// Dynamics + limiter tests: static curve, time constants, linking, auto threshold, level
// statistics, dynamic band cut (band/shelf, stereo/mid/side, relative detection), true-peak
// limiter (ceiling guarantee vs truePeakDb and ffmpeg ebur128, transparency, latency,
// clicks, THD, release), soft clipper (curve, transparency, aliasing, reference
// equivalence) and performance against the ARCHITECTURE §8-derived budgets.
import { join } from 'node:path';
import {
  assert, approx, assertFinite, rng, sine, whiteNoise, pinkNoise, peak, rms, db, maxDiff, stereo,
  TMP, writeWavFloat, hasFfmpeg, ffmpegLoudness, ffmpegDecode,
  speedFactor,
} from './helpers.mjs';
import { gainComputerDb, levelStats, thresholdForTargetGr, calibrateThreshold, compress, dynamicBandCut, relativeBandStats } from '../src/dsp/dynamics.js';
import { limitTruePeak, softClip } from '../src/dsp/limiter.js';
import { truePeakDb, upsample, downsample } from '../src/dsp/oversample.js';
import { butterworth, processInPlace, responseDb, design } from '../src/dsp/biquad.js';
import { RealFFT, hann } from '../src/dsp/fft.js';

// ------------------------------------------------------------------ local helpers

const SR = 48000;


function perfReport(name, ms, budget) {
  const f = speedFactor();
  const msg = `${name}: ${ms.toFixed(0)} ms (budget ${budget} ms @M1; host factor ${f.toFixed(2)} → ≈${(ms / f).toFixed(0)} ms @M1)`;
  assert(ms < budget * f, `${msg} exceeds budget`);
  return msg;
}

const clone = (ch) => ch.map((c) => Float32Array.from(c));
const gain = (x, d) => {
  const g = 10 ** (d / 20);
  const o = Float32Array.from(x);
  for (let i = 0; i < o.length; i++) o[i] *= g;
  return o;
};
const dc = (n, v) => new Float32Array(n).fill(v);
const concat = (...arrs) => {
  const out = new Float32Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const pad = (x, n) => concat(new Float32Array(n), x, new Float32Array(n));
const exactlyEqual = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || v === b[i]);

/** Least-squares amplitude of a tone at f over [start, end). */
function toneAmp(y, f, fs, start = 0, end = y.length) {
  const w = (2 * Math.PI * f) / fs;
  let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
  for (let i = start; i < end; i++) {
    const s = Math.sin(w * i), c = Math.cos(w * i);
    ss += s * s; cc += c * c; sc += s * c; ys += y[i] * s; yc += y[i] * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys * cc - yc * sc) / det, b = (yc * ss - ys * sc) / det;
  return { amp: Math.hypot(a, b), a, b };
}

/** THD+N of a (near) pure tone in dB rel. the fundamental: residual after removing it. */
function thdN(y, f, fs, start, end) {
  const { a, b } = toneAmp(y, f, fs, start, end);
  const w = (2 * Math.PI * f) / fs;
  let e = 0, s = 0;
  for (let i = start; i < end; i++) {
    const r = a * Math.sin(w * i) + b * Math.cos(w * i);
    e += (y[i] - r) ** 2;
    s += r * r;
  }
  return 10 * Math.log10(Math.max(e, 1e-300) / s);
}

/** Static mean GR the way thresholdForTargetGr defines it (independent implementation). */
function meanStaticGr(x, fs, T, ratio, knee, windowMs = 50, gateDb = -60, relGateDb = -40) {
  const W = Math.round((windowMs * fs) / 1000);
  const lv = [];
  for (let s = 0; s < x.length; s += W) {
    const e = Math.min(x.length, s + W);
    let acc = 0;
    for (let i = s; i < e; i++) acc += x[i] * x[i];
    lv.push(10 * Math.log10(Math.max(acc / (e - s), 1e-30)));
  }
  const mx = Math.max(...lv);
  const g = lv.filter((v) => v >= Math.max(gateDb, mx + relGateDb));
  return g.reduce((s, v) => s - gainComputerDb(v, T, ratio, knee), 0) / g.length;
}

function square(f, sec, fs, amp, phase = 0) {
  const n = Math.round(sec * fs);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = amp * (Math.sin((2 * Math.PI * f * i) / fs + phase) >= 0 ? 1 : -1);
  return o;
}
function clippedNoise(sec, fs, seed, drive = 3) {
  const x = whiteNoise(sec, fs, drive, seed);
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i]));
  return x;
}
function kicks(sec, fs, amp, seed = 1) {
  const n = Math.round(sec * fs);
  const o = new Float32Array(n);
  const per = Math.round(0.5 * fs);
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const t = (i % per) / fs;
    const click = t < 0.002 ? amp * 0.8 * (1 - t / 0.002) * (2 * r() - 1) : 0;
    o[i] = amp * Math.exp(-t * 20) * Math.sin(2 * Math.PI * (50 + 150 * Math.exp(-t * 40)) * t) + click;
  }
  return o;
}

/** ffmpeg's ebur128 true peak with full precision: libswresample's 192 kHz filter (exact). */
function ffmpegExactTp(path) {
  const up = ffmpegDecode(path, 192000);
  return db(Math.max(peak(up[0]), peak(up[1])));
}

/** Brutal limiter material (silence-padded: ffmpeg mirrors/flushes at file edges). */
function brutalSet(fs) {
  const s = 1.5, p = Math.round(0.01 * fs);
  return [
    ['square 1 kHz +3.5 dB', [pad(square(1000, s, fs, 1.5), p), pad(square(1000, s, fs, 1.5, 1), p)]],
    ['clipped white noise', [pad(clippedNoise(s, fs, 1), p), pad(clippedNoise(s, fs, 2), p)]],
    ['kick transients +8 dB', [pad(kicks(s, fs, 2.5, 1), p), pad(kicks(s, fs, 2.4, 2), p)]],
    ['pink noise +12 dB', [pad(pinkNoise(s, fs, 4, 1), p), pad(pinkNoise(s, fs, 4, 2), p)]],
    ['ISP sines fs/4 45° +3 dB', [pad(sine(fs / 4, s, fs, 1.41, Math.PI / 4), p), pad(sine((fs / 4) * 0.999, s, fs, 1.41, 0.3), p)]],
    ['HF sines 0.45/0.43 fs', [pad(sine(0.45 * fs, s, fs, 1.5, 0.1), p), pad(sine(0.43 * fs, s, fs, 1.5, 0.7), p)]],
  ];
}

/** Analytic dB of the forced dynamic shelf 1 − (1 − g)·HP1(fc) at f (bilinear HP1). */
function shelfDb(f, fc, cutDb, fs) {
  const g = 10 ** (-cutDb / 20);
  const K = Math.tan((Math.PI * fc) / fs), w = (2 * Math.PI * f) / fs;
  const zr = Math.cos(w), zi = -Math.sin(w); // z^-1
  const nr = (1 - zr) / (1 + K), ni = -zi / (1 + K);
  const a1 = (K - 1) / (K + 1);
  const dr = 1 + a1 * zr, di = a1 * zi;
  const hr = (nr * dr + ni * di) / (dr * dr + di * di), hi = (ni * dr - nr * di) / (dr * dr + di * di);
  return 20 * Math.log10(Math.hypot(1 - (1 - g) * hr, -(1 - g) * hi));
}

/** Power fraction of white noise passed by a section (numerical mean of |H|² over 0…fs/2). */
function firstOrderHp(fc, fs) {
  const K = Math.tan((Math.PI * fc) / fs);
  return { b0: 1 / (1 + K), b1: -1 / (1 + K), b2: 0, a1: (K - 1) / (K + 1), a2: 0 };
}

function noiseFraction(sec, fs) {
  let s = 0;
  const M = 20000;
  for (let i = 0; i < M; i++) s += 10 ** (responseDb(sec, ((i + 0.5) / M) * (fs / 2), fs) / 10);
  return s / M;
}

// Reference soft clipper (dense): full 4x up / clip / residual down with oversample.js.
function refSoftClip(x, T, c) {
  const u = upsample(x, 4);
  const r4 = new Float32Array(u.length);
  for (let q = 0; q < u.length; q++) {
    const v = u[q], av = Math.abs(v);
    if (av > T) r4[q] = Math.sign(v) * (T + (c - T) * Math.tanh((av - T) / (c - T))) - v;
  }
  const d = downsample(r4, 4);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] + d[i];
  return y; // unclamped: softClip adds smooth dips where this exceeds c
}

/** Non-harmonic (alias) energy rel. the fundamental, Hann-windowed FFT (harmonics ±8 bins). */
function aliasDb(y, f, fs) {
  const n = 32768, fft = new RealFFT(n), w = hann(n);
  const inp = new Float64Array(n);
  for (let i = 0; i < n; i++) inp[i] = y[4000 + i] * w[i];
  const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
  fft.forward(inp, re, im);
  let alias = 0, fund = 0;
  const tol = (8 * fs) / n;
  for (let k = 1; k <= n / 2; k++) {
    const p = re[k] ** 2 + im[k] ** 2, fk = (k * fs) / n;
    let harm = false;
    for (let h = 1; h * f < fs / 2 + tol; h++) if (Math.abs(fk - h * f) < tol) harm = true;
    if (Math.abs(fk - f) < tol) fund += p;
    if (!harm) alias += p;
  }
  return 10 * Math.log10(alias / fund);
}

// ------------------------------------------------------------------ tests

export const tests = {
  // ================================================================ static curve

  'gainComputerDb: static soft-knee curve values': () => {
    // below the knee: 0; above: (1/R − 1)(x − T); knee: quadratic, C¹ at both edges
    approx(gainComputerDb(-40, -20, 4, 6), 0, 0, 'below');
    approx(gainComputerDb(-23, -20, 4, 6), 0, 1e-12, 'knee start');
    approx(gainComputerDb(-10, -20, 4, 6), -7.5, 1e-12, 'above: 10 dB over at 4:1');
    approx(gainComputerDb(-20, -20, 4, 6), (-0.75 * 9) / 12, 1e-12, 'knee centre (1/R−1)(W/2)²/(2W)');
    approx(gainComputerDb(-17, -20, 4, 6), -2.25, 1e-12, 'knee end equals the line');
    // C¹: slope 0 at the knee start and (1/R − 1) at the end
    const e = 1e-6;
    approx((gainComputerDb(-23 + e, -20, 4, 6) - gainComputerDb(-23, -20, 4, 6)) / e, 0, 1e-5, 'slope at knee start');
    approx((gainComputerDb(-17, -20, 4, 6) - gainComputerDb(-17 - e, -20, 4, 6)) / e, -0.75, 1e-5, 'slope at knee end');
    // hard knee, limiter, ratio <= 1, disabled and non-finite inputs
    approx(gainComputerDb(-19, -20, 2, 0), -0.5, 1e-12, 'hard knee');
    approx(gainComputerDb(-20, -20, 2, 0), 0, 0, 'hard knee at T');
    approx(gainComputerDb(0, -6, Infinity, 0), -6, 1e-12, '∞:1');
    for (const v of [gainComputerDb(0, -20, 1, 6), gainComputerDb(0, -20, 0.5, 6), gainComputerDb(0, Infinity, 4, 6),
      gainComputerDb(-Infinity, -20, 4, 6), gainComputerDb(NaN, -20, 4, 6), gainComputerDb(0, NaN, 4, 6)]) {
      assert(v === 0, `disabled/non-finite → 0, got ${v}`);
    }
    // monotone non-increasing in level, never positive
    let prev = 0;
    for (let x = -60; x <= 10; x += 0.25) {
      const g = gainComputerDb(x, -20, 3, 8);
      assert(g <= 0 && g <= prev + 1e-12, `monotone at ${x}`);
      prev = g;
    }
  },

  // ================================================================ compressor

  'compress: steady-state GR equals the static curve (peak on DC, RMS on a sine)': () => {
    const n = SR;
    // peak detector on a constant level: exact steady state
    for (const [level, T, R, W] of [[0.5, -12, 4, 6], [0.25, -10, 2, 0], [0.8, -6, 1.5, 10]]) {
      const x = [dc(n, level), dc(n, -level)];
      const r = compress(x, SR, { thresholdDb: T, ratio: R, kneeDb: W, attackMs: 5, releaseMs: 50, detector: 'peak' });
      const expect = gainComputerDb(db(level), T, R, W);
      approx(db(Math.abs(x[0][n - 1]) / level), expect, 1e-4, `peak DC ${level}`);
      approx(x[1][n - 1], -x[0][n - 1], 0, 'linked, sign kept');
      approx(r.grMaxDb, expect, 1e-3, 'grMaxDb');
    }
    // RMS detector: level = A/√2 for a 1 kHz sine (ripple of a 10 ms mean square ≈ 0.03 dB)
    const A = 0.7, x = [sine(1000, 1, SR, A), sine(1000, 1, SR, A)];
    compress(x, SR, { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 100, detector: 'rms', rmsMs: 10 });
    const out = toneAmp(x[0], 1000, SR, SR / 2, SR).amp;
    approx(db(out / A), gainComputerDb(db(A / Math.SQRT2), -20, 3, 6), 0.05, 'RMS steady state');
  },

  'compress: 63% attack and release times (branching smoothing in dB)': () => {
    for (const [att, rel] of [[10, 100], [30, 150], [2, 40]]) {
      const n1 = Math.round(0.3 * SR), n2 = Math.round(1.5 * SR);
      const x = concat(dc(n1, 0.02), dc(n2, 0.8), dc(n2, 0.02));
      const y = Float32Array.from(x);
      compress([y], SR, { thresholdDb: -30, ratio: 4, kneeDb: 0, attackMs: att, releaseMs: rel, detector: 'peak' });
      const grDb = (i) => db(Math.abs(y[i] / x[i]));
      const gHigh = gainComputerDb(db(0.8), -30, 4, 0); // reached at the end of the loud part
      const gLow = gainComputerDb(db(0.02), -30, 4, 0); // 0 (below threshold)
      assert(gLow === 0, 'quiet level below threshold');
      // attack: time to cover 63.2 % of the step in dB
      let ia = n1;
      while (grDb(ia) > 0.632 * gHigh) ia++;
      approx(((ia - n1) / SR) * 1000, att, Math.max(0.05, 0.01 * att), `attack ${att} ms`);
      // release: from gHigh back toward gLow
      let ir = n1 + n2;
      while (grDb(ir) < gHigh + 0.632 * (gLow - gHigh)) ir++;
      approx(((ir - n1 - n2) / SR) * 1000, rel, Math.max(0.1, 0.01 * rel), `release ${rel} ms`);
    }
  },

  'compress: GR on step signals, stereo link and makeup/mix': () => {
    // step up: GR converges to the static value; step down: back to 0
    const n = SR;
    const x = concat(dc(n, 0.1), dc(n, 0.9), dc(n, 0.1));
    const y = Float32Array.from(x);
    const r = compress([y], SR, { thresholdDb: -20, ratio: 5, kneeDb: 4, attackMs: 5, releaseMs: 50, detector: 'peak' });
    approx(db(y[2 * n - 1] / 0.9), gainComputerDb(db(0.9), -20, 5, 4), 1e-3, 'after attack');
    approx(db(y[3 * n - 1] / 0.1), gainComputerDb(db(0.1), -20, 5, 4), 1e-3, 'after release');
    assert(r.grAvgDb < 0 && r.grAvgDb > r.grMaxDb, 'stats');
    // stereo link: loud L, quiet R → one gain (ratio L/R preserved), driven by max(L, R)
    const L = sine(500, 1, SR, 0.9), R = sine(700, 1, SR, 0.05);
    const ch = [Float32Array.from(L), Float32Array.from(R)];
    compress(ch, SR, { thresholdDb: -18, ratio: 4, attackMs: 5, releaseMs: 50 });
    let maxErr = 0;
    for (let i = 1000; i < SR; i += 7) {
      if (Math.abs(L[i]) > 0.1 && Math.abs(R[i]) > 0.01) maxErr = Math.max(maxErr, Math.abs(ch[0][i] / L[i] - ch[1][i] / R[i]));
    }
    assert(maxErr < 1e-6, `one gain for both channels (${maxErr})`);
    const solo = [Float32Array.from(L)];
    compress(solo, SR, { thresholdDb: -18, ratio: 4, attackMs: 5, releaseMs: 50 });
    approx(toneAmp(ch[0], 500, SR, SR / 2, SR).amp, toneAmp(solo[0], 500, SR, SR / 2, SR).amp, 1e-6, 'GR set by the louder channel');
    // makeup and parallel mix (no compression: threshold above the signal)
    const m = [sine(1000, 0.2, SR, 0.1)];
    compress(m, SR, { thresholdDb: 0, ratio: 4, makeupDb: 6 });
    approx(peak(m[0]), 0.1 * 10 ** (6 / 20), 1e-6, 'makeup');
    const p = [dc(SR, 0.9)];
    compress(p, SR, { thresholdDb: -20, ratio: 1e9, kneeDb: 0, attackMs: 1, releaseMs: 10, detector: 'peak', mix: 0.5 });
    approx(p[0][SR - 1], 0.5 * 0.9 + 0.5 * 0.1, 1e-4, 'mix = 0.5 blends dry and (limited) wet');
  },

  'compress: identity cases, silence, short inputs, non-stereo channel counts': () => {
    const x = stereo(pinkNoise(0.5, SR, 0.5, 3), pinkNoise(0.5, SR, 0.5, 4));
    for (const o of [{ thresholdDb: 0, ratio: 4 }, { thresholdDb: -40, ratio: 1 }, { thresholdDb: -40, ratio: 4, mix: 0 },
      { thresholdDb: Infinity, ratio: 4 }, { ratio: 4 }]) {
      const y = clone(x);
      const r = compress(y, SR, o);
      assert(exactlyEqual(y[0], x[0]) && exactlyEqual(y[1], x[1]), `identity for ${JSON.stringify(o)}`);
      assert(r.grAvgDb === 0 && r.grMaxDb === 0, 'zero stats');
    }
    const s = [new Float32Array(1000), new Float32Array(1000)];
    const r = compress(s, SR, { thresholdDb: -60, ratio: 10, makeupDb: 10, detector: 'rms' });
    assert(peak(s[0]) === 0 && r.grAvgDb === 0 && Number.isFinite(r.grMaxDb), 'silence');
    for (const n of [0, 1, 2, 10]) {
      for (const o of [{ detector: 'rms' }, { detector: 'peak', lookaheadMs: 2, autoRelease: true, sidechainHpHz: 100 }]) {
        const t = [whiteNoise(n / SR, SR, 1, n + 1), whiteNoise(n / SR, SR, 1, n + 2)];
        const st = compress(t, SR, { thresholdDb: -30, ratio: 4, ...o });
        assertFinite(t);
        assert(Number.isFinite(st.grAvgDb) && Number.isFinite(st.grMaxDb), `stats finite n=${n}`);
      }
    }
    const mono = [sine(1000, 0.3, SR, 0.9)];
    compress(mono, SR, { thresholdDb: -20, ratio: 4, detector: 'peak', attackMs: 1 });
    assert(peak(mono[0].subarray(SR * 0.2)) < 0.5, 'mono works');
    const three = [sine(1000, 0.3, SR, 0.9), sine(1000, 0.3, SR, 0.1), sine(1000, 0.3, SR, 0.1)];
    compress(three, SR, { thresholdDb: -20, ratio: 4, detector: 'peak', attackMs: 1 });
    approx(three[0][14000] / 0.9, three[2][14000] / 0.1, 1e-6, '3 channels linked');
  },

  'compress: aligned lookahead, sidechain + sidechain high-pass, auto release': () => {
    // lookahead: the gain starts falling La before the step; zero latency otherwise
    const n = SR / 2;
    const x = concat(dc(n, 0.05), dc(n, 0.9));
    const y0 = Float32Array.from(x), y5 = Float32Array.from(x);
    compress([y0], SR, { thresholdDb: -20, ratio: 8, kneeDb: 0, attackMs: 2, releaseMs: 50, detector: 'peak' });
    compress([y5], SR, { thresholdDb: -20, ratio: 8, kneeDb: 0, attackMs: 2, releaseMs: 50, detector: 'peak', lookaheadMs: 5 });
    const la = Math.round(0.005 * SR);
    assert(y0[n - 1] === x[n - 1], 'no lookahead: untouched before the step');
    assert(y5[n - la - 8] === x[n - la - 8], 'lookahead: untouched before n − La');
    assert(y5[n - 1] < 0.999 * x[n - 1], 'lookahead: gain already falling before the step');
    // the lookahead curve is the plain one shifted by La (aligned, no extra delay)
    let d = 0;
    for (let i = n; i < 2 * n - la; i += 3) d = Math.max(d, Math.abs(y5[i] / x[i] - y0[i + la] / x[i + la]));
    assert(d < 2e-3, `shifted gain curve (${d})`);
    // external sidechain drives the gain
    const prog = [sine(1000, 1, SR, 0.1)];
    const key = sine(200, 1, SR, 0.9);
    compress(prog, SR, { thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 50, sidechain: key });
    approx(db(toneAmp(prog[0], 1000, SR, SR / 2, SR).amp / 0.1), gainComputerDb(db(0.9 / Math.SQRT2), -20, 4, 6), 0.1, 'sidechain-driven GR');
    // sidechain high-pass: 40 Hz content barely compresses with a 150 Hz HPF
    const bass = [sine(40, 1, SR, 0.8)], bassHp = [sine(40, 1, SR, 0.8)];
    const r1 = compress(bass, SR, { thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 100 });
    const r2 = compress(bassHp, SR, { thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 100, sidechainHpHz: 150 });
    assert(r1.grAvgDb < -5 && r2.grAvgDb > r1.grAvgDb + 4, `HPF reduces bass-driven GR (${r1.grAvgDb.toFixed(2)} vs ${r2.grAvgDb.toFixed(2)})`);
    // auto release: recovery after a short burst is fast, after a long sustained section slow
    const quiet = dc(Math.round(1.5 * SR), 0.02);
    const shortBurst = concat(dc(SR / 2, 0.02), dc(Math.round(0.02 * SR), 0.9), quiet);
    const longBurst = concat(dc(SR / 2, 0.02), dc(3 * SR, 0.9), quiet);
    const recov = (sig) => {
      const y = Float32Array.from(sig);
      compress([y], SR, { thresholdDb: -30, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 150, autoRelease: true, detector: 'peak' });
      const start = sig.length - quiet.length;
      const g0 = db(y[start] / sig[start]);
      let i = start;
      while (db(y[i] / sig[i]) < g0 * (1 - 0.632) && i < sig.length - 1) i++;
      return ((i - start) / SR) * 1000;
    };
    const tShort = recov(shortBurst), tLong = recov(longBurst);
    assert(tShort < 120 && tLong > 300, `program-dependent release: ${tShort.toFixed(0)} ms after 20 ms burst, ${tLong.toFixed(0)} ms after 3 s`);
    return `auto release 63%: ${tShort.toFixed(0)} ms (short burst) vs ${tLong.toFixed(0)} ms (sustained)`;
  },

  // ================================================================ level statistics

  'levelStats: percentiles, gating and power mean': () => {
    // 4 s at −20 dBFS RMS, 4 s at −30 dBFS RMS, 2 s silence, 1 s at −90 (below gate)
    const a = sine(1000, 4, SR, 0.1 * Math.SQRT2), b = sine(1000, 4, SR, 0.0316227766 * Math.SQRT2);
    const x = concat(a, b, new Float32Array(2 * SR), sine(1000, 1, SR, 3.16e-5 * Math.SQRT2));
    const s = levelStats(x, SR);
    approx(s.max, -20, 0.01, 'max');
    approx(s.p75, -20, 0.01, 'p75');
    approx(s.p10, -30, 0.01, 'p10');
    approx(s.p50, -25, 5.01, 'p50 between');
    approx(s.mean, 10 * Math.log10((0.01 + 0.001) / 2), 0.01, 'power mean of the gated windows');
    approx(s.count, 160, 0, '8 s of 50 ms windows (silence and −90 dB gated)');
    // relative gate: a −70 dB section next to a 0 dB section is ignored with relGateDb −40
    const r = levelStats(concat(sine(100, 1, SR, 1), sine(100, 1, SR, 3e-4)), SR, { windowMs: 100 });
    approx(r.p10, db(1 / Math.SQRT2), 0.05, 'relative gate');
    // stereo extension = linked max; silence → −240 finite
    const st = levelStats([gain(a, -6), a], SR);
    approx(st.max, -20, 0.01, 'linked max of channels');
    const z = levelStats(new Float32Array(1000), SR);
    assert(z.count === 0 && z.p50 === -240 && z.mean === -240, 'silence');
    const tiny = levelStats(whiteNoise(10 / SR, SR, 0.5, 1), SR);
    assert(Number.isFinite(tiny.p50) && tiny.count === 1, 'short input: one partial window');
  },

  'thresholdForTargetGr: achieves the target static GR within 0.1 dB': () => {
    const sigs = [
      ['pink', pinkNoise(20, SR, 0.5, 7)],
      ['dynamic', concat(gain(pinkNoise(6, SR, 0.5, 8), -12), pinkNoise(6, SR, 0.5, 9), gain(pinkNoise(6, SR, 0.5, 10), -6))],
      ['kicks', kicks(10, SR, 0.5)],
    ];
    const out = [];
    for (const [name, x] of sigs) {
      for (const [ratio, knee, target] of [[1.7, 8, 1], [2, 6, 2], [4, 0, 3], [1.4, 10, 0.5]]) {
        const T = thresholdForTargetGr(x, SR, { ratio, kneeDb: knee, targetGrDb: target });
        const got = meanStaticGr(x, SR, T, ratio, knee);
        approx(got, target, 0.1, `${name} R${ratio} target ${target}`);
      }
      // the dynamic compressor at that threshold lands near the static estimate
      const T = thresholdForTargetGr(x, SR, { ratio: 2, kneeDb: 6, targetGrDb: 2 });
      const y = [Float32Array.from(x)];
      const r = compress(y, SR, { thresholdDb: T, ratio: 2, kneeDb: 6, attackMs: 30, releaseMs: 150 });
      assert(r.grAvgDb < -1 && r.grAvgDb > -3.5, `${name}: dynamic GR ${r.grAvgDb.toFixed(2)} dB for a 2 dB static target`);
      out.push(`${name} dyn ${r.grAvgDb.toFixed(2)}`);
    }
    assert(thresholdForTargetGr(sigs[0][1], SR, { ratio: 2, targetGrDb: 0 }) === Infinity, 'target 0 → +Infinity');
    assert(thresholdForTargetGr(sigs[0][1], SR, { ratio: 1, targetGrDb: 2 }) === Infinity, 'ratio 1 → +Infinity');
    assert(thresholdForTargetGr(new Float32Array(SR), SR, { ratio: 2, targetGrDb: 2 }) === Infinity, 'silence → +Infinity');
    assert(Number.isFinite(thresholdForTargetGr(whiteNoise(10 / SR, SR, 0.5, 1), SR, { ratio: 2, targetGrDb: 1 })), 'short input');
    // sidechain high-pass extension matches compress({ sidechainHpHz })
    const bassy = concat(sine(50, 5, SR, 0.5));
    for (let i = 0; i < bassy.length; i++) bassy[i] += 0.05 * Math.sin((2 * Math.PI * 3000 * i) / SR);
    const tHp = thresholdForTargetGr(bassy, SR, { ratio: 2, kneeDb: 6, targetGrDb: 1, sidechainHpHz: 100 });
    const hp = processInPlace(Float32Array.from(bassy), butterworth('highpass', 2, 100, SR));
    approx(meanStaticGr(hp, SR, tHp, 2, 6), 1, 0.1, 'HP sidechain');
    return out.join(', ');
  },

  'calibrateThreshold: realised loud-section GR hits the target with real ballistics': () => {
    // verse (−10 dB) / chorus / verse / chorus with drum hits: the static estimate ignores the
    // smoothing and overshoots; the calibrated threshold lands on the target and leaves the
    // verses (below the loud-section gate) alone
    const verse = (s) => gain(pinkNoise(5, SR, 0.5, s), -10);
    const chorus = (s) => {
      const c = pinkNoise(5, SR, 0.4, s), k = kicks(5, SR, 0.4, s);
      for (let i = 0; i < c.length; i++) c[i] += k[i];
      return c;
    };
    const x = concat(verse(21), chorus(31), verse(22), chorus(32));
    const ch = [x, Float32Array.from(x)];
    const LOUD = { relGateDb: -8, gateRefPct: 0.95 };
    const settings = {
      glue: { ratio: 1.7, kneeDb: 8, attackMs: 30, releaseMs: 150, autoRelease: true, rmsMs: 10, sidechainHpHz: 130, sidechainHpOrder: 4 },
      high: { ratio: 2, kneeDb: 6, attackMs: 5, releaseMs: 60, rmsMs: 5 },
      low: { ratio: 1.6, kneeDb: 6, attackMs: 60, releaseMs: 300, rmsMs: 60 },
    };
    const rows = [];
    for (const [name, o] of Object.entries(settings)) {
      for (const target of [0.5, 1, 2]) {
        const cal = calibrateThreshold(ch, SR, { ...o, targetGrDb: target, ...LOUD });
        assert(Number.isFinite(cal.thresholdDb) && cal.envelope && cal.simulations <= 5, `${name}: calibration result`);
        const y = clone(ch);
        const st = compress(y, SR, { ...o, thresholdDb: cal.thresholdDb, envelope: cal.envelope, statsGateDb: cal.statsGateDb });
        approx(-st.grLoudAvgDb, target, 0.1, `${name} target ${target}: realised loud GR`);
        approx(st.grLoudAvgDb, cal.grLoudAvgDb, 1e-9, `${name}: compress reproduces the calibrated simulation`);
        // the verses (10 dB down) keep most of their level: far less GR than the loud parts
        const vIn = rms(ch[0], SR, 4 * SR), vOut = rms(y[0], SR, 4 * SR);
        assert(db(vOut / vIn) > -0.3 * target, `${name} target ${target}: verse GR ${db(vOut / vIn).toFixed(2)} dB`);
        // the envelope shortcut is exact: same output as a compressor computing its own detector
        if (target === 1) {
          const z = clone(ch);
          compress(z, SR, { ...o, thresholdDb: cal.thresholdDb });
          assert(maxDiff(z[0], y[0]) === 0 && maxDiff(z[1], y[1]) === 0, `${name}: envelope reuse is bit-exact`);
          // the static estimate (old behaviour) overshoots the same target
          const s = clone(ch);
          const Ts = thresholdForTargetGr(ch, SR, { ...o, targetGrDb: 1, ...LOUD });
          const ss = compress(s, SR, { ...o, thresholdDb: Ts, statsGateDb: cal.statsGateDb });
          rows.push(`${name}: static ${(-ss.grLoudAvgDb).toFixed(2)} dB → calibrated ${(-st.grLoudAvgDb).toFixed(2)} dB`);
        }
      }
    }
    const none = calibrateThreshold(ch, SR, { ratio: 2, targetGrDb: 0 });
    assert(none.thresholdDb === Infinity && none.envelope === null, 'target 0 → nothing to do');
    assert(calibrateThreshold([new Float32Array(SR), new Float32Array(SR)], SR, { ratio: 2, targetGrDb: 1 }).thresholdDb === Infinity, 'silence');
    return rows.join(' | ');
  },

  'compress: 4th-order sidechain high-pass keeps a kick from ducking the mids': () => {
    // steady 1 kHz "vocal" + 55 Hz kick bursts every 500 ms: how much does the tone dip on
    // each kick? 2nd order @100 Hz (old glue) vs 4th order @130 Hz
    const n = 6 * SR;
    const x = sine(1000, 6, SR, 0.25);
    for (let i = 0; i < n; i++) {
      const t = (i % (SR / 2)) / SR;
      if (t < 0.12) x[i] += 0.8 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 55 * t);
    }
    const dip = (order, hz) => {
      const y = [Float32Array.from(x), Float32Array.from(x)];
      compress(y, SR, { thresholdDb: -22, ratio: 2, kneeDb: 6, attackMs: 10, releaseMs: 150, rmsMs: 10, sidechainHpHz: hz, sidechainHpOrder: order });
      // tone level just after a kick vs just before the next one
      const at = (s) => toneAmp(y[0], 1000, SR, s, s + Math.round(0.02 * SR)).amp;
      let worst = 0;
      for (let k = 2; k < 11; k++) {
        const s = k * (SR / 2);
        worst = Math.max(worst, db(at(s - Math.round(0.03 * SR)) / at(s + Math.round(0.03 * SR))));
      }
      return worst;
    };
    const d2 = dip(2, 100), d4 = dip(4, 130);
    assert(d4 < 0.5 * d2 && d4 < 0.6, `kick-driven dip: order 2 @100 Hz ${d2.toFixed(2)} dB, order 4 @130 Hz ${d4.toFixed(2)} dB`);
    return `1 kHz dip on each kick: ${d2.toFixed(2)} dB (2nd order, 100 Hz) → ${d4.toFixed(2)} dB (4th order, 130 Hz)`;
  },

  'compress: peak detector never misses a sample at detector-block boundaries': () => {
    // attack 1.5 ms at 48 kHz → control period D = 3, which does not divide the 1024-sample
    // detector block: a lone spike at the end of a block used to be skipped (0 dB GR)
    const grs = [];
    for (const at of [1021, 1022, 1023, 1024, 2047, 3070, 3071]) {
      const x = new Float32Array(4096);
      x[at] = 0.9;
      const r = compress([x, Float32Array.from(x)], SR, { thresholdDb: -20, ratio: 10, attackMs: 1.5, releaseMs: 50, detector: 'peak' });
      grs.push(r.grMaxDb);
    }
    const lo = Math.min(...grs), hi = Math.max(...grs);
    assert(hi < -0.5 && hi - lo < 0.1, `spike GR by position: ${grs.map((g) => g.toFixed(2)).join(', ')}`);
    return `spike GR ${lo.toFixed(2)} … ${hi.toFixed(2)} dB at every block offset`;
  },

  // ================================================================ dynamic band cut

  'dynamicBandCut: forced cut gives exactly maxCut at the centre (band, all modes)': () => {
    for (const [f, q, cut] of [[300, 0.9, 2.5], [3500, 2, 4], [7000, 1.2, 6]]) {
      for (const channel of ['stereo', 'mid']) {
        const x = stereo(sine(f, 1, SR, 0.3));
        const r = dynamicBandCut(x, SR, { freq: f, q, maxCutDb: cut, thresholdRelDb: -100, ratio: 1000, channel });
        approx(db(toneAmp(x[0], f, SR, SR / 2, SR).amp / 0.3), -cut, 0.01, `${f} Hz ${channel}`);
        approx(r.grMaxDb, -cut, 1e-6, 'grMax');
        assert(r.activePct > 99, 'active');
      }
      // an octave away the dip is much smaller (peaking shape)
      const off = stereo(sine(f * 2, 1, SR, 0.3));
      const ref = stereo(sine(f, 1, SR, 0.3)); // detector driven at f, probe at 2f via a mix
      const mixd = [new Float32Array(SR), new Float32Array(SR)];
      for (let i = 0; i < SR; i++) mixd[0][i] = mixd[1][i] = ref[0][i] + off[0][i];
      dynamicBandCut(mixd, SR, { freq: f, q, maxCutDb: cut, thresholdRelDb: -100, ratio: 1000 });
      const atOct = db(toneAmp(mixd[0], 2 * f, SR, SR / 2, SR).amp / 0.3);
      // 1 + (g − 1)·BP0(f, q) ≡ Peaking(f, q/A, A) with A = √g (research/05 §7)
      const peakingDb = responseDb(design('peaking', f, SR, { q: q * 10 ** (cut / 40), gainDb: -cut }), 2 * f, SR);
      approx(atOct, peakingDb, 0.02, `${f} Hz: one octave up follows the equivalent peaking EQ`);
      assert(atOct > -cut / 2, 'one octave up: less than half the cut');
    }
  },

  'dynamicBandCut: exact identity below threshold or with maxCutDb = 0': () => {
    const x = stereo(pinkNoise(2, SR, 0.5, 11), pinkNoise(2, SR, 0.5, 12));
    for (const o of [{ maxCutDb: 0, thresholdRelDb: -100 }, { maxCutDb: 6, thresholdRelDb: 30 }, { maxCutDb: 6, ratio: 1, thresholdRelDb: -100 }]) {
      for (const channel of ['stereo', 'mid', 'side']) {
        const y = clone(x);
        const r = dynamicBandCut(y, SR, { freq: 3000, q: 2, channel, ...o });
        assert(exactlyEqual(y[0], x[0]) && exactlyEqual(y[1], x[1]), `identity ${channel} ${JSON.stringify(o)}`);
        assert(r.grMaxDb === 0 && r.activePct === 0, 'no cut reported');
      }
    }
    // silence and short inputs
    for (const n of [0, 1, 10, 100]) {
      const t = [whiteNoise(n / SR, SR, 0.5, 1), whiteNoise(n / SR, SR, 0.5, 2)];
      dynamicBandCut(t, SR, { freq: 5000, maxCutDb: 4, thresholdRelDb: -100, lookaheadMs: 3 });
      assertFinite(t);
    }
    const z = [new Float32Array(5000), new Float32Array(5000)];
    const r = dynamicBandCut(z, SR, { freq: 5000, maxCutDb: 4, thresholdRelDb: -100 });
    assert(peak(z[0]) === 0 && Number.isFinite(r.thresholdDb), 'silence');
  },

  'dynamicBandCut: mid/side routing (side cut leaves mono untouched, mid cut leaves side)': () => {
    const f = 8000;
    // mono signal (L = R): a forced side cut is bit-exact
    const mono = stereo(concat(sine(f, 1, SR, 0.4)));
    const y = clone(mono);
    dynamicBandCut(y, SR, { freq: f, q: 1, maxCutDb: 6, thresholdRelDb: -100, ratio: 100, channel: 'side' });
    assert(exactlyEqual(y[0], mono[0]) && exactlyEqual(y[1], mono[1]), 'side cut on mono: identity');
    // pure side signal (L = −R): a forced mid cut is bit-exact
    const side = [sine(f, 1, SR, 0.4), gain(sine(f, 1, SR, 0.4), 0).map((v) => -v)];
    const y2 = clone(side);
    dynamicBandCut(y2, SR, { freq: f, maxCutDb: 6, thresholdRelDb: -100, ratio: 100, channel: 'mid' });
    assert(exactlyEqual(y2[0], side[0]) && exactlyEqual(y2[1], side[1]), 'mid cut on pure side: identity');
    // mixed: mid tone at 1 kHz + side tone at 8 kHz; side cut at 8 kHz hits only the side
    const m = sine(1000, 1, SR, 0.3), s = sine(f, 1, SR, 0.2);
    const L = new Float32Array(SR), R = new Float32Array(SR);
    for (let i = 0; i < SR; i++) { L[i] = m[i] + s[i]; R[i] = m[i] - s[i]; }
    const ch = [L, R];
    dynamicBandCut(ch, SR, { type: 'shelf', freq: 6000, maxCutDb: 3, thresholdRelDb: -100, ratio: 100, channel: 'side' });
    const M = new Float32Array(SR), S = new Float32Array(SR);
    for (let i = 0; i < SR; i++) { M[i] = 0.5 * (ch[0][i] + ch[1][i]); S[i] = 0.5 * (ch[0][i] - ch[1][i]); }
    assert(maxDiff(M, m) < 1e-6, 'mid component untouched');
    const sideDb = db(toneAmp(S, f, SR, SR / 2, SR).amp / 0.2);
    approx(sideDb, shelfDb(f, 6000, 3, SR), 0.01, 'side 8 kHz follows the forced shelf');
  },

  'dynamicBandCut: shelf variant (complementary first-order high shelf)': () => {
    const cut = 4;
    // forced: high frequencies → g, low frequencies untouched, exactly LP1 + g·HP1
    for (const fTest of [100, 3000, 12000, 20000]) {
      const x = stereo(sine(fTest, 1, SR, 0.3));
      dynamicBandCut(x, SR, { type: 'shelf', freq: 6000, maxCutDb: cut, thresholdRelDb: -100, ratio: 1000 });
      approx(db(toneAmp(x[0], fTest, SR, SR / 2, SR).amp / 0.3), shelfDb(fTest, 6000, cut, SR), 0.01, `shelf at ${fTest} Hz`);
    }
    assert(shelfDb(100, 6000, cut, SR) > -0.05 && shelfDb(23900, 6000, cut, SR) < -cut + 0.01, 'shelf shape: LF untouched, Nyquist = g');
  },

  'dynamicBandCut: relative detection, threshold = median + thresholdRelDb, bursts, lookahead': () => {
    // pink noise at −30 then −6 dBFS: same spectral balance → same (small) activity in both
    const base = concat(gain(pinkNoise(4, SR, 0.5, 21), -24), pinkNoise(4, SR, 0.5, 22));
    const x = stereo(base, base);
    const st = relativeBandStats(x, SR, { freq: 3000, q: 2 });
    const y = clone(x);
    const r = dynamicBandCut(y, SR, { freq: 3000, q: 2, maxCutDb: 4, thresholdRelDb: 2 });
    approx(r.thresholdDb, st.p50 + 2, 1e-9, 'threshold = relativeBandStats.p50 + thresholdRelDb');
    const rq = rms(y[0], SR, 4 * SR) / rms(x[0], SR, 4 * SR), rl = rms(y[0], 4 * SR + SR, 8 * SR) / rms(x[0], 4 * SR + SR, 8 * SR);
    approx(db(rq), db(rl), 0.1, 'loud and quiet passages treated alike (relative detection)');
    assert(r.activePct < 25 && r.grAvgDb > -0.5, `stationary noise: little activity (${r.activePct.toFixed(1)} %, ${r.grAvgDb.toFixed(2)} dB)`);
    // bursts of a 3 kHz resonance on top of the noise: cut during bursts only
    const noise = pinkNoise(6, SR, 0.3, 23);
    const tone = sine(3000, 6, SR, 0.25);
    const burst = new Float32Array(noise.length);
    const on = (i) => (i / SR) % 1 >= 0.5 && (i / SR) % 1 < 0.7;
    for (let i = 0; i < noise.length; i++) burst[i] = noise[i] + (on(i) ? tone[i] : 0);
    const xb = stereo(burst);
    const yb = clone(xb);
    dynamicBandCut(yb, SR, { freq: 3000, q: 2, maxCutDb: 4, thresholdRelDb: 2, attackMs: 10, releaseMs: 120 });
    let inB = 0, outB = 0, nIn = 0, nOut = 0;
    for (let s = 1; s < 6; s++) {
      const a = Math.round((s + 0.55) * SR), b = Math.round((s + 0.68) * SR);
      inB += db(toneAmp(yb[0], 3000, SR, a, b).amp / toneAmp(xb[0], 3000, SR, a, b).amp); nIn++;
      const c = Math.round((s + 0.05) * SR), d = Math.round((s + 0.4) * SR);
      outB += db(rms(yb[0], c, d) / rms(xb[0], c, d)); nOut++;
    }
    assert(inB / nIn < -2.5, `resonance bursts cut (${(inB / nIn).toFixed(2)} dB)`);
    assert(outB / nOut > -0.3, `between bursts nearly untouched (${(outB / nOut).toFixed(2)} dB)`);
    // lookahead: the cut is already in place at the burst onset
    const y0 = clone(xb), y3 = clone(xb);
    dynamicBandCut(y0, SR, { freq: 3000, q: 2, maxCutDb: 4, attackMs: 5 });
    dynamicBandCut(y3, SR, { freq: 3000, q: 2, maxCutDb: 4, attackMs: 5, lookaheadMs: 5 });
    const onset = Math.round(2.5 * SR);
    const e0 = rms(y0[0], onset, onset + 240) / rms(xb[0], onset, onset + 240);
    const e3 = rms(y3[0], onset, onset + 240) / rms(xb[0], onset, onset + 240);
    assert(e3 < e0 - 0.01, `lookahead cuts the first 5 ms of the burst (${db(e3).toFixed(2)} vs ${db(e0).toFixed(2)} dB)`);
    return `stationary activity ${r.activePct.toFixed(1)} %, burst cut ${(inB / nIn).toFixed(2)} dB, between ${(outB / nOut).toFixed(2)} dB`;
  },

  'relativeBandStats: white-noise band fraction, channel modes, silence': () => {
    // BP0 (0 dB peak) noise bandwidth ≈ (π/2)·f0/Q → power fraction (π/2)(f0/Q)/(fs/2)
    const x = stereo(whiteNoise(10, SR, 0.5, 31), whiteNoise(10, SR, 0.5, 32));
    for (const [f, q] of [[1000, 1], [4000, 2], [8000, 0.7]]) {
      const st = relativeBandStats(x, SR, { freq: f, q });
      const expect = 10 * Math.log10(noiseFraction(design('bandpass', f, SR, { q }), SR));
      approx(st.p50, expect, 0.15, `${f} Hz Q ${q}`);
      assert(st.p50 <= st.p75 && st.p75 <= st.p90 && st.p90 <= st.p95, 'ordered percentiles');
    }
    const sh = relativeBandStats(x, SR, { type: 'shelf', freq: 12000 });
    approx(sh.p50, 10 * Math.log10(noiseFraction({ ...{ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, ...firstOrderHp(12000, SR) }, SR)), 0.15, 'HP1 fraction');
    const mono = stereo(whiteNoise(2, SR, 0.5, 33));
    assert(relativeBandStats(mono, SR, { freq: 1000, channel: 'side' }).count === 0, 'side of mono: no active window');
    assert(relativeBandStats([new Float32Array(100), new Float32Array(100)], SR, { freq: 1000 }).count === 0, 'silence');
  },

  // ================================================================ limiter

  'limitTruePeak: ceiling guarantee on brutal material at 44.1/48/96 kHz (truePeakDb + ffmpeg)': () => {
    const lines = [];
    const useFf = hasFfmpeg();
    for (const fs of [44100, 48000, 96000]) {
      for (const [name, ch] of brutalSet(fs)) {
        for (const ceilingDb of [-1, -2]) {
          if (ceilingDb === -2 && !name.startsWith('pink') && !name.startsWith('clipped')) continue;
          const y = clone(ch);
          const st = limitTruePeak(y, fs, { ceilingDb });
          assertFinite(y);
          const tpM = truePeakDb(y, fs);
          const tpL = truePeakDb(y, fs, 'limiter');
          assert(tpM <= ceilingDb, `${name} @${fs}: truePeakDb ${tpM.toFixed(4)} > ${ceilingDb}`);
          assert(tpL <= ceilingDb + 0.01, `${name} @${fs}: limiter-quality TP ${tpL.toFixed(4)}`);
          let ffTxt = '';
          if (useFf) {
            const path = join(TMP, `dyn-lim-${fs}-${name.replace(/[^a-z0-9]+/gi, '_')}${ceilingDb}.wav`);
            writeWavFloat(path, y, fs);
            const ff = ffmpegLoudness(path).truePeakDb;
            const ffx = ffmpegExactTp(path);
            assert(ff <= ceilingDb + 0.05, `${name} @${fs}: ffmpeg ebur128 ${ff} dBTP > ${ceilingDb}`);
            assert(ffx <= ceilingDb + 0.005, `${name} @${fs}: ffmpeg 192 kHz resampler peak ${ffx.toFixed(4)}`);
            ffTxt = ` ff ${ff} (${ffx.toFixed(3)})`;
          }
          assert(st.grMaxDb < -1 && st.runs >= 1 && st.trimDb > -0.5, `${name}: stats ${JSON.stringify(st)}`);
          if (fs === 48000 || name.startsWith('clipped')) lines.push(`${name}@${fs / 1000}k ${ceilingDb}: TP ${tpM.toFixed(2)}${ffTxt} runs ${st.runs}`);
        }
      }
    }
    return useFf ? lines.join(' | ') : 'ffmpeg missing: truePeakDb checks only';
  },

  'limitTruePeak: abrupt file edges still meet ffmpeg (mirrored start)': () => {
    if (!hasFfmpeg()) return 'skip';
    const out = [];
    for (const fs of [44100, 48000]) {
      // full-scale content right from sample 0 to the last sample
      const ch = [sine(fs / 4, 0.5, fs, 1.41, Math.PI / 4), clippedNoise(0.5, fs, 5)];
      limitTruePeak(ch, fs, { ceilingDb: -1 });
      const path = join(TMP, `dyn-lim-edges-${fs}.wav`);
      writeWavFloat(path, ch, fs);
      const ff = ffmpegLoudness(path).truePeakDb;
      assert(ff <= -0.95, `abrupt edges @${fs}: ffmpeg ${ff}`);
      assert(truePeakDb(ch, fs) <= -1, 'meter');
      out.push(`${fs}: ffmpeg ${ff}`);
    }
    return out.join(', ');
  },

  'limitTruePeak: other sample rates (22.05/32/88.2/176.4/192 kHz), meter + ffmpeg': () => {
    const out = [];
    for (const fs of [22050, 32000, 88200, 176400, 192000]) {
      const p = Math.round(0.01 * fs);
      const ch = [pad(pinkNoise(1, fs, 4, 1), p), pad(clippedNoise(1, fs, 2), p)];
      limitTruePeak(ch, fs, { ceilingDb: -1 });
      const tp = truePeakDb(ch, fs);
      assert(tp <= -1, `${fs}: truePeakDb ${tp}`);
      let ffTxt = '';
      if (hasFfmpeg()) {
        const path = join(TMP, `dyn-lim-rate-${fs}.wav`);
        writeWavFloat(path, ch, fs);
        const ff = ffmpegLoudness(path).truePeakDb;
        assert(ff <= -0.95, `${fs}: ffmpeg ${ff}`);
        ffTxt = ` ff ${ff}`;
      }
      out.push(`${fs / 1000}k TP ${tp.toFixed(2)}${ffTxt}`);
    }
    return out.join(', ');
  },

  'limitTruePeak: exactly transparent below the internal ceiling; zero latency': () => {
    const x = stereo(sine(997, 1, SR, 0.5), pinkNoise(1, SR, 0.3, 41)); // ≈ −6 dBTP
    const y = clone(x);
    const st = limitTruePeak(y, SR, { ceilingDb: -1 });
    assert(exactlyEqual(y[0], x[0]) && exactlyEqual(y[1], x[1]), 'bit-exact');
    assert(st.runs === 0 && st.grMaxDb === 0 && st.grAvgDb === 0, 'no gain pass');
    // one isolated transient: everything farther than lookahead/hold/release is bit-exact,
    // and the transient itself is not shifted in time
    const n = 2 * SR, at = SR / 2;
    const s = sine(440, 2, SR, 0.3);
    for (let i = at; i < at + 48; i++) s[i] += 0.9 * Math.exp(-(i - at) / 12);
    const z = [Float32Array.from(s), Float32Array.from(s)];
    const r = limitTruePeak(z, SR, { ceilingDb: -1, lookaheadMs: 3, releaseMs: 50, adaptiveRelease: false });
    assert(r.grMaxDb < -1, 'transient limited');
    const before = at - Math.round(0.0031 * SR);
    assert(exactlyEqual(z[0].subarray(0, before - 1), s.subarray(0, before - 1)), 'untouched before the lookahead window');
    const after = at + Math.round(1.2 * SR); // 1 − r < 1e-9 needs ≈ 20 release time constants
    assert(exactlyEqual(z[0].subarray(after, n), s.subarray(after, n)), 'bit-exact again after the release');
    // zero latency: the residual (removed part) peaks on the transient, not 3 ms later
    let iMax = 0, vMax = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(s[i] - z[0][i]);
      if (d > vMax) { vMax = d; iMax = i; }
    }
    assert(Math.abs(iMax - at) < 8, `residual centred on the transient (${iMax - at} samples)`);
  },

  'limitTruePeak: smooth gain (no clicks), hold covers the peak, release shape': () => {
    // DC with a 10 ms burst: y/x is the gain curve
    const n = SR, a = SR / 3, b = a + Math.round(0.01 * SR);
    const x = new Float32Array(n).fill(0.5);
    for (let i = a; i < b; i++) x[i] = 1.6;
    const y = [Float32Array.from(x)];
    limitTruePeak(y, SR, { ceilingDb: -1, lookaheadMs: 3, releaseMs: 80, adaptiveRelease: false });
    const g = Float64Array.from(y[0], (v, i) => v / x[i]);
    const C = 10 ** (-1 / 20);
    for (let i = a; i < b; i++) assert(Math.abs(y[0][i]) <= C * (1 + 1e-6), 'burst at or below the ceiling');
    const L = Math.round(0.003 * SR);
    let d1 = 0, d2 = 0;
    for (let i = 1; i < n - 1; i++) {
      d1 = Math.max(d1, Math.abs(g[i + 1] - g[i]));
      d2 = Math.max(d2, Math.abs(g[i + 1] - 2 * g[i] + g[i - 1]));
    }
    const depth = 1 - C / 1.6;
    assert(d1 <= (1.05 * depth) / (0.4 * L), `gain slope bounded (attack spread over L): ${d1.toExponential(2)}`);
    assert(d2 < 1e-3, `no corners: max second difference ${d2.toExponential(2)}`);
    // attack starts no earlier than L before the burst (lookahead) and the gain is back to
    // within 0.1 dB after hold + ~3 release time constants
    assert(g[a - L - 1] === 1, 'gain is 1 before the lookahead window');
    assert(g[a - 1] < 1, 'gain already reduced at the burst onset');
    const hold = Math.round(0.005 * SR);
    assert(db(g[b + hold + Math.round(0.4 * SR)]) > -0.1, 'released after hold + 5 τ');
    assert(db(g[b + hold]) < -5, 'still held right after the burst');
  },

  'limitTruePeak: low THD on a 1 kHz sine limited by 6 dB; adaptive release': () => {
    const C = -1;
    const A = 10 ** ((C + 6) / 20); // true peak 6 dB over the ceiling
    const x = [sine(1000, 2, SR, A), sine(1000, 2, SR, A)];
    const st = limitTruePeak(x, SR, { ceilingDb: C });
    approx(st.grMaxDb, -6.15, 0.1, 'GR ≈ 6 dB (+ internal margin)');
    const thd = thdN(x[0], 1000, SR, SR / 2, 2 * SR - 1000);
    assert(thd < -100, `THD+N ${thd.toFixed(1)} dB`);
    approx(db(toneAmp(x[0], 1000, SR, SR / 2, 2 * SR - 1000).amp), C - 0.15, 0.06, 'output level at the internal ceiling');
    // 50 Hz bass limited by 6 dB: the hold is shorter than the period, the adaptive slow
    // branch keeps the gain ripple (distortion) lower than a plain release
    const bass = (ad) => {
      const s = [sine(50, 3, SR, A)];
      limitTruePeak(s, SR, { ceilingDb: C, adaptiveRelease: ad });
      return thdN(s[0], 50, SR, SR * 2, 3 * SR - 2000);
    };
    const tPlain = bass(false), tAd = bass(true);
    assert(tAd < tPlain - 3, `adaptive release lowers bass distortion (${tAd.toFixed(1)} vs ${tPlain.toFixed(1)} dB)`);
    // adaptive: a lone transient recovers faster than with the plain release
    const rec = (ad) => {
      const s = new Float32Array(SR).fill(0.2);
      for (let i = 1000; i < 1100; i++) s[i] = 1.5;
      const y = [Float32Array.from(s)];
      limitTruePeak(y, SR, { ceilingDb: C, releaseMs: 80, adaptiveRelease: ad });
      let i = 1100 + Math.round(0.006 * SR);
      while (db(y[0][i] / s[i]) < -1 && i < SR - 1) i++;
      return i;
    };
    assert(rec(true) < rec(false), 'adaptive: faster recovery after a short transient');
    return `THD+N 1 kHz ${thd.toFixed(1)} dB; 50 Hz plain ${tPlain.toFixed(1)} / adaptive ${tAd.toFixed(1)} dB`;
  },

  'limitTruePeak: short inputs, silence, mono, 3 channels, parameters': () => {
    for (const n of [0, 1, 2, 10, 100]) {
      const x = [whiteNoise(n / SR, SR, 4, n + 1), whiteNoise(n / SR, SR, 4, n + 2)];
      const st = limitTruePeak(x, SR, { ceilingDb: -1 });
      assertFinite(x);
      if (n) assert(truePeakDb(x, SR) <= -1, `n=${n}: TP ${truePeakDb(x, SR)}`);
      assert(Number.isFinite(st.grAvgDb) && Number.isFinite(st.grMaxDb), 'finite stats');
    }
    const z = [new Float32Array(1000), new Float32Array(1000)];
    const st = limitTruePeak(z, SR);
    assert(peak(z[0]) === 0 && st.runs === 0, 'silence');
    const mono = [pinkNoise(1, SR, 3, 51)];
    limitTruePeak(mono, SR, { ceilingDb: -0.3 });
    assert(truePeakDb(mono, SR) <= -0.3, 'mono');
    const three = [pinkNoise(1, SR, 3, 52), pinkNoise(1, SR, 0.1, 53), pinkNoise(1, SR, 0.1, 54)];
    limitTruePeak(three, SR, { ceilingDb: -1 });
    assert(truePeakDb(three, SR) <= -1, '3 channels');
    for (const o of [{ lookaheadMs: 1.5 }, { lookaheadMs: 5, releaseMs: 200 }, { releaseMs: 0 }, { safetyDb: 0 }]) {
      const x = stereo(pinkNoise(1, SR, 3, 55), pinkNoise(1, SR, 3, 56));
      limitTruePeak(x, SR, { ceilingDb: -1, ...o });
      assert(truePeakDb(x, SR) <= -1, `params ${JSON.stringify(o)}`);
    }
  },

  // ================================================================ soft clipper

  'softClip: curve, peak bound and exact transparency below threshold − knee/2': () => {
    // slowly varying input: output follows the static curve sample by sample
    const thr = -6, knee = 3;
    const c = 10 ** (thr / 20), T = c * 10 ** (-knee / 40);
    const x = sine(30, 1, SR, 1.0);
    const y = [Float32Array.from(x)];
    const st = softClip(y, SR, { thresholdDb: thr, kneeDb: knee });
    let err = 0;
    for (let i = 1000; i < SR - 1000; i++) {
      const a = Math.abs(x[i]);
      const want = a <= T ? a : T + (c - T) * Math.tanh((a - T) / (c - T));
      err = Math.max(err, Math.abs(Math.abs(y[0][i]) - want));
    }
    assert(err < 2e-4, `static curve (max err ${err.toExponential(2)})`);
    approx(st.grMaxDb, db((T + (c - T) * Math.tanh((1 - T) / (c - T))) / 1), 0.01, 'grMaxDb');
    approx(st.clippedPct, 100 * (1 - (2 / Math.PI) * Math.asin(T)), 0.5, 'clippedPct = time above T');
    // output never exceeds the threshold (sample peaks), on brutal material too
    for (const [name, ch] of brutalSet(SR)) {
      const z = clone(ch);
      softClip(z, SR, { thresholdDb: -1.5 });
      assert(Math.max(peak(z[0]), peak(z[1])) <= 10 ** (-1.5 / 20), `${name}: peak ≤ threshold`);
      assertFinite(z);
    }
    // transparent: 4x peak below T → bit-exact; hard clip (knee 0) at the threshold
    const q = stereo(sine(1000, 0.5, SR, 0.5), pinkNoise(0.5, SR, 0.2, 61));
    const tpq = truePeakDb(q, SR, 'limiter');
    const qq = clone(q);
    const r = softClip(qq, SR, { thresholdDb: tpq + 0.76, kneeDb: 1.5 });
    assert(exactlyEqual(qq[0], q[0]) && exactlyEqual(qq[1], q[1]) && r.clippedPct === 0, 'identity below threshold − knee/2');
    const h = [sine(100, 0.5, SR, 1)];
    softClip(h, SR, { thresholdDb: -3, kneeDb: 0 });
    approx(peak(h[0]), 10 ** (-3 / 20), 1e-3, 'hard clip level');
  },

  'softClip: equals a dense 4x reference (sparse/dense/chunked paths)': () => {
    // long signal with sparse peaks (sparse path), a dense clipped section (dense path) and
    // a > 16384-sample segment (chunk carry)
    const fs = 44100;
    const r = rng(71);
    const n = 60000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / fs) + 0.05 * (2 * r() - 1);
    for (const p of [3000, 9000, 9100, 15000]) for (let i = p; i < p + 30; i++) x[i] += 0.9 * Math.sin((i - p) * 0.4);
    for (let i = 20000; i < 52000; i++) x[i] = 0.9 * Math.sin((2 * Math.PI * 200 * i) / fs) + 0.05 * Math.sin((2 * Math.PI * 2500 * i) / fs);
    const thr = -4, knee = 2;
    const c = 10 ** (thr / 20), T = c * 10 ** (-knee / 40);
    const y = [Float32Array.from(x)];
    softClip(y, fs, { thresholdDb: thr, kneeDb: knee });
    const ref = refSoftClip(x, T, c);
    // identical wherever the band-limited result stays below c; around overshoots softClip
    // applies smooth dips (1.5 ms tapers, gaps < 3 ms bridged) that only reduce magnitudes
    const w = Math.round(0.0015 * fs);
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (Math.abs(ref[i]) > c) for (let k = Math.max(0, i - 3 * w); k < Math.min(n, i + 3 * w); k++) near[k] = 1;
    let d = 0, nCmp = 0, nDip = 0;
    for (let i = 0; i < n; i++) {
      assert(Math.abs(y[0][i]) <= c, `|y| <= c at ${i}`);
      if (near[i]) {
        nDip++;
        assert(Math.abs(y[0][i]) <= Math.abs(ref[i]) + 1e-6, `dips only reduce (${i})`);
      } else {
        nCmp++;
        d = Math.max(d, Math.abs(y[0][i] - ref[i]));
      }
    }
    assert(d < 2e-6, `matches the dense reference (max diff ${d.toExponential(2)})`);
    assert(nCmp > n / 2, 'most samples compared');
    return `max |diff| vs dense reference ${d.toExponential(2)} (${nDip} samples near overshoot dips)`;
  },

  'softClip: oversampling suppresses aliasing vs a naive clipper; short inputs': () => {
    const fs = 44100, out = [];
    for (const [f, overDb, knee] of [[7300, 6, 0.5], [5000, 3, 1.5], [10000, 2, 1.5], [7300, 1.5, 1.5]]) {
      const thr = -3, c = 10 ** (thr / 20), T = c * 10 ** (-knee / 40);
      const x = sine(f, 1, fs, c * 10 ** (overDb / 20));
      const y = [Float32Array.from(x)];
      softClip(y, fs, { thresholdDb: thr, kneeDb: knee });
      assert(peak(y[0]) <= c, 'peak bound');
      const naive = Float32Array.from(x, (v) => {
        const a = Math.abs(v);
        return a <= T ? v : Math.sign(v) * (T + (c - T) * Math.tanh((a - T) / (c - T)));
      });
      const aOs = aliasDb(y[0], f, fs), aNaive = aliasDb(naive, f, fs);
      assert(aOs < aNaive - 18, `${f} Hz +${overDb} dB: oversampled ${aOs.toFixed(1)} dB vs naive ${aNaive.toFixed(1)} dB`);
      out.push(`${f / 1000}k+${overDb}: ${aOs.toFixed(0)} vs ${aNaive.toFixed(0)} dB`);
    }
    for (const m of [0, 1, 2, 10]) {
      const t = [whiteNoise(m / SR, SR, 2, m + 3)];
      softClip(t, SR, { thresholdDb: -6 });
      assertFinite(t);
      assert(peak(t[0]) <= 10 ** (-6 / 20), `short n=${m}`);
    }
    const st = softClip([new Float32Array(100)], SR, { thresholdDb: -6 });
    assert(st.clippedPct === 0 && st.grMaxDb === 0, 'silence');
    assert(softClip([sine(100, 0.1, SR, 1)], SR, {}).clippedPct === 0, 'no threshold → no-op');
    return `alias rel. fundamental (oversampled vs naive): ${out.join(', ')}`;
  },

  // ================================================================ performance

  'perf: limiter / compressor / dynamicBandCut / softClip, 3:30 stereo 48 kHz': async () => {
    const { generateDemoTrack } = await import('../src/demo/demo-track.js');
    const demo = generateDemoTrack({ sampleRate: SR, seconds: 210, defects: true });
    const base = demo.channels;
    const tp = truePeakDb(base, SR);
    const loud = base.map((c) => gain(c, 8 - (tp + 1))); // true peak ≈ +7 dBTP → ~8 dB GR
    const res = [];
    // limiter (incl. verification): warm-up on a short excerpt, then the full track
    limitTruePeak(loud.map((c) => c.slice(0, 5 * SR)), SR, { ceilingDb: -1 });
    let tLim = Infinity, stLim = null;
    for (let k = 0; k < 2; k++) {
      const y = clone(loud);
      const t0 = performance.now();
      const st = limitTruePeak(y, SR, { ceilingDb: -1 });
      const t = performance.now() - t0;
      assert(truePeakDb(y, SR) <= -1, 'perf run meets the ceiling');
      if (t < tLim) { tLim = t; stLim = st; }
    }
    res.push(perfReport('limiter', tLim, 1500) + ` [runs ${stLim.runs}, GR avg ${stLim.grAvgDb.toFixed(1)} dB]`);
    // compressor (glue settings: RMS 10 ms, auto release, sidechain HPF)
    const thr = thresholdForTargetGr(base, SR, { ratio: 1.7, kneeDb: 8, targetGrDb: 1, sidechainHpHz: 100 });
    compress(base.map((c) => c.slice(0, 5 * SR)), SR, { thresholdDb: thr, ratio: 1.7, kneeDb: 8, attackMs: 30, releaseMs: 150, autoRelease: true, sidechainHpHz: 100 });
    let tComp = Infinity;
    for (let k = 0; k < 2; k++) {
      const y = clone(base);
      const t0 = performance.now();
      compress(y, SR, { thresholdDb: thr, ratio: 1.7, kneeDb: 8, attackMs: 30, releaseMs: 150, autoRelease: true, sidechainHpHz: 100 });
      tComp = Math.min(tComp, performance.now() - t0);
    }
    res.push(perfReport('compressor (RMS, auto release, SC HPF)', tComp, 400));
    let tPeak = Infinity;
    for (let k = 0; k < 2; k++) {
      const y = clone(base);
      const t0 = performance.now();
      compress(y, SR, { thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 60, detector: 'peak', lookaheadMs: 2 });
      tPeak = Math.min(tPeak, performance.now() - t0);
    }
    res.push(`compressor (peak + lookahead) ${tPeak.toFixed(0)} ms`);
    // dynamic band cut: stereo mud band and mid de-esser with lookahead
    for (const [name, o] of [['dynamicBandCut stereo 300 Hz', { freq: 300, q: 0.9, maxCutDb: 2.5 }],
      ['dynamicBandCut mid de-ess', { channel: 'mid', freq: 7000, q: 1.2, maxCutDb: 4, thresholdRelDb: 7, ratio: 4, attackMs: 5, releaseMs: 60, lookaheadMs: 3 }]]) {
      dynamicBandCut(base.map((c) => c.slice(0, 5 * SR)), SR, o);
      let t = Infinity;
      for (let k = 0; k < 2; k++) {
        const y = clone(base);
        const t0 = performance.now();
        dynamicBandCut(y, SR, o);
        t = Math.min(t, performance.now() - t0);
      }
      res.push(perfReport(name, t, 400));
    }
    // soft clipper shaving 1.5 dB inside the loudness loop (no fixed budget; reported):
    // clean master vs already-crushed input (RESEARCH §1 skips the clipper on crushed input)
    const clean = generateDemoTrack({ sampleRate: SR, seconds: 210, defects: false }).channels;
    for (const [name, sig] of [['clean', clean], ['crushed', base]]) {
      const thrClip = truePeakDb(sig, SR) - 1.5;
      let tClip = Infinity, stClip = null;
      for (let k = 0; k < 2; k++) {
        const y = clone(sig);
        const t0 = performance.now();
        stClip = softClip(y, SR, { thresholdDb: thrClip });
        tClip = Math.min(tClip, performance.now() - t0);
      }
      res.push(`softClip −1.5 dB (${name}, ${stClip.clippedPct.toFixed(2)} % of 4x points) ${tClip.toFixed(0)} ms`);
    }
    return res.join(' | ');
  },
};
