// UI harness: drives src/ui/app.js with FAKE engine / IO modules so the interface can be
// exercised without the DSP engine. Fakes follow the ARCHITECTURE.md contracts: realistic
// AnalysisReport (§4) and RenderReport (§5) shapes (issues, curves, ltas, decisions,
// warnings), delayed progress per stage, superseded renders rejecting {code:'cancelled'}.
// Audio = short synthesized buffers; the Player is a small real Web Audio player so the
// A/B switch, loudness match and the live analyser actually work (it also implements the
// cut tool's range / loop playback: playRange, setRangeLoop, clearRange, range; the
// instance is H.player).
// Open: node tools/serve.mjs 5173 → http://localhost:5173/tests/ui-harness.html
//   ?demo=1 auto-loads the demo · ?tracks=3 loads 3 fake songs · ?theme=light|dark
//   ?probe=none|host simulates a view where files cannot / can be saved (contract C4)
//   ?open=1 unfolds the folded panels
//   ?check=1 runs the UI regression checks (bottom of this file) and prints PASS/FAIL
// Contracts mirrored by the fakes: C1 meta.userOwned (recorded in H.lastParams), C2
// render → { audio, report, preview? } with report.trim, C3 loadTrack(id, audio, info) →
// warn.lossySource, C4 saveBlob statuses + probeSaveSupport.
import { createApp } from '../src/ui/app.js';
import * as params from '../src/engine/params.js';
import { t as i18nT, getLanguage, setLanguage } from '../src/ui/i18n.js';

const P = params;
const H = { speed: 1, save: 'saved', failNextRender: false, lastParams: null, renders: 0, cancels: 0, saves: [] };
// Hidden tabs clamp timers to ~1 s; there a MessageChannel tick keeps the fakes moving.
const tick = () =>
  new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
const sleep = (ms) => (document.hidden ? tick() : new Promise((r) => setTimeout(r, ms * H.speed)));
const dbToGain = (db) => Math.pow(10, db / 20);
const ISO = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// --- Synthesis: a small "song" (kick, snare, hats, bass, chord pad, AI-ish shimmer) ---

function synthSong({ sampleRate = 48000, seconds = 20, seed = 7, level = 0.32, abrupt = true } = {}) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const r = rng(seed);
  const bpm = 100 + Math.floor(r() * 30);
  const beat = (60 / bpm) * sampleRate;
  const roots = [55, 49, 41.2, 46.25].map((f) => f * (1 + Math.floor(r() * 2)));
  let lp = 0;
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const tb = i / beat;
    const pos = tb % 1;
    const bar = Math.floor(tb / 4);
    const root = roots[bar % roots.length];
    const t = i / sampleRate;
    // Song shape: intro, build, chorus, (abrupt) end.
    const sect = t / seconds;
    const env = sect < 0.12 ? 0.45 : sect < 0.45 ? 0.75 : 1;
    const kickT = pos * (60 / bpm);
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-kickT * 30)) * kickT) * Math.exp(-kickT * 9);
    const beatIdx = Math.floor(tb) % 4;
    const noise = r() * 2 - 1;
    const snare = beatIdx % 2 === 1 ? noise * Math.exp(-kickT * 18) * 0.5 : 0;
    hp = 0.6 * (hp + noise - prev);
    prev = noise;
    const hat = (tb * 2) % 1 < 0.08 ? hp * 0.18 : 0;
    const bass = Math.sin(2 * Math.PI * root * t) * 0.55 * (0.6 + 0.4 * Math.exp(-pos * 3));
    let pad = 0;
    for (const m of [2, 2.52, 3, 4]) pad += ((root * m * t) % 1) * 2 - 1;
    lp += 0.08 * (pad * 0.12 - lp);
    const shimmer = Math.sin(2 * Math.PI * (9400 + 300 * Math.sin(t * 7)) * t) * 0.012 * (r() > 0.5 ? 1 : 0.3);
    const mono = (kick * 0.9 + snare + bass * 0.5) * env;
    L[i] = level * (mono + lp * env * 1.1 + hat * 0.9 + shimmer);
    R[i] = level * (mono + lp * env * 0.9 + hat * 1.1 + shimmer * 0.7);
  }
  if (!abrupt) {
    const f = Math.min(n, Math.round(2 * sampleRate));
    for (let i = 0; i < f; i++) {
      const g = Math.cos((i / f) * Math.PI * 0.5);
      L[n - f + i] *= g;
      R[n - f + i] *= g;
    }
  }
  return { sampleRate, channels: [L, R] };
}

// --- Fake measurement (unweighted BS.1770-like: 100 ms blocks, gated) ---

function measureFake(channels, sampleRate) {
  const n = channels[0].length;
  const blk = Math.max(1, Math.round(sampleRate * 0.1));
  const nb = Math.max(1, Math.floor(n / blk));
  const bp = new Float64Array(nb);
  let peak = 0;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (const ch of channels) {
      for (let i = b * blk; i < Math.min(n, (b + 1) * blk); i++) {
        const v = ch[i];
        s += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
    bp[b] = s / blk;
  }
  const lufs = (p) => -0.691 + 10 * Math.log10(Math.max(p, 1e-12));
  const curve = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, b - 29); k <= b; k++) {
      s += bp[k];
      c++;
    }
    curve[b] = lufs(s / c);
  }
  const gated = (thr) => {
    let s = 0;
    let c = 0;
    for (let b = 0; b < nb; b++) {
      if (lufs(bp[b]) > thr) {
        s += bp[b];
        c++;
      }
    }
    return c ? lufs(s / c) : -Infinity;
  };
  const abs = gated(-70);
  const integrated = gated(abs - 10);
  const st = Array.from(curve).filter((v) => v > integrated - 20).sort((a, b) => a - b);
  const lra = st.length > 2 ? st[Math.round((st.length - 1) * 0.95)] - st[Math.round((st.length - 1) * 0.1)] : 0;
  const samplePeakDb = 20 * Math.log10(Math.max(peak, 1e-9));
  const truePeakDb = samplePeakDb + 0.25;
  return {
    integrated,
    lra,
    shortTermMax: Math.max(...curve),
    momentaryMax: Math.max(...curve) + 1.5,
    truePeakDb,
    samplePeakDb,
    curve,
    curveHopSec: 0.1,
  };
}

function bump(f, center, oct, db) {
  const d = Math.log2(f / center) / oct;
  return db * Math.exp(-d * d);
}

function fakeLtas(level, seed, cutoff = 16500) {
  const r = rng(seed);
  return ISO.map((f) => {
    let v = level + 2 - 3.1 * Math.max(0, Math.log2(f / 220));
    v += bump(f, 70, 0.8, 2.5) + bump(f, 290, 0.5, 2.6) + bump(f, 3300, 0.4, 1.4) + bump(f, 9500, 0.35, 2.2);
    if (f < 32) v -= (32 - f) * 0.5;
    if (f > cutoff) v -= 26;
    return Math.round((v + (r() - 0.5) * 0.8) * 10) / 10;
  });
}

function fakeAnalysis(audio, id) {
  const seed = hash(id + audio.channels[0].length);
  const r = rng(seed);
  const m = measureFake(audio.channels, audio.sampleRate);
  const cutoff = r() > 0.5 ? 16000 : 20000;
  const issues = [
    { id: 'shimmer', severity: 0.62 + r() * 0.3, value: 4.2 },
    { id: 'muddy', severity: 0.4 + r() * 0.2, value: 2.6 },
    { id: 'abruptEnd', severity: 0.55, value: 1 },
    { id: 'sibilant', severity: 0.2 + r() * 0.2, value: 1.1 },
  ];
  if (cutoff < 17000) issues.push({ id: 'codecCutoff', severity: 0.38, value: cutoff });
  if (m.integrated < -16) issues.push({ id: 'tooQuiet', severity: 0.3, value: m.integrated });
  if (r() > 0.5) issues.push({ id: 'wideBass', severity: 0.72, value: 0.42 });
  const ltas = fakeLtas(m.integrated - 8, seed, cutoff);
  return {
    duration: audio.channels[0].length / audio.sampleRate,
    sampleRate: audio.sampleRate,
    loudness: { ...m, plr: m.truePeakDb - m.integrated },
    rmsDb: m.integrated - 3,
    crestDb: m.truePeakDb - m.integrated + 3,
    dcOffset: [0.0001, -0.0002],
    stereo: { correlation: 0.62, sideToMidDb: -11.5, nearMono: false, bandCorrelation: [0.55, 0.81, 0.7, 0.42], sideToMidHfDb: -5.2 },
    spectrum: { ltas, hfCutoffHz: cutoff, bands: { sub: -14, low: -6, lowMid: -4, mid: -5, highMid: -9, high: -14, air: -24 } },
    profile: cutoff < 17000 ? 'midband' : 'fullband',
    indices: { mud: 2.6, mudHz: 290, boom: 0.4, boomHz: 125, harsh: 1.1, harshHz: 3300, fizz: 0.6, fizzHz: 6200, sibilance: 1.1, sibilanceEventsPerMin: 6, air: -1.2, rumble: -3, shimmer: 4.2, hash: 0.3, hiss: -2, hfModulation: 0.4 },
    clipping: { samples: 0, pct: 0, runs: 0 },
    silence: { startSec: 0, endSec: 0 },
    abruptEnd: true,
    issues,
  };
}

// --- Fake assistant -------------------------------------------------------------------

function interp(row, t) {
  const ts = P.INTENSITY_TABLE.t;
  const ys = P.INTENSITY_TABLE[row];
  if (t <= ts[0]) return ys[0];
  for (let i = 1; i < ts.length; i++) if (t <= ts[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (t - ts[i - 1])) / (ts[i] - ts[i - 1]);
  return ys[ys.length - 1];
}

function suggestParams(analysis, choices) {
  const p = P.defaultParams();
  const d = P.DESTINATIONS[choices.destination] || P.DESTINATIONS.streaming;
  const t = Math.min(1, Math.max(0, choices.intensity ?? 0.5));
  const target = d.lufsRange ? d.lufsRange[0] + (d.lufsRange[1] - d.lufsRange[0]) * Math.min(1, Math.max(0, (t - 0.25) / 0.5)) : d.lufs;
  p.loudness.targetLufs = Math.round(target * 2) / 2;
  p.loudness.ceilingDb = p.loudness.targetLufs > -14 ? Math.min(d.ceilingDb, -2) : d.ceilingDb;
  p.loudness.budgetDb = interp('limiterBudgetDb', t);
  p.loudness.clipper.amountDb = interp('clipperDb', t);
  p.eq.auto.strength = interp('autoEqStrength', t);
  p.eq.auto.maxDb = interp('autoEqMaxDb', t);
  p.glue.ratio = interp('glueRatio', t);
  p.glue.targetGrDb = interp('glueTargetGrDb', t);
  p.color.saturation.drive = interp('saturationDrive', t);
  p.multiband.bands.forEach((b) => (b.targetGrDb = interp('multibandTargetGrDb', t)));
  const cl = P.CLEANUP_LEVELS[choices.cleanup] || P.CLEANUP_LEVELS.medium;
  const k = cl.k;
  const has = (id) => analysis.issues.some((i) => i.id === id);
  p.spectral.deShimmer.enabled = k > 0 && has('shimmer');
  p.spectral.deShimmer.amount = 0.5 * k;
  p.spectral.denoise.enabled = k > 0 && has('hiss');
  p.spectral.denoise.amount = cl.denoiseMaxDb / 12;
  p.dynEq.bands.mud.enabled = k > 0 && has('muddy');
  p.dynEq.bands.mud.maxCutDb = Math.min(4, 2.5 * k);
  p.dynEq.bands.mud.freq = analysis.indices.mudHz;
  p.dynEq.bands.deEss.enabled = k > 0 && has('sibilant');
  p.dynEq.bands.deEss.maxCutDb = Math.min(6, 4 * k);
  p.stereo.monoBassHz = has('wideBass') ? Math.max(cl.monoBassHz, 120) : cl.monoBassHz;
  const s = P.STYLES[choices.style] || P.STYLES.balanced;
  const sc = t / 0.5;
  p.eq.tone.tiltDbPerOct = s.tiltDbPerOct * sc;
  p.eq.tone.lowShelfDb = s.lowShelfDb * sc;
  p.eq.tone.lowShelfHz = s.lowShelfHz;
  p.eq.tone.presenceDb = s.presenceDb * sc;
  p.eq.tone.presenceHz = s.presenceHz;
  p.eq.tone.airDb = s.airDb * sc;
  p.color.saturation.drive = Math.max(0, p.color.saturation.drive + (s.drive > 0 ? s.drive * sc * 0.4 : s.drive < 0 ? -1 : 0));
  p.color.saturation.enabled = p.color.saturation.drive > 0;
  p.stereo.width = 1 + s.widthAdd * sc;
  if (choices.reference && choices.reference.ltas && choices.reference.ltas.length === 31) {
    p.eq.match.enabled = true;
    p.eq.match.referenceLtas = Array.from(choices.reference.ltas);
    p.eq.match.referenceName = choices.reference.name;
  }
  if (d.sampleRate) p.output.sampleRate = d.sampleRate;
  return P.validateParams(p);
}

function destFromParams(p) {
  let best = 'streaming';
  let err = Infinity;
  for (const id of P.DESTINATION_IDS) {
    const d = P.DESTINATIONS[id];
    const lo = d.lufsRange ? d.lufsRange[0] : d.lufs;
    const hi = d.lufsRange ? d.lufsRange[1] : d.lufs;
    const e = p.loudness.targetLufs < lo ? lo - p.loudness.targetLufs : p.loudness.targetLufs > hi ? p.loudness.targetLufs - hi : 0;
    if (e < err - 1e-9) {
      err = e;
      best = id;
    }
  }
  return best;
}

function describeDecisions(analysis, p) {
  const out = [];
  out.push({ key: 'dec.profile', vars: { profile: analysis.profile } });
  out.push({ key: 'dec.highpass', vars: { hz: p.prepare.highpassHz } });
  if (p.spectral.deShimmer.enabled) out.push({ key: 'dec.deShimmer', vars: { pct: Math.round(p.spectral.deShimmer.amount * 100), hz: p.spectral.deShimmer.startHz } });
  if (p.dynEq.bands.mud.enabled) out.push({ key: 'dec.mud', vars: { db: -p.dynEq.bands.mud.maxCutDb, hz: p.dynEq.bands.mud.freq } });
  if (p.dynEq.bands.deEss.enabled) out.push({ key: 'dec.deEss', vars: { db: -p.dynEq.bands.deEss.maxCutDb, hz: p.dynEq.bands.deEss.freq } });
  if (p.eq.auto.enabled) out.push({ key: 'dec.autoEq', vars: { db: p.eq.auto.maxDb } });
  if (p.eq.match.enabled) out.push({ key: 'dec.match', vars: { name: p.eq.match.referenceName, pct: Math.round(p.eq.match.strength * 100) } });
  if (p.eq.tone.tiltDbPerOct || p.eq.tone.lowShelfDb || p.eq.tone.presenceDb) {
    const style = P.STYLE_IDS.find((id) => P.STYLES[id].tiltDbPerOct && Math.sign(P.STYLES[id].tiltDbPerOct) === Math.sign(p.eq.tone.tiltDbPerOct)) || 'punchy';
    out.push({ key: 'dec.tone', vars: { style } });
  }
  if (p.color.saturation.enabled) out.push({ key: 'dec.saturation', vars: { pct: Math.round(p.color.saturation.drive * 100) } });
  if (p.multiband.enabled) out.push({ key: 'dec.multiband', vars: { db: p.multiband.bands[1].targetGrDb } });
  if (p.stereo.monoBassHz > 0) out.push({ key: 'dec.monoBass', vars: { hz: p.stereo.monoBassHz } });
  if (p.glue.enabled) out.push({ key: 'dec.glue', vars: { db: p.glue.targetGrDb } });
  out.push({ key: 'dec.loudness', vars: { lufs: p.loudness.targetLufs, ceiling: p.loudness.ceilingDb, dest: destFromParams(p) } });
  if (p.finish.fadeOutMs >= 1000) out.push({ key: 'dec.fadeOut', vars: { sec: p.finish.fadeOutMs / 1000 } });
  return out;
}

// --- Fake engine ------------------------------------------------------------------------

function eqCurveFor(p, analysis) {
  const tone = p.eq.tone;
  return ISO.map((f, i) => {
    let v = 0;
    v += tone.lowShelfDb / (1 + Math.pow(f / tone.lowShelfHz, 2));
    v += tone.presenceDb ? bump(f, tone.presenceHz, 0.9, tone.presenceDb) : 0;
    v += tone.airDb / (1 + Math.pow(tone.airHz / f, 2));
    v += tone.mudDb ? bump(f, tone.mudHz, 0.8, tone.mudDb) : 0;
    v += tone.boomDb ? bump(f, tone.boomHz, 0.5, tone.boomDb) : 0;
    v += tone.tiltDbPerOct * Math.log2(f / tone.tiltPivotHz);
    if (p.eq.auto.enabled) v += -p.eq.auto.strength * (bump(f, 290, 0.5, 2.2) + bump(f, 70, 0.8, 1.2));
    if (p.dynEq.bands.mud.enabled) v += bump(f, p.dynEq.bands.mud.freq, 0.4, -p.dynEq.bands.mud.maxCutDb / 2);
    if (p.eq.match.enabled && p.eq.match.referenceLtas) {
      const d = p.eq.match.referenceLtas[i] - analysis.spectrum.ltas[i];
      v += Math.max(-p.eq.match.maxDb, Math.min(p.eq.match.maxDb, d * 0.25 * p.eq.match.strength));
    }
    if (f < 30 || f > analysis.spectrum.hfCutoffHz) v = Math.min(v, 0);
    return Math.round(Math.max(-6, Math.min(6, v)) * 100) / 100;
  });
}

const STAGES = ['prepare', 'trim', 'spectral', 'eq', 'dyneq', 'color', 'multiband', 'stereo', 'glue', 'loudness', 'finish', 'verify'];
const STAGE_MS = { prepare: 60, trim: 20, spectral: 420, eq: 60, dyneq: 140, color: 80, multiband: 180, stereo: 40, glue: 90, loudness: 240, finish: 20, verify: 90 };

class FakeEngineClient {
  constructor() {
    this.audio = new Map();
    this.analysis = new Map();
    this.info = new Map();
    this.seq = new Map();
  }

  get mode() {
    return 'inline';
  }

  async loadTrack(id, audio, info = null) {
    this.audio.set(id, { sampleRate: audio.sampleRate, channels: audio.channels.map((c) => Float32Array.from(c)) });
    this.info.set(id, info || null);
    await sleep(40);
  }

  cancelRender(id) {
    H.cancels++;
    this.seq.set(id, (this.seq.get(id) || 0) + 1);
  }

  async analyze(id) {
    await sleep(700);
    const a = fakeAnalysis(this.audio.get(id), id);
    this.analysis.set(id, a);
    return a;
  }

  async render(id, params, onProgress) {
    const my = (this.seq.get(id) || 0) + 1;
    this.seq.set(id, my);
    H.lastParams = params;
    H.renders++;
    const src = this.audio.get(id);
    const an = this.analysis.get(id);
    if (!src || !an) throw { code: 'render', message: 'track not loaded' };
    for (const st of STAGES) {
      for (let k = 0; k <= 2; k++) {
        if (this.seq.get(id) !== my) throw { code: 'cancelled' };
        if (onProgress) onProgress(st, k / 2);
        await sleep(STAGE_MS[st] / 3);
      }
      if (H.failNextRender && st === 'multiband') {
        H.failNextRender = false;
        throw new Error('fake render failure');
      }
    }
    if (this.seq.get(id) !== my) throw { code: 'cancelled' };
    const p = params;
    const sr = p.output.sampleRate === 'source' ? src.sampleRate : p.output.sampleRate;
    let base = src;
    if (sr !== src.sampleRate) base = resampleAudio(src, sr);
    // Trim (C2 report.trim): the fake cuts a fixed 150 ms head so the A/B offset path runs.
    const startSample = p.trim && p.trim.enabled ? Math.round(0.15 * sr) : 0;
    if (startSample) base = { sampleRate: sr, channels: base.channels.map((c) => c.subarray(startSample)) };
    const n = base.channels[0].length;
    const c = dbToGain(p.loudness.ceilingDb - 0.05);
    let gainDb = p.loudness.targetLufs - an.loudness.integrated;
    let out = null;
    let inPeak = 0;
    for (let pass = 0; pass < 2; pass++) {
      const g = dbToGain(gainDb);
      out = base.channels.map((ch) => {
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = ch[i] * g;
          const a = Math.abs(x);
          if (a > inPeak) inPeak = a;
          y[i] = c * Math.tanh(x / c);
        }
        return y;
      });
      const m = measureFake(out, sr);
      gainDb += p.loudness.targetLufs - m.integrated;
    }
    const fade = Math.min(n, Math.round((p.finish.fadeOutMs / 1000) * sr));
    for (const ch of out) {
      for (let i = 0; i < fade; i++) ch[n - fade + i] *= Math.cos(((i + 1) / fade) * Math.PI * 0.5);
    }
    const audio = { sampleRate: sr, channels: out };
    const loud = measureFake(out, sr);
    const grMax = -Math.max(0, 20 * Math.log10(Math.max(inPeak, 1e-9)) - p.loudness.ceilingDb);
    const eqCurveDb = eqCurveFor(p, an);
    const ltas = an.spectrum.ltas.map((v, i) => Math.round((v + eqCurveDb[i] + loud.integrated - an.loudness.integrated) * 10) / 10);
    const warnings = [];
    if (p.loudness.targetLufs >= -9) warnings.push({ id: 'warn.loudArtifacts', vars: {} });
    if (-grMax > p.loudness.budgetDb) warnings.push({ id: 'heavyLimiting', vars: { gr: -grMax } });
    const info = this.info.get(id);
    if (info && info.lossy && info.bitrateKbps) warnings.push({ id: 'warn.lossySource', vars: { kbps: info.bitrateKbps } });
    if (p.spectral.deShimmer.amount > 0.7) warnings.push({ id: 'warn.qcRollback', vars: { module: 'deShimmer' } });
    const report = {
      loudness: loud,
      inputLoudness: an.loudness,
      limiter: { grAvgDb: grMax * 0.22, grMaxDb: grMax },
      clipper: { grMaxDb: -p.loudness.clipper.amountDb },
      multiband: p.multiband.bands.map((b) => ({ grAvgDb: -b.targetGrDb, grMaxDb: -b.targetGrDb * 3 })),
      glue: { grAvgDb: -p.glue.targetGrDb, grMaxDb: -p.glue.targetGrDb * 2.5 },
      deEss: { grAvgDb: -0.4, grMaxDb: -3.1 },
      deHarsh: { grAvgDb: -0.2, grMaxDb: -1.8 },
      spectral: { avgReductionDb: -0.6, maxReductionDb: -4.4 },
      targetLufs: p.loudness.targetLufs,
      ceilingDb: p.loudness.ceilingDb,
      targetReached: Math.abs(loud.integrated - p.loudness.targetLufs) <= 0.5,
      warnings,
      timingsMs: Object.fromEntries(STAGES.map((s) => [s, STAGE_MS[s]])),
      eqCurveDb,
      ltas,
      correlation: 0.71,
      bandCorrelation: [0.98, 0.86, 0.72, 0.5],
      qc: { passed: true, rollbacks: [] },
      paramsUsed: p,
      trim: { trimmed: startSample > 0, startSample, sampleRate: sr, startSec: startSample / sr, endSec: (startSample + n) / sr },
    };
    // C2: a source-rate copy for playback / waveform when the export rate differs.
    if (sr !== src.sampleRate) return { audio, report, preview: resampleAudio(audio, src.sampleRate) };
    return { audio, report };
  }

  async analyzeReference(audio) {
    await sleep(500);
    const m = measureFake(audio.channels, audio.sampleRate);
    return { ltas: fakeLtas(m.integrated - 6, hash('ref' + audio.channels[0].length), 20000).map((v, i) => v + (ISO[i] > 4000 ? 1.5 : 0)), loudness: m.integrated };
  }

  unload(id) {
    this.audio.delete(id);
    this.analysis.delete(id);
    this.seq.set(id, (this.seq.get(id) || 0) + 1);
  }
}

// --- Fake decode / codecs / save -------------------------------------------------------

const mp3Store = new Map();
let mp3Id = 0;

async function decodeFile(file) {
  const name = file.name || 'audio';
  if (name === 'x.mp3') {
    const text = await file.text();
    const entry = mp3Store.get(text);
    if (!entry) throw { code: 'corrupt', message: 'unknown fake mp3' };
    return { audio: entry.decoded, info: { name, baseName: 'x', ext: 'mp3', format: 'mp3' } };
  }
  await sleep(350);
  const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  if (!['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus'].includes(ext)) throw { code: 'unsupported', message: 'unsupported' };
  if (/corrupt|rotto/i.test(name)) throw { code: 'corrupt', message: 'corrupt' };
  const seed = hash(name);
  const sampleRate = ext === 'mp3' || ext === 'm4a' ? 44100 : 48000;
  const seconds = 18 + (seed % 10);
  const audio = synthSong({ sampleRate, seconds, seed, level: 0.18 + (seed % 7) / 40 });
  const baseName = name.replace(/\.[^.]+$/, '');
  return {
    audio,
    info: {
      name,
      baseName,
      ext,
      format: ext === 'aac' ? 'm4a' : ext,
      codec: ext,
      sampleRate,
      nativeSampleRate: sampleRate,
      decodedChannels: 2,
      bitDepth: ext === 'wav' || ext === 'flac' ? 24 : null,
      bitrateKbps: ext === 'mp3' ? 192 : ext === 'm4a' ? 256 : null,
      lossy: !['wav', 'flac'].includes(ext),
      duration: seconds,
      sizeBytes: file.size || 0,
    },
  };
}

// readMetadata: a file whose name contains "tag" carries a title, lyrics, a link and a
// 1×1 PNG cover; any other file has no metadata (as Suno WAVs).
const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
async function readMetadata(file) {
  // "lento": a slow read that ends only when a check calls H.releaseMeta()
  if (/lento/i.test(file.name || '')) await new Promise((res) => { H.releaseMeta = res; });
  else await sleep(20);
  const none = { format: 'other', tagTypes: [], tags: {}, extra: [], pictures: [], warnings: [] };
  if (!/tag/i.test(file.name || '')) return none;
  return {
    ...none,
    format: 'mp3',
    tagTypes: ['ID3v2.3'],
    tags: { title: 'Canzone di prova', artist: 'Artista di prova', album: 'Album di prova', date: '2025', year: '2025', genre: 'Pop', lyrics: 'Prima riga\nSeconda riga' },
    extra: [{ key: 'WOAS', label: 'Official audio source webpage', value: 'https://example.com/song/1' }, { key: 'TXXX:x', label: 'User text (x)', value: 'javascript:alert(1)' }],
    pictures: [{ mime: 'image/png', type: 3, typeLabel: 'Front cover', description: '', width: 1, height: 1, size: PNG_1PX.length, bytes: PNG_1PX }],
  };
}

function encodeWav(audio, { bitDepth = 24, metadata = null } = {}) {
  H.wavMeta = metadata;
  const nCh = audio.channels.length;
  const n = audio.channels[0].length;
  const bps = bitDepth / 8;
  const data = n * nCh * bps;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, audio.sampleRate, true);
  v.setUint32(28, audio.sampleRate * nCh * bps, true);
  v.setUint16(32, nCh * bps, true);
  v.setUint16(34, bitDepth, true);
  w(36, 'data');
  v.setUint32(40, data, true);
  let o = 44;
  const max = bitDepth === 16 ? 32767 : 8388607;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.round(Math.max(-1, Math.min(1, audio.channels[c][i])) * max);
      if (bitDepth === 16) v.setInt16(o, s, true);
      else {
        v.setUint8(o, s & 255);
        v.setUint8(o + 1, (s >> 8) & 255);
        v.setUint8(o + 2, (s >> 16) & 255);
      }
      o += bps;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function encodeMp3(audio, { kbps = 320, onProgress } = {}) {
  if (![32000, 44100, 48000].includes(audio.sampleRate)) throw new Error('bad mp3 rate ' + audio.sampleRate);
  for (let k = 0; k <= 10; k++) {
    if (onProgress) onProgress(k / 10);
    await sleep(60);
  }
  // Simulate a strong codec overshoot (+2.5 dB on the decoded MP3) so the −0.1 dBTP
  // check fails and the UI's re-render with a lower ceiling is exercised.
  const g = dbToGain(2.5);
  const decoded = { sampleRate: audio.sampleRate, channels: audio.channels.map((ch) => ch.map((x) => x * g)) };
  const key = `FAKEMP3:${++mp3Id}:${kbps}`;
  mp3Store.set(key, { decoded });
  return new Blob([key], { type: 'audio/mpeg' });
}

function makeZip(files) {
  return new Blob(files.map((f) => f.data), { type: 'application/zip' });
}

// saveBlob contract C4: { status: 'saved'|'declined'|'unavailable'|'busy'|'too_large', filename, code? }
async function saveBlob(blob, filename) {
  await sleep(150);
  console.info('[harness] save', filename, blob.size, 'bytes', H.save);
  H.saves.push({ filename, mode: H.save, size: blob.size });
  const zipName = /\.zip$/i.test(filename) ? filename : filename.replace(/\.[^.]+$/, '.zip');
  if (H.save === 'declined') return { status: 'declined', filename: zipName, code: 'declined' };
  if (H.save === 'busy') return { status: 'busy', filename: zipName, code: 'rate_limited' };
  if (H.save === 'too_large') return { status: 'too_large', filename: zipName, code: 'too_large' };
  if (H.save === 'unavailable') return { status: 'unavailable', filename: zipName, code: 'extension_not_enabled' };
  if (H.save === 'host') return { status: 'saved', filename: zipName };
  return { status: 'saved', filename };
}

// probeSaveSupport (C4): ?probe=none|host|browser, answered after a short delay as in a host.
const PROBE = new URLSearchParams(location.search).get('probe') || 'browser';
async function probeSaveSupport() {
  await sleep(300);
  return ['none', 'host', 'browser'].includes(PROBE) ? PROBE : 'browser';
}

function resampleAudio(audio, toRate) {
  if (audio.sampleRate === toRate) return audio;
  const ratio = audio.sampleRate / toRate;
  const n = Math.floor(audio.channels[0].length / ratio);
  return {
    sampleRate: toRate,
    channels: audio.channels.map((ch) => {
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const f = x - i0;
        y[i] = ch[i0] * (1 - f) + (ch[Math.min(ch.length - 1, i0 + 1)] || 0) * f;
      }
      return y;
    }),
  };
}

function truePeakDb(channels) {
  let m = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return 20 * Math.log10(Math.max(m, 1e-9));
}

function generateDemoTrack({ sampleRate = 48000, seconds = 32, seed = 7 } = {}) {
  return synthSong({ sampleRate, seconds, seed, level: 0.2 });
}

// --- Minimal real Web Audio player (A/B, loudness match, analyser) ----------------------

class FakePlayer {
  constructor({ onTime, onEnded, onStateChange } = {}) {
    this.cb = { onTime, onEnded, onStateChange };
    this.ctx = null;
    this.orig = null;
    this.mast = null;
    this.src = 'original';
    this.pos = 0;
    this.startedAt = 0;
    this._playing = false;
    this.nodes = [];
    this.match = { on: false, o: 1, m: 1 };
    this.vol = 1;
    this.offset = 0;
    this.buffers = new WeakMap();
    this.rng = null; // cut tool: { start, end, loop } range playback (Player contract)
    H.player = this;
  }

  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.gO = this.ctx.createGain();
    this.gM = this.ctx.createGain();
    this.out = this.ctx.createGain();
    this._an = this.ctx.createAnalyser();
    this._an.fftSize = 8192;
    this._an.smoothingTimeConstant = 0.8;
    this.gO.connect(this.out);
    this.gM.connect(this.out);
    this.out.connect(this._an);
    this._an.connect(this.ctx.destination);
    this._applyGains(0);
  }

  _buffer(audio) {
    let b = this.buffers.get(audio);
    if (!b) {
      b = this.ctx.createBuffer(2, audio.channels[0].length, audio.sampleRate);
      b.copyToChannel(audio.channels[0], 0);
      b.copyToChannel(audio.channels[1] || audio.channels[0], 1);
      this.buffers.set(audio, b);
    }
    return b;
  }

  _applyGains(ramp = 0.02) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const useM = this.src === 'master' && this.mast;
    const o = (useM ? 0 : 1) * (this.match.on ? this.match.o : 1);
    const m = (useM ? 1 : 0) * (this.match.on ? this.match.m : 1);
    for (const [g, v] of [[this.gO, o], [this.gM, m]]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(v, t + ramp);
    }
    this.out.gain.value = this.vol;
  }

  _stopNodes() {
    for (const n of this.nodes) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
  }

  _startNodes(at) {
    this._stopNodes();
    const r = this.rng;
    if (r && r.loop && (at < r.start || at >= r.end)) at = r.start;
    const mk = (audio, gain, from, shift) => {
      if (!audio) return;
      const s = this.ctx.createBufferSource();
      s.buffer = this._buffer(audio);
      s.connect(gain);
      const off = Math.min(from, s.buffer.duration);
      if (r && r.loop) {
        // Same loop span on both voices (original shifted by the offset): A/B stays aligned.
        s.loop = true;
        s.loopStart = r.start + shift;
        s.loopEnd = r.end + shift;
        s.start(0, off);
      } else if (r) s.start(0, off, Math.max(0.001, r.end - (from - shift)));
      else s.start(0, off);
      this.nodes.push(s);
      return s;
    };
    // C5: the master timeline is the reference; the original runs `offset` s ahead.
    const so = mk(this.orig, this.gO, at + this.offset, this.offset);
    const sm = mk(this.mast, this.gM, at, 0);
    const timeline = sm || so;
    if (timeline) {
      timeline.onended = () => {
        if (!this._playing) return;
        this._playing = false;
        const rr = this.rng;
        this.pos = rr && !rr.loop ? rr.start : 0; // a played range rewinds to its start
        this.rng = null;
        this._stopNodes();
        this.cb.onEnded && this.cb.onEnded();
        this.cb.onStateChange && this.cb.onStateChange();
      };
    }
    this.pos = at;
    this.startedAt = this.ctx.currentTime;
  }

  setTracks(original, mastered, { originalOffsetSec = 0 } = {}) {
    const same = this.orig && original && this.orig === original;
    if (!same) this.rng = null;
    const t = same ? this.currentTime : 0;
    this.orig = original;
    this.mast = mastered;
    this.offset = mastered && Number.isFinite(originalOffsetSec) ? Math.max(0, originalOffsetSec) : 0;
    if (!original) {
      this.pause();
      this.pos = 0;
      return;
    }
    this.pos = Math.min(t, this.duration);
    if (this._playing) this._startNodes(this.pos);
    this._applyGains(0);
  }

  /** Player contract: drop the cached buffer of a song that is not loaded (recorded in H.forgotten). */
  forget(audio) {
    (H.forgotten = H.forgotten || []).push(audio);
    if (audio && audio !== this.orig && audio !== this.mast) this.buffers.delete(audio);
  }

  replaceMastered(mastered, { originalOffsetSec = 0 } = {}) {
    this.mast = mastered;
    this.offset = Number.isFinite(originalOffsetSec) ? Math.max(0, originalOffsetSec) : 0;
    if (this._playing) this._startNodes(Math.min(this.currentTime, this.duration));
    this._applyGains(0.02);
  }

  async play() {
    if (!this.orig) return;
    this._ensure();
    await this.ctx.resume();
    if (this.rng && (this.pos < this.rng.start || this.pos >= this.rng.end)) this.rng = null;
    if (this.pos >= this.duration - 0.05) this.pos = 0;
    this._playing = true;
    this._startNodes(this.pos);
    this._applyGains(0);
    this.cb.onStateChange && this.cb.onStateChange();
  }

  pause() {
    if (!this._playing) return;
    this.pos = this.currentTime;
    this._playing = false;
    this._stopNodes();
    this.cb.onStateChange && this.cb.onStateChange();
  }

  toggle() {
    return this._playing ? this.pause() : this.play();
  }

  seek(sec) {
    this.pos = Math.max(0, Math.min(this.duration, sec));
    if (this.rng && (this.pos < this.rng.start || this.pos >= this.rng.end)) this.rng = null;
    if (this._playing) this._startNodes(this.pos);
    this.cb.onTime && this.cb.onTime(this.pos);
  }

  setSource(src) {
    this.src = src === 'master' ? 'master' : 'original';
    this._applyGains(0.02);
  }

  setLoudnessMatch(enabled, lo, lm) {
    const ok = enabled && Number.isFinite(lo) && Number.isFinite(lm);
    const d = ok ? lm - lo : 0;
    this.match = { on: ok, o: d < 0 ? dbToGain(d) : 1, m: d > 0 ? dbToGain(-d) : 1 };
    this._applyGains(0.02);
  }

  setVolume(v) {
    this.vol = Math.max(0, Math.min(1, v));
    if (this.out) this.out.gain.value = this.vol;
  }

  get currentTime() {
    if (!this._playing || !this.ctx) return this.pos;
    let t = this.pos + (this.ctx.currentTime - this.startedAt);
    const r = this.rng;
    if (r && r.loop && t >= r.end) t = r.start + ((t - r.start) % (r.end - r.start));
    else if (r) t = Math.min(t, r.end);
    return Math.min(this.duration, t);
  }

  get range() {
    return this.rng ? { ...this.rng } : null;
  }

  async playRange(start, end, { loop = false, from } = {}) {
    const s = Math.max(0, Math.min(this.duration, start));
    const e = Math.max(0, Math.min(this.duration, end));
    if (!(e - s >= 0.01)) return;
    this.rng = { start: s, end: e, loop: !!loop };
    const f = Number.isFinite(from) && from >= s && from < e ? from : s;
    if (this._playing) {
      this._startNodes(f);
      this.cb.onStateChange && this.cb.onStateChange();
      return;
    }
    this.pos = f;
    await this.play();
  }

  setRangeLoop(loop) {
    if (!this.rng || this.rng.loop === !!loop) return;
    const t = this.currentTime;
    this.rng.loop = !!loop;
    if (this._playing) this._startNodes(t);
  }

  clearRange() {
    if (!this.rng) return;
    const t = this.currentTime;
    this.rng = null;
    if (this._playing) this._startNodes(t);
  }

  get duration() {
    const a = this.mast || this.orig;
    return a ? a.channels[0].length / a.sampleRate : 0;
  }

  get playing() {
    return this._playing;
  }

  get source() {
    return this.src;
  }

  get analyser() {
    return this._an || null;
  }
}

// --- Boot -------------------------------------------------------------------------------

const q = new URLSearchParams(location.search);
const deps = {
  EngineClient: FakeEngineClient,
  decodeFile,
  Player: FakePlayer,
  encodeWav,
  encodeMp3,
  makeZip,
  saveBlob,
  probeSaveSupport,
  resampleAudio,
  truePeakDb,
  generateDemoTrack,
  suggestParams,
  describeDecisions,
  params,
  readMetadata,
};
// ?real=1 swaps in the real IO / playback modules that exist (engine stays fake), to check
// the UI against them. Missing modules keep their fake silently.
if (q.get('real')) {
  const tryImport = async (path, names) => {
    try {
      const m = await import(path);
      for (const n of names) if (m[n]) deps[n] = m[n];
    } catch (e) {
      console.warn('[harness] keeping fake for', path, e.message);
    }
  };
  await tryImport('../src/audio/player.js', ['Player']);
  await tryImport('../src/demo/demo-track.js', ['generateDemoTrack']);
  await tryImport('../src/export/wav.js', ['encodeWav']);
  await tryImport('../src/export/zip.js', ['makeZip']);
  await tryImport('../src/dsp/resample.js', ['resampleAudio']);
}
// ?check=1 starts from a clean state, as the checks expect: no saved choices or export
// settings (a stored "Altro…" destination has no button), Italian.
if (q.get('check')) {
  for (const k of ['am.choices', 'am.export']) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage blocked: nothing stored either */
    }
  }
  if (getLanguage() !== 'it') setLanguage('it');
}
const app = createApp(document.getElementById('app'), deps);
window.__app = app;
window.__harness = H;

const fakeFile = (name) => new File([new Uint8Array(64)], name, { type: 'audio/mpeg' });

function pressed(attr, value) {
  for (const b of document.querySelectorAll(`[${attr}]`)) b.setAttribute('aria-pressed', b.getAttribute(attr) === String(value) ? 'true' : 'false');
}
for (const b of document.querySelectorAll('[data-theme-set]')) {
  b.addEventListener('click', () => {
    const v = b.getAttribute('data-theme-set');
    if (v) document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
    pressed('data-theme-set', v);
  });
}
for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => {
    H.speed = Number(b.getAttribute('data-speed'));
    pressed('data-speed', H.speed);
  });
}
for (const b of document.querySelectorAll('[data-save]')) {
  b.addEventListener('click', () => {
    H.save = b.getAttribute('data-save');
    pressed('data-save', H.save);
  });
}
document.getElementById('hx-tracks').addEventListener('click', () => app.loadFiles([fakeFile('Notte di luglio.wav'), fakeFile('Ritorno a casa.mp3'), fakeFile('Neon Riviera (v2).flac')]));
document.getElementById('hx-corrupt').addEventListener('click', () => app.loadFiles([fakeFile('brano rotto.mp3')]));
document.getElementById('hx-unsupported').addEventListener('click', () => app.loadFiles([fakeFile('note.txt')]));
document.getElementById('hx-renderfail').addEventListener('click', () => {
  H.failNextRender = true;
});
pressed('data-theme-set', '');
pressed('data-speed', 1);
pressed('data-save', 'saved');

if (q.get('theme')) {
  document.documentElement.setAttribute('data-theme', q.get('theme'));
  pressed('data-theme-set', q.get('theme'));
}
if (q.get('demo')) app.loadDemo();
// ?open=1 unfolds spectrum, platforms, Avanzate and the sample-rate choice (visual review).
if (q.get('open')) {
  for (const id of ['am-spectrum', 'am-platforms', 'am-adv']) document.getElementById(id).open = true;
  document.getElementById('am-rate-change').click();
}
if (q.get('tracks')) {
  const names = ['Notte di luglio.wav', 'Ritorno a casa.mp3', 'Neon Riviera (v2).flac', 'Sale e vento.m4a'];
  app.loadFiles(names.slice(0, Math.max(1, Math.min(4, Number(q.get('tracks'))))).map(fakeFile));
}

// --- ?check=1: UI regression checks -----------------------------------------------------
// Run in a real browser (these DOM behaviours cannot be tested in
// Node). Each check says what it guards; results go to the page, the console and
// window.__checkResults. Start from a clean state: no stored language, no saved choices.

const $ = (sel) => document.querySelector(sel);
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 8000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    try {
      if (cond()) return true;
    } catch {
      /* not ready yet */
    }
    await pause(25);
  }
  return false;
}
const st = () => app.getState();
const activeTrack = () => st().tracks.find((x) => x.id === st().activeId);
const settled = () => st().tracks.every((x) => !x.rendering && !x.timer && !x.phase && !x.stale && (x.result || x.error)) && !st().exporting;
const lastToast = () => {
  const all = document.querySelectorAll('.toast .toast-msg');
  return all.length ? all[all.length - 1].textContent : '';
};
/** Ctrl (or another modifier set) + key on `el`; true when the app took it (undo / redo). */
function ctrlKey(el, key, o = {}) {
  const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...o });
  (el || document.body).dispatchEvent(ev);
  return ev.defaultPrevented;
}
const histSize = () => app.getHistory().size;
const undoName = () => $('#am-undo').getAttribute('aria-label');
const redoName = () => $('#am-redo').getAttribute('aria-label');
const lastToastEl = () => [...document.querySelectorAll('.toast')].pop() || null;
/** A pointer drag on a range input: pointerdown, one input per value (with optional pauses), pointerup. */
async function dragRange(el, values, { pauseMs = 0 } = {}) {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 1 }));
  for (const v of values) {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (pauseMs) await pause(pauseMs);
  }
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 0 }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Dispatch a cancelable Space keydown on `el`; true when the app took it as a shortcut. */
function spaceOn(el) {
  el.focus();
  const ev = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

async function runChecks() {
  const results = [];
  const ok = (c, msg) => {
    if (!c) throw new Error(msg);
  };
  const check = async (name, fn) => {
    try {
      const r = await fn();
      results.push({ name, ok: true, note: typeof r === 'string' ? r : '' });
    } catch (e) {
      results.push({ name, ok: false, note: String((e && e.message) || e) });
    }
  };
  H.speed = 0.15;

  await check('before a song only the drop zone and the destination show', () => {
    ok(visible($('#am-empty')) && visible($('#mod-dest')), 'drop zone / destination hidden');
    for (const s of ['#mod-style', '#mod-clean', '#am-export', '#am-meters', '#am-issues', '#am-spectrum', '#am-adv', '.transport']) ok(!visible($(s)), `${s} visible`);
  });
  await check('the sample rate has one home (no rack copy)', () => ok(!$('#adv-output-sampleRate'), 'rack select still there'));
  await check('the "Altro…" placeholder cannot be picked', () => ok($('#am-dest-more option[value=""]').disabled, 'placeholder enabled'));
  await check('h1, main landmark, named progress bars, no double live region', () => {
    ok($('h1') && $('main'), 'no h1 / main');
    for (const p of document.querySelectorAll('[role=progressbar]')) ok(p.getAttribute('aria-labelledby'), 'unnamed progressbar');
    ok(!$('.toasts').hasAttribute('aria-live'), 'toast container is a live region');
  });
  await check('Italian unless English was picked', () => ok(localStorage.getItem('am.lang') === 'en' || document.documentElement.lang === 'it', document.documentElement.lang));
  await check('Annulla / Ripeti sit in the header, off while there is nothing to undo, with a help card; the destination is undoable before any song', async () => {
    for (const id of ['#am-undo', '#am-redo']) ok(visible($(id)) && $(id).closest('header') && $(id).getAttribute('aria-disabled') === 'true', `${id} not in the header or not off`);
    ok(undoName() === 'Annulla' && redoName() === 'Ripeti' && /Ctrl/.test($('#am-undo').title), `${undoName()} / ${$('#am-undo').title}`);
    ok($('.hist-pair .help-btn'), 'no (i) beside the buttons');
    // Whatever the start (a main destination, or one from "Altro…"): it shows again after undo.
    const d0 = st().destination;
    const shows = (id) => ($(`#am-dest-${id}`) ? $(`#am-dest-${id}`).getAttribute('aria-checked') === 'true' : $('#am-dest-more').value === id);
    ok(shows(d0), `start ${d0} not shown`);
    const d1 = d0 === 'loud' ? 'streaming' : 'loud';
    const name = `Destinazione «${i18nT(`dest.${d1}`)}»`;
    $(`#am-dest-${d1}`).click();
    ok(undoName() === `Annulla: ${name}` && $('#am-undo').getAttribute('aria-disabled') === 'false', undoName());
    $('#am-undo').click();
    ok(st().destination === d0 && shows(d0), `destination ${st().destination}`);
    ok(redoName() === `Ripeti: ${name}` && /^Annullato: Destinazione/.test(lastToast()), `${redoName()} | ${lastToast()}`);
    app.getHistory().clear();
    $('#am-choose').focus();
  });

  // First song: the demo, started from the keyboard.
  $('#am-choose').focus();
  app.loadDemo();
  await check('focus moves to Play when the drop zone goes away', async () => {
    await waitFor(() => activeTrack() && activeTrack().audio && !$('#am-play').disabled);
    const a = document.activeElement;
    ok(a === $('#am-play'), `focus on ${a && (a.id || a.tagName)}`);
  });
  await waitFor(settled, 15000);
  await check('the finished master is announced', async () => {
    await waitFor(() => /Master/.test($('#am-status').textContent), 2000);
    return $('#am-status').textContent;
  });
  await check('export comes first (side column, or right after the tape)', () => {
    const exp = $('#am-export');
    const narrow = matchMedia('(max-width: 899px)').matches;
    ok(narrow ? exp.previousElementSibling === $('#am-tape') : exp.parentElement.firstElementChild === exp, 'export not first');
    ok(exp.compareDocumentPosition($('#am-meters')) & Node.DOCUMENT_POSITION_FOLLOWING, 'meters before export');
    return `download top ${Math.round($('#am-download').getBoundingClientRect().top)} px of ${innerHeight}`;
  });
  await check('meter column headers line up with their values', () => {
    const r = (s) => $(s).getBoundingClientRect().right;
    ok(Math.abs(r('.mcol-before') - r('.mbefore')) < 3 && Math.abs(r('.mcol-after') - r('.mafter')) < 3, `before ${r('.mcol-before')}/${r('.mbefore')} after ${r('.mcol-after')}/${r('.mafter')}`);
  });
  await check('Forte shows the target of the current intensity', async () => {
    $('#am-int-075').click();
    await pause(20);
    const high = $('#am-dest-loud .seg-sub').textContent;
    $('#am-int-05').click();
    await pause(20);
    const mid = $('#am-dest-loud .seg-sub').textContent;
    ok(high !== mid && /9/.test(high) && /10/.test(mid), `high "${high}" mid "${mid}"`);
    await waitFor(settled, 15000);
  });
  await check('during a re-render the meters say "updating", never a false verdict', async () => {
    $('#am-dest-loud').click();
    await pause(10);
    ok(visible($('#am-meters .badge-stale')), 'no updating badge');
    ok(![...document.querySelectorAll('.mstatus')].some(visible), 'a verdict is shown on the old master');
    ok(visible($('#am-decisions .stale-note')), 'decisions not marked');
    await waitFor(settled, 15000);
    ok(!visible($('#am-meters .badge-stale')) && visible($('.mrow-lufs .mstatus')), 'no verdict after the render');
    const v = $('.mrow-lufs .mstatus').textContent;
    $('#am-dest-streaming').click();
    await waitFor(settled, 15000);
    return v;
  });
  await check('"Suona troppo": net cap greys the button; the path is user-owned', async () => {
    let clicks = 0;
    while ($('#am-prob-muddy').getAttribute('aria-disabled') !== 'true' && clicks < 10) {
      $('#am-prob-muddy').click();
      clicks++;
    }
    ok(clicks === 3, `${clicks} clicks to the cap`);
    await waitFor(() => settled() && H.lastParams && H.lastParams.eq.tone.mudDb <= -4.4, 15000);
    ok(H.lastParams.meta && H.lastParams.meta.userOwned.includes('eq.tone.mudDb'), JSON.stringify(H.lastParams.meta));
    $('#am-prob-reset').click();
    await waitFor(settled, 15000);
  });
  await check('going back to the previous settings cancels the running render', async () => {
    H.speed = 1;
    const before = H.cancels;
    $('#am-style-warm').click();
    await waitFor(() => activeTrack().rendering, 3000);
    $('#am-style-balanced').click();
    await waitFor(() => H.cancels > before, 3000);
    H.speed = 0.15;
    ok(H.cancels > before, 'no cancelRender');
    await waitFor(settled, 15000);
  });
  await check('WAV 16-bit moves to 44.1 kHz and leaving it moves back', async () => {
    $('#am-format-wav16').click();
    const a = $('#am-rate-summary').textContent;
    $('#am-format-wav24').click();
    const b = $('#am-rate-summary').textContent;
    ok(/44[,.]1/.test(a) && !/44[,.]1/.test(b) && st().exportRate === 'source', `"${a}" → "${b}"`);
    await waitFor(settled, 15000);
  });
  await check('Space keeps its meaning on switches, sliders and <summary>', () => {
    for (const s of ['#am-match', '#am-int-fine', '#am-adv > summary', '#am-dest-loud']) ok(!spaceOn($(s)), `${s} lost Space`);
  });
  await check('diagnosis chips say what the master did, from its decisions', async () => {
    const chip = () => [...document.querySelectorAll('#am-issues-list .chip')].find((li) => /metallico|metallic/i.test(li.textContent));
    chip().querySelector('.chip-main').click();
    ok(chip().querySelector('.chip-done'), 'no "done" line with cleanup on');
    $('#am-clean-off').click();
    await waitFor(settled, 15000);
    const not = chip().querySelector('.chip-not');
    ok(not && /No|Off/.test(not.textContent), 'no "not corrected" line with cleanup off');
    chip().querySelector('.chip-main').click();
    $('#am-clean-medium').click();
    await waitFor(settled, 15000);
  });
  await check('a song loaded after the demo takes over the screen', async () => {
    await app.loadFiles([fakeFile('La mia canzone.mp3')]);
    ok(activeTrack().name === 'La mia canzone', `active: ${activeTrack().name}`);
    ok(/La mia canzone/.test($('#am-filename').textContent), $('#am-filename').textContent);
    await waitFor(settled, 15000);
  });
  await check('undoing a step of another song switches to that song first and says so', async () => {
    const mine = activeTrack();
    const s0 = mine.choices.style;
    $('#am-style-punchy').click();
    ok(mine.choices.style === 'punchy', 'style not set');
    const demoChip = [...document.querySelectorAll('.track-chip-main')].find((b) => /Demo/.test(b.textContent));
    demoChip.click();
    ok(activeTrack() !== mine, 'still on the same song');
    ok(ctrlKey(document.body, 'z'), 'Ctrl+Z not taken');
    ok(activeTrack() === mine && mine.choices.style === s0 && $(`#am-style-${s0}`).getAttribute('aria-checked') === 'true', `active ${activeTrack().name}, style ${mine.choices.style}`);
    const detail = lastToastEl() && lastToastEl().querySelector('.toast-detail');
    ok(detail && /La mia canzone/.test(detail.textContent), detail ? detail.textContent : 'no song named in the toast');
    ok(ctrlKey(document.body, 'z', { shiftKey: true }) && mine.choices.style === 'punchy', 'redo');
    ctrlKey(document.body, 'z');
    ok(mine.choices.style === s0 && activeTrack() === mine);
    await waitFor(settled, 15000);
  });
  await check('undo of another song while it renders drops that render and keeps the master it had (1 render, 1 cancel); a failed render there is retried', async () => {
    await waitFor(settled, 15000);
    const mine = activeTrack();
    const chipOf = (re) => [...document.querySelectorAll('.track-chip-main')].find((b) => re.test(b.textContent));
    const toOther = () => chipOf(/Demo/).click();
    const s0 = mine.choices.style;
    const s1 = s0 === 'bright' ? 'warm' : 'bright';
    const res0 = mine.result;
    const key0 = mine.resultKey;
    H.speed = 1;
    try {
      const r0 = H.renders;
      const c0 = H.cancels;
      $(`#am-style-${s1}`).click();
      ok(await waitFor(() => mine.rendering, 3000), 'no render started');
      toOther();
      ok(activeTrack() !== mine, 'still on the same song');
      ok(ctrlKey(document.body, 'z'), 'Ctrl+Z not taken');
      ok(activeTrack() === mine && mine.choices.style === s0, `active ${activeTrack().name}, style ${mine.choices.style}`);
      ok(!mine.rendering && mine.result === res0 && mine.resultKey === key0, 'the render of the undone style still runs');
      await waitFor(settled, 15000);
      ok(mine.result === res0 && H.renders - r0 === 1 && H.cancels - c0 === 1, `renders ${H.renders - r0}, cancels ${H.cancels - c0}, master kept ${mine.result === res0}`);
      // A render that failed on the song undone from elsewhere: the undo retries it, as on the song itself.
      H.failNextRender = true;
      $(`#am-style-${s1}`).click();
      ok(await waitFor(() => mine.error, 6000), 'the render did not fail');
      toOther();
      ok(ctrlKey(document.body, 'z') && activeTrack() === mine && mine.choices.style === s0, 'undo');
      await waitFor(settled, 15000);
      ok(!mine.error && mine.result === res0, `error ${mine.error}`);
    } finally {
      H.failNextRender = false;
      H.speed = 0.15;
    }
  });
  await check('a lossy source shows the "WAV from Suno" tip (C3 info)', () => {
    const w = $('#am-warn-list').textContent;
    ok(/192/.test(w) && visible($('#am-warn-list')), w || 'no warning');
  });
  await check('with several songs the scope is shown and can be applied to all', async () => {
    ok(visible($('#am-scope')) && visible($('#mod-style .scope-tag')), 'no scope cue');
    $('#am-apply-all').click();
    ok(/tutti|all/i.test(lastToast()), lastToast());
    await waitFor(settled, 15000);
  });
  await check('a manual loudness gives way to a new destination; the toast\'s Annulla is the global undo (destination and loudness back), Ripeti redoes it', async () => {
    $('#am-adv').open = true;
    const f = $('#adv-loudness-targetLufs');
    const tr = activeTrack();
    f.value = '-12';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    ok(tr.overrides['loudness.targetLufs'] === -12, 'override not set');
    $('#am-dest-hifi').click();
    ok(tr.overrides['loudness.targetLufs'] === undefined, 'override kept');
    ok(undoName() === 'Annulla: Destinazione «Hi-Fi»', undoName());
    const undo = [...document.querySelectorAll('.toast-action')].pop();
    ok(undo, 'no undo');
    undo.click();
    ok(tr.overrides['loudness.targetLufs'] === -12 && st().destination === 'streaming', `undo did not restore (${st().destination}, ${tr.overrides['loudness.targetLufs']})`);
    ok(/^Annullato: Destinazione «Hi-Fi»/.test(lastToast()), lastToast());
    ok(ctrlKey(document.body, 'z', { shiftKey: true }) && st().destination === 'hifi' && tr.overrides['loudness.targetLufs'] === undefined, 'redo');
    ok(ctrlKey(document.body, 'z') && st().destination === 'streaming' && tr.overrides['loudness.targetLufs'] === -12, 'undo again');
    // The toast's Annulla belongs to its step: once another step is on top it goes.
    $('#am-dest-hifi').click();
    const t = lastToastEl();
    ok(t && t.querySelector('.toast-action'), 'no Annulla in the toast');
    $('#am-style-bright').click();
    ok(!t.querySelector('.toast-action'), 'the toast still offers an Annulla of an older step');
    ctrlKey(document.body, 'z');
    ctrlKey(document.body, 'z');
    ok(st().destination === 'streaming' && tr.overrides['loudness.targetLufs'] === -12 && tr.choices.style !== 'bright', 'two undos');
    f.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); // back to automatic
    ok(tr.overrides['loudness.targetLufs'] === undefined, 'double-click reset');
    $('#am-adv').open = false;
    await waitFor(settled, 15000);
  });
  await check('songs left out of a ZIP are named', async () => {
    H.failNextRender = true;
    await app.loadFiles([fakeFile('Brano fallito.wav')]);
    await waitFor(settled, 15000);
    const failed = st().tracks.find((x) => x.name === 'Brano fallito');
    ok(failed && failed.error, 'render did not fail');
    $('#am-export-all').click();
    await waitFor(() => [...document.querySelectorAll('.toast-msg')].some((m) => /Brano fallito/.test(m.textContent)), 3000);
    ok([...document.querySelectorAll('.toast-msg')].some((m) => /Brano fallito/.test(m.textContent)), 'no notice');
    await waitFor(() => !st().exporting, 20000);
  });
  await check('removing songs down to one keeps focus (on "Aggiungi brani"); their undo steps go with them', async () => {
    const gone = st().tracks.slice(1).map((x) => x.id);
    while (st().tracks.length > 1) {
      const xs = document.querySelectorAll('.track-chip-x'); // newest first: the demo stays
      const x = xs[xs.length - 1];
      x.focus();
      x.click();
      await pause(20);
    }
    ok(document.activeElement === $('#am-add'), `focus on ${document.activeElement && (document.activeElement.id || document.activeElement.tagName)}`);
    const { undo, redo } = app.getHistory().steps;
    const left = [...undo, ...redo].filter((x) => gone.includes(x.trackId) || x.before.tracks.some((y) => gone.includes(y.id)));
    ok(!left.length, `${left.length} steps still refer to removed songs`);
    await waitFor(settled, 15000);
  });
  // --- Undo / redo (history.js) on one song --------------------------------------------
  await check('Carattere: Ctrl/⌘+Z undoes, Shift+Ctrl/⌘+Z and Ctrl+Y redo, the buttons name the step, a toast says it; undone before rendering = no render', async () => {
    const tr = activeTrack();
    const s0 = tr.choices.style;
    ok(s0 !== 'warm', s0);
    const r0 = H.renders;
    $('#am-style-warm').click();
    ok(undoName() === 'Annulla: Carattere «Caldo»', undoName());
    ok(ctrlKey(document.body, 'z'), 'Ctrl+Z not taken');
    ok(tr.choices.style === s0 && $(`#am-style-${s0}`).getAttribute('aria-checked') === 'true', `not undone: ${tr.choices.style}`);
    ok(lastToast() === 'Annullato: Carattere «Caldo»', lastToast());
    ok(redoName() === 'Ripeti: Carattere «Caldo»' && $('#am-redo').getAttribute('aria-disabled') === 'false', redoName());
    ok(ctrlKey(document.body, 'y') && tr.choices.style === 'warm', 'Ctrl+Y');
    ok(ctrlKey(document.body, 'z', { ctrlKey: false, metaKey: true }) && tr.choices.style === s0, '⌘Z');
    ok(ctrlKey(document.body, 'Z', { ctrlKey: false, metaKey: true, shiftKey: true }) && tr.choices.style === 'warm', 'Shift+⌘Z');
    ok(/^Ripetuto: Carattere «Caldo»/.test(lastToast()), lastToast());
    ok([...document.querySelectorAll('.toast-msg')].filter((m) => /^(Annullato|Ripetuto):/.test(m.textContent)).length === 1, 'undo / redo toasts pile up');
    ctrlKey(document.body, 'z');
    await waitFor(settled, 15000);
    ok(H.renders === r0, `${H.renders - r0} render(s) for a change undone before it rendered`);
    // A new action clears Ripeti; nothing to redo: the button is off.
    $('#am-clean-light').click();
    ok($('#am-redo').getAttribute('aria-disabled') === 'true' && redoName() === 'Ripeti', `redo after a new action: ${redoName()}`);
    $('#am-undo').click();
    ok(tr.choices.cleanup !== 'light', 'cleanup not undone');
    await waitFor(settled, 15000);
  });
  await check('a drag of the intensity slider is ONE step (pauses while held too); Ctrl+Z on the focused slider moves it back', async () => {
    const tr = activeTrack();
    const i0 = tr.choices.intensity;
    const sl = $('#am-int-fine');
    const n0 = histSize().undo;
    await dragRange(sl, [0.55, 0.6, 0.65], { pauseMs: 15 });
    await pause(700); // pointer released and the merge window over: the next drag is new
    await dragRange(sl, [0.68]);
    ok(histSize().undo === n0 + 2, `${histSize().undo - n0} steps for two drags`);
    ok(undoName() === 'Annulla: Intensità «68%»', undoName());
    await pause(20);
    await dragRange(sl, [0.7, 0.72], { pauseMs: 700 }); // held: pauses longer than the window
    ok(histSize().undo === n0 + 3, `held drag with pauses made ${histSize().undo - n0 - 2} steps`);
    sl.focus();
    ok(ctrlKey(sl, 'z'), 'Ctrl+Z on the slider not taken');
    ok(Math.abs(tr.choices.intensity - 0.68) < 1e-9 && Math.abs(Number(sl.value) - 0.68) < 1e-9, `after 1 undo ${tr.choices.intensity} / slider ${sl.value}`);
    ctrlKey(sl, 'z');
    ctrlKey(sl, 'z');
    ok(tr.choices.intensity === i0 && Math.abs(Number(sl.value) - i0) < 1e-9, `back to ${i0}: ${tr.choices.intensity} / slider ${sl.value}`);
    ok($('#am-int-05').getAttribute('aria-checked') === (i0 === 0.5 ? 'true' : 'false'), 'preset buttons not in sync');
    sl.blur();
    await waitFor(settled, 15000);
  });
  await check('an Avanzate fader drag is one step, its double-click reset another; undo / redo walk them', async () => {
    $('#am-adv').open = true;
    const tr = activeTrack();
    const f = [...document.querySelectorAll('#am-adv .rack-range input[type="range"]')].find((x) => !x.disabled && !/loudness/.test(x.id));
    const path = f.closest('.rack-row').dataset.path;
    ok(!(path in tr.overrides), `${path} already set`);
    const auto = Number(f.value);
    const n0 = histSize().undo;
    const lo = Number(f.min);
    const hi = Number(f.max);
    await dragRange(f, [0.3, 0.4, 0.5].map((x) => lo + (hi - lo) * x), { pauseMs: 10 });
    ok(histSize().undo === n0 + 1 && path in tr.overrides, `${histSize().undo - n0} steps, override ${tr.overrides[path]}`);
    const v = tr.overrides[path];
    ok(undoName().startsWith('Annulla: ') && undoName().includes('«'), undoName());
    await pause(700);
    f.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    ok(!(path in tr.overrides) && histSize().undo === n0 + 2 && /: automatico$/.test(undoName()), `reset: ${undoName()}`);
    ok(ctrlKey(document.body, 'z') && tr.overrides[path] === v, 'undo of the reset');
    ok(ctrlKey(document.body, 'z') && !(path in tr.overrides) && Math.abs(Number(f.value) - auto) < 1e-6, `undo of the drag: fader ${f.value} vs ${auto}`);
    ok(ctrlKey(document.body, 'z', { shiftKey: true }) && tr.overrides[path] === v && f.closest('.rack-row').classList.contains('is-modified'), 'redo of the drag');
    ctrlKey(document.body, 'z');
    ok(!(path in tr.overrides), 'override left behind');
    $('#am-adv').open = false;
    await waitFor(settled, 15000);
    return path;
  });
  await check('each "Suona troppo" click is its own step; Azzera is one more', async () => {
    const tr = activeTrack();
    const n0 = histSize().undo;
    $('#am-prob-harsh').click();
    const v1 = tr.problemOffsets.harsh;
    $('#am-prob-harsh').click();
    const v2 = tr.problemOffsets.harsh;
    ok(v1 < 0 && v2 < v1 && histSize().undo === n0 + 2, `offsets ${v1} ${v2}, ${histSize().undo - n0} steps`);
    ok(undoName() === 'Annulla: Suona troppo… «Aspro»', undoName());
    $('#am-prob-reset').click();
    ok(!tr.problemOffsets.harsh && undoName() === 'Annulla: Azzera «Suona troppo…»', undoName());
    $('#am-undo').click();
    ok(tr.problemOffsets.harsh === v2, 'reset not undone');
    $('#am-undo').click();
    ok(tr.problemOffsets.harsh === v1 && /1[,.]5/.test($('#am-prob-harsh .prob-off').textContent), `one click: ${tr.problemOffsets.harsh} "${$('#am-prob-harsh .prob-off').textContent}"`);
    $('#am-undo').click();
    ok(!tr.problemOffsets.harsh && !$('#am-prob-harsh').classList.contains('is-set'), 'not back to none');
    $('#am-redo').click();
    $('#am-redo').click();
    ok(tr.problemOffsets.harsh === v2, 'redo x2');
    $('#am-undo').click();
    $('#am-undo').click();
    await waitFor(settled, 15000);
  });
  await check('Ctrl/⌘+Z never acts in a text field (its own text undo) nor behind an open help card', async () => {
    const tr = activeTrack();
    $('#am-style-bright').click();
    const n = histSize().undo;
    $('#am-cut-toggle').click();
    const f = $('#am-cut-in');
    f.focus();
    ok(!ctrlKey(f, 'z') && histSize().undo === n && tr.choices.style === 'bright', 'Ctrl+Z in a text field undid a step');
    f.blur();
    $('#am-cut-toggle').click();
    $('.hist-pair .help-btn').click();
    await pause(30);
    const close = $('.help-pop .help-close');
    ok(close && visible(close), 'no help card');
    close.focus();
    ok(!ctrlKey(close, 'z') && tr.choices.style === 'bright', 'Ctrl+Z acted behind the help card');
    ctrlKey(close, 'Escape', { ctrlKey: false });
    ok(!visible($('.help-pop')), 'card not closed');
    ok(ctrlKey(document.body, 'z') && tr.choices.style !== 'bright', 'undo after the card closed');
    await waitFor(settled, 15000);
  });
  // --- Cut tool (cut.js): selection, range playback, clip of the master, edits + undo ---
  const wave = () => $('#am-wave');
  const ptr = (type, fx) => {
    const r = wave().getBoundingClientRect();
    wave().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + r.width * fx, clientY: r.top + r.height * 0.4 }));
  };
  const typeTime = (sel, text) => {
    const f = $(sel);
    f.focus();
    f.value = text;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  const parseTimecodeLike = (x) => {
    const [m, r] = String(x).replace(',', '.').split(':');
    return Number(m) * 60 + Number(r);
  };
  const keyOn = (el, key) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  await check('Taglia: closed by default (simple view unchanged), opens the bar right under the waveform (on a phone after the transport)', () => {
    ok(visible($('#am-cut-toggle')) && !visible($('#am-cut')) && !visible($('#am-edit-strip')), 'bar or strip visible by default');
    $('#am-cut-toggle').click();
    ok(visible($('#am-cut')) && $('#am-cut-toggle').getAttribute('aria-expanded') === 'true', 'bar not open');
    // On a phone Play, the time and Originale / Master stay right under the waveform.
    const phone = matchMedia('(max-width: 520px)').matches;
    const tr = $('#am-tape .transport');
    if (phone) {
      ok($('#am-screen').nextElementSibling === $('#am-progress') && $('#am-progress').nextElementSibling === tr, 'phone: transport not right under the waveform');
      ok(tr.compareDocumentPosition($('#am-cut')) & Node.DOCUMENT_POSITION_FOLLOWING, 'phone: bar not after the transport');
    } else ok($('#am-screen').nextElementSibling === $('#am-cut'), 'bar not right under the waveform');
    ok(wave().getAttribute('aria-describedby') === 'am-cut-howto', 'waveform not described in cut mode');
    // The accessible name of "Imposta dal cursore" starts with its visible text.
    for (const b of document.querySelectorAll('#am-cut .cut-from')) ok(b.getAttribute('aria-label').startsWith(b.textContent.trim()), `"${b.getAttribute('aria-label')}" vs "${b.textContent.trim()}"`);
    return phone ? 'phone layout' : 'wide layout';
  });
  await check('drag selects; IN/OUT fields follow; typed times (comma or dot) move an edge; bad input is flagged, Esc restores', async () => {
    ptr('pointerdown', 0.2);
    ptr('pointermove', 0.25);
    ptr('pointermove', 0.5);
    ptr('pointerup', 0.5);
    await pause(30);
    const a = $('#am-cut-in').value;
    const b = $('#am-cut-out').value;
    ok(a && b && !$('#am-cut-keep').disabled && !$('#am-cut-save').disabled, `after drag: "${a}" "${b}"`);
    typeTime('#am-cut-in', '0:02,5');
    ok(/^0:02[,.]500$/.test($('#am-cut-in').value), $('#am-cut-in').value);
    // Plain seconds work, the fields do not open the colon-less decimal pad, the error says so.
    typeTime('#am-cut-out', '7,5');
    ok(/^0:07[,.]500$/.test($('#am-cut-out').value), $('#am-cut-out').value);
    ok(!$('#am-cut-in').hasAttribute('inputmode') && !$('#am-cut-out').hasAttribute('inputmode') && $('#am-cut-fade-in').getAttribute('inputmode') === 'decimal', 'IN / OUT open the decimal pad (no ":")');
    ok(/83[,.]5/.test($('#am-cut-in-err').textContent) && /83[,.]5/.test($('#am-cut-howto').textContent), 'seconds not mentioned');
    typeTime('#am-cut-out', '6.0');
    ok(/^0:06[,.]000$/.test($('#am-cut-out').value), $('#am-cut-out').value);
    const f = $('#am-cut-in');
    f.value = '1:7x';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    ok(f.getAttribute('aria-invalid') === 'true' && visible($('#am-cut-in-err')), 'invalid input not flagged');
    keyOn(f, 'Escape');
    ok(f.getAttribute('aria-invalid') === 'false' && /^0:02[,.]500$/.test(f.value), `Esc did not restore (${f.value})`);
    f.blur();
    ok(/3[,.]500/.test($('.cut-dur').textContent), $('.cut-dur').textContent);
    return `${$('#am-cut-in').value} → ${$('#am-cut-out').value}`;
  });
  await check('Ascolta selezione sets a range on the player; Loop loops it on both voices; A/B keeps it', async () => {
    const pl = H.player;
    $('#am-cut-listen').click();
    await waitFor(() => pl.range, 1500);
    ok(pl.range && Math.abs(pl.range.start - 2.5) < 0.01 && Math.abs(pl.range.end - 6) < 0.01 && !pl.range.loop, JSON.stringify(pl.range));
    $('#am-cut-loop').click();
    ok(pl.range.loop && $('#am-cut-loop').getAttribute('aria-pressed') === 'true', 'loop not on');
    let note = 'no user gesture: playback not started';
    if (pl.playing) {
      ok(pl.nodes.length && pl.nodes.every((x) => x.loop), 'voices not looping');
      $('#am-ab-original').click();
      $('#am-ab-master').click();
      ok(pl.range && pl.range.loop && pl.playing, 'A/B left the loop');
      $('#am-cut-listen').click();
      note = 'played and looped';
    }
    $('#am-cut-loop').click();
    pl.pause();
    pl.clearRange();
    return note;
  });
  await check('Salva la selezione saves just that part of the MASTER, named "<nome> (Master) 0m02s-0m06s"', async () => {
    const n = H.saves.length;
    $('#am-cut-save').click();
    await waitFor(() => H.saves.length > n && !st().exporting, 8000);
    const last = H.saves[H.saves.length - 1];
    ok(last && /\(Master\) 0m02s-0m06s\.wav$/.test(last.filename), last && last.filename);
    const m = activeTrack().result.audio;
    const expect = Math.round(3.5 * m.sampleRate) * 2 * 3 + 44;
    ok(Math.abs(last.size - expect) <= 12, `size ${last.size} vs ${expect} (3.5 s of 24-bit stereo)`);
    ok(/Salvato|Saved/.test(lastToast()), lastToast());
    return last.filename;
  });
  await check('Elimina la selezione: shorter song, "Modificato", re-analysis + re-master of the edit, focus on the global Annulla named after it; Annulla restores, Ripeti re-applies', async () => {
    const tr = activeTrack();
    const len0 = tr.audio.channels[0].length;
    const sr = tr.audio.sampleRate;
    const renders = H.renders;
    // The header in sight (a later check covers a phone, where it is scrolled away).
    window.scrollTo(0, 0);
    $('#am-cut-remove').focus({ preventScroll: true });
    $('#am-cut-remove').click();
    ok(tr.edits && tr.audio.channels[0].length < len0, 'not edited');
    ok(visible($('#am-edit-strip')) && visible($('.track-single .badge-edit')), 'no "Modificato"');
    ok(!$('#am-cut-undo'), 'the strip still has its own Annulla');
    ok(document.activeElement === $('#am-undo') && undoName() === 'Annulla: Elimina la selezione', `focus on ${document.activeElement && document.activeElement.id}, ${undoName()}`);
    ok(lastToastEl() && lastToastEl().querySelector('.toast-action'), 'the cut toast offers no Annulla');
    await waitFor(settled, 15000);
    ok(H.renders > renders && tr.result && tr.analysis, 'not re-mastered');
    const removed = (len0 - tr.audio.channels[0].length) / sr;
    ok(Math.abs(removed - 3.5) < 0.005, `removed ${removed} s`);
    ok(!$('#am-cut-in').value, 'selection kept across the edit');
    // The player lets go of the unedited song's buffer (kept on the track for undo).
    ok((H.forgotten || []).includes(tr.source) && tr.audio !== tr.source, 'unedited source buffer not released');
    const edits = tr.edits;
    $('#am-undo').focus();
    $('#am-undo').click();
    ok(!tr.edits && tr.audio.channels[0].length === len0 && !visible($('#am-edit-strip')), 'undo failed');
    // Focus stays on a control, never on <body>.
    ok(document.activeElement === $('#am-undo'), `focus after undo on ${document.activeElement && (document.activeElement.id || document.activeElement.tagName)}`);
    ok(redoName() === 'Ripeti: Elimina la selezione', redoName());
    await waitFor(settled, 15000);
    ok(ctrlKey(document.body, 'z', { shiftKey: true }) && tr.edits === edits && Math.abs((len0 - tr.audio.channels[0].length) / sr - 3.5) < 0.005, 'redo did not re-apply the same cut');
    await waitFor(settled, 15000);
    ok(tr.result && tr.analysis, 'not re-mastered after redo');
    ctrlKey(document.body, 'z');
    ok(!tr.edits && tr.audio.channels[0].length === len0, 'second undo');
    await waitFor(settled, 15000);
    return `removed ${removed.toFixed(3)} s, undone, redone, undone`;
  });
  await check('Tieni solo: the edit survives a language switch and a destination change; Torna al brano completo is undoable (toast and header)', async () => {
    typeTime('#am-cut-in', '1');
    typeTime('#am-cut-out', '4,0');
    $('#am-cut-keep').click();
    const tr = activeTrack();
    ok(tr.edits && Math.abs(tr.audio.channels[0].length / tr.audio.sampleRate - 3) < 0.005, `kept ${tr.audio.channels[0].length / tr.audio.sampleRate} s`);
    await waitFor(settled, 15000);
    $('#am-lang-en').click();
    ok(tr.edits && /Edited/.test($('#am-edit-strip').textContent) && /Edited/.test($('.track-single').textContent), 'edit lost on language switch');
    $('#am-dest-loud').click();
    await waitFor(settled, 15000);
    ok(tr.edits && tr.result && visible($('#am-edit-strip')), 'edit lost on destination change');
    $('#am-lang-it').click();
    $('#am-dest-streaming').click();
    await waitFor(settled, 15000);
    window.scrollTo(0, 0); // the header in sight (a later check covers a phone)
    $('#am-cut-reset').focus({ preventScroll: true });
    $('#am-cut-reset').click();
    ok(!tr.edits, 'reset failed');
    // The strip goes with the edit; focus on the global Annulla, named after the reset.
    ok(!visible($('#am-edit-strip')), 'strip still shown on the whole song');
    ok(document.activeElement === $('#am-undo') && undoName() === 'Annulla: Torna al brano completo', `focus after reset on ${document.activeElement && (document.activeElement.id || document.activeElement.tagName)}, ${undoName()}`);
    const undo = [...document.querySelectorAll('.toast-action')].pop();
    ok(undo, 'no undo after reset');
    undo.click();
    ok(tr.edits, 'undo after reset failed');
    // Once the toast is gone the header's Annulla still undoes the reset.
    $('#am-cut-reset').click();
    for (const x of document.querySelectorAll('.toast')) x.remove();
    $('#am-undo').click();
    ok(tr.edits && visible($('#am-cut-reset')), 'header undo after reset failed');
    $('#am-cut-reset').click();
    await waitFor(settled, 15000);
  });
  await check('keys I / O / L / Esc: only with the bar open and never while typing', async () => {
    const pl = H.player;
    pl.seek(3);
    ok(keyOn(document.body, 'i'), 'I not taken');
    pl.seek(5);
    keyOn(document.body, 'o');
    ok(/^0:03[,.]/.test($('#am-cut-in').value) && /^0:05[,.]/.test($('#am-cut-out').value), `${$('#am-cut-in').value} ${$('#am-cut-out').value}`);
    ok(!keyOn($('#am-cut-name'), 'Escape') && $('#am-cut-in').value, 'Esc in a text field cleared the selection');
    keyOn(document.body, 'l');
    ok($('#am-cut-loop').getAttribute('aria-pressed') === 'true', 'L did not toggle the loop');
    keyOn(document.body, 'l');
    ok(keyOn(document.body, 'Escape') && !$('#am-cut-in').value, 'Esc did not clear');
    $('#am-cut-toggle').click();
    ok(!visible($('#am-cut')) && !keyOn(document.body, 'i'), 'keys active with the bar closed');
  });
  const viewSecs = () => {
    // "0:04,7 – 0:05,9" (tenths, floored) → [start, end]
    const sec = (x) => {
      const [m, r] = x.trim().replace(',', '.').split(':');
      return Number(m) * 60 + Number(r);
    };
    return $('#am-cut-scroll').getAttribute('aria-valuetext').split('–').map(sec);
  };
  await check('a new trim keeps the zoomed view on the same music as the selection', async () => {
    $('#am-cut-toggle').click();
    typeTime('#am-cut-in', '5');
    typeTime('#am-cut-out', '6');
    $('#am-cut-out').blur(); // a focused field is never rewritten under the user's typing
    $('#am-cut-zoom-sel').click();
    const trim = $('#adv-trim-enabled');
    ok(trim, 'no trim switch');
    const lead0 = activeTrack().result.report.trim.startSec || 0;
    trim.click();
    await waitFor(() => settled() && (activeTrack().result.report.trim.startSec || 0) !== lead0, 15000);
    await pause(30);
    const a = parseTimecodeLike($('#am-cut-in').value);
    const b = parseTimecodeLike($('#am-cut-out').value);
    const [v0, v1] = viewSecs();
    const note = `sel ${a}–${b}, view ${v0}–${v1}`;
    trim.click(); // back to the earlier trim
    await waitFor(settled, 15000);
    ok(Math.abs(b - a - 1) < 1e-6 && Math.abs(a - 5) > 0.1, `selection not moved with the music: ${note}`);
    ok(v0 <= a + 1e-6 && v1 + 0.1 >= b - 1e-6, `zoomed view lost the selection: ${note}`);
    return note;
  });
  await check('I / O / L pressed inside an open help card stay with the card', async () => {
    H.player.seek(2);
    $('.cut-sel-head .help-btn').click();
    await pause(30);
    const close = $('.help-pop .help-close');
    ok(close && visible(close), 'no help card');
    close.focus();
    const loop0 = $('#am-cut-loop').getAttribute('aria-pressed');
    const in0 = $('#am-cut-in').value;
    for (const k of ['l', 'L', 'i', 'o', 'b']) keyOn(close, k);
    ok($('#am-cut-loop').getAttribute('aria-pressed') === loop0 && $('#am-cut-in').value === in0, `a key acted behind the card (loop ${$('#am-cut-loop').getAttribute('aria-pressed')}, in ${$('#am-cut-in').value})`);
    keyOn(close, 'Escape');
    ok(!visible($('.help-pop')), 'card not closed by Esc');
  });
  await check('after a cut with the header out of sight (a phone: the bar sits after the transport) focus stays in the cut bar, on screen; the toast\'s Annulla undoes the cut', async () => {
    if (!visible($('#am-cut'))) $('#am-cut-toggle').click();
    const tr = activeTrack();
    const len0 = tr.audio.channels[0].length;
    const pad = document.body.style.paddingBottom;
    const onScreen = (el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    };
    try {
      for (const kind of ['remove', 'keep']) {
        typeTime('#am-cut-in', '1');
        typeTime('#am-cut-out', '2');
        // Room to scroll on any window, then the edit card at the top: the header is far above.
        document.body.style.paddingBottom = '4000px';
        const btn = $(`#am-cut-${kind}`);
        window.scrollBy(0, $('#am-cut-edit').getBoundingClientRect().top - 8);
        ok($('#am-undo').getBoundingClientRect().bottom < 0 && onScreen(btn), `${kind}: set-up (header ${$('#am-undo').getBoundingClientRect().bottom}, button ${btn.getBoundingClientRect().top})`);
        btn.focus({ preventScroll: true });
        btn.click();
        const f = document.activeElement;
        ok(tr.edits && tr.audio.channels[0].length < len0, `${kind}: not edited`);
        ok(f && f !== $('#am-undo') && f !== document.body && $('#am-cut').contains(f) && onScreen(f), `${kind}: focus on ${f && (f.id || f.tagName)} at ${f && Math.round(f.getBoundingClientRect().top)} (viewport ${innerHeight})`);
        ok(f === $('#am-cut-edit') && f.getAttribute('role') === 'group' && f.getAttribute('aria-labelledby'), `${kind}: focus not on the named edit card`);
        const undo = lastToastEl() && lastToastEl().querySelector('.toast-action');
        ok(undo && undoName() === `Annulla: ${kind === 'keep' ? 'Tieni solo la selezione' : 'Elimina la selezione'}`, `${kind}: ${undoName()}, toast Annulla ${!!undo}`);
        undo.click();
        ok(!tr.edits && tr.audio.channels[0].length === len0, `${kind}: the toast's Annulla did not undo the cut`);
        await waitFor(settled, 15000);
      }
    } finally {
      document.body.style.paddingBottom = pad;
      window.scrollTo(0, 0);
    }
  });
  await check('untouched fade fields follow the language\'s decimal mark, a typed one stays', async () => {
    const fi = $('#am-cut-fade-in');
    const fo = $('#am-cut-fade-out');
    ok(fi.value === '0,01' && fo.value === '0,01', `${fi.value} ${fo.value}`);
    $('#am-lang-en').click();
    ok(fi.value === '0.01' && fo.value === '0.01', `EN: ${fi.value} ${fo.value}`);
    fo.focus();
    fo.value = '2.5';
    fo.dispatchEvent(new Event('input', { bubbles: true }));
    fo.blur();
    $('#am-lang-it').click();
    ok(fi.value === '0,01' && fo.value === '2.5', `IT: ${fi.value} ${fo.value}`);
    $('#am-cut-toggle').click();
  });

  await check('Metadati: cover, title, lyrics and links of the song; untagged files say so; the switch decides what the master carries', async () => {
    await app.loadFiles([fakeFile('Brano con tag.mp3')]);
    await waitFor(() => activeTrack() && activeTrack().metaState === 'ready' && $('.meta-title').textContent === 'Canzone di prova', 8000);
    await waitFor(settled, 15000);
    const box = $('#am-meta');
    ok(visible(box), 'box hidden');
    ok(/^blob:/.test($('.meta-img').getAttribute('src') || ''), 'no cover');
    ok($('.meta-artist').textContent === 'Artista di prova' && /Album di prova · 2025/.test($('.meta-album').textContent), 'artist / album line');
    ok([...box.querySelectorAll('.meta-sum')].some((x) => /2/.test(x.textContent) && !x.closest('details').hidden), 'lyrics fold');
    const links = [...box.querySelectorAll('.meta-rows a')];
    ok(links.length === 1 && links[0].href === 'https://example.com/song/1' && links[0].rel.includes('noopener'), `links ${links.map((a) => a.href)}`);
    const sw = $('#am-meta-keep');
    ok(visible(sw) && sw.getAttribute('aria-checked') === 'true', 'keep switch');
    const dl = async () => {
      const n = H.saves.length;
      $('#am-download').click();
      await waitFor(() => H.saves.length > n && !st().exporting, 8000);
    };
    await dl();
    ok(H.wavMeta && H.wavMeta.tags.title === 'Canzone di prova', 'metadata not passed to the encoder');
    sw.click();
    await dl();
    ok(H.wavMeta === null, 'switch off still passes metadata');
    sw.click();
    $('.meta-cover:not(.meta-cover-none)').click();
    ok(box.classList.contains('is-large'), 'cover does not enlarge');
    $('.meta-cover:not(.meta-cover-none)').click();
    await app.loadFiles([fakeFile('Senza dati.wav')]);
    [...document.querySelectorAll('#am-tracks .track-chip-main')].find((x) => /Senza dati/.test(x.textContent)).click();
    await waitFor(() => activeTrack().name === 'Senza dati' && activeTrack().metaState === 'ready', 8000);
    ok(/da copiare nel master|to copy into the master/.test($('.meta-note').textContent) && !visible(sw), 'untagged file');
    await waitFor(settled, 15000);
    return 'cover, lyrics, link, switch';
  });
  await check('a focused link survives re-renders; the switch is locked and its value fixed during an export; a read still running is waited for', async () => {
    await app.loadFiles([fakeFile('Brano con tag due.mp3')]);
    [...document.querySelectorAll('#am-tracks .track-chip-main')].find((x) => /tag due/.test(x.textContent)).click();
    await waitFor(() => activeTrack().name === 'Brano con tag due' && activeTrack().metaState === 'ready', 8000);
    await waitFor(settled, 15000);
    const box = $('#am-meta');
    const fold = [...box.querySelectorAll('details.meta-fold')].find((d) => d.querySelector('a'));
    fold.open = true;
    const link = fold.querySelector('a');
    link.focus();
    $('#am-style-' + (activeTrack().choices.style === 'warm' ? 'balanced' : 'warm')).click();
    await waitFor(() => activeTrack().rendering || activeTrack().timer, 3000);
    await waitFor(settled, 15000);
    ok(document.activeElement === link && link.isConnected, `focus on ${document.activeElement && document.activeElement.tagName}`);
    // the switch during "Esporta tutti": locked, and every song keeps the value of the start
    const titles = [];
    let disabledSeen = false;
    const desc = Object.getOwnPropertyDescriptor(H, 'wavMeta');
    Object.defineProperty(H, 'wavMeta', { configurable: true, set(v) { titles.push(v ? v.tags.title : null); disabledSeen = disabledSeen || $('#am-meta-keep').disabled; }, get() { return null; } });
    try {
      const n = H.saves.length;
      $('#am-export-all').click();
      await waitFor(() => titles.length >= 1, 8000);
      $('#am-meta-keep').click(); // disabled: nothing happens
      await waitFor(() => H.saves.length > n && !st().exporting, 15000);
    } finally {
      delete H.wavMeta;
      if (desc) Object.defineProperty(H, 'wavMeta', desc);
    }
    ok(disabledSeen && st().exportMeta === true && $('#am-meta-keep').getAttribute('aria-checked') === 'true' && !$('#am-meta-keep').disabled, 'switch not locked during the export');
    const tagged = titles.filter(Boolean).length;
    const expect = st().tracks.filter((tr) => tr.analysis && !tr.error && !tr.demo && tr.meta && tr.meta.tags && tr.meta.tags.title).length;
    ok(tagged >= 2 && tagged === expect, `titles ${JSON.stringify(titles)}, ${expect} tagged songs`);
    // a slow read is waited for, so the master is tagged even when exported at once
    await app.loadFiles([fakeFile('Tag lento.mp3')]);
    [...document.querySelectorAll('#am-tracks .track-chip-main')].find((x) => /Tag lento/.test(x.textContent)).click();
    await waitFor(() => activeTrack().name === 'Tag lento' && activeTrack().result && !activeTrack().rendering, 15000);
    ok(activeTrack().metaState === 'loading', 'metadata already read: the check proves nothing');
    const n2 = H.saves.length;
    $('#am-download').click();
    await pause(600);
    ok(H.saves.length === n2 && st().exporting && /metadati|metadata/i.test($('#am-export-stage').textContent), `not waiting: ${$('#am-export-stage').textContent}`);
    H.releaseMeta();
    await waitFor(() => H.saves.length > n2 && !st().exporting, 15000);
    ok(H.wavMeta && H.wavMeta.tags.title === 'Canzone di prova', 'exported before the metadata arrived');
    await waitFor(settled, 15000);
    return `focus kept, ${titles.length} songs ${JSON.stringify(titles)}`;
  });
  await check('Tema: 7 skins in a menu by the language switch; a choice sets data-am-skin and is remembered', async () => {
    const btn = $('.skin-btn');
    ok(btn && btn.closest('.top-right'), 'no picker in the header');
    btn.click();
    const items = [...document.querySelectorAll('.skin-menu [role="menuitemradio"]')];
    ok(items.length === 7, `${items.length} skins`);
    const fluo = items.find((x) => /Fluo/.test(x.textContent));
    fluo.click();
    ok(document.documentElement.getAttribute('data-am-skin') === 'fluo' && localStorage.getItem('am.skin') === 'fluo', 'fluo not applied');
    btn.click();
    [...document.querySelectorAll('.skin-menu [role="menuitemradio"]')][0].click();
    ok(!document.documentElement.hasAttribute('data-am-skin'), 'auto did not clear the skin');
    return 'fluo → auto';
  });
  await check('every save status gives an honest message', async () => {
    const run = async (mode) => {
      H.save = mode;
      const n = document.querySelectorAll('.toast').length;
      $('#am-download').click();
      await waitFor(() => !st().exporting && document.querySelectorAll('.toast').length !== n, 8000);
      await waitFor(() => !st().exporting, 8000);
      return lastToast();
    };
    const busy = await run('busy');
    const big = await run('too_large');
    const declined = await run('declined');
    for (const m of [busy, big, declined]) ok(!/Salvato|Saved/.test(m), `false success: ${m}`);
    const un = await run('unavailable');
    ok($('#am-download').disabled && visible($('#am-export-state.is-warn')), 'export not turned off');
    H.save = 'saved';
    return `${busy} | ${big} | ${un}`;
  });

  const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  lines.push(`${results.length - failed} passed, ${failed} failed`);
  const out = document.createElement('pre');
  out.className = 'hx-out';
  out.id = 'hx-out';
  out.textContent = lines.join('\n');
  document.body.append(out);
  console.info(`[harness checks]\n${lines.join('\n')}`);
  window.__checkResults = results;
  return results;
}
window.__runChecks = runChecks;
if (q.get('check')) runChecks();
