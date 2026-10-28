// Spectrum view: live AnalyserNode spectrum (log frequency 20 Hz–20 kHz, 1/6-octave
// smoothing) over static long-term overlays — original LTAS, master LTAS and, in a
// strip below, the net static EQ the master applied.
// Scales: the LTAS overlays are absolute band powers of unknown reference, so the plot
// is labelled in dB relative to the loudest band. The live curve is per-bin dBFS; it is
// aligned to the overlay of the source being heard by a slowly tracked offset (mean over
// 100 Hz–5 kHz), so it moves around the long-term curve instead of floating elsewhere.
// When "Volume pareggiato" is on, the master overlay is shifted by the LUFS difference
// so the two averages compare tone, not level (same rule as the A/B).

/** ISO 1/3-octave centres used by eq.js ltas() (31 bands, 20 Hz … 20 kHz). */
export const ISO_THIRD_OCTAVE = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

const F_MIN = 20;
const F_MAX = 20000;
const RANGE_DB = 60;
const EQ_RANGE_DB = 6;

/** `points` log-spaced frequencies between fMin and fMax (inclusive). */
export function logFrequencies(points = 192, fMin = F_MIN, fMax = F_MAX) {
  const out = new Float64Array(points);
  const r = Math.log(fMax / fMin);
  for (let i = 0; i < points; i++) out[i] = fMin * Math.exp((r * i) / Math.max(1, points - 1));
  return out;
}

/**
 * Fractional FFT-bin edges of a `widthOct` band around each frequency.
 * @returns {{ lo: Float64Array, hi: Float64Array, nBins: number }}
 */
export function makeBandMap(freqs, fftSize, sampleRate, widthOct = 1 / 6) {
  const nBins = fftSize / 2;
  const k = Math.pow(2, widthOct / 2);
  const toBin = (f) => Math.min(nBins - 1, Math.max(0, (f * fftSize) / sampleRate));
  const lo = new Float64Array(freqs.length);
  const hi = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    lo[i] = toBin(freqs[i] / k);
    hi[i] = toBin(freqs[i] * k);
  }
  return { lo, hi, nBins };
}

/**
 * 1/N-octave smoothing: mean POWER of the bins inside each band (fractional edges
 * weighted), linear power interpolation when a band is narrower than one bin.
 * bandPower: report the band's total power (mean × width in bins) instead of the
 * per-bin density. Constant-bandwidth FFT bins make pink noise fall 3 dB/oct; band
 * power is flat for pink noise, which is how 1/3-octave LTAS curves are read, so the
 * live curve and the long-term overlays share one shape convention.
 * @param {Float32Array} binsDb analyser dB values (−Infinity allowed)
 * @param {{ lo: Float64Array, hi: Float64Array }} map
 * @param {Float32Array} [out]
 * @param {Float64Array} [scratch] power buffer, length >= binsDb.length
 * @param {{ bandPower?: boolean }} [opts]
 * @returns {Float32Array} dB per band (floored at −160)
 */
export function smoothSpectrum(binsDb, map, out = new Float32Array(map.lo.length), scratch, opts = {}) {
  const n = binsDb.length;
  const pow = scratch && scratch.length >= n ? scratch : new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = binsDb[i];
    pow[i] = Number.isFinite(d) ? Math.pow(10, d / 10) : 0;
  }
  for (let b = 0; b < map.lo.length; b++) {
    const lo = map.lo[b];
    const hi = map.hi[b];
    let p;
    if (hi - lo < 1) {
      const c = (lo + hi) / 2;
      const i0 = Math.floor(c);
      const i1 = Math.min(n - 1, i0 + 1);
      const f = c - i0;
      p = pow[i0] * (1 - f) + pow[i1] * f;
    } else {
      const a = Math.floor(lo);
      const z = Math.min(n - 1, Math.floor(hi));
      let s = 0;
      let wsum = 0;
      for (let i = a; i <= z; i++) {
        const w = Math.min(i + 1, hi) - Math.max(i, lo);
        if (w <= 0) continue;
        s += pow[i] * w;
        wsum += w;
      }
      p = wsum > 0 ? s / wsum : 0;
    }
    if (opts.bandPower) p *= Math.max(hi - lo, 1e-3);
    out[b] = p > 1e-16 ? 10 * Math.log10(p) : -160;
  }
  return out;
}

/** Log-frequency → x in [0, 1]. */
export function freqToX(f) {
  return Math.log(Math.max(F_MIN, Math.min(F_MAX, f)) / F_MIN) / Math.log(F_MAX / F_MIN);
}

/**
 * Energy mean (dB of the mean power) of `db` values whose frequency is within [f0, f1].
 * Energy, not dB, averaging: the loud bands set the level, so tonal valleys in the live
 * spectrum cannot drag the alignment and push its peaks off the top of the plot.
 */
function energyMean(db, freqs, f0, f1, floor = -150) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < db.length; i++) {
    const f = freqs[i];
    const v = db[i];
    if (f >= f0 && f <= f1 && Number.isFinite(v) && v > floor) {
      s += Math.pow(10, v / 10);
      n++;
    }
  }
  return n && s > 0 ? 10 * Math.log10(s / n) : null;
}

function validCurve(a) {
  return a && a.length === ISO_THIRD_OCTAVE.length && Array.prototype.some.call(a, (v) => Number.isFinite(v));
}

/** Canvas spectrum view. Colors come from CSS custom properties on the canvas. */
export class Spectrum {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overlays = { original: null, master: null, eq: null, masterOffsetDb: 0 };
    this.analyser = null;
    this.liveKind = 'master';
    this.running = false;
    this.freqs = logFrequencies(192);
    this.map = null;
    this.mapKey = '';
    this.bins = null;
    this.scratch = null;
    this.live = new Float32Array(this.freqs.length);
    this.liveValid = false;
    this.liveOffset = null;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this._raf = 0;
    this._frame = 0;
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) this._ro.observe(canvas);
    this.resize();
  }

  /** @param {{ original?: number[], master?: number[], eq?: number[], masterOffsetDb?: number }} o */
  setOverlays(o) {
    this.overlays = {
      original: validCurve(o.original) ? Array.from(o.original) : null,
      master: validCurve(o.master) ? Array.from(o.master) : null,
      eq: validCurve(o.eq) ? Array.from(o.eq) : null,
      masterOffsetDb: Number.isFinite(o.masterOffsetDb) ? o.masterOffsetDb : 0,
    };
    this.draw();
  }

  /** Attach the player's analyser (or null) and which source is audible. */
  setLive(analyser, kind) {
    this.analyser = analyser || null;
    if (kind && kind !== this.liveKind) this.liveOffset = null;
    this.liveKind = kind || this.liveKind;
  }

  /** Start/stop the animation loop (only while audio plays). */
  setRunning(on) {
    on = !!on && !!this.analyser;
    if (on === this.running) return;
    this.running = on;
    if (on) this._loop();
    else {
      this.liveValid = false;
      this.draw();
    }
  }

  invalidate() {
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
    }
    this.draw();
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
  }

  _loop() {
    const tick = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      // ~30 fps is plenty for a smoothed spectrum and halves the cost.
      this._frame = (this._frame + 1) % 2;
      if (this._frame) return;
      this._readLive();
      this._paint();
    };
    this._raf = requestAnimationFrame(tick);
  }

  _readLive() {
    const a = this.analyser;
    if (!a) return;
    try {
      const n = a.frequencyBinCount;
      const sr = a.context ? a.context.sampleRate : 48000;
      const key = `${a.fftSize}:${sr}`;
      if (key !== this.mapKey) {
        this.map = makeBandMap(this.freqs, a.fftSize, sr, 1 / 6);
        this.bins = new Float32Array(n);
        this.scratch = new Float64Array(n);
        this.mapKey = key;
      }
      a.getFloatFrequencyData(this.bins);
      smoothSpectrum(this.bins, this.map, this.live, this.scratch, { bandPower: true });
      this.liveValid = true;
    } catch {
      this.liveValid = false;
    }
  }

  draw() {
    if (this._raf && this.running) return;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._paint();
      if (this.running) this._loop();
    });
  }

  _colors() {
    const cs = getComputedStyle(this.canvas);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return {
      orig: v('--orig', '#8d97a8'),
      master: v('--master', '#36c5b0'),
      fg: v('--fg-2', '#a2abb8'),
      text: v('--fg-3', '#6c7685'),
      grid: v('--grid', 'rgba(255,255,255,.06)'),
      line: v('--line', '#262d37'),
      masterSoft: v('--master-soft', 'rgba(54,197,176,.16)'),
      origSoft: v('--orig-soft', 'rgba(141,151,168,.16)'),
      mono: v('--font-mono', 'monospace'),
    };
  }

  _paint() {
    const { ctx, w, h, dpr } = this;
    if (!ctx || w < 2 || h < 2) return;
    const col = this._colors();
    ctx.clearRect(0, 0, w, h);
    const padL = Math.round(34 * dpr);
    const padR = Math.round(8 * dpr);
    const axisH = Math.round(16 * dpr);
    const eqH = Math.round(Math.max(36 * dpr, h * 0.24));
    const gap = Math.round(10 * dpr);
    const mainTop = Math.round(6 * dpr);
    const mainH = h - axisH - eqH - gap - mainTop;
    const eqTop = mainTop + mainH + gap;
    const plotW = w - padL - padR;
    const X = (f) => padL + freqToX(f) * plotW;
    const o = this.overlays;
    const origL = o.original;
    const mastL = o.master ? o.master.map((v) => v + o.masterOffsetDb) : null;
    let top = -10;
    const maxes = [];
    for (const c of [origL, mastL]) if (c) for (const v of c) if (Number.isFinite(v)) maxes.push(v);
    if (maxes.length) top = Math.max(...maxes) + 4;
    const Y = (db) => mainTop + Math.min(1, Math.max(0, (top - db) / RANGE_DB)) * mainH;

    // Grid + labels.
    ctx.font = `${Math.round(10 * dpr)}px ${col.mono}`;
    ctx.fillStyle = col.grid;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      ctx.fillRect(Math.round(X(f)), mainTop, Math.max(1, Math.round(dpr * 0.5)), mainH);
      ctx.fillRect(Math.round(X(f)), eqTop, Math.max(1, Math.round(dpr * 0.5)), eqH);
    }
    for (let d = 0; d <= RANGE_DB; d += 12) ctx.fillRect(padL, Math.round(Y(top - d)), plotW, Math.max(1, Math.round(dpr * 0.5)));
    ctx.fillStyle = col.text;
    ctx.textBaseline = 'top';
    let lastEnd = -Infinity;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const label = f >= 1000 ? `${f / 1000}k` : String(f);
      const tw = ctx.measureText(label).width;
      const x = Math.min(w - padR - tw, Math.max(padL, X(f) - tw / 2));
      if (x < lastEnd + 6 * dpr) continue; // narrow plots: drop labels that would collide
      ctx.fillText(label, x, h - axisH + 3 * dpr);
      lastEnd = x + tw;
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let d = 0; d <= RANGE_DB; d += 24) ctx.fillText(d === 0 ? '0' : `−${d}`, padL - 6 * dpr, Y(top - d));
    ctx.fillText(`+${EQ_RANGE_DB}`, padL - 6 * dpr, eqTop + 5 * dpr);
    ctx.fillText('0', padL - 6 * dpr, eqTop + eqH / 2);
    ctx.fillText(`−${EQ_RANGE_DB}`, padL - 6 * dpr, eqTop + eqH - 5 * dpr);
    ctx.textAlign = 'left';

    // Live spectrum (behind the long-term curves).
    if (this.running && this.liveValid) {
      const ref = (this.liveKind === 'original' ? origL : mastL) || origL || mastL;
      // 1/6-octave live bands hold half the power of 1/3-octave LTAS bands: −3 dB.
      const target = ref ? energyMean(ref, ISO_THIRD_OCTAVE, 100, 5000) - 3 : null;
      const liveMean = energyMean(this.live, this.freqs, 100, 5000);
      if (liveMean !== null && liveMean > -110) {
        // Without overlays, keep the live curve's energy mean 14 dB under the top.
        const want = target !== null ? target - liveMean : top - 14 - liveMean;
        this.liveOffset = this.liveOffset === null ? want : this.liveOffset + 0.04 * (want - this.liveOffset);
      }
      const off = this.liveOffset ?? 0;
      const color = this.liveKind === 'original' ? col.orig : col.master;
      ctx.beginPath();
      ctx.moveTo(X(this.freqs[0]), mainTop + mainH);
      for (let i = 0; i < this.freqs.length; i++) ctx.lineTo(X(this.freqs[i]), Y(this.live[i] + off));
      ctx.lineTo(X(this.freqs[this.freqs.length - 1]), mainTop + mainH);
      ctx.closePath();
      ctx.fillStyle = this.liveKind === 'original' ? col.origSoft : col.masterSoft;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      for (let i = 0; i < this.freqs.length; i++) {
        const x = X(this.freqs[i]);
        const y = Y(this.live[i] + off);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Long-term curves.
    const curve = (vals, color, width, dash) => {
      const pts = [];
      for (let i = 0; i < ISO_THIRD_OCTAVE.length; i++) if (Number.isFinite(vals[i])) pts.push([X(ISO_THIRD_OCTAVE[i]), Y(vals[i])]);
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.setLineDash(dash ? dash.map((d) => d * dpr) : []);
      smoothPath(ctx, pts);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (origL) curve(origL, col.orig, 1.5, [4, 3]);
    if (mastL) curve(mastL, col.master, 2);

    // EQ strip.
    const eqY = (db) => eqTop + eqH / 2 - (Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, db)) / EQ_RANGE_DB) * (eqH / 2 - 2 * dpr);
    ctx.fillStyle = col.line;
    ctx.fillRect(padL, Math.round(eqTop + eqH / 2), plotW, Math.max(1, Math.round(dpr)));
    if (o.eq) {
      const pts = ISO_THIRD_OCTAVE.map((f, i) => [X(f), eqY(Number.isFinite(o.eq[i]) ? o.eq[i] : 0)]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], eqTop + eqH / 2);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(pts[pts.length - 1][0], eqTop + eqH / 2);
      ctx.closePath();
      ctx.fillStyle = col.masterSoft;
      ctx.fill();
      ctx.strokeStyle = col.fg;
      ctx.lineWidth = 1.5 * dpr;
      smoothPath(ctx, pts);
      ctx.stroke();
    }
  }
}

/** Smooth polyline through points (midpoint quadratic curves). */
function smoothPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}
