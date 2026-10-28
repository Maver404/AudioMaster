// RBJ Audio-EQ-Cookbook biquads (W3C WG Note 2021, RESEARCH 05 §11), bilinear Butterworth
// cascades, Linkwitz-Riley sections, Transposed Direct Form II processing with Float64
// state and analytic magnitude response.
//
// Section format (normalized, a0 = 1): { b0, b1, b2, a1, a2 }.
// A "filter" is a section or an array of sections (cascade).

import { clamp } from './util.js';

const BLOCK = 1024;

function normFreq(freq, sampleRate) {
  const f = Number.isFinite(freq) ? freq : 1000;
  return clamp(f, 1, 0.49 * sampleRate);
}

function normalize(b0, b1, b2, a0, a1, a2) {
  const ia = 1 / a0;
  return { b0: b0 * ia, b1: b1 * ia, b2: b2 * ia, a1: a1 * ia, a2: a2 * ia };
}

/**
 * RBJ cookbook biquad.
 * @param {'lowpass'|'highpass'|'bandpass'|'notch'|'allpass'|'peaking'|'lowshelf'|'highshelf'} type
 *   'bandpass' is the constant 0 dB peak-gain variant (BP0).
 * @param {number} freq Hz, clamped to [1 Hz, 0.49·sampleRate]
 * @param {number} sampleRate
 * @param {{ q?: number, gainDb?: number, slope?: number }} [opts]
 *   q defaults to 1/√2; shelves use q unless `slope` (S, 1 = steepest monotonic) is given.
 * @returns {{ b0: number, b1: number, b2: number, a1: number, a2: number }}
 */
export function design(type, freq, sampleRate, opts = {}) {
  const f0 = normFreq(freq, sampleRate);
  let q = opts.q === undefined ? Math.SQRT1_2 : +opts.q;
  if (!(q > 0) || !Number.isFinite(q)) q = Math.SQRT1_2;
  q = clamp(q, 1e-3, 1e3);
  const gainDb = Number.isFinite(opts.gainDb) ? opts.gainDb : 0;
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  let alpha = sn / (2 * q);
  switch (type) {
    case 'lowpass':
      return normalize((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
    case 'highpass':
      return normalize((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
    case 'bandpass':
      return normalize(alpha, 0, -alpha, 1 + alpha, -2 * cs, 1 - alpha);
    case 'notch':
      return normalize(1, -2 * cs, 1, 1 + alpha, -2 * cs, 1 - alpha);
    case 'allpass':
      return normalize(1 - alpha, -2 * cs, 1 + alpha, 1 + alpha, -2 * cs, 1 - alpha);
    case 'peaking':
      return normalize(1 + alpha * A, -2 * cs, 1 - alpha * A, 1 + alpha / A, -2 * cs, 1 - alpha / A);
    case 'lowshelf':
    case 'highshelf': {
      if (opts.slope !== undefined && opts.slope > 0) {
        const S = Math.min(+opts.slope, 1e3);
        const k = (A + 1 / A) * (1 / S - 1) + 2;
        alpha = (sn / 2) * Math.sqrt(Math.max(k, 1e-12));
      }
      const t = 2 * Math.sqrt(A) * alpha;
      if (type === 'lowshelf') {
        return normalize(
          A * (A + 1 - (A - 1) * cs + t),
          2 * A * (A - 1 - (A + 1) * cs),
          A * (A + 1 - (A - 1) * cs - t),
          A + 1 + (A - 1) * cs + t,
          -2 * (A - 1 + (A + 1) * cs),
          A + 1 + (A - 1) * cs - t,
        );
      }
      return normalize(
        A * (A + 1 + (A - 1) * cs + t),
        -2 * A * (A - 1 + (A + 1) * cs),
        A * (A + 1 + (A - 1) * cs - t),
        A + 1 - (A - 1) * cs + t,
        2 * (A - 1 - (A + 1) * cs),
        A + 1 - (A - 1) * cs - t,
      );
    }
    default:
      throw new Error(`biquad.design: unknown type "${type}"`);
  }
}

/**
 * First-order bilinear (pre-warped) section, b2 = a2 = 0.
 * LP1 + HP1 = 1 exactly (complementary), which dynamics.js relies on for its
 * perfect-reconstruction shelf. 'allpass' (first order) is also available.
 * @param {'lowpass'|'highpass'|'allpass'} type
 * @param {number} freq Hz, clamped to [1 Hz, 0.49·sampleRate]
 * @param {number} sampleRate
 */
export function firstOrder(type, freq, sampleRate) {
  const f0 = normFreq(freq, sampleRate);
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const a1 = (K - 1) / (K + 1);
  switch (type) {
    case 'lowpass':
      return { b0: K / (1 + K), b1: K / (1 + K), b2: 0, a1, a2: 0 };
    case 'highpass':
      return { b0: 1 / (1 + K), b1: -1 / (1 + K), b2: 0, a1, a2: 0 };
    case 'allpass':
      return { b0: a1, b1: 1, b2: 0, a1, a2: 0 };
    default:
      throw new Error(`biquad.firstOrder: unknown type "${type}"`);
  }
}

/**
 * Digital Butterworth (bilinear, pre-warped at freq, so exactly −3.01 dB at freq) as a
 * cascade of RBJ sections with Q_k = 1/(2·sin(π(2k+1)/(2N))); odd orders add a
 * first-order section.
 * @param {'lowpass'|'highpass'} type
 * @param {number} order 1..8 (rounded, clamped)
 * @param {number} freq
 * @param {number} sampleRate
 * @returns {Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>}
 */
export function butterworth(type, order, freq, sampleRate) {
  if (type !== 'lowpass' && type !== 'highpass') throw new Error(`butterworth: unknown type "${type}"`);
  if (!Number.isFinite(order)) throw new Error('butterworth: order must be a number');
  const N = clamp(Math.round(order), 1, 8);
  const sections = [];
  for (let k = 0; k < Math.floor(N / 2); k++) {
    const q = 1 / (2 * Math.sin((Math.PI * (2 * k + 1)) / (2 * N)));
    sections.push(design(type, freq, sampleRate, { q }));
  }
  if (N % 2 === 1) sections.push(firstOrder(type, freq, sampleRate));
  return sections;
}

/**
 * Linkwitz-Riley 4th order (24 dB/oct): two identical Butterworth Q = 1/√2 sections.
 * LP4(f) + HP4(f) = AP2(f) = design('allpass', f, sr) (RESEARCH §7).
 * @param {'lowpass'|'highpass'} type
 * @param {number} freq
 * @param {number} sampleRate
 */
export function linkwitzRiley4(type, freq, sampleRate) {
  if (type !== 'lowpass' && type !== 'highpass') throw new Error(`linkwitzRiley4: unknown type "${type}"`);
  const s = design(type, freq, sampleRate, { q: Math.SQRT1_2 });
  return [s, { ...s }];
}

function asSections(sections) {
  if (!sections) return [];
  return Array.isArray(sections) ? sections : [sections];
}

/**
 * Process a buffer in place through a cascade (TDF-II, Float64 state, fresh state).
 * Sections run block-wise over a Float64 scratch so intermediate signals between
 * sections are never rounded to float32. The state update is written as
 * s1 = (b1·x + s2) − a1·y so the recursive critical path is add → mul → sub only.
 * @param {Float32Array|Float64Array} buffer
 * @param {object|object[]} sections
 * @returns {Float32Array|Float64Array} the same buffer
 */
export function processInPlace(buffer, sections) {
  const secs = asSections(sections);
  const ns = secs.length;
  const n = buffer.length;
  if (!ns || !n) return buffer;
  const state = new Float64Array(2 * ns);
  const tmp = new Float64Array(Math.min(BLOCK, n));
  for (let start = 0; start < n; start += BLOCK) {
    const len = Math.min(BLOCK, n - start);
    for (let i = 0; i < len; i++) tmp[i] = buffer[start + i];
    for (let s = 0; s < ns; s++) {
      const c = secs[s];
      const b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
      let s1 = state[2 * s], s2 = state[2 * s + 1];
      for (let i = 0; i < len; i++) {
        const x = tmp[i];
        const y = b0 * x + s1;
        s1 = (b1 * x + s2) - a1 * y;
        s2 = b2 * x - a2 * y;
        tmp[i] = y;
      }
      // Flush tiny states so decays into silence never reach (slow) subnormals.
      if (Math.abs(s1) < 1e-30) s1 = 0;
      if (Math.abs(s2) < 1e-30) s2 = 0;
      state[2 * s] = s1;
      state[2 * s + 1] = s2;
    }
    for (let i = 0; i < len; i++) buffer[start + i] = tmp[i];
  }
  return buffer;
}

/** Two equal-length channels in one loop: two independent recursions → ~2x throughput. */
function processPairInPlace(bufA, bufB, secs) {
  const ns = secs.length;
  const n = bufA.length;
  const state = new Float64Array(4 * ns);
  const ta = new Float64Array(Math.min(BLOCK, n));
  const tb = new Float64Array(Math.min(BLOCK, n));
  for (let start = 0; start < n; start += BLOCK) {
    const len = Math.min(BLOCK, n - start);
    for (let i = 0; i < len; i++) {
      ta[i] = bufA[start + i];
      tb[i] = bufB[start + i];
    }
    for (let s = 0; s < ns; s++) {
      const c = secs[s];
      const b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
      const k = 4 * s;
      let s1a = state[k], s2a = state[k + 1], s1b = state[k + 2], s2b = state[k + 3];
      for (let i = 0; i < len; i++) {
        const xa = ta[i], xb = tb[i];
        const ya = b0 * xa + s1a;
        const yb = b0 * xb + s1b;
        s1a = (b1 * xa + s2a) - a1 * ya;
        s1b = (b1 * xb + s2b) - a1 * yb;
        s2a = b2 * xa - a2 * ya;
        s2b = b2 * xb - a2 * yb;
        ta[i] = ya;
        tb[i] = yb;
      }
      if (Math.abs(s1a) < 1e-30) s1a = 0;
      if (Math.abs(s2a) < 1e-30) s2a = 0;
      if (Math.abs(s1b) < 1e-30) s1b = 0;
      if (Math.abs(s2b) < 1e-30) s2b = 0;
      state[k] = s1a;
      state[k + 1] = s2a;
      state[k + 2] = s1b;
      state[k + 3] = s2b;
    }
    for (let i = 0; i < len; i++) {
      bufA[start + i] = ta[i];
      bufB[start + i] = tb[i];
    }
  }
}

/**
 * Process every channel in place with its own (fresh) state. Two equal-length channels
 * are filtered in one interleaved loop (same results as processInPlace per channel).
 * @param {Array<Float32Array|Float64Array>} channels
 * @param {object|object[]} sections
 * @returns {Array<Float32Array|Float64Array>} the same channels
 */
export function processStereoInPlace(channels, sections) {
  const secs = asSections(sections);
  if (!secs.length) return channels;
  let c = 0;
  for (; c + 1 < channels.length; c += 2) {
    const a = channels[c], b = channels[c + 1];
    if (a.length === b.length && a.length) processPairInPlace(a, b, secs);
    else {
      processInPlace(a, secs);
      processInPlace(b, secs);
    }
  }
  if (c < channels.length) processInPlace(channels[c], secs);
  return channels;
}

/**
 * Analytic magnitude of the cascade, in dB, using the numerically robust
 * φ = sin²(ω/2) form: |B|² = (b0+b1+b2)² − 4φ(b0b1 + b1b2 + 4b0b2) + 16φ²·b0b2.
 * @param {object|object[]} sections
 * @param {number|ArrayLike<number>} freq Hz (number → number, array → Float64Array)
 * @param {number} sampleRate
 * @returns {number|Float64Array}
 */
export function responseDb(sections, freq, sampleRate) {
  const secs = asSections(sections);
  const one = (f) => {
    const s = Math.sin((Math.PI * f) / sampleRate);
    const phi = s * s;
    let db = 0;
    for (let i = 0; i < secs.length; i++) {
      const { b0, b1, b2, a1, a2 } = secs[i];
      const bs = b0 + b1 + b2;
      const as = 1 + a1 + a2;
      const num = bs * bs - 4 * phi * (b0 * b1 + b1 * b2 + 4 * b0 * b2) + 16 * phi * phi * b0 * b2;
      const den = as * as - 4 * phi * (a1 + a1 * a2 + 4 * a2) + 16 * phi * phi * a2;
      const r = Math.max(num, 0) / Math.max(den, 1e-300);
      db += 10 * Math.log10(r > 1e-30 ? r : 1e-30);
    }
    return db;
  };
  if (typeof freq === 'number') return one(freq);
  const out = new Float64Array(freq.length);
  for (let i = 0; i < freq.length; i++) out[i] = one(freq[i]);
  return out;
}

/**
 * Per-sample cascade for sidechains / dynamic EQ (TDF-II, Float64 state).
 */
export class BiquadCascade {
  /** @param {object|object[]} sections */
  constructor(sections) {
    this.setSections(sections);
  }

  /**
   * Replace coefficients; keeps the state when the section count is unchanged
   * (smooth for slowly varying coefficients), otherwise resets.
   * @param {object|object[]} sections
   */
  setSections(sections) {
    const secs = asSections(sections);
    const ns = secs.length;
    if (!this.coef || this.n !== ns) {
      this.n = ns;
      this.coef = new Float64Array(5 * ns);
      this.state = new Float64Array(2 * ns);
    }
    for (let s = 0; s < ns; s++) {
      const c = secs[s];
      this.coef[5 * s] = c.b0;
      this.coef[5 * s + 1] = c.b1;
      this.coef[5 * s + 2] = c.b2;
      this.coef[5 * s + 3] = c.a1;
      this.coef[5 * s + 4] = c.a2;
    }
  }

  /**
   * @param {number} x
   * @returns {number} y
   */
  process(x) {
    const c = this.coef, st = this.state, ns = this.n;
    let v = x;
    for (let s = 0, k = 0, j = 0; s < ns; s++, k += 5, j += 2) {
      const y = c[k] * v + st[j];
      st[j] = (c[k + 1] * v + st[j + 1]) - c[k + 3] * y;
      st[j + 1] = c[k + 2] * v - c[k + 4] * y;
      v = y;
    }
    return v;
  }

  /** Clear the filter state. */
  reset() {
    this.state.fill(0);
  }
}
