// Deterministic synthetic demo song for AudioMaster ("try it without uploading").
//
// A short modern pop/EDM song in A minor at 122 BPM: 2-bar intro (pad swelling in,
// riser, hats), 4-bar verse, 8-bar chorus (cycling; the last section stretches to
// the end), vi–IV–I–V progression (Am F C G), four-on-the-floor kick with pitch
// envelope, clap/snare (noise + tone), closed/open hats from filtered noise, a
// side-chained 8th-note bass (sub sine + filtered saw), a detuned-saw chord pad (slow
// attack, stereo spread), a vowel-formant "vocal" lead (saw/pulse source, vibrato,
// portamento, sung melody with rests) with ping-pong delay, and a small FDN reverb.
//
// With `defects: true` (the default) the typical AI-generator problems documented
// in docs/research/02-suno-artifacts.md (A-numbers) are baked in, at audible but
// realistic levels, so every cleanup module of the app has something to find
// (DEMO_DEFECTS below holds the exact design values):
//
//  * shimmer   (A2)  10 narrowband partials between 7 and 14 kHz whose amplitudes are
//                    re-drawn every ~21 ms "codec frame" (on/off + random level, 5 ms
//                    crossfades, ±6 Hz jitter), scaled by the music's own HF envelope
//                    and randomly panned: the metallic, glassy flicker of neural codecs.
//  * hiss      (A5)  stationary, uncorrelated L/R noise high-passed at 4 kHz, −60 dBFS
//                    RMS per channel, added after the level stage so it is audible
//                    in the (quiet) intro.
//  * harsh     (A6)  static +6 dB peaking resonance at 3.3 kHz, Q 3.
//  * muddy     (A8)  broad +4 dB peaking bump at 300 Hz, Q 0.9 (≈ +3 dB measured after
//                    the level stage).
//  * wideBass  (A10) the kick body (below ~150 Hz) and the sub-bass oscillators run 65°
//                    out of phase between L and R: "phasey", decorrelated low end,
//                    correlation below 120 Hz ≈ 0.3, mono sum ≈ −1 dB.
//  * dcOffset  (A14) +0.002 (L) / +0.0015 (R) constant offset (≈ −54 / −56 dBFS).
//  * sibilant  (A7)  'S' consonants on the vocal 14 dB hotter than in the clean
//                    version (noise bands at 7 and 11 kHz, ~90 ms bursts, ~28 / min).
//  * tooLoud / overs (A13)  driven to ≈ −8.5 LUFS through a naive (non-oversampled)
//                    soft clipper and a sample-peak limiter at −0.1 dBFS, so the true
//                    peak lands above 0 dBTP (a few inter-sample overs) while no sample
//                    reaches full scale.
//  * abruptEnd (A15) the groove plays until the very last sample (no outro, no fade).
//
// With `defects: false` the same music is rendered cleanly: mono low end, no added
// noise/partials/resonances/offset, soft consonants, ≈ −14 LUFS with the sample peak
// limited to −2 dBFS (true peak ≈ −1.9 dBTP), and a proper ending: a final chord on
// the last bar line that leaves ≥ 2 s, ringing out into a fade to digital silence.
//
// Environment-neutral (no DOM / Web Audio), deterministic (seeded PRNGs; identical
// output for identical options within one JS engine), self-contained (imports nothing
// from src/) and fast: repeated hits/notes/chords are rendered once and mixed in, and
// recursive filters run two channels per loop so their latency chains overlap
// (32 s at 48 kHz: ≈ 0.27 s warm / ≈ 0.75 s first call in Node 20 x64 under Rosetta on an
// M1 Pro; ≈ 0.3 s first call in Chrome 152 arm64). Transient memory ≈ 24 B per frame.

const TAU = 2 * Math.PI;
const BPM = 122;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const EIGHTH = BEAT / 2;
const MAX_SECONDS = 600; // transient memory ≈ 24 bytes per stereo frame (6 Float32 buffers)

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

/** Tempo of the demo song (beats per minute). */
export const DEMO_BPM = BPM;

/**
 * Description of the defects baked in by `generateDemoTrack({ defects: true })`.
 * `issue` values are the analysis issue ids of ARCHITECTURE.md §7 each defect should
 * trigger. Levels are design values (what the generator does), not measurements.
 */
export const DEMO_DEFECTS = deepFreeze({
  issues: ['shimmer', 'hiss', 'harsh', 'muddy', 'wideBass', 'dcOffset', 'sibilant', 'tooLoud', 'overs', 'abruptEnd'],
  shimmer: {
    issue: 'shimmer',
    loHz: 7000,
    hiHz: 14000,
    partials: 10,
    minSpacingHz: 180,
    frameMs: 21.333, // re-draw period of the per-partial gains ("codec frame")
    crossfadeMs: 5,
    onProbability: 0.5,
    onGainRange: [0.35, 1],
    // peak amplitude of one fully "on" partial relative to the RMS envelope of the
    // music's 6–16 kHz band (release ~150 ms): the artifact follows the music.
    levelDb: -6,
    envelopeBandHz: [6000, 16000],
    jitterHz: 6, // per-frame frequency jitter (glassy, not a stable tone)
    panRange: [-0.8, 0.8],
  },
  hiss: { issue: 'hiss', rmsDbfs: -60, highpassHz: 4000, highpassOrder: 2, stereo: 'uncorrelated' },
  harsh: { issue: 'harsh', freqHz: 3300, gainDb: 6, q: 3, type: 'peaking' },
  mud: { issue: 'muddy', freqHz: 300, gainDb: 4, q: 0.9, type: 'peaking' },
  // kick body (once its pitch is below ~150 Hz) and sub-bass oscillators run 65° out of
  // phase between L and R (the bass saw stays centred): r(<120 Hz) ≈ 0.3, mono sum −1 dB
  wideBass: { issue: 'wideBass', belowHz: 120, phaseOffsetDeg: 65, expectedCorrelation: 0.3 },
  dc: { issue: 'dcOffset', left: 0.002, right: 0.0015 },
  // clean 's' ≈ −18 dB re the vowel (broadband RMS); the defect is 14 dB hotter (≈ −4 dB)
  sibilance: { issue: 'sibilant', centerHz: 7000, extraHz: 11000, bandHz: [5000, 9000], burstMs: 90, excessDb: 14 },
  level: { issues: ['tooLoud', 'overs'], targetLufs: -8.5, samplePeakDbfs: -0.1, truePeak: 'above 0 dBTP' },
  abruptEnd: { issue: 'abruptEnd', fadeOut: false },
  clean: { targetLufs: -14, samplePeakDbfs: -2 },
});

// --------------------------------------------------------------------------------
// Arrangement
// --------------------------------------------------------------------------------

const CHORDS = {
  Am: { root: 33, pad: [57, 60, 64], top: 69 },
  F: { root: 29, pad: [57, 60, 65], top: 69 },
  C: { root: 36, pad: [55, 60, 64], top: 67 },
  G: { root: 31, pad: [55, 59, 62], top: 67 },
};
const PROGRESSION = ['Am', 'F', 'C', 'G'];
const INTRO_CHORDS = ['F', 'G'];

// Melodies: [startEighth, lengthEighths, midi, vowel, sibilant] within a 4-bar phrase.
const VERSE = [
  [0, 2, 64, 'o', 0], [2, 1, 62, 'a', 0], [3, 1, 60, 'e', 1], [4, 3, 64, 'a', 0],
  [8, 2, 60, 'o', 0], [10, 1, 62, 'e', 0], [11, 1, 64, 'a', 1], [12, 3, 60, 'o', 0],
  [16, 2, 67, 'a', 1], [18, 1, 64, 'e', 0], [19, 1, 62, 'o', 0], [20, 3, 64, 'a', 0],
  [24, 2, 62, 'e', 0], [26, 2, 59, 'o', 1], [28, 3, 62, 'a', 0],
];
const CHORUS_A = [
  [0, 1, 69, 'e', 1], [1, 1, 67, 'a', 0], [2, 2, 69, 'a', 0], [4, 1, 72, 'o', 0], [5, 1, 69, 'a', 0], [6, 2, 67, 'e', 0],
  [8, 3, 65, 'a', 0], [11, 1, 64, 'o', 0], [12, 2, 65, 'e', 1], [14, 2, 69, 'a', 0],
  [16, 2, 67, 'o', 1], [18, 1, 64, 'a', 0], [19, 1, 67, 'e', 0], [20, 3, 72, 'a', 0], [23, 1, 71, 'o', 0],
  [24, 2, 71, 'e', 1], [26, 2, 67, 'a', 0], [28, 3, 74, 'a', 0],
];
const CHORUS_B = CHORUS_A.slice(0, 15).concat([[24, 2, 71, 'e', 1], [26, 2, 72, 'o', 0], [28, 4, 69, 'a', 0]]);

const SIB_LEAD = 0.065; // the 's' starts before the vowel
const SIB_LEN = 0.09;

function buildArrangement(seconds, defects) {
  const nBars = Math.max(1, Math.ceil(seconds / BAR - 1e-9));
  // Clean version: an ending section starting on the last bar line that leaves >= 2 s.
  let endingBar = null;
  if (!defects) {
    const b = Math.floor((seconds - 2) / BAR);
    if (b >= 3 && b < nBars) endingBar = b;
  }
  const bodyEnd = endingBar ?? nBars;
  const bars = [];
  for (let b = 0; b < nBars; b++) bars.push({ index: b, startSec: b * BAR, endSec: Math.min(seconds, (b + 1) * BAR), section: 'intro', chord: 'Am', barInSection: b, sectionStart: 0, sectionLen: 2 });
  for (let b = 0; b < Math.min(2, nBars); b++) bars[b].chord = INTRO_CHORDS[b];
  let b = 2;
  let k = 0;
  while (b < bodyEnd) {
    const verse = k % 2 === 0;
    let len = verse ? 4 : 8;
    const remain = bodyEnd - b;
    if (remain - len < 4) len = remain; // too short for another section: stretch this one
    for (let j = 0; j < len; j++) {
      const bar = bars[b + j];
      bar.section = verse ? 'verse' : 'chorus';
      bar.chord = PROGRESSION[(b + j - 2) % 4];
      bar.barInSection = j;
      bar.sectionStart = b;
      bar.sectionLen = len;
    }
    b += len;
    k++;
  }
  if (endingBar !== null) {
    for (let j = endingBar; j < nBars; j++) Object.assign(bars[j], { section: 'ending', chord: 'Am', barInSection: j - endingBar, sectionStart: endingBar, sectionLen: nBars - endingBar });
  }
  // Vocal notes (absolute seconds).
  const notes = [];
  for (const bar of bars) {
    if ((bar.section !== 'verse' && bar.section !== 'chorus') || bar.barInSection % 4 !== 0) continue;
    const phraseIdx = Math.floor(bar.barInSection / 4);
    const phrase = bar.section === 'verse' ? VERSE : phraseIdx % 2 === 0 ? CHORUS_A : CHORUS_B;
    for (const [s8, l8, midi, vowel, sib] of phrase) {
      const t0 = bar.startSec + s8 * EIGHTH;
      if (t0 >= seconds) continue;
      notes.push({ t0, t1: t0 + l8 * EIGHTH * 0.92, midi, vowel, sib: !!sib, vel: bar.section === 'chorus' ? 1 : 0.85 });
    }
  }
  if (endingBar !== null) notes.push({ t0: endingBar * BAR, t1: endingBar * BAR + 1.2, midi: 69, vowel: 'a', sib: false, vel: 0.9 });
  const sections = [];
  for (const bar of bars) {
    const last = sections[sections.length - 1];
    if (last && last.name === bar.section && bar.sectionStart === last.startBar) last.endSec = bar.endSec;
    else sections.push({ name: bar.section, startSec: bar.startSec, endSec: bar.endSec, startBar: bar.sectionStart });
  }
  return { seconds, nBars, bars, notes, sections, endingBar };
}

/**
 * Song structure of the demo for the given options (no audio rendered): tempo, bars,
 * sections, vocal sibilant windows and where the clean version's ending starts.
 * Useful for tests and for labelling the demo in the UI.
 * @param {{ seconds?: number, defects?: boolean }} [opts]
 * @returns {{ bpm: number, beatSec: number, barSec: number,
 *   sections: { name: string, startSec: number, endSec: number }[],
 *   bars: { index: number, startSec: number, endSec: number, section: string, chord: string }[],
 *   sibilance: { startSec: number, endSec: number }[], endingStartSec: number|null }}
 */
export function demoArrangement({ seconds = 32, defects = true } = {}) {
  const secs = checkSeconds(seconds);
  if (secs === 0) return { bpm: BPM, beatSec: BEAT, barSec: BAR, sections: [], bars: [], sibilance: [], endingStartSec: null };
  const a = buildArrangement(secs, !!defects);
  return {
    bpm: BPM,
    beatSec: BEAT,
    barSec: BAR,
    sections: a.sections.map(({ name, startSec, endSec }) => ({ name, startSec, endSec })),
    bars: a.bars.map(({ index, startSec, endSec, section, chord }) => ({ index, startSec, endSec, section, chord })),
    sibilance: a.notes.filter((nt) => nt.sib).map((nt) => ({ startSec: Math.max(0, nt.t0 - SIB_LEAD), endSec: Math.min(secs, nt.t0 - SIB_LEAD + SIB_LEN) })),
    endingStartSec: a.endingBar === null ? null : a.endingBar * BAR,
  };
}

// --------------------------------------------------------------------------------
// Small DSP toolkit (private; duplicated on purpose so this module stays standalone)
// --------------------------------------------------------------------------------

function mulberry32(seed) {
  // State in a typed array: a uint32 kept in a closure variable would be re-boxed as a
  // heap number on every call (V8), which made the GC dominate the render time.
  const st = new Uint32Array([seed >>> 0]);
  return () => {
    st[0] += 0x6d2b79f5;
    let t = st[0];
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent deterministic stream per component, so editing one part never shifts another. */
function rngFor(seed, stream) {
  let h = (seed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return mulberry32((h ^ (h >>> 16)) >>> 0);
}

// Per-sample noise uses an inline 32-bit LCG (Numerical Recipes constants) seeded from
// the stream's mulberry32: x = x·1664525 + 1013904223 (mod 2^32, kept as int32 so it
// stays in a register); w = x / 2^31 is uniform in [−1, 1). Plenty for audio noise.
const LCG_SCALE = 1 / 2147483648;
const lcgSeed = (rng) => (rng() * 4294967296) | 0;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const dbGain = (db) => Math.pow(10, db / 20);

/** RBJ cookbook biquad, normalized (a0 = 1). bandpass = constant 0 dB peak. */
function design(type, freq, sr, q = Math.SQRT1_2, gainDb = 0) {
  const f = Math.min(Math.max(freq, 1), 0.45 * sr);
  const w = (TAU * f) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {
    // peaking
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Oscillators use inline PolyBLEP residuals (Välimäki & Huovilainen 2007) for band-limited
// saw/pulse edges: v -= blep(phase, increment).

// --------------------------------------------------------------------------------
// Instruments. Repeated hits/notes/chords are rendered once and mixed in at each
// occurrence (like a sampler): it keeps the render fast for any song length.
// --------------------------------------------------------------------------------

/** dst[i0 + k] += gain · src[k], clipped to dst. */
function addAt(dst, src, i0, gain) {
  const a = Math.max(0, -i0);
  const b = Math.min(src.length, dst.length - i0);
  for (let k = a; k < b; k++) dst[i0 + k] += gain * src[k];
}

/** Side-chain "pump" shape 0..1 (1 right after a kick, ~100 ms recovery). */
function buildDuck(n, sr, kicks) {
  const duck = new Float32Array(n);
  const len = Math.round(0.42 * sr);
  const shape = new Float32Array(len);
  const atk = Math.max(1, Math.round(0.004 * sr));
  const c = Math.exp(-1 / (0.1 * sr));
  let e = 1;
  for (let k = 0; k < len; k++) {
    if (k < atk) shape[k] = k / atk;
    else {
      e *= c;
      shape[k] = e;
    }
  }
  for (const { t } of kicks) {
    const i0 = Math.round(t * sr);
    const a = Math.max(0, -i0);
    const b = Math.min(len, n - i0);
    for (let k = a; k < b; k++) if (shape[k] > duck[i0 + k]) duck[i0 + k] = shape[k];
  }
  return duck;
}

const PAD_DETUNE = [-0.11, 0, 0.12];
const PAD_PAN = [-0.7, 0.05, 0.7];
const PAD_KINDS = {
  normal: { attack: 0.09, gate: BAR, release: 0.25, taus: 4 },
  first: { attack: 1.6, gate: BAR, release: 0.25, taus: 4 },
  ending: { attack: 0.02, gate: 0.5, release: 0.55, taus: 9 },
};
const PAD_GAIN = { intro: 0.75, verse: 0.8, chorus: 1, ending: 1 };

/**
 * Adds one pad note (no envelope) into a chord buffer: 3 detuned band-limited saws
 * (supersaw-style) spread L/C/R.
 */
function padNoteInto(l, r, sr, midi, rng) {
  const f = midiHz(midi);
  const d0 = (f * Math.pow(2, PAD_DETUNE[0] / 12)) / sr;
  const d1 = (f * Math.pow(2, PAD_DETUNE[1] / 12)) / sr;
  const d2 = (f * Math.pow(2, PAD_DETUNE[2] / 12)) / sr;
  const pan = PAD_PAN.map((x) => ((x + 1) * Math.PI) / 4);
  const l0 = Math.cos(pan[0]), l1 = Math.cos(pan[1]), l2 = Math.cos(pan[2]);
  const r0 = Math.sin(pan[0]), r1 = Math.sin(pan[1]), r2 = Math.sin(pan[2]);
  let p0 = rng(), p1 = rng(), p2 = rng();
  for (let i = 0; i < l.length; i++) {
    p0 += d0;
    if (p0 >= 1) p0 -= 1;
    p1 += d1;
    if (p1 >= 1) p1 -= 1;
    p2 += d2;
    if (p2 >= 1) p2 -= 1;
    let v0 = 2 * p0 - 1;
    if (p0 < d0) { const t = p0 / d0; v0 -= t + t - t * t - 1; } else if (p0 > 1 - d0) { const t = (p0 - 1) / d0; v0 -= t * t + t + t + 1; }
    let v1 = 2 * p1 - 1;
    if (p1 < d1) { const t = p1 / d1; v1 -= t + t - t * t - 1; } else if (p1 > 1 - d1) { const t = (p1 - 1) / d1; v1 -= t * t + t + t + 1; }
    let v2 = 2 * p2 - 1;
    if (p2 < d2) { const t = p2 / d2; v2 -= t + t - t * t - 1; } else if (p2 > 1 - d2) { const t = (p2 - 1) / d2; v2 -= t * t + t + t + 1; }
    l[i] += v0 * l0 + v1 * l1 + v2 * l2;
    r[i] += v0 * r0 + v1 * r1 + v2 * r2;
  }
}

/** Chord envelope: smoothstep attack, exponential release after the gate. */
function applyPadEnvelope(l, r, sr, kind) {
  const { attack, gate, release } = PAD_KINDS[kind];
  const atk = Math.max(1, attack * sr);
  const iOff = Math.round(gate * sr);
  const relC = Math.exp(-1 / (release * sr));
  let rl = 1;
  for (let i = 0; i < l.length; i++) {
    let e = i < atk ? i / atk : 1;
    e = e * e * (3 - 2 * e);
    if (i >= iOff) {
      rl *= relC;
      e *= rl;
    }
    l[i] *= e;
    r[i] *= e;
  }
}

/** Pad: one cached stereo buffer per (chord, kind), mixed in at every bar that uses it. */
function renderPad(L, R, sr, arr, rng) {
  const n = L.length;
  const cache = new Map();
  for (const bar of arr.bars) {
    if (bar.section === 'ending' && bar.barInSection > 0) continue;
    const kind = bar.section === 'ending' ? 'ending' : bar.index === 0 ? 'first' : 'normal';
    const full = bar.section === 'chorus' || bar.section === 'ending';
    const key = `${bar.chord}|${kind}|${full}`;
    const i0 = Math.round(bar.startSec * sr);
    let ev = cache.get(key);
    if (!ev) {
      const ch = CHORDS[bar.chord];
      const k = PAD_KINDS[kind];
      let len = Math.round((k.gate + k.release * k.taus) * sr);
      if (kind !== 'normal') len = Math.max(1, Math.min(len, n - i0)); // used once: stop at the end
      ev = { l: new Float32Array(len), r: new Float32Array(len) };
      for (const m of full ? ch.pad.concat([ch.top]) : ch.pad) padNoteInto(ev.l, ev.r, sr, m, rng);
      applyPadEnvelope(ev.l, ev.r, sr, kind);
      cache.set(key, ev);
    }
    const gain = PAD_GAIN[bar.section] * 0.05;
    addAt(L, ev.l, i0, gain);
    addAt(R, ev.r, i0, gain);
  }
}

/** Pad filter cutoff (Hz) at time t: opens through the intro, brightest in the chorus. */
function padCutoff(arr, t) {
  const bi = Math.min(arr.bars.length - 1, Math.max(0, Math.floor(t / BAR)));
  const bar = arr.bars[bi];
  const x = (t - bar.startSec) / BAR;
  if (bar.section === 'intro') return bar.index === 0 ? 350 * Math.pow(900 / 350, x) : 900 * Math.pow(2200 / 900, x);
  if (bar.section === 'verse') return 2600;
  if (bar.section === 'chorus') return 4000;
  return 2600 * Math.exp(-(t - (bar.startSec - bar.barInSection * BAR)) / 2.5) + 400;
}

/**
 * Zavalishin TPT state-variable low-pass on L and R in one loop (two independent
 * recursions interleave well), cutoff smoothed and updated every 64 samples, followed
 * by a one-pole high-pass at hpHz (keeps the pad out of the low mids).
 */
function svfLowpassStereo(L, R, sr, cutoffAt, q, hpHz) {
  const n = L.length;
  const k = 1 / q;
  const hc = Math.exp((-TAU * hpHz) / sr);
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0, hlx = 0, hly = 0, hrx = 0, hry = 0;
  let fc = cutoffAt(0);
  const sm = 1 - Math.exp(-64 / (0.15 * sr));
  for (let b = 0; b < n; b += 64) {
    fc += (cutoffAt(b / sr) - fc) * sm;
    const g = Math.tan((Math.PI * Math.min(fc, 0.45 * sr)) / sr);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const e = Math.min(n, b + 64);
    for (let i = b; i < e; i++) {
      const vl = L[i] - l2;
      const ul = a1 * l1 + a2 * vl;
      const wl = l2 + a2 * l1 + a3 * vl;
      l1 = 2 * ul - l1;
      l2 = 2 * wl - l2;
      hly = hc * (hly + wl - hlx);
      hlx = wl;
      L[i] = hly;
      const vr = R[i] - r2;
      const ur = a1 * r1 + a2 * vr;
      const wr = r2 + a2 * r1 + a3 * vr;
      r1 = 2 * ur - r1;
      r2 = 2 * wr - r2;
      hry = hc * (hry + wr - hrx);
      hrx = wr;
      R[i] = hry;
    }
  }
}

/**
 * Kick: sine with a two-stage pitch envelope (≈450 → 44 Hz) + 4 ms beater click. With
 * rotDeg ≠ 0 it also returns `bodyR`: the same kick whose oscillator phase is offset by
 * rotDeg once the pitch has fallen below ~150 Hz (the wideBass defect).
 */
function kickSample(sr, rng, rotDeg = 0) {
  const len = Math.round(0.42 * sr);
  const body = new Float32Array(len);
  const rot = (rotDeg * Math.PI) / 180;
  const bodyR = rot ? new Float32Array(len) : null;
  const cA = Math.exp(-1 / (0.17 * sr));
  const cP = Math.exp(-1 / (0.032 * sr));
  const cQ = Math.exp(-1 / (0.004 * sr));
  const fade = Math.round(0.03 * sr);
  const atk = 0.0008 * sr;
  let a = 1, p = 1, q = 1, ph = 0;
  for (let k = 0; k < len; k++) {
    a *= cA;
    p *= cP;
    q *= cQ;
    const f = 44 + 150 * p + 260 * q;
    ph += f / sr;
    if (ph >= 1) ph -= 1;
    let env = a * Math.min(1, k / atk);
    if (k > len - fade) env *= (len - k) / fade;
    body[k] = env * Math.sin(TAU * ph);
    if (bodyR) bodyR[k] = env * Math.sin(TAU * ph + rot * Math.min(1, Math.max(0, (170 - f) / 60)));
  }
  const clickLen = Math.max(1, Math.round(0.004 * sr));
  const click = new Float32Array(clickLen);
  const cC = Math.exp(-1 / (0.0012 * sr));
  let e = 1;
  let prev = 0;
  let nz = lcgSeed(rng);
  for (let k = 0; k < clickLen; k++) {
    e *= cC;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const w = nz * LCG_SCALE;
    click[k] = 0.14 * e * (w - prev);
    prev = w;
  }
  return { body, bodyR, click };
}

/** Clap/snare: three 9 ms-spaced noise bursts + tail (band-passed ~1.5 kHz), optional tone. */
function clapSample(sr, rng, tone) {
  const len = Math.round(0.38 * sr);
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  const s = new Float32Array(len);
  const bp = design('bandpass', 1500, sr, 0.8);
  const hp = design('highpass', 700, sr, 0.7);
  let zl1 = 0, zl2 = 0, zr1 = 0, zr2 = 0, hl1 = 0, hl2 = 0, hr1 = 0, hr2 = 0;
  const burst = Math.exp(-1 / (0.0045 * sr));
  const tail = Math.exp(-1 / (0.13 * sr));
  const toneC = Math.exp(-1 / (0.055 * sr));
  const offs = [0, Math.round(0.009 * sr), Math.round(0.018 * sr)];
  const tailStart = Math.round(0.021 * sr);
  const fade = Math.round(0.02 * sr);
  let eb = 0, et = 0.85, toneE = 1, ph = 0;
  let nz = lcgSeed(rng);
  for (let k = 0; k < len; k++) {
    if (k === offs[0] || k === offs[1] || k === offs[2]) eb = 1;
    eb *= burst;
    let env = eb;
    if (k >= tailStart) {
      et *= tail;
      env += et;
    }
    if (k > len - fade) env *= (len - k) / fade;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const a = nz * LCG_SCALE;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const b = 0.55 * a + 0.45 * nz * LCG_SCALE; // partly correlated L/R: some width
    let y = bp.b0 * a + zl1; zl1 = bp.b1 * a - bp.a1 * y + zl2; zl2 = bp.b2 * a - bp.a2 * y;
    let x = y; y = hp.b0 * x + hl1; hl1 = hp.b1 * x - hp.a1 * y + hl2; hl2 = hp.b2 * x - hp.a2 * y;
    const nl = y;
    y = bp.b0 * b + zr1; zr1 = bp.b1 * b - bp.a1 * y + zr2; zr2 = bp.b2 * b - bp.a2 * y;
    x = y; y = hp.b0 * x + hr1; hr1 = hp.b1 * x - hp.a1 * y + hr2; hr2 = hp.b2 * x - hp.a2 * y;
    const nr = y;
    let ts = 0;
    if (tone) {
      toneE *= toneC;
      ph += (172 + 40 * toneE) / sr;
      ts = 0.5 * toneE * Math.sin(TAU * ph);
    }
    l[k] = 1.2 * env * nl + ts;
    r[k] = 1.2 * env * nr + ts;
    s[k] = 0.5 * env * (nl + nr);
  }
  return { l, r, s };
}

/** Hi-hat: 4th-order high-passed (8 kHz) noise with a 10.5 kHz sheen, exponential decay. */
function hatSample(sr, rng, decay) {
  const len = Math.round(Math.min(0.45, decay * 5) * sr);
  const out = new Float32Array(len);
  const h0 = design('highpass', 8000, sr, 0.54);
  const h1 = design('highpass', 8000, sr, 1.31);
  const h2 = design('peaking', 10500, sr, 1, 1.5);
  let c1 = 0, c2 = 0, a1 = 0, a2 = 0, b1 = 0, b2 = 0;
  const c = Math.exp(-1 / (decay * sr));
  const atk = Math.max(1, Math.round(0.0005 * sr));
  const fade = Math.min(64, len);
  let e = 1;
  let nz = lcgSeed(rng);
  for (let k = 0; k < len; k++) {
    e *= c;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const w0 = nz * LCG_SCALE;
    const w = h0.b0 * w0 + c1; c1 = h0.b1 * w0 - h0.a1 * w + c2; c2 = h0.b2 * w0 - h0.a2 * w;
    let y = h1.b0 * w + a1; a1 = h1.b1 * w - h1.a1 * y + a2; a2 = h1.b2 * w - h1.a2 * y;
    const x = y; y = h2.b0 * x + b1; b1 = h2.b1 * x - h2.a1 * y + b2; b2 = h2.b2 * x - h2.a2 * y;
    out[k] = y * e * Math.min(1, k / atk) * (k > len - fade ? (len - k) / fade : 1);
  }
  return out;
}

/** Crash: stereo high-passed noise, 0.75 s decay. */
function crashSample(sr, rng) {
  const len = Math.round(2.2 * sr);
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  const hp = design('highpass', 3800, sr, 0.7);
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  const c = Math.exp(-1 / (0.65 * sr));
  const fade = Math.round(0.2 * sr);
  let e = 1;
  let nz = lcgSeed(rng);
  for (let k = 0; k < len; k++) {
    e *= c;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const a = nz * LCG_SCALE;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const b = nz * LCG_SCALE;
    let y = hp.b0 * a + l1; l1 = hp.b1 * a - hp.a1 * y + l2; l2 = hp.b2 * a - hp.a2 * y;
    const sl = y;
    y = hp.b0 * b + r1; r1 = hp.b1 * b - hp.a1 * y + r2; r2 = hp.b2 * b - hp.a2 * y;
    const env = e * Math.min(1, k / (0.002 * sr)) * (k > len - fade ? (len - k) / fade : 1);
    l[k] = env * sl;
    r[k] = env * y;
  }
  return { l, r };
}

/** Noise riser: band-pass sweeping 400 Hz → 6 kHz with a crescendo. */
function renderRiser(L, R, sr, t0, dur, vel, rng) {
  const n = L.length;
  const i0 = Math.max(0, Math.round(t0 * sr));
  const i1 = Math.min(n, Math.round((t0 + dur) * sr));
  const total = Math.max(1, Math.round(dur * sr));
  const fade = Math.round(0.03 * sr);
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  let c = null;
  let nz = lcgSeed(rng);
  for (let i = i0; i < i1; i++) {
    const x = (i - i0) / total;
    if (c === null || (i - i0) % 64 === 0) c = design('bandpass', 400 * Math.pow(15, x), sr, 1.4);
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const a = nz * LCG_SCALE;
    nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
    const b = nz * LCG_SCALE;
    let y = c.b0 * a + l1; l1 = c.b1 * a - c.a1 * y + l2; l2 = c.b2 * a - c.a2 * y;
    const sl = y;
    y = c.b0 * b + r1; r1 = c.b1 * b - c.a1 * y + r2; r2 = c.b2 * b - c.a2 * y;
    const env = vel * x * x * (i1 - i < fade ? (i1 - i) / fade : 1);
    L[i] += env * sl;
    R[i] += env * y;
  }
}

/** Bass note: sub sine (start phase subRot) + saw through a 2-pole low-pass with a plucky filter envelope. */
function bassNote(sr, midi, lenSec, ending, subRot = 0) {
  const f = midiHz(midi);
  const iOff = Math.round(lenSec * sr);
  const relT = ending ? 0.25 : 0.012;
  const len = iOff + Math.round(relT * 7 * sr);
  const out = new Float32Array(len);
  const atk = Math.max(1, 0.003 * sr);
  const relC = Math.exp(-1 / (relT * sr));
  const fC = Math.exp(-1 / (0.07 * sr));
  const decay = ending ? Math.exp(-1 / (0.5 * sr)) : 1;
  const inc = f / sr;
  const cw = Math.cos(TAU * inc);
  const sw = Math.sin(TAU * inc);
  let sc = Math.cos(subRot), ss = Math.sin(subRot); // rotation oscillator for the sub
  let ph = 0, fe = 1, rl = 1, dc = 1;
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let k = 0; k < len; k++) {
    if ((k & 31) === 0) {
      const g = Math.tan((Math.PI * Math.min(0.45 * sr, 170 + 750 * fe)) / sr);
      a1 = 1 / (1 + g * (g + 1 / 1.1));
      a2 = g * a1;
      a3 = g * a2;
    }
    fe *= fC;
    dc *= decay;
    let env = (k < atk ? k / atk : 1) * dc;
    if (k >= iOff) {
      rl *= relC;
      env *= rl;
    }
    ph += inc;
    if (ph >= 1) ph -= 1;
    let saw = 2 * ph - 1;
    if (ph < inc) {
      const t = ph / inc;
      saw -= t + t - t * t - 1;
    } else if (ph > 1 - inc) {
      const t = (ph - 1) / inc;
      saw -= t * t + t + t + 1;
    }
    const v3 = saw - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    const c2 = sc * cw - ss * sw;
    ss = ss * cw + sc * sw;
    sc = c2;
    out[k] = env * (0.235 * ss + 0.122 * v2);
  }
  return out;
}

/**
 * Bass line into the low bus (side-chain ducked). With lowR (wideBass defect) the right
 * low bus gets the same notes with the sub oscillator phase offset by rotDeg.
 */
function renderBass(low, lowR, sr, arr, duck, rotDeg) {
  const n = low.length;
  const cache = new Map();
  const rot = (rotDeg * Math.PI) / 180;
  const get = (midi, ending, r) => {
    const key = `${midi}|${ending}|${r}`;
    let smp = cache.get(key);
    if (!smp) {
      smp = bassNote(sr, midi, ending ? 0.9 : EIGHTH * 0.82, ending, r);
      cache.set(key, smp);
    }
    return smp;
  };
  const mix = (dst, smp, i0, vel) => {
    const b = Math.min(smp.length, n - i0);
    for (let k = Math.max(0, -i0); k < b; k++) dst[i0 + k] += vel * smp[k] * (1 - 0.65 * duck[i0 + k]);
  };
  for (const bar of arr.bars) {
    const root = CHORDS[bar.chord].root;
    const notes = [];
    if (bar.section === 'verse' || bar.section === 'chorus') {
      const pat = bar.section === 'chorus' ? [0, 0, 12, 0, 0, 0, 12, 0] : [0, 0, 0, 0, 0, 0, 0, 12];
      for (let e = 0; e < 8; e++) notes.push({ t0: bar.startSec + e * EIGHTH, midi: root + pat[e], vel: e % 2 ? 0.85 : 1, ending: false });
    } else if (bar.section === 'ending' && bar.barInSection === 0) {
      notes.push({ t0: bar.startSec, midi: root, vel: 1, ending: true });
    }
    for (const nt of notes) {
      const i0 = Math.round(nt.t0 * sr);
      mix(low, get(nt.midi, nt.ending, 0), i0, nt.vel);
      if (lowR) mix(lowR, get(nt.midi, nt.ending, rot), i0, nt.vel);
    }
  }
}

// Alto-like vowel formants (Csound FOF tables; F2–F4 raised 8–14 dB for a bright,
// forward pop vocal): [freqs], [dB], [bandwidths].
const VOWELS = {
  a: [[800, 1150, 2800, 3500], [0, 0, -6, -14], [80, 90, 120, 130]],
  e: [[400, 1600, 2700, 3300], [0, -8, -9, -16], [60, 80, 120, 150]],
  i: [[350, 1700, 2700, 3700], [0, -6, -10, -18], [50, 100, 120, 150]],
  o: [[450, 800, 2830, 3500], [0, -3, -5, -14], [70, 80, 100, 130]],
  u: [[325, 700, 2530, 3500], [0, -6, -14, -22], [50, 60, 170, 180]],
};
const VOWEL_TABLES = Object.fromEntries(
  Object.entries(VOWELS).map(([k, [f, db, w]]) => [k, { f: Float64Array.from(f), g: Float64Array.from(db.map(dbGain)), w: Float64Array.from(w) }]),
);
const LN2_12 = Math.LN2 / 12;

/**
 * Vocal-like lead: band-limited saw + pulse with breath noise into 4 parallel formant
 * band-passes (constant 0 dB peak, gains per vowel). Pitch (glide + delayed vibrato)
 * and formants are control-rate (32-sample blocks, pitch linearly interpolated).
 */
function renderVocal(vox, sr, notes, rng) {
  const n = vox.length;
  const B = 32;
  const atkA = 1 - Math.exp(-1 / (0.014 * sr));
  const relA = 1 - Math.exp(-1 / (0.035 * sr));
  const glideB = 1 - Math.exp(-B / (0.03 * sr));
  const fmA = 1 - Math.exp(-B / (0.045 * sr));
  const dipC = Math.exp(-1 / (0.02 * sr));
  const airC = Math.exp((-TAU * 4500) / sr);
  const lowC = Math.exp((-TAU * 250) / sr);
  const vibB = (5.3 * B) / sr;
  const curF = Float64Array.from(VOWELS.a[0]);
  const curG = Float64Array.from(VOWELS.a[1].map(dbGain));
  const curW = Float64Array.from(VOWELS.a[2]);
  const cb = new Float64Array(4);
  const ca1 = new Float64Array(4);
  const ca2 = new Float64Array(4);
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0, s7 = 0;
  let amp = 0, ph = 0, vib = 0, dip = 0, airPrev = 0, airY = 0, prevEnd = -1, hpX = 0, hpY = 0;
  let lf = Math.log(midiHz(notes.length ? notes[0].midi : 69));
  let inc = Math.exp(lf) / sr;
  let nz = lcgSeed(rng);
  for (let k = 0; k < notes.length; k++) {
    const nt = notes[k];
    const next = k + 1 < notes.length ? notes[k + 1] : null;
    const i0 = Math.max(0, Math.round(nt.t0 * sr));
    const iOff = Math.min(n, Math.round(nt.t1 * sr));
    const iTail = Math.min(n, Math.round((nt.t1 + 0.3) * sr));
    const i1 = next !== null ? Math.min(iTail, Math.round(next.t0 * sr)) : iTail;
    const vel = nt.vel;
    const legato = nt.t0 - prevEnd < 0.16;
    prevEnd = nt.t1;
    const target = Math.log(midiHz(nt.midi)) + (rng() - 0.5) * 0.006;
    if (!legato || amp < 1e-3) {
      lf = target;
      inc = Math.exp(lf) / sr;
    }
    dip = legato ? 0.3 : 0;
    const vw = VOWEL_TABLES[nt.vowel];
    const tF = vw.f;
    const tG = vw.g;
    const tW = vw.w;
    for (let b0 = i0; b0 < i1; b0 += B) {
      const b1 = Math.min(i1, b0 + B);
      for (let f = 0; f < 4; f++) {
        curF[f] += (tF[f] - curF[f]) * fmA;
        curG[f] += (tG[f] - curG[f]) * fmA;
        curW[f] += (tW[f] - curW[f]) * fmA;
        const fr = Math.min(curF[f], 0.45 * sr);
        const w = (TAU * fr) / sr;
        const alpha = Math.sin(w) / (2 * (fr / curW[f]));
        const a0 = 1 + alpha;
        cb[f] = (alpha / a0) * curG[f];
        ca1[f] = (-2 * Math.cos(w)) / a0;
        ca2[f] = (1 - alpha) / a0;
      }
      const g0 = cb[0], g1 = cb[1], g2 = cb[2], g3 = cb[3];
      const p0 = ca1[0], p1 = ca1[1], p2 = ca1[2], p3 = ca1[3];
      const q0 = ca2[0], q1 = ca2[1], q2 = ca2[2], q3 = ca2[3];
      lf += (target - lf) * glideB;
      vib += vibB;
      vib -= Math.floor(vib);
      const depth = 0.32 * Math.min(1, Math.max(0, ((b1 - i0) / sr - 0.16) / 0.3));
      const incEnd = Math.exp(lf + depth * Math.sin(TAU * vib) * LN2_12) / sr;
      const dInc = (incEnd - inc) / (b1 - b0);
      for (let i = b0; i < b1; i++) {
        inc += dInc;
        ph += inc;
        if (ph >= 1) ph -= 1;
        let p2b = ph + 0.3; // second saw, phase-shifted: saw − saw2 = pulse (width 0.3)
        if (p2b >= 1) p2b -= 1;
        let saw = 2 * ph - 1;
        if (ph < inc) {
          const t = ph / inc;
          saw -= t + t - t * t - 1;
        } else if (ph > 1 - inc) {
          const t = (ph - 1) / inc;
          saw -= t * t + t + t + 1;
        }
        let saw2 = 2 * p2b - 1;
        if (p2b < inc) {
          const t = p2b / inc;
          saw2 -= t + t - t * t - 1;
        } else if (p2b > 1 - inc) {
          const t = (p2b - 1) / inc;
          saw2 -= t * t + t + t + 1;
        }
        nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
        const src = saw + 0.35 * (saw - saw2) + 0.05 * nz * LCG_SCALE;
        const tgt = i < iOff ? vel : 0;
        amp += (tgt - amp) * (tgt > amp ? atkA : relA);
        dip *= dipC;
        // 4 parallel band-passes, TDF-II (b1 = 0, b2 = −b0)
        const o0 = g0 * src + s0; s0 = -p0 * o0 + s1; s1 = -g0 * src - q0 * o0;
        const o1 = g1 * src + s2; s2 = -p1 * o1 + s3; s3 = -g1 * src - q1 * o1;
        const o2 = g2 * src + s4; s4 = -p2 * o2 + s5; s5 = -g2 * src - q2 * o2;
        const o3 = g3 * src + s6; s6 = -p3 * o3 + s7; s7 = -g3 * src - q3 * o3;
        // a little unfiltered top end ("air", breath) so the voice is not band-limited
        airY = airC * (airY + src - airPrev);
        airPrev = src;
        const out = amp * (1 - dip) * (o0 + o1 + o2 + o3 + 0.035 * airY);
        hpY = lowC * (hpY + out - hpX);
        hpX = out;
        vox[i] += hpY;
      }
    }
  }
}

/** 'S' consonants: band-passed noise bursts at 7 and 11 kHz just before sibilant syllables. */
function renderSibilants(vox, sr, notes, level, rng) {
  const n = vox.length;
  const b1 = design('bandpass', DEMO_DEFECTS.sibilance.centerHz, sr, 1.1);
  const b2 = design('bandpass', DEMO_DEFECTS.sibilance.extraHz, sr, 2);
  for (const nt of notes) {
    if (!nt.sib) continue;
    const i0 = Math.max(0, Math.round((nt.t0 - SIB_LEAD) * sr));
    const len = Math.round(SIB_LEN * sr);
    const atk = Math.max(1, 0.008 * sr);
    const hold = Math.round(0.05 * sr);
    const c = Math.exp(-1 / (0.012 * sr));
    let e = 1, z1 = 0, z2 = 0, y1 = 0, y2 = 0;
    let nz = lcgSeed(rng);
    for (let k = 0; k < len; k++) {
      const i = i0 + k;
      if (i >= n) break;
      let env = k < atk ? k / atk : 1;
      if (k > hold) {
        e *= c;
        env *= e;
      }
      nz = (Math.imul(nz, 1664525) + 1013904223) | 0;
      const w = nz * LCG_SCALE;
      const a = b1.b0 * w + z1; z1 = b1.b1 * w - b1.a1 * a + z2; z2 = b1.b2 * w - b1.a2 * a;
      const b = b2.b0 * w + y1; y1 = b2.b1 * w - b2.a1 * b + y2; y2 = b2.b2 * w - b2.a2 * b;
      vox[i] += level * nt.vel * env * (a + 0.5 * b);
    }
  }
}

/** Ping-pong dotted-eighth delay with a damped feedback path, vox → L/R. */
function pingPong(vox, L, R, sr, wet) {
  const n = vox.length;
  const d = Math.max(1, Math.round(0.75 * BEAT * sr));
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const lp = 1 - Math.exp((-TAU * 3500) / sr);
  let idx = 0, zl = 0;
  for (let i = 0; i < n; i++) {
    const outL = bl[idx];
    const outR = br[idx];
    zl += (vox[i] + 0.32 * outR - zl) * lp;
    bl[idx] = zl;
    br[idx] = outL;
    if (++idx >= d) idx = 0;
    L[i] += wet * outL;
    R[i] += wet * outR;
  }
}

const REVERB_WET = 0.5;

/**
 * Small stereo FDN reverb (Jot/Stautner–Puckette), run at half the sample rate (its
 * tail is damped above 6 kHz anyway): [1 2 1]/4 decimation → 18 ms pre-delay → two
 * Schroeder allpass diffusers → 4 delay lines (31.7–47.3 ms) mixed by a normalized
 * Hadamard matrix, one-pole damping per line, RT60-derived line gains (1.5 s) → linear
 * interpolation back to the full rate. One loop; the feedback runs through long delays,
 * so it is not latency-bound like chained IIRs.
 */
function reverb(send, L, R, sr, wet) {
  const n = send.length;
  const hr = sr / 2;
  const m = Math.floor((n + 1) / 2);
  const ms = (x) => Math.max(1, Math.round(x * 1e-3 * hr));
  const preB = new Float32Array(ms(18));
  const apB1 = new Float32Array(ms(4.77));
  const apB2 = new Float32Array(ms(1.63));
  const lens = [31.7, 37.3, 41.9, 47.3].map(ms);
  const n0 = lens[0], n1 = lens[1], n2 = lens[2], n3 = lens[3];
  const d0 = new Float32Array(n0);
  const d1 = new Float32Array(n1);
  const d2 = new Float32Array(n2);
  const d3 = new Float32Array(n3);
  const rt60 = 1.5;
  const [g0, g1, g2, g3] = lens.map((d) => 0.5 * Math.pow(10, (-3 * d) / (rt60 * hr))); // 0.5 normalizes H4
  const dp = Math.exp((-TAU * Math.min(6000, 0.4 * hr)) / hr);
  const ap = 0.6;
  const nPre = preB.length, na1 = apB1.length, na2 = apB2.length;
  let pi = 0, a1 = 0, a2 = 0, k0 = 0, k1 = 0, k2 = 0, k3 = 0;
  let f0 = 0, f1 = 0, f2 = 0, f3 = 0, pl = 0, pr = 0;
  for (let j = 0; j < m; j++) {
    const c = 2 * j;
    const x = 0.5 * send[c] + 0.25 * ((c > 0 ? send[c - 1] : 0) + (c + 1 < n ? send[c + 1] : 0));
    const xp = preB[pi];
    preB[pi] = x;
    if (++pi === nPre) pi = 0;
    let b = apB1[a1];
    let v = xp - ap * b;
    apB1[a1] = v;
    if (++a1 === na1) a1 = 0;
    const y1 = b + ap * v;
    b = apB2[a2];
    v = y1 - ap * b;
    apB2[a2] = v;
    if (++a2 === na2) a2 = 0;
    const y = b + ap * v;
    const o0 = d0[k0], o1 = d1[k1], o2 = d2[k2], o3 = d3[k3];
    f0 = o0 + (f0 - o0) * dp;
    f1 = o1 + (f1 - o1) * dp;
    f2 = o2 + (f2 - o2) * dp;
    f3 = o3 + (f3 - o3) * dp;
    const s01 = f0 + f1, m01 = f0 - f1, s23 = f2 + f3, m23 = f2 - f3;
    d0[k0] = y + g0 * (s01 + s23);
    d1[k1] = y + g1 * (m01 + m23);
    d2[k2] = y + g2 * (s01 - s23);
    d3[k3] = y + g3 * (m01 - m23);
    if (++k0 === n0) k0 = 0;
    if (++k1 === n1) k1 = 0;
    if (++k2 === n2) k2 = 0;
    if (++k3 === n3) k3 = 0;
    const yl = wet * (o0 - o2);
    const yr = wet * (o1 - o3);
    L[c] += yl;
    R[c] += yr;
    if (c > 0) {
      L[c - 1] += 0.5 * (pl + yl);
      R[c - 1] += 0.5 * (pr + yr);
    }
    pl = yl;
    pr = yr;
  }
}

// --------------------------------------------------------------------------------
// Defects
// --------------------------------------------------------------------------------

/**
 * L += HP(lowL), R += HP(lowR) (the same buffer for the clean, mono low end). The
 * 2nd-order 20 Hz high-pass removes the DC that sine oscillators starting at phase 0
 * (kick, sub) would otherwise leave in the mix, as any mix engineer's HPF would.
 */
function mixLow(L, R, lowL, lowR, sr) {
  const c = design('highpass', 20, sr, Math.SQRT1_2);
  const same = lowL === lowR;
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < L.length; i++) {
    const xl = lowL[i];
    const yl = c.b0 * xl + l1;
    l1 = c.b1 * xl - c.a1 * yl + l2;
    l2 = c.b2 * xl - c.a2 * yl;
    let yr = yl;
    if (!same) {
      const xr = lowR[i];
      yr = c.b0 * xr + r1;
      r1 = c.b1 * xr - c.a1 * yr + r2;
      r2 = c.b2 * xr - c.a2 * yr;
    }
    L[i] += yl;
    R[i] += yr;
  }
}

/** Shimmer partial set for a seed: log-uniform in 7–14 kHz with a minimum spacing. */
function shimmerPartials(seed, sr) {
  const d = DEMO_DEFECTS.shimmer;
  const rng = rngFor(seed, 101);
  const out = [];
  let guard = 0;
  while (out.length < d.partials && guard++ < 1000) {
    const f = d.loHz * Math.pow(d.hiHz / d.loHz, rng());
    const pan = d.panRange[0] + (d.panRange[1] - d.panRange[0]) * rng();
    const weight = 0.6 + 0.4 * rng();
    if (out.some((p) => Math.abs(p.freqHz - f) < d.minSpacingHz)) continue;
    out.push({ freqHz: Math.round(f * 10) / 10, pan: Math.round(pan * 1000) / 1000, weight: Math.round(weight * 1000) / 1000 });
  }
  out.sort((a, b) => a.freqHz - b.freqHz);
  return out.filter((p) => p.freqHz + d.jitterHz < 0.45 * sr);
}

/**
 * The shimmer partials of the defective demo for a given seed / sample rate (base
 * frequencies; each partial additionally jitters by ±`DEMO_DEFECTS.shimmer.jitterHz`
 * per frame). Partials at or above 0.45·sampleRate are omitted.
 * @param {{ sampleRate?: number, seed?: number }} [opts]
 * @returns {{ freqHz: number, pan: number, weight: number }[]}
 */
export function demoShimmerPartials({ sampleRate = 48000, seed = 7 } = {}) {
  checkRate(sampleRate);
  return shimmerPartials(seedInt(seed), sampleRate);
}

/**
 * Two rotation oscillators added to L/R over [a, b). State block per slot k at
 * st[8k..8k+7] = cos, sin, cos w, sin w, gain, gain step, pan L, pan R. Two independent
 * recursions per loop overlap (a single rotation is latency-bound).
 */
function shimmerPair(L, R, a, b, st, o) {
  let c0 = st[o], s0 = st[o + 1], g0 = st[o + 4];
  let c1 = st[o + 8], s1 = st[o + 9], g1 = st[o + 12];
  const x0 = st[o + 2], y0 = st[o + 3], d0 = st[o + 5], l0 = st[o + 6], r0 = st[o + 7];
  const x1 = st[o + 10], y1 = st[o + 11], d1 = st[o + 13], l1 = st[o + 14], r1 = st[o + 15];
  for (let k = a; k < b; k++) {
    const v0 = g0 * s0;
    const v1 = g1 * s1;
    L[k] += v0 * l0 + v1 * l1;
    R[k] += v0 * r0 + v1 * r1;
    let t = c0 * x0 - s0 * y0;
    s0 = s0 * x0 + c0 * y0;
    c0 = t;
    t = c1 * x1 - s1 * y1;
    s1 = s1 * x1 + c1 * y1;
    c1 = t;
    g0 += d0;
    g1 += d1;
  }
  st[o] = c0; st[o + 1] = s0; st[o + 4] = g0;
  st[o + 8] = c1; st[o + 9] = s1; st[o + 12] = g1;
}

/**
 * Adds flickering narrowband partials whose level follows the music's 6–16 kHz envelope
 * (research A2: "metallic / glassy texture moving with the music"; neural-codec frames
 * switch partials on and off, so they flicker frame to frame).
 */
function addShimmer(L, R, sr, seed) {
  const n = L.length;
  const d = DEMO_DEFECTS.shimmer;
  const parts = shimmerPartials(seed, sr);
  const P = parts.length;
  if (!P) return;
  const F = Math.max(16, Math.round((d.frameMs / 1000) * sr));
  const nF = Math.ceil(n / F);
  // Envelope: frame RMS of the mid signal above 6 kHz (4th-order high-pass; little energy
  // lies above 16 kHz), peak-hold with ~150 ms release.
  const hp = design('highpass', d.envelopeBandHz[0], sr, Math.SQRT1_2);
  const env = new Float64Array(nF);
  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  for (let f = 0; f < nF; f++) {
    const e = Math.min(n, (f + 1) * F);
    let s = 0;
    for (let i = f * F; i < e; i++) {
      const x = 0.5 * (L[i] + R[i]);
      let y = hp.b0 * x + h1; h1 = hp.b1 * x - hp.a1 * y + h2; h2 = hp.b2 * x - hp.a2 * y;
      const x2 = y; y = hp.b0 * x2 + h3; h3 = hp.b1 * x2 - hp.a1 * y + h4; h4 = hp.b2 * x2 - hp.a2 * y;
      s += y * y;
    }
    env[f] = Math.sqrt(s / Math.max(1, e - f * F));
  }
  const rel = Math.exp(-F / (0.15 * sr));
  for (let f = 1; f < nF; f++) env[f] = Math.max(env[f], env[f - 1] * rel);

  const level = dbGain(d.levelDb);
  const rng = rngFor(seed, 102);
  const xf = Math.max(1, Math.min(F, Math.round((d.crossfadeMs / 1000) * sr)));
  const Q = Math.ceil(P / 2);
  const st = new Float64Array(Q * 16); // an unused slot keeps gain 0
  for (let p = 0; p < P; p++) {
    const o = 8 * p;
    const ph = TAU * rng();
    st[o] = Math.cos(ph);
    st[o + 1] = Math.sin(ph);
    st[o + 2] = 1;
    st[o + 6] = Math.cos(((parts[p].pan + 1) * Math.PI) / 4);
    st[o + 7] = Math.sin(((parts[p].pan + 1) * Math.PI) / 4);
  }
  const gNext = new Float64Array(P);
  for (let f = 0; f < nF; f++) {
    const i0 = f * F;
    const i1 = Math.min(n, i0 + F);
    const ramp = Math.min(xf, i1 - i0);
    for (let p = 0; p < P; p++) {
      const o = 8 * p;
      const on = rng() < d.onProbability;
      const lvl = d.onGainRange[0] + (d.onGainRange[1] - d.onGainRange[0]) * rng();
      const w = (TAU * (parts[p].freqHz + (2 * rng() - 1) * d.jitterHz)) / sr;
      gNext[p] = on ? level * parts[p].weight * lvl * env[f] : 0;
      st[o + 2] = Math.cos(w);
      st[o + 3] = Math.sin(w);
      const norm = 1 / Math.sqrt(st[o] * st[o] + st[o + 1] * st[o + 1]); // stop amplitude drift
      st[o] *= norm;
      st[o + 1] *= norm;
      st[o + 5] = (gNext[p] - st[o + 4]) / ramp;
    }
    for (let q = 0; q < Q; q++) {
      const o = 16 * q;
      const p1 = 2 * q + 1 < P;
      // silent pair (off before and after): skip; its phase is irrelevant until it returns
      if (st[o + 4] === 0 && gNext[2 * q] === 0 && (!p1 || (st[o + 12] === 0 && gNext[2 * q + 1] === 0))) continue;
      shimmerPair(L, R, i0, i0 + ramp, st, o);
      st[o + 4] = gNext[2 * q];
      st[o + 5] = 0;
      if (p1) {
        st[o + 12] = gNext[2 * q + 1];
        st[o + 13] = 0;
      }
      if (i0 + ramp < i1) shimmerPair(L, R, i0 + ramp, i1, st, o);
    }
    for (let p = 0; p < P; p++) st[8 * p + 4] = gNext[p];
  }
}

/**
 * Hiss generator state: uncorrelated L/R white noise (inline LCG, uniform, variance 1/3)
 * through a 2nd-order high-pass, scaled to the target RMS from the filter's noise gain
 * Σh² (so it can be generated inside the final pass).
 */
function hissState(sr, seed) {
  const d = DEMO_DEFECTS.hiss;
  const c = design('highpass', d.highpassHz, sr, Math.SQRT1_2);
  let z1 = 0, z2 = 0, e = 0;
  for (let i = 0; i < 1 << 14; i++) {
    const x = i === 0 ? 1 : 0;
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    e += y * y;
  }
  const g = dbGain(d.rmsDbfs) / Math.sqrt(e / 3);
  return { c, g, nl: lcgSeed(rngFor(seed, 201)), nr: lcgSeed(rngFor(seed, 202)) };
}

// --------------------------------------------------------------------------------
// Level: BS.1770-4 loudness (private copy), naive soft clipper, sample-peak limiter
// --------------------------------------------------------------------------------

/** K-weighting biquads for any rate (libebur128 analog prototype; RESEARCH §7). */
function kWeighting(sr) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  // numerator kept un-normalized [1, −2, 1] (as libebur128)
  const s2 = { a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

/** Gated BS.1770 loudness from mean-square K-weighted 100 ms sub-blocks (L+R summed). */
function gatedLoudness(power, nSub) {
  if (nSub < 4) return -Infinity;
  const nb = nSub - 3;
  const lufs = (p) => -0.691 + 10 * Math.log10(Math.max(p, 1e-30));
  const blocks = new Float64Array(nb);
  for (let j = 0; j < nb; j++) blocks[j] = 0.25 * (power[j] + power[j + 1] + power[j + 2] + power[j + 3]);
  let sum = 0;
  let cnt = 0;
  for (let j = 0; j < nb; j++) {
    if (lufs(blocks[j]) > -70) {
      sum += blocks[j];
      cnt++;
    }
  }
  if (!cnt) return -Infinity;
  const rel = lufs(sum / cnt) - 10;
  sum = 0;
  cnt = 0;
  for (let j = 0; j < nb; j++) {
    const v = lufs(blocks[j]);
    if (v > -70 && v > rel) {
      sum += blocks[j];
      cnt++;
    }
  }
  return cnt ? lufs(sum / cnt) : -Infinity;
}

/**
 * Gated integrated loudness (LUFS) of a stereo pair; −Infinity if < 400 ms or silent.
 * half = true: estimate from the pairwise-averaged signal at sr/2 (2× cheaper; within
 * ~0.1 LU on this material, which has little energy above sr/4). Used only to pick the
 * gain before the limiter; the result is re-measured at full rate.
 */
function integratedLufs(L, R, sr, half = false) {
  const step = half ? 2 : 1;
  const rate = sr / step;
  const sub = Math.round(0.1 * rate);
  const nSub = Math.floor(Math.floor(L.length / step) / sub);
  if (nSub < 4) return -Infinity;
  const [s1, s2] = kWeighting(rate);
  const { b0, b1, b2, a1: p1, a2: p2 } = s1;
  const q1 = s2.a1;
  const q2 = s2.a2;
  const power = new Float64Array(nSub);
  let la1 = 0, la2 = 0, lb1 = 0, lb2 = 0, ra1 = 0, ra2 = 0, rb1 = 0, rb2 = 0;
  for (let j = 0; j < nSub; j++) {
    let acc = 0;
    const e = (j + 1) * sub;
    for (let i = j * sub; i < e; i++) {
      const xl = half ? 0.5 * (L[2 * i] + L[2 * i + 1]) : L[i];
      const yl = b0 * xl + la1;
      la1 = b1 * xl - p1 * yl + la2;
      la2 = b2 * xl - p2 * yl;
      const zl = yl + lb1;
      lb1 = -2 * yl - q1 * zl + lb2;
      lb2 = yl - q2 * zl;
      const xr = half ? 0.5 * (R[2 * i] + R[2 * i + 1]) : R[i];
      const yr = b0 * xr + ra1;
      ra1 = b1 * xr - p1 * yr + ra2;
      ra2 = b2 * xr - p2 * yr;
      const zr = yr + rb1;
      rb1 = -2 * yr - q1 * zr + rb2;
      rb2 = yr - q2 * zr;
      acc += zl * zl + zr * zr;
    }
    power[j] = acc / sub;
  }
  return gatedLoudness(power, nSub);
}

/**
 * tanh-like saturation for u >= 0: Padé [3/2] u(27 + u²)/(27 + 9u²), which reaches 1
 * with zero slope at u = 3 (so clamping there is C1) and is monotonic in between
 * (derivative ∝ (u² − 9)²). Math.tanh is far slower in some JS engines.
 */
function satPade(u) {
  return u >= 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u);
}

/**
 * Stereo-linked lookahead SAMPLE-peak limiter with its input stage:
 *   input  x ← x · preGain, then (clipT > 0) a sample-domain tanh-like soft clipper
 *          (transparent below clipT, asymptote clipC; deliberately NOT oversampled,
 *          like a naive loudness maximizer);
 *   gain   required gain g → forward moving minimum over W samples (van Herk / Gil-Werman
 *          block prefix/suffix minima, branch-light) → instant attack / exponential
 *          release → W-sample box average. Every box input r[j] (j ∈ [i−W+1, i]) is
 *          ≤ min(g[j..j+W−1]) ≤ g[i], so no output SAMPLE exceeds the ceiling; zero
 *          latency (gain applied to the aligned sample). Inter-sample peaks are NOT
 *          controlled — intended for the "overs" defect.
 * gs/hs: scratch Float32Arrays of the same length.
 */
function limitSamplePeaks(L, R, sr, gs, hs, { ceiling, releaseMs, lookMs, preGain = 1, clipT = 0, clipC = 1 }) {
  const n = L.length;
  const W = Math.max(1, Math.round((lookMs / 1000) * sr));
  const relA = 1 - Math.exp(-1 / ((releaseMs / 1000) * sr));
  const span = clipC - clipT;
  for (let j = 0; j < n; j++) {
    let xl = L[j] * preGain;
    let xr = R[j] * preGain;
    let a = xl < 0 ? -xl : xl;
    let b = xr < 0 ? -xr : xr;
    if (clipT > 0) {
      if (a > clipT) {
        a = clipT + span * satPade((a - clipT) / span);
        xl = xl < 0 ? -a : a;
      }
      if (b > clipT) {
        b = clipT + span * satPade((b - clipT) / span);
        xr = xr < 0 ? -b : b;
      }
    }
    L[j] = xl;
    R[j] = xr;
    const pk = a > b ? a : b;
    gs[j] = pk > ceiling ? ceiling / pk : 1;
  }
  for (let b0 = 0; b0 < n; b0 += W) {
    const e = Math.min(n, b0 + W);
    let m = 1;
    for (let j = b0; j < e; j++) {
      if (gs[j] < m) m = gs[j];
      hs[j] = m; // prefix minimum within the block
    }
    m = 1;
    for (let j = e - 1; j >= b0; j--) {
      if (gs[j] < m) m = gs[j];
      gs[j] = m; // suffix minimum within the block
    }
  }
  const ring = new Float64Array(W);
  const m0 = Math.min(gs[0], hs[Math.min(n - 1, W - 1)]);
  ring.fill(m0); // virtual history = first window minimum keeps s[0..] <= g
  let sum = m0 * W;
  let r = m0;
  let slot = 0;
  for (let i = 0; i < n; i++) {
    const k = i + W - 1 < n ? i + W - 1 : n - 1;
    const m = gs[i] < hs[k] ? gs[i] : hs[k];
    r = m < r ? m : r + (m - r) * relA;
    sum += r - ring[slot];
    ring[slot] = r;
    if (++slot === W) slot = 0;
    const s = sum / W;
    if (s < 1) {
      L[i] *= s;
      R[i] *= s;
    }
  }
}

// Integrated loudness of the un-levelled mix (48 kHz, 32 s, seed 7). Anchor for the
// gain when a render is too short to measure (or would need an absurd boost).
const NOMINAL_MIX_LUFS = { defects: -12.3, clean: -14.1 };
// Typical loudness lost in the clipper/limiter, pre-compensated so that the corrective
// second pass is rarely needed.
const LIMIT_LOSS_DB = { defects: 0.5, clean: 0 };

/**
 * Gain to the target loudness → (defects: naive soft clip) → sample-peak limiter →
 * re-measure; a corrective gain + limiter pass only if more than 0.2 LU off.
 */
function levelStage(L, R, sr, defects, gs, hs) {
  const key = defects ? 'defects' : 'clean';
  const target = defects ? DEMO_DEFECTS.level.targetLufs : DEMO_DEFECTS.clean.targetLufs;
  const ceiling = dbGain(defects ? DEMO_DEFECTS.level.samplePeakDbfs : DEMO_DEFECTS.clean.samplePeakDbfs);
  const nominal = target - NOMINAL_MIX_LUFS[key];
  const measured = integratedLufs(L, R, sr, true);
  const gainDb = Number.isFinite(measured) ? Math.min(nominal + 6, Math.max(nominal - 6, target - measured)) : nominal;
  const lim = { ceiling, releaseMs: defects ? 50 : 120, lookMs: defects ? 1 : 3 };
  limitSamplePeaks(L, R, sr, gs, hs, {
    ...lim,
    preGain: dbGain(gainDb + LIMIT_LOSS_DB[key]),
    // loud-master character: shave the transients before the limiter
    clipT: defects ? 0.8 : 0,
    clipC: 1.15,
  });
  const now = integratedLufs(L, R, sr);
  if (Number.isFinite(now) && Math.abs(target - now) > 0.2) {
    limitSamplePeaks(L, R, sr, gs, hs, { ...lim, preGain: dbGain(Math.min(4, Math.max(-6, target - now))) });
  }
}

// --------------------------------------------------------------------------------
// Public entry
// --------------------------------------------------------------------------------

function checkRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError(`generateDemoTrack: sampleRate must be 8000..384000 Hz, got ${sampleRate}`);
  }
}

function checkSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) throw new RangeError(`generateDemoTrack: seconds must be >= 0, got ${seconds}`);
  return Math.min(s, MAX_SECONDS);
}

function seedInt(seed) {
  const s = Number(seed);
  return Number.isFinite(s) ? Math.floor(s) >>> 0 : 7;
}

/**
 * Renders the demo song.
 *
 * @param {{ sampleRate?: number, seconds?: number, seed?: number, defects?: boolean }} [opts]
 *   sampleRate 8000..384000 (default 48000); seconds 0..600 (default 32; length is
 *   round(seconds·sampleRate)); seed: any number (floored, low 32 bits; non-numeric → 7)
 *   — changes noise textures, drum humanization, vocal intonation and the shimmer
 *   partials, not the composition; defects: bake in the AI-generator defects of
 *   DEMO_DEFECTS (default true). Throws RangeError on an invalid rate or duration.
 * @returns {{ sampleRate: number, channels: Float32Array[] }} stereo AudioData
 */
export function generateDemoTrack({ sampleRate = 48000, seconds = 32, seed = 7, defects = true } = {}) {
  checkRate(sampleRate);
  const secs = checkSeconds(seconds);
  const sr = sampleRate;
  const n = Math.round(secs * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  if (n === 0) return { sampleRate: sr, channels: [L, R] };
  const bad = !!defects;
  const s = seedInt(seed);
  const arr = buildArrangement(n / sr, bad);
  const low = new Float32Array(n);
  const send = new Float32Array(n);
  const vox = new Float32Array(n);
  const tl = drumTimeline(arr, rngFor(s, 1));
  const duck = buildDuck(n, sr, tl.kicks);

  // Pad first (L/R are still empty, so the filter and the pump only touch the pad).
  renderPad(L, R, sr, arr, rngFor(s, 2));
  svfLowpassStereo(L, R, sr, (t) => padCutoff(arr, t), 0.8, 280);
  padSendAndPump(L, R, send, duck);

  // Vocal lead with consonants, ping-pong delay and reverb send.
  renderVocal(vox, sr, arr.notes, rngFor(s, 3));
  renderSibilants(vox, sr, arr.notes, bad ? 0.1 * dbGain(DEMO_DEFECTS.sibilance.excessDb) : 0.1, rngFor(s, 4));
  pingPong(vox, L, R, sr, 0.09);
  mixVocal(L, R, send, vox, 0.29, 0.3);

  // Low bus: mono when clean; the defect gets a second (right) bus whose kick body and
  // sub oscillators run phase-offset. `vox` is free now and becomes that bus.
  const rot = bad ? DEMO_DEFECTS.wideBass.phaseOffsetDeg : 0;
  let lowR = low;
  if (bad) {
    vox.fill(0);
    lowR = vox;
  }
  renderDrums(L, R, low, bad ? lowR : null, send, sr, arr, tl, rngFor(s, 5), rot);
  renderBass(low, bad ? lowR : null, sr, arr, duck, rot);
  reverb(send, L, R, sr, REVERB_WET);
  mixLow(L, R, low, lowR, sr);

  if (bad) {
    eqStereo(L, R, [
      design('peaking', DEMO_DEFECTS.mud.freqHz, sr, DEMO_DEFECTS.mud.q, DEMO_DEFECTS.mud.gainDb),
      design('peaking', DEMO_DEFECTS.harsh.freqHz, sr, DEMO_DEFECTS.harsh.q, DEMO_DEFECTS.harsh.gainDb),
    ]);
    addShimmer(L, R, sr, s);
  }

  // send/vox are free from here on: scratch for the limiter.
  levelStage(L, R, sr, bad, send, vox);
  removeMean(L);
  removeMean(R);
  if (bad) {
    finish(L, R, hissState(sr, s), DEMO_DEFECTS.dc.left, DEMO_DEFECTS.dc.right);
  } else {
    fadeEdges(L, R, sr, Math.min(1.2, secs / 4));
    finish(L, R, null, 0, 0);
  }
  return { sampleRate: sr, channels: [L, R] };
}

/** Drum hits for the arrangement, with light seeded humanization (±2 ms, velocity). */
function drumTimeline(arr, hum) {
  const jit = () => (hum() - 0.5) * 0.004;
  const vel = () => 0.92 + 0.08 * hum();
  const kicks = [];
  const claps = [];
  const hats = [];
  const crashes = [];
  for (const bar of arr.bars) {
    const t = bar.startSec;
    const sec = bar.section;
    if (sec === 'verse' || sec === 'chorus') {
      for (let b = 0; b < 4; b++) kicks.push({ t: t + b * BEAT });
      for (const b of [1, 3]) claps.push({ t: t + b * BEAT + jit(), vel: vel(), tone: sec === 'chorus', v: hum() });
      // snare pickup into the next section
      if (bar.barInSection === bar.sectionLen - 1 && bar.index < arr.bars.length - 1) {
        for (let k = 1; k < 4; k++) claps.push({ t: t + 3 * BEAT + k * (BEAT / 4) + jit(), vel: 0.35 + 0.15 * k, tone: true, v: hum() });
      }
      if (bar.barInSection === 0 && sec === 'chorus') crashes.push({ t, vel: 0.045 });
      const steps = sec === 'chorus' ? 16 : 8;
      for (let k = 0; k < steps; k++) {
        const step = (k * 16) / steps;
        const open = sec === 'chorus' && step % 4 === 2;
        const accent = step % 4 === 2 ? 1 : step % 2 === 0 ? 0.75 : 0.5;
        hats.push({ t: t + step * (BEAT / 4) + jit(), vel: (open ? 0.045 : 0.06) * accent * vel(), open, pan: open ? -0.25 : 0.3, v: hum() });
      }
    } else if (sec === 'intro' && bar.index === 1) {
      for (let k = 0; k < 8; k++) hats.push({ t: t + k * EIGHTH + jit(), vel: 0.035 * (k % 2 ? 1 : 0.7) * vel(), open: false, pan: 0.3, v: hum() });
    } else if (sec === 'ending' && bar.barInSection === 0) {
      kicks.push({ t });
      crashes.push({ t, vel: 0.05 });
    }
  }
  return { kicks, claps, hats, crashes };
}

/** Drums: one-shot samples (a few variants for the noisy ones) mixed in at each hit. */
function renderDrums(L, R, low, lowR, send, sr, arr, tl, rng, rotDeg) {
  const kick = kickSample(sr, rng, lowR ? rotDeg : 0);
  for (const k of tl.kicks) {
    const i0 = Math.round(k.t * sr);
    addAt(low, kick.body, i0, 0.38);
    if (lowR) addAt(lowR, kick.bodyR, i0, 0.38);
    addAt(L, kick.click, i0, 1);
    addAt(R, kick.click, i0, 1);
  }
  const clapVar = [0, 1, 2].map(() => [clapSample(sr, rng, false), clapSample(sr, rng, true)]);
  for (const c of tl.claps) {
    const smp = clapVar[Math.floor(c.v * 3)][c.tone ? 1 : 0];
    const i0 = Math.round(c.t * sr);
    const g = 0.49 * c.vel;
    addAt(L, smp.l, i0, g);
    addAt(R, smp.r, i0, g);
    addAt(send, smp.s, i0, g);
  }
  const closedVar = [0, 1, 2, 3, 4, 5].map(() => hatSample(sr, rng, 0.026));
  const openVar = [0, 1, 2].map(() => hatSample(sr, rng, 0.14));
  for (const h of tl.hats) {
    const smp = h.open ? openVar[Math.floor(h.v * 3)] : closedVar[Math.floor(h.v * 6)];
    const p = ((h.pan + 1) * Math.PI) / 4;
    const i0 = Math.round(h.t * sr);
    addAt(L, smp, i0, h.vel * Math.cos(p));
    addAt(R, smp, i0, h.vel * Math.sin(p));
  }
  if (tl.crashes.length) {
    const crashVar = [crashSample(sr, rng), crashSample(sr, rng)];
    tl.crashes.forEach((c, k) => {
      const smp = crashVar[k % 2];
      const i0 = Math.round(c.t * sr);
      addAt(L, smp.l, i0, c.vel);
      addAt(R, smp.r, i0, c.vel);
      addAt(send, smp.l, i0, 0.3 * c.vel);
      addAt(send, smp.r, i0, 0.3 * c.vel);
    });
  }
  if (arr.bars.length > 1) renderRiser(L, R, sr, BAR, BAR, 0.05, rng);
}

/** Reverb send from the (filtered) pad, then the side-chain pump on the pad itself. */
function padSendAndPump(L, R, send, duck) {
  for (let i = 0; i < L.length; i++) {
    send[i] = 0.35 * (L[i] + R[i]);
    const g = 1 - 0.45 * duck[i];
    L[i] *= g;
    R[i] *= g;
  }
}

function mixVocal(L, R, send, vox, gain, sendGain) {
  for (let i = 0; i < L.length; i++) {
    const v = gain * vox[i];
    L[i] += v;
    R[i] += v;
    send[i] += sendGain * v;
  }
}

/**
 * Subtracts the residual mean the asymmetric clipping/limiting of kick-heavy material
 * leaves behind (~1e-4), so DC is exactly what the defect specifies (or none).
 */
function removeMean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  const m = s / x.length;
  for (let i = 0; i < x.length; i++) x[i] -= m;
}

/** Clean version: 5 ms fade-in and an equal-power fade to digital silence at the end. */
function fadeEdges(L, R, sr, outSec) {
  const n = L.length;
  const fi = Math.min(n, Math.round(0.005 * sr));
  for (let i = 0; i < fi; i++) {
    const g = i / fi;
    L[i] *= g;
    R[i] *= g;
  }
  const fo = Math.min(n, Math.round(outSec * sr));
  for (let k = 0; k < fo; k++) {
    const i = n - fo + k;
    const g = k === fo - 1 ? 0 : Math.cos(((k + 1) / fo) * (Math.PI / 2));
    L[i] *= g;
    R[i] *= g;
  }
}

/** Optional hiss + DC, then hygiene: no NaN, nothing at or above full scale. */
function finish(L, R, hiss, dcL, dcR) {
  const lim = 0.9985;
  const n = L.length;
  if (!hiss) {
    for (let i = 0; i < n; i++) {
      const a = L[i] + dcL;
      const b = R[i] + dcR;
      L[i] = a !== a ? 0 : a > lim ? lim : a < -lim ? -lim : a;
      R[i] = b !== b ? 0 : b > lim ? lim : b < -lim ? -lim : b;
    }
    return;
  }
  const { c, g } = hiss;
  let nl = hiss.nl;
  let nr = hiss.nr;
  let l1 = 0, l2 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    nl = (Math.imul(nl, 1664525) + 1013904223) | 0;
    nr = (Math.imul(nr, 1664525) + 1013904223) | 0;
    const wl = nl * LCG_SCALE;
    const wr = nr * LCG_SCALE;
    const yl = c.b0 * wl + l1;
    l1 = c.b1 * wl - c.a1 * yl + l2;
    l2 = c.b2 * wl - c.a2 * yl;
    const yr = c.b0 * wr + r1;
    r1 = c.b1 * wr - c.a1 * yr + r2;
    r2 = c.b2 * wr - c.a2 * yr;
    const a = L[i] + dcL + g * yl;
    const b = R[i] + dcR + g * yr;
    L[i] = a !== a ? 0 : a > lim ? lim : a < -lim ? -lim : a;
    R[i] = b !== b ? 0 : b > lim ? lim : b < -lim ? -lim : b;
  }
}

/** Two biquads in series on L and R, both channels in one loop. */
function eqStereo(L, R, [c, d]) {
  let l1 = 0, l2 = 0, l3 = 0, l4 = 0, r1 = 0, r2 = 0, r3 = 0, r4 = 0;
  for (let i = 0; i < L.length; i++) {
    const xl = L[i];
    const yl = c.b0 * xl + l1;
    l1 = c.b1 * xl - c.a1 * yl + l2;
    l2 = c.b2 * xl - c.a2 * yl;
    const zl = d.b0 * yl + l3;
    l3 = d.b1 * yl - d.a1 * zl + l4;
    l4 = d.b2 * yl - d.a2 * zl;
    L[i] = zl;
    const xr = R[i];
    const yr = c.b0 * xr + r1;
    r1 = c.b1 * xr - c.a1 * yr + r2;
    r2 = c.b2 * xr - c.a2 * yr;
    const zr = d.b0 * yr + r3;
    r3 = d.b1 * yr - d.a1 * zr + r4;
    r4 = d.b2 * yr - d.a2 * zr;
    R[i] = zr;
  }
}
