// Two-lane waveform "tape": Originale on top, Master below, on the player's timeline:
// the master's once it exists (Player contract C5). Master sample 0 is the original's time
// `originalOffsetSec` (the head cut by trim), so the original lane starts that far into the
// original and is cropped to the master's length: both lanes line up with what is heard.
// Peaks: a min/max summary per audio buffer (blocks of 256 samples, computed once) is
// reduced to one min/max pair per device-pixel column and cached per width, so resizes
// and redraws never touch the full sample arrays again. Lanes are rendered into two
// offscreen layers (dim = not yet played, lit = played); a frame is then just two
// drawImage calls plus the playhead, cheap enough for 60 fps during playback.
// Seeking: mouse/pen seek on press and drag. A touch is undecided until it moves
// TOUCH_SLOP px: vertical = page scroll (touch-action: pan-y; the browser sends
// pointercancel, no seek), horizontal = scrub (pointer captured only then), lift without
// moving = tap seek.
// Cut mode (the "Taglia" bar, setCutMode(true)): a drag selects a span instead of
// scrubbing (onSelect), the IN / OUT edges can be grabbed (24 px tolerance for a finger,
// grips drawn at the bottom), a tap still seeks; the view can zoom (setView / zoomBy,
// ctrl/⌘ + wheel at the pointer) and scroll (horizontal wheel). Touch keeps the same
// undecided-then-decide logic, so a vertical swipe still scrolls the page. Leaving cut
// mode restores the whole-song view: the default view never changes.
// Pure helpers (summarize, peaksForWidth, niceTimeStep) are DOM-free for Node tests.

const BLOCK = 256;
const TOUCH_SLOP = 8; // CSS px a finger moves before a touch counts as a scroll or a scrub
const MOUSE_SLOP = 3; // CSS px a mouse drag needs before it selects (less = a click = seek)
const HANDLE_TOUCH = 24; // CSS px around an IN / OUT edge that grabs it with a finger
const HANDLE_MOUSE = 7; // … with a mouse or pen
const MIN_VIEW_SEC = 0.05; // deepest zoom: 50 ms across the canvas
const cache = new WeakMap(); // AudioData → { summary, widths: Map<width, peaks> }

/**
 * Min/max summary over all channels in blocks of `blockSize` samples.
 * NaN samples are ignored (comparisons with NaN are false).
 * @param {Float32Array[]} channels
 * @param {number} [blockSize]
 * @returns {{ blockSize: number, length: number, min: Float32Array, max: Float32Array }}
 */
export function summarize(channels, blockSize = BLOCK) {
  const n = channels && channels[0] ? channels[0].length : 0;
  const nb = Math.ceil(n / blockSize);
  const min = new Float32Array(nb);
  const max = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const s = b * blockSize;
    const e = Math.min(n, s + blockSize);
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = s; i < e; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
  }
  return { blockSize, length: n, min, max };
}

/**
 * One min/max pair per column. Uses the block summary when a column spans >= 2 blocks,
 * else reads the samples directly (short files / very wide canvases).
 * @param {{ blockSize: number, length: number, min: Float32Array, max: Float32Array }} summary
 * @param {Float32Array[]} channels
 * @param {number} width columns
 * @param {number} [spanSamples] timeline length in samples (default: from startSample to the
 *   end); a lane shorter than the timeline ends early, a longer one is cropped
 * @param {number} [startSample] lane sample drawn at column 0 (the original's trimmed head)
 * @returns {{ min: Float32Array, max: Float32Array, columns: number }}
 */
export function peaksForWidth(summary, channels, width, spanSamples, startSample = 0) {
  const w = Math.max(0, Math.floor(width));
  const min = new Float32Array(w);
  const max = new Float32Array(w);
  const n = summary.length;
  const start = Math.max(0, Math.round(startSample) || 0);
  const span = spanSamples > 0 ? spanSamples : n - start;
  if (start >= n || !w || !(span > 0)) return { min, max, columns: 0 };
  const spc = span / w;
  const bs = summary.blockSize;
  let columns = 0;
  for (let c = 0; c < w; c++) {
    const s = start + Math.floor(c * spc);
    if (s >= n) break;
    const e = Math.min(n, Math.max(s + 1, start + Math.floor((c + 1) * spc)));
    let lo = Infinity;
    let hi = -Infinity;
    if (spc >= bs * 2) {
      const b0 = Math.floor(s / bs);
      const b1 = Math.min(summary.min.length, Math.max(b0 + 1, Math.ceil(e / bs)));
      for (let b = b0; b < b1; b++) {
        if (summary.min[b] < lo) lo = summary.min[b];
        if (summary.max[b] > hi) hi = summary.max[b];
      }
    } else {
      for (let ch = 0; ch < channels.length; ch++) {
        const d = channels[ch];
        for (let i = s; i < e; i++) {
          const v = d[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
    columns = c + 1;
  }
  return { min, max, columns };
}

/** Tick spacing (s) so labels are at least `minPx` apart. */
export function niceTimeStep(duration, widthPx, minPx = 72) {
  // Sub-second steps only win when a zoomed view is shorter than ~widthPx/72 seconds.
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if ((s / Math.max(duration, 1e-6)) * widthPx >= minPx) return s;
  return 600;
}

function audioSeconds(a) {
  return a && a.channels && a.channels[0] ? a.channels[0].length / a.sampleRate : 0;
}

function peaksFor(audio, width, spanSamples, startSample) {
  let entry = cache.get(audio);
  if (!entry) {
    entry = { summary: summarize(audio.channels), widths: new Map() };
    cache.set(audio, entry);
  }
  const key = `${width}:${spanSamples}:${startSample}`;
  let p = entry.widths.get(key);
  if (!p) {
    p = peaksForWidth(entry.summary, audio.channels, width, spanSamples, startSample);
    if (entry.widths.size > 6) entry.widths.delete(entry.widths.keys().next().value);
    entry.widths.set(key, p);
  }
  return p;
}

/**
 * Axis label: "m:ss", or "m:ss.d" / "m:ss.dd" for sub-second steps (zoomed in cut mode),
 * with `mark` as the decimal mark (the UI language's: "," in Italian).
 * @param {number} sec
 * @param {number} [step] tick spacing (s)
 * @param {string} [mark]
 */
export function fmtTick(sec, step = 1, mark = '.') {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const q = Math.pow(10, dec);
  const r = Math.round(sec * q) / q;
  const m = Math.floor(r / 60);
  const s = r - m * 60;
  const whole = String(Math.floor(s + 1e-9)).padStart(2, '0');
  return dec ? `${m}:${whole}${mark}${String(Math.round((s - Math.floor(s + 1e-9)) * q)).padStart(dec, '0')}` : `${m}:${whole}`;
}

/** Canvas waveform view. All colors come from CSS custom properties on the canvas. */
export class Waveform {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onSeek?: (sec: number) => void, onHover?: (sec: number|null, xCss: number) => void,
   *   onSelect?: (sel: {start: number, end: number}|null, final: boolean) => void,
   *   onView?: (view: {start: number, end: number, duration: number}) => void }} [opts]
   */
  constructor(canvas, { onSeek, onHover, onSelect, onView } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onHover = onHover;
    this.onSelect = onSelect; // cut mode: selection dragged (final = pointer released)
    this.onView = onView; // cut mode: zoom / scroll changed
    this.cutMode = false;
    this.selection = null; // { start, end } timeline seconds, drawn in cut mode
    this.view = null; // { start, end } visible span (cut mode zoom); null = whole timeline
    this._g = null; // cut-mode gesture
    this.original = null;
    this.master = null;
    this.offsetSec = 0; // original time at master sample 0
    this.curves = { original: null, master: null };
    this.showCurves = false;
    this.active = 'master';
    this.time = 0;
    this.hoverX = null;
    this.placeholder = '';
    this.decimal = '.'; // decimal mark of sub-second axis labels (setDecimal)
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.layers = null;
    this.dirty = true;
    this._raf = 0;
    this._drag = false;
    this._touch = null; // undecided touch: { id, x, y }
    this._seekPending = null;
    this._bind();
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) this._ro.observe(canvas);
    this.resize();
  }

  /** Timeline length in seconds: the master's (the player's reference), else the original's. */
  get duration() {
    return this.master ? audioSeconds(this.master) : audioSeconds(this.original);
  }

  /** Original time (s) shown at the left edge: originalOffsetSec with a master, else 0. */
  get lead() {
    return this.master && this.original ? this.offsetSec : 0;
  }

  /**
   * @param {object|null} original AudioData
   * @param {object|null} master AudioData (the playback preview when there is one)
   * @param {{ originalOffsetSec?: number }} [opts] original time (s) at master sample 0
   */
  setAudio(original, master, opts) {
    const off = opts && Number(opts.originalOffsetSec) > 0 ? Number(opts.originalOffsetSec) : 0;
    if (original !== this.original || master !== this.master || off !== this.offsetSec) {
      // Same song on a shifted timeline (first master, another trim): a zoomed view keeps
      // showing the same music, like the selection does (cut.js). Another song resets it.
      const sameSong = !!original && original === this.original;
      const prevLead = this.lead;
      this.original = original || null;
      this.master = master || null;
      this.offsetSec = off;
      if (this.view) {
        const shift = sameSong ? prevLead - this.lead : 0;
        this.setView(this.view.start + shift, this.view.end + shift); // re-clamped to the new timeline
      }
      this.dirty = true;
      this.draw();
    }
  }

  /** Decimal mark of the sub-second axis labels ("," in Italian, "." in English). */
  setDecimal(mark) {
    const v = mark === ',' ? ',' : '.';
    if (v === this.decimal) return;
    this.decimal = v;
    this.dirty = true;
    this.draw();
  }

  /**
   * Cut mode on/off. Off restores the whole-song view and the normal seek gestures.
   * @param {boolean} on
   */
  setCutMode(on) {
    const v = !!on;
    if (v === this.cutMode) return;
    this.cutMode = v;
    this._g = null;
    this._cursor('');
    if (!v) this.view = null;
    this.dirty = true;
    this.draw();
    this._emitView();
  }

  /** Selection drawn in cut mode ({ start, end } timeline seconds, or null). Does not emit. */
  setSelection(sel) {
    const d = this.duration;
    this.selection = sel && d > 0 && sel.end > sel.start ? { start: Math.max(0, sel.start), end: Math.min(d, sel.end) } : null;
    this.draw();
  }

  /** Visible span in cut mode (whole timeline when it covers it); clamped, at least MIN_VIEW_SEC wide. */
  setView(start, end) {
    const d = this.duration;
    let v = null;
    if (this.cutMode && d > 0 && Number.isFinite(start) && Number.isFinite(end)) {
      const len = Math.min(d, Math.max(MIN_VIEW_SEC, end - start));
      const s = Math.min(Math.max(0, start), d - len);
      if (len < d - 1e-9) v = { start: s, end: s + len };
    }
    const same = (!v && !this.view) || (v && this.view && Math.abs(v.start - this.view.start) < 1e-9 && Math.abs(v.end - this.view.end) < 1e-9);
    this.view = v;
    if (same) return;
    this.dirty = true;
    this.draw();
    this._emitView();
  }

  /** Zoom by `factor` (< 1 = in) keeping `centerSec` at the same place on screen. */
  zoomBy(factor, centerSec) {
    const { start, end } = this._vr();
    const d = this.duration;
    if (!(d > 0) || !(factor > 0)) return;
    const c = Number.isFinite(centerSec) ? Math.min(end, Math.max(start, centerSec)) : (start + end) / 2;
    const len = Math.min(d, Math.max(MIN_VIEW_SEC, (end - start) * factor));
    const k = end > start ? (c - start) / (end - start) : 0.5;
    this.setView(c - k * len, c - k * len + len);
  }

  /** Scroll the view so it starts at `startSec` (length unchanged). */
  scrollTo(startSec) {
    const { start, end } = this._vr();
    this.setView(startSec, startSec + (end - start));
  }

  /** { start, end, duration } of what is visible. */
  getView() {
    return { ...this._vr(), duration: this.duration };
  }

  /** Visible span: the zoomed view, else the whole timeline. */
  _vr() {
    const d = this.duration;
    const v = this.view;
    if (!v || !(d > 0)) return { start: 0, end: d };
    return { start: Math.max(0, v.start), end: Math.min(d, v.end) };
  }

  _emitView() {
    if (this.onView) this.onView(this.getView());
  }

  _cursor(v) {
    if (this.canvas.style && this.canvas.style.cursor !== v) this.canvas.style.cursor = v;
  }

  setCurves(original, master) {
    this.curves = { original: original || null, master: master || null };
    this.dirty = true;
    this.draw();
  }

  setShowCurves(on) {
    this.showCurves = !!on;
    this.dirty = true;
    this.draw();
  }

  setActive(kind) {
    if (kind !== this.active) {
      this.active = kind;
      this.dirty = true;
      this.draw();
    }
  }

  setPlaceholder(text) {
    if (text !== this.placeholder) {
      this.placeholder = text || '';
      this.dirty = true;
      this.draw();
    }
  }

  setTime(sec) {
    const prev = this.time;
    this.time = Number.isFinite(sec) ? sec : 0;
    // Zoomed in: when the playhead MOVES out of the view (playback running off its end, a
    // keyboard seek, a loop wrapping back), page the view to it. A view the user scrolled
    // away from a paused playhead stays where it is (the time does not change then).
    const v = this.view;
    if (v && this.time !== prev && (this.time > v.end || this.time < v.start)) {
      const len = v.end - v.start;
      this.setView(this.time - len * 0.05, this.time + len * 0.95);
    }
    this.draw();
  }

  /** Re-read theme colors and redraw (call when the theme changes). */
  invalidate() {
    this.dirty = true;
    this.draw();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
    this.draw();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    cancelAnimationFrame(this._raf);
  }

  _colors() {
    const cs = getComputedStyle(this.canvas);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return {
      orig: v('--orig', '#8d97a8'),
      master: v('--master', '#36c5b0'),
      accent: v('--accent', '#f0a23b'),
      line: v('--line', '#262d37'),
      grid: v('--grid', 'rgba(255,255,255,.05)'),
      text: v('--fg-3', '#6c7685'),
      fg: v('--fg-2', '#a2abb8'),
      mono: v('--font-mono', 'monospace'),
      dim: Number(v('--wave-dim', '0.42')) || 0.42,
      ghost: Number(v('--wave-ghost', '0.22')) || 0.22,
    };
  }

  _geom() {
    const axis = Math.round(18 * this.dpr);
    const gap = Math.max(1, Math.round(this.dpr));
    const laneH = Math.max(4, Math.floor((this.h - axis - gap) / 2));
    return { axis, gap, laneH, top: [0, laneH + gap], axisY: laneH * 2 + gap };
  }

  _renderLayers() {
    const { w, h } = this;
    const mk = () => {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      return c;
    };
    if (!this.layers || this.layers.w !== w || this.layers.h !== h) this.layers = { w, h, dim: mk(), lit: mk() };
    const col = (this.colors = this._colors());
    const g = this._geom();
    const dur = this.duration;
    const lanes = [
      { audio: this.original, color: col.orig, kind: 'original', curve: this.curves.original },
      { audio: this.master, color: col.master, kind: 'master', curve: this.curves.master },
    ];
    const lead = this.lead;
    const vr = this._vr();
    const vlen = vr.end - vr.start;
    const spanSamples = (a) => Math.round(vlen * a.sampleRate);
    for (const which of ['dim', 'lit']) {
      const ctx = this.layers[which].getContext('2d');
      ctx.clearRect(0, 0, w, h);
      lanes.forEach((lane, i) => {
        const y0 = g.top[i];
        const mid = y0 + g.laneH / 2;
        const amp = (g.laneH / 2) * 0.92;
        ctx.fillStyle = col.grid;
        ctx.fillRect(0, Math.round(mid), w, Math.max(1, Math.round(this.dpr * 0.5)));
        if (!lane.audio) return;
        const shift = lane.kind === 'original' ? lead : 0; // lane seconds before the timeline's 0
        const p = peaksFor(lane.audio, w, spanSamples(lane.audio), Math.round((shift + vr.start) * lane.audio.sampleRate));
        const isActive = lane.kind === this.active;
        // Played part full strength, the rest dimmed; the lane not being heard is ghosted.
        const alpha = which === 'lit' ? (isActive ? 1 : 0.5) : isActive ? col.dim : col.ghost;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = lane.color;
        const minH = Math.max(1, this.dpr * 0.75);
        for (let x = 0; x < p.columns; x++) {
          const top = mid - Math.min(1, Math.max(-1, p.max[x])) * amp;
          const bot = mid - Math.min(1, Math.max(-1, p.min[x])) * amp;
          ctx.fillRect(x, top, 1, Math.max(minH, bot - top));
        }
        ctx.globalAlpha = 1;
        if (this.showCurves && lane.curve && lane.curve.curve && lane.curve.curve.length > 1 && dur > 0) {
          // Short-term loudness, −40…0 LUFS across the lane height.
          const c = lane.curve.curve;
          const hop = lane.curve.hop || 0.1;
          ctx.strokeStyle = which === 'lit' ? col.accent : col.fg;
          ctx.globalAlpha = which === 'lit' ? 0.95 : 0.5;
          ctx.lineWidth = 1.5 * this.dpr;
          ctx.beginPath();
          let started = false;
          for (let k = 0; k < c.length; k++) {
            const v = c[k];
            if (!Number.isFinite(v) || v < -60) {
              started = false;
              continue;
            }
            const x = ((k * hop - shift - vr.start) / vlen) * w;
            const y = y0 + g.laneH * (1 - Math.min(1, Math.max(0, (v + 40) / 40)));
            if (!started) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            started = true;
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
      // Placeholder text in the master lane while it is being prepared.
      if (!this.master && this.original && this.placeholder) {
        ctx.fillStyle = col.text;
        ctx.font = `${Math.round(11 * this.dpr)}px ${col.mono}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(this.placeholder.toUpperCase(), Math.round(12 * this.dpr), g.top[1] + g.laneH / 2);
      }
      // Time axis.
      ctx.fillStyle = col.line;
      ctx.fillRect(0, g.axisY, w, Math.max(1, Math.round(this.dpr)));
      if (dur > 0 && vlen > 0) {
        const step = niceTimeStep(vlen, w / this.dpr);
        ctx.font = `${Math.round(10 * this.dpr)}px ${col.mono}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = col.text;
        for (let k = Math.ceil(vr.start / step - 1e-9); k * step <= vr.end + 1e-6; k++) {
          const s = k * step;
          const x = Math.round(((s - vr.start) / vlen) * w);
          ctx.fillRect(x, g.axisY, Math.max(1, Math.round(this.dpr)), Math.round(4 * this.dpr));
          const label = fmtTick(s, step, this.decimal);
          const tw = ctx.measureText(label).width;
          if (x + 3 * this.dpr + tw < w) ctx.fillText(label, x + 3 * this.dpr, g.axisY + 4 * this.dpr);
        }
      }
    }
    this.dirty = false;
  }

  draw() {
    if (this._raf) return;
    const run = () => {
      this._raf = 0;
      this._paint();
    };
    this._raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : (run(), 0);
  }

  _paint() {
    const { ctx, w, h } = this;
    if (!ctx || w < 2) return;
    if (this.dirty || !this.layers) this._renderLayers();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.layers.dim, 0, 0);
    const dur = this.duration;
    const vr = this._vr();
    const vlen = vr.end - vr.start;
    const xAt = (sec) => (vlen > 0 ? ((sec - vr.start) / vlen) * w : 0);
    const px = dur > 0 ? Math.round(Math.min(w, Math.max(0, xAt(Math.min(this.time, dur))))) : 0;
    const headOn = dur > 0 && this.time >= vr.start - 1e-9 && this.time <= vr.end + 1e-9;
    if (px > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, px, h);
      ctx.clip();
      ctx.drawImage(this.layers.lit, 0, 0);
      ctx.restore();
    }
    const g = this._geom();
    const col = this.colors || this._colors();
    if (this.cutMode && this.selection && dur > 0) this._paintSelection(xAt, g, col);
    if (this.hoverX !== null && dur > 0) {
      ctx.fillStyle = col.fg;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(Math.round(this.hoverX * this.dpr), 0, Math.max(1, Math.round(this.dpr)), g.axisY);
      ctx.globalAlpha = 1;
    }
    if (headOn) {
      ctx.fillStyle = col.accent;
      const lw = Math.max(2, Math.round(1.5 * this.dpr));
      ctx.fillRect(px - Math.floor(lw / 2), 0, lw, g.axisY);
      // Small cap so the playhead reads as a tape head.
      ctx.beginPath();
      ctx.moveTo(px - 5 * this.dpr, 0);
      ctx.lineTo(px + 5 * this.dpr, 0);
      ctx.lineTo(px, 6 * this.dpr);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Selection tint over both lanes, IN / OUT edges and (cut mode) grips at the bottom. */
  _paintSelection(xAt, g, col) {
    const { ctx, w, dpr } = this;
    const x0 = xAt(this.selection.start);
    const x1 = xAt(this.selection.end);
    if (x1 < -4 * dpr || x0 > w + 4 * dpr) return;
    const a = Math.max(0, x0);
    const b = Math.min(w, x1);
    ctx.fillStyle = col.accent;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(a, 0, Math.max(1, b - a), g.axisY);
    ctx.globalAlpha = 1;
    const lw = Math.max(2, Math.round(2 * dpr));
    const gw = Math.round(12 * dpr);
    const gh = Math.round(22 * dpr);
    for (const x of [x0, x1]) {
      if (x < -lw || x > w + lw) continue;
      const xr = Math.round(x);
      ctx.fillStyle = col.accent;
      ctx.fillRect(xr - Math.floor(lw / 2), 0, lw, g.axisY);
      // Grip: a tab at the bottom of the lanes, where a thumb grabs it.
      ctx.fillRect(xr - gw / 2, g.axisY - gh, gw, gh);
      ctx.fillStyle = col.line;
      ctx.fillRect(xr - Math.round(2 * dpr), g.axisY - gh + Math.round(6 * dpr), Math.max(1, Math.round(dpr)), gh - Math.round(12 * dpr));
      ctx.fillRect(xr + Math.round(1 * dpr), g.axisY - gh + Math.round(6 * dpr), Math.max(1, Math.round(dpr)), gh - Math.round(12 * dpr));
    }
  }

  _timeAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.min(r.width, Math.max(0, clientX - r.left));
    const { start, end } = this._vr();
    return { sec: r.width > 0 ? start + (x / r.width) * (end - start) : 0, x };
  }

  /** 'start' | 'end' when CSS x is within `tol` px of an IN / OUT edge (the nearer one), else null. */
  _hitHandle(x, tol) {
    const sel = this.selection;
    if (!sel) return null;
    const r = this.canvas.getBoundingClientRect();
    const { start, end } = this._vr();
    if (!(r.width > 0) || !(end > start)) return null;
    const xs = ((sel.start - start) / (end - start)) * r.width;
    const xe = ((sel.end - start) / (end - start)) * r.width;
    const ds = Math.abs(x - xs);
    const de = Math.abs(x - xe);
    if (Math.min(ds, de) > tol) return null;
    return ds < de || (ds === de && x < xs) ? 'start' : 'end';
  }

  // Cut-mode gestures ----------------------------------------------------------------

  _cutDown(e, capture) {
    if (e.button > 0) return;
    const { sec, x } = this._timeAt(e.clientX);
    const touch = e.pointerType === 'touch';
    this._g = { id: e.pointerId, touch, x0: e.clientX, y0: e.clientY, sec0: sec, hit: this._hitHandle(x, touch ? HANDLE_TOUCH : HANDLE_MOUSE), mode: 'pending' };
    if (!touch) capture(e);
  }

  _cutMove(e, capture) {
    const { sec, x } = this._timeAt(e.clientX);
    const g = this._g;
    if (e.pointerType !== 'touch') {
      this.hoverX = x;
      if (!g) this._cursor(this._hitHandle(x, HANDLE_MOUSE) ? 'ew-resize' : 'crosshair');
      if (this.onHover) this.onHover(sec, x);
    }
    if (!g || g.id !== e.pointerId) {
      this.draw();
      return;
    }
    if (g.mode === 'pending') {
      const dx = Math.abs(e.clientX - g.x0);
      const dy = Math.abs(e.clientY - g.y0);
      if (g.touch) {
        if (!(dx >= TOUCH_SLOP && dx > dy)) {
          if (dy >= TOUCH_SLOP) this._g = null; // vertical: the page scrolls
          return;
        }
        capture(e);
      } else if (dx < MOUSE_SLOP) return;
      g.mode = g.hit ? 'handle' : 'select';
      g.which = g.hit;
    }
    let sel;
    if (g.mode === 'select') sel = { start: Math.min(g.sec0, sec), end: Math.max(g.sec0, sec) };
    else {
      const cur = this.selection || { start: sec, end: sec };
      const other = g.which === 'start' ? cur.end : cur.start;
      if ((g.which === 'start' && sec > other) || (g.which === 'end' && sec < other)) g.which = g.which === 'start' ? 'end' : 'start';
      sel = { start: Math.min(other, sec), end: Math.max(other, sec) };
    }
    this.selection = sel;
    this.draw();
    if (this.onSelect) this.onSelect({ ...sel }, false);
  }

  _cutEnd(e, seek, cancelled) {
    const g = this._g;
    this._g = null;
    if (!g || g.id !== e.pointerId) return;
    if (g.mode === 'pending') {
      if (!cancelled && this.duration) seek(this._timeAt(e.clientX).sec); // a tap / click
    } else if (this.onSelect) this.onSelect(this.selection ? { ...this.selection } : null, true);
  }

  _bind() {
    const c = this.canvas;
    const seek = (sec) => {
      this.time = sec;
      this.draw();
      // Throttle player seeks to one per frame while dragging.
      if (this._seekPending === null && this.onSeek) {
        this._seekPending = sec;
        requestAnimationFrame(() => {
          const s = this._seekPending;
          this._seekPending = null;
          if (s !== null) this.onSeek(s);
        });
      } else this._seekPending = sec;
    };
    const drag = (e) => {
      this._drag = true;
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported */
      }
    };
    c.addEventListener('pointerdown', (e) => {
      if (!this.duration || e.button > 0) return;
      if (this.cutMode) {
        this._cutDown(e, drag);
        return;
      }
      if (e.pointerType === 'touch') {
        // Undecided: no seek and no capture yet (capturing early can block the page scroll).
        this._touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      drag(e);
      seek(this._timeAt(e.clientX).sec);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.duration) return;
      if (this.cutMode) {
        this._cutMove(e, drag);
        return;
      }
      const { sec, x } = this._timeAt(e.clientX);
      const tc = this._touch;
      if (tc && tc.id === e.pointerId) {
        const dx = Math.abs(e.clientX - tc.x);
        const dy = Math.abs(e.clientY - tc.y);
        if (dx >= TOUCH_SLOP && dx > dy) {
          this._touch = null; // horizontal: scrub from here on
          drag(e);
        } else {
          if (dy >= TOUCH_SLOP) this._touch = null; // vertical: the page scrolls, never seek
          return;
        }
      }
      if (this._drag) seek(sec);
      if (e.pointerType !== 'touch') {
        this.hoverX = x;
        this.draw();
        if (this.onHover) this.onHover(sec, x);
      }
    });
    const end = (e) => {
      this._drag = false;
      this._touch = null;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
    };
    c.addEventListener('pointerup', (e) => {
      if (this.cutMode) {
        this._cutEnd(e, seek, false);
        end(e);
        return;
      }
      const tc = this._touch;
      if (tc && tc.id === e.pointerId && this.duration) seek(this._timeAt(e.clientX).sec); // a tap
      end(e);
    });
    c.addEventListener('pointercancel', (e) => {
      if (this.cutMode) this._cutEnd(e, seek, true);
      end(e); // e.g. the browser took the touch for a scroll
    });
    c.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.draw();
      if (this.onHover) this.onHover(null, 0);
    });
    // Cut mode only: ctrl/⌘ + wheel zooms at the pointer, a horizontal wheel (or shift +
    // wheel) scrolls a zoomed view; a plain vertical wheel always scrolls the page.
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.cutMode || !this.duration) return;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.zoomBy(Math.exp(Math.max(-200, Math.min(200, e.deltaY * unit)) * 0.004), this._timeAt(e.clientX).sec);
          return;
        }
        const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
        if (!dx || !this.view) return;
        e.preventDefault();
        const r = this.canvas.getBoundingClientRect();
        const { start, end } = this._vr();
        if (r.width > 0) this.scrollTo(start + ((dx * unit) / r.width) * (end - start));
      },
      { passive: false },
    );
    c.addEventListener('keydown', (e) => {
      const d = this.duration;
      if (!d || !this.onSeek) return;
      const big = e.shiftKey ? 15 : 5;
      let s = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') s = this.time + big;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') s = this.time - big;
      else if (e.key === 'Home') s = 0;
      else if (e.key === 'End') s = Math.max(0, d - 0.5);
      else if (e.key === 'PageUp') s = this.time + 30;
      else if (e.key === 'PageDown') s = this.time - 30;
      if (s === null) return;
      e.preventDefault();
      s = Math.min(d, Math.max(0, s));
      this.time = s;
      this.draw();
      this.onSeek(s);
    });
  }
}
