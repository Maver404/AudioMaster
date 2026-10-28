// Shared test helpers: assertions, deterministic signal generators, WAV writing
// and an ffmpeg bridge used to cross-check loudness/true-peak against a reference.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

export function approx(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg} expected ${expected} ± ${tol}, got ${actual}`);
  }
}

export function assertFinite(channels, msg = 'non-finite sample') {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      if (!Number.isFinite(ch[i])) throw new Error(`${msg} at ${i}: ${ch[i]}`);
    }
  }
}

/** mulberry32 — deterministic PRNG in [0,1). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sine(freq, seconds, sampleRate, amp = 0.5, phase = 0) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i + phase);
  return out;
}

export function whiteNoise(seconds, sampleRate, amp = 0.5, seed = 1) {
  const r = rng(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (2 * r() - 1);
  return out;
}

/** Pink noise (Paul Kellet's refined filter), normalized to the given peak-ish amplitude. */
export function pinkNoise(seconds, sampleRate, amp = 0.5, seed = 1) {
  const r = rng(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = 2 * r() - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * amp;
    b6 = w * 0.115926;
  }
  return out;
}

/** Logarithmic sine sweep. */
export function sweep(f0, f1, seconds, sampleRate, amp = 0.5) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const k = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = amp * Math.sin(((2 * Math.PI * f0 * seconds) / k) * (Math.exp((t / seconds) * k) - 1));
  }
  return out;
}

export function impulse(length, at = 0, amp = 1) {
  const out = new Float32Array(length);
  out[at] = amp;
  return out;
}

export function stereo(l, r = l) {
  return [Float32Array.from(l), Float32Array.from(r)];
}

export function peak(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
}

export function rms(buf, start = 0, end = buf.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function db(x) {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

/** Max |a-b| over the overlapping range. */
export function maxDiff(a, b, start = 0, end = Math.min(a.length, b.length)) {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Lag (in samples, within ±maxLag) maximizing cross-correlation of b against a. */
export function bestLag(a, b, maxLag = 2048) {
  let best = 0;
  let bestVal = -Infinity;
  const n = Math.min(a.length, b.length);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = Math.max(0, -lag); i < n && i + lag < n; i += 4) s += a[i] * b[i + lag];
    if (s > bestVal) {
      bestVal = s;
      best = lag;
    }
  }
  return best;
}

export const TMP = join(tmpdir(), 'audiomaster-tests');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

/** Minimal float32 WAV writer for test fixtures (independent of src/export/wav.js). */
export function writeWavFloat(path, channels, sampleRate) {
  const nCh = channels.length;
  const n = channels[0].length;
  const dataBytes = n * nCh * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(nCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nCh * 4, 28);
  buf.writeUInt16LE(nCh * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      buf.writeFloatLE(channels[c][i], o);
      o += 4;
    }
  }
  writeFileSync(path, buf);
  return path;
}

let ffmpegAvailable = null;
export function hasFfmpeg() {
  if (ffmpegAvailable === null) {
    ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return ffmpegAvailable;
}

export function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-nostats', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Reference loudness via ffmpeg's ebur128 filter.
 * → { integrated, lra, truePeakDb } (truePeakDb = max over channels, dBFS/dBTP)
 */
export function ffmpegLoudness(path) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = res.stderr;
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const num = (re) => {
    const m = summary.match(re);
    return m ? parseFloat(m[1]) : NaN;
  };
  return {
    integrated: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+)\s+LU/),
    truePeakDb: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
  };
}

/** Decode any file to float32 stereo via ffmpeg (for round-trip tests). */
export function ffmpegDecode(path, sampleRate) {
  const args = ['-hide_banner', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2'];
  if (sampleRate) args.push('-ar', String(sampleRate));
  args.push('-');
  const res = spawnSync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 1024 });
  const b = res.stdout;
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const n = f.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = f[2 * i];
    R[i] = f[2 * i + 1];
  }
  return [L, R];
}

/** Time a function, returns [result, ms]. */
export async function timed(fn) {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

/**
 * x64 Node on Apple silicon runs under Rosetta 2: JIT-heavy DSP runs ≈1.6× slower than
 * native while the reference loop below barely slows down (measured on an M1 Pro).
 */
export const ROSETTA = process.arch === 'x64' && /Apple/.test((cpus()[0] || {}).model || '');

let hostFactor = null;
/**
 * Host speed factor vs the ARCHITECTURE §8 reference (Apple M1 P-core): a dependent
 * float-add chain runs at 3 cycles/iteration = 0.94 ns at 3.2 GHz there, times the Rosetta
 * correction. Budgets are asserted as budget × factor; raw times are always reported.
 */
export function speedFactor() {
  if (hostFactor !== null) return hostFactor;
  let best = Infinity;
  for (let r = 0; r < 4; r++) {
    let s = 0;
    const t0 = performance.now();
    for (let i = 0; i < 2e7; i++) s += i * 1e-9;
    best = Math.min(best, performance.now() - t0);
    if (s < 0) throw new Error('unreachable');
  }
  hostFactor = Math.min(3, Math.max(1, best / (2e7 * 0.94e-6))) * (ROSETTA ? 1.6 : 1);
  return hostFactor;
}
