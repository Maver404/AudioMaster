// "Metadati" box (src/ui/metabox.js): the DOM-free helpers behind it — which tags become
// rows and in what order, which values may become links, the lyrics line count, picture
// labels and the technical rows — plus the strings it uses in both languages.
import { assert } from './helpers.mjs';
import { META_ROW_KEYS, hasMeta, carriesMeta, metaRows, safeLink, lyricsLineCount, pictureLabel, techRows } from '../src/ui/metabox.js';
import { TAG_KEYS } from '../src/audio/metadata.js';
import { STRINGS, LANGUAGES, setLanguage, getLanguage } from '../src/ui/i18n.js';

const empty = { format: 'wav', tagTypes: [], tags: {}, extra: [], pictures: [], warnings: [] };

export const tests = {
  'metabox: every tag key is shown somewhere (head, rows or lyrics) and rows keep TAG_KEYS order': () => {
    const head = ['title', 'artist', 'album', 'year', 'lyrics'];
    for (const k of TAG_KEYS) assert(head.includes(k) || META_ROW_KEYS.includes(k), `${k} is never shown`);
    for (const k of META_ROW_KEYS) assert(TAG_KEYS.includes(k), `${k} is not a tag key`);
    const order = META_ROW_KEYS.map((k) => TAG_KEYS.indexOf(k));
    assert(order.every((v, i) => i === 0 || v > order[i - 1]), 'rows out of TAG_KEYS order');
  },

  'metabox: rows skip the head fields, empty values and unknown keys': () => {
    const meta = { ...empty, tags: { title: 'T', artist: 'A', genre: 'Pop', comment: '  ', track: '3/10', bogus: 'x', lyrics: 'a\nb' } };
    const rows = metaRows(meta);
    assert(JSON.stringify(rows) === JSON.stringify([{ key: 'track', value: '3/10' }, { key: 'genre', value: 'Pop' }]), JSON.stringify(rows));
    assert(metaRows(null).length === 0 && metaRows(empty).length === 0, 'no meta');
  },

  'metabox: hasMeta is true for tags, extra fields or pictures only': () => {
    assert(!hasMeta(null) && !hasMeta(empty) && !hasMeta({ ...empty, tags: { title: ' ' } }), 'empty');
    assert(hasMeta({ ...empty, tags: { title: 'x' } }), 'tag');
    assert(hasMeta({ ...empty, extra: [{ key: 'WOAS', label: 'l', value: 'https://a.b' }] }), 'extra');
    assert(hasMeta({ ...empty, pictures: [{ mime: 'image/png', bytes: new Uint8Array(1) }] }), 'picture');
  },

  'metabox: the copy switch is about what a master would really get (not a source encoder name)': () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    assert(!carriesMeta(null) && !carriesMeta(empty), 'nothing');
    assert(!carriesMeta({ ...empty, tags: { encoder: 'Lavf62.12.101' } }), 'encoder only');
    assert(!carriesMeta({ ...empty, pictures: [{ mime: 'application/octet-stream', type: 3, typeLabel: 'Front cover', description: '', width: null, height: null, size: 4, bytes: new Uint8Array(4) }] }), 'non-image picture only');
    assert(carriesMeta({ ...empty, tags: { title: 'T' } }), 'title');
    assert(carriesMeta({ ...empty, pictures: [{ mime: 'image/png', type: 3, typeLabel: 'Front cover', description: '', width: 1, height: 1, size: png.length, bytes: png }] }), 'cover');
  },

  'metabox: only plain http(s) URLs become links': () => {
    assert(safeLink('https://suno.com/song/abc') === 'https://suno.com/song/abc', 'https');
    assert(safeLink(' http://example.com/a?b=1 ') === 'http://example.com/a?b=1', 'http, trimmed');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'blob:https://x/y', 'ftp://x.y', 'https://a b', 'see https://x.y', '//x.y', '', null, 42, 'https://x"y']) {
      assert(safeLink(bad) === null, `${bad} became a link`);
    }
  },

  'metabox: lyrics line count and picture labels': () => {
    assert(lyricsLineCount('') === 0 && lyricsLineCount(null) === 0 && lyricsLineCount('one') === 1 && lyricsLineCount('a\nb\n\nc\n') === 4, 'lines');
    assert(pictureLabel({ mime: 'image/jpeg', width: 360, height: 360 }) === 'JPEG 360×360', 'jpeg');
    assert(pictureLabel({ mime: 'image/png', width: null, height: null }) === 'PNG', 'no size');
    assert(pictureLabel({}) === '?', 'nothing');
  },

  'metabox: technical rows from the decode info and the tag types, in both languages': () => {
    const prev = getLanguage();
    try {
      const info = { format: 'mp3', codec: 'mp3', sampleRate: 48000, nativeSampleRate: 44100, bitDepth: null, bitrateKbps: 192.4, decodedChannels: 2, duration: 125.4, sizeBytes: 3 * 1048576 };
      const meta = { ...empty, tagTypes: ['ID3v2.3', 'ID3v1.1'], pictures: [{ mime: 'image/jpeg', width: 360, height: 360 }, { mime: 'image/png', width: 1024, height: 1024 }] };
      setLanguage('en');
      const rows = Object.fromEntries(techRows(info, meta).map((r) => [r.key, r.value]));
      assert(rows.format === 'MP3' && rows.bitrate === '192 kbps' && rows.channels === 'Stereo' && rows.size === '3.0 MB', JSON.stringify(rows));
      assert(/44[.,]1/.test(rows.sampleRate) && !('bitDepth' in rows) && /2:0?5/.test(rows.duration), JSON.stringify(rows));
      assert(rows.tags === 'ID3v2.3, ID3v1.1' && rows.pictures === 'JPEG 360×360, PNG 1024×1024', JSON.stringify(rows));
      setLanguage('it');
      const it = Object.fromEntries(techRows({ format: 'wav', codec: 'pcm', sampleRate: 44100, bitDepth: 24, decodedChannels: 1, sizeBytes: 0 }, null).map((r) => [r.key, r.value]));
      assert(it.format === 'WAV (pcm)' && it.bitDepth === '24-bit' && it.channels === 'Mono' && !('size' in it) && !('tags' in it), JSON.stringify(it));
      assert(techRows(null, null).length === 0, 'nothing to show');
    } finally {
      setLanguage(prev);
    }
  },

  'metabox: every string it uses exists in it and en': () => {
    const keys = ['meta.title', 'meta.loading', 'meta.none', 'meta.demo', 'meta.coverAlt', 'meta.coverLarger', 'meta.coverSmaller', 'meta.lyrics', 'meta.lyrics1', 'meta.extra', 'meta.tech', 'meta.keep', 'meta.keepOn', 'meta.keepOff', 'meta.mono', 'meta.stereo'];
    for (const k of META_ROW_KEYS) keys.push(`meta.f.${k}`);
    for (const k of ['format', 'sampleRate', 'bitDepth', 'bitrate', 'channels', 'duration', 'size', 'tags', 'pictures']) keys.push(`meta.tech.${k}`);
    const missing = [];
    for (const lang of LANGUAGES) for (const k of keys) if (!String(STRINGS[lang][k] || '').trim()) missing.push(`${lang}:${k}`);
    assert(!missing.length, missing.join(', '));
    for (const lang of LANGUAGES) {
      assert(STRINGS[lang]['meta.lyrics'].includes('{n}') && STRINGS[lang]['meta.extra'].includes('{n}') && STRINGS[lang]['meta.coverAlt'].includes('{title}'), `${lang} placeholders`);
    }
  },
};
