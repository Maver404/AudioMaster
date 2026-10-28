// Save a Blob for the user.
//
// 1. An embedding host can take over saving by defining, before the app starts,
//      globalThis.__AM_HOST__ = {
//        downloads: () => Promise<{ save({ filename, data }) } | null>,
//        extensions?: string[],   // what the host accepts; anything else goes in a STORE .zip
//      }
//    This is for sandboxed frames where <a download> is blocked: the host's save() asks the
//    viewer and resolves once the file was handed over, or rejects with { code }
//    (CODE_STATUS below; any other code is 'unavailable'). downloads() resolving null (or
//    not answering within 20 s) means this view cannot save at all. Inside such a
//    host we never fall back to <a download>: the sandbox blocks it silently and the user
//    would be told 'saved' with no file. A format the host refuses, even as a .zip, is
//    'unavailable' with code 'format_not_accepted' (other formats may still work).
// 2. Elsewhere (the normal case): classic <a download> with an object URL, revoked after
//    60 s (revoking at once can cancel the download in some Safari/Firefox versions).
import { makeZip } from './zip.js';

/** host save() rejection code → saveBlob status. Codes not listed are 'unavailable'. */
const CODE_STATUS = new Map([
  ['declined', 'declined'], // the viewer said no or let the prompt expire: never auto-retry
  ['rate_limited', 'busy'], // a save prompt is already open (or too many recent ones): wait, retry
  ['busy', 'busy'],
  ['too_large', 'too_large'], // over the host's size ceiling: offer a smaller file
]);

const REVOKE_AFTER_MS = 60000;
// A host that never answers downloads() counts as one that cannot save (no endless export).
const HOST_TIMEOUT_MS = 20000;
let hostTimeoutMs = HOST_TIMEOUT_MS;
/** Tests only: a shorter wait for a host that never answers (null = the default). */
export function _setHostTimeout(ms) {
  hostTimeoutMs = ms === null ? HOST_TIMEOUT_MS : ms;
}
// Some hosts reject very long names; 200 characters is safe everywhere.
const MAX_NAME_CHARS = 200;

/** Base and extension; "Sig. Notte" has no extension (an extension is 1–8 letters / digits). */
function splitExt(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return /^[a-z0-9]{1,8}$/i.test(ext) ? { base: name.slice(0, dot), ext: ext.toLowerCase() } : { base: name, ext: '' };
}

/** Strip path separators and control characters, cap the length; keep Unicode (accents are fine). */
function cleanFilename(name) {
  // eslint-disable-next-line no-control-regex
  let s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  if (s.length > MAX_NAME_CHARS) {
    const { base, ext } = splitExt(s);
    const tail = ext && ext.length < 16 ? `.${ext}` : '';
    s = Array.from(tail ? base : s).slice(0, MAX_NAME_CHARS - tail.length).join('').trim() + tail;
  }
  return s || 'download';
}

/** The embedding host's save adapter (see the top of this file), else null. */
function saveHost() {
  const h = globalThis.__AM_HOST__;
  return h && typeof h.downloads === 'function' ? h : null;
}

// host.downloads() is resolved once per host object (a view that cannot save may take a
// while to answer, so app.js asks at boot). A null answer, or none within the timeout, is
// not kept for the probe: the next probeSaveSupport() asks again, and every earlier call
// that is still unanswered can still answer it; an answer that arrives later is kept for
// the next probe. A save after a null answer does not ask again (no second long wait).
let memo = null;
const nullHosts = new WeakSet(); // hosts whose latest answer was null
const outstanding = new WeakMap(); // host → Set of its downloads() answers still awaited

/** The first saver among `answers`, null once all answered null, or null after `ms`. */
function firstSaver(answers, ms) {
  return new Promise((resolve) => {
    let left = answers.length;
    let done = false;
    let timer = 0;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => finish(null), ms);
    for (const a of answers) a.then((ns) => (ns ? finish(ns) : --left === 0 && finish(null)));
  });
}

function downloadsNamespace(host, { reask = true } = {}) {
  if (memo && memo.host === host) return memo.downloads;
  if (!reask && nullHosts.has(host)) return Promise.resolve(null);
  let p;
  try {
    p = Promise.resolve(host.downloads());
  } catch {
    p = Promise.resolve(null);
  }
  const answer = p.then((ns) => (ns && typeof ns.save === 'function' ? ns : null), () => null);
  let set = outstanding.get(host);
  if (!set) outstanding.set(host, (set = new Set()));
  const earlier = [...set];
  set.add(answer);
  answer.then((ns) => {
    set.delete(answer);
    if (!ns) return;
    nullHosts.delete(host);
    // A late answer (after the timeout) for the current host serves the next probe.
    if (!memo && saveHost() === host) memo = { host, downloads: Promise.resolve(ns) };
  });
  const entry = { host, downloads: null };
  entry.downloads = firstSaver([answer, ...earlier], hostTimeoutMs).then((ns) => {
    if (ns) nullHosts.delete(host);
    else {
      nullHosts.add(host);
      if (memo === entry) memo = null;
    }
    return ns;
  });
  memo = entry;
  return entry.downloads;
}

/** Extensions the host accepts as they are, or null when it accepts everything. */
function hostExtensions(host) {
  const list = Array.isArray(host.extensions) ? host.extensions : null;
  return list ? new Set(list.map((e) => String(e).toLowerCase().replace(/^\./, ''))) : null;
}

function canAnchorDownload() {
  const doc = globalThis.document;
  const URLi = globalThis.URL;
  return !!(doc && typeof doc.createElement === 'function' && URLi && typeof URLi.createObjectURL === 'function');
}

/**
 * How this page can save files, resolved ahead of the first export:
 * 'host' = the embedding host saves (each save may ask the viewer),
 * 'browser' = classic download, 'none' = no way to save here (a host that cannot save in
 * this view, or no DOM at all).
 * Memoized: host.downloads() is called once and shared with saveBlob; after a null
 * answer (or none within 20 s) the next probe asks again.
 * @returns {Promise<'host'|'browser'|'none'>}
 */
export function probeSaveSupport() {
  const host = saveHost();
  if (host) return downloadsNamespace(host).then((ns) => (ns ? 'host' : 'none'));
  return Promise.resolve(canAnchorDownload() ? 'browser' : 'none');
}

function anchorDownload(blob, filename) {
  if (!canAnchorDownload()) return { status: 'unavailable', filename, code: 'no_dom' };
  const doc = globalThis.document;
  const URLi = globalThis.URL;
  const url = URLi.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  if (a.style) a.style.display = 'none';
  const parent = doc.body || doc.documentElement;
  if (parent && typeof parent.appendChild === 'function') parent.appendChild(a);
  try {
    a.click();
  } finally {
    if (typeof a.remove === 'function') a.remove();
    else if (parent && typeof parent.removeChild === 'function') parent.removeChild(a);
  }
  const t = setTimeout(() => URLi.revokeObjectURL(url), REVOKE_AFTER_MS);
  if (t && typeof t.unref === 'function') t.unref(); // never keep a Node test process alive
  return { status: 'saved', filename };
}

/**
 * Save a Blob under a filename.
 * @param {Blob} blob
 * @param {string} filename suggested name with extension (e.g. 'Song (master).wav')
 * @returns {Promise<{ status: 'saved'|'declined'|'unavailable'|'busy'|'too_large', filename: string, code?: string }>}
 *   `filename` is the name actually offered (e.g. 'Song (master).zip' inside a host that
 *   does not accept .wav). 'saved': in a host, the viewer accepted; elsewhere, the download
 *   was started (browsers do not report completion). 'declined': the viewer said no. 'busy': a save prompt is
 *   already open (code 'rate_limited'): wait, then retry. 'too_large': the host refused the
 *   size: offer a smaller file (MP3, one track at a time). 'unavailable': no way to save
 *   here; `code` says why ('no_capability' = the host cannot save in this view,
 *   'format_not_accepted' = the host refuses this format even zipped, 'no_dom', or the
 *   host's own code). Never rejects.
 */
export async function saveBlob(blob, filename) {
  const name = cleanFilename(filename);
  const host = saveHost();
  if (!host) return anchorDownload(blob, name);
  const dl = await downloadsNamespace(host, { reask: false });
  if (!dl) return { status: 'unavailable', filename: name, code: 'no_capability' };
  let outName = name;
  let outBlob = blob;
  const { base, ext } = splitExt(name);
  const allowed = hostExtensions(host);
  if (allowed && !allowed.has(ext)) {
    // Wrapping only helps when the host takes a .zip (and the file is not one already).
    if (ext === 'zip' || !allowed.has('zip')) return { status: 'unavailable', filename: name, code: 'format_not_accepted' };
    outName = `${base}.zip`;
    try {
      outBlob = makeZip([{ name, data: new Uint8Array(await blob.arrayBuffer()) }]);
    } catch (e) {
      // zip_too_large (≥ 4 GB) or out of memory: nothing the viewer can be offered
      return { status: 'too_large', filename: outName, code: (e && e.code) || 'zip_failed' };
    }
  }
  try {
    await dl.save({ filename: outName, data: outBlob });
    return { status: 'saved', filename: outName };
  } catch (err) {
    const code = String((err && (err.code || err.name)) || 'unavailable');
    return { status: CODE_STATUS.get(code) || 'unavailable', filename: outName, code };
  }
}
