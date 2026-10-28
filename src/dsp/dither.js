// Float → integer PCM with TPDF dither and optional noise shaping.
//
// Why TPDF: the sum of two independent uniform variables (±0.5 LSB each) makes the
// first and second moments of the total error independent of the signal, so the
// quantization error becomes a benign, signal-independent noise floor (Lipshitz,
// Wannamaker & Vanderkooy, JAES 1992). Total error variance = 1/12 (rounding) +
// 2·1/12 (dither) = 1/4 LSB², i.e. +4.77 dB over plain rounding.
//
// Noise shaping (error feedback, SoX `dither.c` sign convention, RESEARCH §7):
//   v = x·S − Σ c_k·e[n−1−k];  q = round(v + d);  e[n] = q − v  (stored error includes d)
//   ⇒ NTF(z) = 1 − Σ c_k z^−(k+1).
// lip44 (Lipshitz, 44.1 kHz) gives ≈ −16.6 dB at DC, −27 dB near 4 kHz and +19.4 dB at
// Nyquist: noise is moved to where hearing is least sensitive. The coefficients are
// designed for 44.1 kHz only, so 'auto' enables them only for 16-bit at exactly 44.1 kHz
// (RESEARCH §8.8); every other case is flat TPDF. The stored error is limited to ±4 LSB so
// clipped passages cannot drive the feedback loop unstable.
//
// Scaling: full scale = 2^(bits−1) (x = −1 ↦ −32768), clamped to [−2^(b−1), 2^(b−1)−1].
// This is the convention of FFmpeg/libsndfile, so int → float → int round trips are exact.
//
// Determinism: a seeded mulberry32 stream per channel (inlined for speed). Dither must be
// the very last processing step (no gain/SRC afterwards).

/** Lipshitz 5-tap error-feedback filter for 44.1 kHz (SoX `lip44`). */
export const LIP44 = Object.freeze([2.033, -2.165, 1.959, -1.590, 0.6149]);

const SUPPORTED_BITS = [8, 16, 24, 32];

/**
 * Resolve the noise-shaping filter for a given output format.
 * @param {number} bitDepth
 * @param {number|undefined} sampleRate
 * @param {'auto'|'none'|'off'|false|'lip44'|number[]} [mode='auto']
 * @returns {Float64Array|null} error-feedback coefficients, or null for flat TPDF
 */
export function noiseShapingFilter(bitDepth, sampleRate, mode = 'auto') {
  if (mode === 'auto' || mode === true || mode === undefined || mode === null) {
    return bitDepth === 16 && sampleRate === 44100 ? Float64Array.from(LIP44) : null;
  }
  if (mode === 'lip44') return Float64Array.from(LIP44);
  if (Array.isArray(mode) || ArrayBuffer.isView(mode)) {
    return mode.length ? Float64Array.from(mode) : null;
  }
  return null; // 'none' | 'off' | false
}

/** Per-channel seed: decorrelated streams from one user seed (murmur3 finalizer). */
function channelSeed(seed, c) {
  let h = (Math.imul((seed | 0) ^ 0x5bd1e995, 0x9e3779b1) + Math.imul(c + 1, 0x85ebca77)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Stateful quantizer: converts float audio to integer PCM block by block while keeping
 * dither PRNG and noise-shaping state continuous across blocks (so encoders can stream
 * without a full-length intermediate buffer). Results are identical to one-shot
 * {@link floatToPcm} with the same options.
 */
export class PcmQuantizer {
  /**
   * @param {number} numChannels
   * @param {number} bitDepth 8|16|24|32 (24-bit values are returned in Int32)
   * @param {{ sampleRate?: number, dither?: 'tpdf'|'none'|boolean, noiseShaping?: any, seed?: number }} [opts]
   */
  constructor(numChannels, bitDepth, opts = {}) {
    if (!SUPPORTED_BITS.includes(bitDepth)) throw new RangeError(`unsupported bit depth ${bitDepth}`);
    const { sampleRate, dither = 'tpdf', noiseShaping = 'auto', seed = 1 } = opts;
    this.numChannels = Math.max(1, numChannels | 0);
    this.bitDepth = bitDepth;
    this.scale = 2 ** (bitDepth - 1);
    this.max = this.scale - 1;
    this.min = -this.scale;
    this.dither = dither === true || dither === 'tpdf';
    // Noise shaping without dither can produce limit cycles / tones: only with TPDF.
    this.coefs = this.dither ? noiseShapingFilter(bitDepth, sampleRate, noiseShaping) : null;
    this.rng = new Uint32Array(this.numChannels);
    this.err = [];
    for (let c = 0; c < this.numChannels; c++) {
      this.rng[c] = channelSeed(seed, c);
      this.err.push(new Float64Array(this.coefs ? this.coefs.length : 0));
    }
  }

  /**
   * Quantize src[start..end) of channel `c` into out[outOffset + k·stride].
   * @param {Float32Array|Float64Array} src
   * @param {number} start
   * @param {number} end
   * @param {Int8Array|Int16Array|Int32Array} out
   * @param {number} outOffset
   * @param {number} stride
   * @param {number} c channel index (selects PRNG and error state)
   */
  quantizeChannel(src, start, end, out, outOffset, stride, c) {
    if (this.bitDepth > 24) return this._quantizeWide(src, start, end, out, outOffset, stride, c);
    const S = this.scale;
    const max = this.max;
    const min = this.min;
    const lim = 2 * S; // pre-clamp keeps NaN/Inf/huge values out of the arithmetic
    // floor(x) as ((x + OFF) | 0) − OFF: exact for |x| < OFF and ~3× faster than
    // Math.round in V8; OFF + lim + 2 stays far below 2^31 for <= 24-bit.
    const OFF = 4 * S;
    let o = outOffset;
    if (!this.dither) {
      const K = OFF + 0.5; // round half up
      for (let i = start; i < end; i++, o += stride) {
        let v = src[i] * S;
        if (!(v === v)) v = 0;
        else if (v > lim) v = lim;
        else if (v < -lim) v = -lim;
        let q = ((v + K) | 0) - OFF;
        if (q > max) q = max;
        else if (q < min) q = min;
        out[o] = q;
      }
      return;
    }
    // TPDF d = r1 + r2 − 1 with r1, r2 uniform in [0, 1): the two 16-bit halves of one
    // mulberry32 draw (1/65536-LSB resolution is far finer than needed).
    // round(v + d) = floor(v + r1 + r2 − 0.5)  →  K = OFF − 0.5
    const K = OFF - 0.5;
    const U = 1 / 65536;
    let a = this.rng[c] | 0;
    const cf = this.coefs;
    if (!cf) {
      for (let i = start; i < end; i++, o += stride) {
        let v = src[i] * S;
        if (!(v === v)) v = 0;
        else if (v > lim) v = lim;
        else if (v < -lim) v = -lim;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        t ^= t >>> 14;
        let q = ((v + ((t & 0xffff) + (t >>> 16)) * U + K) | 0) - OFF;
        if (q > max) q = max;
        else if (q < min) q = min;
        out[o] = q;
      }
      this.rng[c] = a >>> 0;
      return;
    }
    // Error feedback: v = x − Σ c_k e[n−1−k]; q = round(v + d); e[n] = clamp(q − v, ±4).
    const e = this.err[c];
    if (cf.length === 5) {
      // lip44 fast path: history in registers
      const c0 = cf[0], c1 = cf[1], c2 = cf[2], c3 = cf[3], c4 = cf[4];
      let e0 = e[0], e1 = e[1], e2 = e[2], e3 = e[3], e4 = e[4];
      for (let i = start; i < end; i++, o += stride) {
        let x = src[i] * S;
        if (!(x === x)) x = 0;
        else if (x > lim) x = lim;
        else if (x < -lim) x = -lim;
        const v = x - (c0 * e0 + c1 * e1 + c2 * e2 + c3 * e3 + c4 * e4);
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        t ^= t >>> 14;
        let q = ((v + ((t & 0xffff) + (t >>> 16)) * U + K) | 0) - OFF;
        if (q > max) q = max;
        else if (q < min) q = min;
        out[o] = q;
        let err = q - v;
        if (err > 4) err = 4;
        else if (err < -4) err = -4;
        e4 = e3; e3 = e2; e2 = e1; e1 = e0; e0 = err;
      }
      e[0] = e0; e[1] = e1; e[2] = e2; e[3] = e3; e[4] = e4;
      this.rng[c] = a >>> 0;
      return;
    }
    const N = cf.length;
    for (let i = start; i < end; i++, o += stride) {
      let x = src[i] * S;
      if (!(x === x)) x = 0;
      else if (x > lim) x = lim;
      else if (x < -lim) x = -lim;
      let v = x;
      for (let k = 0; k < N; k++) v -= cf[k] * e[k];
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      t ^= t >>> 14;
      let q = ((v + ((t & 0xffff) + (t >>> 16)) * U + K) | 0) - OFF;
      if (q > max) q = max;
      else if (q < min) q = min;
      out[o] = q;
      let err = q - v;
      if (err > 4) err = 4;
      else if (err < -4) err = -4;
      for (let k = N - 1; k > 0; k--) e[k] = e[k - 1];
      e[0] = err;
    }
    this.rng[c] = a >>> 0;
  }

  /** 32-bit integer output (no shaping): Math.floor path, the |0 trick would overflow. */
  _quantizeWide(src, start, end, out, outOffset, stride, c) {
    const S = this.scale;
    const max = this.max;
    const min = this.min;
    const U = 1 / 65536;
    let a = this.rng[c] | 0;
    for (let i = start, o = outOffset; i < end; i++, o += stride) {
      let v = src[i] * S;
      if (!(v === v)) v = 0;
      let d = 0.5;
      if (this.dither) {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        t ^= t >>> 14;
        d = ((t & 0xffff) + (t >>> 16)) * U - 0.5;
      }
      let q = Math.floor(v + d);
      if (q > max) q = max;
      else if (q < min) q = min;
      out[o] = q;
    }
    this.rng[c] = a >>> 0;
  }

  /**
   * Quantize frames [start, end) of all channels into an interleaved buffer
   * (out[0] = ch0[start], out[1] = ch1[start], …). Missing channels repeat the last one.
   * @param {Array<Float32Array|Float64Array>} channels
   * @param {number} start
   * @param {number} end
   * @param {Int8Array|Int16Array|Int32Array} out length >= (end − start)·numChannels
   * @returns {Int8Array|Int16Array|Int32Array} out
   */
  quantizeInterleaved(channels, start, end, out) {
    const n = this.numChannels;
    for (let c = 0; c < n; c++) {
      const src = channels[Math.min(c, channels.length - 1)];
      this.quantizeChannel(src, start, end, out, c, n, c);
    }
    return out;
  }
}

/**
 * Convert float audio to interleaved integer PCM (the final step before encoding).
 * @param {Float32Array[]} channels 1..n channels (same length; the shortest wins)
 * @param {16|24} bitDepth also accepts 8 and 32 (signed; 8-bit WAV needs +128 offset by the writer)
 * @param {{ sampleRate?: number, dither?: 'tpdf'|'none', noiseShaping?: 'auto'|'none'|'lip44'|number[], seed?: number }} [opts]
 *   noiseShaping 'auto' = lip44 only for 16-bit at 44.1 kHz, flat TPDF otherwise.
 * @returns {Int16Array|Int32Array} interleaved samples (Int16Array for 16-bit, Int32Array
 *   holding 24-bit values for 24-bit), clamped to the integer range (never wraps)
 */
export function floatToPcm(channels, bitDepth, opts = {}) {
  const nCh = channels ? channels.length : 0;
  let n = nCh ? Infinity : 0;
  for (let c = 0; c < nCh; c++) n = Math.min(n, channels[c].length);
  const Out = bitDepth === 16 ? Int16Array : bitDepth === 8 ? Int8Array : Int32Array;
  if (!SUPPORTED_BITS.includes(bitDepth)) throw new RangeError(`unsupported bit depth ${bitDepth}`);
  const out = new Out(n * nCh);
  if (!n) return out;
  new PcmQuantizer(nCh, bitDepth, opts).quantizeInterleaved(channels, 0, n, out);
  return out;
}
