// The mastering chain: renderMaster() (ARCHITECTURE §5, RESEARCH §1 stages 1–12).
// Async orchestration of the DSP primitives: yields between stages, honours cancellation
// at stage boundaries, caches the post-spectral (A) and post-glue (B) audio per track.
// Stages 1–9 run at the SOURCE rate; when the export rate differs the post-glue audio is
// resampled right before the loudness stage (cached per rate), so every destination
// shares caches A and B (switching to / from Club's 44.1 kHz re-runs only stage 10).
//
// Dynamics: multiband bands and glue get their threshold from
// calibrateThreshold — the target is the realised mean gain reduction (attack / release
// included) of the LOUD sections (windows within 5 dB of the 95th-percentile level), so
// verses below the threshold are left alone instead of dragging it down; the destination
// scales the targets (assistant). The multiband split is processed band by band
// (compress, accumulate, release) to keep the peak memory low.
//
// Loudness stage (10) — accurate in ~one limiter pass:
//   A block-rate model of the true-peak limiter (same moving-min hold / adaptive release /
//   box smoothing as limiter.js, on 16-sample blocks of the linked 'limiter'-quality true-
//   peak envelope) predicts the gated integrated loudness of gain → soft clip → limiter →
//   fades for any gain, from cached K-weighted block energies. Solving it (secant) gives the
//   gain for the first real pass; real passes are then corrected by the model calibrated
//   with the measured offset (secant on real points when there are two). A pass that is too
//   loud is trimmed down exactly (static gain: BS.1770 is homogeneous), one that is too
//   quiet with peak headroom is trimmed up exactly, otherwise re-rendered (max 4 passes).
//   The soft-clip threshold shaves ≈ amountDb off the highest true peaks. Only when the
//   target needs more than maxGrDb of (robust) limiting — or, at Loud / Club (a target
//   range), more than the limiter budget — does the clipper escalate: up to 2 dB, then
//   toward the 99th/95th/90th-percentile peak level with a shorter limiter release, never
//   deeper than clipper.maxDepthDb on the highest peak (3 dB Medium, 4 dB High). Beyond
//   that a Loud / Club master settles at the loudest level within the limiter budget, but
//   not below loudness.minTargetLufs (the range's low end), and anything still needing
//   more than maxGrDb is capped — both report warn.targetUnreachable (a normal outcome for
//   dynamic songs, worded as such in the UI).
//
// Zero phase: the stage-1 subsonic filters run forward + backward and the multiband sum is
// passed time-reversed through the crossover allpasses, so no stage delays the bass (the
// master stays sample-aligned with the original for the A/B player; a trimmed head is
// reported as report.trim.startSec, the original's time at the master's sample 0).
//
// QC rollback (RESEARCH §2): the net static EQ range (±4 dB per third-octave) is checked
// on the intended curves BEFORE rendering (no wasted render); after the final measure the
// master is checked against the input: 8–16 kHz balance (minus the change the style and
// the user's own moves intend), correlation (only when widening made a band worse than the
// input), correlation below 120 Hz. Per failing check the single module that moves the
// failing metric most is halved, then disabled (user-owned paths, params.meta.userOwned,
// are never touched), and the chain re-renders from the nearest cache (max 2 rollbacks) →
// warn.qcRollback. The outcome is memoised per cache-B key, so a later loudness-only
// change does not repeat the rollback renders.

import { resampleAudio } from '../dsp/resample.js';
import { design, firstOrder, butterworth, linkwitzRiley4, processStereoInPlace } from '../dsp/biquad.js';
import { spectralCleanup } from '../dsp/spectral.js';
import { ltas, hfCutoffHz, autoEqCurve, matchEqCurve, fitGraphicEq, toneSections, curveResponseDb, THIRD_OCTAVE_HZ } from '../dsp/eq.js';
import { dynamicBandCut, calibrateThreshold, compress, levelStats } from '../dsp/dynamics.js';
import { saturate, airExciter } from '../dsp/saturation.js';
import { stereoImage, correlation } from '../dsp/stereo.js';
import { softClip, limitTruePeak } from '../dsp/limiter.js';
import { truePeakEnvelope } from '../dsp/oversample.js';
import { measure, kWeightingSections } from '../analysis/loudness.js';
import { stereoSpectrum } from '../analysis/analyze.js';
import { validateParams, isUserOwned, DYN_EQ_BAND_IDS } from './params.js';
import { yieldToEventLoop, clamp, dbToGain, toStereo } from '../dsp/util.js';

/** Render stages in order (progress ids; the UI prefixes `stage.`). */
export const STAGES = ['prepare', 'trim', 'spectral', 'eq', 'dyneq', 'color', 'multiband', 'stereo', 'glue', 'loudness', 'finish', 'verify'];

const NB = 31;
const DB10 = 10 / Math.LN10;
const db10 = (p) => DB10 * Math.log(p > 1e-30 ? p : 1e-30);
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const r3 = (v) => Math.round(fin(v) * 1000) / 1000;
const ZERO_GR = Object.freeze({ grAvgDb: 0, grMaxDb: 0 });
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function cancelledError() {
  const e = new Error('cancelled');
  e.code = 'cancelled';
  return e;
}

function cloneCh(ch) {
  return ch.map((c) => Float32Array.from(c));
}

/** Cheap content fingerprint (strided sums): cache keys must change with the audio. */
function fingerprint(audio) {
  const chs = audio.channels || [];
  let s = `${audio.sampleRate}|${chs.length}|${chs.length ? chs[0].length : 0}`;
  for (const c of chs) {
    let a = 0, b = 0;
    const step = Math.max(1, Math.floor(c.length / 65536));
    for (let i = 0; i < c.length; i += step) {
      const v = c[i];
      if (v === v) {
        a += v;
        b += v * ((i % 997) + 1);
      }
    }
    s += `|${a.toPrecision(12)}:${b.toPrecision(12)}`;
  }
  return s;
}

/**
 * Trim window (stage 2): keepStartMs before the first and keepEndMs after the last sample
 * above thresholdDb (any channel) of the SOURCE audio (renderMaster decides it before the
 * stage-1 filters). trim.head === false keeps the start, trim.tail === false the end.
 * No sample above the threshold → no trim.
 * Extension (not in the contract): exported for tests / UI.
 * @returns {{ start: number, end: number }} sample range [start, end)
 */
export function trimBounds(channels, sampleRate, trim = {}) {
  const n = channels.length ? Math.min(...channels.map((c) => c.length)) : 0;
  const thr = dbToGain(fin(trim.thresholdDb, -60));
  let first = -1, last = -1;
  for (let i = 0; i < n && first < 0; i++) for (const c of channels) if (Math.abs(c[i]) > thr) { first = i; break; }
  for (let i = n - 1; i >= 0 && last < 0; i--) for (const c of channels) if (Math.abs(c[i]) > thr) { last = i; break; }
  if (first < 0) return { start: 0, end: n };
  const start = trim.head === false ? 0 : Math.max(0, first - Math.round((fin(trim.keepStartMs, 100) * sampleRate) / 1000));
  const end = trim.tail === false ? n : Math.min(n, last + 1 + Math.round((fin(trim.keepEndMs, 800) * sampleRate) / 1000));
  return { start, end };
}

/** Equal-power fade gains: in g = sin(π/2·i/Tin), out g = sin(π/2·(n−1−i)/Tout). */
function fadeLengths(n, sampleRate, finish) {
  let tin = Math.max(0, Math.round((fin(finish.fadeInMs, 5) * sampleRate) / 1000));
  let tout = Math.max(0, Math.round((fin(finish.fadeOutMs, 30) * sampleRate) / 1000));
  if (tin + tout > n && tin + tout > 0) {
    const s = n / (tin + tout);
    tin = Math.floor(tin * s);
    tout = Math.floor(tout * s);
  }
  return { tin, tout };
}

function fadeGainAt(i, n, tin, tout) {
  let g = 1;
  if (tin > 0 && i < tin) g *= Math.sin((0.5 * Math.PI * i) / tin);
  if (tout > 0 && i > n - 1 - tout) g *= Math.sin((0.5 * Math.PI * Math.max(0, n - 1 - i)) / tout);
  return g;
}

function applyFades(ch, sampleRate, finish) {
  const n = ch[0].length;
  const { tin, tout } = fadeLengths(n, sampleRate, finish);
  for (let i = 0; i < tin; i++) {
    const g = fadeGainAt(i, n, tin, tout);
    for (const c of ch) c[i] *= g;
  }
  for (let i = Math.max(tin, n - tout); i < n; i++) {
    const g = fadeGainAt(i, n, tin, tout);
    for (const c of ch) c[i] *= g;
  }
}

/**
 * Mirror-extended copies of the channels, `pad` samples each side, so IIR passes start
 * and end without a step; `reversed` lays them out back to front. Even (mirror)
 * reflection rather than scipy's odd one: an odd (point) reflection of a track that ends
 * abruptly at a high level can reach 3× its peak, and the filter carries that energy back
 * into the last samples.
 */
function paddedCopies(ch, pad, reversed) {
  return ch.map((x) => {
    const n = x.length;
    const p = Math.min(pad, Math.max(0, n - 1));
    const buf = new Float32Array(n + 2 * p);
    for (let j = 0; j < p; j++) {
      buf[j] = x[p - j]; // before the start
      buf[p + n + j] = x[n - 2 - j]; // after the end
    }
    buf.set(x, p);
    if (reversed) buf.reverse();
    return { buf, p };
  });
}

/** Copy the centre of padded (possibly reversed) buffers back into the channels. */
function unpad(ch, bufs, reversed) {
  ch.forEach((x, c) => {
    const { buf, p } = bufs[c];
    if (reversed) buf.reverse();
    x.set(buf.subarray(p, p + x.length));
  });
}

/** Anti-causal (time-reversed) pass through `sections`, both channels interleaved. */
function reverseFilterInPlace(ch, sampleRate, sections, padSec = 0.05) {
  if (!sections.length || !ch[0].length) return;
  const bufs = paddedCopies(ch, Math.round(padSec * sampleRate), true);
  processStereoInPlace(bufs.map((b) => b.buf), sections);
  unpad(ch, bufs, true);
}

/**
 * Stage 1 filters, zero-phase (forward + time-reversed pass, so bass is not delayed: a
 * minimum-phase 25 Hz high-pass delays 50 Hz by ≈ 2.5 ms): DC blocker (1st order, 5 Hz)
 * and the subsonic Butterworth high-pass. The two passes square the magnitude, so each
 * pass uses half the order with the corner moved to keep −3 dB at highpassHz
 * (fc' = fc·(√2 − 1)^(1/(2m)), m = order/2): order 2 → 12 dB/oct, order 4 → 24 dB/oct.
 * Order 1 stays a single causal pass.
 */
function subsonicInPlace(ch, sampleRate, prep) {
  if (!ch[0].length) return;
  const secs = [];
  if (prep.dcBlock) secs.push(firstOrder('highpass', 5 * Math.sqrt(Math.SQRT2 - 1), sampleRate));
  let causal = null;
  const hz = prep.highpassHz;
  if (hz > 0) {
    const order = prep.highpassOrder;
    if (order % 2 === 0) {
      const m = order / 2;
      secs.push(...butterworth('highpass', m, hz * Math.pow(Math.SQRT2 - 1, 1 / (2 * m)), sampleRate));
    } else causal = butterworth('highpass', order, hz, sampleRate);
  }
  if (secs.length) {
    const bufs = paddedCopies(ch, Math.round(0.2 * sampleRate), false); // 0.2 s: a 16 Hz corner settles
    const arr = bufs.map((b) => b.buf);
    processStereoInPlace(arr, secs);
    for (const a of arr) a.reverse();
    processStereoInPlace(arr, secs);
    for (const a of arr) a.reverse();
    unpad(ch, bufs, false);
  }
  if (causal) processStereoInPlace(ch, causal);
}

function scaleInPlace(ch, g) {
  if (g === 1) return;
  for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= g;
}

/** measure() result after a static gain of `db` (exact: BS.1770 is homogeneous). */
function shiftMeasure(m, db) {
  const curve = Float32Array.from(m.curve, (v) => (v > -119.99 ? v + db : v));
  return {
    ...m,
    integrated: m.integrated + db,
    shortTermMax: m.shortTermMax + db,
    momentaryMax: m.momentaryMax + db,
    truePeakDb: m.truePeakDb + db,
    samplePeakDb: m.samplePeakDb + db,
    curve,
  };
}

/** 1/3-octave LTAS (+ per-band correlation) of a stereo signal, analysis estimator. */
function spectrumOf(ch, sampleRate, overlap) {
  const sp = stereoSpectrum(ch, sampleRate, { overlap });
  const lt = Array.from(ltas(ch, sampleRate, { spectrum: sp.mid }), (v) => Math.round(v * 100) / 100);
  return { sp, ltas: lt };
}

/** HF balance: 8–16 kHz band power re 63 Hz – 16 kHz (dB), from a 31-band LTAS. */
function hfBalance(lt, sampleRate) {
  let hf = 0, all = 0;
  for (let b = 0; b < NB; b++) {
    const f = THIRD_OCTAVE_HZ[b];
    if (f < 63 || f > 16000 || f > 0.45 * sampleRate) continue;
    const p = Math.pow(10, fin(lt[b], -240) / 10);
    all += p;
    if (f >= 8000) hf += p;
  }
  return all > 1e-24 && hf > 0 ? db10(hf) - db10(all) : -240;
}

// ------------------------------------------------------------------ loudness model

/** Largest block size <= 16 dividing the 100 ms grain (so grains are whole blocks). */
function blockSizeFor(grain) {
  for (let d = 16; d > 1; d--) if (grain % d === 0) return d;
  return 1;
}

/**
 * Cached per post-glue audio: K-weighted energy per block (both channels, Σ y²) and the
 * block maximum of the linked 'limiter'-quality true-peak envelope (the limiter's own
 * detector), plus the overall peak.
 */
function proxyPrep(ch, sampleRate) {
  const n = ch[0].length;
  const grain = Math.max(1, Math.round(0.1 * sampleRate));
  const B = blockSizeFor(grain);
  const nb = Math.ceil(n / B);
  const kE = new Float64Array(nb);
  const pk = new Float32Array(nb);
  const secs = kWeightingSections(sampleRate);
  for (const x of ch) {
    let s10 = 0, s11 = 0, s20 = 0, s21 = 0;
    const [c1, c2] = secs;
    for (let b = 0; b < nb; b++) {
      const e = Math.min(n, (b + 1) * B);
      let acc = 0;
      for (let i = b * B; i < e; i++) {
        const v = x[i];
        const y1 = c1.b0 * v + s10;
        s10 = c1.b1 * v - c1.a1 * y1 + s11;
        s11 = c1.b2 * v - c1.a2 * y1;
        const y2 = c2.b0 * y1 + s20;
        s20 = c2.b1 * y1 - c2.a1 * y2 + s21;
        s21 = c2.b2 * y1 - c2.a2 * y2;
        acc += y2 * y2;
      }
      kE[b] += acc;
      if (Math.abs(s10) < 1e-30) s10 = 0;
      if (Math.abs(s11) < 1e-30) s11 = 0;
      if (Math.abs(s20) < 1e-30) s20 = 0;
      if (Math.abs(s21) < 1e-30) s21 = 0;
    }
  }
  const env = new Float32Array(n);
  let pkMax = 0;
  for (const x of ch) {
    truePeakEnvelope(x, sampleRate, env, 'limiter');
    for (let b = 0; b < nb; b++) {
      const e = Math.min(n, (b + 1) * B);
      let m = pk[b];
      for (let i = b * B; i < e; i++) if (env[i] > m) m = env[i];
      pk[b] = m;
      if (m > pkMax) pkMax = m;
    }
  }
  // Peak-level percentiles of the active blocks (0.1 dB histogram): the "top peaks" the
  // soft clipper shaves — refs[0] = max, refs[1] = 99th, refs[2] = 95th, refs[3] = 90th.
  const H = new Uint32Array(1201); // 0 … −120 dB re pkMax in 0.1 dB steps
  let cnt = 0;
  const gate = Math.max(1e-3, pkMax * 1e-4);
  for (let b = 0; b < nb; b++) {
    if (pk[b] < gate) continue;
    const d = 20 * Math.log10(pk[b] / pkMax);
    H[Math.min(1200, Math.max(0, Math.round(-d * 10)))]++;
    cnt++;
  }
  const maxDb = 20 * Math.log10(Math.max(pkMax, 1e-12));
  const refs = [maxDb, maxDb, maxDb, maxDb];
  if (cnt) {
    const qs = [0, 0.01, 0.05, 0.1];
    let acc = 0, i = 0;
    for (let qi = 1; qi < qs.length; qi++) {
      for (; i <= 1200; i++) {
        if (acc + H[i] >= qs[qi] * cnt) break;
        acc += H[i];
      }
      refs[qi] = maxDb - Math.min(i, 1200) / 10;
    }
  }
  return { n, B, nb, grain, kE, pk, pkMax, refs, sampleRate };
}

/** A 4× coarser copy of the model data (for the escalation searches; ≈ 4× faster). */
function coarsePrep(prep) {
  const perGrain = prep.grain / prep.B;
  let D = 1;
  for (let d = 4; d > 1; d--) if (perGrain % d === 0) { D = d; break; }
  if (D === 1) return prep;
  const nb = Math.ceil(prep.nb / D);
  const kE = new Float64Array(nb), pk = new Float32Array(nb);
  for (let b = 0; b < prep.nb; b++) {
    const c = (b / D) | 0;
    kE[c] += prep.kE[b];
    if (prep.pk[b] > pk[c]) pk[c] = prep.pk[b];
  }
  return { ...prep, B: prep.B * D, nb, kE, pk };
}

/**
 * Predicted result of gain → soft clip → true-peak limiter → fades at block rate.
 * → { lufs, grP99, grMax } (gr values in dB, >= 0 = reduction depth)
 */
function proxyEval(prep, gDb, o, wantGr = false) {
  const { B, nb, grain, kE, pk, sampleRate, n } = prep;
  const G = dbToGain(gDb);
  const clipLin = o.clipThrDb === null ? Infinity : dbToGain(o.clipThrDb);
  const cInt = dbToGain(o.ceilingDb - 0.15); // limiter: safety 0.05 + detector margin 0.1
  const Ls = Math.max(1, Math.round(o.lookaheadMs * 1e-3 * sampleRate));
  const Hs = Ls + Math.max(1, Math.round(5e-3 * sampleRate));
  const Hb = Math.max(1, Math.ceil(Hs / B));
  const Lb = Math.max(1, Math.round(Ls / B));
  const R = Math.max(1, o.releaseMs * 1e-3 * sampleRate);
  const kR = 1 / ((o.adaptive ? 0.5 * R : R) + 1), kRs = 1 / (3 * R + 1);
  const kS = 1 - Math.exp(-1 / (Math.max(2 * o.releaseMs, 100) * 1e-3 * sampleRate));
  const kSb = 1 - Math.pow(1 - kS, B);
  const powB = (k) => 1 - Math.pow(1 - k, B);
  const kRb = powB(kR), kRsb = powB(kRs);
  // moving minimum (monotonic deque) over Hb blocks, release, box of Lb blocks
  let cap = 1;
  while (cap < Hb + 2) cap <<= 1;
  const mask = cap - 1;
  const dqV = new Float64Array(cap), dqI = new Int32Array(cap);
  let head = 0, tail = 0;
  const ring = new Float64Array(Lb).fill(1);
  let ri = 0, rsum = Lb, rf = 1, sus = 0;
  const gainAt = new Float32Array(nb);
  for (let b = 0; b < nb + Lb - 1; b++) {
    let gt = 1;
    if (b < nb) {
      let v = pk[b] * G;
      if (v > clipLin) v = clipLin;
      if (v > cInt) gt = cInt / v;
    }
    while (tail > head && dqV[(tail - 1) & mask] >= gt) tail--;
    dqV[tail & mask] = gt;
    dqI[tail & mask] = b;
    tail++;
    if (dqI[head & mask] <= b - Hb) head++;
    const h = dqV[head & mask];
    let k = kRb;
    if (o.adaptive) {
      sus += ((h < 1 ? 1 : 0) - sus) * kSb;
      k = kRb + (kRsb - kRb) * sus;
    }
    if (h <= rf) rf = h;
    else rf += (h - rf) * k;
    rsum += rf - ring[ri];
    ring[ri] = rf;
    if (++ri === Lb) ri = 0;
    const m = b - Lb + 1;
    if (m >= 0 && m < nb) gainAt[m] = Math.min(1, rsum / Lb);
  }
  // gated integrated loudness from 100 ms grains (BS.1770: 400 ms blocks, 75 % overlap)
  const { tin, tout } = fadeLengths(n, sampleRate, o.finish);
  const perGrain = grain / B;
  const nG = Math.floor(n / grain);
  const gp = new Float64Array(nG);
  const clipE = clipLin < Infinity;
  for (let gI = 0; gI < nG; gI++) {
    let acc = 0;
    for (let j = 0; j < perGrain; j++) {
      const b = gI * perGrain + j;
      let e = kE[b] * gainAt[b] * gainAt[b];
      if (clipE) {
        const v = pk[b] * G;
        if (v > clipLin) e *= clipEnergy(clipLin / v);
      }
      const mid = b * B + (B >> 1);
      if (mid < tin || mid > n - 1 - tout) {
        const f = fadeGainAt(mid, n, tin, tout);
        e *= f * f;
      }
      acc += e;
    }
    gp[gI] = (acc * G * G) / grain;
  }
  const lufs = gatedLufs(gp);
  let grP99 = 0, grMax = 0;
  if (wantGr) {
    // 99th percentile of the block gain reduction over active blocks (0.02 dB histogram)
    const HB = 2000, step = 0.02;
    const hist = new Uint32Array(HB + 1);
    const gate = 1e-3 / G; // −60 dBFS true peak after the gain
    let minG = 1, cnt = 0;
    for (let b = 0; b < nb; b++) {
      if (pk[b] < gate) continue;
      const g = gainAt[b];
      cnt++;
      if (g >= 1) {
        hist[0]++;
        continue;
      }
      if (g < minG) minG = g;
      hist[Math.min(HB, Math.round(-20 * Math.log10(Math.max(g, 1e-6)) / step))]++;
    }
    if (cnt) {
      let acc = 0, i = HB;
      for (; i > 0; i--) {
        acc += hist[i];
        if (acc >= 0.01 * cnt) break;
      }
      grP99 = i * step;
      grMax = -20 * Math.log10(Math.max(1e-6, minG));
    }
  }
  return { lufs, grP99, grMax };
}

/**
 * Energy kept when a block peaking at 1 is clipped at c (0 < c < 1): the mean of the
 * clipped-sine power ratio (4/π)[θ/2 − c√(1−c²)/2 + c²(π/2 − θ)], θ = asin c (a block
 * holding a whole cycle), and c² (a block sitting on the crest of a slow wave).
 */
function clipEnergy(c) {
  const th = Math.asin(c);
  const sine = (4 / Math.PI) * (0.5 * th - 0.5 * c * Math.sqrt(1 - c * c) + c * c * (0.5 * Math.PI - th));
  return 0.5 * (sine + c * c);
}

/** BS.1770 integrated loudness from 100 ms grain powers (G = 1 per channel). */
function gatedLufs(gp) {
  const nG = gp.length;
  if (nG < 4) return -Infinity;
  const blocks = [];
  for (let i = 0; i + 4 <= nG; i++) blocks.push(0.25 * (gp[i] + gp[i + 1] + gp[i + 2] + gp[i + 3]));
  const lk = (p) => -0.691 + db10(p);
  const absP = Math.pow(10, (-70 + 0.691) / 10);
  let s = 0, c = 0;
  for (const p of blocks) if (p > absP) { s += p; c++; }
  if (!c) return -Infinity;
  const rel = (s / c) * 0.1;
  let s2 = 0, c2 = 0;
  for (const p of blocks) if (p > absP && p > rel) { s2 += p; c2++; }
  return c2 ? lk(s2 / c2) : -Infinity;
}

/**
 * Smallest g with f(g) >= target for a monotonically non-decreasing f (bracketing, then
 * Illinois regula falsi until the bracket is 0.01 dB wide). A limiter's loudness curve
 * flattens toward saturation, so "f(g) ≈ target" can hold over a wide range of gains; the
 * smallest one means the least limiting for the same loudness.
 */
function solveGain(f, target, g0, lo = -40, hi = 40) {
  let a = clamp(g0, lo, hi), fa = f(a) - target;
  if (!Number.isFinite(fa)) return a;
  let b;
  let fb;
  if (fa >= 0) {
    // walk down until below the target
    b = a;
    fb = fa;
    let step = 2;
    for (let i = 0; i < 16; i++) {
      a = clamp(b - step, lo, hi);
      fa = f(a) - target;
      if (fa < 0 || a === lo) break;
      b = a;
      fb = fa;
      step *= 1.6;
    }
    if (fa >= 0) return a;
  } else {
    let step = 2;
    for (let i = 0; i < 16; i++) {
      b = clamp(a + step, lo, hi);
      fb = f(b) - target;
      if (fb >= 0 || b === hi) break;
      a = b;
      fa = fb;
      step *= 1.6;
    }
    if (fb < 0) return b;
  }
  // invariant: fa < 0 <= fb
  let side = 0;
  for (let i = 0; i < 40 && b - a > 0.01; i++) {
    let c = b - (fb * (b - a)) / (fb - fa);
    if (!(c > a && c < b)) c = 0.5 * (a + b);
    const fc = f(c) - target;
    if (fc >= 0) {
      b = c;
      fb = fc;
      if (side === 1) fa *= 0.5; // Illinois: keep the stale end from stalling
      side = 1;
    } else {
      a = c;
      fa = fc;
      if (side === -1) fb *= 0.5;
      side = -1;
    }
  }
  return b;
}

/**
 * Stage 10 (+ 11 fades inside each pass so the measured loudness includes them).
 * @returns {{ channels, loudness, limiter, clipper, gainDb, passes, warnings, targetReached,
 *   grP99, effectiveTargetLufs }}
 */
async function loudnessStage(x, sampleRate, P, prep, ctx) {
  const L = P.loudness;
  const T = L.targetLufs, C = L.ceilingDb;
  // Loud / Club: the target may settle down to minTargetLufs (the range's low end) rather
  // than push the limiter past its budget or the clipper past its depth cap
  const minT = Number.isFinite(L.minTargetLufs) ? Math.min(L.minTargetLufs, T) : T;
  const lowerable = minT < T - 0.05;
  const escLimit = lowerable ? L.budgetDb : L.maxGrDb;
  const lim = { lookaheadMs: L.limiter.lookaheadMs, releaseMs: L.limiter.releaseMs, adaptive: L.limiter.adaptiveRelease !== false };
  let clipAmt = L.clipper.enabled ? fin(L.clipper.amountDb, 0) : 0;
  const depthCap = Math.max(clipAmt, fin(L.clipper.maxDepthDb, 3));
  const tpMaxDb = 20 * Math.log10(Math.max(prep.pkMax, 1e-12));
  const warnings = [];
  // Soft clip (RESEARCH §1 intensity row 0 / 0.5 / 1.5 dB): shave ≈ clipAmt dB off the top
  // peaks (reference = the highest true peak after the gain), wherever they sit — at a
  // quiet destination it only densifies (compression raises the global PLR a little:
  // loud sections are turned down while the highest peak stays), near the ceiling it takes
  // that share of the limiter's work.
  // Escalation (only when the target is otherwise out of reach within escLimit), clipRef
  // 0 → 3: the reference moves from the highest peak to the 99th (1), 95th (2) and 90th
  // (3) percentile peak level, so the clipper shaves more of the transients and the
  // limiter stays within its budget — but no peak is ever clipped deeper than depthCap
  // (clipper.maxDepthDb: 3 dB at Medium, 4 dB at High; tests measured 4–7.5 dB of drum
  // clipping without this cap). Beyond clipRef 1 the limiter release shortens (×1 → ×0.5,
  // ≥ 30 ms) — a brick-wall limiter with a slow release cannot follow bass cycles, its
  // output loudness saturates (e.g. ≈ −9 LUFS at −1 dBTP on bass-heavy material).
  let clipRef = 0;
  const refDb = (a) => {
    const i = Math.min(2, Math.floor(a)), f = a - i;
    return prep.refs[i] + (prep.refs[Math.min(3, i + 1)] - prep.refs[i]) * f;
  };
  const clipThrFor = (g) => {
    if (!(clipAmt > 0)) return null;
    return Math.max(refDb(clipRef) + g - clipAmt, tpMaxDb + g - depthCap);
  };
  const baseRelease = lim.releaseMs;
  const setRef = (a) => {
    clipRef = a;
    lim.releaseMs = Math.max(Math.min(30, baseRelease), baseRelease * (1 - 0.25 * Math.max(0, a - 1)));
  };
  const modelOpts = (g) => ({ clipThrDb: clipThrFor(g), ceilingDb: C, ...lim, finish: P.finish });
  const model = (g) => proxyEval(prep, g, modelOpts(g)).lufs;
  if (!prep.coarse) prep.coarse = coarsePrep(prep);
  const modelC = (g) => proxyEval(prep.coarse, g, modelOpts(g)).lufs;
  const grAtC = (g) => proxyEval(prep.coarse, g, modelOpts(g), true);
  const realPass = (g) => {
    const tq = now();
    const G = dbToGain(g);
    const out = x.map((c) => {
      const o = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) o[i] = c[i] * G;
      return o;
    });
    const thr = clipThrFor(g);
    const clip = thr !== null ? softClip(out, sampleRate, { thresholdDb: thr }) : { grMaxDb: 0, clippedPct: 0 };
    const limiter = limitTruePeak(out, sampleRate, { ceilingDb: C, lookaheadMs: lim.lookaheadMs, releaseMs: lim.releaseMs, adaptiveRelease: lim.adaptive });
    limiter.releaseMs = lim.releaseMs;
    applyFades(out, sampleRate, P.finish);
    const tl = now();
    const m = measure(out, sampleRate);
    ctx.timings.loudnessMeasure = (ctx.timings.loudnessMeasure || 0) + (now() - tl);
    ctx.timings.loudnessPasses = (ctx.timings.loudnessPasses || 0) + (tl - tq);
    return { out, clip, limiter, m, g, clipAmt, clipRef };
  };
  const L0 = model(0);
  if (!Number.isFinite(L0)) {
    // silence or too short to gate (< 400 ms): no make-up gain, ceiling still enforced
    const r = realPass(0);
    return { channels: r.out, loudness: r.m, limiter: r.limiter, clipper: { ...r.clip, amountDb: 0 }, gainDb: 0, passes: 1, warnings, targetReached: false, grP99: 0, effectiveTargetLufs: T };
  }
  // budget: robust peak limiting = 99th percentile of the block gain reduction
  const grAt = (gg) => proxyEval(prep, gg, modelOpts(gg), true);
  // gain: coarse solve, then the fine one bracketed ±3 dB around it (full range if the
  // fine solution sits on the bracket edge)
  const gC = solveGain(modelC, T, T - L0);
  let g = solveGain(model, T, gC, gC - 3, gC + 3);
  if (g <= gC - 2.999 || g >= gC + 2.999) g = solveGain(model, T, g);
  let need = grAt(g);
  // A brick-wall limiter's output loudness saturates (its smooth gain keeps the waveform's
  // own crest factor): if the target needs more than escLimit, let the clipper take a
  // larger share first — in 0.5 dB steps up to 2 dB (RESEARCH §1) — when enabled.
  // The searches run on the 4× coarser model; the final gain on the fine one.
  const clipCap = Math.min(depthCap, Math.max(clipAmt, 2));
  const clipBase = clipAmt;
  if (need.grP99 > escLimit && L.clipper.enabled && clipAmt > 0) {
    const off = model(g) - modelC(g); // coarse → fine calibration
    const solveC = (g0) => solveGain(modelC, T - off, g0);
    let gc = g, nc = need;
    while (nc.grP99 > escLimit && clipAmt < clipCap) {
      clipAmt = Math.min(clipCap, clipAmt + 0.5);
      gc = solveC(gc);
      nc = grAtC(gc);
    }
    if (nc.grP99 > escLimit) {
      // smallest escalation that keeps the limiter within its budget (bisection on clipRef)
      const tryRef = (a) => {
        setRef(a);
        const gg = solveC(gc);
        return { a, g: gg, need: grAtC(gg) };
      };
      let best = tryRef(3);
      if (best.need.grP99 <= L.budgetDb) {
        let lo = 0, hi = 3;
        for (let i = 0; i < 5; i++) {
          const mid = 0.5 * (lo + hi);
          const t = tryRef(mid);
          if (t.need.grP99 <= L.budgetDb) {
            hi = mid;
            best = t;
          } else lo = mid;
        }
      }
      setRef(best.a);
      gc = best.g;
    }
    g = solveGain(model, T, gc);
    need = grAt(g);
  }
  const escalated = clipAmt > clipBase || clipRef > 0;
  /** Highest gain whose limiting stays within `limit` (coarse bisection, two fine steps). */
  const gainWithin = (limit, gHi) => {
    let lo = gHi - 24, hi = gHi;
    // an unreachable target leaves the solver at its +40 dB bound: widen the bracket down
    for (let k = 0; k < 3 && grAtC(lo).grP99 > limit; k++) {
      hi = lo;
      lo -= 24;
    }
    for (let i = 0; i < 12; i++) {
      const mid = 0.5 * (lo + hi);
      if (grAtC(mid).grP99 > limit) hi = mid;
      else lo = mid;
    }
    lo -= 0.25;
    hi = Math.min(gHi, lo + 0.75);
    for (let i = 0; i < 3; i++) {
      const mid = 0.5 * (lo + hi);
      if (grAt(mid).grP99 > limit) hi = mid;
      else lo = mid;
    }
    return lo;
  };
  let Teff = T;
  if (lowerable && need.grP99 > L.budgetDb) {
    // Loud / Club beyond the clipper's cap: settle at the loudest level the limiter
    // reaches within its budget, but not below the destination range
    const gB = gainWithin(L.budgetDb, g);
    const lB = model(gB);
    if (lB >= minT) {
      g = gB;
      Teff = Math.min(T, lB);
    } else {
      Teff = minT;
      g = solveGain(model, minT, Math.min(g, gB + (minT - lB)));
    }
    need = grAt(g);
  }
  let capped = false;
  if (need.grP99 > L.maxGrDb) {
    g = gainWithin(L.maxGrDb, g);
    capped = true;
  }
  const pts = [];
  let r = null;
  let m = null;
  let best = null;
  let passes = 0;
  let trimmed = false;
  for (; passes < 4;) {
    if (ctx.isCancelled()) throw cancelledError();
    r = realPass(g);
    passes++;
    ctx.progress('loudness', Math.min(0.9, 0.25 * passes));
    m = r.m;
    const err = m.integrated - Teff;
    pts.push([g, m.integrated]);
    if (capped || Math.abs(err) <= 0.1) break;
    if (err > 0) {
      // too loud: exact static trim down (peaks only drop)
      scaleInPlace(r.out, dbToGain(-err));
      m = shiftMeasure(m, -err);
      trimmed = true;
      break;
    }
    if (m.truePeakDb - err <= C - 0.02 && -r.limiter.grMaxDb < 0.05) {
      // too quiet but the limiter barely worked and there is peak headroom: exact trim up
      scaleInPlace(r.out, dbToGain(-err));
      m = shiftMeasure(m, -err);
      trimmed = true;
      break;
    }
    // keep only the best untrimmed pass so far (a superseded pass is released at once)
    if (!best || Math.abs(err) < Math.abs(best.m.integrated - Teff)) best = r;
    else r.out = null;
    if (passes >= 4) break;
    // next gain: secant on real points, else the model calibrated with this offset
    let gNext;
    if (pts.length >= 2) {
      const [g1, l1] = pts[pts.length - 2], [g2, l2] = pts[pts.length - 1];
      gNext = Math.abs(l2 - l1) > 1e-3 ? g2 + ((Teff - l2) * (g2 - g1)) / (l2 - l1) : g2 - err;
    } else {
      const off = m.integrated - model(g);
      gNext = solveGain(model, Teff - off, g - err);
    }
    gNext = clamp(gNext, g - 6, g + 6);
    if (grAt(gNext).grP99 > L.maxGrDb) {
      capped = true;
      gNext = Math.min(gNext, g + 0.5 * (gNext - g));
    }
    g = gNext;
  }
  if (!trimmed && !capped && best && best !== r && (!r.out || Math.abs(best.m.integrated - Teff) < Math.abs(m.integrated - Teff))) {
    r = best; // a later pass ended up further from the target (never trimmed: untouched)
    m = r.m;
  }
  if (!r.out && best) {
    r = best;
    m = r.m;
  }
  best = null;
  // final true-peak guard on the reported (sharp-interpolator) reading
  if (m.truePeakDb > C) {
    const d = C - m.truePeakDb - 0.005;
    scaleInPlace(r.out, dbToGain(d));
    m = shiftMeasure(m, d);
  }
  need = grAt(r.g);
  const gr = Math.max(need.grP99, 0);
  const reached = Math.abs(m.integrated - T) <= 0.5;
  // peak reduction actually needed for the loudness: limiter (robust) + transient clipping
  const work = Math.max(gr, escalated ? -r.clip.grMaxDb : 0);
  if (!reached && m.integrated < T) {
    const want = grAt(g + (T - m.integrated));
    warnings.push({ id: 'warn.targetUnreachable', vars: { lufs: Math.round(m.integrated * 10) / 10, gr: Math.round(Math.max(want.grP99, work) * 10) / 10 } });
  } else if (work > L.budgetDb) {
    warnings.push({ id: 'warn.heavyLimiting', vars: { gr: Math.round(work * 10) / 10 } });
  }
  return {
    channels: r.out, loudness: m, limiter: r.limiter, clipper: { ...r.clip, amountDb: r.clipAmt, transientShare: r.clipRef }, gainDb: r.g, passes, warnings,
    targetReached: reached, grP99: gr, effectiveTargetLufs: capped ? m.integrated : Teff,
  };
}

// ------------------------------------------------------------------ one render

/**
 * Loud-section gate of the multiband / glue thresholds: windows within 5 dB of the
 * 95th-percentile window level (the choruses; a single hit cannot move a percentile).
 * Measured on a verse / chorus song 6 dB apart: an 8 dB gate still averaged verse windows
 * in, so the chorus took ≈ 1.5× the target (ΔLRA 0.9 LU per 0.6 dB stage); at 5 dB the
 * LRA loss of a stage ≈ its gain reduction on the choruses.
 */
const LOUD_GATE = Object.freeze({ gateRefPct: 0.95, relGateDb: -5 });

function zeroCurve() {
  return new Array(NB).fill(0);
}

/**
 * Cache keys: A = stages 1–3, B = stages 1–9 (the output rate is not part of either; the
 * destination is, through its dynamics scale — cache.B2 keeps the previous B).
 */
function cacheKeys(P, fp) {
  const keyA = JSON.stringify({ fp, prepare: P.prepare, trim: P.trim, spectral: P.spectral });
  const keyB = JSON.stringify({ keyA, eq: P.eq, dynEq: P.dynEq, color: P.color, multiband: P.multiband, stereo: P.stereo, glue: P.glue });
  return { keyA, keyB };
}

function ap2(f, sampleRate) {
  return design('allpass', clamp(f, 1, 0.49 * sampleRate), sampleRate, { q: Math.SQRT1_2 });
}

/**
 * LR4 band split with the tree of crossover.js (same filters, same phase: the bands sum
 * to ∏ AP2(f_i)·x), but each band is handed to fn(band) as soon as it exists and the low
 * branch is consumed before the high branch is filtered — so only the input, one branch
 * copy and the caller's accumulator are alive at once instead of every band.
 * `chs` is consumed (it becomes the highest band).
 */
function forEachBand(chs, fs, sampleRate, fn) {
  if (!fs.length) {
    fn(chs);
    return;
  }
  const m = (fs.length - 1) >> 1;
  const fm = fs[m];
  const loFs = fs.slice(0, m);
  const hiFs = fs.slice(m + 1);
  const lo = chs.map((c) => Float32Array.from(c));
  const loSecs = linkwitzRiley4('lowpass', fm, sampleRate);
  for (const f of hiFs) loSecs.push(ap2(f, sampleRate));
  processStereoInPlace(lo, loSecs);
  forEachBand(lo, loFs, sampleRate, fn);
  const hiSecs = linkwitzRiley4('highpass', fm, sampleRate);
  for (const f of loFs) hiSecs.push(ap2(f, sampleRate));
  processStereoInPlace(chs, hiSecs);
  forEachBand(chs, hiFs, sampleRate, fn);
}

/**
 * One multiband band: calibrated threshold (realised loud-section GR = targetGrDb), then
 * the compressor on the same detector envelope; preserveBalance restores the band's
 * gated power mean (tonal balance of the long-term spectrum).
 */
function compressBand(band, b, preserve, sr) {
  if (!(b.targetGrDb > 0 && b.ratio > 1)) return { ...ZERO_GR, grLoudAvgDb: 0 };
  const o = {
    ratio: b.ratio, kneeDb: b.kneeDb, attackMs: b.attackMs, releaseMs: b.releaseMs, detector: 'rms', rmsMs: b.rmsMs,
    sidechainHpHz: b.sidechainHpHz, sidechainHpOrder: 4,
  };
  const cal = calibrateThreshold(band, sr, { ...o, targetGrDb: b.targetGrDb, ...LOUD_GATE });
  const before = preserve ? cal.inputStats : null; // levelStats of the band, from the same pass
  const st = compress(band, sr, { ...o, thresholdDb: cal.thresholdDb, envelope: cal.envelope, statsGateDb: cal.statsGateDb });
  cal.envelope = null;
  let makeupDb = 0;
  if (before && before.count > 0) {
    const after = levelStats(band, sr);
    makeupDb = clamp(fin(before.mean - after.mean, 0), 0, 12);
    scaleInPlace(band, dbToGain(makeupDb));
  }
  return { grAvgDb: r3(st.grAvgDb), grLoudAvgDb: r3(st.grLoudAvgDb), grMaxDb: r3(st.grMaxDb), thresholdDb: r3(fin(cal.thresholdDb, 0)), makeupDb: r3(makeupDb) };
}

/**
 * The static EQ curves of P (stage 4 and the pre-render EQ-range check use the same
 * ones): tone sections + response, match, auto. Auto EQ judges the spectrum after the
 * corrective tone cuts (mud / boom / harsh floors: a bump the tone bell already lowers is
 * not cut twice) and after the reference match (both would correct the same
 * deviation), and with a reference it is scaled by (1 − match strength). Tone boosts
 * (style) stay out of it, else the auto EQ would undo the chosen character.
 */
function eqCurves(P, input, sr) {
  const lt = input.ltas;
  const fc = input.cutoffHz;
  const toneSecs = toneSections(P.eq.tone, sr);
  const tone = Array.from(curveResponseDb(toneSecs, THIRD_OCTAVE_HZ, sr));
  const ma = P.eq.match;
  const matchOn = !!(ma.enabled && ma.referenceLtas && ma.strength > 0);
  const match = matchOn
    ? Array.from(matchEqCurve(lt, ma.referenceLtas, { strength: ma.strength, maxDb: ma.maxDb, cutoffHz: fc }))
    : zeroCurve();
  const au = P.eq.auto;
  const autoStrength = au.strength * (matchOn ? 1 - ma.strength : 1);
  const ltAuto = Array.from(lt, (v, i) => v + Math.min(0, tone[i]) + match[i]);
  const auto = au.enabled && autoStrength > 0.005
    ? Array.from(autoEqCurve(ltAuto, { strength: autoStrength, maxDb: au.maxDb, toleranceDb: au.toleranceDb, targetSlopeDbPerOct: au.targetSlopeDbPerOct, cutoffHz: fc }))
    : zeroCurve();
  return { toneSecs, tone, match, auto };
}

async function renderOnce(audio, P, ctx) {
  const tm = ctx.timings;
  const cache = ctx.cache;
  const sr = +audio.sampleRate; // stages 1–9 run at the source rate
  const outRate = P.output.sampleRate === 'source' ? sr : +P.output.sampleRate;
  const { keyA, keyB } = cacheKeys(P, ctx.fp);
  const stage = async (name, fn) => {
    if (ctx.isCancelled()) throw cancelledError();
    ctx.progress(name, 0);
    const t0 = now();
    const res = await fn();
    tm[name] = (tm[name] || 0) + (now() - t0);
    ctx.progress(name, 1);
    await yieldToEventLoop();
    if (ctx.isCancelled()) throw cancelledError();
    return res;
  };
  const skip = async (names) => {
    for (const nm of names) ctx.progress(nm, 1);
    await yieldToEventLoop();
    if (ctx.isCancelled()) throw cancelledError();
  };

  // Cache B keeps the previous post-glue audio too (B2): destinations differ in their
  // dynamics (Hi-Fi / Streaming / Loud), and toggling between two of them is the common
  // comparison — the second visit is then a loudness-only render
  let B = null;
  if (cache && cache.B && cache.B.key === keyB) B = cache.B;
  else if (cache && cache.B2 && cache.B2.key === keyB) {
    B = cache.B2;
    cache.B2 = cache.B;
    cache.B = B;
  }
  let A = !B && cache && cache.A && cache.A.key === keyA ? cache.A : null;
  let ch, trimInfo, spectralStats;
  if (!B && cache && cache.B) {
    // demote the current B before building a new one (drops the older B2 first, and the
    // demoted entry's resampled copy, to bound the peak memory)
    cache.B2 = cache.B;
    cache.B2.out = null;
    cache.B = null;
  }

  if (B) {
    trimInfo = B.trim;
    await skip(STAGES.slice(0, 9));
  } else {
    if (A) {
      trimInfo = A.trim;
      spectralStats = A.spectral;
      ch = cloneCh(A.channels);
      await skip(['prepare', 'trim', 'spectral']);
    } else {
      // ---- 1 prepare: sanitize, DC blocker + subsonic high-pass (zero phase)
      let srcTrim = null;
      await stage('prepare', () => {
        const st = toStereo(audio.channels);
        // trim window decided on the source samples (before filtering, so the filters'
        // subsonic ringing around hard edges cannot move it)
        if (P.trim.enabled) srcTrim = trimBounds(st, sr, P.trim);
        ch = cloneCh(st);
        for (const c of ch) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) c[i] = 0;
        subsonicInPlace(ch, sr, P.prepare);
      });
      // ---- 2 trim
      await stage('trim', () => {
        const n = ch[0].length;
        let start = 0, end = n;
        if (srcTrim) {
          start = Math.min(n, srcTrim.start);
          end = Math.max(start, Math.min(n, srcTrim.end));
        }
        if (start > 0 || end < n) ch = ch.map((c) => c.slice(start, end));
        trimInfo = { startSample: start, endSample: end, sampleRate: sr, trimmed: start > 0 || end < n };
      });
      // ---- 3 spectral cleanup (de-shimmer, denoise)
      await stage('spectral', () => {
        const sp = P.spectral;
        const on = (sp.deShimmer.enabled && sp.deShimmer.amount > 0) || (sp.denoise.enabled && sp.denoise.amount > 0);
        spectralStats = on ? spectralCleanup(ch, sr, sp, (f) => ctx.progress('spectral', 0.98 * f)) : null;
      });
      A = { key: keyA, sampleRate: sr, trim: trimInfo, spectral: spectralStats, channels: cache ? cloneCh(ch) : ch };
      if (cache) cache.A = A;
    }
    // ---- 4 static EQ: auto / match curve (fitted min-phase bank) + tone, one cascade
    let eqInfo = { curve: zeroCurve(), auto: zeroCurve(), match: zeroCurve(), tone: zeroCurve() };
    await stage('eq', () => {
      if (!P.eq.enabled) return;
      // The auto / match curves use the input's long-term spectrum (measured once per
      // track; the analysis provides it): prepare / trim / spectral cleanup do not change
      // the gated 1/3-octave balance meaningfully (HPF < 30 Hz, silence, HF artifacts).
      const c = eqCurves(P, ctx.input, sr);
      const target = c.auto.map((v, i) => v + c.match[i]);
      // fitted bank minus sections that change nothing audible (< 0.05 dB anywhere): each
      // biquad costs a full pass over the track
      const fitted = (target.some((v) => Math.abs(v) > 1e-3) ? fitGraphicEq(target, sr) : [])
        .filter((sec) => curveResponseDb([sec], THIRD_OCTAVE_HZ, sr).some((v) => Math.abs(v) >= 0.05));
      const secs = [...fitted, ...c.toneSecs];
      if (secs.length) processStereoInPlace(ch, secs);
      eqInfo = {
        curve: Array.from(curveResponseDb(secs, THIRD_OCTAVE_HZ, sr), (v) => Math.round(v * 100) / 100),
        auto: c.auto, // intended curves (QC attribution, decisions); `curve` is the realised net response
        match: c.match,
        tone: c.tone,
      };
    });
    // ---- 5 dynamic EQ bands
    const dynStats = {};
    await stage('dyneq', () => {
      const ids = DYN_EQ_BAND_IDS.filter((id) => P.dynEq.bands[id] && P.dynEq.bands[id].enabled && P.dynEq.bands[id].maxCutDb > 0);
      ids.forEach((id, i) => {
        const b = P.dynEq.bands[id];
        dynStats[id] = dynamicBandCut(ch, sr, {
          type: b.type, channel: b.channel, freq: b.freq, q: b.q, thresholdRelDb: b.thresholdRelDb, ratio: b.ratio,
          maxCutDb: b.maxCutDb, attackMs: b.attackMs, releaseMs: b.releaseMs, kneeDb: b.kneeDb, lookaheadMs: b.lookaheadMs,
        });
        ctx.progress('dyneq', (i + 1) / ids.length);
      });
    });
    // ---- 6 color: saturation, then air exciter (after harshness is controlled)
    const colorStats = {};
    await stage('color', () => {
      const c = P.color;
      if (c.saturation.enabled && c.saturation.drive > 0) colorStats.saturation = saturate(ch, sr, { drive: c.saturation.drive, mix: c.saturation.mix });
      if (c.air.enabled && c.air.amount > 0) colorStats.air = airExciter(ch, sr, { amount: c.air.amount, fromHz: c.air.fromHz });
    });
    // ---- 7 multiband compression (LR4 band by band, calibrated threshold, balance restored)
    let mbStats = P.multiband.bands.map(() => ({ ...ZERO_GR, grLoudAvgDb: 0 }));
    await stage('multiband', () => {
      const mb = P.multiband;
      if (!mb.enabled || !mb.bands.some((b) => b.targetGrDb > 0 && b.ratio > 1)) return;
      const xo = mb.crossovers.filter((f) => Number.isFinite(f) && f > 0).map((f) => clamp(f, 1, 0.49 * sr)).sort((a, b) => a - b);
      const nb = xo.length + 1;
      mbStats = new Array(nb);
      let acc = null, bi = 0;
      forEachBand(ch, xo, sr, (band) => {
        const i = bi++;
        ctx.progress('multiband', (i + 0.5) / nb);
        mbStats[i] = compressBand(band, mb.bands[i] || mb.bands[mb.bands.length - 1], mb.preserveBalance, sr);
        if (!acc) acc = band;
        else {
          for (let c = 0; c < acc.length; c++) {
            const d = acc[c], s = band[c];
            for (let j = 0; j < d.length; j++) d[j] += s[j];
          }
        }
      });
      ch = acc;
      // The LR4 band sum is the input through Π AP2(f_i); running the sum time-reversed
      // through the same allpasses cancels that phase (|AP|² = 1, zero phase), so the
      // stage adds no bass group delay (≈ 3.5 ms at 60 Hz for a 120 Hz split).
      reverseFilterInPlace(ch, sr, xo.map((f) => ap2(f, sr)));
    });
    // ---- 8 stereo: mono bass, width
    await stage('stereo', () => {
      const s = P.stereo;
      if (s.enabled && (s.width !== 1 || s.monoBassHz > 0)) stereoImage(ch, sr, { width: s.width, widthFromHz: s.widthFromHz, monoBassHz: s.monoBassHz });
    });
    // ---- 9 glue compressor (4th-order sidechain HPF, auto release, calibrated threshold)
    let glueStats = { ...ZERO_GR, grLoudAvgDb: 0 };
    await stage('glue', () => {
      const gl = P.glue;
      if (!gl.enabled || !(gl.targetGrDb > 0) || !(gl.ratio > 1)) return;
      const o = {
        ratio: gl.ratio, kneeDb: gl.kneeDb, attackMs: gl.attackMs, releaseMs: gl.releaseMs, autoRelease: gl.autoRelease,
        detector: 'rms', rmsMs: 10, sidechainHpHz: gl.sidechainHpHz, sidechainHpOrder: gl.sidechainHpOrder,
      };
      const cal = calibrateThreshold(ch, sr, { ...o, targetGrDb: gl.targetGrDb, ...LOUD_GATE });
      const st = compress(ch, sr, { ...o, mix: gl.mix, thresholdDb: cal.thresholdDb, envelope: cal.envelope, statsGateDb: cal.statsGateDb });
      glueStats = { grAvgDb: r3(st.grAvgDb), grLoudAvgDb: r3(st.grLoudAvgDb), grMaxDb: r3(st.grMaxDb), thresholdDb: r3(fin(cal.thresholdDb, 0)) };
    });
    // nothing writes to the post-glue audio any more (the loudness passes copy it), so the
    // working buffers themselves become cache B — no copy
    B = {
      key: keyB, sampleRate: sr, trim: trimInfo, channels: ch, proxy: null, out: null,
      stats: { spectral: spectralStats, dynEq: dynStats, color: colorStats, multiband: mbStats, glue: glueStats, eq: eqInfo },
    };
    ch = null;
    if (cache) cache.B = B;
  }

  // ---- 10 loudness (+ 11 fades inside each pass), at the output rate: the post-glue
  // audio is resampled here when the export rate differs (one cached copy per B)
  let ld;
  await stage('loudness', async () => {
    let src = B;
    if (outRate !== sr) {
      if (!B.out || B.out.sampleRate !== outRate) {
        const tr = now();
        B.out = null; // release the previous rate's copy before allocating the new one
        B.out = { sampleRate: outRate, channels: resampleAudio({ sampleRate: sr, channels: B.channels }, outRate).channels, proxy: null };
        tm.resample = (tm.resample || 0) + (now() - tr);
      }
      src = B.out;
    }
    const tp = now();
    if (!src.proxy) src.proxy = proxyPrep(src.channels, src.sampleRate);
    tm.loudnessModel = (tm.loudnessModel || 0) + (now() - tp);
    ld = await loudnessStage(src.channels, src.sampleRate, P, src.proxy, ctx);
  });
  await stage('finish', () => {}); // fades were applied inside the loudness passes
  return { channels: ld.channels, sampleRate: outRate, B, ld, trimInfo };
}

// ------------------------------------------------------------------ QC

/** Tone keys and the companion fields that define their section (attribution, softening). */
const TONE_KEYS = {
  lowShelfDb: ['lowShelfHz'], boomDb: ['boomHz', 'boomQ'], mudDb: ['mudHz', 'mudQ'], presenceDb: ['presenceHz', 'presenceQ'],
  airDb: ['airHz'], highShelfDb: ['highShelfHz'], hashDb: ['hashHz'], tiltDbPerOct: ['tiltPivotHz'],
};

/** Param path of a QC module id (C1 ownership). */
function modulePath(m) {
  if (m.startsWith('dynEq.')) return `dynEq.bands.${m.slice(6)}`;
  if (m.startsWith('tone.')) return `eq.tone.${m.slice(5)}`;
  return { denoise: 'spectral.denoise', deShimmer: 'spectral.deShimmer', autoEq: 'eq.auto', match: 'eq.match', width: 'stereo.width', monoBass: 'stereo.monoBassHz' }[m] || m;
}

/** The style's own share of a tone key (meta.styleTone): intended, never softened. */
function styleShare(P, key) {
  const st = P.meta && P.meta.styleTone;
  return st && Number.isFinite(st[key]) ? st[key] : 0;
}

/** Softenable (assistant-owned) part of a tone key: its value minus the style's share; 0 if user-owned. */
function assistantPart(P, key) {
  if (isUserOwned(P, `eq.tone.${key}`)) return 0;
  const v = fin(P.eq.tone[key], 0) - styleShare(P, key);
  return Math.abs(v) > 1e-3 ? v : 0;
}

/** Response (31 bands) of one tone key at `value`, with its frequency / Q from `tone`. */
function toneKeyCurve(tone, key, value, sr) {
  const t = { [key]: value };
  for (const c of TONE_KEYS[key]) t[c] = tone[c];
  return curveResponseDb(toneSections(t, sr), THIRD_OCTAVE_HZ, sr);
}

/**
 * The static change P intends regardless of QC: the style's tone moves, the
 * user's own tone values (C1) and the reference match (the user picked it). The HF check
 * measures the drop beyond this.
 */
function intendedCurve(P, sr, eq) {
  const out = eq && eq.match ? Array.from(eq.match) : zeroCurve();
  const st = (P.meta && P.meta.styleTone) || {};
  for (const key of Object.keys(TONE_KEYS)) {
    const user = isUserOwned(P, `eq.tone.${key}`);
    const v = user ? fin(P.eq.tone[key], 0) : fin(st[key], 0);
    if (Math.abs(v) < 1e-3) continue;
    // frequency / Q: the style's own when it set them (styleTone carries them)
    const c = toneKeyCurve(user ? P.eq.tone : { ...P.eq.tone, ...st }, key, v, sr);
    for (let i = 0; i < NB; i++) out[i] += c[i];
  }
  return out;
}

/** hfBalance change caused by a static curve on the input spectrum (dB; − = darker). */
function hfDelta(lt, curve, sampleRate) {
  return hfBalance(Array.from(lt, (v, i) => v + fin(curve[i], 0)), sampleRate) - hfBalance(lt, sampleRate);
}

/**
 * Pre-render EQ-range check (RESEARCH §2 "total EQ within ±4 dB per 1/3 octave"): the
 * intended net curve is known before rendering, so the rollback costs no render. At the
 * worst band, the single assistant-owned contributor pushing that way hardest (auto EQ or
 * one tone key's assistant part) is halved, then removed; repeated until within ±4 dB or
 * only user-owned / intended moves are left (accepted: the user asked for them).
 * @returns {{ P: object, applied: string[] }}
 */
function planEqRange(P, input, sr, halved) {
  let q = P;
  const applied = [];
  if (!q.eq.enabled || !input || !input.ltas) return { P: q, applied };
  for (let it = 0; it < 6; it++) {
    const c = eqCurves(q, input, sr);
    let worst = 0, wi = -1;
    for (let i = 0; i < NB; i++) {
      const v = c.tone[i] + c.match[i] + c.auto[i];
      if (Math.abs(v) > Math.abs(worst)) {
        worst = v;
        wi = i;
      }
    }
    if (Math.abs(worst) <= 4 || wi < 0) break;
    const m = topContributor(q, worst, wi, c.auto, sr);
    if (!m) break;
    const r = soften(q, [m], halved);
    if (!r.applied.length) break;
    q = r.params;
    applied.push(...r.applied);
  }
  return { P: q, applied };
}

/** Assistant-owned module pushing the band `wi` hardest in the direction of `worst` (or null). */
function topContributor(P, worst, wi, auto, sr) {
  let best = null, bestV = 0.3;
  const push = (m, v) => {
    const s = Math.sign(v) === Math.sign(worst) ? Math.abs(v) : 0;
    if (s > bestV) {
      bestV = s;
      best = m;
    }
  };
  if (P.eq.auto.enabled && P.eq.auto.strength > 0 && !isUserOwned(P, 'eq.auto')) push('autoEq', fin(auto[wi], 0));
  for (const key of Object.keys(TONE_KEYS)) {
    const part = assistantPart(P, key);
    if (part) push(`tone.${key}`, toneKeyCurve(P.eq.tone, key, part, sr)[wi]);
  }
  return best;
}

/**
 * RESEARCH §2 QC checks on the rendered master → [{ check, value, modules, intended }]:
 * modules = the single softenable module that moves the failing metric most ([] when only
 * user-owned or style-intended moves are responsible: intended = true, the check counts
 * as met — the user asked for it).
 */
function qcFailures(P, res, master, input, ctx) {
  const fails = [];
  const st = res.B.stats;
  const eq = st.eq;
  const sr = res.B.sampleRate;
  const bands = P.dynEq.bands;
  const on = (id) => bands[id] && bands[id].enabled && bands[id].maxCutDb > 0;
  const own = (m) => isUserOwned(P, modulePath(m));
  const bri = fin(P.meta && P.meta.brightened, 0);
  // 1. 8–16 kHz balance: the drop beyond the intended change (style, user, reference)
  //    must stay within 3 dB (+2 dB on fully 'brightened' tracks, which need HF cuts)
  if (input && input.ltas) {
    const lt = input.ltas;
    const hi = hfBalance(lt, input.sampleRate);
    const ho = hfBalance(master.ltas, res.sampleRate);
    const expected = hi > -60 ? hfDelta(lt, intendedCurve(P, sr, eq), input.sampleRate) : 0;
    const drop = ho - hi - expected;
    if (hi > -60 && drop < -(3 + 2 * bri)) {
      // only modules that actually lower 8–16 kHz relative to the rest (a 2–6 kHz harsh
      // cut or a low-shelf boost does not; the side-channel shelf does not touch the mid
      // spectrum this check reads)
      const cands = [];
      const spec = st.spectral || {};
      for (const m of ['denoise', 'deShimmer']) {
        if (P.spectral[m].enabled && P.spectral[m].amount > 0 && spec[m]) cands.push([m, -fin(spec[m].avgReductionDb, 0)]);
      }
      for (const id of DYN_EQ_BAND_IDS) {
        const b = bands[id];
        if (!on(id) || b.channel === 'side' || !st.dynEq[id]) continue;
        const depth = fin(st.dynEq[id].grAvgDb, 0);
        if (depth > -0.01) continue;
        const dip = b.type === 'shelf'
          ? curveResponseDb([design('highshelf', b.freq, sr, { q: 0.7, gainDb: depth })], THIRD_OCTAVE_HZ, sr)
          : curveResponseDb([design('peaking', b.freq, sr, { q: b.q, gainDb: depth })], THIRD_OCTAVE_HZ, sr);
        cands.push([`dynEq.${id}`, -hfDelta(lt, dip, input.sampleRate)]);
      }
      for (const key of Object.keys(TONE_KEYS)) {
        const part = assistantPart(P, key);
        if (part) cands.push([`tone.${key}`, -hfDelta(lt, toneKeyCurve(P.eq.tone, key, part, sr), input.sampleRate)]);
      }
      if (P.eq.auto.enabled && !own('autoEq')) cands.push(['autoEq', -hfDelta(lt, eq.auto, input.sampleRate)]);
      const pick = cands.filter(([m, v]) => v > 0.1 && !own(m)).sort((a, b) => b[1] - a[1])[0];
      fails.push({ check: 'hf', value: drop, modules: pick ? [pick[0]] : [], intended: !pick });
    }
  }
  // 2. correlation: overall >= 0.2, no negative band — only widening can make it worse,
  //    and only a band / overall value worse than the input's counts (Suno mixes
  //    often carry a negative 1–8 kHz correlation of their own)
  const bc = master.bandCorrelation;
  if (P.stereo.enabled && P.stereo.width > 1) {
    const inBc = ctx.inputBandCorrelation();
    const inCorr = fin(input && input.correlation, 1);
    // tolerance 0.1: the analysis and verify spectra use different frame grids, and a 5 %
    // widening moves a near-zero band correlation by ≈ 0.05 (inaudible) — real damage
    // (e.g. +50 % on an anti-phase band) moves it by 0.3–0.5
    const worseBand = bc.some((v, i) => v < Math.min(0, fin(inBc[i], 1)) - 0.1);
    const worseAll = master.correlation < 0.2 && master.correlation < inCorr - 0.1;
    if (worseBand || worseAll) {
      const user = own('width');
      fails.push({ check: 'correlation', value: master.correlation, modules: user ? [] : ['width'], intended: user });
    }
  }
  // 3. below 120 Hz >= 0.7: strengthen mono bass
  if (bc[0] < 0.7 && (P.stereo.monoBassHz < 160 || !P.stereo.enabled)) {
    const user = own('monoBass') || isUserOwned(P, 'stereo.enabled');
    fails.push({ check: 'bassCorrelation', value: bc[0], modules: user ? [] : ['monoBass'], intended: user });
  }
  // 4. realised net static EQ within ±4 dB (the intended curve was checked before the
  //    render; this catches a fitted bank that overshoots the intended curve)
  let worst = 0, wi = -1;
  eq.curve.forEach((v, i) => {
    if (Math.abs(v) > Math.abs(worst)) {
      worst = v;
      wi = i;
    }
  });
  if (Math.abs(worst) > 4.3 && wi >= 0) {
    const m = topContributor(P, worst, wi, eq.auto, sr);
    fails.push({ check: 'eqRange', value: worst, modules: m ? [m] : [], intended: !m });
  }
  return fails;
}

/**
 * Halve (first time) or remove (second time) the given modules → new params. Tone keys
 * are softened one by one and only in their assistant-owned part (the style's share and
 * user-owned values stay); user-owned modules (C1) are skipped.
 */
function soften(P, modules, halved) {
  const q = JSON.parse(JSON.stringify(P));
  const applied = [];
  const half = (v) => Math.round(v * 50) / 100;
  for (const m of new Set(modules)) {
    if (isUserOwned(q, modulePath(m))) continue;
    const again = halved.has(m);
    halved.add(m);
    if (m === 'denoise' || m === 'deShimmer') {
      const s = q.spectral[m];
      if (again) s.enabled = false;
      else s.amount = half(s.amount);
    } else if (m.startsWith('dynEq.')) {
      const b = q.dynEq.bands[m.slice(6)];
      if (!b) continue;
      if (again) b.enabled = false;
      else b.maxCutDb = half(b.maxCutDb);
    } else if (m.startsWith('tone.')) {
      const key = m.slice(5);
      if (!(key in TONE_KEYS)) continue;
      const share = styleShare(q, key);
      const part = fin(q.eq.tone[key], 0) - share;
      q.eq.tone[key] = Math.round((share + (again ? 0 : part / 2)) * 100) / 100;
    } else if (m === 'autoEq') {
      if (again) q.eq.auto.enabled = false;
      else q.eq.auto.strength = half(q.eq.auto.strength);
    } else if (m === 'width') {
      q.stereo.width = again ? 1 : Math.round((1 + (q.stereo.width - 1) / 2) * 100) / 100;
    } else if (m === 'monoBass') {
      q.stereo.enabled = true;
      q.stereo.monoBassHz = q.stereo.monoBassHz > 0 ? Math.min(160, Math.round(q.stereo.monoBassHz * 1.4)) : 120;
    } else continue;
    applied.push(m.startsWith('dynEq.') ? 'dynEq' : m.startsWith('tone.') ? 'tone' : m);
  }
  return { params: validateParams(q), applied: [...new Set(applied)] };
}

/** QC memo key: the cache-B key of the requested params + who owns what. */
function memoKey(P, fp) {
  return `${cacheKeys(P, fp).keyB}|${JSON.stringify((P.meta && P.meta.userOwned) || [])}|${JSON.stringify((P.meta && P.meta.styleTone) || {})}`;
}

const QC_MEMO_MAX = 16;

// ------------------------------------------------------------------ public API

/**
 * Render the master (ARCHITECTURE §5). The input audio is never modified.
 * @param {{ sampleRate: number, channels: Float32Array[] }} audio stereo (mono accepted)
 * @param {object} params Params (validated here)
 * @param {{ onProgress?: (stage: string, fraction: number) => void, cache?: object,
 *   isCancelled?: () => boolean, inputInfo?: { loudness?: object, ltas?: number[], cutoffHz?: number,
 *   clippingRuns?: number, bandCorrelation?: number[], correlation?: number, bitrateKbps?: number,
 *   lossy?: boolean } }} [opts]
 *   cache: plain object owned by the caller (one per track); inputInfo (extension): input
 *   measurements already known (e.g. from the analysis) to skip re-measuring them, plus the
 *   decoder's lossy / bitrate info (warn.lossySource).
 * @returns {Promise<{ audio: { sampleRate: number, channels: Float32Array[] }, report: object }>}
 *   rejects with an Error whose `code` is 'cancelled' when isCancelled() turns true.
 */
export async function renderMaster(audio, params, opts = {}) {
  if (!audio || !audio.channels || !audio.channels.length || !(audio.sampleRate > 0)) {
    throw Object.assign(new Error('renderMaster: invalid audio'), { code: 'render' });
  }
  const t0 = now();
  const cache = opts.cache && typeof opts.cache === 'object' ? opts.cache : null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const isCancelled = typeof opts.isCancelled === 'function' ? () => !!opts.isCancelled() : () => false;
  const ctx = {
    cache,
    isCancelled,
    timings: {},
    fp: fingerprint(audio),
    progress: (stage, f) => {
      if (!onProgress) return;
      try {
        onProgress(stage, f);
      } catch {
        /* a UI callback must never break the render */
      }
    },
  };
  let P = validateParams(params);
  const srcRate = +audio.sampleRate;

  // input measurements (cached per track; seeded from the analysis when given)
  let input = cache && cache.input && cache.input.key === ctx.fp ? cache.input : null;
  if (!input) {
    const t1 = now();
    const info = opts.inputInfo || {};
    const st = toStereo(audio.channels);
    const loud = info.loudness && Number.isFinite(info.loudness.lra) ? info.loudness : measure(st, srcRate);
    let lt, cutoffHz, bandCorr = null;
    if (info.ltas && info.ltas.length === NB && Number.isFinite(info.cutoffHz)) {
      lt = Array.from(info.ltas);
      cutoffHz = info.cutoffHz;
    } else {
      const s = spectrumOf(st, srcRate, 0.5);
      lt = s.ltas;
      cutoffHz = hfCutoffHz(st, srcRate, { spectrum: s.sp.mid });
      bandCorr = s.sp.bandCorrelation;
    }
    if (Array.isArray(info.bandCorrelation) && info.bandCorrelation.length >= 4) bandCorr = info.bandCorrelation.slice(0, 4);
    let runs = fin(info.clippingRuns, -1);
    if (runs < 0) {
      runs = 0;
      for (const c of st) {
        let run = 0;
        for (let i = 0; i <= c.length; i++) {
          if (i < c.length && Math.abs(c[i]) >= 0.999) run++;
          else {
            if (run >= 3) runs++;
            run = 0;
          }
        }
      }
    }
    input = {
      key: ctx.fp, loudness: loud, ltas: lt, cutoffHz, sampleRate: srcRate, clippingRuns: runs, duration: st[0].length / srcRate,
      bandCorrelation: bandCorr, correlation: Number.isFinite(info.correlation) ? info.correlation : null,
    };
    if (cache) cache.input = input;
    ctx.timings.input = now() - t1;
  }
  ctx.input = input;
  // input band correlation for the width check: from the analysis, else measured once
  ctx.inputBandCorrelation = () => {
    if (!input.bandCorrelation) {
      const s = spectrumOf(toStereo(audio.channels), srcRate, 0.5);
      input.bandCorrelation = s.sp.bandCorrelation;
      if (!Number.isFinite(input.correlation)) input.correlation = correlation(toStereo(audio.channels));
    }
    return input.bandCorrelation;
  };

  // QC: a remembered outcome for these params (same cache-B key) skips the rollbacks
  // already found; otherwise the EQ range is settled on the intended curves first
  const rollbacks = [];
  let halved = new Set();
  const mKey = memoKey(P, ctx.fp);
  const memo = cache && cache.qcMemo instanceof Map ? cache.qcMemo.get(mKey) : null;
  if (P.qc.enabled && memo) {
    P = validateParams({ ...P, ...JSON.parse(memo.patch) });
    rollbacks.push(...memo.rollbacks);
    halved = new Set(memo.halved);
  } else if (P.qc.enabled) {
    const plan = planEqRange(P, input, srcRate, halved);
    P = plan.P;
    rollbacks.push(...plan.applied);
  }
  let res, master, fails = [];
  for (let attempt = 0; ; attempt++) {
    res = await renderOnce(audio, P, ctx);
    // ---- 12 verify: master spectrum / correlation, QC
    if (isCancelled()) throw cancelledError();
    ctx.progress('verify', 0);
    const tv = now();
    // The QC compares this with the input LTAS of the analysis (50 % overlap). On short
    // files the frame grid alone moves impulsive HF (hats, "s") by ±1.5 dB, so the same
    // estimator is used there; long files average enough frames to skip every other one.
    const dur = res.channels[0].length / res.sampleRate;
    const s = spectrumOf(res.channels, res.sampleRate, dur >= 120 ? -1 : dur >= 45 ? 0 : 0.5);
    master = { ltas: s.ltas, bandCorrelation: s.sp.bandCorrelation, correlation: correlation(res.channels) };
    fails = P.qc.enabled ? qcFailures(P, res, master, input, ctx) : [];
    ctx.timings.verify = (ctx.timings.verify || 0) + (now() - tv);
    const mods = fails.flatMap((f) => f.modules);
    if (!mods.length || attempt >= 2) break;
    const { params: P2, applied } = soften(P, mods, halved);
    if (!applied.length) break;
    rollbacks.push(...applied);
    P = P2;
    res = null; // release the superseded master before the next render
    await yieldToEventLoop();
  }
  ctx.progress('verify', 1);
  if (cache && P.qc.enabled) {
    if (!(cache.qcMemo instanceof Map)) cache.qcMemo = new Map();
    cache.qcMemo.delete(mKey);
    cache.qcMemo.set(mKey, { patch: JSON.stringify({ spectral: P.spectral, eq: P.eq, dynEq: P.dynEq, stereo: P.stereo }), rollbacks: [...rollbacks], halved: [...halved] });
    while (cache.qcMemo.size > QC_MEMO_MAX) cache.qcMemo.delete(cache.qcMemo.keys().next().value);
  }

  const ld = res.ld;
  const st = res.B.stats;
  const warnings = [...ld.warnings];
  const T = P.loudness.targetLufs;
  if (input.clippingRuns > 0) warnings.push({ id: 'warn.inputClipped', vars: {} });
  const info = opts.inputInfo || {};
  if (info.lossy && Number.isFinite(info.bitrateKbps) && info.bitrateKbps > 0) warnings.push({ id: 'warn.lossySource', vars: { kbps: Math.round(info.bitrateKbps) } });
  if (input.duration > 6 * 60) warnings.push({ id: 'warn.longTrack', vars: { min: Math.round(input.duration / 6) / 10 } });
  const iLoud = input.loudness;
  if (Number.isFinite(iLoud.integrated) && iLoud.truePeakDb - iLoud.integrated < 8 && iLoud.lra < 3) warnings.push({ id: 'warn.crushedInput', vars: {} });
  const bands = P.dynEq.bands;
  const repairs = (P.spectral.deShimmer.enabled ? 2 : 0) + (P.spectral.denoise.enabled ? 2 : 0) +
    DYN_EQ_BAND_IDS.filter((id) => bands[id].enabled && bands[id].maxCutDb > 0).length + (P.eq.tone.hashDb < 0 ? 1 : 0);
  if (T >= -8 && repairs >= 2) warnings.push({ id: 'warn.loudArtifacts', vars: {} });
  for (const m of new Set(rollbacks)) warnings.push({ id: 'warn.qcRollback', vars: { module: m } });

  // trim in the master's sample units (C2): master sample 0 = source time startSec
  const outRate = res.sampleRate;
  const ti = res.trimInfo || { startSample: 0, endSample: audio.channels[0].length, sampleRate: srcRate, trimmed: false };
  const k = outRate / ti.sampleRate;
  const startSample = Math.round(ti.startSample * k);
  const trim = {
    trimmed: !!ti.trimmed, startSample, sampleRate: outRate,
    startSec: startSample / outRate, endSample: startSample + res.channels[0].length,
    endSec: (startSample + res.channels[0].length) / outRate,
  };
  // what actually ran, for describeDecisions: applied curves, realised GR
  const mbOn = P.multiband.enabled ? st.multiband.filter((b, i) => P.multiband.bands[i] && P.multiband.bands[i].targetGrDb > 0) : [];
  let autoPk = 0;
  for (const v of st.eq.auto) if (Math.abs(v) > Math.abs(autoPk)) autoPk = v;
  P.meta = {
    ...(P.meta || {}),
    realised: {
      autoEqDb: Math.round(autoPk * 100) / 100,
      multibandGrDb: mbOn.length ? r3(mbOn.reduce((s2, b) => s2 + fin(b.grLoudAvgDb, 0), 0) / mbOn.length) : 0,
      glueGrDb: P.glue.enabled ? r3(fin(st.glue.grLoudAvgDb, 0)) : 0,
      trimmed: trim.trimmed,
      trimHead: ti.startSample > 0,
      trimTail: ti.endSample < audio.channels[0].length,
      targetLufs: Math.round(ld.effectiveTargetLufs * 10) / 10,
    },
  };

  const timingsMs = {};
  for (const [kk, v] of Object.entries(ctx.timings)) timingsMs[kk] = Math.round(v);
  timingsMs.total = Math.round(now() - t0);
  const report = {
    loudness: ld.loudness,
    inputLoudness: iLoud,
    limiter: { grAvgDb: r3(ld.limiter.grAvgDb), grMaxDb: r3(ld.limiter.grMaxDb), grP99Db: r3(-ld.grP99), runs: ld.limiter.runs, releaseMs: ld.limiter.releaseMs },
    clipper: { grMaxDb: r3(ld.clipper.grMaxDb), clippedPct: r3(ld.clipper.clippedPct), amountDb: r3(ld.clipper.amountDb), transientShare: r3(ld.clipper.transientShare), maxDepthDb: r3(P.loudness.clipper.maxDepthDb) },
    multiband: st.multiband,
    glue: st.glue,
    deEss: st.dynEq.deEss || { ...ZERO_GR },
    deHarsh: st.dynEq.harsh || { ...ZERO_GR },
    spectral: st.spectral || { avgReductionDb: 0, maxReductionDb: 0, deShimmer: null, denoise: null },
    dynEq: st.dynEq,
    targetLufs: T,
    effectiveTargetLufs: r3(ld.effectiveTargetLufs),
    ceilingDb: P.loudness.ceilingDb,
    targetReached: ld.targetReached,
    warnings,
    timingsMs,
    eqCurveDb: st.eq.curve.slice(),
    eqAutoDb: st.eq.auto.map((v) => Math.round(v * 100) / 100),
    ltas: master.ltas,
    correlation: r3(master.correlation),
    bandCorrelation: master.bandCorrelation,
    qc: {
      passed: fails.every((f) => f.intended),
      rollbacks: [...new Set(rollbacks)],
      failures: fails.map((f) => ({ check: f.check, value: r3(f.value), intended: !!f.intended })),
    },
    paramsUsed: P,
    sampleRate: res.sampleRate,
    gainDb: r3(ld.gainDb),
    loudnessPasses: ld.passes,
    trim,
  };
  return { audio: { sampleRate: res.sampleRate, channels: res.channels }, report };
}
