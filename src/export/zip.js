// Store-only ZIP writer (no compression: audio does not deflate, and STORE keeps it fast
// and streamable). Layout per PKWARE APPNOTE 6.3: [local header + data]… central
// directory, end-of-central-directory. UTF-8 names set general-purpose flag bit 11.
// No ZIP64: archives (or members) of 4 GiB and more are refused with a clear error —
// far beyond any song (10 min 24-bit/48 kHz WAV ≈ 173 MB).

const ZIP_LIMIT = 0xffffffff;
const MAX_ENTRIES = 0xffff;

let CRC_TABLE = null;
function crcTables() {
  if (CRC_TABLE) return CRC_TABLE;
  // Slice-by-4 tables for the reflected IEEE polynomial 0xEDB88320 (≈ 3× byte-wise speed).
  const t = new Int32Array(1024);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    t[256 + n] = (t[n] >>> 8) ^ t[t[n] & 255];
    t[512 + n] = (t[256 + n] >>> 8) ^ t[t[256 + n] & 255];
    t[768 + n] = (t[512 + n] >>> 8) ^ t[t[512 + n] & 255];
  }
  CRC_TABLE = t;
  return t;
}

/**
 * CRC-32 (IEEE 802.3, as used by ZIP/PNG/gzip).
 * @param {Uint8Array} bytes
 * @param {number} [crc=0] previous CRC to continue from
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(bytes, crc = 0) {
  const t = crcTables();
  let c = ~crc;
  const n = bytes.length;
  let i = 0;
  for (const end4 = n - (n & 3); i < end4; i += 4) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = t[768 + (c & 255)] ^ t[512 + ((c >>> 8) & 255)] ^ t[256 + ((c >>> 16) & 255)] ^ t[c >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer || (data && typeof data.byteLength === 'number' && typeof data.slice === 'function' && !(typeof Blob !== 'undefined' && data instanceof Blob))) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new TypeError('makeZip: data must be a Uint8Array, ArrayBuffer or string (read Blobs first)');
}

/** Safe relative path inside the archive (no absolute paths, drive letters or '..'). */
function cleanName(name) {
  const parts = String(name ?? '').replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').split('/');
  const out = parts.filter((p) => p && p !== '.' && p !== '..');
  return out.join('/') || 'file';
}

/** MS-DOS date/time (local time, 2-second resolution, years 1980–2107). */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  let y = d.getFullYear();
  if (y < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (y > 2107) y = 2107;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Compute the archive layout and refuse what plain ZIP cannot represent.
 * @param {{ nameLength: number, size: number }[]} entries
 * @returns {{ offsets: number[], cdOffset: number, cdSize: number, total: number }}
 * @throws {Error & { code: 'zip_too_large' }}
 */
export function _planZip(entries) {
  const tooLarge = () => Object.assign(new Error('ZIP archives of 4 GB or more are not supported (no ZIP64). Export fewer or shorter files.'), { code: 'zip_too_large' });
  if (entries.length > MAX_ENTRIES) throw Object.assign(new Error(`ZIP archives are limited to ${MAX_ENTRIES} files.`), { code: 'zip_too_large' });
  const offsets = [];
  let p = 0;
  let cd = 0;
  for (const e of entries) {
    if (e.size >= ZIP_LIMIT) throw tooLarge();
    offsets.push(p);
    p += 30 + e.nameLength + e.size;
    cd += 46 + e.nameLength;
  }
  const total = p + cd + 22;
  if (p >= ZIP_LIMIT || total > ZIP_LIMIT) throw tooLarge();
  return { offsets, cdOffset: p, cdSize: cd, total };
}

/**
 * Build the archive as a list of byte chunks (file data is referenced, not copied).
 * @param {{ name: string, data: Uint8Array|ArrayBuffer|string, date?: Date }[]} files
 * @param {{ date?: Date }} [opts] modification time for all members (default: now)
 * @returns {{ parts: Uint8Array[], size: number }}
 */
export function makeZipParts(files, opts = {}) {
  if (!Array.isArray(files)) throw new TypeError('makeZip: files must be an array');
  const enc = new TextEncoder();
  const items = files.map((f) => {
    const nameBytes = enc.encode(cleanName(f.name));
    if (nameBytes.length > 0xffff) throw new RangeError('makeZip: file name too long');
    const data = toBytes(f.data);
    return { nameBytes, data, utf8: nameBytes.some((b) => b >= 0x80), dt: dosDateTime(f.date || opts.date) };
  });
  const plan = _planZip(items.map((it) => ({ nameLength: it.nameBytes.length, size: it.data.length })));
  const parts = [];
  const cd = new Uint8Array(plan.cdSize + 22);
  const cdv = new DataView(cd.buffer);
  let q = 0;
  items.forEach((it, idx) => {
    const crc = crc32(it.data);
    const flags = it.utf8 ? 0x0800 : 0;
    const n = it.nameBytes.length;
    const lh = new Uint8Array(30 + n);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed: 2.0
    v.setUint16(6, flags, true);
    v.setUint16(8, 0, true); // method: store
    v.setUint16(10, it.dt.time, true);
    v.setUint16(12, it.dt.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, it.data.length, true);
    v.setUint32(22, it.data.length, true);
    v.setUint16(26, n, true);
    v.setUint16(28, 0, true);
    lh.set(it.nameBytes, 30);
    parts.push(lh, it.data);

    cdv.setUint32(q, 0x02014b50, true);
    cdv.setUint16(q + 4, 0x0314, true); // made by: Unix, 2.0 → external attrs carry permissions
    cdv.setUint16(q + 6, 20, true);
    cdv.setUint16(q + 8, flags, true);
    cdv.setUint16(q + 10, 0, true);
    cdv.setUint16(q + 12, it.dt.time, true);
    cdv.setUint16(q + 14, it.dt.date, true);
    cdv.setUint32(q + 16, crc, true);
    cdv.setUint32(q + 20, it.data.length, true);
    cdv.setUint32(q + 24, it.data.length, true);
    cdv.setUint16(q + 28, n, true);
    cdv.setUint16(q + 30, 0, true); // extra
    cdv.setUint16(q + 32, 0, true); // comment
    cdv.setUint16(q + 34, 0, true); // disk
    cdv.setUint16(q + 36, 0, true); // internal attrs
    cdv.setUint32(q + 38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    cdv.setUint32(q + 42, plan.offsets[idx], true);
    cd.set(it.nameBytes, q + 46);
    q += 46 + n;
  });
  cdv.setUint32(q, 0x06054b50, true);
  cdv.setUint16(q + 4, 0, true);
  cdv.setUint16(q + 6, 0, true);
  cdv.setUint16(q + 8, items.length, true);
  cdv.setUint16(q + 10, items.length, true);
  cdv.setUint32(q + 12, plan.cdSize, true);
  cdv.setUint32(q + 16, plan.cdOffset, true);
  cdv.setUint16(q + 20, 0, true);
  parts.push(cd);
  return { parts, size: plan.total };
}

/**
 * Build a ZIP archive as one contiguous Uint8Array (environment-neutral; tests, workers).
 * @param {{ name: string, data: Uint8Array|ArrayBuffer|string, date?: Date }[]} files
 * @param {{ date?: Date }} [opts]
 * @returns {Uint8Array}
 */
export function makeZipBytes(files, opts = {}) {
  const { parts, size } = makeZipParts(files, opts);
  const out = new Uint8Array(size);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/**
 * Store-only ZIP (CRC-32, UTF-8 names) as a Blob.
 * @param {{ name: string, data: Uint8Array|ArrayBuffer|string, date?: Date }[]} files
 * @param {{ date?: Date }} [opts] member modification time (default: now)
 * @returns {Blob} type 'application/zip'
 * @throws {Error & { code: 'zip_too_large' }} at 4 GiB or 65535 members
 */
export function makeZip(files, opts = {}) {
  return new Blob(makeZipParts(files, opts).parts, { type: 'application/zip' });
}
