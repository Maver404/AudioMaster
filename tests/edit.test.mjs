// Cut tool: edit-list algebra (src/audio/edit.js), the rendered edit (crossfaded joins,
// exact lengths, mono / stereo), clips with fades, and the cut bar's DOM-free helpers
// (timecode parsing / formatting, clip file names, key gating).
import { assert, approx } from './helpers.mjs';
import {
  EDIT_CROSSFADE_SEC, MIN_SELECTION_SEC, MIN_RESULT_SEC, fullEdit, normalizeEdit, editLength, isFullEdit, editedToSource, sourceToEdited,
  sliceEdit, editProblem, snapEdges, keepOnly, removeRange, applyEdit, sliceAudio,
} from '../src/audio/edit.js';
import { parseTimecode, formatTimecode, clipFileName, cutKeyAllowed, selectionToEdited } from '../src/ui/cut.js';

const SR = 48000;

/** Sample-index ramp: every output sample says which source frame it came from. */
function ramp(n, channels = 2) {
  const chs = [];
  for (let c = 0; c < channels; c++) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = c === 0 ? i : -i;
    chs.push(a);
  }
  return { sampleRate: SR, channels: chs };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const tests = {
  'edit: full list, normalize (sort, clamp, merge overlapping and adjacent), length': () => {
    assert(eq(fullEdit(1000), [[0, 1000]]) && eq(fullEdit(0), []), 'fullEdit');
    assert(eq(normalizeEdit([[500, 600], [0, 100], [100, 200], [550, 700], [-5, 2], [900, 900], [950, 2000]], 1000), [[0, 200], [500, 700], [950, 1000]]), 'normalize');
    assert(editLength([[0, 200], [500, 700]]) === 400, 'length');
    assert(isFullEdit(null, 10) && isFullEdit([[0, 10]], 10) && !isFullEdit([[0, 9]], 10) && !isFullEdit([[0, 5], [6, 10]], 10), 'isFull');
  },

  'edit: time mapping round-trips (edited → source → edited exact; kept source → edited → source exact; gaps map to the join)': () => {
    const list = [[100, 400], [1000, 1100], [5000, 5600]];
    const total = editLength(list);
    assert(total === 1000, 'total');
    for (let e = 0; e < total; e++) {
      const s = editedToSource(list, e);
      assert(sourceToEdited(list, s) === e, `round trip at edited ${e}`);
    }
    for (const [a, b] of list) for (let s = a; s < b; s += 7) assert(editedToSource(list, sourceToEdited(list, s)) === s, `round trip at source ${s}`);
    assert(editedToSource(list, 0) === 100 && editedToSource(list, 299) === 399 && editedToSource(list, 300) === 1000 && editedToSource(list, 400) === 5000, 'piecewise');
    assert(editedToSource(list, -3) === 100 && editedToSource(list, total) === 5600 && editedToSource(list, 1e9) === 5600, 'clamped ends');
    assert(sourceToEdited(list, 0) === 0 && sourceToEdited(list, 700) === 300 && sourceToEdited(list, 4000) === 400 && sourceToEdited(list, 9999) === total, 'gaps → joins');
  },

  'edit: keepOnly / removeRange compose, undo is the previous list, edges at 0 and at the end': () => {
    const n = 10 * SR;
    const full = fullEdit(n);
    const opts = { sampleRate: SR };
    // Remove 2–3 s, then keep 1–5 s of the result (edited time), then remove the head.
    const l1 = removeRange(full, 2 * SR, 3 * SR, opts);
    assert(eq(l1, [[0, 2 * SR], [3 * SR, n]]) && editLength(l1) === 9 * SR, `remove: ${JSON.stringify(l1)}`);
    const l2 = keepOnly(l1, 1 * SR, 5 * SR, opts);
    assert(eq(l2, [[1 * SR, 2 * SR], [3 * SR, 6 * SR]]) && editLength(l2) === 4 * SR, `keep across a join: ${JSON.stringify(l2)}`);
    const l3 = removeRange(l2, 0, 0.5 * SR, opts);
    assert(eq(l3, [[1.5 * SR, 2 * SR], [3 * SR, 6 * SR]]), `remove at 0: ${JSON.stringify(l3)}`);
    const l4 = removeRange(l3, editLength(l3) - SR, editLength(l3), opts);
    assert(eq(l4, [[1.5 * SR, 2 * SR], [3 * SR, 5 * SR]]), `remove at the end: ${JSON.stringify(l4)}`);
    // Undo = the previous list, untouched by later edits (immutability).
    assert(eq(l1, [[0, 2 * SR], [3 * SR, n]]) && eq(l2, [[1 * SR, 2 * SR], [3 * SR, 6 * SR]]), 'older lists unchanged');
    // Removing exactly across a join merges nothing it should not; removing a join's two
    // sides back to back re-joins adjacent source (merged into one range).
    const back = normalizeEdit([...sliceEdit(l1, 0, 2 * SR), ...sliceEdit(l1, 2 * SR, editLength(l1))]);
    assert(eq(back, l1), 'slices reassemble the list');
    const keepAll = keepOnly(l1, 0, editLength(l1), opts);
    assert(keepAll === null && editProblem(l1, 'keep', 0, editLength(l1), opts) === 'noop', 'keeping everything is a no-op');
    // Selections reaching past the ends are clamped.
    assert(eq(keepOnly(full, -5 * SR, 2 * SR, opts), [[0, 2 * SR]]) && eq(removeRange(full, 8 * SR, 99 * SR, opts), [[0, 8 * SR]]), 'clamped selections');
  },

  'edit: empty or tiny selections and edits that leave too little are rejected': () => {
    const full = fullEdit(10 * SR);
    const opts = { sampleRate: SR };
    const tiny = Math.round(MIN_SELECTION_SEC * SR) - 1;
    assert(editProblem(full, 'remove', 100, 100, opts) === 'tiny' && removeRange(full, 100, 100, opts) === null, 'empty');
    assert(editProblem(full, 'keep', 5000, 5000 + tiny, opts) === 'tiny' && keepOnly(full, 5000, 5000 + tiny, opts) === null, 'tiny');
    assert(editProblem(full, 'remove', 300, 200, opts) === 'tiny', 'reversed');
    assert(editProblem(full, 'remove', NaN, 200, opts) === 'tiny', 'NaN');
    assert(editProblem(full, 'remove', 5000, 5000 + tiny + 1, opts) === null, 'just long enough');
    const keepShort = Math.round(MIN_RESULT_SEC * SR) - 10;
    assert(editProblem(full, 'keep', 0, keepShort, opts) === 'tooShort' && keepOnly(full, 0, keepShort, opts) === null, 'keep too short');
    assert(editProblem(full, 'remove', 0, 10 * SR, opts) === 'tooShort' && removeRange(full, 0, 10 * SR - keepShort, opts) === null, 'remove everything / too much');
    assert(editProblem(full, 'remove', 0, 9 * SR, opts) === null, 'leaves exactly the minimum');
  },

  'edit: applyEdit — exact length, kept samples untouched away from joins, joins crossfaded (mono and stereo)': () => {
    const n = 4 * SR;
    for (const channels of [1, 2]) {
      const src = ramp(n, channels);
      const list = [[0, SR], [2 * SR, 3 * SR], [3.5 * SR, 4 * SR]];
      const out = applyEdit(src, list);
      assert(out.channels.length === channels && out.sampleRate === SR, 'shape');
      assert(out.channels[0].length === editLength(list) && out.channels[0].length === 2.5 * SR, `length ${out.channels[0].length}`);
      const h = Math.floor((EDIT_CROSSFADE_SEC * SR) / 2);
      // Far from the joins every sample is the mapped source sample (time map is exact).
      for (let e = 0; e < out.channels[0].length; e += 97) {
        const nearJoin = [SR, 2 * SR].some((j) => Math.abs(e - j) <= h);
        if (nearJoin) continue;
        const s = editedToSource(list, e);
        assert(out.channels[0][e] === s, `sample ${e}: ${out.channels[0][e]} vs ${s}`);
        if (channels === 2) assert(out.channels[1][e] === -s, 'right channel');
      }
      assert(src.channels[0][123] === 123, 'input untouched');
    }
  },

  'edit: crossfade continuity — no jump bigger than the gain slope allows at a join (DC step and sine)': () => {
    const n = 3 * SR;
    // Two DC levels: a hard cut would jump by 1.0.
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = i < 1.5 * SR ? 0.5 : -0.5;
    const out = applyEdit({ sampleRate: SR, channels: [L, L.slice()] }, [[0, SR], [2 * SR, 3 * SR]]);
    const y = out.channels[0];
    const h = Math.floor((EDIT_CROSSFADE_SEC * SR) / 2);
    let maxJump = 0;
    for (let i = 1; i < y.length; i++) maxJump = Math.max(maxJump, Math.abs(y[i] - y[i - 1]));
    // Equal-power gains over 2h frames: per-frame change ≤ (π/2)/(2h) per unit of level.
    const bound = (Math.PI / 2 / (2 * h)) * 1.0 + 1e-6;
    assert(maxJump <= bound, `max jump ${maxJump} > ${bound}`);
    assert(Math.abs(y[SR - h - 1] - 0.5) < 1e-7 && Math.abs(y[SR + h] + 0.5) < 1e-7, 'outside the fade: pure sides');
    approx(y[SR - 1] + y[SR], 0, 0.01, 'symmetric around the join');
    // Sine with a phase jump at the cut: step stays near the sine's own slope.
    const f = 440;
    const S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = 0.8 * Math.sin((2 * Math.PI * f * i) / SR);
    const cutAt = 1.0;
    const resume = 2.0 + 0.37 / f; // 0.37 cycles of phase jump
    const ys = applyEdit({ sampleRate: SR, channels: [S] }, [[0, cutAt * SR], [Math.round(resume * SR), n]]).channels[0];
    const slope = 0.8 * 2 * Math.PI * f / SR;
    let mj = 0;
    for (let i = 1; i < ys.length; i++) mj = Math.max(mj, Math.abs(ys[i] - ys[i - 1]));
    // Bound: signal slope through gains summing to ≤ √2, plus the gain slope on ≤ 0.8·√2.
    assert(mj <= slope * Math.SQRT2 + bound * 0.8 * Math.SQRT2 + 1e-6, `sine join jump ${mj} (own slope ${slope})`);
    // Hard cut for comparison would jump much more.
    const hard = applyEdit({ sampleRate: SR, channels: [S] }, [[0, cutAt * SR], [Math.round(resume * SR), n]], { crossfadeSec: 0 }).channels[0];
    let hj = 0;
    for (let i = 1; i < hard.length; i++) hj = Math.max(hj, Math.abs(hard[i] - hard[i - 1]));
    assert(hj > mj * 3, `crossfade reduces the click (${hj} → ${mj})`);
  },

  'edit: joins near the source edges and very short pieces stay in range (no out-of-bounds reads)': () => {
    const src = ramp(1000, 1);
    // A 4-frame piece between two joins: the fade shrinks to fit it.
    const out = applyEdit(src, [[0, 300], [302, 306], [700, 1000]], { crossfadeSec: 0.01 });
    assert(out.channels[0].length === 604, `length ${out.channels[0].length}`);
    for (const v of out.channels[0]) assert(Number.isFinite(v), 'finite');
    // Piece starting at frame 0 after a join and ending at the source end.
    const o2 = applyEdit(src, [[0, 10], [990, 1000]], { crossfadeSec: 1 });
    assert(o2.channels[0].length === 20 && o2.channels[0].every(Number.isFinite), 'tiny edges');
  },

  'edit: an edge a few frames from an earlier join (or the song ends) snaps onto it: no sliver piece, no click at the joins': () => {
    const n = 20 * SR;
    const opts = { sampleRate: SR };
    const tol = Math.round(EDIT_CROSSFADE_SEC * SR);
    const half = Math.floor((EDIT_CROSSFADE_SEC * SR) / 2);
    const f = 440;
    const S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = 0.8 * Math.sin((2 * Math.PI * f * i) / SR);
    const sine = { sampleRate: SR, channels: [S] };
    const slope = (0.8 * 2 * Math.PI * f) / SR;
    const maxJump = (y) => {
      let m = 0;
      for (let i = 1; i < y.length; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1]));
      return m;
    };
    const l1 = removeRange(fullEdit(n), 5 * SR, 6 * SR + 137, opts); // a join at edited 5 s
    const join = 5 * SR;
    assert(eq(l1, [[0, join], [6 * SR + 137, n]]), JSON.stringify(l1));
    const clean = [[0, 3 * SR], [6 * SR + 137, n]];
    // The bit right before the earlier cut, missed by a few frames: the end edge lands on
    // the join instead of leaving a 1–40-frame piece between two joins (that clicked).
    for (const sliver of [1, 3, 10, 40, tol]) {
      const l2 = removeRange(l1, 3 * SR, join - sliver, opts);
      assert(eq(l2, clean), `sliver ${sliver}: ${JSON.stringify(l2)}`);
      const mj = maxJump(applyEdit(sine, l2).channels[0]);
      assert(mj < slope * 1.1, `sliver ${sliver}: max jump ${mj} vs the sine's own slope ${slope}`);
    }
    // Just after the join (start edge), and keepOnly too.
    assert(eq(removeRange(l1, join + 7, 8 * SR, opts), [[0, join], [9 * SR + 137, n]]), 'start edge snapped onto the join');
    assert(eq(keepOnly(l1, join - 5, 8 * SR, opts), [[6 * SR + 137, 9 * SR + 137]]), 'keep from just before the join');
    // Farther than one crossfade: left alone, and the piece is long enough for full fades.
    const far = removeRange(l1, 3 * SR, join - tol - 1, opts);
    assert(eq(far, [[0, 3 * SR], [join - tol - 1, join], [6 * SR + 137, n]]) && far[1][1] - far[1][0] >= 2 * half, JSON.stringify(far));
    // Near the song's start / end: snapped there (no sliver as the song's first / last frames).
    assert(eq(removeRange(fullEdit(n), 100, 2 * SR, opts), [[2 * SR, n]]), 'start of the song');
    assert(eq(removeRange(fullEdit(n), 5 * SR, n - 100, opts), [[0, 5 * SR]]), 'end of the song');
    assert(editProblem(fullEdit(n), 'keep', 100, n - 100, opts) === 'noop', 'keep "everything but a few frames" is everything');
    // A selection that collapses onto one join is too short; snapEdges tells where an edit lands.
    assert(editProblem(l1, 'remove', join - 30, join + 30, opts) === 'tiny', 'collapsed selection');
    const se = snapEdges(l1, 3 * SR, join - 3, opts);
    assert(se.e0 === 3 * SR && se.e1 === join, JSON.stringify(se));
    // Without a sample rate the algebra stays frame-exact (no snapping).
    assert(eq(removeRange(l1, 3 * SR, join - 3), [[0, 3 * SR], [join - 3, join], [6 * SR + 137, n]]), 'no snapping without a rate');
  },

  'edit: fuzz — random keep / remove sequences aimed at earlier joins never leave a piece shorter than a full crossfade': () => {
    const sr = 1000; // small rate: the edited content can be checked frame by frame
    const n = 20 * sr;
    const opts = { sampleRate: sr };
    const tol = Math.round(EDIT_CROSSFADE_SEC * sr);
    const half = Math.floor((EDIT_CROSSFADE_SEC * sr) / 2);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 4294967296;
    };
    const joins = (list) => {
      const out = [];
      let cum = 0;
      for (let k = 0; k + 1 < list.length; k++) out.push((cum += list[k][1] - list[k][0]));
      return out;
    };
    // An edge: anywhere, or a few frames either side of a join / the ends (the near misses).
    const edge = (list, total) => {
      const js = [0, ...joins(list), total];
      if (rnd() < 0.5) return Math.floor(rnd() * total);
      const j = js[Math.floor(rnd() * js.length)];
      return Math.max(0, Math.min(total, j + Math.round((rnd() - 0.5) * 4 * tol)));
    };
    let edits = 0;
    for (let trial = 0; trial < 300; trial++) {
      let list = fullEdit(n);
      for (let step = 0; step < 8; step++) {
        const total = editLength(list);
        const kind = rnd() < 0.5 ? 'keep' : 'remove';
        let e0 = edge(list, total);
        let e1 = edge(list, total);
        if (e1 < e0) [e0, e1] = [e1, e0];
        const p = editProblem(list, kind, e0, e1, opts);
        const next = kind === 'keep' ? keepOnly(list, e0, e1, opts) : removeRange(list, e0, e1, opts);
        assert(!!p === !next, `problem ${p} vs result ${JSON.stringify(next)}`);
        if (!next) continue;
        edits++;
        const { e0: a, e1: b } = snapEdges(list, e0, e1, opts);
        const exp = [];
        for (let e = 0; e < total; e++) if ((kind === 'keep') === (e >= a && e < b)) exp.push(editedToSource(list, e));
        assert(editLength(next) === exp.length, `length ${editLength(next)} vs ${exp.length}`);
        for (let e = 0; e < exp.length; e += 7) assert(editedToSource(next, e) === exp[e], `mapping at ${e}`);
        assert(eq(normalizeEdit(next, n), next), 'normalized');
        for (const [x, y] of next) assert(y - x >= 2 * half, `piece [${x}, ${y}) of ${y - x} frames (< ${2 * half}) in ${JSON.stringify(next)}`);
        list = next;
      }
    }
    return `${edits} edits`;
  },

  'edit: sliceAudio — exact frames, fades shaped and scaled to fit, input untouched': () => {
    const n = 2 * SR;
    const a = { sampleRate: SR, channels: [new Float32Array(n).fill(1), new Float32Array(n).fill(-1)] };
    const c = sliceAudio(a, 0.5, 1.25, { fadeInSec: 0.01, fadeOutSec: 0.1 });
    assert(c.channels[0].length === 0.75 * SR, 'length');
    assert(c.channels[0][0] < 0.01 && c.channels[0][c.channels[0].length - 1] < 0.01, 'starts and ends near zero');
    assert(c.channels[0][Math.round(0.01 * SR)] === 1 && c.channels[1][Math.round(0.3 * SR)] === -1, 'full level between the fades');
    for (let i = 1; i < 0.01 * SR; i++) assert(c.channels[0][i] >= c.channels[0][i - 1], 'fade-in rises');
    approx(c.channels[0][c.channels[0].length - Math.round(0.05 * SR)], Math.cos(Math.PI / 4), 0.01, 'equal-power fade-out at its middle');
    assert(a.channels[0][SR] === 1, 'input untouched');
    const short = sliceAudio(a, 0, 0.02, { fadeInSec: 1, fadeOutSec: 1 });
    assert(short.channels[0].length === 0.02 * SR && short.channels[0].every((v) => v >= 0 && v <= 1), 'fades longer than the clip scaled down');
    const clamped = sliceAudio(a, -1, 5);
    assert(clamped.channels[0].length === n, 'clamped to the audio');
    assert(sliceAudio(a, 1, 0.5).channels[0].length === 0, 'reversed → empty');
  },

  'edit: the engine takes an edited song under the same track id (reload replaces it: fresh analysis of the new length)': async () => {
    const { EngineClient } = await import('../src/engine/client.js');
    const engine = new EngineClient({ inline: true });
    const n = 3 * SR;
    const L = new Float32Array(n);
    let x = 1;
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      L[i] = 0.3 * Math.sin(i * 0.031) + ((x / 4294967296) - 0.5) * 0.05;
    }
    const src = { sampleRate: SR, channels: [L, L.slice()] };
    await engine.loadTrack('t1', src);
    const a1 = await engine.analyze('t1');
    approx(a1.duration, 3, 1e-6, 'first analysis');
    const edited = applyEdit(src, removeRange(fullEdit(n), 0.5 * SR, 1.5 * SR, { sampleRate: SR }));
    await engine.loadTrack('t1', edited);
    const a2 = await engine.analyze('t1');
    approx(a2.duration, 2, 1e-6, 'the reloaded track is analyzed again, at its new length');
    assert(src.channels[0].length === n, 'caller audio untouched');
    engine.unload('t1');
  },

  'cut: timecodes parse with comma or dot, format per language, invalid input rejected': () => {
    approx(parseTimecode('0:12.345'), 12.345, 1e-9, 'm:ss.mmm');
    approx(parseTimecode('0:12,345'), 12.345, 1e-9, 'comma');
    approx(parseTimecode('1:02'), 62, 1e-9, 'm:ss');
    approx(parseTimecode('75,5'), 75.5, 1e-9, 'seconds');
    approx(parseTimecode(' 2:05.1 '), 125.1, 1e-9, 'spaces');
    approx(parseTimecode('1:00:00'), 3600, 1e-9, 'h:mm:ss');
    for (const bad of ['', 'abc', '1:75', '-3', '1:2:3:4', '1,2,3', '0:1x']) assert(parseTimecode(bad) === null, `rejects "${bad}"`);
    assert(formatTimecode(12.3456, 'it') === '0:12,346' && formatTimecode(62.5, 'en') === '1:02.500' && formatTimecode(-1, 'en') === '0:00.000', 'format');
    approx(parseTimecode(formatTimecode(187.004, 'it')), 187.004, 1e-9, 'round trip');
  },

  'cut: clip file name, edited-time conversion of a selection, keys gated off text fields': () => {
    assert(clipFileName('Notte di luglio', 12.4, 42.9) === 'Notte di luglio (Master) 0m12s-0m42s', clipFileName('Notte di luglio', 12.4, 42.9));
    assert(clipFileName('a/b:c', 61, 125, 'wav') === 'a b c (Master) 1m01s-2m05s.wav', clipFileName('a/b:c', 61, 125, 'wav'));
    // Timeline (master) seconds → edited frames: + lead, snapped to the ends.
    const r = selectionToEdited({ start: 1, end: 2 }, { lead: 0.5, sampleRate: 1000, timelineDuration: 10, editedFrames: 11000 });
    assert(r.e0 === 1500 && r.e1 === 2500, JSON.stringify(r));
    const ends = selectionToEdited({ start: 0, end: 10 }, { lead: 0.5, sampleRate: 1000, timelineDuration: 10, editedFrames: 11000 });
    assert(ends.e0 === 0 && ends.e1 === 11000, `edges reach the edited ends: ${JSON.stringify(ends)}`);
    const fake = (tag, extra = {}) => ({ tagName: tag, type: extra.type || '', isContentEditable: !!extra.ce, closest: () => null });
    assert(cutKeyAllowed(fake('BUTTON')) && cutKeyAllowed(fake('INPUT', { type: 'range' })) && cutKeyAllowed(null), 'buttons / sliders allowed');
    assert(!cutKeyAllowed(fake('INPUT', { type: 'text' })) && !cutKeyAllowed(fake('TEXTAREA')) && !cutKeyAllowed(fake('SELECT')) && !cutKeyAllowed(fake('DIV', { ce: true })), 'text entry blocked');
  },
};
