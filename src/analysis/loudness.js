// ITU-R BS.1770-4/-5 loudness (EBU R 128): integrated (gated), momentary, short-term,
// EBU Tech 3342 loudness range (LRA), sample / true peak and a short-term curve.
//
// Design (libebur128 / ffmpeg ebur128 approach, RESEARCH §7, research/05 §1.6):
// ONE K-weighting pass accumulates the K-weighted energy Σy² of every channel in
// consecutive 100 ms "grains" (round(0.1·fs) samples). Every reading is then a sum of
// whole grains, so nothing is filtered twice:
//   momentary / gating block = 4 grains  (400 ms, hop 100 ms = the 75 % overlap of BS.1770)
//   short-term window        = 30 grains (3 s, hop 100 ms; Tech 3342 V4 asks for >= 10 Hz)
// The block set equals ffmpeg's ebur128 filter exactly (its 400 ms / 3 s caches are
// evaluated every sr/10 samples): momentary / short-term values agree to its 3-decimal
// output, integrated within 0.01 LU (ffmpeg floors block loudness into 0.01 LU histogram
// bins). LRA follows the Tech 3342 percentiles s[round((n−1)·p)] (0-based); ffmpeg takes
// the 1-based rank round(n·p), i.e. one value lower at both ends, which moves LRA by up
// to ~0.15 LU on short, fast-changing material and vanishes on steady or long programme.
// (libebur128 — used by ffmpeg's *loudnorm* — spaces its LRA short-term blocks 1 s
// apart, a further source of small differences against that tool.)
// True peak: see measureTruePeakDb().
//
// Conventions:
// * K-weighting coefficients are derived for ANY sample rate with libebur128's analog
//   prototype constants (they reproduce the BS.1770 48 kHz tables to all printed
//   digits). The stage-2 numerator stays [1, −2, 1] un-normalized, as in the Rec. and in
//   libebur128/ffmpeg: it adds +0.043 dB at 48 kHz (+0.047 at 44.1, +0.022 at 96 kHz),
//   which the −0.691 dB constant assumes; normalizing it would shift readings ~0.04 dB.
// * Channel weights G = 1 for every channel (L, R; internal audio is always stereo). A
//   single channel is measured as true mono (weight 1), i.e. 3.01 dB below the same
//   audio as dual-mono — callers duplicate mono files first (RESEARCH §7).
// * Powers are averaged, never dB values. Gates are evaluated in the power domain.
// * Incomplete trailing blocks are discarded (BS.1770). No silence is appended.
// * Silence → integrated / momentaryMax / shortTermMax = −Infinity (contract), LRA = 0,
//   peaks = −240 dB (util EPS floor, finite), curve entries = CURVE_FLOOR_LUFS. Inputs
//   shorter than 100 ms have no complete grain and read as silence for loudness (peaks
//   are still measured). A grain containing NaN/±Infinity samples is counted as silent
//   and resets the filter, so a corrupt sample can never turn a reading into NaN.

import { processStereoInPlace } from '../dsp/biquad.js';
import { truePeakDb, truePeakFactor } from '../dsp/oversample.js';
import { gainToDb } from '../dsp/util.js';

/** Floor for loudnessCurve() / measure().curve entries of silent windows (finite, LUFS). */
export const CURVE_FLOOR_LUFS = -120;

const LK_OFFSET = -0.691; // BS.1770 constant: cancels the K-weighting gain at 997 Hz
const ABS_GATE_LUFS = -70;
const P_ABS = Math.pow(10, (ABS_GATE_LUFS - LK_OFFSET) / 10); // power of a −70 LUFS block
const P_CURVE_FLOOR = Math.pow(10, (CURVE_FLOOR_LUFS - LK_OFFSET) / 10);
const REL_GATE_I = 0.1; // −10 LU (BS.1770-2+), as a power ratio
const REL_GATE_LRA = 0.01; // −20 LU (Tech 3342), as a power ratio
const BLOCK_GRAINS = 4; // 400 ms
const SHORT_GRAINS = 30; // 3 s

function checkRate(sampleRate) {
  const fs = +sampleRate;
  if (!(fs > 0) || !Number.isFinite(fs)) throw new RangeError(`loudness: invalid sampleRate ${sampleRate}`);
  return fs;
}

function asChannels(channels) {
  if (!channels) return [];
  return ArrayBuffer.isView(channels) ? [channels] : Array.from(channels);
}

function lufs(p) {
  return p > 0 ? LK_OFFSET + 10 * Math.log10(p) : -Infinity;
}

/**
 * K-weighting filter (BS.1770 Annex 1) as two biquad sections for any sample rate,
 * derived from the analog prototype (libebur128 / Brecht De Man constants):
 * stage 1 = high shelf (head acoustics, ≈ +4 dB above 2 kHz), stage 2 = RLB high-pass
 * (≈ 38 Hz) with the un-normalized [1, −2, 1] numerator of the Rec.
 * At 48 kHz this reproduces BS.1770 Tables 1 and 2 to all 14 printed decimals.
 * @param {number} sampleRate Hz
 * @returns {Array<{ b0: number, b1: number, b2: number, a1: number, a2: number }>} [shelf, highpass]
 */
export function kWeightingSections(sampleRate) {
  const fs = checkRate(sampleRate);
  // Stage 1: high shelf. (f0 is clamped below Nyquist only for absurdly low rates.)
  let f0 = Math.min(1681.974450955533, 0.49 * fs);
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass; numerator deliberately NOT divided by a0 (see header).
  f0 = Math.min(38.13547087602444, 0.49 * fs);
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, highpass];
}

// ------------------------------------------------------------------ the one pass

// K-weighting + per-grain energy for two channels at once: two independent recursions
// per loop iteration roughly double throughput (same trick as biquad.js). Per grain,
// stage 1 runs into a float64 scratch, then stage 2 squares and accumulates; splitting
// the stages keeps V8's register pressure low (measured ~10 % faster than one fused loop).
// All state and accumulation in float64. Adds Σ(yL² + yR²) of grain g into e[g]; with
// `peak` (an object { v }) it also tracks the sample peak of the processed samples.
function grainsPair(xa, xb, nG, grain, k1, k2, e, peak) {
  const b0 = k1.b0, b1 = k1.b1, b2 = k1.b2, a1 = k1.a1, a2 = k1.a2;
  const c1 = k2.a1, c2 = k2.a2;
  const tA = new Float64Array(grain), tB = new Float64Array(grain);
  let pa1 = 0, pa2 = 0, qa1 = 0, qa2 = 0;
  let pb1 = 0, pb2 = 0, qb1 = 0, qb2 = 0;
  let mA = 0, mB = 0;
  for (let g = 0, s = 0; g < nG; g++, s += grain) {
    const gA = mA, gB = mB;
    if (peak) {
      for (let i = 0; i < grain; i++) {
        const xA = xa[s + i], xB = xb[s + i];
        const yA = b0 * xA + pa1;
        const yB = b0 * xB + pb1;
        pa1 = (b1 * xA + pa2) - a1 * yA;
        pb1 = (b1 * xB + pb2) - a1 * yB;
        pa2 = b2 * xA - a2 * yA;
        pb2 = b2 * xB - a2 * yB;
        tA[i] = yA;
        tB[i] = yB;
        const aA = Math.abs(xA), aB = Math.abs(xB);
        if (aA > mA) mA = aA;
        if (aB > mB) mB = aB;
      }
    } else {
      for (let i = 0; i < grain; i++) {
        const xA = xa[s + i], xB = xb[s + i];
        const yA = b0 * xA + pa1;
        const yB = b0 * xB + pb1;
        pa1 = (b1 * xA + pa2) - a1 * yA;
        pb1 = (b1 * xB + pb2) - a1 * yB;
        pa2 = b2 * xA - a2 * yA;
        pb2 = b2 * xB - a2 * yB;
        tA[i] = yA;
        tB[i] = yB;
      }
    }
    let accA = 0, accB = 0;
    for (let i = 0; i < grain; i++) {
      const yA = tA[i], yB = tB[i];
      const zA = yA + qa1;
      const zB = yB + qb1;
      qa1 = (qa2 - 2 * yA) - c1 * zA;
      qb1 = (qb2 - 2 * yB) - c1 * zB;
      qa2 = yA - c2 * zA;
      qb2 = yB - c2 * zB;
      accA += zA * zA;
      accB += zB * zB;
    }
    const acc = accA + accB;
    if (acc < Infinity) e[g] += acc;
    else {
      // NaN/Inf in the input: count the grain as silent, restart the filters and keep
      // the peak of the previous grains (Math.abs(NaN) never wins a comparison anyway).
      pa1 = pa2 = qa1 = qa2 = pb1 = pb2 = qb1 = qb2 = 0;
      if (!(mA < Infinity)) mA = gA;
      if (!(mB < Infinity)) mB = gB;
    }
    // Flush decays into silence before they reach (slow on x86) subnormals.
    if (Math.abs(pa1) < 1e-30) pa1 = 0;
    if (Math.abs(pa2) < 1e-30) pa2 = 0;
    if (Math.abs(qa1) < 1e-30) qa1 = 0;
    if (Math.abs(qa2) < 1e-30) qa2 = 0;
    if (Math.abs(pb1) < 1e-30) pb1 = 0;
    if (Math.abs(pb2) < 1e-30) pb2 = 0;
    if (Math.abs(qb1) < 1e-30) qb1 = 0;
    if (Math.abs(qb2) < 1e-30) qb2 = 0;
  }
  if (peak) peak.v = Math.max(peak.v, mA, mB);
}

function grainsSingle(x, nG, grain, k1, k2, e, peak) {
  const b0 = k1.b0, b1 = k1.b1, b2 = k1.b2, a1 = k1.a1, a2 = k1.a2;
  const c1 = k2.a1, c2 = k2.a2;
  const t = new Float64Array(grain);
  let p1 = 0, p2 = 0, q1 = 0, q2 = 0;
  let m = 0;
  for (let g = 0, s = 0; g < nG; g++, s += grain) {
    const gm = m;
    for (let i = 0; i < grain; i++) {
      const xi = x[s + i];
      const y = b0 * xi + p1;
      p1 = (b1 * xi + p2) - a1 * y;
      p2 = b2 * xi - a2 * y;
      t[i] = y;
      const a = Math.abs(xi);
      if (a > m) m = a;
    }
    let acc = 0;
    for (let i = 0; i < grain; i++) {
      const y = t[i];
      const z = y + q1;
      q1 = (q2 - 2 * y) - c1 * z;
      q2 = y - c2 * z;
      acc += z * z;
    }
    if (acc < Infinity) e[g] += acc;
    else {
      p1 = p2 = q1 = q2 = 0;
      if (!(m < Infinity)) m = gm;
    }
    if (Math.abs(p1) < 1e-30) p1 = 0;
    if (Math.abs(p2) < 1e-30) p2 = 0;
    if (Math.abs(q1) < 1e-30) q1 = 0;
    if (Math.abs(q2) < 1e-30) q2 = 0;
  }
  if (peak) peak.v = Math.max(peak.v, m);
}

/**
 * The single K-weighting pass. Returns the prefix sums P of the channel-weighted
 * (G = 1) grain energies: energy of grains [a, b) = P[b] − P[a]. Float64 prefix sums are
 * monotone (exact zeros on silence, never negative); their rounding error (~1e-16 of
 * the total energy) is below 1e-5 dB for any window louder than −70 LUFS.
 */
function grainAnalysis(chans, fs, grain, wantPeak) {
  const [k1, k2] = kWeightingSections(fs);
  let n = chans.length ? Infinity : 0;
  for (const c of chans) n = Math.min(n, c.length);
  const nG = grain > 0 ? Math.floor(n / grain) : 0;
  const e = new Float64Array(nG);
  const pk = wantPeak ? { v: 0 } : null;
  let c = 0;
  for (; c + 1 < chans.length; c += 2) grainsPair(chans[c], chans[c + 1], nG, grain, k1, k2, e, pk);
  if (c < chans.length) grainsSingle(chans[c], nG, grain, k1, k2, e, pk);
  let peak = 0;
  if (wantPeak) {
    peak = pk.v;
    // Samples after the last complete grain (and of longer channels) count for the peak.
    for (const x of chans) {
      for (let i = nG * grain; i < x.length; i++) {
        const m = Math.abs(x[i]);
        if (m > peak && m < Infinity) peak = m;
      }
    }
  }
  const P = new Float64Array(nG + 1);
  let s = 0;
  for (let g = 0; g < nG; g++) {
    s += e[g];
    P[g + 1] = s;
  }
  return { P, nG, grain, peak };
}

function grainSize(fs, sec) {
  return Math.max(1, Math.round(sec * fs));
}

// ------------------------------------------------------------------ readings

/** BS.1770 gated integrated loudness from 400 ms blocks (4 grains, hop 1 grain). */
function integratedFrom(P, nG, grain) {
  const L = BLOCK_GRAINS;
  const nb = nG - L + 1;
  if (nb <= 0) return -Infinity;
  const norm = 1 / (L * grain);
  let sum = 0, cnt = 0;
  for (let j = 0; j < nb; j++) {
    const p = (P[j + L] - P[j]) * norm;
    if (p > P_ABS) {
      sum += p;
      cnt++;
    }
  }
  if (!cnt) return -Infinity;
  // Γr = L(mean of abs-gated block powers) − 10 LU  ⇔  p > mean / 10.
  const rel = (sum / cnt) * REL_GATE_I;
  let sum2 = 0, cnt2 = 0;
  for (let j = 0; j < nb; j++) {
    const p = (P[j + L] - P[j]) * norm;
    if (p > P_ABS && p > rel) {
      sum2 += p;
      cnt2++;
    }
  }
  return cnt2 ? lufs(sum2 / cnt2) : -Infinity;
}

/**
 * EBU Tech 3342 LRA from 3 s short-term values every 100 ms (complete windows only):
 * absolute gate ≥ −70 LUFS, relative gate ≥ (energy mean of the abs-gated values) − 20 LU,
 * then LRA = s[round((n−1)·0.95)] − s[round((n−1)·0.10)] on the sorted values.
 * Sorting powers is equivalent (loudness is monotone in power) and avoids n logs.
 */
function lraFrom(P, nG, grain) {
  const L = SHORT_GRAINS;
  const nb = nG - L + 1;
  if (nb <= 0) return 0;
  const norm = 1 / (L * grain);
  const vals = new Float64Array(nb);
  let cnt = 0, sum = 0;
  for (let j = 0; j < nb; j++) {
    const p = (P[j + L] - P[j]) * norm;
    if (p >= P_ABS) {
      vals[cnt++] = p;
      sum += p;
    }
  }
  if (cnt < 2) return 0;
  const rel = (sum / cnt) * REL_GATE_LRA;
  let m = 0;
  for (let j = 0; j < cnt; j++) if (vals[j] >= rel) vals[m++] = vals[j];
  if (m < 2) return 0;
  const s = vals.subarray(0, m).sort();
  const lo = s[Math.round((m - 1) * 0.1)];
  const hi = s[Math.round((m - 1) * 0.95)];
  const lra = lufs(hi) - lufs(lo);
  return lra > 0 ? lra : 0;
}

/**
 * Max of the sliding L-grain loudness as a real-time meter would show it. With at least
 * one complete window this is the max over complete windows (zero-padded start windows
 * are nested subsets of the first complete one, so they never exceed it). Shorter input:
 * the meter reading at the end of the signal (window zero-padded before the start).
 */
function maxWindowFrom(P, nG, grain, L) {
  if (nG <= 0) return -Infinity;
  let best = 0;
  if (nG < L) best = P[nG];
  else {
    for (let j = 0, nb = nG - L + 1; j < nb; j++) {
      const d = P[j + L] - P[j];
      if (d > best) best = d;
    }
  }
  return lufs(best / (L * grain));
}

/** curve[k] = loudness of the L-grain window ending at the end of grain k (zero-padded start). */
function curveFrom(P, nG, grain, L) {
  const out = new Float32Array(nG);
  const norm = 1 / (L * grain);
  for (let k = 0; k < nG; k++) {
    const p = (P[k + 1] - P[k + 1 > L ? k + 1 - L : 0]) * norm;
    out[k] = p > P_CURVE_FLOOR ? lufs(p) : CURVE_FLOOR_LUFS;
  }
  return out;
}

function hundredMs(channels, sampleRate) {
  const fs = checkRate(sampleRate);
  return grainAnalysis(asChannels(channels), fs, grainSize(fs, 0.1), false);
}

// ------------------------------------------------------------------ public API

/**
 * K-weighted copy of the channels (BS.1770 pre-filter, coefficients for this sample
 * rate, float64 state; see kWeightingSections). The input is not modified.
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @returns {Float32Array[]} new arrays, same lengths
 */
export function kWeight(channels, sampleRate) {
  const sections = kWeightingSections(sampleRate);
  const out = asChannels(channels).map((c) => Float32Array.from(c));
  return processStereoInPlace(out, sections);
}

/**
 * BS.1770-4 gated integrated loudness: 400 ms blocks with 75 % overlap, absolute gate
 * −70 LUFS, relative gate −10 LU, power averaging.
 * @param {Float32Array[]|Float32Array} channels stereo (G = 1 per channel)
 * @param {number} sampleRate
 * @returns {number} LUFS; −Infinity for silence or input shorter than one 400 ms block
 */
export function integratedLoudness(channels, sampleRate) {
  const { P, nG, grain } = hundredMs(channels, sampleRate);
  return integratedFrom(P, nG, grain);
}

/**
 * Loudness range (EBU Tech 3342 V4): spread between the 10th and 95th percentile of
 * the gated (−70 LUFS absolute, −20 LU relative) 3 s short-term loudness, sampled every
 * 100 ms (complete windows only).
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @returns {number} LU (>= 0; 0 when fewer than two short-term values pass the gates)
 */
export function loudnessRange(channels, sampleRate) {
  const { P, nG, grain } = hundredMs(channels, sampleRate);
  return lraFrom(P, nG, grain);
}

/**
 * Maximum short-term (3 s rectangular window, ungated, 100 ms hop) loudness. Input
 * shorter than 3 s reports the meter reading at its end (window zero-padded before the
 * start, as a real-time EBU meter would show).
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @returns {number} LUFS; −Infinity for silence / input shorter than 100 ms
 */
export function shortTermMax(channels, sampleRate) {
  const { P, nG, grain } = hundredMs(channels, sampleRate);
  return maxWindowFrom(P, nG, grain, SHORT_GRAINS);
}

/**
 * Maximum momentary (400 ms rectangular window, ungated, 100 ms hop) loudness.
 * Input shorter than 400 ms: meter reading at its end (zero-padded window).
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @returns {number} LUFS; −Infinity for silence / input shorter than 100 ms
 */
export function momentaryMax(channels, sampleRate) {
  const { P, nG, grain } = hundredMs(channels, sampleRate);
  return maxWindowFrom(P, nG, grain, BLOCK_GRAINS);
}

/**
 * Sliding-window loudness curve for UI meters / playback: curve[k] is the reading of a
 * rectangular `windowSec` meter at time (k + 1)·hop, i.e. over the window ending at the
 * end of hop k (before 0 s the window is zero-padded, like a real-time meter), so the
 * value to show at playback time t is curve[floor(t / hop) − 1]. One entry per complete
 * hop (length floor(n / hopSamples)). hop = round(hopSec·fs) samples; the window is
 * rounded to a whole number of hops (exact for the 3 s / 0.1 s default).
 * Silent windows read CURVE_FLOOR_LUFS (finite).
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @param {{ windowSec?: number, hopSec?: number }} [opts]
 * @returns {Float32Array} LUFS per hop
 */
export function loudnessCurve(channels, sampleRate, opts = {}) {
  const fs = checkRate(sampleRate);
  const { windowSec = 3, hopSec = 0.1 } = opts || {};
  const hop = hopSec > 0 && Number.isFinite(hopSec) ? hopSec : 0.1;
  const win = windowSec > 0 && Number.isFinite(windowSec) ? windowSec : 3;
  const grain = grainSize(fs, hop);
  const L = Math.max(1, Math.round((win * fs) / grain));
  const { P, nG } = grainAnalysis(asChannels(channels), fs, grain, false);
  return curveFrom(P, nG, grain, L);
}

/**
 * True peak as reported by measure(), in dBTP: 4x interpolation (2x at 96–192 kHz, BS.1770
 * Annex 2 rates) with the foundation's sharp interpolator (oversample.js truePeakDb
 * 'limiter' quality: Kaiser sinc, 16 taps/phase, stopband −50 dB, error ≤ −45 dB to
 * 0.40·fs), max with the sample peak.
 * Why not the Annex 2 example filter ('meter'): it is −6 dB at 24 kHz and under-reads
 * overs of near-Nyquist content (naive clipping, bright masters) — 0.37 vs 0.58 dBTP
 * (ffmpeg ebur128, 192 kHz resampler) on the clipped demo track, outside ±0.2 dB — while
 * it over-reads steady tones by up to +0.045 dB (uneven phase gains). The sharp filter
 * stays within ±0.1 dB of ffmpeg on every test file; it is also the limiter's detector,
 * so measured and limited peaks agree. BS.1770 allows any interpolator that meets its
 * requirements. Running both filters (opts.conservative: max of 'meter' and 'limiter',
 * never below the Annex 2 reading) costs a second full pass on loud masters (≈ +300 ms
 * per 3:30 stereo), so measure() uses the single sharp pass; use the conservative form
 * for a final limiter / QC check that must also satisfy an Annex 2 meter.
 * Corrupt samples: NaN / ±Infinity are ignored (measured as 0), never propagated.
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @param {{ conservative?: boolean }} [opts]
 * @returns {number} dBTP (silence → −240, finite)
 */
export function measureTruePeakDb(channels, sampleRate, opts = {}) {
  const fs = checkRate(sampleRate);
  let chans = asChannels(channels);
  if (!chans.length) return gainToDb(0);
  const both = !!(opts && opts.conservative) && truePeakFactor(fs) === 4;
  const tpOf = (c) => {
    const tp = truePeakDb(c, fs, 'limiter');
    return both ? Math.max(tp, truePeakDb(c, fs, 'meter')) : tp;
  };
  let tp = tpOf(chans);
  // truePeakDb turns NaN samples into −240 (silence) and ±Infinity into +Infinity. Only
  // in those cases (or real silence) scan for non-finite samples and re-measure a copy
  // with them zeroed, so a corrupt sample neither hides the real peak nor yields Infinity.
  if (!(tp > gainToDb(0) && tp < Infinity)) {
    let bad = false;
    chans = chans.map((c) => {
      let copy = null;
      for (let i = 0; i < c.length; i++) {
        if (!Number.isFinite(c[i])) {
          if (!copy) copy = Float32Array.from(c);
          copy[i] = 0;
        }
      }
      if (copy) bad = true;
      return copy || c;
    });
    if (bad) tp = tpOf(chans);
  }
  return tp;
}

/**
 * Full loudness measurement from ONE K-weighting pass (100 ms grain energies) plus one
 * true-peak interpolation pass (measureTruePeakDb: 4x sharp interpolator, within
 * ±0.2 dB of ffmpeg ebur128).
 * @param {Float32Array[]|Float32Array} channels
 * @param {number} sampleRate
 * @returns {{ integrated: number, lra: number, shortTermMax: number, momentaryMax: number,
 *   truePeakDb: number, samplePeakDb: number, curve: Float32Array, curveHopSec: number }}
 *   LUFS / LU / dBTP / dBFS. curve = 3 s short-term loudness per 100 ms hop (see
 *   loudnessCurve), curveHopSec = exact hop (round(0.1·fs)/fs). Silence: loudness values
 *   −Infinity, lra 0, peaks −240.
 */
export function measure(channels, sampleRate) {
  const fs = checkRate(sampleRate);
  const chans = asChannels(channels);
  const grain = grainSize(fs, 0.1);
  const { P, nG, peak } = grainAnalysis(chans, fs, grain, true);
  const samplePeakDb = gainToDb(peak);
  const tp = measureTruePeakDb(chans, fs);
  return {
    integrated: integratedFrom(P, nG, grain),
    lra: lraFrom(P, nG, grain),
    shortTermMax: maxWindowFrom(P, nG, grain, SHORT_GRAINS),
    momentaryMax: maxWindowFrom(P, nG, grain, BLOCK_GRAINS),
    truePeakDb: Math.max(tp, samplePeakDb),
    samplePeakDb,
    curve: curveFrom(P, nG, grain, SHORT_GRAINS),
    curveHopSec: grain / fs,
  };
}
