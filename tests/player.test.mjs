// Playback tests: the A/B Player against a mocked Web Audio API (offset of the original
// relative to a trimmed master, context sample rate, crossfade law, interruptions) and the
// waveform view against a stub canvas (lane alignment, touch gestures).
import { assert, approx } from './helpers.mjs';
import { Player } from '../src/audio/player.js';
import { Waveform, summarize, peaksForWidth, fmtTick } from '../src/ui/waveform.js';

const SR = 48000;
const LEAD = 0.012; // player.js: new voices start this long after a change

// --- mock Web Audio ----------------------------------------------------------------------

class Param {
  constructor(v) {
    this.value = v;
    this.ev = [];
  }
  setValueAtTime(v, t) {
    this.ev.push({ t, v, k: 'set' });
  }
  linearRampToValueAtTime(v, t) {
    this.ev.push({ t, v, k: 'lin' });
  }
  cancelScheduledValues(t) {
    this.ev = this.ev.filter((e) => e.t < t);
  }
  at(t) {
    let pv = this.value;
    let pt = 0;
    for (const e of [...this.ev].sort((a, b) => a.t - b.t)) {
      if (e.t > t) return e.k === 'lin' ? pv + ((e.v - pv) * (t - pt)) / (e.t - pt) : pv;
      pv = e.v;
      pt = e.t;
    }
    return pv;
  }
}

/**
 * Install a mock AudioContext. `rejectRate`: the constructor throws when given a
 * sampleRate (old browsers / unsupported rate). Returns the recorded contexts, sources
 * and createBuffer calls, plus restore().
 */
function installWebAudio({ deviceRate = SR, rejectRate = false } = {}) {
  const rec = { contexts: [], sources: [], buffers: [] };
  const node = () => ({ connect() {}, disconnect() {} });
  class Ctx {
    constructor(opts) {
      if (opts && opts.sampleRate && rejectRate) throw new Error('NotSupportedError: sampleRate');
      this.options = opts || null;
      this.sampleRate = opts && opts.sampleRate ? opts.sampleRate : deviceRate;
      this.currentTime = 0;
      this.state = 'suspended';
      this.resumes = 0;
      this.closed = false;
      this.onstatechange = null;
      this.destination = node();
      rec.contexts.push(this);
    }
    setState(s) {
      if (this.state === s) return;
      this.state = s;
      if (this.onstatechange) this.onstatechange();
    }
    resume() {
      this.resumes++;
      this.setState('running');
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      this.setState('closed');
      return Promise.resolve();
    }
    createGain() {
      return { ...node(), gain: new Param(1) };
    }
    createAnalyser() {
      return { ...node(), fftSize: 2048, smoothingTimeConstant: 0.8, context: this };
    }
    createBuffer(n, len, sr) {
      const b = { numberOfChannels: n, length: len, sampleRate: sr, duration: len / sr, data: [], copyToChannel(a, c) { this.data[c] = a; } };
      rec.buffers.push(b);
      return b;
    }
    createBufferSource() {
      const ctx = this;
      const s = {
        ...node(),
        ctx,
        buffer: null,
        onended: null,
        start(when, off, dur) {
          this.started = { when, off, dur };
        },
        stop(t) {
          this.stopped = t;
        },
      };
      rec.sources.push(s);
      return s;
    }
  }
  const prev = globalThis.AudioContext;
  globalThis.AudioContext = Ctx;
  rec.restore = () => {
    if (prev) globalThis.AudioContext = prev;
    else delete globalThis.AudioContext;
  };
  return rec;
}

/** Sample value a started source plays at context time T (null outside its span). */
function played(src, T) {
  const { when, off, dur } = src.started;
  if (T < when || T - when >= dur - 1e-12 || (src.stopped !== undefined && T >= src.stopped)) return null;
  const idx = Math.round((off + (T - when)) * src.buffer.sampleRate);
  return src.buffer.data[0][idx];
}

/** Like played(), frame-exact, and following a native loop (loopStart / loopEnd). */
function playedAt(src, T) {
  const { when, off, dur } = src.started;
  if (T < when || (src.stopped !== undefined && T >= src.stopped)) return null;
  const sr = src.buffer.sampleRate;
  let f = Math.round(off * sr) + Math.round((T - when) * sr);
  if (src.loop) {
    const ls = Math.round(src.loopStart * sr);
    const le = Math.round(src.loopEnd * sr);
    if (f >= le) f = ls + ((f - ls) % (le - ls));
  } else if (T - when >= dur - 1e-12) return null;
  return src.buffer.data[0][f];
}

const isFrame = (sec, sr) => Math.abs(sec * sr - Math.round(sec * sr)) < 1e-6;

/** Original = sample-index ramp (exact in float32); a trimmed master is a view into it. */
function rampTrack(seconds, sr = SR) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = i;
    R[i] = -i;
  }
  return { sampleRate: sr, channels: [L, R] };
}
function trimmed(orig, startSample, seconds) {
  const e = startSample + Math.round(seconds * orig.sampleRate);
  return { sampleRate: orig.sampleRate, channels: orig.channels.map((c) => c.subarray(startSample, e)) };
}

function newPlayer() {
  const ev = { ended: 0, states: [] };
  const p = new Player({ onEnded: () => ev.ended++, onStateChange: (s) => ev.states.push(s) });
  return { p, ev };
}

// --- stub canvas for Waveform ---------------------------------------------------------------

function installCanvas({ width = 400, height = 200 } = {}) {
  const calls = { fillRect: [], path: [], captures: [], releases: [], text: [] };
  const ctx2d = new Proxy(
    {},
    {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'fillRect') return (x, y, w, h) => calls.fillRect.push({ x, y, w, h, alpha: t.globalAlpha });
        if (k === 'moveTo' || k === 'lineTo') return (x, y) => calls.path.push({ x, y });
        if (k === 'fillText') return (text) => calls.text.push(String(text));
        return () => {};
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    },
  );
  const handlers = {};
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    setPointerCapture: (id) => calls.captures.push(id),
    releasePointerCapture: (id) => calls.releases.push(id),
  };
  const raf = [];
  const saved = {};
  const globals = {
    OffscreenCanvas: class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return ctx2d;
      }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => raf.push(fn),
    cancelAnimationFrame: () => {},
  };
  for (const k of Object.keys(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    globalThis[k] = globals[k];
  }
  const flush = () => {
    for (let guard = 0; raf.length && guard < 20; guard++) raf.splice(0).forEach((fn) => fn());
  };
  const fire = (type, e) => handlers[type] && handlers[type]({ button: 0, pointerId: 1, clientY: 50, ...e });
  const restore = () => {
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
  return { canvas, calls, flush, fire, restore };
}

export const tests = {
  // ------------------------------------------------------------------------- offset (C5)
  'player: trimmed master — the original plays originalOffsetSec ahead, every A/B moment is the same musical sample': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(5);
      const L = 19559; // real Suno export: report.trim.startSample at 48 kHz (407 ms)
      const mast = trimmed(orig, L, 4); // head and tail cut
      const { p } = newPlayer();
      p.setTracks(orig, mast, { originalOffsetSec: L / SR });
      assert(p.duration === 4 && p.currentTime === 0, 'master timeline is the reference');
      approx(p.originalOffsetSec, L / SR, 1e-12, 'offset exposed');
      await p.play();
      const [m, o] = wa.sources;
      assert(m.buffer.data[0] === mast.channels[0] && o.buffer.data[0] === orig.channels[0], 'voices');
      assert(m.started.when === o.started.when && isFrame(m.started.when, SR), 'same frame-aligned start');
      assert(m.started.off === 0, 'master from its sample 0');
      approx(o.started.off * SR, L, 1e-6, 'original from its sample L');
      approx(m.started.dur * SR, 4 * SR, 1e-6, 'master plays to its end');
      approx(o.started.dur * SR, 4 * SR, 1e-6, 'original cut at the master end');
      for (const k of [0, 1, 4800, 96000, 191999]) {
        const T = m.started.when + k / SR;
        assert(played(m, T) === played(o, T) && played(o, T) === L + k, `same sample at frame ${k}: ${played(m, T)} vs ${played(o, T)}`);
      }
      // A/B switch: a gain crossfade on the running, aligned voices (no restart, no jump).
      wa.contexts[0].currentTime = 1.0;
      p.setSource('original');
      assert(wa.sources.length === 2, 'A/B did not restart the voices');
      const T = 1.0 + 0.01;
      assert(played(m, T) === played(o, T), 'aligned during the crossfade');
      // Without the offset (the old behaviour) the original would be L samples behind:
      assert(played(o, T) - (T - o.started.when) * SR === L, 'original runs L samples ahead of master time');
      // With no master yet, the timeline is the original's own (offset not applied).
      p.pause();
      p.setTracks(orig, null, { originalOffsetSec: L / SR });
      assert(p.duration === 5 && p.originalOffsetSec === 0, 'no master: original timeline');
    } finally {
      wa.restore();
    }
  },

  'player: seek (also near 0 and past the end), natural end and replay keep the original offset': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(5);
      const L = 6138; // real Suno export (128 ms)
      const mast = trimmed(orig, L, 4.5);
      const { p, ev } = newPlayer();
      p.setTracks(orig, mast, { originalOffsetSec: L / SR });
      // Seeking while stopped only moves the position.
      p.seek(-3);
      assert(p.currentTime === 0, 'clamped at 0');
      p.seek(99);
      assert(p.currentTime === 4.5, 'clamped at the master duration');
      p.seek(0.00001);
      await p.play();
      const ctx = wa.contexts[0];
      let [m, o] = wa.sources;
      assert(m.started.off * SR === Math.round(0.00001 * SR) && Math.round(o.started.off * SR) === L + Math.round(0.00001 * SR), 'near-0 start keeps the offset');
      // Seek while playing: both restart at the same musical time.
      for (const s of [0, 2.5, 0.0004]) {
        ctx.currentTime += 0.5;
        p.seek(s);
        [m, o] = wa.sources.slice(-2);
        const iM = Math.round(m.started.off * SR);
        assert(iM === Math.round(s * SR) && Math.round(o.started.off * SR) === iM + L, `seek ${s}: master ${iM}, original ${o.started.off * SR}`);
        assert(m.started.when === o.started.when && isFrame(m.started.when, SR), 'frame-aligned restart');
        const T = m.started.when + 0.25;
        assert(played(m, T) === played(o, T), `aligned after seek ${s}`);
        approx(p.currentTime, s, 1 / SR, 'position = the seek target');
      }
      // Seek to the end finishes.
      p.seek(4.5);
      assert(!p.playing && ev.ended === 1 && p.currentTime === 4.5, 'seek to end → ended');
      // Natural end: the master (reference) voice ends playback.
      await p.play();
      [m, o] = wa.sources.slice(-2);
      assert(m.started.off === 0 && Math.round(o.started.off * SR) === L, 'play after end restarts at 0 (original at L)');
      ctx.currentTime += 10;
      o.onended && o.onended(); // the original is not the reference: no end
      assert(p.playing, 'original ending does not stop playback');
      m.onended();
      assert(!p.playing && ev.ended === 2 && p.currentTime === 4.5, 'natural end at the master duration');
    } finally {
      wa.restore();
    }
  },

  'player: first master arrival and trim changes between renders keep the musical time': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(6);
      const L1 = 19559;
      const L2 = 6138;
      const { p } = newPlayer();
      // 1. Only the original is loaded (master still rendering): its own timeline.
      p.setTracks(orig, null);
      await p.play();
      const ctx = wa.contexts[0];
      const [o0] = wa.sources;
      assert(wa.sources.length === 1 && o0.started.off === 0, 'original alone');
      ctx.currentTime = 2.0;
      const pos0 = p.currentTime;
      // 2. The first master arrives (trimmed by L1) while playing: position mapped by −L1.
      const mast1 = trimmed(orig, L1, 5);
      p.setTracks(orig, mast1, { originalOffsetSec: L1 / SR });
      assert(p.playing, 'keeps playing');
      let [m, o] = wa.sources.slice(-2);
      const T1 = o.started.when;
      ctx.currentTime = T1 + 0.1;
      const origTime = o0.started.off + (ctx.currentTime - o0.started.when); // where the original-only timeline would be
      assert(pos0 > 1.9, 'was playing');
      approx(p.currentTime, origTime - L1 / SR, 1 / SR, 'master time = original time − offset');
      const was = Math.round((o0.started.off + (T1 - o0.started.when)) * SR); // where the old voice would be
      assert(Math.abs(Math.round(o.started.off * SR) - was) <= 1, `original continues at its musical time (${o.started.off * SR} vs ${was})`);
      assert(played(m, T1 + 0.1) === played(o, T1 + 0.1), 'aligned after the first master');
      // 3. A re-render with another trim (head L2, other length) while playing: restart,
      //    same musical time, new alignment.
      ctx.currentTime = 3.0;
      const mast2 = trimmed(orig, L2, 5.5);
      const oPrev = o;
      p.replaceMastered(mast2, { originalOffsetSec: L2 / SR });
      [m, o] = wa.sources.slice(-2);
      assert(m.buffer.data[0] === mast2.channels[0] && o.buffer.data[0] === orig.channels[0], 'restarted pair');
      assert(oPrev.stopped !== undefined && oPrev.stopped <= o.started.when, 'old voices fade out first');
      const T2 = o.started.when;
      const was2 = Math.round((oPrev.started.off + (T2 - oPrev.started.when)) * SR);
      assert(Math.abs(Math.round(o.started.off * SR) - was2) <= 1, `musical time kept across the trim change (${o.started.off * SR} vs ${was2})`);
      assert(Math.round(o.started.off * SR) - Math.round(m.started.off * SR) === L2, 'new offset applied');
      assert(played(m, T2 + 0.3) === played(o, T2 + 0.3), 'aligned after the trim change');
      assert(p.duration === 5.5, 'new duration');
      // 4. Same trim, same length (an ordinary re-render): seamless 30 ms master swap,
      //    the original voice keeps running.
      ctx.currentTime = 3.5;
      const n = wa.sources.length;
      const mast3 = trimmed(orig, L2, 5.5);
      p.replaceMastered(mast3, { originalOffsetSec: L2 / SR });
      assert(wa.sources.length === n + 1, 'only a new master voice');
      const swap = wa.sources[n];
      assert(isFrame(swap.started.when, SR) && played(swap, swap.started.when + 0.1) === played(o, swap.started.when + 0.1), 'swapped master aligned with the running original');
      approx(m.stopped, swap.started.when + 0.03, 1e-9, 'old master retired after the crossfade');
      // 5. Paused: a trim change shifts the stored position by the offset difference.
      ctx.currentTime = 4.0;
      p.pause();
      const posM = p.currentTime;
      p.replaceMastered(mast1, { originalOffsetSec: L1 / SR });
      approx(p.currentTime, posM - (L1 - L2) / SR, 1e-9, 'paused position remapped');
      await p.play();
      [m, o] = wa.sources.slice(-2);
      assert(Math.round(o.started.off * SR) - Math.round(m.started.off * SR) === L1, 'resume with the new offset');
      assert(Math.abs(Math.round(o.started.off * SR) - Math.round((posM + L2 / SR) * SR)) <= 1, 'same musical time after resume');
      // 6. Master removed (setTracks with the same original, no master): back to original time.
      p.pause();
      const posM2 = p.currentTime;
      p.setTracks(orig, null);
      approx(p.currentTime, posM2 + L1 / SR, 1e-9, 'original time again');
    } finally {
      wa.restore();
    }
  },

  // ------------------------------------------------------------------------ crossfade
  'player: A/B crossfade is equal-gain (coherent versions sum to unity: no +3 dB swell), reversals are continuous': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(3);
      const { p } = newPlayer();
      p.setTracks(orig, trimmed(orig, 0, 3));
      await p.play();
      const ctx = wa.contexts[0];
      const n = p._n;
      ctx.currentTime = 1.0;
      p.setSource('original');
      let maxSwellDb = -Infinity;
      for (let k = 0; k <= 40; k++) {
        const t = 1.0 + (k / 40) * 0.02;
        const go = n.abOrig.gain.at(t);
        const gm = n.abMast.gain.at(t);
        // Identical (coherent) signals through both gains: amplitude = go + gm.
        maxSwellDb = Math.max(maxSwellDb, 20 * Math.log10(go + gm));
        approx(go + gm, 1, 1e-9, `equal gain at ${k}`);
        assert(go >= 0 && go <= 1 && gm >= 0 && gm <= 1, 'gains in range');
      }
      assert(maxSwellDb < 1e-6, `no swell: ${maxSwellDb} dB (equal-power gave +3.01 dB)`);
      approx(n.abOrig.gain.at(1.0201), 1, 1e-9, 'original fully on after 20 ms');
      approx(n.abMast.gain.at(1.0201), 0, 1e-9, 'master fully off after 20 ms');
      // Reverse halfway through a fade: continues from the current mix, no jump.
      ctx.currentTime = 2.0;
      p.setSource('master');
      ctx.currentTime = 2.005; // θ = 0.25
      const before = n.abMast.gain.at(2.005);
      approx(before, 0.25, 1e-9, 'quarter way');
      p.setSource('original');
      approx(n.abMast.gain.at(2.005), before, 1e-9, 'continuous at the reversal');
      approx(n.abOrig.gain.at(2.005) + n.abMast.gain.at(2.005), 1, 1e-9, 'still unity');
      approx(n.abMast.gain.at(2.005 + 0.005 + 1e-6), 0, 1e-6, 'back to the original in 5 ms (θ distance × 20 ms)');
      assert(wa.sources.length === 2, 'never restarts the voices');
    } finally {
      wa.restore();
    }
  },

  // ---------------------------------------------------------------------- sample rate
  'player: context runs at the original\'s rate (no per-voice resampling), rebuilt for another rate, falls back when rejected': async () => {
    let wa = installWebAudio({ deviceRate: 48000 });
    try {
      const o44 = rampTrack(3, 44100);
      const m44 = trimmed(o44, 4410, 2.5); // e.g. the 'club' master's source-rate preview
      const o48 = rampTrack(3, 48000);
      const m48 = trimmed(o48, 0, 3);
      const { p, ev } = newPlayer();
      p.setTracks(o44, m44, { originalOffsetSec: 0.1 });
      await p.play();
      let ctx = wa.contexts[0];
      assert(ctx.options && ctx.options.sampleRate === 44100 && ctx.sampleRate === 44100, 'context at the original rate');
      for (const s of wa.sources) assert(s.buffer.sampleRate === ctx.sampleRate && isFrame(s.started.when, 44100) && isFrame(s.started.off, 44100) && isFrame(s.started.dur, 44100), 'frame-exact voices: no interpolation');
      const an1 = p.analyser;
      // A track at another rate becomes active (the UI pauses first): rebuilt on the next play().
      p.pause();
      p.setTracks(o48, m48);
      await p.play();
      assert(ctx.closed && wa.contexts.length === 2, 'old context closed, new one built');
      ctx = wa.contexts[1];
      assert(ctx.sampleRate === 48000 && p.analyser !== an1 && p.analyser.context === ctx, 'new context at 48 kHz with its own analyser');
      for (const s of wa.sources.slice(-2)) assert(s.buffer.sampleRate === 48000 && s.ctx === ctx, 'voices on the new context');
      // Back to the 44.1 kHz track: buffers come from the cache (no new copies).
      const nBuf = wa.buffers.length;
      p.pause();
      p.setTracks(o44, m44, { originalOffsetSec: 0.1 });
      await p.play();
      assert(wa.contexts.length === 3 && wa.buffers.length === nBuf, 'AudioBuffer cache stays warm across contexts');
      // Rate change while playing: stops truthfully (no silent "playing"), next play rebuilds.
      p.setTracks(o48, m48);
      assert(!p.playing && ev.states[ev.states.length - 1].playing === false, 'paused on a rate change');
      await p.play();
      assert(p.playing && wa.contexts.length === 4 && wa.contexts[3].sampleRate === 48000, 'rebuilt on play');
      // Same rate again: no rebuild.
      p.pause();
      await p.play();
      assert(wa.contexts.length === 4, 'no rebuild at the same rate');
      p.dispose();
    } finally {
      wa.restore();
    }
    // A browser that rejects the rate: device-rate context, still plays, no rebuild loop.
    wa = installWebAudio({ deviceRate: 48000, rejectRate: true });
    try {
      const o44 = rampTrack(2, 44100);
      const { p } = newPlayer();
      p.setTracks(o44, trimmed(o44, 0, 2));
      await p.play();
      assert(wa.contexts.length === 1 && wa.contexts[0].options === null && wa.contexts[0].sampleRate === 48000, 'fallback context');
      assert(p.playing && wa.sources.length === 2, 'plays');
      p.pause();
      await p.play();
      assert(wa.contexts.length === 1, 'no rebuild loop');
    } finally {
      wa.restore();
    }
  },

  // --------------------------------------------------------------------- interruption
  'player: an interrupted/suspended context shows paused at the frozen position; the first tap resumes there': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(4);
      const { p, ev } = newPlayer();
      p.setTracks(orig, trimmed(orig, 4800, 3.5), { originalOffsetSec: 0.1 });
      await p.play();
      const ctx = wa.contexts[0];
      assert(p.playing && ctx.state === 'running', 'the initial suspended → running transition does not pause');
      ctx.currentTime = 1.5;
      ctx.setState('interrupted'); // iOS: phone call / Siri; the clock freezes
      assert(!p.playing && ev.states[ev.states.length - 1].playing === false, 'UI told: paused');
      const frozen = p.currentTime;
      approx(frozen, 1.5 - wa.sources[0].started.when + 0.008, 1e-9, 'position kept');
      ctx.currentTime = 1.5; // still frozen
      const n = wa.sources.length;
      await p.play(); // the first tap
      assert(ctx.resumes === 2 && ctx.state === 'running' && p.playing, 'resumed inside the tap');
      const [m, o] = wa.sources.slice(n);
      approx(m.started.off, frozen, 1 / SR, 'master resumes at the frozen position');
      assert(Math.round(o.started.off * SR) - Math.round(m.started.off * SR) === 4800, 'original offset kept');
      // Frozen without a statechange (missed event): play() still resumes and restarts.
      ctx.currentTime = 2.0;
      ctx.state = 'suspended';
      const pos = p.currentTime;
      const n2 = wa.sources.length;
      await p.play();
      assert(ctx.resumes === 3 && p.playing && wa.sources.length === n2 + 2, 'restarted');
      approx(wa.sources[n2].started.off, pos, 1 / SR, 'at the frozen position');
      // A later state change while paused does nothing.
      p.pause();
      const k = ev.states.length;
      ctx.setState('suspended');
      assert(ev.states.length === k && !p.playing, 'paused stays paused');
    } finally {
      wa.restore();
    }
  },

  // ----------------------------------------------------------------------- range / loop (cut)
  'player: range — a one-shot range plays [start, end) on both aligned voices, then stops and rewinds to its start': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(5);
      const L = 19559;
      const mast = trimmed(orig, L, 4);
      const { p, ev } = newPlayer();
      p.setTracks(orig, mast, { originalOffsetSec: L / SR });
      await p.playRange(1, 2.25);
      const [m, o] = wa.sources;
      assert(p.playing && p.range && p.range.start === 1 && p.range.end === 2.25 && !p.range.loop, `range ${JSON.stringify(p.range)}`);
      assert(m.started.when === o.started.when && isFrame(m.started.when, SR), 'same frame-aligned start');
      assert(Math.round(m.started.off * SR) === SR && Math.round(o.started.off * SR) === SR + L, 'both from the range start (original + offset)');
      assert(Math.round(m.started.dur * SR) === 1.25 * SR && Math.round(o.started.dur * SR) === 1.25 * SR, 'both stop at the range end');
      assert(!m.loop && !o.loop, 'no loop');
      for (const k of [0, 777, 59999]) assert(playedAt(m, m.started.when + k / SR) === playedAt(o, o.started.when + k / SR), `aligned at ${k}`);
      const ctx = wa.contexts[0];
      ctx.currentTime = m.started.when + 0.5;
      approx(p.currentTime, 1.5, 1e-9, 'position inside the range');
      ctx.currentTime = m.started.when + 1.4;
      approx(p.currentTime, 2.25, 1e-9, 'never reported past the range end');
      m.onended();
      assert(!p.playing && ev.ended === 1 && p.range === null, 'stopped, range mode left');
      approx(p.currentTime, 1, 1e-9, 'rewound to the range start');
      // Play after a range = normal playback from there, to the song end.
      await p.play();
      const [m2] = wa.sources.slice(-2);
      assert(Math.round(m2.started.off * SR) === SR && Math.round(m2.started.dur * SR) === 3 * SR, 'normal play from the range start');
      // Too short or degenerate ranges are refused.
      p.pause();
      const n = wa.sources.length;
      await p.playRange(1, 1.001);
      assert(wa.sources.length === n && !p.playing && p.range === null, 'a 1 ms range is refused');
    } finally {
      wa.restore();
    }
  },

  'player: loop — both voices loop the same musical range (original + offset), aligned through repeats, A/B and a master swap': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(5);
      const L = 6138;
      const mast = trimmed(orig, L, 4.5);
      const { p } = newPlayer();
      p.setTracks(orig, mast, { originalOffsetSec: L / SR });
      await p.playRange(1, 1.5, { loop: true });
      const ctx = wa.contexts[0];
      let [m, o] = wa.sources;
      assert(m.loop && o.loop && m.started.dur === undefined && o.started.dur === undefined, 'native loop, no stop time');
      assert(Math.round(m.loopStart * SR) === SR && Math.round(m.loopEnd * SR) === 1.5 * SR, 'master loops [1, 1.5)');
      assert(Math.round(o.loopStart * SR) === SR + L && Math.round(o.loopEnd * SR) === 1.5 * SR + L, 'original loops the same music');
      const w = m.started.when;
      for (const dt of [0.1, 0.4999, 0.5, 0.61, 1.3, 7.77]) {
        assert(playedAt(m, w + dt) === playedAt(o, w + dt), `aligned after ${dt} s: ${playedAt(m, w + dt)} vs ${playedAt(o, w + dt)}`);
        ctx.currentTime = w + dt;
        approx(p.currentTime, 1 + (dt % 0.5), 2 / SR, `position wraps at ${dt}`);
      }
      assert(playedAt(m, w + 0.61) === L + Math.round(1.11 * SR), 'repeat plays the range start again');
      // A/B: gain crossfade on the running loops.
      p.setSource('original');
      assert(wa.sources.length === 2, 'A/B did not restart the loops');
      // Seamless master swap during the loop: the new master voice loops in phase.
      ctx.currentTime = w + 3.2;
      p.replaceMastered(trimmed(orig, L, 4.5), { originalOffsetSec: L / SR });
      const swap = wa.sources[2];
      assert(wa.sources.length === 3 && swap.loop && Math.round(swap.loopStart * SR) === SR, 'swap voice loops too');
      for (const dt of [0.05, 0.9, 2.31]) assert(playedAt(swap, swap.started.when + dt) === playedAt(o, swap.started.when + dt), `swap aligned (+${dt})`);
      // Pause / resume keep the loop; a seek inside keeps it; a seek outside leaves it.
      ctx.currentTime = w + 4.1;
      p.pause();
      const posPaused = p.currentTime;
      assert(posPaused >= 1 && posPaused < 1.5 && p.range && p.range.loop, `paused inside the loop at ${posPaused}`);
      await p.play();
      [m, o] = wa.sources.slice(-2);
      assert(m.loop && o.loop && Math.abs(m.started.off - posPaused) < 1 / SR, 'resumed looping where it paused');
      ctx.currentTime += 0.2;
      p.seek(1.2);
      [m, o] = wa.sources.slice(-2);
      assert(p.range && m.loop && Math.round(m.started.off * SR) === Math.round(1.2 * SR), 'seek inside keeps looping');
      ctx.currentTime += 0.2;
      p.seek(3);
      [m, o] = wa.sources.slice(-2);
      assert(p.range === null && !m.loop && !o.loop && Math.round(m.started.dur * SR) === 1.5 * SR, 'seek outside: normal playback to the end');
    } finally {
      wa.restore();
    }
  },

  'player: loop switched on/off live and clearRange keep the position; a new trim keeps the looped music': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(6);
      const { p } = newPlayer();
      p.setTracks(orig, null);
      await p.playRange(2, 3);
      const ctx = wa.contexts[0];
      let [o] = wa.sources;
      ctx.currentTime = o.started.when + 0.4;
      p.setRangeLoop(true);
      [o] = wa.sources.slice(-1);
      assert(p.range.loop && o.loop && Math.abs(o.started.off - (2.4 + LEAD)) < 2 / SR, `loop on keeps the position (${o.started.off})`);
      ctx.currentTime = o.started.when + 1.3; // wrapped once
      const pos = p.currentTime;
      approx(pos, 2 + ((o.started.off - 2 + 1.3) % 1), 2 / SR, 'wrapped position');
      p.setRangeLoop(false);
      [o] = wa.sources.slice(-1);
      assert(!o.loop && Math.abs(o.started.off + o.started.dur - 3) < 2 / SR, 'loop off: plays on to the range end');
      ctx.currentTime += 0.1;
      p.clearRange();
      [o] = wa.sources.slice(-1);
      assert(p.range === null && p.playing && Math.abs(o.started.off + o.started.dur - 6) < 2 / SR, 'clearRange: continues to the song end');
      // The first master arrives (trim head 0.5 s) while a loop runs: same music keeps looping.
      await p.playRange(2, 3, { loop: true });
      const lead = 0.5;
      const mast = trimmed(orig, lead * SR, 5);
      p.setTracks(orig, mast, { originalOffsetSec: lead });
      const [m2, o2] = wa.sources.slice(-2);
      assert(p.range && p.range.loop && Math.abs(p.range.start - 1.5) < 1e-9 && Math.abs(p.range.end - 2.5) < 1e-9, `range moved to the master timeline: ${JSON.stringify(p.range)}`);
      assert(Math.round(o2.loopStart * SR) === 2 * SR && Math.round(m2.loopStart * SR) === 1.5 * SR, 'original still loops 2–3 s of the song');
      assert(playedAt(m2, m2.started.when + 1.7) === playedAt(o2, o2.started.when + 1.7), 'aligned after the timeline change');
      // A different song clears the range.
      p.setTracks(rampTrack(3), null);
      assert(p.range === null, 'new song: no range');
    } finally {
      wa.restore();
    }
  },

  'player: a loop ending at the song end stays aligned when the preview is a frame longer than original − lead': async () => {
    const wa = installWebAudio();
    try {
      const orig = rampTrack(5); // 240000 frames
      const L = 7200;
      // Source-rate preview of a trimmed master after an export-rate round trip (48 → 44.1 →
      // 48 kHz): one frame longer than the original has after the lead.
      const m = orig.channels[0].length - L + 1;
      const ramp = (sign) => Float32Array.from({ length: m }, (_, i) => sign * (L + i));
      const preview = { sampleRate: SR, channels: [ramp(1), ramp(-1)] };
      const { p } = newPlayer();
      p.setTracks(orig, preview, { originalOffsetSec: L / SR });
      const d = p.duration;
      await p.playRange(d - 2, d, { loop: true });
      const [mv, ov] = wa.sources;
      const len = (v) => Math.round(v.loopEnd * SR) - Math.round(v.loopStart * SR);
      assert(mv.loop && ov.loop && len(mv) === len(ov), `loop lengths: master ${len(mv)}, original ${len(ov)} frames`);
      assert(Math.round(ov.loopEnd * SR) <= orig.channels[0].length, 'the original loop fits its buffer');
      assert(p.range.end * SR <= orig.channels[0].length - L + 1e-6, `range end ${p.range.end * SR} past the original's room`);
      for (const dt of [0.5, 2.0001, 6.3, 20.7]) assert(playedAt(mv, mv.started.when + dt) === playedAt(ov, ov.started.when + dt), `aligned after ${dt} s (${playedAt(mv, mv.started.when + dt)} vs ${playedAt(ov, ov.started.when + dt)})`);
      // A one-shot range to the end and an ordinary range are unchanged.
      p.pause();
      await p.playRange(1, 2);
      assert(p.range.start === 1 && p.range.end === 2, JSON.stringify(p.range));
    } finally {
      wa.restore();
    }
  },

  'player: forget() drops the cached AudioBuffer of a song no longer loaded (an edit\'s unedited source); a loaded one stays': async () => {
    const wa = installWebAudio();
    try {
      const src = rampTrack(3);
      const edited = rampTrack(2);
      const { p } = newPlayer();
      p.setTracks(src, null);
      await p.play();
      p.pause();
      const n0 = wa.buffers.length;
      p.forget(src); // loaded right now: kept
      await p.play();
      p.pause();
      assert(wa.buffers.length === n0, 'a loaded song keeps its buffer');
      p.setTracks(edited, null);
      p.forget(src);
      await p.play();
      p.pause();
      const n1 = wa.buffers.length;
      assert(n1 === n0 + 1, 'the edited song gets its own buffer');
      // Undo back to the whole song: the buffer is rebuilt on the next play().
      p.setTracks(src, null);
      await p.play();
      p.pause();
      assert(wa.buffers.length === n1 + 1 && wa.buffers[wa.buffers.length - 1].length === src.channels[0].length, 'rebuilt after forget');
      p.forget(null);
      p.forget(undefined);
    } finally {
      wa.restore();
    }
  },

  // ------------------------------------------------------------------------ waveform (C5)
  'waveform: peaksForWidth with startSample equals an aligned view; the lane is cropped to the timeline': () => {
    const n = 3000;
    const ch = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      ch[0][i] = Math.sin(i * 0.37) * (i / n);
      ch[1][i] = Math.cos(i * 0.11) * 0.5;
    }
    const start = 777;
    const span = 1500; // shorter than n − start: cropped
    const view = ch.map((c) => c.subarray(start, start + span));
    // Direct-read regime (spc < 2 blocks): exact.
    const a = peaksForWidth(summarize(ch), ch, 600, span, start);
    const b = peaksForWidth(summarize(view), view, 600);
    assert(a.columns === 600 && b.columns === 600, `columns ${a.columns}`);
    for (let c = 0; c < 600; c++) assert(a.min[c] === b.min[c] && a.max[c] === b.max[c], `column ${c}`);
    // Block regime: each column is a block-aligned superset of its exact span.
    const big = [new Float32Array(240000), new Float32Array(240000)];
    for (let i = 0; i < big[0].length; i++) big[0][i] = big[1][i] = Math.sin(i * 0.001) * ((i % 9000) / 9000);
    const s0 = 19559;
    const w = 100;
    const spanB = 180000;
    const p = peaksForWidth(summarize(big), big, w, spanB, s0);
    assert(p.columns === w, 'all columns');
    for (const c of [0, 1, 50, 99]) {
      const s = s0 + Math.floor((c * spanB) / w);
      const e = s0 + Math.floor(((c + 1) * spanB) / w);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = s; i < e; i++) {
        lo = Math.min(lo, big[0][i]);
        hi = Math.max(hi, big[0][i]);
      }
      assert(p.min[c] <= lo + 1e-7 && p.max[c] >= hi - 1e-7, `superset at ${c}`);
      let lo2 = Infinity;
      let hi2 = -Infinity;
      for (let i = Math.floor(s / 256) * 256; i < Math.ceil(e / 256) * 256; i++) {
        lo2 = Math.min(lo2, big[0][i]);
        hi2 = Math.max(hi2, big[0][i]);
      }
      assert(p.min[c] >= lo2 - 1e-7 && p.max[c] <= hi2 + 1e-7, `within one block at ${c}`);
    }
    // Start at/after the end, or a non-positive span: nothing to draw.
    assert(peaksForWidth(summarize(ch), ch, 10, 100, n).columns === 0 && peaksForWidth(summarize(ch), ch, 10, 0, n - 1).columns === 10);
  },

  'waveform: lanes follow the player timeline — original lane starts at originalOffsetSec, timeline = master': () => {
    const env = installCanvas({ width: 400, height: 200 });
    try {
      const wf = new Waveform(env.canvas, {});
      env.flush();
      const sr = 8000;
      const lead = 1; // 1 s of silence at the head of the original, trimmed off the master
      const orig = { sampleRate: sr, channels: [new Float32Array(5 * sr), new Float32Array(5 * sr)] };
      for (let i = lead * sr; i < 5 * sr; i++) orig.channels[0][i] = orig.channels[1][i] = i % 2 ? 0.9 : -0.9;
      const mast = { sampleRate: sr, channels: orig.channels.map((c) => c.slice(lead * sr)) };
      wf.setAudio(orig, mast, { originalOffsetSec: lead });
      wf.setCurves({ curve: new Float32Array(50).fill(-20), hop: 0.1 }, { curve: new Float32Array(40).fill(-20), hop: 0.1 });
      wf.setShowCurves(true);
      env.calls.fillRect.length = 0;
      env.calls.path.length = 0;
      wf.invalidate();
      env.flush();
      assert(wf.duration === 4 && wf.lead === 1, `timeline = master (${wf.duration}), lead ${wf.lead}`);
      // Original lane = top lane (y < laneH = 90); 1-px columns are the waveform peaks.
      const cols = env.calls.fillRect.filter((r) => r.w === 1 && r.y < 90);
      assert(cols.length >= 400, `original columns drawn: ${cols.length}`);
      const quiet = cols.filter((r) => r.h < 10).map((r) => r.x);
      assert(quiet.length === 0, `no silent lead-in drawn at the left edge (silent columns: ${quiet.slice(0, 5)}…)`);
      // Original loudness curve shifted by the lead: its point for original time 1.0 s sits at x = 0.
      const xs = env.calls.path.filter((pt) => pt.y < 90).map((pt) => pt.x);
      approx(Math.min(...xs), -100, 1e-6, 'curve point at original t = 0 is lead/dur·w left of the edge');
      assert(xs.some((x) => Math.abs(x) < 1e-6), 'original t = 1 s at x = 0');
      // Without a master: the original's own timeline, no shift.
      wf.setAudio(orig, null, { originalOffsetSec: lead });
      assert(wf.duration === 5 && wf.lead === 0, 'original timeline');
      wf.destroy();
    } finally {
      env.restore();
    }
  },

  // ------------------------------------------------------------------------ touch
  'waveform: touch — a vertical swipe never seeks, a tap seeks on lift, a horizontal drag scrubs; mouse seeks on press': () => {
    const env = installCanvas({ width: 400, height: 200 });
    try {
      const seeks = [];
      const wf = new Waveform(env.canvas, { onSeek: (s) => seeks.push(s) });
      const a = { sampleRate: 1000, channels: [new Float32Array(100000), new Float32Array(100000)] }; // 100 s
      wf.setAudio(a, null);
      env.flush();
      const touch = (type, x, y, id = 1) => env.fire(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
      // Page scroll that starts on the waveform: browser cancels the pointer.
      touch('pointerdown', 100, 50);
      touch('pointermove', 102, 56);
      touch('pointermove', 103, 80);
      touch('pointermove', 140, 120); // later sideways drift of the same scroll
      touch('pointercancel', 140, 120);
      env.flush();
      assert(seeks.length === 0 && env.calls.captures.length === 0, `scroll: no seek, no capture (${seeks})`);
      // Scroll that ends with pointerup (no cancel): still no seek.
      touch('pointerdown', 200, 50);
      touch('pointermove', 201, 70);
      touch('pointerup', 201, 70);
      env.flush();
      assert(seeks.length === 0, 'scroll ending in pointerup: no seek');
      // Tap (small jitter below the slop): seek on lift.
      touch('pointerdown', 200, 50);
      touch('pointermove', 203, 53);
      touch('pointerup', 203, 53);
      env.flush();
      assert(seeks.length === 1, `tap seeks once (${seeks})`);
      approx(seeks[0], (203 / 400) * 100, 1e-9, 'tap position');
      assert(env.calls.captures.length === 0, 'tap needs no capture');
      // Horizontal scrub: capture only once the horizontal intent is clear.
      touch('pointerdown', 100, 50, 7);
      touch('pointermove', 105, 51, 7);
      env.flush();
      assert(seeks.length === 1 && env.calls.captures.length === 0, 'below the slop: undecided');
      touch('pointermove', 130, 52, 7);
      env.flush();
      assert(env.calls.captures.length === 1 && env.calls.captures[0] === 7, 'captured after intent');
      approx(seeks[seeks.length - 1], (130 / 400) * 100, 1e-9, 'scrub seeks');
      touch('pointermove', 300, 90, 7); // vertical drift during a scrub keeps scrubbing
      env.flush();
      approx(seeks[seeks.length - 1], 75, 1e-9, 'scrub follows the finger');
      const nScrub = seeks.length;
      touch('pointerup', 300, 90, 7);
      env.flush();
      assert(seeks.length === nScrub, 'lift after a scrub adds no extra seek');
      // Mouse and pen: immediate seek on press, as before.
      env.fire('pointerdown', { pointerType: 'mouse', clientX: 40, clientY: 10 });
      env.flush();
      approx(seeks[seeks.length - 1], 10, 1e-9, 'mouse press seeks');
      assert(env.calls.captures.length === 2, 'mouse captured at once');
      env.fire('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 150 });
      env.flush();
      approx(seeks[seeks.length - 1], 20, 1e-9, 'mouse drag seeks');
      env.fire('pointerup', { pointerType: 'mouse', clientX: 80, clientY: 150 });
      const n = seeks.length;
      env.fire('pointerdown', { pointerType: 'mouse', button: 2, clientX: 40 });
      env.flush();
      assert(seeks.length === n, 'right button ignored');
      wf.destroy();
    } finally {
      env.restore();
    }
  },
  // ------------------------------------------------------------------------ cut mode (waveform)
  'waveform: cut mode — drag selects (no seek), a click seeks, edges are grabbed and can cross; touch swipe still scrolls': () => {
    const env = installCanvas({ width: 400, height: 200 });
    try {
      const seeks = [];
      const sels = [];
      const wf = new Waveform(env.canvas, { onSeek: (s) => seeks.push(s), onSelect: (sel, fin) => sels.push({ ...sel, fin }) });
      const a = { sampleRate: 1000, channels: [new Float32Array(100000), new Float32Array(100000)] }; // 100 s
      wf.setAudio(a, null);
      wf.setCutMode(true);
      env.flush();
      const mouse = (type, x) => env.fire(type, { pointerType: 'mouse', clientX: x, clientY: 60 });
      // Drag from 40 px (10 s) to 120 px (30 s): a selection, never a seek.
      mouse('pointerdown', 40);
      mouse('pointermove', 41); // below the mouse slop: still a click
      mouse('pointermove', 120);
      mouse('pointerup', 120);
      env.flush();
      assert(seeks.length === 0, `no seek while selecting (${seeks})`);
      const last = sels[sels.length - 1];
      assert(last.fin && sels.some((x) => !x.fin) && Math.abs(last.start - 10) < 1e-9 && Math.abs(last.end - 30) < 1e-9, JSON.stringify(last));
      // A click (no movement) seeks and keeps the selection.
      mouse('pointerdown', 200);
      mouse('pointerup', 200);
      env.flush();
      approx(seeks[0], 50, 1e-9, 'click seeks');
      assert(wf.selection && wf.selection.start === 10, 'selection kept');
      // Grab the OUT edge (within 7 px) and drag it before IN: the edges swap.
      mouse('pointerdown', 123);
      mouse('pointermove', 20);
      mouse('pointerup', 20);
      const sw = sels[sels.length - 1];
      assert(Math.abs(sw.start - 5) < 1e-9 && Math.abs(sw.end - 10) < 1e-9, `edge dragged past the other: ${JSON.stringify(sw)}`);
      // Touch: vertical swipe = page scroll (no selection, no seek); horizontal drag
      // selects; a finger 20 px from an edge grabs it (24 px tolerance).
      const touch = (type, x, y, id = 5) => env.fire(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
      const n = sels.length;
      touch('pointerdown', 300, 50);
      touch('pointermove', 302, 70);
      touch('pointercancel', 302, 70);
      env.flush();
      assert(sels.length === n && seeks.length === 1, 'swipe: nothing');
      touch('pointerdown', 60, 50); // 20 px right of the OUT edge at 40 px (10 s)
      touch('pointermove', 90, 52);
      touch('pointerup', 90, 52);
      const tg = sels[sels.length - 1];
      assert(tg.fin && Math.abs(tg.start - 5) < 1e-9 && Math.abs(tg.end - 22.5) < 1e-9, `finger grabbed the edge: ${JSON.stringify(tg)}`);
      touch('pointerdown', 300, 50);
      touch('pointerup', 301, 51);
      env.flush();
      approx(seeks[seeks.length - 1], 75, 0.3, 'tap seeks');
      // Leaving cut mode: the old gestures (mouse drag = scrub) come back.
      wf.setCutMode(false);
      mouse('pointerdown', 100);
      mouse('pointermove', 140);
      mouse('pointerup', 140);
      env.flush();
      approx(seeks[seeks.length - 1], 35, 1e-9, 'normal scrub again');
      wf.destroy();
    } finally {
      env.restore();
    }
  },

  'waveform: cut-mode zoom — setView / zoomBy / ctrl+wheel at the pointer, horizontal wheel scrolls, pointer maps into the view; off restores': () => {
    const env = installCanvas({ width: 400, height: 200 });
    try {
      const views = [];
      const seeks = [];
      const wf = new Waveform(env.canvas, { onSeek: (s) => seeks.push(s), onView: (v) => views.push(v) });
      const a = { sampleRate: 1000, channels: [new Float32Array(100000), new Float32Array(100000)] };
      wf.setAudio(a, null);
      env.flush();
      wf.setView(10, 20);
      assert(wf.view === null, 'no zoom outside cut mode: the default view never changes');
      wf.setCutMode(true);
      wf.setView(10, 20);
      let v = wf.getView();
      assert(v.start === 10 && v.end === 20 && v.duration === 100, JSON.stringify(v));
      env.fire('pointerdown', { pointerType: 'mouse', clientX: 200, clientY: 60 });
      env.fire('pointerup', { pointerType: 'mouse', clientX: 200, clientY: 60 });
      env.flush();
      approx(seeks[seeks.length - 1], 15, 1e-9, 'a click maps into the view');
      wf.zoomBy(0.5, 12);
      v = wf.getView();
      approx(v.end - v.start, 5, 1e-9, 'zoomed in ×2');
      approx((12 - v.start) / (v.end - v.start), 0.2, 1e-9, 'center kept at the same place');
      let prevented = 0;
      const pd = () => prevented++;
      env.fire('wheel', { clientX: 100, deltaY: -100, deltaX: 0, ctrlKey: true, deltaMode: 0, preventDefault: pd });
      const z = wf.getView();
      assert(z.end - z.start < 5 && prevented === 1, `ctrl+wheel zooms in (${z.end - z.start})`);
      const before = wf.getView().start;
      env.fire('wheel', { clientX: 100, deltaY: 0, deltaX: 40, deltaMode: 0, preventDefault: pd });
      assert(wf.getView().start > before && prevented === 2, 'horizontal wheel scrolls');
      env.fire('wheel', { clientX: 100, deltaY: 50, deltaX: 0, deltaMode: 0, preventDefault: pd });
      assert(prevented === 2, 'a plain vertical wheel scrolls the page');
      wf.setView(-50, 1e9);
      assert(wf.view === null, 'covering everything = whole song');
      wf.setView(99.99, 100.02);
      v = wf.getView();
      assert(v.end <= 100 && v.end - v.start >= 0.05 - 1e-9, `clamped at the end, minimum width: ${JSON.stringify(v)}`);
      wf.setSelection({ start: 40, end: 60 });
      wf.setView(30, 40);
      // Playhead running off a zoomed view pages it forward.
      wf.setTime(39.9);
      wf.setTime(40.05);
      v = wf.getView();
      assert(v.start > 39.5 && v.end > 40.05, `followed the playhead: ${JSON.stringify(v)}`);
      const nViews = views.length;
      wf.setCutMode(false);
      assert(wf.view === null && views.length === nViews + 1 && views[views.length - 1].start === 0, 'cut mode off restores the whole song');
      wf.destroy();
    } finally {
      env.restore();
    }
  },

  'waveform: a new trim keeps a zoomed view on the same music (first master, another trim); another song only re-clamps': () => {
    const env = installCanvas({ width: 400, height: 200 });
    try {
      const wf = new Waveform(env.canvas);
      const orig = { sampleRate: 1000, channels: [new Float32Array(100000)] };
      const cut = (lead) => ({ sampleRate: 1000, channels: [new Float32Array(100000 - lead * 1000)] });
      wf.setAudio(orig, null);
      wf.setCutMode(true);
      wf.setView(5, 6);
      wf.setAudio(orig, cut(0.15), { originalOffsetSec: 0.15 }); // the first master, head trimmed by 0.15 s
      let v = wf.getView();
      approx(v.start, 4.85, 1e-9, 'view start follows the music');
      approx(v.end, 5.85, 1e-9, 'view end follows the music');
      wf.setAudio(orig, cut(0.4), { originalOffsetSec: 0.4 }); // a re-render with another trim
      v = wf.getView();
      approx(v.start, 4.6, 1e-9, 'another trim: same music again');
      wf.setAudio(orig, null); // the master dropped (e.g. re-mastering): original time
      approx(wf.getView().start, 5, 1e-9, 'back on the original timeline');
      const other = { sampleRate: 1000, channels: [new Float32Array(50000)] };
      wf.setAudio(other, null, {});
      approx(wf.getView().start, 5, 1e-9, 'another song: not shifted (cut.js resets the view)');
      wf.destroy();
    } finally {
      env.restore();
    }
  },

  'waveform: sub-second axis labels use the UI language\'s decimal mark': () => {
    assert(fmtTick(5.5, 0.5) === '0:05.5' && fmtTick(5.5, 0.5, ',') === '0:05,5', fmtTick(5.5, 0.5, ','));
    assert(fmtTick(65.25, 0.05, ',') === '1:05,25' && fmtTick(65, 5, ',') === '1:05', fmtTick(65.25, 0.05, ','));
    const env = installCanvas({ width: 400, height: 200 });
    try {
      const wf = new Waveform(env.canvas);
      wf.setAudio({ sampleRate: 1000, channels: [new Float32Array(20000)] }, null);
      wf.setCutMode(true);
      wf.setView(5, 6);
      env.flush();
      assert(env.calls.text.some((x) => /^0:05\.\d$/.test(x)) && !env.calls.text.some((x) => /,/.test(x)), env.calls.text.join(' '));
      env.calls.text.length = 0;
      wf.setDecimal(',');
      env.flush();
      assert(env.calls.text.some((x) => /^0:05,\d$/.test(x)) && !env.calls.text.some((x) => /\d\.\d/.test(x)), env.calls.text.join(' '));
      wf.destroy();
    } finally {
      env.restore();
    }
  },
};
