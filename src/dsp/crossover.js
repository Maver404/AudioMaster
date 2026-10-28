// Phase-coherent Linkwitz-Riley 4th-order (24 dB/oct) multiband split (RESEARCH §7,
// RESEARCH 05 §5).
//
// Balanced tree: split at a middle crossover fm with LP4/HP4; every crossover that lives
// in the OTHER branch is applied to this branch as its LR4 allpass AP2 (LP4 + HP4 = AP2),
// so all bands share the same phase and their sum is ∏ AP2(f_i)·x — flat magnitude.
//   3 bands: low = LP4(f1)·AP2(f2), mid = HP4(f1)·LP4(f2), high = HP4(f1)·HP4(f2)
//   4 bands: split at f2; low branch gets AP2(f3), high branch gets AP2(f1)
// The compensation allpasses are folded into the branch cascade (one pass per branch).

import { design, linkwitzRiley4, processStereoInPlace } from './biquad.js';

function ap2(f, sr) {
  return design('allpass', f, sr, { q: Math.SQRT1_2 });
}

function sanitize(crossovers, sampleRate) {
  const out = [];
  for (const f of crossovers || []) {
    if (Number.isFinite(f) && f > 0) out.push(Math.min(Math.max(f, 1), 0.49 * sampleRate));
  }
  return out.sort((a, b) => a - b);
}

// chs: private channel buffers (mutated); out receives one channel array per band.
function splitRec(chs, fs, sampleRate, out) {
  if (!fs.length) {
    out.push(chs);
    return;
  }
  // Middle index: 1 crossover → 0, 2 → 0 (RESEARCH 3-band layout), 3 → 1, 4 → 1.
  const m = (fs.length - 1) >> 1;
  const fm = fs[m];
  const loFs = fs.slice(0, m);
  const hiFs = fs.slice(m + 1);
  const lo = chs.map((c) => Float32Array.from(c));
  const hi = chs; // reuse the private buffers for the high branch
  const loSecs = linkwitzRiley4('lowpass', fm, sampleRate);
  for (const f of hiFs) loSecs.push(ap2(f, sampleRate));
  const hiSecs = linkwitzRiley4('highpass', fm, sampleRate);
  for (const f of loFs) hiSecs.push(ap2(f, sampleRate));
  processStereoInPlace(lo, loSecs);
  processStereoInPlace(hi, hiSecs);
  splitRec(lo, loFs, sampleRate, out);
  splitRec(hi, hiFs, sampleRate, out);
}

/**
 * Split a mono signal into crossovers.length + 1 phase-coherent LR4 bands (low → high).
 * sumBands(result) = input through ∏ AP2(f_i): |sum| flat (±0.05 dB, in practice < 1e-5 dB).
 * The input is not modified.
 * @param {Float32Array} signal
 * @param {number[]} crossovers Hz, ascending (sorted defensively), 1..4 typical (any count works)
 * @param {number} sampleRate
 * @returns {Float32Array[]}
 */
export function splitBands(signal, crossovers, sampleRate) {
  const out = [];
  splitRec([Float32Array.from(signal)], sanitize(crossovers, sampleRate), sampleRate, out);
  return out.map((b) => b[0]);
}

/**
 * Stereo version (both channels filtered in one interleaved pass, independent state).
 * The inputs are not modified.
 * @param {Float32Array[]} channels [L, R] (any count)
 * @param {number[]} crossovers
 * @param {number} sampleRate
 * @returns {Float32Array[][]} bands[b] = [L, R]
 */
export function splitBandsStereo(channels, crossovers, sampleRate) {
  const out = [];
  splitRec(channels.map((c) => Float32Array.from(c)), sanitize(crossovers, sampleRate), sampleRate, out);
  return out;
}

/**
 * Sum bands sample by sample (Float64 accumulation).
 * @param {Float32Array[]} bands
 * @returns {Float32Array}
 */
export function sumBands(bands) {
  if (!bands.length) return new Float32Array(0);
  if (bands.length === 1) return Float32Array.from(bands[0]);
  const n = bands[0].length;
  const out = new Float32Array(n);
  const nb = bands.length;
  for (let i = 0; i < n; i++) {
    let s = bands[0][i];
    for (let b = 1; b < nb; b++) s += bands[b][i];
    out[i] = s;
  }
  return out;
}
