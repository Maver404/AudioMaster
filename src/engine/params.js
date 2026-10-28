// Parameter schema, defaults and presets for the mastering chain.
// The assistant (assistant.js) turns analysis + four simple choices into a full
// Params object; the advanced panel edits the same object through ADVANCED_SECTIONS.
// Values here are the single source of truth for ranges shown in the UI.
// Numbers follow docs/RESEARCH.md (§1 intensity table, §2 cleanup recipes, §3 destinations).

/**
 * Delivery destinations. `lufs` = integrated loudness target, `ceilingDb` = true-peak
 * ceiling (dBTP). `lufsRange` (Loud/Club) is spanned by intensity Low → High.
 * Spotify and SoundCloud ask for −2 dBTP on masters louder than −14 LUFS, because
 * lossy encoding of dense material overshoots more.
 * `main: true` destinations are shown as segments; the others live under "More".
 * `dynamics` scales the multiband / glue gain-reduction targets of the intensity table
 * (RESEARCH §1): a normalised platform turns every master down to the same loudness, so
 * density buys nothing there and costs macro-dynamics (chorus lift); Hi-Fi promises
 * "more dynamics"; only the loud, non-normalised destinations get the full amount.
 */
export const DESTINATIONS = {
  streaming: { lufs: -14, ceilingDb: -1.0, main: true, dynamics: 0.6 },
  loud: { lufs: -10, lufsRange: [-11, -9], ceilingDb: -2.0, main: true, dynamics: 1 },
  hifi: { lufs: -16, ceilingDb: -1.0, main: true, dynamics: 0 },
  club: { lufs: -8, lufsRange: [-9, -7], ceilingDb: -1.0, main: true, sampleRate: 44100, dynamics: 1 },
  video: { lufs: -14, ceilingDb: -1.0, sampleRate: 48000, dynamics: 0.6 },
  social: { lufs: -12, ceilingDb: -2.0, sampleRate: 48000, dynamics: 0.6 },
  broadcast: { lufs: -23, ceilingDb: -1.0, sampleRate: 48000, dynamics: 0.5 },
};
export const DESTINATION_IDS = ['streaming', 'loud', 'hifi', 'club', 'video', 'social', 'broadcast'];

/**
 * How each platform normalises playback, for the "how it will sound there" preview.
 * gain = ref − I, turned down always; boosted only when `boost`, and then limited so
 * the true peak stays at or below `boostPeakLimitDb` (Spotify: min(ref − I, −1 − TP)).
 */
export const PLATFORMS = [
  { id: 'spotify', ref: -14, boost: true, boostPeakLimitDb: -1 },
  { id: 'apple', ref: -16, boost: true, boostPeakLimitDb: -1 },
  { id: 'youtube', ref: -14, boost: false },
  { id: 'amazon', ref: -14, boost: false },
  { id: 'tidal', ref: -14, boost: false },
  { id: 'deezer', ref: -15, boost: false },
];

/** Playback gain (dB) a platform applies to a master with integrated loudness I and true peak TP. */
export function platformGainDb(platform, I, TP) {
  const g = platform.ref - I;
  if (g <= 0) return g;
  if (!platform.boost) return 0;
  return Math.max(0, Math.min(g, platform.boostPeakLimitDb - TP));
}

/**
 * Character presets (deltas vs Balanced, applied by the assistant at intensity 0.5 and
 * scaled by intensity/0.5). Tilt is a complementary shelf pair pivoting at 1 kHz (Warm).
 * Bright uses a broad high shelf instead (`highShelfDb` at `highShelfHz`, Q 0.4: ≈ +1 dB
 * from 6 kHz up, nothing below 300 Hz), so it opens the top without thinning the sub.
 * `bandTiming` overrides the multiband timing per band and adds gain reduction (Punchy: a
 * low band that follows each kick — 15 ms detector, 40 ms attack, 90 ms release — and a
 * slower mid-band attack let the hit through before the band clamps the body; grAddDb ×
 * t/0.5 is added to the band target whatever the destination, since punch is a character
 * choice, not density). No low shelf: it lifted the kick's body (≈ 50 Hz) more than its
 * attack.
 */
export const STYLES = {
  balanced: { tiltDbPerOct: 0, lowShelfDb: 0, lowShelfHz: 90, presenceDb: 0, presenceHz: 3000, airDb: 0, highShelfDb: 0, highShelfHz: 2000, mudDb: 0, drive: 0, widthAdd: 0, glue: {}, bandTiming: null, lowBandRatioAdd: 0, clipAddDb: 0, deEssExtraDb: 0 },
  warm: { tiltDbPerOct: -0.4, lowShelfDb: 0.75, lowShelfHz: 90, presenceDb: -0.5, presenceHz: 3000, airDb: 0, highShelfDb: 0, highShelfHz: 2000, mudDb: 0, drive: 0.15, widthAdd: 0, glue: { releaseMs: 200, ratioAdd: -0.2 }, bandTiming: null, lowBandRatioAdd: 0, clipAddDb: 0, deEssExtraDb: 1 },
  bright: { tiltDbPerOct: 0, lowShelfDb: 0, lowShelfHz: 90, presenceDb: 0.75, presenceHz: 3000, airDb: 1, highShelfDb: 1.2, highShelfHz: 2000, mudDb: 0, drive: -1, widthAdd: 0.05, glue: {}, bandTiming: null, lowBandRatioAdd: 0, clipAddDb: 0, deEssExtraDb: 0 },
  punchy: { tiltDbPerOct: 0, lowShelfDb: 0, lowShelfHz: 80, presenceDb: 0.5, presenceHz: 2500, airDb: 0, highShelfDb: 0, highShelfHz: 2000, mudDb: -0.5, drive: 0, widthAdd: 0, glue: { releaseMs: 100 }, bandTiming: [{ rmsMs: 15, attackMs: 40, releaseMs: 90, grAddDb: 0.6 }, { attackMs: 45, releaseMs: 70, grAddDb: 0.6 }], lowBandRatioAdd: 0.3, clipAddDb: 0, deEssExtraDb: 0 },
};
export const STYLE_IDS = ['balanced', 'warm', 'bright', 'punchy'];

/** UI presets for the continuous intensity 0..1 (RESEARCH §1 table rows). */
export const INTENSITIES = { low: 0.25, medium: 0.5, high: 0.75 };

/**
 * Intensity table (RESEARCH §1). The assistant interpolates linearly between rows by t;
 * below t = 0.25 values scale toward the "zero" row, above 0.75 they extrapolate to t = 1
 * with the listed caps.
 */
export const INTENSITY_TABLE = {
  t: [0, 0.25, 0.5, 0.75, 1],
  autoEqStrength: [0.2, 0.35, 0.6, 0.85, 0.95],
  autoEqMaxDb: [1.5, 2, 3, 4, 4.5],
  // realised mean GR of the LOUD sections (chain: calibrated, ballistics included), before
  // the destination's `dynamics` scale
  multibandTargetGrDb: [0.2, 0.5, 1, 2, 3],
  glueRatio: [1.25, 1.4, 1.7, 2.0, 2.3],
  glueTargetGrDb: [0.25, 0.5, 1, 2, 2],
  saturationDrive: [0.015, 0.03, 0.06, 0.1, 0.14],
  clipperDb: [0, 0, 0.5, 1.5, 2],
  // deepest soft clip allowed on the highest peak when the loudness stage escalates
  clipperMaxDepthDb: [2, 2.5, 3, 4, 4],
  limiterBudgetDb: [2.5, 3, 4, 6, 7],
};

/** AI-artifact cleanup strength presets: k multiplies the max gain changes (RESEARCH §2). */
export const CLEANUP_LEVELS = {
  off: { k: 0, monoBassHz: 0, denoiseMaxDb: 0 },
  light: { k: 0.5, monoBassHz: 80, denoiseMaxDb: 3 },
  medium: { k: 1.0, monoBassHz: 100, denoiseMaxDb: 6 },
  strong: { k: 1.5, monoBassHz: 120, denoiseMaxDb: 9 },
};
export const CLEANUP_IDS = ['off', 'light', 'medium', 'strong'];

/** "It sounds too …" buttons: each click moves one tone control by `stepDb`, capped at ±capDb. */
export const PROBLEM_FIXES = {
  dull: { path: 'eq.tone.airDb', stepDb: 1.5, capDb: 4.5 },
  harsh: { path: 'eq.tone.presenceDb', stepDb: -1.5, capDb: 4.5 },
  muddy: { path: 'eq.tone.mudDb', stepDb: -1.5, capDb: 4.5 },
  boomy: { path: 'eq.tone.boomDb', stepDb: -1.5, capDb: 4.5 },
  thin: { path: 'eq.tone.lowShelfDb', stepDb: 1.5, capDb: 4.5 },
};
export const PROBLEM_IDS = ['dull', 'harsh', 'muddy', 'boomy', 'thin'];

export const OUTPUT_SAMPLE_RATES = ['source', 44100, 48000];

/** @returns {{destination:string, style:string, intensity:number, cleanup:string}} */
export function defaultChoices() {
  return { destination: 'streaming', style: 'balanced', intensity: INTENSITIES.medium, cleanup: 'medium' };
}

/**
 * Dynamic-EQ band defaults (RESEARCH §2). Detection is relative (band level minus broadband
 * level); threshold = median of that difference + thresholdRelDb. `channel` selects where
 * the band works: 'stereo' (linked L/R), 'mid' or 'side'. type 'band' = constant-0dB-peak
 * band-pass subtraction; 'shelf' = first-order complementary high shelf.
 */
function dynBand(o) {
  return { enabled: false, type: 'band', channel: 'stereo', freq: 1000, q: 1, maxCutDb: 0, thresholdRelDb: 2, ratio: 2, kneeDb: 3, attackMs: 10, releaseMs: 120, lookaheadMs: 0, ...o };
}

/**
 * Neutral full parameter set (every module present). The assistant overwrites most values.
 * `meta` (optional, kept by validateParams): { destination, style, cleanup, intensity,
 * profile, brightened, styleTone, userOwned: string[] } — userOwned lists the dot paths
 * whose values came from the user (problem buttons, Advanced panel); QC never softens them.
 */
export function defaultParams() {
  return {
    version: 2,
    output: { sampleRate: 'source' },
    prepare: { dcBlock: true, highpassHz: 25, highpassOrder: 4 },
    // head / tail: which edges trimming may cut (the assistant cuts the head only when the
    // leading silence itself is long — the master's time 0 then moves, see report.trim)
    trim: { enabled: false, head: true, tail: true, thresholdDb: -60, keepStartMs: 100, keepEndMs: 800 },
    spectral: {
      deShimmer: { enabled: true, amount: 0.5, startHz: 5000, fullHz: 9000 },
      denoise: { enabled: false, amount: 0.5, fromHz: 6000 },
    },
    eq: {
      enabled: true,
      auto: { enabled: true, strength: 0.6, maxDb: 3, toleranceDb: 1.5, targetSlopeDbPerOct: null },
      // maxDb 4 = the QC EQ-range limit, so the Amount slider is never halved behind the user's back
      match: { enabled: false, strength: 0.5, maxDb: 4, referenceLtas: null, referenceName: '' },
      tone: {
        lowShelfDb: 0, lowShelfHz: 90,
        boomDb: 0, boomHz: 120, boomQ: 1.4,
        mudDb: 0, mudHz: 300, mudQ: 0.9,
        presenceDb: 0, presenceHz: 3000, presenceQ: 0.8,
        airDb: 0, airHz: 12000,
        highShelfDb: 0, highShelfHz: 2000,
        hashDb: 0, hashHz: 14000,
        tiltDbPerOct: 0, tiltPivotHz: 1000,
      },
    },
    dynEq: {
      bands: {
        mud: dynBand({ freq: 300, q: 0.9, maxCutDb: 2.5 }),
        boom: dynBand({ freq: 120, q: 1.4, maxCutDb: 2 }),
        harsh: dynBand({ freq: 3500, q: 2, maxCutDb: 2.5 }),
        fizz: dynBand({ freq: 6000, q: 2, maxCutDb: 2.5 }),
        deEss: dynBand({ channel: 'mid', freq: 7000, q: 1.2, maxCutDb: 4, thresholdRelDb: 7, ratio: 4, attackMs: 5, releaseMs: 60, lookaheadMs: 3 }),
        deEssAir: dynBand({ channel: 'mid', freq: 12500, q: 1.0, maxCutDb: 3, thresholdRelDb: 7, ratio: 4, attackMs: 2, releaseMs: 50, lookaheadMs: 3 }),
        sideHf: dynBand({ type: 'shelf', channel: 'side', freq: 8000, maxCutDb: 3, thresholdRelDb: 2, attackMs: 5, releaseMs: 150 }),
      },
    },
    color: {
      saturation: { enabled: true, drive: 0.06, mix: 1 },
      air: { enabled: false, amount: 0.5, fromHz: 8000 },
    },
    multiband: {
      enabled: true,
      crossovers: [120, 3000],
      preserveBalance: true,
      // Low band: long detector and slow ballistics so a sub-heavy kick / 808 note is not
      // ducked note by note (that strips 31–40 Hz and lifts 100 Hz in between). Mid band:
      // the detector is high-passed (4th order, 220 Hz) so kick harmonics just above the
      // 120 Hz split do not pull the vocals down on every hit.
      bands: [
        { ratio: 1.6, targetGrDb: 0.5, kneeDb: 6, attackMs: 60, releaseMs: 300, rmsMs: 60, sidechainHpHz: 0 },
        { ratio: 1.8, targetGrDb: 1, kneeDb: 6, attackMs: 20, releaseMs: 120, rmsMs: 15, sidechainHpHz: 220 },
        { ratio: 2.0, targetGrDb: 1, kneeDb: 6, attackMs: 5, releaseMs: 60, rmsMs: 5, sidechainHpHz: 0 },
      ],
    },
    stereo: { enabled: true, width: 1.0, widthFromHz: 1500, monoBassHz: 100 },
    glue: { enabled: true, ratio: 1.7, targetGrDb: 1, kneeDb: 8, attackMs: 30, releaseMs: 150, autoRelease: true, sidechainHpHz: 130, sidechainHpOrder: 4, mix: 1 },
    loudness: {
      targetLufs: -14,
      // Loud / Club: the lowest loudness still inside the destination's range (null = the
      // target); the chain may settle between it and the target when reaching the target
      // would need more than maxGrDb of limiting or maxDepthDb of soft clipping
      minTargetLufs: null,
      ceilingDb: -1.0,
      budgetDb: 4,
      maxGrDb: 9,
      clipper: { enabled: true, amountDb: 0.5, maxDepthDb: 3 },
      limiter: { lookaheadMs: 3, releaseMs: 80, adaptiveRelease: true },
    },
    finish: { fadeInMs: 5, fadeOutMs: 30 },
    qc: { enabled: true },
  };
}

/** The UI section each dynamic-EQ band belongs to, with its label key (advanced panel). */
export const DYN_EQ_BAND_IDS = ['mud', 'boom', 'harsh', 'fizz', 'deEss', 'deEssAir', 'sideHf'];

/**
 * Advanced-panel descriptor. Each control edits one `path` of Params.
 * type: 'toggle' | 'range' | 'select'. `scale: 'log'` for frequency sliders.
 * Units: 'dB', 'Hz', 'ms', '%' (value 0..1 shown as percent), 'x' (ratio/width), 'LUFS', 'dBTP', 'dB/oct'.
 * The rack never exposes crossovers, oversampling or detector internals (RESEARCH §5).
 */
export const ADVANCED_SECTIONS = [
  {
    id: 'cleanup', labelKey: 'adv.cleanup',
    controls: [
      { path: 'spectral.deShimmer.enabled', type: 'toggle', labelKey: 'adv.deShimmer' },
      { path: 'spectral.deShimmer.amount', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', labelKey: 'adv.amount', dependsOn: 'spectral.deShimmer.enabled' },
      { path: 'spectral.denoise.enabled', type: 'toggle', labelKey: 'adv.denoise' },
      { path: 'spectral.denoise.amount', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', labelKey: 'adv.amount', dependsOn: 'spectral.denoise.enabled' },
      { path: 'dynEq.bands.mud.enabled', type: 'toggle', labelKey: 'adv.dynMud' },
      { path: 'dynEq.bands.mud.maxCutDb', type: 'range', min: 0, max: 6, step: 0.5, unit: 'dB', labelKey: 'adv.maxCut', dependsOn: 'dynEq.bands.mud.enabled' },
      { path: 'dynEq.bands.harsh.enabled', type: 'toggle', labelKey: 'adv.dynHarsh' },
      { path: 'dynEq.bands.harsh.maxCutDb', type: 'range', min: 0, max: 6, step: 0.5, unit: 'dB', labelKey: 'adv.maxCut', dependsOn: 'dynEq.bands.harsh.enabled' },
      { path: 'dynEq.bands.harsh.freq', type: 'range', min: 2000, max: 6000, step: 50, unit: 'Hz', scale: 'log', labelKey: 'adv.freq', dependsOn: 'dynEq.bands.harsh.enabled' },
      { path: 'dynEq.bands.fizz.enabled', type: 'toggle', labelKey: 'adv.dynFizz' },
      { path: 'dynEq.bands.fizz.maxCutDb', type: 'range', min: 0, max: 6, step: 0.5, unit: 'dB', labelKey: 'adv.maxCut', dependsOn: 'dynEq.bands.fizz.enabled' },
      { path: 'dynEq.bands.deEss.enabled', type: 'toggle', labelKey: 'adv.deEss' },
      { path: 'dynEq.bands.deEss.maxCutDb', type: 'range', min: 0, max: 9, step: 0.5, unit: 'dB', labelKey: 'adv.maxCut', dependsOn: 'dynEq.bands.deEss.enabled' },
      { path: 'dynEq.bands.deEss.freq', type: 'range', min: 5000, max: 9000, step: 100, unit: 'Hz', scale: 'log', labelKey: 'adv.freq', dependsOn: 'dynEq.bands.deEss.enabled' },
      { path: 'dynEq.bands.sideHf.enabled', type: 'toggle', labelKey: 'adv.sideHf' },
      { path: 'dynEq.bands.sideHf.maxCutDb', type: 'range', min: 0, max: 6, step: 0.5, unit: 'dB', labelKey: 'adv.maxCut', dependsOn: 'dynEq.bands.sideHf.enabled' },
      { path: 'prepare.highpassHz', type: 'range', min: 15, max: 40, step: 1, unit: 'Hz', labelKey: 'adv.highpass' },
    ],
  },
  {
    id: 'eq', labelKey: 'adv.eq',
    controls: [
      { path: 'eq.auto.enabled', type: 'toggle', labelKey: 'adv.autoEq' },
      { path: 'eq.auto.strength', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', labelKey: 'adv.strength', dependsOn: 'eq.auto.enabled' },
      { path: 'eq.tone.lowShelfDb', type: 'range', min: -6, max: 6, step: 0.1, unit: 'dB', labelKey: 'adv.lows' },
      { path: 'eq.tone.boomDb', type: 'range', min: -6, max: 3, step: 0.1, unit: 'dB', labelKey: 'adv.boom' },
      { path: 'eq.tone.mudDb', type: 'range', min: -6, max: 3, step: 0.1, unit: 'dB', labelKey: 'adv.mud' },
      { path: 'eq.tone.presenceDb', type: 'range', min: -6, max: 6, step: 0.1, unit: 'dB', labelKey: 'adv.presence' },
      { path: 'eq.tone.airDb', type: 'range', min: -6, max: 6, step: 0.1, unit: 'dB', labelKey: 'adv.air' },
      { path: 'eq.tone.tiltDbPerOct', type: 'range', min: -1.5, max: 1.5, step: 0.05, unit: 'dB/oct', labelKey: 'adv.tilt' },
      { path: 'eq.match.enabled', type: 'toggle', labelKey: 'adv.match', dependsOn: 'eq.match.referenceLtas' },
      { path: 'eq.match.strength', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', labelKey: 'adv.strength', dependsOn: 'eq.match.enabled' },
    ],
  },
  {
    id: 'color', labelKey: 'adv.color',
    controls: [
      { path: 'color.saturation.enabled', type: 'toggle', labelKey: 'adv.saturation' },
      { path: 'color.saturation.drive', type: 'range', min: 0, max: 0.5, step: 0.01, unit: '%', labelKey: 'adv.drive', dependsOn: 'color.saturation.enabled' },
      { path: 'color.air.enabled', type: 'toggle', labelKey: 'adv.airExciter' },
      { path: 'color.air.amount', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', labelKey: 'adv.amount', dependsOn: 'color.air.enabled' },
    ],
  },
  {
    id: 'dynamics', labelKey: 'adv.dynamics',
    controls: [
      { path: 'multiband.enabled', type: 'toggle', labelKey: 'adv.multiband' },
      { path: 'multiband.bands.0.targetGrDb', type: 'range', min: 0, max: 4, step: 0.1, unit: 'dB', labelKey: 'adv.bandLow', dependsOn: 'multiband.enabled' },
      { path: 'multiband.bands.1.targetGrDb', type: 'range', min: 0, max: 4, step: 0.1, unit: 'dB', labelKey: 'adv.bandMid', dependsOn: 'multiband.enabled' },
      { path: 'multiband.bands.2.targetGrDb', type: 'range', min: 0, max: 4, step: 0.1, unit: 'dB', labelKey: 'adv.bandHigh', dependsOn: 'multiband.enabled' },
      { path: 'glue.enabled', type: 'toggle', labelKey: 'adv.glue' },
      { path: 'glue.targetGrDb', type: 'range', min: 0, max: 4, step: 0.1, unit: 'dB', labelKey: 'adv.glueAmount', dependsOn: 'glue.enabled' },
    ],
  },
  {
    id: 'stereo', labelKey: 'adv.stereo',
    controls: [
      { path: 'stereo.enabled', type: 'toggle', labelKey: 'adv.stereoOn' },
      { path: 'stereo.width', type: 'range', min: 0.5, max: 1.5, step: 0.01, unit: '%', labelKey: 'adv.width', dependsOn: 'stereo.enabled' },
      { path: 'stereo.monoBassHz', type: 'range', min: 0, max: 200, step: 5, unit: 'Hz', labelKey: 'adv.monoBass', dependsOn: 'stereo.enabled' },
    ],
  },
  {
    id: 'loudness', labelKey: 'adv.loudness',
    controls: [
      { path: 'loudness.targetLufs', type: 'range', min: -24, max: -6, step: 0.5, unit: 'LUFS', labelKey: 'adv.target' },
      { path: 'loudness.ceilingDb', type: 'range', min: -3, max: -0.3, step: 0.1, unit: 'dBTP', labelKey: 'adv.ceiling' },
      { path: 'loudness.clipper.enabled', type: 'toggle', labelKey: 'adv.clipper' },
      { path: 'loudness.clipper.amountDb', type: 'range', min: 0, max: 4, step: 0.1, unit: 'dB', labelKey: 'adv.clipAmount', dependsOn: 'loudness.clipper.enabled' },
      { path: 'loudness.limiter.releaseMs', type: 'range', min: 30, max: 300, step: 5, unit: 'ms', scale: 'log', labelKey: 'adv.release' },
    ],
  },
  {
    id: 'finish', labelKey: 'adv.finish',
    controls: [
      { path: 'trim.enabled', type: 'toggle', labelKey: 'adv.trim' },
      { path: 'finish.fadeInMs', type: 'range', min: 0, max: 5000, step: 5, unit: 'ms', labelKey: 'adv.fadeIn' },
      { path: 'finish.fadeOutMs', type: 'range', min: 0, max: 8000, step: 10, unit: 'ms', labelKey: 'adv.fadeOut' },
      { path: 'output.sampleRate', type: 'select', options: OUTPUT_SAMPLE_RATES, labelKey: 'adv.sampleRate' },
    ],
  },
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

/** Deep merge: objects merge recursively; arrays of objects merge index-wise; other values replace. */
export function mergeParams(base, overrides) {
  if (overrides === undefined) return clone(base);
  if (Array.isArray(base) && Array.isArray(overrides)) {
    const n = Math.max(base.length, overrides.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      // Holes / nulls in an override array mean "keep the base element" (sparse overrides
      // survive JSON round-trips, where holes become null).
      const o = overrides[i];
      if (o == null) out.push(clone(base[i]));
      else out.push(isObj(base[i]) && isObj(o) ? mergeParams(base[i], o) : clone(o));
    }
    return out;
  }
  if (!isObj(base) || !isObj(overrides)) return clone(overrides);
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    out[k] = overrides[k] !== undefined ? mergeParams(base[k], overrides[k]) : clone(base[k]);
  }
  return out;
}

/** Read a dotted path ('multiband.bands.0.ratio'). */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Immutable set of a dotted path → new object. */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const root = clone(obj) ?? {};
  let o = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
  return root;
}

/** Sparse override object containing only `path` = value (used for per-track manual tweaks). */
export function overrideFor(path, value) {
  return setPath({}, path, value);
}

const clampNum = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Clamp every numeric field into a safe range; fills missing fields from defaults. */
export function validateParams(p) {
  const d = defaultParams();
  const q = mergeParams(d, p || {});
  const sr = q.output.sampleRate;
  if (!(sr === 'source' || [44100, 48000, 88200, 96000].includes(sr))) q.output.sampleRate = 'source';
  q.prepare.highpassHz = clampNum(q.prepare.highpassHz, 0, 40, 25);
  q.prepare.highpassOrder = [1, 2, 4].includes(q.prepare.highpassOrder) ? q.prepare.highpassOrder : 4;
  q.trim.head = q.trim.head !== false;
  q.trim.tail = q.trim.tail !== false;
  q.spectral.deShimmer.amount = clampNum(q.spectral.deShimmer.amount, 0, 1, 0);
  q.spectral.deShimmer.startHz = clampNum(q.spectral.deShimmer.startHz, 1000, 16000, 5000);
  q.spectral.deShimmer.fullHz = clampNum(q.spectral.deShimmer.fullHz, q.spectral.deShimmer.startHz, 20000, 9000);
  q.spectral.denoise.amount = clampNum(q.spectral.denoise.amount, 0, 1, 0);
  q.spectral.denoise.fromHz = clampNum(q.spectral.denoise.fromHz, 0, 16000, 6000);
  q.eq.auto.strength = clampNum(q.eq.auto.strength, 0, 1, 0.6);
  q.eq.auto.maxDb = clampNum(q.eq.auto.maxDb, 0, 6, 3);
  q.eq.auto.toleranceDb = clampNum(q.eq.auto.toleranceDb, 0, 6, 1.5);
  q.eq.match.strength = clampNum(q.eq.match.strength, 0, 1, 0.5);
  q.eq.match.maxDb = clampNum(q.eq.match.maxDb, 0, 12, 4);
  if (q.eq.match.referenceLtas && q.eq.match.referenceLtas.length !== 31) q.eq.match.referenceLtas = null;
  if (!q.eq.match.referenceLtas) q.eq.match.enabled = false;
  const t = q.eq.tone;
  for (const k of ['lowShelfDb', 'boomDb', 'mudDb', 'presenceDb', 'airDb', 'highShelfDb', 'hashDb']) t[k] = clampNum(t[k], -12, 12, 0);
  t.highShelfHz = clampNum(t.highShelfHz, 500, 16000, 2000);
  t.tiltDbPerOct = clampNum(t.tiltDbPerOct, -3, 3, 0);
  for (const id of DYN_EQ_BAND_IDS) {
    const b = q.dynEq.bands[id] || (q.dynEq.bands[id] = clone(d.dynEq.bands[id]));
    b.maxCutDb = clampNum(b.maxCutDb, 0, 18, 0);
    b.ratio = clampNum(b.ratio, 1, 20, 2);
    b.freq = clampNum(b.freq, 40, 18000, d.dynEq.bands[id].freq);
    b.q = clampNum(b.q, 0.2, 10, 1);
    b.thresholdRelDb = clampNum(b.thresholdRelDb, -12, 24, 2);
    if (!['stereo', 'mid', 'side'].includes(b.channel)) b.channel = 'stereo';
    if (!['band', 'shelf'].includes(b.type)) b.type = 'band';
  }
  q.color.saturation.drive = clampNum(q.color.saturation.drive, 0, 1, 0);
  q.color.saturation.mix = clampNum(q.color.saturation.mix, 0, 1, 1);
  q.color.air.amount = clampNum(q.color.air.amount, 0, 1, 0);
  q.color.air.fromHz = clampNum(q.color.air.fromHz, 3000, 18000, 8000);
  q.multiband.crossovers = q.multiband.crossovers.map((f) => clampNum(f, 40, 16000, 1000)).sort((a, b) => a - b).slice(0, 3);
  while (q.multiband.bands.length < q.multiband.crossovers.length + 1) q.multiband.bands.push(clone(d.multiband.bands[1]));
  q.multiband.bands = q.multiband.bands.slice(0, q.multiband.crossovers.length + 1);
  q.multiband.bands.forEach((b, i) => {
    const db = d.multiband.bands[Math.min(i, d.multiband.bands.length - 1)];
    b.ratio = clampNum(b.ratio, 1, 20, 2);
    b.targetGrDb = clampNum(b.targetGrDb, 0, 12, 1);
    b.attackMs = clampNum(b.attackMs, 0.1, 200, 10);
    b.releaseMs = clampNum(b.releaseMs, 5, 2000, 100);
    b.kneeDb = clampNum(b.kneeDb, 0, 24, 6);
    b.rmsMs = clampNum(b.rmsMs, 1, 200, db.rmsMs);
    b.sidechainHpHz = clampNum(b.sidechainHpHz, 0, 2000, 0);
  });
  q.stereo.width = clampNum(q.stereo.width, 0, 2, 1);
  q.stereo.widthFromHz = clampNum(q.stereo.widthFromHz, 0, 8000, 1500);
  q.stereo.monoBassHz = clampNum(q.stereo.monoBassHz, 0, 300, 100);
  q.glue.ratio = clampNum(q.glue.ratio, 1, 20, 1.7);
  q.glue.targetGrDb = clampNum(q.glue.targetGrDb, 0, 12, 1);
  q.glue.attackMs = clampNum(q.glue.attackMs, 0.1, 200, 30);
  q.glue.releaseMs = clampNum(q.glue.releaseMs, 10, 2000, 150);
  q.glue.sidechainHpHz = clampNum(q.glue.sidechainHpHz, 0, 400, 130);
  q.glue.sidechainHpOrder = q.glue.sidechainHpOrder === 2 ? 2 : 4;
  q.loudness.targetLufs = clampNum(q.loudness.targetLufs, -30, -4, -14);
  q.loudness.ceilingDb = clampNum(q.loudness.ceilingDb, -6, 0, -1);
  q.loudness.budgetDb = clampNum(q.loudness.budgetDb, 0, 24, 4);
  q.loudness.maxGrDb = clampNum(q.loudness.maxGrDb, q.loudness.budgetDb, 24, 9);
  q.loudness.clipper.amountDb = clampNum(q.loudness.clipper.amountDb, 0, 4, 0.5);
  q.loudness.clipper.maxDepthDb = clampNum(q.loudness.clipper.maxDepthDb, Math.max(0.5, q.loudness.clipper.amountDb), 12, 3);
  q.loudness.minTargetLufs = Number.isFinite(q.loudness.minTargetLufs) ? clampNum(q.loudness.minTargetLufs, -30, q.loudness.targetLufs, q.loudness.targetLufs) : null;
  q.loudness.limiter.releaseMs = clampNum(q.loudness.limiter.releaseMs, 5, 2000, 80);
  q.loudness.limiter.lookaheadMs = clampNum(q.loudness.limiter.lookaheadMs, 0.5, 10, 3);
  q.finish.fadeInMs = clampNum(q.finish.fadeInMs, 0, 30000, 5);
  q.finish.fadeOutMs = clampNum(q.finish.fadeOutMs, 0, 60000, 30);
  if (q.meta !== undefined) {
    if (!isObj(q.meta)) delete q.meta;
    else if (q.meta.userOwned !== undefined) {
      // C1: dot paths whose values came from the user — unique strings, at most 200
      const uo = Array.isArray(q.meta.userOwned) ? q.meta.userOwned : [];
      q.meta.userOwned = [...new Set(uo.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 200))].slice(0, 200);
    }
  }
  return q;
}

/**
 * Whether a param path is user-owned (C1): it, one of its parents or one of its children
 * is listed in params.meta.userOwned. QC uses this to leave the user's own values alone.
 * @param {object} params
 * @param {string} path dot path, e.g. 'eq.tone.mudDb' or 'dynEq.bands.deEss'
 * @returns {boolean}
 */
export function isUserOwned(params, path) {
  const uo = params && params.meta && Array.isArray(params.meta.userOwned) ? params.meta.userOwned : null;
  if (!uo || !uo.length) return false;
  return uo.some((u) => u === path || u.startsWith(`${path}.`) || path.startsWith(`${u}.`));
}
