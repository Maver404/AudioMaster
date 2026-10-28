// Non-destructive song edits for the cut tool ("Taglia"), environment-neutral (Node tests,
// worker, main thread: no DOM, no Web Audio).
//
// An edit list is the ordered set of ORIGINAL source ranges that are kept, in whole sample
// frames: [[start, end), …], ascending, disjoint and never adjacent (adjacent ranges are
// one continuous piece of the source and are merged, so a join always means a cut).
// The edited song is those ranges played back to back; its length is exactly the sum of
// the range lengths, so time maps between the edited song and the source piecewise-
// linearly with no drift (editedToSource / sourceToEdited).
//
// Joins are smoothed with a short centred equal-power crossfade: the piece before the cut
// keeps playing h frames past its end (into the removed part) while the piece after it
// starts h frames early, both under sin/cos gains over 2h frames centred on the join. The
// two sides of a cut are unrelated material (uncorrelated), so equal power keeps the level
// steady through the fade; centring it keeps the edited length exact. h is limited by the
// audio available on both sides and by half of each adjacent piece, so neighbouring joins
// never overlap.
//
// Selections arrive in EDITED time (what the user sees and hears); keepOnly / removeRange
// return a new list (the old one stays valid for undo) or null for an edit that must not
// happen (editProblem says why: 'tiny' selection, 'tooShort' result, 'noop').
// With a sampleRate, an edge that lands within one crossfade of an earlier join (or of
// the song's start / end) is first snapped onto it (snapEdges): otherwise the edit would
// leave a sliver piece a few frames long, whose joins get a crossfade of a few samples
// or none at all, i.e. a click. So every piece between two joins keeps at least one
// full crossfade's worth of frames.

/** Crossfade length at a join (s): ≈ 10 ms, long enough to hide the click, short enough not to smear a beat. */
export const EDIT_CROSSFADE_SEC = 0.01;
/** Shortest selection an edit accepts (s): anything shorter is a stray click, not a cut. */
export const MIN_SELECTION_SEC = 0.05;
/** Shortest song an edit may leave (s): the analysis needs a few loudness blocks. */
export const MIN_RESULT_SEC = 1;

/**
 * @typedef {{ sampleRate: number, channels: Float32Array[] }} AudioData
 * @typedef {number[][]} EditList  kept [start, end) source frames
 */

/**
 * The edit list that keeps the whole source.
 * @param {number} length source length in frames
 * @returns {EditList}
 */
export function fullEdit(length) {
  const n = Math.max(0, Math.floor(Number(length) || 0));
  return n > 0 ? [[0, n]] : [];
}

/**
 * Canonical form: integer frames clamped to [0, length], empty ranges dropped, sorted,
 * overlapping or adjacent ranges merged.
 * @param {EditList} list
 * @param {number} [length] source length in frames (no upper clamp when omitted)
 * @returns {EditList}
 */
export function normalizeEdit(list, length = Infinity) {
  const max = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : Infinity;
  const rs = [];
  for (const r of list || []) {
    if (!r || r.length < 2) continue;
    const a = Math.max(0, Math.round(Number(r[0]) || 0));
    const b = Math.min(max, Math.round(Number(r[1]) || 0));
    if (b > a) rs.push([a, b]);
  }
  rs.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** Length of the edited song in frames (sum of the kept ranges). */
export function editLength(list) {
  let n = 0;
  for (const r of list || []) n += r[1] - r[0];
  return n;
}

/** True when the list keeps the whole source unchanged (or is missing). */
export function isFullEdit(list, length) {
  if (!list) return true;
  return list.length === 1 && list[0][0] === 0 && list[0][1] === Math.floor(length);
}

/**
 * Edited frame → source frame (clamped: before 0 → first kept frame, at/after the end →
 * the end of the last kept range).
 * @param {EditList} list
 * @param {number} e edited frame
 * @returns {number}
 */
export function editedToSource(list, e) {
  if (!list || !list.length) return 0;
  if (!(e > 0)) return list[0][0];
  let cum = 0;
  for (const [a, b] of list) {
    const len = b - a;
    if (e < cum + len) return a + (e - cum);
    cum += len;
  }
  return list[list.length - 1][1];
}

/**
 * Source frame → edited frame. A frame inside a removed part maps to the join where the
 * next kept range starts (that is where the music continues); past the last range → end.
 * @param {EditList} list
 * @param {number} s source frame
 * @returns {number}
 */
export function sourceToEdited(list, s) {
  if (!list || !list.length) return 0;
  let cum = 0;
  for (const [a, b] of list) {
    if (s < a) return cum;
    if (s < b) return cum + (s - a);
    cum += b - a;
  }
  return cum;
}

/**
 * The part of an edit list that covers edited frames [e0, e1), as source ranges.
 * @param {EditList} list
 * @param {number} e0
 * @param {number} e1
 * @returns {EditList}
 */
export function sliceEdit(list, e0, e1) {
  const out = [];
  let cum = 0;
  for (const [a, b] of list || []) {
    const len = b - a;
    const o0 = Math.max(e0, cum);
    const o1 = Math.min(e1, cum + len);
    if (o1 > o0) out.push([a + (o0 - cum), a + (o1 - cum)]);
    cum += len;
    if (cum >= e1) break;
  }
  return out;
}

function frameLimits(opts) {
  const sr = opts && opts.sampleRate > 0 ? opts.sampleRate : 0;
  const minFrames = opts && Number.isFinite(opts.minFrames) ? opts.minFrames : sr ? Math.round(MIN_SELECTION_SEC * sr) : 1;
  const minResultFrames = opts && Number.isFinite(opts.minResultFrames) ? opts.minResultFrames : sr ? Math.round(MIN_RESULT_SEC * sr) : 1;
  return { minFrames: Math.max(1, minFrames), minResultFrames: Math.max(1, minResultFrames) };
}

/** `e` moved onto the nearest of 0, a join or `total` when it is at most `tol` frames away. */
function snapFrame(list, e, tol, total) {
  if (!(tol > 0) || !Number.isFinite(e)) return e;
  let best = e;
  let bestD = tol + 1;
  const consider = (x) => {
    const d = Math.abs(e - x);
    if (d <= tol && d < bestD) {
      best = x;
      bestD = d;
    }
  };
  consider(0);
  let cum = 0;
  for (let k = 0; k + 1 < list.length; k++) {
    cum += list[k][1] - list[k][0];
    consider(cum);
  }
  consider(total);
  return best;
}

/**
 * Selection edges as an edit uses them: whole frames clamped to the edited song, and,
 * with a sampleRate, snapped onto an earlier join or onto the song's start / end when
 * they land within one crossfade (EDIT_CROSSFADE_SEC) of it, so no edit leaves a sliver
 * piece too short for its joins' crossfades. editProblem / keepOnly / removeRange all use
 * these edges; callers that need to know where the edit landed (the playhead after
 * "Elimina") ask here too.
 * @param {EditList} list
 * @param {number} e0 edited frames
 * @param {number} e1 edited frames
 * @param {{ sampleRate?: number }} [opts]
 * @returns {{ e0: number, e1: number }}
 */
export function snapEdges(list, e0, e1, opts = {}) {
  const total = editLength(list);
  const a = Math.max(0, Math.min(total, Math.round(Number(e0))));
  const b = Math.max(0, Math.min(total, Math.round(Number(e1))));
  const sr = opts && opts.sampleRate > 0 ? opts.sampleRate : 0;
  const tol = sr ? Math.round(EDIT_CROSSFADE_SEC * sr) : 0; // one full crossfade = 2 × its half
  return { e0: snapFrame(list || [], a, tol, total), e1: snapFrame(list || [], b, tol, total) };
}

/**
 * Why an edit cannot be applied, or null when it can.
 * @param {EditList} list current edit list
 * @param {'keep'|'remove'} kind
 * @param {number} e0 selection start, edited frames
 * @param {number} e1 selection end, edited frames
 * @param {{ sampleRate?: number, minFrames?: number, minResultFrames?: number }} [opts]
 *   limits in frames, or derived from MIN_SELECTION_SEC / MIN_RESULT_SEC at sampleRate
 * @returns {null|'tiny'|'tooShort'|'noop'}
 */
export function editProblem(list, kind, e0, e1, opts = {}) {
  const total = editLength(list);
  const { minFrames, minResultFrames } = frameLimits(opts);
  const { e0: a, e1: b } = snapEdges(list, e0, e1, opts);
  if (!(b - a >= minFrames)) return 'tiny';
  if (kind === 'keep') {
    if (a <= 0 && b >= total) return 'noop';
    return b - a < minResultFrames ? 'tooShort' : null;
  }
  return total - (b - a) < minResultFrames ? 'tooShort' : null;
}

/**
 * Keep only the selected part of the edited song.
 * @param {EditList} list
 * @param {number} e0 edited frames
 * @param {number} e1 edited frames
 * @param {object} [opts] see editProblem
 * @returns {EditList|null} new list, or null (editProblem() tells why)
 */
export function keepOnly(list, e0, e1, opts = {}) {
  if (editProblem(list, 'keep', e0, e1, opts)) return null;
  const { e0: a, e1: b } = snapEdges(list, e0, e1, opts);
  return normalizeEdit(sliceEdit(list, a, b));
}

/**
 * Remove the selected part of the edited song (the two sides are joined).
 * @param {EditList} list
 * @param {number} e0 edited frames
 * @param {number} e1 edited frames
 * @param {object} [opts] see editProblem
 * @returns {EditList|null} new list, or null (editProblem() tells why)
 */
export function removeRange(list, e0, e1, opts = {}) {
  if (editProblem(list, 'remove', e0, e1, opts)) return null;
  const total = editLength(list);
  const { e0: a, e1: b } = snapEdges(list, e0, e1, opts);
  return normalizeEdit([...sliceEdit(list, 0, a), ...sliceEdit(list, b, total)]);
}

/**
 * Render an edit list: the kept ranges back to back, every join smoothed by a centred
 * equal-power crossfade (see the header). Output length === editLength(list). Works on
 * any channel count. The input is not modified.
 * @param {AudioData} audio source
 * @param {EditList} list normalized edit list within the source
 * @param {{ crossfadeSec?: number }} [opts]
 * @returns {AudioData}
 */
export function applyEdit(audio, list, { crossfadeSec = EDIT_CROSSFADE_SEC } = {}) {
  const sr = audio.sampleRate;
  const n = audio.channels.length ? audio.channels[0].length : 0;
  const rs = normalizeEdit(list, n);
  const total = editLength(rs);
  const out = audio.channels.map(() => new Float32Array(total));
  let pos = 0;
  const starts = [];
  for (const [a, b] of rs) {
    starts.push(pos);
    for (let c = 0; c < out.length; c++) out[c].set(audio.channels[c].subarray(a, b), pos);
    pos += b - a;
  }
  const half = Math.max(0, Math.floor((Math.max(0, Number(crossfadeSec) || 0) * sr) / 2));
  if (half > 0) {
    for (let k = 0; k + 1 < rs.length; k++) {
      const [a0, a1] = rs[k];
      const [b0, b1] = rs[k + 1];
      // Frames available past the left piece's end / before the right piece's start, and
      // at most half of each piece (a neighbouring join may use the other half).
      const h = Math.min(half, n - a1, b0, Math.floor((a1 - a0) / 2), Math.floor((b1 - b0) / 2));
      if (h <= 0) continue;
      const p = starts[k + 1];
      const span = 2 * h;
      for (let i = -h; i < h; i++) {
        const th = ((i + h + 0.5) / span) * (Math.PI / 2);
        const gA = Math.cos(th);
        const gB = Math.sin(th);
        for (let c = 0; c < out.length; c++) {
          const src = audio.channels[c];
          out[c][p + i] = src[a1 + i] * gA + src[b0 + i] * gB;
        }
      }
    }
  }
  return { sampleRate: sr, channels: out };
}

/**
 * A clip of `audio` from startSec to endSec (rounded to whole frames, clamped to the
 * audio) with equal-power fade-in / fade-out (longer fades than the clip are scaled down
 * so they fit). The input is not modified.
 * @param {AudioData} audio
 * @param {number} startSec
 * @param {number} endSec
 * @param {{ fadeInSec?: number, fadeOutSec?: number }} [opts]
 * @returns {AudioData}
 */
export function sliceAudio(audio, startSec, endSec, { fadeInSec = 0, fadeOutSec = 0 } = {}) {
  const sr = audio.sampleRate;
  const n = audio.channels.length ? audio.channels[0].length : 0;
  const i0 = Math.max(0, Math.min(n, Math.round((Number(startSec) || 0) * sr)));
  const i1 = Math.max(i0, Math.min(n, Math.round((Number(endSec) || 0) * sr)));
  const len = i1 - i0;
  const out = audio.channels.map((ch) => ch.slice(i0, i1));
  let fi = Math.max(0, Math.round((Number(fadeInSec) || 0) * sr));
  let fo = Math.max(0, Math.round((Number(fadeOutSec) || 0) * sr));
  if (fi + fo > len) {
    const k = len / (fi + fo);
    fi = Math.floor(fi * k);
    fo = Math.floor(fo * k);
  }
  for (const ch of out) {
    for (let i = 0; i < fi; i++) ch[i] *= Math.sin(((i + 0.5) / fi) * (Math.PI / 2));
    for (let i = 0; i < fo; i++) ch[len - fo + i] *= Math.cos(((i + 0.5) / fo) * (Math.PI / 2));
  }
  return { sampleRate: sr, channels: out };
}
