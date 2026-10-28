// I/O tests: dither, WAV writer/parser, format sniffers, decodeFile (with a mocked
// Web Audio decoder backed by ffmpeg), MP3 helpers + gapless tag, ZIP, save (host saver
// contract), dev-server path rules, player smoke test, and performance against
// ARCHITECTURE §8 (3:30 stereo 48 kHz).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  assert, approx, assertFinite, TMP, hasFfmpeg, ffmpegDecode, writeWavFloat, sine, pinkNoise, rng, timed, bestLag,
} from './helpers.mjs';
import { floatToPcm, PcmQuantizer, LIP44, noiseShapingFilter } from '../src/dsp/dither.js';
import { encodeWav, encodeWavBuffer } from '../src/export/wav.js';
import {
  parseWav, parseAiff, sniffFormat, decodeFile, MAX_DURATION_SEC, LOW_MEMORY_MAX_DURATION_SEC, deviceMaxDurationSec,
} from '../src/audio/decode.js';
import { makeZip, makeZipBytes, crc32, _planZip } from '../src/export/zip.js';
import { saveBlob, probeSaveSupport, _setHostTimeout } from '../src/export/save.js';
import {
  encodeMp3, loadLame, _toInt16Chunks, _buildInfoFrame, LAME_URL, LAME_FALLBACK_URL, LAME_INTEGRITY, LAME_FALLBACK_INTEGRITY,
} from '../src/export/mp3.js';
import { resolveRequestPath, isLoopbackHost } from '../tools/serve.mjs';
import { Player } from '../src/audio/player.js';

// ---------------------------------------------------------------------------------------
// helpers

const fx = (name) => join(TMP, `io-${name}`);
const ff = (...args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr}`);
};
const hasTool = (cmd, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const ffInfo = (path) => spawnSync('ffmpeg', ['-hide_banner', '-i', path], { encoding: 'utf8' }).stderr;

/** ffmpeg decode keeping the native channel count (helpers.ffmpegDecode forces stereo). */
function ffDecodeNative(path, nCh) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', path, '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout;
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const n = f.length / nCh;
  return Array.from({ length: nCh }, (_, c) => {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = f[i * nCh + c];
    return ch;
  });
}

function maxAbsDiff(a, b) {
  assert(a.length === b.length, `length ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function namedBlob(bytes, name) {
  return typeof File === 'function' ? new File([bytes], name) : Object.assign(new Blob([bytes]), { name });
}

async function expectReject(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert(e.code === code, `expected code ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`expected rejection with ${code}`);
}

function expectThrow(fn, code) {
  try {
    fn();
  } catch (e) {
    assert(e.code === code, `expected code ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`expected throw with ${code}`);
}

/** Index of the largest sample-to-sample jump (locates the test impulse). */
function impulseAt(ch) {
  let pk = 0;
  let at = -1;
  for (let i = 1; i < ch.length; i++) {
    const d = Math.abs(ch[i] - ch[i - 1]);
    if (d > pk) { pk = d; at = i; }
  }
  return at;
}

/** Deterministic stereo music-like signal with an impulse at exactly 1.000 s. */
function testSignal(sr, seconds = 3, amp = 0.5) {
  const L = sine(440, seconds, sr, amp * 0.6);
  const R = sine(660, seconds, sr, amp * 0.5);
  const nl = pinkNoise(seconds, sr, amp * 0.6, 3);
  const nr = pinkNoise(seconds, sr, amp * 0.6, 4);
  for (let i = 0; i < L.length; i++) { L[i] += nl[i]; R[i] += nr[i]; }
  if (L.length > sr) { L[sr] = 0.95; R[sr] = -0.95; }
  return [L, R];
}

const fixtureCache = new Map();
/** Lazily generated source WAV (float) per rate; returns { path, channels }. */
function sourceWav(sr) {
  if (fixtureCache.has(sr)) return fixtureCache.get(sr);
  const channels = testSignal(sr);
  const path = writeWavFloat(fx(`src${sr}.wav`), channels, sr);
  const v = { path, channels };
  fixtureCache.set(sr, v);
  return v;
}

/** In-place radix-2 FFT (test-only). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2];
        const ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi;
        const ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

/** Welch PSD (Hann, 50% overlap) → Float64Array(N/2 + 1). */
function psd(x, N = 4096) {
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const out = new Float64Array(N / 2 + 1);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += N / 2, frames++) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) out[k] += re[k] * re[k] + im[k] * im[k];
  }
  for (let k = 0; k <= N / 2; k++) out[k] /= frames;
  return out;
}

function bandMean(p, sr, f0, f1) {
  const N = (p.length - 1) * 2;
  let s = 0;
  let n = 0;
  for (let k = Math.ceil((f0 * N) / sr); k <= Math.floor((f1 * N) / sr); k++) { s += p[k]; n++; }
  return s / n;
}

/** |NTF|² band average for error-feedback coefficients c (NTF = 1 − Σ c_k z^−(k+1)). */
function ntfBand(c, sr, f0, f1) {
  let s = 0;
  let n = 0;
  for (let f = f0; f <= f1; f += 10) {
    const w = (2 * Math.PI * f) / sr;
    let re = 1;
    let im = 0;
    c.forEach((ck, k) => { re -= ck * Math.cos(w * (k + 1)); im += ck * Math.sin(w * (k + 1)); });
    s += re * re + im * im;
    n++;
  }
  return s / n;
}

/** Quantization error in LSB: q − x·S. */
function errorLsb(x, q, bits) {
  const S = 2 ** (bits - 1);
  const e = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) e[i] = q[i] - x[i] * S;
  return e;
}

function meanVar(e) {
  let m = 0;
  for (const v of e) m += v;
  m /= e.length;
  let v2 = 0;
  for (const v of e) v2 += (v - m) * (v - m);
  return [m, v2 / e.length];
}

/** Minimal RIFF builder for hand-crafted edge cases. */
function riff(chunks, { id = 'RIFF', pad = true } = {}) {
  const parts = [];
  for (const [cid, body] of chunks) {
    const h = Buffer.alloc(8);
    h.write(cid, 0, 'latin1');
    h.writeUInt32LE(body.length, 4);
    parts.push(h, Buffer.from(body));
    if (pad && body.length & 1) parts.push(Buffer.alloc(1));
  }
  const inner = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(inner.length + 4, 4);
  head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, inner]);
}

function fmtChunk(tag, nCh, sr, bits) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(tag, 0);
  b.writeUInt16LE(nCh, 2);
  b.writeUInt32LE(sr, 4);
  b.writeUInt32LE((sr * nCh * bits) / 8, 8);
  b.writeUInt16LE((nCh * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}

function s16Data(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}

/** Fake AudioBuffer around planar channels (copyFromChannel honours bufferOffset, as the real one). */
function fakeAudioBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length, length: channels[0].length, sampleRate, duration: channels[0].length / sampleRate,
    copyFromChannel(dst, c, start = 0) { dst.set(channels[c].subarray(start, start + dst.length)); },
    getChannelData(c) { return channels[c]; },
  };
}

/**
 * Install a mock OfflineAudioContext whose decodeAudioData runs `decode(bytes, rate)`.
 * Records the context rates. Returns { rates, restore }.
 */
function mockOfflineContext(decode) {
  const rates = [];
  const prev = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    constructor(a, b, c) {
      const sr = typeof a === 'object' ? a.sampleRate : c;
      if (!(sr >= 3000 && sr <= 768000)) throw new Error('NotSupportedError');
      this.sampleRate = sr;
      rates.push(sr);
    }
    decodeAudioData(bytes) {
      assert(bytes instanceof ArrayBuffer, 'decodeAudioData gets an ArrayBuffer');
      return Promise.resolve().then(() => decode(new Uint8Array(bytes), this.sampleRate));
    }
  };
  return { rates, restore: () => { if (prev) globalThis.OfflineAudioContext = prev; else delete globalThis.OfflineAudioContext; } };
}

/** Chromium-like decoder: FFmpeg (Chrome's own decoder) at the context rate. */
function ffmpegLikeDecode(bytes, rate, tag = 'dec') {
  const p = fx(`mock-${tag}-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(p, bytes);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', p, '-f', 'f32le', '-ac', '2', '-ar', String(rate), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0 || !r.stdout.length) throw new Error('EncodingError: Unable to decode audio data');
  const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
  const n = f.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return [L, R];
}

function withNavigator(ua, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true });
  const restore = () => { if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator; };
  return Promise.resolve().then(fn).finally(restore);
}

// lazily generated compressed fixtures
const compressed = {};
function makeCompressed() {
  if (compressed.ready) return compressed;
  const s44 = sourceWav(44100).path;
  const s48 = sourceWav(48000).path;
  const jobs = {
    cbr44: ['mp3', ['-i', s44, '-c:a', 'libmp3lame', '-b:a', '320k']],
    vbr48: ['mp3', ['-i', s48, '-c:a', 'libmp3lame', '-q:a', '2']],
    cbr48: ['mp3', ['-i', s48, '-c:a', 'libmp3lame', '-b:a', '192k']],
    vbr44: ['mp3', ['-i', s44, '-c:a', 'libmp3lame', '-q:a', '4']],
    noxing: ['mp3', ['-i', s44, '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0']],
    mpeg2: ['mp3', ['-i', s44, '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '64k']],
    id3: ['mp3', ['-i', s44, '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3', '-metadata', 'title=Très bien – ok', '-metadata', 'artist=Ünïcode']],
    aac44: ['m4a', ['-i', s44, '-c:a', 'aac', '-b:a', '192k']],
    aac48: ['m4a', ['-i', s48, '-c:a', 'aac', '-b:a', '256k']],
    alac: ['m4a', ['-i', s44, '-c:a', 'alac']],
    flac48: ['flac', ['-i', s48, '-c:a', 'flac']],
    flac96: ['flac', ['-i', s48, '-ar', '96000', '-c:a', 'flac', '-sample_fmt', 's32']],
    vorbis: ['ogg', ['-i', s44, '-c:a', 'vorbis', '-strict', '-2']],
    opus: ['opus', ['-i', s44, '-c:a', 'libopus', '-b:a', '128k']],
    opusmp4: ['m4a', ['-i', s48, '-c:a', 'libopus', '-b:a', '128k', '-f', 'mp4']],
    adts: ['aac', ['-i', s44, '-c:a', 'aac', '-f', 'adts']],
    aiff: ['aiff', ['-i', s44, '-c:a', 'pcm_s16be']],
    aifc: ['aifc', ['-i', s48, '-c:a', 'pcm_s24be', '-f', 'aiff']],
  };
  for (const [name, [ext, args]] of Object.entries(jobs)) {
    const out = fx(`${name}.${ext}`);
    if (!existsSync(out)) ff(...args, out);
    compressed[name] = out;
  }
  // HE-AAC (AudioToolbox): ffmpeg writes mdhd at the output rate, afconvert at the core rate.
  try {
    const out = fx('heaac48.m4a');
    if (!existsSync(out)) ff('-i', s48, '-c:a', 'aac_at', '-profile:a', '4', '-b:a', '64k', out);
    compressed.heaac48 = out;
  } catch { /* aac_at only on macOS builds */ }
  if (hasTool('afconvert', '-h') || existsSync('/usr/bin/afconvert')) {
    for (const [name, args] of [['afc', ['-f', 'm4af', '-d', 'aac', s44]], ['afc_he', ['-f', 'm4af', '-d', 'aach', s48]]]) {
      const out = fx(`${name}.m4a`);
      if (!existsSync(out)) spawnSync('afconvert', [...args, out]);
      if (existsSync(out)) compressed[name] = out;
    }
  }
  if (hasTool('lame')) {
    // `lame -t` = no Info/LAME tag: exactly the stream structure lamejs produces.
    for (const sr of [44100, 48000]) {
      const raw = fx(`raw${sr}.pcm`);
      const out = fx(`lamet${sr}.mp3`);
      if (!existsSync(out)) {
        ff('-i', sourceWav(sr).path, '-f', 's16le', '-acodec', 'pcm_s16le', raw);
        spawnSync('lame', ['--quiet', '-r', '-s', String(sr / 1000), '--bitwidth', '16', '--signed', '--little-endian', '-m', 's', '-b', '320', '--cbr', '-t', raw, out]);
      }
      if (existsSync(out)) compressed[`lamet${sr}`] = out;
    }
  }
  compressed.ready = true;
  return compressed;
}

// ---------------------------------------------------------------------------------------

export const tests = {
  // ----------------------------------------------------------------------------- dither
  'dither: TPDF error is signal-independent (mean 0, variance 1/12 + 2/12 = 1/4 LSB²)': async () => {
    const n = 1 << 18;
    const report = [];
    // DC at fractional LSB offsets + a low-level sine: with RPDF/no dither the error
    // statistics would depend on the input; with TPDF they must not.
    const inputs = {
      zero: new Float32Array(n),
      quarter: new Float32Array(n).fill(0.25 / 32768),
      half: new Float32Array(n).fill(0.5 / 32768),
      odd: new Float32Array(n).fill(-1234.37 / 32768),
      sine: sine(997, n / 48000, 48000, 3 / 32768),
    };
    for (const [name, x] of Object.entries(inputs)) {
      const q = floatToPcm([x], 16, { sampleRate: 48000 });
      const [m, v] = meanVar(errorLsb(x, q, 16));
      approx(m, 0, 0.006, `${name} mean`);
      approx(v, 0.25, 0.006, `${name} variance`);
      report.push(`${name} μ=${m.toFixed(4)} σ²=${v.toFixed(4)}`);
    }
    // sanity: undithered rounding of an exact integer has zero error
    const plain = floatToPcm([inputs.zero], 16, { dither: 'none' });
    assert(plain.every((v) => v === 0), 'no dither on silence must be exact zeros');
    // 24-bit TPDF: same statistics in 24-bit LSBs
    const q24 = floatToPcm([inputs.odd], 24, { sampleRate: 44100 });
    const [m24, v24] = meanVar(errorLsb(inputs.odd, q24, 24));
    approx(m24, 0, 0.006, '24-bit mean');
    approx(v24, 0.25, 0.006, '24-bit variance (flat TPDF even at 44.1 kHz)');
    return report.join(', ');
  },

  'dither: lip44 shapes noise toward HF only at 16-bit/44.1 kHz, matching |NTF|²': async () => {
    const n = 1 << 18;
    const x = sine(1000, n / 44100, 44100, 0.001); // −60 dBFS
    const shaped = floatToPcm([x], 16, { sampleRate: 44100 });
    const flat = floatToPcm([x], 16, { sampleRate: 44100, noiseShaping: 'none' });
    const at48 = floatToPcm([x], 16, { sampleRate: 48000 }); // 'auto' → flat at 48 kHz
    const at24 = floatToPcm([x], 24, { sampleRate: 44100 }); // 'auto' → flat at 24-bit
    assert(noiseShapingFilter(16, 44100) && !noiseShapingFilter(16, 48000) && !noiseShapingFilter(24, 44100) && !noiseShapingFilter(16, 88200), 'auto policy');
    const pS = psd(errorLsb(x, shaped, 16));
    const pF = psd(errorLsb(x, flat, 16));
    const p48 = psd(errorLsb(x, at48, 16));
    const p24 = psd(errorLsb(x, at24, 24));
    const sr = 44100;
    const lo = [200, 3000];
    const hi = [17000, 21000];
    // flat cases: no tilt (±0.7 dB)
    for (const [name, p] of [['flat', pF], ['48k', p48], ['24-bit', p24]]) {
      const tilt = 10 * Math.log10(bandMean(p, sr, ...hi) / bandMean(p, sr, ...lo));
      approx(tilt, 0, 0.7, `${name} tilt dB`);
    }
    // shaped vs flat ≈ |NTF|² per band (±1 dB)
    const out = [];
    for (const [f0, f1] of [[100, 1000], [3000, 5000], [8000, 10000], [18000, 21000]]) {
      const meas = 10 * Math.log10(bandMean(pS, sr, f0, f1) / bandMean(pF, sr, f0, f1));
      const theo = 10 * Math.log10(ntfBand(LIP44, sr, f0, f1));
      approx(meas, theo, 1, `lip44 band ${f0}-${f1} Hz`);
      out.push(`${f0}-${f1}Hz ${meas.toFixed(1)} dB (theory ${theo.toFixed(1)})`);
    }
    const [m] = meanVar(errorLsb(x, shaped, 16));
    approx(m, 0, 0.01, 'shaped error has no DC');
    return out.join(', ');
  },

  'dither: deterministic, seed-dependent, identical when quantized block by block': async () => {
    const [L, R] = testSignal(44100, 1, 0.3);
    for (const [bits, sr] of [[16, 44100], [16, 48000], [24, 44100]]) {
      const a = floatToPcm([L, R], bits, { sampleRate: sr, seed: 7 });
      const b = floatToPcm([L, R], bits, { sampleRate: sr, seed: 7 });
      const c = floatToPcm([L, R], bits, { sampleRate: sr, seed: 8 });
      assert(a.every((v, i) => v === b[i]), 'same seed → same output');
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) diff++;
      assert(diff > a.length * 0.3, 'different seed → different dither');
      // streaming in odd-sized blocks must equal one-shot (PRNG + error state carried)
      const q = new PcmQuantizer(2, bits, { sampleRate: sr, seed: 7 });
      const Out = bits === 16 ? Int16Array : Int32Array;
      const s = new Out(a.length);
      for (let st = 0; st < L.length; st += 1001) {
        const e = Math.min(L.length, st + 1001);
        const blk = new Out((e - st) * 2);
        q.quantizeInterleaved([L, R], st, e, blk);
        s.set(blk, st * 2);
      }
      assert(s.every((v, i) => v === a[i]), `block-wise == one-shot (${bits}/${sr})`);
      // L and R dither are independent
      const eL = new Float64Array(L.length);
      const eR = new Float64Array(L.length);
      for (let i = 0; i < L.length; i++) { eL[i] = a[2 * i] - L[i] * 2 ** (bits - 1); eR[i] = a[2 * i + 1] - R[i] * 2 ** (bits - 1); }
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < eL.length; i++) { sxy += eL[i] * eR[i]; sxx += eL[i] * eL[i]; syy += eR[i] * eR[i]; }
      approx(sxy / Math.sqrt(sxx * syy), 0, 0.05, 'L/R dither correlation');
    }
  },

  'dither: clamps without wrap-around, recovers after clipping, safe on NaN/Inf/empty/10 samples': async () => {
    const x = Float32Array.from([1, -1, 1.5, -1.5, 0.99999, NaN, Infinity, -Infinity, 0, 1e30]);
    const q16 = floatToPcm([x], 16, { sampleRate: 48000 }); // flat TPDF
    assert(q16[0] === 32767 && q16[1] === -32768 && q16[2] === 32767 && q16[3] === -32768, `16-bit clamps ${Array.from(q16)}`);
    assert(q16[6] === 32767 && q16[7] === -32768 && q16[9] === 32767, 'Inf/huge clamp');
    assert(Math.abs(q16[5]) <= 1 && Math.abs(q16[8]) <= 1, 'NaN → 0 ± dither');
    // lip44: shaped noise rides on full-scale samples, but nothing wraps around
    const qs = floatToPcm([x], 16, { sampleRate: 44100 });
    assert(qs[0] > 32700 && qs[1] < -32700 && qs[2] > 32700 && qs[3] < -32700 && qs[6] > 32700 && qs[7] < -32700 && qs[9] > 32700, `lip44 saturates without wrap ${Array.from(qs)}`);
    assert(Math.abs(qs[5]) < 64 && Math.abs(qs[8]) < 64, 'lip44 NaN → ~0');
    const q24 = floatToPcm([x], 24, { sampleRate: 48000 });
    assert(q24[0] === 8388607 && q24[1] === -8388608 && q24[2] === 8388607 && q24[3] === -8388608, `24-bit clamps ${Array.from(q24)}`);
    const qn = floatToPcm([x], 16, { dither: 'none' });
    assert(qn[0] === 32767 && qn[1] === -32768 && qn[5] === 0 && qn[8] === 0, 'undithered clamps / NaN 0');
    // A clipped burst followed by silence: the ±4 LSB error limit keeps the feedback
    // loop stable, the silence noise is back to normal within a few samples.
    const n = 20000;
    const burst = new Float32Array(n);
    for (let i = 0; i < 2000; i++) burst[i] = i & 1 ? 1.4 : -1.4;
    const qb = floatToPcm([burst], 16, { sampleRate: 44100 });
    const ref = floatToPcm([new Float32Array(n)], 16, { sampleRate: 44100, seed: 99 });
    const rmsOf = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / (e - s)); };
    const after = rmsOf(qb, 2100, n);
    const base = rmsOf(ref, 100, n);
    approx(after / base, 1, 0.1, 'noise after clipping ≈ normal shaped noise');
    let peakAfter = 0;
    for (let i = 2100; i < n; i++) peakAfter = Math.max(peakAfter, Math.abs(qb[i]));
    assert(peakAfter <= 40, `shaped noise bounded (peak ${peakAfter} LSB)`);
    // empty / tiny / multichannel
    assert(floatToPcm([new Float32Array(0), new Float32Array(0)], 16).length === 0, 'empty');
    assert(floatToPcm([], 24).length === 0, 'no channels');
    const tiny = floatToPcm([new Float32Array(10).fill(0.5), new Float32Array(10).fill(-0.5)], 24, { sampleRate: 44100 });
    assert(tiny.length === 20 && tiny instanceof Int32Array, 'tiny 24-bit');
    assert(tiny.every((v, i) => Math.abs(v - (i & 1 ? -4194304 : 4194304)) <= 1), 'tiny values');
    let threw = false;
    try { floatToPcm([x], 20); } catch { threw = true; }
    assert(threw, 'unsupported bit depth throws');
  },

  // -------------------------------------------------------------------------------- wav
  'wav: header layout — tag 1 for 16/24 at any rate, tag 3 + fact for float, data last, even sizes': async () => {
    for (const bitDepth of [16, 24, 32]) {
      for (const nCh of [1, 2]) {
        for (const sr of [44100, 48000, 96000]) {
          for (const frames of [0, 7, 1000]) {
            const channels = Array.from({ length: nCh }, () => sine(100, frames / sr, sr, 0.5).subarray(0, frames));
            const blob = encodeWav({ sampleRate: sr, channels }, { bitDepth });
            assert(blob.type === 'audio/wav', 'blob type');
            const u8 = new Uint8Array(await blob.arrayBuffer());
            const dv = new DataView(u8.buffer);
            const str = (o) => String.fromCharCode(...u8.subarray(o, o + 4));
            assert(str(0) === 'RIFF' && str(8) === 'WAVE' && str(12) === 'fmt ', 'RIFF/WAVE/fmt');
            assert(dv.getUint32(4, true) === u8.length - 8, 'RIFF size');
            const fmtSize = dv.getUint32(16, true);
            const tag = dv.getUint16(20, true);
            const label = `${bitDepth}/${nCh}ch/${sr}/${frames}`;
            if (bitDepth === 32) {
              assert(tag === 3 && fmtSize === 18 && dv.getUint16(36, true) === 0, `float tag 3, fmt 18, cbSize 0 (${label})`);
              assert(str(38) === 'fact' && dv.getUint32(42, true) === 4 && dv.getUint32(46, true) === frames, `fact chunk (${label})`);
            } else {
              assert(tag === 1 && fmtSize === 16, `PCM tag 1 with 16-byte fmt (${label}), got tag ${tag}`);
            }
            assert(dv.getUint16(22, true) === nCh && dv.getUint32(24, true) === sr, 'channels/rate');
            const ba = (nCh * bitDepth) / 8;
            assert(dv.getUint32(28, true) === sr * ba && dv.getUint16(32, true) === ba && dv.getUint16(34, true) === bitDepth, 'byteRate/blockAlign/bits');
            const dataOff = bitDepth === 32 ? 50 : 36;
            assert(str(dataOff) === 'data', `data chunk at ${dataOff}`);
            const dataSize = dv.getUint32(dataOff + 4, true);
            assert(dataSize === frames * ba, 'data size');
            assert(u8.length === dataOff + 8 + dataSize + (dataSize & 1), `data is last, pad byte only if odd (${label})`);
            assert(u8.length % 2 === 0, 'even file size');
          }
        }
      }
    }
  },

  'wav: round trip through ffmpeg (16/24/32f × mono/stereo × 44.1/48/96 kHz)': async () => {
    if (!hasFfmpeg()) return 'skip';
    const report = [];
    for (const sr of [44100, 48000, 96000]) {
      const src = testSignal(sr, 0.5, 0.7);
      for (const nCh of [1, 2]) {
        const channels = src.slice(0, nCh);
        for (const bitDepth of [16, 24, 32]) {
          const path = fx(`rt-${bitDepth}-${nCh}-${sr}.wav`);
          writeFileSync(path, Buffer.from(encodeWavBuffer({ sampleRate: sr, channels }, { bitDepth, seed: 5 })));
          const info = ffInfo(path);
          const codec = bitDepth === 32 ? 'pcm_f32le' : `pcm_s${bitDepth}le`;
          const tagHex = bitDepth === 32 ? '0x0003' : '0x0001';
          assert(info.includes(codec) && info.includes(tagHex), `ffmpeg sees ${codec} ${tagHex}: ${info.split('\n').find((l) => l.includes('Audio:'))}`);
          assert(info.includes(`${sr} Hz`), 'rate');
          const dec = ffDecodeNative(path, nCh);
          // exact layout check: ffmpeg's decode equals our own quantized integers
          const expected = bitDepth === 32 ? null : floatToPcm(channels, bitDepth, { sampleRate: sr, seed: 5 });
          const S = 2 ** (bitDepth - 1);
          for (let c = 0; c < nCh; c++) {
            assert(dec[c].length === channels[c].length, 'length');
            if (expected) {
              let m = 0;
              for (let i = 0; i < dec[c].length; i++) m = Math.max(m, Math.abs(dec[c][i] - expected[i * nCh + c] / S));
              assert(m < 1e-9, `ffmpeg decode == our PCM (${bitDepth}/${nCh}/${sr}): ${m}`);
            }
            // vs source: within quantization + dither (flat TPDF ±1.5 LSB, lip44 shaped ≤ 16 LSB)
            const tolLsb = bitDepth === 32 ? 0 : bitDepth === 16 && sr === 44100 ? 16 : 1.5;
            const tol = bitDepth === 32 ? 1e-7 : tolLsb / S + 1e-9;
            const d = maxAbsDiff(dec[c], channels[c]);
            assert(d <= tol, `round trip error ${d} > ${tol} (${bitDepth}/${nCh}/${sr})`);
          }
        }
      }
      report.push(`${sr} ok`);
    }
    return report.join(', ');
  },

  'wav: parseWav reads back encodeWav exactly; dither=false is plain rounding': async () => {
    const sr = 48000;
    const [L, R] = testSignal(sr, 0.25, 0.8);
    for (const bitDepth of [16, 24, 32]) {
      const buf = encodeWavBuffer({ sampleRate: sr, channels: [L, R] }, { bitDepth, dither: false });
      const p = parseWav(buf);
      assert(p.sampleRate === sr && p.channels.length === 2 && p.bitDepth === bitDepth && p.frames === L.length, 'parse meta');
      const S = 2 ** (bitDepth - 1);
      for (const [a, b] of [[p.channels[0], L], [p.channels[1], R]]) {
        for (let i = 0; i < a.length; i++) {
          const want = bitDepth === 32 ? b[i] : Math.max(-S, Math.min(S - 1, Math.round(b[i] * S))) / S;
          if (Math.abs(a[i] - want) > 1e-9) throw new Error(`${bitDepth}-bit sample ${i}: ${a[i]} vs ${want}`);
        }
      }
    }
    // float keeps > 0 dBFS values and sanitizes NaN/Inf
    const hot = Float32Array.from([1.5, -2, NaN, Infinity, -Infinity, 0.25]);
    const pf = parseWav(encodeWavBuffer({ sampleRate: 44100, channels: [hot, hot] }, { bitDepth: 32 }));
    assert(Array.from(pf.channels[0]).join() === '1.5,-2,0,1,-1,0.25', `float sanitize ${Array.from(pf.channels[0])}`);
    // 10-sample and empty inputs
    const tiny = parseWav(encodeWavBuffer({ sampleRate: 8000, channels: [new Float32Array(10).fill(0.1), new Float32Array(10)] }, { bitDepth: 24 }));
    assert(tiny.frames === 10, 'tiny');
    const empty = parseWav(encodeWavBuffer({ sampleRate: 44100, channels: [new Float32Array(0), new Float32Array(0)] }));
    assert(empty.frames === 0 && empty.channels[0].length === 0, 'empty');
  },

  // ----------------------------------------------------------------------------- parse
  'parseWav: ffmpeg u8/s16/s24/s32/f32/f64/A-law/µ-law match ffmpeg decode bit-exactly': async () => {
    if (!hasFfmpeg()) return 'skip';
    const { path, channels } = sourceWav(44100);
    const out = [];
    for (const [codec, bits, tol] of [['pcm_u8', 8, 1 / 128], ['pcm_s16le', 16, 1 / 32768], ['pcm_s24le', 24, 1 / 8388608], ['pcm_s32le', 32, 1e-9], ['pcm_f32le', 32, 0], ['pcm_f64le', 64, 0], ['pcm_alaw', 8, 0.02], ['pcm_mulaw', 8, 0.02]]) {
      const f = fx(`p-${codec}.wav`);
      ff('-i', path, '-c:a', codec, f);
      const buf = readFileSync(f);
      const p = parseWav(buf); // Node Buffer: a view into a shared pool (byteOffset ≠ 0)
      assert(p.sampleRate === 44100 && p.channels.length === 2 && p.bitDepth === bits, `${codec} meta ${p.bitDepth}`);
      const ref = ffDecodeNative(f, 2);
      for (let c = 0; c < 2; c++) {
        const d = maxAbsDiff(p.channels[c], ref[c]);
        assert(d <= 1e-7, `${codec} vs ffmpeg decode: ${d}`);
        const ds = maxAbsDiff(p.channels[c], channels[c]);
        assert(ds <= tol * 1.0001 + 1e-7 || codec.includes('law'), `${codec} vs source ${ds}`);
      }
      assertFinite(p.channels);
      out.push(codec.replace('pcm_', ''));
    }
    return out.join(' ');
  },

  'parseWav: EXTENSIBLE (24-bit 96 kHz, 5.1 → stereo), RF64, LIST/bext metadata chunks': async () => {
    if (!hasFfmpeg()) return 'skip';
    const { path } = sourceWav(48000);
    // 24-bit / 96 kHz: ffmpeg writes WAVE_FORMAT_EXTENSIBLE
    const ext = fx('ext96.wav');
    ff('-i', path, '-ar', '96000', '-c:a', 'pcm_s24le', ext);
    const eb = readFileSync(ext);
    assert(eb.readUInt16LE(20) === 0xfffe, 'ffmpeg wrote 0xFFFE');
    const pe = parseWav(eb);
    assert(pe.formatTag === 0xfffe && pe.codec === 'pcm_s24le' && pe.sampleRate === 96000 && pe.bitDepth === 24, 'extensible parse');
    const ref = ffDecodeNative(ext, 2);
    assert(maxAbsDiff(pe.channels[0], ref[0]) < 1e-7, 'extensible samples');
    // 5.1 (mask 0x3F) → stereo downmix in decodeFile
    const six = fx('six.wav');
    ff('-i', path, '-af', 'pan=5.1|FL=c0|FR=c1|FC=0.5*c0+0.5*c1|LFE=0.3*c0|BL=0.5*c0|BR=0.5*c1', '-c:a', 'pcm_s16le', six);
    const sb = readFileSync(six);
    const ps = parseWav(sb);
    assert(ps.channels.length === 6 && ps.channelMask === 0x3f, `5.1 parse mask ${ps.channelMask}`);
    const { audio, info } = await decodeFile(namedBlob(sb, 'six.wav'));
    assert(audio.channels.length === 2 && info.decodedChannels === 6, '5.1 → stereo');
    const k = Math.SQRT1_2;
    for (const i of [100, 5000, 30000]) {
      const c = ps.channels;
      approx(audio.channels[0][i], c[0][i] + k * c[2][i] + k * c[4][i], 1e-6, 'L downmix (FL + .707 FC + .707 BL, no LFE)');
      approx(audio.channels[1][i], c[1][i] + k * c[2][i] + k * c[5][i], 1e-6, 'R downmix');
    }
    // RF64 with ds64
    const rf = fx('rf64.wav');
    ff('-i', path, '-c:a', 'pcm_s16le', '-rf64', 'always', rf);
    const rb = readFileSync(rf);
    assert(rb.toString('latin1', 0, 4) === 'RF64', 'RF64 header');
    const pr = parseWav(rb);
    assert(pr.container === 'RF64' && pr.frames === 144000, `RF64 frames ${pr.frames}`);
    assert(maxAbsDiff(pr.channels[1], ffDecodeNative(rf, 2)[1]) < 1e-7, 'RF64 samples');
    // LIST (ffmpeg always writes INFO/ISFT; add a title) and bext before data
    const meta = fx('meta.wav');
    ff('-i', path, '-c:a', 'pcm_s16le', '-metadata', 'title=Canzone è', '-write_bext', '1', meta);
    const mb = readFileSync(meta);
    const sMeta = mb.toString('latin1');
    assert(sMeta.indexOf('LIST') > 0 && sMeta.indexOf('bext') > 0 && sMeta.indexOf('LIST') < sMeta.indexOf('data'), 'LIST/bext before data');
    const pm = parseWav(mb);
    assert(pm.frames === 144000 && maxAbsDiff(pm.channels[0], ffDecodeNative(meta, 2)[0]) < 1e-7, 'metadata chunks skipped');
    assert(sniffFormat(mb).format === 'wav', 'sniff wav with metadata');
  },

  'parseWav: odd chunks, missing pad byte, JUNK/bext, truncated and streamed data sizes': async () => {
    const vals = [0, 1000, -1000, 32767, -32768, 12345];
    const fmt = fmtChunk(1, 2, 44100, 16);
    const data = s16Data(vals);
    const check = (buf, label, frames = 3) => {
      const p = parseWav(buf);
      assert(p.frames === frames, `${label}: frames ${p.frames}`);
      for (let i = 0; i < frames * 2; i++) approx(p.channels[i & 1][i >> 1], vals[i] / 32768, 1e-9, `${label} sample ${i}`);
    };
    check(riff([['JUNK', Buffer.alloc(28)], ['fmt ', fmt], ['odd ', Buffer.from('abc')], ['bext', Buffer.alloc(603)], ['data', data]]), 'odd chunks padded');
    check(riff([['fmt ', fmt], ['odd ', Buffer.from('abc')], ['data', data]], { pad: false }), 'missing pad byte');
    check(riff([['fmt ', fmt], ['data', data], ['LIST', Buffer.from('INFOISFT\x04\0\0\0test')]]), 'trailing LIST');
    // fmt chunk after an 18-byte fmt with cbSize (tag 1 + cbSize 0 is common)
    const fmt18 = Buffer.concat([fmt, Buffer.alloc(2)]);
    check(riff([['fmt ', fmt18], ['data', data]]), '18-byte fmt');
    // data size larger than the file (truncated download): decode what is there
    const trunc = riff([['fmt ', fmt], ['data', data]]);
    trunc.writeUInt32LE(1000000, 40);
    check(trunc, 'truncated');
    // streamed writers: 0xFFFFFFFF or 0 never patched
    const s1 = riff([['fmt ', fmt], ['data', data]]);
    s1.writeUInt32LE(0xffffffff, 40);
    s1.writeUInt32LE(0xffffffff, 4);
    check(s1, 'size 0xFFFFFFFF');
    const s0 = riff([['fmt ', fmt], ['data', data]]);
    s0.writeUInt32LE(0, 40);
    check(s0, 'size 0');
    // partial last frame is ignored
    check(riff([['fmt ', fmt], ['data', Buffer.concat([data, Buffer.from([1, 2, 3])])]]), 'partial frame');
    // a view into a larger buffer with an odd offset (alignment-independent reads)
    const base = riff([['fmt ', fmt], ['data', data]]);
    const big = new Uint8Array(base.length + 3);
    big.set(base, 3);
    check(new Uint8Array(big.buffer, 3, base.length), 'unaligned view');
    // 24-in-32 EXTENSIBLE container (left-justified) and 8-bit
    const fmtExt = Buffer.alloc(40);
    fmtExt.writeUInt16LE(0xfffe, 0); fmtExt.writeUInt16LE(1, 2); fmtExt.writeUInt32LE(48000, 4);
    fmtExt.writeUInt32LE(48000 * 4, 8); fmtExt.writeUInt16LE(4, 12); fmtExt.writeUInt16LE(32, 14);
    fmtExt.writeUInt16LE(22, 16); fmtExt.writeUInt16LE(24, 18); fmtExt.writeUInt32LE(4, 20);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmtExt, 24);
    const d32 = Buffer.alloc(8);
    d32.writeInt32LE(0x40000000, 0); d32.writeInt32LE(-0x80000000, 4);
    const p32 = parseWav(riff([['fmt ', fmtExt], ['data', d32]]));
    assert(p32.bitDepth === 24 && p32.channels[0][0] === 0.5 && p32.channels[0][1] === -1, `24-in-32 ${Array.from(p32.channels[0])} bits ${p32.bitDepth}`);
  },

  'parseWav: errors — not a WAV, no fmt/data, RIFX, ADPCM unsupported, too_long before allocating': async () => {
    expectThrow(() => parseWav(new Uint8Array(4)), 'corrupt');
    expectThrow(() => parseWav(Buffer.from('RIFF\0\0\0\0AVI LIST')), 'corrupt');
    expectThrow(() => parseWav(riff([['data', s16Data([1, 2])]])), 'corrupt');
    expectThrow(() => parseWav(riff([['fmt ', fmtChunk(1, 2, 44100, 16)]])), 'corrupt');
    expectThrow(() => parseWav(riff([['fmt ', fmtChunk(1, 0, 44100, 16)], ['data', s16Data([1, 2])]])), 'corrupt');
    expectThrow(() => parseWav(riff([['fmt ', fmtChunk(1, 2, 44100, 16)], ['data', s16Data([1, 2])]], { id: 'RIFX' })), 'unsupported');
    const adpcm = riff([['fmt ', fmtChunk(2, 2, 44100, 4)], ['data', Buffer.alloc(64)]]);
    const e = expectThrow(() => parseWav(adpcm), 'unsupported');
    assert(e.codec === 'adpcm_ms' && /WAV|FLAC/.test(e.message), `ADPCM message: ${e.message}`);
    assert(sniffFormat(adpcm).supported === false, 'sniff marks unsupported codec');
    // too_long is decided from the header, before the sample arrays are allocated
    const long = riff([['fmt ', fmtChunk(1, 1, 8000, 16)], ['data', Buffer.alloc(8000 * 2 * 3)]]);
    expectThrow(() => parseWav(long, { maxDurationSec: 2 }), 'too_long');
    assert(parseWav(long, { maxDurationSec: 3 }).frames === 24000, 'exactly at the limit is fine');
  },

  'parseAiff: AIFF 16-bit and AIFC 24-bit from ffmpeg match ffmpeg decode': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    for (const [name, sr, bits] of [['aiff', 44100, 16], ['aifc', 48000, 24]]) {
      const buf = readFileSync(c[name]);
      const p = parseAiff(buf);
      assert(p.sampleRate === sr && p.bitDepth === bits && p.channels.length === 2, `${name} meta ${p.sampleRate}/${p.bitDepth}`);
      const ref = ffDecodeNative(c[name], 2);
      assert(maxAbsDiff(p.channels[0], ref[0]) < 1e-7 && maxAbsDiff(p.channels[1], ref[1]) < 1e-7, `${name} samples`);
      const s = sniffFormat(buf);
      assert(s.format === 'other' && s.container === 'aiff' && s.nativeSampleRate === sr, `${name} sniff`);
    }
  },

  // ----------------------------------------------------------------------------- sniff
  'sniffFormat: MP3 CBR/VBR 44.1/48 k, MPEG-2, ID3v2, no Xing, LAME tag delay/padding': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    const s = (k) => sniffFormat(readFileSync(c[k]));
    const cbr = s('cbr44');
    assert(cbr.format === 'mp3' && cbr.codec === 'mp3' && cbr.nativeSampleRate === 44100 && cbr.bitrateKbps === 320 && cbr.vbr === false, `cbr44 ${JSON.stringify(cbr)}`);
    assert(cbr.tag === 'Info' && cbr.hasGaplessInfo && cbr.encoderDelay === 576, 'Info tag + LAME delay');
    assert(cbr.totalSamples === 132300 && Math.abs(cbr.duration - 3) < 1e-9, `gapless length ${cbr.totalSamples}`);
    const cbr48 = s('cbr48');
    assert(cbr48.nativeSampleRate === 48000 && cbr48.bitrateKbps === 192 && !cbr48.vbr && cbr48.totalSamples === 144000, 'cbr48');
    for (const [k, sr] of [['vbr48', 48000], ['vbr44', 44100]]) {
      const v = s(k);
      assert(v.nativeSampleRate === sr && v.vbr === true && v.tag === 'Xing' && v.totalSamples === sr * 3, `${k} ${JSON.stringify(v)}`);
      assert(v.bitrateKbps > 8 && v.bitrateKbps < 320, 'VBR average bitrate');
    }
    const m2 = s('mpeg2');
    assert(m2.nativeSampleRate === 22050 && m2.mpegVersion === 2 && m2.samplesPerFrame === 576 && m2.totalSamples === 66150, `mpeg2 ${JSON.stringify(m2)}`);
    const id3 = s('id3');
    assert(id3.nativeSampleRate === 44100 && id3.firstFrameOffset > 45 && id3.totalSamples === 132300, 'ID3v2 skipped');
    const nx = s('noxing');
    assert(nx.tag === null && !nx.hasGaplessInfo && nx.frames * 1152 === nx.totalSamples && nx.vbr === false && nx.bitrateKbps === 192, `no Xing ${JSON.stringify(nx)}`);
    if (c.lamet44100) {
      const lt = sniffFormat(readFileSync(c.lamet44100));
      assert(lt.firstFrameOffset === 0 && lt.tag === null && lt.bitrateKbps === 320 && lt.frames === 116, `lame -t ${JSON.stringify(lt)}`);
    }
    // frames == decoded length for untagged streams (what the gapless fix relies on)
    const dec = ffmpegDecode(c.noxing);
    assert(dec[0].length === nx.totalSamples, `ffmpeg decodes every frame: ${dec[0].length}`);
  },

  'sniffFormat: M4A AAC / HE-AAC / ALAC / Opus-in-MP4, iTunSMPB (afconvert)': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    const s = (k) => sniffFormat(readFileSync(c[k]));
    const a44 = s('aac44');
    assert(a44.format === 'm4a' && a44.codec === 'aac' && a44.nativeSampleRate === 44100 && a44.mdhdTimescale === 44100 && a44.editMediaTime === 1024, `aac44 ${JSON.stringify(a44)}`);
    assert(a44.bitrateKbps > 150 && a44.bitrateKbps < 260 && a44.channels === 2, 'aac bitrate/channels');
    assert(s('aac48').nativeSampleRate === 48000, 'aac48');
    const al = s('alac');
    assert(al.codec === 'alac' && al.nativeSampleRate === 44100 && al.bitDepth > 0 && Math.abs(al.duration - 3) < 1e-6, `alac ${JSON.stringify(al)}`);
    const op = s('opusmp4');
    assert(op.codec === 'opus' && op.nativeSampleRate === 48000 && op.encoderDelay === 312, `opus mp4 ${JSON.stringify(op)}`);
    const out = [];
    if (c.heaac48) {
      // mdhd says 48 kHz, ASC core 24 kHz → prefer mdhd (implicit SBR)
      const he = s('heaac48');
      assert(he.nativeSampleRate === 48000 && he.coreSampleRate === 24000 && he.codec === 'he-aac' && he.sbr, `heaac48 ${JSON.stringify(he)}`);
      out.push('HE-AAC (ffmpeg)');
    }
    if (c.afc) {
      const af = s('afc');
      assert(af.itunSmpb && af.itunSmpb.priming === 2112 && af.itunSmpb.originalSamples === 132300 && af.nativeSampleRate === 44100, `afconvert iTunSMPB ${JSON.stringify(af)}`);
      assert(af.encoderDelay === 2112 && Math.abs(af.duration - 3) < 1e-9, 'iTunSMPB duration');
      out.push('iTunSMPB');
    }
    if (c.afc_he) {
      // Apple writes the 24 kHz core rate everywhere: decode at 2× so SBR is kept
      const ah = s('afc_he');
      assert(ah.nativeSampleRate === 48000 && ah.implicitSbrAssumed && ah.mdhdTimescale === 24000 && ah.itunSmpb.rate === 24000, `afconvert HE ${JSON.stringify(ah)}`);
      out.push('Apple HE-AAC');
    }
    return out.join(', ');
  },

  'sniffFormat: FLAC, Ogg Vorbis/Opus, ADTS, WAV, garbage and tiny buffers': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    const s = (k) => sniffFormat(readFileSync(c[k]));
    const f48 = s('flac48');
    assert(f48.format === 'flac' && f48.nativeSampleRate === 48000 && f48.channels === 2 && f48.totalSamples === 144000 && f48.duration === 3, `flac48 ${JSON.stringify(f48)}`);
    const f96 = s('flac96');
    assert(f96.nativeSampleRate === 96000 && f96.bitDepth >= 24, `flac96 ${JSON.stringify(f96)}`);
    const vb = s('vorbis');
    assert(vb.format === 'ogg' && vb.codec === 'vorbis' && vb.nativeSampleRate === 44100 && Math.abs(vb.duration - 3) < 0.01, `vorbis ${JSON.stringify(vb)}`);
    const op = s('opus');
    assert(op.format === 'ogg' && op.codec === 'opus' && op.nativeSampleRate === 48000 && Number.isFinite(op.inputSampleRate) && op.encoderDelay > 0 && Math.abs(op.duration - 3) < 0.01, `opus ${JSON.stringify(op)}`);
    const ad = s('adts');
    assert(ad.format === 'other' && ad.codec === 'aac' && ad.nativeSampleRate === 44100 && ad.container === 'adts', 'adts');
    const wv = sniffFormat(readFileSync(sourceWav(48000).path));
    assert(wv.format === 'wav' && wv.nativeSampleRate === 48000 && wv.codec === 'pcm_f32le' && wv.duration === 3, 'wav');
    // FLAC with a leading ID3v2 tag
    const id3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a'), Buffer.alloc(10), readFileSync(c.flac48)]);
    assert(sniffFormat(id3).nativeSampleRate === 48000, 'FLAC behind ID3v2');
    // never throws, unknown → other
    const r = rng(9);
    const junk = new Uint8Array(5000).map(() => Math.floor(r() * 256));
    for (const b of [new Uint8Array(0), new Uint8Array(3), new Uint8Array(10), junk, Buffer.from('RIFF....WAVEfmt '), Buffer.from('OggS'), Buffer.from('fLaC'), new ArrayBuffer(16)]) {
      const res = sniffFormat(b);
      assert(res && typeof res.format === 'string', 'returns an object');
    }
    assert(sniffFormat(junk).format === 'other', 'junk is other');
    // truncated files keep their header info
    const half = readFileSync(c.cbr44).subarray(0, 20000);
    const th = sniffFormat(half);
    assert(th.format === 'mp3' && th.nativeSampleRate === 44100, 'truncated mp3');
    const mh = sniffFormat(readFileSync(c.aac44).subarray(0, 2000));
    assert(mh.format === 'm4a', 'truncated m4a still m4a');
  },

  // ------------------------------------------------------------------------ decodeFile
  'decodeFile: WAV/AIFF via the JS parser → stereo AudioData + complete info': async () => {
    const sr = 48000;
    const mono = sine(1000, 0.5, sr, 0.5);
    const wav = encodeWavBuffer({ sampleRate: sr, channels: [mono] }, { bitDepth: 16, dither: false });
    const { audio, info } = await decodeFile(namedBlob(new Uint8Array(wav), 'My Song (v2).WAV'));
    assert(audio.sampleRate === sr && audio.channels.length === 2, 'stereo');
    assert(audio.channels[0] !== audio.channels[1], 'mono duplicated into distinct arrays');
    assert(audio.channels[0].every((v, i) => v === audio.channels[1][i]), 'L == R');
    const want = {
      name: 'My Song (v2).WAV', baseName: 'My Song (v2)', ext: 'wav', format: 'wav', codec: 'pcm_s16le', sampleRate: sr,
      nativeSampleRate: sr, decodedChannels: 1, bitDepth: 16, bitrateKbps: null, lossy: false, decoder: 'js', sizeBytes: wav.byteLength,
    };
    for (const [k, v] of Object.entries(want)) assert(info[k] === v, `info.${k}: ${info[k]} vs ${v}`);
    approx(info.duration, 0.5, 1e-9, 'duration');
    // Blob without name, 10-sample file
    const tiny = encodeWavBuffer({ sampleRate: 44100, channels: [new Float32Array(10).fill(0.5), new Float32Array(10)] }, { bitDepth: 24 });
    const t = await decodeFile(new Blob([tiny]));
    assert(t.info.name === 'audio' && t.audio.channels[0].length === 10, 'tiny, unnamed');
    assertFinite(t.audio.channels);
    if (hasFfmpeg()) {
      const c = makeCompressed();
      const a = await decodeFile(namedBlob(readFileSync(c.aiff), 'x.aiff'));
      assert(a.info.format === 'other' && a.info.codec === 'pcm_s16be' && a.info.decoder === 'js' && a.audio.sampleRate === 44100, 'AIFF decoded in JS');
    }
  },

  'decodeFile: browser path decodes at the native rate; untagged MP3 delay trimmed (Chromium & WebKit)': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    const report = [];
    // Chromium-like decoder (FFmpeg). Tagged MP3: browser already exact → untouched.
    let m = mockOfflineContext((b, r) => fakeAudioBuffer(ffmpegLikeDecode(b, r), r));
    try {
      const t = await decodeFile(namedBlob(readFileSync(c.cbr44), 'song.mp3'));
      assert(m.rates[0] === 44100, `context at native rate (${m.rates})`);
      assert(t.audio.channels[0].length === 132300 && impulseAt(t.audio.channels[0]) === 44100, 'tagged: exact');
      assert(t.info.gapless.method === 'browser' && t.info.lossy && t.info.bitrateKbps === 320 && t.info.format === 'mp3' && t.info.decoder === 'webaudio', `tagged info ${JSON.stringify(t.info)}`);
      // Untagged: decoders output every frame + 1105 samples of delay → trimmed.
      const u = await decodeFile(namedBlob(readFileSync(c.noxing), 'untagged.mp3'));
      const at = impulseAt(u.audio.channels[0]);
      assert(Math.abs(at - 44100) <= 1, `untagged impulse at ${at}`);
      assert(u.info.gapless.method === 'mp3-delay' && u.info.gapless.trimmedStart === 1105, JSON.stringify(u.info.gapless));
      report.push(`Chromium untagged → impulse ${at}`);
      // 48 kHz VBR + Opus (48 k) + FLAC: context rate == header rate
      for (const [k, rate] of [['vbr48', 48000], ['opus', 48000], ['flac48', 48000], ['vorbis', 44100], ['aac48', 48000]]) {
        m.rates.length = 0;
        const d = await decodeFile(namedBlob(readFileSync(c[k]), `x.${k}`));
        assert(m.rates[0] === rate && d.audio.sampleRate === rate && !d.info.resampledByBrowser, `${k} decoded at ${m.rates[0]}`);
      }
      const fl = await decodeFile(namedBlob(readFileSync(c.flac48), 'x.flac'));
      assert(fl.info.bitDepth === 24 && fl.info.lossy === false && fl.info.bitrateKbps === null, 'flac info');
    } finally {
      m.restore();
    }
    // WebKit (CoreAudio) removes the 529-sample decoder delay but not LAME's 576.
    m = mockOfflineContext((b, r) => {
      const [L, R] = ffmpegLikeDecode(b, r);
      const sh = (ch) => { const o = new Float32Array(ch.length); o.set(ch.subarray(529)); return o; };
      return fakeAudioBuffer([sh(L), sh(R)], r);
    });
    try {
      await withNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15', async () => {
        const u = await decodeFile(namedBlob(readFileSync(c.noxing), 'untagged.mp3'));
        const at = impulseAt(u.audio.channels[0]);
        assert(Math.abs(at - 44100) <= 1 && u.info.gapless.trimmedStart === 576, `WebKit untagged impulse ${at}`);
        report.push(`WebKit untagged → impulse ${at}`);
      });
    } finally {
      m.restore();
    }
    // A browser that ignores the LAME tag (Firefox < 83): we apply delay/padding ourselves.
    m = mockOfflineContext((b, r) => {
      const [L, R] = ffmpegLikeDecode(b, r);
      const raw = (ch) => { const o = new Float32Array(116 * 1152); o.set(ch, 576 + 529); return o; };
      return fakeAudioBuffer([raw(L), raw(R)], r);
    });
    try {
      const t = await decodeFile(namedBlob(readFileSync(c.cbr44), 'song.mp3'));
      assert(t.audio.channels[0].length === 132300 && impulseAt(t.audio.channels[0]) === 44100 && t.info.gapless.method === 'lame-tag', `LAME tag applied ${JSON.stringify(t.info.gapless)}`);
    } finally {
      m.restore();
    }
    return report.join(', ');
  },

  'decodeFile: M4A iTunSMPB trimmed when the browser ignored it (Firefox); Apple HE-AAC decoded at 2×': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    if (!c.afc) return 'skip';
    const bytes = readFileSync(c.afc);
    const report = [];
    // FFmpeg trims the priming but leaves the padding tail; Firefox leaves both.
    for (const [label, prependPriming] of [['ffmpeg-like', false], ['firefox-like', true]]) {
      const m = mockOfflineContext((b, r) => {
        let [L, R] = ffmpegLikeDecode(b, r);
        if (prependPriming) {
          const pre = (ch) => { const o = new Float32Array(ch.length + 2112); o.set(ch, 2112); return o; };
          L = pre(L);
          R = pre(R);
        }
        return fakeAudioBuffer([L, R], r);
      });
      try {
        const d = await decodeFile(namedBlob(bytes, 'apple.m4a'));
        const at = impulseAt(d.audio.channels[0]);
        assert(d.audio.channels[0].length === 132300 && Math.abs(at - 44100) <= 1, `${label}: len ${d.audio.channels[0].length} impulse ${at}`);
        report.push(`${label} ${d.info.gapless.method}`);
      } finally {
        m.restore();
      }
    }
    if (c.afc_he) {
      const m = mockOfflineContext((b, r) => fakeAudioBuffer(ffmpegLikeDecode(b, r), r));
      try {
        const d = await decodeFile(namedBlob(readFileSync(c.afc_he), 'he.m4a'));
        assert(m.rates[0] === 48000 && d.audio.sampleRate === 48000, `HE-AAC decoded at ${m.rates[0]}`);
        assert(d.audio.channels[0].length === 144000, `HE-AAC trimmed to iTunSMPB length ×2: ${d.audio.channels[0].length}`);
        report.push('HE-AAC @48k');
      } finally {
        m.restore();
      }
    }
    return report.join(', ');
  },

  'decodeFile: errors — ALAC unsupported (suggests WAV/FLAC), no Web Audio, corrupt, empty, too_long': async () => {
    // no Web Audio at all (Node): non-WAV input is 'unsupported'
    const mp3ish = hasFfmpeg() ? readFileSync(makeCompressed().cbr44) : new Uint8Array(100);
    await expectReject(decodeFile(namedBlob(mp3ish, 'a.mp3')), 'unsupported');
    await expectReject(decodeFile(namedBlob(new Uint8Array(0), 'empty.wav')), 'corrupt');
    // > 15 min WAV (3 kHz mono 8-bit keeps the fixture small)
    const sr = 3000;
    const frames = sr * (MAX_DURATION_SEC + 60);
    const long = riff([['fmt ', fmtChunk(1, 1, sr, 8)], ['data', Buffer.alloc(frames, 128)]]);
    const e = await expectReject(decodeFile(namedBlob(long, 'long.wav')), 'too_long');
    assert(/16\.0 min/.test(e.message) && /15 min/.test(e.message), e.message);
    // a corrupt WAV, and a WAV with no samples
    await expectReject(decodeFile(namedBlob(Buffer.from('RIFF\x10\0\0\0WAVEjunkjunkjunk'), 'bad.wav')), 'corrupt');
    await expectReject(decodeFile(namedBlob(riff([['fmt ', fmtChunk(1, 2, 44100, 16)], ['data', Buffer.alloc(0)]]), 'nil.wav')), 'corrupt');
    if (!hasFfmpeg()) return 'partial (no ffmpeg)';
    const c = makeCompressed();
    // Browser decoder that cannot do ALAC (Chrome/Firefox)
    const m = mockOfflineContext((b, r) => {
      const s = sniffFormat(b);
      if (s.codec === 'alac' || s.format === 'other') throw new Error('EncodingError: Unable to decode audio data');
      if (s.format === 'mp3' && b.length < 20000) throw new Error('EncodingError');
      return fakeAudioBuffer(ffmpegLikeDecode(b, r), r);
    });
    try {
      const ea = await expectReject(decodeFile(namedBlob(readFileSync(c.alac), 'lossless.m4a')), 'unsupported');
      assert(ea.codec === 'alac' && /ALAC/.test(ea.message) && /WAV or FLAC/.test(ea.message), ea.message);
      await expectReject(decodeFile(namedBlob(readFileSync(c.cbr44).subarray(0, 10000), 'broken.mp3')), 'corrupt');
      const r = rng(3);
      await expectReject(decodeFile(namedBlob(new Uint8Array(4000).map(() => Math.floor(r() * 256)), 'what.xyz')), 'unsupported');
    } finally {
      m.restore();
    }
  },

  'decodeFile: a codec the browser lacks is unsupported (canPlayType probe), not "damaged"; corrupt stays corrupt': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    // A browser decoder that fails on every compressed file, like Linux Firefox without
    // system AAC (or Chromium without proprietary codecs) fails on AAC: EncodingError.
    const m = mockOfflineContext(() => { throw new Error('EncodingError: Unable to decode audio data'); });
    const prevDoc = globalThis.document;
    const asked = [];
    let canPlay = () => '';
    globalThis.document = { createElement: (tag) => ({ tag, canPlayType: (mime) => { asked.push(mime); return canPlay(mime); } }) };
    try {
      // a valid AAC M4A in a browser without AAC → unsupported (reason codec), MP3/WAV hint
      const e1 = await expectReject(decodeFile(namedBlob(readFileSync(c.aac44), 'Notte di luglio.m4a')), 'unsupported');
      assert(e1.reason === 'codec' && e1.codec === 'aac' && e1.codecLabel === 'AAC' && /MP3 or WAV/.test(e1.message), `${e1.reason} ${e1.codec} ${e1.message}`);
      assert(asked.at(-1) === 'audio/mp4; codecs="mp4a.40.2"', `probed ${asked.at(-1)}`);
      // the browser has the codec → the file itself is damaged
      canPlay = () => 'probably';
      const e2 = await expectReject(decodeFile(namedBlob(readFileSync(c.aac44), 'song.m4a')), 'corrupt');
      assert(e2.codec === 'aac' && !e2.reason, e2.message);
      // ALAC: unsupported outside Safari (WAV/FLAC hint); in Safari (codec present) a failure is damage
      canPlay = (mime) => (/alac/.test(mime) ? '' : 'probably');
      const e3 = await expectReject(decodeFile(namedBlob(readFileSync(c.alac), 'lossless.m4a')), 'unsupported');
      assert(e3.codec === 'alac' && e3.reason === 'codec' && /WAV or FLAC/.test(e3.message), e3.message);
      assert(asked.at(-1) === 'audio/mp4; codecs="alac"', asked.at(-1));
      canPlay = () => 'maybe';
      await expectReject(decodeFile(namedBlob(readFileSync(c.alac), 'lossless.m4a')), 'corrupt');
      // Opus (Ogg and MP4) and FLAC on a browser without them
      canPlay = () => '';
      for (const [k, mime, hint] of [['opus', 'audio/ogg; codecs="opus"', /MP3 or WAV/], ['opusmp4', 'audio/mp4; codecs="opus"', /MP3 or WAV/], ['flac48', 'audio/flac', /convert the file to WAV\./], ['adts', 'audio/aac', /MP3 or WAV/]]) {
        const e = await expectReject(decodeFile(namedBlob(readFileSync(c[k]), `x.${k}`)), 'unsupported');
        assert(e.reason === 'codec' && asked.at(-1) === mime && hint.test(e.message), `${k}: ${asked.at(-1)} ${e.message}`);
      }
      // header did not parse (truncated before the moov box) → corrupt even if the probe says no
      const n = asked.length;
      const cut = readFileSync(c.aac44).subarray(0, 2000);
      await expectReject(decodeFile(namedBlob(cut, 'cut.m4a')), 'corrupt');
      assert(asked.length === n, 'no probe without a parsed header');
      // unrecognised bytes → unsupported 'format'
      const r = rng(5);
      const e4 = await expectReject(decodeFile(namedBlob(new Uint8Array(3000).map(() => Math.floor(r() * 256)), 'x.m4a')), 'unsupported');
      assert(e4.reason === 'format', e4.reason);
      // WebM Opus is probed as WebM; plain Matroska is never probed (WebKit has no demuxer):
      // its failure is 'unsupported' by the container rule
      const webm = fx('probe-opus.webm');
      if (!existsSync(webm)) ff('-i', sourceWav(48000).path, '-c:a', 'libopus', '-b:a', '96k', webm);
      canPlay = () => 'probably';
      const e5 = await expectReject(decodeFile(namedBlob(readFileSync(webm), 'rec.webm')), 'corrupt');
      assert(asked.at(-1) === 'audio/webm; codecs="opus"' && e5.codec === 'opus', asked.at(-1));
      const mkv = fx('probe-flac.mkv');
      if (!existsSync(mkv)) ff('-i', sourceWav(44100).path, '-c:a', 'flac', mkv);
      const k = asked.length;
      const e6 = await expectReject(decodeFile(namedBlob(readFileSync(mkv), 'x.mkv')), 'unsupported');
      assert(asked.length === k && e6.reason === 'codec' && e6.codec === 'flac', `${e6.message}`);
    } finally {
      m.restore();
      if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
    }
  },

  'sniffFormat: Matroska/WebM (EBML Info duration, codec, rate; live files via the last Cluster) and ADTS duration': async () => {
    if (!hasFfmpeg()) return 'skip';
    const s48 = sourceWav(48000).path;
    const s44 = sourceWav(44100).path;
    const make = (name, args) => {
      const out = fx(name);
      if (!existsSync(out)) ff(...args, out);
      return readFileSync(out);
    };
    const wo = sniffFormat(make('c-opus.webm', ['-i', s48, '-c:a', 'libopus', '-b:a', '96k']));
    assert(wo.container === 'webm' && wo.codec === 'opus' && wo.nativeSampleRate === 48000 && wo.channels === 2 && Math.abs(wo.duration - 3) < 0.03 && wo.bitrateKbps > 50, `webm opus ${JSON.stringify(wo)}`);
    const mf = sniffFormat(make('c-flac.mkv', ['-i', s44, '-c:a', 'flac']));
    assert(mf.container === 'matroska' && mf.codec === 'flac' && mf.nativeSampleRate === 44100 && Math.abs(mf.duration - 3) < 0.03 && mf.bitrateKbps === null, `mkv flac ${JSON.stringify(mf)}`);
    const ma = sniffFormat(make('c-aac.mkv', ['-i', s48, '-c:a', 'aac', '-b:a', '128k']));
    assert(ma.codec === 'aac' && ma.nativeSampleRate === 48000 && Math.abs(ma.duration - 3) < 0.05, `mkv aac ${JSON.stringify(ma)}`);
    // Written to a pipe (like MediaRecorder): no Duration, unknown sizes → last Cluster time
    const livePath = fx('c-live.webm');
    if (!existsSync(livePath)) {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12:sample_rate=48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'pipe:1'], { maxBuffer: 1 << 26 });
      assert(r.status === 0 && r.stdout.length > 1000, 'live webm written');
      writeFileSync(livePath, r.stdout);
    }
    const lv = sniffFormat(readFileSync(livePath));
    assert(lv.codec === 'opus' && lv.duration === null && lv.durationMin >= 5 && lv.durationMin <= 12, `live webm ${JSON.stringify(lv)}`);
    // truncated / garbage EBML never throws
    for (const b of [readFileSync(livePath).subarray(0, 60), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0xff])]) assert(sniffFormat(b).format === 'other', 'truncated EBML');
    // ADTS: frame walk gives the duration the length cap needs
    const ad = sniffFormat(readFileSync(makeCompressed().adts));
    assert(Math.abs(ad.duration - 3) < 0.05 && ad.bitrateKbps > 50, `adts ${JSON.stringify(ad)}`);
  },

  'decodeFile: length cap checked BEFORE decoding for every container (WebM/MKV/ADTS/MP3/M4A/FLAC/Ogg, size bound); device cap': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    let decodes = 0;
    const m = mockOfflineContext((b, r) => { decodes++; return fakeAudioBuffer(ffmpegLikeDecode(b, r), r); });
    try {
      // the fixtures are 3 s (12 s live WebM): with a 2 s cap every one must be refused unread
      const files = [['cbr44', 'mp3'], ['aac44', 'm4a'], ['flac48', 'flac'], ['vorbis', 'ogg'], ['opus', 'opus'], ['adts', 'aac'], ['alac', 'm4a']];
      for (const [k, ext] of files) {
        const e = await expectReject(decodeFile(namedBlob(readFileSync(c[k]), `x.${ext}`), { maxDurationSec: 2 }), 'too_long');
        assert(e.maxDurationSec === 2 && Math.abs(e.duration - 3) < 0.1 && e.estimated === false, `${k}: ${e.duration} ${e.message}`);
      }
      for (const name of ['c-opus.webm', 'c-flac.mkv']) {
        if (existsSync(fx(name))) await expectReject(decodeFile(namedBlob(readFileSync(fx(name)), name), { maxDurationSec: 2 }), 'too_long');
      }
      const decodesBefore = decodes;
      if (existsSync(fx('c-live.webm'))) {
        const e = await expectReject(decodeFile(namedBlob(readFileSync(fx('c-live.webm')), 'rec.webm'), { maxDurationSec: 4 }), 'too_long');
        assert(e.estimated === true && /at least/.test(e.message), e.message);
      }
      // FLAC whose STREAMINFO has no sample count: size / raw PCM rate is a safe lower bound
      const fl = Buffer.from(readFileSync(c.flac48));
      fl[8 + 13] &= 0xf0; fl.writeUInt32BE(0, 8 + 14);
      assert(sniffFormat(fl).duration === null, 'no total samples');
      const e = await expectReject(decodeFile(namedBlob(fl, 'x.flac'), { maxDurationSec: 1 }), 'too_long');
      assert(e.estimated && e.duration > 1 && e.duration < 3, `bound ${e.duration}`);
      assert(decodes === 0 && decodesBefore === 0, `decodeAudioData ran ${decodes}× for files that were too long`);
      // under the cap (lower bound < real length) it decodes normally
      const ok = await decodeFile(namedBlob(fl, 'x.flac'), { maxDurationSec: 3.5 });
      assert(decodes === 1 && Math.abs(ok.info.duration - 3) < 0.01, 'decoded under the cap');
      if (existsSync(fx('c-opus.webm'))) {
        const w = await decodeFile(namedBlob(readFileSync(fx('c-opus.webm')), 'rec.webm'));
        assert(m.rates.at(-1) === 48000 && w.info.codec === 'opus' && w.info.lossy && Math.abs(w.info.duration - 3) < 0.03, `webm decoded ${JSON.stringify(w.info)}`);
      }
      // default cap stays 15 min
      assert((await decodeFile(namedBlob(readFileSync(c.cbr44), 'x.mp3'))).info.duration === 3, 'default cap');
    } finally {
      m.restore();
    }
    // memory-aware cap for the UI (decodeFile's default stays MAX_DURATION_SEC)
    assert(MAX_DURATION_SEC === 900 && LOW_MEMORY_MAX_DURATION_SEC === 600, 'caps');
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';
    assert(deviceMaxDurationSec({ userAgent: mac, maxTouchPoints: 0 }) === 900, 'desktop Safari');
    assert(deviceMaxDurationSec({ userAgent: mac, maxTouchPoints: 5 }) === 600, 'iPadOS (Mac UA + touch)');
    assert(deviceMaxDurationSec({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)' }) === 600, 'iPhone');
    assert(deviceMaxDurationSec({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', deviceMemory: 8 }) === 600, 'Android');
    assert(deviceMaxDurationSec({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', deviceMemory: 4 }) === 600, '4 GB laptop');
    assert(deviceMaxDurationSec({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', deviceMemory: 8 }) === 900, '8 GB desktop');
    assert(deviceMaxDurationSec(undefined) === 900 && deviceMaxDurationSec(null) === 900, 'no navigator');
  },

  'decodeFile: decodeAudioData gets the file bytes without a copy; only the gapless-trimmed range is copied out': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    const bytes = readFileSync(c.noxing); // untagged MP3: 1105 samples of decoder delay are trimmed
    const fileBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const file = { name: 'untagged.mp3', size: fileBuf.byteLength, arrayBuffer: async () => fileBuf };
    const prev = globalThis.OfflineAudioContext;
    const seen = { inputs: [], copies: [], getChannelData: 0 };
    globalThis.OfflineAudioContext = class {
      constructor(o) { this.sampleRate = o.sampleRate; }
      decodeAudioData(ab) {
        seen.inputs.push(ab);
        const chans = ffmpegLikeDecode(new Uint8Array(ab), this.sampleRate);
        structuredClone(ab, { transfer: [ab] }); // detach, as Chrome/Firefox do
        const fake = fakeAudioBuffer(chans, this.sampleRate);
        return Promise.resolve({
          ...fake,
          copyFromChannel(dst, ch, start = 0) { seen.copies.push({ ch, start, n: dst.length }); fake.copyFromChannel(dst, ch, start); },
          getChannelData(ch) { seen.getChannelData++; return fake.getChannelData(ch); },
        });
      }
    };
    try {
      const d = await decodeFile(file);
      assert(seen.inputs.length === 1 && seen.inputs[0] === fileBuf && fileBuf.byteLength === 0, 'the file buffer itself was handed over (and detached)');
      const L = d.audio.channels[0].length;
      assert(seen.copies.length === 2 && seen.copies.every((k) => k.start === 1105 && k.n === L) && seen.getChannelData === 0, `copies ${JSON.stringify(seen.copies)}`);
      assert(d.info.gapless.trimmedStart === 1105 && Math.abs(impulseAt(d.audio.channels[0]) - 44100) <= 1, 'trim + alignment intact');
    } finally {
      if (prev) globalThis.OfflineAudioContext = prev; else delete globalThis.OfflineAudioContext;
    }
  },

  // ------------------------------------------------------------------------------- mp3
  'mp3: _toInt16Chunks — 1152·N blocks, TPDF continuity, mono, tiny and empty input': async () => {
    const [L, R] = testSignal(44100, 1, 0.5);
    const n = L.length;
    const ref = floatToPcm([L, R], 16, { sampleRate: 44100, noiseShaping: 'none', seed: 3 });
    let seen = 0;
    let blocks = 0;
    for (const ch of _toInt16Chunks([L, R], { chunkFrames: 1152 * 4, seed: 3 })) {
      assert(ch.start === seen && ch.left.length === ch.end - ch.start && ch.right.length === ch.left.length, 'contiguous');
      if (ch.end < n) assert(ch.left.length === 1152 * 4, 'full blocks are 1152·N');
      assert(ch.left instanceof Int16Array, 'Int16');
      for (let i = 0; i < ch.left.length; i++) {
        if (ch.left[i] !== ref[2 * (ch.start + i)] || ch.right[i] !== ref[2 * (ch.start + i) + 1]) throw new Error(`sample ${ch.start + i} differs from one-shot flat TPDF`);
      }
      seen = ch.end;
      blocks++;
    }
    assert(seen === n && blocks === Math.ceil(n / 4608), 'all samples, block count');
    // odd chunk sizes are rounded to frames
    const first = _toInt16Chunks([L, R], { chunkFrames: 5000 }).next().value;
    assert(first.left.length === 4608, `rounded to 1152·N: ${first.left.length}`);
    // mono → both sides, tiny, empty
    const mono = Array.from(_toInt16Chunks([new Float32Array(10).fill(0.5)]));
    assert(mono.length === 1 && mono[0].left.length === 10 && mono[0].right.every((v) => Math.abs(v - 16384) <= 1), 'mono tiny');
    assert(Array.from(_toInt16Chunks([new Float32Array(0), new Float32Array(0)])).length === 0, 'empty');
    assert(Array.from(_toInt16Chunks([])).length === 0, 'no channels');
  },

  'mp3: Info/LAME tag makes lamejs-style (tag-less) streams decode sample-exact in ffmpeg': async () => {
    if (!hasFfmpeg()) return 'skip';
    const c = makeCompressed();
    if (!c.lamet44100) return 'skip';
    const out = [];
    for (const sr of [44100, 48000]) {
      const raw = new Uint8Array(readFileSync(c[`lamet${sr}`]));
      const n = 3 * sr;
      const src = sourceWav(sr).channels[0].subarray(0, 2 * sr);
      const untagged = ffmpegDecode(c[`lamet${sr}`]);
      const lagU = bestLag(src, untagged[0].subarray(0, 2 * sr), 1500);
      assert(lagU === 1105, `untagged decode is late by 1105 (${lagU})`);
      const tag = _buildInfoFrame(raw, n);
      assert(tag && tag.length === Math.floor((144000 * 320) / sr), 'Info frame at the stream bitrate');
      const path = fx(`tagged${sr}.mp3`);
      writeFileSync(path, Buffer.concat([Buffer.from(tag), Buffer.from(raw)]));
      const dec = ffmpegDecode(path);
      assert(dec[0].length === n, `tagged decode length ${dec[0].length} vs ${n}`);
      const lagT = bestLag(src, dec[0].subarray(0, 2 * sr), 1500);
      assert(lagT === 0 && Math.abs(impulseAt(dec[0]) - sr) <= 1, `tagged lag ${lagT}, impulse at ${impulseAt(dec[0])}`);
      const warn = spawnSync('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      assert(!/crc|error|invalid/i.test(warn), `ffmpeg warnings: ${warn}`);
      const s = sniffFormat(readFileSync(path));
      assert(s.tag === 'Info' && s.encoderDelay === 576 && s.totalSamples === n && s.encoder.startsWith('LAME') && s.bitrateKbps === 320, `sniff tagged ${JSON.stringify(s)}`);
      out.push(`${sr}: ${dec[0].length} samples, lag ${lagT} (untagged ${lagU})`);
    }
    // not an MPEG-1 L3 stream / inconsistent length → no tag
    assert(_buildInfoFrame(new Uint8Array(1000), 100) === null, 'garbage → null');
    assert(_buildInfoFrame(new Uint8Array(readFileSync(c.lamet44100)), 10 * 132300) === null, 'impossible padding → null');
    return out.join('; ');
  },

  'mp3: encodeMp3 pipeline with a stub encoder (Int16 input, chunking, progress, flush, gapless, validation)': async () => {
    const calls = { ctor: null, samples: 0, encodes: 0, flushed: 0, int16: true };
    let frameSrc = null; // optional real MP3 frames emitted by the stub
    let emitted = 0;
    const takeFrames = (bytes) => {
      if (!frameSrc) return new Int8Array(bytes > 0 ? 7 : 0);
      const end = Math.min(frameSrc.length, emitted + bytes);
      const out = new Int8Array(frameSrc.buffer, frameSrc.byteOffset + emitted, end - emitted);
      emitted = end;
      return out;
    };
    globalThis.lamejs = {
      Mp3Encoder: class {
        constructor(ch, sr, kbps) { calls.ctor = [ch, sr, kbps]; }
        encodeBuffer(l, r) {
          calls.encodes++;
          calls.samples += l.length;
          if (!(l instanceof Int16Array) || !(r instanceof Int16Array) || l.length !== r.length) calls.int16 = false;
          // ~ bytes lamejs would emit for these samples at the stream bitrate
          return takeFrames(frameSrc ? Math.floor((l.length / 1152) * 1044) : 1);
        }
        flush() { calls.flushed++; return takeFrames(frameSrc ? Infinity : 1); }
      },
    };
    try {
      const sr = 44100;
      const [L, R] = testSignal(sr, 3, 0.5);
      const prog = [];
      const blob = await encodeMp3({ sampleRate: sr, channels: [L, R] }, { onProgress: (f) => prog.push(f) });
      assert(blob.type === 'audio/mpeg', 'mime');
      assert(calls.ctor.join() === `2,${sr},320`, `Mp3Encoder(2, sr, 320): ${calls.ctor}`);
      assert(calls.samples === L.length && calls.int16 && calls.flushed === 1, `fed ${calls.samples} Int16 samples, flushed`);
      assert(prog[0] === 0 && prog[prog.length - 1] === 1 && prog.every((v, i) => !i || v >= prog[i - 1]), 'progress 0 → 1, monotonic');
      assert(blob.size === calls.encodes * 7 + 7, `stub bytes concatenated (no tag on non-MP3 data): ${blob.size}`);
      // with real frames from `lame -t` the pipeline prepends the gapless tag end to end
      const c = hasFfmpeg() ? makeCompressed() : {};
      if (c.lamet44100) {
        frameSrc = new Uint8Array(readFileSync(c.lamet44100));
        emitted = 0;
        const b2 = await encodeMp3({ sampleRate: sr, channels: [L, R] });
        const path = fx('pipeline.mp3');
        writeFileSync(path, Buffer.from(await b2.arrayBuffer()));
        const dec = ffmpegDecode(path);
        const lag = bestLag(sourceWav(sr).channels[0].subarray(0, 2 * sr), dec[0].subarray(0, 2 * sr), 1500);
        assert(dec[0].length === 3 * sr && lag === 0, `pipeline gapless: ${dec[0].length}, lag ${lag}`);
      }
      await expectReject(encodeMp3({ sampleRate: 96000, channels: [L, R] }), 'unsupported_rate');
      await expectReject(encodeMp3({ sampleRate: 44100, channels: [L, R] }, { kbps: 330 }), 'unsupported_bitrate');
      // cancellation between slices
      frameSrc = null;
      const big = testSignal(48000, 30, 0.3);
      await expectReject(encodeMp3({ sampleRate: 48000, channels: big }, { isCancelled: () => true }), 'cancelled');
    } finally {
      delete globalThis.lamejs;
    }
  },

  'mp3: loadLame resolves an existing global (both builds) and rejects cleanly without a DOM': async () => {
    assert(LAME_URL === 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js', 'pinned primary URL');
    assert(LAME_FALLBACK_URL === 'https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.iife.js', 'pinned fallback URL');
    class Enc {}
    // cdnjs build: global function with Mp3Encoder property
    const fnGlobal = Object.assign(function lamejs() {}, { Mp3Encoder: Enc });
    globalThis.lamejs = fnGlobal;
    assert((await loadLame()) === fnGlobal, 'function global');
    // module-shaped global with default export
    globalThis.lamejs = { default: { Mp3Encoder: Enc } };
    assert((await loadLame()).Mp3Encoder === Enc, 'default export');
    delete globalThis.lamejs;
    const e = await expectReject(loadLame(), 'mp3_load');
    assert(/MP3 encoder/.test(e.message), e.message);
    // failure is not cached: a later global is picked up
    globalThis.lamejs = { Mp3Encoder: Enc };
    assert((await loadLame()).Mp3Encoder === Enc, 'retry after failure');
    delete globalThis.lamejs;
  },

  'mp3: loadLame injects the pinned CDN scripts with SRI, falls back to the second, then fails with mp3_load': async () => {
    assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(LAME_INTEGRITY) && /^sha384-[A-Za-z0-9+/]{64}$/.test(LAME_FALLBACK_INTEGRITY), 'SRI hashes');
    class Enc {}
    const injected = [];
    let behaviour = () => 'error';
    const prevDoc = globalThis.document;
    globalThis.document = {
      createElement: () => ({ remove() {} }),
      head: {
        appendChild(s) {
          injected.push({ src: s.src, integrity: s.integrity, crossOrigin: s.crossOrigin, referrerPolicy: s.referrerPolicy });
          const what = behaviour(s.src);
          if (what === 'fallback-ok') globalThis.lamejs = { Mp3Encoder: Enc }; // IIFE build shape
          queueMicrotask(() => (what === 'error' ? s.onerror() : s.onload()));
        },
      },
    };
    try {
      // primary blocked (offline / CSP / SRI mismatch) → jsdelivr fallback works
      behaviour = (src) => (src === LAME_URL ? 'error' : 'fallback-ok');
      assert((await loadLame()).Mp3Encoder === Enc, 'fallback build used');
      assert(injected.length === 2 && injected[0].src === LAME_URL && injected[1].src === LAME_FALLBACK_URL, JSON.stringify(injected));
      assert(injected[0].integrity === LAME_INTEGRITY && injected[1].integrity === LAME_FALLBACK_INTEGRITY, 'integrity set');
      assert(injected.every((s) => s.crossOrigin === 'anonymous' && s.referrerPolicy === 'no-referrer'), 'CORS fetch, no referrer');
      delete globalThis.lamejs;
      // both load but define nothing usable, then both fail: a clear mp3_load error
      injected.length = 0;
      behaviour = () => 'load-empty';
      const e1 = await expectReject(loadLame(), 'mp3_load');
      assert(/did not define lamejs/.test(e1.message) && injected.length === 2, e1.message);
      behaviour = () => 'error';
      const e2 = await expectReject(loadLame(), 'mp3_load');
      assert(/failed to load/.test(e2.message) && /export WAV/.test(e2.message), e2.message);
    } finally {
      delete globalThis.lamejs;
      if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
    }
  },

  // ------------------------------------------------------------------------------- zip
  'zip: CRC-32 reference vectors': async () => {
    const enc = new TextEncoder();
    assert(crc32(enc.encode('123456789')) === 0xcbf43926, 'check value');
    assert(crc32(new Uint8Array(0)) === 0, 'empty');
    assert(crc32(enc.encode('The quick brown fox jumps over the lazy dog')) === 0x414fa339, 'fox');
    // incremental == one shot, all alignments of the slice-by-4 loop
    const r = rng(5);
    const data = new Uint8Array(1003).map(() => Math.floor(r() * 256));
    const whole = crc32(data);
    for (const cut of [0, 1, 2, 3, 500, 1003]) assert(crc32(data.subarray(cut), crc32(data.subarray(0, cut))) === whole, `split at ${cut}`);
  },

  'zip: unzip -t passes, UTF-8 accented names, unzip -p round trip, DOS date': async () => {
    if (!hasTool('unzip', '-v')) return 'skip';
    const r = rng(11);
    const wav = new Uint8Array(encodeWavBuffer({ sampleRate: 44100, channels: testSignal(44100, 0.3, 0.5) }, { bitDepth: 16 }));
    const files = [
      { name: 'Canzone già mixata – è (master).wav', data: wav },
      { name: 'notes/日本語 ñ.txt', data: 'ciao è così\n' },
      { name: 'empty.bin', data: new Uint8Array(0) },
      { name: 'random.bin', data: new Uint8Array(77777).map(() => Math.floor(r() * 256)).buffer },
      { name: '../../etc/evil\\path.txt', data: 'x' },
    ];
    const date = new Date(2026, 9, 26, 13, 45, 30);
    const blob = makeZip(files, { date });
    assert(blob.type === 'application/zip', 'mime');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert(bytes.length === makeZipBytes(files, { date }).length && bytes.every((b, i) => b === makeZipBytes(files, { date })[i]), 'Blob == bytes, deterministic');
    const path = fx('test.zip');
    writeFileSync(path, bytes);
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
    const t = spawnSync('unzip', ['-t', path], { encoding: 'utf8', env });
    assert(t.status === 0 && /No errors detected/.test(t.stdout), `unzip -t: ${t.stdout}${t.stderr}`);
    const l = spawnSync('unzip', ['-l', path], { encoding: 'utf8', env }).stdout;
    // (Apple's unzip mangles 3-byte UTF-8 characters in its listing; 2-byte ones show)
    assert(l.includes('Canzone già mixata') && l.includes(' ñ.txt'), `UTF-8 names listed:\n${l}`);
    const py = spawnSync('python3', ['-I', '-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([[i.filename,i.flag_bits,list(i.date_time)] for i in z.infolist()]));print(z.testzip())', path], { encoding: 'utf8' });
    if (py.status === 0) {
      const [names, bad] = py.stdout.trim().split('\n');
      const list = JSON.parse(names);
      assert(list[0][0] === files[0].name && list[1][0] === 'notes/日本語 ñ.txt' && bad === 'None', `python zipfile: ${py.stdout}`);
      assert(list[0][1] & 0x800 && list[0][2].join() === '2026,10,26,13,45,30', 'flags/date via python');
    }
    assert(l.includes('etc/evil/path.txt') && !l.includes('..'), 'path traversal removed');
    assert(/10-26-2026 13:45/.test(l), `DOS date/time:\n${l}`);
    const expectP = (name, data) => {
      const p = spawnSync('unzip', ['-p', path, name], { maxBuffer: 1 << 28, env });
      const want = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      assert(p.status === 0 && Buffer.compare(p.stdout, want) === 0, `unzip -p ${name}`);
    };
    expectP('Canzone già mixata – è (master).wav', wav);
    expectP('notes/日本語 ñ.txt', files[1].data);
    expectP('random.bin', files[3].data);
    expectP('empty.bin', new Uint8Array(0));
    // UTF-8 flag only where needed
    const gp = (off) => bytes[off + 6] | (bytes[off + 7] << 8);
    assert(gp(0) & 0x800, 'bit 11 set for the accented name');
    const ascii = makeZipBytes([{ name: 'a.wav', data: new Uint8Array(3) }]);
    assert(!((ascii[6] | (ascii[7] << 8)) & 0x800), 'bit 11 clear for ASCII');
    // also readable by ffmpeg? the inner WAV parses back from the archive bytes
    const inner = parseWav(bytes.subarray(30 + new TextEncoder().encode(files[0].name).length, 30 + new TextEncoder().encode(files[0].name).length + wav.length));
    assert(inner.frames === Math.round(0.3 * 44100), 'stored data intact');
  },

  'zip: refuses archives of 4 GB or more and more than 65535 entries': async () => {
    const e1 = expectThrow(() => _planZip([{ nameLength: 10, size: 2 ** 32 }]), 'zip_too_large');
    assert(/4 GB/.test(e1.message), e1.message);
    expectThrow(() => _planZip([{ nameLength: 10, size: 2 ** 31 }, { nameLength: 10, size: 2 ** 31 }]), 'zip_too_large');
    const ok = _planZip([{ nameLength: 5, size: 2 ** 31 }, { nameLength: 5, size: 2 ** 30 }]);
    assert(ok.offsets[1] === 35 + 2 ** 31 && ok.total === ok.cdOffset + ok.cdSize + 22, 'layout below the limit');
    const many = Array.from({ length: 65536 }, () => ({ nameLength: 1, size: 0 }));
    expectThrow(() => _planZip(many), 'zip_too_large');
    let threw = false;
    try { makeZip([{ name: 'x', data: new Blob(['a']) }]); } catch (e) { threw = /read Blobs/.test(e.message); }
    assert(threw, 'Blob data rejected with a hint');
  },

  // ------------------------------------------------------------------------------ save
  'save: host saver (wav → zip, declined, fallbacks) and <a download>': async () => {
    const saved = [];
    let mode = 'ok';
    const dl = {
      async save(req) {
        saved.push(req);
        if (mode === 'declined') throw { code: 'declined', message: 'no' };
        if (mode === 'rejected') throw { code: 'rejected_extension', message: 'ext' };
        if (mode === 'busy') throw { code: 'rate_limited', message: 'busy' };
        return { status: 'saved' };
      },
    };
    const clicks = [];
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    globalThis.document = {
      createElement: () => ({ style: {}, click() { clicks.push({ href: this.href, download: this.download }); }, remove() {} }),
      body: { appendChild() {} },
    };
    const prevHost = globalThis.__AM_HOST__;
    const EXT = ['gif', 'png', 'jpg', 'txt', 'json', 'md', 'csv', 'pdf', 'zip'];
    globalThis.__AM_HOST__ = { extensions: EXT, downloads: async () => dl };
    try {
      const wav = encodeWav({ sampleRate: 44100, channels: testSignal(44100, 0.1) }, { bitDepth: 24 });
      let r = await saveBlob(wav, 'Brano è (master).wav');
      assert(r.status === 'saved' && r.filename === 'Brano è (master).zip', JSON.stringify(r));
      const req = saved[0];
      assert(req.filename === 'Brano è (master).zip' && req.data instanceof Blob && req.data.type === 'application/zip', 'zip handed to the host save()');
      if (hasTool('unzip', '-v')) {
        const p = fx('saved.zip');
        writeFileSync(p, Buffer.from(await req.data.arrayBuffer()));
        assert(spawnSync('unzip', ['-t', p]).status === 0, 'saved zip valid');
        const inner = spawnSync('unzip', ['-p', p, 'Brano è (master).wav'], { maxBuffer: 1 << 26, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }).stdout;
        assert(Buffer.compare(inner, Buffer.from(await wav.arrayBuffer())) === 0, 'zip contains the exact WAV');
      }
      r = await saveBlob(new Blob(['{}']), 'report.json');
      assert(r.status === 'saved' && saved[1].filename === 'report.json' && saved[1].data.type !== 'application/zip', 'allowed extension passes as is');
      mode = 'declined';
      r = await saveBlob(wav, 'a.mp3');
      assert(r.status === 'declined' && r.filename === 'a.zip' && r.code === 'declined' && clicks.length === 0, 'declined → no fallback');
      mode = 'busy';
      r = await saveBlob(wav, 'a.wav');
      assert(r.status === 'busy' && r.code === 'rate_limited' && clicks.length === 0, 'rate_limited → busy, no second prompt');
      // Inside a sandboxed host <a download> is blocked silently: falling back used to report
      // 'saved' with no file. Every other outcome is a distinct status, no click.
      mode = 'rejected';
      r = await saveBlob(wav, 'b.wav');
      assert(r.status === 'unavailable' && r.code === 'rejected_extension' && r.filename === 'b.zip' && clicks.length === 0, `rejected_extension → unavailable ${JSON.stringify(r)}`);
      // a host that accepts every extension: the file passes as is
      mode = 'ok';
      globalThis.__AM_HOST__ = { downloads: async () => dl };
      r = await saveBlob(wav, 'open.wav');
      assert(r.status === 'saved' && r.filename === 'open.wav' && saved[saved.length - 1].data === wav, `no extension list → as is ${JSON.stringify(r)}`);
      // a host that cannot save in this view → unavailable, no click
      globalThis.__AM_HOST__ = { extensions: EXT, downloads: async () => null };
      r = await saveBlob(wav, 'c/d:e.wav');
      assert(r.status === 'unavailable' && r.code === 'no_capability' && r.filename === 'c_d_e.wav' && clicks.length === 0, `no capability ${JSON.stringify(r)}`);
      // plain page → <a download>
      delete globalThis.__AM_HOST__;
      r = await saveBlob(wav, 'plain.wav');
      assert(r.status === 'saved' && r.filename === 'plain.wav' && clicks.length === 1 && clicks[0].download === 'plain.wav' && clicks[0].href.startsWith('blob:'), 'plain <a download>');
      // over-long names are capped (some hosts reject long names), extension kept
      r = await saveBlob(wav, `${'è'.repeat(600)}.wav`);
      assert(r.status === 'saved' && r.filename.length === 200 && r.filename.endsWith('è.wav'), `capped name length ${r.filename.length}`);
      // nothing available (worker / Node)
      delete globalThis.document;
      r = await saveBlob(wav, 'x.wav');
      assert(r.status === 'unavailable' && r.code === 'no_dom', 'no DOM → unavailable');
    } finally {
      if (prevWin) globalThis.window = prevWin; else delete globalThis.window;
      if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
      if (prevHost) globalThis.__AM_HOST__ = prevHost; else delete globalThis.__AM_HOST__;
    }
  },

  'save: every host error code maps to a C4 status and never falls back to <a download> inside a host': async () => {
    const clicks = [];
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    globalThis.document = {
      createElement: () => ({ style: {}, click() { clicks.push(this.download); }, remove() {} }),
      body: { appendChild() {} },
    };
    const prevHost = globalThis.__AM_HOST__;
    const extensions = ['json', 'zip'];
    const want = {
      declined: 'declined', rate_limited: 'busy', busy: 'busy', too_large: 'too_large',
      rejected_extension: 'unavailable', unavailable: 'unavailable', forbidden: 'unavailable', host_error: 'unavailable',
      bad_request: 'unavailable', some_future_code: 'unavailable', toString: 'unavailable', constructor: 'unavailable',
    };
    try {
      const blob = new Blob([new Uint8Array(1000)], { type: 'audio/wav' });
      for (const [code, status] of Object.entries(want)) {
        globalThis.__AM_HOST__ = { extensions, downloads: async () => ({ save: async () => { throw { code, message: code }; } }) };
        const r = await saveBlob(blob, 'Notte di luglio (Master).wav');
        assert(r.status === status && r.code === code && r.filename === 'Notte di luglio (Master).zip', `${code} → ${JSON.stringify(r)}`);
      }
      // a rejection without a code (or an Error) is 'unavailable', never 'saved'
      for (const thrown of [undefined, new Error('boom'), 'oops']) {
        globalThis.__AM_HOST__ = { extensions, downloads: async () => ({ save: async () => { throw thrown; } }) };
        const r = await saveBlob(blob, 'x.json');
        assert(r.status === 'unavailable' && typeof r.code === 'string' && r.filename === 'x.json', `codeless rejection ${JSON.stringify(r)}`);
      }
      // downloads() itself rejecting or throwing, or a saver without save(): unavailable
      for (const downloads of [async () => { throw new Error('host'); }, () => { throw new Error('sync'); }, async () => ({})]) {
        globalThis.__AM_HOST__ = { extensions, downloads };
        const r = await saveBlob(blob, 'y.wav');
        assert(r.status === 'unavailable' && r.code === 'no_capability', `broken downloads() ${JSON.stringify(r)}`);
      }
      assert(clicks.length === 0, `<a download> clicked ${clicks.length}× inside a host`);
    } finally {
      if (prevWin) globalThis.window = prevWin; else delete globalThis.window;
      if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
      if (prevHost) globalThis.__AM_HOST__ = prevHost; else delete globalThis.__AM_HOST__;
    }
  },

  'save: probeSaveSupport — host / none (saver null) / browser / none (no DOM), downloads() resolved once': async () => {
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevHost = globalThis.__AM_HOST__;
    try {
      let calls = 0;
      const dl = { save: async () => ({ status: 'saved' }) };
      globalThis.__AM_HOST__ = { downloads: async () => { calls++; return dl; } };
      const p1 = probeSaveSupport();
      const p2 = probeSaveSupport();
      assert((await p1) === 'host' && (await p2) === 'host', 'host');
      const r = await saveBlob(new Blob(['{}']), 'a.json');
      assert(r.status === 'saved' && calls === 1, `downloads() called ${calls}× for two probes and a save`);
      // a host that cannot save in this view (resolves null, possibly after a long wait)
      let resolveUse;
      globalThis.__AM_HOST__ = { downloads: () => { calls++; return new Promise((res) => { resolveUse = res; }); } };
      const pending = probeSaveSupport();
      const save = saveBlob(new Blob(['x']), 'b.wav');
      resolveUse(null);
      assert((await pending) === 'none', 'none inside a host that cannot save');
      const s = await save;
      assert(s.status === 'unavailable' && s.code === 'no_capability' && calls === 2, `save waits for the same answer ${JSON.stringify(s)} ${calls}`);
      // no host
      delete globalThis.__AM_HOST__;
      delete globalThis.window;
      globalThis.document = { createElement: () => ({}), body: {} };
      assert((await probeSaveSupport()) === 'browser', 'browser');
      delete globalThis.document;
      assert((await probeSaveSupport()) === 'none', 'none without a DOM');
    } finally {
      if (prevWin) globalThis.window = prevWin; else delete globalThis.window;
      if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
      if (prevHost) globalThis.__AM_HOST__ = prevHost; else delete globalThis.__AM_HOST__;
    }
  },

  'save: a host that refuses a format even zipped, names without an extension, a late or silent host': async () => {
    const prevHost = globalThis.__AM_HOST__;
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const clicks = [];
    globalThis.document = { createElement: () => ({ style: {}, click() { clicks.push(this.download); }, remove() {} }), body: { appendChild() {} } };
    const saved = [];
    const dl = { save: async (req) => { saved.push(req.filename); } };
    const blob = new Blob([new Uint8Array(100)]);
    try {
      // only WAV: an MP3 cannot be helped by a zip the host refuses too; no prompt is shown
      globalThis.__AM_HOST__ = { extensions: ['wav'], downloads: async () => dl };
      let r = await saveBlob(blob, 'Song (Master).mp3');
      assert(r.status === 'unavailable' && r.code === 'format_not_accepted' && r.filename === 'Song (Master).mp3' && !saved.length, JSON.stringify(r));
      r = await saveBlob(blob, 'AudioMaster (Master).zip');
      assert(r.status === 'unavailable' && r.code === 'format_not_accepted' && !saved.length, `zip not accepted ${JSON.stringify(r)}`);
      r = await saveBlob(blob, 'Song (Master).wav');
      assert(r.status === 'saved' && saved[0] === 'Song (Master).wav', 'wav still saves');
      // a .zip is never zipped again; names without a real extension keep their whole name
      globalThis.__AM_HOST__ = { extensions: ['json', 'zip'], downloads: async () => dl };
      r = await saveBlob(blob, 'AudioMaster (Master).zip');
      assert(r.status === 'saved' && saved[1] === 'AudioMaster (Master).zip', `zip as is ${JSON.stringify(r)}`);
      for (const [name, want] of [['Sig. Notte', 'Sig. Notte.zip'], ['Vol.2 Final', 'Vol.2 Final.zip'], ['Song', 'Song.zip'], ['a.WAV', 'a.zip']]) {
        r = await saveBlob(blob, name);
        assert(r.status === 'saved' && r.filename === want, `${name} → ${r.filename}`);
      }
      // null is not kept: a host whose API arrives after the boot probe is asked again
      let api = null;
      globalThis.__AM_HOST__ = { extensions: ['zip'], downloads: () => api };
      assert((await probeSaveSupport()) === 'none', 'none before the API');
      api = dl;
      assert((await probeSaveSupport()) === 'host', 'host once the API is there');
      // after a null answer a save does not ask again (no second long wait); the probe does
      let calls = 0;
      const slowNull = { extensions: ['zip'], downloads: () => { calls++; return new Promise((res) => setTimeout(() => res(null), 30)); } };
      globalThis.__AM_HOST__ = slowNull;
      assert((await probeSaveSupport()) === 'none' && calls === 1, 'slow null probe');
      r = await saveBlob(blob, 'y.wav');
      assert(r.code === 'no_capability' && calls === 1, `save asked again (${calls})`);
      assert((await probeSaveSupport()) === 'none' && calls === 2, 'the probe asks again');
      // an answer that comes after the timeout is kept for the next probe
      _setHostTimeout(50);
      calls = 0;
      globalThis.__AM_HOST__ = { extensions: ['zip'], downloads: () => { calls++; return new Promise((res) => setTimeout(() => res(dl), 120)); } };
      assert((await probeSaveSupport()) === 'none', 'late host: none at first');
      await new Promise((res) => setTimeout(res, 150));
      assert((await probeSaveSupport()) === 'host' && calls === 1, `late answer kept (calls ${calls})`);
      // a host that never answers counts as one that cannot save
      globalThis.__AM_HOST__ = { extensions: ['zip'], downloads: () => new Promise(() => {}) };
      const t0 = Date.now();
      assert((await probeSaveSupport()) === 'none', 'silent host probe');
      r = await saveBlob(blob, 'x.wav');
      assert(r.status === 'unavailable' && r.code === 'no_capability' && Date.now() - t0 < 2000, `silent host save ${JSON.stringify(r)}`);
      assert(clicks.length === 0, 'no <a download> inside a host');
    } finally {
      _setHostTimeout(null);
      if (prevHost) globalThis.__AM_HOST__ = prevHost; else delete globalThis.__AM_HOST__;
      if (prevWin) globalThis.window = prevWin; else delete globalThis.window;
      if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
    }
  },

  // ---------------------------------------------------------------------------- serve
  'serve: dev-server resolver refuses dotfiles, dot-directories, traversal and bad encodings; loopback Host check': async () => {
    const root = join(TMP, 'serve-root');
    const ok = (p, rel) => {
      const f = resolveRequestPath(root, p);
      assert(f === join(root, rel), `${p} → ${f}`);
    };
    const no = (p) => {
      const f = resolveRequestPath(root, p);
      assert(f === null, `${p} must be refused, got ${f}`);
    };
    ok('/', '');
    ok('/index.html', 'index.html');
    ok('/src/main.js?v=3#x', `src${sep}main.js`);
    ok('/src/ui/styles.css', `src${sep}ui${sep}styles.css`);
    ok('/docs/My%20Notes%20%C3%A8.md', `docs${sep}My Notes è.md`);
    ok('//src//audio///decode.js', `src${sep}audio${sep}decode.js`);
    for (const p of [
      '/.private/song.mp3', '/.vscode/settings.json', '/.git/config', '/.env', '/src/.DS_Store',
      '/%2eprivate/song.mp3', '/%2Evscode/launch.json', '/node_modules/.bin/esbuild',
      '/src/..%2f.private/song.mp3', '/..%2f..%2fetc/passwd', '/..%5c..%5cetc%5cpasswd', '/src/%2e%2e/%2e%2e/etc/passwd',
      '/%00', '/index.html%00.js', '/%E0%A4%A', '/C:/Windows/win.ini', '/src/c:x',
      '/../../etc/passwd', '/src/../../x', '/src/./main.js', '/a\\..\\..\\b', '/%2e%2e/%2e%2e/x', 'http://evil/x',
    ]) no(p);
    for (const h of ['localhost', 'localhost:5173', '127.0.0.1:5173', '127.1.2.3', '[::1]:5173', 'app.localhost:5173', 'LOCALHOST']) assert(isLoopbackHost(h), `loopback ${h}`);
    for (const h of ['evil.com', 'evil.com:5173', '192.168.1.20:5173', 'localhost.evil.com', '127.0.0.1.nip.io', '', undefined]) assert(!isLoopbackHost(h), `not loopback ${h}`);
    // the server module only starts listening when run directly, never on import
    const src = readFileSync(new URL('../tools/serve.mjs', import.meta.url), 'utf8');
    assert(/listen\(port, host/.test(src) && /host = '127\.0\.0\.1'/.test(src), 'binds 127.0.0.1 by default');
  },

  // ---------------------------------------------------------------------------- player
  'player: A/B sync, equal-gain crossfade, loudness match, seek/pause/end, seamless master swap (mock Web Audio)': async () => {
    class Param {
      constructor(v) { this.value = v; this.ev = []; }
      setValueAtTime(v, t) { this.ev.push({ t, v, k: 'set' }); }
      linearRampToValueAtTime(v, t) { this.ev.push({ t, v, k: 'lin' }); }
      cancelScheduledValues(t) { this.ev = this.ev.filter((e) => e.t < t); }
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
    const node = () => ({ connect() {}, disconnect() {} });
    const sources = [];
    class Ctx {
      constructor() { this.currentTime = 0; this.state = 'suspended'; this.destination = node(); Ctx.last = this; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createGain() { return { ...node(), gain: new Param(1) }; }
      createAnalyser() { return { ...node(), fftSize: 2048, smoothingTimeConstant: 0.8 }; }
      createBuffer(n, len, sr) { return { numberOfChannels: n, length: len, sampleRate: sr, duration: len / sr, data: [], copyToChannel(a, c) { this.data[c] = a; } }; }
      createBufferSource() {
        const s = { ...node(), buffer: null, onended: null, start(when, off, dur) { this.started = { when, off, dur }; }, stop(t) { this.stopped = t; } };
        sources.push(s);
        return s;
      }
    }
    const prev = globalThis.AudioContext;
    globalThis.AudioContext = Ctx;
    const ev = { time: [], ended: 0, states: [] };
    const sr = 48000;
    const mk = (sec, v) => ({ sampleRate: sr, channels: [new Float32Array(sec * sr).fill(v), new Float32Array(sec * sr).fill(v)] });
    try {
      const p = new Player({ onTime: (t) => ev.time.push(t), onEnded: () => ev.ended++, onStateChange: (s) => ev.states.push(s) });
      const orig = mk(3, 0.1);
      const mast = mk(2, 0.2); // trimmed master: master timeline is the reference
      p.setTracks(orig, mast);
      assert(p.analyser === null && p.duration === 2 && p.currentTime === 0 && p.source === 'master', 'before play');
      p.setLoudnessMatch(true, -16, -10);
      await p.play();
      const ctx = Ctx.last;
      assert(ctx.state === 'running' && p.playing && p.analyser.fftSize === 8192 && p.analyser.smoothingTimeConstant === 0.75, 'context + analyser');
      const [sm, so] = sources;
      assert(sm.started.when === so.started.when && sm.started.off === 0 && so.started.off === 0, 'sample-synchronous start');
      approx(so.started.dur, 2, 1e-9, 'original cut at the master end');
      ctx.currentTime = 1.0;
      approx(p.currentTime, 1.0 - sm.started.when, 1e-9, 'currentTime = ctx − start + offset');
      // loudness match: only the louder (master, +6 LU) is attenuated
      const n = p._n;
      approx(n.matchMast.gain.at(5), 10 ** (-6 / 20), 1e-9, 'master −6 dB');
      approx(n.matchOrig.gain.at(5), 1, 1e-9, 'original untouched');
      // A/B: 20 ms equal-gain crossfade, both sources keep running. (Was equal-power: the
      // two versions are coherent, so cos/sin gains swelled +3 dB mid-fade;
      // tests/player.test.mjs covers the gain law in detail.)
      p.setSource('original');
      const t0 = 1.0;
      for (const dt of [0, 0.005, 0.01, 0.015, 0.02]) {
        const o = n.abOrig.gain.at(t0 + dt);
        const m = n.abMast.gain.at(t0 + dt);
        approx(o + m, 1, 1e-9, `equal gain at +${dt * 1000} ms`);
      }
      approx(n.abOrig.gain.at(t0 + 0.021), 1, 1e-9, 'original on after 20 ms');
      approx(n.abMast.gain.at(t0 + 0.021), 0, 1e-9, 'master off after 20 ms');
      assert(sources.length === 2, 'A/B did not restart sources');
      // seek while playing: declicked restart, both at the same new offset
      ctx.currentTime = 1.2;
      p.seek(0.5);
      const [nm, no] = sources.slice(2);
      assert(nm.started.off === 0.5 && no.started.off === 0.5 && nm.started.when === no.started.when, 'seek restarts both at 0.5 s');
      assert(sm.stopped > 1.2 && so.stopped > 1.2 && sm.stopped <= nm.started.when, 'old sources stop before the new ones start');
      const tg = n.transport.gain;
      approx(tg.at(sm.stopped), 0, 1e-9, 'silent at the splice');
      approx(tg.at(nm.started.when + 0.02), 1, 1e-9, 'back to unity');
      // replaceMastered (same duration): crossfade old → new at the current position
      ctx.currentTime = 1.5;
      const mast2 = mk(2, 0.3);
      p.replaceMastered(mast2);
      const swap = sources[4];
      approx(swap.started.off, 0.5 + (swap.started.when - nm.started.when), 1e-9, 'new master at the running position');
      approx(nm.stopped, swap.started.when + 0.03, 1e-9, 'old master stops after the 30 ms crossfade');
      assert(sources.length === 5, 'original keeps playing');
      // pause / resume keeps the position
      ctx.currentTime = 1.7;
      p.pause();
      const pos = p.currentTime;
      approx(pos, 0.5 + (1.7 + 0.008 - nm.started.when), 1e-9, 'paused position');
      assert(!p.playing && ev.states[ev.states.length - 1].playing === false, 'state change on pause');
      ctx.currentTime = 3;
      approx(p.currentTime, pos, 1e-12, 'position frozen while paused');
      await p.play();
      const res = sources.slice(5);
      assert(res.every((s) => Math.abs(s.started.off - pos) < 1e-9), 'resumes at the paused position');
      // natural end: the master source ends → onEnded, position = duration
      ctx.currentTime = 10;
      res[0].onended();
      assert(ev.ended === 1 && !p.playing && p.currentTime === 2, 'ended');
      await p.play();
      assert(sources.slice(7).every((s) => s.started.off === 0), 'play after end restarts from 0');
      p.pause();
      // setTracks with a new song (different duration) stops and rewinds
      p.setTracks(mk(4, 0.1), null);
      assert(p.duration === 4 && p.currentTime === 0 && p.source === 'original', 'new song');
      p.setSource('master'); // selection kept, but with no master the original stays audible
      approx(n.abOrig.gain.at(100), 1, 1e-9, 'no master: original audible');
      p.setVolume(0.5);
      approx(n.volume.gain.at(200), 0.5, 1e-9, 'volume');
      p.dispose();
      assert(p.analyser === null, 'disposed');
    } finally {
      if (prev) globalThis.AudioContext = prev; else delete globalThis.AudioContext;
    }
  },

  // ------------------------------------------------------------------------------ perf
  'perf: 3:30 stereo 48 kHz — WAV encode (budget < 1 s), parse, dither, ZIP, MP3 front end': async () => {
    const sr = 48000;
    const n = 210 * sr;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      const nz = (s >>> 8) / 16777216 - 0.5;
      L[i] = 0.4 * Math.sin(i * 0.0571) + 0.2 * nz;
      R[i] = 0.4 * Math.sin(i * 0.0373) - 0.2 * nz;
    }
    const audio = { sampleRate: sr, channels: [L, R] };
    const t = {};
    const [wav24, ms24] = await timed(() => encodeWavBuffer(audio, { bitDepth: 24 }));
    t.wav24 = ms24;
    const [, ms16] = await timed(() => encodeWavBuffer(audio, { bitDepth: 16 }));
    t.wav16 = ms16;
    const [, ms16s] = await timed(() => encodeWavBuffer({ sampleRate: 44100, channels: [L, R] }, { bitDepth: 16 })); // lip44 path (3:48 at 44.1k)
    t.wav16lip44 = ms16s;
    const [, msf] = await timed(() => encodeWavBuffer(audio, { bitDepth: 32 }));
    t.wav32f = msf;
    const [blob, msBlob] = await timed(() => encodeWav(audio, { bitDepth: 24 }));
    t.encodeWavBlob = msBlob;
    assert(blob.size === wav24.byteLength, 'blob size');
    const [p, msParse] = await timed(() => parseWav(wav24));
    t.parseWav24 = msParse;
    assert(p.frames === n, 'parse frames');
    const [, msZip] = await timed(() => makeZipBytes([{ name: 'master.wav', data: new Uint8Array(wav24) }]));
    t.zip = msZip;
    const [, msChunks] = await timed(() => { let k = 0; for (const c of _toInt16Chunks([L, R])) k += c.left.length; return k; });
    t.mp3Int16 = msChunks;
    globalThis.lamejs = { Mp3Encoder: class { encodeBuffer() { return new Int8Array(0); } flush() { return new Int8Array(0); } } };
    try {
      const [, msMp3] = await timed(() => encodeMp3(audio, { gapless: false }));
      t.mp3PipelineNoCodec = msMp3;
    } finally {
      delete globalThis.lamejs;
    }
    const [, msSniff] = await timed(() => sniffFormat(wav24));
    t.sniff = msSniff;
    assert(t.wav24 < 1000 && t.encodeWavBlob < 1000 && t.wav16 < 1000, `WAV encode budget: ${JSON.stringify(t)}`);
    return Object.entries(t).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ');
  },
};
