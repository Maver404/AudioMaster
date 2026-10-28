// Tests for src/demo/demo-track.js (synthetic "Suno-like" demo song) and
// tools/make-fixtures.mjs. All analysis DSP here is private to the test (FFT, PSD,
// filters, true peak) so it does not depend on modules other agents are writing.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertFinite, ffmpegDecode, ffmpegLoudness, hasFfmpeg, TMP, writeWavFloat } from './helpers.mjs';
import { DEMO_BPM, DEMO_DEFECTS, demoArrangement, demoShimmerPartials, generateDemoTrack } from '../src/demo/demo-track.js';
import { makeFixtures } from '../tools/make-fixtures.mjs';

const SR = 48000;
const BODY = [4.5, 28]; // verse + chorus, away from intro and ending
const ISSUE_IDS = ['clipping', 'overs', 'tooLoud', 'tooQuiet', 'dcOffset', 'rumble', 'boomy', 'muddy', 'harsh', 'fizz', 'sibilant', 'shimmer', 'hiss', 'dull', 'brightened', 'codecCutoff', 'nearMono', 'phase', 'wideBass', 'abruptEnd', 'silence', 'overCompressed'];

// ------------------------------------------------------------------------------
// Cached renders (each 32 s render costs ~0.3 s)
// ------------------------------------------------------------------------------
const cache = new Map();
function demo(opts = {}) {
  const key = JSON.stringify(opts);
  if (!cache.has(key)) cache.set(key, generateDemoTrack(opts));
  return cache.get(key);
}
const DEF = () => demo({ defects: true });
const CLEAN = () => demo({ defects: false });

// ------------------------------------------------------------------------------
// Private analysis DSP
// ------------------------------------------------------------------------------
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    for (let i = 0, j = 0; i < n; i++) {
      this.rev[i] = j;
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }
  forward(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = i + k;
          const b = a + half;
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
        }
      }
    }
  }
}

const hann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
const mid = ([L, R]) => Float32Array.from(L, (v, i) => 0.5 * (v + R[i]));
const dbp = (p) => 10 * Math.log10(Math.max(p, 1e-30));
const sec = (t, sr = SR) => Math.round(t * sr);

/** Welch PSD (Hann, 50 % overlap) of x over [t0, t1) seconds → Float64Array(N/2+1). */
function welch(x, sr, t0, t1, N = 8192) {
  const fft = new FFT(N);
  const w = hann(N);
  const P = new Float64Array(N / 2 + 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let cnt = 0;
  for (let s = sec(t0, sr); s + N <= Math.min(x.length, sec(t1, sr)); s += N / 2) {
    for (let i = 0; i < N; i++) {
      re[i] = x[s + i] * w[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k <= N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    cnt++;
  }
  for (let k = 0; k <= N / 2; k++) P[k] /= Math.max(1, cnt);
  return P;
}

/** Summed PSD power in [lo, hi) Hz, dB. */
function bandDb(P, sr, lo, hi) {
  const N = (P.length - 1) * 2;
  let s = 0;
  for (let k = Math.ceil((lo * N) / sr); k < Math.min(P.length, (hi * N) / sr); k++) s += P[k];
  return dbp(s);
}

/** Ratio spectrum a/b in dB, smoothed over ±oct/2 (log-frequency box). */
function ratioDb(Pa, Pb, sr, oct = 1 / 6) {
  const N = (Pa.length - 1) * 2;
  const out = new Float64Array(Pa.length);
  const ca = new Float64Array(Pa.length + 1);
  const cb = new Float64Array(Pa.length + 1);
  for (let k = 0; k < Pa.length; k++) {
    ca[k + 1] = ca[k] + Pa[k];
    cb[k + 1] = cb[k] + Pb[k];
  }
  const h = Math.pow(2, oct / 2);
  for (let k = 1; k < Pa.length; k++) {
    const lo = Math.max(1, Math.floor(k / h));
    const hi = Math.min(Pa.length - 1, Math.ceil(k * h));
    out[k] = dbp(ca[hi + 1] - ca[lo]) - dbp(cb[hi + 1] - cb[lo]);
  }
  out.binHz = sr / N;
  return out;
}

function meanOver(arr, sr, lo, hi) {
  const bin = arr.binHz;
  let s = 0;
  let c = 0;
  for (let k = Math.ceil(lo / bin); k <= Math.floor(hi / bin); k++) {
    s += arr[k];
    c++;
  }
  return s / c;
}

function argmaxOver(arr, lo, hi) {
  const bin = arr.binHz;
  let best = -Infinity;
  let at = 0;
  for (let k = Math.ceil(lo / bin); k <= Math.floor(hi / bin); k++) {
    if (arr[k] > best) {
      best = arr[k];
      at = k * bin;
    }
  }
  return { hz: at, db: best };
}

/** RBJ biquad (normalized). */
function biquad(type, f, sr, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  if (type === 'lowpass') return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
  if (type === 'highpass') return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
  return { b0: al / a0, b1: 0, b2: -al / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 }; // bandpass, 0 dB peak
}

function filt(x, sections) {
  const y = Float64Array.from(x);
  for (const c of sections) {
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const o = c.b0 * v + z1;
      z1 = c.b1 * v - c.a1 * o + z2;
      z2 = c.b2 * v - c.a2 * o;
      y[i] = o;
    }
  }
  return y;
}
const lr4 = (type, f, sr) => [biquad(type, f, sr), biquad(type, f, sr)];

function pearson(a, b, i0 = 0, i1 = a.length) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const n = i1 - i0;
  for (let i = i0; i < i1; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  for (let i = i0; i < i1; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  return sab / Math.sqrt(saa * sbb + 1e-30);
}

function rmsDb(x, i0 = 0, i1 = x.length) {
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return dbp(s / Math.max(1, i1 - i0));
}

function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / x.length;
}

// BS.1770-4 Annex 2 4× polyphase interpolator (RESEARCH §7).
const P0 = [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.0266113281250, 0.014892578125, -0.00830078125];
const P1 = [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.166503906250, 0.4650878906250, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375];
const PHASES = [P0, P1, [...P1].reverse(), [...P0].reverse()];
/** True peak (dBTP) and the number of interpolated points above full scale. */
function truePeak(channels) {
  let peak = 0;
  let overs = 0;
  for (const x of channels) {
    for (let n = 11; n < x.length; n++) {
      const a = Math.abs(x[n]);
      if (a > peak) peak = a;
      for (const p of PHASES) {
        let y = 0;
        for (let k = 0; k < 12; k++) y += p[k] * x[n - k];
        const v = Math.abs(y);
        if (v > peak) peak = v;
        if (v > 1) overs++;
      }
    }
  }
  return { dbtp: 20 * Math.log10(peak), overs };
}

/** STFT power (dB) over [t0, t1) restricted to bins [k0, k1). */
function stftDb(x, sr, t0, t1, k0, k1, N = 2048, hop = 512) {
  const fft = new FFT(N);
  const w = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frames = [];
  for (let s = sec(t0, sr); s + N <= sec(t1, sr); s += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = x[s + i] * w[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    const f = new Float32Array(k1 - k0);
    for (let k = k0; k < k1; k++) f[k - k0] = dbp(re[k] * re[k] + im[k] * im[k]);
    frames.push(f);
  }
  return frames;
}

/**
 * Shimmer statistics at the given partial frequencies: per frame the salience of the
 * partial's bin above its ±1/12-octave neighbourhood (mean dB, ±3 bins excluded).
 */
function partialStats(x, sr, partials, t0, t1) {
  const N = 2048;
  const binHz = sr / N;
  const k0 = Math.floor(6000 / binHz);
  const k1 = Math.ceil(15000 / binHz);
  const frames = stftDb(x, sr, t0, t1, k0, k1, N, 512);
  const out = [];
  for (const p of partials) {
    const k = Math.round(p.freqHz / binHz) - k0;
    const w = Math.max(6, Math.round((p.freqHz / binHz) * 0.0595));
    const sal = new Float64Array(frames.length);
    for (let t = 0; t < frames.length; t++) {
      const f = frames[t];
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, k - w); j <= Math.min(f.length - 1, k + w); j++) {
        if (Math.abs(j - k) <= 3) continue;
        s += f[j];
        c++;
      }
      sal[t] = f[k] - s / c;
    }
    let on = 0;
    let dsum = 0;
    let lsum = 0;
    for (let t = 0; t < sal.length; t++) {
      if (sal[t] > 6) on++;
      if (t) dsum += Math.abs(sal[t] - sal[t - 1]);
      lsum += Math.pow(10, frames[t][k] / 10);
    }
    out.push({ freqHz: p.freqHz, onFrac: on / sal.length, flickerDb: dsum / (sal.length - 1), meanDb: dbp(lsum / sal.length) });
  }
  return out;
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

// ------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------
export const tests = {
  'exports, DEMO_DEFECTS shape and issue ids': async () => {
    assert(typeof generateDemoTrack === 'function', 'generateDemoTrack export');
    assert(DEMO_BPM >= 110 && DEMO_BPM <= 124, 'tempo in 110–124 BPM');
    assert(Object.isFrozen(DEMO_DEFECTS) && Object.isFrozen(DEMO_DEFECTS.shimmer), 'DEMO_DEFECTS deep-frozen');
    for (const id of DEMO_DEFECTS.issues) assert(ISSUE_IDS.includes(id), `unknown issue id ${id}`);
    for (const k of ['shimmer', 'hiss', 'harsh', 'mud', 'wideBass', 'dc', 'sibilance', 'level', 'abruptEnd']) assert(DEMO_DEFECTS[k], `DEMO_DEFECTS.${k}`);
    const d = DEMO_DEFECTS;
    assert(d.shimmer.loHz === 7000 && d.shimmer.hiHz === 14000, 'shimmer band 7–14 kHz');
    assert(d.harsh.freqHz >= 3000 && d.harsh.freqHz <= 3500, 'harsh resonance 3–3.5 kHz');
    assert(d.mud.gainDb >= 3 && d.mud.gainDb <= 4 && Math.abs(d.mud.freqHz - 300) <= 50, 'mud +3–4 dB @ ~300 Hz');
    assert(d.hiss.rmsDbfs === -60 && d.wideBass.belowHz === 120, 'hiss / wide bass constants');
    assert(d.level.targetLufs >= -9 && d.level.targetLufs <= -8, 'too-loud target −9…−8 LUFS');
  },

  'default render: 32 s stereo 48 kHz Float32, finite, below full scale': async () => {
    for (const a of [DEF(), CLEAN()]) {
      assert(a.sampleRate === 48000, 'sampleRate');
      assert(a.channels.length === 2, 'stereo');
      for (const ch of a.channels) {
        assert(ch instanceof Float32Array, 'Float32Array');
        assert(ch.length === 32 * 48000, `length ${ch.length}`);
        let pk = 0;
        for (let i = 0; i < ch.length; i++) pk = Math.max(pk, Math.abs(ch[i]));
        assert(pk <= 0.9985 && pk > 0.5, `sample peak ${pk}`);
      }
      assertFinite(a.channels);
    }
  },

  'deterministic: same seed → bit-identical, both modes': async () => {
    for (const defects of [true, false]) {
      const a = generateDemoTrack({ seconds: 6, defects });
      const b = generateDemoTrack({ seconds: 6, defects });
      for (let c = 0; c < 2; c++) {
        const x = Buffer.from(a.channels[c].buffer);
        const y = Buffer.from(b.channels[c].buffer);
        assert(x.equals(y), `channel ${c} differs (defects=${defects})`);
      }
    }
    // the cached full-length render equals a fresh one
    const fresh = generateDemoTrack({ defects: true });
    assert(Buffer.from(fresh.channels[1].buffer).equals(Buffer.from(DEF().channels[1].buffer)), '32 s render not reproducible');
  },

  'different seed → different audio, same song and level': async () => {
    const a = generateDemoTrack({ seconds: 12, seed: 7 });
    const b = generateDemoTrack({ seconds: 12, seed: 8 });
    let diff = 0;
    for (let i = 0; i < a.channels[0].length; i++) diff = Math.max(diff, Math.abs(a.channels[0][i] - b.channels[0][i]));
    assert(diff > 0.01, `seeds 7/8 nearly identical (max diff ${diff})`);
    const ra = rmsDb(a.channels[0], sec(4), sec(11));
    const rb = rmsDb(b.channels[0], sec(4), sec(11));
    assert(Math.abs(ra - rb) < 0.5, `level differs between seeds: ${ra} vs ${rb}`);
    const pa = demoShimmerPartials({ seed: 7 }).map((p) => p.freqHz).join();
    const pb = demoShimmerPartials({ seed: 8 }).map((p) => p.freqHz).join();
    assert(pa !== pb, 'shimmer partials should depend on the seed');
    return `max |Δ| ${fmt(diff, 3)}, RMS ${fmt(ra)} vs ${fmt(rb)} dBFS`;
  },

  'length and sample rate for other rates and odd durations': async () => {
    for (const [sr, s] of [[44100, 3.3], [96000, 2.05], [22050, 4], [32000, 1.37], [8000, 3], [192000, 0.6]]) {
      for (const defects of [true, false]) {
        const a = generateDemoTrack({ sampleRate: sr, seconds: s, defects, seed: 3 });
        assert(a.sampleRate === sr, 'sampleRate');
        const n = Math.round(s * sr);
        assert(a.channels[0].length === n && a.channels[1].length === n, `${sr} Hz ${s} s → ${a.channels[0].length} (want ${n})`);
        assertFinite(a.channels, `non-finite at ${sr} Hz`);
        for (const ch of a.channels) for (let i = 0; i < ch.length; i++) assert(Math.abs(ch[i]) <= 0.9985, `over full scale at ${sr} Hz`);
      }
    }
  },

  'safe on degenerate inputs (0 s, 1 and 10 samples, 0.3 s) and validates options': async () => {
    const z = generateDemoTrack({ seconds: 0 });
    assert(z.channels.length === 2 && z.channels[0].length === 0, 'zero length');
    for (const n of [1, 10, 100, 1000]) {
      for (const defects of [true, false]) {
        const a = generateDemoTrack({ seconds: n / SR, defects });
        assert(a.channels[0].length === n, `${n} samples`);
        assertFinite(a.channels, `${n} samples`);
      }
    }
    for (const s of [0.3, 0.45, 1.2]) {
      const a = generateDemoTrack({ seconds: s, defects: false });
      assertFinite(a.channels);
      assert(a.channels[0][a.channels[0].length - 1] === 0, 'clean render ends at digital silence');
    }
    let threw = 0;
    for (const bad of [{ sampleRate: 0 }, { sampleRate: NaN }, { sampleRate: 1e6 }, { seconds: -1 }, { seconds: NaN }, { seconds: Infinity }]) {
      try {
        generateDemoTrack(bad);
      } catch (e) {
        if (e instanceof RangeError) threw++;
      }
    }
    assert(threw === 6, `RangeError expected for invalid options (${threw}/6)`);
    const s = generateDemoTrack({ seconds: 0.2, seed: 'not a number' });
    const d = generateDemoTrack({ seconds: 0.2, seed: 7 });
    assert(Buffer.from(s.channels[0].buffer).equals(Buffer.from(d.channels[0].buffer)), 'non-numeric seed falls back to 7');
    const big = generateDemoTrack({ seconds: 2, sampleRate: 48000, seed: 2 ** 40 + 5 });
    assertFinite(big.channels);
  },

  'song structure: intro, verse, chorus, ending (clean) / cut (defects)': async () => {
    const ad = demoArrangement({ defects: true });
    const ac = demoArrangement({ defects: false });
    assert(ad.bpm === DEMO_BPM && Math.abs(ad.barSec - 240 / DEMO_BPM) < 1e-9, 'tempo');
    const names = (a) => a.sections.map((s) => s.name).join(',');
    assert(names(ad) === 'intro,verse,chorus', `defect sections ${names(ad)}`);
    assert(names(ac) === 'intro,verse,chorus,ending', `clean sections ${names(ac)}`);
    assert(ad.endingStartSec === null && ac.endingStartSec > 28 && ac.endingStartSec < 30.5, 'ending start');
    assert(ad.sections.at(-1).endSec === 32, 'arrangement covers the file');
    // intro bar 0 (pad swelling in) is much quieter than the chorus
    const m = mid(CLEAN().channels);
    const intro = rmsDb(m, sec(0.2), sec(1.8));
    const chorus = rmsDb(m, sec(14), sec(26));
    assert(chorus - intro > 10, `intro ${fmt(intro)} vs chorus ${fmt(chorus)} dBFS`);
    // the harmony moves: in every verse/chorus bar the strongest line between 38 and
    // 75 Hz is the bass root of that bar's chord (vi–IV–I–V = A1 F1 C2 G1)
    const ROOT_HZ = { Am: 55, F: 43.65, C: 65.41, G: 49 };
    let ok = 0;
    const body = ac.bars.filter((b) => b.section === 'verse' || b.section === 'chorus');
    for (const b of body) {
      const P = welch(m, SR, b.startSec + 0.05, b.endSec - 0.05, 32768);
      const bin = SR / 32768;
      let best = 0;
      let at = 0;
      for (let k = Math.ceil(38 / bin); k <= 75 / bin; k++) if (P[k] > best) [best, at] = [P[k], k * bin];
      // nearest root (the side-chain pump adds ±2 Hz sidebands, so classify, don't match)
      const nearest = Object.keys(ROOT_HZ).reduce((x, y) => (Math.abs(ROOT_HZ[x] - at) < Math.abs(ROOT_HZ[y] - at) ? x : y));
      if (nearest === b.chord) ok++;
    }
    assert(ok === body.length, `bass root found in ${ok}/${body.length} bars`);
    return `intro ${fmt(intro, 1)} dBFS, chorus ${fmt(chorus, 1)} dBFS; bass roots follow Am–F–C–G in ${ok}/${body.length} bars`;
  },

  'clean mix is tonally plausible (pop/EDM LTAS, stereo, mono-compatible lows)': async () => {
    const a = CLEAN();
    const P = welch(mid(a.channels), SR, ...BODY);
    const rel = (lo, hi) => bandDb(P, SR, lo, hi) - bandDb(P, SR, 890, 1120);
    const b63 = rel(56, 71);
    const b250 = rel(224, 280);
    const b2k = rel(1780, 2240);
    const b8k = rel(7100, 8900);
    const b16k = rel(14100, 17800);
    assert(b63 > 5 && b63 < 18, `63 Hz band ${b63}`);
    assert(b250 > 0 && b250 < 9, `250 Hz band ${b250}`);
    assert(b2k < 0 && b2k > -8, `2 kHz band ${b2k}`);
    assert(b8k < -5 && b8k > -18, `8 kHz band ${b8k}`);
    assert(b16k < b8k + 3 && b16k > -26, `16 kHz band ${b16k}`);
    const r = pearson(a.channels[0], a.channels[1], sec(BODY[0]), sec(BODY[1]));
    assert(r > 0.5 && r < 0.97, `global correlation ${r}`);
    return `rel. 1 kHz: 63 Hz ${fmt(b63, 1)}, 250 Hz ${fmt(b250, 1)}, 2k ${fmt(b2k, 1)}, 8k ${fmt(b8k, 1)}, 16k ${fmt(b16k, 1)} dB; r=${fmt(r)}`;
  },

  'defect: harsh resonance peaks at 3–3.5 kHz (+4…8 dB vs clean)': async () => {
    const rd = ratioDb(welch(mid(DEF().channels), SR, ...BODY), welch(mid(CLEAN().channels), SR, ...BODY), SR, 1 / 6);
    const ref = meanOver(rd, SR, 1000, 2000);
    const pk = argmaxOver(rd, 2000, 6000);
    const rise = pk.db - ref;
    assert(pk.hz >= 3000 && pk.hz <= 3600, `harsh peak at ${pk.hz} Hz`);
    assert(rise > 4 && rise < 8, `harsh peak height ${rise} dB`);
    return `peak ${fmt(pk.hz, 0)} Hz, +${fmt(rise, 1)} dB`;
  },

  'defect: broad mud bump around 300 Hz (+2.5…4.5 dB vs clean)': async () => {
    const rd = ratioDb(welch(mid(DEF().channels), SR, ...BODY), welch(mid(CLEAN().channels), SR, ...BODY), SR, 1 / 3);
    const ref = meanOver(rd, SR, 1000, 2000);
    const bump = meanOver(rd, SR, 260, 340) - ref;
    const pk = argmaxOver(rd, 150, 700);
    assert(bump > 2.5 && bump < 4.5, `mud bump ${bump} dB`);
    assert(pk.hz > 220 && pk.hz < 420, `mud peak at ${pk.hz} Hz`);
    // broad: still > +1.5 dB an octave around it
    const wide = meanOver(rd, SR, 180, 500) - ref;
    assert(wide > 1.5, `mud bump not broad (${wide} dB over 180–500 Hz)`);
    return `+${fmt(bump, 1)} dB @ 300 Hz (peak ${fmt(pk.hz, 0)} Hz)`;
  },

  'defect: flickering narrowband partials 7–14 kHz that follow the music': async () => {
    const parts = demoShimmerPartials({ seed: 7, sampleRate: SR });
    assert(parts.length === DEMO_DEFECTS.shimmer.partials, `partial count ${parts.length}`);
    for (let i = 0; i < parts.length; i++) {
      assert(parts[i].freqHz >= 7000 && parts[i].freqHz <= 14000, 'partial range');
      if (i) assert(parts[i].freqHz - parts[i - 1].freqHz >= DEMO_DEFECTS.shimmer.minSpacingHz, 'partial spacing');
    }
    const sd = partialStats(mid(DEF().channels), SR, parts, ...BODY);
    const sc = partialStats(mid(CLEAN().channels), SR, parts, ...BODY);
    const onD = avg(sd.map((p) => p.onFrac));
    const onC = avg(sc.map((p) => p.onFrac));
    const flick = avg(sd.map((p) => p.flickerDb));
    // level differences normalized by the 4–6 kHz difference (loudness/limiting differ)
    const Pd = welch(mid(DEF().channels), SR, ...BODY);
    const Pc = welch(mid(CLEAN().channels), SR, ...BODY);
    const norm = bandDb(Pd, SR, 4000, 6000) - bandDb(Pc, SR, 4000, 6000);
    const excess = avg(sd.map((p, i) => p.meanDb - sc[i].meanDb)) - norm;
    const bandRise = bandDb(Pd, SR, 7000, 14000) - bandDb(Pc, SR, 7000, 14000) - norm;
    const m = mid(DEF().channels);
    const quiet = avg(partialStats(m, SR, parts, 0.3, 1.8).map((p) => p.meanDb));
    const loud = avg(partialStats(m, SR, parts, 14, 26).map((p) => p.meanDb));
    const summary = `salient ${fmt(onD * 100, 0)} % of frames (clean ${fmt(onC * 100, 0)} %), flicker ${fmt(flick, 1)} dB, partial bins +${fmt(excess, 1)} dB, 7–14 kHz band +${fmt(bandRise, 1)} dB, intro→chorus +${fmt(loud - quiet, 0)} dB`;
    // intermittent: salient (> 6 dB over the 1/6-octave neighbourhood) in a good share of
    // frames but not continuously (a stable tone would be ~100 %)
    assert(onD > 0.25 && onD < 0.85, `defect partial salience share; ${summary}`);
    assert(onC < 0.15 && onD > 3 * onC, `clean salience at the partial bins; ${summary}`);
    assert(flick > 3, `frame-to-frame salience change (want > 3 dB); ${summary}`);
    assert(excess > 4, `partial bins vs clean (want > 4 dB); ${summary}`);
    // audible-but-not-absurd: the whole 7–14 kHz band rises by less than 4 dB
    assert(bandRise > 0.3 && bandRise < 4, `band rise; ${summary}`);
    // follows the music: much weaker under the quiet intro bar than in the chorus
    assert(loud - quiet > 10, `envelope following; ${summary}`);
    return summary;
  },

  'defect: hiss floor ≈ −60 dBFS audible in the intro, uncorrelated L/R': async () => {
    const hp = [biquad('highpass', 4000, SR), biquad('highpass', 4000, SR)];
    const [i0, i1] = [sec(0.05), sec(0.45)];
    const res = [];
    for (const a of [DEF(), CLEAN()]) {
      const l = filt(a.channels[0], hp);
      const r = filt(a.channels[1], hp);
      res.push({ l: rmsDb(l, i0, i1), r: rmsDb(r, i0, i1), corr: pearson(l, r, i0, i1) });
    }
    const [d, c] = res;
    // 2nd-order HP @ 4 kHz again in the test removes ~0.5–1.5 dB of the −60 dBFS hiss
    for (const v of [d.l, d.r]) assert(v > -63.5 && v < -59, `intro hiss ${v} dBFS`);
    assert(Math.abs(d.corr) < 0.15, `hiss correlation ${d.corr}`);
    assert(c.l < -90 && c.r < -90, `clean intro HF ${c.l} dBFS`);
    return `defect ${fmt(d.l, 1)} / ${fmt(d.r, 1)} dBFS (r=${fmt(d.corr)}), clean ${fmt(c.l, 0)} dBFS`;
  },

  'defect: decorrelated low end below 120 Hz, clean mono-compatible': async () => {
    const corrLow = (a) => {
      const l = filt(a.channels[0], lr4('lowpass', 120, SR));
      const r = filt(a.channels[1], lr4('lowpass', 120, SR));
      return pearson(l, r, sec(BODY[0]), sec(BODY[1]));
    };
    const cd = corrLow(DEF());
    const cc = corrLow(CLEAN());
    assert(cc > 0.95, `clean low-band correlation ${cc}`);
    assert(cd < 0.65 && cd > 0.2, `defect low-band correlation ${cd} (want ≈ ${DEMO_DEFECTS.wideBass.expectedCorrelation})`);
    // the rest of the image stays sane (no global phase problem)
    const g = pearson(DEF().channels[0], DEF().channels[1], sec(BODY[0]), sec(BODY[1]));
    assert(g > 0.3, `global correlation ${g}`);
    // mono sum loses low end in the defect version
    const lowMono = (a) => rmsDb(filt(mid(a.channels), lr4('lowpass', 120, SR)), sec(BODY[0]), sec(BODY[1])) - rmsDb(filt(a.channels[0], lr4('lowpass', 120, SR)), sec(BODY[0]), sec(BODY[1]));
    const lossD = lowMono(DEF());
    const lossC = lowMono(CLEAN());
    assert(lossD < -0.7 && lossC > -0.3, `mono low-end loss ${lossD} dB (clean ${lossC} dB)`);
    return `r(<120 Hz) defect ${fmt(cd)}, clean ${fmt(cc, 3)}; mono loss ${fmt(lossD, 1)} dB`;
  },

  'defect: DC offset as specified, clean has none': async () => {
    const [l, r] = DEF().channels.map(mean);
    assert(Math.abs(l - DEMO_DEFECTS.dc.left) < 2e-4 && Math.abs(r - DEMO_DEFECTS.dc.right) < 2e-4, `DC ${l}, ${r}`);
    const [cl, cr] = CLEAN().channels.map(mean);
    assert(Math.abs(cl) < 5e-5 && Math.abs(cr) < 5e-5, `clean DC ${cl}, ${cr}`);
    return `L ${fmt(l, 5)}, R ${fmt(r, 5)}`;
  },

  'defect: sibilant bursts on the vocal (5–9 kHz, ≫ clean, > 4 / min)': async () => {
    const arr = demoArrangement({ defects: true });
    assert(arr.sibilance.length >= 8, `sibilant syllables ${arr.sibilance.length}`);
    const perMin = (arr.sibilance.length / 32) * 60;
    // band 4.5–6.8 kHz: the sibilant's lower half, below every shimmer partial
    const bp = (a) => filt(mid(a.channels), [biquad('highpass', 4500, SR), biquad('highpass', 4500, SR), biquad('lowpass', 6800, SR), biquad('lowpass', 6800, SR)]);
    const bd = bp(DEF());
    const bc = bp(CLEAN());
    // overall gain difference between the versions (loudness stage), from non-sibilant time
    const g = rmsDb(DEF().channels[0], sec(BODY[0]), sec(BODY[1])) - rmsDb(CLEAN().channels[0], sec(BODY[0]), sec(BODY[1]));
    const ex = arr.sibilance.filter((w) => w.startSec > 4).map((w) => rmsDb(bd, sec(w.startSec), sec(w.endSec)) - rmsDb(bc, sec(w.startSec), sec(w.endSec)) - g);
    ex.sort((a, b) => a - b);
    const med = ex[ex.length >> 1];
    // detector view (RESEARCH §2 gate): at the vocal's 's' positions the 5 ms band
    // envelope peaks > 8 dB above its 1 s median, more than 4 times per minute
    const stickOut = (x) => {
      const hop = sec(0.005);
      const env = (t0, t1) => {
        const e = [];
        for (let i = sec(t0); i + hop <= Math.min(x.length, sec(t1)); i += hop) e.push(rmsDb(x, i, i + hop));
        return e;
      };
      return arr.sibilance.filter((w) => w.startSec > 4 && w.endSec < 31.5).map((w) => {
        const local = env(w.startSec - 0.5, w.endSec + 0.5).sort((a, b) => a - b);
        return Math.max(...env(w.startSec, w.endSec)) - local[local.length >> 1];
      });
    };
    const sd = stickOut(bd);
    const sc = stickOut(bc);
    const ed = (sd.filter((v) => v > 8).length / 32) * 60;
    const ec = (sc.filter((v) => v > 8).length / 32) * 60;
    const summary = `${fmt(perMin, 0)} bursts/min, median +${fmt(med, 1)} dB vs clean (design +${DEMO_DEFECTS.sibilance.excessDb}); > 8 dB over the 1 s median: ${fmt(ed, 0)}/min (clean ${fmt(ec, 0)}/min)`;
    assert(med > 6, `sibilant excess; ${summary}`);
    assert(ed > 4 && ed > 2 * ec, `sibilance events; ${summary}`);
    return summary;
  },

  'defect: too loud (−10…−7 LUFS) with inter-sample overs; clean ≈ −14 LUFS, TP < −1 dBTP': async () => {
    const tpD = truePeak(DEF().channels);
    const tpC = truePeak(CLEAN().channels);
    assert(tpD.dbtp > 0 && tpD.overs > 0, `defect true peak ${tpD.dbtp} dBTP (${tpD.overs} overs)`);
    assert(tpD.dbtp < 2, `defect true peak absurd: ${tpD.dbtp}`);
    assert(tpC.dbtp < -1, `clean true peak ${tpC.dbtp}`);
    let extra = '';
    if (hasFfmpeg()) {
      const pd = writeWavFloat(join(TMP, 'demo-test-defects.wav'), DEF().channels, SR);
      const pc = writeWavFloat(join(TMP, 'demo-test-clean.wav'), CLEAN().channels, SR);
      const ld = ffmpegLoudness(pd);
      const lc = ffmpegLoudness(pc);
      assert(ld.integrated >= -10 && ld.integrated <= -7, `defect loudness ${ld.integrated} LUFS`);
      assert(ld.integrated >= -9.1 && ld.integrated <= -7.9, `defect loudness ${ld.integrated} LUFS (design −9…−8)`);
      assert(ld.truePeakDb > 0, `ffmpeg true peak ${ld.truePeakDb} dBTP`);
      assert(Math.abs(lc.integrated + 14) <= 0.5, `clean loudness ${lc.integrated} LUFS`);
      assert(lc.truePeakDb <= -1, `clean ffmpeg true peak ${lc.truePeakDb}`);
      extra = `; ffmpeg: ${ld.integrated} LUFS / ${ld.truePeakDb} dBTP, clean ${lc.integrated} LUFS / ${lc.truePeakDb} dBTP`;
    }
    return `true peak +${fmt(tpD.dbtp)} dBTP, ${tpD.overs} interpolated overs; clean ${fmt(tpC.dbtp)} dBTP${extra}`;
  },

  'no hard clipping: no run of 3+ samples at |x| >= 0.999': async () => {
    for (const a of [DEF(), CLEAN()]) {
      for (const ch of a.channels) {
        let run = 0;
        for (let i = 0; i < ch.length; i++) {
          run = Math.abs(ch[i]) >= 0.999 ? run + 1 : 0;
          assert(run < 3, `clipped run at ${i}`);
        }
      }
    }
  },

  'defect: abrupt ending; clean: song-like ending fading to silence': async () => {
    const tail = (a) => {
      const m = mid(a.channels);
      const n = m.length;
      return { last: rmsDb(m, n - sec(0.2), n), before: rmsDb(m, n - sec(3.2), n - sec(0.2)), end: Math.max(Math.abs(a.channels[0][n - 1]), Math.abs(a.channels[1][n - 1])) };
    };
    const d = tail(DEF());
    const c = tail(CLEAN());
    // RESEARCH §2 detector: last 200 ms within 6 dB of the 3 s before and louder than −30 dBFS
    assert(d.last > -30 && d.before - d.last < 6, `defect tail ${d.last} vs ${d.before} dBFS`);
    assert(d.end > 1e-3, 'defect should stop mid-signal');
    const fin = rmsDb(mid(CLEAN().channels), sec(31.95), sec(32));
    assert(c.last < -35 && c.before - c.last > 15 && fin < -50 && c.end === 0, `clean tail ${c.last} dBFS (3 s before ${c.before}), last 50 ms ${fin} dBFS, last sample ${c.end}`);
    // the clean ending is a final chord that rings out, not just a fade of the groove
    const arr = demoArrangement({ defects: false });
    const m = mid(CLEAN().channels);
    const hit = rmsDb(m, sec(arr.endingStartSec), sec(arr.endingStartSec + 0.8));
    assert(hit > -30, `final chord level ${hit}`);
    return `defect last 200 ms ${fmt(d.last, 1)} dBFS (3 s before ${fmt(d.before, 1)}); clean last 200 ms ${fmt(c.last, 0)} dBFS, last 50 ms ${fmt(fin, 0)} dBFS`;
  },

  'speed: 32 s @ 48 kHz under 400 ms (warm), cold run reported': async () => {
    const times = { true: [], false: [] };
    for (let r = 0; r < 4; r++) {
      for (const defects of [true, false]) {
        const t0 = performance.now();
        generateDemoTrack({ defects, seed: 11 + r });
        times[defects].push(performance.now() - t0);
      }
    }
    const best = (a) => Math.min(...a.slice(1));
    const med = (a) => [...a.slice(1)].sort((x, y) => x - y)[1];
    assert(best(times.true) < 400, `defects render ${best(times.true)} ms`);
    assert(best(times.false) < 400, `clean render ${best(times.false)} ms`);
    // cold: a fresh process (JIT warm-up included); informative, loose bound
    const src = new URL('../src/demo/demo-track.js', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { generateDemoTrack } from ${JSON.stringify(src)}; const t = performance.now(); generateDemoTrack(); console.log(performance.now() - t);`], { encoding: 'utf8' });
    const cold = parseFloat(r.stdout);
    assert(Number.isFinite(cold) && cold < 3000, `cold render ${cold} ms`);
    return `warm defects ${fmt(best(times.true), 0)} ms (median ${fmt(med(times.true), 0)}), clean ${fmt(best(times.false), 0)} ms; cold (fresh process) ${fmt(cold, 0)} ms; node ${process.version} ${process.arch}`;
  },

  'speed: 3:30 stereo 48 kHz within the scaled budget (400 ms per 32 s)': async () => {
    generateDemoTrack({ seconds: 20 }); // warm
    const t0 = performance.now();
    const a = generateDemoTrack({ seconds: 210 });
    const ms = performance.now() - t0;
    assert(a.channels[0].length === 210 * SR, 'length');
    const budget = (400 * 210) / 32;
    assert(ms < budget, `3:30 render ${ms} ms (budget ${budget})`);
    // the long render is musically consistent: still loud and still cut at the end
    const m = a.channels[0];
    const lastSec = rmsDb(m, m.length - SR, m.length);
    assert(lastSec > -25, `long render tail ${lastSec}`);
    return `${fmt(ms, 0)} ms (budget ${fmt(budget, 0)} ms)`;
  },

  'makeFixtures(): every fixture exists, is decodable by ffmpeg and matches the manifest': async () => {
    if (!hasFfmpeg()) return 'skip';
    const t0 = performance.now();
    const m = await makeFixtures();
    const firstMs = performance.now() - t0;
    const ids = Object.keys(m.fixtures);
    const want = ['demo-defects', 'demo-clean', 'pink-noise', 'sine-sweep', 'demo-wav16-44k', 'demo-wav24-48k', 'demo-mp3-320', 'demo-mp3-v0', 'demo-aac-256', 'demo-flac24', 'demo-vorbis', 'demo-opus'];
    for (const id of want) assert(ids.includes(id) || m.skipped.some((s) => s.id === id && !/^ffmpeg failed/.test(s.reason)), `fixture ${id} missing`);
    for (const f of Object.values(m.fixtures)) {
      assert(existsSync(f.path) && statSync(f.path).size > 1000, `${f.id}: file missing`);
      assert(typeof f.codec === 'string' && f.sampleRate > 0 && f.channels === 2, `${f.id}: manifest fields`);
      const [L, R] = ffmpegDecode(f.path);
      const dur = L.length / (f.codec === 'opus' ? 48000 : f.sampleRate);
      assert(Math.abs(dur - f.durationSec) < 0.1 && Math.abs(dur - (f.source === 'demo-defects' || f.source === 'demo-clean' ? 32 : 10)) < 0.1, `${f.id}: decoded ${dur} s`);
      let e = 0;
      for (let i = 0; i < L.length; i += 7) e += L[i] * L[i] + R[i] * R[i];
      assert(e > 0, `${f.id}: decodes to silence`);
      assertFinite([L.subarray(0, 48000), R.subarray(0, 48000)], f.id);
    }
    const expect = { 'demo-wav16-44k': ['pcm_s16le', 44100, 16], 'demo-wav24-48k': ['pcm_s24le', 48000, 24], 'demo-mp3-320': ['mp3', 48000], 'demo-mp3-v0': ['mp3', 44100], 'demo-aac-256': ['aac', 48000], 'demo-flac24': ['flac', 48000, 24], 'demo-vorbis': ['vorbis', 48000], 'demo-opus': ['opus', 48000], 'demo-alac': ['alac', 48000, 24] };
    for (const [id, [codec, rate, bits]] of Object.entries(expect)) {
      const f = m.fixtures[id];
      if (!f) continue;
      assert(f.codec === codec && f.sampleRate === rate, `${id}: ${f.codec} ${f.sampleRate} (want ${codec} ${rate})`);
      if (bits) assert(f.bitDepth === bits, `${id}: bit depth ${f.bitDepth}`);
    }
    assert(m.fixtures['demo-mp3-320'].bitrateKbps === 320, 'mp3 CBR 320');
    // the float WAV source round-trips bit-exactly through ffmpeg
    const [L] = ffmpegDecode(m.fixtures['demo-defects'].path);
    const src = DEF().channels[0];
    for (let i = 0; i < src.length; i += 997) assert(L[i] === src[i], `demo-defects.wav differs at ${i}`);
    // idempotent: second call reuses everything
    const mt = statSync(m.fixtures['demo-mp3-320'].path).mtimeMs;
    const t1 = performance.now();
    const m2 = await makeFixtures();
    const againMs = performance.now() - t1;
    assert(JSON.stringify(m2) === JSON.stringify(m), 'manifest changed on second call');
    // ...and so does a separate process running the CLI
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/make-fixtures.mjs', import.meta.url))], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert(cli.status === 0, `CLI failed: ${cli.stderr}`);
    const m3 = JSON.parse(cli.stdout);
    assert(m3.stamp === m.stamp && Object.keys(m3.fixtures).length === ids.length, 'CLI manifest differs');
    assert(statSync(m.fixtures['demo-mp3-320'].path).mtimeMs === mt, 'fixture rewritten on a repeated run');
    return `${ids.length} fixtures (${m.skipped.length} skipped) in ${fmt(firstMs / 1000, 1)} s; repeat call ${fmt(againMs, 0)} ms`;
  },
};
