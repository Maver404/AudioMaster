// WAV writer: 16/24-bit integer PCM or 32-bit IEEE float.
//
// Delivery rules (RESEARCH §3/§6, research/03 + 04 §5):
// * Integer PCM ALWAYS uses WAVE_FORMAT_PCM (tag 1) with a 16-byte fmt chunk — also for
//   24-bit and > 48 kHz. Spotify's ingestion rejects WAVE_FORMAT_EXTENSIBLE (0xFFFE), and
//   every decoder we care about reads tag 1 at any depth/rate (tested in all browsers).
// * Float uses tag 3 with an 18-byte fmt (cbSize = 0) plus the 'fact' chunk that the spec
//   requires for non-PCM formats.
// * 'data' is the last chunk and nothing follows it except its pad byte when odd-sized
//   (RIFF chunks are word aligned). No LIST/metadata after the audio.
// * Optional metadata (`metadata` = readMetadata()'s result, sanitised by
//   prepareExportMetadata): a LIST/INFO chunk (UTF-8; read by Windows, FFmpeg, foobar2000,
//   TagLib) and an 'id3 ' chunk holding a full ID3v2.3 tag with the cover art and lyrics
//   (read by Apple Music, FFmpeg, foobar2000, Mp3tag) — both BEFORE 'data', where FFmpeg
//   also writes LIST/INFO. Without `metadata` the file is byte-identical to before.
// * Dither (TPDF; lip44 shaping only at 16-bit/44.1 kHz — see dither.js) is the last step.
//
// The file is built in one ArrayBuffer; samples are quantized in blocks straight into it,
// so peak memory is the output plus one small block.
import { PcmQuantizer } from '../dsp/dither.js';
import { prepareExportMetadata, hasExportMetadata, buildId3v2, buildRiffInfo } from '../audio/metadata.js';

const BLOCK_FRAMES = 16384;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const MAX_RIFF_BYTES = 0xffffffff;

function writeAscii(u8, off, s) {
  for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
}

/**
 * The metadata chunks for a master: [LIST/INFO?, 'id3 '] (each complete and word aligned),
 * or [] when there is nothing to write besides the encoder name. Never throws: metadata
 * that cannot be written leaves the master untagged instead of failing the export.
 * @param {object|null} metadata readMetadata() result or { tags?, extra?, pictures? }
 * @returns {Uint8Array[]}
 */
export function wavMetadataChunks(metadata) {
  if (!metadata) return [];
  try {
    const meta = prepareExportMetadata(metadata);
    if (!hasExportMetadata(meta)) return [];
    const out = [];
    const info = buildRiffInfo(meta.tags);
    if (info) out.push(info);
    const id3 = buildId3v2(meta);
    const chunk = new Uint8Array(8 + id3.length + (id3.length & 1));
    writeAscii(chunk, 0, 'id3 ');
    new DataView(chunk.buffer).setUint32(4, id3.length, true);
    chunk.set(id3, 8);
    out.push(chunk);
    return out;
  } catch {
    return [];
  }
}

/**
 * Encode audio as a WAV file into an ArrayBuffer (environment-neutral; used by
 * {@link encodeWav} and by callers that want the bytes, e.g. to put them in a ZIP).
 * @param {{ sampleRate: number, channels: Float32Array[] }} audio
 * @param {{ bitDepth?: 16|24|32, dither?: boolean|'tpdf'|'none', noiseShaping?: 'auto'|'none'|'lip44', seed?: number,
 *   metadata?: object|null }} [opts]
 *   bitDepth 32 = IEEE float (never dithered). dither true = TPDF (+ lip44 at 16/44.1 kHz).
 *   metadata: the source's readMetadata() result → LIST/INFO + 'id3 ' chunks before 'data'.
 * @returns {ArrayBuffer}
 */
export function encodeWavBuffer(audio, { bitDepth = 24, dither = true, noiseShaping = 'auto', seed = 1, metadata = null } = {}) {
  if (!audio || !Array.isArray(audio.channels) || !audio.channels.length) throw new TypeError('encodeWav: audio.channels required');
  if (![16, 24, 32].includes(bitDepth)) throw new RangeError(`encodeWav: unsupported bitDepth ${bitDepth}`);
  const sampleRate = Math.round(audio.sampleRate);
  if (!(sampleRate >= 1 && sampleRate <= 0x7fffffff)) throw new RangeError(`encodeWav: bad sampleRate ${audio.sampleRate}`);
  const chs = audio.channels;
  const nCh = chs.length;
  let frames = Infinity;
  for (const ch of chs) frames = Math.min(frames, ch.length);
  const isFloat = bitDepth === 32;
  const bps = bitDepth / 8;
  const blockAlign = nCh * bps;
  const dataBytes = frames * blockAlign;
  const pad = dataBytes & 1;
  const fmtSize = isFloat ? 18 : 16;
  const metaChunks = wavMetadataChunks(metadata);
  let metaBytes = 0;
  for (const c of metaChunks) metaBytes += c.length;
  const headerBytes = 12 + (8 + fmtSize) + (isFloat ? 12 : 0) + metaBytes + 8;
  const total = headerBytes + dataBytes + pad;
  if (total - 8 > MAX_RIFF_BYTES) throw new RangeError('encodeWav: output exceeds the 4 GiB RIFF limit');

  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let p = 0;
  writeAscii(u8, p, 'RIFF'); dv.setUint32(p + 4, total - 8, true); writeAscii(u8, p + 8, 'WAVE'); p += 12;
  writeAscii(u8, p, 'fmt '); dv.setUint32(p + 4, fmtSize, true); p += 8;
  dv.setUint16(p, isFloat ? 3 : 1, true);
  dv.setUint16(p + 2, nCh, true);
  dv.setUint32(p + 4, sampleRate, true);
  dv.setUint32(p + 8, sampleRate * blockAlign, true);
  dv.setUint16(p + 12, blockAlign, true);
  dv.setUint16(p + 14, bitDepth, true);
  if (isFloat) dv.setUint16(p + 16, 0, true); // cbSize
  p += fmtSize;
  if (isFloat) {
    writeAscii(u8, p, 'fact'); dv.setUint32(p + 4, 4, true); dv.setUint32(p + 8, frames, true); p += 12;
  }
  for (const c of metaChunks) {
    u8.set(c, p);
    p += c.length;
  }
  writeAscii(u8, p, 'data'); dv.setUint32(p + 4, dataBytes, true); p += 8;

  if (!frames) return buf;
  const block = Math.min(BLOCK_FRAMES, frames);
  if (isFloat) {
    const tmp = new Float32Array(block * nCh);
    const tmpBytes = new Uint8Array(tmp.buffer);
    for (let s = 0; s < frames; s += block) {
      const e = Math.min(frames, s + block);
      const n = e - s;
      for (let c = 0; c < nCh; c++) {
        const src = chs[c];
        for (let i = 0, o = c; i < n; i++, o += nCh) {
          const v = src[s + i];
          // NaN/±Inf would poison every downstream tool: map to silence / full scale.
          tmp[o] = v - v === 0 ? v : v > 0 ? 1 : v < 0 ? -1 : 0;
        }
      }
      if (LITTLE_ENDIAN) {
        u8.set(tmpBytes.subarray(0, n * nCh * 4), p);
      } else {
        for (let k = 0; k < n * nCh; k++) dv.setFloat32(p + 4 * k, tmp[k], true);
      }
      p += n * blockAlign;
    }
    return buf;
  }

  const q = new PcmQuantizer(nCh, bitDepth, { sampleRate, dither: dither === true || dither === 'tpdf' ? 'tpdf' : 'none', noiseShaping, seed });
  if (bitDepth === 16) {
    const tmp = new Int16Array(block * nCh);
    const tmpBytes = new Uint8Array(tmp.buffer);
    for (let s = 0; s < frames; s += block) {
      const e = Math.min(frames, s + block);
      const n = (e - s) * nCh;
      q.quantizeInterleaved(chs, s, e, tmp);
      if (LITTLE_ENDIAN) u8.set(tmpBytes.subarray(0, n * 2), p);
      else for (let k = 0; k < n; k++) dv.setInt16(p + 2 * k, tmp[k], true);
      p += n * 2;
    }
  } else {
    const tmp = new Int32Array(block * nCh);
    for (let s = 0; s < frames; s += block) {
      const e = Math.min(frames, s + block);
      const n = (e - s) * nCh;
      q.quantizeInterleaved(chs, s, e, tmp);
      for (let k = 0; k < n; k++, p += 3) {
        const v = tmp[k];
        u8[p] = v & 255;
        u8[p + 1] = (v >> 8) & 255;
        u8[p + 2] = (v >> 16) & 255;
      }
    }
  }
  return buf;
}

/**
 * Encode audio as a WAV Blob.
 * @param {{ sampleRate: number, channels: Float32Array[] }} audio
 * @param {{ bitDepth?: 16|24|32, dither?: boolean, noiseShaping?: 'auto'|'none'|'lip44', seed?: number,
 *   metadata?: object|null }} [opts]
 *   bitDepth 16/24 → PCM tag 1 (TPDF dither unless dither = false); 32 → float tag 3 + fact.
 *   metadata: readMetadata() result of the source (tags + cover are carried into the master).
 * @returns {Blob} type 'audio/wav'
 */
export function encodeWav(audio, { bitDepth = 24, dither = true, noiseShaping = 'auto', seed = 1, metadata = null } = {}) {
  return new Blob([encodeWavBuffer(audio, { bitDepth, dither, noiseShaping, seed, metadata })], { type: 'audio/wav' });
}
