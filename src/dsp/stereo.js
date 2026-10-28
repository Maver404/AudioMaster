// Mid/side width, mono bass and stereo correlation metrics (ARCHITECTURE §3,
// RESEARCH §1 stage 8, research 05 §12).
//
// stereoImage works in M/S (M = (L+R)/2, S = (L−R)/2) and only ever touches S, so the
// mono sum is unaffected by width / mono-bass moves (to float32 rounding, < 1e-7).
// The side gain follows the LR4 magnitudes exactly but is realised ZERO-PHASE
// (forward-backward filtering) instead of causally:
//   * mono bass: forward-backward Butterworth-2 high-pass → |HP2|² = the LR4 high-pass
//     magnitude, with no phase rotation of the remaining side content (a causal LR4 HP
//     turns S by up to 360° near the crossover, which smears/moves panned sources there).
//   * width split: one 2nd-order shelf H(s) = (1 + √2·w^¼·s + √w·s²)/(1 + √2·s + s²),
//     run forward-backward, gives |H|² = (1 + w·Ω⁴)/(1 + Ω⁴) = |LR4 low| + w·|LR4 high|
//     (|LR4| = |Butterworth-2|², and |LP2|² + |HP2|² = 1), i.e. exactly "LR4 low band at
//     gain 1 + LR4 high band at gain w", with zero phase.
// Zero-phase = zero latency (the contract) and true phase coherence between M and S.

import { design } from './biquad.js';
import { clamp, powerToDb } from './util.js';

const BLOCK = 4096;

/**
 * Bilinear transform (pre-warped at fc) of an analog biquad normalised to Ωc = 1:
 * H(s) = (n0 + n1·s + n2·s²)/(d0 + d1·s + d2·s²).
 */
function bilinear(n0, n1, n2, d0, d1, d2, fc, sampleRate) {
  const K = 1 / Math.tan((Math.PI * clamp(fc, 1, 0.49 * sampleRate)) / sampleRate);
  const K2 = K * K;
  const a0 = d0 + d1 * K + d2 * K2;
  return {
    b0: (n0 + n1 * K + n2 * K2) / a0,
    b1: (2 * n0 - 2 * n2 * K2) / a0,
    b2: (n0 - n1 * K + n2 * K2) / a0,
    a1: (2 * d0 - 2 * d2 * K2) / a0,
    a2: (d0 - d1 * K + d2 * K2) / a0,
  };
}

/** Side shelf whose forward-backward magnitude is |LR4 low(fc)| + w·|LR4 high(fc)|. */
function widthShelf(fc, w, sampleRate) {
  const r = Math.sqrt(Math.max(0, w));
  return bilinear(1, Math.SQRT2 * Math.sqrt(r), r, 1, Math.SQRT2, 1, fc, sampleRate);
}

/** Samples for a cascade's zero-input response to decay below ~−140 dB. */
function tailLength(fMin, sampleRate) {
  // Butterworth Q = 1/√2 poles decay at σ = ωc/√2; 16 time constants ≈ −139 dB.
  const sigma = (2 * Math.PI * Math.max(fMin, 5)) / Math.SQRT2;
  return Math.min(Math.ceil((16 / sigma) * sampleRate) + 64, 4 * sampleRate);
}

/** TDF-II over buf[start..end) (step +1 or −1) with persistent Float64 state. */
function runSections(buf, from, to, step, secs, state) {
  for (let s = 0; s < secs.length; s++) {
    const { b0, b1, b2, a1, a2 } = secs[s];
    let s1 = state[2 * s], s2 = state[2 * s + 1];
    for (let i = from; i !== to; i += step) {
      const x = buf[i];
      const y = b0 * x + s1;
      s1 = (b1 * x + s2) - a1 * y;
      s2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    if (Math.abs(s1) < 1e-30) s1 = 0;
    if (Math.abs(s2) < 1e-30) s2 = 0;
    state[2 * s] = s1;
    state[2 * s + 1] = s2;
  }
}

/**
 * Zero-phase (forward-backward) filtering in place, with the forward tail captured in a
 * small side buffer so the result equals filtfilt of the zero-extended signal, cropped.
 * Magnitude |H|², phase 0. Block-wise so the cascade sections stay cache resident.
 */
function filtfiltInPlace(x, secs, tail) {
  const n = x.length;
  if (!n || !secs.length) return x;
  const st = new Float64Array(2 * secs.length);
  const tmp = new Float64Array(BLOCK);
  // Forward over x (block-wise through all sections, state carried).
  for (let s = 0; s < n; s += BLOCK) {
    const len = Math.min(BLOCK, n - s);
    for (let i = 0; i < len; i++) tmp[i] = x[s + i];
    runSections(tmp, 0, len, 1, secs, st);
    for (let i = 0; i < len; i++) x[s + i] = tmp[i];
  }
  // Forward continues over `tail` zeros.
  const t = new Float64Array(tail);
  runSections(t, 0, tail, 1, secs, st);
  // Backward: fresh state, through the tail first, then x from the end.
  st.fill(0);
  runSections(t, tail - 1, -1, -1, secs, st);
  for (let e = n; e > 0; e -= BLOCK) {
    const s = Math.max(0, e - BLOCK);
    const len = e - s;
    for (let i = 0; i < len; i++) tmp[i] = x[s + i];
    runSections(tmp, len - 1, -1, -1, secs, st);
    for (let i = 0; i < len; i++) x[s + i] = tmp[i];
  }
  return x;
}

/**
 * In-place M/S stereo image. Side gain vs frequency: 0 below monoBassHz (LR4 high-pass
 * magnitude; 0 = off), 1 between monoBassHz and widthFromHz, `width` above widthFromHz
 * (LR4 split; widthFromHz = 0 → width applies to all side content above monoBassHz).
 * Never widens below 300 Hz (widthFromHz is raised to 300 when width > 1).
 * width = 1 and monoBassHz = 0 → exact identity (buffers untouched).
 * @param {Float32Array[]} channels [L, R] (mono / 1 channel: untouched)
 * @param {number} sampleRate
 * @param {{ width?: number, widthFromHz?: number, monoBassHz?: number }} [opts]
 * @returns {{ width: number, widthFromHz: number, monoBassHz: number, changed: boolean }}
 */
export function stereoImage(channels, sampleRate, opts = {}) {
  let width = Number.isFinite(opts.width) ? Math.max(0, opts.width) : 1;
  let widthFromHz = Number.isFinite(opts.widthFromHz) ? Math.max(0, opts.widthFromHz) : 1500;
  let monoBassHz = Number.isFinite(opts.monoBassHz) ? Math.max(0, opts.monoBassHz) : 0;
  const nyqLimit = 0.45 * sampleRate;
  if (monoBassHz > 0) monoBassHz = clamp(monoBassHz, 5, nyqLimit);
  if (width > 1) widthFromHz = Math.max(300, widthFromHz);
  if (widthFromHz >= nyqLimit) width = 1; // no band left to apply the width to
  const stats = { width, widthFromHz: width === 1 ? 0 : widthFromHz, monoBassHz, changed: false };
  if (!channels || channels.length < 2) return stats;
  const L = channels[0], R = channels[1];
  const n = Math.min(L.length, R.length);
  if ((width === 1 && monoBassHz === 0) || n === 0) return stats;
  stats.changed = true;

  // Side signal into a working buffer (Float32 is ample: −150 dB rounding).
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = 0.5 * (L[i] - R[i]);
  const secs = [];
  let fMin = Infinity;
  if (monoBassHz > 0) {
    secs.push(design('highpass', monoBassHz, sampleRate, { q: Math.SQRT1_2 }));
    fMin = monoBassHz;
  }
  let scalar = 1;
  if (width !== 1) {
    if (widthFromHz > 0) {
      secs.push(widthShelf(widthFromHz, width, sampleRate));
      fMin = Math.min(fMin, widthFromHz);
    } else {
      scalar = width;
    }
  }
  if (secs.length) filtfiltInPlace(S, secs, tailLength(fMin, sampleRate));
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const s = scalar * S[i];
    L[i] = m + s;
    R[i] = m - s;
  }
  return stats;
}

/** Correlation from accumulated sums: no energy → 1 (nothing decorrelated), one side silent → 0. */
function corrFromSums(sll, srr, slr) {
  const tot = sll + srr;
  if (!(tot > 1e-18)) return 1;
  const d = sll * srr;
  if (!(d > tot * tot * 1e-14)) return 0;
  return clamp(slr / Math.sqrt(d), -1, 1);
}

/** Block gate: blocks below −60 dB re. the loudest block or below −100 dBFS are ignored. */
function gateMask(energy, blockLen) {
  let emax = 0;
  for (let b = 0; b < energy.length; b++) if (energy[b] > emax) emax = energy[b];
  const thr = Math.max(emax * 1e-6, 1e-10 * blockLen);
  const mask = new Uint8Array(energy.length);
  for (let b = 0; b < energy.length; b++) mask[b] = energy[b] >= thr && energy[b] > 0 ? 1 : 0;
  return mask;
}

/**
 * Zero-lag L/R correlation coefficient Σ L·R / √(Σ L²·Σ R²) over the non-silent parts
 * (2048-sample blocks below −60 dB re. the loudest block / −100 dBFS are ignored).
 * Silence → 1; one channel silent → 0.
 * @param {Float32Array[]} channels [L, R]
 * @returns {number} −1 … 1
 */
export function correlation(channels) {
  if (!channels || channels.length < 2) return 1;
  const L = channels[0], R = channels[1];
  const n = Math.min(L.length, R.length);
  const B = 2048;
  const nb = Math.max(1, Math.ceil(n / B));
  const sll = new Float64Array(nb), srr = new Float64Array(nb), slr = new Float64Array(nb), en = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    const e = Math.min(n, (b + 1) * B);
    let a = 0, c = 0, d = 0;
    for (let i = b * B; i < e; i++) {
      const l = L[i], r = R[i];
      a += l * l;
      c += r * r;
      d += l * r;
    }
    sll[b] = a;
    srr[b] = c;
    slr[b] = d;
    en[b] = 0.5 * (a + c);
  }
  const mask = gateMask(en, B);
  let a = 0, c = 0, d = 0;
  for (let b = 0; b < nb; b++) {
    if (!mask[b]) continue;
    a += sll[b];
    c += srr[b];
    d += slr[b];
  }
  return corrFromSums(a, c, d);
}

/**
 * Side-to-mid energy ratio 10·log10(ΣS²/ΣM²) in dB, clamped to ±100 (mono → −100).
 * @param {Float32Array[]} channels [L, R]
 * @returns {number} dB
 */
export function sideToMidDb(channels) {
  if (!channels || channels.length < 2) return -100;
  const L = channels[0], R = channels[1];
  const n = Math.min(L.length, R.length);
  let sm = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const m = L[i] + R[i], s = L[i] - R[i];
    sm += m * m;
    ss += s * s;
  }
  if (!(sm + ss > 1e-24)) return -100;
  return clamp(powerToDb(ss) - powerToDb(sm), -100, 100);
}

/**
 * Per-band correlation, low → high. Bands come from an LR4 chain (band k = HP4(f_k−1) ·
 * LP4(f_k)); L and R are filtered identically, so band phase does not affect the result.
 * Gated like correlation() (broadband 4096-sample blocks). Streams block-wise (no
 * full-length band buffers).
 * @param {Float32Array[]} channels [L, R]
 * @param {number} sampleRate
 * @param {number[]} crossovers Hz, ascending
 * @returns {number[]} crossovers.length + 1 values in −1 … 1
 */
export function bandCorrelation(channels, sampleRate, crossovers) {
  // Keep one value per requested band even when a crossover is out of range (clamped to
  // [1 Hz, 0.49·fs]; an empty band reads 1), so callers can index the result.
  const xs = Array.from(crossovers || [], (f) => clamp(Number.isFinite(f) ? f : 0.49 * sampleRate, 1, 0.49 * sampleRate)).sort((a, b) => a - b);
  if (!channels || channels.length < 2) return new Array(xs.length + 1).fill(1);
  if (!xs.length) return [correlation(channels)];
  const L = channels[0], R = channels[1];
  const n = Math.min(L.length, R.length);
  const nBands = xs.length + 1;
  const B = 4096;
  const nb = Math.max(1, Math.ceil(n / B));
  const sums = new Float64Array(nb * nBands * 3);
  const en = new Float64Array(nb);
  // Per crossover: LP4 = 2 sections, HP4 = 2 sections; each with its own L and R state.
  const lp = xs.map((f) => design('lowpass', f, sampleRate, { q: Math.SQRT1_2 }));
  const hp = xs.map((f) => design('highpass', f, sampleRate, { q: Math.SQRT1_2 }));
  const stLP = xs.map(() => new Float64Array(8)); // [L s1 s2 ×2 sections, R s1 s2 ×2 sections]
  const stHP = xs.map(() => new Float64Array(8));
  const restL = new Float64Array(B), restR = new Float64Array(B);
  const bandL = new Float64Array(B), bandR = new Float64Array(B);
  for (let b = 0; b < nb; b++) {
    const s0 = b * B;
    const len = Math.min(B, n - s0);
    let e = 0;
    for (let i = 0; i < len; i++) {
      const l = L[s0 + i], r = R[s0 + i];
      restL[i] = l;
      restR[i] = r;
      e += l * l + r * r;
    }
    en[b] = 0.5 * e;
    for (let k = 0; k <= xs.length; k++) {
      let srcL = restL, srcR = restR;
      if (k < xs.length) {
        // band = LP4(rest); rest = HP4(rest)
        for (let i = 0; i < len; i++) {
          bandL[i] = restL[i];
          bandR[i] = restR[i];
        }
        lr4Pair(bandL, bandR, len, lp[k], stLP[k]);
        lr4Pair(restL, restR, len, hp[k], stHP[k]);
        srcL = bandL;
        srcR = bandR;
      }
      let a = 0, c = 0, d = 0;
      for (let i = 0; i < len; i++) {
        const l = srcL[i], r = srcR[i];
        a += l * l;
        c += r * r;
        d += l * r;
      }
      const o = (b * nBands + k) * 3;
      sums[o] = a;
      sums[o + 1] = c;
      sums[o + 2] = d;
    }
  }
  const mask = gateMask(en, B);
  const out = [];
  for (let k = 0; k < nBands; k++) {
    let a = 0, c = 0, d = 0;
    for (let b = 0; b < nb; b++) {
      if (!mask[b]) continue;
      const o = (b * nBands + k) * 3;
      a += sums[o];
      c += sums[o + 1];
      d += sums[o + 2];
    }
    out.push(corrFromSums(a, c, d));
  }
  return out;
}

/** Two identical Butterworth sections (= LR4) over L and R blocks, state persisted. */
function lr4Pair(xl, xr, len, c, st) {
  const { b0, b1, b2, a1, a2 } = c;
  for (let s = 0; s < 2; s++) {
    let l1 = st[2 * s], l2 = st[2 * s + 1], r1 = st[4 + 2 * s], r2 = st[4 + 2 * s + 1];
    for (let i = 0; i < len; i++) {
      const xa = xl[i], xb = xr[i];
      const ya = b0 * xa + l1;
      const yb = b0 * xb + r1;
      l1 = (b1 * xa + l2) - a1 * ya;
      r1 = (b1 * xb + r2) - a1 * yb;
      l2 = b2 * xa - a2 * ya;
      r2 = b2 * xb - a2 * yb;
      xl[i] = ya;
      xr[i] = yb;
    }
    if (Math.abs(l1) < 1e-30) l1 = 0;
    if (Math.abs(l2) < 1e-30) l2 = 0;
    if (Math.abs(r1) < 1e-30) r1 = 0;
    if (Math.abs(r2) < 1e-30) r2 = 0;
    st[2 * s] = l1;
    st[2 * s + 1] = l2;
    st[4 + 2 * s] = r1;
    st[4 + 2 * s + 1] = r2;
  }
}

/**
 * Analytic side gain (amplitude, dB) that stereoImage applies at frequency f — for UI
 * drawing and tests. Extension, not in the ARCHITECTURE contract.
 * @param {number} f Hz
 * @param {number} sampleRate
 * @param {{ width?: number, widthFromHz?: number, monoBassHz?: number }} [opts]
 * @returns {number} dB (−240 floor)
 */
export function sideGainDb(f, sampleRate, opts = {}) {
  const width = Number.isFinite(opts.width) ? Math.max(0, opts.width) : 1;
  let widthFromHz = Number.isFinite(opts.widthFromHz) ? Math.max(0, opts.widthFromHz) : 1500;
  const monoBassHz = Number.isFinite(opts.monoBassHz) ? Math.max(0, opts.monoBassHz) : 0;
  if (width > 1) widthFromHz = Math.max(300, widthFromHz);
  // Bilinear frequency warping, as realised by the digital filters.
  const omega4 = (fc) => (Math.tan((Math.PI * clamp(f, 0, 0.4999 * sampleRate)) / sampleRate) / Math.tan((Math.PI * fc) / sampleRate)) ** 4;
  let g = 1;
  if (monoBassHz > 0) {
    const o4 = omega4(monoBassHz);
    g *= o4 / (1 + o4); // |LR4 high-pass|
  }
  if (width !== 1) {
    if (widthFromHz > 0 && widthFromHz < 0.45 * sampleRate) {
      const o4 = omega4(widthFromHz);
      g *= (1 + width * o4) / (1 + o4); // |LR4 low| + width·|LR4 high|
    } else if (widthFromHz === 0) {
      g *= width;
    }
  }
  return 20 * Math.log10(Math.max(g, 1e-12));
}
