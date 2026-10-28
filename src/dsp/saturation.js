// Oversampled tape-style saturation and HF "air" exciter (ARCHITECTURE §3, RESEARCH §1
// stage 6, §2 "Air", research 02 §7.3 M9, research 05 §4.5–4.6).
//
// Both processors are built as  y = x + residual,  where only the NONLINEAR residual is
// computed at 2x and band-limited back down; the dry path is never resampled. So the
// filters cannot dull the top octave, drive → 0 converges to an exact identity, and the
// up-sampler's images cancel in the residual's linear part (they only matter through
// intermodulation, which allows a shorter interpolator than a plain up/down chain).
//
// Fused 2x kernel (per 2048-sample block, all in Float64, zero delay):
//   midpoints   xi[m] = Σ u_j (x[m−j] + x[m+1+j])             (Kaiser half-band, Ku taps/side)
//   residual    r(2m) = R(x[m]),  r(2m+1) = R(xi[m])
//   decimate    y[n]  = ½·R(x[n]) + Σ h_j (R(xi[n−1−j]) + R(xi[n+j]))  (half-band, Kd taps/side)

import { besselI0, kaiserBeta, sinc, clamp, gainToDb } from './util.js';
import { design, firstOrder } from './biquad.js';

const BLOCK = 2048;

/** Kaiser half-band: side taps at odd offsets ±(2k+1) (2x rate), centre ½, exact DC gain. */
function halfBand(K, A) {
  const beta = kaiserBeta(A);
  const i0b = besselI0(beta);
  const h = new Float64Array(K);
  let sum = 0;
  for (let k = 0; k < K; k++) {
    const m = 2 * k + 1;
    const u = m / (2 * K);
    h[k] = 0.5 * sinc(m / 2) * (besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / i0b);
    sum += 2 * h[k];
  }
  const down = h.map((v) => (v * 0.5) / sum);
  return { down, up: down.map((v) => 2 * v) };
}

// Filter choice (the residual is ≤ −20 dB re. the signal even at full drive, so 60 dB of
// rejection keeps aliases/images below −80 dB; at the default drives below −100 dB):
// * decimator: 16 taps/side, Kaiser A = 60: −59 dB at 27 kHz (fs 48 kHz) — the 3rd
//   harmonic of a 9 kHz tone is already rejected — and < −65 dB from 30 kHz up.
// * interpolator: 10 taps/side, A = 70. Its images cancel in the residual's linear part;
//   only their intermodulation remains (e.g. image 39 kHz × 9 kHz tone → 21 kHz), which
//   this keeps below −90 dB re. the tone up to drive 0.5.
// Measured, 9 kHz sine at 48 kHz: aliases below 20 kHz < −150 dB while the shaper stays in
// its cubic region (drive ≤ 0.75), −78 dB at drive 1 (peaks reach the C¹ clip joint).
const UP10 = halfBand(10, 70).up;
const DOWN16 = halfBand(16, 60).down;

// Unrolled kernels (loop versions are ~2x slower in V8).
function mid10(xb, xi, cnt, u) {
  const u0 = u[0], u1 = u[1], u2 = u[2], u3 = u[3], u4 = u[4], u5 = u[5], u6 = u[6], u7 = u[7];
  const u8 = u[8], u9 = u[9];
  for (let t = 0, c = 9; t < cnt; t++, c++) {
    xi[t] =
      u0 * (xb[c] + xb[c + 1])
      + u1 * (xb[c - 1] + xb[c + 2])
      + u2 * (xb[c - 2] + xb[c + 3])
      + u3 * (xb[c - 3] + xb[c + 4])
      + u4 * (xb[c - 4] + xb[c + 5])
      + u5 * (xb[c - 5] + xb[c + 6])
      + u6 * (xb[c - 6] + xb[c + 7])
      + u7 * (xb[c - 7] + xb[c + 8])
      + u8 * (xb[c - 8] + xb[c + 9])
      + u9 * (xb[c - 9] + xb[c + 10]);
  }
}

function dec16(r0, r1, y, len, h) {
  const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];
  const h8 = h[8], h9 = h[9], h10 = h[10], h11 = h[11], h12 = h[12], h13 = h[13], h14 = h[14], h15 = h[15];
  for (let t = 0, c = 16; t < len; t++, c++) {
    y[t] = 0.5 * r0[t]
      + h0 * (r1[c - 1] + r1[c])
      + h1 * (r1[c - 2] + r1[c + 1])
      + h2 * (r1[c - 3] + r1[c + 2])
      + h3 * (r1[c - 4] + r1[c + 3])
      + h4 * (r1[c - 5] + r1[c + 4])
      + h5 * (r1[c - 6] + r1[c + 5])
      + h6 * (r1[c - 7] + r1[c + 6])
      + h7 * (r1[c - 8] + r1[c + 7])
      + h8 * (r1[c - 9] + r1[c + 8])
      + h9 * (r1[c - 10] + r1[c + 9])
      + h10 * (r1[c - 11] + r1[c + 10])
      + h11 * (r1[c - 12] + r1[c + 11])
      + h12 * (r1[c - 13] + r1[c + 12])
      + h13 * (r1[c - 14] + r1[c + 13])
      + h14 * (r1[c - 15] + r1[c + 14])
      + h15 * (r1[c - 16] + r1[c + 15]);
  }
}

const KU = 10, KD = 16;

const SHAPE_SAT = 0, SHAPE_EXC = 1;

/** Nonlinear residual of one block: dst[i] = R(src[off + i]). Params copied to locals. */
function shapeBlock(type, p, src, off, dst, len) {
  if (type === SHAPE_SAT) {
    const C2 = p.C2, C3 = p.C3, vhi = p.vhi, vlo = p.vlo, fhi = p.fhi, flo = p.flo;
    for (let i = 0; i < len; i++) {
      const v = src[off + i];
      dst[i] = v > vhi ? fhi - v : v < vlo ? flo - v : -v * v * (C2 + C3 * v);
    }
  } else {
    // Exciter: soft-bounded input c = s/√(1 + s²/4) (|c| < 2, smooth), then mostly 2nd
    // with some 3rd harmonic: h = c² + 0.5·c³ (≈ −6 / −18 dB for a full-level sine).
    const inv = p.inv, ref = p.ref;
    for (let i = 0; i < len; i++) {
      const v = src[off + i] * inv;
      const c = v / Math.sqrt(1 + 0.25 * v * v);
      const c2 = c * c;
      dst[i] = (c2 + 0.5 * c2 * c) * ref;
    }
  }
}

/**
 * Fused 2x residual kernel over one channel, as a block iterator:
 *   for (let len = it.next(); len > 0; len = it.next()) use it.y[0..len) at it.start
 * The caller may overwrite x[start .. start+len) in place after each next(): the original
 * left context is kept internally and the right context is read before it is written.
 */
class Residual2x {
  constructor(x, type, params) {
    this.x = x;
    this.type = type;
    this.p = params;
    this.P = KD + KU - 1;
    this.xb = new Float64Array(BLOCK + 2 * this.P);
    this.xi = new Float64Array(BLOCK + 2 * KD - 1);
    this.r1 = new Float64Array(BLOCK + 2 * KD - 1);
    this.r0 = new Float64Array(BLOCK);
    this.y = new Float64Array(BLOCK);
    this.ctx = new Float64Array(this.P); // original x[start − P .. start)
    this.start = 0;
    this.pos = 0;
  }

  /** @returns {number} length of the block now in this.y (0 when done) */
  next() {
    const x = this.x, n = x.length, P = this.P, xb = this.xb, ctx = this.ctx;
    const s = this.pos;
    if (s >= n) return 0;
    const len = Math.min(BLOCK, n - s);
    for (let q = 0; q < P; q++) xb[q] = s - P + q >= 0 ? ctx[q] : 0;
    const cnt = len + 2 * P;
    const avail = Math.min(cnt, n - s + P);
    for (let q = P; q < avail; q++) xb[q] = x[s - P + q];
    for (let q = Math.max(P, avail); q < cnt; q++) xb[q] = 0;
    for (let q = 0; q < P; q++) ctx[q] = xb[len + q];
    // Midpoints for m = s − KD + t, t ∈ [0, len + 2KD − 1); x[m] sits at xb[t + KU − 1].
    const mids = len + 2 * KD - 1;
    mid10(xb, this.xi, mids, UP10);
    shapeBlock(this.type, this.p, this.xi, 0, this.r1, mids);
    shapeBlock(this.type, this.p, xb, P, this.r0, len);
    dec16(this.r0, this.r1, this.y, len, DOWN16);
    this.start = s;
    this.pos = s + len;
    return len;
  }
}

/**
 * q-quantile of |x| over all channels from a histogram of the float32 bit patterns (top 15
 * bits = exponent + 7 mantissa bits: log bins of 0.05 dB, no log() calls). Long inputs
 * are read with stride 4 (≥ 250 k samples, ample for a 99.9 % point).
 */
function percentileAbs(chans, q) {
  const bins = new Uint32Array(32768);
  let total = 0;
  let len = 0;
  for (const ch of chans) len += ch.length;
  const stride = len > 1 << 20 ? 4 : 1;
  for (const ch of chans) {
    const f = ch instanceof Float32Array ? ch : Float32Array.from(ch);
    const bits = new Uint32Array(f.buffer, f.byteOffset, f.length);
    for (let i = 0; i < bits.length; i += stride) bins[(bits[i] & 0x7fffffff) >>> 16]++;
    total += Math.ceil(bits.length / stride);
  }
  if (!total) return 0;
  let above = Math.floor(total * (1 - q));
  let k = 32767;
  for (; k > 0; k--) {
    if (bins[k] > above) break;
    above -= bins[k];
  }
  const tmp = new Uint32Array([((k << 16) | 0x8000) >>> 0]);
  const v = new Float32Array(tmp.buffer)[0];
  return Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------- saturation

/** mix = 1: wet x + r in place; otherwise keep r for the final dry/wet sum. */
function writeResidual(ch, keep, s, r, len) {
  if (keep) for (let t = 0; t < len; t++) keep[s + t] = r[t];
  else for (let t = 0; t < len; t++) ch[s + t] += r[t];
}

// Asymmetric cubic soft clipper (research 05 §4.5 cubic, with a bias b for even order):
//   S(z) = z − k·z³ for |z| ≤ 1.5·Lc (C¹ joint), ±Lc beyond, k = 4/(27·Lc²)
//   F(u) = (S(u + b) − S(b)) / S′(b) = u − c2·u² − c3·u³   (unity slope at 0, F(0) = 0)
// Inside the cubic region F produces ONLY 2nd and 3rd harmonics (c2 = 3kb/S′, c3 = k/S′),
// which 2x oversampling handles alias-free for content up to ≈ 23 kHz at 48 kHz.
// u = x / ref, ref = 99.9th percentile of |x| (stereo-linked): the colour does not depend on
// the input level. Calibration: THD ≈ 10 %·drive for a sine whose peak is at ref
// (b = 0.2 → 2nd ≈ +1.6 dB over 3rd); e.g. drive 0.06 ≈ 0.6 % at the loudest peaks.
const SAT_BIAS = 0.2;
const SAT_K_PER_DRIVE = 0.256;

function satShaper(drive, ref) {
  const k = SAT_K_PER_DRIVE * drive;
  const Lc = Math.sqrt(4 / (27 * k));
  const b = SAT_BIAS;
  const sb = b - k * b * b * b;
  const dsb = 1 - 3 * k * b * b;
  const c2 = (3 * k * b) / dsb;
  const c3 = k / dsb;
  // Absolute units: r(v) = −v²(C2 + C3·v) inside [vlo, vhi], Fconst − v outside.
  return {
    C2: c2 / ref,
    C3: c3 / (ref * ref),
    vhi: (1.5 * Lc - b) * ref,
    vlo: (-1.5 * Lc - b) * ref,
    fhi: ((Lc - sb) / dsb) * ref,
    flo: ((-Lc - sb) / dsb) * ref,
  };
}

/**
 * In-place 2x-oversampled asymmetric tape-style saturation (mostly 2nd/3rd harmonics),
 * stereo-linked, level-compensated (output RMS = input RMS, static gain → no pumping),
 * with the generated DC / sub-sonic removed (1-pole 5 Hz high-pass on the residual only).
 * drive 0 (or silence) ⇒ exact identity.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ drive?: number, mix?: number }} [opts] drive 0..1 (THD ≈ 10 %·drive at the
 *   loudest peaks), mix 0..1 = 1 (dry/wet)
 * @returns {{ drive: number, refDb: number, makeupDb: number }}
 */
export function saturate(channels, sampleRate, opts = {}) {
  const drive = clamp(Number.isFinite(opts.drive) ? opts.drive : 0, 0, 1);
  const mix = clamp(Number.isFinite(opts.mix) ? opts.mix : 1, 0, 1);
  const stats = { drive, refDb: -240, makeupDb: 0 };
  if (!channels || !channels.length || drive <= 0 || mix <= 0) return stats;
  const ref = percentileAbs(channels, 0.999);
  if (!(ref > 1e-9)) return stats;
  stats.refDb = gainToDb(ref);
  const p = satShaper(drive, ref);
  // Pass 1 (the 2x kernel): residual r, DC-blocked (1st-order 5 Hz HP on r only).
  // mix = 1: wet = x + r is written in place; otherwise r is kept for the dry/wet sum.
  const keep = mix < 1 ? channels.map((c) => new Float32Array(c.length)) : null;
  const dc = firstOrder('highpass', 5, sampleRate);
  const b0 = dc.b0, b1 = dc.b1, a1 = dc.a1;
  const sums = new Float64Array(3); // Σx², Σx·r, Σr²
  // Channels are run in pairs so the two DC-blocker recursions overlap (latency-bound).
  for (let c = 0; c < channels.length; c += 2) {
    const A = channels[c];
    const B = c + 1 < channels.length && channels[c + 1].length === A.length ? channels[c + 1] : null;
    const itA = new Residual2x(A, SHAPE_SAT, p);
    const itB = B ? new Residual2x(B, SHAPE_SAT, p) : null;
    const kA = keep ? keep[c] : null;
    const kB = keep && B ? keep[c + 1] : null;
    let za = 0, zb = 0;
    for (let len = itA.next(); len > 0; len = itA.next()) {
      const s = itA.start, ya = itA.y;
      if (itB) {
        itB.next();
        const yb = itB.y;
        let sxx = 0, sxr = 0, srr = 0;
        for (let t = 0; t < len; t++) {
          const ra = ya[t], rb = yb[t];
          const ha = b0 * ra + za;
          const hb = b0 * rb + zb;
          za = b1 * ra - a1 * ha;
          zb = b1 * rb - a1 * hb;
          const xa = A[s + t], xb = B[s + t];
          sxx += xa * xa + xb * xb;
          sxr += xa * ha + xb * hb;
          srr += ha * ha + hb * hb;
          ya[t] = ha;
          yb[t] = hb;
        }
        sums[0] += sxx;
        sums[1] += sxr;
        sums[2] += srr;
        writeResidual(A, kA, s, ya, len);
        writeResidual(B, kB, s, yb, len);
      } else {
        let sxx = 0, sxr = 0, srr = 0;
        for (let t = 0; t < len; t++) {
          const ra = ya[t];
          const ha = b0 * ra + za;
          za = b1 * ra - a1 * ha;
          const xa = A[s + t];
          sxx += xa * xa;
          sxr += xa * ha;
          srr += ha * ha;
          ya[t] = ha;
        }
        sums[0] += sxx;
        sums[1] += sxr;
        sums[2] += srr;
        writeResidual(A, kA, s, ya, len);
      }
    }
    if (B === null && c + 1 < channels.length) c--; // partner of a different length: run it alone next
  }
  const exx = sums[0], exr = sums[1], err = sums[2];
  // Level compensation (exact, static): E[y²] = E[x²] with y = (1 − mix)·x + mix·g·(x + r).
  const exw = exx + exr;
  const eww = Math.max(0, exx + 2 * exr + err);
  let g = 1;
  const qa = mix * mix * eww, qb = 2 * (1 - mix) * mix * exw, qc = (mix * mix - 2 * mix) * exx;
  if (qa > 1e-30) {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) g = (-qb + Math.sqrt(disc)) / (2 * qa);
    if (!(g > 0) || !Number.isFinite(g)) g = 1;
  }
  stats.makeupDb = gainToDb(g);
  if (!keep) {
    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  } else {
    const alpha = 1 - mix + mix * g;
    const beta = mix * g;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c], kc = keep[c];
      for (let i = 0; i < ch.length; i++) ch[i] = alpha * ch[i] + beta * kc[i];
    }
  }
  return stats;
}

// ---------------------------------------------------------------- air exciter

// Mix of the generated harmonics relative to the source band (RESEARCH §2: −30 / −24 /
// −19 dB at amount 0.25 / 0.5 / 0.75), extrapolated to −15 dB at 1; below 0.25 the gain
// falls linearly (amplitude) to 0.
function exciterMixGain(amount) {
  const pts = [[0.25, -30], [0.5, -24], [0.75, -19], [1, -15]];
  if (amount <= 0.25) return Math.pow(10, -30 / 20) * (amount / 0.25);
  for (let i = 1; i < pts.length; i++) {
    if (amount <= pts[i][0]) {
      const [a0, d0] = pts[i - 1], [a1, d1] = pts[i];
      return Math.pow(10, (d0 + ((amount - a0) / (a1 - a0)) * (d1 - d0)) / 20);
    }
  }
  return Math.pow(10, -15 / 20);
}

/** TDF-II over ta/tb[from → to) (step ±1), two independent channels, persistent state. */
function runPair(ta, tb, from, to, step, secs, st) {
  for (let k = 0; k < secs.length; k++) {
    const c = secs[k];
    const b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
    let p1 = st[4 * k], p2 = st[4 * k + 1], q1 = st[4 * k + 2], q2 = st[4 * k + 3];
    for (let i = from; i !== to; i += step) {
      const xa = ta[i], xb = tb[i];
      const ya = b0 * xa + p1;
      const yb = b0 * xb + q1;
      p1 = (b1 * xa + p2) - a1 * ya;
      q1 = (b1 * xb + q2) - a1 * yb;
      p2 = b2 * xa - a2 * ya;
      q2 = b2 * xb - a2 * yb;
      ta[i] = ya;
      tb[i] = yb;
    }
    st[4 * k] = Math.abs(p1) < 1e-30 ? 0 : p1;
    st[4 * k + 1] = Math.abs(p2) < 1e-30 ? 0 : p2;
    st[4 * k + 2] = Math.abs(q1) < 1e-30 ? 0 : q1;
    st[4 * k + 3] = Math.abs(q2) < 1e-30 ? 0 : q2;
  }
}

/**
 * Forward-backward (zero-phase, magnitude |H|²) filtering of a channel pair in place; the
 * forward tail beyond the end is captured so the result equals filtfilt of the
 * zero-extended signals, cropped. Block-wise through Float64 scratch.
 */
function filtfiltPair(a, b, secs, tail) {
  const n = Math.min(a.length, b.length);
  if (!n || !secs.length) return;
  const st = new Float64Array(4 * secs.length);
  const ta = new Float64Array(BLOCK), tb = new Float64Array(BLOCK);
  for (let s = 0; s < n; s += BLOCK) {
    const len = Math.min(BLOCK, n - s);
    for (let i = 0; i < len; i++) {
      ta[i] = a[s + i];
      tb[i] = b[s + i];
    }
    runPair(ta, tb, 0, len, 1, secs, st);
    for (let i = 0; i < len; i++) {
      a[s + i] = ta[i];
      b[s + i] = tb[i];
    }
  }
  // Forward tail (zero input), kept for the backward pass.
  const tailA = new Float64Array(tail), tailB = new Float64Array(tail);
  runPair(tailA, tailB, 0, tail, 1, secs, st);
  st.fill(0);
  runPair(tailA, tailB, tail - 1, -1, -1, secs, st);
  for (let e = n; e > 0; e -= BLOCK) {
    const s = Math.max(0, e - BLOCK);
    const len = e - s;
    for (let i = 0; i < len; i++) {
      ta[i] = a[s + i];
      tb[i] = b[s + i];
    }
    runPair(ta, tb, len - 1, -1, -1, secs, st);
    for (let i = 0; i < len; i++) {
      a[s + i] = ta[i];
      b[s + i] = tb[i];
    }
  }
}

function tailFor(fMin, sampleRate) {
  const sigma = (2 * Math.PI * Math.max(fMin, 5)) / Math.SQRT2;
  return Math.min(Math.ceil((16 / sigma) * sampleRate) + 64, 4 * sampleRate);
}

/**
 * Zero-phase filtering of one channel in place. The signal is cut in two overlapping
 * halves that run through filtfiltPair as a pair (two independent recursions → ~2x
 * throughput); the overlap W = tail lets the artificial edge transients decay below
 * −139 dB before the stitch point, so the result equals a single filtfilt.
 */
function filtfiltMono(x, secs, tail) {
  const n = x.length;
  const W = tail;
  if (n < 4 * W + 64) {
    filtfiltPair(x, new Float32Array(n), secs, tail);
    return;
  }
  const h = n >> 1;
  const m = Math.max(h + W, n - h + W);
  const A = new Float32Array(m), B = new Float32Array(m);
  A.set(x.subarray(0, h + W));
  B.set(x.subarray(h - W, n));
  filtfiltPair(A, B, secs, tail);
  x.set(A.subarray(0, h), 0);
  x.set(B.subarray(W, W + n - h), h);
}

/**
 * In-place HF "air" exciter (RESEARCH §2, research 02 §7.3 M9). Source = the mid signal's
 * band fromHz/2 … fromHz (zero-phase band-pass); a 2x-oversampled harmonic generator
 * (mostly 2nd, some 3rd harmonic) turns it into content above fromHz; that is high-passed
 * at fromHz − 500 Hz (zero-phase, LR4 magnitude: nothing new lands below), normalised to
 * the source band's RMS and added at −30 / −24 / −19 dB (amount 0.25 / 0.5 / 0.75)
 * relative to it, to the MID only (no added width). Time-aligned (zero-phase filters).
 * amount 0, a silent source band, or fromHz above 0.45·fs ⇒ exact identity.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ amount?: number, fromHz?: number }} [opts]
 * @returns {{ amount: number, fromHz: number, mixDb: number, addedDb: number }}
 *   mixDb: harmonics re. the source band; addedDb: added RMS re. the input RMS
 */
export function airExciter(channels, sampleRate, opts = {}) {
  const amount = clamp(Number.isFinite(opts.amount) ? opts.amount : 0, 0, 1);
  const fromHz = Number.isFinite(opts.fromHz) && opts.fromHz > 0 ? opts.fromHz : 8000;
  const stats = { amount, fromHz, mixDb: -240, addedDb: -240 };
  if (!channels || !channels.length || amount <= 0) return stats;
  if (fromHz < 1000 || fromHz > 0.45 * sampleRate) return stats;
  const L = channels[0];
  const R = channels.length > 1 ? channels[1] : null;
  const n = R ? Math.min(L.length, R.length) : L.length;
  if (!n) return stats;
  const band = new Float32Array(n);
  if (R) for (let i = 0; i < n; i++) band[i] = 0.5 * (L[i] + R[i]);
  else band.set(L.subarray(0, n));
  // Source band: one RBJ band-pass at the geometric centre, run forward-backward: |BP|²
  // is −3 dB at fromHz/2 and fromHz for Q ≈ 0.91.
  const bp = design('bandpass', fromHz * Math.SQRT1_2, sampleRate, { q: 0.91 });
  filtfiltMono(band, [bp], tailFor(fromHz / 4, sampleRate));
  const ref = percentileAbs([band], 0.999);
  if (!(ref > 1e-9)) return stats;
  let eBand = 0;
  for (let i = 0; i < n; i++) eBand += band[i] * band[i];
  // Harmonics, written over the band buffer.
  const it = new Residual2x(band, SHAPE_EXC, { inv: 1 / ref, ref });
  for (let len = it.next(); len > 0; len = it.next()) {
    const s = it.start, y = it.y;
    for (let t = 0; t < len; t++) band[s + t] = y[t];
  }
  const hpHz = fromHz - 500;
  filtfiltMono(band, [design('highpass', hpHz, sampleRate, { q: Math.SQRT1_2 })], tailFor(hpHz, sampleRate));
  let eH = 0;
  for (let i = 0; i < n; i++) eH += band[i] * band[i];
  if (!(eH > 1e-30)) return stats;
  // Normalise to the source band's RMS (≤ +30 dB), then apply the mix level.
  const norm = Math.min(Math.sqrt(eBand / eH), 31.6);
  const gMix = exciterMixGain(amount);
  const g = norm * gMix;
  stats.mixDb = gainToDb(gMix);
  let eIn = 0, eAdd = 0;
  if (R) {
    for (let i = 0; i < n; i++) {
      const add = g * band[i];
      const l = L[i], r = R[i];
      L[i] = l + add;
      R[i] = r + add;
      eIn += l * l + r * r;
      eAdd += 2 * add * add;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const add = g * band[i];
      const l = L[i];
      L[i] = l + add;
      eIn += l * l;
      eAdd += add * add;
    }
  }
  stats.addedDb = eIn > 0 ? 10 * Math.log10(Math.max(eAdd, 1e-30) / eIn) : -240;
  return stats;
}
