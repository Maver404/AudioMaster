// File → AudioData + info.
//
// * WAV (RIFF/RF64/BW64; PCM 8/16/24/32, float 32/64, A-law/µ-law, EXTENSIBLE) and AIFF/AIFC
//   are parsed in JS: exact, no resampling, and immune to browser bugs (Firefox decodes
//   64-bit float WAV as silence, Chrome rejects it — research/04 §1.1).
// * Everything else goes through decodeAudioData on an OfflineAudioContext created at the
//   file's NATIVE sample rate, sniffed from the header, because decodeAudioData always
//   resamples to the context rate with mediocre filters (Chrome 32-tap sinc, Firefox
//   Speex q4). Native rate: MP3 frame header; MP4 mdhd timescale (preferred over esds,
//   which reports the core rate for HE-AAC); FLAC STREAMINFO; Vorbis id header; Opus = 48k.
// * Gapless fixes (RESEARCH §6): MP3 without a LAME/Info tag gets the known decoder delay
//   trimmed (+1105 Chromium/Gecko, +576 WebKit); M4A whose iTunSMPB priming was not applied
//   (Firefox) is trimmed to the original length. Only when the decoded length proves the
//   browser did not already do it.
// * Memory: the length cap is checked BEFORE decoding for every container
//   (MP3 frame walk, MP4 mdhd/mehd, FLAC STREAMINFO, Ogg granule, ADTS frame walk,
//   Matroska/WebM Info Duration or last Cluster timecode, else a size-based lower bound);
//   decodeAudioData gets the file bytes without a copy, and only the gapless-trimmed range
//   of the AudioBuffer is copied out.
// Errors are Error objects carrying { code: 'unsupported'|'corrupt'|'too_long', message },
// plus details for the UI: unsupported → reason ('codec' | 'format' | 'encoding' |
// 'browser'), codec, codecLabel; too_long → duration, maxDurationSec, estimated.
// 'unsupported' with reason 'codec' means the browser has no decoder for a file whose header
// parsed cleanly (probed with canPlayType); 'corrupt' is kept for damaged files.

export const MAX_DURATION_SEC = 15 * 60;
/** Cap suggested for phones / low-memory devices (see deviceMaxDurationSec). */
export const LOW_MEMORY_MAX_DURATION_SEC = 10 * 60;

/**
 * Length cap that fits this device's memory. Every loaded minute of 48 kHz stereo costs
 * about 23 MB per copy and the app holds several copies (UI, player, worker caches), so
 * phones and devices reporting ≤ 4 GB (navigator.deviceMemory) get the lower cap.
 * decodeFile uses MAX_DURATION_SEC unless the caller passes { maxDurationSec }.
 * @param {{ deviceMemory?: number, userAgent?: string, maxTouchPoints?: number, platform?: string }} [nav]
 * @returns {number} seconds
 */
export function deviceMaxDurationSec(nav = globalThis.navigator) {
  if (!nav) return MAX_DURATION_SEC;
  const mem = Number(nav.deviceMemory);
  if (Number.isFinite(mem) && mem > 0 && mem <= 4) return LOW_MEMORY_MAX_DURATION_SEC;
  const ua = String(nav.userAgent || '');
  // iPhone/iPad (iPadOS reports a Mac UA, but has touch points) and Android phones/tablets
  if (/iPhone|iPad|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return LOW_MEMORY_MAX_DURATION_SEC;
  return MAX_DURATION_SEC;
}

const ASCII = (u8, off, n = 4) => {
  let s = '';
  for (let i = 0; i < n && off + i < u8.length; i++) s += String.fromCharCode(u8[off + i]);
  return s;
};
const isFourcc = (u8, off) => {
  if (off + 4 > u8.length) return false;
  for (let i = 0; i < 4; i++) {
    const b = u8[off + i];
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
};
const u16be = (u8, p) => (u8[p] << 8) | u8[p + 1];
const u24be = (u8, p) => (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
const u32be = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
const u64be = (u8, p) => u32be(u8, p) * 4294967296 + u32be(u8, p + 4);
const u16le = (u8, p) => u8[p] | (u8[p + 1] << 8);
const u32le = (u8, p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
const u64le = (u8, p) => u32le(u8, p) + u32le(u8, p + 4) * 4294967296;

function decodeError(code, message, extra = {}) {
  const e = new Error(message);
  e.name = 'DecodeError';
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input.byteLength === 'number') return new Uint8Array(input);
  throw new TypeError('expected an ArrayBuffer or typed array');
}

// ---------------------------------------------------------------------------------------
// PCM sample decoding (shared by WAV and AIFF)

let ALAW_TABLE = null;
let ULAW_TABLE = null;
function g711Tables() {
  if (ALAW_TABLE) return;
  // ITU-T G.711 expansion to 16-bit linear, then /32768 (same scale as FFmpeg).
  ALAW_TABLE = new Float32Array(256);
  ULAW_TABLE = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let a = i ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    if (seg === 0) t += 8;
    else if (seg === 1) t += 0x108;
    else t = (t + 0x108) << (seg - 1);
    ALAW_TABLE[i] = ((a & 0x80) ? t : -t) / 32768;
    const u = ~i & 0xff;
    let m = ((u & 0x0f) << 3) + 0x84;
    m <<= (u & 0x70) >> 4;
    ULAW_TABLE[i] = ((u & 0x80) ? 0x84 - m : m - 0x84) / 32768;
  }
}

/**
 * Decode interleaved PCM into planar Float32 channels.
 * kind: 'u8' | 's8' | 'int' | 'float' | 'alaw' | 'ulaw'; bytesPer = container size.
 */
function decodePcm(u8, off, frames, nCh, bytesPer, kind, littleEndian) {
  const out = [];
  for (let c = 0; c < nCh; c++) out.push(new Float32Array(frames));
  if (!frames) return out;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const step = nCh * bytesPer;
  const le = littleEndian;
  if (kind === 'alaw' || kind === 'ulaw') g711Tables();
  for (let c = 0; c < nCh; c++) {
    const ch = out[c];
    let p = off + c * bytesPer;
    if (kind === 'u8') {
      for (let i = 0; i < frames; i++, p += step) ch[i] = (u8[p] - 128) * 0.0078125;
    } else if (kind === 's8') {
      for (let i = 0; i < frames; i++, p += step) ch[i] = ((u8[p] << 24) >> 24) * 0.0078125;
    } else if (kind === 'alaw' || kind === 'ulaw') {
      const tab = kind === 'alaw' ? ALAW_TABLE : ULAW_TABLE;
      for (let i = 0; i < frames; i++, p += step) ch[i] = tab[u8[p]];
    } else if (kind === 'int' && bytesPer === 2) {
      for (let i = 0; i < frames; i++, p += step) ch[i] = dv.getInt16(p, le) * 3.0517578125e-5;
    } else if (kind === 'int' && bytesPer === 3) {
      if (le) for (let i = 0; i < frames; i++, p += step) ch[i] = (((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) << 8) >> 8) * 1.1920928955078125e-7;
      else for (let i = 0; i < frames; i++, p += step) ch[i] = (((u8[p + 2] | (u8[p + 1] << 8) | (u8[p] << 16)) << 8) >> 8) * 1.1920928955078125e-7;
    } else if (kind === 'int' && bytesPer === 4) {
      // 32-bit containers: full 32-bit ints, or 20/24 valid bits left-justified (same scale).
      for (let i = 0; i < frames; i++, p += step) ch[i] = dv.getInt32(p, le) * 4.656612873077393e-10;
    } else if (kind === 'float' && bytesPer === 4) {
      for (let i = 0; i < frames; i++, p += step) {
        const v = dv.getFloat32(p, le);
        ch[i] = v - v === 0 ? v : 0; // NaN/Inf → 0 (never let them into the DSP)
      }
    } else if (kind === 'float' && bytesPer === 8) {
      for (let i = 0; i < frames; i++, p += step) {
        const v = dv.getFloat64(p, le);
        ch[i] = v - v === 0 ? v : 0;
      }
    } else {
      throw decodeError('unsupported', `Unsupported PCM layout (${kind}, ${bytesPer} bytes)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// WAV

const WAV_CODECS = {
  0x0002: 'adpcm_ms', 0x0011: 'adpcm_ima', 0x0031: 'gsm_ms', 0x0050: 'mp2', 0x0055: 'mp3',
  0x00ff: 'aac', 0x0160: 'wma', 0x0161: 'wma', 0x1610: 'aac', 0x2000: 'ac3', 0xf1ac: 'flac',
};

/** Walk the RIFF chunks and describe the audio (no sample decoding). Throws DecodeError. */
function readWavHeader(u8) {
  const len = u8.length;
  if (len < 12) throw decodeError('corrupt', 'File too short to be a WAV');
  const riff = ASCII(u8, 0);
  if (riff === 'RIFX' || riff === 'FFIR') throw decodeError('unsupported', 'Big-endian RIFX WAV files are not supported', { codec: 'pcm_be' });
  if (!(riff === 'RIFF' || riff === 'RF64' || riff === 'BW64') || ASCII(u8, 8) !== 'WAVE') throw decodeError('corrupt', 'Not a WAV file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let ds64Data = null;
  const chunks = [];
  let off = 12;
  while (off + 8 <= len) {
    if (!isFourcc(u8, off)) {
      // Writers that forget the pad byte after an odd chunk: re-sync one byte back.
      if (off > 12 && isFourcc(u8, off - 1) && !(u8[off - 1] === 0)) off -= 1;
      else break;
    }
    const id = ASCII(u8, off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    chunks.push(id);
    if (id === 'ds64' && size >= 24 && body + 24 <= len) {
      ds64Data = u64le(u8, body + 8);
    } else if (id === 'fmt ' && size >= 14 && body + 14 <= len) {
      const tag = dv.getUint16(body, true);
      fmt = {
        formatTag: tag,
        realTag: tag,
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true),
        bitsPerSample: size >= 16 ? dv.getUint16(body + 14, true) : 8,
        validBits: 0,
        channelMask: 0,
      };
      fmt.validBits = fmt.bitsPerSample;
      if (tag === 0xfffe) {
        if (size < 40 || body + 40 > len) throw decodeError('corrupt', 'Truncated WAVE_FORMAT_EXTENSIBLE header');
        const vb = dv.getUint16(body + 18, true);
        if (vb > 0 && vb <= fmt.bitsPerSample) fmt.validBits = vb;
        fmt.channelMask = dv.getUint32(body + 20, true);
        fmt.realTag = dv.getUint16(body + 24, true); // first 2 bytes of the SubFormat GUID
      }
    } else if (id === 'data') {
      const remaining = len - body;
      if (riff !== 'RIFF' && size === 0xffffffff && ds64Data !== null) size = ds64Data;
      else if (size === 0xffffffff) size = remaining; // streamed writer, size never patched
      else if (size === 0 && remaining > 0 && !isFourcc(u8, body)) size = remaining;
      dataOffset = body;
      dataSize = Math.min(size, remaining); // truncated download: decode what is there
      if (fmt) break; // everything after 'data' is metadata we do not need
    }
    const next = body + size + (size & 1);
    if (!(next > off)) break;
    off = next;
  }
  if (!fmt) throw decodeError('corrupt', 'WAV file has no fmt chunk');
  if (dataOffset < 0) throw decodeError('corrupt', 'WAV file has no data chunk');
  const nCh = fmt.channels;
  if (!(nCh >= 1 && nCh <= 64)) throw decodeError('corrupt', `Invalid channel count ${nCh}`);
  if (!(fmt.sampleRate >= 1 && fmt.sampleRate <= 4000000)) throw decodeError('corrupt', `Invalid sample rate ${fmt.sampleRate}`);
  const minBytes = Math.max(1, Math.ceil(fmt.bitsPerSample / 8));
  let bytesPer = fmt.blockAlign && fmt.blockAlign % nCh === 0 ? fmt.blockAlign / nCh : minBytes;
  if (bytesPer < minBytes) bytesPer = minBytes;

  const t = fmt.realTag;
  let kind = null;
  let codec = WAV_CODECS[t] || `wav_0x${t.toString(16).padStart(4, '0')}`;
  let bitDepth = fmt.validBits || fmt.bitsPerSample;
  if (t === 1) {
    if (bytesPer === 1) { kind = 'u8'; codec = 'pcm_u8'; }
    else if (bytesPer >= 2 && bytesPer <= 4) { kind = 'int'; codec = `pcm_s${bytesPer * 8}le`; }
  } else if (t === 3) {
    if (bytesPer === 4) { kind = 'float'; codec = 'pcm_f32le'; bitDepth = 32; }
    else if (bytesPer === 8) { kind = 'float'; codec = 'pcm_f64le'; bitDepth = 64; }
  } else if (t === 6 && bytesPer === 1) { kind = 'alaw'; codec = 'pcm_alaw'; bitDepth = 8; }
  else if (t === 7 && bytesPer === 1) { kind = 'ulaw'; codec = 'pcm_mulaw'; bitDepth = 8; }
  const blockBytes = bytesPer * nCh;
  const frames = Math.floor(dataSize / blockBytes);
  return {
    container: riff, formatTag: fmt.formatTag, realTag: t, kind, codec, littleEndian: true,
    numChannels: nCh, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bitsPerSample, bitDepth,
    bytesPerSample: bytesPer, channelMask: fmt.channelMask, dataOffset, dataSize, frames,
    duration: frames / fmt.sampleRate, chunks,
  };
}

/**
 * Parse a WAV file (RIFF / RF64 / BW64; PCM 8/16/24/32-bit, IEEE float 32/64, A-law/µ-law,
 * WAVE_FORMAT_EXTENSIBLE; odd-size chunk padding; LIST/bext/junk/fact/iXML… chunks skipped).
 * Integer samples are scaled by 2^(bits−1) (FFmpeg convention), float NaN/Inf become 0.
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer
 * @param {{ maxDurationSec?: number }} [opts] throws code 'too_long' (before allocating) above it
 * @returns {{ sampleRate: number, channels: Float32Array[], bitDepth: number, numChannels: number,
 *   frames: number, duration: number, formatTag: number, codec: string, container: string, channelMask: number }}
 *   `channels` are the file's native channels (1..n); decodeFile() converts them to stereo.
 * @throws {Error & { code: 'unsupported'|'corrupt'|'too_long' }}
 */
export function parseWav(arrayBuffer, opts = {}) {
  const u8 = toU8(arrayBuffer);
  const h = readWavHeader(u8);
  return decodeHeaderPcm(u8, h, opts);
}

function decodeHeaderPcm(u8, h, opts) {
  if (!h.kind) throw decodeError('unsupported', `Unsupported audio encoding inside the file (${h.codec}). Please convert it to 16/24-bit PCM WAV or FLAC.`, { codec: h.codec, reason: 'encoding' });
  if (opts.maxDurationSec && h.duration > opts.maxDurationSec) throw tooLong(h.duration, opts.maxDurationSec);
  const channels = decodePcm(u8, h.dataOffset, h.frames, h.numChannels, h.bytesPerSample, h.kind, h.littleEndian);
  return {
    sampleRate: h.sampleRate, channels, bitDepth: h.bitDepth, numChannels: h.numChannels,
    frames: h.frames, duration: h.duration, formatTag: h.formatTag, codec: h.codec,
    container: h.container, channelMask: h.channelMask,
  };
}

// ---------------------------------------------------------------------------------------
// AIFF / AIFC (big-endian IFF). Chrome/Firefox cannot decode it, so we do.

function readExtended80(u8, p) {
  const se = u16be(u8, p);
  const exp = se & 0x7fff;
  const mant = u32be(u8, p + 2) * 4294967296 + u32be(u8, p + 6);
  if (!exp && !mant) return 0;
  if (exp === 0x7fff) return NaN;
  return (se & 0x8000 ? -1 : 1) * mant * 2 ** (exp - 16383 - 63);
}

function readAiffHeader(u8) {
  const len = u8.length;
  if (len < 12 || ASCII(u8, 0) !== 'FORM') throw decodeError('corrupt', 'Not an AIFF file');
  const form = ASCII(u8, 8);
  if (form !== 'AIFF' && form !== 'AIFC') throw decodeError('corrupt', 'Not an AIFF file');
  let comm = null;
  let ssnd = -1;
  let ssndSize = 0;
  let off = 12;
  while (off + 8 <= len && isFourcc(u8, off)) {
    const id = ASCII(u8, off);
    const size = u32be(u8, off + 4);
    const body = off + 8;
    if (id === 'COMM' && body + 18 <= len) {
      comm = {
        channels: u16be(u8, body), frames: u32be(u8, body + 2), bits: u16be(u8, body + 6),
        sampleRate: readExtended80(u8, body + 8), compression: form === 'AIFC' && size >= 22 ? ASCII(u8, body + 18) : 'NONE',
      };
    } else if (id === 'SSND' && body + 8 <= len) {
      const dataOff = u32be(u8, body);
      ssnd = body + 8 + dataOff;
      ssndSize = Math.max(0, Math.min(size - 8 - dataOff, len - ssnd));
    }
    const next = body + size + (size & 1);
    if (!(next > off)) break;
    off = next;
  }
  if (!comm) throw decodeError('corrupt', 'AIFF file has no COMM chunk');
  if (ssnd < 0) throw decodeError('corrupt', 'AIFF file has no sound data');
  const nCh = comm.channels;
  const sr = Math.round(comm.sampleRate);
  if (!(nCh >= 1 && nCh <= 64) || !(sr >= 1 && sr <= 4000000)) throw decodeError('corrupt', 'Invalid AIFF format');
  const cmp = comm.compression;
  let bytesPer = Math.max(1, Math.ceil(comm.bits / 8));
  let kind = null;
  let le = false;
  let codec = `aifc_${cmp.trim().toLowerCase()}`;
  let bitDepth = comm.bits;
  if (cmp === 'NONE' || cmp === 'twos' || cmp === 'sowt' || cmp === 'in24' || cmp === 'in32' || cmp === '23ni') {
    if (cmp === 'in24' || cmp === '23ni') bytesPer = 3;
    if (cmp === 'in32') bytesPer = 4;
    le = cmp === 'sowt' || cmp === '23ni';
    kind = bytesPer === 1 ? 's8' : bytesPer <= 4 ? 'int' : null;
    codec = `pcm_s${bytesPer * 8}${le ? 'le' : 'be'}`;
    bitDepth = Math.min(comm.bits || bytesPer * 8, bytesPer * 8);
  } else if (cmp === 'fl32' || cmp === 'FL32') { kind = 'float'; bytesPer = 4; codec = 'pcm_f32be'; bitDepth = 32; }
  else if (cmp === 'fl64' || cmp === 'FL64') { kind = 'float'; bytesPer = 8; codec = 'pcm_f64be'; bitDepth = 64; }
  else if (cmp === 'alaw' || cmp === 'ALAW') { kind = 'alaw'; bytesPer = 1; codec = 'pcm_alaw'; bitDepth = 8; }
  else if (cmp === 'ulaw' || cmp === 'ULAW') { kind = 'ulaw'; bytesPer = 1; codec = 'pcm_mulaw'; bitDepth = 8; }
  const frames = Math.min(comm.frames, Math.floor(ssndSize / (bytesPer * nCh)));
  return {
    container: 'AIFF', formatTag: 0, realTag: 0, kind, codec, littleEndian: le, numChannels: nCh,
    sampleRate: sr, bitsPerSample: comm.bits, bitDepth, bytesPerSample: bytesPer, channelMask: 0,
    dataOffset: ssnd, dataSize: ssndSize, frames, duration: frames / sr, chunks: [],
  };
}

/**
 * Parse an AIFF/AIFC file (big-endian PCM 8–32-bit, 'sowt' little-endian, fl32/fl64, A/µ-law).
 * Same return shape and errors as {@link parseWav}.
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer
 * @param {{ maxDurationSec?: number }} [opts]
 */
export function parseAiff(arrayBuffer, opts = {}) {
  const u8 = toU8(arrayBuffer);
  return decodeHeaderPcm(u8, readAiffHeader(u8), opts);
}

// ---------------------------------------------------------------------------------------
// Channel conversion

// Downmix gains (L, R) per WAVEFORMATEXTENSIBLE speaker bit (ITU-R BS.775-style: centre and
// surrounds at −3 dB, LFE dropped). Web Audio uses the same order for decoded 5.1/7.1.
const SPEAKER_GAINS = [
  [1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2], [0, 0], // FL FR FC LFE
  [Math.SQRT1_2, 0], [0, Math.SQRT1_2], [1, 0], [0, 1], // BL BR FLC FRC
  [0.5, 0.5], [Math.SQRT1_2, 0], [0, Math.SQRT1_2], [0.5, 0.5], // BC SL SR TC
  [Math.SQRT1_2, 0], [0.5, 0.5], [0, Math.SQRT1_2], [Math.SQRT1_2, 0], // TFL TFC TFR TBL
  [0.5, 0.5], [0, Math.SQRT1_2], // TBC TBR
];

/** 1..n channels → [L, R] (distinct arrays: mono is duplicated, > 2 is downmixed). */
function toStereo(channels, channelMask = 0) {
  const n = channels.length;
  if (n === 2) return [channels[0], channels[1]];
  if (n === 1) return [channels[0], Float32Array.from(channels[0])];
  const len = channels[0].length;
  // Map each channel to a speaker position: from the mask bits if they cover all channels,
  // otherwise the default WAVE order (FL FR FC LFE BL BR …).
  const pos = [];
  if (channelMask) {
    for (let b = 0; b < 32 && pos.length < n; b++) if (channelMask & (1 << b)) pos.push(b);
  }
  if (pos.length !== n) {
    pos.length = 0;
    for (let c = 0; c < n; c++) pos.push(c);
  }
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  for (let c = 0; c < n; c++) {
    const g = SPEAKER_GAINS[pos[c]] || [0.5, 0.5];
    const src = channels[c];
    const gl = g[0];
    const gr = g[1];
    if (gl) for (let i = 0; i < len; i++) L[i] += gl * src[i];
    if (gr) for (let i = 0; i < len; i++) R[i] += gr * src[i];
  }
  return [L, R];
}

// ---------------------------------------------------------------------------------------
// MPEG audio (MP3) sniffing

const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const BR_V1 = [
  null,
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], // L3
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0], // L2
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0], // L1
];
const BR_V2 = [
  null,
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
];

/** Parse a 4-byte MPEG audio frame header at p, or null if it is not a valid one. */
function mpegHeader(u8, p) {
  if (p + 4 > u8.length || u8[p] !== 0xff) return null;
  const b1 = u8[p + 1];
  const b2 = u8[p + 2];
  const b3 = u8[p + 3];
  if ((b1 & 0xe0) !== 0xe0) return null;
  const ver = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (ver === 1 || layerBits === 0) return null;
  const brIdx = b2 >> 4;
  const srIdx = (b2 >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3 || (b3 & 3) === 2) return null;
  const v1 = ver === 3;
  const kbps = (v1 ? BR_V1 : BR_V2)[layerBits][brIdx];
  const sr = MPEG_RATES[ver][srIdx];
  const pad = (b2 >> 1) & 1;
  const layer = 4 - layerBits;
  let length;
  let spf;
  if (layer === 1) { length = (Math.floor((12000 * kbps) / sr) + pad) * 4; spf = 384; }
  else if (layer === 2) { length = Math.floor((144000 * kbps) / sr) + pad; spf = 1152; }
  else { length = Math.floor(((v1 ? 144000 : 72000) * kbps) / sr) + pad; spf = v1 ? 1152 : 576; }
  return {
    version: v1 ? 1 : ver === 2 ? 2 : 2.5, ver, layer, kbps, sampleRate: sr, padding: pad,
    channels: b3 >> 6 === 3 ? 1 : 2, crc: !(b1 & 1), length, samplesPerFrame: spf,
  };
}

const sameStream = (a, b) => a.ver === b.ver && a.layer === b.layer && a.sampleRate === b.sampleRate;

/** Skip ID3v2 tags (possibly several, with footer) and zero padding. */
function skipId3v2(u8, p = 0) {
  for (let guard = 0; guard < 8; guard++) {
    if (p + 10 <= u8.length && u8[p] === 0x49 && u8[p + 1] === 0x44 && u8[p + 2] === 0x33 && u8[p + 3] < 0xff) {
      const size = ((u8[p + 6] & 0x7f) << 21) | ((u8[p + 7] & 0x7f) << 14) | ((u8[p + 8] & 0x7f) << 7) | (u8[p + 9] & 0x7f);
      p += 10 + size + (u8[p + 5] & 0x10 ? 10 : 0);
      while (p < u8.length && u8[p] === 0) p++;
    } else break;
  }
  return Math.min(p, u8.length);
}

/** First frame that is followed by consistent frames (avoids false syncs in junk/art). */
function findMpegStart(u8, start, maxScan = 1 << 20) {
  const end = Math.min(u8.length - 4, start + maxScan);
  for (let i = start; i <= end; i++) {
    if (u8[i] !== 0xff) continue;
    const h = mpegHeader(u8, i);
    if (!h) continue;
    let q = i + h.length;
    let ok = true;
    for (let k = 0; k < 3 && q + 4 <= u8.length; k++) {
      const h2 = mpegHeader(u8, q);
      if (!h2 || !sameStream(h, h2)) { ok = false; break; }
      q += h2.length;
    }
    if (ok) return { offset: i, header: h };
  }
  return null;
}

/** Xing/Info (+ LAME extension) or VBRI tag inside the first frame. */
function parseVbrTag(u8, off, h) {
  const side = h.version === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
  for (const x of [off + 4 + side, off + 4 + 2 + side]) {
    const id = ASCII(u8, x);
    if (id !== 'Xing' && id !== 'Info') continue;
    const flags = u32be(u8, x + 4);
    let p = x + 8;
    const tag = { type: id, frames: null, bytes: null, encoder: null, delay: null, padding: null };
    if (flags & 1) { tag.frames = u32be(u8, p); p += 4; }
    if (flags & 2) { tag.bytes = u32be(u8, p); p += 4; }
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    // LAME extension (http://gabriel.mp3-tech.org/mp3infotag.html): 9-byte encoder string,
    // delay/padding 12+12 bits at +21. FFmpeg writes it too ('Lavf'/'Lavc').
    if (p + 24 <= Math.min(u8.length, off + h.length) && /^[A-Za-z]{4}/.test(ASCII(u8, p, 4))) {
      tag.encoder = ASCII(u8, p, 9).replace(/[^\x20-\x7e]/g, '').trim();
      const d = u24be(u8, p + 21);
      tag.delay = d >> 12;
      tag.padding = d & 0xfff;
    }
    return tag;
  }
  if (ASCII(u8, off + 36) === 'VBRI') {
    return { type: 'VBRI', delay: u16be(u8, off + 36 + 6), padding: null, bytes: u32be(u8, off + 36 + 10), frames: u32be(u8, off + 36 + 14), encoder: 'FhG' };
  }
  return null;
}

function sniffMp3(u8, start) {
  const found = findMpegStart(u8, start);
  if (!found) return null;
  const h = found.header;
  const tag = parseVbrTag(u8, found.offset, h);
  // Walk all frames: exact frame count and CBR/VBR detection (cheap: ~40 frames/s of audio).
  let p = found.offset + (tag ? h.length : 0);
  let frames = 0;
  let bytes = 0;
  let minKbps = Infinity;
  let maxKbps = 0;
  while (p + 4 <= u8.length) {
    const f = mpegHeader(u8, p);
    if (!f || !sameStream(f, h)) break;
    frames++;
    bytes += f.length;
    if (f.kbps < minKbps) minKbps = f.kbps;
    if (f.kbps > maxKbps) maxKbps = f.kbps;
    p += f.length;
  }
  const spf = h.samplesPerFrame;
  if (tag && tag.frames && (tag.type === 'Xing' || tag.type === 'Info' || tag.type === 'VBRI')) {
    // Trust the tag when the walk was cut short (truncated file / junk in the middle).
    if (frames < tag.frames * 0.9) frames = tag.frames;
  }
  const hasGapless = !!(tag && tag.delay !== null && tag.padding !== null && tag.type !== 'VBRI');
  const total = frames * spf;
  const samples = hasGapless ? Math.max(0, total - tag.delay - tag.padding) : total;
  const duration = samples / h.sampleRate;
  const vbr = tag ? tag.type !== 'Info' : maxKbps !== minKbps;
  const kbps = vbr && duration > 0 ? Math.round((bytes * 8) / (total / h.sampleRate) / 1000) : h.kbps;
  return {
    format: 'mp3', codec: h.layer === 3 ? 'mp3' : h.layer === 2 ? 'mp2' : 'mp1',
    nativeSampleRate: h.sampleRate, channels: h.channels, bitDepth: null, bitrateKbps: kbps, vbr,
    duration, mpegVersion: h.version, layer: h.layer, samplesPerFrame: spf, frames,
    firstFrameOffset: found.offset, tag: tag ? tag.type : null, encoder: tag ? tag.encoder : null,
    encoderDelay: hasGapless ? tag.delay : tag && tag.type === 'VBRI' ? tag.delay : null,
    encoderPadding: hasGapless ? tag.padding : null, hasGaplessInfo: hasGapless, totalSamples: samples,
  };
}

/** Raw AAC in ADTS framing (.aac). */
function sniffAdts(u8, p) {
  if (p + 7 > u8.length || u8[p] !== 0xff || (u8[p + 1] & 0xf6) !== 0xf0) return null;
  const sfi = (u8[p + 2] >> 2) & 15;
  const rate = AAC_RATES[sfi];
  const flen = ((u8[p + 3] & 3) << 11) | (u8[p + 4] << 3) | (u8[p + 5] >> 5);
  if (!rate || flen < 7) return null;
  const q = p + flen;
  if (q + 2 <= u8.length && !(u8[q] === 0xff && (u8[q + 1] & 0xf6) === 0xf0)) return null;
  const aot = (u8[p + 2] >> 6) + 1;
  const chCfg = ((u8[p + 2] & 1) << 2) | (u8[p + 3] >> 6);
  // ADTS cannot signal SBR explicitly: a ≤ 24 kHz core is very likely HE-AAC → decode at 2×.
  const sbrPossible = aot === 2 && rate <= 24000;
  // Raw ADTS has no length field: walk the frames (1024 core samples per raw data block;
  // ~43 frames/s, cheap) for the duration, which the length cap needs before decoding.
  let samples = 0;
  let bytes = 0;
  for (let q = p; q + 7 <= u8.length && u8[q] === 0xff && (u8[q + 1] & 0xf6) === 0xf0;) {
    const len = ((u8[q + 3] & 3) << 11) | (u8[q + 4] << 3) | (u8[q + 5] >> 5);
    if (len < 7) break;
    samples += ((u8[q + 6] & 3) + 1) * 1024;
    bytes += Math.min(len, u8.length - q);
    q += len;
  }
  const duration = samples ? samples / rate : null;
  return {
    format: 'other', codec: aot === 2 ? 'aac' : `aac_aot${aot}`, nativeSampleRate: sbrPossible ? 2 * rate : rate,
    coreSampleRate: rate, implicitSbrAssumed: sbrPossible, channels: chCfg || null, bitDepth: null,
    bitrateKbps: duration ? Math.round((bytes * 8) / duration / 1000) : null, vbr: null, duration, container: 'adts',
  };
}

// ---------------------------------------------------------------------------------------
// ISO-BMFF / MP4 / M4A

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_NAMES = { 1: 'aac_main', 2: 'aac', 3: 'aac_ssr', 4: 'aac_ltp', 5: 'he-aac', 29: 'he-aac-v2', 23: 'aac_ld', 39: 'aac_eld' };
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'ilst', 'meta', 'wave', '----', 'mvex']);
const isPlausibleRate = (r) => r >= 3000 && r <= 768000;

function parseAudioSpecificConfig(u8, p, end) {
  let bit = p * 8;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      if (bit >> 3 >= end) return v;
      v = (v << 1) | ((u8[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  const readAot = () => {
    const a = read(5);
    return a === 31 ? 32 + read(6) : a;
  };
  const readRate = () => {
    const i = read(4);
    return i === 15 ? read(24) : AAC_RATES[i] || 0;
  };
  let aot = readAot();
  const rate = readRate();
  const chCfg = read(4);
  let extRate = 0;
  let sbr = false;
  if (aot === 5 || aot === 29) {
    sbr = true;
    extRate = readRate();
    readAot();
  }
  return { aot, rate, extRate, channels: chCfg, sbr };
}

function readDescLen(u8, p) {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = u8[p++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { len, p };
}

function parseEsds(u8, p, end) {
  const out = { oti: 0, avgBitrate: 0, maxBitrate: 0, asc: null };
  p += 4; // version/flags
  const walk = (q, stop) => {
    while (q + 2 <= stop) {
      const tag = u8[q];
      const r = readDescLen(u8, q + 1);
      const body = r.p;
      const bodyEnd = Math.min(stop, body + r.len);
      if (tag === 3) {
        let s = body + 2;
        const flags = u8[body + 2];
        s += 1;
        if (flags & 0x80) s += 2;
        if (flags & 0x40) s += 1 + u8[s];
        if (flags & 0x20) s += 2;
        walk(s, bodyEnd);
      } else if (tag === 4) {
        out.oti = u8[body];
        out.maxBitrate = u32be(u8, body + 5);
        out.avgBitrate = u32be(u8, body + 9);
        walk(body + 13, bodyEnd);
      } else if (tag === 5) {
        out.asc = parseAudioSpecificConfig(u8, body, bodyEnd);
      }
      if (!(bodyEnd > q)) break;
      q = bodyEnd;
    }
  };
  walk(p, end);
  return out;
}

function parseSampleEntry(u8, p, end) {
  const type = ASCII(u8, p + 4);
  const ver = u16be(u8, p + 16);
  const entry = { type, channels: u16be(u8, p + 24), sampleSize: u16be(u8, p + 26), sampleRate: u32be(u8, p + 32) / 65536 };
  let child = p + 36;
  if (ver === 1) child += 16;
  else if (ver === 2) {
    const dv = new DataView(u8.buffer, u8.byteOffset + p + 40, 8);
    entry.sampleRate = dv.getFloat64(0, false);
    entry.channels = u32be(u8, p + 48);
    entry.sampleSize = u32be(u8, p + 56);
    child = p + 72;
  }
  const walk = (q, stop) => {
    while (q + 8 <= stop) {
      const size = u32be(u8, q);
      const t = ASCII(u8, q + 4);
      const e = size >= 8 ? Math.min(stop, q + size) : stop;
      if (t === 'esds') entry.esds = parseEsds(u8, q + 8, e);
      else if (t === 'alac' && e - q >= 36) {
        const b = q + 12; // fullbox → ALACSpecificConfig
        entry.alac = { bitDepth: u8[b + 5], channels: u8[b + 9], avgBitrate: u32be(u8, b + 16), sampleRate: u32be(u8, b + 20) };
      } else if (t === 'dOps' && e - q >= 19) {
        entry.dOps = { channels: u8[q + 9], preSkip: u16be(u8, q + 10), inputRate: u32be(u8, q + 12) };
      } else if (t === 'dfLa' && e - q >= 12 + 4 + 34) {
        const si = q + 12 + 4;
        entry.flac = {
          sampleRate: (u8[si + 10] << 12) | (u8[si + 11] << 4) | (u8[si + 12] >> 4),
          bitDepth: (((u8[si + 12] & 1) << 4) | (u8[si + 13] >> 4)) + 1,
        };
      } else if (t === 'wave') walk(q + 8, e);
      if (!(e > q)) break;
      q = e;
    }
  };
  walk(child, end);
  return entry;
}

function sniffMp4(u8) {
  const len = u8.length;
  const tracks = [];
  let cur = null;
  let smpb = null;
  let mdatBytes = 0;
  let brand = null;
  let freeformName = null;
  const movie = { timescale: 0, duration: 0, fragmentDuration: 0 };
  const walk = (start, end, depth, parent) => {
    let p = start;
    while (p + 8 <= end) {
      let size = u32be(u8, p);
      const type = ASCII(u8, p + 4);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = u64be(u8, p + 8);
        hdr = 16;
      } else if (size === 0) size = end - p;
      if (size < hdr) break;
      const boxEnd = Math.min(end, p + size); // truncated files: parse what is there
      const body = p + hdr;
      if (type === 'ftyp') brand = ASCII(u8, body);
      else if (type === 'mdat') mdatBytes += size - hdr;
      else if (type === 'trak') {
        cur = { handler: null, timescale: 0, duration: 0, entry: null, mediaTime: null };
        tracks.push(cur);
        walk(body, boxEnd, depth + 1, type);
        cur = null;
      } else if (type === 'hdlr' && cur && parent === 'mdia') {
        if (!cur.handler) cur.handler = ASCII(u8, body + 8);
      } else if (type === 'mdhd' && cur) {
        const v = u8[body];
        cur.timescale = v === 1 ? u32be(u8, body + 20) : u32be(u8, body + 12);
        cur.duration = v === 1 ? u64be(u8, body + 24) : u32be(u8, body + 16);
      } else if (type === 'mvhd' && !cur) {
        const v = u8[body];
        movie.timescale = v === 1 ? u32be(u8, body + 20) : u32be(u8, body + 12);
        movie.duration = v === 1 ? u64be(u8, body + 24) : u32be(u8, body + 16);
      } else if (type === 'mehd') {
        // fragmented MP4: mdhd/mvhd durations are 0, the total is in mvex/mehd
        movie.fragmentDuration = u8[body] === 1 ? u64be(u8, body + 4) : u32be(u8, body + 4);
      } else if (type === 'elst' && cur) {
        const v = u8[body];
        const n = u32be(u8, body + 4);
        let q = body + 8;
        for (let i = 0; i < n && q + (v === 1 ? 20 : 12) <= boxEnd; i++) {
          const mt = v === 1 ? u32be(u8, q + 8) * 4294967296 + u32be(u8, q + 12) : u32be(u8, q + 4) | 0;
          q += v === 1 ? 20 : 12;
          if (mt !== -1 && mt !== 0xffffffff * 4294967296 + 0xffffffff) { cur.mediaTime = mt; break; }
        }
      } else if (type === 'stsd' && cur && !cur.entry && body + 16 <= boxEnd) {
        const eSize = u32be(u8, body + 8);
        cur.entry = parseSampleEntry(u8, body + 8, Math.min(boxEnd, body + 8 + eSize));
      } else if (type === 'name' && depth > 0) {
        freeformName = ASCII(u8, body + 4, Math.max(0, boxEnd - body - 4));
      } else if (type === 'data' && freeformName === 'iTunSMPB') {
        const s = ASCII(u8, body + 8, Math.max(0, boxEnd - body - 8)).trim().split(/\s+/);
        if (s.length >= 4) {
          const priming = parseInt(s[1], 16);
          const padding = parseInt(s[2], 16);
          const original = parseInt(s[3], 16);
          if (Number.isFinite(priming) && Number.isFinite(original) && original > 0) smpb = { priming, padding, originalSamples: original };
        }
        freeformName = null;
      } else if (MP4_CONTAINERS.has(type) && depth < 12) {
        let c = body;
        // ISO 'meta' is a full box (4 bytes version/flags); QuickTime 'meta' is not.
        if (type === 'meta' && ASCII(u8, body + 4) !== 'hdlr') c += 4;
        if (type === '----') freeformName = null;
        walk(c, boxEnd, depth + 1, type);
      }
      if (!(boxEnd > p)) break;
      p = boxEnd;
    }
  };
  walk(0, len, 0, '');
  const tr = tracks.find((t) => t.handler === 'soun') || tracks.find((t) => t.entry && t.entry.sampleRate > 0);
  if (!tr || !tr.entry) {
    return { format: 'm4a', codec: null, nativeSampleRate: null, channels: null, bitDepth: null, bitrateKbps: null, vbr: null, duration: null, brand, hasAudio: false };
  }
  const e = tr.entry;
  let codec = e.type;
  let bitDepth = null;
  let rate = isPlausibleRate(tr.timescale) ? tr.timescale : 0;
  let channels = e.channels || null;
  let kbps = 0;
  let sbr = false;
  let coreRate = null;
  if (e.type === 'mp4a' && e.esds) {
    const oti = e.esds.oti;
    if (oti === 0x69 || oti === 0x6b) codec = 'mp3';
    else if (oti === 0xa5) codec = 'ac3';
    else if (oti === 0xa6) codec = 'eac3';
    else if (e.esds.asc) codec = AAC_NAMES[e.esds.asc.aot] || `aac_aot${e.esds.asc.aot}`;
    else codec = 'aac';
    if (e.esds.asc) {
      sbr = e.esds.asc.sbr;
      coreRate = e.esds.asc.rate || null;
      if (!rate) rate = e.esds.asc.extRate || (sbr ? 2 * e.esds.asc.rate : e.esds.asc.rate) || 0;
      if (!sbr && e.esds.asc.aot === 2 && coreRate && rate === 2 * coreRate) {
        sbr = true; // implicit SBR, revealed by an mdhd timescale at twice the core rate
        codec = 'he-aac';
      }
    }
    kbps = e.esds.avgBitrate / 1000;
  } else if (e.type === 'mp4a') codec = 'aac';
  else if (e.type === 'alac') {
    codec = 'alac';
    if (e.alac) {
      bitDepth = e.alac.bitDepth || e.sampleSize || null;
      if (isPlausibleRate(e.alac.sampleRate)) rate = e.alac.sampleRate;
      channels = e.alac.channels || channels;
    } else bitDepth = e.sampleSize || null;
  } else if (e.type === 'Opus') {
    codec = 'opus';
    rate = 48000; // Opus always decodes at 48 kHz
    if (e.dOps) channels = e.dOps.channels || channels;
  } else if (e.type === 'fLaC') {
    codec = 'flac';
    if (e.flac) { bitDepth = e.flac.bitDepth; if (isPlausibleRate(e.flac.sampleRate)) rate = e.flac.sampleRate; }
  } else if (e.type === 'ac-3') codec = 'ac3';
  else if (e.type === 'ec-3') codec = 'eac3';
  else if (e.type === '.mp3') codec = 'mp3';
  else if (['lpcm', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'raw '].includes(e.type)) { codec = 'pcm'; bitDepth = e.sampleSize || null; }
  if (!rate && isPlausibleRate(e.sampleRate)) rate = Math.round(e.sampleRate);
  // Apple HE-AAC (afconvert 'aach') signals SBR only implicitly and writes the CORE rate
  // (e.g. 24 kHz) in mdhd, sample entry and ASC alike. Decoding at that rate would discard
  // the whole SBR band, so plain-AAC streams at <= 24 kHz are decoded at twice the rate
  // (an LC file then just gets a harmless 2× upsample).
  let implicitSbrAssumed = false;
  const smpbRate = rate;
  if (codec === 'aac' && rate && rate <= 24000) {
    rate *= 2;
    implicitSbrAssumed = true;
  }
  // 0 / all-ones = not written (fragmented or streamed MP4): fall back to the movie header
  const known = (d) => d > 0 && d !== 0xffffffff;
  let duration = null;
  if (tr.timescale > 0 && known(tr.duration)) duration = tr.duration / tr.timescale;
  else if (movie.timescale > 0 && known(movie.duration)) duration = movie.duration / movie.timescale;
  else if (movie.timescale > 0 && known(movie.fragmentDuration)) duration = movie.fragmentDuration / movie.timescale;
  if (!kbps && e.alac && e.alac.avgBitrate) kbps = e.alac.avgBitrate / 1000;
  if (!kbps && duration > 0 && mdatBytes > 0) kbps = (mdatBytes * 8) / duration / 1000;
  const res = {
    format: 'm4a', codec, nativeSampleRate: rate || null, channels, bitDepth,
    bitrateKbps: kbps ? Math.round(kbps) : null, vbr: null, duration, brand, hasAudio: true,
    mdhdTimescale: tr.timescale || null, entrySampleRate: e.sampleRate || null, coreSampleRate: coreRate, sbr, implicitSbrAssumed,
    editMediaTime: tr.mediaTime, encoderDelay: null, encoderPadding: null, totalSamples: null,
  };
  if (codec === 'opus' && e.dOps) res.encoderDelay = e.dOps.preSkip;
  if (smpb) {
    res.itunSmpb = { ...smpb, rate: smpbRate || null }; // counts are in media-timescale samples
    res.encoderDelay = smpb.priming;
    res.encoderPadding = smpb.padding;
    res.totalSamples = smpb.originalSamples;
    if (smpbRate) res.duration = smpb.originalSamples / smpbRate;
  }
  return res;
}

// ---------------------------------------------------------------------------------------
// FLAC and Ogg

function sniffFlac(u8, p) {
  if (ASCII(u8, p) !== 'fLaC' || p + 8 + 34 > u8.length || (u8[p + 4] & 0x7f) !== 0) {
    return { format: 'flac', codec: 'flac', nativeSampleRate: null, channels: null, bitDepth: null, bitrateKbps: null, vbr: null, duration: null };
  }
  const si = p + 8;
  const rate = (u8[si + 10] << 12) | (u8[si + 11] << 4) | (u8[si + 12] >> 4);
  const channels = ((u8[si + 12] >> 1) & 7) + 1;
  const bps = (((u8[si + 12] & 1) << 4) | (u8[si + 13] >> 4)) + 1;
  const total = (u8[si + 13] & 0x0f) * 4294967296 + u32be(u8, si + 14);
  const duration = rate && total ? total / rate : null;
  return {
    format: 'flac', codec: 'flac', nativeSampleRate: rate || null, channels, bitDepth: bps,
    bitrateKbps: null, vbr: null, duration, totalSamples: total || null,
  };
}

function lastOggGranule(u8) {
  for (let p = u8.length - 27; p >= Math.max(0, u8.length - 65536 - 27); p--) {
    if (u8[p] === 0x4f && u8[p + 1] === 0x67 && u8[p + 2] === 0x67 && u8[p + 3] === 0x53 && u8[p + 4] === 0) {
      const lo = u32le(u8, p + 6);
      const hi = u32le(u8, p + 10);
      if (hi === 0xffffffff && lo === 0xffffffff) continue;
      return hi * 4294967296 + lo;
    }
  }
  return null;
}

function sniffOgg(u8) {
  const res = { format: 'ogg', codec: null, nativeSampleRate: null, channels: null, bitDepth: null, bitrateKbps: null, vbr: null, duration: null };
  if (u8.length < 28) return res;
  const nseg = u8[26];
  const p = 27 + nseg;
  if (p + 16 > u8.length) return res;
  const granule = lastOggGranule(u8);
  if (u8[p] === 1 && ASCII(u8, p + 1, 6) === 'vorbis') {
    res.codec = 'vorbis';
    res.channels = u8[p + 11];
    res.nativeSampleRate = u32le(u8, p + 12) || null;
    const nominal = u32le(u8, p + 20) | 0;
    if (nominal > 0) res.bitrateKbps = Math.round(nominal / 1000);
    if (granule !== null && res.nativeSampleRate) res.duration = granule / res.nativeSampleRate;
  } else if (ASCII(u8, p, 8) === 'OpusHead') {
    res.codec = 'opus';
    res.channels = u8[p + 9];
    res.encoderDelay = u16le(u8, p + 10);
    res.inputSampleRate = u32le(u8, p + 12) || null;
    res.nativeSampleRate = 48000; // OpusHead input rate is informational only
    if (granule !== null) res.duration = Math.max(0, granule - res.encoderDelay) / 48000;
  } else if (u8[p] === 0x7f && ASCII(u8, p + 1, 4) === 'FLAC' && p + 17 + 34 <= u8.length) {
    const f = sniffFlac(u8, p + 9);
    Object.assign(res, f, { format: 'ogg' });
    if (granule !== null && f.nativeSampleRate) res.duration = granule / f.nativeSampleRate;
  } else if (ASCII(u8, p, 8) === 'Speex   ') {
    res.codec = 'speex';
    res.nativeSampleRate = u32le(u8, p + 36) || null;
    if (granule !== null && res.nativeSampleRate) res.duration = granule / res.nativeSampleRate;
  }
  if (!res.bitrateKbps && res.duration > 0 && res.codec !== 'flac') res.bitrateKbps = Math.round((u8.length * 8) / res.duration / 1000);
  return res;
}

const LOSSY = new Set(['mp3', 'mp2', 'mp1', 'aac', 'aac_main', 'aac_ssr', 'aac_ltp', 'he-aac', 'he-aac-v2', 'aac_ld', 'aac_eld', 'opus', 'vorbis', 'speex', 'ac3', 'eac3', 'wma']);

// ---------------------------------------------------------------------------------------
// Matroska / WebM (EBML)

/** EBML element ID at p (length marker kept, as the spec writes IDs), or null. */
function ebmlId(u8, p) {
  const b = u8[p];
  const len = b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
  if (!len || p + len > u8.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + u8[p + i];
  return { id, len };
}

/** EBML data size at p (marker removed; -1 = unknown size), or null. */
function ebmlSize(u8, p) {
  if (p >= u8.length) return null;
  const b = u8[p];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > u8.length) return null;
  let v = b & (mask - 1);
  let allOnes = v === mask - 1;
  for (let i = 1; i < len; i++) {
    v = v * 256 + u8[p + i];
    if (u8[p + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : v, len };
}

/** Iterate the child elements of [start, end): yields { id, body, size, end }. */
function* ebmlChildren(u8, start, end) {
  let p = start;
  while (p < end) {
    const id = ebmlId(u8, p);
    if (!id) return;
    const sz = ebmlSize(u8, p + id.len);
    if (!sz) return;
    const body = p + id.len + sz.len;
    if (body > end) return;
    const e = sz.size < 0 ? end : Math.min(end, body + sz.size);
    yield { id: id.id, body, size: sz.size, end: e };
    if (sz.size < 0 || !(e > p)) return; // unknown size: only the caller can descend
    p = e;
  }
}

const ebmlUint = (u8, p, e) => {
  let v = 0;
  for (let i = p; i < e && i < p + 8; i++) v = v * 256 + u8[i];
  return v;
};
const ebmlFloat = (u8, p, e) => {
  const dv = new DataView(u8.buffer, u8.byteOffset + p, e - p);
  return e - p === 4 ? dv.getFloat32(0, false) : e - p === 8 ? dv.getFloat64(0, false) : NaN;
};

const MKV_CODECS = {
  A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', A_ALAC: 'alac', A_AC3: 'ac3', A_EAC3: 'eac3',
  'A_MPEG/L3': 'mp3', 'A_MPEG/L2': 'mp2', 'A_PCM/INT/LIT': 'pcm', 'A_PCM/INT/BIG': 'pcm', 'A_PCM/FLOAT/IEEE': 'pcm',
};

/**
 * Last Cluster timestamp in the final 2 MB (files written live, e.g. MediaRecorder, have no
 * Duration): a lower bound of the duration that misses at most the last cluster (≈ 5 s).
 */
function lastClusterTime(u8, scale) {
  for (let p = u8.length - 12; p >= Math.max(0, u8.length - (2 << 20)); p--) {
    if (u8[p] !== 0x1f || u8[p + 1] !== 0x43 || u8[p + 2] !== 0xb6 || u8[p + 3] !== 0x75) continue;
    const sz = ebmlSize(u8, p + 4);
    if (!sz) continue;
    const q = p + 4 + sz.len;
    if (u8[q] !== 0xe7) continue; // Cluster Timestamp comes first
    const tsz = ebmlSize(u8, q + 1);
    if (!tsz || tsz.size < 1 || tsz.size > 8) continue;
    return (ebmlUint(u8, q + 1 + tsz.len, q + 1 + tsz.len + tsz.size) * scale) / 1e9;
  }
  return null;
}

function sniffMatroska(u8) {
  const res = {
    format: 'other', container: 'matroska', codec: null, nativeSampleRate: null, channels: null, bitDepth: null,
    bitrateKbps: null, vbr: null, duration: null,
  };
  const len = u8.length;
  let segment = null;
  for (const el of ebmlChildren(u8, 0, len)) {
    if (el.id === 0x1a45dfa3) {
      for (const h of ebmlChildren(u8, el.body, el.end)) {
        if (h.id === 0x4282 && /webm/i.test(ASCII(u8, h.body, h.end - h.body))) res.container = 'webm';
      }
    } else if (el.id === 0x18538067) { segment = el; break; }
  }
  if (!segment) return res;
  let scale = 1e6; // TimestampScale default: 1 ms
  let rawDuration = null;
  let track = null;
  for (const el of ebmlChildren(u8, segment.body, segment.end)) {
    if (el.id === 0x1f43b675) break; // first Cluster: Info and Tracks come before it
    if (el.size < 0) break;
    if (el.id === 0x1549a966) { // Info
      for (const c of ebmlChildren(u8, el.body, el.end)) {
        if (c.id === 0x2ad7b1) scale = ebmlUint(u8, c.body, c.end) || 1e6;
        else if (c.id === 0x4489) rawDuration = ebmlFloat(u8, c.body, c.end);
      }
    } else if (el.id === 0x1654ae6b && !track) { // Tracks → first audio TrackEntry
      for (const te of ebmlChildren(u8, el.body, el.end)) {
        if (te.id !== 0xae) continue;
        const t = { type: 0, codecId: '', rate: 0, outRate: 0, channels: 0, bitDepth: 0 };
        for (const c of ebmlChildren(u8, te.body, te.end)) {
          if (c.id === 0x83) t.type = ebmlUint(u8, c.body, c.end);
          else if (c.id === 0x86) t.codecId = ASCII(u8, c.body, c.end - c.body).replace(/\0+$/, '');
          else if (c.id === 0xe1) {
            for (const a of ebmlChildren(u8, c.body, c.end)) {
              if (a.id === 0xb5) t.rate = ebmlFloat(u8, a.body, a.end);
              else if (a.id === 0x78b5) t.outRate = ebmlFloat(u8, a.body, a.end);
              else if (a.id === 0x9f) t.channels = ebmlUint(u8, a.body, a.end);
              else if (a.id === 0x6264) t.bitDepth = ebmlUint(u8, a.body, a.end);
            }
          }
        }
        if (t.type === 2 || (t.codecId.startsWith('A_') && t.rate)) { track = t; break; }
      }
    }
  }
  if (track) {
    const id = track.codecId;
    res.codec = MKV_CODECS[id] || (id.startsWith('A_AAC') ? 'aac' : id ? id.toLowerCase() : null);
    const rate = res.codec === 'opus' ? 48000 : Math.round(track.outRate || track.rate);
    res.nativeSampleRate = isPlausibleRate(rate) ? rate : null;
    res.channels = track.channels || null;
    if (track.bitDepth && !LOSSY.has(res.codec)) res.bitDepth = track.bitDepth;
  }
  if (rawDuration > 0) res.duration = (rawDuration * scale) / 1e9;
  else {
    const t = lastClusterTime(u8, scale);
    if (t > 0) res.durationMin = t;
  }
  const d = res.duration || res.durationMin;
  if (d > 0 && LOSSY.has(res.codec)) res.bitrateKbps = Math.round((len * 8) / d / 1000);
  return res;
}

/**
 * Identify a file from its magic bytes and read the native sample rate (and whatever else
 * the header offers) without decoding audio. Never throws.
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer
 * @returns {{ format: 'wav'|'mp3'|'m4a'|'flac'|'ogg'|'other', codec: string|null,
 *   nativeSampleRate: number|null, channels: number|null, bitDepth: number|null,
 *   bitrateKbps: number|null, vbr: boolean|null, duration: number|null,
 *   encoderDelay?: number|null, encoderPadding?: number|null, totalSamples?: number|null,
 *   [k: string]: any }}
 *   MP3 adds mpegVersion/layer/samplesPerFrame/frames/tag('Xing'|'Info'|'VBRI')/encoder/
 *   hasGaplessInfo; M4A adds mdhdTimescale/entrySampleRate/coreSampleRate/sbr/editMediaTime/
 *   itunSmpb { priming, padding, originalSamples }; Ogg Opus adds inputSampleRate.
 */
export function sniffFormat(arrayBuffer) {
  const unknown = { format: 'other', codec: null, nativeSampleRate: null, channels: null, bitDepth: null, bitrateKbps: null, vbr: null, duration: null };
  let u8;
  try { u8 = toU8(arrayBuffer); } catch { return unknown; }
  if (u8.length < 4) return unknown;
  try {
    const m = ASCII(u8, 0);
    if ((m === 'RIFF' || m === 'RF64' || m === 'BW64') && ASCII(u8, 8) === 'WAVE') {
      try {
        const h = readWavHeader(u8);
        return {
          format: 'wav', codec: h.codec, nativeSampleRate: h.sampleRate, channels: h.numChannels,
          bitDepth: h.bitDepth, bitrateKbps: null, vbr: false, duration: h.duration, container: h.container,
          formatTag: h.formatTag, subFormatTag: h.realTag, channelMask: h.channelMask, supported: !!h.kind, frames: h.frames,
        };
      } catch (e) {
        return { ...unknown, format: 'wav', error: e.code || 'corrupt' };
      }
    }
    if (m === 'FORM' && (ASCII(u8, 8) === 'AIFF' || ASCII(u8, 8) === 'AIFC')) {
      try {
        const h = readAiffHeader(u8);
        return { ...unknown, codec: h.codec, container: 'aiff', nativeSampleRate: h.sampleRate, channels: h.numChannels, bitDepth: h.bitDepth, duration: h.duration, supported: !!h.kind };
      } catch (e) {
        return { ...unknown, container: 'aiff', error: e.code || 'corrupt' };
      }
    }
    if (m === 'OggS') return sniffOgg(u8);
    if (u8.length >= 8 && ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].includes(ASCII(u8, 4))) return sniffMp4(u8);
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return sniffMatroska(u8);
    const p = skipId3v2(u8, 0);
    if (ASCII(u8, p) === 'fLaC') return sniffFlac(u8, p);
    const adts = sniffAdts(u8, p);
    if (adts) return adts;
    const mp3 = sniffMp3(u8, p);
    if (mp3) return mp3;
  } catch {
    // fall through: a malformed header must never break the caller
  }
  return unknown;
}

// ---------------------------------------------------------------------------------------
// Browser decode path

function isWebKitDecoder() {
  const ua = (globalThis.navigator && globalThis.navigator.userAgent) || '';
  // Safari and every iOS browser decode with CoreAudio (WebKit); desktop Chromium/Gecko use FFmpeg.
  return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua);
}

function createDecodeContext(rate) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) return null;
  try { return new OAC({ numberOfChannels: 2, length: 1, sampleRate: rate }); } catch { /* old API */ }
  try { return new OAC(2, 1, rate); } catch { return null; }
}

function decodeWithContext(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = (b) => { if (!done) { done = true; resolve(b); } };
    const fail = (e) => { if (!done) { done = true; reject(e || new Error('decodeAudioData failed')); } };
    try {
      const p = ctx.decodeAudioData(bytes, ok, fail); // callback form for old WebKit
      if (p && typeof p.then === 'function') p.then(ok, fail);
    } catch (e) {
      fail(e);
    }
  });
}

/**
 * decodeAudioData at the native rate (48 kHz if unknown or out of this browser's range).
 * `bytes` is handed over WITHOUT a copy and is detached afterwards (Chrome/Firefox): the
 * caller must not need it again. That holds because at most one decodeAudioData call is
 * made: a context that cannot be created is skipped before anything is decoded, and a
 * failure at the native rate is a decode error, never retried.
 */
async function webAudioDecode(bytes, nativeRate) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw decodeError('unsupported', 'This browser has no Web Audio decoder. Please use a WAV file.', { codec: 'webaudio', reason: 'browser' });
  const rates = [];
  if (nativeRate && isPlausibleRate(nativeRate)) rates.push(nativeRate);
  if (!rates.includes(48000)) rates.push(48000); // rate outside this browser's range, or unknown
  for (const rate of rates) {
    const ctx = createDecodeContext(rate);
    if (!ctx) continue;
    const ab = await decodeWithContext(ctx, bytes);
    return { buffer: ab, contextRate: rate };
  }
  throw decodeError('unsupported', 'Could not create an audio decoder in this browser.', { codec: 'webaudio', reason: 'browser' });
}

/**
 * Copy frames [start, start + length) of every channel out of an AudioBuffer (our own
 * buffers: transferable to the worker, and the AudioBuffer can be freed). Copying only the
 * gapless-trimmed range avoids a second full-length copy.
 */
function audioBufferToChannels(ab, start = 0, length = ab.length - start) {
  const out = [];
  const n = Math.max(0, Math.min(length, ab.length - start));
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const ch = new Float32Array(n);
    if (typeof ab.copyFromChannel === 'function') ab.copyFromChannel(ch, c, start);
    else ch.set(ab.getChannelData(c).subarray(start, start + n));
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      if (!(v - v === 0)) ch[i] = 0;
    }
    out.push(ch);
  }
  return out;
}

const CODEC_LABELS = {
  aac: 'AAC', 'he-aac': 'HE-AAC', 'he-aac-v2': 'HE-AAC v2', aac_main: 'AAC Main', aac_ltp: 'AAC LTP', aac_ld: 'AAC-LD',
  aac_eld: 'AAC-ELD', alac: 'Apple Lossless (ALAC)', flac: 'FLAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Ogg Vorbis',
  ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)', speex: 'Speex', pcm: 'PCM',
};

// RFC 6381 codec strings for the media-element probe (MP4 sample entries).
const MP4_CODEC_STRINGS = {
  aac: 'mp4a.40.2', 'he-aac': 'mp4a.40.5', 'he-aac-v2': 'mp4a.40.29', aac_main: 'mp4a.40.1', aac_ltp: 'mp4a.40.4',
  aac_ld: 'mp4a.40.23', aac_eld: 'mp4a.40.39', alac: 'alac', opus: 'opus', ac3: 'ac-3', eac3: 'ec-3',
};

/**
 * MIME type (with codecs) that asks for this file's decoder, for canPlayType; null when no
 * type answers it reliably (plain Matroska, PCM, unknown codecs: the gap rules decide).
 */
function probeMime(sniff) {
  const c = sniff.codec;
  if (!c) return null;
  if (sniff.container === 'webm') return c === 'opus' || c === 'vorbis' ? `audio/webm; codecs="${c}"` : null;
  if (sniff.container === 'matroska') return null; // WebKit has no Matroska demuxer at all
  if (c === 'mp3') return 'audio/mpeg';
  if (sniff.container === 'adts') return 'audio/aac';
  if (sniff.format === 'ogg') return `audio/ogg; codecs="${c}"`;
  if (c === 'flac') return 'audio/flac'; // native FLAC and FLAC in MP4 use the same decoder
  if (sniff.format === 'm4a' && MP4_CODEC_STRINGS[c]) return `audio/mp4; codecs="${MP4_CODEC_STRINGS[c]}"`;
  return null;
}

/**
 * Can this browser decode the codec at all? Asks an <audio> element (canPlayType covers the
 * same decoders as decodeAudioData in Chromium, Gecko and WebKit). true / false, or null
 * when there is no DOM to ask or no MIME type for the file.
 */
function browserHasCodec(sniff) {
  const mime = probeMime(sniff);
  const doc = globalThis.document;
  if (!mime || !doc || typeof doc.createElement !== 'function') return null;
  try {
    const el = doc.createElement('audio');
    if (!el || typeof el.canPlayType !== 'function') return null;
    return el.canPlayType(mime) !== '';
  } catch {
    return null;
  }
}

/** Did the sniffer read a complete, consistent audio header (codec and rate)? */
const headerParsed = (sniff) => !!(sniff.codec && sniff.nativeSampleRate && (sniff.format !== 'm4a' || sniff.hasAudio));

function mapDecodeFailure(err, sniff, ext) {
  if (err && err.code && ['unsupported', 'corrupt', 'too_long'].includes(err.code)) return err;
  const codec = sniff.codec || null;
  const codecLabel = CODEC_LABELS[codec] || (sniff.container && !codec ? sniff.container.toUpperCase() : codec);
  const to = codec === 'flac' ? 'WAV' : LOSSY.has(codec) ? 'MP3 or WAV' : 'WAV or FLAC';
  const unsupported = (why) => decodeError('unsupported', `${codecLabel} is not supported here: ${why}. Please convert the file to ${to}.`, { codec, codecLabel, reason: 'codec', cause: err });
  // decodeAudioData raises the same EncodingError for damaged files and for codecs the
  // browser lacks (AAC on Linux Firefox without system codecs, Chromium builds without
  // proprietary codecs, ALAC outside Safari, Opus-in-MP4 on older Safari…). When the header
  // parsed cleanly, ask the media element whether the codec exists here at all.
  const has = headerParsed(sniff) ? browserHasCodec(sniff) : null;
  if (has === false) return unsupported('this browser has no decoder for it');
  if (has === true) return decodeError('corrupt', `The file could not be decoded (${codec}); it may be damaged or incomplete.`, { codec, codecLabel, cause: err });
  // No probe: codecs/containers with known browser gaps are 'unsupported'; failures of
  // mainstream codecs (MP3, AAC, FLAC) are 'corrupt'.
  const gaps = ['alac', 'opus', 'vorbis', 'speex', 'ac3', 'eac3', 'aac_main', 'aac_ssr', 'aac_ltp', 'aac_ld', 'aac_eld', 'pcm'];
  if (gaps.includes(codec) || (sniff.format === 'ogg' && !codec) || ['aiff', 'webm', 'matroska'].includes(sniff.container)) {
    return unsupported(codec === 'alac' && !isWebKitDecoder() ? 'only Safari can decode it' : 'this browser cannot decode it');
  }
  if (sniff.format === 'other' && !codec) {
    return decodeError('unsupported', `Unrecognised audio format${ext ? ` (.${ext})` : ''}. Please use WAV, MP3, M4A, FLAC or OGG.`, { codec: null, reason: 'format' });
  }
  return decodeError('corrupt', `The file could not be decoded (${codec || sniff.format}); it may be damaged or incomplete.`, { codec, codecLabel, cause: err });
}

// Highest bitrate a lossy stream of each codec can have: size / this = the shortest the
// file can be, a safe lower bound of its duration when no header states it.
const MAX_LOSSY_BPS = 1_000_000;
const MAX_LOSSY_BPS_BY_CODEC = { eac3: 6_144_000 };

/**
 * Shortest duration the file can have, without decoding: the header's own duration, else a
 * bound from its size (raw PCM rate for lossless codecs, the codec's maximum bitrate for
 * lossy ones). 0 when nothing is known.
 */
function minDurationSec(sniff, sizeBytes) {
  if (sniff.duration > 0) return sniff.duration;
  let best = sniff.durationMin > 0 ? sniff.durationMin : 0;
  const { nativeSampleRate: rate, channels: ch, bitDepth: bits, codec } = sniff;
  // lossless never stores much more than raw PCM (FLAC verbatim frames: < 1 % overhead)
  if (rate && ch && bits && !LOSSY.has(codec)) best = Math.max(best, (sizeBytes * 8) / (rate * ch * bits * 1.02));
  else if (LOSSY.has(codec)) best = Math.max(best, (sizeBytes * 8) / (MAX_LOSSY_BPS_BY_CODEC[codec] || MAX_LOSSY_BPS));
  return best;
}

function tooLong(duration, maxDurationSec, estimated = false) {
  return decodeError('too_long', `The file is ${estimated ? 'at least ' : ''}${(duration / 60).toFixed(1)} min long; the maximum is ${+(maxDurationSec / 60).toFixed(1)} min.`, { duration, maxDurationSec, estimated });
}

/**
 * Head/tail trimming for encoder delay/padding the browser did not remove (RESEARCH §6).
 * @returns {{ start: number, length: number, method: string }}
 */
function gaplessTrim(sniff, decodedLength, decodedRate) {
  const none = { start: 0, length: decodedLength, method: 'none' };
  if (!sniff.nativeSampleRate || decodedRate !== sniff.nativeSampleRate) return none;
  const L = decodedLength;
  if (sniff.format === 'mp3' && sniff.layer === 3 && sniff.frames > 0) {
    const total = sniff.frames * sniff.samplesPerFrame;
    const webkit = isWebKitDecoder();
    if (sniff.hasGaplessInfo) {
      const expected = sniff.totalSamples;
      if (Math.abs(L - expected) <= 2) return { ...none, method: 'browser' };
      if (L >= total - 2) {
        // Browser ignored the LAME tag (Firefox < 83): apply it ourselves.
        const start = Math.min(L, sniff.encoderDelay + (webkit ? 0 : 529));
        return { start, length: Math.max(0, Math.min(expected, L - start)), method: 'lame-tag' };
      }
      return none;
    }
    if (L >= total - 2 && L <= total + sniff.samplesPerFrame) {
      // No LAME tag: decoders output every frame including the LAME encoder delay (576)
      // and, except CoreAudio, the 529-sample decoder delay.
      const start = Math.min(L, webkit ? 576 : 1105);
      return { start, length: L - start, method: 'mp3-delay' };
    }
    return none;
  }
  if (sniff.format === 'm4a' && sniff.itunSmpb) {
    const k = sniff.itunSmpb.rate ? decodedRate / sniff.itunSmpb.rate : 1;
    if (k !== 1 && k !== 2) return none;
    const priming = Math.round(sniff.itunSmpb.priming * k);
    const N = Math.round(sniff.itunSmpb.originalSamples * k);
    const extra = L - N;
    if (Math.abs(extra) <= 2) return { ...none, method: 'browser' };
    // Firefox ignores iTunSMPB: priming (2112) at the head + a rounded-up tail.
    if (extra >= priming) return { start: priming, length: N, method: 'itunsmpb' };
    // Head already trimmed (FFmpeg-style), only padding left at the tail.
    if (extra > 0) return { start: 0, length: N, method: 'itunsmpb-tail' };
  }
  return none;
}

function splitName(name) {
  const base = String(name).split(/[\\/]/).pop() || 'audio';
  const dot = base.lastIndexOf('.');
  if (dot > 0 && dot < base.length - 1) return { baseName: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() };
  return { baseName: base, ext: '' };
}

async function readBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  if (typeof Response === 'function') return new Response(file).arrayBuffer();
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  throw new TypeError('cannot read the file');
}

/**
 * Decode a user file to stereo AudioData at its native sample rate.
 * @param {File|Blob} file Blob with an optional `name`
 * @param {{ maxDurationSec?: number }} [opts] length cap (default MAX_DURATION_SEC; pass
 *   deviceMaxDurationSec() for a memory-aware cap). Checked before decoding whenever the
 *   header (or the file size) proves the file is longer.
 * @returns {Promise<{ audio: { sampleRate: number, channels: Float32Array[] }, info: {
 *   name: string, baseName: string, ext: string, format: 'wav'|'mp3'|'m4a'|'flac'|'ogg'|'other',
 *   codec: string|null, sampleRate: number, nativeSampleRate: number|null, decodedChannels: number,
 *   bitDepth: number|null, bitrateKbps: number|null, duration: number, sizeBytes: number,
 *   lossy: boolean, vbr: boolean|null, decoder: 'js'|'webaudio', resampledByBrowser: boolean,
 *   encoderDelay: number|null, encoderPadding: number|null,
 *   gapless: { method: string, trimmedStart: number, trimmedEnd: number } } }>}
 * @throws {Error & { code: 'unsupported'|'corrupt'|'too_long', message: string }}
 */
export async function decodeFile(file, opts = {}) {
  if (!file || (typeof file.arrayBuffer !== 'function' && typeof file.size !== 'number')) throw new TypeError('decodeFile: expected a File or Blob');
  const maxDurationSec = opts.maxDurationSec > 0 ? opts.maxDurationSec : MAX_DURATION_SEC;
  const name = typeof file.name === 'string' && file.name ? file.name : 'audio';
  const { baseName, ext } = splitName(name);
  const sizeBytes = file.size || 0;
  if (!sizeBytes) throw decodeError('corrupt', 'The file is empty.');
  let bytes = await readBytes(file);
  const sniff = sniffFormat(bytes);
  let channels;
  let sampleRate;
  let decoder = 'js';
  let bitDepth = null;
  let codec = sniff.codec;
  let channelMask = 0;
  let decodedChannels;
  let gap = { method: 'none', start: 0, length: 0, total: 0 };
  let resampledByBrowser = false;

  const pcmParser = sniff.format === 'wav' ? parseWav : sniff.container === 'aiff' ? parseAiff : null;
  let parsed = null;
  if (pcmParser) {
    try {
      parsed = pcmParser(bytes, { maxDurationSec });
    } catch (e) {
      // Exotic WAV codecs (ADPCM…): let the browser try before giving up.
      if (e.code !== 'unsupported' || !(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) throw e;
      try {
        const r = await webAudioDecode(bytes, sniff.nativeSampleRate);
        parsed = { sampleRate: r.buffer.sampleRate, channels: audioBufferToChannels(r.buffer), bitDepth: null, codec: e.codec, channelMask: 0, viaWebAudio: true };
      } catch {
        throw e;
      }
    }
  }
  if (parsed) {
    bytes = null;
    channels = parsed.channels;
    sampleRate = parsed.sampleRate;
    bitDepth = parsed.bitDepth;
    codec = parsed.codec;
    channelMask = parsed.channelMask || 0;
    if (parsed.viaWebAudio) decoder = 'webaudio';
    parsed = null;
  } else {
    // Refuse before decoding: a long file would first be decoded in full (≈ 23 MB per
    // minute and channel pair at 48 kHz) only to be rejected afterwards.
    const minDur = minDurationSec(sniff, sizeBytes);
    if (minDur > maxDurationSec) throw tooLong(minDur, maxDurationSec, !(sniff.duration > 0));
    let r;
    try {
      r = await webAudioDecode(bytes, sniff.nativeSampleRate);
    } catch (err) {
      throw mapDecodeFailure(err, sniff, ext);
    } finally {
      bytes = null; // drop the file bytes as soon as decoding is over (memory)
    }
    decoder = 'webaudio';
    let ab = r.buffer;
    r = null;
    sampleRate = ab.sampleRate;
    resampledByBrowser = !!(sniff.nativeSampleRate && sampleRate !== sniff.nativeSampleRate);
    const L = ab.length;
    const t = gaplessTrim(sniff, L, sampleRate);
    gap = { ...t, total: L };
    channels = audioBufferToChannels(ab, t.start, t.length);
    ab = null; // let the AudioBuffer go before the stereo conversion
    if (sniff.format === 'flac' || sniff.codec === 'alac') bitDepth = sniff.bitDepth || null;
  }
  decodedChannels = channels.length;
  const frames = decodedChannels ? channels[0].length : 0;
  if (!frames) throw decodeError('corrupt', 'The file contains no audio.');
  const duration = frames / sampleRate;
  if (duration > maxDurationSec) throw tooLong(duration, maxDurationSec);
  const stereo = toStereo(channels, channelMask);
  channels = null;
  const lossy = LOSSY.has(codec);
  const info = {
    name, baseName, ext, format: sniff.format, codec: codec || null, sampleRate,
    nativeSampleRate: sniff.nativeSampleRate || sampleRate, decodedChannels, bitDepth,
    bitrateKbps: lossy && sniff.bitrateKbps ? sniff.bitrateKbps : null, duration, sizeBytes,
    lossy, vbr: lossy ? sniff.vbr ?? null : false, decoder, resampledByBrowser,
    encoderDelay: sniff.encoderDelay ?? null, encoderPadding: sniff.encoderPadding ?? null,
    gapless: { method: gap.method, trimmedStart: gap.start || 0, trimmedEnd: gap.total ? Math.max(0, gap.total - gap.start - gap.length) : 0 },
  };
  return { audio: { sampleRate, channels: stereo }, info };
}
