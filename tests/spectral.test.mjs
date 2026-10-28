// Tests for src/dsp/spectral.js: STFT framework (exact reconstruction, zero latency,
// exact length), de-shimmer (flickering narrowband HF artifacts) and spectral denoise.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assert, approx, assertFinite, rng, sine, whiteNoise, pinkNoise, impulse, peak, db, maxDiff,
  TMP, writeWavFloat, hasFfmpeg, ffmpegLoudness,
  speedFactor,
  ROSETTA,
} from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { spectralCleanup, stftProcess } from '../src/dsp/spectral.js';
import { design, butterworth, processInPlace } from '../src/dsp/biquad.js';
import { RealFFT, hann } from '../src/dsp/fft.js';
import { analyzeTrack, INDEX_GATES } from '../src/analysis/analyze.js';

const SR = 48000;
const here = fileURLToPath(new URL('.', import.meta.url));
const DEMO_PATH = join(here, '../src/demo/demo-track.js');

// ------------------------------------------------------------------ signal helpers

function hpNoise(n, f, seed, sr = SR, sections = 2) {
  const r = rng(seed);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 2 * r() - 1;
  const secs = [];
  for (let s = 0; s < sections; s++) secs.push(design('highpass', f, sr));
  processInPlace(y, secs);
  return y;
}

const ART_FREQS = [7150, 7900, 8800, 9650, 10900, 11800, 12700, 13600];
const STABLE_FREQS = [6200, 10300];

/**
 * Flickering narrowband partials (neural-codec "shimmer" model, cf. demo-track.js): every
 * 21.3 ms "codec frame" each partial is redrawn on/off (p = 0.5) with a random level
 * (0.35–1) and ±4 Hz jitter, 5 ms crossfades, random pan.
 */
function addArtifacts(L, R, sr, ampDb, seed, freqs = ART_FREQS) {
  const n = L.length;
  const r = rng(seed);
  const F = Math.round(0.021333 * sr);
  const xf = Math.round(0.005 * sr);
  const amp = Math.pow(10, ampDb / 20);
  for (const f of freqs) {
    const pan = -0.8 + 1.6 * r();
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    let ph = 2 * Math.PI * r(), gPrev = 0;
    for (let f0 = 0; f0 < n; f0 += F) {
      const on = r() < 0.5;
      const lvl = 0.35 + 0.65 * r();
      const gNext = on ? amp * lvl : 0;
      const w = (2 * Math.PI * (f + (2 * r() - 1) * 4)) / sr;
      const e = Math.min(n, f0 + F);
      for (let i = f0; i < e; i++) {
        const k = i - f0;
        const g = k < xf ? gPrev + (gNext - gPrev) * (k / xf) : gNext;
        ph += w;
        const v = g * Math.sin(ph);
        L[i] += gl * v;
        R[i] += gr * v;
      }
      gPrev = gNext;
    }
  }
}

/**
 * Synthetic "song": partially correlated HF noise ("cymbals", HP 3 kHz, −30 dBFS, slow
 * modulation) + harmonic tones below 4.5 kHz + two stable HF partials + optional injected
 * flickering partials 7–14 kHz + optional transients (clicks, hat bursts).
 */
function makeMusic({ seconds = 8, sr = SR, artifacts = true, artDb = -30, transients = true, stable = true, seed = 11 } = {}) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const n1 = hpNoise(n, 3000, seed, sr), n2 = hpNoise(n, 3000, seed + 1, sr);
  let s = 0;
  for (let i = 0; i < n; i++) s += n1[i] * n1[i];
  const g = Math.pow(10, -30 / 20) / Math.sqrt(s / n);
  for (let i = 0; i < n; i++) {
    const m = 0.75 + 0.25 * Math.sin((2 * Math.PI * 0.4 * i) / sr);
    L[i] += g * m * (0.8 * n1[i] + 0.6 * n2[i]);
    R[i] += g * m * (0.8 * n1[i] - 0.6 * n2[i]);
  }
  for (const [f0, a0, pan] of [[220, 0.12, -0.3], [329.63, 0.08, 0.4], [110, 0.15, 0]]) {
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let h = 1; f0 * h < 4500; h++) {
      const a = a0 / h, w = (2 * Math.PI * f0 * h) / sr, ph = h * 0.7;
      for (let i = 0; i < n; i++) {
        const v = a * Math.sin(w * i + ph);
        L[i] += gl * v;
        R[i] += gr * v;
      }
    }
  }
  if (stable) {
    for (const f of STABLE_FREQS) {
      const a = Math.pow(10, -34 / 20), w = (2 * Math.PI * f) / sr;
      for (let i = 0; i < n; i++) {
        const v = a * Math.sin(w * i);
        L[i] += v;
        R[i] += v;
      }
    }
  }
  if (artifacts) addArtifacts(L, R, sr, artDb, seed + 7);
  const events = [];
  if (transients) {
    for (let t = 0.5; t < seconds - 0.3; t += 0.75) {
      const i0 = Math.round(t * sr);
      if (events.length % 2 === 0) {
        L[i0] += 0.6;
        R[i0] += 0.6;
        events.push({ i: i0, type: 'click' });
      } else {
        const len = Math.round(0.04 * sr);
        const b = hpNoise(len + 64, 7000, seed + 100 + events.length, sr);
        for (let j = 0; j < len; j++) {
          const e = 0.5 * Math.exp(-j / (0.008 * sr));
          L[i0 + j] += e * b[j + 64];
          R[i0 + j] += 0.9 * e * b[j + 64];
        }
        events.push({ i: i0, type: 'hat' });
      }
    }
  }
  return { channels: [L, R], events };
}

/** Welch PSD (Hann, 50 % overlap), power summed over channels. Bin width sr/nfft. */
function psd(channels, nfft = 8192, start = 0, end = channels[0].length) {
  const f = new RealFFT(nfft), w = hann(nfft);
  const fr = new Float64Array(nfft), re = new Float64Array(nfft / 2 + 1), im = new Float64Array(nfft / 2 + 1);
  const out = new Float64Array(nfft / 2 + 1);
  let cnt = 0;
  for (let s = start; s + nfft <= end; s += nfft / 2) {
    for (const x of channels) {
      for (let i = 0; i < nfft; i++) fr[i] = x[s + i] * w[i];
      f.forward(fr, re, im);
      for (let k = 0; k <= nfft / 2; k++) out[k] += re[k] * re[k] + im[k] * im[k];
    }
    cnt++;
  }
  for (let k = 0; k < out.length; k++) out[k] /= Math.max(1, cnt);
  return out;
}

function bandPow(p, f0, f1, sr = SR, nfft = 8192) {
  const df = sr / nfft;
  let s = 0;
  for (let k = Math.max(0, Math.ceil(f0 / df)); k <= Math.min(p.length - 1, Math.floor(f1 / df)); k++) s += p[k];
  return s;
}

const ratioDb = (a, b) => 10 * Math.log10(Math.max(a, 1e-300) / Math.max(b, 1e-300));
const clone = (chs) => chs.map((c) => Float32Array.from(c));

function correlation([L, R]) {
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < L.length; i++) {
    lr += L[i] * R[i];
    ll += L[i] * L[i];
    rr += R[i] * R[i];
  }
  return lr / Math.sqrt(ll * rr + 1e-30);
}

/** Artifact drop (conservative): Σ(P_in − P_bg) over the partial bands vs Σ P_out. */
function artifactDropDb(input, output, background, freqs, sr = SR, half = 18) {
  const Pin = psd(input), Pout = psd(output), Pbg = psd(background);
  let ain = 0, aout = 0;
  const per = [];
  for (const f of freqs) {
    const i = bandPow(Pin, f - half, f + half, sr) - bandPow(Pbg, f - half, f + half, sr);
    const o = bandPow(Pout, f - half, f + half, sr);
    ain += i;
    aout += o;
    per.push(ratioDb(o, i));
  }
  return { total: ratioDb(aout, ain), per };
}

const DS = (amount = 0.6, extra = {}) => ({ deShimmer: { enabled: true, amount, startHz: 5000, fullHz: 9000, ...extra } });
const DN = (amount = 0.5, extra = {}) => ({ denoise: { enabled: true, amount, fromHz: 6000, ...extra } });

/** Music segments with stationary uncorrelated hiss (HP 4 kHz) everywhere, silence between. */
function makeHissy({ hissDb = -60, seed = 77 } = {}) {
  const seg = [['m', 3], ['s', 2], ['m', 3], ['s', 2], ['m', 2]];
  const total = seg.reduce((a, s) => a + s[1], 0);
  const n = total * SR;
  const music = makeMusic({ seconds: total, artifacts: false });
  const L = new Float32Array(n), R = new Float32Array(n);
  let pos = 0;
  for (const [t, d] of seg) {
    const e = pos + d * SR;
    if (t === 'm') {
      for (let i = pos; i < e; i++) {
        L[i] = music.channels[0][i];
        R[i] = music.channels[1][i];
      }
    }
    pos = e;
  }
  const h1 = hpNoise(n, 4000, seed), h2 = hpNoise(n, 4000, seed + 1);
  let s = 0;
  for (let i = 0; i < n; i++) s += h1[i] * h1[i];
  const g = Math.pow(10, hissDb / 20) / Math.sqrt(s / n);
  for (let i = 0; i < n; i++) {
    L[i] += g * h1[i];
    R[i] += g * h2[i];
  }
  const sec = (a, b) => [Math.round(a * SR), Math.round(b * SR)];
  return {
    channels: [L, R],
    silent: [sec(3.3, 4.7), sec(8.3, 9.7)],
    music: [sec(0.3, 2.7), sec(5.3, 7.7), sec(10.3, 11.7)],
  };
}

function segPow(chs, segs, f0, f1) {
  let p = 0;
  for (const [a, b] of segs) p += bandPow(psd(chs, 8192, a, b), f0, f1);
  return p;
}

// ---- musical amplitude modulation: gates, stabs, tremolo, supersaws

/** Level of one exact frequency (single-bin DFT over [1 s, end − 1 s]). */
function toneLevel(x, f, sr = SR) {
  const w = (2 * Math.PI * f) / sr;
  let s = 0, c = 0;
  for (let i = sr; i < x.length - sr; i++) {
    s += x[i] * Math.sin(w * i);
    c += x[i] * Math.cos(w * i);
  }
  return Math.hypot(s, c);
}

/** Rhythmic gate gain (period, 50 % duty, linear edges) at time t. */
function gateAt(t, periodMs, edgeMs) {
  const ms = (t * 1000) % periodMs, on = periodMs / 2;
  return ms < on ? Math.min(1, ms / edgeMs, (on - ms) / edgeMs) : 0;
}

/**
 * Trance-gate test track: a 16-harmonic synth (1/h) gated at
 * `periodMs` over brown-ish noise, a 55 Hz kick on the beat (128 BPM) and a −54 dBFS floor.
 * `pluck`: exponentially decaying stab (60 ms) on every beat instead of a square gate.
 */
function gatedTrack({ periodMs = 117.2, edgeMs = 5, f0 = 880, seconds = 8, pluck = false } = {}) {
  const n = Math.round(seconds * SR);
  const r = rng(4);
  const L = new Float32Array(n), R = new Float32Array(n);
  let b = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, tb = t % 0.46875;
    const g = pluck ? Math.min(1, tb / 0.002) * Math.exp(-tb / 0.06) : gateAt(t, periodMs, edgeMs);
    let s = 0;
    for (let h = 1; h <= 16; h++) s += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
    b = 0.95 * b + 0.05 * (2 * r() - 1);
    b2 = 0.95 * b2 + 0.05 * (2 * r() - 1);
    const kick = 0.4 * Math.exp(-tb * 25) * Math.sin(2 * Math.PI * 55 * tb);
    L[i] = 0.25 * g * s + 0.3 * b + kick + 0.002 * (2 * r() - 1);
    R[i] = 0.25 * g * s + 0.3 * b2 + kick + 0.002 * (2 * r() - 1);
  }
  const hs = [];
  for (let h = 1; h <= 16; h++) if (f0 * h >= 5000) hs.push(f0 * h);
  return { channels: [L, R], freqs: hs };
}

/** Harmonic tone (330 Hz, 1/h up to 16 kHz) with a sinusoidal tremolo of `depthDb`. */
function tremoloTrack({ rate, depthDb, seconds = 6 }) {
  const n = Math.round(seconds * SR);
  const L = whiteNoise(seconds, SR, 0.003, 5), R = whiteNoise(seconds, SR, 0.003, 6);
  const am = new Float64Array(n);
  for (let i = 0; i < n; i++) am[i] = Math.pow(10, (-depthDb / 20) * (0.5 + 0.5 * Math.sin((2 * Math.PI * rate * i) / SR)));
  const hs = [];
  for (let h = 1; 330 * h < 16000; h++) {
    if (330 * h >= 5000) hs.push(330 * h);
    const a = 0.2 / h, w = (2 * Math.PI * 330 * h) / SR;
    for (let i = 0; i < n; i++) {
      const v = a * am[i] * Math.sin(w * i + h);
      L[i] += v;
      R[i] += v;
    }
  }
  return { channels: [L, R], freqs: hs };
}

/** Gated supersaw (7 voices over ±25 cents, 18 harmonics) over pink noise + 1/8 hats. */
function gatedSupersaw({ periodMs = 117.2, seconds = 8 } = {}) {
  const n = Math.round(seconds * SR), f0 = 880, voices = 7, detuneC = 50;
  const pL = pinkNoise(seconds, SR, 0.1, 3), pR = pinkNoise(seconds, SR, 0.1, 4);
  const r = rng(9);
  const L = new Float32Array(n), R = new Float32Array(n);
  const ph = [];
  for (let v = 0; v < voices; v++) ph.push(r() * 2 * Math.PI);
  const fv = [];
  for (let v = 0; v < voices; v++) fv.push(f0 * Math.pow(2, (detuneC * (v / (voices - 1) - 0.5)) / 1200));
  for (let i = 0; i < n; i++) {
    const t = i / SR, g = gateAt(t, periodMs, 5);
    let s = 0;
    for (let v = 0; v < voices; v++) {
      for (let h = 1; h <= 18; h++) if (fv[v] * h < 17000) s += Math.sin(2 * Math.PI * fv[v] * h * t + h + ph[v]) / h;
    }
    s /= Math.sqrt(voices);
    const hat = 0.15 * Math.exp(-(t % 0.234375) / 0.03) * (2 * r() - 1);
    L[i] = 0.25 * g * s + pL[i] + hat;
    R[i] = 0.25 * g * s + pR[i] + 0.9 * hat;
  }
  const hs = [];
  for (let h = 6; h <= 18; h++) if (f0 * h < 17000) hs.push(f0 * h);
  return { channels: [L, R], freqs: hs };
}

/** Drums (kick, snare on 2/4, 1/16 hats) + a steady pad: a rhythmic bed that moves 1–5 kHz. */
function drumsAndPad(seconds = 8) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const hat = hpNoise(n, 7000, 21), sn = hpNoise(n, 200, 22, SR, 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR, tk = t % 0.46875, ts = (t + 0.46875) % 0.9375, th = t % 0.1171875;
    const v = 0.5 * Math.exp(-tk * 25) * Math.sin(2 * Math.PI * 55 * tk);
    const s = 0.25 * Math.exp(-ts / 0.08) * sn[i], hh = 0.12 * Math.exp(-th / 0.02) * hat[i];
    L[i] = v + s + hh;
    R[i] = v + 0.9 * s + 0.8 * hh;
  }
  for (const f0 of [261.6, 329.6, 392, 523.3]) {
    for (let h = 1; h * f0 < 5000; h++) {
      const w = (2 * Math.PI * f0 * h) / SR, a = 0.06 / h;
      for (let i = 0; i < n; i++) {
        const v = a * Math.sin(w * i + h);
        L[i] += v;
        R[i] += 0.9 * v;
      }
    }
  }
  return [L, R];
}

/** Worst per-partial level change (dB) of `freqs` after de-shimmer at `amount`. */
function worstPartialDb(src, freqs, amount = 0.6) {
  const y = clone(src);
  const st = spectralCleanup(y, SR, DS(amount));
  let worst = 0;
  for (const f of freqs) {
    const ch = db(toneLevel(y[0], f) / toneLevel(src[0], f));
    if (Math.abs(ch) > Math.abs(worst)) worst = ch;
  }
  return { worst, st };
}


// ------------------------------------------------------------------ tests

export const tests = {
  'exports and stats shape': async () => {
    assert(typeof spectralCleanup === 'function' && spectralCleanup.length >= 2, 'spectralCleanup');
    assert(typeof stftProcess === 'function', 'stftProcess');
    const x = clone(makeMusic({ seconds: 1, transients: false }).channels);
    const st = spectralCleanup(x, SR, { ...DS(0.5), ...DN(0.5) });
    for (const k of ['avgReductionDb', 'maxReductionDb']) {
      assert(Number.isFinite(st[k]) && st[k] <= 0, `${k} finite and <= 0: ${st[k]}`);
    }
    assert(st.maxReductionDb <= st.avgReductionDb + 1e-9, 'max is the deepest');
    assert(st.deShimmer && Number.isFinite(st.deShimmer.avgReductionDb), 'deShimmer sub-stats');
    assert(st.denoise && 'noiseFloorDb' in st.denoise, 'denoise sub-stats');
  },

  'identity: disabled / amount 0 / missing opts leave the input bit-exact': async () => {
    const src = makeMusic({ seconds: 2 }).channels;
    const cases = [
      {},
      undefined,
      null,
      { deShimmer: { enabled: false, amount: 1 }, denoise: { enabled: false, amount: 1 } },
      { deShimmer: { enabled: true, amount: 0 }, denoise: { enabled: true, amount: 0 } },
      { deShimmer: { enabled: true, amount: NaN }, denoise: { enabled: true, amount: -3 } },
    ];
    for (const opts of cases) {
      const x = clone(src);
      const refs = [x[0], x[1]];
      const st = spectralCleanup(x, SR, opts);
      assert(x[0] === refs[0] && x[1] === refs[1], 'same arrays (in place)');
      assert(maxDiff(x[0], src[0]) === 0 && maxDiff(x[1], src[1]) === 0, `bit-exact for ${JSON.stringify(opts)}`);
      assert(st.avgReductionDb === 0 && st.maxReductionDb === 0, 'zero stats');
    }
  },

  'identity: enabled but nothing to do → output === input (≤ 1e-6)': async () => {
    // de-shimmer on content below startHz only (tones + low-passed noise)
    const n = 3 * SR;
    const lp = [pinkNoise(3, SR, 0.2, 3), pinkNoise(3, SR, 0.2, 4)];
    for (const c of lp) processInPlace(c, butterworth('lowpass', 8, 3000, SR));
    const a = sine(440, 3, SR, 0.3), b = sine(1234, 3, SR, 0.2);
    const src = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      src[0][i] = lp[0][i] + a[i];
      src[1][i] = lp[1][i] + b[i];
    }
    const x = clone(src);
    spectralCleanup(x, SR, DS(1));
    approx(maxDiff(x[0], src[0]), 0, 1e-6, 'L');
    approx(maxDiff(x[1], src[1]), 0, 1e-6, 'R');
    // denoise on digital silence and on a stable tone without any noise floor
    const z = [new Float32Array(SR), new Float32Array(SR)];
    const st = spectralCleanup(z, SR, { ...DS(1), ...DN(1) });
    assert(peak(z[0]) === 0 && peak(z[1]) === 0, 'silence stays silent');
    assert(st.denoise.noiseFloorDb === null, 'no noise floor in digital silence');
  },

  'reconstruction: constant gain via stftProcess is exact, any length / channel count / rate': async () => {
    for (const sr of [44100, 48000, 96000]) {
      for (const len of [1, 10, 511, 2047, 2048, 2049, 5000, 4096 * 3 + 7]) {
        for (const nCh of [1, 2, 3]) {
          const src = [];
          for (let c = 0; c < nCh; c++) src.push(whiteNoise(len / sr, sr, 0.5, 10 * c + len + 1).subarray(0, len));
          if (src[0].length !== len) continue;
          const x = clone(src);
          stftProcess(x, sr, (P, G) => {
            G.fill(0.25);
            return 0;
          });
          for (let c = 0; c < nCh; c++) {
            assert(x[c].length === len, 'exact length');
            approx(maxDiff(x[c], src[c].map((v) => 0.25 * v)), 0, 1e-6, `sr ${sr} len ${len} ch ${c}/${nCh}`);
          }
        }
      }
    }
  },

  'reconstruction: zero latency, zero phase (impulse through a band gain)': async () => {
    const n = 16384, i0 = 8000;
    for (const sr of [48000, 96000]) {
      const x = [impulse(n, i0, 1), impulse(n, i0, 0.5)];
      const kCut = Math.round((7000 / sr) * (sr <= 50000 ? 2048 : 4096));
      stftProcess(x, sr, (P, G) => {
        for (let k = kCut; k < G.length; k++) G[k] = 0.3;
        return kCut;
      });
      for (const [c, a] of [[0, 1], [1, 0.5]]) {
        let pi = 0, pv = 0;
        for (let i = 0; i < n; i++) if (Math.abs(x[c][i]) > pv) { pv = Math.abs(x[c][i]); pi = i; }
        assert(pi === i0, `peak stays at ${i0} (got ${pi}) sr ${sr}`);
        // real gains = zero phase: symmetric around the impulse up to the STFT's small
        // frame-position dependence (time aliasing of the 4 overlapping frames)
        let asym = 0;
        for (let d = 1; d < 3000; d++) asym = Math.max(asym, Math.abs(x[c][i0 + d] - x[c][i0 - d]));
        assert(asym < 1e-4 * a, `symmetric response (asym ${asym})`);
        // DC gain (sum) is 1: the band below 7 kHz is untouched
        let sum = 0;
        for (let i = 0; i < n; i++) sum += x[c][i];
        approx(sum, a, 1e-5 * a, 'sum (DC gain)');
      }
    }
  },

  'reconstruction: content outside the processed band passes bit-exactly': async () => {
    const src = makeMusic({ seconds: 3 }).channels;
    const x = clone(src);
    stftProcess(x, SR, (P, G) => {
      for (let k = 600; k < G.length; k++) G[k] = 0;
      return 600;
    });
    // the difference signal contains only content ≥ ~14 kHz
    const d = x.map((c, j) => c.map((v, i) => v - src[j][i]));
    const Pd = psd(d), Px = psd(src);
    const lowDiff = ratioDb(bandPow(Pd, 20, 12000), bandPow(Px, 20, 12000));
    assert(lowDiff < -100, `difference below 12 kHz is ${lowDiff.toFixed(1)} dB re input`);
    const hi = ratioDb(bandPow(psd(x), 14500, 20000), bandPow(Px, 14500, 20000));
    assert(hi < -60, `band above 14.5 kHz removed (${hi.toFixed(1)} dB)`);
  },

  'stftProcess: non-finite frames are left untouched (no NaN spreading)': async () => {
    const src = makeMusic({ seconds: 1, transients: false }).channels;
    const x = clone(src);
    x[0][10000] = NaN;
    stftProcess(x, SR, (P, G) => {
      G.fill(0.5);
      return 0;
    });
    let nan = 0;
    for (let i = 0; i < x[0].length; i++) if (!Number.isFinite(x[0][i])) nan++;
    assert(nan === 1, `only the original NaN remains (${nan})`);
    assert(Number.isFinite(x[1][10000]), 'other channel untouched by the NaN');
    approx(x[1][5000], 0.5 * src[1][5000], 1e-6, 'healthy frames processed');
    approx(x[1][10000], src[1][10000], 1e-6, 'frames with NaN skipped');
  },

  'de-shimmer: injected flickering partials drop >= 6 dB at amount 0.6; rest untouched': async () => {
    const withA = makeMusic({ artifacts: true });
    const bg = makeMusic({ artifacts: false });
    const x = clone(withA.channels);
    const st = spectralCleanup(x, SR, DS(0.6));
    assertFinite(x);
    const drop = artifactDropDb(withA.channels, x, bg.channels, ART_FREQS);
    assert(drop.total <= -6, `artifact drop ${drop.total.toFixed(2)} dB (per partial ${drop.per.map((v) => v.toFixed(1)).join(' ')})`);
    // broadband HF (5–20 kHz, artifact bands excluded) and content below startHz
    const Pin = psd(withA.channels), Pout = psd(x);
    const df = SR / 8192;
    let hin = 0, hout = 0;
    for (let k = Math.ceil(5000 / df); k <= 20000 / df; k++) {
      if (ART_FREQS.some((f) => Math.abs(k * df - f) < 60)) continue;
      hin += Pin[k];
      hout += Pout[k];
    }
    const hf = ratioDb(hout, hin);
    assert(Math.abs(hf) < 1.5, `broadband HF change ${hf.toFixed(3)} dB`);
    const lf = ratioDb(bandPow(Pout, 20, 4800), bandPow(Pin, 20, 4800));
    assert(Math.abs(lf) < 0.2, `below startHz change ${lf.toFixed(4)} dB`);
    // stable HF partials are kept
    for (const f of STABLE_FREQS) {
      const ch = ratioDb(bandPow(Pout, f - 18, f + 18), bandPow(Pin, f - 18, f + 18));
      assert(Math.abs(ch) < 0.2, `stable partial ${f} Hz changed ${ch.toFixed(2)} dB`);
    }
    assert(st.deShimmer.avgReductionDb < -0.1 && st.maxReductionDb >= -12 - 1e-9, JSON.stringify(st));
    return `artifacts ${drop.total.toFixed(2)} dB, HF ${hf.toFixed(3)} dB, <4.8k ${lf.toFixed(4)} dB`;
  },

  'de-shimmer: no artifacts → HF energy, stable partials and LF unchanged': async () => {
    const bg = makeMusic({ artifacts: false });
    for (const amount of [0.6, 1]) {
      const x = clone(bg.channels);
      spectralCleanup(x, SR, DS(amount));
      const Pin = psd(bg.channels), Pout = psd(x);
      const hf = ratioDb(bandPow(Pout, 5000, 20000), bandPow(Pin, 5000, 20000));
      assert(Math.abs(hf) < 0.1, `false positives: HF change ${hf.toFixed(3)} dB at amount ${amount}`);
      for (const f of STABLE_FREQS) {
        const ch = ratioDb(bandPow(Pout, f - 18, f + 18), bandPow(Pin, f - 18, f + 18));
        assert(Math.abs(ch) < 0.1, `stable ${f} Hz: ${ch.toFixed(3)} dB`);
      }
    }
  },

  'de-shimmer: vibrato, tremolo and beating (detuned) partials are not artifacts': async () => {
    // rich harmonic tones up to 16 kHz over a low noise floor: every HF harmonic is a
    // salient peak, and its level per bin changes all the time — but it never vanishes
    const make = ({ f0, cents = 0, rate = 0, tremDb = 0, detune = 0 }) => {
      const n = 6 * SR;
      const L = whiteNoise(6, SR, 0.003, 5), R = whiteNoise(6, SR, 0.003, 6);
      const fm = new Float64Array(n), am = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        fm[i] = Math.pow(2, (cents / 1200) * Math.sin(2 * Math.PI * rate * t));
        am[i] = Math.pow(10, (-tremDb / 20) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * t)));
      }
      for (let h = 1; f0 * h < 16000; h++) {
        let ph = 0, ph2 = 0.3;
        const a = 0.2 / h, w0 = (2 * Math.PI * f0 * h) / SR;
        for (let i = 0; i < n; i++) {
          ph += w0 * fm[i];
          const v0 = a * am[i] * Math.sin(ph);
          let v = v0;
          if (detune) {
            ph2 += w0 * fm[i] * (1 + detune);
            v = 0.5 * v0 + 0.5 * a * Math.sin(ph2);
          }
          L[i] += v;
          R[i] += v;
        }
      }
      return [L, R];
    };
    const out = [];
    for (const [name, cfg, tol] of [
      ['vocal vibrato ±40 c @5.5 Hz', { f0: 440, cents: 40, rate: 5.5 }, 0.3],
      ['wide vibrato ±80 c @6.5 Hz', { f0: 660, cents: 80, rate: 6.5 }, 1],
      ['tremolo 6 dB @7 Hz', { f0: 330, tremDb: 6 }, 0.05],
      ['detuned pair (+10 c, beating)', { f0: 220, detune: 0.006 }, 0.05],
    ]) {
      const src = make(cfg);
      const x = clone(src);
      spectralCleanup(x, SR, DS(0.6));
      const hf = ratioDb(bandPow(psd(x), 5000, 20000), bandPow(psd(src), 5000, 20000));
      assert(hf > -tol, `${name}: HF change ${hf.toFixed(3)} dB (tolerance ${tol})`);
      out.push(`${name.split(' ')[0]} ${hf.toFixed(2)}`);
    }
    return `HF change (dB): ${out.join(', ')}`;
  },

  // Regression: rhythmic gates and stabs switch a whole harmonic family on and off
  // in step with its low harmonics. Before the co-modulation veto, at amount 0.6 the 1/16
  // gate lost 8 dB at 8–14 kHz (6 dB at 0.5), 1/4 stabs ≈3–4 dB, 20 dB tremolo 7.5 dB, the
  // gated supersaw 6.8 dB, and the shimmer index read +4.1 on the 1/16 gate.
  'de-shimmer: trance gates and stabs (1/16, 1/8, 1/4) keep their HF partials; index below the gate': async () => {
    const out = [];
    for (const [name, cfg] of [
      ['1/16 gate', { periodMs: 117.2, edgeMs: 5 }],
      ['1/16 gate, 1 ms edges, f0 660', { periodMs: 117.2, edgeMs: 1, f0: 660 }],
      ['1/8 gate', { periodMs: 234.4, edgeMs: 5 }],
      ['1/4 stab', { periodMs: 468.8, edgeMs: 10 }],
      ['1/4 pluck', { pluck: true, f0: 784 }],
    ]) {
      const a = gatedTrack(cfg);
      const { worst } = worstPartialDb(a.channels, a.freqs, 0.6);
      assert(Math.abs(worst) <= 0.5, `${name}: HF partial change ${worst.toFixed(2)} dB`);
      const shimmer = analyzeTrack({ sampleRate: SR, channels: a.channels }).indices.shimmer;
      assert(shimmer < INDEX_GATES.shimmer, `${name}: shimmer index ${shimmer} fires (gate ${INDEX_GATES.shimmer})`);
      out.push(`${name} ${worst.toFixed(2)} dB / index ${shimmer}`);
    }
    return out.join('; ');
  },

  'de-shimmer: deep tremolo (20 dB @ 7 Hz, 12 dB @ 16 Hz, 40 dB @ 7 Hz) keeps HF partials; index below the gate': async () => {
    const out = [];
    for (const [rate, depthDb] of [[7, 20], [16, 12], [7, 40], [12, 20]]) {
      const a = tremoloTrack({ rate, depthDb });
      const { worst } = worstPartialDb(a.channels, a.freqs, 0.6);
      assert(Math.abs(worst) <= 0.5, `tremolo ${depthDb} dB @ ${rate} Hz: HF partial change ${worst.toFixed(2)} dB`);
      const shimmer = analyzeTrack({ sampleRate: SR, channels: a.channels }).indices.shimmer;
      assert(shimmer < INDEX_GATES.shimmer, `tremolo ${depthDb} dB @ ${rate} Hz: shimmer index ${shimmer}`);
      out.push(`${depthDb}@${rate} ${worst.toFixed(2)} dB / ${shimmer}`);
    }
    return out.join('; ');
  },

  'de-shimmer: gated supersaw over pink noise + hats keeps its HF harmonics; index below the gate': async () => {
    const a = gatedSupersaw();
    const x = clone(a.channels);
    spectralCleanup(x, SR, DS(0.6));
    // the detuned voices spread each harmonic over ±1.5 %: compare that band (bed included)
    const Pin = psd(a.channels), Pout = psd(x);
    let worst = 0;
    for (const f of a.freqs) {
      const ch = ratioDb(bandPow(Pout, 0.985 * f, 1.015 * f), bandPow(Pin, 0.985 * f, 1.015 * f));
      if (Math.abs(ch) > Math.abs(worst)) worst = ch;
    }
    assert(Math.abs(worst) <= 0.5, `supersaw harmonic band change ${worst.toFixed(2)} dB`);
    const shimmer = analyzeTrack({ sampleRate: SR, channels: a.channels }).indices.shimmer;
    assert(shimmer < INDEX_GATES.shimmer, `gated supersaw: shimmer index ${shimmer}`);
    return `worst harmonic band ${worst.toFixed(2)} dB, index ${shimmer}`;
  },

  'de-shimmer: flickering partials over drums + pad are still removed and detected': async () => {
    // the veto keys on the 1–5 kHz level, which drums move all the time: incoherent
    // flicker must not look co-modulated
    const bg = drumsAndPad();
    const src = clone(bg);
    addArtifacts(src[0], src[1], SR, -30, 17);
    const x = clone(src);
    spectralCleanup(x, SR, DS(0.6));
    const drop = artifactDropDb(src, x, bg, ART_FREQS);
    assert(drop.total <= -5.5, `artifact drop ${drop.total.toFixed(2)} dB (per partial ${drop.per.map((v) => v.toFixed(1)).join(' ')})`);
    const withA = analyzeTrack({ sampleRate: SR, channels: src }).indices.shimmer;
    const clean = analyzeTrack({ sampleRate: SR, channels: bg }).indices.shimmer;
    assert(withA > INDEX_GATES.shimmer && clean < INDEX_GATES.shimmer, `shimmer index ${withA} (artifacts) vs ${clean} (clean)`);
    return `artifacts ${drop.total.toFixed(2)} dB; index ${withA} vs ${clean} clean`;
  },

  'de-shimmer: below startHz the output is sample-identical (difference < −100 dB)': async () => {
    const withA = makeMusic();
    const x = clone(withA.channels);
    spectralCleanup(x, SR, DS(1));
    const d = x.map((c, j) => c.map((v, i) => v - withA.channels[j][i]));
    const rel = ratioDb(bandPow(psd(d), 20, 4000), bandPow(psd(withA.channels), 20, 4000));
    assert(rel < -100, `difference below 4 kHz: ${rel.toFixed(1)} dB re input`);
  },

  'de-shimmer: transients (clicks, hat bursts) keep their peak within 1 dB': async () => {
    const withA = makeMusic();
    const x = clone(withA.channels);
    spectralCleanup(x, SR, DS(0.6));
    let worst = 0;
    for (const e of withA.events) {
      let pi = 0, po = 0;
      for (let i = e.i - 240; i < e.i + 480; i++) {
        for (let c = 0; c < 2; c++) {
          pi = Math.max(pi, Math.abs(withA.channels[c][i]));
          po = Math.max(po, Math.abs(x[c][i]));
        }
      }
      worst = Math.max(worst, Math.abs(db(po) - db(pi)));
    }
    assert(withA.events.length >= 8, 'events');
    assert(worst < 1, `worst transient peak change ${worst.toFixed(3)} dB`);
    return `worst ${worst.toFixed(3)} dB over ${withA.events.length} transients`;
  },

  'de-shimmer: stereo correlation unchanged (±0.02), gains linked (no image shift)': async () => {
    const withA = makeMusic();
    for (const amount of [0.6, 1]) {
      const x = clone(withA.channels);
      spectralCleanup(x, SR, DS(amount));
      approx(correlation(x), correlation(withA.channels), 0.02, `overall correlation @${amount}`);
    }
    // linked gains: a panned source keeps its exact L/R ratio (R = 0.5·L)
    const p = clone(withA.channels);
    for (let i = 0; i < p[0].length; i++) p[1][i] = 0.5 * p[0][i];
    spectralCleanup(p, SR, DS(1));
    let worst = 0;
    for (let i = 0; i < p[0].length; i++) worst = Math.max(worst, Math.abs(p[1][i] - 0.5 * p[0][i]));
    assert(worst < 1e-7, `pan ratio preserved (${worst})`);
    // linked gains: a mono input stays exactly mono
    const mono = makeMusic({ seconds: 3 }).channels[0];
    const m = [Float32Array.from(mono), Float32Array.from(mono)];
    addArtifacts(m[0], m[1], SR, -30, 5);
    m[1].set(m[0]);
    spectralCleanup(m, SR, DS(1));
    assert(maxDiff(m[0], m[1]) === 0, 'mono stays mono');
  },

  'de-shimmer: amount scaling, floor and gains <= 1 (never boosts)': async () => {
    const withA = makeMusic();
    const bg = makeMusic({ artifacts: false });
    const drops = [];
    for (const amount of [0.2, 0.5, 1]) {
      const x = clone(withA.channels);
      const st = spectralCleanup(x, SR, DS(amount));
      drops.push(artifactDropDb(withA.channels, x, bg.channels, ART_FREQS).total);
      const floorDb = -Math.min(12, 18 * amount);
      assert(st.maxReductionDb >= floorDb - 1e-6, `floor ${floorDb} dB respected (${st.maxReductionDb})`);
      // 1 − amount·score bound: never deeper than 20log10(max(1 − amount, floor))
      const bound = Math.max(20 * Math.log10(Math.max(1 - amount, 1e-6)), floorDb);
      assert(st.maxReductionDb >= bound - 1e-6, `contract gain bound ${bound.toFixed(2)} (${st.maxReductionDb})`);
      const Pin = psd(withA.channels), Pout = psd(x);
      for (let f = 5000; f < 20000; f += 250) {
        const ch = ratioDb(bandPow(Pout, f, f + 250), bandPow(Pin, f, f + 250));
        assert(ch < 0.05, `no boost in ${f}–${f + 250} Hz (${ch.toFixed(3)} dB)`);
      }
    }
    assert(drops[0] > drops[1] && drops[1] > drops[2], `monotonic in amount: ${drops.map((d) => d.toFixed(2))}`);
    assert(drops[2] < -9, `amount 1 removes ≥ 9 dB (${drops[2].toFixed(2)})`);
    return `drops @0.2/0.5/1: ${drops.map((d) => d.toFixed(2)).join(' / ')} dB`;
  },

  'de-shimmer: a codec low-pass edge is not mistaken for a peak': async () => {
    const n = 6 * SR;
    const src = [hpNoise(n, 3000, 41), hpNoise(n, 3000, 42)];
    for (const c of src) {
      processInPlace(c, butterworth('lowpass', 8, 16000, SR));
      processInPlace(c, butterworth('lowpass', 8, 16000, SR));
      for (let i = 0; i < n; i++) c[i] *= 0.05 * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SR) ** 2);
    }
    const x = clone(src);
    spectralCleanup(x, SR, DS(1));
    const Pin = psd(src), Pout = psd(x);
    for (const [a, b] of [[14000, 15500], [15500, 16200], [16200, 17000]]) {
      const ch = ratioDb(bandPow(Pout, a, b), bandPow(Pin, a, b));
      assert(Math.abs(ch) < 0.2, `edge band ${a}–${b} Hz changed ${ch.toFixed(3)} dB`);
    }
  },

  'de-shimmer: works at 44.1 and 96 kHz (N = 2048 / 4096)': async () => {
    const out = [];
    for (const sr of [44100, 96000]) {
      const withA = makeMusic({ sr, seconds: 6, transients: false });
      const bg = makeMusic({ sr, seconds: 6, transients: false, artifacts: false });
      const x = clone(withA.channels);
      spectralCleanup(x, sr, DS(0.6));
      assertFinite(x);
      const Pin = psd(withA.channels), Pout = psd(x), Pbg = psd(bg.channels);
      let ain = 0, aout = 0;
      for (const f of ART_FREQS) {
        ain += bandPow(Pin, f - 25, f + 25, sr) - bandPow(Pbg, f - 25, f + 25, sr);
        aout += bandPow(Pout, f - 25, f + 25, sr);
      }
      const drop = ratioDb(aout, ain);
      const lf = ratioDb(bandPow(Pout, 20, 4500, sr), bandPow(Pin, 20, 4500, sr));
      assert(drop <= -5.5, `${sr} Hz: artifact drop ${drop.toFixed(2)} dB`);
      assert(Math.abs(lf) < 0.05, `${sr} Hz: LF ${lf.toFixed(4)} dB`);
      out.push(`${sr}: ${drop.toFixed(2)} dB`);
    }
    return out.join(', ');
  },

  'de-shimmer: demo track (defects on/off) when available': async () => {
    if (!existsSync(DEMO_PATH)) return 'skip';
    const { generateDemoTrack, demoShimmerPartials } = await import('../src/demo/demo-track.js');
    if (typeof generateDemoTrack !== 'function') return 'skip';
    const bad = generateDemoTrack({ seconds: 16, defects: true });
    const clean = generateDemoTrack({ seconds: 16, defects: false });
    const parts = typeof demoShimmerPartials === 'function' ? demoShimmerPartials({ sampleRate: SR }).map((p) => p.freqHz) : [];
    const res = [];
    for (const [name, a] of [['defects', bad], ['clean', clean]]) {
      const x = clone(a.channels);
      const st = spectralCleanup(x, SR, DS(0.6));
      assertFinite(x);
      const Pi = psd(a.channels), Po = psd(x);
      const hf = ratioDb(bandPow(Po, 5000, 20000), bandPow(Pi, 5000, 20000));
      const lf = ratioDb(bandPow(Po, 20, 4500), bandPow(Pi, 20, 4500));
      assert(Math.abs(lf) < 0.01, `${name}: LF ${lf.toFixed(4)} dB`);
      if (name === 'clean') {
        assert(Math.abs(hf) < 0.2, `clean demo HF change ${hf.toFixed(3)} dB`);
        res.push(`clean HF ${hf.toFixed(3)} dB`);
      } else if (parts.length) {
        let pin = 0, pout = 0;
        for (const f of parts) {
          pin += bandPow(Pi, f - 15, f + 15);
          pout += bandPow(Po, f - 15, f + 15);
        }
        const pd = ratioDb(pout, pin);
        assert(pd < -2, `shimmer partial bands (incl. music under them) drop ${pd.toFixed(2)} dB`);
        assert(hf > -1, `defects demo HF change ${hf.toFixed(3)} dB`);
        res.push(`defects: partial bands ${pd.toFixed(2)} dB, HF ${hf.toFixed(2)} dB, avg ${st.avgReductionDb.toFixed(2)} dB`);
      }
    }
    return res.join('; ');
  },

  'denoise: hiss floor in silent passages −5 dB+ at amount 0.5; music untouched': async () => {
    const h = makeHissy();
    const x = clone(h.channels);
    const st = spectralCleanup(x, SR, DN(0.5));
    assertFinite(x);
    const red = ratioDb(segPow(x, h.silent, 8500, 20000), segPow(h.channels, h.silent, 8500, 20000));
    assert(red <= -5, `hiss reduction in silence ${red.toFixed(2)} dB`);
    assert(red >= -6.05, `never more than the 6 dB cap (${red.toFixed(2)})`);
    let mi = 0, mo = 0;
    for (const [a, b] of h.music) {
      for (let c = 0; c < 2; c++) {
        for (let i = a; i < b; i++) {
          mi += h.channels[c][i] ** 2;
          mo += x[c][i] ** 2;
        }
      }
    }
    const musicRms = ratioDb(mo, mi);
    const musicHf = ratioDb(segPow(x, h.music, 6000, 20000), segPow(h.channels, h.music, 6000, 20000));
    assert(Math.abs(musicRms) < 0.5, `music RMS change ${musicRms.toFixed(3)} dB`);
    assert(Math.abs(musicHf) < 0.5, `music HF (> 6 kHz) change ${musicHf.toFixed(3)} dB`);
    const seg = (chs) => [Float32Array.from(chs[0].subarray(h.music[1][0], h.music[1][1])), Float32Array.from(chs[1].subarray(h.music[1][0], h.music[1][1]))];
    approx(correlation(seg(x)), correlation(seg(h.channels)), 0.02, 'music correlation');
    approx(st.denoise.maxReductionDb, -6, 0.01, 'max reduction = 12 dB × amount');
    assert(Number.isFinite(st.denoise.noiseFloorDb), 'noise floor estimated');
    return `silence ${red.toFixed(2)} dB, music RMS ${musicRms.toFixed(3)} dB, music HF ${musicHf.toFixed(3)} dB`;
  },

  'denoise: max reduction follows 12 dB × amount (Light 3 / Medium 6 / Strong 9)': async () => {
    const h = makeHissy();
    const out = [];
    for (const [amount, cap] of [[0.25, 3], [0.5, 6], [0.75, 9]]) {
      const x = clone(h.channels);
      const st = spectralCleanup(x, SR, DN(amount));
      const red = ratioDb(segPow(x, h.silent, 8500, 20000), segPow(h.channels, h.silent, 8500, 20000));
      assert(red <= -cap + 1 && red >= -cap - 0.05, `amount ${amount}: ${red.toFixed(2)} dB (cap ${cap})`);
      approx(st.denoise.maxReductionDb, -cap, 0.01, 'reported max');
      out.push(red.toFixed(2));
    }
    return `silence reduction ${out.join(' / ')} dB`;
  },

  'denoise: nothing changes below fromHz (difference < −100 dB)': async () => {
    const h = makeHissy();
    const x = clone(h.channels);
    spectralCleanup(x, SR, DN(1));
    const d = x.map((c, j) => c.map((v, i) => v - h.channels[j][i]));
    const rel = ratioDb(bandPow(psd(d), 20, 5000), bandPow(psd(h.channels), 20, 5000));
    assert(rel < -100, `difference below 5 kHz: ${rel.toFixed(1)} dB`);
    // ramp: 6–8.5 kHz is reduced less than above 8.5 kHz
    const ramp = ratioDb(segPow(x, h.silent, 6200, 8000), segPow(h.channels, h.silent, 6200, 8000));
    const full = ratioDb(segPow(x, h.silent, 9000, 20000), segPow(h.channels, h.silent, 9000, 20000));
    assert(ramp > full + 2, `½-octave ramp-in (${ramp.toFixed(2)} vs ${full.toFixed(2)} dB)`);
  },

  'denoise: a hat burst in hissy silence keeps its peak within 1 dB': async () => {
    const h = makeHissy();
    const i0 = Math.round(4 * SR);
    const len = Math.round(0.04 * SR);
    const b = hpNoise(len + 64, 7000, 999);
    const src = clone(h.channels);
    for (let j = 0; j < len; j++) {
      const e = 0.3 * Math.exp(-j / (0.008 * SR));
      src[0][i0 + j] += e * b[j + 64];
      src[1][i0 + j] += e * b[j + 64];
    }
    const x = clone(src);
    spectralCleanup(x, SR, DN(1));
    const pi = Math.max(peak(src[0].subarray(i0 - 100, i0 + len)), peak(src[1].subarray(i0 - 100, i0 + len)));
    const po = Math.max(peak(x[0].subarray(i0 - 100, i0 + len)), peak(x[1].subarray(i0 - 100, i0 + len)));
    const ch = db(po) - db(pi);
    assert(Math.abs(ch) < 1, `burst peak change ${ch.toFixed(3)} dB`);
    return `burst peak ${ch.toFixed(3)} dB`;
  },

  'denoise: too short to learn a noise floor → no-op, reported': async () => {
    const x = [whiteNoise(0.05, SR, 0.1, 1), whiteNoise(0.05, SR, 0.1, 2)];
    const src = clone(x);
    const st = spectralCleanup(x, SR, DN(1));
    assert(st.denoise && st.denoise.noiseFloorDb === null, 'noiseFloorDb null');
    assert(maxDiff(x[0], src[0]) === 0 && maxDiff(x[1], src[1]) === 0, 'untouched');
  },

  'safety: silence, tiny inputs, mono, 3 channels, odd rates, extreme content, no NaN': async () => {
    const opts = { ...DS(1), ...DN(1) };
    for (const len of [0, 1, 2, 10, 100, 2047, 2049]) {
      const x = [whiteNoise(len / SR + 1e-9, SR, 0.9, 3).subarray(0, len), whiteNoise(len / SR + 1e-9, SR, 0.9, 4).subarray(0, len)];
      const a = [Float32Array.from(x[0]), Float32Array.from(x[1])];
      const st = spectralCleanup(a, SR, opts);
      assert(a[0].length === x[0].length, `length ${len}`);
      assertFinite(a, `len ${len}`);
      assert(Number.isFinite(st.avgReductionDb) && Number.isFinite(st.maxReductionDb), 'finite stats');
    }
    const mono = [makeMusic({ seconds: 2 }).channels[0]];
    spectralCleanup(mono, SR, opts);
    assertFinite(mono, 'mono');
    const three = makeMusic({ seconds: 2 }).channels.concat([whiteNoise(2, SR, 0.1, 9)]);
    spectralCleanup(three, SR, opts);
    assertFinite(three, '3 ch');
    // full-scale square, DC, alternating ±1, single full-scale spikes
    const n = SR;
    const sq = new Float32Array(n), dc = new Float32Array(n).fill(0.9), alt = new Float32Array(n), spk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sq[i] = (i >> 6) & 1 ? 1 : -1;
      alt[i] = i & 1 ? 1 : -1;
      if (i % 9973 === 0) spk[i] = 1;
    }
    for (const sig of [sq, dc, alt, spk]) {
      const a = [Float32Array.from(sig), Float32Array.from(sig)];
      spectralCleanup(a, SR, opts);
      assertFinite(a, 'extreme');
      assert(peak(a[0]) < 1.5, `bounded output (${peak(a[0])})`);
    }
    // rates where the regions do not exist (startHz/fromHz ≥ Nyquist) → identity
    for (const sr of [8000, 9600]) {
      const a = [whiteNoise(1, sr, 0.3, 1), whiteNoise(1, sr, 0.3, 2)];
      const ref = clone(a);
      spectralCleanup(a, sr, { deShimmer: { enabled: true, amount: 1, startHz: 5000, fullHz: 9000 }, denoise: { enabled: true, amount: 1, fromHz: 6000 } });
      assert(maxDiff(a[0], ref[0]) === 0, `identity at ${sr} Hz`);
    }
    for (const sr of [22050, 32000, 88200, 192000]) {
      const a = [whiteNoise(1, sr, 0.3, 1), whiteNoise(1, sr, 0.3, 2)];
      spectralCleanup(a, sr, opts);
      assertFinite(a, `${sr} Hz`);
    }
    // degenerate region parameters
    for (const ds of [{ startHz: 0, fullHz: 0 }, { startHz: 9000, fullHz: 5000 }, { startHz: -5, fullHz: NaN }]) {
      const a = makeMusic({ seconds: 1 }).channels;
      spectralCleanup(a, SR, { deShimmer: { enabled: true, amount: 1, ...ds }, denoise: { enabled: true, amount: 1, fromHz: -1 } });
      assertFinite(a, JSON.stringify(ds));
    }
    // invalid rate → untouched
    const bad = [whiteNoise(0.1, SR, 0.3, 1)];
    const badRef = Float32Array.from(bad[0]);
    spectralCleanup(bad, 0, opts);
    assert(maxDiff(bad[0], badRef) === 0, 'sampleRate 0 → identity');
  },

  'boundaries: abrupt start/end keep stable content exact and edges sane': async () => {
    // a stable HF tone + noise starting at sample 0 and ending at the last sample
    const n = 2 * SR;
    const src = [hpNoise(n, 3000, 5), hpNoise(n, 3000, 6)];
    const t = sine(9000, 2, SR, 0.05);
    for (let i = 0; i < n; i++) {
      src[0][i] = 0.02 * src[0][i] + t[i];
      src[1][i] = 0.02 * src[1][i] + t[i];
    }
    const x = clone(src);
    spectralCleanup(x, SR, DS(1));
    assert(maxDiff(x[0], src[0]) < 1e-3 && maxDiff(x[1], src[1]) < 1e-3, `stable content kept (max diff ${maxDiff(x[0], src[0])})`);
    // with artifacts right from sample 0: no edge blow-up
    const y = clone(src);
    addArtifacts(y[0], y[1], SR, -26, 3);
    const yRef = clone(y);
    spectralCleanup(y, SR, DS(1));
    const e0 = Math.max(peak(y[0].subarray(0, 1024)), peak(y[1].subarray(0, 1024)));
    const e1 = Math.max(peak(yRef[0].subarray(0, 1024)), peak(yRef[1].subarray(0, 1024)));
    assert(e0 <= e1 * 1.05, 'no edge overshoot at the start');
    const z0 = Math.max(peak(y[0].subarray(n - 1024)), peak(y[1].subarray(n - 1024)));
    const z1 = Math.max(peak(yRef[0].subarray(n - 1024)), peak(yRef[1].subarray(n - 1024)));
    assert(z0 <= z1 * 1.05, 'no edge overshoot at the end');
  },

  'progress callback: monotonic, ends at 1': async () => {
    const x = clone(makeHissy().channels);
    const seen = [];
    spectralCleanup(x, SR, { ...DS(0.5), ...DN(0.5) }, (f) => seen.push(f));
    assert(seen.length >= 10, `called ${seen.length}×`);
    for (let i = 1; i < seen.length; i++) assert(seen[i] >= seen[i - 1], 'monotonic');
    assert(seen[0] >= 0 && seen[seen.length - 1] === 1, 'range 0..1, ends at 1');
    const seen2 = [];
    spectralCleanup(clone(x), SR, {}, (f) => seen2.push(f));
    assert(seen2.length === 1 && seen2[0] === 1, 'no-op still reports completion');
  },

  'deterministic: identical output on repeated runs': async () => {
    const src = makeHissy().channels;
    addArtifacts(src[0], src[1], SR, -30, 8);
    const a = clone(src), b = clone(src);
    const sa = spectralCleanup(a, SR, { ...DS(0.7), ...DN(0.6) });
    const sb = spectralCleanup(b, SR, { ...DS(0.7), ...DN(0.6) });
    assert(maxDiff(a[0], b[0]) === 0 && maxDiff(a[1], b[1]) === 0, 'bit-identical');
    assert(JSON.stringify(sa) === JSON.stringify(sb), 'same stats');
  },

  'ffmpeg cross-check: band levels (LP 4 kHz / HP 6 kHz) and loudness': async () => {
    if (!hasFfmpeg()) return 'skip';
    const rmsDb = (path, chain) => {
      const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', `${chain},astats=metadata=0:measure_perchannel=none`, '-f', 'null', '-'], { encoding: 'utf8' });
      const m = [...res.stderr.matchAll(/RMS level dB:\s+(-?[\d.]+|-inf)/g)];
      return m.length ? parseFloat(m[m.length - 1][1]) : NaN;
    };
    const lp = Array(4).fill('lowpass=f=4000').join(',');
    const hp = Array(4).fill('highpass=f=6000').join(',');
    const out = [];
    for (const artifacts of [true, false]) {
      const sig = makeMusic({ artifacts });
      const x = clone(sig.channels);
      spectralCleanup(x, SR, DS(0.6));
      const tag = artifacts ? 'art' : 'bg';
      const pIn = writeWavFloat(join(TMP, `spectral-${tag}-in.wav`), sig.channels, SR);
      const pOut = writeWavFloat(join(TMP, `spectral-${tag}-out.wav`), x, SR);
      const lf = rmsDb(pOut, lp) - rmsDb(pIn, lp);
      const hf = rmsDb(pOut, hp) - rmsDb(pIn, hp);
      assert(Number.isFinite(lf) && Number.isFinite(hf), 'ffmpeg astats parsed');
      assert(Math.abs(lf) < 0.2, `${tag}: ffmpeg LP 4 kHz level change ${lf.toFixed(3)} dB`);
      // the same filter chain in JS (RBJ biquads, Q 0.707, as ffmpeg's highpass) must agree
      const hpEnergy = (chs) => {
        let e = 0;
        for (const c of chs) {
          const y = Float32Array.from(c);
          processInPlace(y, [0, 1, 2, 3].map(() => design('highpass', 6000, SR)));
          for (let i = 0; i < y.length; i++) e += y[i] * y[i];
        }
        return e;
      };
      const ours = ratioDb(hpEnergy(x), hpEnergy(sig.channels));
      if (artifacts) {
        assert(hf < -0.3 && hf > -3, `${tag}: ffmpeg HP 6 kHz change ${hf.toFixed(3)} dB (artifacts removed)`);
        assert(Math.abs(hf - ours) < 0.05, `ffmpeg ${hf.toFixed(3)} vs JS ${ours.toFixed(3)} dB`);
      } else {
        assert(Math.abs(hf) < 0.05, `${tag}: ffmpeg HP 6 kHz change ${hf.toFixed(3)} dB (nothing to remove)`);
      }
      const li = ffmpegLoudness(pIn), lo = ffmpegLoudness(pOut);
      // removing strong HF artifacts may lower K-weighted loudness slightly; nothing else may
      const tol = artifacts ? 0.25 : 0.05;
      assert(Math.abs(lo.integrated - li.integrated) < tol, `${tag}: integrated loudness change ${(lo.integrated - li.integrated).toFixed(2)} LU`);
      out.push(`${tag}: LP4k ${lf.toFixed(3)} dB, HP6k ${hf.toFixed(3)} dB (ours ${ours.toFixed(3)}), I ${li.integrated}→${lo.integrated}`);
    }
    return out.join('; ');
  },

  'performance: 3:30 stereo 48 kHz (budget 3 s for de-shimmer + denoise)': async () => {
    const base = makeMusic({ seconds: 10.5, artDb: -32 });
    const h = makeHissy();
    const n = 210 * SR;
    const src = [new Float32Array(n), new Float32Array(n)];
    const bl = base.channels[0].length, hl = h.channels[0].length;
    for (let c = 0; c < 2; c++) {
      const b = base.channels[c], hh = h.channels[c];
      for (let i = 0; i < n; i++) src[c][i] = b[i % bl] + hh[i % hl];
    }
    const f = speedFactor();
    // one work buffer, refilled before every run: no large allocations (GC) near the timing
    const work = clone(src);
    const time = (opts, runs = 1) => {
      let best = Infinity;
      for (let r = 0; r < runs; r++) {
        work[0].set(src[0]);
        work[1].set(src[1]);
        const t0 = performance.now();
        spectralCleanup(work, SR, opts);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    // warm-up on a short excerpt (JIT), then measure
    spectralCleanup(clone(src.map((c) => c.subarray(0, 10 * SR))), SR, { ...DS(0.6), ...DN(0.5) });
    const tDs = time(DS(0.6));
    const tDn = time(DN(0.5));
    const tBoth = time({ ...DS(0.6), ...DN(0.5) }, 3);
    const budget = 3000;
    // speedFactor() includes the Rosetta correction (≈2.9 s as x64 vs ≈1.8 s native arm64).
    const rosetta = ROSETTA;
    const scale = f;
    const m1 = tBoth / scale;
    const msg = `de-shimmer ${tDs.toFixed(0)} ms, denoise ${tDn.toFixed(0)} ms, both ${tBoth.toFixed(0)} ms ` +
      `(budget ${budget} ms @M1; host factor ${f.toFixed(2)}${rosetta ? ' incl. × 1.6 Rosetta' : ''} → ≈${m1.toFixed(0)} ms @M1` +
      `${m1 > budget ? ' — OVER BUDGET on this run' : ''})`;
    // Shared/loaded hosts swing ±30 % between runs (see foundation report): fail only beyond
    // 1.3× the scaled budget so real regressions are caught without flapping; the message
    // always reports the raw and M1-normalized times.
    assert(tBoth < 1.3 * budget * scale, `${msg} exceeds 1.3× budget`);
    return msg;
  },
};
