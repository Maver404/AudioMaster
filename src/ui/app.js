// UI controller: state, wiring and rendering of the whole console.
// Flow (RESEARCH §5): drop file(s) or demo → decode → analyze → auto-master at once with
// the current choices; every change re-renders after a 350 ms debounce while playback
// continues (player.replaceMastered); superseded renders reject {code:'cancelled'} and
// stale results are ignored by a per-track sequence number.
// Every user action on the sound (destination, choices, "suona troppo", Avanzate, fade
// fix, reference, apply-to-all, cut edits) is one step of a global undo history
// (history.js): Annulla / Ripeti in the header, Ctrl/⌘+Z, Shift+Ctrl/⌘+Z, Ctrl+Y.
// Engine / IO modules are injected (createApp(root, deps)) so tests/ui-harness.js can
// drive the same UI with fakes. No alert()/confirm()/prompt(): they do not work in
// sandboxed embeds. localStorage only for language, theme, last choices, export options.
import { t, getLanguage, setLanguage, onLanguageChange, formatNumber, formatHz, formatTime } from './i18n.js';
import { h, clear, bindText, bindAttr, relabel, segmented, toggleSwitch, rangeSlider, selectBox, createRack, icon, rateLabel, formatUnit } from './controls.js';
import { Waveform } from './waveform.js';
import { Spectrum } from './spectrum.js';
import { createMeters, createPlatforms, curveValueAt } from './meters.js';
import { helpButton, advancedHelp, advancedHint, withHelp } from './help.js';
import { createCutBar, selectionToEdited, clipFileName, cleanName } from './cut.js';
import { createHistory, labelText, sameValue, undoKeyAllowed, historyKey, COALESCE_MS } from './history.js';
import { createSkinPicker } from './theme.js';
import { createMetaBox } from './metabox.js';
import { fullEdit, isFullEdit, editProblem, snapEdges, keepOnly, removeRange, applyEdit, sliceAudio, editedToSource, sourceToEdited } from '../audio/edit.js';

const DEBOUNCE_MS = 350;
const FADE_FIX_MS = 2500;
const LS_CHOICES = 'am.choices';
const LS_EXPORT = 'am.export';
const EXPORT_FORMATS = ['wav24', 'wav16', 'mp3'];
const MP3_RATES = [32000, 44100, 48000];
const MP3_TP_LIMIT = -0.1;
const LOUDNESS_PATHS = ['loudness.targetLufs', 'loudness.ceilingDb']; // overrides a destination change replaces
const ACCEPT = '.mp3,.wav,.wave,.m4a,.mp4,.aac,.flac,.ogg,.oga,.opus,audio/*';
const STAGE_WEIGHT = { prepare: 4, trim: 1, spectral: 28, eq: 4, dyneq: 10, color: 6, multiband: 14, stereo: 3, glue: 7, loudness: 16, finish: 1, verify: 6 };
const STAGE_ORDER = Object.keys(STAGE_WEIGHT);
const STAGE_TOTAL = STAGE_ORDER.reduce((s, k) => s + STAGE_WEIGHT[k], 0);

// --- Pure helpers (exported for tests) -------------------------------------------------

const MAX_USER_OWNED = 200;

/**
 * Final render params: assistant suggestion ← per-track sparse overrides ← "sounds too…"
 * offsets (added to the resulting tone value, see capProblemOffset) ← global output sample
 * rate, validated. meta.userOwned lists the paths the user set (overrides and problem
 * buttons), so the chain's QC rollback never softens them (ARCHITECTURE C1).
 * @param {object} P params.js exports
 * @param {object} suggested full Params from suggestParams()
 * @param {{ overrides?: Record<string, unknown>, problemOffsets?: Record<string, number>, sampleRate?: string|number }} [o]
 */
export function composeParams(P, suggested, { overrides = {}, problemOffsets = {}, sampleRate } = {}) {
  let p = P.mergeParams(suggested);
  const owned = new Set();
  for (const [path, v] of Object.entries(overrides)) {
    p = P.setPath(p, path, v);
    owned.add(path);
  }
  for (const [id, off] of Object.entries(problemOffsets)) {
    const fix = P.PROBLEM_FIXES[id];
    if (!fix || !off) continue;
    const base = Number(P.getPath(p, fix.path)) || 0;
    const eff = capProblemOffset(P, id, off, base);
    if (!eff) continue;
    p = P.setPath(p, fix.path, Math.round((base + eff) * 100) / 100);
    owned.add(fix.path);
  }
  if (sampleRate !== undefined) p = P.setPath(p, 'output.sampleRate', sampleRate);
  p = P.setPath(p, 'meta', { ...(p.meta && typeof p.meta === 'object' ? p.meta : {}), userOwned: [...owned].slice(0, MAX_USER_OWNED) });
  return P.validateParams ? P.validateParams(p) : p;
}

/**
 * "Sounds too…" offset as it is applied: the NET value at the fix path (the assistant's own
 * move `base` + the offset) stays within ±capDb in the fix direction, so a button never
 * stacks an extreme EQ on top of a floor the assistant already set (the QC no longer
 * softens user-owned values, so this is the only limit). The offset itself stays within
 * ±capDb; a base already past the cap is kept as it is (offset 0), never undone.
 * @param {object} P params.js exports
 * @param {string} id PROBLEM_IDS entry
 * @param {number} off requested offset (dB)
 * @param {number} [base] value at the fix path before the offset
 * @returns {number} offset to add, rounded to 0.01 dB
 */
export function capProblemOffset(P, id, off, base = 0) {
  const fix = P.PROBLEM_FIXES[id];
  if (!fix || !Number.isFinite(off) || !off) return 0;
  const dir = Math.sign(fix.stepDb);
  const b = Number.isFinite(base) ? base : 0;
  const room = Math.max(0, Math.min(fix.capDb, fix.capDb - dir * b));
  const along = dir * off;
  const capped = along > 0 ? Math.min(along, room) : Math.max(along, -fix.capDb);
  return Math.round(dir * capped * 100) / 100 || 0;
}

/** Next "sounds too…" offset after one click: += stepDb, net value capped (capProblemOffset). */
export function applyProblemStep(P, current, id, base = 0) {
  const fix = P.PROBLEM_FIXES[id];
  if (!fix) return current || 0;
  return capProblemOffset(P, id, (current || 0) + fix.stepDb, base);
}

/** Whether another click on a problem button would still change the sound (net value at the cap). */
export function problemAtCap(P, current, id, base = 0) {
  const fix = P.PROBLEM_FIXES[id];
  if (!fix) return false;
  return Math.abs(applyProblemStep(P, current, id, base) - capProblemOffset(P, id, current || 0, base)) < 1e-9;
}

/**
 * Loudness target of a destination at an intensity, for the destination buttons when no
 * analysis exists yet (Loud / Club span lufsRange from Low to High, RESEARCH §3).
 */
export function destinationLufs(P, id, intensity) {
  const d = P.DESTINATIONS[id];
  if (!d) return NaN;
  if (!d.lufsRange) return d.lufs;
  const t = Number.isFinite(intensity) ? intensity : 0.5;
  const u = Math.min(1, Math.max(0, (t - 0.25) / 0.5));
  return Math.round((d.lufsRange[0] + (d.lufsRange[1] - d.lufsRange[0]) * u) * 100) / 100;
}

/**
 * Output sample rate of the masters (output.sampleRate) and why, for the export panel:
 * the user's explicit choice, else 44.1 kHz for WAV 16-bit (CD delivery, RESEARCH §3),
 * else the destination's rate, else the source rate. Nothing is sticky: leaving WAV 16-bit
 * or changing destination brings the automatic rate back unless the user picked one.
 * @param {object} P params.js exports
 * @param {{ manual?: 'source'|number|null, format: string, destination: string, allAt441?: boolean }} o
 * @returns {{ rate: 'source'|number, why: 'manual'|'cd'|'dest'|'source' }}
 */
export function exportRateFor(P, { manual = null, format, destination, allAt441 = false }) {
  if (manual !== null && manual !== undefined) return { rate: manual, why: 'manual' };
  if (format === 'wav16') return { rate: allAt441 ? 'source' : 44100, why: 'cd' };
  const d = P.DESTINATIONS[destination];
  if (d && d.sampleRate) return { rate: d.sampleRate, why: 'dest' };
  return { rate: 'source', why: 'source' };
}

/**
 * Rate one track is rendered at. An MP3 needs 32 / 44.1 / 48 kHz, so for MP3 export a
 * track at any other rate is rendered at the nearest MP3 rate in the worker (no resampling
 * on the main thread at export time, and the meters measure the signal that is saved).
 */
export function renderRateFor(rate, format, sourceRate) {
  if (format !== 'mp3') return rate;
  const out = rate === 'source' ? sourceRate : rate;
  return !Number.isFinite(out) || MP3_RATES.includes(out) ? rate : mp3RateFor(out);
}

/**
 * saveBlob() result (export/save.js contract C4) → the toast to show. Only 'saved' says
 * "Salvato"; 'unavailable' also turns the download off for the rest of the session.
 * @returns {{ kind: 'good'|'info'|'error', key: string, disable?: boolean }}
 */
export function saveOutcome(res) {
  const status = res && res.status;
  const code = res && res.code;
  if (status === 'saved') return { kind: 'good', key: 'export.saved' };
  if (status === 'declined') return { kind: 'info', key: 'export.declined' };
  if (status === 'busy' || code === 'rate_limited') return { kind: 'info', key: 'export.busy' };
  if (status === 'too_large' || code === 'too_large') return { kind: 'error', key: 'export.tooLarge' };
  // This format only: another one may still save, so the download stays on.
  if (status === 'unavailable' && code === 'format_not_accepted') return { kind: 'error', key: 'export.formatRejected' };
  if (status === 'unavailable') return { kind: 'error', key: 'export.unavailable', disable: true };
  return { kind: 'error', key: 'err.export' };
}

// Diagnosis chip → the decision(s) that treat it in the master (assistant.describeDecisions).
const ISSUE_FIX = {
  tooLoud: ['dec.loudness'],
  tooQuiet: ['dec.loudness'],
  overs: ['dec.loudness'],
  rumble: ['dec.highpass'],
  boomy: ['dec.boom'],
  muddy: ['dec.mud'],
  harsh: ['dec.harsh'],
  fizz: ['dec.fizz'],
  sibilant: ['dec.deEss'],
  shimmer: ['dec.deShimmer'],
  hiss: ['dec.denoise'],
  dull: ['dec.air'],
  codecCutoff: ['dec.air'],
  nearMono: ['dec.width'],
  wideBass: ['dec.monoBass'],
  silence: ['dec.trim', 'dec.trimHead', 'dec.trimTail'],
};
const CLEANUP_ISSUES = new Set(['boomy', 'muddy', 'harsh', 'fizz', 'sibilant', 'shimmer', 'hiss']);

/**
 * What the current master does about a diagnosed issue, from its actual decisions (so a
 * chip never claims a fix that did not run, e.g. with cleanup 'off' or below a detector
 * gate). Null for issues whose hint already states what always happens (loudness, DC…).
 * @param {string} id issue id
 * @param {{ key: string, vars?: object }[]} decisions describeDecisions() of the master
 * @param {string} cleanup the track's cleanup choice
 * @param {object} [params] params of the master (an EQ air lift counts for dull/codecCutoff)
 * @returns {null | { done: true, decision?: object, key?: string, vars?: object } | { done: false, key: string }}
 */
export function issueOutcome(id, decisions, cleanup, params) {
  const keys = ISSUE_FIX[id];
  if (!keys) return null;
  const d = (decisions || []).find((x) => x && keys.includes(x.key));
  if (d) return { done: true, decision: d };
  const air = params && params.eq && params.eq.tone ? Number(params.eq.tone.airDb) : 0;
  if ((id === 'dull' || id === 'codecCutoff') && air > 0.05) return { done: true, key: 'issues.airTone', vars: { db: air } };
  if (id === 'silence') return { done: false, key: 'issues.silenceKeep' };
  if (cleanup === 'off' && CLEANUP_ISSUES.has(id)) return { done: false, key: 'issues.notFixedOff' };
  return { done: false, key: 'issues.notFixed' };
}

const SHORTCUT_KEEP = '#am-play, #am-wave, #am-ab';
const INTERACTIVE = 'button, summary, a[href], select, textarea, input, [contenteditable="true"], [role="button"], [role="switch"], [role="radio"], [role="checkbox"], [role="slider"], [role="tab"]';

/**
 * Whether the global shortcuts (Space = play/pause, B = A/B) may act while `el` has focus.
 * Space is the activation key of buttons, switches, radios and <summary>, so the shortcut
 * steps aside on every interactive control except the play button, the waveform and the
 * A/B switch, where play/pause is what the user expects (WCAG 2.1.1 / 2.1.4).
 */
export function shortcutAllowed(el) {
  if (!el || typeof el.closest !== 'function') return true;
  if (el.isContentEditable) return false;
  if (el.closest(SHORTCUT_KEEP)) return true;
  return !el.closest(INTERACTIVE);
}

/** MP3 needs 32 / 44.1 / 48 kHz: keep valid rates, else the closest family. */
export function mp3RateFor(sr) {
  if (MP3_RATES.includes(sr)) return sr;
  if (sr % 11025 === 0) return 44100;
  return 48000;
}

/** '<base> (Master).<ext>' with characters that break file systems removed. */
export function masterFileName(base, ext) {
  const clean = String(base || 'AudioMaster').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'AudioMaster';
  return `${clean} (Master).${ext}`;
}

/** Engine / decoder error → i18n key. */
export function errorKey(e, fallback = 'err.render') {
  const code = e && (e.code || e.name);
  // the file is fine but this browser has no decoder for its codec (decode.js reason)
  if (code === 'unsupported' && (e.reason === 'codec' || e.reason === 'browser')) return 'err.codec';
  if (code === 'unsupported' || code === 'NotSupportedError') return 'err.unsupported';
  if (code === 'corrupt' || code === 'EncodingError') return 'err.corrupt';
  if (code === 'too_long' || code === 'tooLong') return 'err.tooLong';
  if (code === 'mp3Load' || code === 'mp3_load' || /lame/i.test(String(e && e.message))) return 'err.mp3Load';
  return fallback;
}

/** Placeholder values for an errorKey() message ({codec} for err.codec, {min} for err.tooLong). */
export function errorVars(e) {
  const max = e && Number(e.maxDurationSec);
  return {
    codec: (e && (e.codecLabel || e.codec)) || 'audio',
    min: Number.isFinite(max) && max > 0 ? Math.round(max / 60) : 15,
  };
}

/** Progress 0..1 across the render stages from (stage, fraction-within-stage). */
export function stageProgress(stage, fraction) {
  const i = STAGE_ORDER.indexOf(stage);
  if (i < 0) return null;
  let before = 0;
  for (let k = 0; k < i; k++) before += STAGE_WEIGHT[STAGE_ORDER[k]];
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return (before + f * STAGE_WEIGHT[stage]) / STAGE_TOTAL;
}

function readStore(key) {
  try {
    const s = globalThis.localStorage?.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function writeStore(key, v) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: preferences just are not remembered */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Let the browser paint progress before a long synchronous step. rAF never fires in a
// hidden tab, so a timeout guarantees the promise still resolves there.
const nextFrame = () =>
  new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 80);
  });
const stripExt = (n) => String(n || '').replace(/\.[^.]+$/, '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// --- App -----------------------------------------------------------------------------

/**
 * Build the console into `root` and wire it to the injected modules.
 * @param {HTMLElement} root
 * @param {{ EngineClient: Function, decodeFile: Function, Player: Function, encodeWav: Function,
 *   encodeMp3: Function, makeZip: Function, saveBlob: Function, resampleAudio: Function,
 *   truePeakDb: Function, generateDemoTrack: Function, suggestParams: Function,
 *   describeDecisions: Function, params: object,
 *   probeSaveSupport?: () => Promise<'host'|'browser'|'none'>,
 *   readMetadata?: (file: File) => Promise<object> }} deps
 * @returns {{ loadFiles(files: FileList|File[]): Promise<void>, loadDemo(): Promise<void>,
 *   undo(): boolean, redo(): boolean, getHistory(): object, getState(): object, destroy(): void }}
 */
export function createApp(root, deps) {
  const P = deps.params;
  const mainDest = P.DESTINATION_IDS.filter((id) => P.DESTINATIONS[id] && P.DESTINATIONS[id].main);
  const moreDest = P.DESTINATION_IDS.filter((id) => !mainDest.includes(id));
  const def = P.defaultChoices();
  const stored = readStore(LS_CHOICES) || {};
  const storedExport = readStore(LS_EXPORT) || {};

  const state = {
    tracks: [],
    activeId: null,
    nextId: 1,
    destination: P.DESTINATION_IDS.includes(stored.destination) ? stored.destination : def.destination,
    choices: {
      style: P.STYLE_IDS.includes(stored.style) ? stored.style : def.style,
      intensity: finite(stored.intensity) ? Math.min(1, Math.max(0, stored.intensity)) : def.intensity,
      cleanup: P.CLEANUP_IDS.includes(stored.cleanup) ? stored.cleanup : def.cleanup,
      reference: null,
    },
    exportFormat: EXPORT_FORMATS.includes(storedExport.format) ? storedExport.format : 'wav24',
    exportMeta: storedExport.meta !== false, // copy the source's cover and tags into masters
    exportRate: 'source', // output.sampleRate of every master (exportRateFor)
    rateWhy: 'source',
    rateManual: null, // the user's explicit rate, null = automatic
    rateOpen: false,
    // 'host' | 'browser' | 'none' (deps.probeSaveSupport, contract C4); 'unknown' while probing.
    saveSupport: 'unknown',
    listen: 'master',
    loudMatch: true,
    showCurve: false,
    exporting: false,
    refBusy: false,
  };
  updateExportRate();

  // Undo / redo (history.js): snapshots of the undoable state, see snapshot() / applySnapshot().
  const history = createHistory();
  let pointerHeld = false; // a fader is being dragged: its inputs merge into one step until release
  let historyToast = null;

  let ready = false; // set once every view exists (player callbacks may fire early)
  let metaBox = null; // the "Metadati" panel (created after the rack, see below)
  let saveBlockedBySave = false; // a save answered 'unavailable': the download stays off
  let probeTimer = 0;
  let probeTries = 0;
  const PROBE_RETRY_MS = [3000, 10000, 30000];
  let destroyed = false;
  let defaultsCache = null;
  let openIssue = null;
  let liveRaf = 0;
  let lastText = 0;
  let lastAnnounce = 0;
  let engine = null;
  try {
    engine = new deps.EngineClient();
  } catch (e) {
    console.error('EngineClient failed', e);
  }
  const player = new deps.Player({
    onTime: () => {},
    onEnded: () => syncTransport(),
    onStateChange: () => syncTransport(),
  });
  let playerLoaded = { id: null, master: null, lead: 0 }; // lead: original time at master sample 0

  const ui = build();
  const waveform = new Waveform(ui.canvas, {
    onSeek: (sec) => {
      safe(() => player.seek(sec));
      updateLive(true);
    },
    onHover: (sec, x) => {
      if (sec === null) ui.hover.hidden = true;
      else {
        ui.hover.hidden = false;
        ui.hover.textContent = formatTime(sec, true);
        const w = ui.screen.clientWidth;
        ui.hover.style.left = `${Math.min(w - 56, Math.max(4, x + 8))}px`;
      }
    },
  });
  // Cut tool (cut.js): "Taglia" in the tape toolbar, the bar under the waveform, the
  // "Modificato" strip under the tape head. Closed by default: the simple view is unchanged.
  const cut = createCutBar({
    waveform,
    player,
    getTrack: () => active(),
    getFormat: () => state.exportFormat,
    canSave: () => {
      const tr = active();
      return !!(tr && tr.analysis && !tr.error && !state.exporting && state.saveSupport !== 'none');
    },
    isBusy: () => state.exporting,
    editState: () => {
      const tr = active();
      const len = (a) => (a ? a.channels[0].length / a.sampleRate : 0);
      return { edited: !!(tr && tr.edits), sec: len(tr && tr.audio), totalSec: len(tr && (tr.source || tr.audio)), busy: state.exporting };
    },
    editProblem: (kind, sel) => cutProblem(kind, sel),
    applyEdit: (kind, sel) => cutApply(kind, sel),
    resetEdit: () => cutReset(active()),
    focusUndo: () => focusUndo(),
    saveClip: (sel, o) => exportClip(sel, o),
  });
  ui.tapeHead.querySelector('.tape-tools').prepend(cut.toggle);
  ui.tapeHead.after(cut.strip);
  // The bar goes right under the waveform; on a phone (≤ 520 px) the open bar is taller
  // than the screen, so it follows the transport there instead, in the DOM too (reading
  // order = what is seen): Play, the time and Originale / Master stay right under the
  // waveform, e.g. to compare A and B while a selection loops.
  const phoneMql = safe(() => window.matchMedia('(max-width: 520px)'));
  const placeCut = () => {
    const phone = !!(phoneMql && phoneMql.matches);
    const focused = cut.bar.contains(document.activeElement) ? document.activeElement : null;
    if (phone) {
      if (ui.tape.lastElementChild !== cut.bar) ui.tape.append(cut.bar);
    } else if (ui.screen.nextElementSibling !== cut.bar) ui.screen.after(cut.bar);
    if (focused && focused !== document.activeElement) focused.focus({ preventScroll: true });
  };
  placeCut();
  if (phoneMql && phoneMql.addEventListener) phoneMql.addEventListener('change', placeCut);
  // Zoomed (cut mode) axis labels use the language's decimal mark, like the IN / OUT fields.
  const decimalMark = () => formatNumber(1.5, 1).charAt(1);
  waveform.setDecimal(decimalMark());
  const spectrum = new Spectrum(ui.specCanvas);
  const meters = createMeters(ui.metersBody, { help: (id) => helpButton(id) });
  const platforms = createPlatforms(ui.platformsBody, P);
  // The sample rate has a single home, the export panel: the rack drops its copy.
  const rackSections = P.ADVANCED_SECTIONS.map((s) => ({ ...s, controls: s.controls.filter((c) => c.path !== 'output.sampleRate') }));
  const rack = createRack(rackSections, {
    getValue: (path) => (path === 'output.sampleRate' ? state.exportRate : P.getPath(currentParams(), path)),
    isTruthy: (path) => {
      const v = P.getPath(currentParams(), path);
      return Array.isArray(v) ? v.length > 0 : !!v;
    },
    isModified: (id) => sectionModified(id),
    isPathModified: (path) => pathModified(path),
    onChange: (path, v) => onRackChange(path, v),
    onReset: (path) => onRackReset(path),
    onResetSection: (id) => onRackResetSection(id),
    extras: { eq: ui.refBlock },
    helpFor: (sec, ctl) => advancedHelp(sec, ctl, P.ADVANCED_SECTIONS),
  });
  ui.rackHost.append(rack.el);
  // Metadati (metabox.js): cover and tags of the active song, right under the export panel.
  metaBox = createMetaBox({
    help: (id) => helpButton(id, { P }),
    keep: state.exportMeta,
    onKeepChange: (on) => {
      state.exportMeta = on;
      writeStore(LS_EXPORT, { format: state.exportFormat, meta: on });
      metaBox.setKeep(on);
    },
  });
  ui.exportPanel.after(metaBox.el);

  // --- Track model -------------------------------------------------------------------

  function active() {
    return state.tracks.find((tr) => tr.id === state.activeId) || null;
  }

  function newTrack(name) {
    const tr = {
      id: `t${state.nextId++}`,
      name: stripExt(name) || name,
      fileName: name,
      info: null,
      meta: null, // readMetadata() result: tags, pictures (src/audio/metadata.js)
      metaState: 'none', // 'loading' while it is read, 'ready' once done
      audio: null, // what is mastered: the decoded song, or its edit (cut tool)
      source: null, // the decoded song, kept once the song is edited
      edits: null, // edit list of kept source frames (src/audio/edit.js); null = whole song
      analysis: null,
      phase: 'decoding',
      demo: false,
      choices: { ...state.choices },
      overrides: {},
      problemOffsets: {},
      result: null,
      resultKey: '',
      resultParams: null,
      decisions: [],
      renderSeq: 0,
      renderKey: '', // params key of the render in flight
      announced: false,
      rendering: false,
      stale: false,
      timer: 0,
      progress: 0,
      stage: '',
      error: null,
      mp3Adj: null,
      _sugKey: '',
      _sug: null,
    };
    state.tracks.push(tr);
    return tr;
  }

  function trackStatus(tr) {
    if (tr.error) return 'error';
    if (tr.phase) return tr.phase;
    if (tr.rendering) return 'rendering';
    if (tr.timer || tr.stale || !tr.result) return 'queued';
    return 'ready';
  }

  function choicesFor(tr) {
    return { destination: state.destination, style: tr.choices.style, intensity: tr.choices.intensity, cleanup: tr.choices.cleanup, ...(tr.choices.reference ? { reference: tr.choices.reference } : {}) };
  }

  function suggestedFor(tr) {
    const ch = choicesFor(tr);
    const key = JSON.stringify(ch);
    if (tr._sugKey !== key || !tr._sug) {
      tr._sug = deps.suggestParams(tr.analysis, ch);
      tr._sugKey = key;
    }
    return tr._sug;
  }

  function paramsFor(tr) {
    const sampleRate = renderRateFor(state.exportRate, state.exportFormat, tr.audio ? tr.audio.sampleRate : NaN);
    return composeParams(P, suggestedFor(tr), { overrides: tr.overrides, problemOffsets: tr.problemOffsets, sampleRate });
  }

  /** Value at a "sounds too…" path before the button's offset (assistant + any override). */
  function problemBase(tr, id) {
    const fix = P.PROBLEM_FIXES[id];
    if (!fix || !tr || !tr.analysis) return 0;
    if (Object.prototype.hasOwnProperty.call(tr.overrides, fix.path)) return Number(tr.overrides[fix.path]) || 0;
    return Number(safe(() => P.getPath(suggestedFor(tr), fix.path), 0)) || 0;
  }

  /** Recompute the output rate (exportRateFor); true when it changed. */
  function updateExportRate() {
    const withAudio = state.tracks.filter((x) => x.audio);
    const allAt441 = withAudio.length > 0 && withAudio.every((x) => x.audio.sampleRate === 44100);
    const r = exportRateFor(P, { manual: state.rateManual, format: state.exportFormat, destination: state.destination, allAt441 });
    const changed = String(r.rate) !== String(state.exportRate);
    state.exportRate = r.rate;
    state.rateWhy = r.why;
    return changed;
  }

  /** Re-render only the tracks whose params no longer match their master (format / rate changes). */
  function rescheduleChanged() {
    const a = active();
    let any = false;
    for (const tr of state.tracks) {
      if (!tr.analysis || (!tr.result && !tr.rendering)) continue;
      const key = safe(() => JSON.stringify(paramsFor(tr)), '');
      if (key === (tr.rendering ? tr.renderKey : tr.resultKey)) continue;
      any = true;
      if (tr === a) scheduleRender(tr);
      else tr.stale = true;
    }
    if (any) {
      renderTrackBar();
      setTimeout(pumpBackground, DEBOUNCE_MS + 20);
    }
    return any;
  }

  /** The master on screen no longer matches the settings (a re-render is pending or running). */
  function isStale(tr) {
    return !!(tr && tr.result && (tr.rendering || tr.timer || tr.stale));
  }

  function currentParams() {
    const tr = active();
    if (tr && tr.analysis) {
      try {
        return paramsFor(tr);
      } catch (e) {
        console.error(e);
      }
    }
    if (!defaultsCache) defaultsCache = P.defaultParams ? P.defaultParams() : P.validateParams ? P.validateParams({}) : {};
    const d = P.DESTINATIONS[state.destination] || {};
    let p = P.setPath(defaultsCache, 'loudness.targetLufs', d.lufs ?? -14);
    p = P.setPath(p, 'loudness.ceilingDb', d.ceilingDb ?? -1);
    return P.setPath(p, 'output.sampleRate', state.exportRate);
  }

  function targetFor(tr) {
    const p = tr && tr.analysis ? safe(() => paramsFor(tr)) : null;
    const d = P.DESTINATIONS[state.destination] || {};
    return {
      lufs: p ? p.loudness.targetLufs : d.lufs,
      ceiling: p ? p.loudness.ceilingDb : d.ceilingDb,
    };
  }

  function saveChoices() {
    writeStore(LS_CHOICES, { destination: state.destination, style: state.choices.style, intensity: state.choices.intensity, cleanup: state.choices.cleanup });
  }

  // --- Rendering pipeline ------------------------------------------------------------

  function scheduleRender(tr, delay = DEBOUNCE_MS) {
    if (!tr || !tr.analysis) return;
    tr.stale = true;
    clearTimeout(tr.timer);
    tr.timer = setTimeout(() => {
      tr.timer = 0;
      startRender(tr);
    }, delay);
    renderTrackBar();
    if (tr === active()) {
      renderExport();
      renderStale();
    }
  }

  /** Mark every track stale (destination / output rate are global); the active one renders first. */
  function scheduleAll(delay = DEBOUNCE_MS) {
    const a = active();
    for (const tr of state.tracks) {
      if (!tr.analysis) continue;
      if (tr === a) scheduleRender(tr, delay);
      else tr.stale = true;
    }
    renderTrackBar();
    setTimeout(pumpBackground, delay + 20);
  }

  function pumpBackground() {
    if (state.exporting) return;
    if (state.tracks.some((tr) => tr.rendering)) return;
    const a = active();
    if (a && a.analysis && !a.timer && (a.stale || !a.result) && !a.error) {
      startRender(a);
      return;
    }
    if (a && a.timer) return;
    const next = state.tracks.find((tr) => tr !== a && tr.analysis && !tr.timer && (tr.stale || !tr.result) && !tr.error);
    if (next) startRender(next);
  }

  /**
   * Render `tr` with its current params, or with `opts.params` (the export snapshot, so a
   * settings change during a ZIP export cannot mix targets inside one album).
   */
  async function startRender(tr, { force = false, params: fixed = null } = {}) {
    if (!tr.analysis || !state.tracks.includes(tr)) return;
    clearTimeout(tr.timer);
    tr.timer = 0;
    if (!engine) {
      tr.error = 'err.render';
      renderAll();
      return;
    }
    if (state.exporting && !force) {
      tr.stale = true;
      return;
    }
    let params = fixed;
    if (!params) {
      try {
        params = paramsFor(tr);
      } catch (e) {
        console.error('suggestParams failed', e);
        fail(tr, 'err.render');
        return;
      }
    }
    const key = JSON.stringify(params);
    tr.error = null;
    tr.stale = false;
    if (tr.result && tr.resultKey === key) {
      // Back to the settings of the master we already have: drop any in-flight render, and
      // tell the worker, which would otherwise keep computing it for seconds.
      if (tr.rendering && engine.cancelRender) safe(() => engine.cancelRender(tr.id));
      tr.renderSeq++;
      tr.rendering = false;
      tr.renderKey = '';
      if (tr === active()) renderAll();
      else renderTrackBar();
      pumpBackground();
      return;
    }
    if (tr.rendering && tr.renderKey === key) return; // the same render is already running
    const seq = ++tr.renderSeq;
    tr.rendering = true;
    tr.renderKey = key;
    tr.progress = 0;
    tr.stage = 'prepare';
    renderTrackBar();
    if (tr === active()) {
      renderProgress();
      renderExport();
      renderStale();
    }
    try {
      const res = await engine.render(tr.id, params, (stage, fraction) => onRenderProgress(tr, seq, stage, fraction));
      if (seq !== tr.renderSeq || !state.tracks.includes(tr)) return;
      tr.rendering = false;
      tr.renderKey = '';
      tr.result = res;
      tr.resultKey = key;
      tr.resultParams = (res.report && res.report.paramsUsed) || params;
      tr.mp3Adj = null;
      tr.decisions = computeDecisions(tr);
      if (tr === active()) applyResultToPlayer(tr);
      renderAll();
      if (tr === active() && !tr.timer && !tr.stale) announce(t(tr.announced ? 'status.updated' : 'status.ready', { name: tr.name }));
      tr.announced = true;
    } catch (e) {
      if (seq !== tr.renderSeq) return;
      tr.rendering = false;
      if (e && e.code === 'cancelled') {
        renderTrackBar();
        return;
      }
      console.error('render failed', e);
      fail(tr, 'err.render');
    } finally {
      if (seq === tr.renderSeq) {
        tr.rendering = false;
        tr.renderKey = '';
      }
      setTimeout(pumpBackground, 0);
    }
  }

  function fail(tr, key) {
    tr.error = key;
    tr.rendering = false;
    renderAll();
    toast(state.tracks.length > 1 ? t('err.file', { name: tr.name, message: t(key) }) : t(key), 'error');
  }

  function onRenderProgress(tr, seq, stage, fraction) {
    if (seq !== tr.renderSeq) return;
    const s = String(stage || '').replace(/^stage\./, '');
    const p = stageProgress(s, fraction);
    tr.stage = s;
    if (p !== null) tr.progress = Math.max(tr.progress, p);
    else if (finite(fraction)) tr.progress = Math.max(tr.progress, Math.min(1, fraction));
    if (tr === active()) renderProgress();
  }

  function computeDecisions(tr) {
    if (!deps.describeDecisions || !tr.analysis || !tr.result) return [];
    try {
      return deps.describeDecisions(tr.analysis, tr.resultParams) || [];
    } catch (e) {
      console.error('describeDecisions failed', e);
      return [];
    }
  }

  /** Wait until `tr` has a master rendered with exactly `params` (the export snapshot). */
  async function ensureRendered(tr, params) {
    const key = JSON.stringify(params);
    if (!(tr.result && tr.resultKey === key)) startRender(tr, { force: true, params });
    while (tr.rendering) {
      await sleep(80);
      if (!state.tracks.includes(tr)) throw Object.assign(new Error('removed'), { code: 'removed' });
    }
    if (!tr.result || tr.resultKey !== key) throw Object.assign(new Error('render failed'), { code: 'render' });
  }

  /** Polite screen-reader announcement (completion of the active master only). */
  function announce(text) {
    const now = Date.now();
    if (!ui.status || now - lastAnnounce < 800) return;
    lastAnnounce = now;
    // Clear first so the same sentence is announced again on the next update.
    ui.status.textContent = '';
    setTimeout(() => {
      ui.status.textContent = text;
    }, 60);
  }

  // --- Loading ------------------------------------------------------------------------

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    // The user's first song takes over the screen from the demo (otherwise "Scarica il
    // master" would still save the demo); with several files only the first one does.
    const a = active();
    const takeOver = !a || a.demo;
    for (let i = 0; i < files.length; i++) await addFromFile(files[i], { activate: takeOver && i === 0 });
  }

  async function addFromFile(file, { activate = false } = {}) {
    const tr = newTrack(file.name || 'audio');
    if (activate || !active()) setActive(tr, { silent: true });
    readMeta(tr, file);
    renderAll();
    try {
      const { audio, info } = await deps.decodeFile(file);
      if (!state.tracks.includes(tr)) return;
      tr.audio = audio;
      tr.info = info || null;
      tr.name = (info && info.baseName) || tr.name;
      // WAV 16-bit keeps 'source' only while every song is already at 44.1 kHz.
      if (updateExportRate()) {
        renderExport();
        scheduleAll();
      }
    } catch (e) {
      console.error('decode failed', e);
      const key = errorKey(e, 'err.corrupt');
      removeTrack(tr, { quiet: true });
      toast(t('err.file', { name: file.name || '?', message: t(key, errorVars(e)) }), 'error');
      return;
    }
    await analyze(tr);
  }

  /** Tags and cover, read next to the decode (only the tag regions, a few small reads). */
  function readMeta(tr, file) {
    if (typeof deps.readMetadata !== 'function') return;
    tr.metaState = 'loading';
    tr.metaPromise = Promise.resolve()
      .then(() => deps.readMetadata(file))
      .catch((e) => {
        console.warn('metadata read failed', e);
        return null;
      })
      .then((meta) => {
        tr.meta = meta || null;
        tr.metaState = 'ready';
        if (ready && state.tracks.includes(tr) && tr === active()) renderMeta();
      });
  }

  /**
   * What the exporters get as `metadata` for `tr` (null = an untagged master). `keep` is the
   * switch as it was when the export started; a read still running is waited for.
   */
  async function exportMetaFor(tr, keep, report) {
    if (!keep || !tr || tr.demo) return null;
    if (tr.metaState === 'loading' && tr.metaPromise) {
      if (report) report('meta.loading', 0.25);
      await tr.metaPromise;
      // A song removed meanwhile is not saved, as during the render wait (ensureRendered).
      if (!state.tracks.includes(tr)) throw Object.assign(new Error('removed'), { code: 'removed' });
    }
    return tr.meta || null;
  }

  async function loadDemo() {
    const tr = newTrack(t('demo.name'));
    tr.demo = true;
    setActive(tr, { silent: true });
    renderAll();
    await nextFrame();
    try {
      const audio = await deps.generateDemoTrack({ sampleRate: 48000, seconds: 32, seed: 7 });
      if (!state.tracks.includes(tr)) return;
      tr.audio = audio;
      tr.name = t('demo.name');
      tr.info = {
        name: `${t('demo.name')}.wav`,
        baseName: t('demo.name'), // the chip and the downloaded file carry the same name
        ext: 'wav',
        format: 'wav',
        codec: 'pcm',
        sampleRate: audio.sampleRate,
        nativeSampleRate: audio.sampleRate,
        decodedChannels: 2,
        bitDepth: 24,
        bitrateKbps: null,
        duration: audio.channels[0].length / audio.sampleRate,
        sizeBytes: 0,
        demo: true,
      };
    } catch (e) {
      console.error('demo failed', e);
      removeTrack(tr, { quiet: true });
      toast(t('err.render'), 'error');
      return;
    }
    await analyze(tr);
  }

  async function analyze(tr) {
    tr.phase = 'analyzing';
    if (tr === active()) loadPlayer(tr);
    renderAll();
    const audio = tr.audio; // a cut-tool edit while this runs makes this analysis stale
    try {
      if (!engine) throw new Error('no engine');
      // Decode info lets the engine flag a lossy source (warn.lossySource, contract C3).
      // Loading the same id again replaces the engine's copy (fresh render caches).
      await engine.loadTrack(tr.id, tr.audio, tr.info || null);
      const analysis = await engine.analyze(tr.id);
      if (!state.tracks.includes(tr) || tr.audio !== audio) return;
      tr.analysis = analysis;
      tr.phase = null;
    } catch (e) {
      if (tr.audio !== audio) return;
      console.error('analysis failed', e);
      tr.phase = null;
      // Changing a setting cannot retry an analysis (renders need one): say what helps.
      fail(tr, errorKey(e, 'err.analyze'));
      return;
    }
    renderAll();
    if (tr === active()) startRender(tr);
    else {
      tr.stale = true;
      pumpBackground();
    }
  }

  function setActive(tr, { silent = false } = {}) {
    if (state.activeId === tr.id) return;
    state.activeId = tr.id;
    state.choices = { ...tr.choices };
    safe(() => player.pause());
    loadPlayer(tr);
    if (!silent) renderAll();
    if (tr.analysis && !tr.rendering && !tr.timer && (tr.stale || !tr.result) && !tr.error) startRender(tr);
  }

  function removeTrack(tr, { quiet = false } = {}) {
    clearTimeout(tr.timer);
    tr.timer = 0;
    tr.renderSeq++;
    tr.rendering = false;
    safe(() => engine && engine.unload(tr.id));
    const wasActive = state.activeId === tr.id;
    state.tracks = state.tracks.filter((x) => x !== tr);
    // Its steps go, and its part of every other step (a step left changing nothing goes too).
    history.prune({ drop: (st) => st.trackId === tr.id, map: (snap) => ({ ...snap, tracks: snap.tracks.filter((x) => x.id !== tr.id) }) });
    renderHistory();
    if (updateExportRate()) scheduleAll();
    if (wasActive) {
      state.activeId = null;
      const next = state.tracks[state.tracks.length - 1];
      if (next) setActive(next, { silent: true });
      else {
        safe(() => player.pause());
        loadPlayer(null);
      }
    }
    if (!quiet || wasActive) renderAll();
    else renderTrackBar();
    setTimeout(pumpBackground, 0);
  }

  // --- Player -------------------------------------------------------------------------

  /** What the player and the waveform get as the master: the source-rate preview when the
   * engine made one (export rate ≠ source rate, contract C2), else the master itself. */
  function playbackMaster(tr) {
    const r = tr && tr.result;
    return r ? r.preview || r.audio || null : null;
  }

  /** Original time (s) at master sample 0: the head cut by trim (report.trim, C2/C5). */
  function masterLead(tr) {
    const trim = tr && tr.result && tr.result.report ? tr.result.report.trim : null;
    if (!trim || !trim.trimmed) return 0;
    const sec = finite(trim.startSec) ? trim.startSec : trim.startSample / trim.sampleRate;
    return finite(sec) && sec > 0 ? sec : 0;
  }

  function loadPlayer(tr) {
    if (!tr || !tr.audio) {
      safe(() => player.setTracks(null, null));
      playerLoaded = { id: null, master: null, lead: 0 };
    } else {
      const m = playbackMaster(tr);
      const lead = m ? masterLead(tr) : 0;
      safe(() => player.setTracks(tr.audio, m, { originalOffsetSec: lead }));
      playerLoaded = { id: tr.id, master: m, lead };
    }
    applyListen();
    applyLoudMatch();
    syncTransport();
  }

  function applyResultToPlayer(tr) {
    const m = playbackMaster(tr);
    const lead = masterLead(tr);
    // replaceMastered keeps playing; a new lead (trim changed) restarts at the same musical time
    if (playerLoaded.id === tr.id && playerLoaded.master) safe(() => player.replaceMastered(m, { originalOffsetSec: lead }));
    else safe(() => player.setTracks(tr.audio, m, { originalOffsetSec: lead }));
    playerLoaded = { id: tr.id, master: m, lead };
    applyListen();
    applyLoudMatch();
  }

  function effectiveSource() {
    return state.listen === 'master' && playerLoaded.master ? 'master' : 'original';
  }

  function applyListen() {
    if (!ready) return;
    const src = effectiveSource();
    safe(() => player.setSource(src));
    waveform.setActive(src);
    spectrum.setLive(safe(() => player.analyser), src);
    ui.abSeg.setValue(src);
    ui.abSeg.setOptionDisabled('master', !playerLoaded.master);
    ui.screen.dataset.listen = src;
  }

  function applyLoudMatch() {
    const tr = active();
    const lo = tr && tr.analysis ? tr.analysis.loudness.integrated : NaN;
    const lm = tr && tr.result && tr.result.report && tr.result.report.loudness ? tr.result.report.loudness.integrated : NaN;
    if (finite(lo) && finite(lm)) safe(() => player.setLoudnessMatch(state.loudMatch, lo, lm));
    else safe(() => player.setLoudnessMatch(false, lo, lm));
  }

  function setListen(src) {
    state.listen = src === 'original' ? 'original' : 'master';
    applyListen();
    renderSpectrum();
    updateLive(true);
  }

  function toggleAB() {
    if (!playerLoaded.master) return;
    setListen(effectiveSource() === 'master' ? 'original' : 'master');
  }

  async function togglePlay() {
    const tr = active();
    if (!tr || !tr.audio) return;
    try {
      if (safe(() => player.playing, false)) player.pause();
      else await player.play();
    } catch (e) {
      console.error('playback failed', e);
    }
    spectrum.setLive(safe(() => player.analyser), effectiveSource());
    syncTransport();
  }

  function syncTransport() {
    if (!ready) return;
    const tr = active();
    const playing = !!safe(() => player.playing, false);
    const has = !!(tr && tr.audio);
    ui.playBtn.disabled = !has;
    clear(ui.playBtn).append(icon(playing ? 'pause' : 'play'));
    bindAttr(ui.playBtn, 'aria-label', playing ? 'transport.pause' : 'transport.play');
    ui.playBtn.classList.toggle('is-playing', playing);
    ui.abSeg.setDisabled(!has);
    if (has) ui.abSeg.setOptionDisabled('master', !playerLoaded.master);
    ui.matchSw.setDisabled(!has);
    // The player's timeline: the master's once it exists (trim shortens it), else the original's.
    const pd = has && playerLoaded.id === tr.id ? safe(() => player.duration, NaN) : NaN;
    const dur = has ? (finite(pd) && pd > 0 ? pd : tr.audio.channels[0].length / tr.audio.sampleRate) : 0;
    ui.timeDur.textContent = formatTime(dur);
    ui.canvas.setAttribute('aria-valuemax', String(Math.round(dur)));
    spectrum.setLive(safe(() => player.analyser), effectiveSource());
    spectrum.setRunning(playing);
    if (playing && !liveRaf) {
      const tick = () => {
        liveRaf = requestAnimationFrame(tick);
        updateLive(false);
      };
      liveRaf = requestAnimationFrame(tick);
    } else if (!playing && liveRaf) {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
    }
    updateLive(true);
    cut.refresh(); // "Ascolta selezione" / "Ferma" follows the player
  }

  function updateLive(force) {
    if (!ready) return;
    const tr = active();
    const tm = (tr && tr.audio && safe(() => player.currentTime, 0)) || 0;
    waveform.setTime(tm);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - lastText < 90) return;
    lastText = now;
    ui.timeCur.textContent = formatTime(tm, true);
    ui.canvas.setAttribute('aria-valuenow', String(Math.round(tm)));
    ui.canvas.setAttribute('aria-valuetext', t('wave.at', { time: formatTime(tm) }));
    const a = tr && tr.analysis ? tr.analysis.loudness : null;
    const m = tr && tr.result && tr.result.report ? tr.result.report.loudness : null;
    const playing = !!safe(() => player.playing, false);
    // tm is master time; the original's curve is on the original's own (untrimmed) timeline.
    const lead = playerLoaded.master ? playerLoaded.lead : 0;
    meters.setLive({
      orig: a && (playing || tm > 0) ? curveValueAt(a.curve, a.curveHopSec, tm + lead) : null,
      master: m && (playing || tm > 0) ? curveValueAt(m.curve, m.curveHopSec, tm) : null,
      active: effectiveSource(),
    });
  }

  // --- Undo / redo (history.js) ---------------------------------------------------------

  /**
   * The undoable state: destination, global choices and, per song, its choices (reference
   * included: its LTAS travels with the snapshot, it is never decoded again), Avanzate
   * overrides, "suona troppo" offsets and cut edits. Copies of the mutable maps; edit lists
   * and reference objects are immutable and shared.
   */
  function snapshot() {
    return {
      destination: state.destination,
      choices: { ...state.choices },
      tracks: state.tracks.map((tr) => ({ id: tr.id, choices: { ...tr.choices }, overrides: { ...tr.overrides }, problemOffsets: { ...tr.problemOffsets }, edits: tr.edits })),
    };
  }

  /**
   * Run `fn` (a user action on the undoable state) and record it as one history step.
   * `coalesce`: actions with this key merge while they follow each other (a fader drag is
   * one step: no time limit while the pointer is down, COALESCE_MS between keyboard steps);
   * `force` also merges into a sealed step (double-click reset after the two clicks).
   * @returns {object|null} the recorded step, null when nothing changed
   */
  function act(label, fn, { track = null, coalesce = null, force = false } = {}) {
    const before = snapshot();
    fn();
    const res = history.record({ label, trackId: track ? track.id : null, before, after: snapshot() }, { key: coalesce, now: Date.now(), windowMs: pointerHeld ? Infinity : COALESCE_MS, force });
    renderHistory();
    return res === 'added' || res === 'merged' ? history.peekUndo() : null;
  }

  /** Whether a step changes a song's edit (it cannot run during a save: cutProblem 'busy'). */
  function touchesEdits(step) {
    const was = new Map(step.before.tracks.map((x) => [x.id, x.edits]));
    return step.after.tracks.some((x) => was.has(x.id) && !sameValue(was.get(x.id), x.edits));
  }

  const stepBlocked = (step) => state.exporting && touchesEdits(step);

  /**
   * Make `snap` the state again, touching only what differs: params of a song re-render
   * through the usual scheduler (requeue), a different edit goes through setTrackEdit like
   * a cut, a different destination re-masters every song. `lead`: the song that will be on
   * screen (travel switches to it right after), scheduled like the active one.
   */
  function applySnapshot(snap, { lead = null } = {}) {
    const destChanged = snap.destination !== state.destination && !!P.DESTINATIONS[snap.destination];
    if (destChanged) state.destination = snap.destination;
    const a = active();
    const rerender = [];
    for (const s of snap.tracks) {
      const tr = state.tracks.find((x) => x.id === s.id);
      if (!tr) continue;
      let params = false;
      if (!sameValue(tr.choices, s.choices)) {
        tr.choices = { ...s.choices };
        params = true;
      }
      if (!sameValue(tr.overrides, s.overrides)) {
        tr.overrides = { ...s.overrides };
        params = true;
      }
      if (!sameValue(tr.problemOffsets, s.problemOffsets)) {
        tr.problemOffsets = { ...s.problemOffsets };
        params = true;
      }
      // A new edit re-analyzes and re-masters with the params just restored.
      if (!sameValue(tr.edits, s.edits) && (tr.source || tr.audio)) setTrackEdit(tr, s.edits, mappedPosition(tr, s.edits));
      else if (params) rerender.push(tr);
    }
    state.choices = a ? { ...a.choices } : { ...snap.choices };
    if (destChanged) updateExportRate();
    const front = lead || a;
    // The song on screen first (its debounce holds pumpBackground back).
    const todo = (destChanged ? state.tracks.filter((tr) => tr.analysis) : rerender).sort((x, y) => (y === front) - (x === front));
    for (const tr of todo) requeue(tr, tr === front);
    if (todo.some((tr) => tr !== front)) {
      renderTrackBar();
      setTimeout(pumpBackground, DEBOUNCE_MS + 20);
    }
    saveChoices();
  }

  /**
   * Re-master `tr` after undo / redo restored its params, never letting a render of the
   * undone params finish into the player: when the master it has matches the restored
   * params, a render in flight is dropped at once (nothing renders); otherwise the song on
   * screen (`front`), or one that is rendering, goes through the debounce of scheduleRender
   * (its render supersedes the one in flight, retries a failed render, and a burst of
   * Ctrl+Z renders once); any other song waits in the background queue (pumpBackground).
   */
  function requeue(tr, front) {
    if (!tr.analysis) return;
    const key = tr.rendering && tr.result ? safe(() => JSON.stringify(paramsFor(tr)), '') : '';
    if (key && key === tr.resultKey) startRender(tr);
    else if (front || tr.rendering) scheduleRender(tr);
    else tr.stale = true;
  }

  const undo = () => travel('undo');
  const redo = () => travel('redo');

  /**
   * One step back / forward. A step of another song first restores that song's state and
   * then switches to it (the change is seen and heard where it happens); a toast names
   * what was undone / redone.
   */
  function travel(dir) {
    const step = dir === 'undo' ? history.peekUndo() : history.peekRedo();
    if (!step) return false;
    if (stepBlocked(step)) {
      toast(t('cut.why.busy'), 'info');
      return false;
    }
    if (dir === 'undo') history.undo();
    else history.redo();
    const target = step.trackId ? state.tracks.find((x) => x.id === step.trackId) || null : null;
    const switched = !!target && target !== active();
    // The target is scheduled as the song on screen (setActive starts nothing while it renders).
    applySnapshot(dir === 'undo' ? step.before : step.after, { lead: switched ? target : null });
    if (switched) setActive(target, { silent: true });
    renderAll();
    // Undo moves a fader even while it has focus (renderChoices / rack leave a focused one alone).
    rack.refresh({ force: true });
    ui.intSlider.setValue((active() || state).choices.intensity);
    if (historyToast) historyToast.remove();
    historyToast = toast(t(dir === 'undo' ? 'history.undone' : 'history.redone', { action: labelText(step.label, t) }), 'info', { detail: switched ? t('history.onTrack', { name: target.name }) : null });
    return true;
  }

  /** The Annulla offered by a toast: only while its step is still the last one. */
  function undoIfTop(step) {
    if (step && history.peekUndo() === step) undo();
  }

  /**
   * Focus the header's Annulla (cut bar: after an edit or a reset; it may be painted a
   * moment later) — only while it is fully on screen: on a phone scrolled down to the cut
   * bar it is far above, and focus there would be invisible (the cut bar keeps it).
   */
  function focusUndo() {
    if (!ui.undoBtn.isConnected) return false;
    const r = ui.undoBtn.getBoundingClientRect();
    if (!r.height || r.top < 0 || r.bottom > (window.innerHeight || document.documentElement.clientHeight)) return false;
    ui.undoBtn.focus({ preventScroll: true });
    return document.activeElement === ui.undoBtn;
  }

  function paintHistoryBtn(btn, step, dir) {
    const off = !step || stepBlocked(step);
    btn.setAttribute('aria-disabled', off ? 'true' : 'false');
    const name = step ? t(dir === 'undo' ? 'history.undoNamed' : 'history.redoNamed', { action: labelText(step.label, t) }) : t(dir === 'undo' ? 'history.undo' : 'history.redo');
    btn.setAttribute('aria-label', name);
    btn.title = `${step ? name : t(dir === 'undo' ? 'history.nothingUndo' : 'history.nothingRedo')} (${t(dir === 'undo' ? 'history.keyUndo' : 'history.keyRedo')})`;
  }

  function renderHistory() {
    if (!ready) return;
    const u = history.peekUndo();
    paintHistoryBtn(ui.undoBtn, u, 'undo');
    paintHistoryBtn(ui.redoBtn, history.peekRedo(), 'redo');
    // A toast's Annulla belongs to one step: once another step is on top it would undo
    // something else, so it goes (the header's Annulla stays).
    for (const el of ui.toasts.children) {
      if (!el._step || el._step === u) continue;
      el._step = null;
      const b = el.querySelector('.toast-action');
      if (!b) continue;
      if (b === document.activeElement) el.querySelector('.toast-close').focus({ preventScroll: true });
      b.remove();
    }
  }

  // Labels of the steps ({ key, vars } for history.labelText; functions format in the
  // language shown when the label is read).
  const L = (key, vars) => (vars ? { key, vars } : { key });
  const setLabel = (what, value) => L('history.set', { what: typeof what === 'function' ? what : { key: what }, value });

  function choiceLabel(name, value) {
    if (name === 'style') return setLabel('choice.character', { key: `style.${value}` });
    if (name === 'cleanup') return setLabel('choice.cleanup', { key: `cleanup.${value}` });
    if (name === 'intensity') {
      const preset = Object.keys(P.INTENSITIES).find((k) => Math.abs(P.INTENSITIES[k] - value) < 1e-6);
      return setLabel('choice.intensity', preset ? { key: `intensity.${preset}` } : () => `${formatNumber(Math.round(value * 100), 0)}%`);
    }
    return L(`choice.${name}`);
  }

  /** The Avanzate control at `path` and the switch it hangs under (named "<switch> · <control>"). */
  function controlOf(path) {
    const all = P.ADVANCED_SECTIONS.flatMap((s) => s.controls);
    const ctl = all.find((c) => c.path === path) || null;
    const parent = ctl && ctl.dependsOn ? all.find((c) => c.path === ctl.dependsOn && c.type === 'toggle') : null;
    return { ctl, name: () => (!ctl ? path : parent ? `${t(parent.labelKey)} · ${t(ctl.labelKey)}` : t(ctl.labelKey)) };
  }

  function advLabel(path, v) {
    const { ctl, name } = controlOf(path);
    if (ctl && ctl.type === 'toggle') return setLabel(name, { key: v ? 'adv.on' : 'adv.off' });
    if (ctl && ctl.type === 'select') return setLabel(name, () => rateLabel(v));
    return setLabel(name, () => (ctl ? formatUnit(Number(v), ctl.unit, ctl) : String(v)));
  }

  // --- User actions ---------------------------------------------------------------------

  function setDestination(id) {
    if (!P.DESTINATIONS[id]) return;
    // A loudness typed in Avanzate would silently beat the new destination: the
    // destination wins, and the toast offers Annulla (the global undo of this step, which
    // brings back the previous destination and the typed loudness).
    let cleared = false;
    const step = act(setLabel('choice.destination', { key: `dest.${id}` }), () => {
      state.destination = id;
      for (const tr of state.tracks) {
        for (const path of LOUDNESS_PATHS) {
          if (!Object.prototype.hasOwnProperty.call(tr.overrides, path)) continue;
          delete tr.overrides[path];
          cleared = true;
        }
      }
    });
    updateExportRate();
    saveChoices();
    renderChoices();
    renderExport();
    renderRack();
    renderMeters();
    rack.refresh();
    scheduleAll();
    if (cleared && step) toast(t('dest.overrideCleared'), 'info', { action: { label: t('toast.undo'), run: () => undoIfTop(step) }, step });
  }

  /** Copy the active song's character, intensity, cleanup, reference and "sounds too…" fixes to every song (album / EP). */
  function applyChoicesToAll() {
    const a = active();
    if (!a || state.exporting) return;
    act(L('choice.applyAll'), () => {
      for (const tr of state.tracks) {
        if (tr === a) continue;
        tr.choices = { ...a.choices };
        tr.problemOffsets = { ...a.problemOffsets };
      }
    });
    scheduleAll();
    toast(t('choice.appliedAll', { n: state.tracks.length }), 'good');
  }

  /**
   * Character / intensity / cleanup of the active song. `coalesce`: the fine intensity
   * slider (a drag is one step); `force`: its double-click reset joins the clicks' step.
   */
  function setChoice(name, value, { coalesce = false, force = false } = {}) {
    const tr = active();
    act(
      choiceLabel(name, value),
      () => {
        state.choices[name] = value;
        if (tr) tr.choices[name] = value;
      },
      { track: tr, coalesce: coalesce ? `choice:${tr ? tr.id : ''}:${name}` : null, force },
    );
    if (tr) scheduleRender(tr);
    saveChoices();
    renderChoices();
    rack.refresh();
  }

  function setExportFormat(f) {
    state.exportFormat = f;
    writeStore(LS_EXPORT, { format: f, meta: state.exportMeta });
    // WAV 16-bit moves to 44.1 kHz (CD delivery, RESEARCH §3) and leaving it moves back,
    // unless the user picked a rate; an MP3 of an odd-rate source renders at an MP3 rate.
    // Only masters whose params actually change are re-rendered.
    updateExportRate();
    renderExport();
    rack.refresh();
    rescheduleChanged();
  }

  /** Explicit output rate from the export panel; null = back to automatic. */
  function setExportRate(v) {
    if (v !== null && !P.OUTPUT_SAMPLE_RATES.some((r) => String(r) === String(v))) return;
    state.rateManual = v === null ? null : v === 'source' ? 'source' : Number(v);
    updateExportRate();
    renderExport();
    rack.refresh();
    rescheduleChanged();
  }

  function onProblem(id) {
    const tr = active();
    if (!tr || !tr.analysis) return;
    act(setLabel('problems.title', { key: `problem.${id}` }), () => {
      tr.problemOffsets[id] = applyProblemStep(P, tr.problemOffsets[id], id, problemBase(tr, id));
    }, { track: tr });
    afterParamChange(tr);
  }

  function resetProblems() {
    const tr = active();
    if (!tr) return;
    act(L('history.problemsReset'), () => {
      tr.problemOffsets = {};
    }, { track: tr });
    afterParamChange(tr);
  }

  function sectionPaths(id) {
    const sec = P.ADVANCED_SECTIONS.find((s) => s.id === id);
    return sec ? sec.controls.map((c) => c.path).filter((p) => p !== 'output.sampleRate') : [];
  }

  function pathModified(path) {
    const tr = active();
    if (!tr) return false;
    if (Object.prototype.hasOwnProperty.call(tr.overrides, path)) return true;
    return P.PROBLEM_IDS.some((id) => P.PROBLEM_FIXES[id].path === path && tr.problemOffsets[id]);
  }

  function sectionModified(id) {
    return sectionPaths(id).some(pathModified);
  }

  function clearProblemFor(tr, path) {
    for (const id of P.PROBLEM_IDS) if (P.PROBLEM_FIXES[id].path === path) delete tr.problemOffsets[id];
  }

  // Avanzate: one step per fader drag / switch flip (same key = this control of this song).
  const advKey = (tr, path) => `adv:${tr.id}:${path}`;

  function onRackChange(path, v) {
    if (path === 'output.sampleRate') {
      setExportRate(v);
      return;
    }
    const tr = active();
    if (!tr || !tr.analysis) return;
    act(advLabel(path, v), () => {
      tr.overrides[path] = v;
      clearProblemFor(tr, path);
    }, { track: tr, coalesce: advKey(tr, path) });
    afterParamChange(tr);
  }

  function onRackReset(path) {
    if (path === 'output.sampleRate') {
      setExportRate(null);
      return;
    }
    const tr = active();
    if (!tr) return;
    act(L('history.auto', { what: controlOf(path).name }), () => {
      delete tr.overrides[path];
      clearProblemFor(tr, path);
    }, { track: tr, coalesce: advKey(tr, path), force: true });
    afterParamChange(tr);
  }

  function onRackResetSection(id) {
    const tr = active();
    if (!tr) return;
    const sec = P.ADVANCED_SECTIONS.find((s) => s.id === id);
    act(L('history.sectionAuto', { what: { key: sec ? sec.labelKey : id } }), () => {
      for (const p of sectionPaths(id)) {
        delete tr.overrides[p];
        clearProblemFor(tr, p);
      }
    }, { track: tr });
    afterParamChange(tr);
  }

  function afterParamChange(tr) {
    renderRack();
    renderProblems();
    renderIssues();
    renderMeters();
    scheduleRender(tr);
  }

  function setFadeFix(on) {
    const tr = active();
    if (!tr || !tr.analysis) return;
    act(L(on ? 'issues.fadeAdd' : 'history.fadeRemove'), () => {
      if (on) tr.overrides['finish.fadeOutMs'] = FADE_FIX_MS;
      else delete tr.overrides['finish.fadeOutMs'];
    }, { track: tr });
    afterParamChange(tr);
  }

  async function loadReference(file) {
    const tr = active();
    if (!tr || !tr.analysis || !file || !engine) return;
    state.refBusy = true;
    renderReference();
    try {
      const { audio, info } = await deps.decodeFile(file);
      const r = await engine.analyzeReference(audio);
      if (!state.tracks.includes(tr)) return;
      const ref = { ltas: Array.from(r.ltas || []), name: (info && info.baseName) || stripExt(file.name), loudness: r.loudness };
      act(L('history.refLoad', { name: ref.name }), () => {
        tr.choices.reference = ref;
        if (tr === active()) state.choices.reference = ref;
      }, { track: tr });
      scheduleRender(tr, 0);
    } catch (e) {
      console.error('reference failed', e);
      toast(t('err.file', { name: file.name || '?', message: t(errorKey(e, 'err.corrupt'), errorVars(e)) }), 'error');
    } finally {
      state.refBusy = false;
      renderReference();
      rack.refresh();
    }
  }

  function removeReference() {
    const tr = active();
    if (!tr) return;
    act(L('ref.remove'), () => {
      tr.choices.reference = null;
      state.choices.reference = null;
    }, { track: tr });
    renderReference();
    rack.refresh();
    scheduleRender(tr);
  }

  // --- Export ---------------------------------------------------------------------------

  async function exportActive() {
    const tr = active();
    if (!tr || !tr.analysis || state.exporting || state.saveSupport === 'none') return;
    await runExport([tr], false);
  }

  async function exportAll() {
    const list = state.tracks.filter((tr) => tr.analysis && !tr.error);
    if (!list.length || state.exporting || state.saveSupport === 'none') return;
    // Songs that failed or are still loading are not in the archive: say so.
    const skipped = state.tracks.filter((tr) => !list.includes(tr));
    if (skipped.length) toast(t('export.skipped', { names: skipped.map((tr) => tr.name).join(', ') }), 'info', { timeout: 9000 });
    await runExport(list, true);
  }

  function setExportProgress(label, fraction) {
    ui.expProg.hidden = false;
    ui.expProgLabel.textContent = label;
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    ui.expProgFill.style.width = `${pct}%`;
    ui.expProg.setAttribute('aria-valuenow', String(pct));
    ui.expProg.setAttribute('aria-valuetext', `${label} ${pct}%`);
  }

  async function runExport(tracks, asZip) {
    state.exporting = true;
    renderExport();
    const fmt = state.exportFormat;
    const keepMeta = state.exportMeta; // like the format: fixed for the whole export
    const n = tracks.length;
    try {
      // Snapshot every song's params now: a setting changed while a ZIP is being built
      // applies to the next masters, never to half of this album.
      const snaps = tracks.map((tr) => paramsFor(tr));
      const files = [];
      const used = new Set();
      const removed = []; // songs taken off the list during the export: left out, named
      for (let i = 0; i < n; i++) {
        const tr = tracks[i];
        const prefix = n > 1 ? `${t('export.trackOf', { n: i + 1, total: n })} · ` : '';
        const report = (key, f) => setExportProgress(prefix + t(key), (i + Math.min(1, Math.max(0, f))) / n * (asZip ? 0.95 : 1));
        let out;
        try {
          if (!state.tracks.includes(tr)) throw Object.assign(new Error('removed'), { code: 'removed' });
          out = await encodeTrack(tr, fmt, report, snaps[i], keepMeta);
        } catch (e) {
          if (!(e && e.code === 'removed')) throw e;
          removed.push(tr.name);
          continue;
        }
        const { blob, filename } = out;
        if (!asZip) {
          await save(blob, filename, fmt === 'mp3' ? 'MP3' : 'WAV');
          return;
        }
        let name = filename;
        for (let k = 2; used.has(name.toLowerCase()); k++) name = filename.replace(/ \(Master\)\./, ` (Master ${k}).`);
        used.add(name.toLowerCase());
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      if (removed.length) toast(t(files.length ? 'export.removedZip' : 'export.removed', { names: removed.join(', ') }), 'info', { timeout: 9000 });
      if (!files.length) return;
      setExportProgress(t('stage.zip'), 0.97);
      await nextFrame();
      const zip = deps.makeZip(files);
      setExportProgress(t('stage.zip'), 1);
      await save(zip, 'AudioMaster (Master).zip', 'ZIP');
    } catch (e) {
      console.error('export failed', e);
      const key = errorKey(e, e && e.code === 'render' ? 'err.render' : 'err.export');
      toast(t(key), 'error');
    } finally {
      state.exporting = false;
      ui.expProg.hidden = true;
      renderExport();
      setTimeout(pumpBackground, 0);
    }
  }

  async function save(blob, filename, extLabel) {
    let res = null;
    try {
      res = await deps.saveBlob(blob, filename);
    } catch (e) {
      console.error('save failed', e);
    }
    const out = saveOutcome(res);
    if (out.key === 'export.saved') {
      const fn = (res && res.filename) || filename;
      const zipped = /\.zip$/i.test(fn) && !/\.zip$/i.test(filename);
      toast(t('export.saved', { name: fn }), 'good', { detail: zipped ? t('export.savedZip', { ext: extLabel }) : null, timeout: zipped ? 9000 : 5000 });
    } else {
      toast(t(out.key), out.kind, { timeout: out.kind === 'error' ? 9000 : 6000 });
    }
    if (out.disable) {
      state.saveSupport = 'none';
      // The host's own refusal stays for the session. 'no_capability' only repeats an answer
      // to downloads() (maybe a host not ready yet): keep asking, as after the boot probe.
      if (res && res.code === 'no_capability') {
        probeTries = 0;
        clearTimeout(probeTimer);
        probeTimer = setTimeout(probeSave, PROBE_RETRY_MS[probeTries++]);
      } else saveBlockedBySave = true;
    }
  }

  async function encodeTrack(tr, fmt, report, snap, keepMeta) {
    if (!(tr.result && tr.resultKey === JSON.stringify(snap))) report('export.rendering', 0);
    await ensureRendered(tr, snap);
    const metadata = await exportMetaFor(tr, keepMeta, report);
    const base = (tr.info && tr.info.baseName) || tr.name;
    let audio = tr.result.audio;
    if (fmt === 'wav24' || fmt === 'wav16') {
      report('stage.encode', 0.3);
      await nextFrame();
      const blob = deps.encodeWav(audio, { bitDepth: fmt === 'wav16' ? 16 : 24, dither: true, metadata });
      report('stage.encode', 1);
      return { blob, filename: masterFileName(base, 'wav') };
    }
    // MP3 + codec check (RESEARCH §3): decode the encoded file and re-measure the true
    // peak; above −0.1 dBTP re-render with the ceiling 0.5 dB lower (at most twice).
    const params = tr.resultParams;
    const key = tr.resultKey;
    let extra = tr.mp3Adj && tr.mp3Adj.key === key ? tr.mp3Adj.extra : 0;
    const rerender = async () => {
      const p = P.setPath(params, 'loudness.ceilingDb', params.loudness.ceilingDb + extra);
      const res = await engine.render(tr.id, P.validateParams ? P.validateParams(p) : p, (stage, f) => {
        const pr = stageProgress(String(stage).replace(/^stage\./, ''), f);
        report('export.codecFix', 0.05 + 0.25 * (pr ?? 0));
      });
      return res.audio;
    };
    if (extra) audio = await rerender();
    for (let attempt = 0; ; attempt++) {
      let a = audio;
      const rate = mp3RateFor(a.sampleRate);
      if (rate !== a.sampleRate) {
        // Fallback only: MP3 masters are normally rendered at an MP3 rate (renderRateFor).
        report('stage.encode', 0.3);
        await nextFrame();
        a = deps.resampleAudio(a, rate);
      }
      // The encoder may still be downloading (up to 2 × 30 s offline): say so until the
      // first progress callback arrives.
      report('stage.mp3Load', 0.3);
      const blob = await deps.encodeMp3(a, { kbps: 320, metadata, onProgress: (f) => report('stage.encode', 0.3 + 0.55 * (finite(f) ? f : 0)) });
      const filename = masterFileName(base, 'mp3');
      if (!deps.decodeFile || !deps.truePeakDb) return { blob, filename };
      report('export.codecCheck', 0.88);
      let tp = -Infinity;
      try {
        const dec = await deps.decodeFile(new File([blob], 'x.mp3', { type: 'audio/mpeg' }));
        tp = deps.truePeakDb(dec.audio.channels, dec.audio.sampleRate);
      } catch (e) {
        console.warn('MP3 codec check skipped', e);
      }
      if (!(tp > MP3_TP_LIMIT) || attempt >= 2) {
        report('stage.encode', 1);
        return { blob, filename };
      }
      extra -= 0.5;
      tr.mp3Adj = { key, extra };
      report('export.codecFix', 0.05);
      audio = await rerender();
    }
  }

  // --- Cut tool: clips of the master, edits of the song ------------------------------------

  /**
   * "Salva la selezione": the selected part of the active song's MASTER, in the export
   * panel's format and rate, with fades. Same pipeline and messages as the full export;
   * nothing is re-mastered for a clip (an MP3 that overshoots −0.1 dBTP after encoding is
   * turned down by the overshoot instead).
   */
  async function exportClip(sel, { fadeInSec = 0.01, fadeOutSec = 0.01, name = '' } = {}) {
    const tr = active();
    if (!tr || !tr.analysis || tr.error || !sel || state.exporting || state.saveSupport === 'none') return;
    state.exporting = true;
    renderExport();
    cut.refresh();
    const fmt = state.exportFormat;
    const keepMeta = state.exportMeta;
    const leadBefore = waveform.lead; // the timeline the selection was drawn on
    const report = (key, f) => setExportProgress(t(key), f);
    try {
      const snap = paramsFor(tr);
      if (!(tr.result && tr.resultKey === JSON.stringify(snap))) report('export.rendering', 0);
      await ensureRendered(tr, snap);
      // A master with another trim (re-rendered meanwhile) shifts the timeline: same music.
      const shift = leadBefore - masterLead(tr);
      const m = tr.result.audio;
      const dur = m.channels[0].length / m.sampleRate;
      const a = Math.max(0, Math.min(dur, sel.start + shift));
      const b = Math.max(0, Math.min(dur, sel.end + shift));
      if (!(b - a > 0.005)) throw Object.assign(new Error('empty clip'), { code: 'export' });
      let clip = sliceAudio(m, a, b, { fadeInSec, fadeOutSec });
      const base = cleanName(name) || clipFileName((tr.info && tr.info.baseName) || tr.name, a, b);
      const metadata = await exportMetaFor(tr, keepMeta, report);
      let blob;
      let ext = 'wav';
      if (fmt === 'wav24' || fmt === 'wav16') {
        report('stage.encode', 0.3);
        await nextFrame();
        blob = deps.encodeWav(clip, { bitDepth: fmt === 'wav16' ? 16 : 24, dither: true, metadata });
      } else {
        ext = 'mp3';
        const rate = mp3RateFor(clip.sampleRate);
        if (rate !== clip.sampleRate) {
          report('stage.encode', 0.2);
          await nextFrame();
          clip = deps.resampleAudio(clip, rate);
        }
        for (let attempt = 0; ; attempt++) {
          report('stage.mp3Load', 0.3);
          blob = await deps.encodeMp3(clip, { kbps: 320, metadata, onProgress: (f) => report('stage.encode', 0.3 + 0.55 * (finite(f) ? f : 0)) });
          if (!deps.decodeFile || !deps.truePeakDb || attempt >= 2) break;
          report('export.codecCheck', 0.88);
          let tp = -Infinity;
          try {
            const dec = await deps.decodeFile(new File([blob], 'x.mp3', { type: 'audio/mpeg' }));
            tp = deps.truePeakDb(dec.audio.channels, dec.audio.sampleRate);
          } catch (e) {
            console.warn('MP3 codec check skipped', e);
          }
          if (!(tp > MP3_TP_LIMIT)) break;
          const g = Math.pow(10, -(tp - MP3_TP_LIMIT + 0.05) / 20);
          clip = { sampleRate: clip.sampleRate, channels: clip.channels.map((c) => c.map((x) => x * g)) };
        }
      }
      report('stage.encode', 1);
      await save(blob, `${base}.${ext}`, ext.toUpperCase());
    } catch (e) {
      if (e && e.code === 'removed') toast(t('export.removed', { names: tr.name }), 'info');
      else {
        console.error('clip export failed', e);
        toast(t(errorKey(e, e && e.code === 'render' ? 'err.render' : 'err.export')), 'error');
      }
    } finally {
      state.exporting = false;
      ui.expProg.hidden = true;
      renderExport();
      cut.refresh();
      setTimeout(pumpBackground, 0);
    }
  }

  /** Edit list in force for `tr` (the whole song when it was never edited). */
  function editsOf(tr) {
    return tr.edits || fullEdit((tr.source || tr.audio).channels[0].length);
  }

  /** Selection on the timeline → frames of the song the master is made from. */
  function selFrames(tr, sel) {
    return selectionToEdited(sel, { lead: waveform.lead, sampleRate: tr.audio.sampleRate, timelineDuration: waveform.duration, editedFrames: tr.audio.channels[0].length });
  }

  /**
   * Why "Tieni solo" / "Elimina" cannot run now: null, 'busy' (a save is running) or
   * edit.js editProblem(). An analysis or render in progress is no obstacle: the edit
   * supersedes it (analyze() drops results of audio that is no longer the song's).
   */
  function cutProblem(kind, sel) {
    const tr = active();
    if (!tr || !tr.audio || tr.phase === 'decoding' || !sel) return 'none';
    if (state.exporting) return 'busy';
    const { e0, e1 } = selFrames(tr, sel);
    return editProblem(editsOf(tr), kind, e0, e1, { sampleRate: tr.audio.sampleRate });
  }

  function cutApply(kind, sel) {
    const tr = active();
    if (cutProblem(kind, sel)) return false;
    const { e0, e1 } = selFrames(tr, sel);
    const sr = tr.audio.sampleRate;
    const cur = editsOf(tr);
    const next = kind === 'keep' ? keepOnly(cur, e0, e1, { sampleRate: sr }) : removeRange(cur, e0, e1, { sampleRate: sr });
    if (!next) return false;
    // Playhead: the start of what is kept, or the join where the removed part was (the
    // edge the edit used: snapped onto a nearby earlier join, see edit.js snapEdges).
    // One step of the global history: Annulla brings the previous edit back (applySnapshot,
    // the playhead staying on the same music when it still exists).
    const step = act(L(kind === 'keep' ? 'cut.keep' : 'cut.remove'), () => setTrackEdit(tr, next, kind === 'keep' ? 0 : snapEdges(cur, e0, e1, { sampleRate: sr }).e0 / sr), { track: tr });
    // The toast's Annulla is in sight even on a phone, where the header's is scrolled away.
    toast(t(kind === 'keep' ? 'cut.done.keep' : 'cut.done.remove'), 'info', step ? { action: { label: t('toast.undo'), run: () => undoIfTop(step) }, step } : {});
    return true;
  }

  /** Whole song again; an undoable step like any edit (the toast offers it at once). */
  function cutReset(tr) {
    if (!tr || !tr.edits || state.exporting) return;
    const step = act(L('cut.reset'), () => setTrackEdit(tr, null, mappedPosition(tr, null)), { track: tr });
    toast(t('cut.done.reset'), 'info', step ? { action: { label: t('toast.undo'), run: () => undoIfTop(step) }, step } : {});
  }

  /** Current playhead → the same source moment in the song made by `list` (seconds). */
  function mappedPosition(tr, list) {
    if (tr !== active() || !tr.audio) return 0;
    const sr = tr.audio.sampleRate;
    const e = Math.round(((safe(() => player.currentTime, 0) || 0) + waveform.lead) * sr);
    const s = editedToSource(editsOf(tr), e);
    const target = list || fullEdit((tr.source || tr.audio).channels[0].length);
    return sourceToEdited(target, s) / sr;
  }

  /**
   * Make `list` the song of `tr` (null = whole song): render the edit, drop the master and
   * the analysis made from the old audio (every choice, override and "suona troppo" stays),
   * reload it in the engine, re-analyze and re-master. The A/B original is the edited song,
   * so A/B and the waveform stay aligned. Used by the cut actions and by undo / redo.
   */
  function setTrackEdit(tr, list, posSec) {
    if (!tr.source) tr.source = tr.audio;
    const full = !list || isFullEdit(list, tr.source.channels[0].length);
    tr.edits = full ? null : list;
    tr.audio = full ? tr.source : applyEdit(tr.source, list);
    clearTimeout(tr.timer);
    tr.timer = 0;
    if (tr.rendering && engine && engine.cancelRender) safe(() => engine.cancelRender(tr.id));
    tr.renderSeq++;
    Object.assign(tr, { rendering: false, renderKey: '', result: null, resultKey: '', resultParams: null, decisions: [], mp3Adj: null, analysis: null, _sug: null, _sugKey: '', stale: false, error: null, progress: 0 });
    if (tr === active()) safe(() => player.pause());
    const done = analyze(tr); // synchronous part: player and waveform get the edited song
    // The unedited song stays on the track (undo, reset) but is not played any more: let
    // the player drop its full-length AudioBuffer (~90 MB for 4 min of 48 kHz stereo). An
    // undo back to the whole song rebuilds it on the next play().
    if (tr.audio !== tr.source) safe(() => player.forget && player.forget(tr.source));
    if (tr === active()) {
      safe(() => player.seek(Math.max(0, posSec || 0)));
      updateLive(true);
    }
    return done;
  }

  // --- Toasts ---------------------------------------------------------------------------

  /**
   * Toast; `action` { label, run } adds one text button (e.g. Undo) and keeps it up longer;
   * `step`: the history step that action undoes (renderHistory drops the button once
   * another step is on top). Returns the element.
   */
  function toast(message, kind = 'info', { detail = null, timeout, action = null, step = null } = {}) {
    const close = h('button', { type: 'button', class: 'toast-close', 'i18n-aria-label': 'toast.close' }, icon('close'));
    const actBtn = action ? h('button', { type: 'button', class: 'btn-text toast-action', text: action.label }) : null;
    const el = h(
      'div',
      { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast-led', 'aria-hidden': 'true' }),
      h('div', { class: 'toast-body' }, h('p', { class: 'toast-msg', text: message }), detail ? h('p', { class: 'toast-detail', text: detail }) : null, actBtn),
      close,
    );
    const remove = () => el.remove();
    close.addEventListener('click', remove);
    if (actBtn) {
      actBtn.addEventListener('click', () => {
        remove();
        action.run();
      });
    }
    if (actBtn && step) el._step = step;
    ui.toasts.append(el);
    while (ui.toasts.children.length > 4) ui.toasts.firstChild.remove();
    setTimeout(remove, timeout ?? (action ? 12000 : kind === 'error' ? 9000 : 5000));
    return el;
  }

  // --- DOM ------------------------------------------------------------------------------

  function build() {
    clear(root);
    root.classList.add('am-root');
    const fileInput = h('input', { type: 'file', id: 'am-file-input', accept: ACCEPT, multiple: true, hidden: true, tabindex: '-1' });
    const refInput = h('input', { type: 'file', id: 'am-ref-input', accept: ACCEPT, hidden: true, tabindex: '-1' });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (files.length) loadFiles(files);
    });
    refInput.addEventListener('change', () => {
      const f = refInput.files && refInput.files[0];
      refInput.value = '';
      if (f) loadReference(f);
    });
    const pickFiles = () => fileInput.click();
    // (i) explanations (help.js): null when a topic has no text, so nothing is drawn.
    const help = (id, o = {}) => helpButton(id, { P, ...o });

    // Header
    const langSeg = segmented({
      id: 'am-lang',
      labelKey: 'lang.label',
      options: [
        { value: 'it', key: 'lang.it' },
        { value: 'en', key: 'lang.en' },
      ],
      value: getLanguage(),
      onChange: (v) => setLanguage(v),
      className: 'seg-mini',
    });
    // Annulla / Ripeti: always on screen, named after the step they act on (renderHistory).
    // aria-disabled instead of disabled: the last Annulla keeps keyboard focus.
    const histBtn = (id, dir, keys) => {
      const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm hist-btn', id, 'aria-disabled': 'true', 'aria-keyshortcuts': keys }, icon(dir), h('span', { class: 'hist-label', i18n: `history.${dir}` }));
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') !== 'true') travel(dir);
      });
      return b;
    };
    // Tema (theme.js): the menu relabels itself and the class it sets on <html> repaints the canvases.
    const skinPicker = createSkinPicker({ t });
    const undoBtn = histBtn('am-undo', 'undo', 'Control+Z Meta+Z');
    const redoBtn = histBtn('am-redo', 'redo', 'Control+Shift+Z Meta+Shift+Z Control+Y');
    const histGroup = withHelp(h('div', { class: 'hist', role: 'group', 'i18n-aria-label': 'history.group' }, undoBtn, redoBtn), help('history'), 'hist-pair');
    const header = h(
      'header',
      { class: 'am-top' },
      h('div', { class: 'brand' }, h('h1', { class: 'brand-mark', text: 'AudioMaster' }), h('span', { class: 'brand-tag', i18n: 'app.tagline' })),
      h('div', { class: 'top-right' }, histGroup, h('span', { class: 'local-badge' }, h('span', { class: 'led', 'aria-hidden': 'true' }), h('span', { i18n: 'app.local' })), langSeg.el, skinPicker),
    );

    // Tape: track bar, waveform screen (drop zone), progress, transport
    const tracksEl = h('div', { class: 'tape-tracks', id: 'am-tracks' });
    const curveSw = toggleSwitch({
      id: 'am-curve',
      labelKey: 'wave.curve',
      checked: false,
      className: 'switch-sm',
      onChange: (v) => {
        state.showCurve = v;
        waveform.setShowCurves(v);
      },
    });
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'am-add' }, icon('plus'), h('span', { i18n: 'drop.add' }));
    addBtn.addEventListener('click', pickFiles);
    const canvas = h('canvas', { class: 'wave-canvas', id: 'am-wave', tabindex: '0', role: 'slider', 'i18n-aria-label': 'wave.label', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0' });
    const hover = h('span', { class: 'wave-hover', hidden: true, 'aria-hidden': 'true' });
    const chooseBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'am-choose' }, icon('upload'), h('span', { i18n: 'drop.choose' }));
    chooseBtn.addEventListener('click', pickFiles);
    const demoBtn = h('button', { type: 'button', class: 'btn btn-ghost', id: 'am-demo' }, h('span', { i18n: 'drop.demo' }));
    demoBtn.addEventListener('click', () => loadDemo());
    const empty = h(
      'div',
      { class: 'empty', id: 'am-empty' },
      h('p', { class: 'lbl', i18n: 'drop.label' }),
      h('p', { class: 'empty-title', i18n: 'drop.title' }),
      h('p', { class: 'empty-formats', i18n: 'drop.formats' }),
      h('div', { class: 'empty-actions' }, chooseBtn, demoBtn),
      h('p', { class: 'empty-note', i18n: 'drop.privacy' }),
    );
    const dropOverlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, h('span', { i18n: 'drop.release' }));
    const screen = h(
      'div',
      { class: 'screen', id: 'am-screen' },
      canvas,
      h('span', { class: 'lane-tag lane-orig', 'aria-hidden': 'true', i18n: 'wave.original' }),
      h('span', { class: 'lane-tag lane-master', 'aria-hidden': 'true', i18n: 'wave.master' }),
      hover,
      empty,
      dropOverlay,
    );
    const progStage = h('span', { class: 'prog-stage', id: 'am-progress-stage' });
    const progFill = h('span', { class: 'prog-fill' });
    const progPct = h('span', { class: 'prog-pct' });
    const progress = h('div', { class: 'prog', id: 'am-progress', role: 'progressbar', 'aria-labelledby': 'am-progress-stage', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, progStage, h('span', { class: 'prog-track' }, progFill), progPct);

    const playBtn = h('button', { type: 'button', class: 'btn-play', id: 'am-play', 'i18n-aria-label': 'transport.play', disabled: true }, icon('play'));
    playBtn.addEventListener('click', () => togglePlay());
    const timeCur = h('span', { class: 'time-cur', text: formatTime(0, true) });
    const timeDur = h('span', { class: 'time-dur', text: formatTime(0) });
    const abSeg = segmented({
      id: 'am-ab',
      labelKey: 'ab.label',
      options: [
        { value: 'original', key: 'ab.original', sub: 'A' },
        { value: 'master', key: 'ab.master', sub: 'B' },
      ],
      value: 'master',
      onChange: (v) => setListen(v),
      className: 'seg-ab',
    });
    const matchReason = h('p', { class: 'match-reason', id: 'am-match-reason', i18n: 'ab.matchOn' });
    const matchSw = toggleSwitch({
      id: 'am-match',
      labelKey: 'ab.match',
      checked: true,
      onChange: (v) => {
        state.loudMatch = v;
        applyLoudMatch();
        bindText(matchReason, v ? 'ab.matchOn' : 'ab.matchOff');
        renderSpectrum();
      },
    });
    matchSw.button.setAttribute('aria-describedby', 'am-match-reason');
    const transport = h(
      'div',
      { class: 'transport' },
      h('div', { class: 'tr-play' }, playBtn, h('div', { class: 'time', 'aria-live': 'off' }, timeCur, h('span', { class: 'time-sep', text: '/' }), timeDur)),
      withHelp(abSeg.el, help('ab'), 'is-grow'),
      h('div', { class: 'tr-match' }, withHelp(matchSw.el, help('ab.match')), matchReason),
    );
    const tapeHead = h('div', { class: 'tape-head' }, tracksEl, h('div', { class: 'tape-tools' }, withHelp(curveSw.el, help('wave.curve')), withHelp(addBtn, help('tracks'))));
    const tape = h(
      'section',
      { class: 'panel tape', id: 'am-tape', 'i18n-aria-label': 'ab.label' },
      tapeHead,
      screen,
      progress,
      transport,
      h('p', { class: 'keys-hint', i18n: 'transport.keys' }),
    );

    // Choices
    const destHint = h('p', { class: 'hint', id: 'am-dest-hint' });
    const destSeg = segmented({
      id: 'am-dest',
      labelledBy: 'am-dest-label',
      options: mainDest.map((id) => ({ value: id, key: `dest.${id}`, sub: '' })),
      value: state.destination,
      onChange: (v) => setDestination(v),
      className: 'seg-dest',
    });
    const moreSel = selectBox({
      id: 'am-dest-more',
      // The placeholder only labels the closed select: it cannot be picked (it would read
      // as "no destination" while a 'more' destination is still active).
      options: [{ value: '', key: 'choice.morePlaceholder', disabled: true }, ...moreDest.map((id) => ({ value: id, key: `dest.${id}` }))],
      value: moreDest.includes(state.destination) ? state.destination : '',
      onChange: (v) => {
        if (v) setDestination(v);
      },
      className: 'select-more',
    });
    bindAttr(moreSel.el, 'aria-label', 'choice.moreAria');
    const styleHint = h('p', { class: 'hint', id: 'am-style-hint' });
    const styleSeg = segmented({
      id: 'am-style',
      labelledBy: 'am-style-label',
      options: P.STYLE_IDS.map((id) => ({ value: id, key: `style.${id}` })),
      value: state.choices.style,
      onChange: (v) => setChoice('style', v),
    });
    const intSeg = segmented({
      id: 'am-int',
      labelledBy: 'am-int-label',
      options: Object.entries(P.INTENSITIES).map(([k, v]) => ({ value: v, key: `intensity.${k}` })),
      value: state.choices.intensity,
      onChange: (v) => {
        setChoice('intensity', Number(v));
        intSlider.setValue(Number(v));
      },
    });
    const intSlider = rangeSlider({
      id: 'am-int-fine',
      min: 0,
      max: 1,
      step: 0.01,
      value: state.choices.intensity,
      format: (v) => `${formatNumber(Math.round(v * 100), 0)}%`,
      onInput: (v) => setChoice('intensity', v, { coalesce: true }),
      onReset: () => {
        setChoice('intensity', def.intensity, { coalesce: true, force: true });
        intSlider.setValue(def.intensity);
      },
      className: 'range-int',
    });
    bindAttr(intSlider.input, 'aria-label', 'choice.intensityFine');
    const cleanHint = h('p', { class: 'hint', id: 'am-clean-hint' });
    const cleanSeg = segmented({
      id: 'am-clean',
      labelledBy: 'am-clean-label',
      options: P.CLEANUP_IDS.map((id) => ({ value: id, key: `cleanup.${id}` })),
      value: state.choices.cleanup,
      onChange: (v) => setChoice('cleanup', v),
    });
    const probBtns = {};
    const probWrap = h('div', { class: 'probs', role: 'group', 'aria-labelledby': 'am-prob-label' });
    for (const id of P.PROBLEM_IDS) {
      const off = h('span', { class: 'prob-off' });
      const b = h('button', { type: 'button', class: 'prob', id: `am-prob-${id}` }, h('span', { class: 'prob-name', i18n: `problem.${id}` }), off);
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        onProblem(id);
      });
      probBtns[id] = { b, off };
      probWrap.append(b);
    }
    const probReset = h('button', { type: 'button', class: 'btn-text', id: 'am-prob-reset', i18n: 'problems.reset', hidden: true });
    probReset.addEventListener('click', resetProblems);
    // With several songs, a tag tells which choices are global and which per song.
    const scopeTag = (scope) => h('span', { class: `scope-tag scope-${scope}`, i18n: scope === 'all' ? 'choice.scopeAll' : 'choice.scopeOne', hidden: true });
    const module = (id, labelKey, scope, helpEl, ...kids) =>
      h('div', { class: 'module', id: `mod-${id}` }, h('div', { class: 'module-head' }, h('h2', { class: 'lbl', id: `am-${id}-label`, i18n: labelKey }), helpEl, scopeTag(scope)), ...kids);
    const chNow = () => (active() || state).choices; // the card opens on the option in use
    const scopeNote = h('p', { class: 'scope-note' });
    const applyAllBtn = h('button', { type: 'button', class: 'btn-text', id: 'am-apply-all', i18n: 'choice.applyAll' });
    applyAllBtn.addEventListener('click', () => applyChoicesToAll());
    const scopeBar = h('div', { class: 'scope-bar', id: 'am-scope', hidden: true }, scopeNote, applyAllBtn);
    const choices = h(
      'section',
      { class: 'choices', id: 'am-choices' },
      scopeBar,
      h(
        'div',
        { class: 'choices-grid' },
        module('dest', 'choice.destination', 'all', help('choice.destination', { current: () => `dest.${state.destination}` }), h('div', { class: 'dest-row' }, destSeg.el, moreSel.el), destHint),
        module('style', 'choice.character', 'one', help('choice.character', { current: () => `style.${chNow().style}` }), styleSeg.el, styleHint),
        module('int', 'choice.intensity', 'one', help('choice.intensity'), intSeg.el, intSlider.el, h('p', { class: 'hint', i18n: 'intensity.hint' })),
        module('clean', 'choice.cleanup', 'one', help('choice.cleanup', { current: () => `cleanup.${chNow().cleanup}` }), cleanSeg.el, cleanHint),
        h(
          'div',
          { class: 'module', id: 'mod-prob' },
          h('div', { class: 'module-head prob-head' }, h('h2', { class: 'lbl', id: 'am-prob-label', i18n: 'problems.title' }), help('problems.title'), scopeTag('one'), probReset),
          probWrap,
          h('p', { class: 'hint', i18n: 'problems.hint' }),
        ),
      ),
    );

    // Diagnosis + decisions
    const issuesProfile = h('p', { class: 'small muted', id: 'am-profile' });
    const issuesList = h('ul', { class: 'chips', id: 'am-issues-list' });
    const issues = h('section', { class: 'panel notes-panel', id: 'am-issues', 'aria-labelledby': 'am-issues-title' }, h('h2', { class: 'lbl', id: 'am-issues-title', i18n: 'issues.title' }), issuesProfile, issuesList);
    const decList = h('ul', { class: 'declist', id: 'am-dec-list' });
    const warnList = h('ul', { class: 'warnlist', id: 'am-warn-list' });
    const warnTitle = h('h3', { class: 'lbl lbl-warn', i18n: 'decisions.warnings', hidden: true });
    const decUpdating = h('p', { class: 'stale-note', i18n: 'decisions.updating', hidden: true });
    const decisions = h(
      'section',
      { class: 'panel notes-panel', id: 'am-decisions', 'aria-labelledby': 'am-dec-title' },
      h('h2', { class: 'lbl', id: 'am-dec-title', i18n: 'decisions.title' }),
      decUpdating,
      decList,
      warnTitle,
      warnList,
    );

    // Spectrum
    const specCanvas = h('canvas', { class: 'spec-canvas', id: 'am-spec', role: 'img', 'i18n-aria-label': 'spectrum.label' });
    const legend = h(
      'ul',
      { class: 'legend' },
      h('li', { class: 'lg lg-live' }, h('span', { class: 'sw', 'aria-hidden': 'true' }), h('span', { i18n: 'spectrum.live' })),
      h('li', { class: 'lg lg-orig' }, h('span', { class: 'sw', 'aria-hidden': 'true' }), h('span', { i18n: 'spectrum.original' })),
      h('li', { class: 'lg lg-master' }, h('span', { class: 'sw', 'aria-hidden': 'true' }), h('span', { i18n: 'spectrum.master' })),
      h('li', { class: 'lg lg-eq' }, h('span', { class: 'sw', 'aria-hidden': 'true' }), h('span', { i18n: 'spectrum.eq' })),
    );
    const specNote = h('p', { class: 'small muted', i18n: 'spectrum.matched' });
    // Secondary views stay folded under a clear heading (progressive disclosure).
    const foldSummary = (titleId, titleKey, subKey, ...extra) =>
      h(
        'summary',
        { class: 'fold-summary' },
        h('span', { class: 'adv-chev', 'aria-hidden': 'true' }, icon('chevron')),
        h('h2', { class: 'lbl', id: titleId, i18n: titleKey }),
        h('span', { class: 'fold-sub', i18n: subKey }),
        ...extra,
      );
    const spectrumPanel = h(
      'details',
      { class: 'panel fold spectrum', id: 'am-spectrum' },
      foldSummary('am-spec-title', 'spectrum.title', 'spectrum.summary'),
      h('div', { class: 'fold-body' }, withHelp(legend, help('spectrum.legend')), h('div', { class: 'spec-wrap' }, specCanvas), specNote),
    );

    // Advanced rack + reference block (EQ section)
    const refInfo = h('p', { class: 'ref-info' });
    const refLoad = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'am-ref-load' }, icon('upload'), h('span', { i18n: 'ref.load' }));
    refLoad.addEventListener('click', () => refInput.click());
    const refRemove = h('button', { type: 'button', class: 'btn-text', id: 'am-ref-remove', i18n: 'ref.remove', hidden: true });
    refRemove.addEventListener('click', removeReference);
    const refBlock = h('div', { class: 'ref' }, withHelp(h('h4', { class: 'lbl', i18n: 'ref.title' }), help('ref')), h('p', { class: 'hint', i18n: 'ref.hint' }), refInfo, h('div', { class: 'ref-actions' }, refLoad, refRemove));
    const rackHost = h('div', { class: 'rack-host' });
    const advNote = h('p', { class: 'hint adv-note', i18n: 'adv.subtitle' });
    const advMod = h('span', { class: 'badge badge-mod', id: 'am-adv-mod', i18n: 'adv.modified', hidden: true });
    const advDisabled = h('p', { class: 'hint adv-note', i18n: 'adv.disabled' });
    const adv = h(
      'details',
      { class: 'panel adv', id: 'am-adv' },
      h('summary', { class: 'adv-summary' }, h('span', { class: 'adv-chev', 'aria-hidden': 'true' }, icon('chevron')), h('span', { class: 'lbl', i18n: 'adv.title' }), advMod),
      advancedHint(),
      advNote,
      advDisabled,
      rackHost,
    );

    // Side: meters, platforms, export
    const metersBody = h('div', { class: 'meters-body' });
    const explainBtn = h('button', { type: 'button', class: 'btn-text', id: 'am-meters-explain', 'aria-expanded': 'false', 'aria-controls': 'am-meters', i18n: 'meters.explain' });
    const staleBadge = () => h('span', { class: 'badge badge-stale', i18n: 'meters.updating', hidden: true });
    const metersStale = staleBadge();
    const metersPanel = h(
      'section',
      { class: 'panel meters', id: 'am-meters', 'aria-labelledby': 'am-meters-title' },
      h('div', { class: 'panel-head' }, h('div', { class: 'head-l' }, h('h2', { class: 'lbl', id: 'am-meters-title', i18n: 'meters.title' }), metersStale), explainBtn),
      metersBody,
    );
    explainBtn.addEventListener('click', () => {
      const on = !metersPanel.classList.contains('show-hints');
      metersPanel.classList.toggle('show-hints', on);
      explainBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      bindText(explainBtn, on ? 'meters.explainHide' : 'meters.explain');
    });
    const platformsBody = h('div', { class: 'platforms-body' });
    const platformsStale = staleBadge();
    const platformsPanel = h(
      'details',
      { class: 'panel fold platforms', id: 'am-platforms' },
      foldSummary('am-plat-title', 'platforms.title', 'platforms.summary', platformsStale),
      h('div', { class: 'fold-body' }, h('p', { class: 'hint' }, h('span', { i18n: 'platforms.hint' }), ' ', help('platforms')), platformsBody),
    );
    const fmtHint = h('p', { class: 'hint', id: 'am-format-hint' });
    const fmtSeg = segmented({
      id: 'am-format',
      labelledBy: 'am-format-label',
      options: EXPORT_FORMATS.map((f) => ({ value: f, key: `export.${f}` })),
      value: state.exportFormat,
      onChange: (v) => setExportFormat(v),
      className: 'seg-format',
    });
    // Sample rate: one compact line (value + why) and a small "Cambia" that unfolds the choice.
    const rateSummary = h('span', { class: 'rate-summary', id: 'am-rate-summary' });
    const rateChange = h('button', { type: 'button', class: 'btn-text', id: 'am-rate-change', 'aria-expanded': 'false', 'aria-controls': 'am-rate-box', i18n: 'export.rate.change' });
    const rateSeg = segmented({
      id: 'am-rate',
      labelledBy: 'am-rate-label',
      options: P.OUTPUT_SAMPLE_RATES.map((r) => ({ value: r, label: rateLabel(r) })),
      value: state.exportRate,
      onChange: (v) => setExportRate(v),
      className: 'seg-rate',
    });
    const rateAuto = h('button', { type: 'button', class: 'btn-text', id: 'am-rate-auto', i18n: 'export.rate.auto', hidden: true });
    rateAuto.addEventListener('click', () => setExportRate(null));
    const rateBox = h('div', { class: 'rate-box', id: 'am-rate-box', hidden: true }, h('h3', { class: 'sr-only', id: 'am-rate-label', i18n: 'export.rate' }), rateSeg.el, rateAuto);
    rateChange.addEventListener('click', () => {
      state.rateOpen = !state.rateOpen;
      renderExport();
      if (state.rateOpen) {
        const on = rateSeg.buttons.find((b) => b.tabIndex === 0);
        if (on) on.focus();
      }
    });
    const dlBtn = h('button', { type: 'button', class: 'btn btn-primary btn-wide', id: 'am-download', disabled: true }, icon('download'), h('span', { i18n: 'export.download' }));
    dlBtn.addEventListener('click', () => exportActive());
    const dlName = h('p', { class: 'filename', id: 'am-filename' });
    const allBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-wide', id: 'am-export-all', hidden: true }, h('span', { i18n: 'export.all' }));
    allBtn.addEventListener('click', () => exportAll());
    const allHint = h('p', { class: 'hint', hidden: true }, h('span', { i18n: 'export.allHint' }), ' ', help('export.all'));
    const expProgLabel = h('span', { class: 'prog-stage', id: 'am-export-stage' });
    const expProgFill = h('span', { class: 'prog-fill' });
    const expProg = h('div', { class: 'prog prog-export', role: 'progressbar', 'aria-labelledby': 'am-export-stage', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, expProgLabel, h('span', { class: 'prog-track' }, expProgFill));
    const expState = h('p', { class: 'hint', id: 'am-export-state' });
    const exportTitle = h('h2', { class: 'lbl', id: 'am-export-title', i18n: 'export.title' });
    const rateField = h('div', { class: 'field rate-field' }, h('p', { class: 'rate-line' }, rateSummary, rateChange, help('export.rate')), rateBox);
    const exportActions = h('div', { class: 'export-actions' }, withHelp(dlBtn, help('export.download'), 'is-grow'), dlName, expState, allBtn, allHint);
    const exportPanel = h(
      'section',
      { class: 'panel export', id: 'am-export', 'aria-labelledby': 'am-export-title' },
      exportTitle,
      h('div', { class: 'field' }, withHelp(h('h3', { class: 'lbl lbl-sub', id: 'am-format-label', i18n: 'export.format' }), help('export.format', { current: () => `export.${state.exportFormat}` })), fmtSeg.el, fmtHint),
      rateField,
      exportActions,
      expProg,
      h('div', { class: 'notices' }, h('p', { i18n: 'notice.aiPolicy' }), h('p', { i18n: 'notice.sunoLicense' })),
    );

    // Roles on the toasts announce them; a live container on top would double-announce.
    const toasts = h('div', { class: 'toasts' });
    const status = h('p', { class: 'sr-only', id: 'am-status', 'aria-live': 'polite' });
    const side = h('aside', { class: 'am-side' }, exportPanel, metersPanel, platformsPanel);
    const shell = h(
      'div',
      { class: 'am-shell' },
      header,
      h(
        'main',
        { class: 'am-console' },
        h('div', { class: 'am-main' }, tape, choices, h('div', { class: 'notes' }, issues, decisions), spectrumPanel, adv),
        // Export first: the download is what the user came for; the tab order follows.
        side,
      ),
      h('footer', { class: 'am-foot' }, h('p', { i18n: 'app.footer' })),
    );
    root.append(shell, status, toasts, fileInput, refInput);

    return {
      shell, tape, tapeHead, screen, canvas, hover, empty, tracksEl, curveSw, addBtn, progress, progStage, progFill, progPct, undoBtn, redoBtn,
      playBtn, timeCur, timeDur, abSeg, matchSw, matchReason, langSeg, skinPicker,
      destSeg, moreSel, destHint, styleSeg, styleHint, intSeg, intSlider, cleanSeg, cleanHint, probBtns, probReset,
      scopeBar, scopeNote, issues, issuesProfile, issuesList, decisions, decList, decUpdating, warnList, warnTitle,
      spectrumPanel, specCanvas, legend, specNote, adv, advNote, advDisabled, advMod, rackHost, refBlock, refInfo, refLoad, refRemove,
      side, metersPanel, metersStale, metersBody, platformsPanel, platformsStale, platformsBody, exportPanel, exportTitle, exportActions, rateField,
      fmtSeg, fmtHint, rateSummary, rateChange, rateBox, rateSeg, rateAuto, dlBtn, dlName, allBtn, allHint,
      expProg, expProgLabel, expProgFill, expState, toasts, status, chooseBtn, demoBtn, fileInput,
    };
  }

  // --- Renderers ------------------------------------------------------------------------

  function renderAll() {
    // Before the first song only the drop zone and the destination are on screen.
    root.classList.toggle('has-track', state.tracks.length > 0);
    // The empty-state buttons disappear once audio exists: keep keyboard focus in the app.
    const focusInEmpty = ui.empty.contains(document.activeElement);
    renderTrackBar();
    renderScreen();
    renderProgress();
    syncTransport();
    renderChoices();
    renderProblems();
    renderIssues();
    renderDecisions();
    renderMeters();
    renderSpectrum();
    renderRack();
    renderReference();
    renderExport();
    renderMeta();
    renderStale();
    renderHistory();
    if (focusInEmpty && ui.empty.hidden && !ui.playBtn.disabled) ui.playBtn.focus({ preventScroll: true });
  }

  function infoLine(tr) {
    const i = tr.info;
    if (!i) return '';
    const parts = [];
    if (i.format && i.format !== 'other') parts.push(String(i.format).toUpperCase());
    if (finite(i.nativeSampleRate || i.sampleRate)) parts.push(formatHz(i.nativeSampleRate || i.sampleRate));
    if (finite(i.bitDepth)) parts.push(`${i.bitDepth}-bit`);
    else if (finite(i.bitrateKbps)) parts.push(`${Math.round(i.bitrateKbps)} kbps`);
    // An edited song (cut tool) shows its own length, not the file's.
    const dur = finite(i.duration) && !tr.edits ? i.duration : tr.audio ? tr.audio.channels[0].length / tr.audio.sampleRate : NaN;
    if (finite(dur)) parts.push(formatTime(dur));
    return parts.join(' · ');
  }

  function renderTrackBar() {
    const el = ui.tracksEl;
    // The chips are rebuilt: remember which one had keyboard focus and restore it.
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && focused.dataset.focusKey;
    clear(el);
    const a = active();
    ui.tapeHead.hidden = !state.tracks.length;
    if (!state.tracks.length) return;
    if (state.tracks.length === 1 && a) {
      const st = trackStatus(a);
      el.append(
        h(
          'div',
          { class: 'track-single' },
          h('span', { class: `dot dot-${st}`, 'aria-hidden': 'true' }),
          h('span', { class: 'track-name', text: a.name, title: a.name }),
          a.edits ? h('span', { class: 'badge badge-edit', i18n: 'cut.edited' }) : null,
          h('span', { class: 'track-info', text: infoLine(a) }),
          h('span', { class: 'sr-only', text: t(`track.status.${st}`) }),
        ),
      );
      // A chip had focus (a removal left one song): move on to "Aggiungi brani".
      if (focusKey) ui.addBtn.focus({ preventScroll: true });
      return;
    }
    const list = h('ul', { class: 'track-chips', 'aria-label': t('tracks.label') });
    for (const tr of state.tracks) {
      const st = trackStatus(tr);
      const sel = h(
        'button',
        { type: 'button', class: 'track-chip-main', 'aria-pressed': tr === a ? 'true' : 'false', title: `${tr.name} · ${t(`track.status.${st}`)}`, dataset: { focusKey: `sel-${tr.id}` } },
        h('span', { class: `dot dot-${st}`, 'aria-hidden': 'true' }),
        h('span', { class: 'track-name', text: tr.name }),
        tr.edits ? h('span', { class: 'badge badge-edit', i18n: 'cut.edited' }) : null,
        h('span', { class: 'sr-only', text: ` · ${t(`track.status.${st}`)}` }),
      );
      sel.addEventListener('click', () => setActive(tr));
      const rm = h('button', { type: 'button', class: 'track-chip-x', 'aria-label': t('track.remove', { name: tr.name }), dataset: { focusKey: `rm-${tr.id}` } }, icon('close'));
      rm.addEventListener('click', () => removeTrack(tr));
      list.append(h('li', { class: `track-chip${tr === a ? ' is-active' : ''}` }, sel, rm));
    }
    el.append(list);
    if (focusKey) {
      const again = el.querySelector(`[data-focus-key="${focusKey}"]`) || el.querySelector('.track-chip-main');
      if (again) again.focus();
    }
  }

  function renderScreen() {
    const tr = active();
    const hasAudio = !!(tr && tr.audio);
    ui.empty.hidden = hasAudio;
    ui.empty.classList.toggle('is-busy', !!(tr && !tr.audio));
    ui.screen.classList.toggle('has-audio', hasAudio);
    // Same pair and lead as the player (playbackMaster / masterLead), so the lanes line up.
    const wm = hasAudio ? playbackMaster(tr) : null;
    waveform.setAudio(hasAudio ? tr.audio : null, wm, { originalOffsetSec: wm ? masterLead(tr) : 0 });
    waveform.setPlaceholder(hasAudio && !tr.result ? t(tr.error ? `track.status.error` : 'wave.pending') : '');
    const a = tr && tr.analysis ? tr.analysis.loudness : null;
    const m = tr && tr.result && tr.result.report ? tr.result.report.loudness : null;
    waveform.setCurves(a ? { curve: a.curve, hop: a.curveHopSec } : null, m ? { curve: m.curve, hop: m.curveHopSec } : null);
  }

  function renderProgress() {
    const tr = active();
    let label = '';
    let value = null;
    let show = false;
    if (tr && tr.phase) {
      show = true;
      label = t(tr.phase === 'decoding' ? 'stage.decode' : 'stage.analyze');
    } else if (tr && tr.rendering) {
      show = true;
      label = t(`stage.${tr.stage || 'prepare'}`);
      value = tr.progress;
    }
    ui.progress.hidden = !show;
    ui.progress.classList.toggle('is-indeterminate', show && value === null);
    if (!show) return;
    ui.progStage.textContent = label;
    const pct = value === null ? null : Math.round(value * 100);
    ui.progFill.style.width = pct === null ? '' : `${pct}%`;
    ui.progPct.textContent = pct === null ? '' : `${pct}%`;
    if (pct === null) ui.progress.removeAttribute('aria-valuenow');
    else ui.progress.setAttribute('aria-valuenow', String(pct));
    ui.progress.setAttribute('aria-valuetext', pct === null ? label : `${label} ${pct}%`);
  }

  function renderChoices() {
    const tr = active();
    const ch = tr ? tr.choices : state.choices;
    ui.destSeg.setValue(mainDest.includes(state.destination) ? state.destination : null);
    ui.moreSel.setValue(moreDest.includes(state.destination) ? state.destination : '');
    ui.moreSel.el.classList.toggle('is-selected', moreDest.includes(state.destination));
    // Each button shows the target this song would really get (Loud / Club move with intensity).
    for (const id of mainDest) {
      const v = destinationTarget(tr, ch, id);
      ui.destSeg.setSub(id, finite(v) ? `${formatNumber(v, Number.isInteger(v) ? 0 : 1)} LUFS` : '');
    }
    const manual = tr && tr.analysis && Object.prototype.hasOwnProperty.call(tr.overrides, 'loudness.targetLufs') ? Number(tr.overrides['loudness.targetLufs']) : NaN;
    if (finite(manual)) {
      ui.destHint.textContent = `${t(`dest.${state.destination}.hint`)} ${t('dest.manual', { lufs: formatNumber(manual, 1) })}`;
      delete ui.destHint.dataset.i18n;
    } else bindText(ui.destHint, `dest.${state.destination}.hint`);
    const multi = state.tracks.length > 1;
    ui.scopeBar.hidden = !multi;
    for (const el of ui.shell.querySelectorAll('.scope-tag')) el.hidden = !multi;
    ui.scopeNote.textContent = multi && tr ? t('choice.scopeNote', { name: tr.name }) : '';
    ui.styleSeg.setValue(ch.style);
    bindText(ui.styleHint, `style.${ch.style}.hint`);
    const preset = Object.values(P.INTENSITIES).find((v) => Math.abs(v - ch.intensity) < 1e-6);
    ui.intSeg.setValue(preset ?? null);
    if (document.activeElement !== ui.intSlider.input) ui.intSlider.setValue(ch.intensity);
    else ui.intSlider.refresh();
    ui.cleanSeg.setValue(ch.cleanup);
    bindText(ui.cleanHint, `cleanup.${ch.cleanup}.hint`);
  }

  /** Loudness target of destination `id` for the active song (or the bare preset without one). */
  function destinationTarget(tr, ch, id) {
    if (tr && tr.analysis) {
      const p = id === state.destination ? safe(() => paramsFor(tr)) : safe(() => deps.suggestParams(tr.analysis, { ...choicesFor(tr), destination: id }));
      if (p && p.loudness && finite(p.loudness.targetLufs)) return p.loudness.targetLufs;
    }
    return destinationLufs(P, id, ch.intensity);
  }

  function renderProblems() {
    const tr = active();
    const ready = !!(tr && tr.analysis);
    let any = false;
    for (const id of P.PROBLEM_IDS) {
      const { b, off } = ui.probBtns[id];
      const raw = tr ? tr.problemOffsets[id] || 0 : 0;
      // Show what is applied: the net cap may hold the offset below what was clicked.
      const base = ready ? problemBase(tr, id) : 0;
      const v = ready ? capProblemOffset(P, id, raw, base) : 0;
      any = any || !!raw;
      off.textContent = v ? `${formatNumber(v, 1, { sign: true })} dB` : '';
      b.classList.toggle('is-set', !!v);
      b.disabled = !ready;
      const atCap = ready && problemAtCap(P, raw, id, base);
      b.setAttribute('aria-disabled', atCap ? 'true' : 'false');
      if (atCap) bindAttr(b, 'title', 'problems.max');
      else b.removeAttribute('title');
    }
    ui.probReset.hidden = !any;
  }

  function sevClass(s) {
    return s >= 0.67 ? 'high' : s >= 0.34 ? 'mid' : 'low';
  }

  function issueValue(issue) {
    const v = issue.value;
    if (!finite(v)) return '';
    switch (issue.id) {
      case 'codecCutoff':
        return formatHz(v < 100 ? v * 1000 : v);
      case 'tooLoud':
      case 'tooQuiet':
        return `${formatNumber(v, 1)} LUFS`;
      case 'overs':
        return `${formatNumber(v, 1, { sign: true })} dBTP`;
      default:
        return '';
    }
  }

  function renderIssues() {
    const tr = active();
    const list = ui.issuesList;
    clear(list);
    ui.issuesProfile.textContent = '';
    if (!tr || !tr.analysis) {
      list.append(h('li', { class: 'placeholder', i18n: 'issues.empty' }));
      return;
    }
    const an = tr.analysis;
    if (an.profile) bindText(ui.issuesProfile, 'issues.profile', { profile: t(`profile.${an.profile}`) });
    const issues = (an.issues || []).filter((i) => i && i.id).slice().sort((x, y) => (y.severity || 0) - (x.severity || 0));
    if (!issues.length) {
      list.append(h('li', { class: 'placeholder good' }, h('span', { class: 'dot dot-ready', 'aria-hidden': 'true' }), h('span', { i18n: 'issues.none' })));
      return;
    }
    const fadeOn = (safe(() => P.getPath(paramsFor(tr), 'finish.fadeOutMs'), 0) || 0) >= FADE_FIX_MS;
    // Done / not done comes from the master's own decisions, never from a fixed sentence.
    const meta = tr.resultParams && tr.resultParams.meta;
    const cleanupUsed = (meta && meta.cleanup) || tr.choices.cleanup;
    for (const issue of issues) {
      const sev = sevClass(issue.severity || 0);
      const hintId = `am-issue-${issue.id}-hint`;
      const open = openIssue === issue.id;
      const val = issueValue(issue);
      const out = tr.result ? issueOutcome(issue.id, tr.decisions, cleanupUsed, tr.resultParams) : null;
      const main = h(
        'button',
        { type: 'button', class: 'chip-main', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': hintId },
        h('span', { class: `sev sev-${sev}`, 'aria-hidden': 'true' }),
        h('span', { class: 'chip-label', text: t(`issue.${issue.id}`) }),
        val ? h('span', { class: 'chip-val', text: val }) : null,
        out && out.done ? h('span', { class: 'chip-ok', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'sr-only', text: ` · ${t(`sev.${sev}`)}${out && out.done ? ` · ${t('issues.fixedShort')}` : ''}` }),
      );
      main.addEventListener('click', () => {
        openIssue = open ? null : issue.id;
        renderIssues();
        const again = ui.issuesList.querySelector(`[aria-controls="${hintId}"]`);
        if (again) again.focus();
      });
      const li = h('li', { class: `chip chip-${sev}${open ? ' is-open' : ''}` }, main);
      if (issue.id === 'abruptEnd') {
        const fix = h('button', { type: 'button', class: `chip-fix${fadeOn ? ' is-done' : ''}`, id: 'am-fade-fix', 'aria-pressed': fadeOn ? 'true' : 'false', text: t(fadeOn ? 'issues.fadeUndo' : 'issues.fadeAdd') });
        fix.addEventListener('click', () => setFadeFix(!fadeOn));
        li.append(fix);
      }
      const hint = h('div', { class: 'chip-hint', id: hintId, hidden: !open }, h('p', { text: t(`issue.${issue.id}.hint`) }));
      if (issue.id === 'abruptEnd' && fadeOn) hint.append(h('p', { class: 'chip-done', text: t('issues.fadeAdded') }));
      if (out && out.done) {
        const what = out.decision ? t(out.decision.key, fmtVars(out.decision.vars)) : t(out.key, fmtVars(out.vars));
        hint.append(h('p', { class: 'chip-done' }, h('span', { class: 'sr-only', text: t('issues.donePrefix') }), what));
      } else if (out) hint.append(h('p', { class: 'chip-not', text: t(out.key) }));
      li.append(hint);
      list.append(li);
    }
  }

  function fmtVars(vars) {
    const out = {};
    for (const [k, v] of Object.entries(vars || {})) {
      if (v === null || v === undefined) continue;
      if (k === 'style') out[k] = t(`style.${v}`);
      else if (k === 'dest') out[k] = t(`dest.${v}`);
      else if (k === 'profile') out[k] = t(`profile.${v}`);
      else if (k === 'module') {
        const s = t(`module.${v}`);
        out[k] = s === `module.${v}` ? String(v) : s;
      } else if (typeof v !== 'number') out[k] = String(v);
      else if (k === 'hz') out[k] = formatHz(v);
      else if (k === 'db' || k === 'gr') out[k] = formatNumber(Math.abs(v), 1);
      else if (k === 'lufs' || k === 'ceiling') out[k] = formatNumber(v, 1);
      else if (k === 'pct') out[k] = `${formatNumber(Math.round(Math.abs(v) <= 1 && !Number.isInteger(v) ? v * 100 : v), 0)}%`;
      else if (k === 'kbps') out[k] = formatNumber(Math.round(v), 0);
      else out[k] = formatNumber(v, Number.isInteger(v) ? 0 : 1);
    }
    return out;
  }

  function renderDecisions() {
    const tr = active();
    clear(ui.decList);
    clear(ui.warnList);
    ui.warnTitle.hidden = true;
    if (!tr || !tr.result) {
      const pending = tr && (tr.phase || tr.rendering || tr.timer);
      ui.decList.append(h('li', { class: 'placeholder', i18n: pending ? 'decisions.pending' : 'decisions.empty' }));
      return;
    }
    for (const d of tr.decisions) {
      if (!d || !d.key) continue;
      ui.decList.append(h('li', { class: 'dec', text: t(d.key, fmtVars(d.vars)) }));
    }
    if (!ui.decList.children.length) ui.decList.append(h('li', { class: 'placeholder', i18n: 'decisions.empty' }));
    const warns = (tr.result.report && tr.result.report.warnings) || [];
    for (const w of warns) {
      if (!w || !w.id) continue;
      const key = w.id.startsWith('warn.') ? w.id : `warn.${w.id}`;
      ui.warnList.append(h('li', { class: 'warn', text: t(key, fmtVars(w.vars)) }));
    }
    ui.warnTitle.hidden = !ui.warnList.children.length;
  }

  function renderMeters() {
    const tr = active();
    const an = tr && tr.analysis ? tr.analysis.loudness : null;
    const rep = tr && tr.result ? tr.result.report : null;
    const lo = rep ? rep.loudness : null;
    const before = an ? { lufs: an.integrated, tp: an.truePeakDb, lra: an.lra, plr: finite(an.plr) ? an.plr : an.truePeakDb - an.integrated } : {};
    const after = lo ? { lufs: lo.integrated, tp: lo.truePeakDb, lra: lo.lra, plr: lo.truePeakDb - lo.integrated } : {};
    const gr = rep && rep.limiter ? { avg: rep.limiter.grAvgDb, max: rep.limiter.grMaxDb } : null;
    // The master on screen is judged against the target it was rendered for; the new
    // target only appears in the target line while the update runs.
    const used = tr && tr.result && tr.resultParams && tr.resultParams.loudness;
    const target = used ? { lufs: used.targetLufs, ceiling: used.ceilingDb } : targetFor(tr);
    meters.set({ before, after, gr, target, nextTarget: targetFor(tr), stale: isStale(tr) });
    platforms.set(lo ? lo.integrated : null, lo ? lo.truePeakDb : null);
    updateLive(true);
  }

  /** Mark every readout of a master that no longer matches the settings as "updating". */
  function renderStale() {
    const tr = active();
    const st = isStale(tr);
    meters.setStale(st, targetFor(tr));
    ui.metersStale.hidden = !st;
    ui.platformsStale.hidden = !st;
    ui.platformsPanel.classList.toggle('is-stale', st);
    ui.decisions.classList.toggle('is-stale', st);
    ui.decUpdating.hidden = !st;
  }

  function renderSpectrum() {
    const tr = active();
    const an = tr && tr.analysis;
    const rep = tr && tr.result && tr.result.report;
    const lo = an ? an.loudness.integrated : NaN;
    const lm = rep && rep.loudness ? rep.loudness.integrated : NaN;
    spectrum.setOverlays({
      original: an && an.spectrum ? an.spectrum.ltas : null,
      master: rep ? rep.ltas : null,
      eq: rep ? rep.eqCurveDb : null,
      masterOffsetDb: state.loudMatch && finite(lo) && finite(lm) ? lo - lm : 0,
    });
    ui.specNote.hidden = !(state.loudMatch && rep);
    spectrum.setLive(safe(() => player.analyser), effectiveSource());
  }

  function renderRack() {
    const tr = active();
    const ready = !!(tr && tr.analysis);
    rack.setDisabled(!ready);
    ui.advNote.hidden = !ready;
    ui.advDisabled.hidden = ready;
    const anyMod = ready && P.ADVANCED_SECTIONS.some((s) => sectionModified(s.id));
    ui.advMod.hidden = !anyMod;
  }

  function renderReference() {
    const tr = active();
    const ready = !!(tr && tr.analysis);
    const ref = tr ? tr.choices.reference : null;
    ui.refLoad.disabled = !ready || state.refBusy;
    ui.refRemove.hidden = !ref;
    if (state.refBusy) bindText(ui.refInfo, 'ref.loading');
    else if (ref) {
      const l = typeof ref.loudness === 'number' ? ref.loudness : ref.loudness && ref.loudness.integrated;
      ui.refInfo.textContent = finite(l) ? t('ref.info', { name: ref.name, lufs: formatNumber(l, 1) }) : ref.name;
      delete ui.refInfo.dataset.i18n;
    } else {
      ui.refInfo.textContent = '';
      delete ui.refInfo.dataset.i18n;
    }
  }

  function renderMeta() {
    if (ready && metaBox) metaBox.update(active());
  }

  function renderExport() {
    const tr = active();
    const ready = !!(tr && tr.analysis && !tr.error);
    const blocked = state.saveSupport === 'none';
    ui.fmtSeg.setValue(state.exportFormat);
    bindText(ui.fmtHint, `export.${state.exportFormat}.hint`);
    // Sample rate: the active song's real output rate and the reason, in one line.
    const srcRate = tr && tr.audio ? tr.audio.sampleRate : null;
    const rr = renderRateFor(state.exportRate, state.exportFormat, srcRate ?? NaN);
    const shown = rr === 'source' ? srcRate : rr;
    const why = String(rr) !== String(state.exportRate) ? 'mp3' : state.rateWhy;
    ui.rateSummary.textContent = shown ? t(`export.rate.why.${why}`, { rate: formatHz(shown), dest: t(`dest.${state.destination}`) }) : t('export.rate.why.unknown');
    ui.rateSeg.setValue(state.exportRate);
    for (const b of ui.rateSeg.buttons) b.querySelector('.seg-label').textContent = rateLabel(b.dataset.value === 'source' ? 'source' : Number(b.dataset.value));
    ui.rateBox.hidden = !state.rateOpen;
    ui.rateChange.setAttribute('aria-expanded', state.rateOpen ? 'true' : 'false');
    bindText(ui.rateChange, state.rateOpen ? 'export.rate.close' : 'export.rate.change');
    ui.rateAuto.hidden = state.rateManual === null;
    ui.dlBtn.disabled = !ready || state.exporting || blocked;
    ui.fmtSeg.setDisabled(state.exporting);
    ui.rateSeg.setDisabled(state.exporting);
    if (metaBox) metaBox.setDisabled(state.exporting);
    const ext = state.exportFormat === 'mp3' ? 'mp3' : 'wav';
    ui.dlName.textContent = tr ? masterFileName((tr.info && tr.info.baseName) || tr.name, ext) : '';
    ui.dlName.hidden = !tr || blocked;
    const multi = state.tracks.filter((x) => x.analysis).length > 1;
    ui.allBtn.hidden = !multi;
    ui.allHint.hidden = !multi;
    ui.allBtn.disabled = state.exporting || blocked;
    let stateKey = '';
    if (blocked) stateKey = 'export.unavailable';
    else if (!tr) stateKey = 'export.disabled';
    else if (state.exporting) stateKey = 'export.working';
    else if (tr.analysis && (tr.rendering || tr.timer)) stateKey = 'export.waiting';
    if (stateKey) bindText(ui.expState, stateKey);
    else {
      ui.expState.textContent = '';
      delete ui.expState.dataset.i18n;
    }
    ui.expState.hidden = !stateKey;
    ui.expState.classList.toggle('is-warn', blocked);
    cut.refresh(); // format (clip extension) and export availability
    renderHistory(); // a step that edits a song waits for a running save
  }

  // --- Global listeners -------------------------------------------------------------------

  // Space / B act only where they cannot shadow a control's own keys (shortcutAllowed):
  // on the page itself, the waveform, the play button and the A/B switch.
  // Ctrl/⌘+Z, Shift+Ctrl/⌘+Z, Ctrl+Y: undo / redo, except in a text or number field (its
  // own text undo) and while a help card is open.
  function onKeyDown(e) {
    const hk = historyKey(e);
    if (hk) {
      if (e.defaultPrevented || !undoKeyAllowed(e.target) || root.querySelector('.help-btn[aria-expanded="true"]')) return;
      e.preventDefault();
      travel(hk);
      return;
    }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !shortcutAllowed(e.target)) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) togglePlay();
    } else if ((e.key === 'b' || e.key === 'B') && !e.repeat) {
      e.preventDefault();
      toggleAB();
    }
  }
  function onKeyUp(e) {
    // Buttons fire on Space keyup: the play button must not toggle a second time.
    if ((e.code === 'Space' || e.key === ' ') && shortcutAllowed(e.target)) e.preventDefault();
  }
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  let dragDepth = 0;
  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    ui.tape.classList.add('is-drag');
  }
  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.tape.classList.remove('is-drag');
  }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    ui.tape.classList.remove('is-drag');
    loadFiles(e.dataTransfer.files);
  }
  const blockWindowDrop = (e) => {
    if (hasFiles(e)) e.preventDefault();
  };
  // A fader drag is one undo step: the pointer's release closes it.
  function onPointerDown(e) {
    const el = e.target;
    if (el && typeof el.matches === 'function' && el.matches('input[type="range"]')) pointerHeld = true;
  }
  function onPointerUp() {
    if (!pointerHeld) return;
    pointerHeld = false;
    history.seal();
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  root.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('dragover', blockWindowDrop);
  window.addEventListener('drop', blockWindowDrop);
  root.addEventListener('dragenter', onDragEnter);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);

  // Canvas colors come from CSS tokens: repaint when the theme or fonts change.
  const repaint = () => {
    waveform.invalidate();
    spectrum.invalidate();
  };
  const mql = safe(() => window.matchMedia('(prefers-color-scheme: dark)'));
  if (mql && mql.addEventListener) mql.addEventListener('change', repaint);
  const themeObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(repaint) : null;
  if (themeObserver) themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(repaint).catch(() => {});

  // One column below 900 px: the export panel moves right after the tape in the DOM (not
  // only visually with CSS order), so keyboard and screen-reader order match what is seen;
  // inside it the download button comes first and the format / rate options follow.
  const narrowMql = safe(() => window.matchMedia('(max-width: 899px)'));
  const placeExport = () => {
    const narrow = !!(narrowMql && narrowMql.matches);
    if (narrow) {
      if (ui.exportPanel.previousElementSibling !== ui.tape) ui.tape.after(ui.exportPanel);
      if (ui.exportTitle.nextElementSibling !== ui.exportActions) ui.exportTitle.after(ui.exportActions);
    } else {
      if (ui.exportPanel.parentElement !== ui.side) ui.side.prepend(ui.exportPanel);
      if (ui.rateField.nextElementSibling !== ui.exportActions) ui.rateField.after(ui.exportActions);
    }
  };
  placeExport();
  if (narrowMql && narrowMql.addEventListener) narrowMql.addEventListener('change', placeExport);

  const offLang = onLanguageChange(() => {
    relabel(root);
    ui.langSeg.setValue(getLanguage());
    waveform.setDecimal(decimalMark());
    renderAll();
    rack.refresh();
    meters.relabel();
    platforms.relabel();
  });
  try {
    document.documentElement.lang = getLanguage();
  } catch {
    /* ignore */
  }

  ready = true;
  renderAll();

  // Ask at boot whether files can be saved here (contract C4): inside an embedding host the
  // answer can take seconds, and a view that cannot save must say so before the user
  // masters a song, not after the first click on "Scarica". A 'none' from the probe (a host
  // whose API is not ready yet) is asked again a few times and when the page is back in
  // front; a 'none' from a failed save stays for the session.
  function probeSave() {
    if (destroyed) return;
    if (typeof deps.probeSaveSupport !== 'function') {
      state.saveSupport = 'browser';
      return;
    }
    Promise.resolve()
      .then(() => deps.probeSaveSupport())
      .then((v) => {
        if (saveBlockedBySave || destroyed) return;
        state.saveSupport = v === 'host' || v === 'browser' || v === 'none' ? v : 'browser';
        renderExport();
        if (state.saveSupport === 'none' && probeTries < PROBE_RETRY_MS.length) {
          clearTimeout(probeTimer);
          probeTimer = setTimeout(probeSave, PROBE_RETRY_MS[probeTries++]);
        }
      })
      .catch(() => {
        if (saveBlockedBySave || destroyed) return;
        state.saveSupport = 'browser';
        renderExport();
      });
  }
  const reprobe = () => {
    if (state.saveSupport === 'none' && !saveBlockedBySave && !document.hidden) probeSave();
  };
  window.addEventListener('focus', reprobe);
  document.addEventListener('visibilitychange', reprobe);
  probeSave();

  return {
    loadFiles,
    loadDemo,
    undo,
    redo,
    getHistory: () => history,
    getState: () => state,
    destroy() {
      destroyed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('dragover', blockWindowDrop);
      window.removeEventListener('drop', blockWindowDrop);
      if (mql && mql.removeEventListener) mql.removeEventListener('change', repaint);
      if (narrowMql && narrowMql.removeEventListener) narrowMql.removeEventListener('change', placeExport);
      if (phoneMql && phoneMql.removeEventListener) phoneMql.removeEventListener('change', placeCut);
      if (themeObserver) themeObserver.disconnect();
      window.removeEventListener('focus', reprobe);
      document.removeEventListener('visibilitychange', reprobe);
      clearTimeout(probeTimer);
      offLang();
      cancelAnimationFrame(liveRaf);
      cut.destroy();
      metaBox.destroy();
      safe(() => ui.skinPicker.destroy());
      waveform.destroy();
      spectrum.destroy();
      for (const tr of state.tracks) clearTimeout(tr.timer);
      safe(() => player.pause());
      clear(root);
    },
  };
}
