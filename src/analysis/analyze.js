// Full diagnostic report of a track (ARCHITECTURE §4, RESEARCH §1 stage 0, §2,
// research/02 §7.2). Everything the assistant needs to decide the chain is measured here
// once; the chain re-uses a few helpers (stereoSpectrum, REFERENCE_LTAS) for its own
// verification so input and master are measured with the same estimators.
//
// Passes (3:30 stereo 48 kHz ≈ 1.3 s on an M1 Pro, native Node):
//   1. measure()               BS.1770 loudness, LRA, true peak, short-term curve
//   2. time-domain scan         DC, clipping runs, gated RMS / crest, silence, 1 s window
//                               correlations (near-mono), ending (abrupt end gate)
//   3. stereoSpectrum (8192)    one complex FFT per frame of (L + iR) gives L and R: gated
//                               mid PSD (LTAS, codec cutoff, fine peak search), side PSD
//                               (S/M above 8 kHz) and the L/R cross-spectrum (per-band
//                               correlation = Σ Re(L·R*) / √(ΣL²·ΣR²), brick-wall bands)
//   4. frame scan (2048/1024)   complex FFT of (M + iS) per ≈ 21 ms frame: HF noise floor
//                               (hiss) by per-bin minimum statistics, quiet-frame top octave
//                               (hash), narrowband HF flicker (shimmer), sibilance events
//                               (5–9 kHz relative level + spectral concentration; 10–16 kHz
//                               extension), side/mid HF modulation 4–20 Hz
//
// Indices are dB: + = too much, gates (assistant) at the RESEARCH values; see INDEX_GATES.
// Tonal indices (mud, boom, harsh, fizz, rumble) are the excess of a sliding fractional-
// octave band over a "gap" trend: a local linear fit of the 1/3-octave LTAS that ignores
// the ±0.5 octave around the candidate frequency, so a bump is measured against its
// surroundings instead of being absorbed by the fit. Balance indices (air, brightened,
// muffled) compare the LTAS with REFERENCE_LTAS (a smoothed commercial pop/rock long-term
// spectrum) after matching the 125 Hz–4 kHz level.
// All thresholds tagged [E] in RESEARCH need calibration on real Suno files (§8).

import { measure } from './loudness.js';
import { ltas as ltasFromSpectrum, hfCutoffHz, THIRD_OCTAVE_HZ } from '../dsp/eq.js';
import { FFT, hann } from '../dsp/fft.js';
import { correlation } from '../dsp/stereo.js';
import { butterworth } from '../dsp/biquad.js';
import { toStereo, clamp } from '../dsp/util.js';

const NB = 31;
const CENTRE = Float64Array.from({ length: NB }, (_, i) => 1000 * Math.pow(10, (i - 17) / 10));
const XOCT = CENTRE.map((f) => Math.log2(f / 1000));
const DB10 = 10 / Math.LN10;
const db10 = (p) => DB10 * Math.log(p > 1e-30 ? p : 1e-30);

/**
 * Reference long-term spectrum (1/3-octave band power, dB re the 1 kHz band) of modern
 * commercial pop/rock masters — a smoothed composite in the spirit of the published
 * average-spectrum studies and the Tonal Balance Control "modern" targets: roughly flat
 * band power 40–160 Hz, ≈ −1.8 dB/oct band power from 1 to 10 kHz, steeper above 12 kHz.
 * Only relative comparisons are made against it (level-matched over 125 Hz–4 kHz).
 */
export const REFERENCE_LTAS = Object.freeze([
  -1, 1.5, 3.5, 5, 6, 6.5, 6.5, 6, 5.5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 0.8,
  0, -0.6, -1.2, -1.8, -2.5, -3.2, -4, -4.8, -5.7, -6.7, -7.8, -9.2, -12, -18,
]);

/**
 * Detector gates used by the assistant (RESEARCH §2 table; [E] values). Indices above
 * (or for `air`, below) these values fire their module / issue.
 * brightened → brightenedFull: the 'brightened' modifier ramps from 0 to 1 over this
 * brightness range (6–10 kHz vs 250 Hz–2 kHz re REFERENCE_LTAS). Calibrated on real Suno
 * exports (n = 7): normal v4.5/v5 files read 4.1–7.6 dB against this reference, so the
 * old 5 dB on/off gate split near-identical tracks; Suno "Remaster" reads +7/+10 dB.
 */
export const INDEX_GATES = Object.freeze({
  mud: 1.5, boom: 2, harsh: 1.5, fizz: 1.5, rumble: 3, sibilanceEventsPerMin: 4, sibilanceExcessDb: 2,
  air: -3, shimmer: 0, hash: 0, hiss: 0, hfModulation: 0, sideToMidHfDb: -6,
  brightened: 6, brightenedFull: 9, muffled: -3,
});

/**
 * Continuous 'brightened' amount 0..1 from the brightness index (ramp over
 * INDEX_GATES.brightened … brightenedFull). A modifier on top of the f_c profile.
 * @param {number} brightness dB
 * @returns {number}
 */
export function brightenedAmount(brightness) {
  const G = INDEX_GATES;
  return Number.isFinite(brightness) ? clamp((brightness - G.brightened) / (G.brightenedFull - G.brightened), 0, 1) : 0;
}

// ------------------------------------------------------------------ small helpers

function sanitize(chans) {
  return chans.map((c) => {
    let copy = null;
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (!(v === v && v !== Infinity && v !== -Infinity)) {
        if (!copy) copy = Float32Array.from(c);
        copy[i] = 0;
      }
    }
    return copy || c;
  });
}

const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const round = (v, k = 100) => Math.round(fin(v) * k) / k;

/** ramp 0..1 of v between lo and hi, severity floor 0.15 for a fired issue. */
function severity(v, lo, hi) {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return round(0.15 + 0.85 * t, 1000);
}

function fftSizeFor(sampleRate) {
  // ≈ 170 ms frames: 8192 at 44.1/48 kHz (same rule as eq.js → identical LTAS estimator)
  let n = 1024;
  while (n < 0.15 * sampleRate && n < 65536) n <<= 1;
  return n;
}

// ------------------------------------------------------------------ stereo spectrum

/**
 * Gated long-term stereo spectrum from one complex FFT per frame of (L + iR) (Hann,
 * eq.js frame size). Frames whose windowed mid energy is more than |relGateDb| below the
 * loudest frame are ignored (same gate as eq.ltas, so `mid` can be passed to
 * eq.ltas / eq.hfCutoffHz as `opts.spectrum`).
 * Band correlation = Σ_band Re(L·R*) / √(Σ_band |L|²·Σ_band |R|²): the Pearson correlation
 * of brick-wall band-limited L and R over the gated frames.
 * Exported for chain.js (master verification) — not part of the ARCHITECTURE contract.
 * @param {Float32Array[]} channels [L, R]
 * @param {number} sampleRate
 * @param {{ overlap?: number, relGateDb?: number, crossovers?: number[], fftSize?: number }} [opts]
 *   overlap 0.5 (analysis), 0, or negative to skip frames (−1: one frame every 2N samples,
 *   fast verification); crossovers default [120, 1000, 8000]
 * @returns {{ mid: { psd: Float64Array, df: number, fftSize: number, sampleRate: number, frames: number },
 *   side: Float64Array, bandCorrelation: number[], sideToMidHfDb: number, hfMidDb: number, hfSideDb: number }}
 */
export function stereoSpectrum(channels, sampleRate, opts = {}) {
  const L = channels[0];
  const R = channels.length > 1 ? channels[1] : channels[0];
  const n = Math.min(L.length, R.length);
  const N = opts.fftSize && (opts.fftSize & (opts.fftSize - 1)) === 0 ? opts.fftSize : fftSizeFor(sampleRate);
  const half = N >> 1;
  const overlap = clamp(fin(opts.overlap, 0.5), -3, 0.9);
  const hop = Math.max(1, Math.round(N * (1 - overlap)));
  const relGateDb = fin(opts.relGateDb, -50);
  const xo = (opts.crossovers || [120, 1000, 8000]).slice().sort((a, b) => a - b);
  const w = hann(N, true);
  let s2 = 0;
  for (let i = 0; i < N; i++) s2 += w[i] * w[i];
  const count = n <= N ? 1 : Math.ceil((n - N) / hop) + 1;
  const starts = new Float64Array(count);
  for (let f = 0; f < count; f++) starts[f] = count === 1 ? 0 : Math.round((f * (n - N)) / (count - 1));
  // pass 1: windowed mid energy per frame (gate)
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
  const fft = new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const pm = new Float64Array(half + 1), ps = new Float64Array(half + 1);
  const pll = new Float64Array(half + 1), prr = new Float64Array(half + 1), plr = new Float64Array(half + 1);
  let used = 0;
  for (let f = 0; f < count; f++) {
    if (energy[f] < gate) continue;
    const s = starts[f];
    const len = Math.min(N, n - s);
    for (let i = 0; i < len; i++) {
      re[i] = L[s + i] * w[i];
      im[i] = R[s + i] * w[i];
    }
    for (let i = len; i < N; i++) {
      re[i] = 0;
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k <= half; k++) {
      const j = k === 0 ? 0 : N - k;
      const a = re[k], b = im[k], c = re[j], d = im[j];
      // L_k = ((a + c) + i(b − d))/2 ; R_k = ((b + d) + i(c − a))/2
      const lr = 0.5 * (a + c), li = 0.5 * (b - d);
      const rr = 0.5 * (b + d), ri = 0.5 * (c - a);
      const mr = 0.5 * (lr + rr), mi = 0.5 * (li + ri);
      const sr = 0.5 * (lr - rr), si = 0.5 * (li - ri);
      pm[k] += mr * mr + mi * mi;
      ps[k] += sr * sr + si * si;
      pll[k] += lr * lr + li * li;
      prr[k] += rr * rr + ri * ri;
      plr[k] += lr * rr + li * ri;
    }
    used++;
  }
  const psd = new Float64Array(half + 1);
  const side = new Float64Array(half + 1);
  if (used > 0) {
    const norm = 1 / (used * N * s2);
    for (let k = 0; k <= half; k++) {
      const g = norm * (k === 0 || k === half ? 1 : 2);
      psd[k] = pm[k] * g;
      side[k] = ps[k] * g;
    }
  }
  const df = sampleRate / N;
  const edges = [1, ...xo.map((f) => Math.round(f / df)), half + 1];
  const bandCorrelation = [];
  for (let b = 0; b + 1 < edges.length; b++) {
    let a = 0, c = 0, d = 0;
    for (let k = Math.max(1, edges[b]); k < Math.min(half + 1, edges[b + 1]); k++) {
      a += pll[k];
      c += prr[k];
      d += plr[k];
    }
    const tot = a + c;
    let r = 1;
    if (tot > 1e-20) r = a * c > tot * tot * 1e-14 ? clamp(d / Math.sqrt(a * c), -1, 1) : 0;
    bandCorrelation.push(round(r, 1000));
  }
  const k8 = Math.min(half, Math.round(8000 / df));
  let hm = 0, hs = 0;
  for (let k = k8; k <= half; k++) {
    hm += psd[k];
    hs += side[k];
  }
  return {
    mid: { psd, df, fftSize: N, sampleRate, frames: used },
    side,
    bandCorrelation,
    sideToMidHfDb: hm > 1e-24 ? clamp(db10(hs) - db10(hm), -100, 100) : -100,
    hfMidDb: db10(hm),
    hfSideDb: db10(hs),
  };
}

// ------------------------------------------------------------------ time-domain scan

function timeScan(L, R, sr) {
  const n = L.length;
  const thrSil = 0.001; // −60 dBFS
  let sumL = 0, sumR = 0, peak = 0;
  let first = -1, last = -1;
  // clipping: runs of >= 3 consecutive |x| >= 0.999 (per channel)
  let clipSamples = 0, clipRuns = 0;
  let runL = 0, runR = 0;
  const W = Math.max(1, Math.round(0.05 * sr)); // 50 ms RMS windows
  const nw = Math.ceil(n / W);
  const wp = new Float64Array(nw);
  const C = Math.max(1, Math.round(sr)); // 1 s correlation windows
  const nc = Math.ceil(n / C);
  const cll = new Float64Array(nc), crr = new Float64Array(nc), clr = new Float64Array(nc);
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    sumL += l;
    sumR += r;
    const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
    const m = al > ar ? al : ar;
    if (m > peak) peak = m;
    if (m > thrSil) {
      if (first < 0) first = i;
      last = i;
    }
    if (al >= 0.999) runL++;
    else {
      if (runL >= 3) { clipSamples += runL; clipRuns++; }
      runL = 0;
    }
    if (ar >= 0.999) runR++;
    else {
      if (runR >= 3) { clipSamples += runR; clipRuns++; }
      runR = 0;
    }
    const w = (i / W) | 0;
    wp[w] += l * l + r * r;
    const c = (i / C) | 0;
    cll[c] += l * l;
    crr[c] += r * r;
    clr[c] += l * r;
  }
  if (runL >= 3) { clipSamples += runL; clipRuns++; }
  if (runR >= 3) { clipSamples += runR; clipRuns++; }
  // gated RMS (levelStats convention: −60 dBFS absolute, −40 dB re the loudest window)
  let wmax = 0;
  for (let w = 0; w < nw; w++) {
    const len = Math.min(W, n - w * W);
    wp[w] = wp[w] / (2 * len);
    if (wp[w] > wmax) wmax = wp[w];
  }
  const g = Math.max(1e-6, wmax * 1e-4);
  let acc = 0, cnt = 0;
  for (let w = 0; w < nw; w++) if (wp[w] >= g) { acc += wp[w]; cnt++; }
  const rmsDb = cnt ? db10(acc / cnt) : -240;
  // near-mono: share of active 1 s windows with correlation > 0.95 (research/02 §7.2)
  let cmax = 0;
  for (let c = 0; c < nc; c++) cmax = Math.max(cmax, cll[c] + crr[c]);
  let act = 0, mono = 0;
  for (let c = 0; c < nc; c++) {
    const e = cll[c] + crr[c];
    if (!(e > 1e-9 * C && e > cmax * 1e-4)) continue;
    act++;
    const d = cll[c] * crr[c];
    const r = d > 1e-30 ? clr[c] / Math.sqrt(d) : 0;
    if (r > 0.95) mono++;
  }
  // ending (RESEARCH §2): last 200 ms of content vs the 3 s before, > −30 dBFS
  let abruptEnd = false;
  let endLevelDb = -240, endDropDb = 0;
  if (last >= 0) {
    const e = last + 1;
    const a = Math.max(0, e - Math.round(0.2 * sr));
    const b = Math.max(0, a - Math.round(3 * sr));
    const rmsOf = (s0, s1) => {
      let s = 0;
      for (let i = s0; i < s1; i++) s += L[i] * L[i] + R[i] * R[i];
      return s1 > s0 ? db10(s / (2 * (s1 - s0))) : -240;
    };
    endLevelDb = rmsOf(a, e);
    const prevDb = a - b >= Math.round(0.5 * sr) ? rmsOf(b, a) : endLevelDb;
    endDropDb = prevDb - endLevelDb;
    abruptEnd = e - b >= Math.round(1 * sr) && endLevelDb > -30 && endDropDb < 6;
  }
  return {
    dc: [n ? sumL / n : 0, n ? sumR / n : 0],
    peak,
    clipping: { samples: clipSamples, pct: n ? round((100 * clipSamples) / (2 * n), 10000) : 0, runs: clipRuns },
    rmsDb,
    first,
    last,
    nearMonoShare: act ? mono / act : 0,
    activeWindows: act,
    abruptEnd,
    endLevelDb,
    endDropDb,
  };
}

// ------------------------------------------------------------------ frame scan (2048)

/** p-quantile of a numeric array (copy sorted). */
function quantile(arr, q) {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  const pos = clamp(q, 0, 1) * (a.length - 1);
  const i = Math.floor(pos);
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * (pos - i) : a[i];
}

/**
 * Event counter on a per-frame relative level series: excursions more than `thrDb` above
 * the 1 s moving median (active frames only) on frames where `ok` is set, bursts closer
 * than 60 ms merged. Returns the event frame positions too.
 * → { eventsPerMin, excessDb (median event peak − thrDb), events, at: number[] }
 */
function countEvents(rel, act, ok, frameSec, thrDb) {
  const n = rel.length;
  const win = Math.max(9, Math.round(1 / frameSec));
  const step = Math.max(1, Math.round(0.25 / frameSec));
  const nMed = Math.ceil(n / step);
  const med = new Float64Array(nMed).fill(NaN);
  const tmp = [];
  for (let m = 0; m < nMed; m++) {
    const c = m * step + (step >> 1);
    const s0 = Math.max(0, c - (win >> 1)), s1 = Math.min(n, c + (win >> 1) + 1);
    tmp.length = 0;
    for (let i = s0; i < s1; i++) if (act[i]) tmp.push(rel[i]);
    if (tmp.length >= Math.max(5, win >> 2)) {
      tmp.sort((a, b) => a - b);
      med[m] = tmp[tmp.length >> 1];
    }
  }
  const minGap = Math.max(1, Math.round(0.06 / frameSec));
  let events = 0, run = 0, runPeak = -Infinity, runStart = 0, lastEnd = -1e9, activeFrames = 0;
  const peaks = [];
  const at = [];
  for (let i = 0; i <= n; i++) {
    let ex = -100;
    if (i < n) {
      if (act[i]) activeFrames++;
      const m = med[Math.min(nMed - 1, Math.floor(i / step))];
      if (act[i] && ok[i] && m === m) ex = rel[i] - m;
    }
    if (ex > thrDb) {
      if (run === 0) runStart = i;
      run++;
      if (ex > runPeak) runPeak = ex;
      continue;
    }
    if (run >= 1) {
      if (runStart - lastEnd <= minGap && peaks.length) peaks[peaks.length - 1] = Math.max(peaks[peaks.length - 1], runPeak);
      else {
        events++;
        peaks.push(runPeak);
        at.push(runStart);
      }
      lastEnd = i;
    }
    run = 0;
    runPeak = -Infinity;
  }
  const minutes = Math.max(1 / 60, (activeFrames * frameSec) / 60);
  peaks.sort((a, b) => a - b);
  return {
    eventsPerMin: round(events / minutes, 10),
    excessDb: peaks.length ? round(peaks[peaks.length >> 1] - thrDb, 10) : -thrDb,
    events,
    at,
    minutes,
  };
}

/**
 * Short-frame scan (one complex FFT of (M + iS) per frame; Hann, 2048 at 44.1/48 kHz,
 * hop N/2 ≈ 21 ms):
 * * HF floor (hiss): among the active frames, those whose 10–16 kHz level is at or below
 *   its 10th percentile — the stationary floor between hits — give the per-1/3-octave
 *   floor level (per channel) and the spectral flatness of their averaged 10–16 kHz
 *   spectrum (noise ≈ 1, tonal / empty band ≪ 1).
 * * hash: in the quietest 10 % of frames the top octave (12–16 kHz) re 2–6 kHz, minus the
 *   same ratio over all active frames: a top-octave noise floor that does not follow the
 *   music.
 * * shimmer: per 1 s window, HF bins (5 kHz … min(16 kHz, cutoff − 500 Hz)) whose
 *   narrowband-peak state (>= 8 dB over the local ±1/12-octave geometric-mean envelope,
 *   ±1 bin tolerance) is neither rare nor permanent (occupancy 25–85 %) and toggles often
 *   (>= 20 % of frames): codec-like flickering partials. Random noise peaks rarely reach
 *   that occupancy and stable partials never toggle. A cluster of such bins whose toggles
 *   go with the 1.5–4.5 kHz (mid) level (correlation of the toggle direction with the
 *   clipped ±3 dB level change ≥ 0.35 in that window) is a musical gate / stab / tremolo
 *   — its low harmonics switch too — and does not count (as in spectral.js de-shimmer).
 *   Result: clusters per kHz.
 * * sibilance (mid channel): 5–9 kHz level minus the broadband mid level (RESEARCH
 *   relative detector); an event is an excursion > 8 dB above its 1 s moving median on a
 *   frame where the 5–9 kHz band also dominates its neighbours (within 6 dB of the louder
 *   of 1.5–4.5 kHz and 10–16 kHz): an "s" is concentrated there, while claps / snares sit
 *   lower and hats / cymbals higher, so loud percussion does not count. Band B (AI
 *   sibilance 10–16 kHz): band-A events whose 10–16 kHz level (re broadband) also jumps
 *   > 8 dB above its median — the "s" extends into the top octave (hats alone never
 *   count, the de-esser must not duck them).
 * * HF modulation: 4–20 Hz band-pass of the side/mid level ratio above 6 kHz (masks
 *   broadband transients: onsets move M and S together), RMS in dB.
 */
function frameScan(L, R, sr, cutoffHz) {
  const n = L.length;
  let N = 256;
  while (N < 0.04 * sr && N < 16384) N <<= 1; // 2048 at 44.1/48 kHz
  const half = N >> 1;
  const hop = half;
  const df = sr / N;
  const frameSec = hop / sr;
  const w = hann(N, true);
  let s2 = 0;
  for (let i = 0; i < N; i++) s2 += w[i] * w[i];
  const count = n <= N ? 1 : Math.floor((n - N) / hop) + 1;
  const fft = new FFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const nyq = sr / 2;
  const kOf = (f) => clamp(Math.round(f / df), 1, half);
  const k15 = kOf(1500), k2 = kOf(2000), k45 = kOf(4500), k5 = kOf(5000), k6 = kOf(6000), k9 = kOf(9000);
  const k10 = kOf(10000), k12 = kOf(12000);
  const k16 = kOf(Math.min(16000, 0.95 * nyq));
  const hasTop = 16000 < 0.95 * nyq && k16 > k12;
  const scale = 2 / (N * s2); // → one-sided mean square per bin
  // per-frame features
  const eAll = new Float64Array(count);
  const t26 = new Float64Array(count), t1016 = new Float64Array(count), t1216 = new Float64Array(count);
  const m616 = new Float64Array(count), s616 = new Float64Array(count);
  const mAll = new Float64Array(count), m1545 = new Float64Array(count), m59 = new Float64Array(count), m1016 = new Float64Array(count);
  const spec1016 = k16 >= k10 ? new Float32Array(count * (k16 - k10 + 1)) : new Float32Array(0);
  const nTop = k16 - k10 + 1;
  // shimmer bookkeeping
  const sTop = Math.min(16000, fin(cutoffHz, nyq) - 500, 0.45 * sr);
  const kS0 = kOf(5000), kS1 = Math.max(kS0, kOf(sTop));
  const nS = Math.max(0, kS1 - kS0 + 1);
  const halfW = new Int32Array(nS);
  let maxHw = 2;
  for (let j = 0; j < nS; j++) {
    halfW[j] = Math.max(2, Math.round((kS0 + j) * 0.06));
    if (halfW[j] > maxHw) maxHw = halfW[j];
  }
  const kd0 = Math.max(1, kS0 - maxHw - 1), kd1 = Math.min(half, kS1 + maxHw + 1);
  const dB = new Float64Array(half + 2);
  const pre = new Float64Array(half + 3);
  const peakNow = new Uint8Array(nS + 2), prevState = new Uint8Array(nS);
  const occ = new Uint16Array(nS), sw = new Uint16Array(nS);
  const WIN = Math.max(8, Math.round(1 / frameSec));
  let winFrames = 0, winHfActive = 0;
  let flickerSum = 0, flickerWindows = 0;
  // co-modulation of the toggles with the 1.5–4.5 kHz level: Σ direction × change per bin
  const cmX = new Float64Array(nS);
  let cmY = 0, lbPrev = NaN;
  for (let f = 0; f < count; f++) {
    const s = f * hop;
    const len = Math.min(N, n - s);
    let et = 0;
    for (let i = 0; i < len; i++) {
      const l = L[s + i], r = R[s + i];
      const ww = w[i];
      re[i] = 0.5 * (l + r) * ww;
      im[i] = 0.5 * (l - r) * ww;
      et += (l * l + r * r) * ww * ww;
    }
    for (let i = len; i < N; i++) {
      re[i] = 0;
      im[i] = 0;
    }
    eAll[f] = et / (2 * s2);
    fft.forward(re, im);
    let a26 = 0, a1016 = 0, a1216 = 0, am616 = 0, as616 = 0, aAll = 0, a1545 = 0, a59 = 0, b1016 = 0;
    const o = f * nTop;
    for (let k = 1; k <= half; k++) {
      const j = N - k;
      const a = re[k], b = im[k], c = re[j], d = im[j];
      const mr = 0.5 * (a + c), mi = 0.5 * (b - d);
      const sr2 = 0.5 * (b + d), si = 0.5 * (c - a);
      const pm = mr * mr + mi * mi, ps = sr2 * sr2 + si * si;
      const p = pm + ps; // = (|L|² + |R|²)/2
      aAll += pm;
      if (k >= kd0 && k <= kd1) dB[k] = DB10 * Math.log(p + 1e-30);
      if (k < k15) continue;
      if (k < k45) a1545 += pm;
      if (k >= k2 && k < k6) a26 += p;
      if (k >= k5 && k <= k9) a59 += pm;
      if (k >= k6 && k <= k16) {
        am616 += pm;
        as616 += ps;
      }
      if (k >= k10 && k <= k16) {
        a1016 += p;
        b1016 += pm;
        spec1016[o + k - k10] = p;
      }
      if (k >= k12 && k <= k16) a1216 += p;
    }
    t26[f] = a26 * scale;
    t1016[f] = a1016 * scale;
    t1216[f] = a1216 * scale;
    m616[f] = am616 * scale;
    s616[f] = as616 * scale;
    mAll[f] = aAll * scale;
    m1545[f] = a1545 * scale;
    m59[f] = a59 * scale;
    m1016[f] = b1016 * scale;
    // shimmer: narrowband peak state per HF bin
    if (nS > 2) {
      pre[kd0 - 1] = 0;
      for (let k = kd0; k <= kd1; k++) pre[k] = pre[k - 1] + dB[k];
      for (let jj = 0; jj < nS; jj++) {
        const k = kS0 + jj;
        const hw = halfW[jj];
        const lo = Math.max(kd0, k - hw), hi = Math.min(kd1, k + hw);
        const env = (pre[hi] - pre[lo - 1]) / (hi - lo + 1);
        const v = dB[k];
        peakNow[jj + 1] = v - env > 8 && v >= dB[k - 1] && v >= dB[Math.min(kd1, k + 1)] ? 1 : 0;
      }
      if (m616[f] + s616[f] > 1e-11) winHfActive++;
      // reference level change since the previous frame, clipped to ±3 dB (every on/off
      // counts once, whatever its depth)
      const lb = DB10 * Math.log(m1545[f] + 1e-20);
      const dy = lbPrev === lbPrev ? clamp(lb - lbPrev, -3, 3) : 0;
      lbPrev = lb;
      cmY += dy * dy;
      for (let jj = 0; jj < nS; jj++) {
        const st = peakNow[jj] | peakNow[jj + 1] | peakNow[jj + 2];
        if (st) occ[jj]++;
        if (st !== prevState[jj]) {
          sw[jj]++;
          cmX[jj] += st ? dy : -dy;
        }
        prevState[jj] = st;
      }
      winFrames++;
      if (winFrames >= WIN || f === count - 1) {
        if (winHfActive >= 0.5 * winFrames && winFrames >= 8) {
          let clusters = 0, prevFl = 0;
          // co-modulation pooled over each cluster (one partial ±1 bin): more toggles than one
          // bin, and a gated partial is never split into stray one-bin "clusters"
          const cmN = cmY + winFrames * 0.25; // + 0.5 dB RMS floor: tiny wobbles cannot correlate
          let cX = 0, cS = 0, cB = 0;
          for (let jj = 0; jj <= nS; jj++) {
            let fl = 0; // jj = nS closes the last cluster
            if (jj < nS) {
              const oc = occ[jj] / winFrames, q = sw[jj] / winFrames;
              fl = oc >= 0.25 && oc <= 0.85 && q >= 0.2 ? 1 : 0;
            }
            if (fl) {
              cX += cmX[jj];
              cS += sw[jj];
              cB++;
            } else if (prevFl) {
              if (cX < 0.35 * Math.sqrt(cS * cB * cmN)) clusters++;
              cX = 0;
              cS = 0;
              cB = 0;
            }
            prevFl = fl;
          }
          flickerSum += clusters / Math.max(0.5, (nS * df) / 1000);
          flickerWindows++;
        }
        occ.fill(0);
        sw.fill(0);
        cmX.fill(0);
        cmY = 0;
        winFrames = 0;
        winHfActive = 0;
      }
    }
  }
  // ---- active frames
  let emax = 0;
  for (let f = 0; f < count; f++) if (eAll[f] > emax) emax = eAll[f];
  const gAbs = 1e-7; // −70 dBFS mean square
  const act = new Uint8Array(count);
  const active = [];
  for (let f = 0; f < count; f++) {
    if (eAll[f] > gAbs && eAll[f] > emax * 1e-6) {
      act[f] = 1;
      active.push(f);
    }
  }
  const bands1016 = 3 * Math.log2(Math.min(16000, 0.95 * nyq) / 10000); // ≈ 2 third-octaves
  let hissLevelDb = -240, flatness = 0, hashDb = -100, floorSpread = 0, quietGap = 0;
  if (active.length >= 4 && hasTop) {
    // HF noise floor by per-bin minimum statistics: the 5th percentile of each 10–16 kHz
    // bin's power over the active frames (0.5 dB histograms), bias-corrected by +12.9 dB
    // (5th percentile of an exponential distribution = 0.051 × mean) — what a stationary
    // hiss leaves in every bin while music comes and goes. Level per 1/3 octave and per
    // channel; flatness of the floor spectrum (white-ish noise ≈ 1, tonal ≪ 1).
    const HB = 400; // −200 … 0 dB in 0.5 dB steps
    const hist = new Uint32Array(nTop * HB);
    for (const f of active) {
      const o = f * nTop;
      for (let j = 0; j < nTop; j++) {
        const v = spec1016[o + j] * scale;
        const d = v > 1e-20 ? DB10 * Math.log(v) : -200;
        const idx = clamp(Math.floor((d + 200) * 2), 0, HB - 1);
        hist[j * HB + idx]++;
      }
    }
    const target = Math.max(1, Math.floor(0.05 * active.length));
    const floorP = new Float64Array(nTop);
    let sumP = 0, lg = 0;
    for (let j = 0; j < nTop; j++) {
      let c = 0, idx = 0;
      for (; idx < HB; idx++) {
        c += hist[j * HB + idx];
        if (c >= target) break;
      }
      const d = (idx + 0.5) / 2 - 200 + 12.9;
      floorP[j] = Math.pow(10, d / 10);
      sumP += floorP[j];
      lg += Math.log(floorP[j]);
    }
    hissLevelDb = db10(sumP / Math.max(0.5, bands1016));
    flatness = Math.exp(lg / nTop) / (sumP / nTop);
    const lv = active.map((f) => t1016[f]);
    floorSpread = db10(quantile(lv, 0.5)) - hissLevelDb - db10(Math.max(0.5, bands1016));
    // hash: quietest 10 % of frames (broadband)
    const byE = active.slice().sort((a, b) => eAll[a] - eAll[b]);
    const q = byE.slice(0, Math.max(2, Math.ceil(0.1 * byE.length)));
    let q1216 = 0, q26 = 0, a1216 = 0, a26 = 0;
    for (const f of q) {
      q1216 += t1216[f];
      q26 += t26[f];
    }
    for (const f of active) {
      a1216 += t1216[f];
      a26 += t26[f];
    }
    hashDb = db10(q1216) - db10(q26) - (db10(a1216) - db10(a26));
    let q1016 = 0;
    for (const f of q) q1016 += t1016[f];
    quietGap = db10(q1016 / q.length / Math.max(0.5, bands1016)) - hissLevelDb;
  }
  // ---- sibilance (mid)
  const relA = new Float64Array(count), relB = new Float64Array(count);
  const actA = new Uint8Array(count), okA = new Uint8Array(count);
  for (let f = 0; f < count; f++) {
    const neigh = Math.max(m1545[f], hasTop ? m1016[f] : 0);
    relA[f] = db10(m59[f] + 1e-30) - db10(mAll[f] + 1e-30);
    relB[f] = db10(m1016[f] + 1e-30) - db10(mAll[f] + 1e-30);
    actA[f] = act[f] && eAll[f] > emax * 1e-4 && m59[f] > mAll[f] * 1e-6 ? 1 : 0;
    okA[f] = m59[f] > 0.5 * neigh ? 1 : 0;
  }
  const none = { eventsPerMin: 0, excessDb: -8, events: 0, at: [], minutes: 0 };
  const sibA = count >= 16 && k9 < half ? countEvents(relA, actA, okA, frameSec, 8) : none;
  let sibB = none;
  if (hasTop && sibA.events) {
    // B: band-A events whose top octave jumps too (median of relB over the same 1 s span)
    const all = new Uint8Array(count).fill(1);
    const evB = countEvents(relB, actA, all, frameSec, 8);
    let hits = 0;
    const peaksB = [];
    for (const a of sibA.at) {
      if (evB.at.some((b) => Math.abs(b - a) <= 2)) {
        hits++;
        peaksB.push(evB.excessDb);
      }
    }
    sibB = { eventsPerMin: round(hits / Math.max(1 / 60, sibA.minutes), 10), excessDb: hits ? evB.excessDb : -8, events: hits, at: [], minutes: sibA.minutes };
  }
  // ---- HF modulation: 4–20 Hz band of the side/mid level ratio above 6 kHz
  let hfModDb = 0;
  if (count >= 16) {
    const fr = 1 / frameSec;
    const hp = butterworth('highpass', 2, 4, fr)[0];
    const lp = butterworth('lowpass', 2, Math.min(18, 0.42 * fr), fr)[0];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    let acc = 0, cnt = 0, prevH = null;
    for (let f = 0; f < count; f++) {
      const isAct = act[f] && eAll[f] > emax * 1e-4 && m616[f] > 1e-12 && s616[f] > 1e-14;
      const h = isAct ? db10(s616[f]) - db10(m616[f]) : prevH;
      if (h === null) continue;
      prevH = h;
      const y = hp.b0 * h + hp.b1 * x1 + hp.b2 * x2 - hp.a1 * y1 - hp.a2 * y2;
      x2 = x1; x1 = h; y2 = y1; y1 = y;
      const z = lp.b0 * y + lp.b1 * u1 + lp.b2 * u2 - lp.a1 * v1 - lp.a2 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = z;
      if (isAct && f > 8) {
        acc += z * z;
        cnt++;
      }
    }
    hfModDb = cnt ? Math.sqrt(acc / cnt) : 0;
  }
  return {
    hissLevelDb,
    flatness,
    floorSpread,
    quietGap,
    hashDb,
    flicker: flickerWindows ? flickerSum / flickerWindows : 0,
    flickerWindows,
    hfModDb,
    sibA,
    sibB,
    frameSec,
  };
}

// ------------------------------------------------------------------ tonal indices

/** Power of the PSD bins overlapping [fl, fh] (fractional bins, eq.js convention). */
function bandPower(psd, df, fl, fh) {
  const half = psd.length - 1;
  const nyq = half * df;
  const lo = Math.max(0, fl), hi = Math.min(fh, nyq);
  if (!(hi > lo)) return 0;
  const k0 = Math.max(0, Math.floor(lo / df + 0.5));
  const k1 = Math.min(half, Math.floor(hi / df + 0.5));
  let p = 0;
  for (let k = k0; k <= k1; k++) {
    const bl = Math.max((k - 0.5) * df, 0), bh = Math.min((k + 0.5) * df, nyq);
    const ov = Math.min(bh, hi) - Math.max(bl, lo);
    if (ov > 0 && bh > bl) p += psd[k] * (ov / (bh - bl));
  }
  return p;
}

/** Local linear fit of the LTAS at x0 (octaves re 1 kHz) ignoring bands within ±gap oct. */
function gapTrend(y, valid, x0, gap, sigma) {
  let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
  for (let j = 0; j < NB; j++) {
    if (!valid[j]) continue;
    const d = XOCT[j] - x0;
    if (Math.abs(d) < gap) continue;
    const wj = Math.exp(-0.5 * ((Math.abs(d) - gap) / sigma) ** 2);
    s0 += wj;
    s1 += wj * d;
    s2 += wj * d * d;
    t0 += wj * y[j];
    t1 += wj * d * y[j];
  }
  const det = s0 * s2 - s1 * s1;
  if (det > 1e-9 * s0 * s0) return (s2 * t0 - s1 * t1) / det;
  return s0 > 0 ? t0 / s0 : NaN;
}

/**
 * Largest excess of a sliding `widthOct` band (normalised to 1/3-octave band power) over
 * the gap trend, on a 1/24-octave grid in [loHz, hiHz]. → { excess, hz }
 */
function regionPeak(spec, y, valid, loHz, hiHz, widthOct, defHz, gap = 0.5) {
  const norm = db10(1 / 3 / widthOct);
  let best = -Infinity, bestHz = defHz;
  const nyq = 0.5 * spec.sampleRate;
  for (let f = loHz; f <= hiHz * 1.0001; f *= Math.pow(2, 1 / 24)) {
    if (f * Math.pow(2, widthOct / 2) > 0.95 * nyq) break;
    const p = bandPower(spec.psd, spec.df, f * Math.pow(2, -widthOct / 2), f * Math.pow(2, widthOct / 2));
    if (!(p > 0)) continue;
    const t = gapTrend(y, valid, Math.log2(f / 1000), gap, 0.8);
    if (!Number.isFinite(t)) continue;
    const ex = db10(p) + norm - t;
    if (ex > best) {
      best = ex;
      bestHz = f;
    }
  }
  return { excess: Number.isFinite(best) ? best : 0, hz: Math.round(bestHz) };
}

/** Power mean (dB) of LTAS − reference over bands with centre in [lo, hi] (valid only). */
function refDev(dev, valid, lo, hi) {
  let p = 0, c = 0;
  for (let b = 0; b < NB; b++) {
    if (!valid[b] || CENTRE[b] < lo * 0.97 || CENTRE[b] > hi * 1.03) continue;
    p += Math.pow(10, dev[b] / 10);
    c++;
  }
  return c ? db10(p / c) : NaN;
}

// ------------------------------------------------------------------ main

/**
 * Full diagnostic report of a track (sync; ≈ 1 s for 3:30 stereo 48 kHz on an M1).
 * The input is never modified. Non-finite samples are measured as 0.
 * Notes on fields (contract §4 + extensions):
 * * silence: { startSec, endSec } = durations of leading / trailing audio below −60 dBFS.
 * * stereo.bandCorrelation: [<120, 120–1k, 1k–8k, >8k Hz] (brick-wall FFT bands).
 * * spectrum.bands: dB re total power — sub 20–60, low 60–250, lowMid 250–500, mid
 *   500–2k, highMid 2–6k, high 6–12k, air 12–20k Hz.
 * * indices: tonal excesses in dB (see file header) with detected peak frequencies;
 *   sibilance = median event excess over the 8 dB event threshold; air = 10–16 kHz vs
 *   2–6 kHz relative to REFERENCE_LTAS (− = lacks air); shimmer / hash / hiss /
 *   hfModulation are normalised so that 0 is the RESEARCH gate (+ = fires).
 *   Extensions: sibilanceAirEventsPerMin (10–16 kHz events), brightness (6–10 kHz vs
 *   250 Hz–2 kHz re reference), lowEnd (< 120 Hz re reference), hfFlatness,
 *   hissLevelDb (quiet-frame 10–16 kHz level per 1/3 octave), slope1to10k (dB/oct band
 *   power), nearMonoShare.
 * @param {{ sampleRate: number, channels: Float32Array[] }} audio
 * @param {{ timings?: object }} [opts] timings: filled with per-pass milliseconds
 * @returns {object} AnalysisReport
 */
export function analyzeTrack(audio, opts = {}) {
  const sr = +audio.sampleRate;
  if (!(sr > 0)) throw new RangeError(`analyzeTrack: invalid sampleRate ${audio.sampleRate}`);
  const chans = sanitize(toStereo(audio.channels || []));
  const [L, R] = chans;
  const n = Math.min(L.length, R.length);
  const duration = n / sr;
  const tm = opts.timings && typeof opts.timings === 'object' ? opts.timings : {};
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let t0 = now();
  const loud = measure(chans, sr);
  tm.loudness = now() - t0;
  const integrated = loud.integrated;
  const plr = Number.isFinite(integrated) ? loud.truePeakDb - integrated : 0;
  t0 = now();
  const ts = timeScan(L, R, sr);
  tm.time = now() - t0;
  t0 = now();
  const sp = stereoSpectrum(chans, sr, { overlap: 0.5 });
  tm.spectrum = now() - t0;
  t0 = now();
  const lt = Array.from(ltasFromSpectrum(chans, sr, { spectrum: sp.mid }), (v) => round(v));
  const fc = hfCutoffHz(chans, sr, { spectrum: sp.mid });
  const nyq = sr / 2;

  // ---- valid bands for trends: 31.5 Hz … min(16 kHz, cutoff), not empty
  let ymax = -Infinity;
  for (let b = 2; b <= 29; b++) ymax = Math.max(ymax, lt[b]);
  const valid = new Uint8Array(NB);
  let nValid = 0;
  for (let b = 2; b <= 29; b++) {
    if (CENTRE[b] * Math.pow(10, 1 / 20) <= Math.min(fc, 0.95 * nyq) && lt[b] > ymax - 60 && lt[b] > -200) {
      valid[b] = 1;
      nValid++;
    }
  }
  const validAll = new Uint8Array(NB); // incl. 20/25 Hz for rumble
  for (let b = 0; b < NB; b++) validAll[b] = (b < 2 ? lt[b] > -200 && ymax > -200 : valid[b]) ? 1 : 0;
  const tonalOk = nValid >= 8 && sp.mid.frames > 0;
  // trend input: 1-2-1 power smoothing of the LTAS (sparse arrangements make adjacent
  // third-octaves alternate by a few dB; the trend must not follow that)
  const lts = new Float64Array(NB);
  for (let b = 0; b < NB; b++) {
    const pw = (j) => Math.pow(10, lt[clamp(j, 0, NB - 1)] / 10);
    lts[b] = db10(0.25 * pw(b - 1) + 0.5 * pw(b) + 0.25 * pw(b + 1));
  }
  const peakOf = (lo, hi, width, def, gap) => (tonalOk ? regionPeak(sp.mid, lts, valid, lo, hi, width, def, gap) : { excess: 0, hz: def });
  // mud is broad (Q ≈ 0.9): a 2/3-octave window against neighbours ≥ 2/3 octave away
  const mudPk = peakOf(180, 800, 2 / 3, 300, 0.67);
  // prefer the classic 200–500 Hz region unless a 500–800 Hz peak clearly dominates
  if (tonalOk && mudPk.hz > 520) {
    const core = peakOf(200, 500, 2 / 3, 300, 0.67);
    if (core.excess > mudPk.excess - 0.75) Object.assign(mudPk, core);
  }
  const boomPk = peakOf(90, 160, 1 / 3, 120, 0.5);
  const harshPk = fc > 6500 ? peakOf(2000, 6000, 1 / 3, 3500, 0.5) : { excess: 0, hz: 3500 };
  const fizzPk = fc > 8500 ? peakOf(5000, 8000, 1 / 3, 6000, 0.5) : { excess: 0, hz: 6000 };
  tm.tonal = now() - t0;

  // ---- reference-relative balance (level-matched over 125 Hz – 4 kHz)
  const dev = new Float64Array(NB);
  const offs = [];
  for (let b = 0; b < NB; b++) {
    dev[b] = lt[b] - REFERENCE_LTAS[b];
    if (valid[b] && CENTRE[b] >= 120 && CENTRE[b] <= 4200) offs.push(dev[b]);
  }
  offs.sort((a, b) => a - b);
  const off = offs.length ? offs[offs.length >> 1] : 0;
  for (let b = 0; b < NB; b++) dev[b] -= off;
  const validHf = new Uint8Array(NB);
  for (let b = 0; b < NB; b++) validHf[b] = lt[b] > -200 && CENTRE[b] < 0.95 * nyq ? 1 : 0;
  const devMid = fin(refDev(dev, valid, 250, 2000));
  const dev26 = fin(refDev(dev, valid, 2000, 6300));
  let air = 0;
  if (tonalOk) {
    // bands above the cutoff count as empty (their LTAS is the codec floor)
    const top = fin(refDev(dev, validHf, 10000, Math.min(16000, 0.95 * nyq)), dev26 - 30);
    air = Math.max(-30, top - dev26);
  }
  const brightness = tonalOk ? fin(refDev(dev, validHf, 6300, 10000), devMid) - devMid : 0;
  const hf616 = tonalOk ? fin(refDev(dev, validHf, 6300, 16000), devMid - 30) - devMid : 0;
  const lowEnd = tonalOk ? fin(refDev(dev, valid, 40, 125)) - devMid : 0;
  const rumble = tonalOk ? fin(refDev(dev, validAll, 20, 25)) - fin(refDev(dev, valid, 40, 80)) : 0;
  // 1–10 kHz slope of the band power (dB/oct), for the bright-style cap
  let slope = 0;
  {
    let c = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let b = 0; b < NB; b++) {
      if (!valid[b] || CENTRE[b] < 950 || CENTRE[b] > 10500) continue;
      c++; sx += XOCT[b]; sy += lt[b]; sxx += XOCT[b] ** 2; sxy += XOCT[b] * lt[b];
    }
    const d = c * sxx - sx * sx;
    if (c >= 4 && d > 1e-9) slope = (c * sxy - sx * sy) / d;
  }

  // ---- frame scan and sibilance
  t0 = now();
  const fsn = frameScan(L, R, sr, fc);
  tm.frames = now() - t0;
  const sibA = fsn.sibA;
  const sibB = fc >= 15500 ? fsn.sibB : { eventsPerMin: 0, excessDb: -8, events: 0 };

  // shimmer: flickering partial clusters per kHz re 0.45/kHz (0 = gate). [E] calibration on
  // the demo: clean ≈ 0.13–0.2, with the 10 codec-like partials ≈ 0.86–0.9, pink noise 0.
  // Trance gates (1/16 … 1/4) and deep tremolo do not count (co-modulated, see frameScan):
  // 0–0.2/kHz instead of 0.7–1.5. Real Suno set (n = 7): 5 above the gate before and after.
  const shimmer = fsn.flickerWindows ? db10((fsn.flicker + 0.02) / 0.45) : -10;
  // hiss (RESEARCH denoise gate "level > −70 dBFS/band" on a typical −15 LUFS Suno file):
  // the stationary 10–16 kHz floor re programme loudness above −55 LU, the floor within
  // 14 dB of the median HF level (it is there all the time, not only in decays), and
  // noise-like (flatness ≥ 0.5). 0 = gate.
  const floorRel = fsn.hissLevelDb - (Number.isFinite(integrated) ? integrated : -70);
  let hiss = Math.min(floorRel + 55, 14 - fsn.floorSpread);
  if (fsn.flatness < 0.5 || fsn.hissLevelDb < -95) hiss = Math.min(hiss, -0.1 - 10 * Math.max(0, 0.5 - fsn.flatness));
  // hash: in the quietest frames the top octave sticks out > 6 dB more (re 2–6 kHz) than
  // over the whole track, and the HF floor is noise-like [E]
  let hash = fsn.hashDb - 6;
  if (fsn.flatness < 0.5 || fsn.hissLevelDb < -85) hash = Math.min(hash, -0.1);
  // HF modulation re 2.5 dB RMS — the stand-in for RESEARCH's "reference 80th percentile"
  // (uncalibrated [E]: the demo reads ≈ 2.0–2.2 dB with and without its artifacts)
  const hfModulation = fsn.hfModDb - 2.5;

  const st = {
    correlation: round(correlation(chans), 1000),
    sideToMidDb: round(sideToMid(L, R), 10),
    nearMono: ts.activeWindows > 0 && ts.nearMonoShare >= 0.5,
    bandCorrelation: sp.bandCorrelation,
    sideToMidHfDb: round(sp.sideToMidHfDb, 10),
  };

  // ---- spectrum bands (dB re total)
  const groups = { sub: [20, 60], low: [60, 250], lowMid: [250, 500], mid: [500, 2000], highMid: [2000, 6000], high: [6000, 12000], air: [12000, 20000] };
  let tot = 0;
  for (let b = 0; b < NB; b++) tot += Math.pow(10, lt[b] / 10);
  const bands = {};
  for (const [k, [lo, hi]] of Object.entries(groups)) {
    let p = 0;
    for (let b = 0; b < NB; b++) {
      const f = THIRD_OCTAVE_HZ[b];
      if (f >= lo && f < hi) p += Math.pow(10, lt[b] / 10);
    }
    bands[k] = tot > 1e-24 ? round(Math.max(-120, db10(p) - db10(tot)), 10) : -120;
  }

  // ---- profile (RESEARCH §2 table) from the codec cutoff; 'brightened' is a continuous
  // modifier on top (report.brightened 0..1), so the f_c emphasis (e.g. midband side-HF
  // control) is kept and processing never flips on a fraction of a dB of brightness
  let profile = 'fullband';
  if (fc <= 13500) profile = 'legacy';
  else if (fc <= 17500) profile = 'midband';
  else if (tonalOk && hf616 < INDEX_GATES.muffled && lowEnd > 1) profile = 'muffled';
  const brightened = tonalOk ? round(brightenedAmount(brightness), 1000) : 0;

  const indices = {
    mud: round(mudPk.excess), mudHz: mudPk.hz,
    boom: round(boomPk.excess), boomHz: boomPk.hz,
    harsh: round(harshPk.excess), harshHz: harshPk.hz,
    fizz: round(fizzPk.excess), fizzHz: fizzPk.hz,
    sibilance: sibA.excessDb, sibilanceEventsPerMin: sibA.eventsPerMin,
    air: round(air), rumble: round(rumble), shimmer: round(shimmer), hash: round(hash), hiss: round(hiss),
    hfModulation: round(hfModulation),
    // extensions
    sibilanceAirEventsPerMin: sibB.eventsPerMin, sibilanceAir: sibB.excessDb,
    brightness: round(brightness), hf616: round(hf616), lowEnd: round(lowEnd), hfFlatness: round(fsn.flatness, 1000),
    hissLevelDb: round(fsn.hissLevelDb, 10), floorSpread: round(fsn.floorSpread, 10), quietGap: round(fsn.quietGap, 10), floorRel: round(floorRel, 10), hashRawDb: round(fsn.hashDb, 10), shimmerFlicker: round(fsn.flicker, 1000),
    hfModDb: round(fsn.hfModDb), slope1to10k: round(slope), nearMonoShare: round(ts.nearMonoShare, 1000),
  };

  const silence = ts.first < 0 ? { startSec: round(duration, 1000), endSec: round(duration, 1000) } : {
    startSec: round(ts.first / sr, 1000),
    endSec: round((n - 1 - ts.last) / sr, 1000),
  };
  const report = {
    duration,
    sampleRate: sr,
    loudness: {
      integrated,
      lra: loud.lra,
      shortTermMax: loud.shortTermMax,
      momentaryMax: loud.momentaryMax,
      truePeakDb: loud.truePeakDb,
      samplePeakDb: loud.samplePeakDb,
      plr: round(plr),
      curve: loud.curve,
      curveHopSec: loud.curveHopSec,
    },
    rmsDb: round(ts.rmsDb),
    crestDb: round(ts.rmsDb > -240 ? loud.samplePeakDb - ts.rmsDb : 0),
    dcOffset: [ts.dc[0], ts.dc[1]],
    stereo: st,
    spectrum: { ltas: lt, hfCutoffHz: fc, bands },
    profile,
    brightened,
    indices,
    clipping: ts.clipping,
    silence,
    abruptEnd: ts.abruptEnd,
    issues: [],
  };
  report.issues = findIssues(report, ts);
  return report;
}

function sideToMid(L, R) {
  let sm = 0, ss = 0;
  for (let i = 0; i < L.length; i++) {
    const m = L[i] + R[i], s = L[i] - R[i];
    sm += m * m;
    ss += s * s;
  }
  if (!(sm + ss > 1e-24)) return -100;
  return clamp(db10(ss) - db10(sm), -100, 100);
}

/** Issue chips (ARCHITECTURE §7) with severities 0..1 (0.15 when just past the gate). */
function findIssues(r, ts) {
  const out = [];
  const add = (id, sev, value) => out.push({ id, severity: sev, value: typeof value === 'number' ? round(value, 1000) : value });
  const I = r.loudness.integrated;
  const tp = r.loudness.truePeakDb;
  const x = r.indices;
  const G = INDEX_GATES;
  const silent = !Number.isFinite(I);
  if (r.clipping.runs > 0) add('clipping', severity(Math.log10(1 + r.clipping.runs), 0, 2.5), r.clipping.runs);
  if (tp > 0) add('overs', severity(tp, 0, 2), tp);
  if (!silent && I > -9) add('tooLoud', severity(I, -9, -6), I);
  if (!silent && I < -20) add('tooQuiet', severity(-I, 20, 30), I);
  const dc = Math.max(Math.abs(r.dcOffset[0]), Math.abs(r.dcOffset[1]));
  // Suno exports typically carry 0.0004–0.0016 of DC on one channel (−56…−68 dBFS): the
  // stage-1 DC blocker removes it, so the chip only appears from 0.001 and stays minor.
  if (dc > 0.001) add('dcOffset', Math.min(0.33, severity(Math.log10(dc / 0.001), 0, 1.3)), dc);
  if (!silent) {
    if (x.rumble > G.rumble) add('rumble', severity(x.rumble, G.rumble, G.rumble + 9), x.rumble);
    if (x.boom > G.boom) add('boomy', severity(x.boom, G.boom, G.boom + 4), x.boom);
    if (x.mud > G.mud) add('muddy', severity(x.mud, G.mud, G.mud + 4), x.mud);
    if (x.harsh > G.harsh) add('harsh', severity(x.harsh, G.harsh, G.harsh + 5), x.harsh);
    if (x.fizz > G.fizz) add('fizz', severity(x.fizz, G.fizz, G.fizz + 4), x.fizz);
    // Every sung track has "s" events (40–120 per minute on real Suno exports): severity
    // follows how far they stand out (median excess over the 8 dB event threshold; real
    // Suno vocals 2–4.5 dB, a clearly sibilant vocal ≥ 8 dB), not how many there are.
    if (x.sibilanceEventsPerMin > G.sibilanceEventsPerMin && x.sibilance > G.sibilanceExcessDb) {
      add('sibilant', severity(x.sibilance, G.sibilanceExcessDb, G.sibilanceExcessDb + 8), x.sibilance);
    }
    if (x.shimmer > G.shimmer) add('shimmer', severity(x.shimmer, G.shimmer, G.shimmer + 6), x.shimmer);
    if (x.hiss > G.hiss) add('hiss', severity(x.hiss, G.hiss, G.hiss + 10), x.hiss);
    if (r.brightened > 0) add('brightened', round(0.15 + 0.85 * r.brightened, 1000), x.brightness);
    else if (x.air < G.air) add('dull', severity(-x.air, -G.air, -G.air + 9), x.air);
    if (r.spectrum.hfCutoffHz <= 17000) add('codecCutoff', severity(17000 - r.spectrum.hfCutoffHz, 0, 6000), r.spectrum.hfCutoffHz);
    if (r.stereo.nearMono) add('nearMono', severity(x.nearMonoShare, 0.5, 1), x.nearMonoShare);
    if (r.stereo.correlation < 0.2) add('phase', severity(-r.stereo.correlation, -0.2, 0.5), r.stereo.correlation);
    if (r.stereo.bandCorrelation[0] < 0.7) add('wideBass', severity(-r.stereo.bandCorrelation[0], -0.7, 0), r.stereo.bandCorrelation[0]);
    if (r.abruptEnd) add('abruptEnd', severity(ts.endLevelDb, -30, -12), round(ts.endLevelDb, 10));
    if (r.loudness.plr < 8 && r.loudness.lra < 3) add('overCompressed', severity(8 - r.loudness.plr, 0, 4), r.loudness.plr);
  }
  const silMax = Math.max(r.silence.startSec, r.silence.endSec);
  if (ts.first < 0) add('silence', 1, r.duration); // digital silence (below −60 dBFS) throughout
  else if (silMax > 0.5) add('silence', severity(silMax, 0.5, 5), silMax);
  return out;
}
