// i18n completeness (ARCHITECTURE.md §10) + the DOM-free UI helpers (formatting, param
// composition, waveform peaks, spectrum smoothing, meter lookups) and their speed on a
// 3:30 stereo 48 kHz signal.
import { assert, approx, timed } from './helpers.mjs';
import * as P from '../src/engine/params.js';
import { STRINGS, LANGUAGES, t, setLanguage, getLanguage, onLanguageChange, formatNumber, formatHz, formatTime } from '../src/ui/i18n.js';
import { formatUnit, snap, logToPos, posToLog, rateLabel } from '../src/ui/controls.js';
import {
  composeParams, applyProblemStep, problemAtCap, capProblemOffset, mp3RateFor, masterFileName, errorKey, errorVars, stageProgress,
  destinationLufs, exportRateFor, renderRateFor, saveOutcome, issueOutcome, shortcutAllowed,
} from '../src/ui/app.js';
import { summarize, peaksForWidth, niceTimeStep } from '../src/ui/waveform.js';
import { ISO_THIRD_OCTAVE, logFrequencies, makeBandMap, smoothSpectrum, freqToX } from '../src/ui/spectrum.js';
import { curveValueAt, liveFraction, platformGainText } from '../src/ui/meters.js';

const ISSUE_IDS = ['clipping', 'overs', 'tooLoud', 'tooQuiet', 'dcOffset', 'rumble', 'boomy', 'muddy', 'harsh', 'fizz', 'sibilant', 'shimmer', 'hiss', 'dull', 'brightened', 'codecCutoff', 'nearMono', 'phase', 'wideBass', 'abruptEnd', 'silence', 'overCompressed'];
const STAGES = ['decode', 'analyze', 'prepare', 'trim', 'spectral', 'eq', 'dyneq', 'color', 'multiband', 'stereo', 'glue', 'loudness', 'finish', 'verify', 'encode', 'zip'];
const PROFILES = ['legacy', 'midband', 'fullband', 'muffled', 'brightened'];
// §10 decision keys with their documented vars.
const DECISIONS = {
  highpass: ['hz'], deShimmer: ['pct', 'hz'], denoise: ['db', 'hz'], mud: ['db', 'hz'], boom: ['db', 'hz'], harsh: ['db', 'hz'],
  fizz: ['db', 'hz'], deEss: ['db', 'hz'], sideHf: ['db'], hash: ['db'], autoEq: ['db'], match: ['name', 'pct'], tone: ['style'],
  saturation: ['pct'], air: ['pct'], multiband: ['db'], monoBass: ['hz'], width: ['pct'], glue: ['db'],
  loudness: ['lufs', 'ceiling', 'dest'], fadeOut: ['sec'], trim: [], profile: ['profile'],
};
const WARNINGS = { targetUnreachable: ['lufs', 'gr'], heavyLimiting: ['gr'], inputClipped: [], lossySource: ['kbps'], longTrack: ['min'], qcRollback: ['module'], loudArtifacts: [], crushedInput: [] };
const ERRORS = ['unsupported', 'corrupt', 'tooLong', 'render', 'export', 'mp3Load'];

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function requireKeys(keys) {
  const missing = [];
  for (const lang of LANGUAGES) for (const k of keys) if (typeof STRINGS[lang][k] !== 'string' || !STRINGS[lang][k].trim()) missing.push(`${lang}:${k}`);
  assert(!missing.length, `missing keys: ${missing.join(', ')}`);
}

function withLang(lang, fn) {
  const prev = getLanguage();
  setLanguage(lang);
  try {
    return fn();
  } finally {
    setLanguage(prev);
  }
}

/** Deterministic test signal (no Math.random): stereo sum of two sines + LCG noise. */
function testSignal(seconds, sampleRate) {
  const n = Math.round(seconds * sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const noise = (s / 4294967296 - 0.5) * 0.1;
    L[i] = 0.5 * Math.sin(i * 0.013) + noise;
    R[i] = 0.4 * Math.sin(i * 0.021) - noise;
  }
  return [L, R];
}

export const tests = {
  'i18n: it and en have identical key sets': () => {
    const a = Object.keys(STRINGS.it).sort();
    const b = Object.keys(STRINGS.en).sort();
    const onlyIt = a.filter((k) => !(k in STRINGS.en));
    const onlyEn = b.filter((k) => !(k in STRINGS.it));
    assert(!onlyIt.length && !onlyEn.length, `only it: ${onlyIt.join(',')} · only en: ${onlyEn.join(',')}`);
    return `${a.length} keys`;
  },

  'i18n: no empty strings, same {placeholders} in both languages': () => {
    const bad = [];
    for (const k of Object.keys(STRINGS.it)) {
      if (!STRINGS.it[k].trim() || !STRINGS.en[k].trim()) bad.push(`${k} empty`);
      if (placeholders(STRINGS.it[k]).join() !== placeholders(STRINGS.en[k]).join()) bad.push(`${k} vars differ`);
    }
    assert(!bad.length, bad.join('; '));
  },

  'i18n: every ADVANCED_SECTIONS labelKey exists': () => {
    const keys = new Set();
    for (const sec of P.ADVANCED_SECTIONS) {
      keys.add(sec.labelKey);
      for (const c of sec.controls) keys.add(c.labelKey);
    }
    requireKeys([...keys]);
    return `${keys.size} labels`;
  },

  'i18n: §10 stages, issues (+hint), profiles': () => {
    requireKeys(STAGES.map((s) => `stage.${s}`));
    requireKeys(ISSUE_IDS.flatMap((id) => [`issue.${id}`, `issue.${id}.hint`]));
    requireKeys(PROFILES.map((p) => `profile.${p}`));
  },

  'i18n: §10 decisions carry exactly the documented vars': () => {
    const bad = [];
    for (const [id, vars] of Object.entries(DECISIONS)) {
      const key = `dec.${id}`;
      requireKeys([key]);
      for (const lang of LANGUAGES) {
        const got = placeholders(STRINGS[lang][key]);
        if (got.join() !== [...vars].sort().join()) bad.push(`${lang}:${key} has {${got}} expected {${vars}}`);
      }
    }
    assert(!bad.length, bad.join('; '));
  },

  'i18n: §10 warnings, notices, errors': () => {
    const bad = [];
    for (const [id, vars] of Object.entries(WARNINGS)) {
      const key = `warn.${id}`;
      requireKeys([key]);
      for (const lang of LANGUAGES) if (placeholders(STRINGS[lang][key]).join() !== [...vars].sort().join()) bad.push(`${lang}:${key}`);
    }
    assert(!bad.length, `vars mismatch: ${bad.join(', ')}`);
    requireKeys(['notice.aiPolicy', 'notice.sunoLicense']);
    requireKeys(ERRORS.map((e) => `err.${e}`));
  },

  'i18n: choice labels for every id in params.js': () => {
    requireKeys(P.DESTINATION_IDS.flatMap((id) => [`dest.${id}`, `dest.${id}.hint`]));
    requireKeys(P.STYLE_IDS.flatMap((id) => [`style.${id}`, `style.${id}.hint`]));
    requireKeys(Object.keys(P.INTENSITIES).map((k) => `intensity.${k}`));
    requireKeys(P.CLEANUP_IDS.flatMap((id) => [`cleanup.${id}`, `cleanup.${id}.hint`]));
    requireKeys(P.PROBLEM_IDS.map((id) => `problem.${id}`));
    requireKeys(P.PLATFORMS.map((p) => `platform.${p.id}`));
    // Export formats used by the UI.
    requireKeys(['wav24', 'wav16', 'mp3'].flatMap((f) => [`export.${f}`, `export.${f}.hint`]));
  },

  'i18n: copy avoids engineering jargon and watermark claims': () => {
    const banned = [/\bratio\b/i, /rapporto di compressione/i, /crossover/i, /oversampl/i, /sovracampion/i, /watermark/i, /filigrana/i, /lookahead/i];
    const hits = [];
    for (const lang of LANGUAGES) for (const [k, v] of Object.entries(STRINGS[lang])) for (const re of banned) if (re.test(v)) hits.push(`${lang}:${k}`);
    assert(!hits.length, hits.join(', '));
    // Spec phrasing the product relies on.
    assert(STRINGS.it['drop.title'] === 'Trascina qui il brano di Suno');
    assert(STRINGS.it['drop.demo'] === 'Prova con la demo');
    assert(STRINGS.it['ab.match'] === 'Volume pareggiato');
    assert(STRINGS.it['choice.cleanup'] === 'Pulisci artefatti AI');
    assert(STRINGS.it['export.all'] === 'Esporta tutti (ZIP)');
    assert(STRINGS.it['issues.fadeAdd'] === 'Aggiungi dissolvenza');
  },

  'i18n: {var} interpolation and number formatting': () => {
    withLang('it', () => {
      assert(t('dec.highpass', { hz: '25 Hz' }) === 'Filtrati i bassissimi inudibili sotto 25 Hz', t('dec.highpass', { hz: '25 Hz' }));
      assert(t('export.saved', { name: 'Brano (Master).wav' }) === 'Salvato: Brano (Master).wav');
      // Numbers: decimal comma, true minus sign, integers unchanged.
      assert(t('meters.grValue', { avg: -1.25, max: -3 }) === 'media −1,3 · max −3 dB', t('meters.grValue', { avg: -1.25, max: -3 }));
      // Missing vars stay visible; unknown keys fall back to the key itself.
      assert(t('dec.harsh', { hz: '3,4 kHz' }).includes('{db}'));
      assert(t('no.such.key') === 'no.such.key');
      assert(t('dec.trim') === STRINGS.it['dec.trim']);
      // Repeated placeholder / string vars with special replacement patterns.
      assert(t('err.file', { name: '$&', message: 'x' }) === '$&: x');
    });
    withLang('en', () => {
      assert(t('meters.grValue', { avg: -1.25, max: -3 }) === 'avg −1.3 · max −3 dB');
      assert(t('dec.match', { name: 'Ref', pct: '50%' }) === 'Moved the tone toward the reference “Ref” (50%)');
    });
  },

  'i18n: setLanguage / getLanguage / onLanguageChange': () => {
    const start = getLanguage();
    setLanguage('it');
    const seen = [];
    const off = onLanguageChange((l) => seen.push(l));
    setLanguage('en');
    setLanguage('en'); // no duplicate event
    setLanguage('it');
    setLanguage('xx'); // ignored
    off();
    setLanguage('en');
    assert(seen.join() === 'en,it', `events ${seen.join()}`);
    assert(getLanguage() === 'en');
    assert(t('ab.original') === 'Original');
    setLanguage(start);
  },

  // Italian-first. The browser locale no longer picks English; only the user's own
  // IT/EN choice (localStorage) does.
  'i18n: default language is Italian unless the user picked English': async () => {
    const saved = { ls: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), nav: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
    const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    try {
      define('localStorage', undefined);
      define('navigator', { language: 'it-IT' });
      let m = await import('../src/ui/i18n.js?nav-it');
      assert(m.getLanguage() === 'it', 'navigator it → it');
      define('navigator', { language: 'en-US' });
      m = await import('../src/ui/i18n.js?nav-en');
      assert(m.getLanguage() === 'it', 'English browser, nothing stored → it');
      define('localStorage', { getItem: () => 'en', setItem() {} });
      m = await import('../src/ui/i18n.js?ls-en');
      assert(m.getLanguage() === 'en', 'stored en wins');
      define('localStorage', { getItem: () => 'xx', setItem() {} });
      m = await import('../src/ui/i18n.js?ls-bad');
      assert(m.getLanguage() === 'it', 'unknown stored value → it');
      define('localStorage', {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      });
      m = await import('../src/ui/i18n.js?ls-throw');
      assert(m.getLanguage() === 'it', 'throwing storage falls back to Italian');
      m.setLanguage('en'); // must not throw
      assert(m.getLanguage() === 'en');
    } finally {
      for (const [name, d] of [['localStorage', saved.ls], ['navigator', saved.nav]]) {
        if (d) Object.defineProperty(globalThis, name, d);
        else delete globalThis[name];
      }
    }
  },

  'format: numbers, Hz, time, units': () => {
    withLang('it', () => {
      assert(formatNumber(-14) === '−14');
      assert(formatNumber(-0.04, 1) === '0,0', 'no negative zero');
      assert(formatNumber(1.5, 1, { sign: true }) === '+1,5');
      assert(formatNumber(NaN) === '—' && formatNumber(-Infinity) === '—');
      assert(formatHz(300) === '300 Hz' && formatHz(3400) === '3,4 kHz' && formatHz(16000) === '16 kHz', formatHz(3400));
      assert(formatTime(75.34, true) === '1:15,3' && formatTime(75.9) === '1:15' && formatTime(-3) === '0:00');
      assert(formatUnit(0.5, '%') === '50%');
      assert(formatUnit(-1.5, 'dB', { min: -6 }) === '−1,5 dB' && formatUnit(2.5, 'dB', { min: 0 }) === '2,5 dB');
      assert(formatUnit(2.5, 'dB', { min: -6 }) === '+2,5 dB');
      assert(formatUnit(2500, 'ms') === '2,5 s' && formatUnit(80, 'ms') === '80 ms');
      assert(formatUnit(0, 'Hz') === 'Spento' && formatUnit(120, 'Hz') === '120 Hz');
      assert(formatUnit(-14, 'LUFS') === '−14,0 LUFS' && formatUnit(-1, 'dBTP') === '−1,0 dBTP');
      assert(formatUnit(0.3, 'dB/oct') === '+0,30 dB/ott');
      assert(rateLabel('source') === 'Originale' && rateLabel(44100) === '44,1 kHz' && rateLabel(48000) === '48 kHz');
    });
    withLang('en', () => assert(formatHz(3400) === '3.4 kHz' && formatUnit(0.3, 'dB/oct') === '+0.30 dB/oct'));
  },

  'controls: snap and log slider mapping round-trip every ADVANCED log control': () => {
    approx(snap(0.1 + 0.2, 0, 1, 0.01), 0.3, 0, 'float noise removed');
    assert(snap(7, 0, 6, 0.5) === 6 && snap(NaN, 0, 6, 0.5) === 0);
    for (const sec of P.ADVANCED_SECTIONS) {
      for (const c of sec.controls) {
        if (c.scale !== 'log') continue;
        assert(logToPos(c.min, c.min, c.max) === 0 && logToPos(c.max, c.min, c.max) === 400, c.path);
        for (let pos = 0; pos <= 400; pos += 7) {
          const v = posToLog(pos, c.min, c.max, c.step);
          assert(v >= c.min && v <= c.max, `${c.path} ${v}`);
          // Monotonic and stable: mapping back lands within one step's worth of positions.
          const back = posToLog(logToPos(v, c.min, c.max), c.min, c.max, c.step);
          approx(back, v, c.step + 1e-9, c.path);
        }
      }
    }
  },

  'app: composeParams = suggestion ← overrides ← problem offsets ← output rate': () => {
    const base = P.defaultParams();
    base.eq.tone.airDb = 1;
    const out = composeParams(P, base, {
      overrides: { 'eq.tone.presenceDb': 2, 'multiband.bands.2.targetGrDb': 3, 'finish.fadeOutMs': 2500 },
      problemOffsets: { dull: 3, harsh: -1.5, unknown: 9 },
      sampleRate: 44100,
    });
    assert(out.eq.tone.airDb === 4, 'offset adds to suggestion');
    assert(out.eq.tone.presenceDb === 0.5, 'offset adds to the override');
    assert(out.multiband.bands[2].targetGrDb === 3 && out.multiband.bands[0].targetGrDb === base.multiband.bands[0].targetGrDb, 'sparse array override');
    assert(out.finish.fadeOutMs === 2500 && out.output.sampleRate === 44100);
    assert(base.eq.tone.presenceDb === 0 && base.output.sampleRate === 'source', 'input untouched');
    // validateParams clamps out-of-range manual values.
    const clamped = composeParams(P, base, { overrides: { 'loudness.ceilingDb': 3 } });
    assert(clamped.loudness.ceilingDb === 0);
  },

  'app: "sounds too…" steps are capped at ±capDb': () => {
    for (const id of P.PROBLEM_IDS) {
      const f = P.PROBLEM_FIXES[id];
      let v = 0;
      for (let i = 0; i < 10; i++) v = applyProblemStep(P, v, id);
      approx(Math.abs(v), f.capDb, 1e-9, id);
      assert(Math.sign(v) === Math.sign(f.stepDb), id);
      assert(problemAtCap(P, v, id) && !problemAtCap(P, 0, id), id);
    }
    assert(applyProblemStep(P, 0, 'nope') === 0);
  },

  'app: MP3 rates, file names, error keys, stage progress': () => {
    assert(mp3RateFor(44100) === 44100 && mp3RateFor(48000) === 48000 && mp3RateFor(32000) === 32000);
    assert(mp3RateFor(88200) === 44100 && mp3RateFor(22050) === 44100 && mp3RateFor(96000) === 48000);
    assert(masterFileName('Notte di luglio', 'wav') === 'Notte di luglio (Master).wav');
    assert(masterFileName('a/b:c?', 'mp3') === 'a b c (Master).mp3' && masterFileName('', 'wav') === 'AudioMaster (Master).wav');
    assert(errorKey({ code: 'unsupported' }) === 'err.unsupported' && errorKey({ code: 'too_long' }) === 'err.tooLong');
    assert(errorKey({ code: 'corrupt' }) === 'err.corrupt' && errorKey(new Error('lamejs failed')) === 'err.mp3Load');
    assert(errorKey(null, 'err.export') === 'err.export');
    // a missing codec is not a damaged file; the length cap is shown in minutes
    assert(errorKey({ code: 'unsupported', reason: 'codec', codecLabel: 'ALAC' }) === 'err.codec');
    assert(errorKey({ code: 'unsupported', reason: 'format' }) === 'err.unsupported');
    const v = errorVars({ code: 'too_long', maxDurationSec: 600 });
    assert(v.min === 10 && errorVars({ codecLabel: 'Opus' }).codec === 'Opus' && errorVars(null).min === 15);
    let prev = -1;
    for (const s of ['prepare', 'trim', 'spectral', 'eq', 'dyneq', 'color', 'multiband', 'stereo', 'glue', 'loudness', 'finish', 'verify']) {
      for (const f of [0, 0.5, 1]) {
        const p = stageProgress(s, f);
        assert(p >= prev - 1e-12 && p >= 0 && p <= 1, `${s} ${f}`);
        prev = p;
      }
    }
    approx(stageProgress('verify', 1), 1, 1e-12);
    assert(stageProgress('nope', 0.5) === null && stageProgress('eq', NaN) === stageProgress('eq', 0));
  },

  // Contract C1: the chain's QC must never soften what the user set, so composeParams
  // lists those paths in meta.userOwned (and keeps the assistant's own meta).
  'app: composeParams lists the user-owned paths in meta.userOwned (C1)': () => {
    const base = P.defaultParams();
    base.meta = { destination: 'streaming', style: 'warm' };
    const out = composeParams(P, base, {
      overrides: { 'loudness.targetLufs': -12, 'dynEq.bands.deEss.maxCutDb': 3 },
      problemOffsets: { muddy: -1.5, dull: 0 },
    });
    const owned = out.meta.userOwned;
    assert(Array.isArray(owned) && owned.length === 3, JSON.stringify(owned));
    for (const p of ['loudness.targetLufs', 'dynEq.bands.deEss.maxCutDb', 'eq.tone.mudDb']) assert(owned.includes(p), p);
    assert(!owned.includes('eq.tone.airDb'), 'a zero offset is not user-owned');
    assert(out.meta.destination === 'streaming' && out.meta.style === 'warm', 'assistant meta kept');
    const plain = composeParams(P, P.defaultParams(), {});
    assert(Array.isArray(plain.meta.userOwned) && plain.meta.userOwned.length === 0);
    // An override and a problem offset on the same path count once.
    const dup = composeParams(P, P.defaultParams(), { overrides: { 'eq.tone.mudDb': -1 }, problemOffsets: { muddy: -1.5 } });
    assert(dup.meta.userOwned.filter((p) => p === 'eq.tone.mudDb').length === 1);
  },

  // A click adds 1.5 dB on top of the assistant's own floor, and the NET value
  // is capped at 4.5 dB (the QC no longer halves user-owned tone values, so this is the only
  // limit); the button greys out exactly when another click would change nothing.
  'app: "sounds too…" caps the net correction (assistant floor + offset) at capDb': () => {
    const floor = -1.25; // real Suno ballad: assistant mud floor at 763 Hz
    let off = 0;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      off = applyProblemStep(P, off, 'muddy', floor);
      seen.push(off);
    }
    assert(seen.join() === '-1.5,-3,-3.25,-3.25', `offsets ${seen.join()}`);
    assert(!problemAtCap(P, -3, 'muddy', floor) && problemAtCap(P, -3.25, 'muddy', floor), 'greyed out at the net cap');
    const base = P.defaultParams();
    base.eq.tone.mudDb = floor;
    // Even a stored offset larger than the room left is applied up to the net cap only.
    const p = composeParams(P, base, { problemOffsets: { muddy: -4.5 } });
    approx(p.eq.tone.mudDb, -4.5, 1e-9, 'net mud = cap');
    // Net values always stay inside the Avanzate fader ranges.
    const ranges = Object.fromEntries(P.ADVANCED_SECTIONS.flatMap((s) => s.controls).filter((c) => c.type === 'range').map((c) => [c.path, c]));
    const strong = P.defaultParams();
    Object.assign(strong.eq.tone, { lowShelfDb: 1.5, mudDb: -2.25, boomDb: -1, presenceDb: -1.87, airDb: 1 });
    const all = composeParams(P, strong, { problemOffsets: { thin: 4.5, muddy: -4.5, boomy: -4.5, harsh: -4.5, dull: 4.5 } });
    for (const id of P.PROBLEM_IDS) {
      const { path, capDb } = P.PROBLEM_FIXES[id];
      const v = P.getPath(all, path);
      assert(Math.abs(v) <= capDb + 1e-9, `${id} net ${v}`);
      assert(v >= ranges[path].min && v <= ranges[path].max, `${id} ${v} outside the fader range`);
    }
    // A floor already past the cap is never undone, and the button is greyed from the start.
    assert(capProblemOffset(P, 'muddy', -1.5, -5) === 0 && problemAtCap(P, 0, 'muddy', -5));
    // A base in the opposite direction leaves the full 4.5 dB of travel.
    assert(capProblemOffset(P, 'thin', 6, -0.5) === 4.5);
    assert(capProblemOffset(P, 'nope', 3, 0) === 0 && capProblemOffset(P, 'dull', NaN, 0) === 0);
  },

  // Loud / Club targets move with intensity; the buttons must show that number.
  'app: destination targets follow the intensity (Loud / Club ranges)': () => {
    assert(destinationLufs(P, 'streaming', 0.9) === -14 && destinationLufs(P, 'hifi', 0.1) === -16);
    assert(destinationLufs(P, 'loud', 0.25) === -11 && destinationLufs(P, 'loud', 0.5) === -10 && destinationLufs(P, 'loud', 0.75) === -9);
    assert(destinationLufs(P, 'club', 0.25) === -9 && destinationLufs(P, 'club', 1) === -7 && destinationLufs(P, 'club', 0) === -9);
    assert(Number.isNaN(destinationLufs(P, 'nope', 0.5)) && destinationLufs(P, 'loud', NaN) === -10);
  },

  // The output rate is derived, never sticky; MP3 renders at an MP3 rate.
  'app: export sample rate is derived (WAV 16 → 44.1 kHz and back) and MP3-safe': () => {
    const r = (o) => exportRateFor(P, { format: 'wav24', destination: 'streaming', ...o });
    assert(r({}).rate === 'source' && r({}).why === 'source');
    assert(r({ format: 'wav16' }).rate === 44100 && r({ format: 'wav16' }).why === 'cd');
    assert(r({ format: 'wav16', allAt441: true }).rate === 'source', '44.1 kHz sources need no re-render');
    assert(r({ format: 'wav24' }).rate === 'source', 'leaving WAV 16 brings the source rate back');
    assert(r({ destination: 'club' }).rate === 44100 && r({ destination: 'club' }).why === 'dest');
    assert(r({ destination: 'video', format: 'wav16' }).rate === 44100, 'CD delivery wins over the video rate');
    assert(r({ manual: 48000, format: 'wav16' }).rate === 48000 && r({ manual: 'source', destination: 'club' }).why === 'manual');
    assert(renderRateFor('source', 'mp3', 96000) === 48000 && renderRateFor('source', 'mp3', 88200) === 44100);
    assert(renderRateFor('source', 'mp3', 48000) === 'source' && renderRateFor('source', 'mp3', 32000) === 'source');
    assert(renderRateFor('source', 'wav24', 96000) === 'source' && renderRateFor(44100, 'mp3', 96000) === 44100);
    assert(renderRateFor('source', 'mp3', NaN) === 'source');
  },

  // C4: "Salvato" only for 'saved'; every other status gets its own honest message.
  'app: every saveBlob status maps to an accurate message (C4)': () => {
    assert(saveOutcome({ status: 'saved', filename: 'a.zip' }).key === 'export.saved');
    assert(saveOutcome({ status: 'declined' }).key === 'export.declined');
    assert(saveOutcome({ status: 'busy' }).key === 'export.busy');
    assert(saveOutcome({ status: 'unavailable', code: 'rate_limited' }).key === 'export.busy', 'legacy busy code');
    const fmt = saveOutcome({ status: 'unavailable', code: 'format_not_accepted' });
    assert(fmt.key === 'export.formatRejected' && !fmt.disable, 'a refused format keeps the download on');
    assert(saveOutcome({ status: 'too_large' }).key === 'export.tooLarge');
    const un = saveOutcome({ status: 'unavailable', code: 'extension_not_enabled' });
    assert(un.key === 'export.unavailable' && un.disable === true && un.kind === 'error');
    for (const res of [null, undefined, {}, { status: 'weird' }]) assert(saveOutcome(res).key === 'err.export', JSON.stringify(res));
    for (const s of ['declined', 'busy', 'too_large', 'unavailable', null]) assert(saveOutcome({ status: s }).key !== 'export.saved');
    requireKeys(['export.saved', 'export.declined', 'export.busy', 'export.tooLarge', 'export.unavailable', 'err.export']);
  },

  // A diagnosis chip says "done" only when the master's decisions contain the fix.
  'app: diagnosis chips report what the master really did': () => {
    const dec = [{ key: 'dec.mud', vars: { db: -2, hz: 300 } }, { key: 'dec.trim', vars: {} }];
    const mud = issueOutcome('muddy', dec, 'medium');
    assert(mud.done && mud.decision.key === 'dec.mud');
    assert(issueOutcome('silence', dec, 'medium').done, 'auto-trimmed silence is done');
    assert(issueOutcome('silence', [], 'medium').key === 'issues.silenceKeep');
    assert(issueOutcome('boomy', [], 'off').key === 'issues.notFixedOff');
    assert(issueOutcome('boomy', [], 'light').key === 'issues.notFixed', 'below the detector gate');
    assert(issueOutcome('nearMono', [], 'off').key === 'issues.notFixed', 'not a cleanup issue');
    const air = { eq: { tone: { airDb: 1.5 } } };
    assert(issueOutcome('dull', [], 'medium', air).done && issueOutcome('dull', [], 'medium', air).key === 'issues.airTone');
    assert(issueOutcome('dull', [], 'medium').done === false);
    assert(issueOutcome('tooQuiet', [{ key: 'dec.loudness', vars: {} }], 'off').done, 'loudness always applied');
    assert(issueOutcome('clipping', [], 'off') === null && issueOutcome('abruptEnd', dec, 'medium') === null);
    requireKeys(['issues.notFixed', 'issues.notFixedOff', 'issues.silenceKeep', 'issues.airTone', 'issues.donePrefix', 'issues.fixedShort']);
    // The hints of the issues above describe the problem only (no fixed claim of a fix).
    for (const id of ['boomy', 'muddy', 'harsh', 'fizz', 'sibilant', 'shimmer', 'hiss', 'dull', 'codecCutoff', 'nearMono', 'wideBass', 'silence', 'rumble']) {
      assert(!/\b(viene|vengono|si può|puoi)\b/i.test(STRINGS.it[`issue.${id}.hint`]), `it issue.${id}.hint claims an action`);
      assert(!/\b(it is|they are|can be|you can)\b/i.test(STRINGS.en[`issue.${id}.hint`]), `en issue.${id}.hint claims an action`);
    }
  },

  // Space / B never steal the activation key of another control.
  'app: global shortcuts step aside on interactive controls': () => {
    // Minimal element fake: `matches` lists which selector groups the element (or an ancestor) matches.
    const el = (matches, extra = {}) => ({ closest: (sel) => (matches.some((m) => sel.includes(m)) ? {} : null), ...extra });
    assert(shortcutAllowed(null) && shortcutAllowed({}), 'no target / body');
    assert(shortcutAllowed(el([])), 'plain element');
    assert(shortcutAllowed(el(['#am-play', 'button'])), 'play button keeps Space');
    assert(shortcutAllowed(el(['#am-ab', '[role="radio"]'])), 'A/B switch keeps Space');
    assert(shortcutAllowed(el(['#am-wave', '[role="slider"]'])), 'waveform keeps Space');
    assert(!shortcutAllowed(el(['button'])), 'other buttons');
    assert(!shortcutAllowed(el(['[role="switch"]'])), 'switches');
    assert(!shortcutAllowed(el(['summary'])), 'Avanzate summary');
    assert(!shortcutAllowed(el(['input'])), 'range faders and text fields');
    assert(!shortcutAllowed(el([], { isContentEditable: true })), 'contenteditable');
  },

  // Wording consistency and honest status copy.
  'i18n: copy is consistent and status messages are honest': () => {
    for (const lang of LANGUAGES) {
      const s = STRINGS[lang];
      const cleanup = P.CLEANUP_IDS.map((id) => s[`cleanup.${id}`]);
      const intensity = Object.keys(P.INTENSITIES).map((k) => s[`intensity.${k}`]);
      const dests = P.DESTINATION_IDS.map((id) => s[`dest.${id}`]);
      for (const c of cleanup) assert(!intensity.includes(c) && !dests.includes(c), `${lang}: "${c}" used twice`);
      assert(s['meters.plr'] !== s['adv.dynamics'], `${lang}: meters.plr = adv.dynamics`);
      assert(/OGG/.test(s['drop.formats']), `${lang}: OGG missing from drop.formats`);
    }
    assert(!/abbiamo/i.test(STRINGS.it['issues.empty']) && !/\bwe\b/i.test(STRINGS.en['issues.empty']), 'one voice (first person singular)');
    assert(!/quasi pronto/i.test(STRINGS.it['export.waiting']) && !/almost ready/i.test(STRINGS.en['export.waiting']));
    assert(!/formato/i.test(STRINGS.it['err.export']) && !/format/i.test(STRINGS.en['err.export']), 'a failed save is not a format problem');
    assert(!/filtro dei bassissimi/.test(STRINGS.it['cleanup.off.hint']), 'cleanup off keeps the rest of the chain');
    requireKeys(['err.analyze', 'stage.mp3Load', 'export.rendering', 'status.ready', 'status.updated', 'decisions.updating', 'meters.updating']);
  },

  'waveform: peaks are exact, safe on silence, NaN and 10-sample inputs': () => {
    const L = Float32Array.from([0, 0.5, -0.25, 1, NaN, -1, 0.1, 0, 0, 0.3]);
    const R = Float32Array.from([0, -0.6, 0, 0, 0, 0, 0, 0.2, 0, 0]);
    const sum = summarize([L, R], 4);
    const f32 = Math.fround;
    assert(sum.min.length === 3 && sum.max[0] === 1 && sum.min[0] === f32(-0.6) && sum.min[1] === -1, JSON.stringify([...sum.min]));
    const p = peaksForWidth(sum, [L, R], 5);
    assert(p.columns === 5 && p.max[1] === 1 && p.min[0] === f32(-0.6), JSON.stringify([...p.max]));
    for (const v of [...p.min, ...p.max]) assert(Number.isFinite(v));
    // Wider than the sample count, zero width, empty audio, all-NaN.
    assert(peaksForWidth(sum, [L, R], 40).columns === 40, 'each sample spans 4 columns');
    assert(peaksForWidth(sum, [L, R], 0).columns === 0);
    const empty = summarize([new Float32Array(0), new Float32Array(0)]);
    assert(empty.length === 0 && peaksForWidth(empty, [new Float32Array(0)], 100).columns === 0);
    const nan = new Float32Array(600).fill(NaN);
    const pn = peaksForWidth(summarize([nan, nan]), [nan, nan], 3);
    assert([...pn.min, ...pn.max].every((v) => v === 0));
    // Shorter lane on a longer timeline ends early.
    assert(peaksForWidth(sum, [L, R], 20, 20).columns === 10);
    assert(niceTimeStep(210, 1000) === 30 && niceTimeStep(210, 2000) === 10 && niceTimeStep(10, 300) === 5);
  },

  'waveform: block summary equals direct min/max per column': () => {
    const ch = testSignal(4, 48000);
    const sum = summarize(ch);
    const w = 300;
    const p = peaksForWidth(sum, ch, w);
    const n = ch[0].length;
    for (const c of [0, 1, 150, 299]) {
      const s = Math.floor((c * n) / w);
      const e = Math.floor(((c + 1) * n) / w);
      let lo = Infinity;
      let hi = -Infinity;
      // Block-aligned superset of the column; the summary may include up to one block extra.
      for (let i = Math.floor(s / 256) * 256; i < Math.min(n, Math.ceil(e / 256) * 256); i++) {
        lo = Math.min(lo, ch[0][i], ch[1][i]);
        hi = Math.max(hi, ch[0][i], ch[1][i]);
      }
      approx(p.min[c], lo, 1e-7, `min col ${c}`);
      approx(p.max[c], hi, 1e-7, `max col ${c}`);
    }
  },

  'spectrum: 1/6-octave smoothing of a flat spectrum stays flat; mapping sane': () => {
    const fft = 8192;
    const sr = 48000;
    const freqs = logFrequencies(192);
    approx(freqs[0], 20, 1e-9);
    approx(freqs[191], 20000, 1e-6);
    const map = makeBandMap(freqs, fft, sr, 1 / 6);
    for (let i = 0; i < freqs.length; i++) assert(map.hi[i] >= map.lo[i] && map.lo[i] >= 0 && map.hi[i] <= fft / 2 - 1);
    const flat = new Float32Array(fft / 2).fill(-40);
    const out = smoothSpectrum(flat, map);
    for (const v of out) approx(v, -40, 1e-6, 'flat');
    // Silence (−Infinity from an AnalyserNode) must not produce NaN.
    const silent = smoothSpectrum(new Float32Array(fft / 2).fill(-Infinity), map);
    for (const v of silent) assert(v === -160);
    // A single tone shows up at its band and not two octaves away.
    const tone = new Float32Array(fft / 2).fill(-120);
    const bin = Math.round((1000 * fft) / sr);
    tone[bin] = -10;
    const st = smoothSpectrum(tone, map);
    const i1k = freqs.findIndex((f) => f >= 1000);
    const i4k = freqs.findIndex((f) => f >= 4000);
    assert(st[i1k] > st[i4k] + 40, `${st[i1k]} vs ${st[i4k]}`);
    assert(ISO_THIRD_OCTAVE.length === 31 && freqToX(20) === 0 && freqToX(20000) === 1 && Math.abs(freqToX(632.46) - 0.5) < 1e-3);
  },

  'meters: curve lookup, live bar scale, platform preview text': () => {
    const curve = Float32Array.from([-30, -20, -14, NaN]);
    assert(curveValueAt(curve, 0.1, 0) === -30 && curveValueAt(curve, 0.1, 0.16) === -14);
    assert(curveValueAt(curve, 0.1, 99) === null, 'NaN sample → null');
    assert(curveValueAt(null, 0.1, 1) === null && curveValueAt(curve, 0, 1) === null);
    assert(liveFraction(-36) === 0 && liveFraction(-3) === 1 && liveFraction(NaN) === 0 && liveFraction(0) === 1);
    withLang('it', () => {
      assert(platformGainText(-2).text === '−2,0 dB' && platformGainText(-2).kind === 'down');
      assert(platformGainText(0.01).text === 'invariato' && platformGainText(1.2).text === '+1,2 dB');
    });
    // Integration with params.js: a −16 LUFS / −1 dBTP Hi-Fi master on each platform.
    const g = Object.fromEntries(P.PLATFORMS.map((p) => [p.id, P.platformGainDb(p, -16, -1)]));
    assert(g.spotify === 0 && g.apple === 0 && g.youtube === 0 && g.deezer === 0, JSON.stringify(g));
    const loud = P.platformGainDb(P.PLATFORMS[0], -10, -2);
    assert(loud === -4);
  },

  'perf: UI helpers on a 3:30 stereo 48 kHz signal': async () => {
    const ch = testSignal(210, 48000);
    const [sum, tSum] = await timed(() => summarize(ch));
    let tPeaks = 0;
    for (const w of [2800, 1400, 780]) {
      const [p, ms] = await timed(() => peaksForWidth(sum, ch, w));
      assert(p.columns === w);
      tPeaks = Math.max(tPeaks, ms);
    }
    const map = makeBandMap(logFrequencies(192), 8192, 48000, 1 / 6);
    const bins = new Float32Array(4096).map((_, i) => -30 - i * 0.01);
    const scratch = new Float64Array(4096);
    const out = new Float32Array(192);
    const [, tSpec] = await timed(() => {
      for (let k = 0; k < 200; k++) smoothSpectrum(bins, map, out, scratch);
    });
    const suggested = P.defaultParams();
    const [, tCompose] = await timed(() => {
      for (let k = 0; k < 100; k++) composeParams(P, suggested, { overrides: { 'eq.tone.airDb': 1, 'finish.fadeOutMs': 2500 }, problemOffsets: { dull: 1.5 }, sampleRate: 'source' });
    });
    const [, tT] = await timed(() => {
      for (let k = 0; k < 20000; k++) t('dec.harsh', { db: 2.5, hz: '3,4 kHz' });
    });
    // Budgets: the summary runs once per decoded buffer (must stay far below the 2 s
    // analysis budget), peaks per resize/frame, spectrum per animation frame.
    assert(tSum < 400, `summarize ${tSum.toFixed(1)} ms`);
    assert(tPeaks < 16, `peaksForWidth ${tPeaks.toFixed(2)} ms`);
    assert(tSpec / 200 < 1, `smoothSpectrum ${(tSpec / 200).toFixed(3)} ms/frame`);
    assert(tCompose / 100 < 3, `composeParams ${(tCompose / 100).toFixed(3)} ms`);
    return `summarize ${tSum.toFixed(0)} ms · peaks ≤ ${tPeaks.toFixed(2)} ms · spectrum ${(tSpec / 200).toFixed(3)} ms/frame · composeParams ${(tCompose / 100).toFixed(3)} ms · t() ${((tT / 20000) * 1000).toFixed(2)} µs`;
  },
};
