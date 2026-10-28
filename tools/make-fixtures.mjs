#!/usr/bin/env node
// Deterministic audio fixtures for the test suite (Node only).
//
//   node tools/make-fixtures.mjs [--force]      → prints the JSON manifest
//   import { makeFixtures } from '../tools/make-fixtures.mjs'; const m = await makeFixtures();
//
// Writes into join(helpers.TMP, 'fixtures'):
//   32-bit float WAV sources (pure JS, always):
//     demo-defects   the demo song with every baked-in AI-generator defect (48 kHz, 32 s)
//     demo-clean     the same song rendered clean (48 kHz, 32 s)
//     pink-noise     10 s stereo pink noise (independent L/R), ≈ −20 dBFS RMS
//     sine-sweep     10 s log sweep 20 Hz → 20 kHz, −6 dBFS, dual mono
//   ffmpeg transcodes of demo-defects (only when ffmpeg and the encoder are available):
//     demo-wav16-44k  WAV PCM 16-bit 44.1 kHz (swr resampler, triangular dither)
//     demo-wav24-48k  WAV PCM 24-bit 48 kHz
//     demo-mp3-320    MP3 320 kbps CBR 48 kHz (libmp3lame)
//     demo-mp3-v0     MP3 VBR V0 44.1 kHz (libmp3lame)
//     demo-aac-256    M4A AAC-LC 256 kbps 48 kHz (ffmpeg native aac)
//     demo-alac       M4A ALAC (24-bit in s32p) 48 kHz
//     demo-flac24     FLAC 24-bit 48 kHz
//     demo-vorbis     Ogg Vorbis 48 kHz (libvorbis q6, else the native encoder at 192 kbps)
//     demo-opus       Ogg Opus 160 kbps (always 48 kHz)
//     demo-opus-m4a   Opus in MP4 ".m4a", like Suno's served stream (RESEARCH §6)
//
// Manifest: { version, stamp, dir, ffmpeg, fixtures: { [id]: entry }, skipped: [{ id, reason }] }
// entry: { id, path, file, container (wav|mp3|m4a|flac|ogg), codec, sampleRate, channels, bitDepth|null,
//          bitrateKbps|null, durationSec, lossy, source, description }
// codec / sampleRate / channels / bitDepth / durationSec are read back from the written
// file (ffprobe, else `ffmpeg -i`), so they describe what is on disk.
//
// Idempotent: the manifest stores a stamp (hash of this script, the demo generator,
// tests/helpers.mjs and the ffmpeg version); if it matches and every file exists, nothing is rewritten. Files
// are written to a temporary name and renamed, so concurrent runs never expose partial
// files. Repeated calls in one process share one build.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TMP, hasFfmpeg, pinkNoise, sweep, writeWavFloat } from '../tests/helpers.mjs';
import { generateDemoTrack } from '../src/demo/demo-track.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Default output directory. */
export const FIXTURE_DIR = join(TMP, 'fixtures');
const VERSION = 1;

const SOURCES = [
  {
    id: 'demo-defects',
    file: 'demo-defects.wav',
    description: 'demo song, defects on (48 kHz, 32 s, float)',
    make: () => generateDemoTrack({ sampleRate: 48000, seconds: 32, seed: 7, defects: true }),
  },
  {
    id: 'demo-clean',
    file: 'demo-clean.wav',
    description: 'demo song, defects off (48 kHz, 32 s, float)',
    make: () => generateDemoTrack({ sampleRate: 48000, seconds: 32, seed: 7, defects: false }),
  },
  {
    id: 'pink-noise',
    file: 'pink-noise.wav',
    description: 'stereo pink noise, independent L/R (48 kHz, 10 s, float)',
    make: () => ({ sampleRate: 48000, channels: [pinkNoise(10, 48000, 0.5, 11), pinkNoise(10, 48000, 0.5, 12)] }),
  },
  {
    id: 'sine-sweep',
    file: 'sine-sweep.wav',
    description: 'log sine sweep 20 Hz → 20 kHz at −6 dBFS, dual mono (48 kHz, 10 s, float)',
    make: () => {
      const s = sweep(20, 20000, 10, 48000, 0.5);
      return { sampleRate: 48000, channels: [s, Float32Array.from(s)] };
    },
  },
];

// Transcodes of demo-defects. `encoder` must be listed by `ffmpeg -encoders`.
const TRANSCODES = [
  { id: 'demo-wav16-44k', file: 'demo-16bit-44k.wav', encoder: 'pcm_s16le', lossy: false, description: 'WAV PCM 16-bit 44.1 kHz (triangular dither)', args: ['-af', 'aresample=44100:dither_method=triangular', '-c:a', 'pcm_s16le'] },
  { id: 'demo-wav24-48k', file: 'demo-24bit-48k.wav', encoder: 'pcm_s24le', lossy: false, description: 'WAV PCM 24-bit 48 kHz', args: ['-c:a', 'pcm_s24le'] },
  { id: 'demo-mp3-320', file: 'demo-320k-48k.mp3', encoder: 'libmp3lame', lossy: true, description: 'MP3 320 kbps CBR 48 kHz', args: ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000'] },
  { id: 'demo-mp3-v0', file: 'demo-v0-44k.mp3', encoder: 'libmp3lame', lossy: true, description: 'MP3 VBR V0 44.1 kHz', args: ['-c:a', 'libmp3lame', '-q:a', '0', '-ar', '44100'] },
  { id: 'demo-aac-256', file: 'demo-aac-256k.m4a', encoder: 'aac', lossy: true, description: 'M4A AAC-LC 256 kbps 48 kHz', args: ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'] },
  { id: 'demo-alac', file: 'demo-alac.m4a', encoder: 'alac', lossy: false, description: 'M4A ALAC 24-bit 48 kHz', args: ['-c:a', 'alac', '-sample_fmt', 's32p'] },
  { id: 'demo-flac24', file: 'demo-24bit.flac', encoder: 'flac', lossy: false, description: 'FLAC 24-bit 48 kHz', args: ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] },
  { id: 'demo-vorbis', file: 'demo-vorbis.ogg', encoder: ['libvorbis', 'vorbis'], lossy: true, description: 'Ogg Vorbis 48 kHz', args: (enc) => (enc === 'libvorbis' ? ['-c:a', 'libvorbis', '-q:a', '6'] : ['-c:a', 'vorbis', '-strict', '-2', '-b:a', '192k']) },
  { id: 'demo-opus', file: 'demo-opus-160k.opus', encoder: 'libopus', lossy: true, description: 'Ogg Opus 160 kbps', args: ['-c:a', 'libopus', '-b:a', '160k'] },
  { id: 'demo-opus-m4a', file: 'demo-opus-160k.m4a', encoder: 'libopus', lossy: true, description: 'Opus in MP4 (.m4a), like Suno’s served stream', args: ['-c:a', 'libopus', '-b:a', '160k', '-f', 'mp4'] },
];

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let encodersCache = null;
function encoders() {
  if (encodersCache) return encodersCache;
  const out = run('ffmpeg', ['-hide_banner', '-encoders']).stdout || '';
  encodersCache = new Set(out.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
  return encodersCache;
}

function hasFfprobe() {
  return run('ffprobe', ['-version']).status === 0;
}

/** Stream facts of a written file: ffprobe JSON, else parsed from `ffmpeg -i`. */
function probe(path) {
  if (hasFfprobe()) {
    const r = run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
    if (r.status === 0) {
      const j = JSON.parse(r.stdout);
      const st = (j.streams || []).find((x) => x.codec_type === 'audio') || {};
      const fmt = j.format || {};
      const bits = Number(st.bits_per_raw_sample) || Number(st.bits_per_sample) || null;
      const br = Number(st.bit_rate) || Number(fmt.bit_rate) || null;
      return {
        codec: st.codec_name || 'unknown',
        container: (fmt.format_name || '').split(',')[0],
        sampleRate: Number(st.sample_rate) || null,
        channels: Number(st.channels) || null,
        bitDepth: bits,
        bitrateKbps: br ? Math.round(br / 1000) : null,
        durationSec: Number(st.duration) || Number(fmt.duration) || null,
      };
    }
  }
  const txt = run('ffmpeg', ['-hide_banner', '-i', path]).stderr || '';
  const m = txt.match(/Audio: ([a-z0-9_]+)[^,]*, (\d+) Hz, ([a-z0-9.]+)/);
  const d = txt.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const inp = txt.match(/Input #0, ([a-z0-9_]+)/);
  return {
    codec: m ? m[1] : 'unknown',
    container: inp ? inp[1] : '',
    sampleRate: m ? Number(m[2]) : null,
    channels: m ? (m[3] === 'stereo' ? 2 : m[3] === 'mono' ? 1 : null) : null,
    bitDepth: null,
    bitrateKbps: null,
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
  };
}

function stampFor(ffmpegOk) {
  const h = createHash('sha1');
  h.update(String(VERSION));
  h.update(readFileSync(fileURLToPath(import.meta.url)));
  h.update(readFileSync(join(root, 'src/demo/demo-track.js')));
  h.update(readFileSync(join(root, 'tests/helpers.mjs')));
  h.update(ffmpegOk ? (run('ffmpeg', ['-version']).stdout || '').split('\n')[0] : 'no-ffmpeg');
  return h.digest('hex').slice(0, 16);
}

const tmpName = (path) => `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;

function writeWavAtomic(path, audio) {
  const t = tmpName(path);
  writeWavFloat(t, audio.channels, audio.sampleRate);
  renameSync(t, path);
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function complete(manifest, stamp) {
  return !!manifest && manifest.stamp === stamp && Object.values(manifest.fixtures || {}).every((f) => existsSync(f.path));
}

async function build({ dir, force, log }) {
  mkdirSync(dir, { recursive: true });
  const ffmpegOk = hasFfmpeg();
  const stamp = stampFor(ffmpegOk);
  const prev = readManifest(dir);
  if (!force && complete(prev, stamp)) return prev;

  const fixtures = {};
  const skipped = [];
  const say = (msg) => log && process.stderr.write(`[make-fixtures] ${msg}\n`);
  for (const src of SOURCES) {
    const path = join(dir, src.file);
    const audio = src.make();
    writeWavAtomic(path, audio);
    fixtures[src.id] = {
      id: src.id,
      path,
      file: src.file,
      container: 'wav',
      codec: 'pcm_f32le',
      sampleRate: audio.sampleRate,
      channels: audio.channels.length,
      bitDepth: 32,
      bitrateKbps: Math.round((audio.sampleRate * 32 * audio.channels.length) / 1000),
      durationSec: audio.channels[0].length / audio.sampleRate,
      lossy: false,
      source: src.id,
      description: src.description,
    };
    say(`wrote ${src.file}`);
  }
  const input = fixtures['demo-defects'].path;
  for (const tc of TRANSCODES) {
    if (!ffmpegOk) {
      skipped.push({ id: tc.id, reason: 'ffmpeg not found' });
      continue;
    }
    const wanted = Array.isArray(tc.encoder) ? tc.encoder : [tc.encoder];
    const enc = wanted.find((e) => encoders().has(e));
    if (!enc) {
      skipped.push({ id: tc.id, reason: `encoder ${wanted.join('/')} not available in this ffmpeg` });
      continue;
    }
    const path = join(dir, tc.file);
    const t = tmpName(path);
    const args = typeof tc.args === 'function' ? tc.args(enc) : tc.args;
    // a temporary name hides the extension from ffmpeg: give the muxer explicitly
    const fmtArgs = args.includes('-f') ? [] : ['-f', { wav: 'wav', mp3: 'mp3', m4a: 'ipod', flac: 'flac', ogg: 'ogg', opus: 'opus' }[tc.file.split('.').pop()]];
    const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map_metadata', '-1', ...args, ...fmtArgs, t]);
    if (r.status !== 0 || !existsSync(t)) {
      rmSync(t, { force: true });
      skipped.push({ id: tc.id, reason: `ffmpeg failed: ${(r.stderr || '').trim().split('\n').pop()}` });
      continue;
    }
    renameSync(t, path);
    const info = probe(path);
    // container by file type, as the app's decoder names formats (wav|mp3|m4a|flac|ogg)
    const ext = tc.file.split('.').pop();
    info.container = { opus: 'ogg' }[ext] || ext;
    fixtures[tc.id] = { id: tc.id, path, file: tc.file, ...info, lossy: tc.lossy, source: 'demo-defects', description: tc.description };
    say(`wrote ${tc.file} (${info.codec}, ${info.sampleRate} Hz)`);
  }
  const manifest = { version: VERSION, stamp, dir, ffmpeg: ffmpegOk, fixtures, skipped };
  const mp = join(dir, 'manifest.json');
  const t = tmpName(mp);
  writeFileSync(t, JSON.stringify(manifest, null, 2));
  renameSync(t, mp);
  return manifest;
}

let pending = null;

/**
 * Builds (or reuses) the fixture set and resolves to its manifest.
 * @param {{ dir?: string, force?: boolean, log?: boolean }} [opts]
 *   dir: output directory (default FIXTURE_DIR); force: rebuild even if up to date;
 *   log: progress on stderr.
 * @returns {Promise<{ version: number, stamp: string, dir: string, ffmpeg: boolean,
 *   fixtures: Object<string, { id: string, path: string, file: string, container: string,
 *   codec: string, sampleRate: number, channels: number, bitDepth: number|null,
 *   bitrateKbps: number|null, durationSec: number, lossy: boolean, source: string,
 *   description: string }>, skipped: { id: string, reason: string }[] }>}
 */
export async function makeFixtures({ dir = FIXTURE_DIR, force = false, log = false } = {}) {
  if (force || dir !== FIXTURE_DIR) return build({ dir, force, log });
  if (pending) {
    const m = await pending.catch(() => null);
    if (m && Object.values(m.fixtures).every((f) => existsSync(f.path))) return m;
  }
  pending = build({ dir, force, log });
  return pending;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await makeFixtures({ force: process.argv.includes('--force'), log: true });
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
