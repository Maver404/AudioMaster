// Small shared helpers: dB conversion, allocation, one-pole coefficients, PRNG, Kaiser
// window maths. Environment-neutral (Node, Worker, main thread).

/** @typedef {{ sampleRate: number, channels: Float32Array[] }} AudioData */

/** Floor used for amplitude → dB conversions (−240 dB), avoids log10(0). */
export const EPS = 1e-12;

/**
 * @param {number} db
 * @returns {number} 10^(db/20)
 */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * @param {number} g amplitude (sign ignored)
 * @returns {number} 20·log10(max(|g|, EPS)) — finite, −240 dB for silence
 */
export function gainToDb(g) {
  const a = Math.abs(g);
  return 20 * Math.log10(a > EPS ? a : EPS);
}

/**
 * @param {number} p power (mean square)
 * @returns {number} 10·log10(max(p, 1e-24)) — finite, −240 dB for silence
 */
export function powerToDb(p) {
  return 10 * Math.log10(p > 1e-24 ? p : 1e-24);
}

/**
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 */
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * One-pole smoothing coefficient a = exp(−1/(τ·fs)), used as y = a·y + (1 − a)·x.
 * τ is the 63.2 % (1 − 1/e) time constant (Giannoulis/Reiss convention, RESEARCH §7).
 * @param {number} ms time constant in milliseconds (<= 0 → 0, i.e. no smoothing)
 * @param {number} sampleRate
 */
export function timeCoef(ms, sampleRate) {
  if (!(ms > 0) || !(sampleRate > 0)) return 0;
  return Math.exp(-1 / (ms * 1e-3 * sampleRate));
}

/**
 * @param {number} sampleRate
 * @param {number} length
 * @param {number} [numChannels=2]
 * @returns {AudioData} zero-filled
 */
export function makeAudio(sampleRate, length, numChannels = 2) {
  const n = Math.max(0, Math.floor(length) || 0);
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(n));
  return { sampleRate, channels };
}

/**
 * @param {AudioData} audio
 * @returns {AudioData} deep copy (other enumerable fields copied shallowly)
 */
export function cloneAudio(audio) {
  return { ...audio, sampleRate: audio.sampleRate, channels: audio.channels.map((c) => Float32Array.from(c)) };
}

/**
 * @param {AudioData} audio
 * @returns {number} frames (channels[0].length, 0 if no channels)
 */
export function audioLength(audio) {
  return audio && audio.channels && audio.channels.length ? audio.channels[0].length : 0;
}

/**
 * Any channel count → [L, R].
 * * 1 channel: [c0, copy of c0] (two distinct arrays so in-place processing of one side
 *   never touches the other).
 * * 2 channels: the same two arrays (no copy).
 * * >2: simple ITU-style downmix, LFE dropped, surrounds/center at −3 dB:
 *   3 = L R C, 4 = L R Ls Rs (quad), 5 = L R C Ls Rs, 6+ = L R C LFE Ls Rs [Lb Rb …]
 *   (WAVE_FORMAT_EXTENSIBLE default order, which is also the Web Audio 5.1 order).
 *   No normalization: the mastering chain sets the level anyway.
 * @param {Float32Array[]} channels
 * @returns {Float32Array[]}
 */
export function toStereo(channels) {
  const n = channels.length;
  if (n === 0) return [new Float32Array(0), new Float32Array(0)];
  if (n === 1) return [channels[0], Float32Array.from(channels[0])];
  if (n === 2) return [channels[0], channels[1]];
  const len = channels[0].length;
  const L = Float32Array.from(channels[0]);
  const R = Float32Array.from(channels[1]);
  const g = Math.SQRT1_2;
  const addBoth = (c) => {
    for (let i = 0; i < len; i++) {
      const v = g * c[i];
      L[i] += v;
      R[i] += v;
    }
  };
  const addTo = (dst, c) => {
    for (let i = 0; i < len; i++) dst[i] += g * c[i];
  };
  let first; // first index of the surround pairs
  if (n === 3) {
    addBoth(channels[2]);
    return [L, R];
  } else if (n === 4) {
    first = 2;
  } else if (n === 5) {
    addBoth(channels[2]);
    first = 3;
  } else {
    addBoth(channels[2]); // centre; channels[3] = LFE, dropped
    first = 4;
  }
  for (let c = first; c < n; c++) addTo((c - first) % 2 === 0 ? L : R, channels[c]);
  return [L, R];
}

/**
 * @param {Float32Array[]} channels
 * @returns {Float32Array} (L + R)/2 (mean of all channels for other counts)
 */
export function mixToMono(channels) {
  const n = channels.length;
  if (n === 0) return new Float32Array(0);
  const len = channels[0].length;
  const out = new Float32Array(len);
  if (n === 2) {
    const a = channels[0], b = channels[1];
    for (let i = 0; i < len; i++) out[i] = 0.5 * (a[i] + b[i]);
    return out;
  }
  const g = 1 / n;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += channels[c][i];
    out[i] = s * g;
  }
  return out;
}

/**
 * Deterministic PRNG (mulberry32), identical sequence to tests/helpers.mjs rng().
 * @param {number} [seed=1]
 * @returns {() => number} uniform in [0, 1)
 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {Promise<void>} resolved on the next macrotask (setTimeout 0) */
export function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- extras (not part of the ARCHITECTURE contract, used by oversample/resample) ----

/**
 * Zeroth-order modified Bessel function of the first kind (power series).
 * @param {number} x
 */
export function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 500; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Kaiser β for a stopband attenuation of A dB (Oppenheim & Schafer; RESEARCH 05 §4.6).
 * @param {number} A
 */
export function kaiserBeta(A) {
  if (A > 50) return 0.1102 * (A - 8.7);
  if (A >= 21) return 0.5842 * Math.pow(A - 21, 0.4) + 0.07886 * (A - 21);
  return 0;
}

/**
 * Kaiser window value at normalized position u ∈ [−1, 1] (0 outside).
 * @param {number} u
 * @param {number} beta
 * @param {number} [i0beta] precomputed besselI0(beta)
 */
export function kaiser(u, beta, i0beta = besselI0(beta)) {
  if (u <= -1 || u >= 1) return u === 1 || u === -1 ? 1 / i0beta : 0;
  return besselI0(beta * Math.sqrt(1 - u * u)) / i0beta;
}

/**
 * Normalized sinc: sin(πx)/(πx).
 * @param {number} x
 */
export function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * @param {Float32Array|Float64Array} buf
 * @returns {number} max |x|
 */
export function peakAbs(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
}
