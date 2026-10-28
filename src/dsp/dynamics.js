// Dynamics processors: feed-forward compressor, level statistics / auto threshold, and a
// phase-coherent dynamic band cut (dynamic EQ, de-esser, side-channel HF control).
//
// Conventions (RESEARCH §7, research/05 §6–7):
// * Log-domain feed-forward topology (Giannoulis, Massberg & Reiss, JAES 60(6) 2012):
//   level (dB) → static soft-knee gain computer → branching attack/release smoothing of
//   the gain change in dB → linear gain. Smoothing in the gain domain gives a clean
//   envelope with no attack lag and lets the knee be arbitrarily wide.
// * Time constants are 63.2 % (1 − 1/e) times: a = exp(−1/(τ·fs)) (util.timeCoef).
// * Every gain change reported is in dB and <= 0 ("gain reduction" is negative).
// * Zero latency: lookahead is realised by computing the gain from the detector `La`
//   samples ahead (offline), never by delaying the audio.

import { timeCoef, clamp } from './util.js';
import { design, firstOrder, butterworth } from './biquad.js';

const LN10_20 = Math.LN10 / 20; // dB → natural-log amplitude
const DB_POW = 10 / Math.LN10; // ln(power) → dB
const SILENCE_DB = -240; // finite floor returned for empty statistics (util.powerToDb floor)
const GR_GATE_POW = 1e-6; // −60 dBFS: "non-silent" gate for average-GR statistics

// ------------------------------------------------------------------ static curve

/**
 * Static soft-knee gain computer (Giannoulis/Massberg/Reiss 2012; MathWorks `compressor`).
 * With d = level − threshold and knee width W:
 *   2d <= −W: 0 · |2d| < W: (1/R − 1)(d + W/2)²/(2W) · 2d >= W: (1/R − 1)·d.
 * The curve is C¹ and the knee is centred on the threshold.
 * @param {number} levelDb detector level in dB
 * @param {number} thresholdDb +Infinity disables compression
 * @param {number} ratio >= 1 (Infinity = limiter slope); <= 1 → no compression
 * @param {number} kneeDb knee width W in dB (0 = hard knee)
 * @returns {number} gain change in dB (<= 0, finite)
 */
export function gainComputerDb(levelDb, thresholdDb, ratio, kneeDb) {
  if (!(ratio > 1) || !(levelDb > -Infinity) || !(thresholdDb < Infinity)) return 0;
  if (Number.isNaN(levelDb) || Number.isNaN(thresholdDb)) return 0;
  const s = 1 / ratio - 1; // slope of the gain change above the knee (−1 for ∞:1)
  const W = kneeDb > 0 ? Math.min(kneeDb, 1e6) : 0;
  const d = Math.min(levelDb, 1e6) - Math.max(thresholdDb, -1e6);
  if (2 * d <= -W) return 0;
  if (2 * d >= W) return s * d;
  const t = d + W / 2;
  return (s * t * t) / (2 * W);
}

// ------------------------------------------------------------------ level statistics

function asChannels(x) {
  if (!x) return [];
  return ArrayBuffer.isView(x) ? [x] : Array.from(x);
}

/**
 * Sidechain high-pass: Butterworth sections of the given order (2 → one biquad, 4 → two:
 * 24 dB/oct keeps a 50–60 Hz kick ≈ 20 dB down at a 130 Hz corner, where a 2nd-order
 * filter leaves it only 6–9 dB down and the kick still drives the gain), or null.
 */
function scSections(hpHz, order, sampleRate) {
  if (!(hpHz > 0) || !(sampleRate > 0)) return null;
  const o = order === 4 || order === 6 || order === 8 ? order : 2;
  return butterworth('highpass', o, Math.min(hpHz, 0.45 * sampleRate), sampleRate);
}

/**
 * Mean square per consecutive window, stereo-linked as the max over channels (the same
 * link the compressor uses). Optional Butterworth high-pass on the way (to mirror a
 * compressor's sidechain filter, order 2 or 4). Last partial window uses its own length.
 * @returns {Float64Array}
 */
function windowPowers(chans, sampleRate, windowMs, hpHz, hpOrder = 2) {
  const n = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  const W = Math.max(1, Math.round((windowMs > 0 ? windowMs : 50) * 1e-3 * sampleRate));
  const nw = Math.ceil(n / W);
  const out = new Float64Array(nw);
  const secs = scSections(hpHz, hpOrder, sampleRate);
  const ns = secs ? secs.length : 0;
  const z1 = new Float64Array(ns), z2 = new Float64Array(ns);
  for (const x of chans) {
    z1.fill(0);
    z2.fill(0);
    for (let w = 0; w < nw; w++) {
      const start = w * W, end = Math.min(n, start + W);
      let acc = 0;
      if (ns) {
        for (let i = start; i < end; i++) {
          let v = x[i];
          for (let s = 0; s < ns; s++) {
            const c = secs[s];
            const y = c.b0 * v + z1[s];
            z1[s] = (c.b1 * v + z2[s]) - c.a1 * y;
            z2[s] = c.b2 * v - c.a2 * y;
            v = y;
          }
          acc += v * v;
        }
        for (let s = 0; s < ns; s++) {
          if (Math.abs(z1[s]) < 1e-30) z1[s] = 0;
          if (Math.abs(z2[s]) < 1e-30) z2[s] = 0;
        }
      } else {
        for (let i = start; i < end; i++) acc += x[i] * x[i];
      }
      const ms = acc / (end - start);
      if (ms > out[w]) out[w] = ms;
    }
  }
  return out;
}

/**
 * Gate level (dB) of a set of window powers: the absolute gate, or `relGateDb` below the
 * reference window — the loudest one (gateRefPct = 1) or the gateRefPct quantile of the
 * non-silent windows (e.g. 0.95: a robust "loud section" reference that a single hit
 * cannot move). → { gate, maxP } (gate = +Infinity when everything is silent).
 */
function gateLevelDb(powers, gateDb, relGateDb, gateRefPct = 1) {
  let maxP = 0;
  for (let i = 0; i < powers.length; i++) if (powers[i] > maxP) maxP = powers[i];
  if (!(maxP > 0)) return { gate: Infinity, maxP };
  let refP = maxP;
  if (gateRefPct < 1) {
    const nz = [];
    for (let i = 0; i < powers.length; i++) if (powers[i] > maxP * 1e-12) nz.push(powers[i]);
    const s = Float64Array.from(nz).sort();
    if (s.length) refP = s[Math.min(s.length - 1, Math.max(0, Math.round(clamp(gateRefPct, 0, 1) * (s.length - 1))))];
  }
  const refDb = DB_POW * Math.log(refP);
  const gate = Math.max(Number.isFinite(gateDb) ? gateDb : -60, refDb - Math.abs(Number.isFinite(relGateDb) ? relGateDb : -40));
  return { gate, maxP };
}

/** Gated window levels in dB (absolute gate, and relative to the reference window). */
function gatedLevelsDb(powers, gateDb, relGateDb, gateRefPct = 1) {
  const { gate } = gateLevelDb(powers, gateDb, relGateDb, gateRefPct);
  if (gate === Infinity) return new Float64Array(0);
  const tmp = [];
  for (let i = 0; i < powers.length; i++) {
    if (powers[i] > 0) {
      const d = DB_POW * Math.log(powers[i]);
      if (d >= gate) tmp.push(d);
    }
  }
  return Float64Array.from(tmp);
}

function percentileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return SILENCE_DB;
  const pos = clamp(q, 0, 1) * (n - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[n - 1];
}

/**
 * Distribution of windowed RMS levels (gated), e.g. to set thresholds and make-up gains.
 * Windows below the absolute gate, or more than |relGateDb| below the loudest window,
 * are ignored. `mean` is the power mean (energy average) of the gated windows, so it is
 * directly usable to restore a band's level after compression.
 * Extension: `signal` may also be an array of channels (linked = max of channel levels);
 * `count` = number of gated windows; `gateRefPct` < 1 measures relGateDb from that quantile
 * of the window levels instead of the loudest window. Silence → every level −240 dB
 * (finite), count 0.
 * @param {Float32Array|Float32Array[]} signal mono sidechain (or channels)
 * @param {number} sampleRate
 * @param {{ windowMs?: number, gateDb?: number, relGateDb?: number, gateRefPct?: number }} [opts]
 * @returns {{ p10: number, p50: number, p75: number, p90: number, p95: number, p99: number,
 *   max: number, mean: number, count: number }} dBFS
 */
export function levelStats(signal, sampleRate, opts = {}) {
  const { windowMs = 50 } = opts;
  return statsOfPowers(windowPowers(asChannels(signal), sampleRate, windowMs, 0), opts);
}

/** levelStats() of precomputed window powers (same gating). */
function statsOfPowers(powers, opts = {}) {
  const { gateDb = -60, relGateDb = -40, gateRefPct = 1 } = opts;
  const lv = gatedLevelsDb(powers, gateDb, relGateDb, gateRefPct);
  lv.sort();
  let pm = 0;
  for (let i = 0; i < lv.length; i++) pm += Math.exp(lv[i] / DB_POW);
  return {
    p10: percentileSorted(lv, 0.1),
    p50: percentileSorted(lv, 0.5),
    p75: percentileSorted(lv, 0.75),
    p90: percentileSorted(lv, 0.9),
    p95: percentileSorted(lv, 0.95),
    p99: percentileSorted(lv, 0.99),
    max: lv.length ? lv[lv.length - 1] : SILENCE_DB,
    mean: lv.length ? DB_POW * Math.log(pm / lv.length) : SILENCE_DB,
    count: lv.length,
  };
}

/**
 * Auto threshold: the thresholdDb at which the mean static gain reduction over the gated
 * windowed RMS levels equals targetGrDb (bisection; the mean GR is continuous and
 * monotonically decreasing in the threshold, so the solution is unique).
 * Extension: `opts.sidechainHpHz` / `sidechainHpOrder` apply the same high-pass that
 * compress({ sidechainHpHz, sidechainHpOrder }) uses, so the estimate matches that
 * compressor's detector; `sidechain` may be an array of channels (linked like the
 * compressor); `gateRefPct` (< 1) measures relGateDb from that quantile of the window
 * levels (e.g. 0.95 with relGateDb −8: the target is the mean GR of the LOUD sections, so
 * quieter verses do not pull the threshold down — the compressor then leaves them alone).
 * @param {Float32Array|Float32Array[]} sidechain
 * @param {number} sampleRate
 * @param {{ ratio: number, kneeDb?: number, targetGrDb: number, windowMs?: number,
 *   gateDb?: number, relGateDb?: number, gateRefPct?: number, sidechainHpHz?: number,
 *   sidechainHpOrder?: number }} opts
 * @returns {number} thresholdDb (+Infinity when targetGrDb <= 0, ratio <= 1 or silence)
 */
export function thresholdForTargetGr(sidechain, sampleRate, opts = {}) {
  const { ratio, kneeDb = 6, targetGrDb, windowMs = 50, gateDb = -60, relGateDb = -40, gateRefPct = 1, sidechainHpHz = 0, sidechainHpOrder = 2 } = opts;
  if (!(targetGrDb > 0) || !(ratio > 1)) return Infinity;
  const lv = gatedLevelsDb(windowPowers(asChannels(sidechain), sampleRate, windowMs, sidechainHpHz, sidechainHpOrder), gateDb, relGateDb, gateRefPct);
  return staticThreshold(lv, ratio, kneeDb > 0 ? kneeDb : 0, targetGrDb);
}

/** Mean static GR (dB, >= 0) of window levels lv at threshold T. */
function meanStaticGr(lv, T, ratio, W) {
  let s = 0;
  for (let i = 0; i < lv.length; i++) s -= gainComputerDb(lv[i], T, ratio, W);
  return lv.length ? s / lv.length : 0;
}

/** Bisection: threshold whose mean static GR over lv equals target (+Infinity if lv is empty). */
function staticThreshold(lv, ratio, W, target) {
  const n = lv.length;
  if (!n) return Infinity;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lv[i] < lo) lo = lv[i];
    if (lv[i] > hi) hi = lv[i];
  }
  const slope = 1 - 1 / ratio;
  // At lo' every window is above the knee with GR >= target; at hi' nothing is compressed.
  lo = lo - W / 2 - target / slope - 1;
  hi = hi + W / 2 + 1;
  for (let it = 0; it < 200 && hi - lo > 1e-9; it++) {
    const mid = 0.5 * (lo + hi);
    if (meanStaticGr(lv, mid, ratio, W) > target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Ballistics-aware auto threshold (research/05 §6): the static estimate above
 * ignores attack / release smoothing — with release slower than attack the smoothed GR
 * rides near its peaks, so the realised average overshoots the target by 1.3–1.8×. Here
 * the static threshold is only the starting point: the compressor's own detector
 * envelope is computed once (control rate, compressorEnvelope) and its gain smoothing is
 * simulated (no audio pass); the threshold is then corrected (Newton step on the static
 * slope, then secant on the realised points, ≤ 5 simulations) until the REALISED mean GR
 * of the gated windows' level range — control points whose detector level is above the
 * same gate (statsGateDb) — is within 0.03 dB of targetGrDb.
 * Pass the returned `envelope` and `statsGateDb` to compress() with the same ballistics:
 * it then skips its own detector pass and reports grLoudAvgDb = the calibrated value.
 * @param {Float32Array|Float32Array[]} channels the compressor input (or its sidechain)
 * @param {number} sampleRate
 * @param {{ ratio: number, kneeDb?: number, targetGrDb: number, attackMs?: number,
 *   releaseMs?: number, autoRelease?: boolean, detector?: 'rms'|'peak', rmsMs?: number,
 *   lookaheadMs?: number, sidechainHpHz?: number, sidechainHpOrder?: number,
 *   windowMs?: number, gateDb?: number, relGateDb?: number, gateRefPct?: number }} opts
 * @returns {{ thresholdDb: number, staticThresholdDb: number, statsGateDb: number,
 *   envelope: object|null, grLoudAvgDb: number, simulations: number, inputStats: object|null }}
 *   grLoudAvgDb = predicted realised GR (<= 0); thresholdDb +Infinity when nothing to do;
 *   inputStats = levelStats() of the input itself (same pass; null with an external sidechain)
 */
export function calibrateThreshold(channels, sampleRate, opts = {}) {
  const {
    ratio, kneeDb = 6, targetGrDb, windowMs = 50, gateDb = -60, relGateDb = -40, gateRefPct = 1,
    sidechainHpHz = 0, sidechainHpOrder = 2,
  } = opts;
  const none = { thresholdDb: Infinity, staticThresholdDb: Infinity, statsGateDb: -60, envelope: null, grLoudAvgDb: 0, simulations: 0, inputStats: null };
  if (!(targetGrDb > 0) || !(ratio > 1) || !(sampleRate > 0)) return none;
  const chans = asChannels(channels);
  // one detector pass gives the control envelope AND the 50 ms window powers of the
  // (high-passed) sidechain for the static estimate, plus those of the unfiltered input
  const env = compressorEnvelope(chans, sampleRate, { ...opts, windowMs });
  const powers = env.winPowers;
  const inputStats = env.rawPowers ? statsOfPowers(env.rawPowers) : null;
  env.winPowers = env.rawPowers = null;
  const { gate } = gateLevelDb(powers, gateDb, relGateDb, gateRefPct);
  if (gate === Infinity) return { ...none, inputStats };
  const lv = gatedLevelsDb(powers, gateDb, relGateDb, gateRefPct);
  const W = kneeDb > 0 ? kneeDb : 0;
  const T0 = staticThreshold(lv, ratio, W, targetGrDb);
  if (!Number.isFinite(T0)) return { ...none, inputStats };
  const traj = { ratio, kneeDb: W, attackMs: opts.attackMs, releaseMs: opts.releaseMs, autoRelease: !!opts.autoRelease, statsGateDb: gate };
  let sims = 0;
  const realised = (T) => {
    sims++;
    return -gainTrajectory(env, { ...traj, thresholdDb: T }, false).grLoudAvgDb;
  };
  const target = targetGrDb;
  let T = T0, g = realised(T0);
  let Tp = NaN, gp = NaN;
  for (let it = 0; it < 4 && Math.abs(g - target) > 0.03; it++) {
    let step;
    if (Number.isFinite(Tp) && Math.abs(g - gp) > 1e-4) step = ((g - target) * (T - Tp)) / (gp - g); // secant
    else {
      // static slope dGR/dT (< 0) around T, floored so a flat region cannot explode the step
      const d = (meanStaticGr(lv, T - 0.25, ratio, W) - meanStaticGr(lv, T + 0.25, ratio, W)) / 0.5;
      step = (g - target) / Math.max(d, 0.05 * (1 - 1 / ratio));
    }
    step = clamp(step, -12, 12);
    Tp = T;
    gp = g;
    T += step;
    g = realised(T);
  }
  return { thresholdDb: T, staticThresholdDb: T0, statsGateDb: gate, envelope: env, grLoudAvgDb: -g, simulations: sims, inputStats };
}

// ------------------------------------------------------------------ compressor

const DET_BLOCK = 1024;

/**
 * Linked detector level for samples n0 … n0+len−1 (zero input beyond detLen): per channel
 * optional high-pass cascade, then mean square (one-pole, coefficient aMs) or |x|;
 * out[j] = max over channels (power for RMS, amplitude for peak).
 */
function detectBlock(det, detLen, n0, len, st, out) {
  const nd = det.length;
  const { secs, isPeak, aMs, win } = st;
  const ns = secs ? secs.length : 0;
  const bMs = 1 - aMs;
  for (let j = 0; j < len; j++) out[j] = 0;
  for (let c = 0; c < nd; c++) {
    const x = det[c];
    const z1 = st.z1[c], z2 = st.z2[c];
    let ms = st.ms[c];
    // optional window energies (raw and filtered) for calibrateThreshold, real samples only
    const wr = win ? win.raw[c] : null, wf = win ? win.filt[c] : null;
    const Wn = win ? win.W : 1;
    let wi = win ? Math.floor(n0 / Wn) : 0, wEnd = (wi + 1) * Wn, ar = 0, af = 0;
    for (let j = 0; j < len; j++) {
      const n = n0 + j;
      const x0 = n < detLen ? x[n] : 0;
      let v = x0;
      for (let s = 0; s < ns; s++) {
        const q = secs[s];
        const y = q.b0 * v + z1[s];
        z1[s] = (q.b1 * v + z2[s]) - q.a1 * y;
        z2[s] = q.b2 * v - q.a2 * y;
        v = y;
      }
      if (wr && n < detLen) {
        if (n >= wEnd) {
          wr[wi] += ar;
          wf[wi] += af;
          ar = af = 0;
          wi++;
          wEnd += Wn;
        }
        ar += x0 * x0;
        af += v * v;
      }
      let l;
      if (isPeak) l = v < 0 ? -v : v;
      else {
        ms = aMs * ms + bMs * v * v;
        l = ms;
      }
      if (l > out[j]) out[j] = l;
    }
    if (wr && (ar > 0 || af > 0)) {
      wr[wi] += ar;
      wf[wi] += af;
    }
    for (let s = 0; s < ns; s++) {
      if (Math.abs(z1[s]) < 1e-30) z1[s] = 0;
      if (Math.abs(z2[s]) < 1e-30) z2[s] = 0;
    }
    if (ms < 1e-30) ms = 0;
    st.ms[c] = ms;
  }
}

/** Linked mean square per window (max over channels) from per-channel window energies. */
function linkedWindowPowers(perCh, N, W) {
  const nw = Math.ceil(N / W);
  const out = new Float64Array(nw);
  for (const e of perCh) {
    for (let w = 0; w < nw; w++) {
      const ms = e[w] / (Math.min(N, (w + 1) * W) - w * W);
      if (ms > out[w]) out[w] = ms;
    }
  }
  return out;
}

/** Control decimation D (>= 24 control points per attack and RMS time constant). */
function controlPeriod(sampleRate, attackMs, rmsMs, isPeak) {
  const tauMin = Math.min(attackMs > 0 ? attackMs : 0, isPeak ? Infinity : rmsMs > 0 ? rmsMs : 0) * 1e-3 * sampleRate;
  return clamp(Math.floor(tauMin / 24), 1, isPeak ? 4 : 8);
}

const fin = (v, d) => (Number.isFinite(v) ? v : d);

/** Everything the detector envelope depends on (an envelope is reused only on a match). */
function envelopeKey(N, sampleRate, o) {
  const isPeak = o.detector === 'peak';
  return [N, sampleRate, isPeak ? 'peak' : 'rms', isPeak ? 0 : fin(o.rmsMs, 10), fin(o.attackMs, 10), fin(o.lookaheadMs, 0),
    fin(o.sidechainHpHz, 0), o.sidechainHpOrder === 4 || o.sidechainHpOrder === 6 || o.sidechainHpOrder === 8 ? o.sidechainHpOrder : 2].join('|');
}


/**
 * Detector envelope of the compressor at its control rate (the expensive per-sample part
 * of compress(), computed once so that calibrateThreshold can simulate the gain smoothing
 * for several thresholds and compress() can then reuse it).
 * Control point k sits at sample n_k = kD + D − 1 (0 <= n_k < N + La, the detector input
 * being zero beyond its end). RMS: the linked one-pole mean square at n_k. Peak: the linked
 * max |x| over the whole control period (n_k − D, n_k] — carried across detector blocks,
 * so no sample is ever skipped whatever D.
 * @returns {{ lv: Float64Array, D: number, K: number, La: number, N: number, isPeak: boolean,
 *   sampleRate: number, key: string }}
 */
function compressorEnvelope(channels, sampleRate, opts = {}) {
  const chans = asChannels(channels);
  const N = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  const { detector = 'rms', rmsMs = 10, attackMs = 10, lookaheadMs = 0, sidechain = null, sidechainHpHz = 0, sidechainHpOrder = 2 } = opts;
  const isPeak = detector === 'peak';
  const det = sidechain ? asChannels(sidechain) : chans;
  const nd = det.length;
  const detLen = nd ? Math.min(...det.map((d) => d.length)) : 0;
  const secs = scSections(sidechainHpHz, sidechainHpOrder, sampleRate);
  const ns = secs ? secs.length : 0;
  const st = {
    secs, isPeak, aMs: isPeak ? 0 : timeCoef(rmsMs, sampleRate),
    z1: Array.from({ length: nd }, () => new Float64Array(ns)), z2: Array.from({ length: nd }, () => new Float64Array(ns)),
    ms: new Float64Array(nd), win: null,
  };
  if (opts.windowMs > 0 && detLen > 0) {
    // calibrateThreshold: 50 ms window energies of the same pass (see windowPowers)
    const W = Math.max(1, Math.round(opts.windowMs * 1e-3 * sampleRate));
    const nw = Math.ceil(detLen / W);
    st.win = { W, raw: Array.from({ length: nd }, () => new Float64Array(nw)), filt: Array.from({ length: nd }, () => new Float64Array(nw)) };
  }
  const D = controlPeriod(sampleRate, attackMs, rmsMs, isPeak);
  const La = Math.max(0, Math.round((lookaheadMs > 0 ? lookaheadMs : 0) * 1e-3 * sampleRate));
  const total = N + La;
  const K = Math.floor(total / D);
  const lv = new Float64Array(K);
  const lvl = new Float64Array(DET_BLOCK);
  let pend = 0; // peak: running max of the current (partial) control period
  for (let n0 = 0; n0 < total; n0 += DET_BLOCK) {
    const len = Math.min(DET_BLOCK, total - n0);
    detectBlock(det, detLen, n0, len, st, lvl);
    if (isPeak) {
      for (let j = 0; j < len; j++) {
        const v = lvl[j];
        if (v > pend) pend = v;
        const n = n0 + j;
        if ((n + 1) % D === 0) {
          const k = (n + 1) / D - 1;
          if (k < K) lv[k] = pend;
          pend = 0;
        }
      }
    } else {
      for (let j = (D - 1 - (n0 % D) + D) % D; j < len; j += D) {
        const k = (n0 + j + 1) / D - 1;
        if (k < K) lv[k] = lvl[j];
      }
    }
  }
  const env = { lv, D, K, La, N, isPeak, sampleRate, key: envelopeKey(N, sampleRate, opts) };
  if (st.win) {
    env.winPowers = linkedWindowPowers(st.win.filt, detLen, st.win.W);
    env.rawPowers = sidechain ? null : linkedWindowPowers(st.win.raw, detLen, st.win.W);
  }
  return env;
}

/**
 * Gain computer + branching smoothing over a control envelope. Returns the statistics of
 * compress() and, when `keep`, the smoothed gain change (dB) per control point.
 * Statistics: grAvgDb over control points whose level is above −60 dBFS (non-silent),
 * grLoudAvgDb over those above statsGateDb (dBFS; the loud-section gate of
 * calibrateThreshold), grMaxDb the deepest — counted from n_k >= La (aligned time).
 */
function gainTrajectory(env, o, keep) {
  const { lv, D, K, La, isPeak } = env;
  const ratio = o.ratio, W = o.kneeDb > 0 ? o.kneeDb : 0;
  const ctlRate = env.sampleRate / D;
  const attackMs = fin(o.attackMs, 10), releaseMs = fin(o.releaseMs, 100);
  const aA = timeCoef(attackMs, ctlRate);
  const fastMs = o.autoRelease ? clamp(0.5 * releaseMs, 40, 100) : releaseMs;
  const aR = timeCoef(fastMs, ctlRate);
  const aS = o.autoRelease ? timeCoef(clamp(5 * releaseMs, 500, 2000), ctlRate) : 0;
  const T = Math.max(o.thresholdDb, -1e6);
  const slope = 1 / ratio - 1;
  // Level below which the gain computer is exactly 0 (skip the log there).
  const kneeLoDb = T - W / 2;
  const toLin = (db) => (isPeak ? Math.exp(db * LN10_20) : Math.exp(db / DB_POW));
  const kneeLo = toLin(kneeLoDb);
  const levelScale = isPeak ? 2 * DB_POW : DB_POW; // ln(level) → dB
  const gateLevel = isPeak ? Math.sqrt(GR_GATE_POW) : GR_GATE_POW;
  const loudLevel = Number.isFinite(o.statsGateDb) ? toLin(o.statsGateDb) : gateLevel;
  const gs = keep ? new Float32Array(K) : null;
  let gsFast = 0, gsSlow = 0;
  let sumGr = 0, cntGr = 0, sumLoud = 0, cntLoud = 0, minGr = 0;
  const kLa = Math.max(0, Math.ceil((La - D + 1) / D)); // first k with n_k >= La
  for (let k = 0; k < K; k++) {
    const l = lv[k];
    let gc = 0;
    if (l > kneeLo) {
      const d = levelScale * Math.log(l) - T;
      if (2 * d >= W) gc = slope * d;
      else {
        const t = d + W / 2;
        gc = (slope * t * t) / (2 * W);
      }
    }
    gsFast = gc < gsFast ? aA * gsFast + (1 - aA) * gc : aR * gsFast + (1 - aR) * gc;
    if (gsFast > -1e-9 && gc === 0) gsFast = 0; // settle exactly (identity after release)
    let g = gsFast;
    if (o.autoRelease) {
      gsSlow = aS * gsSlow + (1 - aS) * gsFast;
      if (gsSlow > -1e-9 && gsFast === 0) gsSlow = 0;
      if (gsSlow < g) g = gsSlow;
    }
    if (k >= kLa) {
      if (g < minGr) minGr = g;
      if (l > gateLevel) {
        sumGr += g;
        cntGr++;
      }
      if (l > loudLevel) {
        sumLoud += g;
        cntLoud++;
      }
    }
    if (gs) gs[k] = g;
  }
  return { gs, grAvgDb: cntGr ? sumGr / cntGr : 0, grLoudAvgDb: cntLoud ? sumLoud / cntLoud : 0, grMaxDb: minGr };
}

/**
 * Stereo-linked feed-forward compressor, in place.
 *
 * Detector: per-channel RMS (one-pole mean square, τ = rmsMs) or instantaneous peak,
 * linked as the max of the channel levels (one gain for all channels → no image shift).
 * The detector runs on `sidechain` when given, optionally high-passed (Butterworth of
 * sidechainHpOrder 2 or 4, reduces bass-driven pumping). Gain computer: gainComputerDb.
 * Smoothing: branching one-pole in the dB domain (attack when the reduction deepens).
 * autoRelease (program dependence, RESEARCH §7 / research/05 §6.5): a fast branch
 * (release clamp(releaseMs/2, 40, 100) ms) and a slow branch (one-pole on the fast one,
 * τ = clamp(5·releaseMs, 500, 2000) ms); applied GR = max of both, so isolated transients
 * recover fast and sustained compression recovers slowly (no pumping).
 * lookaheadMs: the gain is computed from the detector that many ms ahead (aligned, zero
 * latency: the attack starts before the transient). mix: parallel blend with the dry
 * signal (make-up applies to the wet path only).
 * Efficiency: the gain computer and smoothing run at a control rate (at least 24 points
 * per attack/RMS time constant, at most sr/8 for RMS, sr/4 for peak) and the linear gain is
 * interpolated per sample. The RMS level is smooth (τ = rmsMs) and is sampled; the peak
 * level of a control period is its max |x| (conservative, never misses a peak).
 * Extensions: `envelope` = calibrateThreshold().envelope (skips the detector pass when it
 * matches these options); `statsGateDb` adds grLoudAvgDb (mean GR where the detector is
 * above that level — the loud sections).
 * @param {Float32Array[]} channels processed in place
 * @param {number} sampleRate
 * @param {{ thresholdDb: number, ratio: number, kneeDb?: number, attackMs?: number,
 *   releaseMs?: number, makeupDb?: number, detector?: 'rms'|'peak', rmsMs?: number,
 *   autoRelease?: boolean, sidechain?: Float32Array|Float32Array[], sidechainHpHz?: number,
 *   sidechainHpOrder?: number, lookaheadMs?: number, mix?: number, envelope?: object,
 *   statsGateDb?: number }} opts
 * @returns {{ grAvgDb: number, grMaxDb: number, grLoudAvgDb: number }} average over
 *   non-silent samples (detector above −60 dBFS) and deepest gain change, all <= 0
 */
export function compress(channels, sampleRate, opts = {}) {
  const chans = asChannels(channels);
  const N = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  const {
    thresholdDb = Infinity, ratio = 1, kneeDb = 6, attackMs = 10, releaseMs = 100, makeupDb = 0,
    autoRelease = false, mix = 1,
  } = opts;
  const wet = clamp(Number.isFinite(mix) ? mix : 1, 0, 1);
  const makeup = Number.isFinite(makeupDb) ? Math.exp(makeupDb * LN10_20) : 1;
  const active = N > 0 && sampleRate > 0 && ratio > 1 && thresholdDb < Infinity && !Number.isNaN(thresholdDb) && wet > 0;
  if (!active) {
    // Only static make-up/mix to apply (exact identity for makeup 0 or mix 0).
    const g = wet * makeup + (1 - wet);
    if (g !== 1) for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    return { grAvgDb: 0, grMaxDb: 0, grLoudAvgDb: 0 };
  }
  const given = opts.envelope;
  const env = given && given.key === envelopeKey(N, sampleRate, opts) ? given : compressorEnvelope(chans, sampleRate, opts);
  const { D, K, La } = env;
  const tr = gainTrajectory(env, {
    sampleRate, thresholdDb, ratio, kneeDb, attackMs, releaseMs, autoRelease, statsGateDb: opts.statsGateDb,
  }, true);
  const gsAll = tr.gs;
  const wetGain = wet * makeup, dry = 1 - wet;
  // linear gain at control times: (tPrev, gPrev) → (tCur, gCur); virtual start at t = −1
  let tPrev = -1, gPrev = wetGain + dry, mNext = 0;
  const nc = chans.length;
  const two = nc === 2;
  const A = chans[0], B = two ? chans[1] : null;
  for (let k = 0; k < K; k++) {
    const n = k * D + D - 1;
    const gs = gsAll[k];
    const gCur = gs === 0 ? wetGain + dry : wetGain * Math.exp(gs * LN10_20) + dry;
    // apply to every sample m whose gain time m + La lies in (tPrev, n]
    const mEnd = Math.min(N, n - La + 1);
    if (mNext < mEnd) {
      if (gCur === 1 && gPrev === 1) mNext = mEnd;
      else {
        const inv = 1 / (n - tPrev);
        for (let m = mNext; m < mEnd; m++) {
          const g = gPrev + (gCur - gPrev) * ((m + La - tPrev) * inv);
          if (two) {
            A[m] *= g;
            B[m] *= g;
          } else for (let c = 0; c < nc; c++) chans[c][m] *= g;
        }
        mNext = mEnd;
      }
    }
    tPrev = n;
    gPrev = gCur;
  }
  // tail (only when total is not a multiple of D): hold the last control gain
  if (mNext < N && gPrev !== 1) {
    for (let m = mNext; m < N; m++) for (let c = 0; c < nc; c++) chans[c][m] *= gPrev;
  }
  return { grAvgDb: tr.grAvgDb, grMaxDb: tr.grMaxDb, grLoudAvgDb: tr.grLoudAvgDb };
}

// ------------------------------------------------------------------ dynamic band cut

/** Detector band filter (the same filter the cut subtracts). */
function bandSection(type, freq, q, sampleRate) {
  return type === 'shelf'
    ? firstOrder('highpass', freq, sampleRate)
    : design('bandpass', freq, sampleRate, { q: q > 0 ? q : 1 });
}

/**
 * One pass over the sidechain of a channel mode ('stereo'/'mid' → (L+R)/2, 'side' →
 * (L−R)/2; mono input is treated as L = R, so its side is silent): windowed band and
 * broadband energies (for the median / statistics) and, when `env` is given, one-pole
 * power envelopes of band and broadband decimated to the control rate (every D samples,
 * at sample kD + D − 1).
 * @returns {{ eb: Float64Array, ew: Float64Array }}
 */
function scanBand(chans, N, mode, sec, Wn, env) {
  const L = chans[0], R = chans.length >= 2 ? chans[1] : chans[0];
  const sgn = mode === 'side' ? -1 : 1;
  const nw = Math.ceil(N / Wn);
  const eb = new Float64Array(nw), ew = new Float64Array(nw);
  const { b0, b1, b2, a1, a2 } = sec;
  let s1 = 0, s2 = 0;
  const ae = env ? env.ae : 0, be = 1 - ae, D = env ? env.D : 1;
  const ctlB = env ? env.ctlB : null, ctlW = env ? env.ctlW : null;
  let envB = 0, envW = 0, cnt = 0, k = 0;
  for (let w = 0; w < nw; w++) {
    const start = w * Wn, end = Math.min(N, start + Wn);
    let ab = 0, aw = 0;
    if (env) {
      for (let n = start; n < end; n++) {
        const v = 0.5 * (L[n] + sgn * R[n]);
        const y = b0 * v + s1;
        s1 = (b1 * v + s2) - a1 * y;
        s2 = b2 * v - a2 * y;
        const yy = y * y, vv = v * v;
        ab += yy;
        aw += vv;
        envB = ae * envB + be * yy;
        envW = ae * envW + be * vv;
        if (++cnt === D) {
          ctlB[k] = envB;
          ctlW[k] = envW;
          k++;
          cnt = 0;
        }
      }
      if (envB < 1e-30) envB = 0;
      if (envW < 1e-30) envW = 0;
    } else {
      for (let n = start; n < end; n++) {
        const v = 0.5 * (L[n] + sgn * R[n]);
        const y = b0 * v + s1;
        s1 = (b1 * v + s2) - a1 * y;
        s2 = b2 * v - a2 * y;
        ab += y * y;
        aw += v * v;
      }
    }
    if (Math.abs(s1) < 1e-30) s1 = 0;
    if (Math.abs(s2) < 1e-30) s2 = 0;
    eb[w] = ab / (end - start);
    ew[w] = aw / (end - start);
  }
  if (env && cnt > 0) {
    // trailing partial control period
    ctlB[k] = envB;
    ctlW[k] = envW;
  }
  return { eb, ew };
}

/**
 * Relative band levels (band − broadband, dB) of the gated windows, sorted ascending.
 * Gate: window broadband RMS >= −60 dBFS and within 40 dB of the loudest window.
 */
function relativeLevels(eb, ew) {
  let maxW = 0;
  for (let i = 0; i < ew.length; i++) if (ew[i] > maxW) maxW = ew[i];
  const gate = Math.max(GR_GATE_POW, maxW * 1e-4);
  const out = [];
  if (maxW > 0) {
    for (let i = 0; i < ew.length; i++) {
      if (ew[i] >= gate) out.push(DB_POW * Math.log((eb[i] + 1e-30) / ew[i]));
    }
  }
  const a = Float64Array.from(out);
  a.sort();
  return { rel: a, maxW };
}

/**
 * Distribution of the relative band level (band − broadband, dB) over active windows of
 * the channel selected by `channel` ('stereo' → mid, 'mid', 'side'), using exactly the
 * detector filter of dynamicBandCut. Active = window RMS >= −60 dBFS and within 40 dB of
 * the loudest window. Its p50 + thresholdRelDb equals dynamicBandCut's thresholdDb.
 * No active window → all 0 (count 0).
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ freq: number, q?: number, type?: 'band'|'shelf', channel?: 'stereo'|'mid'|'side',
 *   windowMs?: number }} opts
 * @returns {{ p50: number, p75: number, p90: number, p95: number, count: number }}
 */
export function relativeBandStats(channels, sampleRate, { freq, q = 1, type = 'band', channel = 'stereo', windowMs = 20 } = {}) {
  const chans = asChannels(channels);
  const N = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  if (!N || !(sampleRate > 0)) return { p50: 0, p75: 0, p90: 0, p95: 0, count: 0 };
  const sec = bandSection(type, freq, q, sampleRate);
  const mode = channel === 'mid' || channel === 'side' ? channel : 'stereo';
  const Wn = Math.max(1, Math.round((windowMs > 0 ? windowMs : 20) * 1e-3 * sampleRate));
  const { eb, ew } = scanBand(chans, N, mode, sec, Wn, null);
  const { rel } = relativeLevels(eb, ew);
  if (!rel.length) return { p50: 0, p75: 0, p90: 0, p95: 0, count: 0 };
  return {
    p50: percentileSorted(rel, 0.5),
    p75: percentileSorted(rel, 0.75),
    p90: percentileSorted(rel, 0.9),
    p95: percentileSorted(rel, 0.95),
    count: rel.length,
  };
}

/**
 * Phase-coherent dynamic cut, in place.
 *   'band':  y = x − (1 − g)·BP0(x)  (BP0 = RBJ constant-0 dB-peak band-pass at freq/q, so
 *            g = 1 is an exact identity and g < 1 is a peaking dip of exactly 20·log10(g)
 *            dB at freq, research/05 §7).
 *   'shelf': y = x − (1 − g)·HP1(x) = LP1(x) + g·HP1(x) (bilinear 1st order, LP1 + HP1 = 1:
 *            perfect-reconstruction dynamic high shelf, exactly g at Nyquist).
 * channel 'stereo' cuts L and R with one linked gain (detector on the mid signal); 'mid' /
 * 'side' cut only that M/S component (the other component is untouched bit-exactly:
 * L −= c, R ∓= c).
 * Detection is RELATIVE: d = env(band(sc)) − env(sc) in dB (one-pole power envelopes,
 * τ = clamp(max(attackMs/2, 2000/freq ms), 1, 30) ms), so a loud passage with a normal
 * balance is untouched. threshold = median over active 20 ms windows of the relative
 * band level (= relativeBandStats().p50) + thresholdRelDb. The cut starts AT the
 * threshold: g = gainComputerDb(d, threshold + kneeDb/2, ratio, kneeDb) limited to
 * −maxCutDb (the soft knee lies entirely above the threshold, so a detector that never
 * exceeds the threshold gives an exact identity). Gain smoothing: branching attack/
 * release in dB at a ≈ 6 kHz control rate, linearly interpolated per sample; quiet
 * passages (< −60 dBFS or > 40 dB below the loudest window) are never cut.
 * lookaheadMs: the gain leads the audio (aligned, zero latency).
 * @param {Float32Array[]} channels [L, R] (mono accepted: 'stereo'/'mid' cut it, 'side' is a no-op)
 * @param {number} sampleRate
 * @param {{ type?: 'band'|'shelf', channel?: 'stereo'|'mid'|'side', freq: number, q?: number,
 *   thresholdRelDb?: number, ratio?: number, maxCutDb: number, attackMs?: number,
 *   releaseMs?: number, kneeDb?: number, lookaheadMs?: number }} opts
 * @returns {{ grAvgDb: number, grMaxDb: number, activePct: number, thresholdDb: number }}
 *   grAvg over non-silent time; activePct = % of non-silent time cut by more than 0.1 dB;
 *   thresholdDb = absolute relative-level threshold in dB (band − broadband).
 */
export function dynamicBandCut(channels, sampleRate, opts = {}) {
  const chans = asChannels(channels);
  const {
    type = 'band', channel = 'stereo', freq = 1000, q = 1, thresholdRelDb = 2, ratio = 2, maxCutDb = 0,
    attackMs = 10, releaseMs = 120, kneeDb = 3, lookaheadMs = 0,
  } = opts;
  const mode = channel === 'mid' || channel === 'side' ? channel : 'stereo';
  const N = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  const maxCut = Number.isFinite(maxCutDb) ? Math.max(0, maxCutDb) : 0;
  const thrRel = Number.isFinite(thresholdRelDb) ? thresholdRelDb : 2;
  const result = { grAvgDb: 0, grMaxDb: 0, activePct: 0, thresholdDb: thrRel };
  if (!N || !(sampleRate > 0)) return result;
  const sec = bandSection(type, freq, q, sampleRate);

  // ---- pass 1: windowed energies (median) + control-rate envelopes, one sweep
  const D = Math.max(1, Math.round(sampleRate / 6000));
  const K = Math.ceil(N / D);
  const fHz = clamp(Number.isFinite(freq) ? freq : 1000, 1, 0.49 * sampleRate);
  const envMs = clamp(Math.max(0.5 * (attackMs > 0 ? attackMs : 0), 2000 / fHz), 1, 30);
  const env = { ae: timeCoef(envMs, sampleRate), D, ctlB: new Float64Array(K), ctlW: new Float64Array(K) };
  const Wn = Math.max(1, Math.round(0.02 * sampleRate));
  const { eb: web, ew: wew } = scanBand(chans, N, mode, sec, Wn, env);
  const { rel, maxW } = relativeLevels(web, wew);
  const median = rel.length ? percentileSorted(rel, 0.5) : 0;
  const thr = median + thrRel;
  result.thresholdDb = thr;
  if (!(maxCut > 0) || !rel.length || !(ratio > 1)) return result;
  const gatePow = Math.max(GR_GATE_POW, maxW * 1e-4);
  const { ctlB, ctlW } = env;

  // ---- pass 2: gain computer + smoothing at the control rate → linear gains
  const ctlRate = sampleRate / D;
  const aA = timeCoef(attackMs, ctlRate);
  const aR = timeCoef(releaseMs, ctlRate);
  const W = kneeDb > 0 ? kneeDb : 0;
  const Tk = thr + W / 2; // knee entirely above the threshold
  const slope = 1 / ratio - 1;
  // G[j] = linear gain at sample time jD − 1 (G[0] = 1: before the first control point)
  const G = new Float64Array(K + 1);
  G[0] = 1;
  let gs = 0, sumGr = 0, cntAct = 0, cntCut = 0, minGr = 0, anyCut = false;
  for (let k = 0; k < K; k++) {
    let gc = 0;
    const act = ctlW[k] >= gatePow;
    if (act) {
      const d = DB_POW * Math.log((ctlB[k] + 1e-30) / ctlW[k]) - Tk;
      if (2 * d > -W) {
        if (2 * d >= W) gc = slope * d;
        else {
          const t = d + W / 2;
          gc = (slope * t * t) / (2 * W);
        }
        if (gc < -maxCut) gc = -maxCut;
      }
    }
    gs = gc < gs ? aA * gs + (1 - aA) * gc : aR * gs + (1 - aR) * gc;
    if (gs > -1e-6 && gc === 0) gs = 0; // settle exactly → bit-exact passages between events
    if (gs < 0) anyCut = true;
    if (gs < minGr) minGr = gs;
    if (act) {
      cntAct++;
      sumGr += gs;
      if (gs < -0.1) cntCut++;
    }
    G[k + 1] = gs === 0 ? 1 : Math.exp(gs * LN10_20);
  }
  result.grAvgDb = cntAct ? sumGr / cntAct : 0;
  result.grMaxDb = minGr;
  result.activePct = cntAct ? (100 * cntCut) / cntAct : 0;
  if (!anyCut) return result; // exact identity

  // ---- pass 3: apply. Sample n takes the gain at time t = n + La, linearly interpolated
  // between G[j] (time jD − 1) and G[j+1] (time jD + D − 1).
  const La = Math.max(0, Math.round((lookaheadMs > 0 ? lookaheadMs : 0) * 1e-3 * sampleRate));
  const ap = { b0: sec.b0, b1: sec.b1, b2: sec.b2, a1: sec.a1, a2: sec.a2, G, K, D, La };
  if (chans.length < 2) {
    applyCut(chans[0], null, N, ap, 0);
  } else if (mode === 'stereo') {
    applyCut(chans[0], null, N, ap, 0);
    applyCut(chans[1], null, N, ap, 0);
    for (let c = 2; c < chans.length; c++) applyCut(chans[c], null, N, ap, 0);
  } else {
    // M/S: only the selected component changes; c = (1 − g)·BP(sc); L −= c, R ∓= c.
    applyCut(chans[0], chans[1], N, ap, mode === 'side' ? -1 : 1);
  }
  return result;
}

/**
 * y = x − (1 − g[n])·BP(sc[n]), streamed per control segment with an incremental linear
 * gain. ms = 0: x itself is the sidechain (stereo / mono). ms = ±1: sc = (L ± R)/2 and the
 * correction is subtracted from L and (±) from R, leaving the other M/S component exact.
 */
function applyCut(L, R, N, ap, ms) {
  const { b0, b1, b2, a1, a2, G, K, D, La } = ap;
  let s1 = 0, s2 = 0;
  const invD = 1 / D;
  // first sample whose time n + La reaches control segment j: n = jD − 1 − La
  for (let j = 0; ; j++) {
    const nStart = Math.max(0, j * D - 1 - La);
    const nEnd = Math.min(N, j < K ? (j + 1) * D - 1 - La : N);
    if (nStart >= N) break;
    if (nEnd <= nStart) continue;
    const gA = G[Math.min(j, K)], gB = G[Math.min(j + 1, K)];
    if (gA === 1 && gB === 1) {
      // unity: only keep the filter state running
      for (let n = nStart; n < nEnd; n++) {
        const v = ms === 0 ? L[n] : 0.5 * (L[n] + ms * R[n]);
        const y = b0 * v + s1;
        s1 = (b1 * v + s2) - a1 * y;
        s2 = b2 * v - a2 * y;
      }
    } else {
      const t0 = j * D - 1; // time of G[j]
      const dg = (gB - gA) * invD;
      let g = gA + dg * (nStart + La - t0);
      for (let n = nStart; n < nEnd; n++, g += dg) {
        const xl = L[n];
        const v = ms === 0 ? xl : 0.5 * (xl + ms * R[n]);
        const y = b0 * v + s1;
        s1 = (b1 * v + s2) - a1 * y;
        s2 = b2 * v - a2 * y;
        const c = (1 - g) * y;
        L[n] = xl - c;
        if (ms !== 0) R[n] -= ms * c;
      }
    }
    if (Math.abs(s1) < 1e-30) s1 = 0;
    if (Math.abs(s2) < 1e-30) s2 = 0;
    if (nEnd >= N) break;
  }
}
