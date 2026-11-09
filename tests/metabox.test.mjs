// "Metadati" box (src/ui/metabox.js): the DOM-free helpers behind it — which tags become
// rows and in what order, which values may become links, the lyrics line count, picture
// labels and the technical rows, the user's edits (validation, patches, the merged
// metadata a master carries, read back from a real WAV) — plus the strings it uses.
import { assert } from './helpers.mjs';
import {
  META_ROW_KEYS, hasMeta, carriesMeta, metaRows, safeLink, lyricsLineCount, pictureLabel, techRows,
  EDIT_KEYS, validateTag, patchEdits, effectiveMeta, extraId, hasEdits,
} from '../src/ui/metabox.js';
import { TAG_KEYS, readMetadata, sniffImage } from '../src/audio/metadata.js';
import { encodeWav } from '../src/export/wav.js';
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
    const keys = ['meta.title', 'meta.loading', 'meta.none', 'meta.demo', 'meta.coverAlt', 'meta.coverLarger', 'meta.coverSmaller', 'meta.lyrics', 'meta.lyrics1', 'meta.extra',
      'meta.edit', 'meta.editDone', 'meta.edited', 'meta.editLegend', 'meta.reset', 'meta.coverChange', 'meta.coverAdd', 'meta.coverRemove', 'meta.coverBad',
      'meta.extraEdit', 'meta.removeField', 'meta.editKeepOff', 'meta.ph.date', 'meta.ph.track', 'meta.ph.isrc', 'meta.ph.bpm',
      'meta.bad.date', 'meta.bad.track', 'meta.bad.disc', 'meta.bad.bpm', 'meta.bad.isrc', 'meta.bad.long', 'meta.tech', 'meta.keep', 'meta.keepOn', 'meta.keepOff', 'meta.mono', 'meta.stereo'];
    for (const k of [...META_ROW_KEYS, ...EDIT_KEYS]) keys.push(`meta.f.${k}`);
    for (const k of ['format', 'sampleRate', 'bitDepth', 'bitrate', 'channels', 'duration', 'size', 'tags', 'pictures']) keys.push(`meta.tech.${k}`);
    const missing = [];
    for (const lang of LANGUAGES) for (const k of keys) if (!String(STRINGS[lang][k] || '').trim()) missing.push(`${lang}:${k}`);
    assert(!missing.length, missing.join(', '));
    for (const lang of LANGUAGES) {
      assert(STRINGS[lang]['meta.lyrics'].includes('{n}') && STRINGS[lang]['meta.extra'].includes('{n}') && STRINGS[lang]['meta.coverAlt'].includes('{title}'), `${lang} placeholders`);
    }
  },

  'metabox edits: field validation (empty is always fine; dates, numbers, ISRC, length)': () => {
    for (const k of EDIT_KEYS) assert(TAG_KEYS.includes(k), `${k} is not a tag key`);
    const ok = { date: ['2025', '2025-04', '2025-04-11', ''], track: ['3', '3/12', ' 12 '], disc: ['1', '1/2'], bpm: ['120', '98.5', '128,25'], isrc: ['IT-ABC-25-00001', 'ITABC2500001', 'us-z03-98-00212'], title: ['Notte di luglio'] };
    const bad = { date: ['25', '2025-13-01', '2025-04-32', '11/04/2025', 'ieri'], track: ['3 di 12', 'x', '3/'], disc: ['uno'], bpm: ['veloce', '1', '1200'], isrc: ['IT-ABC-25-0001', 'ABC'] };
    for (const [k, list] of Object.entries(ok)) for (const v of list) assert(validateTag(k, v) === null, `${k} "${v}" refused`);
    for (const [k, list] of Object.entries(bad)) for (const v of list) assert(validateTag(k, v) === `meta.bad.${k}`, `${k} "${v}" accepted: ${validateTag(k, v)}`);
    assert(validateTag('title', 'x'.repeat(301)) === 'meta.bad.long' && validateTag('lyrics', 'x'.repeat(5000)) === null, 'lengths');
  },

  'metabox edits: patches never mutate, a value back to the file’s is no edit, reset drops all': () => {
    const meta = { ...empty, tags: { title: 'Bozza', artist: 'Ünïcode Årtist' }, extra: [{ key: 'WOAS', label: 'Link', value: 'https://example.com/1' }] };
    let e = patchEdits(meta, null, { tag: 'title', value: '  Notte di luglio  ' });
    assert(e && e.tags.title === 'Notte di luglio' && hasEdits(e), JSON.stringify(e));
    const before = JSON.stringify(e);
    const e2 = patchEdits(meta, e, { tag: 'artist', value: '' });
    assert(JSON.stringify(e) === before && e2.tags.artist === '' && e2.tags.title === 'Notte di luglio', 'immutable');
    assert(patchEdits(meta, e, { tag: 'title', value: 'Bozza' }) === null, 'back to the file value: no edits left');
    assert(patchEdits(meta, e2, { tag: 'encoder', value: 'x' }).tags.encoder === undefined, 'encoder is not editable');
    const e3 = patchEdits(meta, e2, { dropExtra: extraId(meta.extra[0]) });
    assert(e3.dropExtra.length === 1 && patchEdits(meta, e3, { dropExtra: extraId(meta.extra[0]) }).dropExtra.length === 1, 'drop once');
    assert(patchEdits(meta, e3, { reset: true }) === null && patchEdits(meta, e3, null) === null, 'reset');
    assert(hasEdits(patchEdits(meta, null, { cover: null })), 'cover removal is an edit');
  },

  'metabox edits: effectiveMeta merges tags, date / year, cover and removed fields; cached': () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const old = { mime: 'image/jpeg', type: 3, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) };
    const meta = { ...empty, tags: { title: 'Bozza', date: '2025-04-11', year: '2025' }, extra: [{ key: 'WOAS', label: 'Link', value: 'https://example.com/1' }, { key: 'TXXX:x', label: 'x', value: 'y' }], pictures: [old] };
    assert(effectiveMeta(meta, null) === meta && effectiveMeta(null, null) === null, 'no edits: the file itself');
    let e = patchEdits(meta, null, { tag: 'date', value: '2024' });
    e = patchEdits(meta, e, { tag: 'title', value: 'Notte di luglio' });
    e = patchEdits(meta, e, { dropExtra: extraId(meta.extra[0]) });
    const cover = { mime: 'image/png', type: 3, width: 1, height: 1, size: png.length, bytes: png };
    e = patchEdits(meta, e, { cover });
    const m = effectiveMeta(meta, e);
    assert(m.tags.title === 'Notte di luglio' && m.tags.date === '2024' && m.tags.year === '2024', JSON.stringify(m.tags));
    assert(m.extra.length === 1 && m.extra[0].key === 'TXXX:x' && m.pictures.length === 1 && m.pictures[0] === cover, 'extra / cover');
    assert(meta.tags.title === 'Bozza' && meta.pictures[0] === old && meta.extra.length === 2, 'the file data is untouched');
    assert(effectiveMeta(meta, e) === m, 'same inputs, same object');
    assert(effectiveMeta(meta, patchEdits(meta, null, { cover: null })).pictures.length === 0, 'cover removed');
    const fromNothing = effectiveMeta(null, patchEdits(null, null, { tag: 'artist', value: 'Ünïcode Årtist' }));
    assert(fromNothing.tags.artist === 'Ünïcode Årtist' && carriesMeta(fromNothing) && !carriesMeta(empty), 'a file without metadata gets some');
    assert(sniffImage(png).mime === 'image/png' && sniffImage(new Uint8Array(20)) === null, 'cover sniffing');
  },

  'metabox edits: a WAV master carries the edited title, date, cover and fields (read back)': async () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const meta = { ...empty, tagTypes: ['ID3v2.3'], tags: { title: 'Bozza', artist: 'Ünïcode Årtist', date: '2025', year: '2025', lyrics: 'Prima riga' }, extra: [{ key: 'WOAS', label: 'Link', value: 'https://example.com/1' }, { key: 'TXXX:Studio', label: 'Studio', value: 'Casa' }] };
    let e = patchEdits(meta, null, { tag: 'title', value: 'Notte di luglio' });
    e = patchEdits(meta, e, { tag: 'date', value: '2024-07-15' });
    e = patchEdits(meta, e, { tag: 'lyrics', value: 'Riga uno\r\nRiga due' });
    e = patchEdits(meta, e, { tag: 'artist', value: '' });
    e = patchEdits(meta, e, { tag: 'comment', value: 'Master per il distributore\nVersione 2' });
    e = patchEdits(meta, e, { dropExtra: extraId(meta.extra[0]) });
    e = patchEdits(meta, e, { cover: { mime: 'image/png', type: 3, width: 1, height: 1, size: png.length, bytes: png } });
    const sr = 44100;
    const ch = new Float32Array(sr / 10);
    const blob = encodeWav({ sampleRate: sr, channels: [ch, ch] }, { bitDepth: 16, metadata: effectiveMeta(meta, e) });
    const back = await readMetadata(blob);
    assert(back.tags.title === 'Notte di luglio' && back.tags.date === '2024-07-15' && back.tags.lyrics === 'Riga uno\nRiga due', JSON.stringify(back.tags));
    assert(!back.tags.artist && back.tags.encoder === 'AudioMaster', `artist removed, encoder ${back.tags.encoder}`);
    assert(back.tags.comment === 'Master per il distributore\nVersione 2', `comment ${JSON.stringify(back.tags.comment)}`);
    const keys = back.extra.map((x) => x.key);
    assert(!keys.includes('WOAS') && keys.includes('TXXX:Studio'), JSON.stringify(keys));
    assert(back.pictures.length === 1 && back.pictures[0].mime === 'image/png' && back.pictures[0].type === 3, JSON.stringify(back.pictures.map((p) => [p.mime, p.type])));
  },
};
