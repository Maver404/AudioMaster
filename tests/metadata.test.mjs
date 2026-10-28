// Metadata tests: readMetadata on FFmpeg-made fixtures of every container (MP3 ID3v2.3/2.4/
// ID3v1, M4A ilst/mdta, FLAC, Ogg Vorbis/Opus/FLAC, WAV LIST/INFO, AIFF ID3), hand-built
// ID3 edge cases (unsynchronisation, extended header, footer, v2.2, iTunes sizes,
// compressed/encrypted frames, UTF-16 BE), APEv2, garbage/truncated input, bounded reads on
// multi-GB virtual files, and the export round trip: readMetadata(encodeMp3/encodeWav
// output) equals prepareExportMetadata(input), FFprobe agrees, gapless length unchanged.
// Edge cases: per-tag ID3v2.4 size mode, lone surrogates in URL frames / exporters
// that never fail on metadata, linear + capped hostile repetition, MP4 legal-parent walk,
// v2.3 dates (TYER + TXXX DATE, no TDRC), odd RIFF INFO subchunks, Ogg Skeleton first,
// trailing tag chains, picture MIME never scriptable.
//
// Optional: AM_META_FILES="/path/a.mp3:/path/b.wav" node tests/run.mjs metadata
// also reads real files and prints what it finds (nothing is written anywhere).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assert, TMP, hasFfmpeg, ffmpegDecode, writeWavFloat, sine, pinkNoise, rng } from './helpers.mjs';
import {
  readMetadata, buildId3v2, buildRiffInfo, prepareExportMetadata, hasExportMetadata, pickCover, cleanText,
  TAG_KEYS, PICTURE_TYPES, MAX_EXPORT_PICTURE_BYTES, MAX_TAG_ITEMS, MAX_PICTURES, MAX_WARNINGS, IMAGE_MIMES,
} from '../src/audio/metadata.js';
import { encodeWav, encodeWavBuffer, wavMetadataChunks } from '../src/export/wav.js';
import { encodeMp3 } from '../src/export/mp3.js';
import { parseWav, sniffFormat } from '../src/audio/decode.js';

// ---------------------------------------------------------------------------------------
// helpers

const fx = (name) => join(TMP, `meta-${name}`);
const ff = (...args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ').slice(0, 300)}: ${r.stderr}`);
};
const hasLame = () => spawnSync('lame', ['--version'], { stdio: 'ignore' }).status === 0;

function probe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffprobe ${path}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const tags = {};
  // Ogg keeps the comments on the audio stream, everything else on the format
  const audio = (j.streams || []).find((s) => s.codec_type === 'audio');
  for (const src of [(audio && audio.tags) || {}, (j.format && j.format.tags) || {}]) {
    for (const [k, v] of Object.entries(src)) tags[k.toLowerCase()] = v;
  }
  const pics = (j.streams || []).filter((s) => s.disposition && s.disposition.attached_pic);
  return { tags, streams: j.streams || [], pics, format: j.format };
}

const eqBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;

function assertTags(got, want, what) {
  for (const [k, v] of Object.entries(want)) {
    assert(got[k] === v, `${what}: tags.${k} = ${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}`);
  }
}

const extraOf = (meta, key) => (meta.extra.find((e) => e.key === key) || {}).value;

/** Deep comparison of two metadata objects (tags, extra, pictures incl. bytes). */
function assertSameMeta(a, b, what) {
  const ja = JSON.stringify(a.tags);
  const jb = JSON.stringify(b.tags);
  assert(ja === jb, `${what}: tags differ\n  ${ja}\n  ${jb}`);
  const ea = JSON.stringify(a.extra);
  const eb = JSON.stringify(b.extra);
  assert(ea === eb, `${what}: extra differ\n  ${ea}\n  ${eb}`);
  assert(a.pictures.length === b.pictures.length, `${what}: ${a.pictures.length} vs ${b.pictures.length} pictures`);
  a.pictures.forEach((p, i) => {
    const q = b.pictures[i];
    for (const k of ['mime', 'type', 'typeLabel', 'description', 'width', 'height', 'size']) {
      assert(p[k] === q[k], `${what}: picture ${i}.${k} ${JSON.stringify(p[k])} vs ${JSON.stringify(q[k])}`);
    }
    assert(eqBytes(p.bytes, q.bytes), `${what}: picture ${i} bytes differ`);
  });
}

// --- independent ID3 builder (test side; does not share code with src) -------------------

const TE = {
  latin1: (s) => Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]),
  utf16: (s) => Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]),
  utf16bom_be: (s) => Buffer.concat([Buffer.from([1, 0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]),
  utf16be: (s) => Buffer.concat([Buffer.from([2]), Buffer.from(s, 'utf16le').swap16()]),
  utf8: (s) => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]),
};
const ss = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

function frame(ver, id, data, { flags = 0, plainSize = false } = {}) {
  if (ver === 2) return Buffer.concat([Buffer.from(id), Buffer.from([(data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
  return Buffer.concat([Buffer.from(id), ver === 4 && !plainSize ? ss(data.length) : be32(data.length), Buffer.from([0, flags]), data]);
}

function id3tag(ver, frames, { flags = 0, ext = null, padding = 0, footer = false, unsyncBody = false } = {}) {
  let body = Buffer.concat([...(ext ? [ext] : []), ...frames]);
  if (unsyncBody) body = unsyncBytes(body);
  body = Buffer.concat([body, Buffer.alloc(padding)]);
  const parts = [Buffer.from('ID3'), Buffer.from([ver, 0, flags]), ss(body.length), body];
  if (footer) parts.push(Buffer.from('3DI'), Buffer.from([ver, 0, flags]), ss(body.length));
  return Buffer.concat(parts);
}

function unsyncBytes(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] === 0 || (b[i + 1] & 0xe0) === 0xe0)) out.push(0);
  }
  return Buffer.from(out);
}

/** FLAC PICTURE block body (also the METADATA_BLOCK_PICTURE payload). */
function flacPicture(type, mime, desc, data, w = 0, h = 0) {
  const d = Buffer.from(desc, 'utf8');
  return Buffer.concat([be32(type), be32(mime.length), Buffer.from(mime, 'latin1'), be32(d.length), d, be32(w), be32(h), be32(24), be32(0), be32(data.length), data]);
}

// --- fixtures ----------------------------------------------------------------------------

let fixtures = null;
function makeFixtures() {
  if (fixtures) return fixtures;
  const f = {};
  const sr = 44100;
  const L = sine(440, 1, sr, 0.3);
  const R = pinkNoise(1, sr, 0.2, 7);
  f.src = writeWavFloat(fx('src.wav'), [L, R], sr);
  f.png = fx('cover.png');
  f.jpg = fx('cover.jpg');
  f.gif = fx('cover.gif');
  f.bmp = fx('cover.bmp');
  f.webp = fx('cover.webp');
  f.bigpng = fx('big.png');
  if (!existsSync(f.png)) ff('-f', 'lavfi', '-i', 'testsrc=s=64x48:d=1', '-frames:v', '1', f.png);
  if (!existsSync(f.jpg)) ff('-f', 'lavfi', '-i', 'testsrc=s=40x30:d=1', '-frames:v', '1', f.jpg);
  if (!existsSync(f.gif)) ff('-f', 'lavfi', '-i', 'testsrc=s=33x21:d=1', '-frames:v', '1', f.gif);
  if (!existsSync(f.bmp)) ff('-f', 'lavfi', '-i', 'testsrc=s=17x9:d=1', '-frames:v', '1', f.bmp);
  try {
    if (!existsSync(f.webp)) ff('-f', 'lavfi', '-i', 'testsrc=s=50x26:d=1', '-frames:v', '1', f.webp);
  } catch { f.webp = null; }
  // ~190 KB of noise: a comment packet spanning several Ogg pages
  if (!existsSync(f.bigpng)) ff('-f', 'lavfi', '-i', 'nullsrc=s=256x256,geq=random(1)*255:random(2)*255:random(3)*255', '-frames:v', '1', f.bigpng);
  // a tag-less MP3 stream to put behind hand-built tags
  f.bare = fx('bare.mp3');
  if (!existsSync(f.bare)) ff('-i', f.src, '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_xing', '0', f.bare);
  fixtures = f;
  return f;
}

function fixture(name, args) {
  const out = fx(name);
  if (!existsSync(out)) ff(...args, out);
  return out;
}

const COMMON = [
  '-metadata', 'title=Très bien – “ok” ♫', '-metadata', 'artist=Ünïcode Artist', '-metadata', 'album=The Album',
  '-metadata', 'album_artist=Various', '-metadata', 'genre=Pop', '-metadata', 'track=3/12', '-metadata', 'disc=1/2',
  '-metadata', 'composer=Comp Oser', '-metadata', 'comment=A comment', '-metadata', 'copyright=(c) 2024 Me',
  '-metadata', 'publisher=Label Inc', '-metadata', 'lyrics=First line\nSecond line', '-metadata', 'MYKEY=my value',
];

// stub lamejs that emits the frames of a real tag-less (`lame -t`) stream, like io.test.mjs
let lameFrames = null;
function lameStream(sr, seconds) {
  if (lameFrames) return lameFrames;
  if (!hasFfmpeg() || !hasLame()) return null;
  const n = Math.round(sr * seconds);
  const L = sine(440, seconds, sr, 0.4);
  const R = pinkNoise(seconds, sr, 0.3, 9);
  const wav = writeWavFloat(fx('lame-src.wav'), [L, R], sr);
  const raw = fx('lame-src.pcm');
  const out = fx('lame-t.mp3');
  if (!existsSync(out)) {
    ff('-i', wav, '-f', 's16le', '-acodec', 'pcm_s16le', raw);
    spawnSync('lame', ['--quiet', '-r', '-s', String(sr / 1000), '--bitwidth', '16', '--signed', '--little-endian', '-m', 's', '-b', '320', '--cbr', '-t', raw, out]);
  }
  if (!existsSync(out)) return null;
  lameFrames = { frames: new Uint8Array(readFileSync(out)), L, R, n, sr };
  return lameFrames;
}

async function encodeMp3WithStub(stream, opts) {
  let emitted = 0;
  const take = (bytes) => {
    const end = Math.min(stream.frames.length, emitted + bytes);
    const out = new Int8Array(stream.frames.buffer, stream.frames.byteOffset + emitted, end - emitted);
    emitted = end;
    return out;
  };
  globalThis.lamejs = {
    Mp3Encoder: class {
      encodeBuffer(l) { return take(Math.floor((l.length / 1152) * 1044)); }
      flush() { return take(Infinity); }
    },
  };
  try {
    const blob = await encodeMp3({ sampleRate: stream.sr, channels: [stream.L, stream.R] }, opts);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    delete globalThis.lamejs;
  }
}

/** A Blob-like file of `size` bytes: `segments` hold real bytes, everything else reads as 0. */
class VirtualBlob {
  constructor(size, segments) {
    this.size = size;
    this.segments = segments;
    this.bytesRead = 0;
    this.reads = 0;
  }

  slice(start = 0, end = this.size) {
    const self = this;
    const s0 = Math.max(0, start);
    const e0 = Math.min(this.size, end);
    return {
      size: Math.max(0, e0 - s0),
      async arrayBuffer() {
        self.reads++;
        self.bytesRead += Math.max(0, e0 - s0);
        const out = new Uint8Array(Math.max(0, e0 - s0));
        for (const { offset, bytes } of self.segments) {
          const s = Math.max(s0, offset);
          const e = Math.min(e0, offset + bytes.length);
          if (s < e) out.set(bytes.subarray(s - offset, e - offset), s - s0);
        }
        return out.buffer;
      },
    };
  }

  async arrayBuffer() {
    throw new Error('whole-file read');
  }
}

/** A metadata object like readMetadata returns, with Suno-style content. */
function sampleMeta() {
  const f = makeFixtures();
  return {
    tags: {
      title: 'Notte di luglio – “live” ♫', artist: 'Ünïcode Årtist', album: 'Album', albumArtist: 'Various', date: '2025-04-11',
      track: '3/12', disc: '1/2', genre: 'Pop', composer: 'Comp', publisher: 'Label', copyright: '(c) 2025', isrc: 'ITABC2500001',
      bpm: '120', comment: 'Mastered for test', lyrics: 'Prima riga\nSeconda riga – è così\n\n[Chorus]\nUltima', encoder: 'Lavf61.7.100',
    },
    extra: [
      { key: 'WOAS', label: 'Official audio source webpage', value: 'https://suno.com/song/0000-test' },
      { key: 'TXXX:Mood words', label: 'Mood words', value: 'warm, nostalgic' },
      { key: 'TXXX:iTunSMPB', label: 'iTunSMPB', value: ' 00000000 00000210 000003D8' },
      { key: 'TXXX:REPLAYGAIN_TRACK_GAIN', label: 'REPLAYGAIN_TRACK_GAIN', value: '-6.20 dB' },
      { key: 'TLEN', label: 'Length (ms)', value: '210000' },
      { key: 'TOPE', label: 'Original artist', value: 'Someone' },
      { key: 'COMM:Short', label: 'Short', value: 'second comment' },
    ],
    pictures: [
      { mime: 'image/png', type: 0, description: '', bytes: new Uint8Array(readFileSync(f.png)) },
      { mime: 'image/jpeg', type: 3, description: 'Cover', bytes: new Uint8Array(readFileSync(f.jpg)) },
    ],
  };
}

// --- small builders for the hardening tests ----------------------------------------------

const MPEG = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);

/** MP4 box; `type` is a 4-char string (latin1, so '\xa9nam' works). */
const mp4box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([be32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const mp4data = (type, payload) => mp4box('data', be32(type), be32(0), payload);
const mp4meta = (...items) => mp4box('meta', be32(0), mp4box('hdlr', Buffer.alloc(8), Buffer.from('mdirappl'), Buffer.alloc(9)), mp4box('ilst', ...items));
const M4A_FTYP = mp4box('ftyp', Buffer.from('M4A '), be32(0), Buffer.from('M4A isom'));
const M4A_MDAT = mp4box('mdat', Buffer.alloc(16));

/** One Ogg page holding whole packets (no CRC: the reader does not check it). */
function oggPage(serial, seq, flags, packets) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  return Buffer.concat([Buffer.from('OggS'), Buffer.from([0, flags]), Buffer.alloc(8), le32(serial), le32(seq), le32(0), Buffer.from([lacing.length]), Buffer.from(lacing), ...packets]);
}
const vorbisComment = (fields) => Buffer.concat([le32(3), Buffer.from('ven'), le32(fields.length), ...fields.map((f) => { const b = Buffer.from(f, 'utf8'); return Buffer.concat([le32(b.length), b]); })]);
const OPUS_HEAD = Buffer.concat([Buffer.from('OpusHead'), Buffer.from([1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]);

/** encodeMp3 with a stub lamejs that emits `bytes` (no Info frame: gapless off). */
async function encodeMp3Stub(opts, bytes = Buffer.alloc(417, 0x55)) {
  globalThis.lamejs = {
    Mp3Encoder: class {
      encodeBuffer() { return new Int8Array(0); }
      flush() { return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length); }
    },
  };
  try {
    const blob = await encodeMp3({ sampleRate: 44100, channels: [new Float32Array(1152), new Float32Array(1152)] }, { gapless: false, ...opts });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    delete globalThis.lamejs;
  }
}

/** APEv2 tag (items + footer, optionally a header) as a Buffer. */
function apeTag(items, { header = false } = {}) {
  const body = Buffer.concat(items.map(([key, value]) => { const v = Buffer.from(value, 'utf8'); return Buffer.concat([le32(v.length), le32(0), Buffer.from(key, 'latin1'), Buffer.from([0]), v]); }));
  const size = body.length + 32;
  const flags = header ? 0x80000000 : 0;
  const hf = (isHeader) => Buffer.concat([Buffer.from('APETAGEX'), le32(2000), le32(size), le32(items.length), le32((flags | (isHeader ? 0x20000000 : 0)) >>> 0), Buffer.alloc(8)]);
  return Buffer.concat([header ? hf(true) : Buffer.alloc(0), body, hf(false)]);
}

function id3v1(title, album = '') {
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0);
  v1.write(title, 3, 'latin1');
  v1.write(album, 63, 'latin1');
  v1[127] = 255;
  return v1;
}

// ---------------------------------------------------------------------------------------

export const tests = {
  // --------------------------------------------------------------------------- MP3 / ID3
  'metadata: FFmpeg ID3v2.3 MP3 — UTF-16 text, TXXX, COMM, lyrics, PNG front cover with description': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const path = fixture('v23.mp3', [
      '-i', f.src, '-i', f.png, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-c:v', 'copy',
      '-id3v2_version', '3', ...COMMON, '-metadata', 'date=2024', '-metadata:s:v', 'title=Front desc', '-metadata:s:v', 'comment=Cover (front)',
    ]);
    const m = await readMetadata(new Uint8Array(readFileSync(path)));
    assert(m.format === 'mp3' && m.tagTypes[0] === 'ID3v2.3', `${m.format} ${m.tagTypes}`);
    assertTags(m.tags, {
      title: 'Très bien – “ok” ♫', artist: 'Ünïcode Artist', album: 'The Album', albumArtist: 'Various', genre: 'Pop',
      track: '3/12', disc: '1/2', composer: 'Comp Oser', comment: 'A comment', copyright: '(c) 2024 Me', publisher: 'Label Inc',
      lyrics: 'First line\nSecond line', date: '2024', year: '2024',
    }, 'v2.3');
    assert(/^Lavf/.test(m.tags.encoder), 'encoder');
    assert(extraOf(m, 'TXXX:MYKEY') === 'my value', `TXXX ${JSON.stringify(m.extra)}`);
    assert(m.pictures.length === 1, 'one picture');
    const p = m.pictures[0];
    assert(p.mime === 'image/png' && p.type === 3 && p.typeLabel === 'Front cover' && p.description === 'Front desc' && p.width === 64 && p.height === 48, JSON.stringify({ ...p, bytes: undefined }));
    assert(eqBytes(p.bytes, readFileSync(f.png)), 'cover bytes');
    assert(pickCover(m) === p, 'pickCover');
    assert(Object.keys(m.tags).every((k, i, a) => !i || TAG_KEYS.indexOf(a[i - 1]) < TAG_KEYS.indexOf(k)), 'tags in TAG_KEYS order');
    assert(m.warnings.length === 0, `warnings ${m.warnings}`);
  },

  'metadata: FFmpeg ID3v2.4 MP3 — UTF-8 text, full date, JPEG cover; ID3v1-only and v1+v2 files': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const v24 = fixture('v24.mp3', [
      '-i', f.src, '-i', f.jpg, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-c:v', 'copy',
      '-id3v2_version', '4', ...COMMON, '-metadata', 'date=2023-05-06',
    ]);
    const m = await readMetadata(readFileSync(v24));
    assert(m.tagTypes[0] === 'ID3v2.4', m.tagTypes.join());
    assertTags(m.tags, { title: 'Très bien – “ok” ♫', artist: 'Ünïcode Artist', date: '2023-05-06', year: '2023', lyrics: 'First line\nSecond line', track: '3/12' }, 'v2.4');
    assert(m.pictures.length === 1 && m.pictures[0].mime === 'image/jpeg' && m.pictures[0].width === 40 && m.pictures[0].height === 30, 'jpeg cover');
    assert(eqBytes(m.pictures[0].bytes, readFileSync(f.jpg)), 'jpeg bytes');
    // ID3v1 only (title/artist/album ≤ 30 chars, Latin-1). FFmpeg writes ID3v1 only along
    // with an ID3v2 tag, so strip the leading tag.
    const v12 = fixture('v1src.mp3', [
      '-i', f.src, '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3', '-write_id3v1', '1',
      '-metadata', 'title=Old school', '-metadata', 'artist=Säger', '-metadata', 'album=LP', '-metadata', 'date=1999',
      '-metadata', 'comment=hi', '-metadata', 'track=7', '-metadata', 'genre=Rock',
    ]);
    const raw = readFileSync(v12);
    assert(raw.subarray(0, 3).toString() === 'ID3', 'v1src has ID3v2');
    const v1only = raw.subarray(10 + ((raw[6] << 21) | (raw[7] << 14) | (raw[8] << 7) | raw[9]));
    const m1 = await readMetadata(v1only);
    assert(m1.format === 'mp3' && /^ID3v1/.test(m1.tagTypes[0]) && m1.tagTypes.length === 1, m1.tagTypes.join());
    assertTags(m1.tags, { title: 'Old school', artist: 'Säger', album: 'LP', date: '1999', comment: 'hi', track: '7', genre: 'Rock' }, 'v1');
    // both: ID3v2 wins (v1 truncates to 30 chars)
    const long = 'A title that is much longer than thirty characters';
    const both = fixture('v1v2.mp3', ['-i', f.src, '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3', '-write_id3v1', '1', '-metadata', `title=${long}`, '-metadata', 'artist=X']);
    const mb = await readMetadata(readFileSync(both));
    assert(mb.tags.title === long && mb.tagTypes.join() === 'ID3v2.3,ID3v1', `${mb.tags.title} ${mb.tagTypes}`);
  },

  'metadata: hand-built ID3v2.3 — tag unsynchronisation, extended header, UTF-16 BE BOM, multi-string, genre refs, compressed/encrypted frames': async () => {
    const f = hasFfmpeg() ? makeFixtures() : null;
    const pic = f ? readFileSync(f.jpg) : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0, 0xff, 0xd9]);
    const frames = [
      frame(3, 'TIT2', TE.utf16bom_be('Bé title')),
      frame(3, 'TPE1', TE.latin1('Artist\0Second')), // two strings (v2.4 style) still read
      frame(3, 'TCON', TE.latin1('(13)(17)')),
      frame(3, 'TYER', TE.latin1('2021')),
      frame(3, 'TDAT', TE.latin1('0503')),
      frame(3, 'TIME', TE.latin1('1407')),
      frame(3, 'COMM', Buffer.concat([TE.latin1('engiTunNORM\0 0000044E'), Buffer.alloc(0)])),
      frame(3, 'COMM', Buffer.concat([Buffer.from([1]), Buffer.from('eng'), Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from([0xff, 0xfe]), Buffer.from('Ciao è', 'utf16le')])),
      frame(3, 'USLT', Buffer.concat([Buffer.from([0]), Buffer.from('ita'), Buffer.from([0]), Buffer.from('riga 1\r\nriga 2\rriga 3', 'latin1')])),
      frame(3, 'TXXX', Buffer.concat([TE.utf16('Café'), Buffer.from([0, 0, 0xff, 0xfe]), Buffer.from('valué', 'utf16le')])),
      frame(3, 'WOAS', Buffer.from('https://suno.com/song/x')),
      frame(3, 'TPE3', Buffer.concat([be32(10), Buffer.from('zlibdata..')]), { flags: 0x80 }), // compressed
      frame(3, 'TPE4', Buffer.concat([Buffer.from([1]), Buffer.from('secret')]), { flags: 0x40 }), // encrypted
      frame(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/jpg\0'), Buffer.from([4]), Buffer.from('back\0'), pic])),
    ];
    const ext = Buffer.concat([be32(6), Buffer.from([0, 0]), be32(0)]);
    const tag = id3tag(3, frames, { flags: 0x80 | 0x40, ext, unsyncBody: true, padding: 64 });
    assert(tag.length > id3tag(3, frames, { flags: 0x40, ext, padding: 64 }).length, 'body really is unsynchronised');
    const m = await readMetadata(Buffer.concat([tag, f ? readFileSync(f.bare) : Buffer.from([0xff, 0xfb, 0x90, 0])]));
    assertTags(m.tags, {
      title: 'Bé title', artist: 'Artist; Second', genre: 'Pop; Rock', date: '2021-03-05T14:07', year: '2021',
      comment: 'Ciao è', lyrics: 'riga 1\nriga 2\nriga 3',
    }, 'v2.3 unsync');
    assert(m.tags.conductor === undefined && m.tags.remixer === undefined, 'compressed/encrypted frames skipped');
    assert(m.warnings.some((w) => /compressed frame TPE3/.test(w)) && m.warnings.some((w) => /encrypted frame TPE4/.test(w)), m.warnings.join('|'));
    assert(extraOf(m, 'COMM:iTunNORM') === '0000044E' && extraOf(m, 'TXXX:Café') === 'valué' && extraOf(m, 'WOAS') === 'https://suno.com/song/x', JSON.stringify(m.extra));
    const p = m.pictures[0];
    assert(p && p.type === 4 && p.typeLabel === 'Back cover' && p.description === 'back' && p.mime === 'image/jpeg' && eqBytes(p.bytes, pic), 'unsynced APIC restored');
    assert(p.width === 40 && p.height === 30, `jpeg dims ${p.width}x${p.height}`);
    assert(pickCover(m) === p, 'no front cover → first picture');
    if (f) {
      // FFmpeg agrees on the same frames without unsynchronisation. (With v2.3 tag-level
      // unsync FFmpeg reads frame sizes on the unsynchronised bytes — it gets 'Bé titl' and
      // stops; TagLib/mutagen, like this reader, de-unsynchronise the whole tag first.)
      const plainTag = id3tag(3, frames.filter((x) => !/^TPE[34]/.test(x.subarray(0, 4).toString())), { flags: 0x40, ext });
      const path = fx('hand23.mp3');
      writeFileSync(path, Buffer.concat([plainTag, readFileSync(f.bare)]));
      const pr = probe(path);
      const mp = await readMetadata(readFileSync(path));
      // (FFmpeg keeps only the first '(13)' genre ref and the first string of a v2.3 frame)
      assert(pr.tags.title === mp.tags.title && pr.tags.genre === 'Pop' && pr.tags.comment === mp.tags.comment && pr.tags.date.startsWith('2021-03-05') && pr.tags['café'] === 'valué', JSON.stringify(pr.tags));
      assert(pr.pics.length === 1 && pr.pics[0].width === 40 && mp.pictures[0].width === 40, 'APIC');
    }
  },

  'metadata: hand-built ID3v2.4 — footer, frame unsync + data length indicator, UTF-16BE, null-separated values, iTunes plain sizes; ID3v2.2': async () => {
    const big = 'x'.repeat(300);
    const art = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 200, 8, 2, 0, 0, 0, 0xff, 0xe0, 0xff, 0x00]);
    const apic = Buffer.concat([Buffer.from([3]), Buffer.from('image/png\0'), Buffer.from([3]), Buffer.from('fröntal\0', 'utf8'), art]);
    const unsynced = unsyncBytes(apic);
    const frames = [
      frame(4, 'TIT2', TE.utf16be('Big Endian ✓')),
      frame(4, 'TPE1', TE.utf8('Uno\0Due\0')),
      frame(4, 'TCON', TE.utf8('13\0RX\0Synthwave')),
      frame(4, 'TDRC', TE.utf8('2023-01-02T03:04')),
      frame(4, 'TXXX', TE.utf8(`long\0${big}`), { plainSize: true }), // iTunes writes plain sizes
      frame(4, 'TXXX', TE.utf8('lyrics\0from txxx')), // FFmpeg-style lyrics: used when no USLT
      frame(4, 'APIC', Buffer.concat([ss(apic.length), unsynced]), { flags: 0x02 | 0x01 }),
      frame(4, 'TALB', Buffer.concat([Buffer.from([7]), TE.utf8('Grouped')]), { flags: 0x40 }), // grouping id byte first
    ];
    const tag = id3tag(4, frames, { flags: 0x10, footer: true });
    const m = await readMetadata(Buffer.concat([tag, Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]));
    assertTags(m.tags, { title: 'Big Endian ✓', artist: 'Uno; Due', genre: 'Pop; Remix; Synthwave', date: '2023-01-02T03:04', year: '2023', lyrics: 'from txxx', album: 'Grouped' }, 'v2.4');
    assert(extraOf(m, 'TXXX:long') === big, 'plain-size frame read whole');
    const p = m.pictures[0];
    assert(p && p.description === 'fröntal' && p.mime === 'image/png' && p.width === 256 && p.height === 200 && eqBytes(p.bytes, art), 'frame-unsynced APIC');
    assert(m.warnings.length === 0, m.warnings.join('|'));
    // the same tag appended at the end of the file (footer) is found too
    const tail = await readMetadata(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400), tag]));
    assert(tail.tags.title === 'Big Endian ✓' && tail.format === 'mp3', `appended v2.4: ${JSON.stringify(tail.tags)}`);
    // ID3v2.2 (3-char ids, PIC with image format)
    const v22 = id3tag(2, [
      frame(2, 'TT2', TE.latin1('Two point two')),
      frame(2, 'TP1', TE.utf16('Ärtist')),
      frame(2, 'TCO', TE.latin1('(17)')),
      frame(2, 'TYE', TE.latin1('1998')),
      frame(2, 'COM', Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from([0]), Buffer.from('c22')])),
      frame(2, 'ULT', Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from([0]), Buffer.from('ly22')])),
      frame(2, 'PIC', Buffer.concat([Buffer.from([0]), Buffer.from('PNG'), Buffer.from([3, 0]), art])),
      frame(2, 'TT1', TE.latin1('grp')),
    ]);
    const m2 = await readMetadata(Buffer.concat([v22, Buffer.from([0xff, 0xfb, 0x90, 0x64])]));
    assertTags(m2.tags, { title: 'Two point two', artist: 'Ärtist', genre: 'Rock', date: '1998', comment: 'c22', lyrics: 'ly22', grouping: 'grp' }, 'v2.2');
    assert(m2.tagTypes[0] === 'ID3v2.2' && m2.pictures[0].mime === 'image/png' && m2.pictures[0].type === 3, 'v2.2 PIC');
    // compressed v2.2 tag / unknown major version: skipped with a warning, never thrown
    const c22 = await readMetadata(id3tag(2, [frame(2, 'TT2', TE.latin1('x'))], { flags: 0x40 }));
    assert(!c22.tags.title && c22.warnings.some((w) => /compressed/.test(w)), 'compressed v2.2');
    const v5 = await readMetadata(id3tag(5, [frame(3, 'TIT2', TE.latin1('x'))]));
    assert(!v5.tags.title && v5.warnings.some((w) => /unsupported/.test(w)), 'v2.5');
  },

  'metadata: APEv2 tag (with binary cover) and ID3v1 at the end of an MP3': async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 9, 0, 0, 0, 7, 8, 2, 0, 0, 0]);
    const item = (key, value, flags = 0) => Buffer.concat([le32(value.length), le32(flags), Buffer.from(key, 'latin1'), Buffer.from([0]), value]);
    const items = [
      item('Title', Buffer.from('Ape title ✓', 'utf8')),
      item('Artist', Buffer.from('A1\0A2', 'utf8')),
      item('Year', Buffer.from('2010')),
      item('REPLAYGAIN_TRACK_GAIN', Buffer.from('-3.1 dB')),
      item('Cover Art (Front)', Buffer.concat([Buffer.from('cover.png\0'), png]), 2),
    ];
    const body = Buffer.concat(items);
    const footer = Buffer.concat([Buffer.from('APETAGEX'), le32(2000), le32(body.length + 32), le32(items.length), le32(0), Buffer.alloc(8)]);
    const v1 = Buffer.alloc(128);
    v1.write('TAG', 0);
    v1.write('V1 title', 3, 'latin1');
    v1.write('V1 album', 63, 'latin1');
    v1[127] = 255;
    const file = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(1000), body, footer, v1]);
    const m = await readMetadata(file);
    assert(m.format === 'mp3' && m.tagTypes.join() === 'APEv2,ID3v1', m.tagTypes.join());
    assertTags(m.tags, { title: 'Ape title ✓', artist: 'A1; A2', date: '2010', album: 'V1 album' }, 'ape');
    assert(extraOf(m, 'APE:REPLAYGAIN_TRACK_GAIN') === '-3.1 dB', 'ape extra');
    assert(m.pictures.length === 1 && m.pictures[0].width === 9 && m.pictures[0].height === 7 && m.pictures[0].type === 3, 'ape cover');
    assert(!m.tags.genre, 'ID3v1 genre 255 = none');
  },

  // ------------------------------------------------------------------------- MP4 / M4A
  'metadata: M4A (AAC) ilst — covr JPEG, ©lyr, trkn/disk, freeform; moov at end, faststart, mdta keys': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const base = ['-i', f.src, '-i', f.jpg, '-map', '0', '-map', '1', '-c:a', 'aac', '-b:a', '128k', '-c:v', 'copy', '-disposition:v', 'attached_pic', ...COMMON, '-metadata', 'date=2022-07-08', '-metadata', 'grouping=Grp'];
    const out = [];
    for (const [name, extra] of [['tail.m4a', []], ['fast.m4a', ['-movflags', '+faststart']]]) {
      const path = fixture(name, [...base, ...extra]);
      const m = await readMetadata(readFileSync(path));
      assert(m.format === 'm4a' && m.tagTypes[0] === 'MP4 (iTunes ilst)', `${m.format} ${m.tagTypes}`);
      assertTags(m.tags, {
        title: 'Très bien – “ok” ♫', artist: 'Ünïcode Artist', album: 'The Album', albumArtist: 'Various', genre: 'Pop',
        track: '3/12', disc: '1/2', composer: 'Comp Oser', comment: 'A comment', copyright: '(c) 2024 Me',
        lyrics: 'First line\nSecond line', date: '2022-07-08', year: '2022', grouping: 'Grp',
      }, name);
      assert(m.pictures.length === 1 && m.pictures[0].mime === 'image/jpeg' && m.pictures[0].width === 40 && m.pictures[0].type === 3, `${name} covr`);
      assert(eqBytes(m.pictures[0].bytes, readFileSync(f.jpg)), `${name} covr bytes`);
      assert(m.warnings.length === 0, `${name}: ${m.warnings}`);
      out.push(`${name} ok`);
    }
    // QuickTime 'mdta' keys (FFmpeg -movflags use_metadata_tags): keys box + index-typed items
    const mdta = fixture('mdta.m4a', ['-i', f.src, '-c:a', 'aac', '-b:a', '96k', '-movflags', 'use_metadata_tags', '-metadata', 'title=Key title', '-metadata', 'MYKEY=key value']);
    const mk = await readMetadata(readFileSync(mdta));
    assert(mk.tags.title === 'Key title' && extraOf(mk, 'MYKEY') === 'key value', `mdta ${JSON.stringify(mk)}`);
    return out.join(', ');
  },

  // ------------------------------------------------------------------- FLAC / Ogg
  'metadata: FLAC — Vorbis comment, PICTURE block, track totals, DESCRIPTION; FLAC with a stray ID3v2 prefix': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const path = fixture('pic.flac', ['-i', f.src, '-i', f.png, '-map', '0', '-map', '1', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', ...COMMON, '-metadata', 'date=2020', '-metadata:s:v', 'comment=Cover (front)', '-metadata:s:v', 'title=flac pic']);
    const m = await readMetadata(readFileSync(path));
    assert(m.format === 'flac' && m.tagTypes[0] === 'FLAC Vorbis comment', m.tagTypes.join());
    assertTags(m.tags, { title: 'Très bien – “ok” ♫', artist: 'Ünïcode Artist', track: '3/12', disc: '1/2', albumArtist: 'Various', lyrics: 'First line\nSecond line', comment: 'A comment', date: '2020' }, 'flac');
    assert(/^Lavf/.test(extraOf(m, 'vendor')) && extraOf(m, 'MYKEY') === 'my value', JSON.stringify(m.extra));
    const p = m.pictures[0];
    assert(p && p.type === 3 && p.description === 'flac pic' && p.width === 64 && p.height === 48 && eqBytes(p.bytes, readFileSync(f.png)), 'flac picture');
    // hand-built: TRACKTOTAL/DISCTOTAL merge, DESCRIPTION → comment, repeated ARTIST, picture with declared size only
    const vc = (entries) => Buffer.concat([le32(3), Buffer.from('ven'), le32(entries.length), ...entries.map((e) => { const b = Buffer.from(e, 'utf8'); return Buffer.concat([le32(b.length), b]); })]);
    const block = (type, data, last = false) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
    const notImage = Buffer.from('not an image at all');
    const flac = Buffer.concat([
      Buffer.from('fLaC'), block(0, Buffer.alloc(34)), block(1, Buffer.alloc(100)),
      block(4, vc(['tracknumber=4', 'TRACKTOTAL=9', 'DISCNUMBER=2', 'DISCTOTAL=3', 'ARTIST=One', 'ARTIST=Two', 'DESCRIPTION=desc text', 'title=lower key'])),
      block(6, flacPicture(8, 'image/x-weird', 'artist pic', notImage, 300, 200), true),
    ]);
    const mh = await readMetadata(flac);
    assertTags(mh.tags, { track: '4/9', disc: '2/3', artist: 'One; Two', comment: 'desc text', title: 'lower key' }, 'hand flac');
    const q = mh.pictures[0];
    // (not an image and not declared as one of IMAGE_MIMES → never exposed with its own mime)
    assert(q.type === 8 && q.mime === 'application/octet-stream' && q.width === 300 && q.height === 200 && mh.warnings.some((w) => /not a recognised image/.test(w)), 'declared dims kept, warning for non-image');
    // ID3v2 in front of FLAC: format flac, Vorbis comment wins, ID3 fills the gaps
    const id3 = id3tag(3, [frame(3, 'TIT2', TE.latin1('id3 title')), frame(3, 'TALB', TE.latin1('id3 album'))]);
    const mix = await readMetadata(Buffer.concat([id3, flac]));
    assert(mix.format === 'flac' && mix.tags.title === 'lower key' && mix.tags.album === 'id3 album' && mix.tagTypes.join() === 'FLAC Vorbis comment,ID3v2.3', `${mix.format} ${JSON.stringify(mix.tags)} ${mix.tagTypes}`);
  },

  'metadata: Ogg Vorbis / Opus / FLAC — comment headers, METADATA_BLOCK_PICTURE spanning pages, legacy COVERART': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const small = readFileSync(f.png);
    const big = readFileSync(f.bigpng);
    assert(big.length > 100000, `big png ${big.length}`);
    const mbp = (data, type, desc) => `METADATA_BLOCK_PICTURE=${flacPicture(type, 'image/png', desc, data).toString('base64')}`;
    const out = [];
    for (const [name, args] of [
      ['vorbis.ogg', ['-c:a', 'vorbis', '-strict', '-2', '-ac', '2']],
      ['opus.opus', ['-c:a', 'libopus', '-b:a', '64k']],
      ['flac.oga', ['-c:a', 'flac', '-f', 'ogg']],
    ]) {
      const pic = name === 'opus.opus' ? big : small;
      const path = fixture(name, ['-i', f.src, ...args, ...COMMON, '-metadata', mbp(pic, 3, `ogg ${name}`)]);
      const m = await readMetadata(readFileSync(path));
      assert(m.format === 'ogg', `${name} format ${m.format}`);
      assertTags(m.tags, { title: 'Très bien – “ok” ♫', artist: 'Ünïcode Artist', lyrics: 'First line\nSecond line', track: '3/12' }, name);
      const p = m.pictures[0];
      assert(p && p.type === 3 && p.description === `ogg ${name}` && eqBytes(p.bytes, pic) && p.width === (pic === big ? 256 : 64), `${name} picture`);
      assert(m.warnings.length === 0, `${name}: ${m.warnings}`);
      const pr = probe(path);
      assert(pr.tags.title === 'Très bien – “ok” ♫', `${name} ffprobe title`);
      out.push(`${name}: ${m.tagTypes[0]}, picture ${p.size} B`);
    }
    // legacy COVERART/COVERARTMIME pair
    const legacy = fixture('legacy.ogg', ['-i', f.src, '-c:a', 'vorbis', '-strict', '-2', '-ac', '2', '-metadata', `COVERART=${small.toString('base64')}`, '-metadata', 'COVERARTMIME=image/png']);
    const ml = await readMetadata(readFileSync(legacy));
    assert(ml.pictures.length === 1 && eqBytes(ml.pictures[0].bytes, small) && ml.pictures[0].type === 3, 'COVERART');
    return out.join('; ');
  },

  // ------------------------------------------------------------------- WAV / AIFF
  'metadata: WAV LIST/INFO (FFmpeg), bext, odd chunk without pad byte; AIFF with ID3 chunk + cover and NAME/AUTH': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const path = fixture('info.wav', ['-i', f.src, '-c:a', 'pcm_s16le', ...COMMON, '-metadata', 'date=2019-01-01']);
    const m = await readMetadata(readFileSync(path));
    assert(m.format === 'wav' && m.tagTypes[0] === 'RIFF INFO', m.tagTypes.join());
    assertTags(m.tags, { title: 'Très bien – “ok” ♫', artist: 'Ünïcode Artist', album: 'The Album', genre: 'Pop', comment: 'A comment', copyright: '(c) 2024 Me', date: '2019-01-01', track: '3/12' }, 'info');
    // hand-built: bext + an odd-sized chunk whose pad byte is missing + INFO after data
    const sub = (id, s) => { const b = Buffer.from(`${s}\0`, 'latin1'); return Buffer.concat([Buffer.from(id), le32(b.length), b, Buffer.alloc(b.length & 1)]); };
    const info = Buffer.concat([Buffer.from('INFO'), sub('INAM', 'Hand title'), sub('IKEY', 'k1; k2'), sub('ICRD', '2001')]);
    const bext = Buffer.alloc(602 + 14);
    bext.write('BWF description', 0, 'latin1');
    bext.write('Originator', 256, 'latin1');
    bext.write('A=PCM,F=48000', 602, 'latin1');
    const fmt = Buffer.concat([Buffer.from([1, 0, 2, 0]), le32(48000), le32(192000), Buffer.from([4, 0, 16, 0])]);
    const wav = Buffer.concat([
      Buffer.from('RIFF'), le32(0), Buffer.from('WAVE'),
      Buffer.from('fmt '), le32(16), fmt,
      Buffer.from('junk'), le32(3), Buffer.from('abc'), // odd, pad byte missing
      Buffer.from('bext'), le32(bext.length), bext,
      Buffer.from('data'), le32(8), Buffer.alloc(8),
      Buffer.from('LIST'), le32(info.length), info,
    ]);
    const mh = await readMetadata(wav);
    assert(mh.tags.title === 'Hand title' && mh.tags.date === '2001' && extraOf(mh, 'IKEY') === 'k1; k2', JSON.stringify(mh));
    assert(extraOf(mh, 'bext:Description') === 'BWF description' && extraOf(mh, 'bext:CodingHistory') === 'A=PCM,F=48000', 'bext');
    // AIFF: FFmpeg writes an ID3 chunk (with the cover) when asked
    const aiff = fixture('id3.aiff', ['-i', f.src, '-i', f.png, '-map', '0', '-map', '1', '-c:a', 'pcm_s16be', '-c:v', 'copy', '-write_id3v2', '1', '-id3v2_version', '3', ...COMMON]);
    const ma = await readMetadata(readFileSync(aiff));
    assert(ma.format === 'aiff' && ma.tagTypes[0] === 'ID3v2.3' && ma.tags.title === 'Très bien – “ok” ♫' && ma.pictures.length === 1 && ma.pictures[0].width === 64, `aiff ${JSON.stringify(ma.tags)} ${ma.tagTypes}`);
    // AIFF text chunks
    const ck = (id, s) => { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from(id), be32(b.length), b, Buffer.alloc(b.length & 1)]); };
    const body = Buffer.concat([Buffer.from('AIFF'), ck('NAME', 'Aiff name'), ck('AUTH', 'Aiff author'), ck('(c) ', '2000 X'), ck('ANNO', 'note')]);
    const mt = await readMetadata(Buffer.concat([Buffer.from('FORM'), be32(body.length), body]));
    assertTags(mt.tags, { title: 'Aiff name', artist: 'Aiff author', copyright: '2000 X', comment: 'note' }, 'aiff text');
  },

  'metadata: picture dimensions from PNG/JPEG/GIF/BMP/WebP headers; mime fixed when declared wrong': async () => {
    if (!hasFfmpeg()) return 'skip';
    const f = makeFixtures();
    const cases = [[f.png, 'image/png', 64, 48], [f.jpg, 'image/jpeg', 40, 30], [f.gif, 'image/gif', 33, 21], [f.bmp, 'image/bmp', 17, 9]];
    if (f.webp) cases.push([f.webp, 'image/webp', 50, 26]);
    else {
      // this FFmpeg build has no WebP encoder: synthetic VP8L / VP8X headers
      const vp8l = Buffer.concat([Buffer.from('RIFF'), le32(30), Buffer.from('WEBPVP8L'), le32(10), Buffer.from([0x2f, (49) & 255, ((49) >> 8) | ((25 & 3) << 6), (25 >> 2) & 255, (25 >> 10) & 15, 0, 0, 0, 0, 0])]);
      const vp8x = Buffer.concat([Buffer.from('RIFF'), le32(30), Buffer.from('WEBPVP8X'), le32(10), Buffer.from([0, 0, 0, 0, 299 & 255, 299 >> 8, 0, 199, 0, 0])]);
      writeFileSync(fx('l.webp'), vp8l);
      writeFileSync(fx('x.webp'), vp8x);
      cases.push([fx('l.webp'), 'image/webp', 50, 26], [fx('x.webp'), 'image/webp', 300, 200]);
    }
    const frames = cases.map(([path], i) => frame(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0'), Buffer.from([i === 0 ? 3 : 18]), Buffer.from(`p${i}\0`), readFileSync(path)])));
    const m = await readMetadata(id3tag(3, frames));
    assert(m.pictures.length === cases.length, 'all pictures');
    cases.forEach(([, mime, w, h], i) => {
      const p = m.pictures[i];
      assert(p.mime === mime && p.width === w && p.height === h, `${mime}: ${p.mime} ${p.width}x${p.height}`);
    });
    return cases.map(([, mime, w, h]) => `${mime.slice(6)} ${w}x${h}`).join(', ');
  },

  // ------------------------------------------------------------------ robustness
  'metadata: garbage, truncated and hostile inputs never throw; Blob and bytes agree': async () => {
    const r = rng(42);
    for (const n of [0, 1, 3, 4, 10, 127, 128, 1000, 65537]) {
      for (let k = 0; k < 4; k++) {
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
        const m = await readMetadata(b);
        assert(m && Array.isArray(m.warnings) && typeof m.tags === 'object', 'shape');
      }
    }
    for (const bad of [null, undefined, 42, 'string', {}, [1, 2, 3]]) {
      const m = await readMetadata(bad);
      assert(m.format === 'other' && m.warnings.length === 1, `bad input ${String(bad)}`);
    }
    const empty = await readMetadata(new Uint8Array(0));
    assert(empty.warnings[0] === 'empty file', 'empty');
    // every input kind: ArrayBuffer, DataView, Node Buffer slice with byteOffset, Blob
    const t = id3tag(3, [frame(3, 'TIT2', TE.latin1('kinds'))]);
    const padded = Buffer.concat([Buffer.alloc(7), t]).subarray(7);
    for (const input of [t.buffer.slice(t.byteOffset, t.byteOffset + t.length), new DataView(padded.buffer, padded.byteOffset, padded.length), padded, new Blob([t])]) {
      assert((await readMetadata(input)).tags.title === 'kinds', `input kind ${Object.prototype.toString.call(input)}`);
    }
    // magic + absurd sizes
    const hostile = [
      Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]), Buffer.from('TIT2'), be32(0xfffffff0)]),
      Buffer.concat([Buffer.from('RIFF'), le32(100), Buffer.from('WAVE'), Buffer.from('LIST'), le32(0xfffffff0), Buffer.from('INFO')]),
      Buffer.concat([Buffer.from('RIFF'), le32(100), Buffer.from('WAVE'), Buffer.from('id3 '), le32(0xfffffff0), Buffer.from('ID3\x03\0\0\x7f\x7f\x7f\x7f')]),
      Buffer.concat([be32(16), Buffer.from('ftypM4A '), be32(0), be32(0xfffffff0), Buffer.from('moov'), be32(1), Buffer.from('udta')]),
      Buffer.concat([be32(8), Buffer.from('ftyp'), be32(1), Buffer.from('moov'), be32(0xffffffff), be32(0xffffffff)]),
      Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x04, 0xff, 0xff, 0xff]), le32(0xfffffff0)]),
      Buffer.concat([Buffer.from('OggS'), Buffer.alloc(22), Buffer.from([255]), Buffer.alloc(255, 255)]),
      Buffer.concat([Buffer.from('FORM'), be32(100), Buffer.from('AIFF'), Buffer.from('ID3 '), be32(0xfffffff0)]),
    ];
    for (const h of hostile) {
      const m = await readMetadata(h);
      assert(m.warnings.length > 0, `hostile ${h.subarray(0, 12).toString('latin1')} → warnings`);
    }
    if (!hasFfmpeg()) return 'ffmpeg fixtures skipped';
    // every fixture, cut at many points, as bytes and as Blob: same result, no throw
    const f = makeFixtures();
    const paths = ['v23.mp3', 'v24.mp3', 'tail.m4a', 'fast.m4a', 'pic.flac', 'opus.opus', 'vorbis.ogg', 'info.wav', 'id3.aiff'].map(fx).filter(existsSync);
    paths.push(f.bare);
    let cuts = 0;
    for (const path of paths) {
      const full = new Uint8Array(readFileSync(path));
      const whole = await readMetadata(new Blob([full]));
      const asBytes = await readMetadata(full);
      assertSameMeta(whole, asBytes, `${path} Blob vs bytes`);
      for (const frac of [0.001, 0.01, 0.05, 0.1, 0.3, 0.5, 0.9, 0.999]) {
        const cut = full.subarray(0, Math.floor(full.length * frac));
        const m = await readMetadata(cut);
        const mb = await readMetadata(new Blob([cut]));
        assert(JSON.stringify(m.tags) === JSON.stringify(mb.tags), 'truncated Blob vs bytes');
        for (const [k, v] of Object.entries(m.tags)) assert(whole.tags[k] === v || whole.tags[k].startsWith(v) || k === 'year' || k === 'date', `${path}@${frac}: ${k}=${v} not in full read`);
        cuts++;
      }
    }
    return `${paths.length} fixtures × 8 cuts (${cuts}) ok`;
  },

  'metadata: bounded reads — multi-GB virtual WAV/RF64/MP4/MP3 read only their tag regions': async () => {
    const id3 = id3tag(3, [frame(3, 'TIT2', TE.latin1('Far title')), frame(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3, 0]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000)]))]);
    const info = Buffer.concat([Buffer.from('INFO'), Buffer.from('IART'), le32(6), Buffer.from('Artis\0')]);
    const fmt = Buffer.concat([Buffer.from('fmt '), le32(16), Buffer.from([1, 0, 2, 0]), le32(48000), le32(192000), Buffer.from([4, 0, 16, 0])]);
    const out = [];
    // 1.5 GB WAV, tags after 'data'
    {
      const dataLen = 1.5e9;
      const head = Buffer.concat([Buffer.from('RIFF'), le32(0xffffffff), Buffer.from('WAVE'), fmt, Buffer.from('data'), le32(dataLen)]);
      const tail = Buffer.concat([Buffer.from('LIST'), le32(info.length), info, Buffer.from('id3 '), le32(id3.length), id3]);
      const blob = new VirtualBlob(head.length + dataLen + tail.length, [{ offset: 0, bytes: head }, { offset: head.length + dataLen, bytes: tail }]);
      const m = await readMetadata(blob);
      assert(m.tags.title === 'Far title' && m.tags.artist === 'Artis' && m.pictures.length === 1, `wav ${JSON.stringify(m.tags)} ${m.warnings}`);
      assert(blob.bytesRead < 300000, `wav read ${blob.bytesRead} bytes`);
      out.push(`WAV 1.5 GB: ${blob.bytesRead} B in ${blob.reads} reads`);
    }
    // 5 GB RF64 (ds64 data size), tags after data
    {
      const dataLen = 5e9;
      const ds64 = Buffer.concat([Buffer.from('ds64'), le32(28), le32(0), le32(0), le32(dataLen % 4294967296), le32(Math.floor(dataLen / 4294967296)), Buffer.alloc(12)]);
      const head = Buffer.concat([Buffer.from('RF64'), le32(0xffffffff), Buffer.from('WAVE'), ds64, fmt, Buffer.from('data'), le32(0xffffffff)]);
      const tail = Buffer.concat([Buffer.from('LIST'), le32(info.length), info]);
      const blob = new VirtualBlob(head.length + dataLen + tail.length, [{ offset: 0, bytes: head }, { offset: head.length + dataLen, bytes: tail }]);
      const m = await readMetadata(blob);
      assert(m.tags.artist === 'Artis' && blob.bytesRead < 300000, `rf64 ${JSON.stringify(m.tags)} read ${blob.bytesRead}`);
      out.push(`RF64 5 GB: ${blob.bytesRead} B`);
    }
    // 2 GB M4A: mdat first (64-bit size), moov with udta/meta/ilst at the end
    {
      const box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([be32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
      const data = (type, payload) => box('data', be32(type), be32(0), payload);
      const ilst = box('ilst', box('\xa9nam', data(1, Buffer.from('MP4 title'))), box('trkn', data(0, Buffer.from([0, 0, 0, 5, 0, 9, 0, 0]))), box('gnre', data(0, Buffer.from([0, 18]))));
      const meta = box('meta', be32(0), box('hdlr', Buffer.alloc(25)), ilst);
      const moov = box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('mdia', Buffer.alloc(5000))), box('udta', meta));
      const mdatLen = 2e9;
      const head = Buffer.concat([box('ftyp', Buffer.from('M4A '), be32(0)), be32(1), Buffer.from('mdat'), be32(Math.floor((mdatLen + 16) / 4294967296)), be32((mdatLen + 16) % 4294967296)]);
      const blob = new VirtualBlob(head.length + mdatLen + moov.length, [{ offset: 0, bytes: head }, { offset: head.length + mdatLen, bytes: moov }]);
      const m = await readMetadata(blob);
      assertTags(m.tags, { title: 'MP4 title', track: '5/9', genre: 'Rock' }, 'virtual m4a');
      assert(blob.bytesRead < 300000, `m4a read ${blob.bytesRead}`);
      out.push(`M4A 2 GB: ${blob.bytesRead} B`);
    }
    // 800 MB MP3: ID3v2 at the start, ID3v1 at the end
    {
      const v1 = Buffer.alloc(128);
      v1.write('TAG', 0);
      v1.write('v1 album', 63, 'latin1');
      v1[127] = 13;
      const size = 8e8;
      const blob = new VirtualBlob(size, [{ offset: 0, bytes: Buffer.concat([id3, Buffer.from([0xff, 0xfb, 0x90, 0x64])]) }, { offset: size - 128, bytes: v1 }]);
      const m = await readMetadata(blob);
      assert(m.tags.title === 'Far title' && m.tags.album === 'v1 album' && m.tags.genre === 'Pop' && blob.bytesRead < 300000, `mp3 ${JSON.stringify(m.tags)} read ${blob.bytesRead}`);
      out.push(`MP3 800 MB: ${blob.bytesRead} B`);
    }
    return out.join('; ');
  },

  // ------------------------------------------------------------------ writers
  'metadata: buildId3v2 — exact round trip, encodings, date frames, extra-key mapping; buildRiffInfo layout': async () => {
    const tags = {};
    for (const k of TAG_KEYS) tags[k] = `${k} välue`;
    tags.date = '2025-04-11T10:20';
    tags.year = '2025';
    tags.originalDate = '1999';
    tags.lyrics = 'l1\nl2 ♫';
    const meta = {
      tags,
      extra: [
        { key: 'TOPE', label: 'Original artist', value: 'Orig' },
        { key: 'WOAS', label: 'Official audio source webpage', value: 'https://suno.com/song/abc' },
        { key: 'TXXX:Ünï', label: 'Ünï', value: 'ü' },
        { key: 'WXXX:home', label: 'home', value: 'https://example.com/ä' },
        { key: 'COMM:note', label: 'note', value: 'second' },
        { key: 'USLT:alt', label: 'alt', value: 'alt lyrics' },
      ],
      pictures: [{ mime: 'image/png', type: 3, description: 'Fröñt', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3]) }],
    };
    const tag = buildId3v2(meta);
    assert(tag[0] === 0x49 && tag[3] === 3 && tag[4] === 0 && tag[5] === 0, 'ID3v2.3 header, no flags');
    const m = await readMetadata(tag);
    const want = prepareExportMetadata(meta, { encoder: tags.encoder });
    want.extra[3] = { ...want.extra[3], value: 'https://example.com/%C3%A4' }; // URLs are Latin-1: non-ASCII is percent-encoded
    assertSameMeta(m, { ...want, pictures: want.pictures }, 'buildId3v2');
    assert(m.warnings.length === 0, m.warnings.join());
    // ASCII → ISO-8859-1 (0), anything else → UTF-16 with BOM FF FE
    const find = (b, id) => { for (let i = 10; i < b.length - 4; i++) if (b[i] === id.charCodeAt(0) && b[i + 1] === id.charCodeAt(1) && b[i + 2] === id.charCodeAt(2) && b[i + 3] === id.charCodeAt(3)) return i; return -1; };
    const ascii = buildId3v2({ tags: { title: 'Plain', artist: 'Ärtist' } });
    const t = find(ascii, 'TIT2');
    const a = find(ascii, 'TPE1');
    assert(ascii[t + 10] === 0 && ascii[a + 10] === 1 && ascii[a + 11] === 0xff && ascii[a + 12] === 0xfe, 'text encodings');
    // date variants (v2.3 has no TDRC: a value the TYER/TDAT/TIME frames cannot hold also goes to TXXX 'DATE')
    const dates = { 2025: ['TYER'], '2025-04-11': ['TYER', 'TDAT'], '2025-04-11T10:20': ['TYER', 'TDAT', 'TIME'], 'April 2025': ['TYER', 'TXXX'] };
    for (const [d, ids] of Object.entries(dates)) {
      const b = buildId3v2({ tags: { date: d } });
      for (const id of ['TYER', 'TDAT', 'TIME', 'TDRC', 'TXXX']) assert((find(b, id) >= 0) === ids.includes(id), `date ${d}: ${id}`);
      const back = await readMetadata(b);
      assert(back.tags.date === d && back.tags.year === '2025', `date ${d} → ${back.tags.date}/${back.tags.year}`);
    }
    // keys of other formats become TXXX with their label
    const other = await readMetadata(buildId3v2({ extra: [{ key: '----:com.apple.iTunes:MOOD', label: 'MOOD', value: 'calm' }, { key: 'IKEY', label: 'Keywords', value: 'a; b' }, { key: 'REMIX_OF', label: '', value: 'x' }] }));
    assert(extraOf(other, 'TXXX:Keywords') === 'a; b' && extraOf(other, 'TXXX:REMIX_OF') === 'x' && other.tags.mood === 'calm', JSON.stringify(other));
    // padding and empty input
    const padded = buildId3v2({ tags: { title: 'x' } }, { padding: 100 });
    assert(padded.length === buildId3v2({ tags: { title: 'x' } }).length + 100 && (await readMetadata(padded)).tags.title === 'x', 'padding');
    assert(buildId3v2({}).length === 10 && buildId3v2().length === 10, 'empty tag');
    // RIFF INFO: word-aligned subchunks, UTF-8, NUL-terminated
    const info = buildRiffInfo({ title: 'Tïtle', artist: 'AB', date: '2020', encoder: 'AudioMaster', lyrics: 'not written' });
    assert(info.length % 2 === 0 && Buffer.from(info.subarray(0, 4)).toString() === 'LIST' && Buffer.from(info.subarray(8, 12)).toString() === 'INFO', 'LIST/INFO header');
    assert(new DataView(info.buffer).getUint32(4, true) === info.length - 8, 'LIST size');
    assert(!Buffer.from(info).includes(Buffer.from('not written')), 'lyrics not in INFO');
    assert(buildRiffInfo({}) === null && buildRiffInfo({ lyrics: 'x' }) === null, 'empty INFO → null');
  },

  'metadata: prepareExportMetadata drops source-encoding data, sets encoder, is idempotent': async () => {
    if (!hasFfmpeg()) return 'skip'; // the sample pictures are made with ffmpeg
    const meta = sampleMeta();
    const p = prepareExportMetadata(meta);
    assert(p.tags.encoder === 'AudioMaster' && p.tags.year === '2025' && p.tags.title === meta.tags.title, JSON.stringify(p.tags));
    const keys = p.extra.map((e) => e.key);
    assert(keys.join() === 'WOAS,TXXX:Mood words,TOPE,COMM:Short', `kept ${keys}`);
    assert(p.pictures.length === 2 && p.pictures[0].width === 64 && p.pictures[1].typeLabel === 'Front cover', 'pictures normalized');
    assert(p.pictures[0].bytes === meta.pictures[0].bytes, 'no copy of picture bytes');
    assertSameMeta(prepareExportMetadata(p), p, 'idempotent');
    assert(prepareExportMetadata(meta, { encoder: null }).tags.encoder === undefined, 'encoder null');
    const dropped = prepareExportMetadata({
      extra: [
        { key: 'REPLAYGAIN_ALBUM_PEAK', value: '1' }, { key: '----:com.apple.iTunes:iTunNORM', value: 'x' }, { key: 'vendor', value: 'v' },
        { key: 'UFID:http://musicbrainz.org', value: 'id' }, { key: 'PCNT', value: '3' }, { key: 'COMM:iTunPGAP', value: '0' },
        { key: 'ENCODER_OPTIONS', value: '-q5' }, { key: 'bext:CodingHistory', value: 'A=PCM' }, { key: 'pgap', value: '1' },
        { key: 'APE:MP3GAIN_MINMAX', value: '1,2' }, { key: 'R128_TRACK_GAIN', value: '0' },
      ],
    });
    assert(dropped.extra.length === 0, `dropped ${JSON.stringify(dropped.extra)}`);
    assert(!hasExportMetadata(dropped) && !hasExportMetadata(prepareExportMetadata(null)) && hasExportMetadata(p), 'hasExportMetadata');
    const huge = prepareExportMetadata({ pictures: [{ bytes: new Uint8Array(MAX_EXPORT_PICTURE_BYTES + 1) }, { bytes: new Uint8Array(readFileSync(makeFixtures().jpg)).buffer }] });
    assert(huge.pictures.length === 1 && huge.pictures[0].mime === 'image/jpeg' && huge.pictures[0].type === 3, 'size cap; ArrayBuffer bytes; default type');
    assert(cleanText('  a\r\nb\rc\0junk ') === 'a\nb\nc' && PICTURE_TYPES[3] === 'Front cover', 'cleanText');
  },

  'metadata: encodeMp3 round trip — tags/lyrics/covers read back, FFprobe agrees, gapless length unchanged': async () => {
    const stream = lameStream(44100, 3);
    if (!stream) return 'skip';
    const plain = await encodeMp3WithStub(stream, {});
    const meta = sampleMeta();
    const tagged = await encodeMp3WithStub(stream, { metadata: meta });
    const id3Len = tagged.length - plain.length;
    assert(id3Len > 0 && eqBytes(tagged.subarray(id3Len), plain), 'ID3 tag prepended, audio + Info frame unchanged');
    const empty = await encodeMp3WithStub(stream, { metadata: { tags: { encoder: 'x' } } });
    assert(eqBytes(empty, plain), 'nothing to write → no tag');
    const back = await readMetadata(tagged);
    assertSameMeta(back, prepareExportMetadata(meta), 'mp3 round trip');
    assert(back.tagTypes.join() === 'ID3v2.3' && back.warnings.length === 0, `${back.tagTypes} ${back.warnings}`);
    // decoders: same exact length (Info/LAME gapless still honoured), FFprobe sees tags + both pictures
    const path = fx('rt.mp3');
    writeFileSync(path, tagged);
    const dec = ffmpegDecode(path);
    assert(dec[0].length === stream.n, `decoded ${dec[0].length} vs ${stream.n}`);
    const s = sniffFormat(tagged);
    assert(s.tag === 'Info' && s.encoderDelay === 576 && s.totalSamples === stream.n, `sniff ${JSON.stringify(s)}`);
    const pr = probe(path);
    assert(pr.tags.title === meta.tags.title && pr.tags.artist === meta.tags.artist && pr.tags.album === 'Album' && pr.tags.album_artist === 'Various', JSON.stringify(pr.tags));
    assert(pr.tags.date.startsWith('2025') && pr.tags.track === '3/12' && pr.tags.disc === '1/2' && pr.tags.genre === 'Pop' && pr.tags.encoder === 'AudioMaster', JSON.stringify(pr.tags));
    assert(pr.tags['lyrics-eng'] === meta.tags.lyrics && pr.tags.comment === 'Mastered for test' && pr.tags['mood words'] === 'warm, nostalgic', JSON.stringify(pr.tags));
    assert(!('itunsmpb' in pr.tags) && !('replaygain_track_gain' in pr.tags), 'source gapless/loudness data not carried');
    assert(pr.pics.length === 2 && pr.pics[0].codec_name === 'png' && pr.pics[0].width === 64 && pr.pics[1].codec_name === 'mjpeg' && pr.pics[1].width === 40, JSON.stringify(pr.pics.map((p) => [p.codec_name, p.width])));
    const warn = spawnSync('ffmpeg', ['-hide_banner', '-v', 'warning', '-i', path, '-map', '0:a', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    assert(!/error|invalid|crc/i.test(warn), `ffmpeg warnings: ${warn}`);
    return `ID3 ${id3Len} B, ${dec[0].length} samples (exact)`;
  },

  'metadata: encodeWav round trip — LIST/INFO + id3 before data, tag 1 kept, PCM identical, FFprobe reads tags and cover': async () => {
    if (!hasFfmpeg()) return 'skip'; // the sample pictures are made with ffmpeg
    const sr = 48000;
    const L = sine(997, 0.5, sr, 0.5);
    const R = pinkNoise(0.5, sr, 0.3, 3);
    const meta = sampleMeta();
    const out = [];
    for (const bitDepth of [16, 24, 32]) {
      const plain = new Uint8Array(encodeWavBuffer({ sampleRate: sr, channels: [L, R] }, { bitDepth, seed: 4 }));
      const tagged = new Uint8Array(encodeWavBuffer({ sampleRate: sr, channels: [L, R] }, { bitDepth, seed: 4, metadata: meta }));
      const dv = new DataView(tagged.buffer);
      assert(dv.getUint32(4, true) === tagged.length - 8, 'RIFF size');
      // chunk walk: fmt [fact] LIST id3 data(last); all even sized
      const ids = [];
      let p = 12;
      while (p + 8 <= tagged.length) {
        const id = Buffer.from(tagged.subarray(p, p + 4)).toString('latin1');
        const len = dv.getUint32(p + 4, true);
        ids.push(id);
        p += 8 + len + (len & 1);
      }
      assert(p === tagged.length, `chunks tile the file (${p} vs ${tagged.length})`);
      assert(ids.join() === (bitDepth === 32 ? 'fmt ,fact,LIST,id3 ,data' : 'fmt ,LIST,id3 ,data'), ids.join());
      assert(dv.getUint16(20, true) === (bitDepth === 32 ? 3 : 1), 'format tag unchanged');
      // audio bytes identical to the untagged file ('data' payload is the tail of both)
      const hdr = bitDepth === 32 ? 58 : 44;
      assert(eqBytes(tagged.subarray(tagged.length - (plain.length - hdr)), plain.subarray(hdr)), 'PCM identical');
      const a = parseWav(tagged.buffer);
      const b = parseWav(plain.buffer);
      assert(a.frames === b.frames && a.channels[0].every((v, i) => v === b.channels[0][i]), 'parseWav reads the same samples');
      const back = await readMetadata(tagged);
      assertSameMeta(back, prepareExportMetadata(meta), `wav${bitDepth} round trip`);
      assert(back.tagTypes.join() === 'ID3v2.3,RIFF INFO' && back.warnings.length === 0, `${back.tagTypes} ${back.warnings}`);
      if (hasFfmpeg()) {
        const path = fx(`rt${bitDepth}.wav`);
        writeFileSync(path, tagged);
        const pr = probe(path);
        assert(pr.tags.title === meta.tags.title && pr.tags.artist === meta.tags.artist && pr.tags.album === 'Album', `ffprobe ${JSON.stringify(pr.tags)}`);
        assert(pr.pics.length === 2 && pr.pics[0].width === 64 && pr.pics[1].width === 40, `ffprobe pictures ${pr.pics.length}`);
        const audio = pr.streams.find((s) => s.codec_type === 'audio');
        assert(audio && Number(audio.duration_ts) === L.length, `ffprobe duration ${audio && audio.duration_ts}`);
        const d1 = ffmpegDecode(path);
        assert(d1[0].length === L.length, 'ffmpeg decodes all frames');
        if (existsSync('/usr/bin/afinfo')) {
          // Apple's CoreAudio (Music, QuickLook): composer/tempo exist only in the 'id3 ' chunk
          const info = spawnSync('/usr/bin/afinfo', ['-i', path], { encoding: 'utf8' }).stdout;
          assert(info.includes(meta.tags.title) && /composer\s+: "Comp"/.test(info) && /tempo\s+: "120"/.test(info), `afinfo: ${info}`);
        }
      }
      out.push(`${bitDepth}-bit +${tagged.length - plain.length} B`);
    }
    // the Blob API passes metadata through; no metadata → byte-identical to before
    const blob = encodeWav({ sampleRate: sr, channels: [L, R] }, { bitDepth: 24, metadata: meta });
    assert((await readMetadata(blob)).tags.title === meta.tags.title, 'encodeWav Blob');
    const n1 = new Uint8Array(encodeWavBuffer({ sampleRate: sr, channels: [L, R] }, { metadata: null }));
    const n2 = new Uint8Array(encodeWavBuffer({ sampleRate: sr, channels: [L, R] }));
    assert(eqBytes(n1, n2) && n1.length === 44 + L.length * 6, 'no metadata → unchanged layout');
    assert(wavMetadataChunks({ tags: { encoder: 'only' } }).length === 0, 'nothing to write → no chunks');
    // odd-sized id3 chunk gets its pad byte
    const odd = wavMetadataChunks({ tags: { title: 'ab' } });
    assert(odd.every((c) => c.length % 2 === 0), 'word aligned');
    return out.join(', ');
  },

  // ------------------------------------------------------------- hardening (hostile and edge-case tags)
  'metadata: ID3v2.4 frame-size mode is decided once per tag — iTunes plain sizes with 0x00 in the cover, spec sizes, mixed fallback': async () => {
    const tagOf = (plain, img, extra = []) => {
      const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0'), Buffer.from([3, 0]), img]);
      const frames = [frame(4, 'TIT2', TE.utf8('Title'), { plainSize: plain }), frame(4, 'APIC', apic, { plainSize: plain }), ...extra,
        frame(4, 'TPE1', TE.utf8('Artist'), { plainSize: plain }), frame(4, 'TALB', TE.utf8('Album'), { plainSize: plain })];
      return Buffer.concat([id3tag(4, frames, { padding: 32 }), MPEG]);
    };
    // the reported case: a 300-byte APIC (size bytes 00 00 01 2C, sync-safe reading 172) whose
    // byte 172 is 0x00 — it used to be cut there and TPE1/TALB were read as padding
    const img = Buffer.alloc(300 - 14, 0x55);
    img.set([0xff, 0xd8, 0xff, 0xe0]);
    img[172 - 14] = 0;
    const m = await readMetadata(tagOf(true, img));
    assertTags(m.tags, { title: 'Title', artist: 'Artist', album: 'Album' }, 'iTunes v2.4');
    assert(m.pictures.length === 1 && m.pictures[0].size === img.length && m.warnings.length === 0, `picture ${m.pictures.map((p) => p.size)} ${m.warnings}`);
    // many JPEG-like covers (1 byte in 6 is 0x00) at many sizes, written both ways
    const r = rng(11);
    let n = 0;
    for (let k = 0; k < 300; k++) {
      const len = 128 + Math.floor(r() * 4000);
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i++) b[i] = r() < 1 / 6 ? 0 : 1 + Math.floor(r() * 255);
      b.set([0xff, 0xd8, 0xff, 0xe0]);
      for (const plain of [true, false]) {
        const mm = await readMetadata(tagOf(plain, b));
        const ok = mm.tags.artist === 'Artist' && mm.tags.album === 'Album' && mm.pictures[0] && eqBytes(mm.pictures[0].bytes, b) && !mm.warnings.length;
        assert(ok, `${plain ? 'plain' : 'sync-safe'} sizes, cover ${len} B: ${JSON.stringify(mm.tags)} ${mm.pictures.map((p) => p.size)} ${mm.warnings}`);
        n++;
      }
    }
    // a tag mixing both size kinds (no consistent walk): per-frame guess, with a warning
    const mixed = await readMetadata(tagOf(false, img, [frame(4, 'TXXX', TE.utf8(`big\0${'x'.repeat(300)}`), { plainSize: true }), frame(4, 'TCOM', TE.utf8(`${'y'.repeat(300)}`))]));
    assertTags(mixed.tags, { artist: 'Artist', album: 'Album', composer: 'y'.repeat(300) }, 'mixed sizes');
    assert(extraOf(mixed, 'TXXX:big') === 'x'.repeat(300) && mixed.warnings.some((w) => /guessed per frame/.test(w)), `mixed ${mixed.warnings}`);
    return `${n} tags`;
  },

  'metadata: lone UTF-16 surrogates read as U+FFFD; URL frames and both exporters never throw on metadata': async () => {
    // M4A ilst 'WOAR' atom, data type 2 (UTF-16BE) = D8 00 00 41: a lone high surrogate
    const m4a = Buffer.concat([M4A_FTYP, mp4box('moov', mp4box('udta', mp4meta(mp4box('\xa9nam', mp4data(1, Buffer.from('Song'))), mp4box('WOAR', mp4data(2, Buffer.from([0xd8, 0x00, 0x00, 0x41])))))), M4A_MDAT]);
    const m = await readMetadata(m4a);
    assert(m.tags.title === 'Song' && extraOf(m, 'WOAR') === '�A', JSON.stringify(m.extra));
    // writers fed lone surrogates directly
    const bad = { tags: { title: 'x\ud800', artist: '\udc00y' }, extra: [{ key: 'WOAR', value: '\ud800A' }, { key: 'WXXX:home', value: 'https://e.com/\udfff' }], pictures: [] };
    const tag = buildId3v2(prepareExportMetadata(bad));
    const back = await readMetadata(tag);
    assert(extraOf(back, 'WOAR') === '%EF%BF%BDA' && extraOf(back, 'WXXX:home') === 'https://e.com/%EF%BF%BD', JSON.stringify(back.extra));
    const audio = { sampleRate: 44100, channels: [new Float32Array(441), new Float32Array(441)] };
    for (const meta of [m, bad]) {
      const wav = new Uint8Array(encodeWavBuffer(audio, { metadata: meta }));
      assert((await readMetadata(wav)).tags.title, 'tagged WAV');
      const mp3 = await encodeMp3Stub({ metadata: meta });
      assert(Buffer.from(mp3.subarray(0, 3)).toString() === 'ID3' && (await readMetadata(mp3)).tags.title, 'tagged MP3');
    }
    // defence in depth: metadata that throws while being prepared leaves the master untagged
    const hostile = { get tags() { throw new Error('boom'); } };
    const plainWav = new Uint8Array(encodeWavBuffer(audio));
    assert(eqBytes(new Uint8Array(encodeWavBuffer(audio, { metadata: hostile })), plainWav) && wavMetadataChunks(hostile).length === 0, 'WAV untagged');
    const plainMp3 = await encodeMp3Stub({});
    assert(eqBytes(await encodeMp3Stub({ metadata: hostile }), plainMp3), 'MP3 untagged');
  },

  'metadata: hostile repetition is linear and capped — 40,000 TPE1 / TXXX frames, 20,000 pictures, warnings': async () => {
    const big = (make, n) => Buffer.concat([id3tag(3, Array.from({ length: n }, (_, i) => make(i))), MPEG]);
    let t0 = performance.now();
    const a = await readMetadata(big((i) => frame(3, 'TPE1', TE.latin1(`a${i}`)), 40000));
    const tA = performance.now() - t0;
    const values = a.tags.artist.split('; ');
    assert(values.length === MAX_TAG_ITEMS && values[0] === 'a0' && values[MAX_TAG_ITEMS - 1] === `a${MAX_TAG_ITEMS - 1}`, `artist values ${values.length}`);
    assert(a.warnings.some((w) => /dropped/.test(w)), a.warnings.join());
    t0 = performance.now();
    const x = await readMetadata(big((i) => frame(3, 'TXXX', TE.latin1(`d${i}\0v`)), 40000));
    const tX = performance.now() - t0;
    assert(x.extra.length === MAX_TAG_ITEMS && x.extra[0].key === 'TXXX:d0', `extra ${x.extra.length}`);
    assert(tA < 2000 && tX < 2000, `40,000 frames took ${tA.toFixed(0)} / ${tX.toFixed(0)} ms (was 36 s / 4.9 s)`);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
    const p = await readMetadata(big((i) => frame(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([i % 21, 0]), png])), 20000));
    assert(p.pictures.length === MAX_PICTURES, `pictures ${p.pictures.length}`);
    // every junk picture warns: the list is capped, the last entry counts the rest
    const j = await readMetadata(big(() => frame(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3, 0]), Buffer.from('junk')])), 5000));
    assert(j.warnings.length === MAX_WARNINGS && /more warnings/.test(j.warnings[MAX_WARNINGS - 1]), `warnings ${j.warnings.length}`);
    // de-duplication semantics unchanged: repeated values (also inside '; ' lists) are kept once
    const d = await readMetadata(id3tag(3, [frame(3, 'TPE1', TE.latin1('A')), frame(3, 'TPE1', TE.latin1('B')), frame(3, 'TPE1', TE.latin1('A')), frame(3, 'TCON', TE.latin1('(13)(17)')), frame(3, 'TCON', TE.latin1('Rock'))]));
    assertTags(d.tags, { artist: 'A; B', genre: 'Pop; Rock' }, 'dedupe');
    return `TPE1 ${tA.toFixed(0)} ms, TXXX ${tX.toFixed(0)} ms`;
  },

  'metadata: MP4 walk descends only moov → trak → udta → meta under legal parents (nested-header bomb)': async () => {
    const depth = 200000;
    // moov/udta/udta/…/udta/meta/ilst: 1.6 MB of nested headers
    const inner = mp4meta(mp4box('\xa9ART', mp4data(1, Buffer.from('deep'))));
    const bomb = Buffer.alloc(8 * depth + inner.length);
    for (let i = 0; i < depth; i++) {
      bomb.writeUInt32BE(bomb.length - 8 * i, 8 * i);
      bomb.write('udta', 8 * i + 4, 'latin1');
    }
    inner.copy(bomb, 8 * depth);
    const moov = mp4box('moov',
      mp4box('trak', mp4box('udta', mp4meta(mp4box('\xa9nam', mp4data(1, Buffer.from('Trak title')))))),
      mp4box('udta', mp4meta(mp4box('\xa9alb', mp4data(1, Buffer.from('Album')))), mp4box('meta', be32(0), mp4meta(mp4box('\xa9wrt', mp4data(1, Buffer.from('meta in meta')))))),
      bomb);
    const t0 = performance.now();
    const m = await readMetadata(Buffer.concat([M4A_FTYP, moov, M4A_MDAT]));
    const ms = performance.now() - t0;
    assertTags(m.tags, { title: 'Trak title', album: 'Album' }, 'legal paths');
    assert(!m.tags.artist && !m.tags.composer, `udta in udta / meta in meta not walked: ${JSON.stringify(m.tags)}`);
    assert(ms < 1000, `${ms.toFixed(0)} ms`);
    // moov/meta (QuickTime mdta keys) still read
    const kname = Buffer.from('com.apple.quicktime.title');
    const keys = mp4box('keys', be32(0), be32(1), Buffer.concat([be32(8 + kname.length), Buffer.from('mdta'), kname]));
    const qdata = mp4data(1, Buffer.from('QT title'));
    const qt = mp4box('moov', mp4box('meta', be32(0), mp4box('hdlr', Buffer.alloc(8), Buffer.from('mdta'), Buffer.alloc(9)), keys, mp4box('ilst', Buffer.concat([be32(8 + qdata.length), be32(1), qdata]))));
    const mq = await readMetadata(Buffer.concat([M4A_FTYP, qt, M4A_MDAT]));
    assert(mq.tags.title === 'QT title', JSON.stringify(mq));
    return `${depth} nested udta in ${ms.toFixed(0)} ms`;
  },

  'metadata: v2.3 dates — TYER always, TXXX DATE/ORIGINALDATE when the frames cannot hold the value, never TDRC/TDOR; Apple reads the year': async () => {
    const has = (b, id) => Buffer.from(b).includes(Buffer.from(id));
    const exact = new Set(['2024', '2024-05-06', '2024-05-06T10:20']);
    for (const d of ['2024', '2024-05', '2024-05-06', '2024-05-06 10:20', '2024-05-06T10:20', '2024-05-06T07:00:00Z', '2024-05-06T10:20:30.5+02:00', '06/05/2024', 'May 2024']) {
      const b = buildId3v2(prepareExportMetadata({ tags: { title: 'D', date: d, originalDate: '1999-01-02' } }));
      assert(has(b, 'TYER') && has(b, 'TORY') && !has(b, 'TDRC') && !has(b, 'TDOR'), `${d}: frames`);
      assert(has(b, '\x00DATE\x00') === !exact.has(d), `${d}: TXXX DATE`); // (not the 'ORIGINALDATE' one)
      assert(has(b, 'TDAT') === /^\d{4}-\d\d-\d\d/.test(d), `${d}: TDAT`);
      const back = await readMetadata(b);
      assert(back.tags.date === d && back.tags.year === '2024' && back.tags.originalDate === '1999-01-02' && !back.extra.length, `${d} → ${JSON.stringify(back.tags)} ${JSON.stringify(back.extra)}`);
    }
    const oy = await readMetadata(buildId3v2({ tags: { originalDate: '1988' } }));
    assert(oy.tags.originalDate === '1988', 'TORY alone');
    // a TXXX DATE whose year disagrees with TYER does not override it
    const conflict = await readMetadata(id3tag(3, [frame(3, 'TYER', TE.latin1('2021')), frame(3, 'TXXX', TE.latin1('DATE\x002020-01-01')), frame(3, 'TORY', TE.latin1('1970'))]));
    assert(conflict.tags.date === '2021' && extraOf(conflict, 'TXXX:DATE') === '2020-01-01' && conflict.tags.originalDate === '1970', JSON.stringify(conflict));
    // FFmpeg's v2.3 TXXX 'date' for a date it cannot split
    const ffd = await readMetadata(id3tag(3, [frame(3, 'TXXX', TE.latin1('date\x0006/05/2024'))]));
    assert(ffd.tags.date === '06/05/2024' && ffd.tags.year === '2024' && !ffd.extra.length, JSON.stringify(ffd));
    if (!existsSync('/usr/bin/afinfo')) return 'afinfo not available';
    // CoreAudio (Apple Music) shows the year for an iTunes-style ©day date, in WAV and MP3
    const meta = { tags: { title: 'ItunesDate', date: '2024-05-06T07:00:00Z' } };
    const wavPath = fx('itunes-date.wav');
    writeFileSync(wavPath, new Uint8Array(encodeWavBuffer({ sampleRate: 44100, channels: [sine(440, 0.2, 44100), sine(440, 0.2, 44100)] }, { metadata: meta })));
    const paths = [wavPath];
    if (hasFfmpeg()) {
      const mp3Path = fx('itunes-date.mp3');
      writeFileSync(mp3Path, Buffer.concat([buildId3v2(prepareExportMetadata(meta)), readFileSync(makeFixtures().bare)]));
      paths.push(mp3Path);
    }
    for (const path of paths) {
      const info = spawnSync('/usr/bin/afinfo', ['-i', path], { encoding: 'utf8' }).stdout;
      assert(/year\s+: "2024"/.test(info), `afinfo ${path}: ${info}`);
    }
    return `afinfo year ok (${paths.length} files)`;
  },

  'metadata: RIFF INFO subchunk of odd size without its pad byte does not hide the later fields': async () => {
    const sub = (id, bytes, pad) => Buffer.concat([Buffer.from(id), le32(bytes.length), bytes, Buffer.alloc(pad ? bytes.length & 1 : 0)]);
    const fmt = Buffer.concat([Buffer.from('fmt '), le32(16), Buffer.from([1, 0, 2, 0]), le32(44100), le32(176400), Buffer.from([4, 0, 16, 0])]);
    const wav = (info) => Buffer.concat([Buffer.from('RIFF'), le32(0), Buffer.from('WAVE'), fmt, Buffer.from('LIST'), le32(info.length + (info.length & 1)), info, Buffer.alloc(info.length & 1), Buffer.from('data'), le32(8), Buffer.alloc(8)]);
    // INAM 'Titl\0' (5 bytes) with no pad byte, then IART / ICMT
    const a = await readMetadata(wav(Buffer.concat([Buffer.from('INFO'), sub('INAM', Buffer.from('Titl\0'), false), sub('IART', Buffer.from('Artist\0'), true), sub('ICMT', Buffer.from('Comment\0'), true)])));
    assertTags(a.tags, { title: 'Titl', artist: 'Artist', comment: 'Comment' }, 'odd no pad');
    // the same with the next size byte printable (IART of 65 bytes: 'ART' + 0x41 is a FourCC too)
    const v65 = Buffer.from(`${'A'.repeat(64)}\0`);
    const b = await readMetadata(wav(Buffer.concat([Buffer.from('INFO'), sub('INAM', Buffer.from('Titl\0'), false), sub('IART', v65, false), sub('ICMT', Buffer.from('Comment\0'), true)])));
    assertTags(b.tags, { title: 'Titl', artist: 'A'.repeat(64), comment: 'Comment' }, 'odd no pad, printable size byte');
    // correctly padded subchunks are unaffected
    const c = await readMetadata(wav(Buffer.concat([Buffer.from('INFO'), sub('INAM', Buffer.from('Titl\0'), true), sub('IART', Buffer.from('Artist\0'), true)])));
    assertTags(c.tags, { title: 'Titl', artist: 'Artist' }, 'padded');
  },

  'metadata: Ogg — a first logical stream that is not audio (Skeleton, Theora) is skipped for the next BOS stream': async () => {
    const tags = Buffer.concat([Buffer.from('OpusTags'), vorbisComment(['TITLE=After skeleton', 'ARTIST=Opus'])]);
    const skeleton = oggPage(5, 0, 2, [Buffer.concat([Buffer.from('fishead\0'), Buffer.alloc(56)])]);
    const theora = oggPage(6, 0, 2, [Buffer.concat([Buffer.from([0x80]), Buffer.from('theora'), Buffer.alloc(35)])]);
    const opus = [oggPage(7, 0, 2, [OPUS_HEAD]), oggPage(7, 1, 0, [tags]), oggPage(7, 2, 0, [Buffer.alloc(30)])];
    for (const [name, file] of [['skeleton', Buffer.concat([skeleton, ...opus])], ['skeleton + theora', Buffer.concat([skeleton, theora, opus[0], oggPage(5, 1, 0, [Buffer.alloc(40)]), opus[1], opus[2]])]]) {
      const m = await readMetadata(file);
      assert(m.format === 'ogg' && m.tagTypes.join() === 'Vorbis comment (Ogg Opus)' && m.tags.title === 'After skeleton' && m.tags.artist === 'Opus' && !m.warnings.length, `${name}: ${m.tagTypes} ${JSON.stringify(m.tags)} ${m.warnings}`);
      assert(JSON.stringify((await readMetadata(new Blob([file]))).tags) === JSON.stringify(m.tags), `${name}: Blob`);
    }
    // only non-audio streams: a warning, no tags
    const none = await readMetadata(Buffer.concat([skeleton, oggPage(5, 1, 0, [Buffer.alloc(40)])]));
    assert(!Object.keys(none.tags).length && none.warnings.some((w) => /no Vorbis, Opus, FLAC or Speex stream/.test(w)), `none: ${none.warnings}`);
  },

  'metadata: trailing tags are peeled in any order — [ID3v2.4+footer][APEv2][ID3v1], [APEv2][ID3v2.4+footer]': async () => {
    const fr = frame(4, 'TIT2', TE.utf8('Appended v2.4'));
    const v24 = id3tag(4, [fr], { flags: 0x10, footer: true });
    const ape = apeTag([['Artist', 'Ape artist'], ['Title', 'Ape title']]);
    const apeH = apeTag([['Artist', 'Ape artist'], ['Title', 'Ape title']], { header: true });
    const cases = [
      ['v2.4 + APE + v1', Buffer.concat([MPEG, v24, ape, id3v1('V1 title', 'V1 album')]), 'ID3v2.4,APEv2,ID3v1', 'Appended v2.4'],
      ['v2.4 + APE(header) + v1', Buffer.concat([MPEG, v24, apeH, id3v1('V1 title', 'V1 album')]), 'ID3v2.4,APEv2,ID3v1', 'Appended v2.4'],
      ['APE + v2.4', Buffer.concat([MPEG, ape, v24]), 'ID3v2.4,APEv2', 'Appended v2.4'],
      ['APE(header) + v2.4 + v1', Buffer.concat([MPEG, apeH, v24, id3v1('V1 title', 'V1 album')]), 'ID3v2.4,APEv2,ID3v1', 'Appended v2.4'],
      ['leading v2.3 + APE + v2.4 + v1', Buffer.concat([id3tag(3, [frame(3, 'TIT2', TE.latin1('Leading'))]), MPEG, ape, v24, id3v1('V1 title', 'V1 album')]), 'ID3v2.3,ID3v2.4,APEv2,ID3v1', 'Leading'],
    ];
    for (const [name, file, types, title] of cases) {
      const m = await readMetadata(file);
      assert(m.tagTypes.join() === types && m.tags.title === title && m.tags.artist === 'Ape artist' && m.warnings.length === 0, `${name}: ${m.tagTypes} ${JSON.stringify(m.tags)} ${m.warnings}`);
      if (types.endsWith('ID3v1')) assert(m.tags.album === 'V1 album', `${name}: v1 album`);
    }
  },

  'metadata: pictures — non-image bytes never keep a scriptable mime, are no cover and are not exported': async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 5, 0, 0, 0, 4]);
    const apic = (mime, type, bytes) => frame(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from(`${mime}\0`), Buffer.from([type, 0]), bytes]));
    const html = Buffer.from('<html><script>alert(document.domain)</script></html>');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const m = await readMetadata(Buffer.concat([id3tag(3, [apic('text/html', 3, html), apic('image/svg+xml', 0, svg)]), MPEG]));
    assert(m.pictures.map((p) => p.mime).join() === 'application/octet-stream,application/octet-stream', m.pictures.map((p) => p.mime).join());
    assert(pickCover(m) === null && prepareExportMetadata(m).pictures.length === 0 && !hasExportMetadata(prepareExportMetadata(m)), 'no cover, nothing exported');
    assert(!Buffer.from(buildId3v2({ pictures: [{ mime: 'text/html', bytes: html }] })).includes(Buffer.from('APIC')), 'buildId3v2 skips it');
    // real image declared as text/html: sniffed type wins, it is the cover
    const m2 = await readMetadata(Buffer.concat([id3tag(3, [apic('text/html', 0, html), apic('text/html', 3, png)]), MPEG]));
    assert(pickCover(m2) === m2.pictures[1] && m2.pictures[1].mime === 'image/png' && m2.pictures[1].width === 5, 'sniffed png cover');
    // unrecognised bytes declared as an image type keep it (inert in <img>) but are not exported
    const m3 = await readMetadata(Buffer.concat([id3tag(3, [apic('image/jpeg', 3, Buffer.from('not really'))]), MPEG]));
    assert(m3.pictures[0].mime === 'image/jpeg' && pickCover(m3) === m3.pictures[0] && prepareExportMetadata(m3).pictures.length === 0, 'declared jpeg');
    assert(m.pictures.concat(m2.pictures, m3.pictures).every((p) => IMAGE_MIMES.includes(p.mime) || p.mime === 'application/octet-stream'), 'mime set');
    // pickCover on hand-made lists ignores anything outside IMAGE_MIMES
    assert(pickCover([{ type: 3, mime: 'text/html' }, { type: 0, mime: 'image/gif' }]).mime === 'image/gif', 'pickCover filter');
  },

  'metadata: real files from AM_META_FILES (optional, read-only report)': async () => {
    const list = (process.env.AM_META_FILES || '').split(':').filter(Boolean);
    if (!list.length) return 'skip';
    const out = [];
    for (const path of list) {
      if (!existsSync(path)) { out.push(`missing ${path}`); continue; }
      const buf = readFileSync(path);
      const t0 = performance.now();
      const m = await readMetadata(new Blob([buf]));
      const ms = performance.now() - t0;
      assert(m.warnings.length === 0, `${path}: ${m.warnings}`);
      const cover = pickCover(m);
      out.push(`${m.format} [${m.tagTypes}] "${m.tags.title || ''}" by "${m.tags.artist || ''}", ${m.pictures.length} pic(s)${cover ? ` cover ${cover.mime} ${cover.width}x${cover.height} ${cover.size} B` : ''}, lyrics ${m.tags.lyrics ? m.tags.lyrics.length : 0} chars, ${m.extra.length} extra, ${ms.toFixed(1)} ms`);
    }
    return out.join(' | ');
  },
};
