// Engine tests: analyze.js, assistant.js, chain.js, handlers.js, worker.js, client.js.
// End-to-end on the demo track (src/demo) and the fixtures of tools/make-fixtures.mjs,
// cross-checked with ffmpeg ebur128 when available. Deterministic.
import { join } from 'node:path';
import {
  assert, approx, assertFinite, pinkNoise, sine, bestLag, writeWavFloat, ffmpegLoudness, ffmpegDecode,
  hasFfmpeg, TMP, timed,
  speedFactor,
  ROSETTA,
} from './helpers.mjs';
import { analyzeTrack, REFERENCE_LTAS, INDEX_GATES, stereoSpectrum } from '../src/analysis/analyze.js';
import { suggestParams, describeDecisions, intensityValue, targetLufsFor } from '../src/engine/assistant.js';
import { renderMaster, trimBounds, STAGES } from '../src/engine/chain.js';
import { createEngineState, handleMessage } from '../src/engine/handlers.js';
import { EngineClient } from '../src/engine/client.js';
import {
  DESTINATIONS, DESTINATION_IDS, STYLES, INTENSITY_TABLE, CLEANUP_LEVELS, DYN_EQ_BAND_IDS, validateParams, defaultParams, isUserOwned,
} from '../src/engine/params.js';
import { generateDemoTrack, DEMO_DEFECTS, demoShimmerPartials } from '../src/demo/demo-track.js';
import { measure, measureTruePeakDb } from '../src/analysis/loudness.js';
import { truePeakDb } from '../src/dsp/oversample.js';
import { design, butterworth, processStereoInPlace } from '../src/dsp/biquad.js';
import { fitGraphicEq, THIRD_OCTAVE_HZ } from '../src/dsp/eq.js';
import { RealFFT, hann } from '../src/dsp/fft.js';
import { makeFixtures } from '../tools/make-fixtures.mjs';
import { STRINGS } from '../src/ui/i18n.js';

const SR = 48000;

// ------------------------------------------------------------------ helpers

const scaleFactor = speedFactor;
const scaleNote = () => `host factor ${speedFactor().toFixed(2)}${ROSETTA ? ' incl. × 1.6 Rosetta' : ''}`;

const memo = new Map();
function once(key, fn) {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}
const demo = (defects = true, seconds = 32) => once(`demo-${defects}-${seconds}`, () => generateDemoTrack({ sampleRate: SR, seconds, seed: 7, defects }));
const demoAnalysis = (defects = true) => once(`an-${defects}`, () => analyzeTrack(demo(defects)));
const cloneAudio = (a) => ({ sampleRate: a.sampleRate, channels: a.channels.map((c) => Float32Array.from(c)) });
const inputInfoOf = (an) => ({ loudness: an.loudness, ltas: an.spectrum.ltas, cutoffHz: an.spectrum.hfCutoffHz, clippingRuns: an.clipping.runs });
const demoCache = { true: {}, false: {} };

async function renderDemo(choices = {}, { defects = true, mutate = null } = {}) {
  const an = demoAnalysis(defects);
  let p = suggestParams(an, { destination: 'streaming', style: 'balanced', intensity: 0.5, cleanup: 'medium', ...choices });
  if (mutate) {
    p = JSON.parse(JSON.stringify(p));
    mutate(p);
    p = validateParams(p);
  }
  const res = await renderMaster(demo(defects), p, { cache: demoCache[defects], inputInfo: inputInfoOf(an) });
  return { ...res, params: p, analysis: an };
}

const hasNaN = (chs) => chs.some((c) => c.some((v) => !Number.isFinite(v)));
const plrOf = (m) => m.truePeakDb - m.integrated;

/** Band power sum of a 31-band LTAS over [lo, hi] (nominal centres), dB. */
function bandDb(lt, lo, hi) {
  let p = 0;
  THIRD_OCTAVE_HZ.forEach((f, i) => {
    if (f >= lo && f <= hi) p += Math.pow(10, lt[i] / 10);
  });
  return 10 * Math.log10(Math.max(p, 1e-30));
}
const hfBalance = (lt) => bandDb(lt, 8000, 16000) - bandDb(lt, 63, 16000);

/** Long-term mid power spectrum (Welch, Hann 8192, 50 %) → { psd, df }. */
function midPsd(ch, sr) {
  const N = 8192, hop = 4096;
  const fft = new RealFFT(N);
  const w = hann(N);
  const buf = new Float64Array(N), re = new Float64Array(N / 2 + 1), im = new Float64Array(N / 2 + 1);
  const psd = new Float64Array(N / 2 + 1);
  let frames = 0;
  for (let s = 0; s + N <= ch[0].length; s += hop) {
    for (let i = 0; i < N; i++) buf[i] = 0.5 * (ch[0][s + i] + ch[1][s + i]) * w[i];
    fft.forward(buf, re, im);
    for (let k = 0; k <= N / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  for (let k = 0; k <= N / 2; k++) psd[k] /= Math.max(1, frames);
  return { psd, df: sr / N };
}
const psdBand = ({ psd, df }, lo, hi) => {
  let p = 0;
  for (let k = Math.max(1, Math.round(lo / df)); k <= Math.min(psd.length - 1, Math.round(hi / df)); k++) p += psd[k];
  return 10 * Math.log10(p + 1e-30);
};

/** Shimmer partial energy re the rest of the 7–14 kHz band (dB), demo partial list. */
function partialRatioDb(ch, sr) {
  const sp = midPsd(ch, sr);
  const parts = demoShimmerPartials({ sampleRate: sr });
  let inP = 0, all = 0;
  const near = (f) => parts.some((p) => Math.abs(p.freqHz - f) <= 18);
  for (let k = Math.round(7000 / sp.df); k <= Math.round(14000 / sp.df); k++) {
    all += sp.psd[k];
    if (near(k * sp.df)) inP += sp.psd[k];
  }
  return 10 * Math.log10(inP / Math.max(all - inP, 1e-30));
}

function ffmpegCheck(audio, name) {
  if (!hasFfmpeg()) return null;
  const path = join(TMP, `engine-${name}.wav`);
  writeWavFloat(path, audio.channels, audio.sampleRate);
  return ffmpegLoudness(path);
}

/** Shape stereo pink noise to a target 31-band curve (relative dB) with the fitted EQ. */
function shapedNoise(curveDb, seconds = 12) {
  const L = pinkNoise(seconds, SR, 0.35, 21), R = pinkNoise(seconds, SR, 0.35, 22);
  for (let i = 0; i < L.length; i++) {
    const m = 0.5 * (L[i] + R[i]);
    L[i] = 0.8 * m + 0.2 * L[i];
    R[i] = 0.8 * m + 0.2 * R[i];
  }
  const ch = [L, R];
  const mean = curveDb.reduce((s, v) => s + v, 0) / curveDb.length;
  processStereoInPlace(ch, fitGraphicEq(curveDb.map((v) => v - mean), SR));
  return { sampleRate: SR, channels: ch };
}

/**
 * Synthetic song with macro-dynamics: 6 s verse (−6 dB, lighter kick) / 6 s chorus,
 * 55 Hz kick with a 120 Hz click every 0.5 s, a 45 Hz sub note under each chorus kick,
 * pink-noise pad and a vibrato "voice". Deterministic. → { audio, kicks: onset samples }
 */
function song(seconds = 36, sr = SR) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const pad = [pinkNoise(seconds, sr, 0.5, 51), pinkNoise(seconds, sr, 0.5, 52)];
  processStereoInPlace(pad, butterworth('lowpass', 1, 2500, sr)); // music-like −4 dB/oct top
  const [padL, padR] = pad;
  const kicks = [];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const chorus = Math.floor(t / 6) % 2 === 1;
    const g = chorus ? 1 : 0.5; // −6 dB verses
    const v = 0.1 * Math.sin(2 * Math.PI * (330 * t + 2 * Math.sin(2 * Math.PI * 5 * t))) + 0.04 * Math.sin(2 * Math.PI * (660 * t + 4 * Math.sin(2 * Math.PI * 5 * t)));
    L[i] = g * (padL[i] + v);
    R[i] = g * (padR[i] + v);
  }
  for (let k = 0; k * 0.5 * sr < n; k++) {
    const s = Math.round(k * 0.5 * sr);
    const chorus = Math.floor((k * 0.5) / 6) % 2 === 1;
    kicks.push({ s, chorus });
    const amp = chorus ? 0.25 : 0.12;
    for (let j = 0; j < Math.round(0.25 * sr) && s + j < n; j++) {
      const t = j / sr;
      let x = amp * Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * 55 * t) + 0.25 * amp * Math.exp(-t / 0.008) * Math.sin(2 * Math.PI * 120 * t);
      if (chorus) x += 0.1 * Math.exp(-t / 0.2) * Math.sin(2 * Math.PI * 45 * t);
      L[s + j] += x;
      R[s + j] += x;
    }
  }
  return { audio: { sampleRate: sr, channels: [L, R] }, kicks };
}

/** Kick attack-to-body (dB) of a master vs its input, 40–120 Hz, master loudness-matched. */
function kickPunch(input, master, kicks) {
  const sr = input.sampleRate;
  const lp = (ch) => {
    const y = [Float32Array.from(ch[0]), Float32Array.from(ch[1])];
    processStereoInPlace(y, [...butterworth('highpass', 4, 40, sr), ...butterworth('lowpass', 4, 120, sr)]);
    return y[0];
  };
  const g = Math.pow(10, (measure(input.channels, sr).integrated - measure(master.channels, sr).integrated) / 20);
  const xi = lp(input.channels), xo = lp(master.channels);
  let sum = 0, cnt = 0;
  for (const { s } of kicks) {
    if (s + Math.round(0.15 * sr) >= xi.length || s < sr) continue;
    let ai = 0, ao = 0, bi = 0, bo = 0;
    for (let j = s; j < s + Math.round(0.012 * sr); j++) {
      ai = Math.max(ai, Math.abs(xi[j]));
      ao = Math.max(ao, Math.abs(xo[j] * g));
    }
    for (let j = s + Math.round(0.04 * sr); j < s + Math.round(0.14 * sr); j++) {
      bi += xi[j] * xi[j];
      bo += xo[j] * g * xo[j] * g;
    }
    sum += 20 * Math.log10(ao / ai) - 10 * Math.log10(bo / bi);
    cnt++;
  }
  return sum / cnt;
}

/** Loudness-matched mid-band power change (dB) of master vs input over [lo, hi] Hz. */
function bandChangeDb(input, master, lo, hi) {
  const sr = input.sampleRate;
  const gi = measure(input.channels, sr).integrated, go = measure(master.channels, sr).integrated;
  const pi = midPsd(input.channels, sr), po = midPsd(master.channels, sr);
  return psdBand(po, lo, hi) - psdBand(pi, lo, hi) - (go - gi);
}

/** How often the eq stage started in a render (1 = no QC re-render). */
const eqRuns = (prog) => prog.filter(([s, f]) => s === 'eq' && f === 0).length;

function dbgReport(r) {
  return `LUFS ${r.loudness.integrated.toFixed(2)} TP ${r.loudness.truePeakDb.toFixed(2)} LRA ${r.loudness.lra.toFixed(1)}`;
}

// ------------------------------------------------------------------ tests

export const tests = {
  // ================================================================ analysis

  'analyze: demo defects are all detected (DEMO_DEFECTS issue list)': async () => {
    const an = demoAnalysis(true);
    const ids = new Set(an.issues.map((i) => i.id));
    for (const id of DEMO_DEFECTS.issues) assert(ids.has(id), `missing issue ${id} (got ${[...ids].join(',')})`);
    const x = an.indices;
    approx(x.harshHz, DEMO_DEFECTS.harsh.freqHz, 0.06 * DEMO_DEFECTS.harsh.freqHz, 'harsh peak frequency');
    assert(x.mudHz >= 200 && x.mudHz <= 500, `mud peak in 200–500 Hz: ${x.mudHz}`);
    approx(an.dcOffset[0], DEMO_DEFECTS.dc.left, 2e-4, 'DC left');
    approx(an.dcOffset[1], DEMO_DEFECTS.dc.right, 2e-4, 'DC right');
    assert(an.stereo.bandCorrelation[0] < 0.5, `low-band correlation ${an.stereo.bandCorrelation[0]}`);
    assert(an.loudness.truePeakDb > 0 && an.loudness.integrated > -9, 'tooLoud / overs');
    assert(an.abruptEnd, 'abrupt end');
    assert(an.profile === 'fullband', `profile ${an.profile}`);
    for (const i of an.issues) assert(i.severity >= 0 && i.severity <= 1 && Number.isFinite(i.value), `severity/value of ${i.id}`);
    return `issues: ${an.issues.map((i) => `${i.id}(${i.severity.toFixed(2)})`).join(' ')}; harsh ${x.harsh} dB @ ${x.harshHz} Hz, mud ${x.mud} dB @ ${x.mudHz} Hz, sibilance ${x.sibilanceEventsPerMin}/min, shimmer ${x.shimmer}, hiss ${x.hiss}`;
  },

  'analyze: clean demo shows none of the artifact issues': async () => {
    const an = demoAnalysis(false);
    const ids = new Set(an.issues.map((i) => i.id));
    for (const id of ['shimmer', 'hiss', 'sibilant', 'wideBass', 'dcOffset', 'overs', 'tooLoud', 'abruptEnd', 'phase', 'clipping', 'codecCutoff', 'brightened']) {
      assert(!ids.has(id), `clean demo flagged ${id}`);
    }
    assert(an.stereo.bandCorrelation[0] > 0.95, 'clean low end is mono');
    // detector margins (defects vs clean)
    const d = demoAnalysis(true).indices, c = an.indices;
    assert(d.shimmer - c.shimmer > 3, `shimmer separation ${d.shimmer} vs ${c.shimmer}`);
    assert(d.hiss - c.hiss > 10, `hiss separation ${d.hiss} vs ${c.hiss}`);
    assert(d.sibilanceEventsPerMin > 5 * Math.max(1, c.sibilanceEventsPerMin), `sibilance ${d.sibilanceEventsPerMin} vs ${c.sibilanceEventsPerMin}/min`);
    assert(d.harsh - c.harsh > 2, `harsh separation ${d.harsh} vs ${c.harsh}`);
    return `clean issues: ${an.issues.map((i) => i.id).join(',') || 'none'} (synthetic arrangement: lumpy low mids)`;
  },

  'analyze: report shape, finite values, matches ffmpeg loudness': async () => {
    const an = demoAnalysis(true);
    for (const k of ['duration', 'sampleRate', 'rmsDb', 'crestDb']) assert(Number.isFinite(an[k]), k);
    for (const k of ['integrated', 'lra', 'shortTermMax', 'momentaryMax', 'truePeakDb', 'samplePeakDb', 'plr', 'curveHopSec']) assert(Number.isFinite(an.loudness[k]), `loudness.${k}`);
    assert(an.loudness.curve instanceof Float32Array && an.loudness.curve.length > 100, 'curve');
    assert(an.spectrum.ltas.length === 31 && an.spectrum.ltas.every(Number.isFinite), 'ltas');
    for (const v of Object.values(an.spectrum.bands)) assert(Number.isFinite(v) && v <= 0, 'bands dB re total');
    assert(an.stereo.bandCorrelation.length === 4 && an.stereo.bandCorrelation.every((v) => v >= -1 && v <= 1), 'band correlation');
    for (const [k, v] of Object.entries(an.indices)) assert(Number.isFinite(v), `index ${k}`);
    assert(Number.isFinite(an.silence.startSec) && Number.isFinite(an.silence.endSec), 'silence');
    assert(typeof an.abruptEnd === 'boolean' && typeof an.stereo.nearMono === 'boolean', 'booleans');
    assert(JSON.stringify(an).length > 0, 'serializable');
    const ff = ffmpegCheck(demo(true), 'analyze-input');
    if (ff) {
      approx(an.loudness.integrated, ff.integrated, 0.1, 'integrated vs ffmpeg');
      approx(an.loudness.truePeakDb, ff.truePeakDb, 0.2, 'true peak vs ffmpeg');
    }
    return ff ? `I ${an.loudness.integrated.toFixed(2)} (ffmpeg ${ff.integrated}), TP ${an.loudness.truePeakDb.toFixed(2)} (ffmpeg ${ff.truePeakDb})` : 'ffmpeg missing: shape only';
  },

  'analyze: profiles from codec cutoff and balance vs REFERENCE_LTAS': async () => {
    const clean = demo(false);
    const lp = (f) => {
      const a = cloneAudio(clean);
      processStereoInPlace(a.channels, [...butterworth('lowpass', 8, f, SR), ...butterworth('lowpass', 8, f, SR)]);
      return analyzeTrack(a);
    };
    const l12 = lp(12000), l16 = lp(16000);
    assert(l12.profile === 'legacy', `12 kHz → ${l12.profile}`);
    assert(l16.profile === 'midband', `16 kHz → ${l16.profile}`);
    assert(l12.issues.some((i) => i.id === 'codecCutoff') && l12.issues.some((i) => i.id === 'dull'), 'legacy: codecCutoff + dull');
    approx(l16.spectrum.hfCutoffHz, 16000, 600, 'cutoff');
    // reference-shaped noise reads full band and neutral; +8 dB at 6–10 kHz → brightened
    // (a continuous modifier on top of the f_c profile: ramp 6 → 9 dB);
    // −6 dB above 5 kHz with +3 dB lows → muffled
    const ref = analyzeTrack(shapedNoise(REFERENCE_LTAS));
    assert(ref.profile === 'fullband', `reference-shaped noise → ${ref.profile}`);
    assert(Math.abs(ref.indices.brightness) < 2 && Math.abs(ref.indices.air) < 2, `neutral balance (brightness ${ref.indices.brightness}, air ${ref.indices.air})`);
    const bright = analyzeTrack(shapedNoise(REFERENCE_LTAS.map((v, i) => v + (THIRD_OCTAVE_HZ[i] >= 6300 && THIRD_OCTAVE_HZ[i] <= 10000 ? 8 : 0))));
    assert(bright.profile === 'fullband' && bright.issues.some((i) => i.id === 'brightened'), `+8 dB 6–10 kHz → ${bright.profile}`);
    approx(bright.brightened, (bright.indices.brightness - INDEX_GATES.brightened) / (INDEX_GATES.brightenedFull - INDEX_GATES.brightened), 0.002, 'brightened ramp');
    assert(bright.brightened > 0.3 && bright.brightened < 1 && ref.brightened === 0, `brightened amount ${bright.brightened} / ref ${ref.brightened}`);
    const muf = analyzeTrack(shapedNoise(REFERENCE_LTAS.map((v, i) => v + (THIRD_OCTAVE_HZ[i] >= 5000 ? -6 : 0) + (THIRD_OCTAVE_HZ[i] <= 125 ? 3 : 0))));
    assert(muf.profile === 'muffled', `dark + bass → ${muf.profile}`);
    return `legacy fc ${l12.spectrum.hfCutoffHz}, midband fc ${l16.spectrum.hfCutoffHz}; brightness ref ${ref.indices.brightness} / bright ${bright.indices.brightness}; muffled hf ${muf.indices.hf616}`;
  },

  'analyze: tonal detectors find injected mud / harsh / boom / rumble at the right frequency': async () => {
    const base = REFERENCE_LTAS.slice();
    const add = (f0, db, wOct) => base.map((v, i) => v + db * Math.exp(-0.5 * (Math.log2(THIRD_OCTAVE_HZ[i] / f0) / wOct) ** 2));
    const neutral = analyzeTrack(shapedNoise(base, 10)).indices;
    for (const k of ['mud', 'boom', 'harsh', 'fizz', 'rumble']) assert(neutral[k] < INDEX_GATES[k], `neutral ${k} = ${neutral[k]}`);
    const mud = analyzeTrack(shapedNoise(add(320, 4, 0.5), 10)).indices;
    assert(mud.mud > INDEX_GATES.mud && Math.abs(Math.log2(mud.mudHz / 320)) < 0.4, `mud ${mud.mud} @ ${mud.mudHz}`);
    const boom = analyzeTrack(shapedNoise(add(125, 5, 0.3), 10)).indices;
    assert(boom.boom > INDEX_GATES.boom, `boom ${boom.boom} @ ${boom.boomHz}`);
    const harsh = cloneAudio(shapedNoise(base, 10));
    processStereoInPlace(harsh.channels, [design('peaking', 4200, SR, { q: 3, gainDb: 7 })]);
    const h = analyzeTrack(harsh).indices;
    assert(h.harsh > INDEX_GATES.harsh && Math.abs(h.harshHz - 4200) < 350, `harsh ${h.harsh} @ ${h.harshHz}`);
    const rum = analyzeTrack(shapedNoise(base.map((v, i) => v + (THIRD_OCTAVE_HZ[i] <= 25 ? 10 : 0)), 10)).indices;
    assert(rum.rumble > INDEX_GATES.rumble, `rumble ${rum.rumble}`);
    return `neutral mud/boom/harsh ${neutral.mud}/${neutral.boom}/${neutral.harsh}; injected mud ${mud.mud}@${mud.mudHz}, boom ${boom.boom}@${boom.boomHz}, harsh ${h.harsh}@${h.harshHz}, rumble ${rum.rumble}`;
  },

  'analyze: silence, 10 samples, mono, NaN, 96 kHz, leading/trailing silence': async () => {
    const check = (a, name) => {
      const r = analyzeTrack(a);
      const walk = (o, path) => {
        if (typeof o === 'number') assert(!Number.isNaN(o), `${name}: NaN at ${path}`);
        else if (o && typeof o === 'object' && !ArrayBuffer.isView(o)) for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      };
      walk(r, name);
      return r;
    };
    const sil = check({ sampleRate: SR, channels: [new Float32Array(SR), new Float32Array(SR)] }, 'silence');
    assert(sil.issues.some((i) => i.id === 'silence') && sil.issues.length === 1, `silence issues ${sil.issues.map((i) => i.id)}`);
    check({ sampleRate: SR, channels: [Float32Array.from({ length: 10 }, (_, i) => 0.1 * Math.sin(i)), new Float32Array(10)] }, 'ten');
    const mono = check({ sampleRate: 44100, channels: [pinkNoise(3, 44100, 0.3, 3)] }, 'mono');
    assert(mono.stereo.correlation > 0.99 && mono.stereo.nearMono, 'mono is near-mono');
    const nan = pinkNoise(2, SR, 0.3, 4);
    nan[100] = NaN;
    nan[200] = Infinity;
    check({ sampleRate: SR, channels: [nan, Float32Array.from(nan)] }, 'nan');
    check({ sampleRate: 96000, channels: [pinkNoise(3, 96000, 0.3, 5), pinkNoise(3, 96000, 0.3, 6)] }, '96k');
    const d = demo(false, 32);
    const withSil = { sampleRate: SR, channels: d.channels.map((c) => { const o = new Float32Array(c.length + Math.round(3 * SR)); o.set(c, Math.round(1 * SR)); return o; }) };
    const r = check(withSil, 'padded');
    approx(r.silence.startSec, 1, 0.15, 'leading silence');
    approx(r.silence.endSec, 2, 0.2, 'trailing silence (clean demo fades out)');
    assert(r.issues.some((i) => i.id === 'silence'), 'silence issue');
    assert(suggestParams(r, {}).trim.enabled, 'assistant enables trim for > 0.5 s silence');
    assert(!suggestParams(demoAnalysis(true), {}).trim.enabled, 'no trim without silence');
    return `silence ${r.silence.startSec}/${r.silence.endSec} s`;
  },

  'analyze: performance 3:30 stereo 48 kHz (budget 2 s @M1)': async () => {
    const a = demo(true, 210);
    analyzeTrack({ sampleRate: SR, channels: a.channels.map((c) => c.subarray(0, 10 * SR)) }); // warm-up
    const tm = {};
    const [r, ms] = await timed(() => analyzeTrack(a, { timings: tm }));
    assert(r.issues.length > 0, 'issues');
    const budget = 2000;
    const m1 = ms / scaleFactor();
    assert(ms < 1.3 * budget * scaleFactor(), `analyzeTrack ${ms.toFixed(0)} ms > 1.3 × ${budget} ms × ${scaleNote()}`);
    return `${ms.toFixed(0)} ms (${scaleNote()} → ≈${m1.toFixed(0)} ms @M1; budget ${budget}) — ${Object.entries(tm).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`;
  },

  // ================================================================ assistant

  'assistant: destinations, ceilings, lufsRange by intensity, never touches output.sampleRate': async () => {
    const an = demoAnalysis(false);
    for (const dest of DESTINATION_IDS) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const p = suggestParams(an, { destination: dest, intensity: t });
        const d = DESTINATIONS[dest];
        assert(p.loudness.ceilingDb === d.ceilingDb, `${dest} ceiling`);
        const want = d.lufsRange ? d.lufsRange[0] + (d.lufsRange[1] - d.lufsRange[0]) * Math.min(1, Math.max(0, (t - 0.25) / 0.5)) : d.lufs;
        approx(p.loudness.targetLufs, want, 1e-6, `${dest} @ ${t} target`);
        assert(p.output.sampleRate === 'source', `${dest}: output.sampleRate untouched`);
        assert(JSON.stringify(validateParams(p)) === JSON.stringify(p), `${dest}: validated`);
      }
    }
    approx(targetLufsFor('loud', 0.25), -11, 1e-9, 'loud low');
    approx(targetLufsFor('club', 0.75), -7, 1e-9, 'club high');
    approx(targetLufsFor('nope', 0.5), -14, 1e-9, 'unknown → streaming');
    return 'ok';
  },

  'assistant: INTENSITY_TABLE interpolation drives the mastering moves': async () => {
    const an = demoAnalysis(false);
    // dynamics targets: table × the destination's `dynamics` scale (streaming 0.6), halved
    // again when the input is already at / above the target; low band at half
    const quiet = { ...an, loudness: { ...an.loudness, integrated: -20 } };
    for (const t of [0, 0.125, 0.25, 0.4, 0.5, 0.75, 0.9, 1]) {
      const p = suggestParams(quiet, { intensity: t, style: 'balanced' });
      const ds = DESTINATIONS.streaming.dynamics;
      approx(p.eq.auto.strength, intensityValue('autoEqStrength', t), 0.006, `auto strength @${t}`);
      approx(p.eq.auto.maxDb, intensityValue('autoEqMaxDb', t), 0.006, `auto max @${t}`);
      approx(p.multiband.bands[1].targetGrDb, Math.min(3, intensityValue('multibandTargetGrDb', t)) * ds, 0.006, `mb @${t}`);
      approx(p.multiband.bands[0].targetGrDb, 0.5 * Math.min(3, intensityValue('multibandTargetGrDb', t)) * ds, 0.006, `mb low @${t}`);
      approx(p.glue.targetGrDb, Math.min(2, intensityValue('glueTargetGrDb', t)) * ds, 0.006, `glue @${t}`);
      approx(p.loudness.clipper.maxDepthDb, intensityValue('clipperMaxDepthDb', t), 0.006, `clip depth @${t}`);
      const loudIn = suggestParams({ ...an, loudness: { ...an.loudness, integrated: -12 } }, { intensity: t, style: 'balanced' });
      approx(loudIn.glue.targetGrDb, Math.min(2, intensityValue('glueTargetGrDb', t)) * ds * 0.5, 0.006, `glue, input louder than target @${t}`);
      const hifi = suggestParams(quiet, { intensity: t, destination: 'hifi' });
      assert(hifi.glue.targetGrDb === 0 && hifi.multiband.bands.every((b) => b.targetGrDb === 0), `hi-fi keeps the macro-dynamics @${t}`);
      const loud = suggestParams(quiet, { intensity: t, destination: 'loud' });
      approx(loud.glue.targetGrDb, Math.min(2, intensityValue('glueTargetGrDb', t)), 0.006, `loud: full glue @${t}`);
      approx(p.loudness.budgetDb, intensityValue('limiterBudgetDb', t), 0.006, `budget @${t}`);
      approx(p.color.saturation.drive, intensityValue('saturationDrive', t), 0.006, `drive @${t}`);
      approx(p.loudness.clipper.amountDb, Math.min(2, intensityValue('clipperDb', t)), 0.006, `clip @${t}`);
      assert(p.loudness.minTargetLufs === null && loud.loudness.minTargetLufs === Math.min(loud.loudness.targetLufs, -11), `minTargetLufs @${t}`);
    }
    // midpoints interpolate linearly between the RESEARCH rows
    approx(intensityValue('glueRatio', 0.375), (INTENSITY_TABLE.glueRatio[1] + INTENSITY_TABLE.glueRatio[2]) / 2, 1e-9, 'midpoint');
    approx(intensityValue('glueRatio', 2), INTENSITY_TABLE.glueRatio[4], 1e-9, 'clamped');
    return 'ok';
  },

  'assistant: STYLES deltas scaled by intensity/0.5 with the RESEARCH §4 gates': async () => {
    const an = demoAnalysis(false); // full band, harsh index above the presence gate
    const at = (style, t, a = an) => suggestParams(a, { style, intensity: t, cleanup: 'off' });
    const warm = at('warm', 0.75);
    approx(warm.eq.tone.tiltDbPerOct, STYLES.warm.tiltDbPerOct * 1.5, 0.006, 'warm tilt × 1.5');
    approx(warm.eq.tone.lowShelfDb, 0.75 * 1.5, 0.006, 'warm low shelf');
    approx(warm.eq.tone.presenceDb, -0.5 * 1.5, 0.006, 'warm presence cut');
    approx(warm.color.saturation.drive, intensityValue('saturationDrive', 0.75) + 0.15 * 1.5, 0.006, 'warm drive');
    assert(warm.glue.releaseMs === 200, 'warm glue release');
    approx(warm.glue.ratio, intensityValue('glueRatio', 0.75) - 0.2 * 1.5, 0.006, 'warm glue ratio');
    // Punchy: no low shelf (it lifted the kick body more than its attack), no
    // glue attack override (it equalled the default), low band follows each kick with a
    // slow attack, mid band attacks slower, both with +0.6 dB of gain reduction
    const punchy = at('punchy', 0.5);
    const bal = at('balanced', 0.5);
    assert(punchy.eq.tone.lowShelfDb === 0 && punchy.glue.attackMs === bal.glue.attackMs && punchy.glue.releaseMs === 100, 'punchy glue timing / no low shelf');
    approx(punchy.multiband.bands[0].ratio, bal.multiband.bands[0].ratio + 0.3, 1e-9, 'punchy low-band ratio');
    const pb = punchy.multiband.bands;
    assert(pb[0].rmsMs === 15 && pb[0].attackMs === 40 && pb[0].releaseMs === 90 && pb[1].attackMs === 45 && pb[1].releaseMs === 70, 'punchy band timing');
    approx(pb[1].targetGrDb, bal.multiband.bands[1].targetGrDb + 0.6, 0.011, 'punchy mid-band GR + 0.6 dB');
    approx(pb[0].targetGrDb, bal.multiband.bands[0].targetGrDb + 0.6, 0.011, 'punchy low-band GR + 0.6 dB');
    approx(punchy.loudness.clipper.amountDb, bal.loudness.clipper.amountDb, 0.006, 'punchy: no extra clipping (it shaved the hits)');
    approx(punchy.eq.tone.mudDb, -0.5, 0.006, 'punchy extra mud cut');
    // Bright: a broad high shelf instead of the 1 kHz tilt pair (no sub cut)
    const bright = at('bright', 0.5);
    assert(!bright.color.saturation.enabled, 'bright: no saturation');
    approx(bright.stereo.width, 1.05, 1e-9, 'bright width +5 %');
    assert(bright.eq.tone.tiltDbPerOct === 0, 'bright: no tilt');
    approx(bright.eq.tone.highShelfDb, 1.2, 1e-9, 'bright high shelf');
    approx(bright.eq.tone.airDb, 1, 1e-9, 'bright air (f_c >= 17 kHz, no hash)');
    assert(bright.meta.styleTone.highShelfDb === 1.2 && bright.meta.styleTone.airDb === 1, `styleTone records the style's moves ${JSON.stringify(bright.meta.styleTone)}`);
    assert(bright.eq.tone.presenceDb === 0, 'no presence boost when the harsh index is above the gate');
    // gates: band-limited → no air shelf; already bright → no tilt / air; not harsh → presence
    const mod = (patch) => ({ ...an, ...patch, indices: { ...an.indices, ...(patch.indices || {}) }, spectrum: { ...an.spectrum, ...(patch.spectrum || {}) } });
    assert(at('bright', 0.5, mod({ spectrum: { hfCutoffHz: 16000 } })).eq.tone.airDb === 0, 'no air shelf below 17 kHz');
    const already = at('bright', 0.5, mod({ indices: { slope1to10k: -0.5 } }));
    assert(already.eq.tone.highShelfDb === 0 && already.eq.tone.airDb === 0, 'already bright: no shelf/air');
    assert(at('bright', 0.5, mod({ profile: 'brightened' })).eq.tone.airDb === 0, 'brightened: no air');
    approx(at('bright', 0.5, mod({ indices: { harsh: 0.2 } })).eq.tone.presenceDb, 0.75, 1e-9, 'presence when not harsh');
    assert(bal.eq.tone.tiltDbPerOct === 0 && bal.eq.tone.lowShelfDb === 0 && bal.eq.tone.highShelfDb === 0, 'balanced: auto-EQ only');
    return 'ok';
  },

  'assistant: cleanup k × detector gates (every module off below its gate)': async () => {
    const an = demoAnalysis(true);
    const quiet = { ...an, profile: 'fullband', indices: Object.fromEntries(Object.entries(an.indices).map(([k, v]) => [k, /Hz$/.test(k) ? v : k === 'air' ? 0 : -10])) };
    quiet.stereo = { ...an.stereo, bandCorrelation: [0.95, 0.9, 0.8, 0.7], sideToMidHfDb: -12 };
    const pq = suggestParams(quiet, { cleanup: 'strong' });
    for (const id of DYN_EQ_BAND_IDS) assert(!pq.dynEq.bands[id].enabled, `${id} off below its gate`);
    assert(!pq.spectral.deShimmer.enabled && !pq.spectral.denoise.enabled && !pq.color.air.enabled, 'spectral / air off');
    assert(pq.eq.tone.hashDb === 0 && pq.eq.tone.mudDb === 0 && pq.eq.tone.boomDb === 0, 'no static floors');
    const levels = {};
    for (const cl of ['off', 'light', 'medium', 'strong']) {
      const p = suggestParams(an, { cleanup: cl, style: 'balanced' });
      const k = CLEANUP_LEVELS[cl].k;
      const b = p.dynEq.bands;
      levels[cl] = p;
      if (k === 0) {
        assert(DYN_EQ_BAND_IDS.every((id) => !b[id].enabled) && !p.spectral.deShimmer.enabled && !p.spectral.denoise.enabled, 'off: no repairs');
        assert(p.prepare.highpassHz >= 25 && p.prepare.dcBlock, 'off: DC + HPF still run');
        continue;
      }
      assert(b.mud.enabled && b.harsh.enabled && b.deEss.enabled, `${cl}: mud / harsh / de-ess fire on the demo`);
      approx(b.harsh.freq, an.indices.harshHz, 1, 'harsh at the detected peak');
      approx(b.mud.freq, an.indices.mudHz, 1, 'mud at the detected peak');
      // static floor at half the maximum, total capped at −4 dB
      const mudCut = Math.min(4, 2.5 * k);
      approx(-p.eq.tone.mudDb, mudCut / 2, 0.011, `${cl} mud floor`);
      assert(-p.eq.tone.mudDb + b.mud.maxCutDb <= 4.001, `${cl} mud total <= 4 dB`);
      approx(-p.eq.tone.presenceDb, Math.min(4, 2.5 * k) / 2, 0.011, `${cl} harsh floor on the presence bell`);
      approx(p.eq.tone.presenceHz, an.indices.harshHz, 1, 'harsh floor frequency');
      approx(b.deEss.maxCutDb, Math.min(6, 4 * k), 0.011, `${cl} de-ess max`);
      assert(b.deEss.channel === 'mid', 'de-ess on the mid channel');
      approx(p.spectral.deShimmer.amount, 0.5 * k, 0.011, `${cl} de-shimmer amount`);
      approx(p.spectral.denoise.amount, CLEANUP_LEVELS[cl].denoiseMaxDb / 12, 0.011, `${cl} denoise amount`);
      assert(p.spectral.deShimmer.enabled && p.spectral.denoise.enabled, 'shimmer / hiss gates fire on the demo');
    }
    assert(levels.strong.dynEq.bands.harsh.maxCutDb + -levels.strong.eq.tone.presenceDb <= 4.001, 'harsh total <= 4 dB');
    // hash shelf only when the band exists; air exciter on band-limited, clean HF
    const hashy = { ...an, indices: { ...an.indices, hash: 2, hiss: -5 } };
    approx(suggestParams(hashy, {}).eq.tone.hashDb, -1.5, 1e-9, 'hash shelf −1.5 × k');
    assert(suggestParams({ ...hashy, spectrum: { ...an.spectrum, hfCutoffHz: 16000 } }, {}).eq.tone.hashDb === 0, 'no hash shelf below 17 kHz');
    const legacy = { ...an, profile: 'legacy', spectrum: { ...an.spectrum, hfCutoffHz: 12000 }, indices: { ...an.indices, hiss: -5, hash: -5 } };
    const pl = suggestParams(legacy, { cleanup: 'strong' });
    assert(pl.color.air.enabled && pl.color.air.fromHz === 12000 && Math.abs(pl.color.air.amount - 0.75) < 1e-9, 'legacy: exciter from f_c, amount 0.5 × k');
    assert(!suggestParams({ ...legacy, profile: 'brightened' }, {}).color.air.enabled, 'no exciter on brightened');
    assert(!suggestParams(legacy, { cleanup: 'off' }).color.air.enabled, 'no exciter with cleanup off');
    const bri = suggestParams({ ...an, profile: 'brightened', indices: { ...an.indices, fizz: -5 } }, {});
    assert(bri.dynEq.bands.fizz.enabled, 'fizz fires on the brightened profile');
    return 'ok';
  },

  'assistant: mono bass, near-mono width, highpass, crushed / low-crest / louder-than-target rules': async () => {
    const an = demoAnalysis(false);
    const withSt = (st, extra = {}) => ({ ...an, ...extra, stereo: { ...an.stereo, ...st } });
    const mono = (a, cl) => suggestParams(a, { cleanup: cl }).stereo.monoBassHz;
    assert(mono(withSt({ bandCorrelation: [0.95, 0.9, 0.8, 0.7] }), 'off') === 0, 'off + correlated → none');
    assert(mono(withSt({ bandCorrelation: [0.6, 0.9, 0.8, 0.7] }), 'off') === 100, 'forced below 0.7 even when off');
    assert(mono(withSt({ bandCorrelation: [0.4, 0.9, 0.8, 0.7] }), 'off') === 150, '< 0.5 → 150 Hz');
    assert(mono(withSt({ bandCorrelation: [0.95, 0.9, 0.8, 0.7] }), 'light') === 80, 'light 80');
    assert(mono(withSt({ bandCorrelation: [0.95, 0.9, 0.8, 0.7] }), 'medium') === 100, 'medium 100');
    assert(mono(withSt({ bandCorrelation: [0.95, 0.9, 0.8, 0.7] }), 'strong') === 120, 'strong 120');
    assert(mono(withSt({ bandCorrelation: [0.45, 0.9, 0.8, 0.7] }), 'light') === 150, 'light + < 0.5 → 150');
    assert(mono(withSt({ bandCorrelation: [0.99, 0.99, 0.99, 0.99], nearMono: true }), 'strong') === 80, 'near-mono → 80');
    for (const [t, w] of [[0.25, 1.05], [0.5, 1.1], [0.75, 1.15]]) {
      const p = suggestParams(withSt({ nearMono: true, bandCorrelation: [1, 1, 1, 1] }), { intensity: t, style: 'balanced' });
      approx(p.stereo.width, w, 1e-9, `near-mono width @${t}`);
      assert(p.stereo.widthFromHz === 1500, 'width above 1.5 kHz only');
    }
    const rum = suggestParams({ ...an, indices: { ...an.indices, rumble: 9 } }, {});
    assert(rum.prepare.highpassHz >= 30 && rum.prepare.highpassHz <= 35, `rumble → ${rum.prepare.highpassHz} Hz`);
    assert(suggestParams({ ...an, indices: { ...an.indices, rumble: 40 } }, {}).prepare.highpassHz <= 35, 'never above 35 Hz (40 max)');
    const base = suggestParams(an, { intensity: 0.75 });
    const crushed = suggestParams({ ...an, loudness: { ...an.loudness, plr: 6, lra: 2 } }, { intensity: 0.75 });
    approx(crushed.multiband.bands[0].targetGrDb, base.multiband.bands[0].targetGrDb / 2, 0.011, 'crushed: half multiband');
    approx(crushed.glue.targetGrDb, base.glue.targetGrDb / 2, 0.011, 'crushed: half glue');
    assert(!crushed.loudness.clipper.enabled, 'crushed: no clipper');
    const lowCrest = suggestParams({ ...an, crestDb: 8 }, { intensity: 0.75 });
    approx(lowCrest.glue.ratio, base.glue.ratio - 0.3, 0.011, 'low crest: glue ratio −0.3');
    const loudIn = suggestParams({ ...an, loudness: { ...an.loudness, integrated: -9, truePeakDb: -8 } }, { intensity: 0.75 });
    assert(!loudIn.loudness.clipper.enabled, 'input louder than target with headroom: gain reduction only');
    const loudPeaky = suggestParams({ ...an, loudness: { ...an.loudness, integrated: -9, truePeakDb: 0.5 } }, { destination: 'loud', intensity: 0.75 });
    assert(loudPeaky.loudness.clipper.enabled, 'louder than the −9 target but peaking: clipper stays');
    assert(base.finish.fadeInMs === 5 && base.finish.fadeOutMs === 30, 'fades 5 / 30 ms (abrupt end only reported)');
    assert(suggestParams(demoAnalysis(true), {}).finish.fadeOutMs === 30, 'abrupt end does not auto-enable a long fade');
    return 'ok';
  },

  'assistant: reference → match EQ; robust to missing analysis': async () => {
    const an = demoAnalysis(false);
    const ref = { ltas: REFERENCE_LTAS.map((v) => v - 30), name: 'Ref', loudness: -9 };
    const p = suggestParams(an, { reference: ref });
    assert(p.eq.match.enabled && p.eq.match.referenceName === 'Ref' && p.eq.match.strength === 0.5, 'match on at 50 %');
    assert(p.eq.match.referenceLtas.length === 31, 'reference LTAS');
    assert(!suggestParams(an, { reference: { ltas: [1, 2, 3] } }).eq.match.enabled, 'invalid reference ignored');
    for (const a of [null, undefined, {}, { indices: {} }]) {
      const q = suggestParams(a, { destination: 'loud', style: 'warm', intensity: 2, cleanup: 'bogus' });
      assert(JSON.stringify(validateParams(q)) === JSON.stringify(q), 'validated params');
      assert(DYN_EQ_BAND_IDS.every((id) => !q.dynEq.bands[id].enabled), 'no detector → no repairs');
      assert(describeDecisions(a, q).length > 0, 'decisions');
    }
    return 'ok';
  },

  'params: meta.userOwned survives validation as unique strings (C1)': async () => {
    const many = Array.from({ length: 300 }, (_, i) => `p.${i}`);
    const p = validateParams({ meta: { userOwned: ['eq.tone.mudDb', 'eq.tone.mudDb', 42, null, '', 'x'.repeat(201), ...many], style: 'warm' } });
    const uo = p.meta.userOwned;
    assert(uo[0] === 'eq.tone.mudDb' && uo.filter((v) => v === 'eq.tone.mudDb').length === 1, 'unique, order kept');
    assert(uo.length === 200 && uo.every((v) => typeof v === 'string' && v.length > 0), `max 200 strings (${uo.length})`);
    assert(p.meta.style === 'warm', 'other meta kept');
    assert(JSON.stringify(validateParams({ meta: { userOwned: 'eq.tone.mudDb' } }).meta.userOwned) === '[]', 'non-array → []');
    assert(!('userOwned' in validateParams({ meta: {} }).meta) && validateParams({ meta: 5 }).meta === undefined, 'absent stays absent');
    assert(JSON.stringify(validateParams(p)) === JSON.stringify(p), 'idempotent');
    assert(isUserOwned(p, 'eq.tone.mudDb') && isUserOwned(p, 'eq.tone') && isUserOwned(p, 'eq.tone.mudDb.x') && !isUserOwned(p, 'eq.tone.boomDb'), 'ownership by path, parent or child');
    assert(!isUserOwned(defaultParams(), 'eq.tone.mudDb'), 'no meta → nothing user-owned');
    // the assistant ignores it: same suggestion whatever the UI owns
    const an = demoAnalysis(true);
    assert(suggestParams(an, {}).meta.userOwned === undefined, 'assistant adds no userOwned');
    return `${uo.length} paths kept`;
  },

  'assistant: describeDecisions describes what actually ran': async () => {
    const { report: r, analysis: an } = await renderDemo({});
    const real = r.paramsUsed.meta.realised;
    assert(real && Number.isFinite(real.autoEqDb) && Number.isFinite(real.multibandGrDb), `meta.realised ${JSON.stringify(real)}`);
    let pk = 0;
    for (const v of r.eqAutoDb) if (Math.abs(v) > Math.abs(pk)) pk = v;
    const d = describeDecisions(an, r.paramsUsed);
    const auto = d.find((x) => x.key === 'dec.autoEq');
    if (Math.abs(pk) >= 0.3) approx(auto.vars.db, pk, 0.011, 'auto EQ line = the applied curve (sign included)');
    else assert(!auto, 'no auto EQ line when the applied curve is flat');
    const mb = d.find((x) => x.key === 'dec.multiband');
    if (mb) approx(mb.vars.db, real.multibandGrDb, 0.011, 'multiband line = realised loud-section GR');
    const gl = d.find((x) => x.key === 'dec.glue');
    if (gl) approx(gl.vars.db, r.glue.grLoudAvgDb, 0.011, 'glue line = realised GR');
    // a Club master that settled lower says so
    const club = await renderDemo({ destination: 'club' });
    const lc = describeDecisions(an, club.report.paramsUsed).find((x) => x.key === 'dec.loudness');
    approx(lc.vars.lufs, club.report.effectiveTargetLufs, 0.051, 'loudness line = the level rendered to');
    // without a report (plain params) the lines still come from the parameters
    const plain = describeDecisions(an, suggestParams(an, {}));
    assert(plain.some((x) => x.key === 'dec.multiband'), 'fallback from params');
    return d.map((x) => `${x.key.slice(4)}${x.vars.db !== undefined ? ` ${x.vars.db}` : ''}`).join(', ');
  },

  'assistant: describeDecisions keys/vars per §10, chain order, only what is applied': async () => {
    const ORDER = ['dec.profile', 'dec.highpass', 'dec.trim', 'dec.deShimmer', 'dec.denoise', 'dec.autoEq', 'dec.match', 'dec.tone', 'dec.hash',
      'dec.mud', 'dec.boom', 'dec.harsh', 'dec.fizz', 'dec.deEss', 'dec.sideHf', 'dec.saturation', 'dec.air', 'dec.multiband', 'dec.monoBass',
      'dec.width', 'dec.glue', 'dec.loudness', 'dec.fadeOut'];
    const VARS = {
      'dec.highpass': ['hz'], 'dec.deShimmer': ['pct', 'hz'], 'dec.denoise': ['db', 'hz'], 'dec.mud': ['db', 'hz'], 'dec.boom': ['db', 'hz'],
      'dec.harsh': ['db', 'hz'], 'dec.fizz': ['db', 'hz'], 'dec.deEss': ['db', 'hz'], 'dec.sideHf': ['db'], 'dec.hash': ['db'], 'dec.autoEq': ['db'],
      'dec.match': ['name', 'pct'], 'dec.tone': ['style'], 'dec.saturation': ['pct'], 'dec.air': ['pct'], 'dec.multiband': ['db'],
      'dec.monoBass': ['hz'], 'dec.width': ['pct'], 'dec.glue': ['db'], 'dec.loudness': ['lufs', 'ceiling', 'dest'], 'dec.fadeOut': ['sec'],
      'dec.trim': [], 'dec.profile': ['profile'],
    };
    const an = demoAnalysis(true);
    const check = (p, label) => {
      const d = describeDecisions(an, p);
      let last = -1;
      for (const { key, vars } of d) {
        const idx = ORDER.indexOf(key);
        assert(idx >= 0, `${label}: unknown key ${key}`);
        assert(idx >= last, `${label}: ${key} out of chain order`);
        last = idx;
        for (const v of VARS[key]) assert(vars[v] !== undefined && vars[v] !== null, `${label}: ${key} missing ${v}`);
        if (vars.pct !== undefined) assert(Number.isInteger(vars.pct), `${key} pct integer`);
        if (vars.db !== undefined) assert(Number.isFinite(vars.db), `${key} db`);
      }
      return d;
    };
    const p = suggestParams(an, { style: 'warm', destination: 'loud' });
    const d = check(p, 'warm/loud');
    const keys = d.map((x) => x.key);
    for (const k of ['dec.highpass', 'dec.deShimmer', 'dec.denoise', 'dec.mud', 'dec.harsh', 'dec.deEss', 'dec.monoBass', 'dec.tone', 'dec.loudness']) assert(keys.includes(k), `expected ${k}`);
    assert(d.find((x) => x.key === 'dec.loudness').vars.dest === 'loud' && d.find((x) => x.key === 'dec.tone').vars.style === 'warm', 'ids as vars');
    // disabling modules removes their lines; a long fade-out appears when set
    const q = JSON.parse(JSON.stringify(p));
    q.spectral.deShimmer.enabled = false;
    q.dynEq.bands.mud.enabled = false;
    q.eq.tone.mudDb = 0;
    q.finish.fadeOutMs = 2500;
    q.stereo.monoBassHz = 0;
    const k2 = check(validateParams(q), 'modified').map((x) => x.key);
    assert(!k2.includes('dec.deShimmer') && !k2.includes('dec.mud') && !k2.includes('dec.monoBass'), 'removed lines');
    assert(k2.includes('dec.fadeOut'), 'fade-out line');
    check(suggestParams(an, { cleanup: 'off', style: 'bright', reference: { ltas: REFERENCE_LTAS, name: 'X' } }), 'bright/ref');
    return `${d.length} decisions: ${keys.join(', ')}`;
  },

  // ================================================================ chain

  'chain: every destination reaches its LUFS (±0.3 LU) under its ceiling (own meters + ffmpeg)': async () => {
    const rows = [];
    for (const dest of DESTINATION_IDS) {
      const { audio, report: r, params } = await renderDemo({ destination: dest });
      const C = params.loudness.ceilingDb;
      // Loud / Club may settle below the target, inside their range, rather than clip
      // deeper than clipper.maxDepthDb or limit past the budget: the master then
      // hits that effective target
      const T = r.effectiveTargetLufs;
      const lo = params.loudness.minTargetLufs ?? params.loudness.targetLufs;
      assert(T <= params.loudness.targetLufs + 1e-9 && T >= lo - 0.11, `${dest} effective target ${T} outside [${lo}, ${params.loudness.targetLufs}]`);
      approx(r.loudness.integrated, T, 0.3, `${dest} LUFS`);
      if (T === params.loudness.targetLufs) assert(r.targetReached, `${dest} targetReached`);
      assert(-r.clipper.grMaxDb <= params.loudness.clipper.maxDepthDb + 0.05, `${dest} clip depth ${r.clipper.grMaxDb} > ${params.loudness.clipper.maxDepthDb}`);
      const meter = truePeakDb(audio.channels, audio.sampleRate);
      const cons = measureTruePeakDb(audio.channels, audio.sampleRate, { conservative: true });
      assert(r.loudness.truePeakDb <= C + 1e-6 && meter <= C + 1e-6 && cons <= C + 1e-6, `${dest} TP ${r.loudness.truePeakDb} / ${meter} / ${cons} > ${C}`);
      assert(!hasNaN(audio.channels), `${dest} NaN`);
      const ff = ffmpegCheck(audio, dest);
      if (ff) {
        approx(ff.integrated, T, 0.3, `${dest} ffmpeg LUFS`);
        assert(ff.truePeakDb <= C + 0.05, `${dest} ffmpeg TP ${ff.truePeakDb} > ${C}`); // ffmpeg prints 1 decimal
      }
      rows.push(`${dest} ${r.loudness.integrated.toFixed(2)}/${params.loudness.targetLufs}${T !== params.loudness.targetLufs ? `→${T}` : ''} TP ${r.loudness.truePeakDb.toFixed(2)}${ff ? ` ff ${ff.integrated}/${ff.truePeakDb}` : ''} lim ${r.limiter.grMaxDb.toFixed(1)} clip ${r.clipper.grMaxDb.toFixed(1)} (${r.loudnessPasses}p)`);
    }
    return rows.join(' | ');
  },

  'chain: length preserved, time-aligned (bestLag 0), no NaN, input untouched': async () => {
    const a = demo(true, 32);
    const before = a.channels.map((c) => c.slice(0, 1000));
    const { audio, report } = await renderDemo({});
    assert(audio.channels.length === 2 && audio.channels[0].length === a.channels[0].length && audio.channels[1].length === a.channels[1].length, 'length');
    assert(audio.sampleRate === SR && report.sampleRate === SR, 'rate');
    assertFinite(audio.channels);
    for (let c = 0; c < 2; c++) for (let i = 0; i < 1000; i++) assert(a.channels[c][i] === before[c][i], 'input modified');
    const s = 6 * SR, e = s + 2 * SR;
    const mid = (ch) => Float32Array.from({ length: e - s }, (_, i) => ch[0][s + i] + ch[1][s + i]);
    const lag = bestLag(mid(a.channels), mid(audio.channels), 512);
    assert(lag === 0, `bestLag ${lag}`);
    // high band too (no bulk delay anywhere in the chain)
    const hp = (x) => {
      const y = [Float32Array.from(x), Float32Array.from(x)];
      processStereoInPlace(y, butterworth('highpass', 4, 2000, SR));
      return y[0];
    };
    const lagHf = bestLag(hp(mid(a.channels)), hp(mid(audio.channels)), 64);
    assert(Math.abs(lagHf) <= 1, `HF bestLag ${lagHf}`);
    // fades: starts and ends at (near) zero
    assert(Math.abs(audio.channels[0][0]) < 1e-6 && Math.abs(audio.channels[0][audio.channels[0].length - 1]) < 1e-6, 'edge fades');
    return `bestLag ${lag}, HF lag ${lagHf}`;
  },

  'chain: trim cuts leading/trailing silence exactly; output rate conversion': async () => {
    // sharp edges: 1.5 s silence + 6 s noise + 2 s silence → [1.4 s, 8.3 s) exactly
    const lead = Math.round(1.5 * SR), body = 6 * SR, tail = 2 * SR;
    const mk = (seed) => { const o = new Float32Array(lead + body + tail); o.set(pinkNoise(6, SR, 0.3, seed), lead); return o; };
    const sharp = { sampleRate: SR, channels: [mk(41), mk(42)] };
    const ps = suggestParams(analyzeTrack(sharp), {});
    assert(ps.trim.enabled, 'trim enabled for > 0.5 s silence');
    const rs = await renderMaster(sharp, ps, {});
    const keepS = Math.round(0.1 * SR), keepE = Math.round(0.8 * SR);
    approx(rs.report.trim.startSample, lead - keepS, 1, 'start = onset − 100 ms');
    approx(rs.report.trim.endSample, lead + body + keepE, 1, 'end = last sample + 800 ms');
    assert(rs.audio.channels[0].length === rs.report.trim.endSample - rs.report.trim.startSample, 'output length = trimmed range');
    approx(rs.report.loudness.integrated, -14, 0.3, 'LUFS after trim');
    // the demo (slow edges): same rule on the source samples
    const d = demo(false, 32);
    const padded = { sampleRate: SR, channels: d.channels.map((c) => { const o = new Float32Array(c.length + lead + tail); o.set(c, lead); return o; }) };
    const p = suggestParams(analyzeTrack(padded), {});
    const { audio, report } = await renderMaster(padded, p, {});
    const raw = trimBounds(padded.channels, SR, p.trim);
    assert(report.trim.endSample - report.trim.startSample === audio.channels[0].length, 'demo: output length = trimmed range');
    assert(report.trim.startSample === raw.start && report.trim.endSample === raw.end, `demo bounds ${report.trim.startSample}/${report.trim.endSample} vs ${raw.start}/${raw.end}`);
    // explicit output rate (UI-owned): 48 k → 44.1 k
    const p44 = validateParams({ ...suggestParams(demoAnalysis(true), {}), output: { sampleRate: 44100 } });
    const r44 = await renderMaster(demo(true), p44, {});
    approx(r44.audio.channels[0].length, Math.round((demo(true).channels[0].length * 44100) / SR), 1, '44.1 k length');
    assert(r44.audio.sampleRate === 44100, '44.1 k rate');
    approx(r44.report.loudness.integrated, -14, 0.3, '44.1 k LUFS');
    assert(truePeakDb(r44.audio.channels, 44100) <= -1 + 1e-6, '44.1 k TP');
    return `sharp: ${sharp.channels[0].length} → ${rs.audio.channels[0].length} samples (exact); demo ${padded.channels[0].length} → ${audio.channels[0].length}; 44.1 k: ${dbgReport(r44.report)}`;
  },

  'chain: each demo defect measurably reduced, 8–16 kHz kept (≤ 3 dB drop)': async () => {
    const a = demo(true);
    const { audio, analysis: an } = await renderDemo({});
    const m = analyzeTrack(audio);
    const pa = midPsd(a.channels, SR), pm = midPsd(audio.channels, SR);
    // 3.3 kHz resonance: level re its neighbourhood (1/6 octave vs ±1 octave)
    const res = (p) => psdBand(p, 3100, 3500) - 0.5 * (psdBand(p, 1650, 1850) + psdBand(p, 6200, 7000)) - 10 * Math.log10(400 / 600);
    const dRes = res(pm) - res(pa);
    assert(dRes < -1, `3.3 kHz resonance change ${dRes.toFixed(2)} dB`);
    assert(m.indices.harsh < an.indices.harsh - 0.8, `harsh index ${an.indices.harsh} → ${m.indices.harsh}`);
    // 300 Hz mud: 200–450 Hz re 100–150 Hz and 1–2 kHz
    const mud = (p) => psdBand(p, 200, 450) - 0.5 * (psdBand(p, 100, 150) + psdBand(p, 1000, 2000));
    const dMud = mud(pm) - mud(pa);
    assert(dMud < -1, `mud change ${dMud.toFixed(2)} dB`);
    assert(m.indices.mud < an.indices.mud - 1, `mud index ${an.indices.mud} → ${m.indices.mud}`);
    // HF flicker: shimmer partial energy re the rest of 7–14 kHz
    const dShim = partialRatioDb(audio.channels, SR) - partialRatioDb(a.channels, SR);
    assert(dShim < -0.5, `shimmer partials ${dShim.toFixed(2)} dB`);
    // DC removed, lows correlated, hiss lower
    assert(Math.max(Math.abs(m.dcOffset[0]), Math.abs(m.dcOffset[1])) < 1e-4, `DC ${m.dcOffset}`);
    assert(m.stereo.bandCorrelation[0] > 0.9, `low-band correlation ${an.stereo.bandCorrelation[0]} → ${m.stereo.bandCorrelation[0]}`);
    assert(m.indices.hiss < an.indices.hiss, `hiss ${an.indices.hiss} → ${m.indices.hiss}`);
    // the top end is not dulled
    const dHf = hfBalance(m.spectrum.ltas) - hfBalance(an.spectrum.ltas);
    assert(dHf > -3, `8–16 kHz balance ${dHf.toFixed(2)} dB`);
    const top = psdBand(pm, 8000, 16000) - psdBand(pm, 200, 4000) - (psdBand(pa, 8000, 16000) - psdBand(pa, 200, 4000));
    assert(top > -3, `8–16 kHz re 200 Hz–4 kHz ${top.toFixed(2)} dB`);
    return `resonance ${dRes.toFixed(2)} dB, mud ${dMud.toFixed(2)} dB, shimmer partials ${dShim.toFixed(2)} dB, DC ${m.dcOffset.map((v) => v.toExponential(1))}, r<120 ${an.stereo.bandCorrelation[0]}→${m.stereo.bandCorrelation[0]}, hiss ${an.indices.hiss}→${m.indices.hiss}, 8–16 kHz ${dHf.toFixed(2)} dB`;
  },

  'chain: warm darker / bright brighter than balanced': async () => {
    const out = {};
    for (const style of ['balanced', 'warm', 'bright']) {
      const { audio } = await renderDemo({ style }, { defects: false });
      const p = midPsd(audio.channels, SR);
      out[style] = psdBand(p, 6000, 16000) - psdBand(p, 100, 1000);
    }
    assert(out.warm < out.balanced - 0.5, `warm ${out.warm.toFixed(2)} vs balanced ${out.balanced.toFixed(2)}`);
    assert(out.bright > out.balanced + 0.5, `bright ${out.bright.toFixed(2)} vs balanced ${out.balanced.toFixed(2)}`);
    return `HF re LF: warm ${out.warm.toFixed(2)} < balanced ${out.balanced.toFixed(2)} < bright ${out.bright.toFixed(2)} dB`;
  },

  'chain: intensity monotonically lowers PLR': async () => {
    // Loud / Club: intensity raises the target and the peak work (clipper, limiter budget)
    // → lower PLR. Since the clip depth is capped a dense track can saturate near
    // its loudest clean level, so High may end barely louder than Medium: non-increasing
    // per step, strictly lower from Low to High. Streaming (fixed −14 / −1): the limiter
    // pins PLR at C − T once the peaks reach the ceiling, so it cannot rise with intensity.
    const rows = [];
    for (const defects of [true, false]) {
      for (const dest of ['loud', 'club', 'streaming']) {
        const plr = [];
        for (const t of [0.25, 0.5, 0.75]) {
          const { report } = await renderDemo({ destination: dest, intensity: t }, { defects });
          plr.push(plrOf(report.loudness));
        }
        const tag = `${dest} (${defects ? 'defects' : 'clean'}) PLR ${plr.map((v) => v.toFixed(2))}`;
        if (dest === 'streaming') {
          if (!defects) assert(plr[1] <= plr[0] + 0.05 && plr[2] <= plr[1] + 0.05, tag);
          assert(plr.every((v) => v <= -1 - -14 + 0.05), `${tag}: PLR <= C − T`);
        } else assert(plr[0] > plr[2] + 0.2 && plr[1] <= plr[0] + 0.02 && plr[2] <= plr[1] + 0.02, tag);
        rows.push(`${defects ? 'D' : 'C'}/${dest} ${plr.map((v) => v.toFixed(2)).join(' → ')}`);
      }
    }
    return rows.join(' | ');
  },

  'chain: cache — loudness-only re-render >= 2× faster, spectral cache reused': async () => {
    const a = demo(true);
    const an = demoAnalysis(true);
    const cache = {};
    const p = suggestParams(an, {});
    const t1 = performance.now();
    const r1 = await renderMaster(a, p, { cache, inputInfo: inputInfoOf(an) });
    const full = performance.now() - t1;
    const p2 = validateParams({ ...p, loudness: { ...p.loudness, targetLufs: -12, ceilingDb: -1.5 } });
    const t2 = performance.now();
    const r2 = await renderMaster(a, p2, { cache, inputInfo: inputInfoOf(an) });
    const loudOnly = performance.now() - t2;
    assert(!('glue' in r2.report.timingsMs) && !('spectral' in r2.report.timingsMs), `stages 1–9 skipped: ${Object.keys(r2.report.timingsMs)}`);
    assert(full / loudOnly >= 2, `loudness-only ${loudOnly.toFixed(0)} ms vs full ${full.toFixed(0)} ms`);
    approx(r2.report.loudness.integrated, -12, 0.3, 'new target');
    assert(r2.report.loudness.truePeakDb <= -1.5 + 1e-6, 'new ceiling');
    const p3 = validateParams({ ...p, eq: { ...p.eq, tone: { ...p.eq.tone, lowShelfDb: 1.5 } } });
    const t3 = performance.now();
    const r3 = await renderMaster(a, p3, { cache, inputInfo: inputInfoOf(an) });
    const eqOnly = performance.now() - t3;
    assert(!('spectral' in r3.report.timingsMs) && 'eq' in r3.report.timingsMs, 'cache A reused (no spectral stage)');
    // identical params → identical output (cache does not alter results)
    const r4 = await renderMaster(a, p, { cache, inputInfo: inputInfoOf(an) });
    let maxd = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < r1.audio.channels[c].length; i += 7) maxd = Math.max(maxd, Math.abs(r1.audio.channels[c][i] - r4.audio.channels[c][i]));
    assert(maxd < 1e-6, `cached render differs by ${maxd}`);
    return `full ${full.toFixed(0)} ms, loudness-only ${loudOnly.toFixed(0)} ms (${(full / loudOnly).toFixed(1)}×), EQ change (cache A) ${eqOnly.toFixed(0)} ms`;
  },

  'chain: cancellation at stage boundaries, progress per stage': async () => {
    const a = demo(true, 12);
    const p = suggestParams(analyzeTrack(a), {});
    const seen = [];
    let n = 0;
    let err = null;
    try {
      await renderMaster(a, p, { onProgress: (stage, f) => seen.push([stage, f]), isCancelled: () => ++n > 3 });
    } catch (e) {
      err = e;
    }
    assert(err && err.code === 'cancelled', `expected cancelled, got ${err && err.message}`);
    assert(!seen.some(([s]) => s === 'loudness'), 'stopped before the loudness stage');
    const prog = [];
    const { report } = await renderMaster(a, p, { onProgress: (stage, f) => prog.push([stage, f]) });
    const order = [...new Set(prog.map(([s]) => s))];
    assert(JSON.stringify(order) === JSON.stringify(STAGES), `stage order ${order}`);
    assert(prog.every(([, f]) => f >= 0 && f <= 1), 'fractions 0..1');
    for (const st of ['prepare', 'spectral', 'eq', 'dyneq', 'multiband', 'glue', 'loudness', 'verify']) assert(Number.isFinite(report.timingsMs[st]), `timing ${st}`);
    return `cancelled after ${seen.length} progress events; stages ${order.join('→')}`;
  },

  'chain: QC rollback softens the responsible module (EQ range, width, HF loss)': async () => {
    const a = demo(false, 16);
    const an = analyzeTrack(a);
    const base = suggestParams(an, {});
    // 1. an extreme tone tilt exceeds ±4 dB per third-octave → tone halved then disabled
    const p1 = validateParams({ ...base, eq: { ...base.eq, tone: { ...base.eq.tone, tiltDbPerOct: -2.5 } } });
    const r1 = (await renderMaster(a, p1, {})).report;
    assert(r1.qc.rollbacks.includes('tone') && r1.warnings.some((w) => w.id === 'warn.qcRollback' && w.vars.module === 'tone'), `tone rollback ${JSON.stringify(r1.qc)}`);
    assert(Math.abs(r1.paramsUsed.eq.tone.tiltDbPerOct) < 2.5, 'paramsUsed reflects the rollback');
    assert(r1.eqCurveDb.every((v) => Math.abs(v) <= 4.05) && r1.qc.passed, 'net EQ within ±4 dB after rollback');
    // 2. anti-phase highs widened → width reverted
    const L = pinkNoise(8, SR, 0.3, 31), R = pinkNoise(8, SR, 0.3, 32);
    const hiS = [Float32Array.from(L), Float32Array.from(R)];
    processStereoInPlace(hiS, butterworth('highpass', 4, 3000, SR));
    for (let i = 0; i < L.length; i++) {
      R[i] = 0.7 * L[i] - 1.2 * hiS[0][i];
      L[i] = 0.7 * L[i] + 1.2 * hiS[0][i];
    }
    const wide = { sampleRate: SR, channels: [L, R] };
    const p2 = validateParams({ ...suggestParams(analyzeTrack(wide), {}), stereo: { enabled: true, width: 1.5, widthFromHz: 1500, monoBassHz: 100 } });
    const r2 = (await renderMaster(wide, p2, {})).report;
    if (r2.correlation < 0.2 || r2.bandCorrelation.some((v) => v < 0) || r2.qc.rollbacks.length) {
      assert(r2.qc.rollbacks.includes('width'), `width rollback ${JSON.stringify(r2.qc)} corr ${r2.correlation} ${r2.bandCorrelation}`);
      assert(r2.paramsUsed.stereo.width < 1.5, 'width softened');
    }
    // 3. heavy denoise on noise-like music → 8–16 kHz loss → denoise softened
    const noisy = shapedNoise(REFERENCE_LTAS, 8);
    const p3 = validateParams({ ...suggestParams(analyzeTrack(noisy), {}), spectral: { deShimmer: { enabled: false }, denoise: { enabled: true, amount: 1, fromHz: 2000 } } });
    const r3 = (await renderMaster(noisy, p3, {})).report;
    if (r3.qc.rollbacks.length || r3.qc.failures.length) assert(r3.qc.rollbacks.includes('denoise'), `denoise rollback ${JSON.stringify(r3.qc)}`);
    return `tone: ${r1.qc.rollbacks.join(',')}; width: ${r2.qc.rollbacks.join(',') || 'none needed'} (corr ${r2.correlation}); denoise: ${r3.qc.rollbacks.join(',') || 'none needed'}`;
  },

  'chain: macro-dynamics kept — Streaming loses ≈ only its chorus GR, Hi-Fi ≥ −0.4 LU; sub not ducked': async () => {
    // The verse / chorus song (6 dB apart, LRA ≈ 6.3) is harsher than the real Suno set
    // (ΔLRA −0.1 … −0.9 LU at Streaming, docs/RESEARCH.md §1): a section that is compressed
    // and one that is not differ by the gain reduction, so the LRA loss ≈ the choruses' GR
    // (0.6 dB multiband + 0.6 dB glue ≈ −1.3 LU). The old all-window threshold made the
    // choruses take several dB: −3.4 LU on this song.
    const { audio } = once('song', () => song());
    const an = once('song-an', () => analyzeTrack(audio));
    const inLra = measure(audio.channels, SR).lra;
    const rows = [];
    const cache = {};
    const lra = {};
    for (const dest of ['streaming', 'hifi', 'loud']) {
      const p = suggestParams(an, { destination: dest });
      const { audio: out, report } = await renderMaster(audio, p, { cache, inputInfo: inputInfoOf(an) });
      lra[dest] = report.loudness.lra - inLra;
      const low = bandChangeDb(audio, out, 28, 71);
      rows.push(`${dest} ΔLRA ${lra[dest].toFixed(2)} LU, Δ31–63 Hz ${low.toFixed(2)} dB, mb ${report.multiband.map((b) => b.grLoudAvgDb).join('/')}, glue ${report.glue.grLoudAvgDb}, lim ${report.limiter.grAvgDb}/${report.limiter.grMaxDb}, clip ${report.clipper.grMaxDb}`);
      if (dest !== 'loud') assert(low > -0.7, `${dest}: 31–63 Hz ${low.toFixed(2)} dB (sub ducked)`);
      // realised loud-section GR follows the (destination-scaled) targets
      p.multiband.bands.forEach((b, i) => {
        if (b.targetGrDb > 0) approx(-report.multiband[i].grLoudAvgDb, b.targetGrDb, 0.12, `${dest} band ${i} realised GR`);
      });
      if (p.glue.targetGrDb > 0) approx(-report.glue.grLoudAvgDb, p.glue.targetGrDb, 0.12, `${dest} glue realised GR`);
    }
    assert(lra.streaming >= -1.6, `streaming ΔLRA ${lra.streaming.toFixed(2)}`);
    assert(lra.hifi >= -0.4, `hi-fi ΔLRA ${lra.hifi.toFixed(2)}`);
    assert(lra.hifi >= lra.streaming - 0.05 && lra.streaming >= lra.loud - 0.05, 'Hi-Fi ≥ Streaming ≥ Loud in dynamics');
    return `input LRA ${inLra.toFixed(1)}; ${rows.join(' | ')}`;
  },

  'chain: Punchy hits harder than Balanced, Bright keeps the sub': async () => {
    const { audio, kicks } = once('song', () => song());
    const an = once('song-an', () => analyzeTrack(audio));
    const cache = {};
    const out = {};
    for (const style of ['balanced', 'punchy', 'bright']) {
      out[style] = (await renderMaster(audio, suggestParams(an, { style }), { cache, inputInfo: inputInfoOf(an) })).audio;
    }
    const pb = kickPunch(audio, out.balanced, kicks), pp = kickPunch(audio, out.punchy, kicks);
    assert(pp > pb + 0.05, `kick attack-to-body: punchy ${pp.toFixed(2)} dB vs balanced ${pb.toFixed(2)} dB`);
    const sb = bandChangeDb(audio, out.balanced, 28, 71), sr = bandChangeDb(audio, out.bright, 28, 71);
    assert(sr > sb - 0.35, `bright 31–63 Hz ${sr.toFixed(2)} dB vs balanced ${sb.toFixed(2)} dB`);
    const tb = bandChangeDb(audio, out.balanced, 6000, 14000), tr = bandChangeDb(audio, out.bright, 6000, 14000);
    assert(tr > tb + 0.5, `bright top ${tr.toFixed(2)} vs balanced ${tb.toFixed(2)} dB`);
    return `kick attack-to-body: balanced ${pb.toFixed(2)}, punchy ${pp.toFixed(2)} dB; 31–63 Hz: balanced ${sb.toFixed(2)}, bright ${sr.toFixed(2)} dB; 6–14 kHz +${(tr - tb).toFixed(2)} dB`;
  },

  'chain: QC never softens user-owned paths — "too muddy" keeps working (C1)': async () => {
    const a = demo(true, 16);
    const an = once('an16', () => analyzeTrack(a));
    const base = suggestParams(an, {});
    assert(base.eq.tone.mudDb < 0, 'mud floor detected on the demo');
    const harsh0 = base.eq.tone.presenceDb;
    const prog = [];
    for (const clicks of [1, 2, 3]) {
      // what the UI's composeParams does: floor + offset, path listed as user-owned
      const p = JSON.parse(JSON.stringify(base));
      p.eq.tone.mudDb = base.eq.tone.mudDb - 1.5 * clicks;
      p.meta.userOwned = ['eq.tone.mudDb'];
      prog.length = 0;
      const { report: r } = await renderMaster(a, validateParams(p), { onProgress: (s, f) => prog.push([s, f]) });
      approx(r.paramsUsed.eq.tone.mudDb, p.eq.tone.mudDb, 1e-9, `${clicks} click(s): user value kept`);
      approx(r.paramsUsed.eq.tone.presenceDb, harsh0, 1e-9, `${clicks} click(s): unrelated harsh floor untouched`);
      assert(eqRuns(prog) === 1, `${clicks} click(s): no QC re-render (${eqRuns(prog)} eq stages)`);
      assert(r.qc.passed && !r.warnings.some((w) => w.id === 'warn.qcRollback' && w.vars.module === 'tone'), `${clicks}: ${JSON.stringify(r.qc)}`);
    }
    // the same value without ownership is the assistant's → softened (one key only)
    const q = JSON.parse(JSON.stringify(base));
    q.eq.tone.mudDb = base.eq.tone.mudDb - 4.5;
    const r2 = (await renderMaster(a, validateParams(q), {})).report;
    assert(r2.paramsUsed.eq.tone.mudDb > q.eq.tone.mudDb && r2.qc.rollbacks.includes('tone'), `assistant-owned mud softened ${r2.paramsUsed.eq.tone.mudDb}`);
    approx(r2.paramsUsed.eq.tone.presenceDb, harsh0, 1e-9, 'only the responsible key is softened');
    return `user mud ${(base.eq.tone.mudDb - 4.5).toFixed(2)} dB kept; assistant-owned → ${r2.paramsUsed.eq.tone.mudDb} dB`;
  },

  'chain: width blamed only when widening made a band worse than the input; QC memo': async () => {
    // Suno-like input whose 1–8 kHz band is already anti-phase (correlation < 0)
    const L = pinkNoise(10, SR, 0.3, 61), R = pinkNoise(10, SR, 0.3, 62);
    const hi = [Float32Array.from(L), Float32Array.from(R)];
    processStereoInPlace(hi, [...butterworth('highpass', 4, 1500, SR), ...butterworth('lowpass', 4, 6000, SR)]);
    for (let i = 0; i < L.length; i++) {
      const m = 0.6 * L[i];
      R[i] = m - 0.9 * hi[0][i];
      L[i] = m + 0.9 * hi[0][i];
    }
    const wide = { sampleRate: SR, channels: [L, R] };
    const an = analyzeTrack(wide);
    assert(an.stereo.bandCorrelation[2] < 0, `input 1–8 kHz correlation ${an.stereo.bandCorrelation[2]}`);
    const info = { ...inputInfoOf(an), bandCorrelation: an.stereo.bandCorrelation, correlation: an.stereo.correlation };
    const cache = {};
    // Bright's +5 % width: the band is negative because of the input → no rollback, 1 render
    const pb = suggestParams(an, { style: 'bright', cleanup: 'off' }); // noise input: keep denoise out of it
    assert(pb.stereo.width > 1, 'bright widens');
    const prog = [];
    const rb = (await renderMaster(wide, pb, { cache, inputInfo: info, onProgress: (s, f) => prog.push([s, f]) })).report;
    assert(!rb.qc.rollbacks.includes('width') && rb.paramsUsed.stereo.width === pb.stereo.width && rb.qc.passed, `bright: ${JSON.stringify(rb.qc)}`);
    assert(eqRuns(prog) === 1, `bright: ${eqRuns(prog)} renders`);
    // +50 % makes it clearly worse → width softened; a later loudness-only change reuses
    // the outcome (cache B hit, no repeated rollback renders)
    const p2 = validateParams({ ...pb, stereo: { ...pb.stereo, width: 1.5 } });
    prog.length = 0;
    const r2 = (await renderMaster(wide, p2, { cache, inputInfo: info, onProgress: (s, f) => prog.push([s, f]) })).report;
    assert(r2.qc.rollbacks.includes('width') && r2.paramsUsed.stereo.width < 1.5, `width rollback ${JSON.stringify(r2.qc)}`);
    const first = eqRuns(prog);
    prog.length = 0;
    const p3 = validateParams({ ...p2, loudness: { ...p2.loudness, targetLufs: -12 } });
    const r3 = (await renderMaster(wide, p3, { cache, inputInfo: info, onProgress: (s, f) => prog.push([s, f]) })).report;
    assert(eqRuns(prog) === 0 && !('glue' in r3.timingsMs), `memo: ${eqRuns(prog)} eq stages`);
    assert(r3.qc.rollbacks.includes('width') && r3.paramsUsed.stereo.width === r2.paramsUsed.stereo.width, 'memoised rollback reported');
    approx(r3.loudness.integrated, -12, 0.3, 'new target');
    // a user-chosen width is never softened (C1)
    const p4 = JSON.parse(JSON.stringify(p2));
    p4.meta.userOwned = ['stereo.width'];
    const r4 = (await renderMaster(wide, validateParams(p4), { cache, inputInfo: info })).report;
    assert(r4.paramsUsed.stereo.width === 1.5 && !r4.qc.rollbacks.includes('width') && r4.qc.passed, `user width kept ${JSON.stringify(r4.qc)}`);
    return `bright width kept (r 1–8 kHz ${rb.bandCorrelation[2]} vs input ${an.stereo.bandCorrelation[2]}); 1.5 → ${r2.paramsUsed.stereo.width} in ${first} renders, then 0 on a loudness change`;
  },

  'chain: Warm keeps the repairs — the HF check ignores the style\'s intended change': async () => {
    const an = demoAnalysis(true);
    const rows = [];
    for (const t of [0.5, 0.75]) {
      const p = suggestParams(an, { style: 'warm', intensity: t });
      const { report: r } = await renderMaster(demo(true), p, { inputInfo: inputInfoOf(an) });
      for (const m of ['denoise', 'deShimmer', 'dynEq']) assert(!r.qc.rollbacks.includes(m), `warm @${t}: ${m} rolled back ${JSON.stringify(r.qc)}`);
      assert(r.paramsUsed.dynEq.bands.harsh.maxCutDb === p.dynEq.bands.harsh.maxCutDb && r.paramsUsed.spectral.deShimmer.amount === p.spectral.deShimmer.amount, 'repairs at full strength');
      approx(r.paramsUsed.eq.tone.tiltDbPerOct, p.eq.tone.tiltDbPerOct, 1e-9, 'warm tilt kept');
      rows.push(`t ${t}: ${JSON.stringify(r.qc)}`);
    }
    return rows.join(' | ');
  },

  'chain: reference match at 100 % is never halved; auto EQ steps back': async () => {
    const an = demoAnalysis(false);
    const ref = { ltas: REFERENCE_LTAS.map((v, i) => v - 30 + (THIRD_OCTAVE_HZ[i] >= 4000 ? 3 : 0) + (THIRD_OCTAVE_HZ[i] <= 80 ? -3 : 0)), name: 'Ref', amount: 1 };
    const p = suggestParams(an, { reference: ref });
    assert(p.eq.match.strength === 1 && p.eq.match.maxDb === 4, 'match at 100 %, curve within the QC range');
    const { report: r } = await renderMaster(demo(false), p, { inputInfo: inputInfoOf(an) });
    assert(r.paramsUsed.eq.match.strength === 1 && !r.qc.rollbacks.includes('match'), `match kept ${JSON.stringify(r.qc)}`);
    assert(r.eqAutoDb.every((v) => v === 0), 'auto EQ off at 100 % reference (it would correct the same deviation twice)');
    assert(r.eqCurveDb.every((v) => Math.abs(v) <= 4.6), `net EQ ${Math.max(...r.eqCurveDb.map(Math.abs))}`); // ±4 dB curve + fit error
    const half = (await renderMaster(demo(false), suggestParams(an, { reference: { ...ref, amount: 0.5 } }), { inputInfo: inputInfoOf(an) })).report;
    assert(half.paramsUsed.eq.match.strength === 0.5, 'half amount kept');
    return `net EQ max ${Math.max(...r.eqCurveDb.map(Math.abs)).toFixed(2)} dB, auto max at 50 %: ${Math.max(...half.eqAutoDb.map(Math.abs)).toFixed(2)} dB`;
  },

  'chain: output rate after glue — caches A/B shared across rates; C2 trim report': async () => {
    const a = demo(true, 12);
    const an = analyzeTrack(a);
    const cache = {};
    const p = suggestParams(an, {});
    const r48 = (await renderMaster(a, p, { cache, inputInfo: inputInfoOf(an) })).report;
    const p44 = validateParams({ ...p, output: { sampleRate: 44100 } });
    const res44 = await renderMaster(a, p44, { cache, inputInfo: inputInfoOf(an) });
    const t44 = res44.report.timingsMs;
    assert(!('spectral' in t44) && !('glue' in t44) && 'resample' in t44, `44.1 k: stages 1–9 reused ${Object.keys(t44)}`);
    assert(res44.audio.sampleRate === 44100 && Math.abs(res44.audio.channels[0].length - Math.round((a.channels[0].length * 44100) / SR)) <= 1, '44.1 k output');
    approx(res44.report.loudness.integrated, -14, 0.3, '44.1 k LUFS');
    assert(truePeakDb(res44.audio.channels, 44100) <= -1 + 1e-6, '44.1 k TP');
    const tr = res44.report.trim;
    assert(tr.sampleRate === 44100 && tr.startSample === 0 && tr.startSec === 0 && tr.trimmed === false, `trim report ${JSON.stringify(tr)}`);
    approx(tr.endSec, res44.audio.channels[0].length / 44100, 1e-9, 'endSec');
    const back = (await renderMaster(a, validateParams({ ...p, loudness: { ...p.loudness, targetLufs: -13 } }), { cache, inputInfo: inputInfoOf(an) })).report;
    assert(!('glue' in back.timingsMs) && !('resample' in back.timingsMs), 'back at the source rate: cache B, no resample');
    // destinations differ in their dynamics: Streaming → Loud runs stages 4–9 once, and
    // the way back finds the previous post-glue audio (cache.B2)
    const loud = (await renderMaster(a, suggestParams(an, { destination: 'loud' }), { cache, inputInfo: inputInfoOf(an) })).report;
    assert('glue' in loud.timingsMs && !('spectral' in loud.timingsMs), 'loud: cache A, new B');
    const again = (await renderMaster(a, p, { cache, inputInfo: inputInfoOf(an) })).report;
    assert(!('glue' in again.timingsMs) && !('eq' in again.timingsMs), `back to Streaming: B2 hit ${Object.keys(again.timingsMs)}`);
    const loud2 = (await renderMaster(a, suggestParams(an, { destination: 'loud' }), { cache, inputInfo: inputInfoOf(an) })).report;
    assert(!('glue' in loud2.timingsMs), 'and Loud again');
    void r48;
    return `44.1 k re-render ${t44.total} ms (resample ${t44.resample} ms) after a ${r48.timingsMs.total} ms full render`;
  },

  'chain: trim cuts the head only when the leading silence itself is long (C2)': async () => {
    const body = 6 * SR;
    const mk = (lead, tail, seed) => { const o = new Float32Array(lead + body + tail); o.set(pinkNoise(6, SR, 0.3, seed), lead); return o; };
    // short head (0.2 s), long tail (2 s): the tail is cut, the start stays (A/B alignment)
    const lead = Math.round(0.2 * SR);
    const t1 = { sampleRate: SR, channels: [mk(lead, 2 * SR, 71), mk(lead, 2 * SR, 72)] };
    const p1 = suggestParams(analyzeTrack(t1), {});
    assert(p1.trim.enabled && p1.trim.head === false && p1.trim.tail === true, `trim flags ${JSON.stringify(p1.trim)}`);
    const r1 = (await renderMaster(t1, p1, {})).report;
    assert(r1.trim.trimmed && r1.trim.startSample === 0 && r1.trim.startSec === 0, `head kept ${JSON.stringify(r1.trim)}`);
    approx(r1.trim.endSec, (lead + body) / SR + 0.8, 0.002, 'tail cut to 0.8 s');
    // long head (1.5 s): cut to 100 ms of pre-roll, reported in source time
    const lead2 = Math.round(1.5 * SR);
    const t2 = { sampleRate: SR, channels: [mk(lead2, 0, 73), mk(lead2, 0, 74)] };
    const p2 = suggestParams(analyzeTrack(t2), {});
    assert(p2.trim.head === true, 'head trimmed when the leading silence is long');
    const res2 = await renderMaster(t2, validateParams({ ...p2, output: { sampleRate: 44100 } }), {});
    const tr = res2.report.trim;
    approx(tr.startSec, 1.4, 0.001, 'startSec = onset − 100 ms');
    assert(tr.sampleRate === 44100 && Math.abs(tr.startSec - tr.startSample / tr.sampleRate) < 1e-12, `C2 trim units ${JSON.stringify(tr)}`);
    // describeDecisions mentions trim only when something was cut
    const short = { sampleRate: SR, channels: [mk(lead, 0, 75), mk(lead, 0, 76)] };
    const ps = validateParams({ ...suggestParams(analyzeTrack(short), {}), trim: { enabled: true, head: true, tail: true } });
    const rs = (await renderMaster(short, ps, {})).report;
    if (!rs.trim.trimmed) assert(!describeDecisions(analyzeTrack(short), rs.paramsUsed).some((d) => d.key === 'dec.trim'), 'no trim line when nothing was cut');
    return `short head: start kept, end ${r1.trim.endSec.toFixed(3)} s; long head: start ${tr.startSec} s (${tr.startSample} @ 44.1 k)`;
  },

  'chain: robust on silence, 10 samples, 300 ms, mono, NaN input, 96 kHz': async () => {
    const cases = {
      ten: { sampleRate: SR, channels: [Float32Array.from({ length: 10 }, (_, i) => 0.1 * Math.sin(i)), new Float32Array(10)] },
      silence: { sampleRate: SR, channels: [new Float32Array(SR), new Float32Array(SR)] },
      short: { sampleRate: SR, channels: [sine(440, 0.3, SR, 0.9), sine(440, 0.3, SR, 0.9)] },
      mono: { sampleRate: 44100, channels: [pinkNoise(3, 44100, 0.3, 3)] },
      nan: (() => { const x = pinkNoise(2, SR, 0.3, 4); x[1000] = NaN; x[2000] = -Infinity; return { sampleRate: SR, channels: [x, Float32Array.from(x)] }; })(),
      hi96: { sampleRate: 96000, channels: [pinkNoise(3, 96000, 0.3, 5), pinkNoise(3, 96000, 0.3, 6)] },
    };
    const rows = [];
    for (const [name, a] of Object.entries(cases)) {
      const an = analyzeTrack(a);
      const p = suggestParams(an, {});
      const { audio, report } = await renderMaster(a, p, {});
      assert(audio.channels.length === 2 && audio.channels[0].length === a.channels[0].length, `${name} length`);
      assertFinite(audio.channels, `${name} non-finite`);
      assert(truePeakDb(audio.channels, audio.sampleRate) <= p.loudness.ceilingDb + 1e-6, `${name} TP`);
      if (name === 'mono' || name === 'nan' || name === 'hi96') approx(report.loudness.integrated, -14, 0.3, `${name} LUFS`);
      rows.push(`${name}: ${Number.isFinite(report.loudness.integrated) ? report.loudness.integrated.toFixed(2) : '−∞'} LUFS`);
    }
    return rows.join(', ');
  },

  'chain: decoded fixtures (WAV/MP3/AAC/ALAC/FLAC/Vorbis/Opus) master to target': async () => {
    if (!hasFfmpeg()) return 'skip';
    const m = await makeFixtures();
    const ids = Object.keys(m.fixtures);
    const dests = ['streaming', 'loud', 'hifi', 'club', 'video', 'social', 'broadcast'];
    const rows = [];
    let i = 0;
    for (const id of ids) {
      const f = m.fixtures[id];
      const channels = ffmpegDecode(f.path);
      const audio = { sampleRate: f.sampleRate, channels };
      assert(channels[0].length > 0, `${id} decoded`);
      const an = analyzeTrack(audio);
      const dest = dests[i++ % dests.length];
      const p = suggestParams(an, { destination: dest });
      const { audio: out, report } = await renderMaster(audio, p, { inputInfo: inputInfoOf(an) });
      assert(out.channels[0].length === channels[0].length, `${id} length`);
      assertFinite(out.channels, `${id}`);
      const C = p.loudness.ceilingDb;
      assert(truePeakDb(out.channels, out.sampleRate) <= C + 1e-6 && report.loudness.truePeakDb <= C + 1e-6, `${id} TP`);
      if (report.targetReached || !report.warnings.some((w) => w.id === 'warn.targetUnreachable')) approx(report.loudness.integrated, report.effectiveTargetLufs, 0.3, `${id} (${dest}) LUFS`);
      if (f.lossy && f.codec !== 'opus') assert(an.spectrum.hfCutoffHz <= 20500 || f.bitrateKbps >= 256, `${id} cutoff ${an.spectrum.hfCutoffHz}`);
      rows.push(`${id}→${dest} ${report.loudness.integrated.toFixed(2)}/${p.loudness.targetLufs} fc ${Math.round(an.spectrum.hfCutoffHz / 100) / 10}k ${an.profile}`);
    }
    return rows.join(' | ');
  },

  // ================================================================ handlers / worker / client

  'handlers: load / analyze / render / ltas / unload, supersede and cancel': async () => {
    const a = demo(true, 12);
    const st = createEngineState();
    const info = await handleMessage(st, { type: 'load', trackId: 't1', sampleRate: SR, channels: a.channels.map((c) => Float32Array.from(c)) });
    approx(info.duration, 12, 1e-6, 'duration');
    const an = await handleMessage(st, { type: 'analyze', trackId: 't1' });
    assert(an === (await handleMessage(st, { type: 'analyze', trackId: 't1' })), 'analysis cached');
    const p = suggestParams(an, {});
    // supersede: the older render rejects 'cancelled' at its next stage boundary
    const r1 = handleMessage(st, { type: 'render', id: 1, trackId: 't1', params: p });
    const r2 = handleMessage(st, { type: 'render', id: 2, trackId: 't1', params: p });
    const [s1, s2] = await Promise.allSettled([r1, r2]);
    assert(s1.status === 'rejected' && s1.reason.code === 'cancelled', 'older render cancelled');
    assert(s2.status === 'fulfilled' && s2.value.audio.channels[0].length === a.channels[0].length, 'newer render');
    approx(s2.value.report.loudness.integrated, -14, 0.3, 'LUFS');
    // explicit cancel
    const r3 = handleMessage(st, { type: 'render', id: 3, trackId: 't1', params: { ...p, loudness: { ...p.loudness, targetLufs: -13 } } });
    await handleMessage(st, { type: 'cancel', id: 3 });
    const s3 = await r3.then(() => null, (e) => e);
    assert(s3 && s3.code === 'cancelled', 'explicit cancel');
    const ref = await handleMessage(st, { type: 'ltas', sampleRate: SR, channels: a.channels.map((c) => Float32Array.from(c)) });
    assert(ref.ltas.length === 31 && Number.isFinite(ref.loudness.integrated), 'reference ltas');
    for (let i = 0; i < 31; i++) approx(ref.ltas[i], an.spectrum.ltas[i], 0.02, 'reference LTAS = analysis estimator');
    await handleMessage(st, { type: 'unload', trackId: 't1' });
    const e = await handleMessage(st, { type: 'analyze', trackId: 't1' }).then(() => null, (x) => x);
    assert(e && e.code, 'unknown track after unload');
    const bad = await handleMessage(st, { type: 'load', trackId: 'x', sampleRate: 0, channels: [] }).then(() => null, (x) => x);
    assert(bad && bad.code === 'corrupt', 'invalid load');
    return 'ok';
  },

  'handlers: C2 preview at the source rate, C3 lossy source warning, caches of ≤ 2 tracks': async () => {
    const a = demo(true, 6);
    const st = createEngineState();
    const copy = () => a.channels.map((c) => Float32Array.from(c));
    // C3: decodeFile()'s info travels with the load; a lossy source warns (kbps estimated
    // from size / duration when the header has none)
    await handleMessage(st, { type: 'load', trackId: 'mp3', sampleRate: SR, channels: copy(), info: { format: 'mp3', codec: 'mp3', lossy: true, bitrateKbps: 192 } });
    await handleMessage(st, { type: 'load', trackId: 'aac', sampleRate: SR, channels: copy(), info: { format: 'm4a', lossy: true, bitrateKbps: null, sizeBytes: 96000, duration: 6 } });
    await handleMessage(st, { type: 'load', trackId: 'wav', sampleRate: SR, channels: copy(), info: { format: 'wav', lossy: false, bitrateKbps: null } });
    const an = await handleMessage(st, { type: 'analyze', trackId: 'mp3' });
    const p = suggestParams(an, {});
    const warn = async (id) => (await handleMessage(st, { type: 'render', id: `r-${id}`, trackId: id, params: p })).report.warnings.find((w) => w.id === 'warn.lossySource');
    const w1 = await warn('mp3'), w2 = await warn('aac'), w3 = await warn('wav');
    assert(w1 && w1.vars.kbps === 192, `mp3: ${JSON.stringify(w1)}`);
    assert(w2 && w2.vars.kbps === 128, `aac estimated kbps: ${JSON.stringify(w2)}`);
    assert(!w3, 'wav: no lossy warning');
    // Only the 2 most recently rendered tracks keep caches A / B; only the last one B2
    const cached = () => [...st.tracks].filter(([, t]) => t.cache.A || t.cache.B).map(([id]) => id).sort().join(',');
    assert(cached() === 'aac,wav', `LRU caches: ${cached()}`);
    assert([...st.tracks].every(([id, t]) => id === 'wav' || !t.cache.B2), 'B2 only on the track just rendered');
    // a focused track keeps its caches while others render in the background
    await handleMessage(st, { type: 'focus', trackId: 'aac' });
    await handleMessage(st, { type: 'render', id: 'r-mp3b', trackId: 'mp3', params: p });
    assert(cached() === 'aac,mp3', `focus kept: ${cached()}`);
    // C2: a master at another rate comes with a preview at the source rate
    const r44 = await handleMessage(st, { type: 'render', id: 'r44', trackId: 'wav', params: validateParams({ ...p, output: { sampleRate: 44100 } }) });
    assert(r44.audio.sampleRate === 44100 && r44.preview && r44.preview.sampleRate === SR, 'preview at the source rate');
    approx(r44.preview.channels[0].length, a.channels[0].length, 1, 'preview length = source length');
    const lag = bestLag(r44.preview.channels[0].subarray(SR, 3 * SR), a.channels[0].subarray(SR, 3 * SR), 64);
    assert(Math.abs(lag) <= 1, `preview aligned with the source (lag ${lag})`);
    const r48 = await handleMessage(st, { type: 'render', id: 'r48', trackId: 'wav', params: p });
    assert(r48.preview === undefined, 'no preview when the rates match');
    assert(r44.report.trim && r44.report.trim.sampleRate === 44100 && r44.report.trim.startSec === 0, `report.trim ${JSON.stringify(r44.report.trim)}`);
    await handleMessage(st, { type: 'unload', trackId: 'aac' });
    assert(st.focus === null && !st.lru.includes('aac'), 'unload clears focus / LRU');
    return `caches: ${cached()}; preview ${r44.preview.channels[0].length} samples @ ${r44.preview.sampleRate}`;
  },

  'worker: message protocol (progress, transferable result, error, supersede) without a real Worker': async () => {
    const posted = [];
    let resolveDone;
    const prevSelf = globalThis.self;
    globalThis.self = { postMessage: (m, transfer) => { posted.push({ m, transfer }); if (m.type !== 'progress' && resolveDone) resolveDone(m); } };
    try {
      await import('../src/engine/worker.js?protocol-test');
      const scope = globalThis.self;
      const send = (msg) => new Promise((res) => { resolveDone = res; scope.onmessage({ data: msg }); });
      const a = demo(true, 8);
      const r = await send({ type: 'load', id: 1, trackId: 'w', sampleRate: SR, channels: a.channels.map((c) => Float32Array.from(c)) });
      assert(r.type === 'result' && r.id === 1, 'load result');
      const an = (await send({ type: 'analyze', id: 2, trackId: 'w' })).result;
      assert(an.issues && an.spectrum, 'analysis via worker');
      const p = suggestParams(an, {});
      // supersede inside the worker
      const results = [];
      const waitFor = (id) => new Promise((res) => {
        const tick = () => {
          const hit = posted.find((x) => x.m.id === id && x.m.type !== 'progress');
          if (hit) res(hit);
          else setTimeout(tick, 5);
        };
        tick();
      });
      scope.onmessage({ data: { type: 'render', id: 10, trackId: 'w', params: p } });
      scope.onmessage({ data: { type: 'render', id: 11, trackId: 'w', params: p } });
      results.push(await waitFor(10), await waitFor(11));
      assert(results[0].m.type === 'error' && results[0].m.code === 'cancelled', 'superseded render → error cancelled');
      assert(results[1].m.type === 'result' && results[1].transfer.length === 2, 'render result transfers 2 channel buffers');
      assert(results[1].transfer[0] === results[1].m.result.audio.channels[0].buffer, 'transfer list = output channels');
      const prog = posted.filter((x) => x.m.id === 11 && x.m.type === 'progress');
      assert(prog.length >= STAGES.length && prog.every((x) => typeof x.m.stage === 'string'), 'progress messages');
      const err = await send({ type: 'analyze', id: 12, trackId: 'nope' });
      assert(err.type === 'error' && err.id === 12 && err.code, 'error message, worker alive');
      const unk = await send({ type: 'bogus', id: 13 });
      assert(unk.type === 'error', 'unknown request → error');
      const pong = await send({ type: 'ping', id: 14 });
      assert(pong.type === 'result' && pong.result.pong, 'ping');
      return `${posted.length} messages, ${prog.length} progress for one render`;
    } finally {
      if (prevSelf === undefined) delete globalThis.self;
      else globalThis.self = prevSelf;
    }
  },

  'client: inline fallback in Node (copies channels, progress, supersede, reference)': async () => {
    const c = new EngineClient();
    const a = demo(true, 8);
    const keep = a.channels.map((x) => x.slice(0, 64));
    await c.loadTrack('a', a, { format: 'mp3', codec: 'mp3', lossy: true, bitrateKbps: 160, extra: { not: 'cloned' } });
    assert(c.mode === 'inline', `mode ${c.mode}`);
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < 64; i++) assert(a.channels[ch][i] === keep[ch][i] && a.channels[ch].length > 0, 'caller keeps its audio');
    const an = await c.analyze('a');
    const p = suggestParams(an, {});
    const stages = new Set();
    const first = c.render('a', p, () => {});
    const second = c.render('a', p, (s) => stages.add(s));
    const [s1, s2] = await Promise.allSettled([first, second]);
    assert(s1.status === 'rejected' && s1.reason.code === 'cancelled', 'superseded → cancelled');
    assert(s2.status === 'fulfilled' && s2.value.audio && s2.value.report, 'render result');
    assert(STAGES.every((s) => stages.has(s)), `progress stages ${[...stages]}`);
    assert(s2.value.report.warnings.some((w) => w.id === 'warn.lossySource' && w.vars.kbps === 160), 'C3: lossy source from loadTrack info');
    assert(s2.value.preview === undefined, 'no preview at the source rate');
    const r44 = await c.render('a', validateParams({ ...p, output: { sampleRate: 44100 } }));
    assert(r44.audio.sampleRate === 44100 && r44.preview && r44.preview.sampleRate === a.sampleRate, 'C2: preview at the source rate');
    c.focusTrack('a');
    const ref = await c.analyzeReference(demo(false, 8));
    assert(ref.ltas.length === 31, 'reference');
    await c.unload('a');
    return 'ok';
  },

  'client: worker path, classic __AM_WORKER_URL__, ping timeout → inline, crash → inline': async () => {
    const prevW = globalThis.Worker, prevU = globalThis.__AM_WORKER_URL__, prevSelf = globalThis.self;
    // a fake Worker that runs worker.js's onmessage asynchronously in this thread
    const relay = { target: null };
    globalThis.self = { postMessage: (m) => setTimeout(() => relay.target && relay.target.onmessage && relay.target.onmessage({ data: m }), 0) };
    await import('../src/engine/worker.js?client-test');
    const workerScope = globalThis.self;
    const made = [];
    class FakeWorker {
      constructor(url, opts) {
        made.push({ url: String(url), opts });
        this.onmessage = null;
        this.mode = FakeWorker.mode;
        relay.target = this;
      }
      postMessage(m) {
        if (this.mode === 'silent') return;
        if (this.mode === 'crash' && m.type === 'analyze') {
          setTimeout(() => this.onerror && this.onerror(new Error('boom')), 0);
          return;
        }
        relay.target = this;
        setTimeout(() => workerScope.onmessage({ data: m }), 0);
      }
      terminate() { this.mode = 'silent'; }
    }
    try {
      globalThis.Worker = FakeWorker;
      FakeWorker.mode = 'ok';
      delete globalThis.__AM_WORKER_URL__;
      const c1 = new EngineClient();
      const a = demo(true, 6);
      await c1.loadTrack('k', a);
      assert(c1.mode === 'worker', `worker mode, got ${c1.mode}`);
      assert(made[0].opts && made[0].opts.type === 'module' && /worker\.js$/.test(made[0].url), 'dev: module worker from ./worker.js');
      const an = await c1.analyze('k');
      const r = await c1.render('k', suggestParams(an, {}));
      approx(r.report.loudness.integrated, -14, 0.3, 'render through the worker path');
      globalThis.__AM_WORKER_URL__ = 'blob:fake-worker';
      const c2 = new EngineClient();
      await c2.analyzeReference(a);
      assert(made[1].url === 'blob:fake-worker' && made[1].opts === undefined, 'build: classic worker from __AM_WORKER_URL__');
      FakeWorker.mode = 'silent';
      const c3 = new EngineClient({ pingTimeoutMs: 50 });
      const ref3 = await c3.analyzeReference(a);
      assert(c3.mode === 'inline' && ref3.ltas.length === 31, 'no ping answer → inline');
      FakeWorker.mode = 'crash';
      const c4 = new EngineClient();
      await c4.loadTrack('z', a);
      assert(c4.mode === 'worker', 'worker before the crash');
      const e = await c4.analyze('z').then(() => null, (x) => x);
      assert(e && e.code === 'render' && c4.mode === 'inline', 'crash rejects in-flight request and switches to inline');
      const an4 = await c4.analyze('z'); // re-loaded from the caller's audio
      assert(an4.issues, 'continues in-thread after a crash');
      return `workers created: ${made.map((m) => m.url.split('/').pop()).join(', ')}`;
    } finally {
      if (prevW === undefined) delete globalThis.Worker;
      else globalThis.Worker = prevW;
      if (prevU === undefined) delete globalThis.__AM_WORKER_URL__;
      else globalThis.__AM_WORKER_URL__ = prevU;
      if (prevSelf === undefined) delete globalThis.self;
      else globalThis.self = prevSelf;
    }
  },

  'i18n: every engine key exists in IT and EN, placeholders covered by the vars': async () => {
    const need = new Map(); // key → vars
    const addKey = (key, vars = {}) => need.set(key, { ...(need.get(key) || {}), ...vars });
    const an = demoAnalysis(true);
    const variants = [
      suggestParams(an, { style: 'warm', destination: 'loud' }),
      suggestParams(an, { style: 'bright', cleanup: 'strong', reference: { ltas: REFERENCE_LTAS, name: 'R' } }),
      suggestParams({ ...an, profile: 'legacy', spectrum: { ...an.spectrum, hfCutoffHz: 12000 }, indices: { ...an.indices, hiss: -5, hash: -5 } }, { style: 'punchy' }),
      suggestParams({ ...an, indices: { ...an.indices, hash: 3, boom: 5, fizz: 4, hiss: -3 }, stereo: { ...an.stereo, sideToMidHfDb: -3, nearMono: true } }, { destination: 'club' }),
    ];
    for (const p of variants) {
      const q = JSON.parse(JSON.stringify(p));
      q.finish.fadeOutMs = 2500;
      q.trim.enabled = true;
      for (const d of describeDecisions(an, validateParams(q))) addKey(d.key, d.vars);
    }
    for (const id of ['targetUnreachable', 'heavyLimiting', 'inputClipped', 'lossySource', 'longTrack', 'qcRollback', 'loudArtifacts', 'crushedInput']) {
      addKey(`warn.${id}`, { lufs: -9, gr: 3, kbps: 128, min: 7, module: 'tone' });
    }
    for (const m of ['denoise', 'deShimmer', 'dynEq', 'tone', 'autoEq', 'match', 'width', 'monoBass']) addKey(`module.${m}`);
    for (const st of STAGES) addKey(`stage.${st}`);
    for (const pr of ['legacy', 'midband', 'fullband', 'muffled', 'brightened']) addKey(`profile.${pr}`);
    const issueIds = ['clipping', 'overs', 'tooLoud', 'tooQuiet', 'dcOffset', 'rumble', 'boomy', 'muddy', 'harsh', 'fizz', 'sibilant', 'shimmer', 'hiss', 'dull', 'brightened', 'codecCutoff', 'nearMono', 'phase', 'wideBass', 'abruptEnd', 'silence', 'overCompressed'];
    for (const id of issueIds) {
      addKey(`issue.${id}`);
      addKey(`issue.${id}.hint`);
    }
    const seen = new Set();
    for (const a of [demoAnalysis(true), demoAnalysis(false)]) for (const i of a.issues) seen.add(i.id);
    for (const id of seen) assert(issueIds.includes(id), `analysis emits unknown issue id ${id}`);
    const missing = [];
    for (const lang of ['it', 'en']) {
      for (const [key, vars] of need) {
        const str = STRINGS[lang][key];
        if (typeof str !== 'string') {
          missing.push(`${lang}:${key}`);
          continue;
        }
        for (const m of str.matchAll(/\{(\w+)\}/g)) if (!(m[1] in vars)) missing.push(`${lang}:${key}{${m[1]}}`);
      }
    }
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    return `${need.size} keys checked in IT/EN`;
  },

  // ================================================================ performance + report

  'performance: full render 3:30 stereo 48 kHz (budget 8 s; cache B < 2 s; cache A < 4 s @M1)': async () => {
    const a = demo(true, 210);
    const st = createEngineState();
    await handleMessage(st, { type: 'load', trackId: 'p', sampleRate: SR, channels: a.channels.map((c) => Float32Array.from(c)) });
    const an = await handleMessage(st, { type: 'analyze', trackId: 'p' });
    const p = suggestParams(an, {});
    // warm-up (JIT) on a short excerpt of the same material
    const w = createEngineState();
    await handleMessage(w, { type: 'load', trackId: 'w', sampleRate: SR, channels: a.channels.map((c) => c.slice(0, 12 * SR)) });
    await handleMessage(w, { type: 'render', id: 0, trackId: 'w', params: p });
    const [r1, full] = await timed(() => handleMessage(st, { type: 'render', id: 1, trackId: 'p', params: p }));
    const [r2, loudOnly] = await timed(() => handleMessage(st, { type: 'render', id: 2, trackId: 'p', params: { ...p, loudness: { ...p.loudness, targetLufs: -12 } } }));
    const [r3, specCache] = await timed(() => handleMessage(st, { type: 'render', id: 3, trackId: 'p', params: { ...p, glue: { ...p.glue, targetGrDb: 2 } } }));
    const f = scaleFactor();
    const rep = (ms, budget) => `${ms.toFixed(0)} ms (≈${(ms / f).toFixed(0)} @M1, budget ${budget})`;
    const timings = Object.entries(r1.report.timingsMs).map(([k, v]) => `${k} ${v}`).join(', ');
    const gr = `multiband ${r1.report.multiband.map((b) => b.grAvgDb.toFixed(1)).join('/')} dB, glue ${r1.report.glue.grAvgDb.toFixed(1)}, limiter avg ${r1.report.limiter.grAvgDb.toFixed(2)} max ${r1.report.limiter.grMaxDb.toFixed(1)}, clip ${r1.report.clipper.grMaxDb.toFixed(1)}`;
    assert(full < 1.3 * 8000 * f, `full render ${rep(full, 8000)} — ${scaleNote()}`);
    assert(loudOnly < 1.3 * 2000 * f, `loudness-only ${rep(loudOnly, 2000)}`);
    assert(specCache < 1.3 * 4000 * f, `spectral-cache re-render ${rep(specCache, 4000)}`);
    approx(r1.report.loudness.integrated, -14, 0.3, 'LUFS');
    approx(r2.report.loudness.integrated, -12, 0.3, 'LUFS −12');
    void r3;
    return `full ${rep(full, 8000)}; loudness-only ${rep(loudOnly, 2000)}; cache A ${rep(specCache, 4000)} [${scaleNote()}] — stages: ${timings} — GR: ${gr}`;
  },

  'report: listening-oriented summary of the demo master': async () => {
    const an = demoAnalysis(true);
    const { report: r, params } = await renderDemo({});
    const dec = describeDecisions(an, r.paramsUsed).map(({ key, vars }) => `${key.replace('dec.', '')}${Object.keys(vars).length ? `(${Object.entries(vars).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`).join(' ')})` : ''}`);
    const i = r.inputLoudness, o = r.loudness;
    const dyn = Object.entries(r.dynEq).map(([k, s]) => `${k} avg ${s.grAvgDb.toFixed(2)} max ${s.grMaxDb.toFixed(1)} (${s.activePct.toFixed(0)} % active)`).join('; ');
    const lines = [
      '',
      `    before: ${i.integrated.toFixed(1)} LUFS, TP ${i.truePeakDb.toFixed(2)} dBTP, LRA ${i.lra.toFixed(1)} LU, PLR ${plrOf(i).toFixed(1)} dB`,
      `    after : ${o.integrated.toFixed(1)} LUFS, TP ${o.truePeakDb.toFixed(2)} dBTP, LRA ${o.lra.toFixed(1)} LU, PLR ${plrOf(o).toFixed(1)} dB (target ${params.loudness.targetLufs} / ${params.loudness.ceilingDb})`,
      `    decisions: ${dec.join(', ')}`,
      `    spectral: ${r.spectral.avgReductionDb.toFixed(2)} dB avg (de-shimmer max ${r.spectral.deShimmer ? r.spectral.deShimmer.maxReductionDb.toFixed(1) : 0}, denoise max ${r.spectral.denoise ? r.spectral.denoise.maxReductionDb.toFixed(1) : 0} dB)`,
      `    dynamic EQ: ${dyn}`,
      `    multiband: ${r.multiband.map((b, k) => `${['low', 'mid', 'high'][k]} ${b.grAvgDb.toFixed(1)}/${b.grMaxDb.toFixed(1)} dB`).join(', ')}; glue ${r.glue.grAvgDb.toFixed(1)}/${r.glue.grMaxDb.toFixed(1)} dB`,
      `    limiter: avg ${r.limiter.grAvgDb.toFixed(2)} max ${r.limiter.grMaxDb.toFixed(2)} dB; clipper ${r.clipper.grMaxDb.toFixed(2)} dB; gain ${r.gainDb.toFixed(2)} dB in ${r.loudnessPasses} pass(es)`,
      `    net EQ (dB @ 63/250/1k/4k/10k/16k): ${[5, 11, 17, 23, 27, 29].map((k) => r.eqCurveDb[k].toFixed(1)).join(' / ')}`,
      `    stereo: r ${r.correlation}, bands ${r.bandCorrelation.join(' / ')}; QC ${r.qc.passed ? 'passed' : 'failed'}${r.qc.rollbacks.length ? ` (rolled back ${r.qc.rollbacks})` : ''}; warnings: ${r.warnings.map((w) => w.id).join(', ') || 'none'}`,
    ];
    assert(r.qc.passed, 'QC');
    return lines.join('\n');
  },
};

void defaultParams;
void stereoSpectrum;
