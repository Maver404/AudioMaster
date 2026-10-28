// Synchronized A/B player (browser only).
//
// Graph (built lazily on the first play(), i.e. inside a user gesture):
//
//   original src → voice gain ─┐
//                              ├→ abOrig → matchOrig ─┐
//   master src(s) → voice gain ┴→ abMast → matchMast ─┴→ transport → analyser → volume → out
//
// * Sample rate: the AudioContext runs at the ORIGINAL's rate and the UI hands over the
//   master at that rate too (EngineClient's `preview` when the export rate differs), so no
//   voice goes through AudioBufferSourceNode resampling (linear interpolation in Chromium
//   and WebKit, research/04 §1.2: −2 dB at 12 kHz plus aliases); the browser converts the
//   whole output stream to the device rate with a proper resampler instead. Start times,
//   offsets and lengths are snapped to whole sample frames, else Chromium interpolates
//   every voice by a constant fraction of a sample. A track at another rate rebuilds the
//   context on the next play() (inside that gesture); a browser that rejects the rate
//   gets a device-rate context (both voices then share the same resampling).
// * Timeline: the master's (duration, end of playback, currentTime, seek). Master sample 0
//   is the original's time `originalOffsetSec` (the head cut by trim), so the original
//   voice plays at offset + originalOffsetSec and is cut at the master's end. With no
//   master yet the timeline is the original's own. Whenever the master or the offset
//   changes, the position keeps its musical time (the original's time).
// * Both sources are started with the same start(when, …) so they stay
//   sample-synchronous; A/B is a gain crossfade, never a restart.
// * abOrig/abMast: 20 ms equal-gain (linear) A/B crossfade: original and master are the
//   same song, time-aligned and loudness-matched, i.e. coherent, so equal-power gains
//   would swell by +3 dB mid-fade. voice gains: 30 ms linear crossfade when a re-rendered
//   master replaces the playing one.
// * matchOrig/matchMast: loudness matching, attenuating only the louder version.
// * transport: 8 ms declick ramps on play/pause/seek.
// * A context that stops running on its own (iOS call, Siri, lock screen: 'interrupted' or
//   'suspended') switches the Player to paused at the frozen position, so the UI shows
//   Play and the next tap resumes (resume() inside that gesture).
// * Range playback (cut tool): playRange(start, end, { loop }) plays a span of the
//   timeline once (then stops and rewinds to its start) or loops it. Looping uses the
//   sources' native loopStart / loopEnd on frame-exact bounds: the original voice loops
//   [start, end] + originalOffsetSec, the master [start, end], both started with the same
//   when/offset, so they stay sample-aligned through every repeat and A/B stays a pure
//   gain crossfade. A seek outside the range, or clearRange(), leaves range mode.
// Automation uses cancelScheduledValues + setValueAtTime + linearRampToValueAtTime only
// (portable; setValueCurveAtTime throws on overlapping events and cancelAndHoldAtTime is
// missing in Firefox).

const AB_FADE = 0.02;
const SWAP_FADE = 0.03;
const DECLICK = 0.008;
const LEAD = 0.012; // >= DECLICK: new sources start after old ones have faded out
const MATCH_RAMP = 0.03;
const MAX_MATCH_DB = 40;
const MAX_OFFSET_SEC = 600;
const MIN_RANGE_SEC = 0.01; // shortest playable range (a loop must span more than a click)

const dbToGain = (db) => Math.pow(10, db / 20);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function audioDuration(a) {
  return a && a.channels && a.channels.length && a.sampleRate > 0 ? a.channels[0].length / a.sampleRate : 0;
}

/** originalOffsetSec option → seconds >= 0 (the trim only ever removes the head). */
function offsetOption(opts) {
  const v = opts ? Number(opts.originalOffsetSec) : 0;
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_OFFSET_SEC) : 0;
}

export class Player {
  /**
   * @param {{ onTime?: (seconds: number) => void, onEnded?: () => void,
   *   onStateChange?: (state: { playing: boolean, source: 'original'|'master', currentTime: number }) => void }} [callbacks]
   */
  constructor({ onTime, onEnded, onStateChange } = {}) {
    this._cb = { onTime, onEnded, onStateChange };
    this._ctx = null;
    this._ctxRate = 0; // rate requested for _ctx (the browser may have ignored it)
    this._n = null; // graph nodes
    this._orig = null;
    this._mast = null;
    this._origOffset = 0; // original time (s) at master sample 0
    this._bufCache = new WeakMap(); // AudioData → AudioBuffer
    this._source = 'master';
    this._playing = false;
    this._offset = 0; // position while stopped
    this._startCtx = 0; // ctx time at which _startOffset plays
    this._startOffset = 0;
    this._session = 0; // invalidates onended handlers of stopped voices
    this._voices = { orig: null, mast: null };
    this._ab = { t0: 0, t1: 0, from: 1, to: 1 }; // θ: 0 = original, 1 = master
    this._match = { enabled: false, lufsO: NaN, lufsM: NaN };
    this._volume = 1;
    this._tick = 0;
    this._tickIsRaf = false;
    this._range = null; // { start, end, loop } timeline seconds (frame-snapped): range mode
    this._vEnd = 0; // timeline time where the running voices stop
    this._vLoop = null; // { start, end } while the running voices loop
  }

  // --- public API ------------------------------------------------------------------------

  /** Seconds, master timeline (clamped to [0, duration]). */
  get currentTime() {
    const d = this.duration;
    if (this._playing && this._ctx) return this._posAt(this._ctx.currentTime);
    return clamp(this._offset, 0, d);
  }

  /** Master duration (original's when no master yet). */
  get duration() {
    return this._mast ? audioDuration(this._mast) : audioDuration(this._orig);
  }

  /** Original time (s) at timeline position 0: originalOffsetSec while a master is loaded, else 0. */
  get originalOffsetSec() {
    return this._lead();
  }

  get playing() {
    return this._playing;
  }

  /** 'original' | 'master' (the selection; with no master loaded the original is heard). */
  get source() {
    return this._source;
  }

  /** AnalyserNode after the A/B mix (fftSize 8192), or null before the first play(). */
  get analyser() {
    return this._n ? this._n.analyser : null;
  }

  /** Active range { start, end, loop } (timeline seconds) or null outside range mode. */
  get range() {
    return this._range ? { ...this._range } : null;
  }

  /**
   * Play the timeline span [start, end) once (playback then stops and the position goes
   * back to start) or in a loop. Already playing: restarts there at once (declicked).
   * `from` (inside the span) starts mid-range, e.g. to keep the position when a loop is
   * switched on during playback.
   * @param {number} start seconds
   * @param {number} end seconds
   * @param {{ loop?: boolean, from?: number }} [opts]
   */
  async playRange(start, end, { loop = false, from } = {}) {
    const r = this._snapRange(start, end);
    if (!r) return;
    r.loop = !!loop;
    this._range = r;
    const f = Number.isFinite(from) && from >= r.start && from < r.end - 1e-3 ? from : r.start;
    if (this._playing && this._ctx) {
      this._restartAt(f);
      this._emitState();
      return;
    }
    this._offset = f;
    await this.play();
  }

  /** Loop the active range or not (live: the voices restart at the current position). */
  setRangeLoop(loop) {
    const r = this._range;
    if (!r || r.loop === !!loop) return;
    r.loop = !!loop;
    if (!this._playing || !this._ctx) return;
    const at = this.currentTime + LEAD; // the restart lands LEAD later: keep the music continuous
    if (!r.loop && at >= r.end - 1e-3) this._finishRange();
    else this._restartAt(r.loop && at >= r.end ? r.start + ((at - r.start) % (r.end - r.start)) : at);
  }

  /** Leave range mode; playback (if any) continues normally from the current position. */
  clearRange() {
    if (!this._range) return;
    this._range = null;
    if (this._playing && this._ctx) {
      const at = this.currentTime + LEAD;
      if (at >= this.duration - 1e-3) {
        this._fadeOutAndStop();
        this._finish();
      } else this._restartAt(at);
    }
  }

  /**
   * Load a new pair. Keeps the position (and keeps playing) when it is the same song
   * (same original object or same duration), mapped to the same musical time when the
   * timeline changes (first master, other offset); otherwise stops and rewinds.
   * @param {{ sampleRate: number, channels: Float32Array[] }|null} original
   * @param {{ sampleRate: number, channels: Float32Array[] }|null} mastered
   * @param {{ originalOffsetSec?: number }} [opts] original time (s) at master sample 0
   */
  setTracks(original, mastered, opts) {
    const prevDur = this.duration;
    const prevLead = this._lead();
    const pos = this.currentTime;
    const sameSong = (!!original && original === this._orig) || (prevDur > 0 && Math.abs(audioDuration(mastered || original) - prevDur) < 1e-3);
    const wasPlaying = this._playing;
    const now = this._ctx ? this._ctx.currentTime : 0;
    if (wasPlaying) this._fadeOutAndStop();
    this._orig = original || null;
    this._mast = mastered || null;
    this._origOffset = offsetOption(opts);
    const dur = this.duration;
    const at = pos + prevLead - this._lead(); // same musical time on the new timeline
    if (sameSong) this._shiftRange(prevLead - this._lead());
    else this._range = null;
    // A/B gains may jump (e.g. first master arrives): do it while the transport is silent.
    this._applyAbAt(wasPlaying ? now + DECLICK : now);
    // A track at another sample rate needs a new context: rebuilt by the next play().
    const resume = wasPlaying && !this._rateChanged();
    if (sameSong && at < dur - 1e-3) {
      this._offset = Math.max(0, at);
      if (resume) this._startVoices(Math.min(Math.max(0, at + LEAD), dur - 1e-3), now + LEAD);
    } else {
      this._offset = sameSong ? dur : 0;
    }
    if (wasPlaying && !(resume && sameSong && at < dur - 1e-3)) {
      this._playing = false;
      this._stopTicker();
      this._emitState();
    }
    this._emitTime();
  }

  /**
   * Swap in a re-rendered master without interrupting playback (30 ms crossfade at the
   * current position). A master with a different duration or offset restarts both
   * sources at the same musical time instead (the timeline changed).
   * @param {{ sampleRate: number, channels: Float32Array[] }|null} mastered
   * @param {{ originalOffsetSec?: number }} [opts] original time (s) at master sample 0
   */
  replaceMastered(mastered, opts) {
    const prevDur = this.duration;
    const prevLead = this._lead();
    const pos = this.currentTime;
    const prevTheta = this._targetTheta();
    this._mast = mastered || null;
    this._origOffset = offsetOption(opts);
    const shift = prevLead - this._lead(); // timeline shift that keeps the musical time
    const dur = this.duration;
    this._shiftRange(shift);
    if (!this._playing || !this._ctx) {
      this._applyAbAt(this._ctx ? this._ctx.currentTime : 0);
      this._offset = clamp(this._offset + shift, 0, dur);
      this._emitTime();
      return;
    }
    const old = this._voices.mast;
    const buf = this._buffer(this._mast);
    const retimed = Math.abs(dur - prevDur) > 1e-3 || Math.abs(shift) > 1e-9 || this._targetTheta() !== prevTheta;
    if (!buf || !old || retimed || buf.sampleRate !== old.src.buffer.sampleRate) {
      const at = pos + shift + LEAD; // restart lands LEAD later, keep the music continuous
      if (at >= dur - 1e-3) {
        this._fadeOutAndStop();
        this._finish();
      } else this._restartAt(Math.max(0, at));
      return;
    }
    const ctx = this._ctx;
    const when = this._frameTime(ctx.currentTime + LEAD);
    const at = this._posAt(when);
    if (!this._vLoop && at >= this._vEnd - 0.01) return; // about to end anyway
    // Same loop / range end as the running original voice, so they stay aligned.
    const v = this._makeVoice(buf, this._n.abMast, when, at, this._vEnd - at, this._vLoop);
    if (!v) return;
    this._linearFade(v.gain.gain, when, SWAP_FADE, 0, 1);
    this._linearFade(old.gain.gain, when, SWAP_FADE, 1, 0);
    this._retireVoice(old, when + SWAP_FADE);
    this._voices.mast = v;
    this._bindEnd();
  }

  /** Start (or resume) playback. Must be called from a user gesture the first time. */
  async play() {
    if (!this._orig && !this._mast) return;
    const ctx = this._ensureContext();
    // resume() synchronously inside the gesture (Safari/iOS), also after an interruption
    const resumed = ctx.state !== 'running' && typeof ctx.resume === 'function' ? ctx.resume() : null;
    if (!this._playing) {
      const dur = this.duration;
      const r = this._range;
      if (r && (this._offset < r.start - 1e-6 || this._offset >= r.end - 1e-3)) this._range = null;
      if (this._offset >= dur - 1e-3) this._offset = 0; // play after end restarts
      this._playing = true;
      this._startVoices(this._offset, ctx.currentTime + LEAD);
      this._startTicker();
      this._emitState();
    } else if (resumed) {
      // 'Playing' on a frozen clock (stopped without a statechange): restart where it froze.
      this.seek(this.currentTime);
    }
    if (resumed) {
      try {
        await resumed;
      } catch {
        // autoplay policy: stays suspended until the next gesture; position math still holds
      }
    }
  }

  /** Pause (8 ms fade-out), keeping the position. */
  pause() {
    if (!this._playing) return;
    this._offset = this._posAt(this._ctx.currentTime + DECLICK);
    this._fadeOutAndStop();
    this._playing = false;
    this._stopTicker();
    this._emitTime();
    this._emitState();
  }

  toggle() {
    if (this._playing) this.pause();
    else return this.play();
    return undefined;
  }

  /** Jump to `seconds` on the master timeline (declicked restart while playing). */
  seek(seconds) {
    const d = this.duration;
    const s = clamp(Number(seconds) || 0, 0, d);
    const r = this._range;
    if (r && (s < r.start - 1e-6 || s >= r.end - 1e-3)) this._range = null; // a seek outside leaves range mode
    if (!this._playing || !this._ctx) {
      this._offset = s;
      this._emitTime();
      return;
    }
    if (s >= d - 1e-3) {
      this._fadeOutAndStop();
      this._finish();
      return;
    }
    this._restartAt(s);
  }

  /** Select what is heard: 20 ms equal-gain crossfade, both sources keep running. */
  setSource(source) {
    if (source !== 'original' && source !== 'master') throw new RangeError(`unknown source ${source}`);
    if (source === this._source) return;
    this._source = source;
    if (!this._ctx) {
      this._applyAbAt(0);
    } else {
      const now = this._ctx.currentTime;
      const from = this._thetaAt(now);
      const to = this._targetTheta();
      const dur = Math.max(0.005, AB_FADE * Math.abs(to - from));
      this._ab = { t0: now, t1: now + dur, from, to };
      this._abFade(now, dur, from, to);
    }
    this._emitState();
  }

  /**
   * Loudness-matched comparison: the louder version is turned down by the LUFS
   * difference (never boost the quieter one: no clipping, no added noise).
   * @param {boolean} enabled
   * @param {number} lufsOriginal integrated LUFS of the original
   * @param {number} lufsMaster integrated LUFS of the master
   */
  setLoudnessMatch(enabled, lufsOriginal, lufsMaster) {
    this._match = { enabled: !!enabled, lufsO: lufsOriginal, lufsM: lufsMaster };
    if (!this._n) return;
    const [gO, gM] = this._matchGains();
    const now = this._ctx.currentTime;
    this._rampTo(this._n.matchOrig.gain, now, gO, MATCH_RAMP);
    this._rampTo(this._n.matchMast.gain, now, gM, MATCH_RAMP);
  }

  /** Output volume, linear gain 0..1 (apply any taper in the UI). */
  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (this._n) this._rampTo(this._n.volume.gain, this._ctx.currentTime, this._volume, 0.02);
  }

  /**
   * Drop the cached AudioBuffer of `audio` unless it is loaded right now (e.g. the unedited
   * song a cut-tool edit keeps for undo): a later play() of it rebuilds the buffer.
   * @param {{ sampleRate: number, channels: Float32Array[] }|null} audio
   */
  forget(audio) {
    if (audio && audio !== this._orig && audio !== this._mast) this._bufCache.delete(audio);
  }

  /** Stop and release the AudioContext (the Player can be reused; play() rebuilds it). */
  dispose() {
    if (this._playing) this.pause();
    this._stopTicker();
    this._closeContext();
    this._bufCache = new WeakMap();
  }

  // --- internals -------------------------------------------------------------------------

  /** Original time at timeline 0 (only meaningful with a master: else the timeline is the original's). */
  _lead() {
    return this._mast ? this._origOffset : 0;
  }

  /** Timeline position at context time t while playing (wraps inside a running loop). */
  _posAt(t) {
    const raw = this._startOffset + Math.max(0, t - this._startCtx);
    const lp = this._vLoop;
    if (lp && raw >= lp.end) return lp.start + ((raw - lp.start) % (lp.end - lp.start));
    return clamp(raw, 0, Math.min(this.duration, this._vEnd > 0 ? this._vEnd : Infinity));
  }

  /** [start, end) clamped to the timeline and snapped to the reference's frames; null if too short. */
  _snapRange(start, end) {
    const d = this.duration;
    const ref = this._mast || this._orig;
    const sr = ref && ref.sampleRate > 0 ? ref.sampleRate : 0;
    if (!(d > 0) || !sr) return null;
    const snap = (x) => Math.round(clamp(Number(x) || 0, 0, d) * sr) / sr;
    const s = snap(start);
    let e = Math.min(snap(end), Math.floor(d * sr + 1e-6) / sr);
    if (this._mast && this._orig) {
      // Both voices must reach the end: a source-rate preview of a trimmed master can come
      // back one frame longer than original − lead (export-rate round trip), and an original
      // loop clamped to its buffer would then be one frame shorter than the master's, so the
      // two would drift apart by a frame on every repeat.
      e = Math.min(e, Math.floor((audioDuration(this._orig) - this._lead()) * sr + 1e-6) / sr);
    }
    return e - s >= MIN_RANGE_SEC ? { start: s, end: e, loop: false } : null;
  }

  /** Keep the active range on the same music when the timeline shifts (new trim / first master). */
  _shiftRange(shift) {
    const r = this._range;
    if (!r) return;
    const nr = Math.abs(shift) > 1e-9 || r.end > this.duration ? this._snapRange(r.start + shift, r.end + shift) : r;
    this._range = nr && nr.start >= 0 ? { ...nr, loop: r.loop } : null;
  }

  /** Rate the context should run at: the original's (the master's when there is none). */
  _wantRate() {
    const a = this._orig || this._mast;
    return a && a.sampleRate > 0 ? a.sampleRate : 0;
  }

  _rateChanged() {
    const want = this._wantRate();
    return !!this._ctx && want > 0 && want !== this._ctxRate;
  }

  _ensureContext() {
    const want = this._wantRate();
    if (this._ctx && (!want || want === this._ctxRate)) return this._ctx;
    if (this._ctx) this._closeContext(); // a track at another rate is loaded (never while playing)
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw Object.assign(new Error('Web Audio is not available in this browser'), { code: 'unsupported' });
    // iOS: play through the ringer/silent switch like a music app (Safari 16.4+).
    try {
      if (globalThis.navigator && navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {
      // optional API
    }
    let ctx = null;
    if (want) {
      try {
        ctx = new AC({ sampleRate: want });
      } catch {
        ctx = null; // rate rejected: device rate (the buffers are then resampled per voice)
      }
    }
    if (!ctx) ctx = new AC();
    this._ctxRate = want;
    ctx.onstatechange = () => this._onContextState(ctx);
    const g = () => ctx.createGain();
    const n = { abOrig: g(), abMast: g(), matchOrig: g(), matchMast: g(), transport: g(), volume: g(), analyser: ctx.createAnalyser() };
    n.analyser.fftSize = 8192;
    n.analyser.smoothingTimeConstant = 0.75;
    n.abOrig.connect(n.matchOrig);
    n.abMast.connect(n.matchMast);
    n.matchOrig.connect(n.transport);
    n.matchMast.connect(n.transport);
    n.transport.connect(n.analyser);
    n.analyser.connect(n.volume);
    n.volume.connect(ctx.destination);
    n.transport.gain.value = 0;
    n.volume.gain.value = this._volume;
    this._ctx = ctx;
    this._n = n;
    const [gO, gM] = this._matchGains();
    n.matchOrig.gain.value = gO;
    n.matchMast.gain.value = gM;
    this._applyAbAt(0);
    return ctx;
  }

  /** Release the context (the AudioBuffer cache is context-independent and stays warm). */
  _closeContext() {
    const ctx = this._ctx;
    if (!ctx) return;
    ctx.onstatechange = null;
    try {
      const p = typeof ctx.close === 'function' ? ctx.close() : null;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // already closed
    }
    this._session++;
    this._ctx = null;
    this._n = null;
    this._voices = { orig: null, mast: null };
  }

  /** The context stopped running on its own (iOS interruption, OS suspend): show paused. */
  _onContextState(ctx) {
    if (ctx !== this._ctx || !this._playing || ctx.state === 'running') return;
    this.pause();
  }

  /** Context time snapped up to the next sample frame (sub-frame starts are interpolated). */
  _frameTime(t) {
    const sr = this._ctx ? this._ctx.sampleRate : 0;
    return sr > 0 ? Math.ceil(t * sr - 1e-6) / sr : t;
  }

  _buffer(audio) {
    if (!audio || !this._ctx) return null;
    let b = this._bufCache.get(audio);
    if (b) return b;
    const chs = audio.channels;
    const len = chs && chs.length ? chs[0].length : 0;
    if (!len) return null;
    b = this._ctx.createBuffer(Math.min(chs.length, 2), len, audio.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      if (typeof b.copyToChannel === 'function') b.copyToChannel(chs[c], c);
      else b.getChannelData(c).set(chs[c]);
    }
    this._bufCache.set(audio, b);
    return b;
  }

  /**
   * One source from buffer second `offset` for `length` s, both snapped to whole frames;
   * with `loop` ({ start, end } buffer seconds) it repeats that span (frame-exact bounds)
   * until stopped instead.
   */
  _makeVoice(buf, dest, when, offset, length, loop = null) {
    if (!buf) return null;
    const sr = buf.sampleRate;
    const i0 = Math.max(0, Math.round(offset * sr));
    const frames = Math.min(buf.length - i0, Math.round(length * sr));
    if (loop ? !(i0 < buf.length) : !(frames >= 1)) return null; // e.g. original shorter than offset
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(dest);
    if (loop) {
      src.loop = true;
      src.loopStart = Math.max(0, Math.round(loop.start * sr)) / sr;
      src.loopEnd = Math.min(buf.length, Math.round(loop.end * sr)) / sr;
      src.start(when, i0 / sr);
    } else {
      // third argument: never play past the master's end (or the range's)
      src.start(when, i0 / sr, frames / sr);
    }
    const v = { src, gain };
    src.onended = () => this._disposeVoice(v);
    return v;
  }

  _disposeVoice(v) {
    try {
      v.src.disconnect();
      v.gain.disconnect();
    } catch {
      // already disconnected
    }
  }

  _retireVoice(v, at) {
    if (!v) return;
    v.src.onended = () => this._disposeVoice(v);
    try {
      v.src.stop(at);
    } catch {
      this._disposeVoice(v);
    }
  }

  _startVoices(offset, when) {
    const dur = this.duration;
    const bufM = this._buffer(this._mast);
    const bufO = this._buffer(this._orig);
    const ref = bufM || bufO;
    const r = this._range;
    const lead = this._lead();
    const loop = r && r.loop ? { start: r.start, end: r.end } : null;
    const vEnd = r ? Math.min(r.end, dur) : dur;
    // Timeline position on the reference's frame grid; the original runs originalOffsetSec ahead.
    let pos = ref ? Math.round(offset * ref.sampleRate) / ref.sampleRate : offset;
    if (loop && (pos < loop.start || pos >= loop.end)) pos = loop.start;
    const at = this._frameTime(when);
    this._session++;
    this._voices.mast = this._makeVoice(bufM, this._n.abMast, at, pos, vEnd - pos, loop);
    this._voices.orig = this._makeVoice(bufO, this._n.abOrig, at, pos + lead, vEnd - pos, loop ? { start: loop.start + lead, end: loop.end + lead } : null);
    this._vEnd = vEnd;
    this._vLoop = loop;
    this._startCtx = at;
    this._startOffset = pos;
    const tg = this._n.transport.gain;
    tg.cancelScheduledValues(at);
    tg.setValueAtTime(0, at);
    tg.linearRampToValueAtTime(1, at + DECLICK);
    this._bindEnd();
  }

  /** The reference voice (master, else original) ends playback. */
  _bindEnd() {
    const session = this._session;
    const ref = this._voices.mast || this._voices.orig;
    if (!ref) return;
    ref.src.onended = () => {
      this._disposeVoice(ref);
      if (session !== this._session || !this._playing) return;
      if (this._range && !this._range.loop) this._finishRange();
      else this._finish();
    };
  }

  _fadeOutAndStop() {
    const ctx = this._ctx;
    if (!ctx || !this._n) return;
    const now = ctx.currentTime;
    const tg = this._n.transport.gain;
    tg.cancelScheduledValues(now);
    tg.setValueAtTime(tg.value, now);
    tg.linearRampToValueAtTime(0, now + DECLICK);
    this._session++;
    this._retireVoice(this._voices.orig, now + DECLICK);
    this._retireVoice(this._voices.mast, now + DECLICK);
    this._voices = { orig: null, mast: null };
  }

  _restartAt(s) {
    const now = this._ctx.currentTime;
    this._fadeOutAndStop(); // transport reaches 0 at now + DECLICK
    this._applyAbAt(now + DECLICK); // pending A/B changes land in the silent gap
    // Start strictly after the fade-out ramp ends: cancelScheduledValues(when) must not
    // remove that ramp's end event.
    this._startVoices(s, now + LEAD);
    this._emitTime();
  }

  _finish() {
    this._session++;
    this._retireVoice(this._voices.orig, this._ctx ? this._ctx.currentTime : 0);
    this._retireVoice(this._voices.mast, this._ctx ? this._ctx.currentTime : 0);
    this._voices = { orig: null, mast: null };
    this._playing = false;
    this._offset = this.duration; // next play() restarts from 0
    this._stopTicker();
    this._emitTime();
    if (this._cb.onEnded) this._cb.onEnded();
    this._emitState();
  }

  /** A one-shot range reached its end: stop, leave range mode, rewind to the range start. */
  _finishRange() {
    const r = this._range;
    const now = this._ctx ? this._ctx.currentTime : 0;
    this._fadeOutAndStop();
    this._session++;
    this._retireVoice(this._voices.orig, now);
    this._retireVoice(this._voices.mast, now);
    this._voices = { orig: null, mast: null };
    this._playing = false;
    this._range = null;
    this._offset = r ? r.start : 0;
    this._stopTicker();
    this._emitTime();
    if (this._cb.onEnded) this._cb.onEnded();
    this._emitState();
  }

  // A/B gains -------------------------------------------------------------------------

  _targetTheta() {
    if (!this._mast) return 0;
    if (!this._orig) return 1;
    return this._source === 'master' ? 1 : 0;
  }

  _thetaAt(t) {
    const a = this._ab;
    if (t >= a.t1 || a.t1 <= a.t0) return a.to;
    if (t <= a.t0) return a.from;
    return a.from + ((a.to - a.from) * (t - a.t0)) / (a.t1 - a.t0);
  }

  /** Set the A/B gains to the current selection at time t (no fade). */
  _applyAbAt(t) {
    const th = this._targetTheta();
    this._ab = { t0: t, t1: t, from: th, to: th };
    if (!this._n) return;
    for (const [param, v] of [[this._n.abOrig.gain, 1 - th], [this._n.abMast.gain, th]]) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(v, t);
    }
  }

  /** Equal-gain A/B ramp: original 1 − θ, master θ (coherent signals: the sum stays at unity). */
  _abFade(now, dur, from, to) {
    for (const [param, a, b] of [[this._n.abOrig.gain, 1 - from, 1 - to], [this._n.abMast.gain, from, to]]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(a, now);
      param.linearRampToValueAtTime(b, now + dur);
    }
  }

  _linearFade(param, at, dur, from, to) {
    param.cancelScheduledValues(at);
    param.setValueAtTime(from, at);
    param.linearRampToValueAtTime(to, at + dur);
  }

  _rampTo(param, now, value, dur) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + dur);
  }

  _matchGains() {
    const { enabled, lufsO, lufsM } = this._match;
    if (!enabled || !Number.isFinite(lufsO) || !Number.isFinite(lufsM)) return [1, 1];
    const diff = clamp(lufsM - lufsO, -MAX_MATCH_DB, MAX_MATCH_DB);
    return diff > 0 ? [1, dbToGain(-diff)] : [dbToGain(diff), 1];
  }

  // callbacks ---------------------------------------------------------------------------

  _emitTime() {
    if (this._cb.onTime) this._cb.onTime(this.currentTime);
  }

  _emitState() {
    if (this._cb.onStateChange) this._cb.onStateChange({ playing: this._playing, source: this._source, currentTime: this.currentTime });
  }

  _startTicker() {
    this._stopTicker();
    const raf = globalThis.requestAnimationFrame;
    const step = () => {
      if (!this._playing) return;
      this._emitTime();
      // Safety net if onended was missed (e.g. context suspended at the boundary).
      if (this._ctx && !this._vLoop && this._ctx.currentTime - this._startCtx > this._vEnd - this._startOffset + 0.25) {
        if (this._range) this._finishRange();
        else this._finish();
        return;
      }
      if (this._tickIsRaf) this._tick = raf(step);
    };
    if (typeof raf === 'function') {
      this._tickIsRaf = true;
      this._tick = raf(step);
    } else {
      this._tickIsRaf = false;
      this._tick = setInterval(step, 50);
      if (this._tick && typeof this._tick.unref === 'function') this._tick.unref();
    }
  }

  _stopTicker() {
    if (!this._tick) return;
    if (this._tickIsRaf) globalThis.cancelAnimationFrame(this._tick);
    else clearInterval(this._tick);
    this._tick = 0;
  }
}
