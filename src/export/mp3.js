// MP3 export with lamejs (LGPL-3.0), loaded at runtime from a pinned CDN URL.
//
// * lamejs' Mp3Encoder is CBR with the bit reservoir disabled and plain L/R stereo, so we
//   offer 320 kbps by default (the reservoir/joint-stereo loss is negligible there).
// * Input: float → Int16 with flat TPDF dither (no noise shaping: a perceptual codec would
//   spend bits on the shaped HF noise). 32/44.1/48 kHz only (MPEG-1 Layer III).
// * Encoding runs in 1152·N-sample chunks and yields to the event loop every ~50 ms so the
//   UI stays responsive on the main thread (MessageChannel, not setTimeout: timers are
//   throttled to ≥ 1 s in background tabs).
// * Gapless: lamejs writes no Info/LAME tag, so decoders would add 1105 (Chromium/Gecko) or
//   576 (WebKit) samples of leading silence (research/04 §1.4). We prepend a standard
//   Info frame + LAME extension carrying encoder delay (576) and padding, which LAME,
//   FFmpeg, Chrome, Firefox (≥ 83) and Safari honour → sample-exact length and alignment.
// * Metadata (optional): the source's tags, lyrics and cover as an ID3v2.3 tag in front of
//   the Info frame (decoders skip ID3v2 by its size, so gapless trimming is unchanged).
import { PcmQuantizer } from '../dsp/dither.js';
import { prepareExportMetadata, hasExportMetadata, buildId3v2 } from '../audio/metadata.js';

/** Primary lamejs build (classic script: `function lamejs(){…}` sets lamejs.Mp3Encoder). */
export const LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
/** Fallback build (@breezystack fork, IIFE: `var lamejs = {Mp3Encoder, …}`). */
export const LAME_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.iife.js';
// Subresource Integrity: the browser refuses either file if the CDN ever serves other bytes
// (both verified 2026-10: the cdnjs hash is the one cdnjs publishes for 1.2.1; the jsdelivr
// file matches the sha256 in jsdelivr's package listing; both expose Mp3Encoder(channels,
// rate, kbps) with encodeBuffer(left, right) and flush()).
export const LAME_INTEGRITY = 'sha512-xT0S/xXvkrfkRXGBPlzZPCAncnMK5c1N7slRkToUbv8Z901aUEuKO84tLy8dWU+3ew4InFEN7TebPaVMy2npZw==';
export const LAME_FALLBACK_INTEGRITY = 'sha384-KET6YrYmKZcEZxY3gujbd0H8k7MHKDX/ONdVWD1XoixjS2AuhzMJBHsRDiM8+gH9';

export const MP3_SAMPLE_RATES = Object.freeze([32000, 44100, 48000]);
export const MP3_BITRATES = Object.freeze([32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]);

const ENCODER_DELAY = 576; // LAME ENCDELAY; lamejs is a port of LAME 3.98
const CHUNK_FRAMES = 1152 * 16;
const SLICE_MS = 50;
const LOAD_TIMEOUT_MS = 30000;

const now = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

function mp3Error(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Resolve on the next macrotask without timer throttling. */
function yieldToEventLoop() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The encoder namespace from either build's global (function or object, maybe .default). */
function lameNamespace(g) {
  if (!g) return null;
  if (typeof g.Mp3Encoder === 'function') return g;
  if (g.default && typeof g.default.Mp3Encoder === 'function') return g.default;
  return null;
}

function injectScript(url, integrity) {
  const doc = globalThis.document;
  if (doc && typeof doc.createElement === 'function') {
    return new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      let timer = null;
      const done = (err) => {
        clearTimeout(timer);
        s.onload = s.onerror = null;
        if (err) {
          s.remove();
          reject(err);
        } else resolve();
      };
      timer = setTimeout(() => done(new Error(`timeout loading ${url}`)), LOAD_TIMEOUT_MS);
      s.onload = () => done(null);
      s.onerror = () => done(new Error(`failed to load ${url}`));
      s.async = true;
      s.referrerPolicy = 'no-referrer';
      if (integrity) {
        s.integrity = integrity;
        s.crossOrigin = 'anonymous'; // SRI needs a CORS fetch (both CDNs send ACAO: *)
      }
      s.src = url;
      (doc.head || doc.documentElement).appendChild(s);
    });
  }
  if (typeof globalThis.importScripts === 'function') {
    // classic worker: synchronous; throws on network/CSP errors
    return new Promise((resolve, reject) => {
      try {
        globalThis.importScripts(url);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }
  return Promise.reject(new Error('no way to load scripts in this environment'));
}

let lamePromise = null;

/**
 * Load lamejs once (primary CDN, then fallback; each pinned with SRI) and resolve its
 * namespace ({ Mp3Encoder, … }). A global `lamejs` already present (an earlier load, a
 * bundled build, tests) is used as is. A failed load is not cached, so a later call retries.
 * @returns {Promise<{ Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => { encodeBuffer(l: Int16Array, r?: Int16Array): Int8Array, flush(): Int8Array } }>}
 * @throws {Error & { code: 'mp3_load' }}
 */
export function loadLame() {
  const existing = lameNamespace(globalThis.lamejs);
  if (existing) return Promise.resolve(existing);
  if (!lamePromise) {
    lamePromise = (async () => {
      let lastErr = null;
      for (const [url, integrity] of [[LAME_URL, LAME_INTEGRITY], [LAME_FALLBACK_URL, LAME_FALLBACK_INTEGRITY]]) {
        try {
          await injectScript(url, integrity);
          const ns = lameNamespace(globalThis.lamejs);
          if (ns) return ns;
          lastErr = new Error(`${url} did not define lamejs`);
        } catch (e) {
          lastErr = e;
        }
      }
      throw mp3Error('mp3_load', `The MP3 encoder could not be loaded (${lastErr && lastErr.message}). Check the connection or export WAV.`);
    })();
    // Only concurrent calls share a load: after success the global answers (above), and a
    // failed load is retried next time.
    const clear = () => {
      lamePromise = null;
    };
    lamePromise.then(clear, clear);
  }
  return lamePromise;
}

/**
 * Float stereo → dithered Int16 blocks for the encoder (flat TPDF, continuous across
 * blocks). Block length is a multiple of 1152 (one MPEG-1 Layer III frame) except the last.
 * The yielded arrays are REUSED between iterations: consume them before advancing.
 * @param {Float32Array[]} channels 1 or 2 channels (mono is fed to both sides)
 * @param {{ chunkFrames?: number, seed?: number }} [opts]
 * @returns {Generator<{ left: Int16Array, right: Int16Array, start: number, end: number }>}
 */
export function* _toInt16Chunks(channels, { chunkFrames = CHUNK_FRAMES, seed = 1 } = {}) {
  if (!channels || !channels.length) return;
  const L = channels[0];
  const R = channels.length > 1 ? channels[1] : channels[0];
  const n = Math.min(L.length, R.length);
  if (!n) return;
  const size = Math.max(1, Math.round(chunkFrames / 1152)) * 1152;
  const q = new PcmQuantizer(2, 16, { dither: 'tpdf', noiseShaping: 'none', seed });
  const left = new Int16Array(size);
  const right = new Int16Array(size);
  for (let s = 0; s < n; s += size) {
    const e = Math.min(n, s + size);
    const m = e - s;
    q.quantizeChannel(L, s, e, left, 0, 1, 0);
    q.quantizeChannel(R, s, e, right, 0, 1, 1);
    if (m === size) yield { left, right, start: s, end: e };
    else yield { left: left.subarray(0, m), right: right.subarray(0, m), start: s, end: e };
  }
}

// --- gapless Info/LAME tag ---------------------------------------------------------------

const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const SR_V1 = [44100, 48000, 32000];

let CRC16 = null;
/** CRC-16/ARC (poly 0x8005 reflected, init 0): the LAME tag's music and tag CRCs. */
function crc16(bytes, start, end, crc = 0) {
  if (!CRC16) {
    CRC16 = new Uint16Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
      CRC16[n] = c;
    }
  }
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC16[(crc ^ bytes[i]) & 255];
  return crc & 0xffff;
}

function v1l3Frame(u8, p) {
  if (p + 4 > u8.length || u8[p] !== 0xff || (u8[p + 1] & 0xfe) !== 0xfa) return null; // MPEG-1 Layer III
  const brIdx = u8[p + 2] >> 4;
  const srIdx = (u8[p + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const kbps = BR_V1L3[brIdx];
  const sr = SR_V1[srIdx];
  return { kbps, sr, srIdx, length: Math.floor((144000 * kbps) / sr) + ((u8[p + 2] >> 1) & 1), mono: u8[p + 3] >> 6 === 3 };
}

/**
 * Build an Info frame (Xing header for CBR + LAME extension) for a tag-less MPEG-1 Layer III
 * stream such as lamejs output, so decoders trim encoder delay and padding.
 * @param {Uint8Array} audio the encoded frames (starting with a frame header)
 * @param {number} numSamples original length in samples per channel
 * @param {{ delay?: number }} [opts] encoder delay (576 for LAME/lamejs)
 * @returns {Uint8Array|null} the frame to prepend, or null if the stream is not usable
 */
export function _buildInfoFrame(audio, numSamples, { delay = ENCODER_DELAY } = {}) {
  const first = v1l3Frame(audio, 0);
  if (!first) return null;
  let frames = 0;
  let p = 0;
  while (p < audio.length) {
    const f = v1l3Frame(audio, p);
    if (!f || f.sr !== first.sr || p + f.length > audio.length) break;
    frames++;
    p += f.length;
  }
  const musicEnd = p;
  const padding = frames * 1152 - delay - numSamples;
  if (!(frames > 0) || padding < 0 || padding > 4095 || delay > 4095) return null;
  // Same bitrate as the stream (keeps CBR detection happy) unless that frame is too small
  // for the 192 bytes of header + side info + Xing + LAME data.
  let brIdx = BR_V1L3.indexOf(first.kbps);
  while (brIdx < 14 && Math.floor((144000 * BR_V1L3[brIdx]) / first.sr) < 192) brIdx++;
  const len = Math.floor((144000 * BR_V1L3[brIdx]) / first.sr);
  const tag = new Uint8Array(len);
  const dv = new DataView(tag.buffer);
  tag[0] = 0xff;
  tag[1] = 0xfb; // MPEG-1, Layer III, no CRC
  tag[2] = (brIdx << 4) | (first.srIdx << 2);
  tag[3] = audio[3] & 0xcf; // channel mode/copyright/original/emphasis of the stream, no mode ext
  const x = 4 + (first.mono ? 17 : 32);
  tag.set([0x49, 0x6e, 0x66, 0x6f], x); // 'Info' = CBR
  dv.setUint32(x + 4, 0x0f, false); // frames, bytes, TOC, quality present
  dv.setUint32(x + 8, frames, false);
  dv.setUint32(x + 12, len + musicEnd, false);
  for (let i = 0; i < 100; i++) tag[x + 16 + i] = Math.floor((i * 256) / 100); // linear TOC (CBR)
  dv.setUint32(x + 116, 0, false); // quality: unknown
  const l = x + 120;
  const ver = 'LAME3.98r';
  for (let i = 0; i < 9; i++) tag[l + i] = ver.charCodeAt(i);
  tag[l + 9] = 0x01; // tag revision 0, VBR method 1 = CBR
  tag[l + 20] = Math.min(255, first.kbps);
  tag[l + 21] = delay >> 4;
  tag[l + 22] = ((delay & 15) << 4) | (padding >> 8);
  tag[l + 23] = padding & 255;
  const srcFreq = first.sr === 44100 ? 1 : first.sr === 48000 ? 2 : 0;
  tag[l + 24] = (srcFreq << 6) | ((first.mono ? 0 : 1) << 2); // stereo mode: 0 mono / 1 L-R stereo
  dv.setUint32(l + 28, len + musicEnd, false); // music length incl. this frame
  dv.setUint16(l + 32, crc16(audio, 0, musicEnd), false);
  dv.setUint16(l + 34, crc16(tag, 0, 190), false);
  return tag;
}

/**
 * Encode stereo audio to MP3 (CBR) with lamejs.
 * @param {{ sampleRate: number, channels: Float32Array[] }} audio sampleRate 32000|44100|48000
 *   (the caller resamples; dither is applied here, so pass the float master)
 * @param {{ kbps?: number, onProgress?: (fraction: number) => void, seed?: number,
 *   gapless?: boolean, isCancelled?: () => boolean, metadata?: object|null }} [opts]
 *   gapless (default true) prepends the Info/LAME tag frame with delay/padding.
 *   metadata: the source's readMetadata() result → ID3v2.3 tag (tags, lyrics, cover) first.
 * @returns {Promise<Blob>} type 'audio/mpeg'
 * @throws {Error & { code: 'unsupported_rate'|'unsupported_bitrate'|'mp3_load'|'cancelled' }}
 */
export async function encodeMp3(audio, { kbps = 320, onProgress, seed = 1, gapless = true, isCancelled, metadata = null } = {}) {
  if (!audio || !audio.channels || !audio.channels.length) throw new TypeError('encodeMp3: audio.channels required');
  const sr = audio.sampleRate;
  if (!MP3_SAMPLE_RATES.includes(sr)) throw mp3Error('unsupported_rate', `MP3 export needs 32, 44.1 or 48 kHz audio (got ${sr} Hz)`);
  if (!MP3_BITRATES.includes(kbps)) throw mp3Error('unsupported_bitrate', `Unsupported MP3 bitrate ${kbps} kbps`);
  const lame = await loadLame();
  const enc = new lame.Mp3Encoder(2, sr, kbps);
  const L = audio.channels[0];
  const R = audio.channels[1] || L;
  const total = Math.min(L.length, R.length);
  const parts = [];
  let size = 0;
  const push = (buf) => {
    if (!buf || !buf.length) return;
    // lamejs returns Int8Array views; copy to standalone bytes
    const b = new Uint8Array(buf.buffer, buf.byteOffset, buf.length).slice();
    parts.push(b);
    size += b.length;
  };
  const progress = typeof onProgress === 'function' ? onProgress : null;
  let sliceStart = now();
  if (progress) progress(0);
  for (const chunk of _toInt16Chunks(audio.channels, { seed })) {
    if (isCancelled && isCancelled()) throw mp3Error('cancelled', 'MP3 encoding cancelled');
    push(enc.encodeBuffer(chunk.left, chunk.right));
    if (progress) progress(0.99 * (chunk.end / total));
    if (now() - sliceStart > SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = now();
    }
  }
  push(enc.flush());
  let out = parts;
  if (gapless && size) {
    const all = new Uint8Array(size);
    let p = 0;
    for (const b of parts) {
      all.set(b, p);
      p += b.length;
    }
    const tag = _buildInfoFrame(all, total);
    out = tag ? [tag, all] : [all];
  }
  if (metadata) {
    try {
      const meta = prepareExportMetadata(metadata);
      if (hasExportMetadata(meta)) out = [buildId3v2(meta), ...out];
    } catch {
      // metadata that cannot be written leaves the master untagged; it never fails the export
    }
  }
  if (progress) progress(1);
  return new Blob(out, { type: 'audio/mpeg' });
}
