// True-peak lookahead limiter (Signalsmith design) with an offline verify-and-rerun loop,
// and a 4x-oversampled smooth (tanh-knee) soft clipper.
//
// Limiter (G. Luff, "Designing a straightforward limiter", Signalsmith Audio 2022;
// RESEARCH §7, research/05 §4):
//   pk[n]  = linked true-peak envelope (max over channels of truePeakEnvelope 'limiter':
//            |x[n]| and the 4x-interpolated points up to x[n+1]),
//   gt[n]  = min(1, c[n]/pk[n])          target gain (c = internal ceiling),
//   h[n]   = min(gt[n−H+1 … n])           moving minimum ("hold"), H >= L + 1,
//   r[n]   : r += (h − r)/(R + 1); r = min(r, h)   (instant attack, smooth release),
//   g      = two cascaded box filters of lengths 0.5822/0.4178 of the support L,
//   y[m]   = x[m]·g[m + L − 1]            (the L − 1 lookahead is removed: zero latency).
// No overshoot at the detector's points: g[m] and g[m+1] are averages of r values whose
// hold windows all contain m (H >= L + 1), so both are <= gt[m] — the gain over the whole
// interpolated interval [m, m+1] is <= c/pk[m].
//
// What remains is (a) gain modulation inside the interpolation filter's support (second
// order) and (b) disagreement between interpolators on content near Nyquist (the BS.1770
// filter stops at ≈0.58·fs; ffmpeg's ebur128 resamples to 192 kHz with a 32-tap Kaiser
// sinc cut at fs/2 and reads up to ≈0.7 dB higher on full-band material such as clipped
// noise). Both are removed offline by verification of the actual output:
//   * BS.1770-4 meter (bit-exact replica of oversample.truePeakDb, rigorous, every sample
//     that can reach the ceiling — exact Σ|taps| bounds skip the rest);
//   * ffmpeg ebur128 (exact emulation of libswresample's default 192 kHz filter and grid,
//     including its mirrored start; matches ffmpeg's resampled samples to ≈1e-5) on every
//     interval whose meter reading is within 3 dB of the ceiling.
// Where a point is over, the ceiling is capped locally (around that point only) by the
// excess + 0.05 dB and the gain recomputed; only blocks whose gain changed are
// re-verified. If anything is still over after the last run, a static trim (exact: both
// readings are linear in the signal) makes the guarantee unconditional.

import { clamp, sinc, besselI0 } from './util.js';
import { truePeakEnvelope, truePeakFactor, upsample, downsample } from './oversample.js';

const LN10_20 = Math.LN10 / 20;
const DB20 = 20 / Math.LN10;
const VB_SHIFT = 12; // verification block = 4096 samples
const VB = 1 << VB_SHIFT;
const VM = 20; // verification margin (>= the 32-tap emulation's reach of 16/17 samples)
const MAX_RUNS = 3; // first pass + 2 local re-runs (ARCHITECTURE: max 3 runs)
const FF_CAND_DB = 3; // ffmpeg check on intervals whose meter reading is within this of the ceiling
// Extra internal margin below ceiling − safetyDb for the first pass: covers the typical
// second-order overshoot (gain modulation, ≤ ≈0.1 dB on brutal material, ≤ 0.04 dB on
// music) so that re-runs stay rare and local (RESEARCH §7 suggests 0.25 dB for 4x).
const DETECTOR_MARGIN_DB = 0.1;
// A re-run only re-verifies blocks whose gain changed by more than DIRTY_TOL (relative):
// the slow release tail of a local fix changes the gain by tiny amounts for seconds. Any
// interpolated value of a block can then grow by at most Σ|taps|·(runs·DIRTY_TOL)·max|y|
// <= 2.3·3e-4·C, so verifying against C·(1 − VERIFY_SLACK) keeps the guarantee exact.
const DIRTY_TOL = 1e-4;
const VERIFY_SLACK = 1e-3; // 0.0087 dB

// ---------------------------------------------------------------- BS.1770 meter replica
// Same coefficients and evaluation order as src/dsp/oversample.js → identical readings.

const TP_P0 = [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
  0.97216796875, -0.102294921875, 0.047607421875, -0.0266113281250, 0.014892578125, -0.00830078125];
const TP_P1 = [-0.0291748046875, 0.029296875, -0.0517578125, 0.0891113281250, -0.166503906250, 0.465087890625,
  0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375];

function meterPairs(P) {
  const e = new Float64Array(6), g = new Float64Array(6);
  for (let j = 0; j < 6; j++) {
    const a = P[5 - j], b = P[6 + j];
    e[j] = 0.5 * (a + b);
    g[j] = 0.5 * (a - b);
  }
  return { e, g };
}
const MTR0 = meterPairs(TP_P0), MTR1 = meterPairs(TP_P1);
const MTR_BOUND = Math.max(...[TP_P0, TP_P1].map((P) => P.reduce((s, v) => s + Math.abs(v), 0)));

/** 2x half-band of oversample.js (96–192 kHz, both qualities): up taps, same order. */
function halfBandUp(K, A) {
  const beta = A > 50 ? 0.1102 * (A - 8.7) : 0.5842 * Math.pow(A - 21, 0.4) + 0.07886 * (A - 21);
  const i0b = besselI0(beta);
  const hw = 2 * K;
  const h = new Float64Array(K);
  let sum = 0;
  for (let k = 0; k < K; k++) {
    const m = 2 * k + 1;
    const u = m / hw;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / i0b;
    h[k] = 0.5 * sinc(m / 2) * w;
    sum += 2 * h[k];
  }
  const norm = 0.5 / sum;
  return h.map((v) => 2 * (v * norm));
}
const HB2X_UP = halfBandUp(12, 70);
const HB2X_BOUND = HB2X_UP.reduce((s, v) => s + 2 * Math.abs(v), 0);

// ---------------------------------------------------------------- ffmpeg ebur128 emulation
// libavfilter/f_ebur128 resamples to 192 kHz with libswresample defaults: Kaiser (β = 9)
// windowed sinc at the input Nyquist (upsampling ⇒ factor 1), filter_size 32 taps,
// center 15, exact rational phases (exact_rational = 1): output k sits at input time
// k·fs/192000. Each phase is normalized to unit DC gain. Its start history is the input
// mirrored about sample 0 (invert_initial_buffer); the tail is never flushed.

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

const ffCache = new Map();
function ffGrid(sampleRate) {
  const fs = Math.round(sampleRate);
  if (ffCache.has(fs)) return ffCache.get(fs);
  let grid = null;
  if (fs < 192000) {
    const g = gcd(fs, 192000);
    const a = fs / g, b = 192000 / g;
    if (b <= 4096) {
      const T = new Float64Array(b * 32);
      for (let p = 0; p < b; p++) {
        let s = 0;
        for (let j = 0; j < 32; j++) {
          const x = j - 15 - p / b;
          const w = (2 * x) / 32;
          const v = sinc(x) * besselI0(9 * Math.sqrt(Math.max(0, 1 - w * w)));
          T[p * 32 + j] = v;
          s += v;
        }
        for (let j = 0; j < 32; j++) T[p * 32 + j] /= s;
      }
      grid = { a, b, T, sym: false, e: null, g: null, h: null };
      if (a === 1 && (b === 2 || b === 4)) {
        // symmetric form (taps of phase p and b − p are mirror images)
        const half = b / 2; // phase index of the midpoint
        grid.sym = true;
        grid.h = Float64Array.from({ length: 16 }, (_, m) => T[half * 32 + 16 + m]);
        if (b === 4) {
          const A = (m) => T[32 + 16 + m], B = (m) => T[32 + 15 - m];
          grid.e = Float64Array.from({ length: 16 }, (_, m) => 0.5 * (A(m) + B(m)));
          grid.g = Float64Array.from({ length: 16 }, (_, m) => 0.5 * (A(m) - B(m)));
        }
      }
    }
  }
  ffCache.set(fs, grid);
  return grid;
}

/** Max |emulated ffmpeg sample| over output times in [i, i+1); buf[c] = y[i], ≥ 16/17 margin. */
function ffInterval(buf, c, i, ff) {
  if (ff.sym) return ffSym(buf, c, ff);
  const a = ff.a, b = ff.b, T = ff.T;
  const r = (i * b) % a;
  let num = r === 0 ? 0 : a - r; // phase numerator of the first output time >= i
  let best = 0;
  const o = c - 15;
  for (; num < b; num += a) {
    if (num === 0) continue; // phase 0 is the sample itself (covered by the meter check)
    const base = num * 32;
    let v = 0;
    for (let j = 0; j < 32; j++) v += T[base + j] * buf[o + j];
    if (v < 0) v = -v;
    if (v > best) best = v;
  }
  return best;
}

/**
 * Integer ratios 192000/fs = 2 or 4 (96 / 48 kHz): the phases are symmetric about the
 * interval centre, so pair sums s = y[i+1+m] + y[i−m] and differences d serve all of them
 * (phase 1/2: Σc·s; phases 1/4, 3/4: Σe·s ± Σg·d).
 */
function ffSym(buf, c, ff) {
  const e = ff.e, g = ff.g, h = ff.h;
  let E = 0, Gs = 0, M = 0;
  for (let m = 0; m < 16; m++) {
    const p = buf[c + 1 + m], q = buf[c - m];
    const sm = p + q;
    M += h[m] * sm;
    if (e) {
      E += e[m] * sm;
      Gs += g[m] * (p - q);
    }
  }
  let best = M < 0 ? -M : M;
  if (e) {
    const v = Math.abs(E) + Math.abs(Gs);
    if (v > best) best = v;
  }
  return best;
}

// ---------------------------------------------------------------- verification kernels

/**
 * Event list of over-ceiling points, merged on the fly (consecutive points within 16
 * samples become one event holding the worst ratio).
 */
class Events {
  constructor() {
    this.pos = new Float64Array(256);
    this.end = new Float64Array(256);
    this.ratio = new Float64Array(256);
    this.n = 0;
  }

  clear() {
    this.n = 0;
  }

  add(p, ratio) {
    const n = this.n;
    if (n && p - this.end[n - 1] <= 16 && p >= this.pos[n - 1]) {
      if (p > this.end[n - 1]) this.end[n - 1] = p;
      if (ratio > this.ratio[n - 1]) this.ratio[n - 1] = ratio;
      return;
    }
    if (n === this.pos.length) {
      const grow = (a) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.pos = grow(this.pos);
      this.end = grow(this.end);
      this.ratio = grow(this.ratio);
    }
    this.pos[n] = p;
    this.end[n] = p;
    this.ratio[n] = ratio;
    this.n = n + 1;
  }
}

/**
 * 4x BS.1770 meter scan over centres buf[c0 … c0+len−1]. Intervals whose reading exceeds
 * candThr are written to (cIdx, cVal) and handled afterwards (keeps this hot loop free of
 * calls, which V8 would otherwise inline and slow down). Returns the candidate count.
 */
function scanMeter4(buf, c0, len, candThr, cIdx, cVal) {
  const e00 = MTR0.e[0], e01 = MTR0.e[1], e02 = MTR0.e[2], e03 = MTR0.e[3], e04 = MTR0.e[4], e05 = MTR0.e[5];
  const g00 = MTR0.g[0], g01 = MTR0.g[1], g02 = MTR0.g[2], g03 = MTR0.g[3], g04 = MTR0.g[4], g05 = MTR0.g[5];
  const e10 = MTR1.e[0], e11 = MTR1.e[1], e12 = MTR1.e[2], e13 = MTR1.e[3], e14 = MTR1.e[4], e15 = MTR1.e[5];
  const g10 = MTR1.g[0], g11 = MTR1.g[1], g12 = MTR1.g[2], g13 = MTR1.g[3], g14 = MTR1.g[4], g15 = MTR1.g[5];
  let nc = 0;
  for (let t = 0, c = c0; t < len; t++, c++) {
    const m0 = buf[c], p0 = buf[c + 1], s0 = p0 + m0, d0 = p0 - m0;
    const m1 = buf[c - 1], p1 = buf[c + 2], s1 = p1 + m1, d1 = p1 - m1;
    const m2 = buf[c - 2], p2 = buf[c + 3], s2 = p2 + m2, d2 = p2 - m2;
    const m3 = buf[c - 3], p3 = buf[c + 4], s3 = p3 + m3, d3 = p3 - m3;
    const m4 = buf[c - 4], p4 = buf[c + 5], s4 = p4 + m4, d4 = p4 - m4;
    const m5 = buf[c - 5], p5 = buf[c + 6], s5 = p5 + m5, d5 = p5 - m5;
    const E0 = e00 * s0 + e01 * s1 + e02 * s2 + e03 * s3 + e04 * s4 + e05 * s5;
    const G0 = g00 * d0 + g01 * d1 + g02 * d2 + g03 * d3 + g04 * d4 + g05 * d5;
    const E1 = e10 * s0 + e11 * s1 + e12 * s2 + e13 * s3 + e14 * s4 + e15 * s5;
    const G1 = g10 * d0 + g11 * d1 + g12 * d2 + g13 * d3 + g14 * d4 + g15 * d5;
    // max(|E ± G|) = |E| + |G| exactly in floating point; ternaries are ≈1.7x faster in
    // V8 than a 5-argument Math.max here
    const a0 = Math.abs(E0) + Math.abs(G0), a1 = Math.abs(E1) + Math.abs(G1), am = m0 < 0 ? -m0 : m0;
    const vm = a0 > a1 ? (a0 > am ? a0 : am) : (a1 > am ? a1 : am);
    if (vm > candThr) {
      cIdx[nc] = t;
      cVal[nc] = vm;
      nc++;
    }
  }
  return nc;
}

/** 2x (96–192 kHz) meter scan (half-band, as oversample.js); same candidate output. */
function scanMeter2(buf, c0, len, candThr, cIdx, cVal) {
  const u = HB2X_UP, K = u.length;
  let nc = 0;
  for (let t = 0, c = c0; t < len; t++, c++) {
    let a = 0;
    for (let j = 0; j < K; j++) a += u[j] * (buf[c - j] + buf[c + 1 + j]);
    const vm = Math.max(Math.abs(buf[c]), Math.abs(a));
    if (vm > candThr) {
      cIdx[nc] = t;
      cVal[nc] = vm;
      nc++;
    }
  }
  return nc;
}

/**
 * Verify one block of one channel of the output y = fround(x·G) (exactly what will be
 * stored): BS.1770 meter on every interval that can reach the candidate threshold (exact
 * Σ|taps| skip), ffmpeg emulation on the candidates, ffmpeg's mirrored start in block 0.
 */
function verifyBlock(v, x, b) {
  const { G, N, F, ff, buf, thrM, thrF, candThr, ev, cIdx, cVal } = v;
  const s = b << VB_SHIFT, e = Math.min(N, s + VB);
  const len = e - s;
  const span = len + 2 * VM;
  // y over [s − VM, e + VM), zero beyond the signal
  const lo = Math.max(0, s - VM), hi = Math.min(N, e + VM);
  const q0 = lo - (s - VM), q1 = hi - (s - VM);
  for (let q = 0; q < q0; q++) buf[q] = 0;
  let bm = 0;
  for (let q = q0, i = lo; q < q1; q++, i++) {
    const y = Math.fround(x[i] * G[i]);
    buf[q] = y;
    const a = y < 0 ? -y : y;
    if (a > bm) bm = a;
  }
  for (let q = q1; q < span; q++) buf[q] = 0;
  if (F === 1) {
    for (let t = 0; t < len; t++) {
      const a = Math.abs(buf[VM + t]);
      if (a > thrM) ev.add(s + t, a / thrM);
    }
    return;
  }
  let nc = 0;
  // exact skip: no interpolated point of this block can reach the candidate threshold
  if (F === 4) {
    if (bm * MTR_BOUND > candThr) nc = scanMeter4(buf, VM, len, candThr, cIdx, cVal);
  } else if (bm * HB2X_BOUND > candThr) nc = scanMeter2(buf, VM, len, candThr, cIdx, cVal);
  for (let k = 0; k < nc; k++) {
    const t = cIdx[k], vm = cVal[k];
    if (vm > thrM) ev.add(s + t, vm / thrM);
    if (ff) {
      const vf = ffInterval(buf, VM + t, s + t, ff);
      if (vf > thrF) ev.add(s + t, vf / thrF);
    }
  }
  if (b === 0 && ff) {
    // ffmpeg's start: history mirrored about sample 0 (y[−n] = y[n])
    for (let q = 1; q <= VM && q < len + VM; q++) buf[VM - q] = buf[VM + q];
    for (let t = 0; t < Math.min(16, len); t++) {
      const vf = ffInterval(buf, VM + t, t, ff);
      if (vf > thrF) ev.add(t, vf / thrF);
    }
  }
}

// ---------------------------------------------------------------- gain pipeline

/**
 * Signalsmith gain computer over the whole signal. Writes G[m] (gain for sample m, the
 * lookahead already removed) and flags the verification blocks whose gain changed.
 * `bps` = sorted local ceiling caps [pos, cap, pos, cap, …] (absolute linear ceilings that
 * apply from pos to the next breakpoint; Infinity = none).
 */
function computeGain(pk, N, cInt, bps, G, dirty, p) {
  const L = p.L, H = p.H, kR = p.kR, kRs = p.kRs, adaptive = p.adaptive, kS = p.kS, L1 = p.L1, L2 = p.L2;
  const inv1 = 1 / L1, inv2 = 1 / L2;
  let cap = 1;
  while (cap < H + 2) cap <<= 1;
  const mask = cap - 1;
  const dqV = new Float64Array(cap), dqI = new Int32Array(cap);
  let head = 0, tail = 0;
  const ring1 = new Float64Array(L1).fill(1), ring2 = new Float64Array(L2).fill(1);
  let i1 = 0, i2 = 0, sum1 = L1, sum2 = L2, ones1 = L1, ones2 = L2;
  let rf = 1, sus = 0;
  let bp = 0, nextPos = bps.length ? bps[0] : Infinity, cur = cInt;
  const total = N + L - 1;
  for (let n = 0; n < total; n++) {
    while (n >= nextPos) {
      cur = Math.min(cInt, bps[bp + 1]);
      bp += 2;
      nextPos = bp < bps.length ? bps[bp] : Infinity;
    }
    let gt = 1;
    if (n < N) {
      const v = pk[n];
      if (v > cur) gt = cur / v;
    }
    // moving minimum over H (monotonic deque; the front expires at most once per step)
    while (tail > head && dqV[(tail - 1) & mask] >= gt) tail--;
    dqV[tail & mask] = gt;
    dqI[tail & mask] = n;
    tail++;
    if (dqI[head & mask] <= n - H) head++;
    const h = dqV[head & mask];
    // release (instant attack; the box smoothing shapes the attack). Adaptive: the release
    // coefficient slides from fast (R/2) to slow (3R) with the fraction of recent time
    // spent limiting (one-pole "sustain" detector), so isolated peaks recover quickly and
    // sustained limiting releases slowly (less gain ripple on bass → less distortion).
    let k = kR;
    if (adaptive) {
      sus += ((h < 1 ? 1 : 0) - sus) * kS;
      k = kR + (kRs - kR) * sus;
    }
    if (h <= rf) rf = h;
    else {
      rf += (h - rf) * k;
      if (h === 1 && rf > 1 - 1e-9) rf = 1;
    }
    const r = rf;
    // two cascaded boxes (history = gain 1; sums reset exactly after L ones → bit-exact
    // unity between limiting events)
    sum1 += r - ring1[i1];
    ring1[i1] = r;
    if (++i1 === L1) i1 = 0;
    let v1;
    if (r === 1) {
      if (++ones1 >= L1) sum1 = L1;
    } else ones1 = 0;
    if (ones1 >= L1) v1 = 1;
    else {
      v1 = sum1 * inv1;
      if (v1 > 1) v1 = 1;
    }
    sum2 += v1 - ring2[i2];
    ring2[i2] = v1;
    if (++i2 === L2) i2 = 0;
    let v2;
    if (v1 === 1) {
      if (++ones2 >= L2) sum2 = L2;
    } else ones2 = 0;
    if (ones2 >= L2) v2 = 1;
    else {
      v2 = sum2 * inv2;
      if (v2 > 1) v2 = 1;
    }
    const m = n - L + 1;
    if (m >= 0) {
      const nv = Math.fround(v2);
      const old = G[m];
      if (nv !== old) {
        const d = nv - old;
        if (d > DIRTY_TOL * old || d < -DIRTY_TOL * old) dirty[m >> VB_SHIFT] = 1;
        G[m] = nv;
      }
    }
  }
}

function asChannels(x) {
  if (!x) return [];
  return ArrayBuffer.isView(x) ? [x] : Array.from(x);
}

function finiteOr(v, d) {
  return Number.isFinite(v) ? v : d;
}

/**
 * Stereo-linked true-peak lookahead limiter, in place, zero latency.
 * Signalsmith design (see file header): hold H = L + 5 ms, release
 * r += (h − r)/(R + 1), two boxes 0.5822/0.4178 of the lookahead L.
 * adaptiveRelease: the release time slides from releaseMs/2 (isolated transients) to
 * 3·releaseMs (sustained limiting) with the fraction of the last ≈ max(2·releaseMs, 100 ms)
 * spent limiting, so peaks recover quickly while dense passages release slowly (less gain
 * ripple on bass → less distortion and pumping).
 * Internal ceiling = ceilingDb − safetyDb, then verify-and-rerun (file header) so that
 * truePeakDb(output) <= ceilingDb (BS.1770 meter) and ffmpeg's ebur128 true peak (exact
 * emulation) <= ceilingDb too. Exactly transparent (output === input) when the input
 * never exceeds the internal ceiling and both readings confirm it.
 * @param {Float32Array[]} channels processed in place (any channel count, linked)
 * @param {number} sampleRate
 * @param {{ ceilingDb?: number, lookaheadMs?: number, releaseMs?: number,
 *   adaptiveRelease?: boolean, safetyDb?: number }} [opts]
 * @returns {{ grAvgDb: number, grMaxDb: number, grPctAbove1dB: number, runs: number,
 *   trimDb: number }} grAvg over non-silent samples (true peak > −60 dBFS), <= 0;
 *   grPctAbove1dB = % of non-silent samples reduced by more than 1 dB; runs = gain passes
 *   (0 = nothing to limit); trimDb = static fallback trim (normally 0)
 */
export function limitTruePeak(channels, sampleRate, opts = {}) {
  const chans = asChannels(channels);
  const nCh = chans.length;
  const N = nCh ? Math.min(...chans.map((c) => c.length)) : 0;
  const stats = { grAvgDb: 0, grMaxDb: 0, grPctAbove1dB: 0, runs: 0, trimDb: 0 };
  if (!N || !(sampleRate > 0)) return stats;
  const ceilingDb = Math.min(finiteOr(opts.ceilingDb, -1), 24);
  const lookaheadMs = clamp(finiteOr(opts.lookaheadMs, 3), 0.02, 50);
  const releaseMs = clamp(finiteOr(opts.releaseMs, 80), 0, 5000);
  const adaptive = opts.adaptiveRelease !== false;
  const safetyDb = clamp(finiteOr(opts.safetyDb, 0.05), 0, 6);
  const C = Math.exp(ceilingDb * LN10_20);
  const cInt = C * Math.exp(-(safetyDb + DETECTOR_MARGIN_DB) * LN10_20);
  const thrM = C * (1 - VERIFY_SLACK); // what truePeakDb reports must stay <= ceilingDb
  const thrF = C * (1 - VERIFY_SLACK); // ffmpeg emulation (ffmpeg's float32 math: ≈1e-5 rel.)
  const candThr = C * Math.exp(-FF_CAND_DB * LN10_20);

  // ---- detector: linked true-peak envelope
  const pk = new Float32Array(N);
  const G = new Float32Array(N);
  truePeakEnvelope(chans[0], sampleRate, pk, 'limiter');
  for (let c = 1; c < nCh; c++) {
    truePeakEnvelope(chans[c], sampleRate, G, 'limiter');
    for (let i = 0; i < N; i++) if (G[i] > pk[i]) pk[i] = G[i];
  }
  G.fill(1);
  let pkMax = 0;
  for (let i = 0; i < N; i++) if (pk[i] > pkMax) pkMax = pk[i];

  // ---- parameters (samples)
  const L = Math.max(1, Math.round(lookaheadMs * 1e-3 * sampleRate));
  const H = L + Math.max(1, Math.round(5e-3 * sampleRate));
  const R = releaseMs * 1e-3 * sampleRate;
  const L1 = Math.max(1, Math.round(0.5822 * (L + 1)));
  const p = {
    L, H, L1, L2: Math.max(1, L + 1 - L1),
    kR: 1 / ((adaptive ? 0.5 * R : R) + 1),
    kRs: 1 / (3 * R + 1),
    adaptive,
    // sustain detector time constant: 2·releaseMs, at least 100 ms
    kS: 1 - Math.exp(-1 / (Math.max(2 * releaseMs, 100) * 1e-3 * sampleRate)),
  };

  // ---- verification setup
  const F = truePeakFactor(sampleRate);
  const ff = ffGrid(sampleRate);
  const nB = (N + VB - 1) >> VB_SHIFT;
  const dirty = new Uint8Array(nB);
  const buf = new Float64Array(VB + 2 * VM);
  const ev = new Events();
  const regions = []; // [start, end, cap]

  const vctx = { chans, G, N, F, ff, buf, thrM, thrF, candThr, ev, cIdx: new Int32Array(VB), cVal: new Float64Array(VB) };
  const verify = (all) => {
    ev.clear();
    for (let b = 0; b < nB; b++) {
      if (all || dirty[b] || (b > 0 && dirty[b - 1]) || (b + 1 < nB && dirty[b + 1])) {
        for (let c = 0; c < nCh; c++) verifyBlock(vctx, chans[c], b);
      }
    }
    dirty.fill(0);
  };

  let runs = 0;
  if (pkMax > cInt) {
    computeGain(pk, N, cInt, [], G, dirty, p);
    runs = 1;
  }
  verify(true);
  while (ev.n && runs < MAX_RUNS) {
    const touched = addRegions(regions, ev, N, G, pk);
    computeGain(pk, N, cInt, breakpoints(regions), G, dirty, p);
    for (const b of touched) dirty[b] = 1;
    runs++;
    verify(false);
  }
  let trim = 1;
  if (ev.n) {
    let worst = 1;
    for (let i = 0; i < ev.n; i++) if (ev.ratio[i] > worst) worst = ev.ratio[i];
    trim = Math.exp(-0.002 * LN10_20) / worst;
  }

  // ---- apply + statistics (dB sums accumulated as log of short products)
  const g1 = Math.exp(-1 * LN10_20);
  const gate = 1e-3; // −60 dBFS true peak
  let sumLn = 0, prod = 1, cnt = 0, cnt1 = 0, gMin = 1;
  if (trim !== 1) for (let m = 0; m < N; m++) G[m] *= trim;
  if (nCh === 2) {
    const A = chans[0], B = chans[1];
    for (let m = 0; m < N; m++) {
      const g = G[m];
      if (g !== 1) {
        A[m] *= g;
        B[m] *= g;
      }
    }
  } else {
    for (const x of chans) for (let m = 0; m < N; m++) if (G[m] !== 1) x[m] *= G[m];
  }
  for (let m = 0; m < N; m++) {
    const g = G[m];
    if (g < gMin) gMin = g;
    if (pk[m] > gate) {
      cnt++;
      if (g < 1) {
        prod *= g > 1e-100 ? g : 1e-100;
        if (prod < 1e-150) {
          sumLn += Math.log(prod);
          prod = 1;
        }
        if (g < g1) cnt1++;
      }
    }
  }
  sumLn += Math.log(prod);
  stats.grAvgDb = cnt ? (DB20 * sumLn) / cnt : 0;
  stats.grMaxDb = gMin < 1 ? DB20 * Math.log(gMin) : 0;
  stats.grPctAbove1dB = cnt ? (100 * cnt1) / cnt : 0;
  stats.runs = runs;
  stats.trimDb = trim < 1 ? DB20 * Math.log(trim) : 0;
  return stats;
}

/**
 * Turn over-ceiling events into local ceiling caps: around each event the detector's
 * estimate of the output level (max g·pk) is lowered by the excess + 0.05 dB. An absolute
 * cap (not a factor on the ceiling) also works where the gain was 1 (an interpolator
 * reading above the limiter detector's), because the cap then drops below pk.
 * Returns the verification blocks touched (they must be re-verified).
 */
function addRegions(regions, ev, N, G, pk) {
  const extra = Math.exp(-0.05 * LN10_20);
  const PAD = 16;
  const touched = [];
  for (let i = 0; i < ev.n; i++) {
    const s = Math.max(0, ev.pos[i] - PAD), e = Math.min(N, ev.end[i] + PAD + 1);
    let level = 0;
    for (let m = s; m < e; m++) {
      const v = G[m] * pk[m];
      if (v > level) level = v;
    }
    if (level > 0) regions.push([s, e, (level * extra) / ev.ratio[i]]);
    touched.push(s >> VB_SHIFT, (e - 1) >> VB_SHIFT);
  }
  return touched;
}

/** Overlapping [start, end, cap] regions → sorted breakpoints [pos, min cap, …]. */
function breakpoints(regions) {
  const bounds = new Set();
  for (const r of regions) {
    bounds.add(r[0]);
    bounds.add(r[1]);
  }
  const pos = Array.from(bounds).sort((a, b) => a - b);
  const byStart = regions.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let active = [];
  let j = 0;
  for (const p of pos) {
    while (j < byStart.length && byStart[j][0] <= p) active.push(byStart[j++]);
    active = active.filter((r) => r[1] > p);
    let cap = Infinity;
    for (const r of active) if (r[2] < cap) cap = r[2];
    out.push(p, cap);
  }
  return out;
}

// ---------------------------------------------------------------- soft clipper

/** Largest float32 value <= v (v > 0). */
function f32AtMost(v) {
  const f = new Float32Array([v]);
  if (f[0] > v) {
    const i = new Int32Array(f.buffer);
    i[0] -= 1;
  }
  return f[0];
}

/**
 * Replica of oversample.js's 'limiter' 4x interpolator (Kaiser-windowed sinc, β 4.5,
 * fc 0.49·fs, 16 taps per phase), pair form: for the interval [i, i+1] with
 * s_j = x[i+1+j] + x[i−j], d_j = x[i+1+j] − x[i−j]: u(i+¼) = Σe·s + Σg·d,
 * u(i+¾) = Σe·s − Σg·d, u(i+½) = Σc·s. The clipper decides with the same 4x view of the
 * signal that the limiter's detector uses.
 */
function limiterDesign(H, beta, fc) {
  const i0b = besselI0(beta);
  const h = (t) => {
    const u = t / H;
    if (u >= 1) return 0;
    return 2 * fc * sinc(2 * fc * t) * (besselI0(beta * Math.sqrt(1 - u * u)) / i0b);
  };
  const e = new Float64Array(H), g = new Float64Array(H), c = new Float64Array(H);
  let s1 = 0, s2 = 0;
  for (let j = 0; j < H; j++) {
    const a = h(0.75 + j);
    const b = h(0.25 + j);
    e[j] = 0.5 * (a + b);
    g[j] = 0.5 * (a - b);
    c[j] = h(0.5 + j);
    s1 += a + b;
    s2 += 2 * c[j];
  }
  for (let j = 0; j < H; j++) {
    e[j] /= s1;
    g[j] /= s1;
    c[j] /= s2;
  }
  return { e, g, c, H };
}
const LIM4 = limiterDesign(8, 4.5, 0.49);
// Σ|taps| of the worst phase: exact bound of |u| by max|x| over the 16-sample support.
const LIM4_BOUND = Math.max(
  LIM4.e.reduce((acc, e, j) => acc + Math.abs(e + LIM4.g[j]) + Math.abs(e - LIM4.g[j]), 0),
  LIM4.c.reduce((acc, c) => acc + 2 * Math.abs(c), 0),
);

// Decimation of a 4x residual: impulse responses of oversample.downsample(·, 4) for an
// impulse at 4x position 4i + p (p = 0..3), as base-rate kernels over i − KD … i + KD.
// downsample is linear and shift-invariant by 4, so Σ r_j·kernel equals downsample(r).
const KD = 28;
const CLIP_CHUNK = 16384;
const PADX = 40; // padding of the clipper's sample window (>= KU + 1, >= 8 + 1)
const KU = 28; // reach of the 4x interpolation kernels below
let upKernels = null;
/**
 * oversample.upsample(·, 4) as three direct kernels (its 90 dB half-band cascade):
 * u(i + p/4) = Σ_k t_p[k + KU]·x[i − k], k = −KU … KU (probed once; upsample is linear and
 * shift-invariant, so this reproduces it exactly).
 */
function upsampleKernels() {
  if (upKernels) return upKernels;
  const c = 64;
  const imp = new Float32Array(2 * c + 1);
  imp[c] = 1;
  const up = upsample(imp, 4);
  upKernels = [null];
  for (let p = 1; p < 4; p++) {
    upKernels.push(Float64Array.from({ length: 2 * KU + 1 }, (_, j) => up[4 * c + 4 * (j - KU) + p]));
  }
  return upKernels;
}
let decKernels = null;
function decimationKernels() {
  if (decKernels) return decKernels;
  const c = 64;
  decKernels = [];
  for (let p = 0; p < 4; p++) {
    const r = new Float32Array(4 * (2 * c + 1));
    r[4 * c + p] = 1;
    const d = downsample(r, 4);
    decKernels.push(Float64Array.from({ length: 2 * KD + 1 }, (_, k) => d[c - KD + k]));
  }
  return decKernels;
}

/**
 * 4x-oversampled smooth clipper, in place, zero latency.
 * Curve (research/05 §4.5 knee clipper), with c = 10^(thresholdDb/20) the ceiling and
 * T = c·10^(−kneeDb/40) the end of the linear region — kneeDb is the knee width in dB,
 * centred so that the clipper is exactly transparent below thresholdDb − kneeDb/2
 * (kneeDb = 6 gives RESEARCH's T = c·10^(−3/20); kneeDb = 0 is a hard clip):
 *   |y| = |x|                                  for |x| <= T
 *   |y| = T + (c − T)·tanh((|x| − T)/(c − T))  above (C¹ at T, asymptote c).
 * Oversampling: u = oversample.upsample(x, 4) (90 dB half-band cascade, evaluated only
 * where needed); the 4x points above T are clipped and only the clipping residual
 * f(u) − u is decimated with oversample.downsample and added back
 * (y = x + down4(f(u) − u)) — identical to a full up/clip/down chain on everything the
 * curve touches, while untouched audio passes bit-exactly and the band above 0.44·fs is
 * not dulled by a filter round trip. Work is proportional to the material near T: blocks
 * and 8-sample groups are skipped with the exact bound Σ|taps|·max|x| of the cheap 16-tap
 * 'limiter' interpolator, which also screens intervals (0.5 dB margin) before the exact
 * cascade values are computed.
 * The band-limited result can overshoot the 4x clip level by ~0.1 dB (more for full-scale
 * tones near Nyquist); such samples are pulled back with smooth gain dips (1.5 ms tapers), so no
 * output sample exceeds the threshold. The true peak may sit slightly above it — the
 * limiter follows.
 * @param {Float32Array[]} channels processed in place (each channel independently)
 * @param {number} sampleRate
 * @param {{ thresholdDb: number, kneeDb?: number }} opts
 * @returns {{ grMaxDb: number, clippedPct: number }} deepest reduction of the static curve
 *   (<= 0 dB) and % of 4x points above T
 */
export function softClip(channels, sampleRate, opts = {}) {
  const chans = asChannels(channels);
  const out = { grMaxDb: 0, clippedPct: 0 };
  const thresholdDb = opts.thresholdDb;
  if (!chans.length || !Number.isFinite(thresholdDb)) return out;
  const kneeDb = Math.max(0, finiteOr(opts.kneeDb, 1.5));
  const cRaw = Math.exp(Math.min(thresholdDb, 60) * LN10_20);
  const c = f32AtMost(cRaw); // stored samples must not round above the threshold
  const T = cRaw * Math.exp((-kneeDb / 2) * LN10_20);
  const span = cRaw - T;
  const ker = decimationKernels();
  const st = { clipped: 0, worst: 1 };
  const ws = {
    xb: new Float64Array(CLIP_CHUNK + 2 * PADX + 8),
    res: new Float64Array(CLIP_CHUNK + 2 * KD + 1),
    pts: new Float64Array(4 * CLIP_CHUNK),
    gm: new Float64Array(((CLIP_CHUNK + 2 * PADX) >> 3) + 4),
    list: new Int32Array(CLIP_CHUNK),
  };
  let total = 0;
  const BS = 64;
  const segs = [];
  const dipW = Math.max(4, Math.round(1.5e-3 * sampleRate)); // 1.5 ms raised-cosine tapers
  for (const x of chans) {
    const N = x.length;
    total += 4 * N;
    if (!N) continue;
    const nb = Math.ceil(N / BS);
    const bm = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let m = 0;
      for (let i = b * BS, e = Math.min(N, i + BS); i < e; i++) {
        const a = x[i] < 0 ? -x[i] : x[i];
        if (a > m) m = a;
      }
      bm[b] = m;
    }
    // block b can produce |u| > T only if its samples ±8 (neighbour blocks) can
    const lim = T / LIM4_BOUND;
    const cand = (b) => (bm[b] > lim || (b > 0 && bm[b - 1] > lim) || (b + 1 < nb && bm[b + 1] > lim));
    let b = 0;
    while (b < nb) {
      if (!cand(b)) {
        b++;
        continue;
      }
      let e = b + 1;
      while (e < nb && cand(e)) e++;
      const sa = b * BS, sb = Math.min(N, e * BS);
      clipSegment(x, sa, sb, T, c, span, ker, st, ws);
      segs.push(Math.max(0, sa - KD), Math.min(N, sb + KD));
      b = e;
    }
    // The decimated (band-limited) result can overshoot the 4x clip level slightly; pull
    // such samples back with smooth local gain dips instead of a hard clamp (a clamp at
    // the base rate would re-introduce exactly the aliasing the oversampling removed).
    for (let k = 0; k < segs.length; k += 2) peakDips(x, segs[k], segs[k + 1], c, dipW, st);
    segs.length = 0;
  }
  out.grMaxDb = st.worst < 1 ? DB20 * Math.log(st.worst) : 0;
  out.clippedPct = total ? (100 * st.clipped) / total : 0;
  return out;
}

/** Curve value for a magnitude a > T. */
function clipCurve(a, T, c, span) {
  return span > 0 ? T + span * Math.tanh((a - T) / span) : c;
}

/**
 * Clip [a, b) of x in place, in chunks. Interpolation reads original samples only: a
 * chunk's residual is written back only up to where the next chunk can still read
 * (KD behind its start); the rest is carried.
 */
function clipSegment(x, a, b, T, c, span, ker, st, ws) {
  const N = x.length;
  const CH = CLIP_CHUNK;
  const k = LIM4;
  const le0 = k.e[0], le1 = k.e[1], le2 = k.e[2], le3 = k.e[3], le4 = k.e[4], le5 = k.e[5], le6 = k.e[6], le7 = k.e[7];
  const lg0 = k.g[0], lg1 = k.g[1], lg2 = k.g[2], lg3 = k.g[3], lg4 = k.g[4], lg5 = k.g[5], lg6 = k.g[6], lg7 = k.g[7];
  const lc0 = k.c[0], lc1 = k.c[1], lc2 = k.c[2], lc3 = k.c[3], lc4 = k.c[4], lc5 = k.c[5], lc6 = k.c[6], lc7 = k.c[7];
  // xb: padded samples · res: base-rate residual (zero outside [resLo, resHi)) ·
  // pts: 4x residual (kept all-zero between uses) · list: clipped intervals of the chunk
  const { xb, res, pts, gm, list } = ws;
  const [k0, k1, k2, k3] = ker;
  const [, u1, u2, u3] = upsampleKernels();
  const KW = 2 * KU + 1;
  const W = 2 * KD + 1;
  const lim = T / LIM4_BOUND;
  // screen margin: the cheap interpolator agrees with the cascade within a few hundredths
  // of a dB below 0.45·fs; 0.5 dB leaves ample room
  const Tscr = T * Math.exp(-0.5 * LN10_20);
  let resLo = 0, resHi = 0;
  for (let ca = a; ca < b; ca += CH) {
    const cb = Math.min(b, ca + CH);
    const len = cb - ca;
    const off = ca - KD; // res[q] ↔ sample off + q
    // padded copy: xb[q] = x[ca − PADX + q] (zero outside the signal)
    const span2 = len + 2 * PADX + 1;
    const lo = Math.max(0, ca - PADX), hi = Math.min(N, ca - PADX + span2);
    const q0 = lo - (ca - PADX), q1 = hi - (ca - PADX);
    for (let q = 0; q < q0; q++) xb[q] = 0;
    for (let q = q0, i = lo; q < q1; q++, i++) xb[q] = x[i];
    for (let q = q1; q < span2; q++) xb[q] = 0;
    // 8-sample groups gm[g] = max|xb[8g … 8g+7]|. Intervals 8g … 8g+7 read (cheap screen)
    // xb[ii+PADX−7 … ii+PADX+8] ⊂ groups g+4 … g+6, so LIM4_BOUND·max skips them exactly.
    const ng = (len + 7) >> 3;
    for (let g = 0, ge = (span2 + 7) >> 3; g < ge; g++) {
      let m = 0;
      for (let q = 8 * g, qe = Math.min(span2, q + 8); q < qe; q++) {
        const v = xb[q] < 0 ? -xb[q] : xb[q];
        if (v > m) m = v;
      }
      gm[g] = m;
    }
    let nClip = 0;
    for (let g = 0; g < ng; g++) {
      if (gm[g + 4] <= lim && gm[g + 5] <= lim && gm[g + 6] <= lim) continue;
      for (let ii = 8 * g, i1 = Math.min(len, ii + 8); ii < i1; ii++) {
        const cc = ii + PADX; // xb index of x[i]
        const m0 = xb[cc], p0 = xb[cc + 1], s0 = p0 + m0, d0 = p0 - m0;
        const m1 = xb[cc - 1], p1 = xb[cc + 2], s1 = p1 + m1, d1 = p1 - m1;
        const m2 = xb[cc - 2], p2 = xb[cc + 3], s2 = p2 + m2, d2 = p2 - m2;
        const m3 = xb[cc - 3], p3 = xb[cc + 4], s3 = p3 + m3, d3 = p3 - m3;
        const m4 = xb[cc - 4], p4 = xb[cc + 5], s4 = p4 + m4, d4 = p4 - m4;
        const m5 = xb[cc - 5], p5 = xb[cc + 6], s5 = p5 + m5, d5 = p5 - m5;
        const m6 = xb[cc - 6], p6 = xb[cc + 7], s6 = p6 + m6, d6 = p6 - m6;
        const m7 = xb[cc - 7], p7 = xb[cc + 8], s7 = p7 + m7, d7 = p7 - m7;
        const E = le0 * s0 + le1 * s1 + le2 * s2 + le3 * s3 + le4 * s4 + le5 * s5 + le6 * s6 + le7 * s7;
        const G = lg0 * d0 + lg1 * d1 + lg2 * d2 + lg3 * d3 + lg4 * d4 + lg5 * d5 + lg6 * d6 + lg7 * d7;
        const M = lc0 * s0 + lc1 * s1 + lc2 * s2 + lc3 * s3 + lc4 * s4 + lc5 * s5 + lc6 * s6 + lc7 * s7;
        const a0 = m0 < 0 ? -m0 : m0, a1 = Math.abs(E) + Math.abs(G), a2 = M < 0 ? -M : M;
        if (a0 <= T && a1 <= Tscr && a2 <= Tscr) continue;
        // candidate: the exact 4x points of oversample.upsample (90 dB cascade)
        let v1 = 0, v2 = 0, v3 = 0;
        for (let j = 0, o = cc + KU; j < KW; j++, o--) {
          const xv = xb[o];
          v1 += u1[j] * xv;
          v2 += u2[j] * xv;
          v3 += u3[j] * xv;
        }
        const r0 = clipRes(m0, T, c, span, st), r1 = clipRes(v1, T, c, span, st);
        const r2 = clipRes(v2, T, c, span, st), r3 = clipRes(v3, T, c, span, st);
        if (r0 === 0 && r1 === 0 && r2 === 0 && r3 === 0) continue;
        const q = 4 * ii;
        pts[q] = r0;
        pts[q + 1] = r1;
        pts[q + 2] = r2;
        pts[q + 3] = r3;
        list[nClip++] = ii;
      }
    }
    if (nClip > 0) {
      if (nClip > len >> 3) {
        // dense: decimate the chunk's 4x residual with the half-band cascade
        const r4 = new Float32Array(4 * (len + 2 * KD));
        r4.set(pts.subarray(0, 4 * len), 4 * KD);
        const d = downsample(r4, 4);
        for (let q = 0; q < d.length; q++) res[q] += d[q];
      } else {
        for (let n = 0; n < nClip; n++) {
          const i = list[n], q = 4 * i;
          const r0 = pts[q], r1 = pts[q + 1], r2 = pts[q + 2], r3 = pts[q + 3];
          // kernel index t ↔ sample i + t − KD ↔ res[i + t]
          for (let t = 0; t < W; t++) res[i + t] += r0 * k0[t] + r1 * k1[t] + r2 * k2[t] + r3 * k3[t];
        }
      }
      for (let n = 0; n < nClip; n++) pts.fill(0, 4 * list[n], 4 * list[n] + 4);
      if (resHi <= resLo) resLo = list[0];
      else if (list[0] < resLo) resLo = list[0];
      if (list[nClip - 1] + W > resHi) resHi = list[nClip - 1] + W;
    }
    // final positions: everything below the next chunk's reach (cb − KD), all at the end
    const last = cb >= b;
    const finalEnd = last ? Math.min(N, cb + KD) : cb - KD;
    const wEnd = Math.min(finalEnd - off, resHi);
    for (let q = Math.max(resLo, -off); q < wEnd; q++) x[off + q] += res[q];
    if (!last) {
      // carry res for [cb − KD, cb + KD] to the next chunk (its offset is cb − KD)
      const from = cb - KD - off;
      const nLo = Math.max(resLo, from) - from, nHi = Math.min(resHi, from + W) - from;
      res.copyWithin(0, from, from + W);
      res.fill(0, W, res.length);
      if (nHi > nLo) {
        res.fill(0, 0, nLo);
        res.fill(0, nHi, W);
        resLo = nLo;
        resHi = nHi;
      } else {
        res.fill(0, 0, W);
        resLo = resHi = 0;
      }
    } else if (resHi > resLo) {
      res.fill(0, resLo, resHi);
      resLo = resHi = 0;
    }
  }
}

/**
 * Guarantee |x| <= c on [a, b): every run of samples above c (gaps shorter than 2w are
 * bridged, so dense overshoots get one steady gain instead of a fluttering one) gets a
 * gain dip of depth min(c/|x|) over the run, with raised-cosine tapers of `w` samples on
 * both sides (dips multiply; neighbours outside [a, b) are only ever reduced).
 */
function peakDips(x, a, b, c, w, st) {
  const N = x.length;
  let i = a;
  while (i < b) {
    if (!(Math.abs(x[i]) > c)) {
      i++;
      continue;
    }
    let j = i, gReq = 1;
    // a run: samples above c, bridging gaps shorter than the taper
    while (j < b) {
      const v = Math.abs(x[j]);
      if (v > c) {
        const g = c / v;
        if (g < gReq) gReq = g;
        j++;
      } else {
        let k = j;
        while (k < b && k < j + 2 * w && !(Math.abs(x[k]) > c)) k++;
        if (k < b && k < j + 2 * w) j = k;
        else break;
      }
    }
    gReq = f32Below(gReq); // the stored product must not round back above c
    const depth = 1 - gReq;
    const lo = Math.max(0, i - w), hi = Math.min(N, j + w);
    for (let n = lo; n < hi; n++) {
      let wt = 1;
      if (n < i) wt = 0.5 - 0.5 * Math.cos((Math.PI * (n - (i - w))) / w);
      else if (n >= j) wt = 0.5 - 0.5 * Math.cos((Math.PI * (j + w - n)) / w);
      x[n] *= 1 - depth * wt;
    }
    for (let n = i; n < j; n++) {
      // float32 rounding safety (the run itself got exactly gReq)
      if (x[n] > c) x[n] = c;
      else if (x[n] < -c) x[n] = -c;
    }
    if (gReq < st.worst) st.worst = gReq;
    i = j;
  }
}

/** Slightly smaller than g (a few ulps) so x·g stored as float32 stays below c·… */
function f32Below(g) {
  return g * (1 - 4e-7);
}

/** Residual f(u) − u of one 4x point (0 when |u| <= T); updates the statistics. */
function clipRes(u, T, c, span, st) {
  const a = u < 0 ? -u : u;
  if (!(a > T)) return 0;
  const fv = clipCurve(a, T, c, span);
  st.clipped++;
  const ratio = fv / a;
  if (ratio < st.worst) st.worst = ratio;
  return (u < 0 ? -fv : fv) - u;
}
