// Engine request handlers shared by the Web Worker (worker.js) and the in-thread fallback
// (client.js inline mode): plain functions over a state object, one entry per loaded
// track (audio, render cache, analysis). Protocol: ARCHITECTURE §5.
//
// Supersede semantics: a newer render for the same track becomes the track's active
// render; the older one sees isCancelled() at its next stage boundary (renders yield
// between stages, so the newer request is dispatched in between) and rejects with
// code 'cancelled'. An explicit cancel message does the same for one render id.
//
// Memory: the render caches A / B (≈ 2 copies of the track) are kept for at most
// CACHE_TRACKS tracks — the focused one (optional 'focus' message: the track on screen)
// and the most recently rendered others; evicted tracks keep their input and analysis.
// Only the track being rendered also keeps B2 (the previous destination's post-glue audio).
//
// Preview (C2): when the master's rate differs from the loaded track's (Club 44.1 kHz,
// WAV 16-bit), the result also carries `preview` = the master resampled back to the
// source rate (resample.js), for playback / waveform only — the browser's own buffer
// resampling is linear interpolation.

import { analyzeTrack, stereoSpectrum } from '../analysis/analyze.js';
import { measure } from '../analysis/loudness.js';
import { ltas as ltasBands } from '../dsp/eq.js';
import { toStereo } from '../dsp/util.js';
import { resampleAudio } from '../dsp/resample.js';
import { renderMaster } from './chain.js';

/** Tracks whose render caches (A / B) are kept. */
export const CACHE_TRACKS = 2;

function engineError(message, code) {
  return Object.assign(new Error(message), { code });
}

function asChannels(channels) {
  if (!Array.isArray(channels) || !channels.length) throw engineError('no audio channels', 'corrupt');
  const out = channels.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c || [])));
  return toStereo(out);
}

function checkRate(sampleRate) {
  const sr = +sampleRate;
  if (!(sr >= 3000 && sr <= 768000)) throw engineError(`invalid sample rate ${sampleRate}`, 'corrupt');
  return sr;
}

/** @returns {{ tracks: Map, active: Map, cancelled: Set, lru: any[], focus: any }} fresh engine state */
export function createEngineState() {
  return { tracks: new Map(), active: new Map(), cancelled: new Set(), lru: [], focus: null };
}

/**
 * Decoder info (C3: decodeFile()'s info, or null) → the fields the engine uses. A lossy
 * source without a bitrate in its header gets one estimated from size and duration.
 */
function sourceInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const lossy = !!info.lossy;
  let kbps = Number.isFinite(info.bitrateKbps) && info.bitrateKbps > 0 ? info.bitrateKbps : null;
  if (lossy && !kbps && info.sizeBytes > 0 && info.duration > 0) kbps = Math.round((info.sizeBytes * 8) / info.duration / 1000);
  return { lossy, bitrateKbps: kbps, codec: typeof info.codec === 'string' ? info.codec : null, format: typeof info.format === 'string' ? info.format : null };
}

/**
 * Mark a track as just rendered; drop the render caches of tracks beyond CACHE_TRACKS.
 * Only the track being rendered keeps a second post-glue entry (cache.B2, the previous
 * destination's dynamics).
 */
function touchCaches(state, trackId) {
  state.lru = [trackId, ...state.lru.filter((id) => id !== trackId && state.tracks.has(id))];
  const keep = new Set();
  if (state.focus !== null && state.tracks.has(state.focus)) keep.add(state.focus);
  for (const id of state.lru) {
    if (keep.size >= CACHE_TRACKS) break;
    keep.add(id);
  }
  keep.add(trackId);
  for (const [id, t] of state.tracks) {
    if (!t.cache || id === trackId) continue;
    t.cache.B2 = null;
    if (keep.has(id)) continue;
    t.cache.A = null;
    t.cache.B = null;
  }
}

function track(state, trackId) {
  const t = state.tracks.get(trackId);
  if (!t) throw engineError(`unknown track ${trackId}`, 'render');
  return t;
}

/**
 * { type:'load', trackId, sampleRate, channels, info? } — takes ownership of the channels;
 * info = decodeFile()'s info (C3: lossy source → warn.lossySource).
 * @returns {{ trackId: any, duration: number, sampleRate: number }}
 */
export function handleLoad(state, msg) {
  const sampleRate = checkRate(msg.sampleRate);
  const channels = asChannels(msg.channels);
  state.tracks.set(msg.trackId, { audio: { sampleRate, channels }, cache: {}, analysis: null, info: sourceInfo(msg.info) });
  return { trackId: msg.trackId, duration: channels[0].length / sampleRate, sampleRate };
}

/** { type:'focus', trackId } — the track on screen keeps its render caches. */
export function handleFocus(state, msg) {
  state.focus = msg.trackId === undefined ? null : msg.trackId;
  return true;
}

/** { type:'analyze', trackId } → AnalysisReport (computed once per loaded track). */
export function handleAnalyze(state, msg) {
  const t = track(state, msg.trackId);
  if (!t.analysis) t.analysis = analyzeTrack(t.audio);
  return t.analysis;
}

/**
 * { type:'render', id, trackId, params } → { audio, report, preview? }. The output
 * channels are freshly allocated (safe to transfer). Input measurements come from the
 * analysis when it exists (no second loudness pass); the decoder info from the load.
 * preview (C2): only when audio.sampleRate differs from the track's — the master
 * resampled back to the source rate, for playback only.
 */
export async function handleRender(state, msg, { onProgress } = {}) {
  const t = track(state, msg.trackId);
  const id = msg.id;
  state.active.set(msg.trackId, id);
  touchCaches(state, msg.trackId);
  const isCancelled = () => state.cancelled.has(id) || state.active.get(msg.trackId) !== id || !state.tracks.has(msg.trackId);
  const an = t.analysis;
  const src = t.info || {};
  const inputInfo = {
    lossy: !!src.lossy, bitrateKbps: src.bitrateKbps,
    ...(an ? {
      loudness: an.loudness, ltas: an.spectrum && an.spectrum.ltas, cutoffHz: an.spectrum && an.spectrum.hfCutoffHz,
      clippingRuns: an.clipping && an.clipping.runs, bandCorrelation: an.stereo && an.stereo.bandCorrelation,
      correlation: an.stereo && an.stereo.correlation,
    } : {}),
  };
  try {
    const res = await renderMaster(t.audio, msg.params, { cache: t.cache, onProgress, isCancelled, inputInfo });
    if (isCancelled()) throw engineError('cancelled', 'cancelled');
    if (res.audio.sampleRate !== t.audio.sampleRate) {
      res.preview = resampleAudio(res.audio, t.audio.sampleRate);
      if (isCancelled()) throw engineError('cancelled', 'cancelled');
    }
    return res;
  } finally {
    state.cancelled.delete(id);
    if (state.active.get(msg.trackId) === id) state.active.delete(msg.trackId);
  }
}

/** { type:'cancel', id } — cancels that render at its next stage boundary. */
export function handleCancel(state, msg) {
  state.cancelled.add(msg.id);
  return true;
}

/**
 * { type:'ltas', sampleRate, channels } (reference track) → { ltas: number[31], loudness }
 * with the analysis estimator (gated mid LTAS), loudness = { integrated, lra, truePeakDb }.
 */
export function handleLtas(state, msg) {
  const sampleRate = checkRate(msg.sampleRate);
  const ch = asChannels(msg.channels);
  const sp = stereoSpectrum(ch, sampleRate, { overlap: 0.5 });
  const lt = Array.from(ltasBands(ch, sampleRate, { spectrum: sp.mid }), (v) => Math.round(v * 100) / 100);
  const m = measure(ch, sampleRate);
  return { ltas: lt, loudness: { integrated: m.integrated, lra: m.lra, truePeakDb: m.truePeakDb } };
}

/** { type:'unload', trackId } — frees the track (a running render is cancelled). */
export function handleUnload(state, msg) {
  state.tracks.delete(msg.trackId);
  state.active.delete(msg.trackId);
  state.lru = state.lru.filter((id) => id !== msg.trackId);
  if (state.focus === msg.trackId) state.focus = null;
  return true;
}

/**
 * Dispatch one request by type ('load'|'analyze'|'render'|'ltas'|'cancel'|'unload'|'focus'|'ping').
 * @param {object} state createEngineState()
 * @param {object} msg request message
 * @param {{ onProgress?: (stage: string, fraction: number) => void }} [hooks]
 * @returns {Promise<any>} result
 */
export async function handleMessage(state, msg, hooks = {}) {
  switch (msg && msg.type) {
    case 'ping': return { pong: true };
    case 'load': return handleLoad(state, msg);
    case 'analyze': return handleAnalyze(state, msg);
    case 'render': return handleRender(state, msg, hooks);
    case 'ltas': return handleLtas(state, msg);
    case 'cancel': return handleCancel(state, msg);
    case 'unload': return handleUnload(state, msg);
    case 'focus': return handleFocus(state, msg);
    default: throw engineError(`unknown request ${msg && msg.type}`, 'render');
  }
}
