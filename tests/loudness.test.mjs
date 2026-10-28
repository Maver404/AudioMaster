// Tests for src/analysis/loudness.js — BS.1770-4/5 K-weighting, gating, EBU Tech 3341
// compliance vectors, EBU Tech 3342 LRA, true peak, robustness, ffmpeg ebur128
// cross-checks (44.1 / 48 / 96 kHz) and the measure() performance budget.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  assert, approx, sine, pinkNoise, stereo, rng, writeWavFloat, hasFfmpeg, TMP,
  speedFactor,
} from './helpers.mjs';
import {
  kWeight, kWeightingSections, integratedLoudness, loudnessRange, shortTermMax,
  momentaryMax, loudnessCurve, measure, measureTruePeakDb, CURVE_FLOOR_LUFS,
} from '../src/analysis/loudness.js';
import { responseDb } from '../src/dsp/biquad.js';
import { truePeakDb } from '../src/dsp/oversample.js';

const RATES = [44100, 48000, 96000];
const dbfs = (db) => Math.pow(10, db / 20);

/** Stereo 1 kHz sine made of [seconds, dBFS-peak] segments, phase-continuous. */
function sineSegments(segments, sr, freq = 1000) {
  const n = segments.reduce((s, [sec]) => s + Math.round(sec * sr), 0);
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sr;
  let i = 0;
  for (const [sec, db] of segments) {
    const a = dbfs(db);
    for (const end = i + Math.round(sec * sr); i < end; i++) x[i] = a * Math.sin(w * i);
  }
  return stereo(x);
}

/** Decorrelated stereo pink noise scaled to an RMS level (dBFS) per segment. */
function pinkSegments(segments, sr, seed = 3) {
  const n = segments.reduce((s, [sec]) => s + Math.round(sec * sr), 0);
  const L = pinkNoise(n / sr, sr, 1, seed);
  const R = pinkNoise(n / sr, sr, 1, seed + 101);
  let ms = 0;
  for (let i = 0; i < L.length; i++) ms += L[i] * L[i] + R[i] * R[i];
  const norm = 1 / Math.sqrt(ms / (2 * L.length));
  let i = 0;
  for (const [sec, db] of segments) {
    const g = norm * dbfs(db);
    for (const end = Math.min(L.length, i + Math.round(sec * sr)); i < end; i++) {
      L[i] *= g;
      R[i] *= g;
    }
  }
  return [L, R];
}

function assertNoNaN(m, label = '') {
  for (const k of ['integrated', 'lra', 'shortTermMax', 'momentaryMax', 'truePeakDb', 'samplePeakDb', 'curveHopSec']) {
    assert(!Number.isNaN(m[k]), `${label} ${k} is NaN`);
  }
  assert(Number.isFinite(m.lra) && m.lra >= 0, `${label} lra must be finite >= 0, got ${m.lra}`);
  assert(Number.isFinite(m.truePeakDb) && Number.isFinite(m.samplePeakDb), `${label} peaks must be finite`);
  for (const k of ['integrated', 'shortTermMax', 'momentaryMax']) {
    assert(m[k] !== Infinity, `${label} ${k} is +Infinity`);
  }
  assert(m.curve instanceof Float32Array, `${label} curve must be a Float32Array`);
  for (let i = 0; i < m.curve.length; i++) assert(Number.isFinite(m.curve[i]), `${label} curve[${i}] = ${m.curve[i]}`);
}

// ------------------------------------------------------------------ ffmpeg bridge

/**
 * ffmpeg ebur128 with per-100 ms metadata (3 decimals): M/S per frame (frame k = window
 * ending at the end of 100 ms grain k), final I / LRA, plus the stderr summary true peak.
 */
function ffmpegR128(path) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af',
    'ebur128=metadata=1:peak=true,ametadata=mode=print:file=-', '-f', 'null', '-'], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  const M = [], S = [];
  let I = NaN, LRA = NaN, tpLin = NaN;
  for (const line of res.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (!line.startsWith('lavfi.r128.') || eq < 0) continue;
    const key = line.slice(11, eq);
    const v = parseFloat(line.slice(eq + 1));
    if (key === 'M') M.push(v);
    else if (key === 'S') S.push(v);
    else if (key === 'I') I = v;
    else if (key === 'LRA') LRA = v;
    else if (key === 'true_peak') tpLin = v;
  }
  const text = res.stderr;
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const m = summary.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  const tpSummary = m ? parseFloat(m[1]) : NaN;
  // metadata TP is linear with 3 decimals: better than the 0.1 dB summary above ~0.1 FS
  const truePeakDb = tpLin >= 0.1 ? 20 * Math.log10(tpLin) : tpSummary;
  return { M, S, I, LRA, truePeakDb };
}

const ffStats = { dI: 0, dLRA: 0, dTP: 0, dS: 0, dM: 0, lines: [] };

function crossCheck(label, ch, sr) {
  const path = writeWavFloat(join(TMP, `loudness-${label}-${sr}.wav`), ch, sr);
  const ref = ffmpegR128(path);
  const m = measure(ch, sr);
  assertNoNaN(m, label);
  const dI = Math.abs(m.integrated - ref.I);
  const dLRA = Math.abs(m.lra - ref.LRA);
  const dTP = Math.abs(m.truePeakDb - ref.truePeakDb);
  // Curve alignment: ffmpeg frame k carries the 3 s window ending at grain k.
  let dS = 0, dM = 0, maxS = -Infinity, maxM = -Infinity;
  for (let k = 0; k < Math.min(ref.S.length, m.curve.length); k++) {
    if (ref.S[k] > -70) dS = Math.max(dS, Math.abs(m.curve[k] - ref.S[k]));
    maxS = Math.max(maxS, ref.S[k]);
    maxM = Math.max(maxM, ref.M[k]);
  }
  dS = Math.max(dS, Math.abs(m.shortTermMax - maxS));
  dM = Math.abs(m.momentaryMax - maxM);
  const msg = `${label}@${sr / 1000}k: I ${m.integrated.toFixed(3)}/${ref.I.toFixed(3)} LRA ${m.lra.toFixed(2)}/${ref.LRA.toFixed(2)} TP ${m.truePeakDb.toFixed(2)}/${ref.truePeakDb.toFixed(2)}`;
  assert(dI <= 0.1, `${msg}: integrated off by ${dI.toFixed(3)} LU`);
  assert(dLRA <= 0.3, `${msg}: LRA off by ${dLRA.toFixed(3)} LU`);
  assert(dTP <= 0.2, `${msg}: true peak off by ${dTP.toFixed(3)} dB`);
  assert(dS <= 0.02, `${msg}: short-term curve off by ${dS.toFixed(4)} LU`);
  assert(dM <= 0.02, `${msg}: momentary max off by ${dM.toFixed(4)} LU`);
  ffStats.dI = Math.max(ffStats.dI, dI);
  ffStats.dLRA = Math.max(ffStats.dLRA, dLRA);
  ffStats.dTP = Math.max(ffStats.dTP, dTP);
  ffStats.dS = Math.max(ffStats.dS, dS);
  ffStats.dM = Math.max(ffStats.dM, dM);
  ffStats.lines.push(msg);
  return { m, ref, dI, dLRA, dTP };
}

function ffSummary(results) {
  const r = (k) => Math.max(...results.map((x) => x[k])).toFixed(3);
  return `max |Δ| vs ffmpeg: I ${r('dI')} LU, LRA ${r('dLRA')} LU, TP ${r('dTP')} dB`;
}

// ------------------------------------------------------------------ performance

/**
 * Host speed factor vs the ARCHITECTURE §8 reference (Apple M1 P-core), same probe as
 * tests/foundation.test.mjs: a dependent float-add chain (0.94 ns/iteration on M1).
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

// ------------------------------------------------------------------ tests

export const tests = {
  'K-weighting coefficients reproduce the BS.1770 48 kHz tables': async () => {
    const [s1, s2] = kWeightingSections(48000);
    const T1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
    const T2 = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621];
    const keys = ['b0', 'b1', 'b2', 'a1', 'a2'];
    keys.forEach((k, i) => approx(s1[k], T1[i], 1e-14, `stage 1 ${k}`));
    keys.forEach((k, i) => approx(s2[k], T2[i], 1e-14, `stage 2 ${k}`));
    // stage-2 numerator deliberately un-normalized (exactly [1, -2, 1])
    assert(s2.b0 === 1 && s2.b1 === -2 && s2.b2 === 1, 'stage 2 numerator must be [1,-2,1]');
  },

  'K-weighting coefficients at 44.1 and 96 kHz (libebur128 derivation)': async () => {
    const ref = {
      44100: [[1.53084123005035, -2.65097999515473, 1.16907907992159, -1.66365511325602, 0.71259542807323],
        [-1.98916967362980, 0.98919903578704]],
      96000: [[1.55971422897580, -2.92674157825108, 1.37826120231582, -1.84460946989011, 0.85584332293064],
        [-1.99501754472472, 0.99502375904092]],
    };
    for (const sr of [44100, 96000]) {
      const [s1, s2] = kWeightingSections(sr);
      ['b0', 'b1', 'b2', 'a1', 'a2'].forEach((k, i) => approx(s1[k], ref[sr][0][i], 1e-13, `${sr} stage 1 ${k}`));
      approx(s2.a1, ref[sr][1][0], 1e-13, `${sr} stage 2 a1`);
      approx(s2.a2, ref[sr][1][1], 1e-13, `${sr} stage 2 a2`);
    }
    let threw = false;
    try { kWeightingSections(0); } catch { threw = true; }
    assert(threw, 'invalid sample rate must throw');
  },

  'K-weighting magnitude at the RESEARCH §7 test points (48 kHz)': async () => {
    const secs = kWeightingSections(48000);
    const pts = [[20, -13.275], [38, -6.003], [100, -1.133], [1000, 0.698], [1500, 2.036],
      [2000, 3.071], [4000, 3.968], [10000, 4.042], [20000, 4.043]];
    const out = [];
    for (const [f, want] of pts) {
      const got = responseDb(secs, f, 48000);
      approx(got, want, 0.001, `K-weighting @ ${f} Hz`);
      out.push(`${f}:${got.toFixed(3)}`);
    }
    // the −0.691 constant cancels the gain at 997 Hz (BS.1770 Note 1)
    approx(responseDb(secs, 997, 48000), 0.691, 0.001, '997 Hz gain');
    return out.join(' ');
  },

  'K-weighting response is sample-rate independent (44.1 / 96 vs 48 kHz)': async () => {
    const r48 = kWeightingSections(48000);
    let d44 = 0, d96 = 0;
    for (let f = 40; f <= 20000; f *= 1.05) {
      const ref = responseDb(r48, f, 48000);
      if (f >= 1000) d44 = Math.max(d44, Math.abs(responseDb(kWeightingSections(44100), f, 44100) - ref));
      d96 = Math.max(d96, Math.abs(responseDb(kWeightingSections(96000), f, 96000) - ref));
    }
    // 44.1 vs 48: < 0.005 dB from 1 kHz up (research/05 §1.2). 96 kHz differs mainly by the
    // un-normalized stage-2 passband gain (+0.022 vs +0.043 dB) — kept for ffmpeg parity.
    assert(d44 < 0.006, `44.1 kHz deviates ${d44.toFixed(4)} dB`);
    assert(d96 < 0.03, `96 kHz deviates ${d96.toFixed(4)} dB`);
    return `max |Δ| 44.1k ${d44.toFixed(4)} dB (1–20 kHz), 96k ${d96.toFixed(4)} dB (40 Hz–20 kHz)`;
  },

  'kWeight() matches the analytic response, returns new arrays, leaves input intact': async () => {
    for (const sr of RATES) {
      const secs = kWeightingSections(sr);
      for (const f of [25, 100, 1000, 5000, 15000]) {
        const x = sine(f, 1.5, sr, 0.5);
        const ch = [x, Float32Array.from(x)];
        const copy = Float32Array.from(x);
        const y = kWeight(ch, sr);
        assert(y.length === 2 && y[0] !== ch[0] && y[0].length === x.length, 'new arrays, same length');
        for (let i = 0; i < x.length; i += 997) assert(x[i] === copy[i], 'input modified');
        const a = Math.round(0.5 * sr), b = x.length;
        let px = 0, py = 0;
        for (let i = a; i < b; i++) {
          px += x[i] * x[i];
          py += y[0][i] * y[0][i];
        }
        const got = 10 * Math.log10(py / px);
        approx(got, responseDb(secs, f, sr), 0.01, `kWeight gain @ ${f} Hz, ${sr} Hz`);
      }
    }
    const single = kWeight(new Float32Array(100), 48000);
    assert(Array.isArray(single) && single.length === 1 && single[0].length === 100, 'single array input');
  },

  'EBU Tech 3341 #1/#2: 1 kHz at −23 / −33 dBFS → M = S = I (44.1/48/96 kHz)': async () => {
    const out = [];
    for (const sr of RATES) {
      for (const lvl of [-23, -33]) {
        const ch = sineSegments([[20, lvl]], sr);
        const m = measure(ch, sr);
        approx(m.integrated, lvl, 0.1, `I ${lvl} @ ${sr}`);
        approx(m.momentaryMax, lvl, 0.1, `M ${lvl} @ ${sr}`);
        approx(m.shortTermMax, lvl, 0.1, `S ${lvl} @ ${sr}`);
        // steady tone: the expected deviation is only the K-weighting gain at 1 kHz
        // (+0.698 dB) − 0.691 (+ the rate-dependent stage-2 passband gain, ≤ 0.03 dB)
        approx(m.integrated, lvl, 0.03, `I ${lvl} @ ${sr} (tight)`);
        assert(m.lra < 1e-6, `steady tone LRA ${m.lra}`);
        for (let k = 29; k < m.curve.length; k++) approx(m.curve[k], m.shortTermMax, 1e-4, `curve[${k}]`);
        out.push(`${sr / 1000}k ${lvl}: ${m.integrated.toFixed(3)}`);
      }
    }
    return out.join(', ');
  },

  'EBU Tech 3341 #3/#4/#5: relative and absolute gates → −23.0 LUFS': async () => {
    const cases = {
      3: [[10, -36], [60, -23], [10, -36]],
      4: [[10, -72], [10, -36], [60, -23], [10, -36], [10, -72]],
      5: [[20, -26], [20.1, -20], [20, -26]],
    };
    const out = [];
    for (const sr of [44100, 48000]) {
      for (const [id, segs] of Object.entries(cases)) {
        const I = integratedLoudness(sineSegments(segs, sr), sr);
        approx(I, -23, 0.1, `Tech 3341 #${id} @ ${sr}`);
        out.push(`#${id}@${sr / 1000}k ${I.toFixed(3)}`);
      }
    }
    return out.join(', ');
  },

  'EBU Tech 3342 LRA cases #1–#4 (10 / 5 / 20 / 15 LU)': async () => {
    const cases = [
      [[[20, -20], [20, -30]], 10],
      [[[20, -20], [20, -15]], 5],
      [[[20, -40], [20, -20]], 20],
      [[[20, -50], [20, -35], [20, -20], [20, -35], [20, -50]], 15],
    ];
    const out = [];
    for (const sr of [44100, 48000]) {
      cases.forEach(([segs, want], i) => {
        const lra = loudnessRange(sineSegments(segs, sr), sr);
        approx(lra, want, 1, `Tech 3342 #${i + 1} @ ${sr}`);
        approx(lra, want, 0.05, `Tech 3342 #${i + 1} @ ${sr} (tight)`);
        out.push(`#${i + 1}@${sr / 1000}k ${lra.toFixed(3)}`);
      });
    }
    return out.join(', ');
  },

  'silence → −Infinity loudness, LRA 0, finite peaks, floored curve, never NaN': async () => {
    for (const sr of RATES) {
      const ch = [new Float32Array(5 * sr), new Float32Array(5 * sr)];
      const m = measure(ch, sr);
      assertNoNaN(m, 'silence');
      assert(m.integrated === -Infinity, `integrated ${m.integrated}`);
      assert(m.shortTermMax === -Infinity && m.momentaryMax === -Infinity, 'S/M max of silence');
      assert(m.lra === 0, 'lra of silence');
      assert(m.truePeakDb <= -200 && m.samplePeakDb <= -200, 'peaks of silence');
      assert(m.curve.length === 50 && m.curve.every((v) => v === CURVE_FLOOR_LUFS), 'curve of silence');
      assert(integratedLoudness(ch, sr) === -Infinity, 'integratedLoudness(silence)');
      assert(loudnessRange(ch, sr) === 0, 'loudnessRange(silence)');
      assert(shortTermMax(ch, sr) === -Infinity && momentaryMax(ch, sr) === -Infinity, 'max of silence');
    }
    // below the absolute gate (−80 dBFS tone) also reads as "no programme"
    const quiet = sineSegments([[10, -80]], 48000);
    assert(integratedLoudness(quiet, 48000) === -Infinity, 'below −70 LUFS absolute gate');
    assert(loudnessRange(quiet, 48000) === 0, 'LRA below gate');
    approx(momentaryMax(quiet, 48000), -80, 0.05, 'ungated momentary still measured');
  },

  'very short and degenerate inputs are safe (0 … 19200 samples, empty, mono, single array)': async () => {
    const sr = 48000;
    for (const n of [0, 1, 10, 4799, 4800, 4801, 19199, 19200, 48000]) {
      const x = sine(1000, n / sr, sr, dbfs(-20));
      const m = measure(stereo(x), sr);
      assertNoNaN(m, `n=${n}`);
      assert(m.curve.length === Math.floor(n / 4800), `curve length for n=${n}`);
      if (n < 19200) assert(m.integrated === -Infinity, `no complete 400 ms block for n=${n}`);
      else approx(m.integrated, -20, 0.05, `integrated n=${n}`);
      if (n < 4800) assert(m.momentaryMax === -Infinity, `no complete grain n=${n}`);
      else assert(Number.isFinite(m.momentaryMax), `momentary for n=${n}`);
      if (n >= 1) approx(m.samplePeakDb, 20 * Math.log10(Math.max(...Array.from(x, Math.abs), 1e-12)), 1e-4, `peak n=${n}`);
      for (const f of [integratedLoudness, loudnessRange, shortTermMax, momentaryMax]) {
        assert(!Number.isNaN(f(stereo(x), sr)), `${f.name} NaN for n=${n}`);
      }
      const c = loudnessCurve(stereo(x), sr);
      assert(c.length === Math.floor(n / 4800), 'loudnessCurve length');
    }
    const e = measure([], sr);
    assertNoNaN(e, 'empty');
    assert(e.integrated === -Infinity && e.curve.length === 0, 'empty channel list');
    const s = measure(sine(1000, 2, sr, dbfs(-20)), sr);
    approx(s.integrated, -20 - 3.0103, 0.05, 'a bare Float32Array is one (mono) channel');
    // channels of different lengths: loudness over the common part, peaks over everything
    const a = sine(1000, 2, sr, 0.1);
    const b = new Float32Array(3 * sr);
    b[b.length - 1] = 0.9;
    const u = measure([a, b], sr);
    assertNoNaN(u, 'unequal');
    approx(u.samplePeakDb, 20 * Math.log10(0.9), 1e-4, 'peak of the longer channel tail');
  },

  'mono input reads 3.01 dB below the same audio as dual-mono': async () => {
    const sr = 48000;
    const x = pinkSegments([[10, -20]], sr)[0];
    const mono = integratedLoudness([x], sr);
    const dual = integratedLoudness([x, x], sr);
    approx(dual - mono, 10 * Math.log10(2), 1e-6, 'dual-mono offset');
    return `mono ${mono.toFixed(3)} / dual ${dual.toFixed(3)} LUFS`;
  },

  'NaN / Infinity samples never produce NaN': async () => {
    const sr = 48000;
    const ch = pinkSegments([[10, -20]], sr);
    const clean = measure(ch, sr);
    ch[0][123456] = NaN;
    ch[1][234567] = Infinity;
    ch[0][345678] = -Infinity;
    const m = measure(ch, sr);
    assertNoNaN(m, 'corrupt');
    assert(Number.isFinite(m.integrated), 'integrated stays finite');
    approx(m.integrated, clean.integrated, 0.2, 'corrupt grains are dropped, not propagated');
    for (const f of [integratedLoudness, loudnessRange, shortTermMax, momentaryMax]) {
      assert(Number.isFinite(f(ch, sr)), `${f.name} finite with corrupt samples`);
    }
    // a lone +Infinity or NaN must neither yield an infinite true peak nor hide the real one
    for (const bad of [Infinity, NaN]) {
      const c2 = pinkSegments([[3.05, -20]], sr, 4); // 3.05 s: last 50 ms are not a full grain
      const last = c2[1].length - 1;
      c2[1][1000] = bad;
      c2[0][last] = bad;
      const clean2 = measureTruePeakDb(pinkSegments([[3.05, -20]], sr, 4).map((x, c) => {
        if (c === 1) x[1000] = 0;
        else x[last] = 0;
        return x;
      }), sr);
      const m2 = measure(c2, sr);
      assertNoNaN(m2, `lone ${bad}`);
      approx(m2.truePeakDb, clean2, 1e-9, `true peak with a lone ${bad}`);
    }
  },

  'measure() equals the standalone functions and measureTruePeakDb()': async () => {
    for (const sr of RATES) {
      const ch = pinkSegments([[6, -18], [5, -30], [7, -14], [4.05, -24]], sr, 9);
      const m = measure(ch, sr);
      assertNoNaN(m, `${sr}`);
      assert(m.integrated === integratedLoudness(ch, sr), 'integrated');
      assert(m.lra === loudnessRange(ch, sr), 'lra');
      assert(m.shortTermMax === shortTermMax(ch, sr), 'shortTermMax');
      assert(m.momentaryMax === momentaryMax(ch, sr), 'momentaryMax');
      assert(m.truePeakDb === measureTruePeakDb(ch, sr), 'truePeakDb = measureTruePeakDb');
      const tpMeter = truePeakDb(ch, sr), tpSharp = truePeakDb(ch, sr, 'limiter');
      assert(m.truePeakDb === tpSharp, 'sharp 4x interpolator');
      // pink noise reaches Nyquist: the Annex 2 filter (−6 dB at fs/2) reads up to ~0.15 dB lower
      approx(tpSharp, tpMeter, 0.25, 'sharp vs BS.1770 Annex 2 filter on pink noise');
      assert(measureTruePeakDb(ch, sr, { conservative: true }) === Math.max(tpMeter, tpSharp), 'conservative = max of both');
      let pk = 0;
      for (const c of ch) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
      approx(m.samplePeakDb, 20 * Math.log10(pk), 1e-9, 'samplePeakDb');
      assert(m.truePeakDb >= m.samplePeakDb, 'TP >= sample peak');
      const c = loudnessCurve(ch, sr);
      assert(c.length === m.curve.length && c.length === Math.floor(ch[0].length / Math.round(0.1 * sr)), 'curve length');
      for (let k = 0; k < c.length; k++) assert(c[k] === m.curve[k], `curve[${k}]`);
      approx(m.curveHopSec, 0.1, 1e-12, 'curveHopSec');
      approx(Math.max(...m.curve), m.shortTermMax, 1e-4, 'max(curve) = shortTermMax');
      // gain linearity: +6 dB in → +6 LU on every loudness reading, LRA unchanged
      const g = dbfs(6);
      const m2 = measure(ch.map((x) => x.map((v) => v * g)), sr);
      approx(m2.integrated - m.integrated, 6, 1e-5, 'I gain linearity');
      approx(m2.shortTermMax - m.shortTermMax, 6, 1e-5, 'S gain linearity');
      approx(m2.lra, m.lra, 1e-5, 'LRA gain invariance');
      // L/R symmetry
      const sw = measure([ch[1], ch[0]], sr);
      approx(sw.integrated, m.integrated, 1e-9, 'channel swap');
    }
  },

  'loudnessCurve: timing (window ending at each hop), zero-padded start, options': async () => {
    const sr = 48000;
    const lvl = -20;
    const ch = sineSegments([[5, -200], [10, lvl]], sr); // 5 s silence, 10 s tone
    const full = integratedLoudness(sineSegments([[10, lvl]], sr), sr);
    const c = loudnessCurve(ch, sr);
    assert(c.length === 150, 'length');
    for (let k = 0; k < 50; k++) assert(c[k] === CURVE_FLOOR_LUFS, `silent window ${k}: ${c[k]}`);
    // window ending at grain k holds (k − 49) grains of tone out of 30
    for (let k = 50; k < 80; k++) approx(c[k], full + 10 * Math.log10((k - 49) / 30), 0.01, `ramp ${k}`);
    for (let k = 79; k < 150; k++) approx(c[k], full, 0.01, `steady ${k}`);
    // 400 ms window → max equals momentaryMax; finer hop doubles the length
    const m400 = loudnessCurve(ch, sr, { windowSec: 0.4 });
    approx(Math.max(...m400), momentaryMax(ch, sr), 1e-4, '0.4 s window max');
    const fine = loudnessCurve(ch, sr, { hopSec: 0.05 });
    assert(fine.length === 300, 'hop 0.05 → 300 entries');
    approx(fine[299], c[149], 1e-3, 'same 3 s window at the end');
    const bad = loudnessCurve(ch, sr, { windowSec: -1, hopSec: NaN });
    assert(bad.length === 150 && bad[100] === c[100], 'invalid options fall back to defaults');
  },

  'short input: S/M max are the zero-padded meter reading at the end': async () => {
    const sr = 48000;
    const ch = sineSegments([[1, -20]], sr);
    const ref = momentaryMax(ch, sr);
    approx(ref, -20, 0.03, 'momentary of a 1 s tone');
    approx(shortTermMax(ch, sr), ref + 10 * Math.log10(1 / 3), 0.01, '1 s of a 3 s window');
    assert(loudnessRange(ch, sr) === 0, 'no complete 3 s window → LRA 0');
  },

  'true peak: EBU Tech 3341 #15–#19 inter-sample cases (48 kHz)': async () => {
    const sr = 48000;
    const cases = [
      [sr / 4, 0.5, 0, -6.02], [sr / 4, 0.5, 45, -6.02], [sr / 6, 0.5, 60, -6.02],
      [sr / 8, 0.5, 67.5, -6.02], [sr / 4, 1.41, 45, 3.0],
    ];
    // Raised-cosine ramps: a hard start from silence has a real (step) overshoot.
    const tone = (f, amp, ph) => {
      const x = sine(f, 2, sr, amp, (ph * Math.PI) / 180);
      for (let i = 0, r = 2400; i < r; i++) {
        const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / r);
        x[i] *= g;
        x[x.length - 1 - i] *= g;
      }
      return x;
    };
    const out = [], annex = [];
    for (const [f, amp, ph, want] of cases) {
      const x = tone(f, amp, ph);
      const m = measure(stereo(x), sr);
      // the sharp interpolator tracks the analog peak (the Annex 2 filter reads −6.316 /
      // −5.976 on #17 / #16); the conservative form never reads below the Annex 2 filter
      approx(m.truePeakDb, 20 * Math.log10(amp), 0.04, `reported TP vs exact peak (f=${f}, ${ph}°)`);
      const meter = truePeakDb(stereo(x), sr);
      assert(measureTruePeakDb(stereo(x), sr, { conservative: true }) === Math.max(meter, m.truePeakDb), 'conservative');
      annex.push(meter.toFixed(3));
      assert(m.truePeakDb >= want - 0.4 && m.truePeakDb <= want + 0.2, `TP ${m.truePeakDb} for f=${f} ph=${ph} (want ${want} +0.2/−0.4)`);
      out.push(m.truePeakDb.toFixed(3));
    }
    const last = measure(stereo(tone(sr / 4, 1.41, 45)), sr);
    approx(last.samplePeakDb, 20 * Math.log10(1.41 * Math.SQRT1_2), 0.01, 'sample peak of #19');
    return `reported ${out.join(' / ')} dBTP (Annex 2 filter: ${annex.join(' / ')})`;
  },

  'ffmpeg ebur128: 1 kHz sines at −23 / −18 / −30 dBFS (44.1 / 48 / 96 kHz)': async () => {
    if (!hasFfmpeg()) return 'skip';
    const res = [];
    for (const sr of RATES) {
      for (const lvl of [-23, -18, -30]) res.push(crossCheck(`sine${lvl}`, sineSegments([[20, lvl]], sr), sr));
    }
    return ffSummary(res);
  },

  'ffmpeg ebur128: pink noise (44.1 / 48 / 96 kHz)': async () => {
    if (!hasFfmpeg()) return 'skip';
    const res = [];
    for (const sr of RATES) res.push(crossCheck('pink', pinkSegments([[30, -16]], sr, 5), sr));
    return ffSummary(res);
  },

  'ffmpeg ebur128: alternating 20 s −20 / 20 s −30 dBFS → LRA ≈ 10 (44.1 / 48 / 96 kHz)': async () => {
    if (!hasFfmpeg()) return 'skip';
    const res = [];
    for (const sr of RATES) {
      const tone = crossCheck('alt-sine', sineSegments([[20, -20], [20, -30], [20, -20], [20, -30]], sr), sr);
      approx(tone.m.lra, 10, 0.1, `tone LRA @ ${sr}`);
      const pink = crossCheck('alt-pink', pinkSegments([[20, -20], [20, -30], [20, -20], [20, -30]], sr, 11), sr);
      approx(pink.m.lra, 10, 1, `pink LRA @ ${sr}`);
      res.push(tone, pink);
    }
    return ffSummary(res) + ` (pink LRA ${res[1].m.lra.toFixed(2)} vs ffmpeg ${res[1].ref.LRA.toFixed(2)})`;
  },

  'ffmpeg ebur128: demo track (44.1 / 48 / 96 kHz)': async () => {
    if (!hasFfmpeg()) return 'skip';
    let gen;
    try {
      gen = (await import('../src/demo/demo-track.js')).generateDemoTrack;
    } catch {
      return 'skip';
    }
    if (typeof gen !== 'function') return 'skip';
    const res = [];
    for (const sr of RATES) {
      // defects: loud (≈ −8.5 LUFS), naively clipped → inter-sample overs (TP stress test)
      res.push(crossCheck('demo', gen({ sampleRate: sr, seconds: 32 }).channels, sr));
      res.push(crossCheck('demo-clean', gen({ sampleRate: sr, seconds: 32, defects: false }).channels, sr));
    }
    const d = res[2];
    return ffSummary(res) + ` (48k: I ${d.m.integrated.toFixed(2)}/${d.ref.I.toFixed(2)} LRA ${d.m.lra.toFixed(2)}/${d.ref.LRA.toFixed(2)} TP ${d.m.truePeakDb.toFixed(2)}/${d.ref.truePeakDb.toFixed(2)})`;
  },

  'ffmpeg cross-check summary (worst case over all files)': async () => {
    if (!hasFfmpeg() || !ffStats.lines.length) return 'skip';
    return `${ffStats.lines.length} files: max |ΔI| ${ffStats.dI.toFixed(3)} LU, |ΔLRA| ${ffStats.dLRA.toFixed(3)} LU, ` +
      `|ΔTP| ${ffStats.dTP.toFixed(3)} dB, |ΔS curve| ${ffStats.dS.toFixed(4)} LU, |ΔM max| ${ffStats.dM.toFixed(4)} LU`;
  },

  'performance: measure() on 3:30 stereo 48 kHz < 600 ms (M1 budget)': async () => {
    const sr = 48000;
    const n = 210 * sr;
    // (a) dynamic programme: decorrelated pink noise, slow level envelope, rare transients
    const L = pinkNoise(210, sr, 0.6, 21), R = pinkNoise(210, sr, 0.6, 22);
    // (b) loud "brick-walled" master (worst case: every block peaks near the ceiling, so
    //     the true-peak pass can skip nothing): pink noise driven into tanh, ≈ −6 LUFS
    const LL = new Float32Array(n), RR = new Float32Array(n);
    const r = rng(5);
    for (let i = 0; i < n; i++) {
      const env = 0.35 + 0.3 * Math.sin((2 * Math.PI * i) / (sr * 17));
      LL[i] = 0.89 * Math.tanh(4 * L[i]);
      RR[i] = 0.89 * Math.tanh(4 * R[i]);
      const g = env + (r() < 2e-5 ? 2 : 0);
      L[i] *= g;
      R[i] *= g;
    }
    const dyn = [L, R], loud = [LL, RR];
    measure(dyn, sr); // warm-up (JIT)
    const tDyn = bestOf(3, () => measure(dyn, sr));
    const tLoud = bestOf(3, () => measure(loud, sr));
    const tTP = bestOf(2, () => measureTruePeakDb(loud, sr));
    const tI = bestOf(3, () => integratedLoudness(loud, sr));
    const tK = bestOf(2, () => kWeight(loud, sr));
    const f = speedFactor();
    const at = (ms) => `${ms.toFixed(0)} ms (≈${(ms / f).toFixed(0)} @M1)`;
    const msg = `measure: loud master ${at(tLoud)}, dynamic ${at(tDyn)}; budget 600 ms @M1, host factor ${f.toFixed(2)} · ` +
      `loud: true peak ${tTP.toFixed(0)} ms, integratedLoudness ${tI.toFixed(0)} ms, kWeight() ${tK.toFixed(0)} ms ` +
      `(loud master I ${integratedLoudness(loud, sr).toFixed(1)} LUFS)`;
    assert(Math.max(tLoud, tDyn) < 600 * f, `${msg} exceeds budget`);
    return msg;
  },
};
