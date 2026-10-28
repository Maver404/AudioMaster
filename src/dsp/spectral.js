// STFT "AI artifact cleanup": de-shimmer (de-ring of flickering narrowband HF peaks)
// and stationary-hiss spectral denoise. Environment-neutral, offline, in place.
//
// Framework (RESEARCH §7 "STFT", 05-dsp-algorithms §8.1):
// * √Hann (sine) analysis + synthesis window, hop N/4: Σ w² = Σ Hann = 2.0 exactly, so the
//   overlap-add is divided by 2. Masks are real and non-negative; phase is kept.
// * The processor is written in "delta" form: y = x + OLA(w·IFFT((G − 1)·FFT(w·x)))/2.
//   This is algebraically identical to plain WOLA resynthesis, but bins with G = 1
//   contribute nothing, so everything outside the processed region passes through
//   bit-exactly, frames without any gain change skip the inverse FFTs, and identity is
//   exact (not merely ≈1e-7) when nothing is detected.
// * Zero latency / exact length: frames start at −(N − H) (virtual zero padding), so every
//   sample is covered by all four frames; output index = input index, nothing to shift.
//   Finished samples are written back while streaming (O(N) memory per channel).
// * Gains are computed once per frame from the LINKED power |L|² + |R|² and applied to
//   both channels, so the stereo image and the inter-channel phase never move.

import { FFT, RealFFT, hann } from './fft.js';

const DB_PER_NEPER_POW = 10 / Math.LN10; // 10·log10(x) = DB_PER_NEPER_POW · ln(x)
const DB_PER_NEPER_AMP = 20 / Math.LN10;
const POW_PER_DB = Math.LN10 / 10; // x = exp(dB · POW_PER_DB)
const AMP_PER_DB = Math.LN10 / 20;

// ---- de-shimmer constants (RESEARCH §2 / 05 §8.4; engineering values, tuned on tests) --
// The local envelope is a robust log-mean over ±1/12 octave (a 1/6-octave window). Each
// side is evaluated separately and the HIGHER side is used, so a codec low-pass edge
// (one side empty) or a steep slope never looks like a peak: a peak must stand out of
// BOTH sides. The ±1 centre bins around the evaluated bin are excluded (√Hann main lobe
// is ±1.5 bins wide).
const ENV_HALF_OCT = 1 / 12;
const ENV_GAP = 2;
const ENV_MIN_HALF = 5;
const ENV_MIN_SIDE = 3;
// First pass: plain windowed log-mean; values above it + CLIP_DB are clipped before the
// final (per-side) means so neighbouring partials do not inflate the envelope.
const CLIP_DB = 8;
// A clipped log-mean of gamma-distributed bin powers sits below their mean power (Euler γ:
// E[ln X] = ln μ − 0.577 for |X|² of one complex Gaussian). SAL_BIAS converts it so that
// "x dB above the envelope" means above the mean noise power. Measured on white and pink
// noise: +0.8 dB (uncorrelated L/R) … +2.0 dB (L = R) → centre value.
const SAL_BIAS_DB = 1.4;
const SAL_T0_DB = 6; // score starts at 6 dB peak excess (RESEARCH §2) …
const SAL_T1_DB = 9; // … and is full at 9 dB
const FLK_T0_DB = 3; // flicker > 3 dB (RESEARCH §2) …
const FLK_T1_DB = 4.5; // … full at 4.5 dB
const SAL_TAU_MS = 50; // power-domain smoothing of the peak ratio (intermittent peaks stay salient)
const FLK_TAU_MS = 100; // ≈ mean |Δ| over ≈10 frames (05 §8.4: 6–12 frames, 70–140 ms)
const FLK_LAG_MS = 21.3; // compare frames ≈21 ms apart (codec-frame scale, 50 % overlap)
// The detector (envelope, salience, flicker → target gain) runs on every frame whose
// start is a multiple of ≈21 ms (every 2nd frame at 44.1–96 kHz): its estimators are
// smoothed over 50–100 ms anyway, so this halves its cost with no measurable change in
// detection. Gain smoothing and synthesis still run on every hop (N/4).
const DS_ANALYSIS_MS = 21.3;
// Flicker is tolerant to frequency motion. A bin's level is compared with the other
// frame's level at the same bin OR any clear peak (≥ FLK_PEAK_DB over the local envelope)
// within ±FLK_TRACK of its frequency, so a partial that merely MOVES (vibrato: up to
// ≈2.3 % per 21 ms for ±50 cents at 6 Hz) is not flicker, while one that appears or
// vanishes is. Only clear peaks qualify there, because the maximum over many noise bins
// would bias the reference up and hide real flicker. A second, all-bin maximum (which
// also catches a partial smeared by fast vibrato) scales an observation down when it says
// the energy is still there (change < FLK_MOVE_DB).
const FLK_TRACK = 0.03;
const FLK_PEAK_DB = 9;
const FLK_MOVE_DB = 4;
const FLK_MAX_DB = 40; // clamp of a single flicker observation
const DS_ATTACK_MS = 20; // gain smoothing: reduction engages in 20 ms …
const DS_RELEASE_MS = 80; // … and recovers in 80 ms (contract)
const DS_TOP_HZ = 20000; // nothing audible above; saves work (and halves it at 96 kHz)
// Co-modulation veto (musical gates, stabs, deep tremolo). A gated or tremoloed harmonic
// sound switches its LOW harmonics in step with its HF ones, so the 1–5 kHz level moves
// with the partial's on/off pattern; codec / generator shimmer flickers on its own while
// the low band stays put. Per bin, the flicker observations (signed: + appeared,
// − vanished) are correlated with the frame-to-frame change of the reference band over
// the same lag, both clipped to ±CM_CLIP_DB so every on/off event counts once whatever
// its depth (Pearson on raw dB would let one 40 dB coincidence dominate). The reference
// is the whole band and each of its CM_SUB sub-bands (≈ half an octave): the best one
// counts, because a vocal or pad may fill most of the band while the gated sound's low
// harmonics still dominate one part of it. Correlation ≤ CM_C0: unchanged; ≥ CM_C1: not
// an artifact (score 0); linear in between. Deliberately NOT a share of HF bins moving
// together: MP3 scalefactor-band dropouts switch neighbouring HF bins together too, but
// leave 1–5 kHz alone. Measured: gates / stabs / tremolo ≥ 0.7, injected and demo
// shimmer ≤ 0.3 (99th percentile), MP3 hash above 16 kHz in real Suno exports < 0.4 in
// ≥ 95 % of the decisions (their 5–16 kHz candidates spread over 0–0.7).
const CM_LO_HZ = 1000;
const CM_HI_HZ = 5000; // capped below startHz
const CM_SUB = 4;
const CM_MIN_BINS = 8; // narrower reference (startHz < ≈1.2 kHz): no veto
const CM_TAU_MS = 1500; // gates repeat for bars; chance coincidences average out
const CM_CLIP_DB = 3; // = FLK_T0_DB
const CM_FLOOR_DB = 0.5; // reference changes below ≈0.5 dB RMS cannot correlate
const CM_C0 = 0.4;
const CM_C1 = 0.65;

// ---- denoise constants -----------------------------------------------------------------
const DN_ALPHA = 0.98; // Ephraim–Malah decision-directed a-priori SNR smoothing (Cappé 1994)
const DN_XI_MIN = 1e-3;
const DN_PCT = 0.05; // noise floor = 5th percentile of frame power per bin (02 §7.3 M6)
const DN_SMOOTH_BINS = 4; // ±4-bin power average before the percentile (variance ↓)
// Low percentile → mean noise power. The ±4-bin average of linked power is roughly gamma
// distributed with 7–14 degrees of freedom (L = R … uncorrelated L/R noise): its 5th
// percentile sits ≈2.3–3.4 dB below the mean. Measured on white noise → centre value.
const DN_BIAS_DB = 2.9;
const DN_HIST_MIN_DB = -200;
const DN_HIST_MAX_DB = 20;
const DN_HIST_STEP_DB = 0.5;
const DN_SILENT_RMS_DB = -90; // frames below this (full-band-equivalent RMS) are not "noise"
const DN_MIN_FRAMES = 8;
const DN_MAX_FRAMES = 2000; // ≥ 100 frames below the 5th percentile: plenty; bounds pass-1 time
const DN_OPEN_MS = 5; // gain opens fast (protects onsets) …
const DN_CLOSE_MS = 100; // … and closes slowly (no musical noise)

/** STFT size used for a sample rate (ARCHITECTURE §3: 2048 up to 50 kHz, 4096 above). */
function fftSizeFor(sampleRate) {
  return sampleRate <= 50000 ? 2048 : 4096;
}

/** Periodic √Hann (= sine) window; w² sums to exactly 2 at hop N/4. */
function sqrtHann(n) {
  const w = hann(n, true);
  for (let i = 0; i < n; i++) w[i] = Math.sqrt(w[i]);
  return w;
}

/** Raised-cosine weight in log-frequency: 0 at/below f0, 1 at/above f1. */
function logRamp(f, f0, f1) {
  if (f <= f0) return 0;
  if (!(f1 > f0) || f >= f1) return 1;
  const x = Math.log(f / f0) / Math.log(f1 / f0);
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

// 10^(x/10) for x in dB (clamped to ±60 dB): integer-dB table × short Taylor series of
// e^u, u < 0.23 (rel. error < 2e-7). About 2× faster than Math.exp in the hot loop.
const DBP_TABLE = new Float64Array(121);
for (let i = 0; i <= 120; i++) DBP_TABLE[i] = Math.pow(10, (i - 60) / 10);
function dbToPow(x) {
  if (x < -60) x = -60;
  else if (x > 59.999) x = 59.999;
  const xf = Math.floor(x);
  const u = (x - xf) * POW_PER_DB;
  return DBP_TABLE[xf + 60] * (1 + u * (1 + u * (0.5 + u * (1 / 6 + u * (1 / 24 + u * (1 / 120))))));
}

function onePole(ms, hopSec) {
  return Math.exp(-hopSec / (ms * 1e-3));
}

function clampAmount(a) {
  const v = Number(a);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Generic zero-latency STFT gain processor (√Hann, hop N/4, delta-form overlap-add),
 * in place. Exposed for reuse and for exact reconstruction tests.
 *
 * Per frame, `frameFn(power, gains, frameIndex)` receives the linked power spectrum
 * (Σ over channels of |X[k]|², bins 0..N/2, valid from `opts.powerFrom` upward) and a
 * persistent gain array (bins 0..N/2). It must return the lowest bin index whose gain may
 * differ from 1 (gains at and above it must all be valid), or −1 when the frame is left
 * untouched. Gains are real; phase is preserved; all channels share the same gains.
 * Frames whose power is not finite are left untouched (frameFn is not called).
 *
 * @param {Float32Array[]} channels processed in place (any count ≥ 1, equal lengths)
 * @param {number} sampleRate
 * @param {(power: Float64Array, gains: Float64Array, frame: number) => number} frameFn
 * @param {{ fftSize?: number, powerFrom?: number, onProgress?: (f: number) => void,
 *           progressFrom?: number, progressTo?: number }} [opts]
 * @returns {{ frames: number, fftSize: number, hop: number }}
 */
export function stftProcess(channels, sampleRate, frameFn, opts = {}) {
  const nCh = channels ? channels.length : 0;
  const len = nCh ? channels[0].length : 0;
  const N = opts.fftSize || fftSizeFor(sampleRate);
  const H = N >> 2;
  const K = N >> 1;
  if (!nCh || !len) return { frames: 0, fftSize: N, hop: H };
  const pad = N - H;
  const powerFrom = Math.max(0, Math.min(K, opts.powerFrom | 0));
  const win = sqrtHann(N);
  const win2 = win.map((v) => 0.5 * v); // synthesis window with the ÷2 of Σw² = 2 folded in
  const ola = [];
  for (let c = 0; c < nCh; c++) ola.push(new Float64Array(N));
  const power = new Float64Array(K + 1);
  const gains = new Float64Array(K + 1).fill(1);
  const nFrames = Math.floor((len - 1 + pad) / H) + 1;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const p0 = opts.progressFrom ?? 0;
  const p1 = opts.progressTo ?? 1;
  const progEvery = Math.max(1, Math.floor(nFrames / 50));
  let sinceDirty = 4; // frames since the last modification; ≥ 4 ⇒ OLA buffers are all zero

  // Stereo: one complex FFT of wL + i·wR per frame. Because the gains are real and
  // symmetric, the inverse of (G − 1)·Z directly yields δL + i·δR — no unpacking — and the
  // linked power is (|Z[k]|² + |Z[N−k]|²)/2. Other channel counts: one RealFFT each.
  const stereo = nCh === 2;
  const cfft = stereo ? new FFT(N) : null;
  const zr = stereo ? new Float64Array(N) : null;
  const zi = stereo ? new Float64Array(N) : null;
  const rfft = stereo ? null : new RealFFT(N);
  // Fast path through the FFT's bit-reversed core (as RealFFT itself does): saves the two
  // permutation passes and the 1/N scaling pass per frame (≈5 % of the run time). It is
  // verified once against the public API and falls back to it if fft.js ever changes.
  const rev = stereo && fftCoreUsable(cfft, N) ? cfft.rev : null;
  const yr = rev ? new Float64Array(N) : null;
  const yi = rev ? new Float64Array(N) : null;
  const win2n = win2.map((v) => v / N);
  const frame = new Float64Array(N);
  const re = [];
  const im = [];
  if (!stereo) {
    for (let c = 0; c < nCh; c++) {
      re.push(new Float64Array(K + 1));
      im.push(new Float64Array(K + 1));
    }
  }

  // The per-frame work lives in small helpers: they are called thousands of times and get
  // fully optimized, whereas a single long-running loop body would only be OSR-compiled.
  for (let t = 0; t < nFrames; t++) {
    const s = t * H - pad;
    let tot;
    if (stereo) {
      if (rev) {
        loadFrame2Rev(channels[0], channels[1], s, len, win, zr, zi, rev);
        cfft._butterflies(zr, zi);
      } else {
        loadFrame2(channels[0], channels[1], s, len, win, zr, zi);
        cfft.forward(zr, zi);
      }
      tot = packedPower(zr, zi, power, powerFrom, K);
    } else {
      for (let c = 0; c < nCh; c++) {
        loadFrame(channels[c], s, len, win, frame);
        rfft.forward(frame, re[c], im[c]);
      }
      tot = linkedPower(re, im, power, powerFrom, K);
    }
    const kLow = Number.isFinite(tot) ? frameFn(power, gains, t) : -1;
    if (kLow >= 0 && kLow <= K) {
      if (stereo) {
        if (rev) {
          // gains + bit-reversal in one pass; inverse = swap(FFT(swap(Z)))/N
          deltaGainsPackedRev(zr, zi, gains, kLow, K, rev, yr, yi);
          cfft._butterflies(yi, yr);
          overlapAdd2(ola[0], ola[1], yr, yi, win2n);
        } else {
          applyDeltaGainsPacked(zr, zi, gains, kLow, K);
          cfft.inverse(zr, zi);
          overlapAdd2(ola[0], ola[1], zr, zi, win2);
        }
      } else {
        for (let c = 0; c < nCh; c++) {
          applyDeltaGains(re[c], im[c], gains, kLow, K);
          rfft.inverse(re[c], im[c], frame);
          overlapAdd(ola[c], frame, win2);
        }
      }
      sinceDirty = 0;
    } else if (sinceDirty < 4) {
      sinceDirty++;
    }
    // Samples [s, s+H) are now final: no later frame overlaps them.
    if (sinceDirty < 4) {
      for (let c = 0; c < nCh; c++) flushOla(ola[c], channels[c], s, len, H);
    }
    if (onProgress && t % progEvery === 0) onProgress(p0 + ((p1 - p0) * t) / nFrames);
  }
  return { frames: nFrames, fftSize: N, hop: H };
}

const coreChecked = new Map();
/** True when FFT internals (`rev`, `_butterflies` on bit-reversed input) match forward(). */
function fftCoreUsable(fft, N) {
  if (coreChecked.has(N)) return coreChecked.get(N);
  let ok = typeof fft._butterflies === 'function' && fft.rev instanceof Int32Array && fft.rev.length === N;
  if (ok) {
    const a = new Float64Array(N), b = new Float64Array(N), c = new Float64Array(N), d = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      a[n] = Math.sin(0.37 * n) + 0.1 * (n % 7);
      b[n] = Math.cos(0.11 * n * n);
      c[fft.rev[n]] = a[n];
      d[fft.rev[n]] = b[n];
    }
    fft.forward(a, b);
    fft._butterflies(c, d);
    for (let n = 0; n < N && ok; n++) ok = Math.abs(a[n] - c[n]) < 1e-9 && Math.abs(b[n] - d[n]) < 1e-9;
  }
  coreChecked.set(N, ok);
  return ok;
}

/** Windowed stereo frame packed as re = w·L, im = w·R (zeros outside [0, len)). */
function loadFrame2(xL, xR, s, len, win, zr, zi) {
  const N = zr.length;
  if (s >= 0 && s + N <= len) {
    for (let n = 0; n < N; n++) {
      const w = win[n];
      zr[n] = xL[s + n] * w;
      zi[n] = xR[s + n] * w;
    }
  } else {
    for (let n = 0; n < N; n++) {
      const i = s + n;
      const ok = i >= 0 && i < len;
      zr[n] = ok ? xL[i] * win[n] : 0;
      zi[n] = ok ? xR[i] * win[n] : 0;
    }
  }
}

/** Same as loadFrame2, written in bit-reversed order (input of FFT._butterflies). */
function loadFrame2Rev(xL, xR, s, len, win, zr, zi, rev) {
  const N = zr.length;
  if (s >= 0 && s + N <= len) {
    for (let n = 0; n < N; n++) {
      const w = win[n];
      const j = rev[n];
      zr[j] = xL[s + n] * w;
      zi[j] = xR[s + n] * w;
    }
  } else {
    for (let n = 0; n < N; n++) {
      const i = s + n;
      const ok = i >= 0 && i < len;
      const j = rev[n];
      zr[j] = ok ? xL[i] * win[n] : 0;
      zi[j] = ok ? xR[i] * win[n] : 0;
    }
  }
}

/** (G − 1)·Z (symmetric real gain, 0 below kLow) written bit-reversed into yr/yi. */
function deltaGainsPackedRev(zr, zi, gains, kLow, K, rev, yr, yi) {
  const N = zr.length;
  if (kLow > 0) {
    yr.fill(0);
    yi.fill(0);
  }
  for (let k = kLow; k <= K; k++) {
    const g = gains[k] - 1;
    let j = rev[k];
    yr[j] = zr[k] * g;
    yi[j] = zi[k] * g;
    if (k > 0 && k < K) {
      const m = N - k;
      j = rev[m];
      yr[j] = zr[m] * g;
      yi[j] = zi[m] * g;
    }
  }
}

/** |X_L[k]|² + |X_R[k]|² = (|Z[k]|² + |Z[N−k]|²)/2 for k in [from, K]; returns the total. */
function packedPower(zr, zi, power, from, K) {
  const N = zr.length;
  let tot = 0;
  for (let k = from; k <= K; k++) {
    const m = k === 0 ? 0 : N - k;
    const p = 0.5 * (zr[k] * zr[k] + zi[k] * zi[k] + zr[m] * zr[m] + zi[m] * zi[m]);
    power[k] = p;
    tot += p;
  }
  return tot;
}

/** Packed spectrum → (G − 1)·Z with the symmetric real gain; 0 below kLow (and mirror). */
function applyDeltaGainsPacked(zr, zi, gains, kLow, K) {
  const N = zr.length;
  for (let k = 0; k < kLow; k++) {
    zr[k] = 0;
    zi[k] = 0;
    if (k > 0) {
      zr[N - k] = 0;
      zi[N - k] = 0;
    }
  }
  for (let k = kLow; k <= K; k++) {
    const g = gains[k] - 1;
    zr[k] *= g;
    zi[k] *= g;
    if (k > 0 && k < K) {
      zr[N - k] *= g;
      zi[N - k] *= g;
    }
  }
}

function overlapAdd2(oL, oR, dL, dR, win2) {
  const N = dL.length;
  for (let n = 0; n < N; n++) {
    const w = win2[n];
    oL[n] += dL[n] * w;
    oR[n] += dR[n] * w;
  }
}

/** Windowed frame x[s .. s+N) (zeros outside [0, len)) → frame. */
function loadFrame(x, s, len, win, frame) {
  const N = frame.length;
  if (s >= 0 && s + N <= len) {
    for (let n = 0; n < N; n++) frame[n] = x[s + n] * win[n];
  } else {
    for (let n = 0; n < N; n++) {
      const i = s + n;
      frame[n] = i >= 0 && i < len ? x[i] * win[n] : 0;
    }
  }
}

/** Spectrum → (G − 1)·X for k ≥ kLow, 0 below (delta form). */
function applyDeltaGains(R, I, gains, kLow, K) {
  for (let k = 0; k < kLow; k++) {
    R[k] = 0;
    I[k] = 0;
  }
  for (let k = kLow; k <= K; k++) {
    const g = gains[k] - 1;
    R[k] *= g;
    I[k] *= g;
  }
}

function overlapAdd(o, frame, win2) {
  const N = frame.length;
  for (let n = 0; n < N; n++) o[n] += frame[n] * win2[n];
}

/** Adds the finished first H samples of the OLA buffer to x[s ..] and shifts the buffer. */
function flushOla(o, x, s, len, H) {
  const N = o.length;
  const a = s < 0 ? -s : 0;
  const b = len - s < H ? len - s : H;
  for (let i = a; i < b; i++) x[s + i] += o[i];
  o.copyWithin(0, H);
  o.fill(0, N - H);
}

/** Σ_c |X_c[k]|² for k in [from, K] → power; returns the total (finite check). */
function linkedPower(re, im, power, from, K) {
  let tot = 0;
  if (re.length === 2) {
    const r0 = re[0], i0 = im[0], r1 = re[1], i1 = im[1];
    for (let k = from; k <= K; k++) {
      const p = r0[k] * r0[k] + i0[k] * i0[k] + r1[k] * r1[k] + i1[k] * i1[k];
      power[k] = p;
      tot += p;
    }
    return tot;
  }
  for (let k = from; k <= K; k++) {
    let p = 0;
    for (let c = 0; c < re.length; c++) p += re[c][k] * re[c][k] + im[c][k] * im[c][k];
    power[k] = p;
    tot += p;
  }
  return tot;
}

/**
 * Pass 1 of the denoiser: per-bin noise floor (mean noise power, linked) from a
 * memory-bounded histogram of the ±DN_SMOOTH_BINS-averaged frame power; the noise floor
 * is a low percentile, bias-corrected to a mean. Only frames fully inside the signal and
 * above the "digital silence" level are counted. → Float64Array(K+1) or null.
 */
function estimateNoiseFloor(channels, N, kLo, normP) {
  const nCh = channels.length;
  const len = channels[0].length;
  const H = N >> 2;
  const K = N >> 1;
  const count = (stride) => (len >= N ? Math.floor((len - N) / stride) + 1 : 0);
  // Percentiles need many frames, not overlap: hop N (no overlap) when there are plenty,
  // denser hops for short signals.
  let stride = Math.max(N, Math.ceil((len - N) / DN_MAX_FRAMES));
  if (count(stride) < 64) stride = 2 * H;
  if (count(stride) < 32) stride = H;
  const nFr = count(stride);
  if (nFr < DN_MIN_FRAMES) return null;
  const fft = new RealFFT(N);
  const win = sqrtHann(N);
  const frame = new Float64Array(N);
  const re = new Float64Array(K + 1);
  const im = new Float64Array(K + 1);
  const P = new Float64Array(K + 1);
  const nb = K - kLo + 1;
  const cells = Math.round((DN_HIST_MAX_DB - DN_HIST_MIN_DB) / DN_HIST_STEP_DB);
  const hist = new Uint32Array(nb * cells);
  const pre = new Float64Array(K + 2);
  const s0 = Math.max(1, kLo - DN_SMOOTH_BINS);
  // White noise of RMS r gives E|X|² = r²·Σw² = r²·N/2 per channel; linked over channels.
  const silentMean = Math.pow(10, DN_SILENT_RMS_DB / 10) * (N / 2) * nCh;
  const invNorm = 1 / normP;
  const cellScale = 1 / DN_HIST_STEP_DB;
  let used = 0;
  for (let f = 0; f < nFr; f++) {
    const s = f * stride;
    P.fill(0);
    for (let c = 0; c < nCh; c++) {
      const x = channels[c];
      for (let n = 0; n < N; n++) frame[n] = x[s + n] * win[n];
      fft.forward(frame, re, im);
      for (let k = s0; k <= K; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    }
    let mean = 0;
    for (let k = kLo; k <= K; k++) mean += P[k];
    mean /= nb;
    if (!(mean > silentMean) || !Number.isFinite(mean)) continue;
    used++;
    pre[s0] = 0;
    for (let k = s0; k <= K; k++) pre[k + 1] = pre[k] + P[k];
    for (let k = kLo; k <= K; k++) {
      const a = k - DN_SMOOTH_BINS < s0 ? s0 : k - DN_SMOOTH_BINS;
      const b = k + DN_SMOOTH_BINS > K ? K : k + DN_SMOOTH_BINS;
      const q = (pre[b + 1] - pre[a]) / (b - a + 1);
      const d = DB_PER_NEPER_POW * Math.log(q * invNorm + 1e-30);
      let cell = Math.floor((d - DN_HIST_MIN_DB) * cellScale);
      if (cell < 0) cell = 0;
      else if (cell >= cells) cell = cells - 1;
      hist[(k - kLo) * cells + cell]++;
    }
  }
  if (used < DN_MIN_FRAMES) return null;
  const lambda = new Float64Array(K + 1);
  const rank = DN_PCT * used;
  for (let k = kLo; k <= K; k++) {
    const o = (k - kLo) * cells;
    let cum = 0;
    let d = DN_HIST_MIN_DB;
    for (let c = 0; c < cells; c++) {
      const h = hist[o + c];
      if (cum + h >= rank) {
        const frac = h > 0 ? (rank - cum) / h : 0; // uniform within the cell
        d = DN_HIST_MIN_DB + (c + frac) * DN_HIST_STEP_DB;
        break;
      }
      cum += h;
    }
    lambda[k] = normP * Math.exp((d + DN_BIAS_DB) * POW_PER_DB);
  }
  return lambda;
}

// ------------------------------------------------------------------------- de-shimmer

/** De-shimmer state: per-bin tables (precomputed window bounds) and smoothing states. */
function createDeShimmer(K, df, hopSec, amount, startHz, fullHz, normP) {
  const w = new Float64Array(K + 1);
  let kS0 = K + 1;
  for (let k = 1; k <= K; k++) {
    w[k] = logRamp(k * df, startHz, fullHz);
    if (w[k] > 0 && kS0 > K) kS0 = k;
  }
  const kS1 = Math.min(K, Math.floor(DS_TOP_HZ / df));
  if (kS0 > kS1) return null;
  const half = new Int32Array(K + 1);
  const r = Math.pow(2, ENV_HALF_OCT) - 1;
  for (let k = 0; k <= K; k++) half[k] = Math.max(ENV_MIN_HALF, Math.round(k * r));
  const lo = Math.max(1, kS0 - half[kS0] - 1); // envelope range [lo, hi]
  const hi = Math.min(K, kS1 + half[kS1] + 1);
  // Prefix-sum index pairs: Σ_{j=a}^{b} v[j] = cs[b + 1] − cs[a].
  const fA = new Int32Array(K + 1), fB = new Int32Array(K + 1), fInv = new Float64Array(K + 1);
  for (let k = lo; k <= hi; k++) {
    const a = Math.max(lo, k - half[k]);
    const b = Math.min(hi, k + half[k]);
    fA[k] = a;
    fB[k] = b + 1;
    fInv[k] = 1 / (b - a + 1);
  }
  const lA = new Int32Array(K + 1), lB = new Int32Array(K + 1), lInv = new Float64Array(K + 1);
  const rA = new Int32Array(K + 1), rB = new Int32Array(K + 1), rInv = new Float64Array(K + 1);
  const tInv = new Float64Array(K + 1);
  const mode = new Uint8Array(K + 1); // 0 both sides, 1 left only, 2 right only, 3 none
  for (let k = kS0; k <= kS1; k++) {
    const la = Math.max(lo, k - half[k]);
    const lb = k - ENV_GAP;
    const ra = k + ENV_GAP;
    const rb = Math.min(hi, k + half[k]);
    const nl = Math.max(0, lb - la + 1);
    const nr = Math.max(0, rb - ra + 1);
    lA[k] = la;
    lB[k] = nl > 0 ? lb + 1 : la;
    rA[k] = ra <= hi ? ra : hi + 1;
    rB[k] = nr > 0 ? rb + 1 : rA[k];
    lInv[k] = nl > 0 ? 1 / nl : 0;
    rInv[k] = nr > 0 ? 1 / nr : 0;
    tInv[k] = nl + nr > 0 ? 1 / (nl + nr) : 0;
    const okL = nl >= ENV_MIN_SIDE, okR = nr >= ENV_MIN_SIDE;
    mode[k] = okL && okR ? 0 : okL ? 1 : okR ? 2 : 3;
  }
  // Range-maximum queries (sparse table over the level spectrum) for the flicker tracker.
  const qA = new Int32Array(K + 1), qB = new Int32Array(K + 1), qJ = new Uint8Array(K + 1);
  let levels = 0;
  for (let k = kS0; k <= kS1; k++) {
    const m = Math.max(2, Math.round(FLK_TRACK * k));
    const a = Math.max(lo, k - m), b = Math.min(hi, k + m);
    let j = 0;
    while ((2 << j) <= b - a + 1) j++;
    qA[k] = a; // max over [a, b] = max(T_j[a], T_j[b − 2^j + 1])
    qB[k] = b - (1 << j) + 1;
    qJ[k] = j;
    if (j > levels) levels = j;
  }
  const spT = [new Float64Array(K + 2)]; // level 0: bin level where it is a clear peak, else −∞
  for (let j = 1; j <= levels; j++) spT.push(new Float64Array(K + 2));
  const spA = [null]; // level 0 = the level spectrum itself (all bins)
  for (let j = 1; j <= levels; j++) spA.push(new Float64Array(K + 2));
  const every = Math.max(1, Math.round((DS_ANALYSIS_MS * 1e-3) / hopSec));
  const aHop = every * hopSec; // analysis hop
  const lag = Math.max(1, Math.round((FLK_LAG_MS * 1e-3) / aHop));
  const eHist = [], lHist = [], mHist = [], aHist = [], vHist = [];
  for (let i = 0; i <= lag; i++) {
    eHist.push(new Float64Array(K + 1)); // pooled envelope (dB)
    lHist.push(new Float64Array(K + 1)); // bin level (dB)
    mHist.push(new Float64Array(K + 1)); // flicker reference level (dB), see FLK_TRACK
    aHist.push(new Float64Array(K + 1)); // local max of all bins within ±FLK_TRACK (dB)
    vHist.push(new Uint8Array(K + 1));
  }
  // co-modulation reference: series 0 = [cB0, cB1], series 1..CM_SUB = its log-spaced parts
  const cB0 = Math.max(1, Math.round(CM_LO_HZ / df));
  const cB1 = Math.min(Math.round(CM_HI_HZ / df), kS0 - 1);
  const comod = cB1 - cB0 + 1 >= CM_MIN_BINS;
  const nRef = CM_SUB + 1;
  const cEdge = new Int32Array(nRef + 1); // series r ≥ 1 covers bins [cEdge[r], cEdge[r + 1])
  if (comod) {
    cEdge[1] = cB0;
    for (let r = 2; r <= CM_SUB; r++) {
      cEdge[r] = Math.max(cEdge[r - 1] + 1, Math.round(cB0 * Math.pow((cB1 + 1) / cB0, (r - 1) / CM_SUB)));
    }
    cEdge[nRef] = cB1 + 1; // ≥ CM_MIN_BINS bins: no series is empty
  }
  const cxy = [];
  for (let r = 0; r < (comod ? nRef : 0); r++) cxy.push(new Float64Array(K + 1));
  return {
    K, kS0, kS1, lo, hi, w, fA, fB, fInv, lA, lB, lInv, rA, rB, rInv, tInv, mode,
    qA, qB, qJ, levels, spT, spA,
    amount,
    floorG: Math.exp(-Math.min(12, 18 * amount) * AMP_PER_DB),
    every,
    aS: onePole(SAL_TAU_MS, aHop),
    aF: onePole(FLK_TAU_MS, aHop),
    aAtt: onePole(DS_ATTACK_MS, hopSec),
    aRel: onePole(DS_RELEASE_MS, hopSec),
    salT0: Math.exp(SAL_T0_DB * POW_PER_DB),
    pFloor: normP * 1e-16, // −160 dB re a full-scale sine's peak bin: log guard
    pValid: normP * 1e-12, // −120 dB: below this a bin's level is not trusted for flicker
    lag, eHist, lHist, mHist, aHist, vHist,
    comod, cB0: comod ? cB0 : K + 1, cB1, nRef, cEdge,
    aC: onePole(CM_TAU_MS, aHop),
    bHist: new Float64Array((lag + 1) * nRef), // reference levels (dB), slot-major
    dRef: new Float64Array(nRef), // clipped reference changes of the current frame (dB)
    syy: new Float64Array(nRef), // smoothed squared reference changes
    cxy, // per series: smoothed (clipped signed flicker × reference change)
    cxx: new Float64Array(K + 1), // smoothed squared clipped signed flicker
    Ldb: new Float64Array(K + 1),
    cs1: new Float64Array(K + 2), // prefix sums of the bin levels (dB)
    cs2: new Float64Array(K + 2), // prefix sums of the clipped bin levels (dB)
    rs: new Float64Array(K + 2), // smoothed peak/envelope power ratio
    flk: new Float64Array(K + 1), // smoothed flicker (dB)
    tgt: new Float64Array(K + 2), // target gain of the last detection (dB, ≤ 0)
    gDb: new Float64Array(K + 1), // smoothed gain (dB, ≤ 0)
  };
}

/** One frame of de-shimmer: detector on analysis frames, gain smoothing on every frame. */
function deShimmerFrame(st, P, t) {
  if (t % st.every === 0) deShimmerDetect(st, P, t / st.every);
  deShimmerSmooth(st);
}

/** Detector: updates st.tgt (per-bin target gain in dB, ≤ 0) from the frame's power. */
function deShimmerDetect(st, P, t) {
  const { kS0, kS1, lo, hi, w, fA, fB, fInv, lA, lB, lInv, rA, rB, rInv, tInv, mode } = st;
  const { qA, qB, qJ, levels, spT, spA } = st;
  const { Ldb, cs1, cs2, rs, flk, tgt, pFloor, pValid } = st;
  const { aS, aF, salT0, amount, floorG } = st;
  const slot = t % (st.lag + 1);
  const old = (t + 1) % (st.lag + 1); // the slot written `lag` frames ago
  const eNow = st.eHist[slot], lNow = st.lHist[slot], mNow = st.mHist[slot], vNow = st.vHist[slot];
  const eOld = st.eHist[old], lOld = st.lHist[old], mOld = st.mHist[old], vOld = st.vHist[old];
  const aNow = st.aHist[slot], aOld = st.aHist[old];
  const { comod, cxy, cxx, dRef, nRef, aC } = st;
  if (comod) comodReference(st, P, t, slot, old);

  cs1[lo] = 0;
  for (let k = lo; k <= hi; k++) {
    const L = DB_PER_NEPER_POW * Math.log(P[k] + pFloor);
    Ldb[k] = L;
    cs1[k + 1] = cs1[k] + L;
  }
  cs2[lo] = 0;
  for (let k = lo; k <= hi; k++) {
    const c = (cs1[fB[k]] - cs1[fA[k]]) * fInv[k] + CLIP_DB;
    const L = Ldb[k];
    cs2[k + 1] = cs2[k] + (L < c ? L : c);
  }
  // clear peaks (vs the clipped windowed mean) → sparse table for range-max queries
  const pk = spT[0];
  for (let k = lo; k <= hi; k++) {
    const L = Ldb[k];
    pk[k] = L - (cs2[fB[k]] - cs2[fA[k]]) * fInv[k] > FLK_PEAK_DB ? L : -1e9;
  }
  spA[0] = Ldb;
  for (let j = 1; j <= levels; j++) {
    const h = 1 << (j - 1), end = hi - (1 << j) + 1;
    const prev = spT[j - 1], cur = spT[j];
    for (let i = lo; i <= end; i++) {
      const a = prev[i], b = prev[i + h];
      cur[i] = a > b ? a : b;
    }
    const prevA = spA[j - 1], curA = spA[j];
    for (let i = lo; i <= end; i++) {
      const a = prevA[i], b = prevA[i + h];
      curA[i] = a > b ? a : b;
    }
  }
  for (let k = kS0; k <= kS1; k++) {
    const L = Ldb[k];
    const sl = cs2[lB[k]] - cs2[lA[k]];
    const sr = cs2[rB[k]] - cs2[rA[k]];
    const m = mode[k];
    let env;
    if (m === 0) {
      const ml = sl * lInv[k], mr = sr * rInv[k];
      env = ml > mr ? ml : mr;
    } else if (m === 1) env = sl * lInv[k];
    else if (m === 2) env = sr * rInv[k];
    else env = L;
    // smoothed peak-to-envelope power ratio, calibrated to the mean noise power
    rs[k] = aS * rs[k] + (1 - aS) * dbToPow(L - env - SAL_BIAS_DB);
    // Flicker between frames `lag` apart, tolerant to frequency motion (FLK_TRACK): a level
    // that appears (L now vs the old reference) or vanishes (old L vs the reference now).
    // Evaluated on the absolute level (dL) and on the level relative to the pooled
    // envelope (dR), keeping the smaller: an on/off artifact moves both, a broadband
    // transient or swell moves mostly one of them, vibrato neither.
    const envFl = tInv[k] > 0 ? (sl + sr) * tInv[k] : L;
    const j = qJ[k], qa = qA[k], qb = qB[k];
    const tj = spT[j];
    let mx = tj[qa] > tj[qb] ? tj[qa] : tj[qb]; // reference: own level or a clear peak nearby
    if (L > mx) mx = L;
    const ta = spA[j];
    const ax = ta[qa] > ta[qb] ? ta[qa] : ta[qb]; // max of all bins nearby (biased up)
    const valid = P[k] > pValid ? 1 : 0;
    let d = 0, sd = 0;
    if (valid & vOld[k]) {
      const on = L - mOld[k];
      const off = lOld[k] - mx;
      const de = envFl - eOld[k];
      let dL = on > off ? on : off;
      let dR = on - de > off + de ? on - de : off + de;
      if (dL < 0) dL = 0;
      if (dR < 0) dR = 0;
      d = dL < dR ? dL : dR;
      if (d > FLK_MAX_DB) d = FLK_MAX_DB;
      // veto by the all-bin tracker: a partial that is still there, only moved or smeared
      const on2 = L - aOld[k], off2 = lOld[k] - ax;
      let d2 = on2 > off2 ? on2 : off2;
      if (d2 < FLK_MOVE_DB) d *= d2 > 0 ? d2 / FLK_MOVE_DB : 0;
      sd = d < CM_CLIP_DB ? d : CM_CLIP_DB;
      if (on < off) sd = -sd; // + appeared, − vanished
    }
    flk[k] = aF * flk[k] + (1 - aF) * d;
    if (comod) {
      cxx[k] = aC * cxx[k] + (1 - aC) * sd * sd;
      for (let r = 0; r < nRef; r++) cxy[r][k] = aC * cxy[r][k] + (1 - aC) * sd * dRef[r];
    }
    eNow[k] = envFl;
    lNow[k] = L;
    mNow[k] = mx;
    aNow[k] = ax;
    vNow[k] = valid;
  }
  rs[kS0 - 1] = 0;
  rs[kS1 + 1] = 0;
  for (let k = kS0; k <= kS1; k++) tgt[k] = 0;
  for (let k = kS0; k <= kS1; k++) {
    // Only local maxima of the smoothed peak ratio are candidates: the main-lobe skirts
    // of a strong STABLE partial are salient and flicker (noise interference is relatively
    // larger there), but they must not be treated as artifacts of their own. A flagged
    // peak takes its ±1 neighbours along (main lobe ±1.5 bins), see below.
    const r = rs[k];
    if (!(r > salT0) || r < rs[k - 1] || r < rs[k + 1]) continue;
    const fl = flk[k];
    if (!(fl > FLK_T0_DB)) continue;
    const sal = DB_PER_NEPER_POW * Math.log(r);
    let sS = (sal - SAL_T0_DB) * (1 / (SAL_T1_DB - SAL_T0_DB));
    if (sS > 1) sS = 1;
    let sF = (fl - FLK_T0_DB) * (1 / (FLK_T1_DB - FLK_T0_DB));
    if (sF > 1) sF = 1;
    // geometric mean: zero unless BOTH criteria hold, but less conservative than a product
    let score = Math.sqrt(sS * sF) * w[k];
    if (comod && score > 0) {
      // co-modulated with the low band: a musical gate / stab / tremolo, not shimmer
      const c = comodCorrelation(st, k);
      if (c >= CM_C1) score = 0;
      else if (c > CM_C0) score *= (CM_C1 - c) * (1 / (CM_C1 - CM_C0));
    }
    if (score > 0) {
      // G = max(floor, 1 − 0.5·score·(amount/0.5)); never below the envelope (de-ring,
      // not a notch filter); never above 1 (dips are not lifted)
      let g = 1 - amount * score;
      if (g < floorG) g = floorG;
      const toEnv = 1 / Math.sqrt(r);
      if (g < toEnv) g = toEnv;
      if (g < 1) tgt[k] = DB_PER_NEPER_AMP * Math.log(g);
    }
  }
  tgt[kS0 - 1] = 0;
  tgt[kS1 + 1] = 0;
}

/** Co-modulation reference: clipped level change of each reference series over `lag`. */
function comodReference(st, P, t, slot, old) {
  const { nRef, cEdge, bHist, dRef, syy, aC, pFloor } = st;
  const o = slot * nRef, oOld = old * nRef;
  let tot = 0;
  for (let r = 1; r < nRef; r++) {
    let p = 0;
    for (let k = cEdge[r]; k < cEdge[r + 1]; k++) p += P[k];
    tot += p;
    bHist[o + r] = DB_PER_NEPER_POW * Math.log(p + pFloor * (cEdge[r + 1] - cEdge[r]));
  }
  bHist[o] = DB_PER_NEPER_POW * Math.log(tot + pFloor * (st.cB1 - st.cB0 + 1));
  for (let r = 0; r < nRef; r++) {
    let d = t >= st.lag ? bHist[o + r] - bHist[oOld + r] : 0;
    if (d > CM_CLIP_DB) d = CM_CLIP_DB;
    else if (d < -CM_CLIP_DB) d = -CM_CLIP_DB;
    dRef[r] = d;
    syy[r] = aC * syy[r] + (1 - aC) * d * d;
  }
}

/** Best correlation of bin k's signed flicker with the reference series (≤ 1). */
function comodCorrelation(st, k) {
  const { nRef, cxy, cxx, syy } = st;
  const floor2 = CM_FLOOR_DB * CM_FLOOR_DB;
  let best = -1;
  for (let r = 0; r < nRef; r++) {
    const c = cxy[r][k] / Math.sqrt(cxx[k] * (syy[r] + floor2) + 1e-30);
    if (c > best) best = c;
  }
  return best;
}

/** Gain smoothing toward the (held) targets: 20 ms attack / 80 ms release, per hop. */
function deShimmerSmooth(st) {
  const { kS0, kS1, tgt, gDb, aAtt, aRel } = st;
  for (let k = kS0; k <= kS1; k++) {
    // spread over ±1 bin: a partial's √Hann main lobe spans ±1.5 bins
    let target = tgt[k];
    const a = tgt[k - 1], b = tgt[k + 1];
    if (a < target) target = a;
    if (b < target) target = b;
    let cur = gDb[k];
    const c = target < cur ? aAtt : aRel;
    cur = c * cur + (1 - c) * target;
    gDb[k] = cur > -1e-4 ? 0 : cur;
  }
}

// ---------------------------------------------------------------------------- denoise

function createDenoise(K, df, hopSec, amount, fromHz, lambda, kD0, normP) {
  const w = new Float64Array(K + 1);
  for (let k = 1; k <= K; k++) w[k] = fromHz <= 0 ? 1 : logRamp(k * df, fromHz, fromHz * Math.SQRT2);
  const lambdaInv = new Float64Array(K + 1);
  // a (near-)zero floor just means "no noise here": γ saturates and the gain stays at 1
  for (let k = kD0; k <= K; k++) lambdaInv[k] = 1 / Math.max(lambda[k], normP * 1e-20);
  return {
    K, kD0, w, lambdaInv,
    floorG: Math.exp(-12 * amount * AMP_PER_DB),
    aOpen: onePole(DN_OPEN_MS, hopSec),
    aClose: onePole(DN_CLOSE_MS, hopSec),
    gRaw: new Float64Array(K + 1),
    gam: new Float64Array(K + 1),
    gU: new Float64Array(K + 1).fill(1), // smoothed, un-ramped gain (linear)
    sPrev: new Float64Array(K + 1).fill(1e3), // |Ŝ|²/λ of the previous frame; start "open"
  };
}

/** One frame of denoise: updates st.gU (smoothed Wiener gain, before the ramp-in). */
function denoiseFrame(st, P) {
  const { K, kD0, lambdaInv, floorG, aOpen, aClose, gRaw, gam, gU, sPrev } = st;
  for (let k = kD0; k <= K; k++) {
    let g2 = P[k] * lambdaInv[k]; // a-posteriori SNR γ
    if (g2 > 1e8) g2 = 1e8;
    gam[k] = g2;
    let xi = DN_ALPHA * sPrev[k] + (1 - DN_ALPHA) * (g2 > 1 ? g2 - 1 : 0);
    if (xi < DN_XI_MIN) xi = DN_XI_MIN;
    const g = xi / (1 + xi);
    gRaw[k] = g < floorG ? floorG : g;
  }
  for (let k = kD0; k <= K; k++) {
    // ±2-bin triangular smoothing of the gain (05 §8.3: suppresses musical noise)
    let s = 3 * gRaw[k], ws = 3;
    if (k - 1 >= kD0) { s += 2 * gRaw[k - 1]; ws += 2; }
    if (k + 1 <= K) { s += 2 * gRaw[k + 1]; ws += 2; }
    if (k - 2 >= kD0) { s += gRaw[k - 2]; ws += 1; }
    if (k + 2 <= K) { s += gRaw[k + 2]; ws += 1; }
    const g = s / ws;
    let cur = gU[k];
    const a = g > cur ? aOpen : aClose;
    cur = a * cur + (1 - a) * g;
    if (cur > 1 - 1e-7) cur = 1;
    gU[k] = cur;
    sPrev[k] = cur * cur * gam[k]; // clean-power estimate for the next decision-directed step
  }
}

/**
 * STFT cleanup of AI-generator artifacts, in place (ARCHITECTURE §3). √Hann analysis +
 * synthesis, hop N/4, N = 2048 (sr ≤ 50 kHz) or 4096; zero latency, exact length. Gains
 * come from the linked power of all channels and are applied to every channel, so the
 * stereo image cannot shift.
 *
 * deShimmer (de-ring), startHz … min(20 kHz, Nyquist) with a log raised-cosine ramp-in
 * startHz → fullHz. A bin is an artifact candidate when it is a local maximum of its
 * time-smoothed (50 ms, power domain) level relative to the robust ±1/12-octave envelope
 * (it must stand out of BOTH sides, so band-limit edges and slopes never qualify) by
 * more than 6 dB, AND it flickers by more than 3 dB between frames ≈21 ms apart (mean
 * over ≈100 ms of how much it appeared / vanished, measured on the absolute and the
 * envelope-relative level and tolerant to ±3 % frequency motion — so broadband
 * transients, note envelopes, tremolo and vibrato do not count). Flicker that moves in
 * step with the 1–5 kHz level (≈1.5 s correlation of the signed on/off events with the
 * level changes of that band or one of its 4 sub-bands; see CM_*) is a musical gate,
 * stab or deep tremolo: the score fades out between correlation 0.4 and 0.65. score =
 * √(ramp(excess 6→9 dB) · ramp(flicker 3→4.5 dB)) · ramp-in · co-modulation ∈ [0, 1];
 * G = max(floor, 1 − 0.5·score·(amount/0.5), envelope level), floor = −min(12, 18·amount)
 * dB. Peaks are pulled toward the envelope, never below it; dips are never lifted (G ≤ 1).
 * The gain covers the peak's ±1 neighbours (main lobe) and is smoothed 20 ms attack /
 * 80 ms release per hop (the detector itself runs every ≈21 ms).
 *
 * denoise: above fromHz (½-octave log ramp-in fromHz → fromHz·√2). Pass 1: per-bin noise
 * floor = bias-corrected 5th percentile of the (±4-bin averaged) frame power, from a
 * memory-bounded histogram; frames of digital silence are ignored. Pass 2: Wiener gain
 * ξ/(1+ξ) with decision-directed ξ (α = 0.98), floor −12·amount dB (max reduction
 * 3 / 6 / 9 dB at amount 0.25 / 0.5 / 0.75), ±2-bin triangular frequency smoothing,
 * opens in 5 ms / closes in 100 ms. Treats any stationary HF content found in the
 * quietest 5 % of frames as noise: enable it only when the hiss detector fires.
 *
 * Identity: with both disabled or amount 0 the channels are not touched; when nothing is
 * detected the output equals the input exactly. Frames containing NaN/Infinity are left
 * unprocessed (the bad samples are not spread).
 *
 * @param {Float32Array[]} channels stereo (any count ≥ 1 works), modified in place
 * @param {number} sampleRate
 * @param {{ deShimmer?: { enabled?: boolean, amount?: number, startHz?: number, fullHz?: number },
 *           denoise?: { enabled?: boolean, amount?: number, fromHz?: number } }} opts
 * @param {(fraction: number) => void} [onProgress] called with 0..1 (ends with 1)
 * @returns {{ avgReductionDb: number, maxReductionDb: number,
 *             deShimmer: { avgReductionDb: number, maxReductionDb: number } | null,
 *             denoise: { avgReductionDb: number, maxReductionDb: number, noiseFloorDb: number|null } | null }}
 *   Gain changes in dB (≤ 0): avg = energy-weighted over the processed bins (all frames),
 *   max = deepest per-bin gain. Sub-objects are null when that process is off.
 *   noiseFloorDb: mean per-bin, per-channel noise power above fromHz in dB re a full-scale
 *   sine's peak bin (null if it could not be estimated — input shorter than ≈8 FFT frames
 *   or only digital silence — in which case denoise does nothing).
 */
export function spectralCleanup(channels, sampleRate, opts = {}, onProgress) {
  const stats = { avgReductionDb: 0, maxReductionDb: 0, deShimmer: null, denoise: null };
  const progress = typeof onProgress === 'function' ? onProgress : null;
  const nCh = channels ? channels.length : 0;
  const len = nCh ? channels[0].length : 0;
  const sr = Number(sampleRate);
  const o = opts || {};
  const dsO = o.deShimmer || {};
  const dnO = o.denoise || {};
  const nyq = sr / 2;
  let dsAmount = dsO.enabled ? clampAmount(dsO.amount) : 0;
  let dnAmount = dnO.enabled ? clampAmount(dnO.amount) : 0;
  const startHz = Number.isFinite(dsO.startHz) ? Math.max(20, dsO.startHz) : 5000; // log ramp needs > 0
  const fullHz = Number.isFinite(dsO.fullHz) ? Math.max(startHz, dsO.fullHz) : Math.max(startHz, 9000);
  const fromHz = Number.isFinite(dnO.fromHz) ? Math.max(0, dnO.fromHz) : 6000;
  if (!(sr > 0) || startHz >= nyq) dsAmount = 0;
  if (!(sr > 0) || fromHz >= nyq) dnAmount = 0;
  if (!len || (dsAmount <= 0 && dnAmount <= 0)) {
    if (dsAmount > 0) stats.deShimmer = { avgReductionDb: 0, maxReductionDb: 0 };
    if (dnAmount > 0) stats.denoise = { avgReductionDb: 0, maxReductionDb: 0, noiseFloorDb: null };
    if (progress) progress(1);
    return stats;
  }

  const N = fftSizeFor(sr);
  const H = N >> 2;
  const K = N >> 1;
  const df = sr / N;
  const hopSec = H / sr;
  // Power of a full-scale sine's peak bin (Σw/2)² with Σw = Σ sin(πn/N) ≈ 2N/π.
  const normP = (N / Math.PI) ** 2;

  const ds = dsAmount > 0 ? createDeShimmer(K, df, hopSec, dsAmount, startHz, fullHz, normP) : null;
  let dn = null;
  let noiseFloorDb = null;
  if (dnAmount > 0) {
    let kD0 = K + 1;
    for (let k = 1; k <= K && kD0 > K; k++) if (fromHz <= 0 || k * df > fromHz) kD0 = k;
    const lambda = kD0 <= K ? estimateNoiseFloor(channels, N, kD0, normP) : null;
    if (progress) progress(0.2);
    if (lambda) {
      dn = createDenoise(K, df, hopSec, dnAmount, fromHz, lambda, kD0, normP);
      let acc = 0;
      for (let k = kD0; k <= K; k++) acc += lambda[k];
      noiseFloorDb = DB_PER_NEPER_POW * Math.log(acc / (K - kD0 + 1) / normP / nCh + 1e-30);
    }
  }
  if (dnAmount > 0) stats.denoise = { avgReductionDb: 0, maxReductionDb: 0, noiseFloorDb };
  if (dsAmount > 0) stats.deShimmer = { avgReductionDb: 0, maxReductionDb: 0 };
  if (!ds && !dn) {
    if (progress) progress(1);
    return stats;
  }

  const kS0 = ds ? ds.kS0 : K + 1;
  const kD0 = dn ? dn.kD0 : K + 1;
  const kMin = Math.min(kS0, kD0);
  const powerFrom = Math.min(ds ? Math.min(ds.lo, ds.cB0) : K + 1, kD0); // incl. the co-modulation reference
  const acc = { eIn: 0, eOut: 0, eDs: 0, eDn: 0, minG: 1, minDs: 1, minDn: 1 };

  const frameFn = (P, G, t) => {
    if (ds) deShimmerFrame(ds, P, t);
    if (dn) denoiseFrame(dn, P);
    return combineGains(P, G, kMin, K, ds, dn, acc);
  };
  stftProcess(channels, sr, frameFn, {
    fftSize: N,
    powerFrom,
    onProgress: progress,
    progressFrom: dnAmount > 0 ? 0.2 : 0,
    progressTo: 1,
  });

  const toDb = (e) => (acc.eIn > 0 && e > 0 ? Math.min(0, DB_PER_NEPER_POW * Math.log(e / acc.eIn)) : 0);
  const ampDb = (g) => (g < 1 ? DB_PER_NEPER_AMP * Math.log(Math.max(g, 1e-12)) : 0);
  stats.avgReductionDb = toDb(acc.eOut);
  stats.maxReductionDb = ampDb(acc.minG);
  if (ds) stats.deShimmer = { avgReductionDb: toDb(acc.eDs), maxReductionDb: ampDb(acc.minDs) };
  if (dn) stats.denoise = { avgReductionDb: toDb(acc.eDn), maxReductionDb: ampDb(acc.minDn), noiseFloorDb };
  if (progress) progress(1);
  return stats;
}

/** Final per-bin gain = de-shimmer × ramped denoise; accumulates stats. → lowest bin < 1 or −1. */
function combineGains(P, G, kMin, K, ds, dn, acc) {
  const kS0 = ds ? ds.kS0 : K + 1;
  const kD0 = dn ? dn.kD0 : K + 1;
  const gDb = ds ? ds.gDb : null;
  const gU = dn ? dn.gU : null;
  const wD = dn ? dn.w : null;
  let eIn = 0, eOut = 0, eDs = 0, eDn = 0;
  let minG = acc.minG, minDs = acc.minDs, minDn = acc.minDn;
  let kLow = -1;
  for (let k = kMin; k <= K; k++) {
    let gd = 1;
    if (k >= kS0) {
      const v = gDb[k];
      if (v < 0) gd = Math.exp(v * AMP_PER_DB);
    }
    let gn = 1;
    if (k >= kD0) gn = 1 - wD[k] * (1 - gU[k]);
    const g = gd * gn;
    G[k] = g;
    const p = P[k];
    eIn += p;
    eOut += g * g * p;
    eDs += gd * gd * p;
    eDn += gn * gn * p;
    if (g < 1) {
      if (kLow < 0) kLow = k;
      if (g < minG) minG = g;
      if (gd < minDs) minDs = gd;
      if (gn < minDn) minDn = gn;
    }
  }
  acc.eIn += eIn;
  acc.eOut += eOut;
  acc.eDs += eDs;
  acc.eDn += eDn;
  acc.minG = minG;
  acc.minDs = minDs;
  acc.minDn = minDn;
  return kLow;
}
