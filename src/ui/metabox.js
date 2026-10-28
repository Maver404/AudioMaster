// "Metadati" box: the active song's cover art and every tag the file carries (read by
// src/audio/metadata.js), its lyrics, the remaining fields under their original names and
// the technical details, plus the switch that copies cover and tags into the exported
// master. Pure helpers first (DOM-free, tested in Node); createMetaBox() builds the panel
// (nothing touches the DOM at import time). Every value is set as textContent, links only
// for http(s) URLs, and a picture's blob URL is only ever an <img> source.
import { t, getLanguage, formatNumber, formatHz, formatTime } from './i18n.js';
import { h, clear, bindText, toggleSwitch } from './controls.js';
import { withHelp } from './help.js';
import { pickCover, prepareExportMetadata, hasExportMetadata } from '../audio/metadata.js';

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

/**
 * Build the panel.
 * @param {{ help?: (id: string) => HTMLElement|null, keep?: boolean, onKeepChange?: (on: boolean) => void }} [api]
 * @returns {{ el: HTMLElement, update(tr: object|null): void, setKeep(on: boolean): void,
 *   setDisabled(d: boolean): void, relabel(): void, destroy(): void }}
 */
export function createMetaBox({ help = () => null, keep = true, onKeepChange = () => {} } = {}) {
  let coverUrl = null;
  let coverPic = null;
  let current = null; // the track shown
  let shownKey = ''; // what the rows were built from: rebuilt only when it changes
  let large = false;
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

  const el = h(
    'section',
    { class: 'panel meta', id: 'am-meta', 'aria-labelledby': 'am-meta-title', hidden: true },
    h('div', { class: 'panel-head' }, h('div', { class: 'head-l' }, h('h2', { class: 'lbl', id: 'am-meta-title', i18n: 'meta.title' }), help('meta'))),
    h('div', { class: 'meta-head' }, coverBtn, coverNone, h('div', { class: 'meta-id' }, title, artist, album)),
    note,
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

  function renderKeep() {
    keepSw.setChecked(keepOn);
    bindText(keepHint, keepOn ? 'meta.keepOn' : 'meta.keepOff');
  }

  /**
   * Show `tr` (the active track: { id, name, demo, info, meta, metaState }) or hide the box.
   * Called on every app render: the rows are rebuilt only when the song, its metadata or
   * info, or the language changed, so a focused link (or a screen reader's place) survives.
   */
  function update(tr) {
    current = tr || null;
    el.hidden = !current;
    if (!current) {
      setCover(null);
      shownKey = '';
      return;
    }
    const meta = current.meta || null;
    const loading = current.metaState === 'loading';
    const carries = carriesMeta(meta);
    keepBox.hidden = !carries || !!current.demo || loading;
    renderKeep();
    const key = [current.id, current.name, current.demo ? 1 : 0, current.metaState, idOf(meta), idOf(current.info), getLanguage()].join('|');
    if (key === shownKey) return;
    shownKey = key;

    const tags = (meta && meta.tags) || {};
    setCover(meta ? pickCover(meta) : null);
    img.alt = t('meta.coverAlt', { title: str(tags.title) || current.name || '' });
    bindLabel();
    title.textContent = str(tags.title) || current.name || '';
    artist.textContent = str(tags.artist);
    artist.hidden = !artist.textContent;
    const albumLine = [str(tags.album), str(tags.year) || str(tags.date)].filter(Boolean).join(' · ');
    album.textContent = albumLine;
    album.hidden = !albumLine;

    // Nothing a master could carry: say so (a source encoder name alone is not metadata).
    note.hidden = !loading && !current.demo && carries;
    if (loading) bindText(note, 'meta.loading');
    else if (current.demo) bindText(note, 'meta.demo');
    else if (!carries) bindText(note, 'meta.none');

    fillRows(rows, metaRows(meta), (r) => t(`meta.f.${r.key}`));
    rows.hidden = !rows.firstChild;

    const lyr = str(tags.lyrics);
    lyrics.hidden = !lyr;
    if (lyr) {
      const n = lyricsLineCount(lyr);
      bindText(lyricsSum, n === 1 ? 'meta.lyrics1' : 'meta.lyrics', { n: formatNumber(n, 0) });
      lyricsText.textContent = lyr;
    } else lyricsText.textContent = '';

    const ex = (meta && meta.extra) || [];
    extra.hidden = !ex.length;
    bindText(extraSum, 'meta.extra', { n: formatNumber(ex.length, 0) });
    fillRows(extraRows, ex, (r) => r.label || r.key);

    const tr2 = techRows(current.info, meta);
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
    /** The switch cannot change during an export (like the format and the rate). */
    setDisabled(d) {
      keepSw.setDisabled(!!d);
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
