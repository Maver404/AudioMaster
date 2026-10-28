// Contextual help (src/ui/help.js): every (i) the UI can show has a complete, short text in
// both languages; every control of the Advanced panel resolves to its own entry; no help
// text is orphaned; the topics placed in the UI source are exactly the registered ones.
// DOM-free: the registry and the lookup are pure, helpButton() returns null in Node.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assert } from './helpers.mjs';
import * as P from '../src/engine/params.js';
import { intensityValue } from '../src/engine/assistant.js';
import { autoEqCurve, THIRD_OCTAVE_HZ } from '../src/dsp/eq.js';
import { STRINGS, LANGUAGES } from '../src/ui/i18n.js';
import { HELP_TOPICS, ADV_HELP_ALIAS, hasHelpText, hasHelpEntry, topicOptions, advancedHelpId, helpIdsInUse, helpButton, advancedHint } from '../src/ui/help.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = ['what', 'when', 'example'];
const OPTIONAL = ['range'];
// Popovers stay small: a phone shows a card without scrolling.
const MAX = { what: 220, when: 200, example: 200, range: 200 };
// Files that place (i) buttons. A topic id is a literal first argument of help( /
// helpButton( / helpBtn( (cut.js), or a `help: '<id>'` property (meters.js rows).
const UI_FILES = ['src/ui/app.js', 'src/ui/meters.js', 'src/ui/cut.js', 'src/ui/controls.js', 'src/ui/metabox.js'];
const PLACED = /\bhelp(?:Button|Btn)?\(\s*'([\w.]+)'|\bhelp:\s*'([\w.]+)'/g;

const missingIn = (id, parts) => {
  const out = [];
  for (const lang of LANGUAGES) for (const part of parts) {
    const v = STRINGS[lang][`help.${id}.${part}`];
    if (typeof v !== 'string' || !v.trim()) out.push(`${lang}:help.${id}.${part}`);
  }
  return out;
};

/** Every number in a text ("−6…+3 dB", "0,5", "1.5") as a JS number. */
const nums = (s) => [...String(s).matchAll(/[−-]?\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace('−', '-').replace(',', '.')));

/** help.<id>.<part> keys (UI chrome help.ui.* excluded) → [{ key, id, part }]. */
function helpKeys(lang) {
  return Object.keys(STRINGS[lang])
    .filter((k) => k.startsWith('help.') && !k.startsWith('help.ui.'))
    .map((key) => ({ key, id: key.slice(5, key.lastIndexOf('.')), part: key.slice(key.lastIndexOf('.') + 1) }));
}

export const tests = {
  'help: every topic the UI places has its texts in it and en (groups: intro + every option)': () => {
    const missing = [];
    let n = 0;
    for (const id of Object.keys(HELP_TOPICS)) {
      const opts = topicOptions(id, P);
      if (opts) {
        assert(opts.length > 0, `${id}: no options`);
        missing.push(...missingIn(id, ['what']));
        for (const o of opts) {
          missing.push(...missingIn(o.id, PARTS));
          assert(typeof STRINGS.it[o.label] === 'string', `${id}: option label ${o.label} is not an i18n key`);
          n++;
        }
      } else {
        missing.push(...missingIn(id, PARTS));
        n++;
      }
      const lab = HELP_TOPICS[id].label;
      assert(typeof lab === 'function' || typeof STRINGS.it[lab] === 'string', `${id}: label ${lab} is not an i18n key`);
    }
    assert(!missing.length, `missing help texts: ${missing.join(', ')}`);
    return `${Object.keys(HELP_TOPICS).length} topics, ${n} entries`;
  },

  'help: every ADVANCED_SECTIONS section and control resolves to its own complete entry': () => {
    const unresolved = [];
    const ids = new Map();
    let n = 0;
    for (const sec of P.ADVANCED_SECTIONS) {
      const sid = advancedHelpId(sec, null, P.ADVANCED_SECTIONS);
      if (!sid) unresolved.push(`section ${sec.id} (${sec.labelKey})`);
      for (const c of sec.controls) {
        n++;
        const id = advancedHelpId(sec, c, P.ADVANCED_SECTIONS);
        if (!id) {
          unresolved.push(`${c.path} (${c.labelKey})`);
          continue;
        }
        // Two different controls must not share one explanation (e.g. three "Quantità").
        if (ids.has(id) && ids.get(id) !== c.path) unresolved.push(`${c.path} shares help.${id} with ${ids.get(id)}`);
        ids.set(id, c.path);
        const miss = missingIn(id, PARTS);
        if (miss.length) unresolved.push(...miss);
      }
    }
    assert(!unresolved.length, `Advanced controls without their own help (add help.<id>.what/.when/.example in i18n.js): ${unresolved.join('; ')}`);
    return `${P.ADVANCED_SECTIONS.length} sections, ${n} controls`;
  },

  'help: no help text is orphaned (every help.<id> key belongs to a shown entry)': () => {
    const { full, intro } = helpIdsInUse(P);
    const bad = [];
    for (const lang of LANGUAGES) {
      for (const { key, id, part } of helpKeys(lang)) {
        if (![...PARTS, ...OPTIONAL].includes(part)) bad.push(`${lang}:${key} (unknown part)`);
        else if (intro.has(id) && part !== 'what') bad.push(`${lang}:${key} (a group has an intro only)`);
        else if (!full.has(id) && !intro.has(id)) bad.push(`${lang}:${key} (unused id)`);
      }
    }
    assert(!bad.length, bad.join(', '));
    return `${full.size} entries + ${intro.size} group intros`;
  },

  'help: texts are non-empty, short and mirrored in English': () => {
    const bad = [];
    const itKeys = helpKeys('it').map((k) => k.key);
    const enKeys = new Set(helpKeys('en').map((k) => k.key));
    for (const k of itKeys) if (!enKeys.has(k)) bad.push(`en missing ${k}`);
    for (const k of enKeys) if (!(k in STRINGS.it)) bad.push(`it missing ${k}`);
    for (const lang of LANGUAGES) {
      for (const { key, part } of helpKeys(lang)) {
        const v = STRINGS[lang][key];
        if (typeof v !== 'string' || !v.trim()) bad.push(`${lang}:${key} empty`);
        else if (MAX[part] && v.length > MAX[part]) bad.push(`${lang}:${key} ${v.length} > ${MAX[part]} chars`);
      }
    }
    for (const k of ['button', 'what', 'when', 'example', 'range', 'close', 'options', 'hint', 'hintClose']) {
      for (const lang of LANGUAGES) if (!String(STRINGS[lang][`help.ui.${k}`] || '').trim()) bad.push(`${lang}:help.ui.${k} missing`);
    }
    for (const lang of LANGUAGES) assert(STRINGS[lang]['help.ui.button'].includes('{label}'), `${lang}: help.ui.button needs {label}`);
    assert(STRINGS.it['help.ui.hint'] === 'Tocca (i) accanto a ogni comando per sapere cosa fa', 'Advanced tip wording');
    assert(!bad.length, bad.join('; '));
  },

  'help: the UI source places exactly the registered topics': async () => {
    const used = new Set();
    for (const f of UI_FILES) {
      const path = join(root, f);
      if (!existsSync(path)) continue;
      const src = await readFile(path, 'utf8');
      for (const m of src.matchAll(PLACED)) used.add(m[1] || m[2]);
    }
    const registered = new Set(Object.keys(HELP_TOPICS));
    const unknown = [...used].filter((id) => !registered.has(id));
    const unplaced = [...registered].filter((id) => !used.has(id));
    assert(!unknown.length, `placed but not in HELP_TOPICS: ${unknown.join(', ')}`);
    assert(!unplaced.length, `registered but never placed in the UI: ${unplaced.join(', ')}`);
    return `${used.size} placed`;
  },

  'help: lookup falls back gracefully for new or renamed controls': () => {
    const sections = [
      {
        id: 'x', labelKey: 'adv.no.such.section',
        controls: [
          { path: 'color.saturation.enabled', type: 'toggle', labelKey: 'adv.saturation' },
          { path: 'color.saturation.drive', type: 'range', labelKey: 'adv.drive', dependsOn: 'color.saturation.enabled' },
          { path: 'spectral.deShimmer.enabled', type: 'toggle', labelKey: 'adv.deShimmer' },
          { path: 'spectral.deShimmer.amount', type: 'range', labelKey: 'adv.amount', dependsOn: 'spectral.deShimmer.enabled' },
          { path: 'dynEq.bands.boom.maxCutDb', type: 'range', labelKey: 'adv.maxCut', dependsOn: 'dynEq.bands.boom.enabled' },
          { path: 'new.thing', type: 'range', labelKey: 'adv.brandNew' },
          { path: 'output.sampleRate', type: 'select', labelKey: 'adv.sampleRate' },
        ],
      },
    ];
    const id = (path) => advancedHelpId(sections[0], sections[0].controls.find((c) => c.path === path), sections);
    assert(advancedHelpId(sections[0], null, sections) === null, 'unknown section → null');
    assert(id('color.saturation.drive') === 'adv.drive', `own label: ${id('color.saturation.drive')}`);
    assert(id('spectral.deShimmer.amount') === 'adv.deShimmer.amount', `generic label under a switch: ${id('spectral.deShimmer.amount')}`);
    // A generic label whose switch is not in the panel has no specific text: no button.
    assert(id('dynEq.bands.boom.maxCutDb') === null, 'generic label without a specific text → null');
    assert(id('new.thing') === null, 'new control without text → null');
    assert(id('output.sampleRate') === ADV_HELP_ALIAS['output.sampleRate'] && hasHelpEntry('export.rate'), 'sample rate → export panel help');
    assert(topicOptions('choice.destination', {}).length === 0, 'missing params list → no options, no crash');
    assert(topicOptions('ab', P) === null, 'single topic → null');
    assert(!hasHelpText('no.such.id') && !hasHelpEntry('no.such.id'));
    // No DOM in Node: the builders return null instead of throwing.
    assert(helpButton('choice.intensity', { P }) === null && advancedHint() === null);
  },

  // The engine owns the ranges: a slider whose min / max changes in params.js must not keep
  // stating the old values (e.g. "0–2 dB" after the clipper went to 0–4 dB).
  'help: every Advanced slider states its real range (params.js min / max)': () => {
    const shown = (v, c) => {
      if (c.unit === '%') return Math.round(v * 100);
      if (c.unit === 'Hz' && c.max >= 1000) return v / 1000; // "2–6 kHz"
      if (c.unit === 'ms' && c.max >= 1000) return v / 1000; // "0–5 s"
      return v;
    };
    const bad = [];
    let n = 0;
    for (const sec of P.ADVANCED_SECTIONS) {
      for (const c of sec.controls) {
        if (c.type !== 'range') continue;
        const id = advancedHelpId(sec, c, P.ADVANCED_SECTIONS);
        if (!id) continue; // reported by the coverage test
        n++;
        for (const lang of LANGUAGES) {
          const s = STRINGS[lang][`help.${id}.range`];
          if (!s) {
            bad.push(`${lang}:help.${id}.range missing (${c.path})`);
            continue;
          }
          const got = nums(s).map(Math.abs);
          for (const v of [c.min, c.max]) if (!got.some((x) => Math.abs(x - Math.abs(shown(v, c))) < 1e-6)) bad.push(`${lang}:help.${id}.range lacks ${shown(v, c)} (${c.path} ${c.min}…${c.max})`);
        }
      }
    }
    assert(!bad.length, bad.join('; '));
    return `${n} sliders`;
  },

  'help: the destination card covers every destination, the "Altro…" ones included': () => {
    const ids = topicOptions('choice.destination', P).map((o) => o.id);
    for (const d of P.DESTINATION_IDS) assert(ids.includes(`dest.${d}`), `dest.${d}`);
    const more = P.DESTINATION_IDS.filter((d) => !P.DESTINATIONS[d].main);
    assert(more.length >= 3 && more.every((d) => hasHelpEntry(`dest.${d}`)), `Altro…: ${more.join(', ')}`);
    // The stated loudness of every destination matches params.js.
    for (const d of P.DESTINATION_IDS) {
      const s = STRINGS.it[`help.dest.${d}.range`] || '';
      const dest = P.DESTINATIONS[d];
      const want = dest.lufsRange ? dest.lufsRange.map((v) => `−${-v}`) : [`−${-dest.lufs}`];
      for (const w of want) assert(s.includes(w), `help.dest.${d}.range should state ${w} LUFS: "${s}"`);
      assert(s.includes(`−${String(-dest.ceilingDb).replace('.', ',')} dBTP`), `help.dest.${d}.range ceiling: "${s}"`);
    }
  },

  // The stereo stage changes only the Side signal (stereo.js; tone.test.mjs "mid never
  // changes"), so L+R is the same before and after. A mono speaker, a phone or a mono club
  // rig hears no difference, so no text may promise one (it did: "più forza su casse mono").
  'help: stereo and mono-lows texts never promise a benefit on mono speakers': () => {
    const KEYS = /^(?:help\.adv\.(?:stereo|stereoOn|width|monoBass)\.\w+|dec\.(?:monoBass|width))$/;
    const PROMISE = {
      it: /più forza|perd\w* forza|sparisc|più potenza|più solid|resti solido/i,
      en: /more power|los\w* power|vanish|stronger|stays solid on a mono/i,
    };
    const DEVICE = { it: /cass[ae] mono|telefon|bluetooth|club|impiant/i, en: /mono speaker|\bphones?\b|bluetooth|club/i }; // "headphones" is fine
    const NO_CHANGE = { it: /non cambia/i, en: /nothing changes|does not change/i };
    const bad = [];
    let n = 0;
    for (const lang of LANGUAGES) {
      for (const [key, v] of Object.entries(STRINGS[lang])) {
        if (!KEYS.test(key)) continue;
        n++;
        if (PROMISE[lang].test(v)) bad.push(`${lang}:${key} promises a mono benefit: "${v}"`);
        else if (DEVICE[lang].test(v) && !NO_CHANGE[lang].test(v)) bad.push(`${lang}:${key} names a mono device without saying nothing changes there: "${v}"`);
      }
    }
    assert(n >= 30, `only ${n} stereo texts matched: did the keys move?`);
    assert(!bad.length, bad.join('; '));
    return `${n} texts`;
  },

  // The English UI is American ("Color", "Analyzing", "Off-center"); Italian help stays in
  // plain words ("ripiano" is a calque of "shelf" that no other text explains).
  'help: English help uses American spelling, Italian help avoids the "ripiano" jargon': () => {
    const BRITISH = /colour|centre|grey|analys(?:e|ed|es|ing)\b|normalis|optimis|behaviour|favour|neighbour|recognis|artefact/i;
    const bad = [];
    for (const [key, v] of Object.entries(STRINGS.en)) {
      if ((key.startsWith('help.') || key.startsWith('dec.')) && BRITISH.test(v)) bad.push(`en:${key} "${v.match(BRITISH)[0]}"`);
    }
    for (const [key, v] of Object.entries(STRINGS.it)) if (key.startsWith('help.') && /ripian/i.test(v)) bad.push(`it:${key} "ripiano"`);
    assert(!bad.length, bad.join('; '));
  },

  // Automatic values the help states, read from the engine instead of trusted by hand.
  'help: the automatic values stated in the texts follow the engine': () => {
    const bad = [];
    const has = (key, v) => {
      for (const lang of LANGUAGES) if (!nums(STRINGS[lang][key]).some((x) => Math.abs(x - v) < 1e-6)) bad.push(`${lang}:${key} should state ${v}`);
    };
    // Rebalance: the per-area cap runs from the lowest intensity's maxDb to autoEqCurve's real
    // clamp (±min(maxDb, 4)), not to the table's top value.
    const bump = THIRD_OCTAVE_HZ.map((_, b) => (b === 17 ? -15 : -30));
    const top = P.INTENSITY_TABLE.autoEqMaxDb.at(-1);
    const cap = Math.round(-Math.min(...autoEqCurve(bump, { strength: 1, maxDb: top })) * 100) / 100;
    has('help.adv.autoEq.strength.what', P.INTENSITY_TABLE.autoEqMaxDb[0]);
    has('help.adv.autoEq.strength.what', cap);
    for (const lang of LANGUAGES) {
      const got = Math.max(...nums(STRINGS[lang]['help.adv.autoEq.strength.what']));
      if (got > cap) bad.push(`${lang}:help.adv.autoEq.strength.what states ${got} dB, the curve stops at ${cap} dB`);
    }
    // The slope is corrected only when a target slope is set; the default (null) keeps it.
    if (typeof P.defaultParams().eq.auto.targetSlopeDbPerOct !== 'number') {
      if (/corregge[^.;]*pendenza/i.test(STRINGS.it['help.adv.autoEq.what'])) bad.push('it:help.adv.autoEq.what claims a slope correction');
      if (/corrects[^.;]*slope/i.test(STRINGS.en['help.adv.autoEq.what'])) bad.push('en:help.adv.autoEq.what claims a slope correction');
    }
    // Clipper: off at Low, on above it, with the Medium amount the card states.
    if (intensityValue('clipperDb', P.INTENSITIES.low) !== 0) bad.push('clipperDb at Low is no longer 0: help.adv.clipper.range says "above Low"');
    has('help.adv.clipper.range', intensityValue('clipperDb', P.INTENSITIES.medium));
    // Harshness band: the default frequency used when the analysis found none.
    has('help.adv.dynHarsh.freq.what', P.defaultParams().dynEq.bands.harsh.freq / 1000);
    // Mono lows per cleanup level.
    for (const lv of ['light', 'medium', 'strong']) has('help.adv.monoBass.range', P.CLEANUP_LEVELS[lv].monoBassHz);
    assert(!bad.length, bad.join('; '));
  },
};
