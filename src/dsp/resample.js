// High-quality sample-rate conversion: Kaiser-windowed sinc, zero delay.
//
// Design (relative to the LOWER of the two rates, fs_lo):
//   passband edge 0.45·fs_lo (flat to ±0.001 dB), stopband edge 0.525·fs_lo (< −100 dB,
//   Kaiser A = 105, β ≈ 10.6), cutoff 0.4875·fs_lo. Half-width 46 low-rate samples
//   (≈ 45 zero crossings per side): 92 taps upsampling, 92·from/to downsampling.
//   Components between 0.5 and 0.525·fs_lo can fold back, but only onto 0.475–0.5·fs_lo
//   (≥ 20.9 kHz at 44.1 kHz) and attenuated; everything that could alias below 0.475·fs_lo
//   is rejected by > 100 dB. Moving the stopband edge to exactly 0.5 would cost 1.5x
//   the taps for a difference confined to the inaudible top 1 kHz of the band.
// Implementation:
//   * Rational ratios (all common rates: 44.1k↔48k = 147/160, 96k→44.1k = 147/320, …):
//     exact polyphase — one coefficient row per output phase, computed directly from the
//     kernel and normalized to unity DC gain. No interpolation error.
//   * Other ratios: kernel table with 4096 points per low-rate sample + linear
//     interpolation between table phases (error ≲ −110 dB), per-output DC normalization.
// Output sample j sits exactly at input time j·from/to (output 0 = input 0, no delay);
// output length is round(n·to/from). The signal is zero-padded beyond both ends.

import { besselI0, kaiserBeta, sinc } from './util.js';

const ATTEN = 105;
const PASS = 0.45;
const STOP = 0.525;
const FC = 0.5 * (PASS + STOP);
const BETA = kaiserBeta(ATTEN);
const I0B = besselI0(BETA);
const HALF = Math.ceil((ATTEN - 7.95) / (14.36 * (STOP - PASS)) / 2); // 46
const TABLE_RES = 4096;
const MAX_TABLE = 2000000;

/** Prototype kernel in low-rate sample units (u >= 0). */
function kernelLo(u) {
  const a = Math.abs(u);
  if (a >= HALF) return 0;
  const r = a / HALF;
  return 2 * FC * sinc(2 * FC * a) * (besselI0(BETA * Math.sqrt(1 - r * r)) / I0B);
}

let table = null;
let dtable = null;
function getTable() {
  if (!table) {
    const N = HALF * TABLE_RES + 2;
    table = new Float64Array(N);
    dtable = new Float64Array(N);
    for (let i = 0; i < N; i++) table[i] = kernelLo(i / TABLE_RES);
    for (let i = 0; i < N - 1; i++) dtable[i] = table[i + 1] - table[i];
  }
  return { table, dtable };
}

function gcd(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

const planCache = new Map();

function makePlan(from, to) {
  const key = `${from}:${to}`;
  const cached = planCache.get(key);
  if (cached) return cached;
  const scale = Math.min(1, to / from); // input-sample units → low-rate units
  const win = HALF / scale; // kernel half-width in input samples
  const hn = Math.ceil(win);
  const T = 2 * hn; // taps k = −hn+1 … hn around floor(t)
  const T8 = (T + 7) & ~7; // rational rows padded with zeros to a multiple of 8 (unrolled dot)
  let plan;
  if (Number.isInteger(from) && Number.isInteger(to)) {
    const g = gcd(from, to);
    const L = to / g;
    const M = from / g;
    if (L * T8 <= MAX_TABLE) {
      const rows = new Float64Array(L * T8);
      for (let ph = 0; ph < L; ph++) {
        const frac = ph / L;
        let sum = 0;
        for (let q = 0; q < T; q++) {
          const k = q - hn + 1;
          const v = scale * kernelLo((frac - k) * scale);
          rows[ph * T8 + q] = v;
          sum += v;
        }
        const inv = 1 / sum;
        for (let q = 0; q < T; q++) rows[ph * T8 + q] *= inv;
      }
      plan = { kind: 'rational', L, M, T: T8, hn, rows };
    }
  }
  if (!plan) plan = { kind: 'table', T, hn, scale };
  if (planCache.size > 8) planCache.delete(planCache.keys().next().value);
  planCache.set(key, plan);
  return plan;
}

function resampleRational(x, outLen, plan) {
  const n = x.length;
  const { L, M, T, hn, rows } = plan;
  const out = new Float32Array(outLen);
  const stepI = Math.floor(M / L);
  const stepP = M % L;
  let i0 = 0;
  let ph = 0;
  for (let j = 0; j < outLen; j++) {
    const r = ph * T;
    const base = i0 - hn + 1;
    let acc;
    if (base >= 0 && base + T <= n) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0;
      for (let q = 0; q < T; q += 8) {
        const rq = r + q, xq = base + q;
        a0 += rows[rq] * x[xq];
        a1 += rows[rq + 1] * x[xq + 1];
        a2 += rows[rq + 2] * x[xq + 2];
        a3 += rows[rq + 3] * x[xq + 3];
        a4 += rows[rq + 4] * x[xq + 4];
        a5 += rows[rq + 5] * x[xq + 5];
        a6 += rows[rq + 6] * x[xq + 6];
        a7 += rows[rq + 7] * x[xq + 7];
      }
      acc = (a0 + a1) + (a2 + a3) + ((a4 + a5) + (a6 + a7));
    } else {
      acc = 0;
      const qs = Math.max(0, -base);
      const qe = Math.min(T, n - base);
      for (let q = qs; q < qe; q++) acc += rows[r + q] * x[base + q];
    }
    out[j] = acc;
    i0 += stepI;
    ph += stepP;
    if (ph >= L) {
      ph -= L;
      i0++;
    }
  }
  return out;
}

/** Two equal-length channels in one pass: each coefficient load serves both channels. */
function resampleRationalPair(xa, xb, outLen, plan) {
  const n = xa.length;
  const { L, M, T, hn, rows } = plan;
  const oa = new Float32Array(outLen);
  const ob = new Float32Array(outLen);
  const stepI = Math.floor(M / L);
  const stepP = M % L;
  let i0 = 0;
  let ph = 0;
  for (let j = 0; j < outLen; j++) {
    const r = ph * T;
    const base = i0 - hn + 1;
    if (base >= 0 && base + T <= n) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
      for (let q = 0; q < T; q += 4) {
        const rq = r + q, xq = base + q;
        const c0 = rows[rq], c1 = rows[rq + 1], c2 = rows[rq + 2], c3 = rows[rq + 3];
        a0 += c0 * xa[xq];
        b0 += c0 * xb[xq];
        a1 += c1 * xa[xq + 1];
        b1 += c1 * xb[xq + 1];
        a2 += c2 * xa[xq + 2];
        b2 += c2 * xb[xq + 2];
        a3 += c3 * xa[xq + 3];
        b3 += c3 * xb[xq + 3];
      }
      oa[j] = (a0 + a1) + (a2 + a3);
      ob[j] = (b0 + b1) + (b2 + b3);
    } else {
      let a = 0, b = 0;
      const qs = Math.max(0, -base);
      const qe = Math.min(T, n - base);
      for (let q = qs; q < qe; q++) {
        a += rows[r + q] * xa[base + q];
        b += rows[r + q] * xb[base + q];
      }
      oa[j] = a;
      ob[j] = b;
    }
    i0 += stepI;
    ph += stepP;
    if (ph >= L) {
      ph -= L;
      i0++;
    }
  }
  return [oa, ob];
}

function resampleTable(x, outLen, from, to, plan) {
  const n = x.length;
  const { T, hn, scale } = plan;
  const { table: tb, dtable: dt } = getTable();
  const lim = HALF * TABLE_RES;
  const out = new Float32Array(outLen);
  const ratio = from / to;
  const sres = scale * TABLE_RES;
  for (let j = 0; j < outLen; j++) {
    const t = j * ratio;
    const i0 = Math.floor(t);
    const frac = t - i0;
    const base = i0 - hn + 1;
    let acc = 0;
    let full = 0;
    for (let q = 0; q < T; q++) {
      const pos = Math.abs(frac - (q - hn + 1)) * sres;
      const ii = Math.floor(pos);
      if (ii >= lim) continue;
      const c = tb[ii] + (pos - ii) * dt[ii];
      full += c;
      const m = base + q;
      if (m >= 0 && m < n) acc += c * x[m];
    }
    // Normalize by the full-kernel DC gain (all taps, also those off the edges, so the
    // zero-padded borders fade naturally instead of being re-amplified).
    out[j] = full > 0 ? acc / full : 0;
  }
  return out;
}

/**
 * Resample a mono signal (windowed-sinc, Kaiser, >= 32 zero crossings per side).
 * Passband flat (±0.001 dB) to 0.45·min(from, to), stopband < −100 dB from 0.525·min.
 * Zero delay; output length round(n·to/from). Equal rates return a copy.
 * @param {Float32Array|Float64Array} signal
 * @param {number} fromRate Hz (> 0)
 * @param {number} toRate Hz (> 0)
 * @returns {Float32Array}
 */
export function resample(signal, fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0) || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
    throw new Error(`resample: invalid rates ${fromRate} → ${toRate}`);
  }
  if (fromRate === toRate) return Float32Array.from(signal);
  const n = signal.length;
  const outLen = Math.round((n * toRate) / fromRate);
  if (!n || !outLen) return new Float32Array(outLen);
  const plan = makePlan(fromRate, toRate);
  return plan.kind === 'rational'
    ? resampleRational(signal, outLen, plan)
    : resampleTable(signal, outLen, fromRate, toRate, plan);
}

/**
 * Resample every channel of an AudioData.
 * NOTE: returns the SAME object (not a copy) when audio.sampleRate === toRate — clone
 * before processing in place if the input must be preserved.
 * @param {{ sampleRate: number, channels: Float32Array[] }} audio
 * @param {number} toRate
 * @returns {{ sampleRate: number, channels: Float32Array[] }}
 */
export function resampleAudio(audio, toRate) {
  if (audio.sampleRate === toRate) return audio;
  const ch = audio.channels;
  const from = audio.sampleRate;
  if (ch.length === 2 && ch[0].length === ch[1].length && ch[0].length && from > 0 && toRate > 0) {
    const plan = makePlan(from, toRate);
    const outLen = Math.round((ch[0].length * toRate) / from);
    if (plan.kind === 'rational' && outLen) {
      return { sampleRate: toRate, channels: resampleRationalPair(ch[0], ch[1], outLen, plan) };
    }
  }
  return {
    sampleRate: toRate,
    channels: audio.channels.map((ch) => resample(ch, audio.sampleRate, toRate)),
  };
}
