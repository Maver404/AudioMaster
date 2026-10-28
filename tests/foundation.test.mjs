// DSP foundation tests: util, biquad, crossover, fft, oversample, resample.
import { join } from 'node:path';
import {
  assert, approx, assertFinite, rng, sine, whiteNoise, pinkNoise, impulse, peak, rms, db, maxDiff,
  TMP, writeWavFloat, hasFfmpeg, ffmpegLoudness,
  speedFactor,
} from './helpers.mjs';
import * as U from '../src/dsp/util.js';
import {
  design, firstOrder, butterworth, linkwitzRiley4, processInPlace, processStereoInPlace, responseDb,
  BiquadCascade,
} from '../src/dsp/biquad.js';
import { splitBands, splitBandsStereo, sumBands } from '../src/dsp/crossover.js';
import { FFT, RealFFT, hann } from '../src/dsp/fft.js';
import { upsample, downsample, truePeakEnvelope, truePeakDb } from '../src/dsp/oversample.js';
import { resample, resampleAudio } from '../src/dsp/resample.js';

// ------------------------------------------------------------------ local helpers

/** Least-squares fit of a·sin + b·cos at f over [start, end) → amplitude and phase. */
function fitTone(y, f, fs, start = 0, end = y.length) {
  const w = (2 * Math.PI * f) / fs;
  let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
  for (let i = start; i < end; i++) {
    const s = Math.sin(w * i), c = Math.cos(w * i);
    ss += s * s; cc += c * c; sc += s * c; ys += y[i] * s; yc += y[i] * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys * cc - yc * sc) / det;
  const b = (yc * ss - ys * sc) / det;
  return { amp: Math.hypot(a, b), a, b };
}

/** Residual of y against amp·sin(2πf·i/fs + ph) over [start, end), in dB rel. the tone. */
function residualDb(y, f, fs, amp, ph, start, end) {
  const w = (2 * Math.PI * f) / fs;
  let e = 0, s = 0;
  for (let i = start; i < end; i++) {
    const r = amp * Math.sin(w * i + ph);
    e += (y[i] - r) ** 2;
    s += r * r;
  }
  return 10 * Math.log10(Math.max(e, 1e-300) / s);
}

function rmsDb(y, start = 0, end = y.length) {
  return db(rms(y, start, end));
}

/** Naive DFT (angles reduced mod n for accuracy). */
function dft(re, im) {
  const n = re.length;
  const R = new Float64Array(n), I = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < n; j++) {
      const a = (-2 * Math.PI * ((k * j) % n)) / n;
      const c = Math.cos(a), s = Math.sin(a);
      sr += re[j] * c - im[j] * s;
      si += re[j] * s + im[j] * c;
    }
    R[k] = sr; I[k] = si;
  }
  return [R, I];
}

function maxAbsDiff(a, b, n = Math.min(a.length, b.length)) {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Magnitude response (dB) of an impulse response via RealFFT, evaluated at freqs. */
function irResponseDb(ir, fs, freqs) {
  const n = ir.length;
  const f = new RealFFT(n);
  const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
  f.forward(Float64Array.from(ir), re, im);
  return freqs.map((hz) => {
    const k = Math.round((hz * n) / fs);
    return 10 * Math.log10(re[k] * re[k] + im[k] * im[k]);
  });
}

function logFreqs(f0, f1, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(f0 * Math.pow(f1 / f0, i / (count - 1)));
  return out;
}

/**
 * Host speed factor vs the ARCHITECTURE §8 reference (Apple M1 P-core): a dependent
 * float-add chain runs at 3 cycles/iteration = 0.94 ns at 3.2 GHz there. Budgets are
 * asserted as budget × factor (clamped 1..3) and the raw time is always reported.
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

function perfReport(name, ms, budget) {
  const f = speedFactor();
  const msg = `${name}: ${ms.toFixed(0)} ms` + (budget ? ` (budget ${budget} ms @M1; host factor ${f.toFixed(2)} → ≈${(ms / f).toFixed(0)} ms @M1)` : ` (host factor ${f.toFixed(2)})`);
  if (budget) assert(ms < budget * f, `${msg} exceeds budget`);
  return msg;
}

const SR = 48000;
const LEN_330 = 210 * SR; // 3:30 at 48 kHz, per channel

// ------------------------------------------------------------------ util

export const tests = {
  'util: dB helpers, clamp, lerp, timeCoef': () => {
    approx(U.dbToGain(-6.0206), 0.5, 1e-4);
    approx(U.gainToDb(0.5), -6.0206, 1e-4);
    approx(U.gainToDb(-2), 6.0206, 1e-4, 'sign ignored');
    for (const d of [-60, -12.5, 0, 3, 24]) approx(U.gainToDb(U.dbToGain(d)), d, 1e-12);
    assert(U.gainToDb(0) === -240 && Number.isFinite(U.gainToDb(0)), 'gainToDb(0) finite −240');
    assert(U.powerToDb(0) === -240, 'powerToDb(0) = −240');
    approx(U.powerToDb(0.25), -6.0206, 1e-4);
    assert(U.EPS === 1e-12);
    assert(U.clamp(5, 0, 1) === 1 && U.clamp(-5, 0, 1) === 0 && U.clamp(0.3, 0, 1) === 0.3);
    approx(U.lerp(2, 4, 0.25), 2.5, 1e-15);
    approx(U.timeCoef(10, 48000), Math.exp(-1 / 480), 1e-15);
    assert(U.timeCoef(0, 48000) === 0 && U.timeCoef(-5, 48000) === 0, 'ms <= 0 → 0');
    // one-pole step response reaches 1 − 1/e after τ
    const a = U.timeCoef(5, 48000);
    let y = 0;
    for (let i = 0; i < 240; i++) y = a * y + (1 - a);
    approx(y, 1 - Math.exp(-1), 1e-9);
  },

  'util: audio alloc/clone, toStereo, mixToMono': () => {
    const a = U.makeAudio(44100, 10);
    assert(a.sampleRate === 44100 && a.channels.length === 2 && a.channels[0].length === 10);
    assert(U.makeAudio(48000, 5, 1).channels.length === 1);
    a.channels[0][3] = 0.5;
    const b = U.cloneAudio(a);
    b.channels[0][3] = 0.25;
    assert(a.channels[0][3] === 0.5 && b.channels[0][3] === 0.25, 'deep copy');
    assert(U.audioLength(a) === 10 && U.audioLength({ channels: [] }) === 0);
    const mono = Float32Array.from([1, 2, 3]);
    const st = U.toStereo([mono]);
    assert(st.length === 2 && st[0] !== st[1] && st[1][2] === 3, 'mono duplicated into distinct arrays');
    const l = Float32Array.from([1, 0]), r = Float32Array.from([0, 1]);
    const st2 = U.toStereo([l, r]);
    assert(st2[0] === l && st2[1] === r, 'stereo passes through');
    // 5.1: L R C LFE Ls Rs
    const ch = [1, 2, 3, 100, 5, 6].map((v) => Float32Array.from([v]));
    const d = U.toStereo(ch);
    approx(d[0][0], 1 + Math.SQRT1_2 * (3 + 5), 1e-6, '5.1 L');
    approx(d[1][0], 2 + Math.SQRT1_2 * (3 + 6), 1e-6, '5.1 R (LFE dropped)');
    const m = U.mixToMono([Float32Array.from([1, -1]), Float32Array.from([0, 1])]);
    assert(m[0] === 0.5 && m[1] === 0);
    assert(U.toStereo([]).length === 2);
  },

  'util: createRng matches helpers.rng; yieldToEventLoop; Kaiser helpers': async () => {
    const a = U.createRng(42), b = rng(42);
    for (let i = 0; i < 100; i++) assert(a() === b(), 'same sequence as helpers.rng');
    const c = U.createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = c();
      assert(v >= 0 && v < 1);
    }
    let done = false;
    const p = U.yieldToEventLoop().then(() => { done = true; });
    assert(!done, 'resolves asynchronously');
    await p;
    assert(done);
    approx(U.besselI0(0), 1, 1e-15);
    approx(U.besselI0(1), 1.2660658777520082, 1e-14);
    approx(U.kaiserBeta(65), 6.20426, 1e-5, 'SciPy kaiser_beta(65)');
    approx(U.sinc(0.5), 2 / Math.PI, 1e-15);
  },

  // ------------------------------------------------------------------ biquad

  'biquad: peaking / shelf gains match analytic values': () => {
    for (const fs of [44100, 48000, 96000]) {
      for (const f0 of [60, 1000, 8000]) {
        for (const g of [-12, -3, 1, 6, 12]) {
          for (const q of [0.5, 1.4, 4]) {
            const pk = design('peaking', f0, fs, { gainDb: g, q });
            approx(responseDb(pk, f0, fs), g, 1e-7, `peaking ${f0}/${g}/${q}`);
            approx(responseDb(pk, 0.1, fs), 0, 1e-3, 'peaking DC');
          }
          // RBJ shelves: half the gain (in dB) at f0, full gain at the far end
          const ls = design('lowshelf', f0, fs, { gainDb: g });
          const hs = design('highshelf', f0, fs, { gainDb: g });
          approx(responseDb(ls, f0, fs), g / 2, 1e-7, 'lowshelf mid');
          approx(responseDb(hs, f0, fs), g / 2, 1e-7, 'highshelf mid');
          approx(responseDb(ls, 0.01, fs), g, 1e-6, 'lowshelf DC');
          approx(responseDb(hs, fs / 2 - 1e-6, fs), g, 1e-6, 'highshelf Nyquist');
          const lsS = design('lowshelf', f0, fs, { gainDb: g, slope: 1 });
          approx(responseDb(lsS, f0, fs), g / 2, 1e-7, 'slope form mid');
        }
      }
    }
    // shelf with S = 1 is monotonic (no overshoot beyond gain)
    const s = design('highshelf', 3000, 48000, { gainDb: 6, slope: 1 });
    const r = responseDb(s, logFreqs(20, 23900, 400), 48000);
    assert(Math.max(...r) <= 6 + 1e-9 && Math.min(...r) >= -1e-9, 'S=1 shelf monotonic');
    // zero gain is an exact identity
    const z = design('peaking', 1000, 48000, { gainDb: 0, q: 2 });
    assert(z.b0 === 1 && Math.abs(z.b1 - z.a1) < 1e-15 && Math.abs(z.b2 - z.a2) < 1e-15, '0 dB peaking = identity');
  },

  'biquad: Butterworth orders 1..8 match the bilinear analytic response': () => {
    for (const fs of [44100, 48000, 96000]) {
      for (const fc of [20, 100, 1000, 10000]) {
        const wc = Math.tan((Math.PI * fc) / fs);
        for (let N = 1; N <= 8; N++) {
          const lp = butterworth('lowpass', N, fc, fs);
          const hp = butterworth('highpass', N, fc, fs);
          assert(lp.length === Math.ceil(N / 2), 'section count');
          approx(responseDb(lp, fc, fs), -3.0103, 1e-4, `LP${N} −3 dB at ${fc}`);
          approx(responseDb(hp, fc, fs), -3.0103, 1e-4, `HP${N} −3 dB at ${fc}`);
          for (const f of logFreqs(5, 0.49 * fs, 25)) {
            const r = Math.tan((Math.PI * f) / fs) / wc;
            const lpA = -10 * Math.log10(1 + Math.pow(r, 2 * N));
            const hpA = -10 * Math.log10(1 + Math.pow(1 / r, 2 * N));
            if (lpA > -200) approx(responseDb(lp, f, fs), lpA, 1e-6, `LP${N} ${fc} @${f.toFixed(1)}`);
            if (hpA > -200) approx(responseDb(hp, f, fs), hpA, 1e-6, `HP${N} ${fc} @${f.toFixed(1)}`);
          }
        }
      }
    }
    // LR4 = Butterworth² → −6.02 dB at fc
    approx(responseDb(linkwitzRiley4('lowpass', 500, 48000), 500, 48000), -6.0206, 1e-4);
    approx(responseDb(linkwitzRiley4('highpass', 500, 48000), 500, 48000), -6.0206, 1e-4);
    let threw = false;
    try { butterworth('bandpass', 2, 100, 48000); } catch { threw = true; }
    assert(threw, 'unknown type throws');
  },

  'biquad: constant-0dB bandpass, notch = x − BP0(x), allpass, first order': () => {
    const fs = 48000;
    for (const [f0, q] of [[300, 0.9], [3000, 2], [12000, 0.7]]) {
      const bp = design('bandpass', f0, fs, { q });
      approx(responseDb(bp, f0, fs), 0, 1e-9, 'BP0 peak 0 dB at f0');
      const grid = responseDb(bp, logFreqs(20, 23000, 300), fs);
      assert(Math.max(...grid) <= 1e-9, 'BP0 never exceeds 0 dB');
      const notch = design('notch', f0, fs, { q });
      assert(responseDb(notch, f0, fs) < -150, 'notch null');
      // coefficient identity: notch = 1 − BP0
      approx(notch.b0, 1 - bp.b0, 1e-15);
      approx(notch.b1, bp.a1 - bp.b1, 1e-15);
      approx(notch.b2, bp.a2 - bp.b2, 1e-15);
      // time domain
      const x = whiteNoise(0.2, fs, 0.5, 3);
      const yn = processInPlace(Float32Array.from(x), notch);
      const yb = processInPlace(Float32Array.from(x), bp);
      let m = 0;
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(yn[i] - (x[i] - yb[i])));
      assert(m < 2e-7, `x − BP0(x) equals notch (max diff ${m})`);
      const ap = design('allpass', f0, fs, { q });
      const apg = responseDb(ap, logFreqs(10, 23900, 200), fs);
      assert(Math.max(...apg.map(Math.abs)) < 1e-9, 'allpass flat');
    }
    // first order: LP1 + HP1 = 1, −3 dB at fc
    const lp1 = firstOrder('lowpass', 2000, fs), hp1 = firstOrder('highpass', 2000, fs);
    approx(responseDb(lp1, 2000, fs), -3.0103, 1e-4);
    approx(responseDb(hp1, 2000, fs), -3.0103, 1e-4);
    const x = whiteNoise(0.1, fs, 0.5, 9);
    const a = processInPlace(Float32Array.from(x), lp1), b = processInPlace(Float32Array.from(x), hp1);
    let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(a[i] + b[i] - x[i]));
    assert(m < 2e-7, `LP1 + HP1 = identity (${m})`);
    const ap1 = firstOrder('allpass', 2000, fs);
    assert(Math.abs(responseDb(ap1, 7000, fs)) < 1e-9, 'first-order allpass flat');
  },

  'biquad: peaking ≡ 1 + (A²−1)·BP0(f0, Q·A) identity': () => {
    const fs = 48000;
    for (const [f0, q, g] of [[250, 0.9, -4], [3400, 2, -6], [9000, 1.2, 5], [80, 0.7, 9]]) {
      const A = Math.pow(10, g / 40);
      const pk = design('peaking', f0, fs, { q, gainDb: g });
      const bp = design('bandpass', f0, fs, { q: q * A });
      const x = whiteNoise(0.25, fs, 0.4, 11);
      const yp = processInPlace(Float32Array.from(x), pk);
      const yb = processInPlace(Float32Array.from(x), bp);
      let m = 0;
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(yp[i] - (x[i] + (A * A - 1) * yb[i])));
      assert(m < 1e-6, `identity ${f0}/${q}/${g}: max diff ${m}`);
      // and the dynamic-EQ form gives exactly g at f0: |1 + (G − 1)·BP0| = G at f0
      const G = U.dbToGain(g);
      const bp0 = design('bandpass', f0, fs, { q });
      const n = fs;
      const s = sine(f0, 1, fs, 0.5);
      const yb0 = processInPlace(Float32Array.from(s), bp0);
      const y = s.map((v, i) => v + (G - 1) * yb0[i]);
      approx(db(fitTone(y, f0, fs, n / 2, n).amp / 0.5), g, 0.002, 'dynamic band gain at f0');
    }
  },

  'biquad: processInPlace matches responseDb (sine measurement)': () => {
    const fs = 48000;
    const filters = {
      peaking: [design('peaking', 1000, fs, { q: 1, gainDb: 6 })],
      lowshelf: [design('lowshelf', 200, fs, { gainDb: 4 })],
      highshelf: [design('highshelf', 8000, fs, { gainDb: -5, q: 0.8 })],
      hp4: butterworth('highpass', 4, 100, fs),
      lp7: butterworth('lowpass', 7, 6000, fs),
      lr4: linkwitzRiley4('lowpass', 2000, fs),
      bp: [design('bandpass', 3000, fs, { q: 2 })],
      mixed: [design('peaking', 300, fs, { q: 0.9, gainDb: -3 }), design('highshelf', 10000, fs, { gainDb: 2 }), ...butterworth('highpass', 2, 25, fs)],
    };
    const n = fs;
    for (const [name, secs] of Object.entries(filters)) {
      for (const f of [40, 100, 300, 1000, 2000, 3000, 6000, 12000, 18000]) {
        const x = sine(f, 1, fs, 0.5);
        processInPlace(x, secs);
        const got = db(fitTone(x, f, fs, n / 2, n).amp / 0.5);
        const want = responseDb(secs, f, fs);
        if (want > -100) approx(got, want, 0.005, `${name} @${f}`);
      }
    }
  },

  'biquad: stability at 20 Hz/48 kHz and 10 Hz/96 kHz': () => {
    const cases = [
      ['HP8 20 Hz @48k', butterworth('highpass', 8, 20, 48000), 48000, 20],
      ['HP8 10 Hz @96k', butterworth('highpass', 8, 10, 96000), 96000, 10],
      ['LP8 10 Hz @96k', butterworth('lowpass', 8, 10, 96000), 96000, 10],
      ['LR4 HP 10 Hz @96k', linkwitzRiley4('highpass', 10, 96000), 96000, 10],
      ['LS +6 20 Hz @48k', [design('lowshelf', 20, 48000, { gainDb: 6 })], 48000, 20],
    ];
    for (const [name, secs, fs, fc] of cases) {
      for (const s of secs) {
        assert(Math.abs(s.a2) < 1 && Math.abs(s.a1) < 1 + s.a2, `${name}: poles inside unit circle`);
      }
      // impulse response decays to (numerical) zero, finite everywhere
      const ir = processInPlace(impulse(fs * 10, 0, 1), secs);
      assertFinite([ir], name);
      const tail = rms(ir, ir.length - fs, ir.length);
      assert(tail < 1e-12, `${name}: impulse response tail ${tail}`);
      // sine measurement at fc against the analytic response
      const x = sine(fc, 12, fs, 0.5);
      processInPlace(x, secs);
      const got = db(fitTone(x, fc, fs, 6 * fs, 12 * fs).amp / 0.5);
      approx(got, responseDb(secs, fc, fs), 0.01, `${name}: gain at fc`);
    }
    // analytic precision deep in the stopband of a low corner (float64 coefficients)
    const hp = butterworth('highpass', 8, 20, 48000);
    const r = Math.tan((Math.PI * 5) / 48000) / Math.tan((Math.PI * 20) / 48000);
    approx(responseDb(hp, 5, 48000), -10 * Math.log10(1 + Math.pow(1 / r, 16)), 1e-6, 'HP8 at 5 Hz');
  },

  'biquad: BiquadCascade, stereo independence, edge cases': () => {
    const fs = 44100;
    const secs = [design('peaking', 500, fs, { q: 1, gainDb: 6 }), ...butterworth('highpass', 3, 40, fs)];
    const x = whiteNoise(0.1, fs, 0.5, 5);
    const ref = processInPlace(Float32Array.from(x), secs);
    const bc = new BiquadCascade(secs);
    let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(bc.process(x[i]) - ref[i]));
    assert(m < 1e-7, `per-sample cascade equals block processing (${m})`);
    bc.reset();
    approx(bc.process(x[0]), ref[0], 1e-7, 'reset clears state');
    // single section object accepted
    const one = new BiquadCascade(design('lowpass', 1000, fs));
    assert(Number.isFinite(one.process(1)));
    // stereo: independent state per channel
    const L = Float32Array.from(x), R = new Float32Array(x.length);
    processStereoInPlace([L, R], secs);
    assert(maxDiff(L, ref) === 0 && peak(R) === 0, 'R stays silent, L identical to mono');
    // silence and very short inputs
    const z = new Float32Array(100);
    processInPlace(z, secs);
    assert(peak(z) === 0);
    const tiny = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    processInPlace(tiny, butterworth('lowpass', 8, 20000, fs));
    assertFinite([tiny]);
    processInPlace(new Float32Array(0), secs);
    processInPlace(Float32Array.from([0.5]), []);
    // frequency clamping: no NaN at 0 Hz / above Nyquist / NaN
    for (const f of [0, -5, 30000, 1e9, NaN]) {
      for (const t of ['lowpass', 'highpass', 'bandpass', 'notch', 'allpass', 'peaking', 'lowshelf', 'highshelf']) {
        const s = design(t, f, fs, { gainDb: 3 });
        for (const v of Object.values(s)) assert(Number.isFinite(v), `${t} @${f}`);
      }
    }
    assert(Number.isFinite(responseDb(design('notch', 1000, fs), 1000, fs)), 'notch null is finite');
  },

  'biquad: LR4 LP + HP = AP2 (time domain)': () => {
    const fs = 48000;
    for (const f of [80, 1200, 9000]) {
      const x = whiteNoise(0.3, fs, 0.5, 21);
      const lo = processInPlace(Float32Array.from(x), linkwitzRiley4('lowpass', f, fs));
      const hi = processInPlace(Float32Array.from(x), linkwitzRiley4('highpass', f, fs));
      const ap = processInPlace(Float32Array.from(x), design('allpass', f, fs, { q: Math.SQRT1_2 }));
      let m = 0;
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(lo[i] + hi[i] - ap[i]));
      assert(m < 5e-7, `LP4 + HP4 = AP2 at ${f} (${m})`);
    }
  },

  // ------------------------------------------------------------------ crossover

  'crossover: LR4 bands sum flat (±0.05 dB, 20 Hz–20 kHz) for 1–4 crossovers': () => {
    const fs = 48000;
    const n = 65536;
    const freqs = logFreqs(20, 20000, 200);
    const sets = [[120], [120, 3000], [200, 600], [80, 800, 5000], [60, 250, 2000, 8000]];
    const report = [];
    for (const xo of sets) {
      const bands = splitBands(impulse(n, 0, 1), xo, fs);
      assert(bands.length === xo.length + 1, 'band count');
      const sum = sumBands(bands);
      const r = irResponseDb(sum, fs, freqs);
      const dev = Math.max(...r.map(Math.abs));
      assert(dev < 0.05, `sum not flat for ${xo}: ${dev} dB`);
      report.push(`${xo.join('/')}: ${dev.toExponential(1)} dB`);
      // each crossover point: adjacent bands are both at −6.02 dB
      for (let i = 0; i < xo.length; i++) {
        const lo = irResponseDb(bands[i], fs, [xo[i]])[0];
        const hi = irResponseDb(bands[i + 1], fs, [xo[i]])[0];
        approx(lo, -6.02, 0.15, `band ${i} at ${xo[i]}`);
        approx(hi, -6.02, 0.15, `band ${i + 1} at ${xo[i]}`);
      }
    }
    return report.join(', ');
  },

  'crossover: sum equals the allpass cascade sample-by-sample; input untouched': () => {
    const fs = 44100;
    const x = pinkNoise(1, fs, 0.8, 4);
    const copy = Float32Array.from(x);
    for (const xo of [[150], [150, 2500], [90, 700, 6000], [50, 300, 2000, 9000]]) {
      const sum = sumBands(splitBands(x, xo, fs));
      const ap = processInPlace(Float32Array.from(x), xo.map((f) => design('allpass', f, fs, { q: Math.SQRT1_2 })));
      const m = maxAbsDiff(sum, ap);
      assert(m < 2e-6, `sum == ∏AP2 for ${xo} (${m})`);
    }
    assert(maxDiff(x, copy) === 0, 'input not modified');
    // unsorted crossovers are sorted
    const a = splitBands(x, [2500, 150], fs), b = splitBands(x, [150, 2500], fs);
    assert(maxDiff(a[0], b[0]) === 0 && maxDiff(a[2], b[2]) === 0);
  },

  'crossover: stereo split, silence, short inputs': () => {
    const fs = 48000;
    const L = whiteNoise(0.2, fs, 0.5, 1), R = whiteNoise(0.2, fs, 0.5, 2);
    const bands = splitBandsStereo([L, R], [120, 3000], fs);
    assert(bands.length === 3 && bands[0].length === 2);
    const monoR = splitBands(R, [120, 3000], fs);
    for (let b = 0; b < 3; b++) assert(maxDiff(bands[b][1], monoR[b]) === 0, 'per-channel identical to mono');
    const z = splitBands(new Float32Array(1000), [100, 1000, 5000], fs);
    assert(z.every((b) => peak(b) === 0), 'silence in, silence out');
    const t = splitBands(Float32Array.from([1, 0.5, 0, 0, -1, 0, 0, 0, 0, 0]), [100, 1000, 5000, 12000], fs);
    assert(t.length === 5 && t.every((b) => b.length === 10));
    assertFinite(t);
    const s = sumBands(splitBands(Float32Array.from([0.3]), [500], fs));
    assert(s.length === 1 && Number.isFinite(s[0]));
    assert(sumBands([]).length === 0);
    const none = splitBands(L, [], fs);
    assert(none.length === 1 && maxDiff(none[0], L) === 0 && none[0] !== L, 'no crossovers → copy');
  },

  // ------------------------------------------------------------------ fft

  'fft: FFT matches naive DFT and round trips': () => {
    const r = rng(5);
    for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
      const re = Float64Array.from({ length: n }, () => r() - 0.5);
      const im = Float64Array.from({ length: n }, () => r() - 0.5);
      const [R, I] = dft(re, im);
      const f = new FFT(n);
      const a = re.slice(), b = im.slice();
      f.forward(a, b);
      const e = Math.max(maxAbsDiff(a, R), maxAbsDiff(b, I));
      assert(e < 1e-9, `FFT(${n}) vs DFT: ${e}`);
      f.inverse(a, b);
      const e2 = Math.max(maxAbsDiff(a, re), maxAbsDiff(b, im));
      assert(e2 < 1e-12, `FFT(${n}) round trip: ${e2}`);
    }
    const big = new FFT(65536);
    const re = Float64Array.from({ length: 65536 }, () => r() - 0.5), im = new Float64Array(65536);
    const a = re.slice(), b = im.slice();
    big.forward(a, b);
    big.inverse(a, b);
    assert(maxAbsDiff(a, re) < 1e-12 && maxAbsDiff(b, im) < 1e-12, 'FFT(65536) round trip');
  },

  'fft: RealFFT matches naive DFT and round trips < 1e-9': () => {
    const r = rng(8);
    for (const n of [2, 4, 8, 16, 64, 256, 1024, 2048]) {
      const x = Float64Array.from({ length: n }, () => r() - 0.5);
      const [R, I] = dft(x, new Float64Array(n));
      const f = new RealFFT(n);
      const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
      f.forward(x, re, im);
      let e = 0;
      for (let k = 0; k <= n / 2; k++) e = Math.max(e, Math.abs(re[k] - R[k]), Math.abs(im[k] - I[k]));
      assert(e < 1e-9, `RealFFT(${n}) vs DFT: ${e}`);
      const y = new Float64Array(n);
      f.inverse(re, im, y);
      const e2 = maxAbsDiff(x, y);
      assert(e2 < 1e-12, `RealFFT(${n}) round trip ${e2}`);
    }
    // Float32 input, Float32 output, larger sizes
    for (const n of [4096, 32768]) {
      const f = new RealFFT(n);
      const x = whiteNoise(n / 48000, 48000, 0.5, n);
      const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
      f.forward(x, re, im);
      const y = new Float64Array(n);
      f.inverse(re, im, y);
      assert(maxAbsDiff(x, y) < 1e-9, `RealFFT(${n}) round trip`);
      // Parseval
      let et = 0, ef = 0;
      for (let i = 0; i < n; i++) et += x[i] * x[i];
      for (let k = 0; k <= n / 2; k++) ef += (k === 0 || k === n / 2 ? 1 : 2) * (re[k] * re[k] + im[k] * im[k]);
      approx(ef / n, et, et * 1e-12, 'Parseval');
    }
    // a pure cosine lands in one bin
    const n = 1024, f = new RealFFT(n);
    const x = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 37 * i) / n));
    const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
    f.forward(x, re, im);
    approx(re[37], n / 2, 1e-9);
    approx(re[36], 0, 1e-9);
  },

  'fft: hann window, invalid sizes': () => {
    const w = hann(8);
    approx(w[0], 0, 1e-15);
    approx(w[4], 1, 1e-15, 'periodic peak at n/2');
    const s = hann(9, false);
    approx(s[0], 0, 1e-15);
    approx(s[8], 0, 1e-15, 'symmetric ends at 0');
    approx(s[4], 1, 1e-15);
    // periodic Hann at hop N/2 sums to 1 (COLA)
    const N = 2048, h = hann(N);
    for (let i = 0; i < N / 2; i++) approx(h[i] + h[i + N / 2], 1, 1e-12);
    assert(hann(1)[0] === 1 && hann(0).length === 0);
    for (const bad of [0, 3, 12, 1000, 2.5]) {
      let threw = false;
      try { new FFT(bad); } catch { threw = true; }
      assert(threw, `FFT(${bad}) throws`);
    }
    let threw = false;
    try { new RealFFT(1); } catch { threw = true; }
    assert(threw, 'RealFFT(1) throws');
  },

  'perf: RealFFT(2048) forward+inverse (target < 25 µs)': () => {
    const n = 2048;
    const f = new RealFFT(n);
    const x = whiteNoise(n / 48000, 48000, 0.5, 1);
    const xd = Float64Array.from(x);
    const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1), y = new Float64Array(n);
    for (let i = 0; i < 20000; i++) {
      f.forward(xd, re, im);
      f.inverse(re, im, y);
    }
    const iters = 20000;
    const ms = bestOf(5, () => {
      for (let i = 0; i < iters; i++) {
        f.forward(xd, re, im);
        f.inverse(re, im, y);
      }
    });
    const us = (ms * 1000) / iters;
    const fac = speedFactor();
    // Regression guard at 1.5x the target (timing on shared hosts is noisy); the raw and
    // host-normalized numbers are reported for comparison with the 25 µs target.
    assert(us < 1.5 * 25 * fac, `RealFFT(2048) fwd+inv ${us.toFixed(1)} µs exceeds 1.5 × 25 µs × host factor ${fac.toFixed(2)}`);
    return `${us.toFixed(1)} µs per forward+inverse (target 25 µs @M1; host factor ${fac.toFixed(2)} → ≈${(us / fac).toFixed(1)} µs @M1)`;
  },

  // ------------------------------------------------------------------ oversample

  'oversample: upsample keeps samples, interpolates sines, rejects images': () => {
    for (const fs of [44100, 48000]) {
      for (const factor of [2, 4, 8]) {
        for (const f of [997, 7000, 15000, 0.42 * fs]) {
          const n = 8192;
          const x = sine(f, n / fs, fs, 0.5, 0.3);
          const y = upsample(x, factor);
          assert(y.length === n * factor, 'length');
          for (let i = 0; i < n; i += 97) assert(y[i * factor] === x[i], 'original samples preserved');
          // residual vs the ideal band-limited interpolation (contains passband error + images)
          const res = residualDb(y, f, fs * factor, 0.5, 0.3, 300 * factor, (n - 300) * factor);
          assert(res < -85, `${fs}/${factor}x/${f.toFixed(0)} Hz: residual ${res.toFixed(1)} dB`);
        }
      }
    }
    // factor 1 copies; invalid factor throws
    const x = whiteNoise(0.01, 48000, 0.5, 3);
    const c = upsample(x, 1);
    assert(c !== x && maxDiff(c, x) === 0);
    let threw = false;
    try { upsample(x, 3); } catch { threw = true; }
    assert(threw, 'factor 3 throws');
    // short / silent
    for (const n of [0, 1, 2, 10]) {
      const s = whiteNoise(n / 48000, 48000, 0.5, n + 1);
      const u = upsample(s, 4);
      assert(u.length === 4 * n);
      assertFinite([u, downsample(u, 4)]);
    }
    assert(peak(upsample(new Float32Array(500), 4)) === 0);
  },

  'oversample: downsample anti-alias and up/down round trip': () => {
    const fs = 48000;
    for (const factor of [2, 4]) {
      const hi = fs * factor;
      const n = 8192 * factor;
      // above 0.56·fs → must vanish
      for (const f of [0.57 * fs, 0.7 * fs, 0.95 * fs, factor === 4 ? 1.7 * fs : 0.99 * fs]) {
        const x = sine(f, n / hi, hi, 0.5);
        const y = downsample(x, factor);
        assert(y.length === n / factor);
        const att = rmsDb(y, 400, y.length - 400) - db(0.5 / Math.SQRT2);
        assert(att < -88, `${factor}x: ${f.toFixed(0)} Hz attenuated only ${att.toFixed(1)} dB`);
      }
      // passband tone decimates cleanly, time aligned
      const x = sine(9000, n / hi, hi, 0.5, 0.2);
      const y = downsample(x, factor);
      const res = residualDb(y, 9000, fs, 0.5, 0.2, 300, y.length - 300);
      assert(res < -85, `${factor}x passband residual ${res.toFixed(1)}`);
      // round trip of a band-limited noise (content < 0.42·fs)
      const s = processInPlace(whiteNoise(1, fs, 0.5, 6), butterworth('lowpass', 8, 0.38 * fs, fs));
      const back = downsample(upsample(s, factor), factor);
      assert(back.length === s.length);
      let e = 0, p = 0;
      for (let i = 500; i < s.length - 500; i++) { e += (back[i] - s[i]) ** 2; p += s[i] * s[i]; }
      const err = 10 * Math.log10(e / p);
      assert(err < -80, `${factor}x round trip error ${err.toFixed(1)} dB`);
    }
    assert(downsample(new Float32Array(7), 2).length === 4, 'odd length → ceil(n/2)');
  },

  'oversample: true peak — classic fs/4 45° (+3.01 dBTP) and EBU Tech 3341 cases': () => {
    const fs = 48000;
    // Raised-cosine ramps avoid the (real) step overshoot of a hard start from silence.
    const tone = (f, amp, ph, sec = 2) => {
      const x = sine(f, sec, fs, amp, ph);
      const r = 2400;
      for (let i = 0; i < r; i++) {
        const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / r);
        x[i] *= g;
        x[x.length - 1 - i] *= g;
      }
      return x;
    };
    // classic: fs/4, 45°, samples exactly ±1 (0 dBFS sample peak), true peak √2
    const x = tone(fs / 4, Math.SQRT2, Math.PI / 4);
    approx(db(peak(x)), 0, 1e-5, 'sample peak 0 dBFS');
    const tp = truePeakDb([x, x], fs);
    approx(tp, 3.01, 0.1, 'meter ≈ +3.01 dBTP');
    const envL = truePeakEnvelope(x, fs);
    approx(db(peak(envL)), 3.0103, 0.01, 'limiter envelope ≈ +3.0103 dB');
    // EBU Tech 3341 true-peak cases (values computed with the Annex 2 FIR, RESEARCH 05 §3.3)
    const cases = [
      [fs / 4, 0.5, 0, -6.021], [fs / 4, 0.5, Math.PI / 4, -5.976], [fs / 6, 0.5, Math.PI / 3, -6.316],
      [fs / 8, 0.5, (67.5 * Math.PI) / 180, -6.028], [fs / 4, 1.41, Math.PI / 4, 3.029],
    ];
    const out = [];
    for (const [f, a, ph, want] of cases) {
      const s = tone(f, a, ph);
      const got = truePeakDb([s], fs);
      approx(got, want, 0.005, `EBU case f=${f} ph=${ph.toFixed(3)}`);
      const lim = db(peak(truePeakEnvelope(s, fs, undefined, 'limiter')));
      assert(Math.abs(lim - db(a)) < 0.05, `limiter reads ${lim} for true ${db(a)}`);
      out.push(got.toFixed(3));
    }
    return `meter: ${out.join(', ')} dBTP; classic ${tp.toFixed(3)} dBTP`;
  },

  'oversample: truePeakEnvelope properties': () => {
    const fs = 44100;
    const x = pinkNoise(1, fs, 0.9, 12);
    for (const q of ['limiter', 'meter']) {
      const env = truePeakEnvelope(x, fs, undefined, q);
      assert(env.length === x.length);
      for (let i = 0; i < x.length; i++) assert(env[i] >= Math.abs(x[i]), `${q}: env >= |x| at ${i}`);
      assertFinite([env]);
    }
    // meter envelope max === truePeakDb
    approx(db(peak(truePeakEnvelope(x, fs, undefined, 'meter'))), truePeakDb([x], fs), 1e-4, 'meter env vs truePeakDb');
    // out buffer reuse
    const buf = new Float32Array(x.length);
    assert(truePeakEnvelope(x, fs, buf) === buf, 'returns the provided buffer');
    // 96 kHz → 2x (midpoint): fs/4 45° tone peaks exactly at the midpoint
    const hi = sine(24000, 1, 96000, Math.SQRT2, Math.PI / 4);
    const e96 = truePeakEnvelope(hi, 96000);
    let m = 0;
    for (let i = 1000; i < hi.length - 1000; i++) m = Math.max(m, e96[i]);
    approx(db(m), 3.0103, 0.02, '2x midpoint at 96 kHz');
    approx(truePeakDb([hi.subarray(2000, 90000)], 96000), 3.0103, 0.3, 'truePeakDb at 96 kHz');
    // > 192 kHz → sample peak
    const e384 = truePeakEnvelope(hi, 384000);
    for (let i = 0; i < hi.length; i += 101) assert(e384[i] === Math.abs(hi[i]));
    approx(truePeakDb([hi], 384000), db(peak(hi)), 1e-9);
    // silence / short
    approx(truePeakDb([new Float32Array(100), new Float32Array(100)], fs), -240, 1e-9, 'silence → −240 dB');
    for (const n of [0, 1, 2, 10]) {
      const s = whiteNoise(n / fs, fs, 0.5, n + 3);
      const e = truePeakEnvelope(s, fs);
      assert(e.length === n);
      assertFinite([e, truePeakEnvelope(s, fs, undefined, 'meter')]);
      assert(Number.isFinite(truePeakDb([s], fs)));
    }
    assert(Number.isFinite(truePeakDb(Float32Array.from([0.5, -0.5]), fs)), 'accepts a bare Float32Array');
  },

  'oversample: limiter-quality interpolation accuracy vs exact multisine': () => {
    // Band-limited multisines with exactly known continuous waveform: compare the
    // envelope maximum against the exact maximum on the same 4x grid (isolates filter
    // error from the 4x grid under-read) and against the continuous peak.
    const fs = 48000;
    const r = rng(77);
    let worstLim = 0, worstMeter = 0, worstCont = 0;
    for (let trial = 0; trial < 40; trial++) {
      const comps = [];
      const fmax = trial < 20 ? 0.35 : 0.4;
      for (let k = 0; k < 12; k++) comps.push([(0.01 + r() * (fmax - 0.01)) * fs, r() * 2 * Math.PI, 0.2 + r()]);
      const n = 4096;
      const val = (t) => comps.reduce((s, [f, ph, a]) => s + a * Math.sin((2 * Math.PI * f * t) / fs + ph), 0);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = val(i);
      const norm = 0.9 / peak(x);
      for (let i = 0; i < n; i++) x[i] *= norm;
      let grid = 0, cont = 0;
      for (let i = 200; i < n - 200; i++) {
        for (let p = 0; p < 4; p++) grid = Math.max(grid, Math.abs(val(i + p / 4) * norm));
        for (let p = 0; p < 32; p++) cont = Math.max(cont, Math.abs(val(i + p / 32) * norm));
      }
      const lim = truePeakEnvelope(x, fs, undefined, 'limiter');
      const met = truePeakEnvelope(x, fs, undefined, 'meter');
      let ml = 0, mm = 0;
      for (let i = 200; i < n - 200; i++) { ml = Math.max(ml, lim[i]); mm = Math.max(mm, met[i]); }
      worstLim = Math.max(worstLim, Math.abs(db(ml / grid)));
      worstMeter = Math.max(worstMeter, Math.abs(db(mm / cont)));
      worstCont = Math.max(worstCont, Math.abs(db(ml / cont)));
    }
    assert(worstLim < 0.03, `limiter vs exact 4x grid: ${worstLim} dB`);
    assert(worstCont < 0.3, `limiter vs continuous peak: ${worstCont} dB`);
    return `limiter vs exact 4x: ${worstLim.toFixed(4)} dB, vs continuous: ${worstCont.toFixed(3)} dB; meter vs continuous: ${worstMeter.toFixed(3)} dB`;
  },

  'oversample: truePeakDb agrees with ffmpeg ebur128 within 0.2 dB': () => {
    if (!hasFfmpeg()) return 'skip';
    const out = [];
    const signals = [];
    // pink noise (stereo, independent channels)
    signals.push(['pink48', 48000, [pinkNoise(8, 48000, 1.2, 1), pinkNoise(8, 48000, 1.2, 2)]]);
    signals.push(['pink44', 44100, [pinkNoise(8, 44100, 1.2, 3), pinkNoise(8, 44100, 1.2, 4)]]);
    // white noise low-passed at 16 kHz (codec-like), hot level
    {
      const fs = 48000;
      const a = processInPlace(whiteNoise(8, fs, 0.9, 5), butterworth('lowpass', 8, 16000, fs));
      const b = processInPlace(whiteNoise(8, fs, 0.9, 6), butterworth('lowpass', 8, 16000, fs));
      signals.push(['lpnoise48', fs, [a, b]]);
    }
    // music-like: harmonic tones + decaying percussive bursts (noise with a natural
    // high-frequency roll-off) + a little stereo noise
    for (const fs of [44100, 48000]) {
      const n = 8 * fs;
      const r = rng(fs);
      const L = new Float32Array(n), R = new Float32Array(n);
      const hiss = processInPlace(whiteNoise(8, fs, 1, fs + 1), butterworth('lowpass', 2, 9000, fs));
      const notes = [110, 146.83, 196, 261.63, 329.63, 440];
      for (let i = 0; i < n; i++) {
        const t = i / fs;
        let s = 0;
        for (let k = 0; k < notes.length; k++) {
          for (let h = 1; h <= 12; h++) {
            if (notes[k] * h > 0.45 * fs) break;
            s += (0.12 / h) * Math.sin(2 * Math.PI * notes[k] * h * t + k + h);
          }
        }
        const beat = t % 0.5;
        s += 1.2 * Math.exp(-beat * 30) * hiss[i]; // snare-ish burst
        s += 0.6 * Math.exp(-beat * 12) * Math.sin(2 * Math.PI * 55 * beat * (1 - beat)); // kick-ish
        L[i] = 0.5 * s;
        R[i] = 0.5 * s * 0.9 + 0.05 * (2 * r() - 1);
      }
      signals.push([`music${fs / 1000}`, fs, [L, R]]);
    }
    for (const [name, fs, ch] of signals) {
      const path = join(TMP, `foundation-tp-${name}.wav`);
      writeWavFloat(path, ch, fs);
      const ref = ffmpegLoudness(path).truePeakDb;
      const got = truePeakDb(ch, fs);
      const lim = truePeakDb(ch, fs, 'limiter');
      assert(Number.isFinite(ref), `ffmpeg reading for ${name}`);
      assert(Math.abs(got - ref) <= 0.2, `${name}: ours ${got.toFixed(3)} vs ffmpeg ${ref} dBTP`);
      assert(Math.abs(lim - ref) <= 0.2, `${name}: limiter quality ${lim.toFixed(3)} vs ffmpeg ${ref} dBTP`);
      out.push(`${name} meter ${got.toFixed(2)} / limiter ${lim.toFixed(2)} / ffmpeg ${ref}`);
    }
    return out.join(', ');
  },

  // ------------------------------------------------------------------ resample

  'resample: output length is round(n·to/from)': () => {
    const pairs = [[48000, 44100], [44100, 48000], [96000, 44100], [44100, 96000], [48000, 96000],
      [96000, 48000], [22050, 48000], [32000, 44100], [44100, 47999], [8000, 192000], [192000, 8000]];
    for (const [a, b] of pairs) {
      for (const n of [0, 1, 2, 3, 10, 999, 12345]) {
        const y = resample(new Float32Array(n), a, b);
        assert(y.length === Math.round((n * b) / a), `${a}→${b} n=${n}: ${y.length}`);
      }
    }
    const x = Float32Array.from([0.1, 0.2]);
    const same = resample(x, 48000, 48000);
    assert(same !== x && maxDiff(same, x) === 0, 'equal rates → copy');
    let threw = false;
    try { resample(x, 0, 48000); } catch { threw = true; }
    assert(threw, 'invalid rate throws');
  },

  'resample: passband flatness and exact time alignment': () => {
    const pairs = [[48000, 44100], [44100, 48000], [96000, 44100], [44100, 96000], [48000, 96000], [96000, 48000], [44100, 47999], [32000, 48000]];
    let worst = -Infinity, worstGain = 0;
    for (const [a, b] of pairs) {
      const lo = Math.min(a, b);
      for (const f of [31, 440, 1000, 5000, 10000, 15000, 0.4 * lo, 0.45 * lo].filter((v) => v <= 0.45 * lo)) {
        const ph = 0.7;
        const x = sine(f, 0.5, a, 0.5, ph);
        const y = resample(x, a, b);
        const edge = Math.ceil(0.01 * b); // > kernel half-width (≈1 ms)
        // residual vs the analytic tone at the new rate: amplitude AND timing error
        const res = residualDb(y, f, b, 0.5, ph, edge, y.length - edge);
        worst = Math.max(worst, res);
        assert(res < -100, `${a}→${b} @${f.toFixed(0)} Hz: residual ${res.toFixed(1)} dB`);
        const g = Math.abs(db(fitTone(y, f, b, edge, y.length - edge).amp / 0.5));
        worstGain = Math.max(worstGain, g);
        assert(g < 0.001, `${a}→${b} @${f.toFixed(0)}: gain error ${g} dB`);
      }
    }
    return `worst residual ${worst.toFixed(1)} dB, worst gain error ${worstGain.toExponential(1)} dB`;
  },

  'resample: alias and image rejection > 100 dB': () => {
    const report = [];
    // downsampling: anything at or above 0.525·fs_out must vanish
    const down = [[48000, 44100, [23200, 23600, 23990]], [96000, 44100, [23300, 30000, 40000, 47000]],
      [96000, 48000, [25300, 33000, 47500]], [44100, 32000, [16900, 20000, 22000]]];
    for (const [a, b, fsx] of down) {
      for (const f of fsx) {
        const x = sine(f, 0.5, a, 0.5);
        const y = resample(x, a, b);
        const edge = Math.ceil(0.01 * b);
        const att = rmsDb(y, edge, y.length - edge) - db(0.5 / Math.SQRT2);
        assert(att < -100, `${a}→${b}: ${f} Hz leaks at ${att.toFixed(1)} dB`);
        report.push(`${a / 1000}→${b / 1000}k ${f}: ${att.toFixed(0)}`);
      }
    }
    // upsampling: a tone near the passband edge must come out as the pure tone (no images)
    for (const [a, b] of [[44100, 96000], [44100, 48000], [48000, 192000]]) {
      const f = 0.45 * a;
      const y = resample(sine(f, 0.5, a, 0.5), a, b);
      const edge = Math.ceil(0.01 * b);
      const res = residualDb(y, f, b, 0.5, 0, edge, y.length - edge);
      assert(res < -100, `${a}→${b}: images/residual ${res.toFixed(1)} dB`);
      report.push(`${a / 1000}→${b / 1000}k img ${res.toFixed(0)}`);
    }
    return report.join(', ');
  },

  'resample: zero delay (impulse position), resampleAudio, silence and short inputs': () => {
    for (const [a, b] of [[48000, 44100], [44100, 48000], [44100, 96000], [96000, 44100]]) {
      const k = 3000;
      const y = resample(impulse(8000, k, 1), a, b);
      let im = 0;
      for (let i = 1; i < y.length; i++) if (y[i] > y[im]) im = i;
      // Energy centroid of the reconstructed pulse: a coarse check (y² is not fully
      // band-limited below fs, ~0.02-sample bias). Exact alignment is proven by the
      // −100 dB sine residual test above (a 1e-5-sample delay would already fail it).
      let m0 = 0, m1 = 0;
      for (let i = im - 150; i <= im + 150; i++) { m0 += y[i] * y[i]; m1 += i * y[i] * y[i]; }
      const pos = m1 / m0;
      approx(pos, (k * b) / a, 0.03, `${a}→${b} impulse position`);
    }
    // sine time alignment via cross-check of phase (redundant with residual test, cheap)
    const audio = { sampleRate: 48000, channels: [whiteNoise(0.1, 48000, 0.5, 1), whiteNoise(0.1, 48000, 0.5, 2)] };
    assert(resampleAudio(audio, 48000) === audio, 'same rate → same object');
    const r = resampleAudio(audio, 44100);
    assert(r !== audio && r.sampleRate === 44100 && r.channels.length === 2);
    assert(r.channels[0].length === Math.round((4800 * 44100) / 48000));
    assert(maxDiff(r.channels[1], resample(audio.channels[1], 48000, 44100)) < 1e-7, 'stereo pair path equals per-channel path');
    assert(peak(resample(new Float32Array(1000), 44100, 48000)) === 0, 'silence');
    for (const n of [1, 2, 10]) {
      const s = whiteNoise(n / 48000, 48000, 0.5, n);
      for (const [a, b] of [[48000, 44100], [44100, 48000], [44100, 47999]]) {
        const y = resample(s, a, b);
        assertFinite([y]);
      }
    }
    // DC passes at unity in the interior
    const dc = new Float32Array(20000).fill(0.25);
    const ydc = resample(dc, 44100, 48000);
    for (let i = 500; i < ydc.length - 500; i += 37) approx(ydc[i], 0.25, 1e-6, 'DC gain');
  },

  // ------------------------------------------------------------------ performance

  'perf: truePeakEnvelope limiter, 3:30 stereo 48 kHz (budget 400 ms)': () => {
    const L = pinkNoise(210, SR, 1, 1), R = pinkNoise(210, SR, 1, 2);
    const out = new Float32Array(LEN_330);
    truePeakEnvelope(L.subarray(0, 200000), SR, out);
    const ms = bestOf(3, () => {
      truePeakEnvelope(L, SR, out, 'limiter');
      truePeakEnvelope(R, SR, out, 'limiter');
    });
    const msMeter = bestOf(2, () => {
      truePeakEnvelope(L, SR, out, 'meter');
      truePeakEnvelope(R, SR, out, 'meter');
    });
    const msDb = bestOf(3, () => truePeakDb([L, R], SR));
    return perfReport('limiter env', ms, 400) + ` | meter env ${msMeter.toFixed(0)} ms | truePeakDb ${msDb.toFixed(0)} ms`;
  },

  'perf: up/downsample, biquad, crossover, resample (3:30 stereo 48 kHz)': () => {
    const L = pinkNoise(210, SR, 0.5, 3), R = pinkNoise(210, SR, 0.5, 4);
    const res = [];
    let u2, u4;
    const t2 = bestOf(2, () => { u2 = [upsample(L, 2), upsample(R, 2)]; });
    const d2 = bestOf(2, () => { downsample(u2[0], 2); downsample(u2[1], 2); });
    u2 = null;
    const t4 = bestOf(1, () => { u4 = [upsample(L, 4), upsample(R, 4)]; });
    const d4 = bestOf(1, () => { downsample(u4[0], 4); downsample(u4[1], 4); });
    u4 = null;
    res.push(`up2 ${t2.toFixed(0)} / down2 ${d2.toFixed(0)} / up4 ${t4.toFixed(0)} / down4 ${d4.toFixed(0)} ms`);
    const secs = [...butterworth('highpass', 2, 25, SR), design('peaking', 300, SR, { gainDb: -2 }), design('highshelf', 12000, SR, { gainDb: 1 }),
      design('peaking', 3000, SR, { gainDb: -1, q: 2 }), design('lowshelf', 90, SR, { gainDb: 1 })];
    const bq = bestOf(2, () => processStereoInPlace([Float32Array.from(L), Float32Array.from(R)], secs));
    res.push(`6-section biquad ${bq.toFixed(0)} ms`);
    const xo = bestOf(2, () => splitBandsStereo([L, R], [120, 3000], SR));
    res.push(`3-band LR4 split ${xo.toFixed(0)} ms`);
    const rs = bestOf(1, () => resampleAudio({ sampleRate: SR, channels: [L, R] }, 44100));
    const rs2 = bestOf(1, () => resampleAudio({ sampleRate: 44100, channels: [L.subarray(0, 210 * 44100), R.subarray(0, 210 * 44100)] }, 48000));
    res.push(`resample 48→44.1k ${rs.toFixed(0)} ms, 44.1→48k ${rs2.toFixed(0)} ms`);
    // generous sanity bound only (no §8 budget for these primitives); numbers are reported
    assert(bq < 3000 * speedFactor() && xo < 4000 * speedFactor(), 'biquad/crossover unexpectedly slow');
    return res.join(' | ') + ` (host factor ${speedFactor().toFixed(2)})`;
  },
};
