// Polyphase half-band up/down-sampling and true-peak (inter-sample peak) detection.
//
// * upsample/downsample: cascaded linear-phase Kaiser half-band FIR stages (2x each),
//   computed centred (zero-phase), so outputs are time-aligned with no delay to undo.
//   Stage 1 (at the base rate): 48 taps, transition 0.44–0.56·fs, ~90 dB.
//   Later stages only have to reject images of < 0.56·fs and are much shorter.
//   A half-band filter keeps every original sample (upsample(x)[f·n] === x[n]).
// * truePeakEnvelope / truePeakDb: 4x (sr < 96 kHz), 2x (96–192 kHz), 1x above
//   (BS.1770-4 Annex 2; RESEARCH 05 §3).
//   'meter'   = the BS.1770-4 48-tap / 4-phase reference interpolator (the standard
//               meter; ffmpeg ebur128 uses its own 192 kHz resampler and reads up to
//               ~0.2 dB higher on bright material).
//   'limiter' = Kaiser-windowed sinc, 16 taps/phase (β 4.5, fc 0.49·fs): stopband −50 dB
//               from 0.583·fs (BS.1770: −39 dB) and interpolation error ≤ −45 dB up to
//               0.40·fs (BS.1770: ≈ −30 dB), within the limiter's time budget.
//   Both are evaluated with symmetric pair sums (phase p and 4−p are mirror images), so
//   one set of pair sums/differences serves two phases — about half the multiplies.

import { besselI0, kaiserBeta, sinc, gainToDb } from './util.js';

const BLOCK = 4096;

/** Copy x[start .. start+count-1] into buf[0..count-1], zero outside [0, x.length). */
function fillPadded(buf, x, start, count) {
  const n = x.length;
  let j = 0;
  for (; j < count && start + j < 0; j++) buf[j] = 0;
  const end = Math.min(count, n - start);
  for (; j < end; j++) buf[j] = x[start + j];
  for (; j < count; j++) buf[j] = 0;
}

// ---------------------------------------------------------------- half-band stages

/**
 * Kaiser half-band: side taps h_k at odd offsets ±(2k+1) (high-rate samples), centre 0.5.
 * Returns the upsampling taps u_k = 2·h_k (each pair sums to the interpolated value, Σ2u = 1)
 * and decimation taps h_k (centre 0.5, Σ2h = 0.5 → DC gain 1).
 */
function halfBand(K, A) {
  const beta = kaiserBeta(A);
  const i0b = besselI0(beta);
  const hw = 2 * K; // window half-width in high-rate samples
  const h = new Float64Array(K);
  let sum = 0;
  for (let k = 0; k < K; k++) {
    const m = 2 * k + 1;
    const u = m / hw;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / i0b;
    h[k] = 0.5 * sinc(m / 2) * w;
    sum += 2 * h[k];
  }
  const norm = 0.5 / sum; // exact DC gain
  const down = h.map((v) => v * norm);
  const up = down.map((v) => 2 * v);
  return { K, up, down };
}

// Stage 1 runs at the base rate: 48 taps, β for 90 dB → transition ≈ 0.44–0.56·fs.
// Stage 2 (at 2·fs) only has to pass < 0.56·fs and reject images from ≈ 1.44·fs: 16 taps.
// Stage 3 (at 4·fs, 8x only): passes < 0.56·fs, rejects from ≈ 3.44·fs: 10 taps.
// (Measured half-band ripple: stage 1 −88.6 dB over 0–0.44·fs, stage 2 −95.6 dB, stage 3
// −106 dB; short windows need a larger β than the Kaiser A formula suggests.)
// Tap counts are a speed/quality balance for JS (no SIMD): ≥ 90 dB image/alias rejection
// for content below 0.44·fs (19.4 kHz at 44.1 kHz, 21.1 kHz at 48 kHz).
const STAGES = [halfBand(24, 90), halfBand(8, 100), halfBand(5, 110)];
const UP_KERNELS = { 24: up2K24, 8: up2K8, 5: up2K5 };
const DOWN_KERNELS = { 24: down2K24, 8: down2K8, 5: down2K5 };

function up2Generic(buf, len, out, o0, u) {
  const K = u.length;
  for (let t = 0, c = K - 1, o = o0; t < len; t++, c++, o += 2) {
    let a = 0;
    for (let j = 0; j < K; j++) a += u[j] * (buf[c - j] + buf[c + 1 + j]);
    out[o] = buf[c];
    out[o + 1] = a;
  }
}

function down2Generic(buf, len, out, o0, h) {
  const K = h.length;
  for (let t = 0, c = 2 * K - 1; t < len; t++, c += 2) {
    let a = 0.5 * buf[c];
    for (let j = 0; j < K; j++) a += h[j] * (buf[c - 2 * j - 1] + buf[c + 2 * j + 1]);
    out[o0 + t] = a;
  }
}

/** 2x interpolation with a half-band stage. Output Float32Array(2n). */
function up2(x, stage) {
  const n = x.length;
  const out = new Float32Array(2 * n);
  const K = stage.K;
  const kernel = UP_KERNELS[K] || up2Generic;
  const buf = new Float64Array(BLOCK + 2 * K);
  for (let s = 0; s < n; s += BLOCK) {
    const len = Math.min(BLOCK, n - s);
    // buf[q] = x[s - K + 1 + q]; x[s+t] at q = t + K - 1
    fillPadded(buf, x, s - K + 1, len + 2 * K - 1);
    kernel(buf, len, out, 2 * s, stage.up);
  }
  return out;
}

/** 2x decimation with a half-band stage. Output Float32Array(ceil(n/2)). */
function down2(x, stage) {
  const n = x.length;
  const m = (n + 1) >> 1;
  const out = new Float32Array(m);
  const K = stage.K;
  const kernel = DOWN_KERNELS[K] || down2Generic;
  const R = 2 * K - 1; // reach in input samples
  const buf = new Float64Array(2 * BLOCK + 2 * R + 1);
  for (let s = 0; s < m; s += BLOCK) {
    const len = Math.min(BLOCK, m - s);
    // buf[q] = x[2s - R + q]; centre x[2(s+t)] at q = 2t + R
    fillPadded(buf, x, 2 * s - R, 2 * len + 2 * R);
    kernel(buf, len, out, s, stage.down);
  }
  return out;
}

function stagesFor(factor) {
  const f = Math.round(factor);
  if (f === 1) return 0;
  if (f === 2) return 1;
  if (f === 4) return 2;
  if (f === 8) return 3;
  throw new Error(`oversample: factor must be 1, 2, 4 or 8, got ${factor}`);
}

/**
 * Linear-phase oversampling by 2, 4 (or 8), zero delay: out[factor·n] === x[n] and the
 * in-between samples are band-limited interpolations (images of content < 0.44·fs are
 * attenuated by >= 90 dB).
 * @param {Float32Array|Float64Array} signal
 * @param {number} factor 2 | 4 (8 and 1 also accepted)
 * @returns {Float32Array} length signal.length·factor
 */
export function upsample(signal, factor) {
  const ns = stagesFor(factor);
  let y = signal;
  if (ns === 0) return Float32Array.from(signal);
  for (let s = 0; s < ns; s++) y = up2(y, STAGES[s]);
  return y;
}

/**
 * Inverse of upsample: anti-alias filtered (content above 0.56·fs_out is rejected by
 * >= 90 dB; 0.44–0.56·fs_out is the transition band), then decimated, zero delay.
 * downsample(upsample(x, f), f) ≈ x for content below 0.44·fs.
 * @param {Float32Array|Float64Array} signal
 * @param {number} factor 2 | 4 (8 and 1 also accepted)
 * @returns {Float32Array} length ceil(signal.length / factor)
 */
export function downsample(signal, factor) {
  const ns = stagesFor(factor);
  let y = signal;
  if (ns === 0) return Float32Array.from(signal);
  for (let s = ns - 1; s >= 0; s--) y = down2(y, STAGES[s]);
  return y;
}

// ---------------------------------------------------------------- true peak

// BS.1770-4 Annex 2 polyphase coefficients (RESEARCH §7). Phase p output at input time
// n: y_p[n] = Σ_k P_p[k]·x[n−k]; it represents time n − 5.875 + p/4, i.e. the points at
// +0.125, +0.375, +0.625, +0.875 between x[n−6] and x[n−5].
const TP_P0 = [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
  0.97216796875, -0.102294921875, 0.047607421875, -0.0266113281250, 0.014892578125, -0.00830078125];
const TP_P1 = [-0.0291748046875, 0.029296875, -0.0517578125, 0.0891113281250, -0.166503906250, 0.465087890625,
  0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375];

// Pair form around the centre i+0.5 for the points between x[i] and x[i+1]:
// x⁺_j = x[i+1+j], x⁻_j = x[i−j]; y_p = Σ_j P_p[5−j]·x⁺_j + P_p[6+j]·x⁻_j (p = 0, 1);
// phases 3 and 2 are the mirrors (P3 = reverse P0, P2 = reverse P1):
// y0,3 = E0 ± G0, y1,2 = E1 ± G1 with e = (a+b)/2 on x⁺+x⁻ and g = (a−b)/2 on x⁺−x⁻.
function meterPairs(P) {
  const e = new Float64Array(6), g = new Float64Array(6);
  for (let j = 0; j < 6; j++) {
    const a = P[5 - j], b = P[6 + j];
    e[j] = 0.5 * (a + b);
    g[j] = 0.5 * (a - b);
  }
  return { e, g };
}
const MTR0 = meterPairs(TP_P0), MTR1 = meterPairs(TP_P1);
const MTR_E0 = MTR0.e, MTR_G0 = MTR0.g, MTR_E1 = MTR1.e, MTR_G1 = MTR1.g;
// Upper bound of |interpolated| / max|x in window| (used to skip quiet blocks exactly).
const MTR_BOUND = Math.max(...[TP_P0, TP_P1].map((P) => P.reduce((s, v) => s + Math.abs(v), 0)));

// 'limiter' 4x interpolator: Kaiser-windowed sinc, 16 taps per phase (window half-width
// 8 input samples). Coefficients for the points i + p/4 (p = 1, 2, 3), in pair form.
// Each phase is normalized to an exact DC gain of 1.
function limiterDesign(H, beta, fc) {
  const i0b = besselI0(beta);
  const h = (t) => {
    const u = t / H;
    if (u >= 1) return 0;
    return 2 * fc * sinc(2 * fc * t) * (besselI0(beta * Math.sqrt(1 - u * u)) / i0b);
  };
  const e = new Float64Array(H), g = new Float64Array(H), c = new Float64Array(H);
  let s1 = 0, s2 = 0;
  for (let j = 0; j < H; j++) {
    const a = h(0.75 + j); // phase 1 (i + 1/4) weight on x⁺_j = x[i+1+j]
    const b = h(0.25 + j); // phase 1 weight on x⁻_j = x[i−j]
    e[j] = 0.5 * (a + b);
    g[j] = 0.5 * (a - b);
    c[j] = h(0.5 + j); // phase 2 (midpoint), same weight on both sides
    s1 += a + b;
    s2 += 2 * c[j];
  }
  for (let j = 0; j < H; j++) {
    e[j] /= s1;
    g[j] /= s1;
    c[j] /= s2;
  }
  return { e, g, c, H };
}
const LIM4 = limiterDesign(8, 4.5, 0.49);

// 2x (96–192 kHz) midpoint interpolator for both qualities: Kaiser half-band, 24 taps
// (passband ~0.41·fs, ~70 dB) — at these rates audio content sits far below 0.25·fs.
const HB2X = halfBand(12, 70);
// Gain bounds (Σ|taps| of the worst phase) for exact block skipping in truePeakDb.
const HB2X_BOUND = HB2X.up.reduce((s, v) => s + 2 * Math.abs(v), 0);
const LIM4_BOUND = Math.max(
  LIM4.e.reduce((s, e, j) => s + Math.abs(e + LIM4.g[j]) + Math.abs(e - LIM4.g[j]), 0),
  LIM4.c.reduce((s, c) => s + 2 * Math.abs(c), 0),
);

/**
 * Oversampling factor used for true-peak detection at a sample rate.
 * @param {number} sampleRate
 * @returns {1|2|4}
 */
export function truePeakFactor(sampleRate) {
  return sampleRate < 96000 ? 4 : sampleRate <= 192000 ? 2 : 1;
}

function hb2EnvKernel(buf, len, out, off, u) {
  const K = u.length;
  for (let t = 0, c = K - 1; t < len; t++, c++) {
    let a = 0;
    for (let j = 0; j < K; j++) a += u[j] * (buf[c - j] + buf[c + 1 + j]);
    out[off + t] = Math.max(Math.abs(buf[c]), Math.abs(a));
  }
}

function hb2MaxKernel(buf, len, peakIn, u) {
  const K = u.length;
  let peak = peakIn;
  for (let t = 0, c = K - 1; t < len; t++, c++) {
    let a = 0;
    for (let j = 0; j < K; j++) a += u[j] * (buf[c - j] + buf[c + 1 + j]);
    peak = Math.max(peak, Math.abs(buf[c]), Math.abs(a));
  }
  return peak;
}

/**
 * True-peak envelope: env[n] = max(|x[n]|, |x(n + p/F)| for p = 1..F−1), the interpolated
 * points between x[n] and x[n+1] (signal zero-padded beyond its ends), F = 4 below
 * 96 kHz, 2 for 96–192 kHz, 1 above. Zero latency.
 * @param {Float32Array|Float64Array} signal
 * @param {number} sampleRate
 * @param {Float32Array} [out] optional output buffer (length >= signal.length)
 * @param {'limiter'|'meter'} [quality='limiter']
 * @returns {Float32Array}
 */
export function truePeakEnvelope(signal, sampleRate, out, quality = 'limiter') {
  const n = signal.length;
  const env = out && out.length >= n ? out : new Float32Array(n);
  const F = truePeakFactor(sampleRate);
  if (F === 1) {
    for (let i = 0; i < n; i++) env[i] = Math.abs(signal[i]);
    return env;
  }
  const mode = F === 2 ? 2 : quality === 'meter' ? 1 : 0;
  const H = mode === 2 ? HB2X.K : mode === 1 ? 6 : LIM4.H;
  const buf = new Float64Array(BLOCK + 2 * H);
  for (let s = 0; s < n; s += BLOCK) {
    const len = Math.min(BLOCK, n - s);
    // buf[q] = x[s − H + 1 + q]; x[s+t] sits at q = t + H − 1
    fillPadded(buf, signal, s - H + 1, len + 2 * H - 1);
    if (mode === 0) {
      // two outputs per iteration (they share 15 of 16 window samples), odd tail single
      const done = limiterEnvKernel2(buf, len, env, s, LIM4);
      if (done < len) limiterEnvKernel(buf.subarray(done), len - done, env, s + done, LIM4);
    } else if (mode === 1) {
      meterEnvKernel(buf, len, env, s);
    } else {
      hb2EnvKernel(buf, len, env, s, HB2X.up);
    }
  }
  return env;
}

/**
 * BS.1770-4 true peak in dBTP: max over channels of max(sample peak, 4x-interpolated
 * peak) with the Annex 2 filter (2x Kaiser half-band at 96–192 kHz, sample peak above).
 * Exact block skipping: blocks whose max|x| × (filter gain bound) cannot beat the running
 * peak are not interpolated. Silence → −240 dB (finite).
 * Optional `quality = 'limiter'` (extension) uses the more accurate limiter interpolator
 * instead (ffmpeg's ebur128, which resamples to 192 kHz with a sharper filter, can read
 * up to ~0.2 dB above the Annex 2 filter on bright material).
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @param {'meter'|'limiter'} [quality='meter']
 * @returns {number} dBTP
 */
export function truePeakDb(channels, sampleRate, quality = 'meter') {
  const chans = ArrayBuffer.isView(channels) ? [channels] : channels;
  const F = truePeakFactor(sampleRate);
  let peak = 0;
  for (const x of chans) {
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  }
  if (F === 1) return gainToDb(peak);
  const mode = F === 2 ? 2 : quality === 'limiter' ? 0 : 1;
  const H = mode === 2 ? HB2X.K : mode === 1 ? 6 : LIM4.H;
  const bound = mode === 2 ? HB2X_BOUND : mode === 1 ? MTR_BOUND : LIM4_BOUND;
  const B = 1024;
  const buf = new Float64Array(B + 2 * H);
  const scratch = mode === 0 ? new Float32Array(B) : null;
  for (const x of chans) {
    const n = x.length;
    for (let s = 0; s < n; s += B) {
      const len = Math.min(B, n - s);
      const cnt = len + 2 * H - 1;
      fillPadded(buf, x, s - H + 1, cnt);
      let bm = 0;
      for (let q = 0; q < cnt; q++) bm = Math.max(bm, Math.abs(buf[q]));
      if (bm * bound <= peak) continue;
      if (mode === 1) peak = meterMaxKernel(buf, len, peak);
      else if (mode === 2) peak = hb2MaxKernel(buf, len, peak, HB2X.up);
      else {
        const done = limiterEnvKernel2(buf, len, scratch, 0, LIM4);
        if (done < len) limiterEnvKernel(buf.subarray(done), len - done, scratch, done, LIM4);
        for (let t = 0; t < len; t++) peak = Math.max(peak, scratch[t]);
      }
    }
  }
  return gainToDb(peak);
}

// ---------------------------------------------------------------- unrolled kernels
// buf holds x[s−H+1 …] (Float64, zero-padded); for output t the centre sample x[i] is
// buf[c] with c = t + H − 1, x⁻_j = buf[c − j], x⁺_j = buf[c + 1 + j].
// (Generated code: fully unrolled for speed — loop-carried versions are ~2x slower in V8.)

function limiterEnvKernel2(buf, len, out, off, k) {
  const e0 = k.e[0], e1 = k.e[1], e2 = k.e[2], e3 = k.e[3], e4 = k.e[4], e5 = k.e[5], e6 = k.e[6], e7 = k.e[7];
  const g0 = k.g[0], g1 = k.g[1], g2 = k.g[2], g3 = k.g[3], g4 = k.g[4], g5 = k.g[5], g6 = k.g[6], g7 = k.g[7];
  const c0 = k.c[0], c1 = k.c[1], c2 = k.c[2], c3 = k.c[3], c4 = k.c[4], c5 = k.c[5], c6 = k.c[6], c7 = k.c[7];
  let t = 0;
  for (let c = 7; t + 1 < len; t += 2, c += 2) {
    const wm7 = buf[c - 7], wm6 = buf[c - 6], wm5 = buf[c - 5], wm4 = buf[c - 4], wm3 = buf[c - 3], wm2 = buf[c - 2], wm1 = buf[c - 1], w0 = buf[c], w1 = buf[c + 1], w2 = buf[c + 2], w3 = buf[c + 3], w4 = buf[c + 4], w5 = buf[c + 5], w6 = buf[c + 6], w7 = buf[c + 7], w8 = buf[c + 8], w9 = buf[c + 9];
    const sA0 = w1 + w0, dA0 = w1 - w0;
    const sA1 = w2 + wm1, dA1 = w2 - wm1;
    const sA2 = w3 + wm2, dA2 = w3 - wm2;
    const sA3 = w4 + wm3, dA3 = w4 - wm3;
    const sA4 = w5 + wm4, dA4 = w5 - wm4;
    const sA5 = w6 + wm5, dA5 = w6 - wm5;
    const sA6 = w7 + wm6, dA6 = w7 - wm6;
    const sA7 = w8 + wm7, dA7 = w8 - wm7;
    const EA = e0 * sA0 + e1 * sA1 + e2 * sA2 + e3 * sA3 + e4 * sA4 + e5 * sA5 + e6 * sA6 + e7 * sA7;
    const GA = g0 * dA0 + g1 * dA1 + g2 * dA2 + g3 * dA3 + g4 * dA4 + g5 * dA5 + g6 * dA6 + g7 * dA7;
    const MA = c0 * sA0 + c1 * sA1 + c2 * sA2 + c3 * sA3 + c4 * sA4 + c5 * sA5 + c6 * sA6 + c7 * sA7;
    const sB0 = w2 + w1, dB0 = w2 - w1;
    const sB1 = w3 + w0, dB1 = w3 - w0;
    const sB2 = w4 + wm1, dB2 = w4 - wm1;
    const sB3 = w5 + wm2, dB3 = w5 - wm2;
    const sB4 = w6 + wm3, dB4 = w6 - wm3;
    const sB5 = w7 + wm4, dB5 = w7 - wm4;
    const sB6 = w8 + wm5, dB6 = w8 - wm5;
    const sB7 = w9 + wm6, dB7 = w9 - wm6;
    const EB = e0 * sB0 + e1 * sB1 + e2 * sB2 + e3 * sB3 + e4 * sB4 + e5 * sB5 + e6 * sB6 + e7 * sB7;
    const GB = g0 * dB0 + g1 * dB1 + g2 * dB2 + g3 * dB3 + g4 * dB4 + g5 * dB5 + g6 * dB6 + g7 * dB7;
    const MB = c0 * sB0 + c1 * sB1 + c2 * sB2 + c3 * sB3 + c4 * sB4 + c5 * sB5 + c6 * sB6 + c7 * sB7;
    out[off + t] = Math.max(Math.abs(w0), Math.abs(EA) + Math.abs(GA), Math.abs(MA));
    out[off + t + 1] = Math.max(Math.abs(w1), Math.abs(EB) + Math.abs(GB), Math.abs(MB));
  }
  return t;
}

function limiterEnvKernel(buf, len, out, off, k) {
  const e0 = k.e[0], e1 = k.e[1], e2 = k.e[2], e3 = k.e[3], e4 = k.e[4], e5 = k.e[5], e6 = k.e[6], e7 = k.e[7];
  const g0 = k.g[0], g1 = k.g[1], g2 = k.g[2], g3 = k.g[3], g4 = k.g[4], g5 = k.g[5], g6 = k.g[6], g7 = k.g[7];
  const c0 = k.c[0], c1 = k.c[1], c2 = k.c[2], c3 = k.c[3], c4 = k.c[4], c5 = k.c[5], c6 = k.c[6], c7 = k.c[7];
  for (let t = 0, c = 7; t < len; t++, c++) {
    const m0 = buf[c], p0 = buf[c + 1], s0 = p0 + m0, d0 = p0 - m0;
    const m1 = buf[c - 1], p1 = buf[c + 2], s1 = p1 + m1, d1 = p1 - m1;
    const m2 = buf[c - 2], p2 = buf[c + 3], s2 = p2 + m2, d2 = p2 - m2;
    const m3 = buf[c - 3], p3 = buf[c + 4], s3 = p3 + m3, d3 = p3 - m3;
    const m4 = buf[c - 4], p4 = buf[c + 5], s4 = p4 + m4, d4 = p4 - m4;
    const m5 = buf[c - 5], p5 = buf[c + 6], s5 = p5 + m5, d5 = p5 - m5;
    const m6 = buf[c - 6], p6 = buf[c + 7], s6 = p6 + m6, d6 = p6 - m6;
    const m7 = buf[c - 7], p7 = buf[c + 8], s7 = p7 + m7, d7 = p7 - m7;
    const E = e0 * s0 + e1 * s1 + e2 * s2 + e3 * s3 + e4 * s4 + e5 * s5 + e6 * s6 + e7 * s7;
    const G = g0 * d0 + g1 * d1 + g2 * d2 + g3 * d3 + g4 * d4 + g5 * d5 + g6 * d6 + g7 * d7;
    const M = c0 * s0 + c1 * s1 + c2 * s2 + c3 * s3 + c4 * s4 + c5 * s5 + c6 * s6 + c7 * s7;
    out[off + t] = Math.max(Math.abs(m0), Math.abs(E + G), Math.abs(E - G), Math.abs(M));
  }
}

function meterEnvKernel(buf, len, out, off) {
  const e00 = MTR_E0[0], e01 = MTR_E0[1], e02 = MTR_E0[2], e03 = MTR_E0[3], e04 = MTR_E0[4], e05 = MTR_E0[5];
  const g00 = MTR_G0[0], g01 = MTR_G0[1], g02 = MTR_G0[2], g03 = MTR_G0[3], g04 = MTR_G0[4], g05 = MTR_G0[5];
  const e10 = MTR_E1[0], e11 = MTR_E1[1], e12 = MTR_E1[2], e13 = MTR_E1[3], e14 = MTR_E1[4], e15 = MTR_E1[5];
  const g10 = MTR_G1[0], g11 = MTR_G1[1], g12 = MTR_G1[2], g13 = MTR_G1[3], g14 = MTR_G1[4], g15 = MTR_G1[5];
  for (let t = 0, c = 5; t < len; t++, c++) {
    const m0 = buf[c], p0 = buf[c + 1], s0 = p0 + m0, d0 = p0 - m0;
    const m1 = buf[c - 1], p1 = buf[c + 2], s1 = p1 + m1, d1 = p1 - m1;
    const m2 = buf[c - 2], p2 = buf[c + 3], s2 = p2 + m2, d2 = p2 - m2;
    const m3 = buf[c - 3], p3 = buf[c + 4], s3 = p3 + m3, d3 = p3 - m3;
    const m4 = buf[c - 4], p4 = buf[c + 5], s4 = p4 + m4, d4 = p4 - m4;
    const m5 = buf[c - 5], p5 = buf[c + 6], s5 = p5 + m5, d5 = p5 - m5;
    const E0 = e00 * s0 + e01 * s1 + e02 * s2 + e03 * s3 + e04 * s4 + e05 * s5;
    const G0 = g00 * d0 + g01 * d1 + g02 * d2 + g03 * d3 + g04 * d4 + g05 * d5;
    const E1 = e10 * s0 + e11 * s1 + e12 * s2 + e13 * s3 + e14 * s4 + e15 * s5;
    const G1 = g10 * d0 + g11 * d1 + g12 * d2 + g13 * d3 + g14 * d4 + g15 * d5;
    out[off + t] = Math.max(Math.abs(m0), Math.abs(E0 + G0), Math.abs(E0 - G0), Math.abs(E1 + G1), Math.abs(E1 - G1));
  }
}

function meterMaxKernel(buf, len, peakIn) {
  const e00 = MTR_E0[0], e01 = MTR_E0[1], e02 = MTR_E0[2], e03 = MTR_E0[3], e04 = MTR_E0[4], e05 = MTR_E0[5];
  const g00 = MTR_G0[0], g01 = MTR_G0[1], g02 = MTR_G0[2], g03 = MTR_G0[3], g04 = MTR_G0[4], g05 = MTR_G0[5];
  const e10 = MTR_E1[0], e11 = MTR_E1[1], e12 = MTR_E1[2], e13 = MTR_E1[3], e14 = MTR_E1[4], e15 = MTR_E1[5];
  const g10 = MTR_G1[0], g11 = MTR_G1[1], g12 = MTR_G1[2], g13 = MTR_G1[3], g14 = MTR_G1[4], g15 = MTR_G1[5];
  let peak = peakIn;
  for (let t = 0, c = 5; t < len; t++, c++) {
    const m0 = buf[c], p0 = buf[c + 1], s0 = p0 + m0, d0 = p0 - m0;
    const m1 = buf[c - 1], p1 = buf[c + 2], s1 = p1 + m1, d1 = p1 - m1;
    const m2 = buf[c - 2], p2 = buf[c + 3], s2 = p2 + m2, d2 = p2 - m2;
    const m3 = buf[c - 3], p3 = buf[c + 4], s3 = p3 + m3, d3 = p3 - m3;
    const m4 = buf[c - 4], p4 = buf[c + 5], s4 = p4 + m4, d4 = p4 - m4;
    const m5 = buf[c - 5], p5 = buf[c + 6], s5 = p5 + m5, d5 = p5 - m5;
    const E0 = e00 * s0 + e01 * s1 + e02 * s2 + e03 * s3 + e04 * s4 + e05 * s5;
    const G0 = g00 * d0 + g01 * d1 + g02 * d2 + g03 * d3 + g04 * d4 + g05 * d5;
    const E1 = e10 * s0 + e11 * s1 + e12 * s2 + e13 * s3 + e14 * s4 + e15 * s5;
    const G1 = g10 * d0 + g11 * d1 + g12 * d2 + g13 * d3 + g14 * d4 + g15 * d5;
    peak = Math.max(peak, Math.abs(m0), Math.abs(E0 + G0), Math.abs(E0 - G0), Math.abs(E1 + G1), Math.abs(E1 - G1));
  }
  return peak;
}

function up2K24(buf, len, out, o0, u) {
  const u0 = u[0], u1 = u[1], u2 = u[2], u3 = u[3], u4 = u[4], u5 = u[5], u6 = u[6], u7 = u[7];
  const u8 = u[8], u9 = u[9], u10 = u[10], u11 = u[11], u12 = u[12], u13 = u[13], u14 = u[14], u15 = u[15];
  const u16 = u[16], u17 = u[17], u18 = u[18], u19 = u[19], u20 = u[20], u21 = u[21], u22 = u[22], u23 = u[23];
  for (let t = 0, c = 23, o = o0; t < len; t++, c++, o += 2) {
    out[o] = buf[c];
    out[o + 1] =
      u0 * (buf[c] + buf[c + 1])
      + u1 * (buf[c - 1] + buf[c + 2])
      + u2 * (buf[c - 2] + buf[c + 3])
      + u3 * (buf[c - 3] + buf[c + 4])
      + u4 * (buf[c - 4] + buf[c + 5])
      + u5 * (buf[c - 5] + buf[c + 6])
      + u6 * (buf[c - 6] + buf[c + 7])
      + u7 * (buf[c - 7] + buf[c + 8])
      + u8 * (buf[c - 8] + buf[c + 9])
      + u9 * (buf[c - 9] + buf[c + 10])
      + u10 * (buf[c - 10] + buf[c + 11])
      + u11 * (buf[c - 11] + buf[c + 12])
      + u12 * (buf[c - 12] + buf[c + 13])
      + u13 * (buf[c - 13] + buf[c + 14])
      + u14 * (buf[c - 14] + buf[c + 15])
      + u15 * (buf[c - 15] + buf[c + 16])
      + u16 * (buf[c - 16] + buf[c + 17])
      + u17 * (buf[c - 17] + buf[c + 18])
      + u18 * (buf[c - 18] + buf[c + 19])
      + u19 * (buf[c - 19] + buf[c + 20])
      + u20 * (buf[c - 20] + buf[c + 21])
      + u21 * (buf[c - 21] + buf[c + 22])
      + u22 * (buf[c - 22] + buf[c + 23])
      + u23 * (buf[c - 23] + buf[c + 24]);
  }
}

function down2K24(buf, len, out, o0, h) {
  const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];
  const h8 = h[8], h9 = h[9], h10 = h[10], h11 = h[11], h12 = h[12], h13 = h[13], h14 = h[14], h15 = h[15];
  const h16 = h[16], h17 = h[17], h18 = h[18], h19 = h[19], h20 = h[20], h21 = h[21], h22 = h[22], h23 = h[23];
  for (let t = 0, c = 47; t < len; t++, c += 2) {
    out[o0 + t] = 0.5 * buf[c]
      + h0 * (buf[c - 1] + buf[c + 1])
      + h1 * (buf[c - 3] + buf[c + 3])
      + h2 * (buf[c - 5] + buf[c + 5])
      + h3 * (buf[c - 7] + buf[c + 7])
      + h4 * (buf[c - 9] + buf[c + 9])
      + h5 * (buf[c - 11] + buf[c + 11])
      + h6 * (buf[c - 13] + buf[c + 13])
      + h7 * (buf[c - 15] + buf[c + 15])
      + h8 * (buf[c - 17] + buf[c + 17])
      + h9 * (buf[c - 19] + buf[c + 19])
      + h10 * (buf[c - 21] + buf[c + 21])
      + h11 * (buf[c - 23] + buf[c + 23])
      + h12 * (buf[c - 25] + buf[c + 25])
      + h13 * (buf[c - 27] + buf[c + 27])
      + h14 * (buf[c - 29] + buf[c + 29])
      + h15 * (buf[c - 31] + buf[c + 31])
      + h16 * (buf[c - 33] + buf[c + 33])
      + h17 * (buf[c - 35] + buf[c + 35])
      + h18 * (buf[c - 37] + buf[c + 37])
      + h19 * (buf[c - 39] + buf[c + 39])
      + h20 * (buf[c - 41] + buf[c + 41])
      + h21 * (buf[c - 43] + buf[c + 43])
      + h22 * (buf[c - 45] + buf[c + 45])
      + h23 * (buf[c - 47] + buf[c + 47]);
  }
}

function up2K8(buf, len, out, o0, u) {
  const u0 = u[0], u1 = u[1], u2 = u[2], u3 = u[3], u4 = u[4], u5 = u[5], u6 = u[6], u7 = u[7];
  for (let t = 0, c = 7, o = o0; t < len; t++, c++, o += 2) {
    out[o] = buf[c];
    out[o + 1] =
      u0 * (buf[c] + buf[c + 1])
      + u1 * (buf[c - 1] + buf[c + 2])
      + u2 * (buf[c - 2] + buf[c + 3])
      + u3 * (buf[c - 3] + buf[c + 4])
      + u4 * (buf[c - 4] + buf[c + 5])
      + u5 * (buf[c - 5] + buf[c + 6])
      + u6 * (buf[c - 6] + buf[c + 7])
      + u7 * (buf[c - 7] + buf[c + 8]);
  }
}

function down2K8(buf, len, out, o0, h) {
  const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];
  for (let t = 0, c = 15; t < len; t++, c += 2) {
    out[o0 + t] = 0.5 * buf[c]
      + h0 * (buf[c - 1] + buf[c + 1])
      + h1 * (buf[c - 3] + buf[c + 3])
      + h2 * (buf[c - 5] + buf[c + 5])
      + h3 * (buf[c - 7] + buf[c + 7])
      + h4 * (buf[c - 9] + buf[c + 9])
      + h5 * (buf[c - 11] + buf[c + 11])
      + h6 * (buf[c - 13] + buf[c + 13])
      + h7 * (buf[c - 15] + buf[c + 15]);
  }
}

function up2K5(buf, len, out, o0, u) {
  const u0 = u[0], u1 = u[1], u2 = u[2], u3 = u[3], u4 = u[4];
  for (let t = 0, c = 4, o = o0; t < len; t++, c++, o += 2) {
    out[o] = buf[c];
    out[o + 1] =
      u0 * (buf[c] + buf[c + 1])
      + u1 * (buf[c - 1] + buf[c + 2])
      + u2 * (buf[c - 2] + buf[c + 3])
      + u3 * (buf[c - 3] + buf[c + 4])
      + u4 * (buf[c - 4] + buf[c + 5]);
  }
}

function down2K5(buf, len, out, o0, h) {
  const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4];
  for (let t = 0, c = 9; t < len; t++, c += 2) {
    out[o0 + t] = 0.5 * buf[c]
      + h0 * (buf[c - 1] + buf[c + 1])
      + h1 * (buf[c - 3] + buf[c + 3])
      + h2 * (buf[c - 5] + buf[c + 5])
      + h3 * (buf[c - 7] + buf[c + 7])
      + h4 * (buf[c - 9] + buf[c + 9]);
  }
}
