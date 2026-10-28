// Spectral analysis and static EQ design (ARCHITECTURE §3, RESEARCH §1, §2, §7).
//
// * ltas: long-term average spectrum of the mid signal in ISO 1/3-octave bands. Welch
//   estimate (Hann, ~170 ms frames, 50 % overlap, power average) over the louder frames,
//   integrated into exact base-10 band edges with fractional-bin overlap (so bands that
//   are narrower than one FFT bin still get the right share of power). Band values are
//   band power in dB re full-scale mean square (a 0 dBFS-peak sine reads −3.01 dB in its
//   band; the 31 band powers sum to the signal's mean square).
// * hfCutoffHz: codec low-pass detection. A codec / resampler low-pass is a steep roll-off
//   ("cliff", RESEARCH 02 §7.2) in the long-term spectrum with nothing coming back above
//   it; without one the contract rule applies (highest frequency within 35 dB of the
//   4–8 kHz level).
// * autoEqCurve / matchEqCurve: 31-point correction curves (dB), conservative by design:
//   cuts before boosts, never boosting empty bands (below 30 Hz, above the cutoff).
// * fitGraphicEq: least-squares fit of a fixed 10-filter minimum-phase bank to a curve.
// * toneSections: the style/"problem button" tone controls as biquads.

import { powerToDb, clamp } from './util.js';
import { design, responseDb } from './biquad.js';
import { RealFFT, hann } from './fft.js';

/** ISO 266 nominal 1/3-octave centres, 20 Hz … 20 kHz (31 bands). */
export const THIRD_OCTAVE_HZ = Object.freeze([
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
]);

const NB = 31;
// Exact base-10 centres (IEC 61260): fm = 1000·10^(k/10); edges fm·10^(±1/20).
const CENTRE = Float64Array.from({ length: NB }, (_, i) => 1000 * Math.pow(10, (i - 17) / 10));
const EDGE_LO = CENTRE.map((f) => f * Math.pow(10, -1 / 20));
const EDGE_HI = CENTRE.map((f) => f * Math.pow(10, 1 / 20));
// Octaves re 1 kHz of each band centre (x-axis for trends and tilts).
const XOCT = CENTRE.map((f) => Math.log2(f / 1000));

function fftSizeFor(sampleRate) {
  // ≈ 170 ms frames: 8192 at 44.1/48 kHz (5.9 Hz bins), 16384 at 88.2/96 kHz.
  let n = 1024;
  while (n < 0.15 * sampleRate && n < 65536) n <<= 1;
  return n;
}

/**
 * Gated long-term power spectrum of the mid signal (Welch: Hann, 50 % overlap).
 * Extension (not in the ARCHITECTURE contract): ltas() and hfCutoffHz() share it — either
 * pass it explicitly via `opts.spectrum`, or rely on the internal one-entry cache (keyed
 * weakly on the L array plus a full content checksum of both channels, so in-place edits
 * are always detected; a hit costs ~10 % of a recompute). Treat the result as read-only.
 * @param {Float32Array[]} channels [L, R] (or [mono])
 * @param {number} sampleRate
 * @param {{ fftSize?: number, relGateDb?: number }} [opts]
 *   relGateDb: frames quieter than this re. the loudest frame are ignored (default −50).
 * @returns {{ psd: Float64Array, df: number, fftSize: number, sampleRate: number, frames: number }}
 *   psd[k] = mean-square power of bin k (one-sided; Σ psd = mean square of the mid signal).
 */
export function longTermSpectrum(channels, sampleRate, opts = {}) {
  const N = opts.fftSize && (opts.fftSize & (opts.fftSize - 1)) === 0 ? opts.fftSize : fftSizeFor(sampleRate);
  const relGateDb = Number.isFinite(opts.relGateDb) ? opts.relGateDb : -50;
  const L = (channels && channels[0]) || new Float32Array(0);
  const R = channels && channels.length > 1 ? channels[1] : L;
  const n = Math.min(L.length, R.length);
  const useCache = n >= 65536 && typeof L === 'object';
  let key = null;
  if (useCache) {
    key = `${sampleRate}|${N}|${relGateDb}|${n}|${checksum(L, n)}|${R === L ? 'same' : checksum(R, n)}`;
    const hit = SPEC_CACHE.get(L);
    if (hit && hit.key === key) return hit.spectrum;
  }
  const spectrum = computeSpectrum(L, R, n, N, relGateDb, sampleRate);
  if (useCache) SPEC_CACHE.set(L, { key, spectrum });
  return spectrum;
}

const SPEC_CACHE = new WeakMap();

/** Content checksum: plain and position-weighted sums (any in-place edit changes them). */
function checksum(x, n) {
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    a += v;
    b += v * ((i % 1021) + 1);
  }
  return `${a}:${b}`;
}

function computeSpectrum(L, R, n, N, relGateDb, sampleRate) {
  const half = N >> 1;
  const hop = half;
  const w = hann(N, true);
  let s2 = 0;
  for (let i = 0; i < N; i++) s2 += w[i] * w[i];
  // Frame starts spread evenly so the first frame starts at 0 and the last ends at n.
  const count = n <= N ? 1 : Math.ceil((n - N) / hop) + 1;
  const starts = new Float64Array(count);
  for (let f = 0; f < count; f++) starts[f] = count === 1 ? 0 : Math.round((f * (n - N)) / (count - 1));
  // Pass 1: windowed frame energies for gating.
  const energy = new Float64Array(count);
  let emax = 0;
  for (let f = 0; f < count; f++) {
    const s = starts[f];
    const len = Math.min(N, n - s);
    let e = 0;
    for (let i = 0; i < len; i++) {
      const m = 0.5 * (L[s + i] + R[s + i]) * w[i];
      e += m * m;
    }
    energy[f] = e;
    if (e > emax) emax = e;
  }
  const gate = Math.max(emax * Math.pow(10, relGateDb / 10), 1e-30);
  // Pass 2: power spectra of the accepted frames.
  const fft = new RealFFT(N);
  const buf = new Float64Array(N);
  const re = new Float64Array(half + 1);
  const im = new Float64Array(half + 1);
  const acc = new Float64Array(half + 1);
  let used = 0;
  for (let f = 0; f < count; f++) {
    if (energy[f] < gate) continue;
    const s = starts[f];
    const len = Math.min(N, n - s);
    for (let i = 0; i < len; i++) buf[i] = 0.5 * (L[s + i] + R[s + i]) * w[i];
    for (let i = len; i < N; i++) buf[i] = 0;
    fft.forward(buf, re, im);
    for (let k = 0; k <= half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  // Parseval: Σ_k |X_k|² (two-sided) = N·Σ (x·w)²  →  mean square ≈ Σ|X|² / (N·Σw²).
  const psd = new Float64Array(half + 1);
  if (used > 0) {
    const norm = 1 / (used * N * s2);
    for (let k = 0; k <= half; k++) psd[k] = acc[k] * norm * (k === 0 || k === half ? 1 : 2);
  }
  return { psd, df: sampleRate / N, fftSize: N, sampleRate, frames: used };
}

/** Power of the bins overlapping [fl, fh] (each bin = a rectangle of width df). */
function bandPower(psd, df, fl, fh) {
  const half = psd.length - 1;
  const nyq = half * df;
  const lo = Math.max(0, fl);
  const hi = Math.min(fh, nyq);
  if (!(hi > lo)) return 0;
  const k0 = Math.max(0, Math.floor(lo / df + 0.5));
  const k1 = Math.min(half, Math.floor(hi / df + 0.5));
  let p = 0;
  for (let k = k0; k <= k1; k++) {
    const bl = Math.max((k - 0.5) * df, 0);
    const bh = Math.min((k + 0.5) * df, nyq);
    const ov = Math.min(bh, hi) - Math.max(bl, lo);
    if (ov > 0 && bh > bl) p += psd[k] * (ov / (bh - bl));
  }
  return p;
}

/**
 * Long-term average spectrum of the mid signal in 1/3-octave bands (dB band power re
 * full-scale mean square), gated: frames quieter than −50 dB re. the loudest frame are
 * ignored. Bands above Nyquist (and silence) read −240 dB.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ fftSize?: number, relGateDb?: number, spectrum?: object }} [opts]
 *   spectrum: a longTermSpectrum() result to reuse.
 * @returns {Float64Array} 31 values, low → high (THIRD_OCTAVE_HZ)
 */
export function ltas(channels, sampleRate, opts = {}) {
  const sp = opts.spectrum && opts.spectrum.psd ? opts.spectrum : longTermSpectrum(channels, sampleRate, opts);
  const out = new Float64Array(NB);
  for (let b = 0; b < NB; b++) out[b] = powerToDb(bandPower(sp.psd, sp.df, EDGE_LO[b], EDGE_HI[b]));
  return out;
}

/**
 * Codec low-pass detection on the gated long-term spectrum (±150 Hz smoothing).
 * 1. Low-pass edge: the highest steep roll-off above 2 kHz — local slope ≤ −40 dB/oct
 *    (measured over ±1/12 octave; natural music rolls off at −5 … −20 dB/oct, codec and
 *    resampler low-passes at hundreds of dB/oct, a 16th-order IIR at ~50–100) that drops
 *    ≥ 20 dB in total, starts from real content (≥ ref − 40 dB) and has nothing
 *    substantial coming back above it (≤ pre-roll-off level − 15 dB). This generalises
 *    the RESEARCH 02 §7.2 "cliff" test (LTAS(f − 300) − LTAS(f + 300) > 18 dB). The
 *    reported value is the passband edge: the highest frequency still within 6 dB of the
 *    level ¼–5⁄12 octave below the roll-off.
 * 2. Otherwise (contract rule): the highest frequency within 35 dB of the 4–8 kHz level.
 * A result within ~3 % of Nyquist returns sampleRate/2 (no low-pass detected).
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ spectrum?: object }} [opts] extension: reuse a longTermSpectrum() result
 * @returns {number} Hz
 */
export function hfCutoffHz(channels, sampleRate, opts = {}) {
  const sp = opts.spectrum && opts.spectrum.psd ? opts.spectrum : longTermSpectrum(channels, sampleRate, opts);
  const { psd, df } = sp;
  const half = psd.length - 1;
  const nyq = sampleRate / 2;
  if (half < 8) return nyq;
  // Power-domain moving average, ±150 Hz.
  const W = Math.max(1, Math.round(150 / df));
  const pre = new Float64Array(half + 2);
  for (let k = 0; k <= half; k++) pre[k + 1] = pre[k] + psd[k];
  const D = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const a = Math.max(0, k - W), b = Math.min(half, k + W);
    D[k] = powerToDb((pre[b + 1] - pre[a]) / (b - a + 1));
  }
  const meanDb = (f0, f1) => {
    const a = clamp(Math.round(f0 / df), 0, half), b = clamp(Math.round(f1 / df), 0, half);
    if (b < a) return -240;
    return powerToDb((pre[b + 1] - pre[a]) / (b - a + 1));
  };
  const ref = meanDb(Math.min(4000, 0.25 * nyq), Math.min(8000, 0.5 * nyq));
  const guard = Math.max(500, 0.03 * nyq);

  // 1. Steep roll-off on a 1/48-octave grid, scanned from the top.
  const STEPS = 48;
  const gf = [];
  for (let f = 2000; f < nyq - df; f *= Math.pow(2, 1 / STEPS)) gf.push(f);
  const gd = gf.map((f) => D[Math.min(half, Math.round(f / df))]);
  const n = gd.length;
  const h = 4; // ±1/12 octave
  const slope = (i) => (gd[Math.min(n - 1, i + h)] - gd[Math.max(0, i - h)]) / ((Math.min(n - 1, i + h) - Math.max(0, i - h)) / STEPS);
  const meanGrid = (i0, i1) => {
    const a = clamp(i0, 0, n - 1), b = clamp(i1, 0, n - 1);
    let p = 0;
    for (let i = a; i <= b; i++) p += Math.pow(10, gd[i] / 10);
    return powerToDb(p / (b - a + 1));
  };
  for (let i = n - 1; i >= h; i--) {
    if (slope(i) > -40 || gd[Math.max(0, i - h)] < ref - 40) continue;
    const top = i;
    let bot = i;
    while (bot - 1 >= h && slope(bot - 1) <= -40) bot--;
    i = bot; // continue below this run if it is rejected
    const preLevel = meanGrid(bot - h - 12, bot - h - 4);
    const postLevel = gd[Math.min(n - 1, top + h)];
    if (preLevel - postLevel < 20) continue;
    if (top + h < n - 1 && meanGrid(top + h, top + h + 12) > preLevel - 15) continue;
    // Passband edge (bin resolution): highest bin up to the roll-off top within 6 dB.
    let k = Math.min(half, Math.round(gf[Math.min(n - 1, top + h)] / df));
    const kMin = Math.round(gf[Math.max(0, bot - h - 12)] / df);
    while (k > kMin && D[k] < preLevel - 6) k--;
    const fEdge = k * df;
    if (fEdge >= nyq - guard) return nyq;
    return Math.round(fEdge / 10) * 10;
  }

  // 2. Contract rule: highest frequency within 35 dB of the 4–8 kHz level.
  let k35 = half;
  while (k35 > 0 && D[k35] < ref - 35) k35--;
  const f35 = k35 * df;
  if (f35 >= nyq - guard) return nyq;
  return Math.round(f35 / 10) * 10;
}

// ---------------------------------------------------------------- curve helpers

function finiteOr(v, d) {
  return Number.isFinite(v) ? v : d;
}

/** Weighted local-linear regression (Gaussian kernel in octaves), robust (bisquare) iterations. */
function robustTrend(x, y, valid, sigmaOct, iterations = 3) {
  const n = x.length;
  const rob = new Float64Array(n).fill(1);
  const trend = new Float64Array(n);
  for (let it = 0; it <= iterations; it++) {
    for (let i = 0; i < n; i++) {
      let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
      for (let j = 0; j < n; j++) {
        if (!valid[j]) continue;
        const d = x[j] - x[i];
        const wj = Math.exp(-0.5 * (d / sigmaOct) * (d / sigmaOct)) * rob[j];
        s0 += wj;
        s1 += wj * d;
        s2 += wj * d * d;
        t0 += wj * y[j];
        t1 += wj * d * y[j];
      }
      const det = s0 * s2 - s1 * s1;
      trend[i] = det > 1e-12 * s0 * s0 ? (s2 * t0 - s1 * t1) / det : s0 > 0 ? t0 / s0 : 0;
    }
    if (it === iterations) break;
    const res = [];
    for (let j = 0; j < n; j++) if (valid[j]) res.push(Math.abs(y[j] - trend[j]));
    res.sort((a, b) => a - b);
    const mad = Math.max(0.5, res.length ? res[res.length >> 1] : 0);
    for (let j = 0; j < n; j++) {
      const u = (y[j] - trend[j]) / (4.5 * mad);
      rob[j] = Math.abs(u) < 1 ? (1 - u * u) * (1 - u * u) : 0;
    }
  }
  return trend;
}

/** Least-squares slope of y over x (valid points only); 0 if undetermined. */
function slopeOf(x, y, valid) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    if (!valid[i]) continue;
    n++;
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const d = n * sxx - sx * sx;
  return n >= 3 && d > 1e-9 ? (n * sxy - sx * sy) / d : 0;
}

/** Boost allowance per band for a codec cutoff: full below, half if straddling, none above. */
function boostAllowance(b, cutoffHz) {
  if (!(cutoffHz > 0) || !Number.isFinite(cutoffHz)) return 1;
  if (EDGE_HI[b] <= cutoffHz) return 1;
  if (CENTRE[b] <= cutoffHz) return 0.5;
  return 0;
}

/**
 * Automatic corrective EQ curve.
 * (a) Bumps/dips vs the track's own smoothed trend (robust local-linear fit, σ = 0.8 oct)
 *     are corrected by their excess beyond the tolerance (soft threshold); dips are filled
 *     at 70 % (a long-term dip is often arrangement, and boosting it raises noise). Low end:
 *     bump cuts fade to ¼ from 200 Hz down to 63 Hz and stay at ¼ below (the kick / 808
 *     hump is the genre's low end, and 31.5–40 Hz is never cut harder than 50–63 Hz);
 *     dips below 63 Hz are never filled (that is the natural sub roll-off toward the
 *     subsonic high-pass, not a resonance dip).
 * (b) Only if targetSlopeDbPerOct is a number: the overall slope (100 Hz–10 kHz) is moved
 *     toward it (≤ ±1.5 dB/oct of change). null keeps the track's slope.
 * (a)+(b) scale with strength; styleTiltDbPerOct (pivot 1 kHz) is added unscaled.
 * The result is smoothed (1-2-1 over neighbours), clamped to ±min(maxDb, 4), and never
 * boosts below 30 Hz (boosts fade in over 28–45 Hz) or above cutoffHz.
 * Slopes are in dB/oct of 1/3-octave BAND POWER (pink noise = 0, white = +3; typical
 * commercial masters ≈ −3 … −5 dB/oct above ~200 Hz).
 * @param {ArrayLike<number>} inputLtas 31 values (dB)
 * @param {{ strength?: number, maxDb?: number, toleranceDb?: number,
 *           targetSlopeDbPerOct?: number|null, styleTiltDbPerOct?: number, cutoffHz?: number }} opts
 * @returns {Float64Array} correction (dB) per THIRD_OCTAVE_HZ band
 */
export function autoEqCurve(inputLtas, opts = {}) {
  const strength = clamp(finiteOr(opts.strength, 0.6), 0, 1);
  const lim = Math.min(clamp(finiteOr(opts.maxDb, 3), 0, 12), 4);
  const tol = Math.max(0, finiteOr(opts.toleranceDb, 1.5));
  const target = Number.isFinite(opts.targetSlopeDbPerOct) ? opts.targetSlopeDbPerOct : null;
  const tilt = finiteOr(opts.styleTiltDbPerOct, 0);
  const cutoff = Number.isFinite(opts.cutoffHz) && opts.cutoffHz > 0 ? opts.cutoffHz : Infinity;
  const y = new Float64Array(NB);
  let ymax = -Infinity;
  for (let b = 0; b < NB; b++) {
    y[b] = finiteOr(inputLtas && inputLtas[b], -240);
    if (b >= 2 && b <= 29 && y[b] > ymax) ymax = y[b];
  }
  // Bands the analysis trusts: 31.5 Hz – 16 kHz, fully below the cutoff, not empty.
  const valid = new Uint8Array(NB);
  let nValid = 0;
  for (let b = 2; b <= 29; b++) {
    if (EDGE_HI[b] <= cutoff && y[b] > ymax - 60 && y[b] > -200) {
      valid[b] = 1;
      nValid++;
    }
  }
  const raw = new Float64Array(NB);
  if (nValid >= 5) {
    const trend = robustTrend(XOCT, y, valid, 0.8);
    for (let b = 0; b < NB; b++) {
      if (!valid[b]) continue;
      const r = y[b] - trend[b];
      const ex = Math.max(0, Math.abs(r) - tol);
      let c = r > 0 ? -ex : 0.7 * ex;
      // The kick / bass hump (≈ 50–120 Hz) is the genre's low end, not a resonance: a
      // trend fit sees it as a bump, so cuts fade to ¼ from 200 Hz down to 63 Hz and stay
      // there below (narrow boom is handled by its own detector and dynamic band). Below
      // 63 Hz the trend fit reads the roll-off into the subsonic filter as a dip: no fill
      // (decided before the smoothing, so nothing spreads into 40–50 Hz either).
      if (r > 0 && CENTRE[b] < 200) c *= clamp(0.25 + 0.75 * Math.log2(CENTRE[b] / 63) / Math.log2(200 / 63), 0.25, 1);
      else if (r <= 0 && CENTRE[b] < 60) c = 0;
      raw[b] = c;
    }
    if (target !== null) {
      const sv = new Uint8Array(NB);
      for (let b = 0; b < NB; b++) sv[b] = valid[b] && CENTRE[b] >= 90 && CENTRE[b] <= 11000 ? 1 : 0;
      const delta = clamp(target - slopeOf(XOCT, trend, sv), -1.5, 1.5);
      for (let b = 0; b < NB; b++) raw[b] += delta * XOCT[b];
    }
  }
  const total = new Float64Array(NB);
  for (let b = 0; b < NB; b++) total[b] = strength * raw[b] + tilt * XOCT[b];
  return finishCurve(total, lim, cutoff);
}

/** 1-2-1 smoothing, clamp, no boost below 30 Hz / above the cutoff, final clamp. */
function finishCurve(c, lim, cutoff) {
  const out = new Float64Array(NB);
  for (let b = 0; b < NB; b++) {
    const l = c[Math.max(0, b - 1)], r = c[Math.min(NB - 1, b + 1)];
    out[b] = clamp(0.25 * l + 0.5 * c[b] + 0.25 * r, -lim, lim);
  }
  for (let b = 0; b < NB; b++) {
    if (out[b] > 0) {
      // No boost below 30 Hz, faded in over 28–45 Hz (25 Hz: 0, 31.5 Hz: ¼, 50 Hz: full)
      // so the realised minimum-phase EQ has no steep step at the bottom.
      out[b] *= clamp(Math.log2(THIRD_OCTAVE_HZ[b] / 28) / Math.log2(45 / 28), 0, 1);
      out[b] *= boostAllowance(b, cutoff);
    }
    if (Math.abs(out[b]) < 1e-9) out[b] = 0;
  }
  return out;
}

/** Approximate K-weighting gain (dB) at f: BS.1770 stage 1 shelf + stage 2 high-pass. */
function kWeightDb(f) {
  const sr = 48000;
  const shelf = [{ b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 }];
  const hp = [{ b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 }];
  return responseDb(shelf, Math.min(f, 0.49 * sr), sr) + responseDb(hp, Math.min(f, 0.49 * sr), sr);
}
const KW = Float64Array.from(CENTRE, (f) => kWeightDb(f));

/**
 * Reference-matching EQ curve (Matchering-style, RESEARCH §7 / research 05 §9.2).
 * Both LTAS are assumed gated (louder parts; ltas() does this). They are loudness-
 * normalised first (K-weighted band-power sum over the shared valid range), so the
 * curve is purely tonal; the difference is smoothed over smoothingOct (1/3 oct = the band
 * itself), clamped to ±maxDb, faded to 0 below 30–40 Hz and above min(16 kHz, cutoffHz)
 * (from 0.2 oct below it), and scaled by strength.
 * @param {ArrayLike<number>} inputLtas
 * @param {ArrayLike<number>} referenceLtas
 * @param {{ strength?: number, maxDb?: number, smoothingOct?: number, cutoffHz?: number }} opts
 * @returns {Float64Array} correction (dB), 31 bands
 */
export function matchEqCurve(inputLtas, referenceLtas, opts = {}) {
  const strength = clamp(finiteOr(opts.strength, 0.5), 0, 1);
  const maxDb = clamp(finiteOr(opts.maxDb, 6), 0, 24);
  const smoothingOct = clamp(finiteOr(opts.smoothingOct, 1 / 3), 0, 4);
  const cutoff = Number.isFinite(opts.cutoffHz) && opts.cutoffHz > 0 ? opts.cutoffHz : Infinity;
  const a = new Float64Array(NB), r = new Float64Array(NB);
  let amax = -Infinity, rmax = -Infinity;
  for (let b = 0; b < NB; b++) {
    a[b] = finiteOr(inputLtas && inputLtas[b], -240);
    r[b] = finiteOr(referenceLtas && referenceLtas[b], -240);
    amax = Math.max(amax, a[b]);
    rmax = Math.max(rmax, r[b]);
  }
  const fHi = Math.min(16000, cutoff);
  const fLoFade = fHi * Math.pow(2, -0.2);
  const weight = new Float64Array(NB);
  const valid = new Uint8Array(NB);
  for (let b = 0; b < NB; b++) {
    const f = THIRD_OCTAVE_HZ[b]; // nominal centres: the 16 kHz band is fully faded at 16 kHz
    const wl = clamp(Math.log2(f / 30) / Math.log2(40 / 30), 0, 1);
    const wh = clamp(Math.log2(fHi / f) / Math.log2(fHi / fLoFade), 0, 1);
    const ok = a[b] > amax - 80 && r[b] > rmax - 80 && a[b] > -200 && r[b] > -200;
    weight[b] = ok ? wl * wh : 0;
    valid[b] = ok && weight[b] > 0 ? 1 : 0;
  }
  // Loudness normalisation over the shared valid range.
  let pa = 0, pr = 0;
  for (let b = 0; b < NB; b++) {
    if (!valid[b]) continue;
    pa += Math.pow(10, (a[b] + KW[b]) / 10);
    pr += Math.pow(10, (r[b] + KW[b]) / 10);
  }
  const out = new Float64Array(NB);
  if (!(pa > 0 && pr > 0)) return out;
  const offset = 10 * Math.log10(pr / pa);
  const diff = new Float64Array(NB);
  for (let b = 0; b < NB; b++) diff[b] = valid[b] ? r[b] - a[b] - offset : 0;
  // Fractional-octave smoothing: box of ±smoothingOct/2 in band units, fractional edges.
  const hw = 1.5 * smoothingOct;
  const sm = new Float64Array(NB);
  for (let b = 0; b < NB; b++) {
    if (!valid[b]) continue;
    let s = 0, ws = 0;
    for (let j = 0; j < NB; j++) {
      if (!valid[j]) continue;
      const wj = clamp(hw + 0.5 - Math.abs(j - b), 0, 1);
      s += wj * diff[j];
      ws += wj;
    }
    sm[b] = ws > 0 ? s / ws : 0;
  }
  for (let b = 0; b < NB; b++) {
    const v = strength * weight[b] * clamp(sm[b], -maxDb, maxDb);
    out[b] = Math.abs(v) < 1e-9 ? 0 : v;
  }
  return out;
}

// ---------------------------------------------------------------- EQ fitting

// The minimum-phase bank of the contract at its nominal settings: low shelf 80 Hz,
// peaking 63 … 8k (Q 1.4), high shelf 12 kHz. Shelves use Q 0.6 (gentle, no overshoot).
// fitGraphicEq's refinement stage may move each filter ±½ octave (bells: Q 0.5 … 4).
const BANK = [
  { type: 'lowshelf', f: 80, q: 0.6 },
  { type: 'peaking', f: 63, q: 1.4 },
  { type: 'peaking', f: 125, q: 1.4 },
  { type: 'peaking', f: 250, q: 1.4 },
  { type: 'peaking', f: 500, q: 1.4 },
  { type: 'peaking', f: 1000, q: 1.4 },
  { type: 'peaking', f: 2000, q: 1.4 },
  { type: 'peaking', f: 4000, q: 1.4 },
  { type: 'peaking', f: 8000, q: 1.4 },
  { type: 'highshelf', f: 12000, q: 0.6 },
];

/** Solve the symmetric positive-definite system A·x = b (Gaussian elimination, pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-14) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = Math.abs(M[r][r]) < 1e-14 ? 0 : s / M[r][r];
  }
  return x;
}

/** Linear interpolation of a 31-point curve in log-frequency (flat beyond the ends). */
function interpCurve(curve, f) {
  const x = Math.log2(f / 1000);
  if (x <= XOCT[0]) return curve[0];
  if (x >= XOCT[NB - 1]) return curve[NB - 1];
  const p = (x - XOCT[0]) * 3;
  const i = Math.min(NB - 2, Math.floor(p));
  const t = p - i;
  return curve[i] * (1 - t) + curve[i + 1] * t;
}

/**
 * Approximate a 31-point curve with the bank (low shelf 80 Hz, peaking at 63, 125, 250,
 * 500, 1k, 2k, 4k, 8k Hz with Q 1.4, high shelf 12 kHz) by Levenberg-Marquardt least
 * squares on a 1/6-octave grid (20 Hz … min(20.5 kHz, 0.45·fs)):
 *   1. gains only, filters at their nominal frequency / Q;
 *   2. refinement: each bell may also move ±½ octave and change Q (0.5 … 4), each shelf
 *      may move ±½ octave, with weak penalties pulling them back to nominal. An octave-
 *      spaced bank cannot otherwise follow features narrower than ~1 octave (e.g. a
 *      ⅔-octave mud bump between 250 and 500 Hz) to within 0.5 dB.
 * A small ridge on the gains keeps overlapping filters (63 Hz bell / 80 Hz shelf) from
 * fighting with large opposite gains. Typical max error ≤ 0.3 dB on smooth curves
 * within ±4 dB.
 * @param {ArrayLike<number>} curveDb 31 values (dB)
 * @param {number} sampleRate
 * @returns {Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>} sections (≈0 dB filters omitted)
 */
export function fitGraphicEq(curveDb, sampleRate) {
  const curve = Float64Array.from({ length: NB }, (_, i) => finiteOr(curveDb && curveDb[i], 0));
  let peakAbs = 0;
  for (let i = 0; i < NB; i++) peakAbs = Math.max(peakAbs, Math.abs(curve[i]));
  if (peakAbs < 1e-4 || !(sampleRate > 0)) return [];
  const fTop = Math.min(20500, 0.45 * sampleRate);
  const grid = [];
  for (let f = 20; f <= fTop; f *= Math.pow(2, 1 / 6)) grid.push(f);
  const G = grid.length;
  const target = Float64Array.from(grid, (f) => interpCurve(curve, f));
  const wgt = Float64Array.from(grid, (f) => (f < 28 ? 0.5 : 1));
  const bank = BANK.filter((s) => s.f < 0.42 * sampleRate);
  const F = bank.length;
  // Parameters per filter: [gain dB, frequency offset (octaves), ln Q].
  const NP = 3 * F;
  const lo = new Float64Array(NP), hi = new Float64Array(NP), nominal = new Float64Array(NP);
  for (let j = 0; j < F; j++) {
    const fMaxOct = Math.log2(Math.min(bank[j].f * Math.SQRT2, 0.45 * sampleRate) / bank[j].f);
    lo[3 * j] = -18;
    hi[3 * j] = 18;
    lo[3 * j + 1] = -0.5;
    hi[3 * j + 1] = Math.max(0, fMaxOct);
    nominal[3 * j + 2] = Math.log(bank[j].q);
    const shelf = bank[j].type !== 'peaking';
    lo[3 * j + 2] = shelf ? nominal[3 * j + 2] : Math.log(0.5);
    hi[3 * j + 2] = shelf ? nominal[3 * j + 2] : Math.log(4);
  }
  const PEN = { gain: 0.02, freq: 0.05, q: 0.05 };
  const sectionOf = (j, par) => design(bank[j].type, bank[j].f * Math.pow(2, par[3 * j + 1]), sampleRate, {
    q: Math.exp(par[3 * j + 2]),
    gainDb: par[3 * j],
  });
  const respOf = (j, par) => (par[3 * j] === 0 ? new Float64Array(G) : responseDb(sectionOf(j, par), grid, sampleRate));
  const penalty = (par) => {
    let c = 0;
    for (let j = 0; j < F; j++) {
      c += PEN.gain * par[3 * j] ** 2 + PEN.freq * par[3 * j + 1] ** 2 + PEN.q * (par[3 * j + 2] - nominal[3 * j + 2]) ** 2;
    }
    return c;
  };
  const evalAll = (par) => {
    const resp = [];
    const total = new Float64Array(G);
    for (let j = 0; j < F; j++) {
      const r = respOf(j, par);
      resp.push(r);
      for (let i = 0; i < G; i++) total[i] += r[i];
    }
    let cost = penalty(par);
    for (let i = 0; i < G; i++) cost += wgt[i] * (target[i] - total[i]) ** 2;
    return { resp, total, cost };
  };
  const par = Float64Array.from(nominal);
  for (let j = 0; j < F; j++) par[3 * j] = bank[j].type === 'peaking' ? 0.5 * interpCurve(curve, bank[j].f) : 0;
  let cur = evalAll(par);
  const optimise = (free, maxIter) => {
    const K = free.length;
    let lambda = 1e-3;
    for (let it = 0; it < maxIter; it++) {
      // Numerical Jacobian of the response sum w.r.t. the free parameters.
      const J = [];
      for (const p of free) {
        const j = Math.floor(p / 3);
        const step = p % 3 === 0 ? 0.05 : 0.01;
        const trial = Float64Array.from(par);
        trial[p] += step;
        const r = respOf(j, trial);
        J.push(Float64Array.from(r, (v, i) => (v - cur.resp[j][i]) / step));
      }
      // Gradient of the penalty (diagonal Hessian added to the normal equations).
      const penW = (p) => (p % 3 === 0 ? PEN.gain : p % 3 === 1 ? PEN.freq : PEN.q);
      const penG = (p) => penW(p) * (par[p] - (p % 3 === 2 ? nominal[p] : 0));
      const A = [];
      const rhs = new Array(K).fill(0);
      for (let a = 0; a < K; a++) {
        A.push(new Array(K).fill(0));
        for (let b = 0; b <= a; b++) {
          let sum = 0;
          for (let i = 0; i < G; i++) sum += wgt[i] * J[a][i] * J[b][i];
          A[a][b] = sum;
          A[b][a] = sum;
        }
        let sum = 0;
        for (let i = 0; i < G; i++) sum += wgt[i] * J[a][i] * (target[i] - cur.total[i]);
        rhs[a] = sum - penG(free[a]);
      }
      let improved = false;
      let drop = 0;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const Ad = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + penW(free[a]) + 1e-9 : v)));
        const stepV = solve(Ad, rhs);
        const trial = Float64Array.from(par);
        for (let a = 0; a < K; a++) trial[free[a]] = clamp(par[free[a]] + stepV[a], lo[free[a]], hi[free[a]]);
        const ev = evalAll(trial);
        if (ev.cost < cur.cost) {
          drop = cur.cost - ev.cost;
          par.set(trial);
          cur = ev;
          lambda = Math.max(1e-7, lambda * 0.3);
          improved = true;
        } else {
          lambda *= 8;
        }
      }
      if (!improved || drop < 1e-7) break;
    }
  };
  const gainsOnly = [];
  const all = [];
  for (let j = 0; j < F; j++) {
    gainsOnly.push(3 * j);
    all.push(3 * j, 3 * j + 1);
    if (bank[j].type === 'peaking') all.push(3 * j + 2);
  }
  optimise(gainsOnly, 30);
  optimise(all, 40);
  const out = [];
  for (let j = 0; j < F; j++) {
    if (Math.abs(par[3 * j]) < 0.005) continue;
    out.push(sectionOf(j, par));
  }
  return out;
}

// ---------------------------------------------------------------- tone controls

const TILT_Q = 0.3; // broad shelves: closest to a constant dB/oct between ~40 Hz and 16 kHz

function tiltPair(tiltDbPerOct, pivotHz, sampleRate) {
  // Complementary shelves at the pivot: high shelf +G/2, low shelf −G/2. G is the least-
  // squares match of the pair to tilt·log2(f/pivot) over 40 Hz … min(16 kHz, 0.45 fs)
  // (≈ ±1.3 dB at 100 Hz / 10 kHz for 0.4 dB/oct). Response is ~linear in G, so one
  // projection plus one refinement step suffices.
  const pair = (G) => [
    design('highshelf', pivotHz, sampleRate, { q: TILT_Q, gainDb: G / 2 }),
    design('lowshelf', pivotHz, sampleRate, { q: TILT_Q, gainDb: -G / 2 }),
  ];
  const grid = [];
  const top = Math.min(16000, 0.45 * sampleRate);
  for (let f = 40; f <= top; f *= Math.pow(2, 1 / 6)) grid.push(f);
  const d = grid.map((f) => tiltDbPerOct * Math.log2(f / pivotHz));
  let G = 0;
  const unit = responseDb(pair(1), grid, sampleRate);
  let num = 0, den = 0;
  for (let i = 0; i < grid.length; i++) {
    num += unit[i] * d[i];
    den += unit[i] * unit[i];
  }
  G = den > 0 ? num / den : 0;
  const r = responseDb(pair(G), grid, sampleRate);
  num = 0;
  den = 0;
  for (let i = 0; i < grid.length; i++) {
    num += r[i] * d[i];
    den += r[i] * r[i];
  }
  if (den > 0) G *= num / den;
  return pair(clamp(G, -36, 36));
}

/**
 * Tone-control sections (style moves, "too dull/harsh/…" buttons). Zero-gain bands are
 * omitted, so a neutral tone returns [].
 * @param {{ lowShelfDb?: number, lowShelfHz?: number, boomDb?: number, boomHz?: number, boomQ?: number,
 *           mudDb?: number, mudHz?: number, mudQ?: number, presenceDb?: number, presenceHz?: number,
 *           presenceQ?: number, airDb?: number, airHz?: number, highShelfDb?: number, highShelfHz?: number,
 *           hashDb?: number, hashHz?: number, tiltDbPerOct?: number, tiltPivotHz?: number }} tone
 *   highShelfDb: broad high shelf (Q 0.4) at highShelfHz (default 2 kHz): ≈ full gain from
 *   6 kHz up, ≤ 0.05 dB up to 300 Hz — the Bright style's "open top" without a low cut.
 * @param {number} sampleRate
 * @returns {Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>}
 */
export function toneSections(tone, sampleRate) {
  const t = tone || {};
  const out = [];
  const g = (v) => (Number.isFinite(v) && Math.abs(v) > 1e-6 ? v : 0);
  const f = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const q = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  if (g(t.lowShelfDb)) out.push(design('lowshelf', f(t.lowShelfHz, 90), sampleRate, { q: 0.6, gainDb: g(t.lowShelfDb) }));
  if (g(t.boomDb)) out.push(design('peaking', f(t.boomHz, 120), sampleRate, { q: q(t.boomQ, 1.4), gainDb: g(t.boomDb) }));
  if (g(t.mudDb)) out.push(design('peaking', f(t.mudHz, 300), sampleRate, { q: q(t.mudQ, 0.9), gainDb: g(t.mudDb) }));
  if (g(t.presenceDb)) out.push(design('peaking', f(t.presenceHz, 3000), sampleRate, { q: q(t.presenceQ, 0.8), gainDb: g(t.presenceDb) }));
  if (g(t.airDb)) out.push(design('highshelf', f(t.airHz, 12000), sampleRate, { q: 0.6, gainDb: g(t.airDb) }));
  if (g(t.highShelfDb)) out.push(design('highshelf', f(t.highShelfHz, 2000), sampleRate, { q: 0.4, gainDb: g(t.highShelfDb) }));
  if (g(t.hashDb)) out.push(design('highshelf', f(t.hashHz, 14000), sampleRate, { q: 0.6, gainDb: g(t.hashDb) }));
  if (g(t.tiltDbPerOct)) out.push(...tiltPair(g(t.tiltDbPerOct), f(t.tiltPivotHz, 1000), sampleRate));
  return out;
}

/**
 * Magnitude response of a cascade for UI drawing (frequencies above Nyquist are clamped
 * to Nyquist).
 * @param {object[]} sections
 * @param {ArrayLike<number>} freqs Hz
 * @param {number} sampleRate
 * @returns {Float64Array} dB
 */
export function curveResponseDb(sections, freqs, sampleRate) {
  const fs = Array.from(freqs || [], (v) => clamp(finiteOr(v, 0), 0, 0.5 * sampleRate));
  if (!sections || (Array.isArray(sections) && sections.length === 0)) return new Float64Array(fs.length);
  return responseDb(sections, fs, sampleRate);
}
