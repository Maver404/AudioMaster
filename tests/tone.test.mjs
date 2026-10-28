// Tests for src/dsp/eq.js, src/dsp/stereo.js, src/dsp/saturation.js.
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import {
  assert, approx, assertFinite, rng, sine, whiteNoise, pinkNoise, stereo, rms, db, maxDiff,
  TMP, writeWavFloat, hasFfmpeg, ffmpeg, ffmpegDecode, ffmpegLoudness,
  speedFactor,
} from './helpers.mjs';
import {
  THIRD_OCTAVE_HZ, ltas, hfCutoffHz, autoEqCurve, matchEqCurve, fitGraphicEq, toneSections,
  curveResponseDb, longTermSpectrum,
} from '../src/dsp/eq.js';
import { stereoImage, correlation, sideToMidDb, bandCorrelation, sideGainDb } from '../src/dsp/stereo.js';
import { saturate, airExciter } from '../src/dsp/saturation.js';
import { RealFFT } from '../src/dsp/fft.js';
import { responseDb, butterworth, processInPlace, design } from '../src/dsp/biquad.js';

const SR = 48000;
const NB = 31;
const bandIndex = (hz) => THIRD_OCTAVE_HZ.indexOf(hz);

// ------------------------------------------------------------------ helpers

/** Power spectrum (|X|², Blackman-Harris) of x[start .. start+N). */
function powerSpectrum(x, start, N) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    w[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
  }
  const buf = new Float64Array(N);
  for (let i = 0; i < N; i++) buf[i] = (x[start + i] || 0) * w[i];
  const re = new Float64Array(N / 2 + 1), im = new Float64Array(N / 2 + 1);
  new RealFFT(N).forward(buf, re, im);
  const p = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

/** Amplitude of the component at f (Blackman-Harris windowed DFT at exactly f). */
function toneAmp(x, f, sr, start = 0, end = x.length) {
  let sr0 = 0, si = 0, sw = 0;
  const N = end - start;
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / (N - 1);
    const w = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    const ph = (2 * Math.PI * f * (start + i)) / sr;
    sr0 += w * x[start + i] * Math.cos(ph);
    si += w * x[start + i] * Math.sin(ph);
    sw += w;
  }
  return (2 * Math.hypot(sr0, si)) / sw;
}

/** THD (ratio) of a tone at f0 from harmonics 2..10 below Nyquist. */
function thd(x, f0, sr, start, end) {
  const a1 = toneAmp(x, f0, sr, start, end);
  let s = 0;
  for (let k = 2; k <= 10 && k * f0 < 0.5 * sr; k++) s += toneAmp(x, k * f0, sr, start, end) ** 2;
  return Math.sqrt(s) / a1;
}

/** Brick-wall low-passed signal (exact, via one long FFT). */
function brickwall(x, cutoffHz, sr, tilt = 0) {
  let N = 1;
  while (N < x.length) N <<= 1;
  const fft = new RealFFT(N);
  const buf = new Float64Array(N);
  buf.set(x);
  const re = new Float64Array(N / 2 + 1), im = new Float64Array(N / 2 + 1);
  fft.forward(buf, re, im);
  for (let k = 0; k <= N / 2; k++) {
    const f = (k * sr) / N;
    let g = f > cutoffHz ? 0 : 1;
    // optional extra HF roll-off above 2 kHz (music-like spectrum), tilt dB/oct
    if (tilt && f > 2000) g *= Math.pow(10, (tilt * Math.log2(f / 2000)) / 20);
    re[k] *= g;
    im[k] *= g;
  }
  fft.inverse(re, im, buf);
  return Float32Array.from(buf.subarray(0, x.length));
}

function bandEnergy(p, sr, N, f0, f1) {
  let s = 0;
  for (let k = Math.max(0, Math.ceil((f0 * N) / sr)); k <= Math.min(p.length - 1, Math.floor((f1 * N) / sr)); k++) s += p[k];
  return s;
}

function midOf(ch) {
  const m = new Float32Array(ch[0].length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (ch[0][i] + ch[1][i]);
  return m;
}

function sideOf(ch) {
  const s = new Float32Array(ch[0].length);
  for (let i = 0; i < s.length; i++) s[i] = 0.5 * (ch[0][i] - ch[1][i]);
  return s;
}

function lowpassed(x, hz, sr, order = 8) {
  const y = Float32Array.from(x);
  processInPlace(y, butterworth('lowpass', order, hz, sr));
  return y;
}

/**
 * Host speed factor vs the ARCHITECTURE §8 reference (Apple M1 P-core), same method as
 * foundation.test.mjs: a dependent float-add chain runs at 0.94 ns/iteration there.
 * Budgets are asserted as budget × factor (clamped 1..3); raw times are reported.
 */

function bestOf(times, fn) {
  let best = Infinity;
  for (let i = 0; i < times; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// Shared test material (deterministic).
const PINK20 = pinkNoise(20, SR, 0.5, 11);

export const tests = {
  // ================================================================== eq.js: analysis

  'eq: THIRD_OCTAVE_HZ = 31 ISO centres 20 … 20000': () => {
    assert(THIRD_OCTAVE_HZ.length === 31, 'length');
    assert(THIRD_OCTAVE_HZ[0] === 20 && THIRD_OCTAVE_HZ[30] === 20000 && THIRD_OCTAVE_HZ[17] === 1000, 'anchors');
    for (let i = 1; i < 31; i++) {
      const r = THIRD_OCTAVE_HZ[i] / THIRD_OCTAVE_HZ[i - 1];
      assert(r > 1.2 && r < 1.3, `ratio at ${i}: ${r}`);
    }
  },

  'ltas: pink noise is flat (±1 dB, 50 Hz – 16 kHz)': () => {
    const l = ltas(stereo(PINK20), SR);
    assert(l.length === NB, 'length');
    const idx = [];
    for (let b = bandIndex(50); b <= bandIndex(16000); b++) idx.push(b);
    const vals = idx.map((b) => l[b]).sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    let dev = 0;
    for (const b of idx) dev = Math.max(dev, Math.abs(l[b] - med));
    assert(dev < 1, `max deviation ${dev.toFixed(2)} dB`);
    return `max deviation ${dev.toFixed(2)} dB`;
  },

  'ltas: white noise rises ≈ +1 dB per third-octave': () => {
    const x = whiteNoise(15, SR, 0.5, 3);
    const l = ltas(stereo(x), SR);
    let worst = 0;
    for (let b = bandIndex(50) + 1; b <= bandIndex(16000); b++) worst = Math.max(worst, Math.abs(l[b] - l[b - 1] - 1));
    // regression slope over 100 Hz – 16 kHz
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let b = bandIndex(100); b <= bandIndex(16000); b++) {
      n++;
      sx += b;
      sy += l[b];
      sxx += b * b;
      sxy += b * l[b];
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    approx(slope, 1, 0.05, 'slope per band');
    assert(worst < 0.6, `band step deviation ${worst.toFixed(2)}`);
    // absolute: band power = σ²·bandwidth/(fs/2); σ² = amp²/3
    const b1k = bandIndex(1000);
    const expected = 10 * Math.log10(((0.25 / 3) * (1000 * (Math.pow(10, 0.05) - Math.pow(10, -0.05)))) / (SR / 2));
    approx(l[b1k], expected, 0.3, '1 kHz band level');
    return `slope ${slope.toFixed(3)} dB/band, worst step error ${worst.toFixed(2)} dB`;
  },

  'ltas: absolute scale (0 dBFS sine → −3.01 dB in its band), mid signal, Parseval': () => {
    const x = sine(1000, 4, SR, 1);
    const l = ltas(stereo(x), SR);
    approx(l[bandIndex(1000)], -3.01, 0.05, '1 kHz band');
    assert(l[bandIndex(800)] < -60 && l[bandIndex(1250)] < -60, 'neighbours');
    // pure side → mid is silent
    const side = [Float32Array.from(x), Float32Array.from(x, (v) => -v)];
    const ls = ltas(side, SR);
    for (const v of ls) assert(Number.isFinite(v) && v < -200, 'mid of pure side is silent');
    // band powers of a 3-tone signal sum to its mean square
    const y = new Float32Array(4 * SR);
    for (let i = 0; i < y.length; i++) y[i] = 0.3 * Math.sin(2 * Math.PI * 100 * i / SR) + 0.2 * Math.sin(2 * Math.PI * 3000 * i / SR) + 0.1 * Math.sin(2 * Math.PI * 12000 * i / SR);
    const ly = ltas(stereo(y), SR);
    const sum = ly.reduce((s, v) => s + Math.pow(10, v / 10), 0);
    approx(10 * Math.log10(sum), db(rms(y)), 0.05, 'Parseval');
  },

  'ltas: 44.1 / 96 kHz, spectrum reuse and cache invalidation on in-place edits': () => {
    for (const sr of [44100, 96000]) {
      const l = ltas(stereo(whiteNoise(8, sr, 0.5, 6)), sr);
      let worst = 0;
      for (let b = bandIndex(100); b <= bandIndex(16000); b++) worst = Math.max(worst, Math.abs(l[b] - l[b - 1] - 1));
      assert(worst < 0.6, `${sr}: white noise step error ${worst.toFixed(2)}`);
    }
    const ch = [pinkNoise(3, SR, 0.5, 12), pinkNoise(3, SR, 0.5, 13)];
    const a = ltas(ch, SR);
    const sp = longTermSpectrum(ch, SR);
    const b = ltas(null, SR, { spectrum: sp });
    for (let i = 0; i < NB; i++) assert(a[i] === b[i], 'explicit spectrum gives identical bands');
    // in-place edit (a fade on the last 10 %) must not return stale cached results
    const n = ch[0].length;
    for (let i = Math.floor(0.9 * n); i < n; i++) {
      ch[0][i] *= 0.1;
      ch[1][i] *= 0.1;
    }
    const c = ltas(ch, SR);
    let d = 0;
    for (let i = 3; i < NB; i++) d = Math.max(d, Math.abs(c[i] - a[i]));
    assert(d > 0.1, 'cache invalidated by the edit');
    const fresh = ltas([Float32Array.from(ch[0]), Float32Array.from(ch[1])], SR);
    for (let i = 0; i < NB; i++) approx(c[i], fresh[i], 1e-9, 'matches a fresh computation');
  },

  'ltas: gating ignores silence and very quiet passages': () => {
    const a = pinkNoise(6, SR, 0.5, 4);
    const withGaps = new Float32Array(a.length + 8 * SR);
    withGaps.set(a.subarray(0, 3 * SR), 0);
    // 4 s at −70 dB re. the music (white noise: would tilt the LTAS if it counted)
    const q = whiteNoise(4, SR, 0.5 * 3e-4, 5);
    withGaps.set(q, 3 * SR);
    withGaps.set(a.subarray(3 * SR), 7 * SR);
    // trailing 4 s digital silence
    const l1 = ltas(stereo(a), SR), l2 = ltas(stereo(withGaps), SR);
    let d = 0;
    for (let b = 3; b < NB; b++) d = Math.max(d, Math.abs(l1[b] - l2[b]));
    assert(d < 0.35, `gated LTAS differs by ${d.toFixed(2)} dB`);
    return `max difference ${d.toFixed(2)} dB`;
  },

  'ltas / hfCutoffHz: safe on silence and 10-sample input': () => {
    for (const len of [0, 10, 1000]) {
      const z = [new Float32Array(len), new Float32Array(len)];
      const l = ltas(z, SR);
      for (const v of l) assert(Number.isFinite(v), 'finite');
      assert(hfCutoffHz(z, SR) === SR / 2, 'silence → sr/2');
    }
    const ten = stereo(Float32Array.from({ length: 10 }, (_, i) => Math.sin(i)));
    for (const v of ltas(ten, SR)) assert(Number.isFinite(v), 'finite (10 samples)');
    assert(Number.isFinite(hfCutoffHz(ten, SR)), 'cutoff finite');
  },

  'hfCutoffHz: full band, 16 kHz (MP3-like) and 11–13 kHz (legacy) low-passes': () => {
    const base = pinkNoise(12, SR, 0.5, 7);
    const out = [];
    const full = hfCutoffHz(stereo(base), SR);
    assert(full === SR / 2, `full band → ${full}`);
    out.push(`full ${full}`);
    for (const [fc, tilt] of [[16000, 0], [16000, -2], [12000, 0], [11000, -3], [13000, -1.5], [19500, -2]]) {
      const x = brickwall(base, fc, SR, tilt);
      const got = hfCutoffHz(stereo(x), SR);
      assert(Math.abs(got - fc) <= 300, `${fc} Hz (tilt ${tilt}) detected as ${got}`);
      out.push(`${fc}→${got}`);
    }
    // a steep IIR low-pass (16th-order Butterworth) on a music-like spectrum
    const iir = lowpassed(lowpassed(brickwall(base, 23000, SR, -2), 16000, SR), 16000, SR);
    const gotIir = hfCutoffHz(stereo(iir), SR);
    assert(Math.abs(gotIir - 16000) <= 700, `IIR 16 kHz → ${gotIir}`);
    out.push(`IIR16k→${gotIir}`);
    // 44.1 kHz full-band material with a typical 20 kHz anti-alias edge reads >= 19 kHz
    const b44 = pinkNoise(8, 44100, 0.5, 8);
    const aa = brickwall(b44, 20000, 44100, -2);
    const g44 = hfCutoffHz(stereo(aa), 44100);
    assert(g44 >= 19000, `44.1 kHz anti-alias edge → ${g44}`);
    out.push(`44.1k aa→${g44}`);
    // reusing a precomputed spectrum gives identical answers
    const sp = longTermSpectrum(stereo(base), SR);
    assert(hfCutoffHz(null, SR, { spectrum: sp }) === full, 'spectrum reuse');
    return out.join(', ');
  },

  'hfCutoffHz: real MP3 encodes (ffmpeg libmp3lame) are detected': () => {
    if (!hasFfmpeg()) return 'skip';
    const sr = 44100;
    const src = brickwall(pinkNoise(8, sr, 0.4, 9), 21000, sr, -2);
    const wav = join(TMP, 'tone-cutoff-src.wav');
    writeWavFloat(wav, stereo(src), sr);
    const out = [];
    for (const [kbps, cutoff] of [[128, 16000], [96, 12000], [192, 0]]) {
      const mp3 = join(TMP, `tone-cutoff-${kbps}.mp3`);
      try {
        const args = ['-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', `${kbps}k`];
        if (cutoff) args.push('-cutoff', String(cutoff));
        args.push(mp3);
        ffmpeg(args);
      } catch {
        return 'skip';
      }
      const dec = ffmpegDecode(mp3, sr);
      const got = hfCutoffHz(dec, sr);
      if (cutoff) assert(Math.abs(got - cutoff) <= 800, `${kbps}k cutoff ${cutoff} → ${got}`);
      else assert(got >= 17500 && got <= 21000, `${kbps}k default LAME low-pass → ${got}`);
      out.push(`${kbps}k${cutoff ? '/' + cutoff : ''}→${got}`);
      if (existsSync(mp3)) unlinkSync(mp3);
    }
    return out.join(', ');
  },

  // ================================================================== eq.js: curves

  'autoEqCurve: zero for a smooth spectrum, no slope change when target is null': () => {
    const l = ltas(stereo(PINK20), SR);
    const c = autoEqCurve(l, { strength: 1, maxDb: 4, toleranceDb: 1.5, targetSlopeDbPerOct: null, cutoffHz: SR / 2 });
    for (const v of c) assert(Math.abs(v) < 1e-9, `non-zero ${v}`);
    // a smoothly tilted spectrum (−4.5 dB/oct, typical music) also gets no correction
    const tilted = Float64Array.from(THIRD_OCTAVE_HZ, (f) => -30 - 4.5 * Math.log2(f / 1000));
    const c2 = autoEqCurve(tilted, { strength: 1, targetSlopeDbPerOct: null });
    for (const v of c2) assert(Math.abs(v) < 1e-6, `tilted: non-zero ${v}`);
  },

  'autoEqCurve: corrects a bump beyond tolerance, bounded, never boosts empty bands': () => {
    const l = Float64Array.from(THIRD_OCTAVE_HZ, (f) => -30 - 3 * Math.log2(f / 1000));
    const b = bandIndex(315);
    l[b] += 5;
    l[b - 1] += 2.5;
    l[b + 1] += 2.5;
    // codec cutoff at 16 kHz: bands above are empty
    l[bandIndex(20000)] = -150;
    const c = autoEqCurve(l, { strength: 1, maxDb: 3, toleranceDb: 1.5, cutoffHz: 16000 });
    assert(c[b] < -2 && c[b] >= -3 - 1e-9, `bump correction ${c[b]}`);
    assert(c[b - 1] < 0 && c[b + 1] < 0, 'neighbours cut');
    for (let i = 0; i < NB; i++) {
      assert(Math.abs(c[i]) <= 3 + 1e-9, `clamp at ${i}`);
      if (THIRD_OCTAVE_HZ[i] < 30 || THIRD_OCTAVE_HZ[i] > 16000) assert(c[i] <= 0, `boost at ${THIRD_OCTAVE_HZ[i]}`);
    }
    // far from the bump nothing happens
    for (const f of [63, 2000, 8000]) assert(Math.abs(c[bandIndex(f)]) < 0.05, `untouched at ${f}`);
    // strength scales linearly (before clamping)
    const half = autoEqCurve(l, { strength: 0.5, maxDb: 6, cutoffHz: 16000 });
    const full = autoEqCurve(l, { strength: 1, maxDb: 6, cutoffHz: 16000 });
    approx(half[b], full[b] / 2, 1e-9, 'strength scaling');
    // a dip is filled less than a bump is cut
    const d = Float64Array.from(THIRD_OCTAVE_HZ, (f) => -30 - 3 * Math.log2(f / 1000));
    d[b] -= 5;
    d[b - 1] -= 2.5;
    d[b + 1] -= 2.5;
    const cd = autoEqCurve(d, { strength: 1, maxDb: 6 });
    assert(cd[b] > 0 && cd[b] < -full[b], `dip ${cd[b]} vs bump ${full[b]}`);
    return `bump +5 dB @315 → ${c[b].toFixed(2)} dB; dip −5 dB → +${cd[b].toFixed(2)} dB`;
  },

  'autoEqCurve: slope toward target only when given, style tilt, ±4 dB cap': () => {
    const flat = new Float64Array(NB).fill(-30);
    const c = autoEqCurve(flat, { strength: 1, maxDb: 6, targetSlopeDbPerOct: -1 });
    // −1 dB/oct line around 1 kHz (unclamped region)
    for (const f of [250, 500, 2000, 4000]) approx(c[bandIndex(f)], -Math.log2(f / 1000), 0.02, `slope at ${f}`);
    for (const v of c) assert(Math.abs(v) <= 4 + 1e-9, 'cap 4 dB even with maxDb 6');
    assert(c[bandIndex(20)] <= 0 && c[bandIndex(25)] <= 0, 'no boost below 30 Hz');
    const t = autoEqCurve(flat, { strength: 0, maxDb: 3, styleTiltDbPerOct: 0.5, cutoffHz: 12000 });
    approx(t[bandIndex(4000)], 1, 0.01, 'tilt at 4k');
    approx(t[bandIndex(250)], -1, 0.01, 'tilt at 250');
    assert(t[bandIndex(16000)] === 0 && t[bandIndex(20000)] === 0, 'no tilt boost above the cutoff');
    assert(t[bandIndex(12500)] < t[bandIndex(10000)], 'straddling band only half');
    const none = autoEqCurve(flat, { strength: 1, targetSlopeDbPerOct: null });
    for (const v of none) assert(v === 0, 'null target keeps the slope');
  },

  'autoEqCurve: low end — 31.5/40 Hz never cut harder than 50/63 Hz, sub roll-off never filled': () => {
    const trend = () => Float64Array.from(THIRD_OCTAVE_HZ, (f) => -30 - 3 * Math.log2(f / 1000));
    // a +4 dB one-band hump at each low band: the cut never grows toward the sub
    const cut = {};
    for (const f of [31.5, 40, 50, 63, 80, 100]) {
      const l = trend();
      l[bandIndex(f)] += 4;
      cut[f] = -autoEqCurve(l, { strength: 1, maxDb: 4, toleranceDb: 1.5 })[bandIndex(f)];
      assert(cut[f] > 0, `hump at ${f} Hz is cut (${cut[f]})`);
    }
    // (was 0.5 at 31.5/40 Hz vs 0.25 at 50/63 Hz: twice as hard; the edge of the trend fit
    // and the 1-2-1 smoothing leave a few hundredths)
    for (const f of [31.5, 40, 50]) assert(cut[f] <= 1.05 * cut[63] + 0.005, `${f} Hz cut ${cut[f].toFixed(3)} vs 63 Hz ${cut[63].toFixed(3)}`);
    assert(cut[63] <= cut[80] + 1e-6 && cut[80] <= cut[100] + 1e-6, 'fade from 200 Hz down to 63 Hz');
    // the natural roll-off into the subsonic region (a steep "dip" below 63 Hz) is not filled
    const roll = trend();
    roll[bandIndex(50)] -= 4;
    roll[bandIndex(40)] -= 9;
    roll[bandIndex(31.5)] -= 15;
    const c = autoEqCurve(roll, { strength: 1, maxDb: 4, toleranceDb: 1.5 });
    for (const f of [20, 25, 31.5, 40, 50]) assert(c[bandIndex(f)] <= 1e-9, `no boost at ${f} Hz (${c[bandIndex(f)]})`);
    // a dip at 80 Hz is still filled (above the sub region)
    const dip = trend();
    dip[bandIndex(80)] -= 5;
    assert(autoEqCurve(dip, { strength: 1, maxDb: 4, toleranceDb: 1.5 })[bandIndex(80)] > 0.5, 'dip at 80 Hz filled');
    return `hump cuts dB: ${Object.entries(cut).map(([f, v]) => `${f} Hz ${v.toFixed(2)}`).join(', ')}`;
  },

  'toneSections: Bright high shelf opens the top without touching the lows': () => {
    const secs = toneSections({ highShelfDb: 1.2, highShelfHz: 2000 }, SR);
    assert(secs.length === 1, 'one section');
    const r = (f) => responseDb(secs, f, SR);
    for (const f of [20, 31.5, 50, 100, 200, 300]) assert(Math.abs(r(f)) < 0.06, `lows untouched at ${f} Hz (${r(f).toFixed(3)})`);
    for (const f of [6000, 8000, 10000, 16000]) assert(r(f) > 0.9 && r(f) < 1.25, `top lifted at ${f} Hz (${r(f).toFixed(2)})`);
    // the old 1 kHz tilt pair cut the sub by ≈ 1 dB for the same top lift
    const tilt = toneSections({ tiltDbPerOct: 0.3 }, SR);
    assert(responseDb(tilt, 31.5, SR) < -0.9, 'tilt pair (reference) cuts the sub');
    assert(toneSections({ highShelfDb: 0 }, SR).length === 0, 'zero gain omitted');
    return `+1.2 dB shelf: ${r(100).toFixed(3)} dB @100 Hz, ${r(1000).toFixed(2)} @1 kHz, ${r(10000).toFixed(2)} @10 kHz`;
  },

  'matchEqCurve: zero for identical / level-shifted spectra, fades, clamp, strength': () => {
    const a = ltas(stereo(PINK20), SR);
    for (const v of matchEqCurve(a, a, { strength: 1 })) assert(v === 0, 'identical → 0');
    const shifted = a.map((v) => v + 7.3);
    for (const v of matchEqCurve(a, shifted, { strength: 1 })) assert(Math.abs(v) < 1e-9, 'loudness-normalised');
    // reference is brighter: +0.8 dB/oct above 1 kHz
    const ref = a.map((v, i) => v + (THIRD_OCTAVE_HZ[i] > 1000 ? 0.8 * Math.log2(THIRD_OCTAVE_HZ[i] / 1000) : 0));
    const m = matchEqCurve(a, ref, { strength: 1, maxDb: 6 });
    assert(m[bandIndex(8000)] > m[bandIndex(2000)] && m[bandIndex(2000)] > m[bandIndex(500)], 'follows the reference tilt');
    assert(m[bandIndex(20)] === 0 && m[bandIndex(25)] === 0, 'faded to 0 below 30 Hz');
    assert(Math.abs(m[bandIndex(31.5)]) < Math.abs(m[bandIndex(63)]) + 1e-9, 'fade-in 30–40 Hz');
    assert(m[bandIndex(16000)] === 0 && m[bandIndex(20000)] === 0, 'faded above 16 kHz');
    const half = matchEqCurve(a, ref, { strength: 0.5, maxDb: 6 });
    for (let i = 0; i < NB; i++) approx(half[i], m[i] / 2, 1e-9, 'strength');
    const extreme = a.map((v, i) => v + (i === bandIndex(2000) ? 20 : 0));
    const mc = matchEqCurve(a, extreme, { strength: 1, maxDb: 6 });
    assert(mc[bandIndex(2000)] <= 6 + 1e-9, 'clamped');
    // cutoff: nothing at or above the codec low-pass
    const cut = matchEqCurve(a, ref, { strength: 1, cutoffHz: 12000 });
    assert(cut[bandIndex(12500)] === 0 && cut[bandIndex(16000)] === 0, 'faded at the cutoff');
    // silent input / reference → zeros
    for (const v of matchEqCurve(new Float64Array(NB).fill(-240), a, { strength: 1 })) assert(v === 0, 'silent input');
  },

  'fitGraphicEq: < 0.5 dB max error on smooth targets within ±4 dB': () => {
    const targets = {
      tiltUp: THIRD_OCTAVE_HZ.map((f) => clampN(0.6 * Math.log2(f / 1000), -3, 3)),
      tiltDown: THIRD_OCTAVE_HZ.map((f) => clampN(-0.4 * Math.log2(f / 1000), -3, 3)),
      mudCut: THIRD_OCTAVE_HZ.map((f) => -3 * Math.exp(-0.5 * (Math.log2(f / 300) / 0.6) ** 2)),
      smile: THIRD_OCTAVE_HZ.map((f) => 2.5 * Math.exp(-0.5 * (Math.log2(f / 60) / 0.9) ** 2) + 2 * Math.exp(-0.5 * (Math.log2(f / 12000) / 1) ** 2)),
      mixed: THIRD_OCTAVE_HZ.map((f) => 2 * Math.sin(Math.log2(f / 20) * 0.9) - 1.5 * Math.exp(-0.5 * (Math.log2(f / 3500) / 0.5) ** 2)),
    };
    // a real autoEq + tilt result
    const l = ltas(stereo(PINK20), SR);
    l[bandIndex(250)] += 4;
    l[bandIndex(200)] += 2;
    l[bandIndex(4000)] -= 3;
    targets.autoEq = Array.from(autoEqCurve(l, { strength: 0.85, maxDb: 4, styleTiltDbPerOct: -0.4 }));
    const out = [];
    for (const sr of [44100, 48000, 96000]) {
      for (const [name, t] of Object.entries(targets)) {
        const secs = fitGraphicEq(t, sr);
        assert(secs.length >= 1 && secs.length <= 10, 'bank size');
        for (const s of secs) {
          for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) assert(Number.isFinite(s[k]), 'finite coefficient');
          assert(Math.abs(s.a2) < 1 && Math.abs(s.a1) < 1 + s.a2, 'stable section');
        }
        const r = curveResponseDb(secs, THIRD_OCTAVE_HZ, sr);
        let err = 0;
        for (let i = 0; i < NB; i++) if (THIRD_OCTAVE_HZ[i] <= Math.min(16000, 0.4 * sr)) err = Math.max(err, Math.abs(r[i] - t[i]));
        assert(err < 0.5, `${name} @${sr}: max error ${err.toFixed(2)} dB`);
        if (sr === 48000) out.push(`${name} ${err.toFixed(2)}`);
      }
    }
    assert(fitGraphicEq(new Float64Array(NB), SR).length === 0, 'flat → no sections');
    return 'max error dB: ' + out.join(', ');
  },

  'toneSections: neutral is empty; controls hit their gains; tilt pair is complementary': () => {
    assert(toneSections({}, SR).length === 0, 'neutral');
    assert(toneSections({ lowShelfDb: 0, tiltDbPerOct: 0, airDb: 0 }, SR).length === 0, 'zero gains omitted');
    const one = (tone, f) => responseDb(toneSections(tone, SR), f, SR);
    approx(one({ boomDb: -2 }, 120), -2, 1e-6, 'boom @120');
    approx(one({ mudDb: -3, mudHz: 280 }, 280), -3, 1e-6, 'mud @f');
    approx(one({ presenceDb: 1.5 }, 3000), 1.5, 1e-6, 'presence');
    approx(one({ lowShelfDb: 1 }, 25), 1, 0.05, 'low shelf plateau');
    approx(one({ lowShelfDb: 1 }, 1000), 0, 0.05, 'low shelf above');
    approx(one({ airDb: 1.5 }, 20000), 1.5, 0.1, 'air shelf plateau');
    approx(one({ airDb: 1.5 }, 2000), 0, 0.05, 'air shelf below');
    approx(one({ hashDb: -1.5 }, 19000), -1.5, 0.2, 'hash shelf');
    // tilt: RESEARCH §4 "−0.4 dB/oct ≈ −1.3 dB at 10 kHz"
    const tilt = toneSections({ tiltDbPerOct: -0.4 }, SR);
    assert(tilt.length === 2, 'shelf pair');
    const r = (f) => responseDb(tilt, f, SR);
    approx(r(1000), 0, 0.02, 'pivot');
    approx(r(10000), -1.33, 0.25, '10 kHz');
    approx(r(100), 1.33, 0.25, '100 Hz');
    let prev = Infinity;
    for (let f = 20; f < 20000; f *= 1.2) {
      const v = r(f);
      assert(v < prev + 1e-9, 'monotonic');
      prev = v;
    }
    const piv = toneSections({ tiltDbPerOct: 0.3, tiltPivotHz: 2000 }, SR);
    approx(responseDb(piv, 2000, SR), 0, 0.02, 'custom pivot');
    return `tilt −0.4: ${r(100).toFixed(2)} dB @100 Hz, ${r(10000).toFixed(2)} dB @10 kHz`;
  },

  'curveResponseDb: matches responseDb, empty → zeros, safe above Nyquist': () => {
    const secs = toneSections({ mudDb: -2, airDb: 1 }, SR);
    const fr = [20, 100, 1000, 10000, 30000];
    const r = curveResponseDb(secs, fr, SR);
    assert(r instanceof Float64Array && r.length === 5, 'type');
    for (let i = 0; i < 4; i++) approx(r[i], responseDb(secs, fr[i], SR), 1e-12, 'match');
    assert(Number.isFinite(r[4]), 'above Nyquist finite');
    const z = curveResponseDb([], fr, SR);
    for (const v of z) assert(v === 0, 'empty');
  },

  // ================================================================== stereo.js

  'stereoImage: width 1 & monoBass 0 is an exact identity': () => {
    const L = pinkNoise(1, SR, 0.5, 1), R = pinkNoise(1, SR, 0.5, 2);
    const ch = [Float32Array.from(L), Float32Array.from(R)];
    const st = stereoImage(ch, SR, { width: 1, widthFromHz: 1500, monoBassHz: 0 });
    assert(!st.changed, 'not changed');
    for (let i = 0; i < L.length; i++) assert(ch[0][i] === L[i] && ch[1][i] === R[i], 'bit exact');
    stereoImage(ch, SR, {});
    assert(maxDiff(ch[0], L) === 0, 'defaults are identity');
  },

  'stereoImage: width 0 → mono above monoBass; mid never changes': () => {
    const L = pinkNoise(3, SR, 0.5, 3), R = pinkNoise(3, SR, 0.5, 4);
    const ch = [Float32Array.from(L), Float32Array.from(R)];
    const m0 = midOf(ch);
    stereoImage(ch, SR, { width: 0, widthFromHz: 0, monoBassHz: 0 });
    for (let i = 0; i < L.length; i++) assert(ch[0][i] === ch[1][i], 'fully mono');
    assert(maxDiff(midOf(ch), m0) < 1e-6, 'mid unchanged');
    // width 0 above 1.5 kHz only: highs mono, lows untouched
    const c2 = [Float32Array.from(L), Float32Array.from(R)];
    stereoImage(c2, SR, { width: 0, widthFromHz: 1500, monoBassHz: 120 });
    assert(maxDiff(midOf(c2), m0) < 1e-6, 'mid unchanged (split)');
    const [lo, mid, hi] = bandCorrelation(c2, SR, [400, 6000]);
    const before = bandCorrelation([L, R], SR, [400, 6000]);
    assert(hi > 0.999, `highs mono: r = ${hi}`);
    assert(Math.abs(before[0]) < 0.05 && lo > 0.2 && lo < 0.95, `lows: ${before[0]} → ${lo} (mono < 120 Hz only)`);
    assert(mid > 0.3, `1.5 kHz region partly narrowed: ${mid}`);
    return `band r after: <400 ${lo.toFixed(2)}, 400–6k ${mid.toFixed(2)}, >6k ${hi.toFixed(4)}`;
  },

  'stereoImage: side gain follows the LR4 magnitudes with zero phase': () => {
    const opts = { width: 1.4, widthFromHz: 2000, monoBassHz: 100 };
    const out = [];
    for (const f of [40, 100, 150, 400, 2000, 6000, 15000]) {
      const s = sine(f, 1, SR, 0.25, 0.3);
      const ch = [Float32Array.from(s), Float32Array.from(s, (v) => -v)]; // pure side
      stereoImage(ch, SR, opts);
      const so = sideOf(ch);
      const g = sideGainDb(f, SR, opts);
      const expect = dbToG(g);
      // zero phase: output = g · input, sample by sample (away from the edges)
      let err = 0;
      for (let i = 12000; i < 36000; i++) err = Math.max(err, Math.abs(so[i] - expect * s[i]));
      assert(err < 2e-4 * Math.max(1, expect), `${f} Hz: |out − g·in| = ${err}`);
      out.push(`${f}Hz ${g.toFixed(2)}dB`);
    }
    approx(sideGainDb(100, SR, opts), -6.02, 0.05, 'LR4 −6 dB at the mono-bass crossover');
    approx(sideGainDb(15000, SR, opts), 20 * Math.log10(1.4), 0.05, 'width above the split');
    return out.join(', ');
  },

  'stereoImage: never widens below 300 Hz': () => {
    const opts = { width: 2, widthFromHz: 50, monoBassHz: 0 };
    // LR4 split clamped to 300 Hz: residual widening below it is the crossover skirt only,
    // (1 + w·Ω⁴)/(1 + Ω⁴) with Ω = f/300: +0.014 dB at 60 Hz, +0.5 dB at 150 Hz (w = 2).
    for (const [f, maxDbV] of [[60, 0.02], [150, 0.55], [300, 3.6]]) {
      const s = sine(f, 1, SR, 0.25);
      const ch = [Float32Array.from(s), Float32Array.from(s, (v) => -v)];
      stereoImage(ch, SR, opts);
      const g = db(toneAmp(sideOf(ch), f, SR, 12000, 36000) / 0.25);
      assert(g <= maxDbV, `${f} Hz widened by ${g.toFixed(2)} dB`);
    }
    const st = stereoImage([new Float32Array(100), new Float32Array(100)], SR, { width: 1.5, widthFromHz: 0 });
    assert(st.widthFromHz === 300, 'clamped split');
  },

  'stereoImage: mono bass makes decorrelated lows mono (< 100 Hz correlation ≈ 1)': () => {
    const n = 6 * SR;
    const lowL = lowpassed(whiteNoise(6, SR, 0.5, 21), 60, SR, 4);
    const lowR = lowpassed(whiteNoise(6, SR, 0.5, 22), 60, SR, 4);
    const high = pinkNoise(6, SR, 0.2, 23);
    processInPlace(high, butterworth('highpass', 8, 400, SR)); // correlated content only above 400 Hz
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = lowL[i] + high[i];
      R[i] = lowR[i] + high[i];
    }
    const before = bandCorrelation([L, R], SR, [100]);
    const ch = [Float32Array.from(L), Float32Array.from(R)];
    stereoImage(ch, SR, { monoBassHz: 100 });
    const after = bandCorrelation(ch, SR, [100]);
    assert(before[0] < 0.2, `before ${before[0]}`);
    assert(after[0] > 0.97, `after ${after[0]}`);
    assert(after[1] > 0.95, 'highs (correlated) stay correlated');
    assert(maxDiff(midOf(ch), midOf([L, R])) < 1e-6, 'mono sum unchanged');
    return `<100 Hz r: ${before[0].toFixed(3)} → ${after[0].toFixed(3)}`;
  },

  'stereoImage: safe on silence, 10 samples, mono input': () => {
    const z = [new Float32Array(SR), new Float32Array(SR)];
    stereoImage(z, SR, { width: 1.3, monoBassHz: 120 });
    for (const c of z) for (const v of c) assert(v === 0, 'silence stays silent');
    const t = [Float32Array.from([1, -1, 0.5, 0.2, 0, 0, 0.3, -0.2, 0.1, 0]), new Float32Array(10)];
    stereoImage(t, SR, { width: 0.5, monoBassHz: 100, widthFromHz: 1000 });
    assertFinite(t);
    const mono = [Float32Array.from([0.1, 0.2])];
    stereoImage(mono, SR, { width: 0 });
    assert(mono[0][0] === Math.fround(0.1), 'mono untouched');
  },

  'correlation / sideToMidDb: reference values and gating': () => {
    const a = pinkNoise(4, SR, 0.5, 31), b = pinkNoise(4, SR, 0.5, 32);
    approx(correlation([a, a]), 1, 1e-9, 'identical');
    approx(correlation([a, Float32Array.from(a, (v) => -v)]), -1, 1e-9, 'inverted');
    assert(Math.abs(correlation([a, b])) < 0.03, 'independent');
    assert(correlation([new Float32Array(100), new Float32Array(100)]) === 1, 'silence → 1');
    assert(correlation([a, new Float32Array(a.length)]) === 0, 'one side silent → 0');
    // gating: 4 s correlated music + 8 s of independent noise at −80 dB re. it
    const L = new Float32Array(12 * SR), R = new Float32Array(12 * SR);
    L.set(a);
    R.set(a);
    const nl = whiteNoise(8, SR, 5e-5, 33), nr = whiteNoise(8, SR, 5e-5, 34);
    L.set(nl, 4 * SR);
    R.set(nr, 4 * SR);
    assert(correlation([L, R]) > 0.999, 'quiet uncorrelated noise is gated out');
    // side/mid
    assert(sideToMidDb([a, a]) === -100, 'mono');
    assert(sideToMidDb([a, Float32Array.from(a, (v) => -v)]) === 100, 'pure side (clamped)');
    approx(sideToMidDb([a, b]), 0, 0.2, 'independent ≈ 0 dB');
    const half = [Float32Array.from(a, (v, i) => v + 0.5 * b[i]), Float32Array.from(a, (v, i) => v - 0.5 * b[i])];
    approx(sideToMidDb(half), 20 * Math.log10(0.5 * rms(b) / rms(a)), 0.02, 'S at half the level');
    assert(Number.isFinite(sideToMidDb([new Float32Array(10), new Float32Array(10)])), 'silence finite');
  },

  'bandCorrelation: per-band values low → high': () => {
    const n = 4 * SR;
    const low = lowpassed(whiteNoise(4, SR, 0.5, 41), 80, SR, 8);
    const hiN = whiteNoise(4, SR, 0.3, 42);
    const hp = Float32Array.from(hiN);
    processInPlace(hp, butterworth('highpass', 8, 3000, SR));
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = low[i] + hp[i];
      R[i] = low[i] - hp[i];
    }
    const r = bandCorrelation([L, R], SR, [300, 1000]);
    assert(r.length === 3, 'length');
    assert(r[0] > 0.99, `low ${r[0]}`);
    assert(r[2] < -0.99, `high ${r[2]}`);
    const r4 = bandCorrelation([L, R], SR, [120, 1000, 8000]);
    assert(r4.length === 4, 'analysis layout');
    const single = bandCorrelation([L, R], SR, []);
    approx(single[0], correlation([L, R]), 1e-12, 'no crossovers → broadband');
    const lowRate = bandCorrelation([L.subarray(0, 16000), R.subarray(0, 16000)], 16000, [120, 1000, 8000]);
    assert(lowRate.length === 4 && lowRate.every(Number.isFinite), 'crossover above Nyquist keeps the band count');
    const z = bandCorrelation([new Float32Array(10), new Float32Array(10)], SR, [120, 1000]);
    assert(z.every((v) => v === 1), 'silence → 1');
    return r4.map((v) => v.toFixed(3)).join(' / ');
  },

  // ================================================================== saturation.js

  'saturate: drive 0 / mix 0 / silence are exact identities': () => {
    const L = pinkNoise(1, SR, 0.5, 51), R = pinkNoise(1, SR, 0.5, 52);
    for (const o of [{ drive: 0 }, { drive: 0.5, mix: 0 }, {}]) {
      const ch = [Float32Array.from(L), Float32Array.from(R)];
      saturate(ch, SR, o);
      assert(maxDiff(ch[0], L) === 0 && maxDiff(ch[1], R) === 0, `identity for ${JSON.stringify(o)}`);
    }
    const z = [new Float32Array(1000), new Float32Array(1000)];
    saturate(z, SR, { drive: 1 });
    for (const c of z) for (const v of c) assert(v === 0, 'silence');
  },

  'saturate: THD rises monotonically with drive, mostly 2nd/3rd harmonics': () => {
    const f0 = 1000;
    let prev = 0;
    const out = [];
    for (const drive of [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1]) {
      const s = sine(f0, 1, SR, 0.5);
      const ch = [Float32Array.from(s), Float32Array.from(s)];
      saturate(ch, SR, { drive });
      const t = thd(ch[0], f0, SR, 4800, 43200);
      assert(t > prev, `THD not increasing at drive ${drive}: ${t} <= ${prev}`);
      prev = t;
      const a1 = toneAmp(ch[0], f0, SR, 4800, 43200);
      const h2 = toneAmp(ch[0], 2 * f0, SR, 4800, 43200), h3 = toneAmp(ch[0], 3 * f0, SR, 4800, 43200);
      let hi = 0;
      for (let k = 4; k <= 10; k++) hi = Math.max(hi, toneAmp(ch[0], k * f0, SR, 4800, 43200));
      if (drive <= 0.5) assert(hi < 0.05 * Math.max(h2, h3), `drive ${drive}: higher harmonics ${db(hi / a1).toFixed(1)} dB`);
      if (drive === 0.1) assert(t > 0.007 && t < 0.013, `calibration: THD ${(100 * t).toFixed(2)} % at drive 0.1`);
      out.push(`${drive}: ${(100 * t).toFixed(2)}% (H2 ${db(h2 / a1).toFixed(0)}, H3 ${db(h3 / a1).toFixed(0)} dB)`);
    }
    return out.join('; ');
  },

  'saturate: RMS preserved (within 0.5 dB), level-independent colour, no DC': () => {
    const out = [];
    const music = [pinkNoise(4, SR, 0.6, 53), pinkNoise(4, SR, 0.6, 54)];
    for (const [drive, mix] of [[0.06, 1], [0.3, 1], [1, 1], [0.5, 0.5]]) {
      const ch = music.map((c) => Float32Array.from(c));
      const st = saturate(ch, SR, { drive, mix });
      const d = db(rms(ch[0]) * rms(ch[1])) / 2 - db(rms(music[0]) * rms(music[1])) / 2;
      const dTot = 10 * Math.log10((rms(ch[0]) ** 2 + rms(ch[1]) ** 2) / (rms(music[0]) ** 2 + rms(music[1]) ** 2));
      assert(Math.abs(dTot) < 0.01 && Math.abs(d) < 0.5, `drive ${drive} mix ${mix}: RMS change ${dTot.toFixed(3)} dB`);
      assertFinite(ch);
      out.push(`d${drive}/m${mix}: ${dTot.toFixed(4)} dB (makeup ${st.makeupDb.toFixed(2)})`);
    }
    // level independence: the same tone 20 dB lower gets the same THD
    const t = [0.5, 0.05].map((amp) => {
      const s = sine(500, 1, SR, amp);
      const ch = [Float32Array.from(s), Float32Array.from(s)];
      saturate(ch, SR, { drive: 0.3 });
      return thd(ch[0], 500, SR, 4800, 43200);
    });
    approx(t[1], t[0], 0.0005, 'THD level independent');
    // asymmetric shaper → DC is generated, then removed
    const s = sine(200, 3, SR, 0.5);
    const ch = [Float32Array.from(s), Float32Array.from(s)];
    saturate(ch, SR, { drive: 1 });
    let m = 0;
    for (let i = SR; i < 3 * SR; i++) m += ch[0][i];
    m /= 2 * SR;
    assert(Math.abs(m) < 2e-4, `DC ${m}`);
    return out.join(', ');
  },

  'saturate: low aliasing on a 9 kHz sine at 48 kHz (2x oversampled)': () => {
    const f0 = 9000;
    const N = 32768;
    const res = [];
    for (const drive of [0.1, 0.25, 0.5, 0.75, 1]) {
      const s = sine(f0, 1.2, SR, 0.5);
      const ch = [Float32Array.from(s), Float32Array.from(s)];
      saturate(ch, SR, { drive });
      const p = powerSpectrum(ch[0], 8000, N);
      const k0 = Math.round((f0 * N) / SR);
      let fund = 0;
      for (let k = k0 - 6; k <= k0 + 6; k++) fund += p[k];
      // Any line that is not DC, the fundamental or the 2nd harmonic (18 kHz) is an alias
      // (27 kHz → 21 kHz, 36 → 12, 45 → 3, …). Without oversampling the 21 kHz line sits at
      // the 3rd-harmonic level (≈ −30 dB at drive 0.5).
      let audible = 0, full = 0;
      for (let k = 10; k < p.length; k++) {
        const f = (k * SR) / N;
        if (Math.abs(f - f0) < 200 || Math.abs(f - 2 * f0) < 200) continue;
        if (f < 20000) audible = Math.max(audible, p[k]);
        full = Math.max(full, p[k]);
      }
      const aDb = 10 * Math.log10(audible / fund), fDb = 10 * Math.log10(full / fund);
      if (drive <= 0.75) assert(aDb < -120, `drive ${drive}: alias below 20 kHz ${aDb.toFixed(1)} dB`);
      else assert(aDb < -70, `drive ${drive}: alias below 20 kHz ${aDb.toFixed(1)} dB`);
      if (drive <= 0.5) assert(fDb < -88, `drive ${drive}: alias up to Nyquist ${fDb.toFixed(1)} dB`);
      res.push(`drive ${drive}: <20k ${aDb.toFixed(0)} dB, to Nyquist ${fDb.toFixed(0)} dB`);
    }
    return res.join('; ');
  },

  'saturate: zero latency and safe on short / extreme input': () => {
    const s = sine(300, 0.5, SR, 0.3);
    const ch = [Float32Array.from(s), Float32Array.from(s)];
    saturate(ch, SR, { drive: 0.2 });
    // in phase: projection on the input is maximal at lag 0
    const corr = (lag) => {
      let a = 0;
      for (let i = 2000; i < 20000; i++) a += ch[0][i] * s[i + lag];
      return a;
    };
    assert(corr(0) > corr(1) && corr(0) > corr(-1), 'aligned');
    for (const len of [1, 10, 47]) {
      const t = [Float32Array.from({ length: len }, (_, i) => Math.sin(i) * 0.9), Float32Array.from({ length: len }, (_, i) => Math.cos(i) * 0.9)];
      saturate(t, SR, { drive: 0.8 });
      assertFinite(t);
    }
    const big = [Float32Array.from({ length: 4800 }, (_, i) => 10 * Math.sin(i * 0.05)), Float32Array.from({ length: 4800 }, (_, i) => (i === 100 ? 1e6 : 0))];
    saturate(big, SR, { drive: 1 });
    assertFinite(big);
    const mono = [sine(440, 0.2, SR, 0.5)];
    saturate(mono, SR, { drive: 0.4 });
    assertFinite(mono);
  },

  'saturate: loudness unchanged per ffmpeg ebur128 (±0.3 LU)': () => {
    if (!hasFfmpeg()) return 'skip';
    const music = [brickwall(pinkNoise(8, SR, 0.6, 55), 20000, SR, -2), brickwall(pinkNoise(8, SR, 0.6, 56), 20000, SR, -2)];
    const pIn = writeWavFloat(join(TMP, 'tone-sat-in.wav'), music, SR);
    const ch = music.map((c) => Float32Array.from(c));
    saturate(ch, SR, { drive: 0.3 });
    const pOut = writeWavFloat(join(TMP, 'tone-sat-out.wav'), ch, SR);
    const a = ffmpegLoudness(pIn), b = ffmpegLoudness(pOut);
    approx(b.integrated, a.integrated, 0.3, 'integrated loudness');
    return `${a.integrated} → ${b.integrated} LUFS`;
  },

  // ================================================================== air exciter

  'airExciter: amount 0 / no room / silent band are identities': () => {
    const L = pinkNoise(1, SR, 0.5, 61), R = pinkNoise(1, SR, 0.5, 62);
    for (const o of [{ amount: 0 }, { amount: 0.5, fromHz: 22000 }, {}]) {
      const ch = [Float32Array.from(L), Float32Array.from(R)];
      airExciter(ch, SR, o);
      assert(maxDiff(ch[0], L) === 0 && maxDiff(ch[1], R) === 0, `identity ${JSON.stringify(o)}`);
    }
    const lowOnly = [sine(100, 1, SR, 0.5), sine(100, 1, SR, 0.5)];
    const copy = lowOnly.map((c) => Float32Array.from(c));
    airExciter(lowOnly, SR, { amount: 1, fromHz: 12000 });
    const addLow = Float32Array.from(lowOnly[0], (v, i) => v - copy[0][i]);
    assert(db(rms(addLow) / rms(copy[0])) < -90, 'nothing in the source band → (almost) nothing added');
    for (const len of [0, 10, 300]) {
      const t = [Float32Array.from({ length: len }, (_, i) => Math.sin(i * 2)), Float32Array.from({ length: len }, (_, i) => Math.sin(i * 2.5))];
      airExciter(t, SR, { amount: 0.75, fromHz: 8000 });
      assertFinite(t);
    }
    const mono = [brickwall(pinkNoise(1, SR, 0.5, 65), 8000, SR)];
    const m0 = Float32Array.from(mono[0]);
    const st = airExciter(mono, SR, { amount: 0.5, fromHz: 8000 });
    assertFinite(mono);
    assert(maxDiff(mono[0], m0) > 0 && st.addedDb < -20, 'mono input is excited too');
  },

  'airExciter: adds energy only above fromHz − 500 Hz, mid only, at the RESEARCH mix levels': () => {
    const fromHz = 12000;
    const base = [brickwall(pinkNoise(4, SR, 0.5, 63), fromHz, SR, -2), brickwall(pinkNoise(4, SR, 0.5, 64), fromHz, SR, -2)];
    const out = [];
    const addRms = {};
    for (const amount of [0.25, 0.5, 0.75]) {
      const ch = base.map((c) => Float32Array.from(c));
      const st = airExciter(ch, SR, { amount, fromHz });
      const add = Float32Array.from(ch[0], (v, i) => v - base[0][i]);
      const addR = Float32Array.from(ch[1], (v, i) => v - base[1][i]);
      assert(maxDiff(add, addR) < 1e-6, 'added content is identical in L and R (mid only)');
      const N = 65536;
      const p = powerSpectrum(add, 20000, N);
      const above = bandEnergy(p, SR, N, fromHz - 500, SR / 2);
      const below = bandEnergy(p, SR, N, 20, (fromHz - 500) / 2);
      const nearBelow = bandEnergy(p, SR, N, (fromHz - 500) / 2, fromHz - 500);
      assert(10 * Math.log10(below / above) < -40, `energy an octave+ below the HP: ${(10 * Math.log10(below / above)).toFixed(1)} dB`);
      assert(10 * Math.log10(nearBelow / above) < -6, `energy just below the HP: ${(10 * Math.log10(nearBelow / above)).toFixed(1)} dB`);
      // there was nothing above fromHz before; now there is
      const pin = powerSpectrum(base[0], 20000, N);
      const pout = powerSpectrum(ch[0], 20000, N);
      const gain = 10 * Math.log10(bandEnergy(pout, SR, N, fromHz + 500, 20000) / Math.max(1e-30, bandEnergy(pin, SR, N, fromHz + 500, 20000)));
      assert(gain > 40, 'air added above the cutoff');
      addRms[amount] = rms(add);
      out.push(`amount ${amount}: mix ${st.mixDb.toFixed(1)} dB, added ${st.addedDb.toFixed(1)} dB re input, below/above ${(10 * Math.log10(below / above)).toFixed(0)} dB`);
    }
    approx(db(addRms[0.5] / addRms[0.25]), 6, 0.05, '−24 vs −30 dB');
    approx(db(addRms[0.75] / addRms[0.5]), 5, 0.05, '−19 vs −24 dB');
    return out.join('; ');
  },

  'airExciter: generated harmonics are time-aligned with their source': () => {
    // 6 kHz tone burst (source band 4–8 kHz for fromHz = 8000) → harmonics at 12/18 kHz
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 20000; i < 22400; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 6000 * i) / SR) * Math.sin((Math.PI * (i - 20000)) / 2400) ** 2;
    const ch = [Float32Array.from(x), Float32Array.from(x)];
    airExciter(ch, SR, { amount: 1, fromHz: 8000 });
    const add = Float32Array.from(ch[0], (v, i) => v - x[i]);
    // envelope centroid of the added signal vs the burst centre (21200)
    let s = 0, w = 0;
    for (let i = 0; i < n; i++) {
      s += i * add[i] * add[i];
      w += add[i] * add[i];
    }
    const centre = s / w;
    assert(Math.abs(centre - 21200) < 3, `centroid ${centre.toFixed(1)} (expected 21200)`);
    const before = add.subarray(0, 19000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert(before < 1e-6, 'no pre-echo far before the burst');
    return `centroid offset ${(centre - 21200).toFixed(2)} samples`;
  },

  // ================================================================== performance

  'perf: tone modules on 3:30 stereo 48 kHz (each < 800 ms @M1)': () => {
    const L = pinkNoise(210, SR, 0.5, 71), R = pinkNoise(210, SR, 0.5, 72);
    const fresh = () => [Float32Array.from(L), Float32Array.from(R)];
    const f = speedFactor();
    const budget = 800;
    const res = [];
    // warm up the JIT on a short excerpt
    const warm = [L.subarray(0, SR * 2), R.subarray(0, SR * 2)].map((c) => Float32Array.from(c));
    saturate(warm, SR, { drive: 0.2 });
    airExciter(warm, SR, { amount: 0.5 });
    stereoImage(warm, SR, { width: 1.1, monoBassHz: 100 });
    ltas(warm, SR);
    hfCutoffHz(warm, SR);
    bandCorrelation(warm, SR, [120, 1000, 8000]);
    const cases = [
      ['ltas', (ch) => ltas(ch, SR)],
      ['hfCutoffHz', (ch) => hfCutoffHz(ch, SR)],
      ['stereoImage', (ch) => stereoImage(ch, SR, { width: 1.2, widthFromHz: 1500, monoBassHz: 100 })],
      ['correlation+sideToMid', (ch) => { correlation(ch); sideToMidDb(ch); }],
      ['bandCorrelation(4 bands)', (ch) => bandCorrelation(ch, SR, [120, 1000, 8000])],
      ['saturate', (ch) => saturate(ch, SR, { drive: 0.1 })],
      ['airExciter', (ch) => airExciter(ch, SR, { amount: 0.5, fromHz: 12000 })],
    ];
    for (const [name, fn] of cases) {
      let best = Infinity;
      for (let r = 0; r < 2; r++) {
        const ch = fresh();
        const t0 = performance.now();
        fn(ch);
        best = Math.min(best, performance.now() - t0);
      }
      assert(best < budget * f, `${name}: ${best.toFixed(0)} ms exceeds ${budget} ms × host factor ${f.toFixed(2)}`);
      res.push(`${name} ${best.toFixed(0)}`);
    }
    const tFit = bestOf(3, () => fitGraphicEq(autoEqCurve(ltas([warm[0], warm[1]], SR), { strength: 0.6, styleTiltDbPerOct: 0.3 }), SR));
    res.push(`autoEq+fit ${tFit.toFixed(0)}`);
    return `ms: ${res.join(', ')} (host factor ${f.toFixed(2)})`;
  },
};

function clampN(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function dbToG(d) {
  return Math.pow(10, d / 20);
}

void rng;
void design;
