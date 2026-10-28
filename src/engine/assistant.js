// Assistant: analysis + four simple choices → a full parameter set (ARCHITECTURE §5,
// RESEARCH §1–§4). Pure and environment-neutral; never touches output.sampleRate (the UI
// owns the export rate).
//
// Layers, in order (each later layer may refine an earlier one):
//   1. destination   target LUFS (lufsRange spanned by intensity), true-peak ceiling,
//                    dynamics scale (normalised platforms / Hi-Fi compress less)
//   2. intensity     INTENSITY_TABLE rows, linear interpolation in t
//   3. cleanup       k × detector-gated repair moves (RESEARCH §2 table): every module is
//                    off unless its detector fires; frequencies come from the detectors
//   4. style         STYLES deltas × t/0.5 with the RESEARCH §4 gates
//   5. auto-adjust   crushed input, low crest, input louder than target, near-mono,
//                    wide bass, rumble (RESEARCH §1 auto-adjust rules)
//   6. reference     match EQ when a reference LTAS is given
// describeDecisions() turns the applied parameters back into §10 i18n keys, chain order.

import {
  DESTINATIONS, STYLES, INTENSITY_TABLE, CLEANUP_LEVELS, defaultParams, defaultChoices, validateParams,
} from './params.js';
import { INDEX_GATES, brightenedAmount } from '../analysis/analyze.js';
import { autoEqCurve } from '../dsp/eq.js';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const fin = (v, d) => (Number.isFinite(v) ? v : d);
const r2 = (v) => Math.round(v * 100) / 100;

/** Linear interpolation of an INTENSITY_TABLE row at t (clamped to the table). */
export function intensityValue(row, t) {
  const ts = INTENSITY_TABLE.t;
  const ys = INTENSITY_TABLE[row];
  if (!ys) return 0;
  const x = clamp(fin(t, 0.5), ts[0], ts[ts.length - 1]);
  for (let i = 1; i < ts.length; i++) {
    if (x <= ts[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - ts[i - 1])) / (ts[i] - ts[i - 1]);
  }
  return ys[ys.length - 1];
}

/** Target loudness for a destination at intensity t (Loud/Club span lufsRange Low → High). */
export function targetLufsFor(destination, t) {
  const d = DESTINATIONS[destination] || DESTINATIONS.streaming;
  if (!d.lufsRange) return d.lufs;
  const u = clamp((fin(t, 0.5) - 0.25) / 0.5, 0, 1);
  return r2(d.lufsRange[0] + (d.lufsRange[1] - d.lufsRange[0]) * u);
}

/** Amount scaling with the detector excess: 0.5 at the gate → 1 at gate + 2 dB. */
const byExcess = (v, gate) => clamp(0.5 + 0.25 * (v - gate), 0.5, 1);

/** 'brightened' modifier 0..1 of an analysis (report.brightened; older reports: profile / index). */
function brightenedOf(a) {
  if (a.profile === 'brightened') return 1;
  if (Number.isFinite(a.brightened)) return clamp(a.brightened, 0, 1);
  return brightenedAmount(a.indices && a.indices.brightness);
}

/** Low band share of the multiband target (subs are not ducked note by note). */
const LOW_BAND_SHARE = 0.5;

/**
 * Full parameter set for a track.
 * @param {object} analysis AnalysisReport (analyze.js); missing fields → neutral defaults
 * @param {{ destination?: string, style?: string, intensity?: number,
 *   cleanup?: 'off'|'light'|'medium'|'strong',
 *   reference?: { ltas: number[], name?: string, loudness?: any, amount?: number } }} choices
 * @param {object} [opts] reserved
 * @returns {object} validated Params (params.js schema) plus `meta` { destination, style,
 *   cleanup, intensity, profile, brightened, styleTone } used by describeDecisions / the
 *   chain's QC (styleTone = the tone moves the chosen style made: the QC treats them as
 *   intended, not as damage). The assistant ignores meta.userOwned (the UI adds it).
 */
export function suggestParams(analysis, choices = {}, opts = {}) {
  void opts;
  const ch = { ...defaultChoices(), ...(choices || {}) };
  const a = analysis || {};
  const x = a.indices || {};
  const G = INDEX_GATES;
  const t = clamp(fin(ch.intensity, 0.5), 0, 1);
  const sc = t / 0.5; // style scale (RESEARCH §4)
  const destination = DESTINATIONS[ch.destination] ? ch.destination : 'streaming';
  const style = STYLES[ch.style] ? ch.style : 'balanced';
  const cleanup = CLEANUP_LEVELS[ch.cleanup] ? ch.cleanup : 'medium';
  const k = CLEANUP_LEVELS[cleanup].k;
  const sr = fin(a.sampleRate, 48000);
  const fc = fin(a.spectrum && a.spectrum.hfCutoffHz, sr / 2);
  const profile = a.profile && a.profile !== 'brightened' ? a.profile : (fc <= 13500 ? 'legacy' : fc <= 17500 ? 'midband' : 'fullband');
  const lo = a.loudness || {};
  const I = fin(lo.integrated, -Infinity);
  const stereoA = a.stereo || {};
  const bc0 = fin(stereoA.bandCorrelation && stereoA.bandCorrelation[0], 1);
  // 'brightened' (Suno "Remaster"-like 6–10 kHz excess) is a continuous modifier 0..1 on
  // top of the f_c profile: its emphases scale with it instead of switching at a gate
  const bri = brightenedOf(a);
  const p = defaultParams();
  const tone = p.eq.tone;
  const bands = p.dynEq.bands;

  // ---- 1. destination (RESEARCH §3)
  const d = DESTINATIONS[destination];
  p.loudness.targetLufs = targetLufsFor(destination, t);
  p.loudness.ceilingDb = d.ceilingDb;
  p.loudness.minTargetLufs = d.lufsRange ? Math.min(p.loudness.targetLufs, d.lufsRange[0]) : null;
  // Dynamics scale: normalised platforms turn every master to the same level, so
  // density only costs chorus lift there; Hi-Fi keeps the macro-dynamics. An input that is
  // already at / above the target needs no density at all (RESEARCH §1 "gain reduction
  // only"): halve again.
  const dynScale = fin(d.dynamics, 1) * (I >= p.loudness.targetLufs ? 0.5 : 1);

  // ---- 2. intensity (RESEARCH §1 table)
  p.eq.auto.strength = r2(intensityValue('autoEqStrength', t));
  p.eq.auto.maxDb = r2(intensityValue('autoEqMaxDb', t));
  const mbGr = Math.min(3, intensityValue('multibandTargetGrDb', t)) * dynScale;
  p.multiband.bands.forEach((b, i) => { b.targetGrDb = r2(i === 0 ? LOW_BAND_SHARE * mbGr : mbGr); });
  p.glue.ratio = r2(intensityValue('glueRatio', t));
  p.glue.targetGrDb = r2(Math.min(2, intensityValue('glueTargetGrDb', t)) * dynScale);
  let drive = intensityValue('saturationDrive', t);
  let clipDb = Math.min(2, intensityValue('clipperDb', t));
  p.loudness.clipper.maxDepthDb = r2(intensityValue('clipperMaxDepthDb', t));
  p.loudness.budgetDb = r2(intensityValue('limiterBudgetDb', t));
  p.loudness.maxGrDb = Math.max(9, p.loudness.budgetDb + 3);

  // ---- 3. cleanup: k × detector gates (RESEARCH §2)
  const prepHp = fin(x.rumble, -99) > G.rumble ? clamp(30 + 0.5 * (x.rumble - G.rumble), 30, 35) : 25;
  p.prepare.highpassHz = r2(prepHp); // DC blocker + high-pass run even with cleanup off
  const dyn = (id, o) => Object.assign(bands[id], { enabled: true }, o);
  // Air exciter start: the file's cut-off (or 10 kHz on full-band files), also when the
  // user switches the exciter on by hand or cleanup is off
  p.color.air.fromHz = Math.round(fc < 0.45 * sr ? Math.min(fc, 18000) : 10000);
  if (k > 0) {
    // Mud / boom: dynamic band + static floor at half the maximum, total capped (−4 / −3 dB)
    if (fin(x.mud, -99) > G.mud) {
      const cut = Math.min(4, 2.5 * k * byExcess(x.mud, G.mud));
      const floor = cut / 2;
      const hz = clamp(fin(x.mudHz, 300), 150, 800);
      dyn('mud', { freq: hz, q: 0.9, maxCutDb: r2(Math.min(cut, 4 - floor)) });
      tone.mudDb = r2(-floor);
      tone.mudHz = hz;
      tone.mudQ = 0.9;
    }
    if (fin(x.boom, -99) > G.boom) {
      const cut = Math.min(3, 2 * k * byExcess(x.boom, G.boom));
      const floor = cut / 2;
      const hz = clamp(fin(x.boomHz, 120), 90, 160);
      dyn('boom', { freq: hz, q: 1.4, maxCutDb: r2(Math.min(cut, 3 - floor)) });
      tone.boomDb = r2(-floor);
      tone.boomHz = hz;
      tone.boomQ = 1.4;
    }
    // Brightened (Suno "Remaster"-like): stronger harshness, fizz and de-ess cuts, × 1 → 1.4
    const emph = 1 + 0.4 * bri;
    let harshFloor = 0;
    if (fin(x.harsh, -99) > G.harsh && fc > 6500) {
      // research/02 §7.3 M3: static floor at half the maximum cut — a resonance that is
      // always there raises the dynamic band's median and is never cut dynamically. The
      // floor uses the tone "presence" bell (narrowed to Q 2 at the detected peak); the
      // "too harsh" button then deepens exactly this cut.
      const cut = Math.min(4, 2.5 * k * byExcess(x.harsh, G.harsh) * emph);
      const hz = clamp(fin(x.harshHz, 3500), 2000, 6000);
      harshFloor = cut / 2;
      dyn('harsh', { freq: hz, q: 2, maxCutDb: r2(Math.min(cut, 4 - harshFloor)) });
      tone.presenceDb = r2(-harshFloor);
      tone.presenceHz = hz;
      tone.presenceQ = 2;
    }
    const fizzIdx = fin(x.fizz, -99) > G.fizz;
    const fizzAmt = Math.max(fizzIdx ? byExcess(x.fizz, G.fizz) : 0, bri);
    const fizzCut = Math.min(3.5, 2.5 * k * fizzAmt * emph);
    if (fizzCut >= 0.3 && fc > 8500) {
      dyn('fizz', { freq: clamp(fin(x.fizzHz, 6000), 5000, 8000), q: 2, maxCutDb: r2(fizzCut) });
    }
    // de-ess depth follows how far the "s" events stand out (median excess 2 dB → half,
    // ≥ 8 dB → full): real Suno vocals sit at 2–4.5 dB and need a lighter touch
    const sibScale = (excess) => clamp(0.5 + (fin(excess, G.sibilanceExcessDb) - G.sibilanceExcessDb) / 12, 0.5, 1);
    if (fin(x.sibilanceEventsPerMin, 0) > G.sibilanceEventsPerMin && fc > 9500) {
      dyn('deEss', { maxCutDb: r2(Math.min(6, 4 * k * sibScale(x.sibilance) * (1 + 0.25 * bri))), thresholdRelDb: 7 });
    }
    // band B threshold 9 dB (A: 7): its detector has no external key and cannot tell
    // hats from the top octave of an "s", so only the strong excursions are cut
    if (fin(x.sibilanceAirEventsPerMin, 0) > G.sibilanceEventsPerMin && fc >= 16000) {
      dyn('deEssAir', { maxCutDb: r2(Math.min(4.5, 3 * k * sibScale(x.sibilanceAir))), thresholdRelDb: 9 });
    }
    // Side-channel HF control: wide HF + unstable HF envelope (full strength on midband)
    const smhf = fin(stereoA.sideToMidHfDb, -100);
    if (smhf > G.sideToMidHfDb && (fin(x.hfModulation, -99) > G.hfModulation || profile === 'midband')) {
      dyn('sideHf', { maxCutDb: r2(Math.min(4.5, 3 * k)) });
    }
    // 14 kHz hash shelf: only when the band is really there (f_c >= 17 kHz)
    if (fin(x.hash, -99) > G.hash && fc >= 17000 && profile !== 'legacy') tone.hashDb = r2(-Math.min(3, 1.5 * k));
    // Spectral cleanup, gated
    p.spectral.deShimmer.enabled = fin(x.shimmer, -99) > G.shimmer;
    p.spectral.deShimmer.amount = r2(clamp(0.5 * k, 0, 1));
    p.spectral.denoise.enabled = fin(x.hiss, -99) > G.hiss;
    p.spectral.denoise.amount = r2(CLEANUP_LEVELS[cleanup].denoiseMaxDb / 12);
    // Air exciter: band-limited or dull, clean HF (no hash / hiss), not (clearly) brightened
    const dull = fin(x.air, 0) < G.air;
    if ((fc < 16000 || dull) && !(fin(x.hiss, -99) > G.hiss) && !(fin(x.hash, -99) > G.hash) && bri < 0.5) {
      const gentle = (fc >= 16000 ? 0.6 : 1) * (1 - bri); // full-band but dull ("muffled"): gentle
      p.color.air.enabled = true;
      p.color.air.amount = r2(clamp(0.5 * k * gentle, 0, 1));
      // optional +1 dB × k shelf at 12 kHz, never into an empty band
      if (dull && fc >= 16000) {
        tone.airDb = r2(Math.min(2, 1 * k));
        tone.airHz = 12000;
      }
    }
  } else {
    p.spectral.deShimmer.enabled = false;
    p.spectral.denoise.enabled = false;
  }

  // ---- mono bass (cleanup level, band correlation; forced below 0.7 even when off)
  let mono = CLEANUP_LEVELS[cleanup].monoBassHz;
  if (k > 0) {
    if (bc0 < 0.5) mono = 150;
    else if (stereoA.nearMono) mono = 80;
  }
  if (bc0 < 0.7 && mono === 0) mono = bc0 < 0.5 ? 150 : 100;
  p.stereo.monoBassHz = mono;

  // ---- 4. style (RESEARCH §4), deltas × t/0.5. styleTone records what the style itself
  // added to the tone (the QC's "intended change" baseline).
  const st = STYLES[style];
  const styleTone = {};
  const slope = fin(x.slope1to10k, -3);
  const alreadyBright = bri > 0 || slope > -1.0; // calibrated cap [E]: −1 dB/oct band power
  let tilt = st.tiltDbPerOct * sc;
  if (tilt > 0 && alreadyBright) tilt = 0;
  tone.tiltDbPerOct = r2(tilt);
  if (tone.tiltDbPerOct) styleTone.tiltDbPerOct = tone.tiltDbPerOct;
  if (st.lowShelfDb) {
    tone.lowShelfDb = r2(st.lowShelfDb * sc);
    tone.lowShelfHz = st.lowShelfHz;
    Object.assign(styleTone, { lowShelfDb: tone.lowShelfDb, lowShelfHz: tone.lowShelfHz });
  }
  if (st.highShelfDb && !(st.highShelfDb > 0 && alreadyBright)) {
    // Bright: broad high shelf (opens the top, leaves the sub alone)
    tone.highShelfDb = r2(st.highShelfDb * sc);
    tone.highShelfHz = st.highShelfHz;
    Object.assign(styleTone, { highShelfDb: tone.highShelfDb, highShelfHz: tone.highShelfHz });
  }
  if (st.presenceDb) {
    // a presence boost only where no harshness was detected; when the presence bell
    // carries the harsh floor, a style cut (warm) just deepens it
    const floorUsed = tone.presenceDb < 0 && tone.presenceQ === 2;
    if (floorUsed) {
      if (st.presenceDb < 0) {
        tone.presenceDb = r2(tone.presenceDb + st.presenceDb * sc);
        Object.assign(styleTone, { presenceDb: r2(st.presenceDb * sc), presenceHz: tone.presenceHz, presenceQ: 2 });
      }
    } else if (st.presenceDb < 0 || fin(x.harsh, 99) <= G.harsh / 2) {
      tone.presenceDb = r2(st.presenceDb * sc);
      tone.presenceHz = st.presenceHz;
      Object.assign(styleTone, { presenceDb: tone.presenceDb, presenceHz: tone.presenceHz, presenceQ: tone.presenceQ });
    }
  }
  if (st.airDb > 0 && fc >= 17000 && !(fin(x.hash, -99) > G.hash) && !alreadyBright) {
    const before = tone.airDb;
    tone.airDb = r2(Math.min(3, tone.airDb + st.airDb * sc));
    tone.airHz = 12000;
    Object.assign(styleTone, { airDb: r2(tone.airDb - before), airHz: 12000 });
  }
  if (st.mudDb) {
    tone.mudDb = r2(tone.mudDb + st.mudDb * sc);
    Object.assign(styleTone, { mudDb: r2(st.mudDb * sc), mudHz: tone.mudHz, mudQ: tone.mudQ });
  }
  if (st.drive < 0) {
    p.color.saturation.enabled = false;
    drive = 0;
  } else drive += st.drive * sc;
  let width = 1 + st.widthAdd * sc;
  if (st.glue.releaseMs) p.glue.releaseMs = st.glue.releaseMs;
  if (st.glue.ratioAdd) p.glue.ratio = r2(Math.max(1.1, p.glue.ratio + st.glue.ratioAdd * sc));
  if (st.lowBandRatioAdd) p.multiband.bands[0].ratio = r2(p.multiband.bands[0].ratio + st.lowBandRatioAdd * sc);
  if (Array.isArray(st.bandTiming)) {
    // Punchy: the low band follows each kick (short detector) with a slow attack,
    // the mid band attacks slower: the hit passes before the band clamps the body, the short
    // release frees the next hit; the added gain reduction (grAddDb × t/0.5) makes it audible
    st.bandTiming.forEach((bt, i) => {
      const b = p.multiband.bands[i];
      if (!b || !bt) return;
      if (bt.rmsMs) b.rmsMs = bt.rmsMs;
      if (bt.attackMs) b.attackMs = bt.attackMs;
      if (bt.releaseMs) b.releaseMs = bt.releaseMs;
      if (bt.grAddDb && p.multiband.enabled) b.targetGrDb = r2(Math.min(3, b.targetGrDb + bt.grAddDb * sc));
    });
  }
  clipDb += st.clipAddDb * sc;
  if (st.deEssExtraDb && bands.deEss.enabled) bands.deEss.maxCutDb = r2(bands.deEss.maxCutDb + st.deEssExtraDb * sc);

  // ---- 5. auto-adjust rules (RESEARCH §1)
  if (stereoA.nearMono) width += 0.2 * t; // +5 / 10 / 15 % above 1.5 kHz (QC reverts if r < 0.2)
  p.stereo.width = r2(width);
  p.stereo.widthFromHz = 1500;
  const plr = fin(lo.plr, 12), lra = fin(lo.lra, 6);
  const crushed = plr < 8 && lra < 3;
  if (crushed) {
    for (const b of p.multiband.bands) b.targetGrDb = r2(b.targetGrDb / 2);
    p.glue.targetGrDb = r2(p.glue.targetGrDb / 2);
    clipDb = 0;
  }
  if (fin(a.crestDb, 20) < 10) p.glue.ratio = r2(Math.max(1.1, p.glue.ratio - 0.3));
  // Input already at or above the target: gain reduction only — unless even the turned-down
  // input would still peak within 3 dB of the ceiling (processing can raise the PLR, e.g.
  // phase rotation of a clipped file), in which case the clipper stays available.
  const tpIn = fin(lo.truePeakDb, 0);
  if (I >= p.loudness.targetLufs && tpIn - (I - p.loudness.targetLufs) < p.loudness.ceilingDb - 3) clipDb = 0;
  p.color.saturation.drive = r2(clamp(drive, 0, 0.5));
  if (p.color.saturation.drive <= 0) p.color.saturation.enabled = false;
  p.loudness.clipper.amountDb = r2(clamp(clipDb, 0, 2.5));
  p.loudness.clipper.enabled = p.loudness.clipper.amountDb > 0;

  // ---- 6. reference (match EQ)
  const ref = ch.reference;
  if (ref && ref.ltas && ref.ltas.length === 31) {
    p.eq.match.enabled = true;
    p.eq.match.referenceLtas = Array.from(ref.ltas, (v) => fin(v, -240));
    p.eq.match.referenceName = String(ref.name || '');
    p.eq.match.strength = r2(clamp(fin(ref.amount, 0.5), 0, 1));
  }

  // ---- trim only for real silence, short edge fades always. Head and tail are decided
  // separately: a long tail alone must not move the master's start (A/B, waveform);
  // with both edges short a user enabling trim gets both.
  const sil = a.silence || {};
  const head = fin(sil.startSec, 0) > 0.5, tail = fin(sil.endSec, 0) > 0.5;
  p.trim.enabled = head || tail;
  p.trim.head = head || !tail;
  p.trim.tail = true;
  p.finish.fadeInMs = 5;
  p.finish.fadeOutMs = 30;

  p.meta = { destination, style, cleanup, intensity: t, profile, brightened: r2(bri), styleTone };
  return validateParams(p);
}

/**
 * Plain-language decisions (§10 keys) for what the parameters actually apply, in chain
 * order. `db` vars are negative for cuts (the UI shows magnitudes); `pct` vars are
 * integer percents. With report.paramsUsed (the chain adds `meta.realised`: the applied
 * auto-EQ curve's largest move, the realised multiband / glue gain reduction of the loud
 * sections, whether trim cut anything, the loudness actually targeted) the lines describe
 * what actually ran, after any QC rollback; otherwise they are derived from the parameters.
 * @param {object} analysis AnalysisReport
 * @param {object} params Params (usually report.paramsUsed)
 * @returns {{ key: string, vars: object }[]}
 */
export function describeDecisions(analysis, params) {
  const a = analysis || {};
  const p = params || {};
  const out = [];
  const add = (key, vars = {}) => out.push({ key, vars });
  const meta = p.meta || {};
  const real = meta.realised && typeof meta.realised === 'object' ? meta.realised : null;
  const profile = a.profile || meta.profile;
  if (profile) add('dec.profile', { profile });
  const prep = p.prepare || {};
  if (fin(prep.highpassHz, 0) > 0) add('dec.highpass', { hz: Math.round(prep.highpassHz) });
  if (p.trim && p.trim.enabled && !(real && real.trimmed === false)) {
    // name the edge that was actually cut (a long tail alone keeps the start)
    const head = real && typeof real.trimHead === 'boolean' ? real.trimHead : p.trim.head !== false;
    const tail = real && typeof real.trimTail === 'boolean' ? real.trimTail : p.trim.tail !== false;
    add(head && tail ? 'dec.trim' : head ? 'dec.trimHead' : 'dec.trimTail', {});
  }
  const sp = p.spectral || {};
  if (sp.deShimmer && sp.deShimmer.enabled && sp.deShimmer.amount > 0) {
    add('dec.deShimmer', { pct: Math.round(sp.deShimmer.amount * 100), hz: Math.round(fin(sp.deShimmer.startHz, 5000)) });
  }
  if (sp.denoise && sp.denoise.enabled && sp.denoise.amount > 0) {
    add('dec.denoise', { db: r2(-12 * sp.denoise.amount), hz: Math.round(fin(sp.denoise.fromHz, 6000)) });
  }
  const eq = p.eq || {};
  const tone = eq.tone || {};
  if (eq.enabled !== false) {
    const au = eq.auto || {};
    const lt = a.spectrum && a.spectrum.ltas;
    if (real && Number.isFinite(real.autoEqDb)) {
      if (au.enabled && Math.abs(real.autoEqDb) >= 0.3) add('dec.autoEq', { db: r2(real.autoEqDb) });
    } else if (au.enabled && au.strength > 0 && lt && lt.length === 31) {
      const c = autoEqCurve(lt, {
        strength: au.strength, maxDb: au.maxDb, toleranceDb: au.toleranceDb,
        targetSlopeDbPerOct: au.targetSlopeDbPerOct, cutoffHz: a.spectrum.hfCutoffHz,
      });
      let m = 0;
      for (const v of c) if (Math.abs(v) > Math.abs(m)) m = v;
      if (Math.abs(m) >= 0.3) add('dec.autoEq', { db: r2(m) });
    }
    const ma = eq.match || {};
    if (ma.enabled && ma.referenceLtas && ma.strength > 0) add('dec.match', { name: ma.referenceName || '', pct: Math.round(ma.strength * 100) });
    const styleMoves = ['tiltDbPerOct', 'lowShelfDb', 'highShelfDb'].some((key) => Math.abs(fin(tone[key], 0)) > 1e-3) || (Math.abs(fin(tone.presenceDb, 0)) > 1e-3 && tone.presenceQ !== 2);
    if (meta.style && meta.style !== 'balanced' && styleMoves) add('dec.tone', { style: meta.style });
    if (fin(tone.hashDb, 0) < 0) add('dec.hash', { db: r2(tone.hashDb) });
  }
  const bands = (p.dynEq && p.dynEq.bands) || {};
  const on = (id) => bands[id] && bands[id].enabled && bands[id].maxCutDb > 0;
  const staticOf = (id) => (eq.enabled === false ? 0 : Math.min(0, fin(id === 'mud' ? tone.mudDb : tone.boomDb, 0)));
  for (const id of ['mud', 'boom']) {
    const st = staticOf(id);
    if (on(id) || st < 0) {
      const hz = on(id) ? bands[id].freq : id === 'mud' ? tone.mudHz : tone.boomHz;
      add(`dec.${id}`, { db: r2(-(on(id) ? bands[id].maxCutDb : 0) + st), hz: Math.round(fin(hz, id === 'mud' ? 300 : 120)) });
    }
  }
  const harshFloor = eq.enabled !== false && tone.presenceQ === 2 && fin(tone.presenceDb, 0) < 0 ? tone.presenceDb : 0;
  if (on('harsh') || harshFloor < 0) {
    add('dec.harsh', { db: r2(-(on('harsh') ? bands.harsh.maxCutDb : 0) + harshFloor), hz: Math.round(on('harsh') ? bands.harsh.freq : fin(tone.presenceHz, 3500)) });
  }
  if (on('fizz')) add('dec.fizz', { db: r2(-bands.fizz.maxCutDb), hz: Math.round(bands.fizz.freq) });
  for (const id of ['deEss', 'deEssAir']) if (on(id)) add('dec.deEss', { db: r2(-bands[id].maxCutDb), hz: Math.round(bands[id].freq) });
  if (on('sideHf')) add('dec.sideHf', { db: r2(-bands.sideHf.maxCutDb) });
  const col = p.color || {};
  if (col.saturation && col.saturation.enabled && col.saturation.drive > 0) add('dec.saturation', { pct: Math.round(col.saturation.drive * 100) });
  if (col.air && col.air.enabled && col.air.amount > 0) add('dec.air', { pct: Math.round(col.air.amount * 100) });
  const mb = p.multiband || {};
  if (mb.enabled && Array.isArray(mb.bands) && mb.bands.some((b) => b.targetGrDb > 0)) {
    const avg = real && Number.isFinite(real.multibandGrDb)
      ? -real.multibandGrDb
      : mb.bands.reduce((s, b) => s + fin(b.targetGrDb, 0), 0) / mb.bands.length;
    if (avg >= 0.05) add('dec.multiband', { db: r2(-avg) });
  }
  const stp = p.stereo || {};
  if (stp.enabled !== false) {
    if (fin(stp.monoBassHz, 0) > 0) add('dec.monoBass', { hz: Math.round(stp.monoBassHz) });
    if (Math.abs(fin(stp.width, 1) - 1) >= 0.005) add('dec.width', { pct: Math.round((stp.width - 1) * 100) });
  }
  const gl = p.glue || {};
  if (gl.enabled && gl.targetGrDb > 0 && gl.ratio > 1) {
    const g = real && Number.isFinite(real.glueGrDb) ? -real.glueGrDb : gl.targetGrDb;
    if (g >= 0.05) add('dec.glue', { db: r2(-g) });
  }
  const ld = p.loudness || {};
  // the level the master was actually rendered to (Loud / Club may settle below the target)
  const lufs = real && Number.isFinite(real.targetLufs) ? real.targetLufs : fin(ld.targetLufs, -14);
  add('dec.loudness', { lufs, ceiling: fin(ld.ceilingDb, -1), dest: meta.destination || 'streaming' });
  const fo = p.finish || {};
  if (fin(fo.fadeOutMs, 0) >= 1000) add('dec.fadeOut', { sec: Math.round(fo.fadeOutMs / 100) / 10 });
  return out;
}
