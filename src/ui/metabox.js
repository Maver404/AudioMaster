// "Metadati" box: the active song's cover art and every tag the file carries (read by
// src/audio/metadata.js), its lyrics, the remaining fields under their original names and
// the technical details, plus the switch that copies cover and tags into the exported
// master. "Modifica" opens a form that changes the main fields, the cover and the extra
// fields of what the master carries (the file itself is never touched). Pure helpers first (DOM-free, tested in Node); createMetaBox() builds the panel
// (nothing touches the DOM at import time). Every value is set as textContent, links only
// for http(s) URLs, and a picture's blob URL is only ever an <img> source.
import { t, getLanguage, formatNumber, formatHz, formatTime } from './i18n.js';
import { h, clear, bindText, bindAttr, toggleSwitch } from './controls.js';
import { withHelp } from './help.js';
import { pickCover, prepareExportMetadata, hasExportMetadata, sniffImage, MAX_EXPORT_PICTURE_BYTES } from '../audio/metadata.js';

/** Tag keys shown as rows, in order (title / artist / album head the box; lyrics have their own fold). */
export const META_ROW_KEYS = Object.freeze([
  'albumArtist', 'date', 'track', 'disc', 'genre', 'composer', 'lyricist', 'conductor', 'remixer',
  'publisher', 'copyright', 'isrc', 'bpm', 'key', 'mood', 'language', 'grouping', 'subtitle',
  'compilation', 'originalDate', 'comment', 'encoder', 'encodedBy',
]);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** True when the file carries anything worth showing or copying (tags or a picture). */
export function hasMeta(meta) {
  if (!meta) return false;
  const tags = meta.tags || {};
  return Object.keys(tags).some((k) => str(tags[k])) || (meta.extra || []).length > 0 || (meta.pictures || []).length > 0;
}

const carriesCache = new WeakMap();
/**
 * True when an exported master would get anything from `meta` (the exporters drop source
 * encoder names, lengths, non-image pictures…): what the copy-to-master switch is about.
 */
export function carriesMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (!carriesCache.has(meta)) {
    let v = false;
    try {
      v = hasExportMetadata(prepareExportMetadata(meta));
    } catch {
      v = false;
    }
    carriesCache.set(meta, v);
  }
  return carriesCache.get(meta);
}

/** [{ key, value }] for the rows under the head, in META_ROW_KEYS order. */
export function metaRows(meta) {
  const tags = (meta && meta.tags) || {};
  return META_ROW_KEYS.filter((k) => str(tags[k])).map((k) => ({ key: k, value: str(tags[k]) }));
}

/** The value as a link target when it is a plain http(s) URL, else null. */
export function safeLink(value) {
  const s = str(value);
  if (!/^https?:\/\/[^\s<>"]+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Number of lines of a lyrics text (0 when empty). */
export function lyricsLineCount(text) {
  const s = str(text);
  return s ? s.split('\n').length : 0;
}

// --- Edits ---------------------------------------------------------------------------
// The user's changes live beside the file's metadata, never inside it: edits =
// { tags: { key: value }, cover: undefined (unchanged) | null (removed) | picture,
//   dropExtra: [extraId] } or null. effectiveMeta() merges them for the box and the
// exporters; "Ripristina i dati del file" simply drops them.

/** Tag keys the edit form offers, in order (encoder names are set by the exporter). */
export const EDIT_KEYS = Object.freeze([
  'title', 'artist', 'album', 'albumArtist', 'date', 'track', 'disc', 'genre', 'bpm', 'key',
  'isrc', 'composer', 'lyricist', 'publisher', 'copyright', 'comment', 'lyrics',
]);
/** Fields edited in a multi-line box. */
export const LONG_KEYS = Object.freeze(['comment', 'lyrics']);
/** Short fields, two to a row in the form; the others take the whole width. */
export const SHORT_KEYS = Object.freeze(['date', 'track', 'disc', 'genre', 'bpm', 'key']);
/** Longest value accepted per field (characters). */
export const MAX_EDIT_CHARS = { lyrics: 20000, comment: 2000 };
const MAX_SHORT_CHARS = 300;
/** Covers the user picks: what every player and tag reader shows. */
export const COVER_MIMES = Object.freeze(['image/jpeg', 'image/png']);

const FORMATS = {
  date: /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/,
  track: /^\d{1,4}(\/\d{1,4})?$/,
  disc: /^\d{1,3}(\/\d{1,3})?$/,
  bpm: /^\d{2,3}([.,]\d{1,2})?$/,
  isrc: /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i,
};

/** Edited text as it is stored: Unix line ends, trimmed. */
function normValue(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').trim();
}

/** The i18n key of what is wrong with `value` for `key`, or null when it is fine (empty is fine). */
export function validateTag(key, value) {
  const v = normValue(value);
  if (!v) return null;
  if (v.length > (MAX_EDIT_CHARS[key] || MAX_SHORT_CHARS)) return 'meta.bad.long';
  if (FORMATS[key] && !FORMATS[key].test(v)) return `meta.bad.${key}`;
  return null;
}

/** Stable id of an extra field (key + value: a tag may repeat a key with other values). */
export function extraId(e) {
  return `${(e && e.key) || ''}\u0000${(e && e.value) || ''}`;
}

/** True when `edits` changes anything. */
export function hasEdits(edits) {
  return !!edits && (Object.keys(edits.tags || {}).length > 0 || edits.cover !== undefined || (edits.dropExtra || []).length > 0);
}

/**
 * New edits after one change (the old object is never mutated): { tag, value } sets a
 * field (back to the file's value = no edit), { cover: picture|null } replaces / removes
 * the cover, { dropExtra: id } removes an extra field, { reset: true } drops everything.
 * @returns {object|null} null when nothing is edited any more
 */
export function patchEdits(meta, edits, patch) {
  if (!patch || patch.reset) return null;
  const cur = edits || {};
  const next = { tags: { ...(cur.tags || {}) }, cover: cur.cover, dropExtra: [...(cur.dropExtra || [])] };
  if (patch.tag && EDIT_KEYS.includes(patch.tag)) {
    const value = normValue(patch.value);
    if (value === str(meta && meta.tags && meta.tags[patch.tag])) delete next.tags[patch.tag];
    else next.tags[patch.tag] = value;
  }
  if ('cover' in patch) next.cover = patch.cover;
  if (patch.dropExtra && !next.dropExtra.includes(patch.dropExtra)) next.dropExtra.push(patch.dropExtra);
  return hasEdits(next) ? next : null;
}

const effectiveCache = new WeakMap();
/**
 * The metadata the box shows and a master carries: the file's, with the user's edits on
 * top. Without edits it is `meta` itself. Same inputs → same object (cached per edits).
 */
export function effectiveMeta(meta, edits) {
  if (!hasEdits(edits)) return meta || null;
  const hit = effectiveCache.get(edits);
  if (hit && hit.meta === meta) return hit.result;
  const base = meta && typeof meta === 'object' ? meta : { format: 'other', tagTypes: [], tags: {}, extra: [], pictures: [], warnings: [] };
  const tags = { ...(base.tags || {}) };
  for (const [k, raw] of Object.entries(edits.tags || {})) {
    if (!EDIT_KEYS.includes(k)) continue;
    const v = normValue(raw);
    if (v) tags[k] = v;
    else delete tags[k];
    if (k === 'date') delete tags.year;
  }
  if (tags.date && !tags.year) {
    const m = /(\d{4})/.exec(tags.date);
    if (m) tags.year = m[1];
  }
  const drop = new Set(edits.dropExtra || []);
  const extra = (base.extra || []).filter((e) => !drop.has(extraId(e)));
  let pictures = base.pictures || [];
  if (edits.cover === null) pictures = [];
  else if (edits.cover) pictures = [edits.cover];
  const result = { ...base, tags, extra, pictures };
  effectiveCache.set(edits, { meta, result });
  return result;
}

/** "JPEG 360×360" style description of one picture. */
export function pictureLabel(p) {
  const type = String((p && p.mime) || '').replace(/^image\//, '').toUpperCase() || '?';
  return finite(p && p.width) && finite(p && p.height) ? `${type} ${p.width}×${p.height}` : type;
}

/**
 * Technical rows from the decoder's info and the metadata result: [{ key, value }], key =
 * the i18n suffix (meta.tech.<key>). Values are already formatted for the current language.
 */
export function techRows(info, meta) {
  const rows = [];
  const add = (key, value) => {
    if (value !== '' && value !== null && value !== undefined) rows.push({ key, value: String(value) });
  };
  const i = info || {};
  if (i.format && i.format !== 'other') add('format', String(i.format).toUpperCase() + (i.codec && i.codec !== i.format ? ` (${i.codec})` : ''));
  const sr = i.nativeSampleRate || i.sampleRate;
  if (finite(sr)) add('sampleRate', formatHz(sr));
  if (finite(i.bitDepth)) add('bitDepth', `${i.bitDepth}-bit`);
  if (finite(i.bitrateKbps)) add('bitrate', `${Math.round(i.bitrateKbps)} kbps`);
  if (finite(i.decodedChannels)) add('channels', i.decodedChannels === 1 ? t('meta.mono') : i.decodedChannels === 2 ? t('meta.stereo') : String(i.decodedChannels));
  if (finite(i.duration)) add('duration', formatTime(i.duration));
  if (finite(i.sizeBytes) && i.sizeBytes > 0) add('size', `${formatNumber(i.sizeBytes / 1048576, 1)} MB`);
  if (meta && Array.isArray(meta.tagTypes) && meta.tagTypes.length) add('tags', meta.tagTypes.join(', '));
  if (meta && Array.isArray(meta.pictures) && meta.pictures.length) add('pictures', meta.pictures.map(pictureLabel).join(', '));
  return rows;
}

/** Placeholder hints for the fields with a format. */
const PLACEHOLDER = { date: 'meta.ph.date', track: 'meta.ph.track', disc: 'meta.ph.track', isrc: 'meta.ph.isrc', bpm: 'meta.ph.bpm' };

/**
 * Build the panel.
 * @param {{ help?: (id: string) => HTMLElement|null, keep?: boolean, onKeepChange?: (on: boolean) => void,
 *   onEdit?: (patch: object) => void }} [api] onEdit gets patchEdits() patches for the active song
 * @returns {{ el: HTMLElement, update(tr: object|null): void, setKeep(on: boolean): void,
 *   setDisabled(d: boolean): void, relabel(): void, destroy(): void }}
 */
export function createMetaBox({ help = () => null, keep = true, onKeepChange = () => {}, onEdit = () => {} } = {}) {
  let coverUrl = null;
  let coverPic = null;
  let current = null; // the track shown
  let shownKey = ''; // what the rows were built from: rebuilt only when it changes
  let large = false;
  let editing = null; // id of the track whose form is open
  const ids = new WeakMap();
  let nextObjId = 1;
  const idOf = (o) => {
    if (!o || typeof o !== 'object') return 0;
    if (!ids.has(o)) ids.set(o, nextObjId++);
    return ids.get(o);
  };

  const img = h('img', { class: 'meta-img', alt: '', decoding: 'async' });
  const coverBtn = h('button', { type: 'button', class: 'meta-cover', 'aria-expanded': 'false', hidden: true }, img);
  const coverNone = h('div', { class: 'meta-cover meta-cover-none', 'aria-hidden': 'true' }, h('span', { text: '♪' }));
  const title = h('p', { class: 'meta-title' });
  const artist = h('p', { class: 'meta-artist' });
  const album = h('p', { class: 'meta-album' });
  const editedBadge = h('span', { class: 'badge badge-mod', i18n: 'meta.edited', hidden: true });
  const note = h('p', { class: 'hint meta-note' });
  const rows = h('dl', { class: 'meta-rows' });
  const lyricsSum = h('summary', { class: 'meta-sum' });
  const lyricsText = h('div', { class: 'meta-lyrics', tabindex: '0' });
  const lyrics = h('details', { class: 'meta-fold', hidden: true }, lyricsSum, lyricsText);
  const extraSum = h('summary', { class: 'meta-sum' });
  const extraRows = h('dl', { class: 'meta-rows meta-rows-extra' });
  const extra = h('details', { class: 'meta-fold', hidden: true }, extraSum, extraRows);
  const techRowsEl = h('dl', { class: 'meta-rows' });
  const tech = h('details', { class: 'meta-fold', hidden: true }, h('summary', { class: 'meta-sum', i18n: 'meta.tech' }), techRowsEl);
  const keepSw = toggleSwitch({ id: 'am-meta-keep', labelKey: 'meta.keep', checked: keep, onChange: (on) => onKeepChange(on) });
  const keepHint = h('p', { class: 'hint', id: 'am-meta-keep-hint' });
  keepSw.button.setAttribute('aria-describedby', 'am-meta-keep-hint');
  const keepBox = h('div', { class: 'meta-keep', hidden: true }, withHelp(keepSw.el, help('meta.keep')), keepHint);
  let keepOn = !!keep;

  // Edit form ("Modifica"): one field per EDIT_KEYS, the cover, the extra fields.
  const editBtn = h('button', { type: 'button', class: 'btn-text', id: 'am-meta-edit', 'aria-expanded': 'false', 'aria-controls': 'am-meta-form', i18n: 'meta.edit' });
  const fields = {};
  const fieldEls = EDIT_KEYS.map((key) => {
    const id = `am-meta-f-${key}`;
    const long = LONG_KEYS.includes(key);
    const input = h(long ? 'textarea' : 'input', {
      id,
      class: `meta-input${long ? ' meta-input-long' : ''}`,
      ...(long ? { rows: key === 'lyrics' ? '8' : '3' } : { type: 'text', autocomplete: 'off', spellcheck: 'false' }),
      maxlength: String(MAX_EDIT_CHARS[key] || MAX_SHORT_CHARS),
      'aria-describedby': `${id}-err`,
    });
    if (PLACEHOLDER[key]) bindAttr(input, 'placeholder', PLACEHOLDER[key]);
    const err = h('p', { class: 'meta-err', id: `${id}-err`, hidden: true });
    input.addEventListener('input', () => {
      const bad = validateTag(key, input.value);
      input.setAttribute('aria-invalid', bad ? 'true' : 'false');
      err.hidden = !bad;
      if (bad) bindText(err, bad);
      else onEdit({ tag: key, value: input.value });
    });
    fields[key] = { input, err };
    return h('div', { class: `meta-field${SHORT_KEYS.includes(key) ? '' : ' meta-field-long'}` }, h('label', { for: id, i18n: `meta.f.${key}` }), input, err);
  });
  const coverInput = h('input', { type: 'file', accept: COVER_MIMES.join(','), hidden: true, tabindex: '-1' });
  const coverPick = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'am-meta-cover-pick' });
  const coverDrop = h('button', { type: 'button', class: 'btn-text', id: 'am-meta-cover-drop', i18n: 'meta.coverRemove' });
  const coverErr = h('p', { class: 'meta-err', hidden: true, role: 'alert' });
  const extraEdit = h('ul', { class: 'meta-extra-edit' });
  const extraEditBox = h('div', { class: 'meta-field meta-field-long', hidden: true }, h('p', { class: 'meta-sub', i18n: 'meta.extraEdit' }), extraEdit);
  const keepOffNote = h('p', { class: 'hint meta-warn', i18n: 'meta.editKeepOff', hidden: true });
  const doneBtn = h('button', { type: 'submit', class: 'btn btn-ghost btn-sm', i18n: 'meta.editDone' });
  const resetBtn = h('button', { type: 'button', class: 'btn-text', id: 'am-meta-reset', i18n: 'meta.reset', hidden: true });
  const fieldset = h(
    'fieldset',
    { class: 'meta-fieldset' },
    h('legend', { class: 'sr-only', i18n: 'meta.editLegend' }),
    h('div', { class: 'meta-cover-edit' }, coverPick, coverDrop, coverInput),
    coverErr,
    h('div', { class: 'meta-fields' }, ...fieldEls),
    extraEditBox,
    keepOffNote,
    h('div', { class: 'meta-form-actions' }, doneBtn, resetBtn),
  );
  const form = h('form', { class: 'meta-form', id: 'am-meta-form', hidden: true, novalidate: true }, fieldset);
  const editWrap = withHelp(editBtn, help('meta.edit'));

  const el = h(
    'section',
    { class: 'panel meta', id: 'am-meta', 'aria-labelledby': 'am-meta-title', hidden: true },
    h('div', { class: 'panel-head' }, h('div', { class: 'head-l' }, h('h2', { class: 'lbl', id: 'am-meta-title', i18n: 'meta.title' }), help('meta'), editedBadge), editWrap),
    h('div', { class: 'meta-head' }, coverBtn, coverNone, h('div', { class: 'meta-id' }, title, artist, album)),
    note,
    form,
    rows,
    lyrics,
    extra,
    tech,
    keepBox,
  );

  coverBtn.addEventListener('click', () => {
    large = !large;
    el.classList.toggle('is-large', large);
    coverBtn.setAttribute('aria-expanded', large ? 'true' : 'false');
    bindLabel();
  });
  editBtn.addEventListener('click', () => (editing ? closeEdit(true) : openEdit()));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    closeEdit(true);
  });
  resetBtn.addEventListener('click', () => {
    onEdit({ reset: true });
    fillForm();
    coverErr.hidden = true;
    doneBtn.focus();
  });
  coverPick.addEventListener('click', () => coverInput.click());
  coverDrop.addEventListener('click', () => {
    coverErr.hidden = true;
    onEdit({ cover: null });
    coverPick.focus();
  });
  coverInput.addEventListener('change', async () => {
    const file = coverInput.files && coverInput.files[0];
    coverInput.value = '';
    if (!file) return;
    const pic = await readCover(file);
    coverErr.hidden = !!pic;
    if (!pic) {
      bindText(coverErr, 'meta.coverBad');
      return;
    }
    onEdit({ cover: pic });
  });

  /** A picked image as a front-cover picture, or null when it is not a JPEG / PNG ≤ 16 MB. */
  async function readCover(file) {
    try {
      if (file.size > MAX_EXPORT_PICTURE_BYTES) return null;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = sniffImage(bytes);
      if (!info || !COVER_MIMES.includes(info.mime)) return null;
      return { mime: info.mime, type: 3, typeLabel: 'Front cover', description: '', width: info.width, height: info.height, size: bytes.length, bytes };
    } catch {
      return null;
    }
  }

  function effective() {
    return current ? effectiveMeta(current.meta || null, current.metaEdits || null) : null;
  }

  /** Put the current values (file + edits) in the fields, clearing any error. */
  function fillForm() {
    const tags = (effective() || {}).tags || {};
    for (const key of EDIT_KEYS) {
      const { input, err } = fields[key];
      input.value = key === 'date' ? str(tags.date) || str(tags.year) : str(tags[key]);
      input.setAttribute('aria-invalid', 'false');
      err.hidden = true;
    }
  }

  function openEdit() {
    if (!current || editing) return;
    editing = current.id;
    coverErr.hidden = true;
    fillForm();
    form.hidden = false;
    el.classList.add('is-editing');
    editBtn.setAttribute('aria-expanded', 'true');
    bindText(editBtn, 'meta.editDone');
    shownKey = '';
    update(current);
    fields.title.input.focus();
  }

  function closeEdit(focus) {
    if (!editing) return;
    editing = null;
    form.hidden = true;
    el.classList.remove('is-editing');
    editBtn.setAttribute('aria-expanded', 'false');
    bindText(editBtn, 'meta.edit');
    shownKey = '';
    if (current) update(current);
    if (focus) editBtn.focus();
  }

  function bindLabel() {
    coverBtn.setAttribute('aria-label', t(large ? 'meta.coverSmaller' : 'meta.coverLarger'));
  }

  function setCover(pic) {
    if (pic === coverPic) return;
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    coverUrl = null;
    coverPic = pic;
    if (pic) {
      try {
        coverUrl = URL.createObjectURL(new Blob([pic.bytes], { type: pic.mime }));
      } catch {
        coverUrl = null;
      }
    }
    if (coverUrl) img.src = coverUrl;
    else img.removeAttribute('src');
    coverBtn.hidden = !coverUrl;
    coverNone.hidden = !!coverUrl;
    if (!coverUrl && large) {
      large = false;
      el.classList.remove('is-large');
      coverBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function fillRows(dl, list, labelOf) {
    clear(dl);
    for (const r of list) {
      const link = safeLink(r.value);
      const dd = h('dd', {}, link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: r.value }) : r.value);
      dl.append(h('dt', { text: labelOf(r) }), dd);
    }
  }

  /** The extra fields with a remove button each; focus stays in the list after a removal. */
  function fillExtraEdit(list) {
    clear(extraEdit);
    extraEditBox.hidden = !list.length;
    list.forEach((e, i) => {
      const name = e.label || e.key;
      const rm = h('button', { type: 'button', class: 'meta-x', 'i18n-aria-label': ['meta.removeField', { name }], text: '×' });
      rm.addEventListener('click', () => {
        onEdit({ dropExtra: extraId(e) });
        const left = extraEdit.querySelectorAll('.meta-x');
        (left[Math.min(i, left.length - 1)] || doneBtn).focus();
      });
      extraEdit.append(h('li', {}, h('span', { class: 'meta-x-label', text: name }), h('span', { class: 'meta-x-value', text: e.value }), rm));
    });
  }

  function renderKeep() {
    keepSw.setChecked(keepOn);
    bindText(keepHint, keepOn ? 'meta.keepOn' : 'meta.keepOff');
    keepOffNote.hidden = keepOn;
  }

  /**
   * Show `tr` (the active track: { id, name, demo, info, meta, metaState, metaEdits }) or
   * hide the box. Called on every app render: the rows are rebuilt only when the song, its
   * metadata, edits or info, or the language changed, so a focused link (or a screen
   * reader's place) survives; the open form is never refilled while the user types.
   */
  function update(tr) {
    current = tr || null;
    el.hidden = !current;
    if (!current) {
      closeEdit(false);
      setCover(null);
      shownKey = '';
      return;
    }
    if (editing && editing !== current.id) closeEdit(false); // another song: its own data
    const loading = current.metaState === 'loading';
    const meta = effective();
    const carries = carriesMeta(meta);
    const edited = hasEdits(current.metaEdits);
    keepBox.hidden = !carries || !!current.demo || loading;
    editWrap.hidden = !!current.demo;
    editBtn.hidden = false;
    editBtn.disabled = loading;
    editedBadge.hidden = !edited;
    resetBtn.hidden = !edited;
    renderKeep();
    const key = [current.id, current.name, current.demo ? 1 : 0, current.metaState, idOf(meta), idOf(current.info), editing ? 1 : 0, getLanguage()].join('|');
    if (key === shownKey) return;
    shownKey = key;

    const tags = (meta && meta.tags) || {};
    const cover = meta ? pickCover(meta) : null;
    setCover(cover);
    img.alt = t('meta.coverAlt', { title: str(tags.title) || current.name || '' });
    bindLabel();
    title.textContent = str(tags.title) || current.name || '';
    artist.textContent = str(tags.artist);
    artist.hidden = !artist.textContent;
    const albumLine = [str(tags.album), str(tags.year) || str(tags.date)].filter(Boolean).join(' · ');
    album.textContent = albumLine;
    album.hidden = !albumLine;

    // Nothing a master could carry: say so (a source encoder name alone is not metadata).
    note.hidden = !!editing || (!loading && !current.demo && carries);
    if (loading) bindText(note, 'meta.loading');
    else if (current.demo) bindText(note, 'meta.demo');
    else if (!carries) bindText(note, 'meta.none');

    // While the form is open it replaces the read-only rows, lyrics and extra fields.
    fillRows(rows, metaRows(meta), (r) => t(`meta.f.${r.key}`));
    rows.hidden = !!editing || !rows.firstChild;

    const lyr = str(tags.lyrics);
    lyrics.hidden = !!editing || !lyr;
    if (lyr) {
      const n = lyricsLineCount(lyr);
      bindText(lyricsSum, n === 1 ? 'meta.lyrics1' : 'meta.lyrics', { n: formatNumber(n, 0) });
      lyricsText.textContent = lyr;
    } else lyricsText.textContent = '';

    const ex = (meta && meta.extra) || [];
    extra.hidden = !!editing || !ex.length;
    bindText(extraSum, 'meta.extra', { n: formatNumber(ex.length, 0) });
    fillRows(extraRows, ex, (r) => r.label || r.key);
    if (editing) fillExtraEdit(ex);

    bindText(coverPick, cover ? 'meta.coverChange' : 'meta.coverAdd');
    coverDrop.hidden = !cover;

    const tr2 = techRows(current.info, current.meta || null);
    tech.hidden = !tr2.length;
    fillRows(techRowsEl, tr2, (r) => t(`meta.tech.${r.key}`));
  }

  return {
    el,
    update,
    setKeep(on) {
      keepOn = !!on;
      renderKeep();
    },
    /** The switch and the form cannot change during an export (like the format and the rate). */
    setDisabled(d) {
      keepSw.setDisabled(!!d);
      fieldset.disabled = !!d;
    },
    /** Re-translate what is not bound to a key (rows, alt text) after a language change. */
    relabel() {
      shownKey = '';
      if (current) update(current);
    },
    destroy() {
      setCover(null);
    },
  };
}
