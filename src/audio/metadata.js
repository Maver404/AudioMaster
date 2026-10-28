// Audio file metadata: a reader for every tag format a dropped song can carry (title,
// artist, lyrics, cover art, …) and the writers the exporters use to carry the source's
// metadata into the master (ID3v2.3 for MP3 and WAV 'id3 ' chunks, RIFF LIST/INFO).
// Environment-neutral (browser main thread, worker, Node): no DOM, no Web Audio.
//
// Reading is bounded: only the header/tag regions are read — never the audio payload.
// A File/Blob is read through Blob.slice (64 KiB windows), so a 100 MB WAV costs a few
// small reads. MP3/AAC: leading ID3v2 tag(s) + the tail (ID3v1, APEv2, appended ID3v2);
// MP4: box headers only, descending moov → (trak →) udta → meta → ilst, never mdat/stbl;
// FLAC: metadata blocks; Ogg: the header packets of the first audio logical stream; WAV/AIFF:
// chunk headers, reading only LIST/INFO, 'id3 '/'ID3 ', bext and AIFF text chunks.
// Any single tag region is capped at MAX_REGION_BYTES; values, fields and pictures per tag
// block at MAX_TAG_ITEMS / MAX_PICTURES, and all work is linear in the bytes read (hostile
// tags with 100,000 frames or millions of nested MP4 headers stay fast). Nothing here throws
// on bad input: problems end up in `warnings` and whatever was parsed so far is returned.
// Picture `mime` is always one of IMAGE_MIMES or 'application/octet-stream'.
//
// Supported: ID3v2.2/2.3/2.4 (sync-safe sizes, tag- and frame-level unsynchronisation,
// extended header, footer, iTunes' non-sync-safe v2.4 frame sizes (decided per tag), any
// chain of trailing ID3v2.4/APEv2 tags before ID3v1; compressed/encrypted
// frames are skipped with a warning; text encodings 0–3 incl. UTF-16 BOM/BE; multiple
// values; APIC/PIC, USLT, COMM, TXXX, WXXX, W***, UFID, POPM, PCNT, TIPL/TMCL/IPLS; TCON
// '(13)' genre numbers), ID3v1/1.1, APEv2, MP4/M4A ilst (incl. freeform '----' atoms,
// covr, QuickTime 'keys' metadata and classic udta '©xyz' atoms), FLAC VORBIS_COMMENT +
// PICTURE, Ogg Vorbis/Opus/FLAC/Speex comment headers (METADATA_BLOCK_PICTURE and legacy
// COVERART), WAV LIST/INFO + 'id3 ' + bext (RIFF/RF64/BW64), AIFF/AIFC 'ID3 ' + NAME/AUTH/
// (c) /ANNO/COMT. Picture dimensions come from the JPEG SOF / PNG IHDR / GIF / BMP / WebP
// headers (no decoding).

/** Largest single tag region read into memory (an ID3 tag, an ilst box, a FLAC block…). */
export const MAX_REGION_BYTES = 64 * 1024 * 1024;
/** Pictures bigger than this are not copied into exported masters. */
export const MAX_EXPORT_PICTURE_BYTES = 16 * 1024 * 1024;
/** All pictures of one exported master together (later ones are skipped past this). */
export const MAX_EXPORT_PICTURES_TOTAL_BYTES = 64 * 1024 * 1024;
/**
 * Caps against hostile tags (a < 1 MB ID3 tag can hold 40,000 frames): distinct values
 * kept per field and extra fields kept per tag block and in the merged result; pictures per
 * tag block. What is over the cap is dropped with one warning.
 */
export const MAX_TAG_ITEMS = 1024;
export const MAX_PICTURES = 64;
/** At most this many warnings are returned (the last one says how many were left out). */
export const MAX_WARNINGS = 64;
/**
 * The only picture `mime` values readMetadata/prepareExportMetadata produce besides
 * 'application/octet-stream' (bytes that are no recognised image and were not declared as
 * one of these). A Blob of a picture may only be used as an <img> source.
 */
export const IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp']);
const IMAGE_MIME_SET = new Set(IMAGE_MIMES);
const READ_WINDOW = 64 * 1024;
const EMPTY = new Uint8Array(0);

/**
 * Canonical tag keys, in display order. Every value is a trimmed string ('\n' line
 * endings); multiple values of one field are joined with '; '. `track`/`disc` are 'n' or
 * 'n/total' as stored. `date` is the full date as stored (e.g. '2025', '2025-04-11');
 * `year` is its 4-digit year (derived; always set together with `date`).
 */
export const TAG_KEYS = Object.freeze([
  'title', 'artist', 'album', 'albumArtist', 'date', 'year', 'track', 'disc', 'genre',
  'composer', 'lyricist', 'conductor', 'remixer', 'publisher', 'copyright', 'isrc', 'bpm',
  'key', 'mood', 'language', 'grouping', 'subtitle', 'compilation', 'originalDate',
  'comment', 'lyrics', 'encoder', 'encodedBy',
]);

/** ID3v2 / FLAC picture type codes → English labels (index = code). */
export const PICTURE_TYPES = Object.freeze([
  'Other', '32x32 file icon', 'Other file icon', 'Front cover', 'Back cover', 'Leaflet page',
  'Media', 'Lead artist', 'Artist', 'Conductor', 'Band', 'Composer', 'Lyricist',
  'Recording location', 'During recording', 'During performance', 'Video screen capture',
  'A bright coloured fish', 'Illustration', 'Band logotype', 'Publisher logotype',
]);

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore',
  'Terror', 'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop', 'Abstract', 'Art Rock',
  'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro',
  'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band', 'Krautrock',
  'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk', 'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock',
  'Trop Rock', 'World Music', 'Neoclassical', 'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock', 'G-Funk', 'Dubstep',
  'Garage Rock', 'Psybient',
];

// ---------------------------------------------------------------------------------------
// byte helpers

const u16be = (b, p) => (b[p] << 8) | b[p + 1];
const u24be = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
const u32be = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u64be = (b, p) => u32be(b, p) * 4294967296 + u32be(b, p + 4);
const u16le = (b, p) => b[p] | (b[p + 1] << 8);
const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u64le = (b, p) => u32le(b, p) + u32le(b, p + 4) * 4294967296;
const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

function latin1(b, s = 0, e = b.length) {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)));
  return out;
}

const ascii = (b, p, n) => (p + n <= b.length ? latin1(b, p, p + n) : '');

/**
 * `s` with every lone UTF-16 surrogate replaced by U+FFFD (String#toWellFormed). Decoded
 * UTF-16 tag text can hold lone surrogates, on which encodeURI() throws.
 */
function wellFormed(s) {
  if (typeof s.toWellFormed === 'function') return s.toWellFormed();
  if (!/[\ud800-\udfff]/.test(s)) return s;
  let out = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
    }
    out += `${s.slice(from, i)}�`;
    from = i + 1;
  }
  return out + s.slice(from);
}

function utf16(b, s, e, le) {
  let out = '';
  const n = (e - s) >> 1;
  for (let i = 0; i < n; i += 8192) {
    const m = Math.min(8192, n - i);
    const codes = new Uint16Array(m);
    for (let k = 0, p = s + 2 * i; k < m; k++, p += 2) codes[k] = le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1];
    out += String.fromCharCode.apply(null, codes);
  }
  return wellFormed(out);
}

let utf8Decoder = null;
function utf8(b, s = 0, e = b.length) {
  if (e <= s) return '';
  if (!utf8Decoder) utf8Decoder = new TextDecoder('utf-8');
  return utf8Decoder.decode(b.subarray(s, e));
}

let strictUtf8 = null;
let cp1252 = null;
/** Legacy 8-bit text (RIFF INFO, AIFF, ID3v1-like fields): UTF-8 when valid, else Windows-1252. */
function legacyText(b, s = 0, e = b.length) {
  try {
    if (!strictUtf8) strictUtf8 = new TextDecoder('utf-8', { fatal: true });
    return strictUtf8.decode(b.subarray(s, e));
  } catch {
    try {
      if (!cp1252) cp1252 = new TextDecoder('windows-1252');
      return cp1252.decode(b.subarray(s, e));
    } catch {
      return latin1(b, s, e);
    }
  }
}

function cutAtNul(b, s, e) {
  for (let i = s; i < e; i++) if (b[i] === 0) return i;
  return e;
}

const isFourcc = (b, p) => {
  if (p + 4 > b.length) return false;
  for (let i = 0; i < 4; i++) if (b[p + i] < 0x20 || b[p + i] > 0x7e) return false;
  return true;
};

function deunsync(b) {
  let n = 0;
  for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0) n++;
  if (!n) return b;
  const out = new Uint8Array(b.length - n);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    out[o++] = b[i];
    if (b[i] === 0xff && i + 1 < b.length && b[i + 1] === 0) i++;
  }
  return out;
}

const B64 = new Int16Array(256).fill(-1);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
B64[0x2d] = 62; // '-' (base64url)
B64[0x5f] = 63; // '_'
/** Base64 (ASCII bytes or string) → bytes; whitespace and padding are ignored. */
function base64ToBytes(src, s = 0, e = src.length) {
  const str = typeof src === 'string';
  const out = new Uint8Array(Math.ceil(((e - s) * 3) / 4) + 3);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = s; i < e; i++) {
    const v = B64[(str ? src.charCodeAt(i) : src[i]) & 255];
    if (v < 0) continue;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

/** Normalize text values: cut at NUL, strip BOM, '\r\n'/'\r' → '\n', trim. */
export function cleanText(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  const z = s.indexOf('\0');
  if (z >= 0) s = s.slice(0, z);
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
}

// ---------------------------------------------------------------------------------------
// byte source: Uint8Array (zero copy) or Blob/File (sliced reads, 64 KiB window cache)

const isBlobLike = (x) => !!x && typeof x === 'object' && typeof x.size === 'number' && typeof x.slice === 'function' && typeof x.arrayBuffer === 'function';

class ByteSource {
  constructor(input) {
    if (isBlobLike(input) && !ArrayBuffer.isView(input)) {
      this.blob = input;
      this.size = input.size;
    } else if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer)) {
      this.u8 = new Uint8Array(input);
      this.size = this.u8.length;
    } else if (ArrayBuffer.isView(input)) {
      this.u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      this.size = this.u8.length;
    } else {
      throw new TypeError('readMetadata: expected a File, Blob, ArrayBuffer or typed array');
    }
    this.cache = null;
    this.cacheOff = 0;
  }

  /** Bytes [off, off + len) clipped to the file (may be shorter at EOF). Views may share memory. */
  async read(off, len) {
    off = Math.max(0, Math.floor(off));
    len = Math.floor(len);
    if (!(off < this.size) || !(len > 0)) return EMPTY;
    const end = Math.min(this.size, off + len);
    if (this.u8) return this.u8.subarray(off, end);
    const c = this.cache;
    if (c && off >= this.cacheOff && end <= this.cacheOff + c.length) return c.subarray(off - this.cacheOff, end - this.cacheOff);
    if (end - off >= READ_WINDOW) return new Uint8Array(await this.blob.slice(off, end).arrayBuffer());
    const wEnd = Math.min(this.size, off + READ_WINDOW);
    this.cache = new Uint8Array(await this.blob.slice(off, wEnd).arrayBuffer());
    this.cacheOff = off;
    return this.cache.subarray(0, end - off);
  }
}

async function readRegion(src, off, len, warnings, what) {
  if (len > MAX_REGION_BYTES) {
    warnings.push(`${what}: ${len} bytes, only the first ${MAX_REGION_BYTES} read`);
    len = MAX_REGION_BYTES;
  }
  const b = await src.read(off, len);
  if (b.length < len) warnings.push(`${what}: truncated (${b.length} of ${len} bytes)`);
  return b;
}

// ---------------------------------------------------------------------------------------
// pictures

function imageInfo(b) {
  if (!b || b.length < 8) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const ok = b.length >= 24 && ascii(b, 12, 4) === 'IHDR';
    return { mime: 'image/png', width: ok ? u32be(b, 16) : null, height: ok ? u32be(b, 20) : null };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let w = null;
    let h = null;
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (p + 9 <= b.length) { h = u16be(b, p + 5); w = u16be(b, p + 7); }
        break;
      }
      const len = u16be(b, p + 2);
      if (len < 2) break;
      p += 2 + len;
    }
    return { mime: 'image/jpeg', width: w, height: h };
  }
  const sig = ascii(b, 0, 6);
  if (sig === 'GIF87a' || sig === 'GIF89a') return { mime: 'image/gif', width: b.length >= 10 ? u16le(b, 6) : null, height: b.length >= 10 ? u16le(b, 8) : null };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    const dib = u32le(b, 14);
    if (dib === 12) return { mime: 'image/bmp', width: u16le(b, 18), height: u16le(b, 20) };
    if (dib >= 40) {
      const hh = u32le(b, 22) | 0;
      return { mime: 'image/bmp', width: u32le(b, 18) | 0, height: Math.abs(hh) };
    }
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' && b.length >= 30) {
    const fmt = ascii(b, 12, 4);
    if (fmt === 'VP8 ') return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (fmt === 'VP8L') {
      return { mime: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    }
    if (fmt === 'VP8X') return { mime: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return { mime: 'image/webp', width: null, height: null };
  }
  return null;
}

function normalizeMime(m) {
  const s = cleanText(m).toLowerCase();
  if (!s) return '';
  if (s === 'jpg' || s === 'jpeg' || s === 'image/jpg' || s === 'image/pjpeg') return 'image/jpeg';
  if (s === 'png' || s === 'image/x-png') return 'image/png';
  if (s === 'gif') return 'image/gif';
  if (s === 'bmp' || s === 'image/x-bmp' || s === 'image/x-ms-bmp') return 'image/bmp';
  if (!s.includes('/')) return `image/${s}`;
  return s;
}

/**
 * The mime a picture is exposed with: the sniffed image type, else the declared type when it
 * is one of IMAGE_MIMES, else 'application/octet-stream' — never 'text/html', SVG or any
 * other type a browser would run script in when a blob URL of the bytes is opened.
 */
function safeMime(info, declared) {
  if (info && info.mime) return info.mime;
  const d = normalizeMime(declared);
  return IMAGE_MIME_SET.has(d) ? d : 'application/octet-stream';
}

const pictureType = (t) => (Number.isInteger(t) && t >= 0 && t < PICTURE_TYPES.length ? t : 0);
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return null;
}

/**
 * Normalized picture record. Sniffed mime/dimensions win over declared ones (a PNG
 * declared as image/jpeg would otherwise not display); see safeMime() for bytes that are
 * no recognised image. `copy` detaches the bytes from the (possibly large) buffer they were
 * read from.
 */
function makePicture(bytes, mime, type, description, width, height, warnings, copy = true) {
  bytes = toBytes(bytes);
  if (!bytes || !bytes.length) return null;
  const info = imageInfo(bytes);
  if (!info && warnings) warnings.push(`picture (${normalizeMime(mime) || 'unknown type'}, ${bytes.length} bytes) is not a recognised image`);
  const t = pictureType(type);
  return {
    mime: safeMime(info, mime),
    type: t,
    typeLabel: PICTURE_TYPES[t],
    description: cleanText(description),
    width: positive(info && info.width) || positive(width),
    height: positive(info && info.height) || positive(height),
    size: bytes.length,
    bytes: copy ? bytes.slice() : bytes,
  };
}

/**
 * The picture to show as "the cover": the first front cover (type 3), else the first
 * picture of type 0 (other), else the first picture — counting only pictures whose `mime`
 * is one of IMAGE_MIMES; null when there is none.
 * @param {{ pictures?: Array<{ type: number, mime: string }> } | Array<{ type: number, mime: string }>} metaOrPictures
 */
export function pickCover(metaOrPictures) {
  const all = Array.isArray(metaOrPictures) ? metaOrPictures : (metaOrPictures && metaOrPictures.pictures) || [];
  const list = all.filter((p) => p && IMAGE_MIME_SET.has(p.mime));
  return list.find((p) => p.type === 3) || list.find((p) => p.type === 0) || list[0] || null;
}

// ---------------------------------------------------------------------------------------
// per-source collector (one per tag block; merged by priority at the end)

class Source {
  constructor(type) {
    this.type = type;
    this.tags = {};
    this.extra = [];
    this.pictures = [];
    // per tag key: the values already in tags[key] (whole and split at '; ') and their count,
    // so repeated values are skipped in O(1) instead of re-splitting the joined string
    this.seen = new Map();
    this.dropped = 0; // values / fields / pictures over MAX_TAG_ITEMS / MAX_PICTURES
  }

  tag(key, value) {
    const v = cleanText(value);
    if (!v) return;
    let e = this.seen.get(key);
    if (!e) this.seen.set(key, (e = { set: new Set(), n: 0 }));
    if (e.set.has(v)) return;
    if (e.n >= MAX_TAG_ITEMS) {
      this.dropped++;
      return;
    }
    e.n++;
    e.set.add(v);
    if (v.includes('; ')) for (const part of v.split('; ')) e.set.add(part);
    const prev = this.tags[key];
    this.tags[key] = prev === undefined ? v : `${prev}; ${v}`;
  }

  /** Overwrite tags[key] (e.g. 'n' → 'n/total'). */
  replace(key, value) {
    const v = cleanText(value);
    this.seen.delete(key);
    delete this.tags[key];
    if (v) this.tag(key, v);
  }

  ext(key, label, value) {
    const v = cleanText(value);
    if (!v) return;
    if (this.extra.length >= MAX_TAG_ITEMS) {
      this.dropped++;
      return;
    }
    this.extra.push({ key: String(key), label: cleanText(label) || String(key), value: v });
  }

  pic(p) {
    if (!p) return;
    if (this.pictures.length >= MAX_PICTURES) this.dropped++;
    else this.pictures.push(p);
  }
}

function normalizeTags(tags) {
  if (tags.date && !tags.year) {
    const m = /(?:^|\D)(\d{4})(?:\D|$)/.exec(tags.date);
    if (m) tags.year = m[1];
  }
  if (tags.year && !tags.date) tags.date = tags.year;
  const out = {};
  for (const k of TAG_KEYS) if (tags[k]) out[k] = tags[k];
  for (const k of Object.keys(tags)) if (!(k in out) && tags[k]) out[k] = tags[k];
  return out;
}

function merge(res, sources) {
  const tags = {};
  const seenExtra = new Set();
  let dropped = 0;
  for (const s of sources) {
    dropped += s.dropped;
    if (!Object.keys(s.tags).length && !s.extra.length && !s.pictures.length) continue;
    if (!res.tagTypes.includes(s.type)) res.tagTypes.push(s.type);
    for (const [k, v] of Object.entries(s.tags)) if (!(k in tags)) tags[k] = v;
    for (const e of s.extra) {
      const id = `${e.key}\0${e.value}`;
      if (seenExtra.has(id)) continue;
      if (res.extra.length >= MAX_TAG_ITEMS) {
        dropped++;
        continue;
      }
      seenExtra.add(id);
      res.extra.push(e);
    }
    if (!res.pictures.length && s.pictures.length) res.pictures.push(...s.pictures);
  }
  if (dropped) {
    res.warnings.push(`${dropped} tag values, fields or pictures dropped (limits: ${MAX_TAG_ITEMS} values per field, ${MAX_TAG_ITEMS} extra fields, ${MAX_PICTURES} pictures)`);
  }
  res.tags = normalizeTags(tags);
}

function capWarnings(w) {
  if (w.length <= MAX_WARNINGS) return w;
  return [...w.slice(0, MAX_WARNINGS - 1), `… and ${w.length - (MAX_WARNINGS - 1)} more warnings`];
}

// ---------------------------------------------------------------------------------------
// ID3v2

const ID3_TAGS = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist', TRCK: 'track', TPOS: 'disc',
  TCOM: 'composer', TEXT: 'lyricist', TPE3: 'conductor', TPE4: 'remixer', TPUB: 'publisher',
  TCOP: 'copyright', TSRC: 'isrc', TBPM: 'bpm', TKEY: 'key', TMOO: 'mood', TLAN: 'language',
  TIT1: 'grouping', GRP1: 'grouping', TIT3: 'subtitle', TCMP: 'compilation', TSSE: 'encoder',
  TENC: 'encodedBy', TDRC: 'date', TDOR: 'originalDate',
};

const ID3_LABELS = {
  TDLY: 'Playlist delay', TFLT: 'File type', TLEN: 'Length (ms)', TMED: 'Media type', TOAL: 'Original album',
  TOFN: 'Original filename', TOLY: 'Original lyricist', TOPE: 'Original artist', TOWN: 'File owner',
  TRDA: 'Recording dates', TRSN: 'Internet radio station', TRSO: 'Radio station owner', TSIZ: 'Size',
  TDEN: 'Encoding time', TDRL: 'Release time', TDTG: 'Tagging time', TIPL: 'Involved people',
  TMCL: 'Musician credits', TPRO: 'Produced notice', TSOA: 'Album sort order', TSOP: 'Artist sort order',
  TSOT: 'Title sort order', TSO2: 'Album artist sort order', TSOC: 'Composer sort order', TSST: 'Set subtitle',
  TCAT: 'Podcast category', TDES: 'Podcast description', TGID: 'Podcast ID', TKWD: 'Podcast keywords',
  MVNM: 'Movement name', MVIN: 'Movement', IPLS: 'Involved people', TDAT: 'Date (DDMM)', TIME: 'Time (HHMM)',
  TYER: 'Year', WCOM: 'Commercial information', WCOP: 'Copyright information', WOAF: 'Official audio file webpage',
  WOAR: 'Official artist webpage', WOAS: 'Official audio source webpage', WORS: 'Internet radio station homepage',
  WPAY: 'Payment', WPUB: 'Publisher webpage', WFED: 'Podcast feed', PCNT: 'Play counter', POPM: 'Rating',
};

const ID3V22_IDS = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4', TAL: 'TALB',
  TCO: 'TCON', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER', TDA: 'TDAT', TIM: 'TIME', TRD: 'TRDA', TCM: 'TCOM',
  TXT: 'TEXT', TPB: 'TPUB', TCR: 'TCOP', TSS: 'TSSE', TEN: 'TENC', TBP: 'TBPM', TRC: 'TSRC', TKE: 'TKEY',
  TLA: 'TLAN', TLE: 'TLEN', TMT: 'TMED', TOT: 'TOAL', TOA: 'TOPE', TOL: 'TOLY', TOR: 'TORY', TOF: 'TOFN',
  TFT: 'TFLT', TSI: 'TSIZ', TDY: 'TDLY', TCP: 'TCMP', TST: 'TSOT', TSP: 'TSOP', TSA: 'TSOA', TS2: 'TSO2',
  TSC: 'TSOC', TXX: 'TXXX', COM: 'COMM', ULT: 'USLT', PIC: 'PIC', WXX: 'WXXX', WAR: 'WOAR', WAS: 'WOAS',
  WAF: 'WOAF', WCM: 'WCOM', WCP: 'WCOP', WPB: 'WPUB', IPL: 'IPLS', UFI: 'UFID', CNT: 'PCNT', POP: 'POPM',
  GP1: 'GRP1', MVN: 'MVNM', MVI: 'MVIN',
};

const TEXT_LIKE = new Set(['GRP1', 'MVNM', 'MVIN', 'IPLS']);

function isFrameId(b, p, n) {
  if (p + n > b.length) return false;
  for (let i = 0; i < n; i++) {
    const c = b[p + i];
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
  }
  return true;
}

/** Decode [s, e) in ID3 text encoding `enc`; `st.le` carries UTF-16 endianness between strings. */
function id3Decode(d, s, e, enc, st = { le: true }) {
  if (e <= s) return '';
  if (enc === 1 || enc === 2) {
    if (e - s >= 2 && d[s] === 0xff && d[s + 1] === 0xfe) { st.le = true; s += 2; }
    else if (e - s >= 2 && d[s] === 0xfe && d[s + 1] === 0xff) { st.le = false; s += 2; }
    else if (enc === 2) st.le = false;
    return utf16(d, s, e, st.le);
  }
  if (enc === 3) return utf8(d, s, e);
  return latin1(d, s, e);
}

/** [end of the string starting at s, offset after its terminator]. */
function id3StringEnd(d, s, e, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = s; i + 1 < e; i += 2) if (d[i] === 0 && d[i + 1] === 0) return [i, i + 2];
    return [e, e];
  }
  for (let i = s; i < e; i++) if (d[i] === 0) return [i, i + 1];
  return [e, e];
}

function id3Terminated(d, s, e, enc, st) {
  const [end, next] = id3StringEnd(d, s, e, enc);
  return [id3Decode(d, s, end, enc, st), next];
}

function id3Strings(d, s, e, enc) {
  const st = { le: true };
  const out = [];
  while (s < e) {
    const [end, next] = id3StringEnd(d, s, e, enc);
    const v = cleanText(id3Decode(d, s, end, enc, st));
    if (v) out.push(v);
    s = next;
  }
  return out;
}

function genreName(s) {
  if (/^\d+$/.test(s)) return ID3V1_GENRES[+s] || s;
  if (s === 'RX') return 'Remix';
  if (s === 'CR') return 'Cover';
  return s;
}

/** TCON: '(13)', '(13)Refinement', '((literal', '13', 'RX', plain text. */
function parseGenres(values) {
  const out = [];
  for (const v of values) {
    let rest = v;
    const refs = [];
    let m;
    while ((m = /^\((\d+|RX|CR)\)/.exec(rest))) {
      refs.push(genreName(m[1]));
      rest = rest.slice(m[0].length);
    }
    if (rest.startsWith('((')) rest = rest.slice(1);
    rest = rest.trim();
    if (rest) out.push(refs.length ? rest : genreName(rest));
    else out.push(...refs);
  }
  return out;
}

/** Offset from which `b` holds only zero bytes up to its end (b.length when it ends non-zero). */
function zeroTailStart(b, from) {
  let z = b.length;
  while (z > from && b[z - 1] === 0) z--;
  return z;
}

/**
 * ID3v2.4 frame sizes are sync-safe, but old iTunes wrote plain 32-bit sizes. Decided once
 * per tag, like mutagen's _determine_bpi: a size mode is accepted when walking every frame
 * with it lands only on valid frame ids and ends exactly at the end of the frames or where
 * the all-zero padding starts (`zeroFrom`). Sync-safe (the spec) is tried first, then plain;
 * null when neither walk works (mixed or damaged tag: sizes are then guessed per frame).
 * Deciding per frame alone misreads a big APIC whose sync-safe-sized end happens to hit a
 * 0x00 inside the image: the frame is cut and every later frame is lost as "padding".
 */
function id3v24SizeMode(b, start, zeroFrom) {
  const walk = (plain) => {
    let p = start;
    for (;;) {
      if (p >= zeroFrom) return true; // end of the frames, or only zeros left (padding)
      if (p + 10 > b.length || !isFrameId(b, p, 4)) return false;
      if (!plain && (b[p + 4] | b[p + 5] | b[p + 6] | b[p + 7]) & 0x80) return false;
      p += 10 + (plain ? u32be(b, p + 4) : syncsafe(b, p + 4));
      if (p > b.length) return false;
    }
  };
  if (walk(false)) return 'syncsafe';
  if (walk(true)) return 'plain';
  return null;
}

/** Per-frame guess (id3v24SizeMode() found no consistent mode): sync-safe unless plain fits clearly better. */
function id3v24FrameSize(b, p, zeroFrom) {
  const raw = u32be(b, p + 4);
  if ((b[p + 4] | b[p + 5] | b[p + 6] | b[p + 7]) & 0x80) return raw;
  const ss = syncsafe(b, p + 4);
  if (ss === raw) return ss;
  // a frame ends at the next frame id, the end of the frames, or where real padding (all
  // zeros to the end) begins — a single 0x00 inside picture data does not count
  const fits = (q) => q <= b.length && (q >= zeroFrom || isFrameId(b, q, 4));
  if (fits(p + 10 + ss)) return ss;
  if (fits(p + 10 + raw)) return raw;
  return ss;
}

const yearOf = (s) => {
  const m = /(?:^|\D)(\d{4})(?:\D|$)/.exec(s);
  return m ? m[1] : '';
};

/** Parse one ID3v2 tag (bytes start with 'ID3'). Never throws. */
function parseId3v2(tag, warnings) {
  const major = tag[3];
  const src = new Source(`ID3v2.${major}`);
  try {
    parseId3v2Into(src, tag, major, warnings);
  } catch (e) {
    warnings.push(`ID3v2.${major}: ${e && e.message}`);
  }
  return src;
}

function parseId3v2Into(src, tag, major, warnings) {
  const flags = tag[5];
  const declared = syncsafe(tag, 6);
  let body = tag.subarray(10, Math.min(tag.length, 10 + declared));
  if (major < 2 || major > 4) {
    warnings.push(`ID3v2.${major} tag: unsupported version, skipped`);
    return;
  }
  if (major === 2 && flags & 0x40) {
    warnings.push('ID3v2.2 tag is compressed: skipped');
    return;
  }
  const tagUnsync = !!(flags & 0x80);
  if (tagUnsync && major < 4) body = deunsync(body);
  let p = 0;
  if (major > 2 && flags & 0x40 && body.length >= 4) {
    // v2.3: size excludes its own 4 bytes; v2.4: sync-safe and includes them. Some writers
    // get this wrong, so take whichever candidate lands on a frame.
    const a = major === 3 ? 4 + u32be(body, 0) : syncsafe(body, 0);
    const b = major === 3 ? u32be(body, 0) : 4 + syncsafe(body, 0);
    p = isFrameId(body, a, 4) || !isFrameId(body, b, 4) ? a : b;
    if (p > body.length) {
      warnings.push(`ID3v2.${major}: bad extended header`);
      return;
    }
  }
  const idLen = major === 2 ? 3 : 4;
  const hdr = major === 2 ? 6 : 10;
  const ctx = { comment: false, lyrics: false, year: '', dat: '', time: '', oyear: '', weak: [] };
  const zeroFrom = major === 4 ? zeroTailStart(body, p) : 0;
  const sizeMode = major === 4 ? id3v24SizeMode(body, p, zeroFrom) : null;
  let guessed = false;
  while (p + hdr <= body.length) {
    if (body[p] === 0) break; // padding
    if (!isFrameId(body, p, idLen)) {
      warnings.push(`ID3v2.${major}: invalid frame header at tag byte ${p + 10}; rest of the tag skipped`);
      break;
    }
    let id = ascii(body, p, idLen);
    let size;
    if (major === 2) size = u24be(body, p + 3);
    else if (major === 3 || sizeMode === 'plain') size = u32be(body, p + 4);
    else if (sizeMode === 'syncsafe') size = syncsafe(body, p + 4);
    else {
      size = id3v24FrameSize(body, p, zeroFrom);
      if (!guessed && size !== syncsafe(body, p + 4)) {
        guessed = true;
        warnings.push('ID3v2.4: frame sizes are neither all sync-safe nor all plain; guessed per frame');
      }
    }
    const fmt = major === 2 ? 0 : body[p + 9];
    const start = p + hdr;
    if (start + size > body.length) {
      warnings.push(`ID3v2.${major}: frame ${id} truncated`);
      break;
    }
    p = start + size;
    let d = body.subarray(start, start + size);
    if (major === 2) id = ID3V22_IDS[id] || id;
    if (major === 3) {
      if (fmt & 0x80) { warnings.push(`ID3v2.3: compressed frame ${id} skipped`); continue; }
      if (fmt & 0x40) { warnings.push(`ID3v2.3: encrypted frame ${id} skipped`); continue; }
      if (fmt & 0x20) d = d.subarray(1); // grouping identity
    } else if (major === 4) {
      if (fmt & 0x08) { warnings.push(`ID3v2.4: compressed frame ${id} skipped`); continue; }
      if (fmt & 0x04) { warnings.push(`ID3v2.4: encrypted frame ${id} skipped`); continue; }
      let off = 0;
      if (fmt & 0x40) off += 1; // grouping identity
      if (fmt & 0x01) off += 4; // data length indicator
      d = d.subarray(Math.min(off, d.length));
      if (fmt & 0x02 || tagUnsync) d = deunsync(d);
    }
    if (!d.length) continue;
    id3Frame(src, id, d, ctx, warnings);
  }
  // v2.3 dates: TYER (+ TDAT/TIME) and TORY. A TXXX 'DATE'/'ORIGINALDATE' (what FFmpeg and
  // buildId3v2 write when the frames cannot hold the whole date) refines them when its year
  // agrees; a TDRC/TDOR frame wins over all of these.
  const year = /^\d{4}$/.test(ctx.year) ? ctx.year : '';
  const oyear = /^\d{4}$/.test(ctx.oyear) ? ctx.oyear : '';
  for (const [key, name, value] of ctx.weak) {
    const v = cleanText(value);
    let ok = !src.tags[key] || src.tags[key] === v;
    if (ok && key === 'date' && year && yearOf(v) !== year) ok = false;
    if (ok && key === 'originalDate' && oyear && yearOf(v) !== oyear) ok = false;
    if (ok) src.tag(key, value);
    else src.ext(`TXXX:${name}`, name, value);
  }
  if (!src.tags.date && year) {
    let date = year;
    if (/^\d{4}$/.test(ctx.dat)) {
      date += `-${ctx.dat.slice(2, 4)}-${ctx.dat.slice(0, 2)}`;
      if (/^\d{4}$/.test(ctx.time)) date += `T${ctx.time.slice(0, 2)}:${ctx.time.slice(2, 4)}`;
    }
    src.tag('date', date);
  } else if (ctx.year && !src.tags.date) src.tag('date', ctx.year);
  if (!src.tags.originalDate && ctx.oyear) src.tag('originalDate', ctx.oyear);
}

// TXXX descriptions some writers (FFmpeg, foobar2000) use for fields that have no ID3
// frame of their own: they fill the tag only when the proper frame is absent.
const TXXX_TAGS = {
  LYRICS: 'lyrics', UNSYNCEDLYRICS: 'lyrics', 'UNSYNCED LYRICS': 'lyrics', ALBUMARTIST: 'albumArtist',
  'ALBUM ARTIST': 'albumArtist', ALBUM_ARTIST: 'albumArtist', LABEL: 'publisher', PUBLISHER: 'publisher',
  ISRC: 'isrc', MOOD: 'mood', LANGUAGE: 'language', CONDUCTOR: 'conductor', LYRICIST: 'lyricist',
  REMIXER: 'remixer', SUBTITLE: 'subtitle', ORIGINALDATE: 'originalDate', COMPILATION: 'compilation',
  COMMENT: 'comment', DESCRIPTION: 'comment', DATE: 'date', ORIGINALYEAR: 'originalDate',
};

function id3Frame(src, id, d, ctx, warnings) {
  const enc = d[0];
  if (id === 'TXXX') {
    const [desc, p] = id3Terminated(d, 1, d.length, enc);
    const values = id3Strings(d, p, d.length, enc);
    const name = cleanText(desc);
    const upper = name.toUpperCase();
    // FFmpeg writes `-metadata lyrics=…` as TXXX 'USLT' (it has no USLT writer)
    const weak = TXXX_TAGS[upper] || (upper === 'USLT' || /^LYRICS-[A-Z]{3}$/.test(upper) ? 'lyrics' : null);
    if (weak && values.length) ctx.weak.push([weak, name, values.join('; ')]);
    else src.ext(name ? `TXXX:${name}` : 'TXXX', name || 'User text', values.join('; '));
    return;
  }
  if ((id[0] === 'T' && id.length === 4) || TEXT_LIKE.has(id)) {
    let values = id3Strings(d, 1, d.length, enc);
    if (!values.length) return;
    if (id === 'TCON') { src.tag('genre', parseGenres(values).join('; ')); return; }
    if (id === 'TYER') { ctx.year = values[0]; return; }
    if (id === 'TDAT') { ctx.dat = values[0]; return; }
    if (id === 'TIME') { ctx.time = values[0]; return; }
    if (id === 'TORY') { ctx.oyear = values[0]; return; }
    if (id === 'TIPL' || id === 'TMCL' || id === 'IPLS') {
      const pairs = [];
      for (let i = 0; i + 1 < values.length; i += 2) pairs.push(`${values[i]}: ${values[i + 1]}`);
      if (values.length & 1) pairs.push(values[values.length - 1]);
      values = pairs;
    }
    const key = ID3_TAGS[id];
    if (key) for (const v of values) src.tag(key, v);
    else src.ext(id, ID3_LABELS[id] || id, values.join('; '));
    return;
  }
  if (id === 'COMM' || id === 'USLT') {
    if (d.length < 4) return;
    const [desc, p] = id3Terminated(d, 4, d.length, enc);
    const text = id3Decode(d, p, d.length, enc);
    const name = cleanText(desc);
    const main = id === 'COMM' ? 'comment' : 'lyrics';
    if (!name && !ctx[main] && cleanText(text)) {
      ctx[main] = true;
      src.tag(main, text);
    } else {
      src.ext(name ? `${id}:${name}` : id, name || (id === 'COMM' ? 'Comment' : 'Lyrics'), text);
    }
    return;
  }
  if (id === 'APIC' || id === 'PIC') {
    let mime;
    let p;
    if (id === 'PIC') {
      mime = ascii(d, 1, 3);
      p = 4;
    } else {
      const e = cutAtNul(d, 1, d.length);
      mime = latin1(d, 1, e);
      p = e + 1;
    }
    if (p >= d.length) return;
    const type = d[p];
    const [desc, q] = id3Terminated(d, p + 1, d.length, enc);
    if (mime === '-->') {
      warnings.push('ID3v2: linked picture (URL) skipped');
      return;
    }
    src.pic(makePicture(d.subarray(q), mime, type, desc, null, null, warnings));
    return;
  }
  if (id === 'WXXX') {
    const [desc, p] = id3Terminated(d, 1, d.length, enc);
    const name = cleanText(desc);
    src.ext(name ? `WXXX:${name}` : 'WXXX', name || 'URL', latin1(d, p, cutAtNul(d, p, d.length)));
    return;
  }
  if (id[0] === 'W' && id.length === 4) {
    src.ext(id, ID3_LABELS[id] || id, latin1(d, 0, cutAtNul(d, 0, d.length)));
    return;
  }
  if (id === 'UFID') {
    const e = cutAtNul(d, 0, d.length);
    const owner = latin1(d, 0, e);
    const ident = d.subarray(e + 1);
    if (ident.length && ident.every((c) => c >= 0x20 && c < 0x7f)) src.ext(`UFID:${owner}`, `Unique file ID (${owner})`, latin1(ident));
    return;
  }
  if (id === 'POPM') {
    const e = cutAtNul(d, 0, d.length);
    const email = latin1(d, 0, e);
    if (e + 1 < d.length) src.ext(email ? `POPM:${email}` : 'POPM', email ? `Rating (${email})` : 'Rating', String(d[e + 1]));
    return;
  }
  if (id === 'PCNT') {
    let n = 0;
    for (let i = 0; i < d.length && i < 8; i++) n = n * 256 + d[i];
    src.ext('PCNT', 'Play counter', String(n));
  }
  // other frames (PRIV, GEOB, MCDI, SYLT, RVA2, CHAP, …) carry no displayable text
}

// ---------------------------------------------------------------------------------------
// ID3v1 / APEv2 / leading & trailing tags of MPEG-like streams

function parseId3v1(t) {
  if (t.length < 128 || ascii(t, 0, 3) !== 'TAG') return null;
  // nominally ISO-8859-1, but FFmpeg and many taggers write UTF-8 or the local code page
  const field = (s, e) => legacyText(t, s, cutAtNul(t, s, e));
  const v11 = t[125] === 0 && t[126] !== 0;
  const src = new Source(v11 ? 'ID3v1.1' : 'ID3v1');
  src.tag('title', field(3, 33));
  src.tag('artist', field(33, 63));
  src.tag('album', field(63, 93));
  src.tag('date', field(93, 97));
  src.tag('comment', field(97, v11 ? 125 : 127));
  if (v11) src.tag('track', String(t[126]));
  if (t[127] < ID3V1_GENRES.length) src.tag('genre', ID3V1_GENRES[t[127]]);
  return src;
}

const APE_TAGS = {
  title: 'title', artist: 'artist', album: 'album', 'album artist': 'albumArtist', albumartist: 'albumArtist',
  year: 'date', date: 'date', genre: 'genre', track: 'track', disc: 'disc', composer: 'composer', comment: 'comment',
  lyrics: 'lyrics', copyright: 'copyright', publisher: 'publisher', label: 'publisher', isrc: 'isrc', bpm: 'bpm',
  language: 'language', conductor: 'conductor', subtitle: 'subtitle', lyricist: 'lyricist', mood: 'mood',
  grouping: 'grouping', compilation: 'compilation', encodedby: 'encodedBy', 'encoded by': 'encodedBy',
};

/**
 * APEv2 tag whose 32-byte footer is at `footerOff` → { source, begin } (begin = first byte of
 * the tag, its optional 32-byte header included), or null. The tag must not start before
 * `minStart`.
 */
async function parseApe(src, footerOff, warnings, minStart = 0) {
  const f = await src.read(footerOff, 32);
  if (f.length < 32 || ascii(f, 0, 8) !== 'APETAGEX') return null;
  const tagSize = u32le(f, 12);
  const count = u32le(f, 16);
  const hasHeader = (u32le(f, 20) & 0x80000000) !== 0;
  const start = footerOff + 32 - tagSize;
  if (tagSize < 32 || start < minStart) {
    warnings.push('APEv2: bad tag size');
    return null;
  }
  const begin = hasHeader && start - 32 >= minStart && ascii(await src.read(start - 32, 8), 0, 8) === 'APETAGEX' ? start - 32 : start;
  const s = new Source('APEv2');
  const b = await readRegion(src, start, tagSize - 32, warnings, 'APEv2 tag');
  let p = 0;
  for (let i = 0; i < count && p + 9 <= b.length; i++) {
    const len = u32le(b, p);
    const flags = u32le(b, p + 4);
    const ke = cutAtNul(b, p + 8, b.length);
    const key = latin1(b, p + 8, ke);
    const vs = ke + 1;
    if (vs + len > b.length) {
      warnings.push('APEv2: item truncated');
      break;
    }
    const kind = (flags >> 1) & 3;
    if (kind === 1) {
      if (/^cover art/i.test(key)) {
        const fe = cutAtNul(b, vs, vs + len);
        const type = /front/i.test(key) ? 3 : /back/i.test(key) ? 4 : 0;
        s.pic(makePicture(b.subarray(Math.min(fe + 1, vs + len), vs + len), '', type, '', null, null, warnings));
      }
    } else {
      const value = utf8(b, vs, vs + len).split('\0').map(cleanText).filter(Boolean).join('; ');
      const mapped = APE_TAGS[key.toLowerCase()];
      if (mapped) s.tag(mapped, value);
      else s.ext(`APE:${key}`, key, value);
    }
    p = vs + len;
  }
  return { source: s, begin };
}

const isMpegSync = (b, p) => p + 1 < b.length && b[p] === 0xff && (b[p + 1] & 0xe0) === 0xe0;
const isAdts = (b, p) => p + 1 < b.length && b[p] === 0xff && (b[p + 1] & 0xf6) === 0xf0;

async function parseMpegLike(src, res, sources) {
  const w = res.warnings;
  let p = 0;
  for (let n = 0; n < 4; n++) {
    const h = await src.read(p, 10);
    if (!(h.length === 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33 && h[3] < 0xff && h[4] < 0xff && ((h[6] | h[7] | h[8] | h[9]) & 0x80) === 0)) break;
    const size = 10 + syncsafe(h, 6) + (h[3] === 4 && h[5] & 0x10 ? 10 : 0);
    const tag = await readRegion(src, p, size, w, 'ID3v2 tag');
    sources.push(parseId3v2(tag, w));
    p += size;
    const z = await src.read(p, 4096);
    let k = 0;
    while (k < z.length && z[k] === 0) k++;
    p += k;
  }
  const nx = await src.read(p, 4);
  if (ascii(nx, 0, 4) === 'fLaC') {
    res.format = 'flac';
    const flac = new Source('FLAC Vorbis comment');
    sources.unshift(flac);
    await parseFlac(src, p, flac, w);
    return;
  }
  if (isAdts(nx, 0)) res.format = 'aac';
  else if (isMpegSync(nx, 0) || sources.length) res.format = 'mp3';
  // trailing tags, peeled off the end until none matches: an ID3v1 tag is always last; before
  // it any chain of APEv2 tags and appended ID3v2.4 tags (with footer), e.g.
  // [audio][ID3v2.4 + footer][APEv2][ID3v1] or [audio][APEv2][ID3v2.4 + footer].
  let end = src.size;
  let v1 = null;
  const appended = [];
  const apes = [];
  if (end - 128 >= p) {
    v1 = parseId3v1(await src.read(end - 128, 128));
    if (v1) end -= 128;
  }
  for (let n = 0; n < 16; n++) {
    if (end - 32 >= p) {
      const ape = await parseApe(src, end - 32, w, p);
      if (ape) {
        apes.push(ape.source);
        end = ape.begin;
        continue;
      }
    }
    if (end - 10 >= p) {
      const f = await src.read(end - 10, 10);
      if (ascii(f, 0, 3) === '3DI' && f[3] === 4) {
        const size = syncsafe(f, 6) + 20;
        if (end - size >= p) {
          const tag = await readRegion(src, end - size, size, w, 'appended ID3v2 tag');
          if (ascii(tag, 0, 3) === 'ID3') {
            appended.push(parseId3v2(tag, w));
            end -= size;
            continue;
          }
        }
      }
    }
    break;
  }
  // priority: leading ID3v2 > appended ID3v2 > APEv2 > ID3v1
  sources.push(...appended, ...apes);
  if (v1) sources.push(v1);
  if (res.format === 'other' && sources.length) res.format = 'mp3';
}

// ---------------------------------------------------------------------------------------
// FLAC / Vorbis comment / Ogg

const VORBIS_TAGS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist',
  ALBUM_ARTIST: 'albumArtist', DATE: 'date', YEAR: 'year', GENRE: 'genre', TRACKNUMBER: 'track', TRACK: 'track',
  DISCNUMBER: 'disc', DISC: 'disc', COMPOSER: 'composer', LYRICIST: 'lyricist', CONDUCTOR: 'conductor',
  REMIXER: 'remixer', COMMENT: 'comment', LYRICS: 'lyrics', UNSYNCEDLYRICS: 'lyrics', 'UNSYNCED LYRICS': 'lyrics',
  ENCODER: 'encoder', ENCODEDBY: 'encodedBy', 'ENCODED-BY': 'encodedBy', ENCODED_BY: 'encodedBy',
  COPYRIGHT: 'copyright', PUBLISHER: 'publisher', LABEL: 'publisher', ORGANIZATION: 'publisher', BPM: 'bpm',
  ISRC: 'isrc', GROUPING: 'grouping', SUBTITLE: 'subtitle', LANGUAGE: 'language', MOOD: 'mood',
  INITIALKEY: 'key', KEY: 'key', COMPILATION: 'compilation', ORIGINALDATE: 'originalDate', ORIGINALYEAR: 'originalDate',
};

function parseFlacPicture(b, warnings, off = 0) {
  try {
    let p = off;
    if (p + 32 > b.length) throw new Error('short');
    const type = u32be(b, p);
    const ml = u32be(b, p + 4);
    p += 8;
    if (p + ml + 4 > b.length) throw new Error('mime');
    const mime = latin1(b, p, p + ml);
    p += ml;
    const dl = u32be(b, p);
    p += 4;
    if (p + dl + 20 > b.length) throw new Error('description');
    const desc = utf8(b, p, p + dl);
    p += dl;
    const w = u32be(b, p);
    const h = u32be(b, p + 4);
    const len = u32be(b, p + 16);
    p += 20;
    if (p + len > b.length) throw new Error('data truncated');
    if (mime === '-->') {
      warnings.push('FLAC picture: linked picture (URL) skipped');
      return null;
    }
    return makePicture(b.subarray(p, p + len), mime, type, desc, w, h, warnings);
  } catch (e) {
    warnings.push(`invalid FLAC picture block (${e.message})`);
    return null;
  }
}

function parseVorbisComment(b, off, s, warnings) {
  if (off + 8 > b.length) {
    warnings.push('Vorbis comment: truncated header');
    return;
  }
  const vlen = u32le(b, off);
  let p = off + 4;
  if (p + vlen + 4 > b.length) {
    warnings.push('Vorbis comment: truncated vendor string');
    return;
  }
  s.ext('vendor', 'Vendor', utf8(b, p, p + vlen));
  p += vlen;
  const count = u32le(b, p);
  p += 4;
  const pending = { trackTotal: '', discTotal: '', desc: [], coverArt: [], coverMime: '' };
  for (let i = 0; i < count; i++) {
    if (p + 4 > b.length) {
      warnings.push('Vorbis comment: truncated');
      break;
    }
    const len = u32le(b, p);
    p += 4;
    if (p + len > b.length) {
      warnings.push('Vorbis comment: truncated');
      break;
    }
    let eq = -1;
    for (let k = p; k < p + len; k++) if (b[k] === 0x3d) { eq = k; break; }
    if (eq > p) {
      const key = latin1(b, p, eq).toUpperCase();
      if (key === 'METADATA_BLOCK_PICTURE') s.pic(parseFlacPicture(base64ToBytes(b, eq + 1, p + len), warnings));
      else if (key === 'COVERART') pending.coverArt.push(base64ToBytes(b, eq + 1, p + len));
      else {
        const value = utf8(b, eq + 1, p + len);
        if (key === 'TRACKTOTAL' || key === 'TOTALTRACKS') pending.trackTotal = cleanText(value);
        else if (key === 'DISCTOTAL' || key === 'TOTALDISCS') pending.discTotal = cleanText(value);
        else if (key === 'DESCRIPTION') pending.desc.push(value);
        else if (key === 'COVERARTMIME') pending.coverMime = cleanText(value);
        else if (VORBIS_TAGS[key]) s.tag(VORBIS_TAGS[key], value);
        else s.ext(key, key, value);
      }
    }
    p += len;
  }
  for (const [k, total, name] of [['track', pending.trackTotal, 'TRACKTOTAL'], ['disc', pending.discTotal, 'DISCTOTAL']]) {
    if (!total) continue;
    if (s.tags[k] && !s.tags[k].includes('/')) s.replace(k, `${s.tags[k]}/${total}`);
    else if (!s.tags[k]) s.ext(name, name, total);
  }
  for (const d of pending.desc) {
    if (!s.tags.comment) s.tag('comment', d);
    else s.ext('DESCRIPTION', 'DESCRIPTION', d);
  }
  for (const img of pending.coverArt) s.pic(makePicture(img, pending.coverMime, 3, '', null, null, warnings));
}

async function parseFlac(src, start, s, warnings) {
  let p = start + 4;
  for (let n = 0; n < 1024 && p + 4 <= src.size; n++) {
    const h = await src.read(p, 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = u24be(h, 1);
    if (type === 127) {
      warnings.push('FLAC: invalid metadata block');
      break;
    }
    if (type === 4 || type === 6) {
      const b = await readRegion(src, p + 4, len, warnings, type === 4 ? 'FLAC Vorbis comment' : 'FLAC picture');
      if (type === 4) parseVorbisComment(b, 0, s, warnings);
      else if (b.length === len) s.pic(parseFlacPicture(b, warnings));
    }
    p += 4 + len;
    if (last) return;
  }
  if (p + 4 > src.size) warnings.push('FLAC: metadata truncated');
}

function oggCodec(pk) {
  if (pk.length >= 7 && pk[0] === 1 && ascii(pk, 1, 6) === 'vorbis') return 'vorbis';
  if (ascii(pk, 0, 8) === 'OpusHead') return 'opus';
  if (pk.length >= 13 && pk[0] === 0x7f && ascii(pk, 1, 4) === 'FLAC') return 'flac';
  if (ascii(pk, 0, 8) === 'Speex   ') return 'speex';
  return null;
}

async function parseOgg(src, res, sources) {
  const w = res.warnings;
  let p = 0;
  let serial = -1;
  let need = 2;
  let codec = null;
  let s = null;
  let parts = [];
  let partLen = 0;
  let overflow = false;
  let pk = 0;
  // Logical streams whose first packet is no audio codec read here (Ogg Skeleton 'fishead',
  // Theora, …): their BOS pages come first, so the next BOS page's stream is tried instead.
  const skipped = new Set();
  const NO_AUDIO = 'Ogg: no Vorbis, Opus, FLAC or Speex stream found';
  /** true = more header packets wanted, false = done, null = not an audio stream */
  const handle = (packet) => {
    if (pk === 0) {
      codec = oggCodec(packet);
      if (!codec) return null;
      s = new Source(`Vorbis comment (Ogg ${codec === 'flac' ? 'FLAC' : codec[0].toUpperCase() + codec.slice(1)})`);
      sources.push(s);
      if (codec === 'flac') {
        const nh = u16be(packet, 7);
        need = nh ? 1 + nh : Infinity;
      }
    } else if (codec === 'vorbis') {
      if (packet[0] === 3 && ascii(packet, 1, 6) === 'vorbis') parseVorbisComment(packet, 7, s, w);
      return false;
    } else if (codec === 'opus') {
      if (ascii(packet, 0, 8) === 'OpusTags') parseVorbisComment(packet, 8, s, w);
      return false;
    } else if (codec === 'speex') {
      parseVorbisComment(packet, 0, s, w);
      return false;
    } else if (codec === 'flac') {
      const type = packet[0] & 0x7f;
      if (type === 4) parseVorbisComment(packet, 4, s, w);
      else if (type === 6) s.pic(parseFlacPicture(packet, w, 4));
      if (packet[0] & 0x80) return false;
    }
    pk++;
    return pk < need;
  };
  for (let pages = 0; pages < 1 << 20 && p + 27 <= src.size; pages++) {
    const h = await src.read(p, 27);
    if (ascii(h, 0, 4) !== 'OggS') {
      w.push(`Ogg: lost page sync at byte ${p}`);
      return;
    }
    const nseg = h[26];
    const lacing = (await src.read(p + 27, nseg)).slice();
    if (lacing.length < nseg) break;
    let bodyLen = 0;
    for (let i = 0; i < nseg; i++) bodyLen += lacing[i];
    const bodyStart = p + 27 + nseg;
    const pageSerial = u32le(h, 14);
    if (serial < 0) {
      const bos = (h[5] & 2) !== 0;
      if (skipped.size && !bos) {
        w.push(NO_AUDIO); // past the BOS pages: no stream left to try
        return;
      }
      if (!skipped.has(pageSerial)) serial = pageSerial;
    }
    if (pageSerial === serial) {
      const body = await src.read(bodyStart, bodyLen);
      if (body.length < bodyLen) break;
      let q = 0;
      for (let i = 0; i < nseg; i++) {
        const l = lacing[i];
        if (!overflow && partLen + l > MAX_REGION_BYTES) {
          overflow = true;
          w.push('Ogg: header packet too large, skipped');
        }
        if (!overflow) {
          parts.push(body.slice(q, q + l));
          partLen += l;
        }
        q += l;
        if (l < 255) {
          let packet = EMPTY;
          if (!overflow) {
            packet = new Uint8Array(partLen);
            let o = 0;
            for (const part of parts) {
              packet.set(part, o);
              o += part.length;
            }
          }
          parts = [];
          partLen = 0;
          overflow = false;
          const more = handle(packet);
          if (more === null) {
            skipped.add(serial);
            if (skipped.size > 64) {
              w.push(NO_AUDIO);
              return;
            }
            serial = -1;
            pk = 0;
            need = 2;
            codec = null;
            break; // the rest of this page belongs to the skipped stream
          }
          if (!more) return;
        }
      }
    }
    p = bodyStart + bodyLen;
  }
  w.push(!s && skipped.size ? NO_AUDIO : 'Ogg: header packets truncated');
}

// ---------------------------------------------------------------------------------------
// MP4 / M4A

const MP4_TAGS = {
  '©nam': 'title', '©ART': 'artist', aART: 'albumArtist', '©alb': 'album', '©day': 'date', '©gen': 'genre',
  '©wrt': 'composer', '©cmt': 'comment', '©lyr': 'lyrics', '©too': 'encoder', '©enc': 'encodedBy',
  cprt: 'copyright', '©cpy': 'copyright', '©grp': 'grouping', tmpo: 'bpm', cpil: 'compilation', '©st3': 'subtitle',
  '©con': 'conductor', '©pub': 'publisher', '©lab': 'publisher', '©swr': 'encoder', '©mak': 'publisher',
};

const MP4_LABELS = {
  desc: 'Description', ldes: 'Long description', sonm: 'Title sort order', soar: 'Artist sort order',
  soaa: 'Album artist sort order', soal: 'Album sort order', soco: 'Composer sort order', sosn: 'Show sort order',
  tvsh: 'TV show', rtng: 'Content rating', stik: 'Media kind', pgap: 'Gapless playback', purd: 'Purchase date',
  apID: 'Account', ownr: 'Owner', 'xid ': 'Content ID', '©mvn': 'Movement name', '©mvi': 'Movement number',
  '©mvc': 'Movement count', shwm: 'Show movement', '©wrk': 'Work', keyw: 'Keywords', catg: 'Category',
  hdvd: 'HD video', akID: 'Store account type', cnID: 'Store content ID', atID: 'Store artist ID',
  plID: 'Store playlist ID', geID: 'Store genre ID', sfID: 'Store country', cmID: 'Store composer ID',
  '©dir': 'Director', '©prd': 'Producer', '©src': 'Source credits', '©inf': 'Information', '©req': 'Requirements',
  '©fmt': 'Format', '©prf': 'Performers', '©xyz': 'Location', '©url': 'URL', '©hst': 'Host computer',
};

const MP4_FREEFORM = {
  ISRC: 'isrc', LABEL: 'publisher', PUBLISHER: 'publisher', LYRICIST: 'lyricist', CONDUCTOR: 'conductor',
  MOOD: 'mood', LANGUAGE: 'language', SUBTITLE: 'subtitle', INITIALKEY: 'key', KEY: 'key', REMIXER: 'remixer',
  MIXARTIST: 'remixer', ORIGINALDATE: 'originalDate', BPM: 'bpm', ENCODEDBY: 'encodedBy', ENCODER: 'encoder',
};

const QT_KEYS = {
  title: 'title', artist: 'artist', album: 'album', albumartist: 'albumArtist', comment: 'comment', genre: 'genre',
  composer: 'composer', copyright: 'copyright', creationdate: 'date', year: 'year', software: 'encoder',
  publisher: 'publisher', author: 'artist', lyrics: 'lyrics', 'track-number': 'track',
};

function mp4Int(pl, signed) {
  const n = pl.length;
  if (n === 1) return signed ? (pl[0] << 24) >> 24 : pl[0];
  if (n === 2) return signed ? (u16be(pl, 0) << 16) >> 16 : u16be(pl, 0);
  if (n === 3) return u24be(pl, 0);
  if (n === 4) return signed ? u32be(pl, 0) | 0 : u32be(pl, 0);
  if (n === 8) return u64be(pl, 0);
  return null;
}

const printable = (pl) => pl.length > 0 && pl.every((c) => c >= 0x20 || c === 0x0a || c === 0x0d || c === 0x09);

function mp4Value(type, pl) {
  switch (type) {
    case 1: case 4: return utf8(pl);
    case 2: case 5: return utf16(pl, 0, pl.length, false);
    case 21: case 22: case 65: case 66: case 67: case 75: case 76: case 77: case 78: {
      const v = mp4Int(pl, type === 21 || (type >= 65 && type <= 67));
      return v === null ? '' : String(v);
    }
    case 23: return pl.length === 4 ? String(new DataView(pl.buffer, pl.byteOffset, 4).getFloat32(0)) : '';
    case 24: return pl.length === 8 ? String(new DataView(pl.buffer, pl.byteOffset, 8).getFloat64(0)) : '';
    case 0: {
      if (printable(pl) && pl.length > 2) return utf8(pl);
      const v = mp4Int(pl, false);
      return v === null ? '' : String(v);
    }
    default: return printable(pl) ? utf8(pl) : '';
  }
}

function parseIlst(b, s, ctx, warnings) {
  let p = 0;
  while (p + 8 <= b.length) {
    const size = u32be(b, p);
    if (size < 8 || p + size > b.length) {
      warnings.push('MP4: ilst item truncated');
      break;
    }
    const end = p + size;
    let name = latin1(b, p + 4, p + 8);
    let keyName = null;
    if (ctx.keys) {
      const idx = u32be(b, p + 4);
      if (idx >= 1 && idx <= ctx.keys.length) keyName = ctx.keys[idx - 1];
    }
    let mean = '';
    let nm = '';
    const datas = [];
    for (let q = p + 8; q + 8 <= end;) {
      const cs = u32be(b, q);
      if (cs < 8 || q + cs > end) break;
      const ct = latin1(b, q + 4, q + 8);
      if (ct === 'mean' && cs >= 12) mean = utf8(b, q + 12, q + cs);
      else if (ct === 'name' && cs >= 12) nm = utf8(b, q + 12, q + cs);
      else if (ct === 'data' && cs >= 16) datas.push({ type: u24be(b, q + 9), pl: b.subarray(q + 16, q + cs) });
      q += cs;
    }
    p = end;
    if (keyName) {
      const short = keyName.replace(/^com\.apple\.quicktime\./, '');
      const key = QT_KEYS[short.toLowerCase()];
      for (const d of datas) {
        if (d.type === 13 || d.type === 14 || d.type === 27) { s.pic(makePicture(d.pl, '', 3, '', null, null, warnings)); continue; }
        const v = mp4Value(d.type, d.pl);
        if (key) s.tag(key, v);
        else s.ext(keyName, short, v);
      }
      continue;
    }
    if (name === '----') {
      const upper = nm.toUpperCase();
      const key = MP4_FREEFORM[upper];
      for (const d of datas) {
        const v = mp4Value(d.type || 1, d.pl);
        if (key) s.tag(key, v);
        else s.ext(`----:${mean}:${nm}`, nm || mean, v);
      }
      continue;
    }
    if (name === 'covr') {
      for (const d of datas) {
        const mime = d.type === 13 ? 'image/jpeg' : d.type === 14 ? 'image/png' : d.type === 27 ? 'image/bmp' : '';
        s.pic(makePicture(d.pl, mime, 3, '', null, null, warnings));
      }
      continue;
    }
    if (name === 'trkn' || name === 'disk') {
      const d = datas[0];
      if (d && d.pl.length >= 6) {
        const n = u16be(d.pl, 2);
        const t = u16be(d.pl, 4);
        if (n || t) s.tag(name === 'trkn' ? 'track' : 'disc', t ? `${n}/${t}` : String(n));
      }
      continue;
    }
    if (name === 'gnre') {
      const d = datas[0];
      if (d && d.pl.length >= 2) {
        const g = u16be(d.pl, 0);
        if (g >= 1 && g <= ID3V1_GENRES.length) s.tag('genre', ID3V1_GENRES[g - 1]);
      }
      continue;
    }
    if (!/^[\x20-\x7e\xa9]{4}$/.test(name)) name = `0x${u32be(b, end - size + 4).toString(16)}`;
    for (const d of datas) {
      const v = mp4Value(d.type, d.pl);
      const key = MP4_TAGS[name];
      if (key) s.tag(key, v);
      else s.ext(name, MP4_LABELS[name] || name, v);
    }
  }
}

// The only boxes walked into are the containers on the way to the tags, each under its legal
// parents: moov (top level) → [trak →] [udta →] meta → ilst/keys (at most 4 levels; never
// udta in udta or meta in meta, so a file of nested headers cannot recurse without bound).
const MP4_MAX_DEPTH = 6;
const MP4_MAX_BOXES = 1 << 16; // box headers read per file (real files: < 100)
const mp4Descends = (type, parent) =>
  (type === 'moov' && parent === null) || (type === 'trak' && parent === 'moov') || (type === 'udta' && (parent === 'moov' || parent === 'trak'));
const mp4HasMeta = (parent) => parent === 'moov' || parent === 'trak' || parent === 'udta';

async function walkMp4(src, start, end, depth, s, ctx, warnings, parent, budget = { boxes: 0 }) {
  if (depth > MP4_MAX_DEPTH) {
    warnings.push('MP4: boxes nested too deep');
    return;
  }
  let p = start;
  for (let n = 0; n < 4096 && p + 8 <= end; n++) {
    if (++budget.boxes > MP4_MAX_BOXES) {
      if (budget.boxes === MP4_MAX_BOXES + 1) warnings.push(`MP4: more than ${MP4_MAX_BOXES} boxes, rest skipped`);
      return;
    }
    const h = await src.read(p, 16);
    if (h.length < 8) break;
    let size = u32be(h, 0);
    const type = latin1(h, 4, 8);
    let hdr = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = u64be(h, 8);
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || (!isFourcc(h, 4) && h[4] !== 0xa9)) {
      warnings.push(`MP4: invalid box at byte ${p}`);
      break;
    }
    let boxEnd = p + size;
    if (boxEnd > end) {
      if (type !== 'mdat') warnings.push(`MP4: box '${type}' truncated`);
      boxEnd = end;
    }
    const body = p + hdr;
    if (mp4Descends(type, parent)) {
      await walkMp4(src, body, boxEnd, depth + 1, s, ctx, warnings, type, budget);
    } else if (type === 'meta' && mp4HasMeta(parent)) {
      const q = await src.read(body, 8);
      const off = q.length >= 8 && ['hdlr', 'ilst', 'keys', 'free'].includes(latin1(q, 4, 8)) ? 0 : 4;
      const sub = { keys: null };
      await walkMp4(src, body + off, boxEnd, depth + 1, s, sub, warnings, 'meta', budget);
    } else if (type === 'keys' && parent === 'meta') {
      const b = await readRegion(src, body, boxEnd - body, warnings, 'MP4 keys');
      const keys = [];
      if (b.length >= 8) {
        const count = u32be(b, 4);
        for (let q = 8, i = 0; i < count && q + 8 <= b.length; i++) {
          const ks = u32be(b, q);
          if (ks < 8 || q + ks > b.length) break;
          keys.push(utf8(b, q + 8, q + ks));
          q += ks;
        }
      }
      ctx.keys = keys;
    } else if (type === 'ilst' && parent === 'meta') {
      const b = await readRegion(src, body, boxEnd - body, warnings, 'MP4 ilst');
      parseIlst(b, s, ctx, warnings);
    } else if (parent === 'udta' && h[4] === 0xa9) {
      // classic QuickTime user data text: [u16 length][u16 language][text]…
      const b = await readRegion(src, body, Math.min(boxEnd - body, 1 << 20), warnings, `MP4 ${type}`);
      if (b.length >= 4) {
        const len = u16be(b, 0);
        const text = legacyText(b, 4, Math.min(b.length, 4 + len));
        const key = MP4_TAGS[type];
        if (key) s.tag(key, text);
        else s.ext(type, MP4_LABELS[type] || type, text);
      }
    }
    p = boxEnd;
  }
}

// ---------------------------------------------------------------------------------------
// WAV (RIFF/RF64/BW64) and AIFF

const INFO_TAGS = {
  INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'date', IGNR: 'genre', ICMT: 'comment', ICOP: 'copyright',
  ISFT: 'encoder', IPRT: 'track', ITRK: 'track', ILNG: 'language', IMUS: 'composer', IWRI: 'lyricist', IBPM: 'bpm',
};

const INFO_LABELS = {
  IARL: 'Archival location', ICMS: 'Commissioned', ICRP: 'Cropped', IDIM: 'Dimensions', IDPI: 'Dots per inch',
  IENG: 'Engineer', IKEY: 'Keywords', ILGT: 'Lightness', IMED: 'Medium', IPLT: 'Palette setting', ISBJ: 'Subject',
  ISHP: 'Sharpness', ISRC: 'Source', ISRF: 'Source form', ITCH: 'Technician', ISMP: 'SMPTE time code',
  IDIT: 'Digitization date', ISGN: 'Secondary genre', IEDT: 'Edited by', IPRO: 'Produced by', ISTR: 'Starring',
  IRTD: 'Rating', IAS1: 'First language', IENC: 'Encoded by',
};

const isInfoId = (id) => id in INFO_TAGS || id in INFO_LABELS;

function parseInfo(b, s) {
  let p = 0;
  while (p + 8 <= b.length && isFourcc(b, p)) {
    const id = ascii(b, p, 4);
    const len = u32le(b, p + 4);
    const e = Math.min(b.length, p + 8 + len);
    const text = legacyText(b, p + 8, cutAtNul(b, p + 8, e));
    if (INFO_TAGS[id]) s.tag(INFO_TAGS[id], text);
    else s.ext(id, INFO_LABELS[id] || id, text);
    p += 8 + len + (len & 1);
    if (len & 1 && p - 1 + 8 <= b.length) {
      // pad byte missing after an odd-sized subchunk (some writers): back up one byte when
      // that lands on an id and the padded position does not (like parseRiff and FFmpeg)
      const here = isFourcc(b, p);
      const back = isFourcc(b, p - 1);
      if ((back && !here) || (back && isInfoId(ascii(b, p - 1, 4)) && !isInfoId(ascii(b, p, 4)))) p -= 1;
    }
  }
}

function parseBext(b, s) {
  if (b.length < 338) return;
  const f = (a, e) => legacyText(b, a, cutAtNul(b, a, e));
  s.ext('bext:Description', 'Description', f(0, 256));
  s.ext('bext:Originator', 'Originator', f(256, 288));
  s.ext('bext:OriginatorReference', 'Originator reference', f(288, 320));
  s.ext('bext:OriginationDate', 'Origination date', f(320, 330));
  s.ext('bext:OriginationTime', 'Origination time', f(330, 338));
  if (b.length > 602) s.ext('bext:CodingHistory', 'Coding history', f(602, b.length));
}

// Chunk ids seen in the wild, to re-sync after writers that forget the pad byte.
const RIFF_IDS = new Set(['fmt ', 'data', 'fact', 'LIST', 'id3 ', 'ID3 ', 'bext', 'junk', 'JUNK', 'PAD ', 'FLLR', 'iXML',
  'axml', 'cue ', 'smpl', 'inst', 'acid', 'cart', 'DISP', 'plst', 'PEAK', 'umid', 'minf', 'elm1', 'regn', 'chna',
  'dbmd', 'ds64', 'MD5 ', 'levl', 'afsp', 'link', 'SyLp', 'ResU']);

async function parseRiff(src, res, sources) {
  const w = res.warnings;
  const info = new Source('RIFF INFO');
  const bext = new Source('BWF bext');
  const id3s = [];
  let p = 12;
  let ds64Data = null;
  let prevOdd = false;
  for (let n = 0; n < 10000 && p + 8 <= src.size; n++) {
    let h = await src.read(p, 8);
    if (prevOdd) {
      // pad byte missing? prefer the candidate that is a known id / fits in the file
      const h2 = await src.read(p - 1, 8);
      const fits = (x, at) => isFourcc(x, 0) && at + 8 + u32le(x, 4) <= src.size + 1;
      const k1 = RIFF_IDS.has(ascii(h, 0, 4));
      const k2 = RIFF_IDS.has(ascii(h2, 0, 4));
      if ((k2 && !k1) || (!k1 && !fits(h, p) && fits(h2, p - 1))) { p -= 1; h = h2; }
    }
    if (!isFourcc(h, 0)) {
      w.push(`WAV: invalid chunk header at byte ${p}`);
      break;
    }
    const id = ascii(h, 0, 4);
    let len = u32le(h, 4);
    if (id === 'ds64') {
      const d = await src.read(p + 8, 16);
      if (d.length >= 16) ds64Data = u64le(d, 8);
    } else if (id === 'data') {
      if (len === 0xffffffff && ds64Data !== null) len = ds64Data;
      if (p + 8 + len > src.size) break; // audio runs to EOF: nothing after it
    } else if (id === 'LIST' && len >= 4) {
      const t = await src.read(p + 8, 4);
      if (ascii(t, 0, 4) === 'INFO') parseInfo(await readRegion(src, p + 12, len - 4, w, 'WAV LIST/INFO'), info);
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const b = await readRegion(src, p + 8, len, w, "WAV 'id3 ' chunk");
      if (ascii(b, 0, 3) === 'ID3') id3s.push(parseId3v2(b, w));
    } else if (id === 'bext') {
      parseBext(await readRegion(src, p + 8, Math.min(len, 602 + 65536), w, 'WAV bext'), bext);
    }
    p += 8 + len + (len & 1);
    prevOdd = !!(len & 1);
  }
  sources.push(...id3s, info, bext);
}

async function parseAiffFile(src, res, sources) {
  const w = res.warnings;
  const text = new Source('AIFF text');
  const id3s = [];
  let p = 12;
  for (let n = 0; n < 10000 && p + 8 <= src.size; n++) {
    const h = await src.read(p, 8);
    if (!isFourcc(h, 0)) {
      w.push(`AIFF: invalid chunk header at byte ${p}`);
      break;
    }
    const id = ascii(h, 0, 4);
    const len = u32be(h, 4);
    if (id === 'SSND' && p + 8 + len > src.size) break;
    if (id === 'ID3 ' || id === 'id3 ') {
      const b = await readRegion(src, p + 8, len, w, "AIFF 'ID3 ' chunk");
      if (ascii(b, 0, 3) === 'ID3') id3s.push(parseId3v2(b, w));
    } else if (id === 'NAME' || id === 'AUTH' || id === '(c) ' || id === 'ANNO') {
      const b = await readRegion(src, p + 8, Math.min(len, 1 << 20), w, `AIFF ${id}`);
      const v = legacyText(b, 0, cutAtNul(b, 0, b.length));
      if (id === 'NAME') text.tag('title', v);
      else if (id === 'AUTH') text.tag('artist', v);
      else if (id === '(c) ') text.tag('copyright', v);
      else if (!text.tags.comment) text.tag('comment', v);
      else text.ext('ANNO', 'Annotation', v);
    } else if (id === 'COMT') {
      const b = await readRegion(src, p + 8, Math.min(len, 1 << 20), w, 'AIFF COMT');
      if (b.length >= 2) {
        const count = u16be(b, 0);
        for (let i = 0, q = 2; i < count && q + 8 <= b.length; i++) {
          const cl = u16be(b, q + 6);
          const v = legacyText(b, q + 8, Math.min(b.length, q + 8 + cl));
          if (!text.tags.comment) text.tag('comment', v);
          else text.ext('COMT', 'Comment', v);
          q += 8 + cl + (cl & 1);
        }
      }
    }
    p += 8 + len + (len & 1);
  }
  sources.push(...id3s, text);
}

// ---------------------------------------------------------------------------------------
// entry point

const MP4_TOP = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid']);

/**
 * Read every tag of an audio file without decoding it.
 * @param {File|Blob|ArrayBuffer|ArrayBufferView} input
 * @returns {Promise<{
 *   format: 'mp3'|'aac'|'m4a'|'flac'|'ogg'|'wav'|'aiff'|'other',
 *   tagTypes: string[],               // tag blocks found, by priority: e.g. ['ID3v2.3', 'ID3v1.1']
 *   tags: { title?: string, artist?: string, album?: string, albumArtist?: string, date?: string,
 *           year?: string, track?: string, disc?: string, genre?: string, composer?: string,
 *           lyricist?: string, conductor?: string, remixer?: string, publisher?: string,
 *           copyright?: string, isrc?: string, bpm?: string, key?: string, mood?: string,
 *           language?: string, grouping?: string, subtitle?: string, compilation?: string,
 *           originalDate?: string, comment?: string, lyrics?: string, encoder?: string,
 *           encodedBy?: string },      // only present keys, in TAG_KEYS order
 *   extra: Array<{ key: string, label: string, value: string }>,
 *   pictures: Array<{ mime: string, type: number, typeLabel: string, description: string,
 *                     width: number|null, height: number|null, size: number, bytes: Uint8Array }>,
 *                                     // mime: one of IMAGE_MIMES or 'application/octet-stream';
 *                                     // a Blob of `bytes` may only be used as an <img> source
 *   warnings: string[],               // at most MAX_WARNINGS
 * }>} never rejects
 *
 * `extra` keys keep the source's own naming: ID3 frame ids ('WOAS', 'TOPE'), 'TXXX:<desc>',
 * 'WXXX:<desc>', 'COMM:<desc>', 'USLT:<desc>', 'UFID:<owner>', 'POPM:<email>'; MP4 atom
 * names ('desc', 'soar') and '----:<mean>:<name>'; Vorbis field names ('REPLAYGAIN_TRACK_GAIN',
 * plus 'vendor'); RIFF INFO ids ('IKEY'); 'bext:<field>'; 'APE:<key>'. `label` is English.
 * When several tag blocks exist the first in `tagTypes` wins per field (ID3v2 over APEv2 over
 * ID3v1; FLAC Vorbis comment over a stray ID3v2; WAV 'id3 ' over LIST/INFO); pictures come
 * from the first block that has any. Picture bytes are copies (safe to keep).
 */
export async function readMetadata(input) {
  const res = { format: 'other', tagTypes: [], tags: {}, extra: [], pictures: [], warnings: [] };
  const sources = [];
  let src;
  try {
    src = new ByteSource(input);
  } catch (e) {
    res.warnings.push(e.message);
    return res;
  }
  try {
    if (!src.size) {
      res.warnings.push('empty file');
      return res;
    }
    const head = await src.read(0, 16);
    const m = ascii(head, 0, 4);
    const m8 = ascii(head, 8, 4);
    if ((m === 'RIFF' || m === 'RF64' || m === 'BW64') && m8 === 'WAVE') {
      res.format = 'wav';
      await parseRiff(src, res, sources);
    } else if (m === 'FORM' && (m8 === 'AIFF' || m8 === 'AIFC')) {
      res.format = 'aiff';
      await parseAiffFile(src, res, sources);
    } else if (m === 'OggS') {
      res.format = 'ogg';
      await parseOgg(src, res, sources);
    } else if (m === 'fLaC') {
      res.format = 'flac';
      const s = new Source('FLAC Vorbis comment');
      sources.push(s);
      await parseFlac(src, 0, s, res.warnings);
    } else if (head.length >= 8 && MP4_TOP.has(ascii(head, 4, 4))) {
      res.format = 'm4a';
      const s = new Source('MP4 (iTunes ilst)');
      sources.push(s);
      await walkMp4(src, 0, src.size, 0, s, { keys: null }, res.warnings, null);
    } else {
      await parseMpegLike(src, res, sources);
    }
  } catch (e) {
    res.warnings.push(`metadata read stopped: ${(e && e.message) || e}`);
  }
  try {
    merge(res, sources);
  } catch (e) {
    res.warnings.push(`metadata merge failed: ${(e && e.message) || e}`);
  }
  res.warnings = capWarnings(res.warnings);
  return res;
}

// ---------------------------------------------------------------------------------------
// export: sanitising + writers

// Source fields that would be wrong or meaningless in the master: encoder/gapless/loudness
// data of the source encoding, its length, play counts, store account ids.
const DROP_EXTRA_KEYS = new Set([
  'TLEN', 'TSIZ', 'TFLT', 'TDLY', 'TDEN', 'TDTG', 'PCNT', 'vendor', 'pgap', 'purd', 'apID', 'ownr', 'akID',
  'cnID', 'atID', 'plID', 'geID', 'sfID', 'cmID', 'xid ', 'bext:CodingHistory', 'bext:OriginatorReference',
  'bext:OriginationDate', 'bext:OriginationTime',
]);
const DROP_EXTRA_PREFIX = /^(UFID|POPM)(:|$)/;
const DROP_EXTRA_NAME = /^(replaygain_|r128_|itunnorm$|itunsmpb$|itunpgap$|itunes_cddb|mp3gain|encoder$|encoding|encoder[ _]?settings|encoder_options|encodersettings|lame |tool (name|version)$)/i;

function isTransferable(key) {
  if (DROP_EXTRA_KEYS.has(key) || DROP_EXTRA_PREFIX.test(key)) return false;
  const name = key.replace(/^(TXXX|WXXX|COMM|USLT|APE):/, '').replace(/^----:[^:]*:/, '');
  return !DROP_EXTRA_NAME.test(name);
}

/**
 * The metadata to embed in an exported master: the source's tags, extra fields and
 * pictures minus what describes the source encoding (encoder, gapless/ReplayGain/iTunNORM
 * data, length, play counter, store ids), with `encoder` set to the given name. Idempotent.
 * Accepts readMetadata()'s result or any partial { tags?, extra?, pictures? }.
 * @param {object|null} meta
 * @param {{ encoder?: string|null }} [opts] encoder (default 'AudioMaster'; null = none)
 * @returns {{ tags: object, extra: Array<{key: string, label: string, value: string}>, pictures: object[] }}
 */
export function prepareExportMetadata(meta, { encoder = 'AudioMaster' } = {}) {
  const tags = {};
  const extra = [];
  const pictures = [];
  const src = meta && typeof meta === 'object' ? meta : {};
  const t = src.tags && typeof src.tags === 'object' ? src.tags : {};
  for (const k of Object.keys(t)) {
    if (k === 'encoder') continue;
    const v = cleanText(t[k]);
    if (v) tags[k] = v;
  }
  if (encoder) tags.encoder = cleanText(encoder);
  for (const e of Array.isArray(src.extra) ? src.extra : []) {
    if (!e || !e.key) continue;
    const key = String(e.key);
    const value = cleanText(e.value);
    if (!value || !isTransferable(key)) continue;
    extra.push({ key, label: cleanText(e.label) || key, value });
  }
  let total = 0;
  for (const p of Array.isArray(src.pictures) ? src.pictures : []) {
    if (!p) continue;
    const bytes = toBytes(p.bytes);
    if (!bytes || !bytes.length || bytes.length > MAX_EXPORT_PICTURE_BYTES) continue;
    if (!imageInfo(bytes)) continue; // only real images go into a master (never HTML/SVG/junk)
    if (total + bytes.length > MAX_EXPORT_PICTURES_TOTAL_BYTES) continue;
    total += bytes.length;
    const type = Number.isInteger(p.type) ? p.type : 3;
    pictures.push(makePicture(bytes, p.mime, type, p.description, p.width, p.height, null, false));
  }
  return { tags: normalizeTags(tags), extra, pictures };
}

/** True when prepared metadata has something besides the encoder name worth writing. */
export function hasExportMetadata(prepared) {
  if (!prepared) return false;
  const keys = Object.keys(prepared.tags || {}).filter((k) => k !== 'encoder');
  return keys.length > 0 || (prepared.extra || []).length > 0 || (prepared.pictures || []).length > 0;
}

// --- ID3v2.3 writer --------------------------------------------------------------------

const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

function encodeId3String(s, enc, terminate) {
  if (enc === 0) {
    const out = new Uint8Array(s.length + (terminate ? 1 : 0));
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  const out = new Uint8Array(2 + 2 * s.length + (terminate ? 2 : 0));
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + 2 * i] = c & 0xff;
    out[3 + 2 * i] = c >> 8;
  }
  return out;
}

/** URL frames are ISO-8859-1: anything outside printable ASCII is percent-encoded (UTF-8). */
const latin1Url = (s) => {
  const w = wellFormed(s); // encodeURI throws URIError on a lone surrogate
  const u = /^[\x20-\x7e]*$/.test(w) ? w : encodeURI(w);
  return encodeId3String(u, 0, false);
};

function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function id3v23Frame(id, parts) {
  const data = concatBytes(parts);
  const out = new Uint8Array(10 + data.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  out[4] = (data.length >>> 24) & 255;
  out[5] = (data.length >>> 16) & 255;
  out[6] = (data.length >>> 8) & 255;
  out[7] = data.length & 255;
  out.set(data, 10);
  return out;
}

const noNul = (s) => cleanText(s).replace(/\0/g, '');

function textFrame(id, value) {
  const v = noNul(value);
  if (!v) return null;
  const enc = isAscii(v) ? 0 : 1;
  return id3v23Frame(id, [Uint8Array.of(enc), encodeId3String(v, enc, false)]);
}

function descTextFrame(id, desc, value, lang) {
  const d = noNul(desc);
  const v = noNul(value);
  if (!v) return null;
  const enc = isAscii(d) && isAscii(v) ? 0 : 1;
  const parts = [Uint8Array.of(enc)];
  if (lang) parts.push(encodeId3String(lang, 0, false));
  parts.push(encodeId3String(d, enc, true), encodeId3String(v, enc, false));
  return id3v23Frame(id, parts);
}

// ISO 8601-ish dates as taggers write them: '2024', '2024-05', '2024-05-06', '2024-05-06 07:00',
// '2024-05-06T07:00:00Z' (iTunes ©day), with optional seconds, fraction and UTC offset.
const ISO_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * ID3v2.3 date frames for a date string: TYER with its year, TDAT/TIME when day/time are
 * known, plus ['TXXX', whole value] when reading those frames back would not give the value
 * ('2024-05', '2024-05-06T07:00:00Z', '06/05/2024'; FFmpeg also writes TXXX 'date').
 * @returns {Array<[string, string]>}
 */
function v23DateFrames(date, fallbackYear) {
  const out = [];
  if (!date) return out;
  const m = ISO_DATE.exec(date);
  const year = m ? m[1] : yearOf(date) || (/^\d{4}$/.test(fallbackYear) ? fallbackYear : '');
  let back = '';
  if (year) {
    out.push(['TYER', year]);
    back = year;
    if (m && m[3]) {
      out.push(['TDAT', `${m[3]}${m[2]}`]);
      back += `-${m[2]}-${m[3]}`;
      if (m[4]) {
        out.push(['TIME', `${m[4]}${m[5]}`]);
        back += `T${m[4]}:${m[5]}`;
      }
    }
  }
  if (back !== date) out.push(['TXXX', date]);
  return out;
}

const TAG_TO_ID3 = [
  ['title', 'TIT2'], ['artist', 'TPE1'], ['albumArtist', 'TPE2'], ['album', 'TALB'], ['track', 'TRCK'], ['disc', 'TPOS'],
  ['genre', 'TCON'], ['composer', 'TCOM'], ['lyricist', 'TEXT'], ['conductor', 'TPE3'], ['remixer', 'TPE4'],
  ['publisher', 'TPUB'], ['copyright', 'TCOP'], ['isrc', 'TSRC'], ['bpm', 'TBPM'], ['key', 'TKEY'], ['mood', 'TMOO'],
  ['language', 'TLAN'], ['grouping', 'TIT1'], ['subtitle', 'TIT3'], ['compilation', 'TCMP'], ['encoder', 'TSSE'],
  ['encodedBy', 'TENC'],
];

/**
 * Build an ID3v2.3 tag (no unsynchronisation, no extended header). Text is ISO-8859-1 when
 * pure ASCII, else UTF-16 with BOM. tags → standard frames (date → TYER + TDAT/TIME when
 * known, plus TXXX 'DATE' holding the whole value when those cannot — never the v2.4-only
 * TDRC, which Apple ignores in v2.3; originalDate → TORY (+ TXXX 'ORIGINALDATE')),
 * comment → COMM, lyrics → USLT ('eng', empty description), extra → the frame its key
 * names ('TOPE', 'WOAS', 'TXXX:x', 'WXXX:x', 'COMM:x', 'USLT:x'), anything else → TXXX
 * with the label as description; pictures → APIC (in order; bytes that are no recognised
 * image and not declared as one of IMAGE_MIMES are skipped). Writes what it is given
 * otherwise: use prepareExportMetadata() first for a master.
 * @param {{ tags?: object, extra?: Array<{key: string, label?: string, value: string}>,
 *   pictures?: Array<{ bytes: Uint8Array|ArrayBuffer, mime?: string, type?: number, description?: string }> }} meta
 * @param {{ padding?: number }} [opts] zero bytes appended inside the tag (default 0)
 * @returns {Uint8Array} the complete tag ('ID3' header included)
 */
export function buildId3v2(meta = {}, { padding = 0 } = {}) {
  const tags = (meta && meta.tags) || {};
  const frames = [];
  const seen = new Set();
  const add = (key, frame) => {
    if (!frame || seen.has(key)) return;
    seen.add(key);
    frames.push(frame);
  };
  for (const [k, id] of TAG_TO_ID3) {
    add(id, textFrame(id, tags[k]));
    if (k === 'disc') {
      // dates right after track/disc, like most taggers
      const date = cleanText(tags.date) || cleanText(tags.year);
      for (const [fid, v] of v23DateFrames(date, cleanText(tags.year))) {
        if (fid === 'TXXX') add('TXXX:DATE', descTextFrame('TXXX', 'DATE', v));
        else add(fid, textFrame(fid, v));
      }
    }
  }
  const od = cleanText(tags.originalDate);
  if (od) {
    const oy = ((ISO_DATE.exec(od) || [])[1]) || yearOf(od);
    if (oy) add('TORY', textFrame('TORY', oy));
    if (oy !== od) add('TXXX:ORIGINALDATE', descTextFrame('TXXX', 'ORIGINALDATE', od));
  }
  add('COMM:', descTextFrame('COMM', '', tags.comment, 'eng'));
  add('USLT:', descTextFrame('USLT', '', tags.lyrics, 'eng'));
  for (const e of Array.isArray(meta && meta.extra) ? meta.extra : []) {
    if (!e || !e.key) continue;
    const key = String(e.key);
    const value = e.value;
    let m;
    if ((m = /^(TXXX|WXXX|COMM|USLT)(?::([\s\S]*))?$/.exec(key))) {
      const desc = m[2] || '';
      const id = m[1];
      if (id === 'TXXX') add(`TXXX:${desc}`, descTextFrame('TXXX', desc, value));
      else if (id === 'WXXX') {
        const d = noNul(desc);
        const v = noNul(value);
        if (!v) continue;
        const enc = isAscii(d) ? 0 : 1;
        add(`WXXX:${desc}`, id3v23Frame('WXXX', [Uint8Array.of(enc), encodeId3String(d, enc, true), latin1Url(v)]));
      } else add(`${id}:${desc}`, descTextFrame(id, desc, value, 'eng'));
    } else if (/^T[A-Z0-9]{3}$/.test(key) || TEXT_LIKE.has(key)) {
      add(key, textFrame(key, value));
    } else if (/^W[A-Z0-9]{3}$/.test(key)) {
      const v = noNul(value);
      if (v) add(`${key}:${v}`, id3v23Frame(key, [latin1Url(v)]));
    } else {
      const desc = cleanText(e.label) || key;
      add(`TXXX:${desc}`, descTextFrame('TXXX', desc, value));
    }
  }
  for (const p of Array.isArray(meta && meta.pictures) ? meta.pictures : []) {
    const bytes = p && toBytes(p.bytes);
    if (!bytes || !bytes.length) continue;
    const mime = safeMime(imageInfo(bytes), p.mime);
    if (!IMAGE_MIME_SET.has(mime)) continue; // never write 'text/html', SVG, '-->' (link), …
    const desc = noNul(p.description);
    const enc = isAscii(desc) ? 0 : 1;
    const type = Number.isInteger(p.type) && p.type >= 0 && p.type <= 255 ? p.type : 3;
    frames.push(id3v23Frame('APIC', [Uint8Array.of(enc), encodeId3String(mime, 0, true), Uint8Array.of(type), encodeId3String(desc, enc, true), bytes]));
  }
  const pad = Math.max(0, Math.floor(padding) || 0);
  let size = pad;
  for (const f of frames) size += f.length;
  if (size > 0x0fffffff) throw new RangeError('buildId3v2: tag larger than 256 MiB');
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  let o = 10;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

// --- RIFF LIST/INFO writer -------------------------------------------------------------

const INFO_WRITE = [
  ['INAM', 'title'], ['IART', 'artist'], ['IPRD', 'album'], ['IPRT', 'track'], ['ICRD', 'date'], ['IGNR', 'genre'],
  ['ICMT', 'comment'], ['ICOP', 'copyright'], ['ISFT', 'encoder'],
];

/**
 * A complete RIFF 'LIST' chunk of type 'INFO' (header, subchunks, word-aligned) for the
 * common tags, UTF-8 encoded (what FFmpeg, foobar2000 and TagLib read); null if empty.
 * @param {object} tags canonical tags (see TAG_KEYS)
 * @returns {Uint8Array|null}
 */
export function buildRiffInfo(tags = {}) {
  const enc = new TextEncoder();
  const subs = [];
  for (const [id, key] of INFO_WRITE) {
    const v = noNul(tags && (key === 'date' ? tags.date || tags.year : tags[key]));
    if (v) subs.push([id, enc.encode(v)]);
  }
  if (!subs.length) return null;
  let size = 4;
  for (const [, b] of subs) size += 8 + b.length + 1 + ((b.length + 1) & 1);
  const out = new Uint8Array(8 + size);
  const dv = new DataView(out.buffer);
  const put = (s, o) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put('LIST', 0);
  dv.setUint32(4, size, true);
  put('INFO', 8);
  let o = 12;
  for (const [id, b] of subs) {
    put(id, o);
    dv.setUint32(o + 4, b.length + 1, true);
    out.set(b, o + 8);
    o += 8 + b.length + 1 + ((b.length + 1) & 1); // NUL terminator + pad byte stay zero
  }
  return out;
}
