// Main-thread engine API (ARCHITECTURE §5). Runs the engine in a Web Worker when possible
// and transparently falls back to in-thread execution (same handlers, same results) when
// the worker cannot be created, does not answer the first ping within 3 s, or crashes.
// Worker URL: globalThis.__AM_WORKER_URL__ (single-file build: a classic Blob worker),
// else ./worker.js as a module worker (dev server).

import { createEngineState, handleMessage, handleCancel } from './handlers.js';
import { yieldToEventLoop } from '../dsp/util.js';

const PING_TIMEOUT_MS = 3000;

function toError(d) {
  return Object.assign(new Error((d && d.message) || 'engine error'), { code: (d && d.code) || 'render' });
}

/** C3: the structured-cloneable part of decodeFile()'s info (or null). */
function plainInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {};
  for (const k of ['codec', 'format', 'lossy', 'bitrateKbps', 'duration', 'sizeBytes', 'sampleRate', 'nativeSampleRate']) {
    const v = info[k];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

function copyChannels(audio) {
  const chs = (audio && audio.channels) || [];
  if (!chs.length) throw Object.assign(new Error('no audio channels'), { code: 'corrupt' });
  const out = chs.slice(0, 2).map((c) => Float32Array.from(c));
  if (out.length === 1) out.push(Float32Array.from(out[0]));
  if (chs.length > 2) {
    // >2 channels: let the handlers downmix (copy all)
    return chs.map((c) => Float32Array.from(c));
  }
  return out;
}

/** Engine client: worker-backed with an in-thread fallback. */
export class EngineClient {
  /**
   * @param {{ inline?: boolean, pingTimeoutMs?: number }} [opts] inline: force in-thread mode
   */
  constructor(opts = {}) {
    this._mode = 'worker';
    this._worker = null;
    this._inline = null;
    this._seq = 0;
    this._pending = new Map();
    this._tracks = new Map(); // trackId → { audio, info } (caller's, reference only, for a crash re-load)
    this._renderIds = new Map(); // trackId → latest render id
    this._ready = this._init(opts || {});
  }

  /** @returns {'worker'|'inline'} current execution mode (settles after the first ping) */
  get mode() {
    return this._mode;
  }

  async _init(opts) {
    let w = null;
    try {
      if (opts.inline || typeof Worker === 'undefined') throw new Error('no worker');
      const url = globalThis.__AM_WORKER_URL__;
      w = url ? new Worker(url) : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onMessage(e.data);
      w.onerror = (e) => this._onWorkerFailure(e);
      w.onmessageerror = (e) => this._onWorkerFailure(e);
      this._worker = w;
      await this._post({ type: 'ping' }, [], Number.isFinite(opts.pingTimeoutMs) ? opts.pingTimeoutMs : PING_TIMEOUT_MS);
      this._mode = 'worker';
    } catch {
      if (w) {
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
      }
      this._worker = null;
      this._goInline();
    }
  }

  _goInline() {
    this._mode = 'inline';
    if (!this._inline) this._inline = createEngineState();
  }

  _post(msg, transfer, timeoutMs, onProgress) {
    return new Promise((resolve, reject) => {
      if (!this._worker) {
        reject(Object.assign(new Error('worker unavailable'), { code: 'render' }));
        return;
      }
      const id = ++this._seq;
      const entry = { resolve, reject, onProgress, timer: 0, type: msg.type };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._pending.delete(id);
          reject(Object.assign(new Error('worker timeout'), { code: 'timeout' }));
        }, timeoutMs);
      }
      this._pending.set(id, entry);
      if (msg.type === 'render') this._renderIds.set(msg.trackId, id);
      try {
        this._worker.postMessage({ ...msg, id }, transfer || []);
      } catch (err) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        reject(Object.assign(new Error(String((err && err.message) || err)), { code: 'render' }));
      }
    });
  }

  _onMessage(d) {
    if (!d || d.id === undefined) return;
    const p = this._pending.get(d.id);
    if (!p) return;
    if (d.type === 'progress') {
      if (p.onProgress) {
        try {
          p.onProgress(d.stage, d.fraction);
        } catch {
          /* UI callback errors must not break the engine */
        }
      }
      return;
    }
    clearTimeout(p.timer);
    this._pending.delete(d.id);
    if (d.type === 'result') p.resolve(d.result);
    else p.reject(toError(d));
  }

  /** The worker died (or never loaded): reject what is in flight, continue in-thread. */
  _onWorkerFailure() {
    const w = this._worker;
    this._worker = null;
    if (w) {
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('engine worker failed'), { code: p.type === 'ping' ? 'timeout' : 'render' }));
      this._pending.delete(id);
    }
    this._goInline();
  }

  async _inlineCall(msg, onProgress) {
    const st = this._inline;
    if (msg.trackId !== undefined && msg.type !== 'load' && msg.type !== 'unload' && !st.tracks.has(msg.trackId) && this._tracks.has(msg.trackId)) {
      // re-load after a worker crash, from the caller's audio (copied)
      const { audio: a, info } = this._tracks.get(msg.trackId);
      await handleMessage(st, { type: 'load', trackId: msg.trackId, sampleRate: a.sampleRate, channels: copyChannels(a), info: plainInfo(info) });
    }
    const id = ++this._seq;
    if (msg.type === 'render') this._renderIds.set(msg.trackId, id);
    await yieldToEventLoop(); // let the UI paint before a long synchronous step
    return handleMessage(st, { ...msg, id }, { onProgress });
  }

  async _request(msg, transfer, onProgress) {
    await this._ready;
    if (this._mode === 'worker' && this._worker) return this._post(msg, transfer, 0, onProgress);
    return this._inlineCall(msg, onProgress);
  }

  /**
   * Load (or replace) a track. The channels are copied, so the caller keeps its own audio.
   * @param {any} trackId
   * @param {{ sampleRate: number, channels: Float32Array[] }} audio
   * @param {object|null} [info] decodeFile()'s info ({ codec, format, lossy, bitrateKbps, … })
   *   — C3: a lossy source then reports warn.lossySource
   */
  async loadTrack(trackId, audio, info = null) {
    this._tracks.set(trackId, { audio, info });
    const channels = copyChannels(audio);
    return this._request({ type: 'load', trackId, sampleRate: audio.sampleRate, channels, info: plainInfo(info) }, channels.map((c) => c.buffer));
  }

  /**
   * Extension: the track on screen keeps its render caches while other tracks
   * render in the background (fire and forget; without it the engine keeps the caches of
   * the most recently rendered tracks).
   * @param {any} trackId
   */
  focusTrack(trackId) {
    return this._request({ type: 'focus', trackId }).catch(() => false);
  }

  /** @returns {Promise<object>} AnalysisReport */
  async analyze(trackId) {
    return this._request({ type: 'analyze', trackId });
  }

  /**
   * Render with params. A newer render of the same track supersedes this one, which then
   * rejects with { code: 'cancelled' }.
   * @param {any} trackId
   * @param {object} params
   * @param {(stage: string, fraction: number) => void} [onProgress]
   * @returns {Promise<{ audio: { sampleRate: number, channels: Float32Array[] }, report: object,
   *   preview?: { sampleRate: number, channels: Float32Array[] } }>} preview (C2): present only
   *   when audio.sampleRate differs from the loaded track's — the master resampled back to
   *   the source rate (resample.js), for playback / waveform only; export uses `audio`.
   */
  async render(trackId, params, onProgress) {
    const res = await this._request({ type: 'render', trackId, params }, [], onProgress);
    const out = { audio: res.audio, report: res.report };
    if (res.preview) out.preview = res.preview;
    return out;
  }

  /**
   * Cancel the latest render of a track (extension; superseding does this implicitly).
   * @param {any} trackId
   */
  cancelRender(trackId) {
    const id = this._renderIds.get(trackId);
    if (id === undefined) return;
    if (this._mode === 'worker' && this._worker) {
      try {
        this._worker.postMessage({ type: 'cancel', id });
      } catch {
        /* ignore */
      }
    } else if (this._inline) handleCancel(this._inline, { id });
  }

  /**
   * Reference track: gated LTAS + loudness (channels copied).
   * @returns {Promise<{ ltas: number[], loudness: { integrated: number, lra: number, truePeakDb: number } }>}
   */
  async analyzeReference(audio) {
    const channels = copyChannels(audio);
    return this._request({ type: 'ltas', sampleRate: audio.sampleRate, channels }, channels.map((c) => c.buffer));
  }

  /** Free a track (fire and forget). */
  unload(trackId) {
    this._tracks.delete(trackId);
    this._renderIds.delete(trackId);
    return this._request({ type: 'unload', trackId }).catch(() => false);
  }
}
