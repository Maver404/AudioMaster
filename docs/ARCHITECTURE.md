# AudioMaster — Architecture & Module Contracts

AudioMaster is a 100% client-side mastering app for songs generated with Suno AI
(MP3 / WAV / M4A / FLAC / OGG in → mastered WAV 16/24-bit or MP3 out). No backend,
no build step needed for development (plain ES modules), optional esbuild bundle
that produces one self-contained HTML file (GitHub Pages, or "download and
double-click" distribution).

This document is the **contract** between modules. Every exported function listed
here must exist with exactly this name and signature. Internals are free.

---------------------------------------------------------------------------------

## 0. Ground rules (all modules)

* Plain JavaScript ES modules (`export function …`), no TypeScript, no runtime
  dependencies. The only third-party code is the MP3 encoder (lamejs), loaded at
  runtime from a pinned CDN URL by `src/export/mp3.js`.
* Everything under `src/dsp`, `src/analysis`, `src/engine/chain.js`,
  `src/engine/assistant.js`, `src/engine/params.js`, `src/export/wav.js`,
  `src/export/zip.js`, `src/demo` is **environment-neutral**: it must run unchanged
  in Node 20 (tests), in a Web Worker and on the browser main thread. No DOM, no
  `window`, no `AudioContext` there.
* 2-space indent, semicolons, single quotes, JSDoc on every export. Comments explain
  *why* (DSP rationale, references), not what.
* Numeric hygiene: filter state in Float64 (`let` locals or Float64Array); buffers are
  Float32Array. Flush denormals is not needed in JS, but guard `log10(0)` with
  epsilons. Never produce NaN/Infinity; functions must be safe on silence.
* **Zero-latency contract**: every processing function returns audio that is
  time-aligned with its input and has the same length. Lookahead / FIR / STFT delays
  are compensated internally (process with padding, then shift).
* **In-place contract**: processors named `process*` / `apply*` / listed as
  "in place" mutate the `channels` arrays they are given and return a small stats
  object. Callers clone first if they need the input.
* Long synchronous loops are fine inside DSP primitives (they are called from a
  worker). Orchestration (`chain.js`) is `async` and yields between stages.

### Shared data type

```js
/** @typedef {{ sampleRate: number, channels: Float32Array[] }} AudioData */
```
Internally audio is always **stereo** (`channels.length === 2`). Mono files are
duplicated; files with >2 channels are downmixed to L/R at decode time.

---------------------------------------------------------------------------------

## 1. Directory layout

```
index.html                    dev entry (loads src/main.js as module)
src/main.js                   boot: creates App
src/ui/app.js                 UI controller (state, wiring, rendering)
src/ui/waveform.js            canvas waveform (original lane + master lane, playhead; cut mode: selection, zoom)
src/ui/cut.js                 cut bar "Taglia": select / listen / loop, save a clip of the master, edit the song
src/ui/history.js             undo / redo history (pure: steps, coalescing, labels, key gating)
src/ui/metabox.js             "Metadati" box: cover, tags, lyrics, technical details, copy-to-master switch
src/ui/theme.js               "Tema" skins (palettes as CSS custom properties) + header picker
src/ui/spectrum.js            canvas spectrum (live analyser + static LTAS A vs B)
src/ui/meters.js              loudness/peak meters, gain-reduction readouts
src/ui/controls.js            segmented controls, sliders, toggles (tiny DOM helpers)
src/ui/help.js                (i) explanation cards: popover / bottom sheet, hover tip, help registry
src/ui/i18n.js                IT/EN strings, t(key, vars)
src/ui/styles.css             all styles (design tokens on :root)
src/audio/decode.js           File → AudioData + info (WAV parser + decodeAudioData)
src/audio/player.js           synchronized A/B playback, loudness-matched, range / loop playback
src/audio/edit.js             non-destructive song edits: edit lists, crossfaded joins, clips (environment-neutral)
src/audio/metadata.js         tag reader (ID3/APE/MP4/FLAC/Ogg/WAV/AIFF, cover art) + ID3v2.3 / RIFF INFO writers
src/dsp/util.js               dB helpers, clone/alloc, smoothing coefs, PRNG
src/dsp/biquad.js             RBJ cookbook designs, Butterworth cascades, processing
src/dsp/crossover.js          Linkwitz-Riley 4th-order multiband split (phase-coherent)
src/dsp/fft.js                radix-2 complex FFT + real FFT wrapper
src/dsp/oversample.js         polyphase up/down-sampling, true-peak interpolation
src/dsp/resample.js           high-quality sample-rate conversion (windowed sinc)
src/dsp/dynamics.js           compressor, level statistics, dynamic band cut
src/dsp/limiter.js            true-peak lookahead limiter, soft clipper
src/dsp/spectral.js           STFT cleanup: de-shimmer/de-ring + spectral denoise
src/dsp/eq.js                 1/3-octave LTAS, auto-EQ & match-EQ curves, EQ fitting
src/dsp/stereo.js             M/S width, mono-bass, correlation
src/dsp/saturation.js         oversampled tape-style saturation, HF "air" exciter
src/dsp/dither.js             TPDF dither + noise shaping, float → PCM
src/analysis/loudness.js      BS.1770-4 LUFS (I/S/M), LRA, true peak, loudness curve
src/analysis/analyze.js       full diagnostic report of a track
src/engine/params.js          parameter schema, defaults, presets
src/engine/assistant.js       analysis + simple choices → full params
src/engine/chain.js           renderMaster(): the mastering chain (async, cached)
src/engine/worker.js          Web Worker wrapper around analyze/render
src/engine/client.js          main-thread API (Worker, with in-thread fallback)
src/export/wav.js             WAV encoder (16/24 PCM, 32 float)
src/export/mp3.js             MP3 encoder (lamejs, chunked, progress)
src/export/zip.js             store-only ZIP writer (CRC32)
src/export/save.js            save a Blob: <a download>, or an embedding host's save adapter
src/demo/demo-track.js        deterministic synthetic "Suno-like" demo song with artifacts
tests/run.mjs                 zero-dependency test runner (node tests/run.mjs [filter])
tests/helpers.mjs             assert helpers, signal generators, ffmpeg bridge
tests/*.test.mjs              unit/integration tests
tools/build.mjs               esbuild → dist/index.html (standalone; --embed-adapter adds dist/embed.html)
docs/                         ARCHITECTURE.md, RESEARCH.md
Dockerfile, docker/nginx.conf  container: Node builds dist/index.html, unprivileged nginx serves it on :8080
compose.yaml                  the same, read-only, no capabilities (CI smoke test: .github/workflows/docker.yml)
```

---------------------------------------------------------------------------------

## 2. DSP foundation

### src/dsp/util.js
```js
export const EPS = 1e-12;
export function dbToGain(db)            // 10^(db/20)
export function gainToDb(g)             // 20*log10(max(|g|, EPS))
export function powerToDb(p)            // 10*log10(max(p, 1e-24))
export function clamp(x, lo, hi)
export function lerp(a, b, t)
export function timeCoef(ms, sampleRate) // one-pole coefficient: a = exp(-1/(ms*1e-3*sr)); y = a*y + (1-a)*x ; ms<=0 → 0
export function makeAudio(sampleRate, length, numChannels = 2) // AudioData of zeros
export function cloneAudio(audio)       // deep copy
export function audioLength(audio)      // channels[0].length
export function toStereo(channels)      // Float32Array[] (1..n) → [L, R] (mono dup, >2 downmix: L=c0+.707*c2.., simple)
export function mixToMono(channels)     // Float32Array (L+R)/2
export function createRng(seed)         // deterministic PRNG () => float in [0,1)  (e.g. mulberry32)
export function yieldToEventLoop()      // Promise resolved on next macrotask (setTimeout 0)
```

### src/dsp/biquad.js
Coefficient object (normalized, a0 = 1): `{ b0, b1, b2, a1, a2 }`.
A "filter" is an array of sections (cascade). Processing is Transposed Direct Form II
with Float64 state.
```js
export function design(type, freq, sampleRate, opts = {})
  // type: 'lowpass'|'highpass'|'bandpass'(constant 0 dB peak)|'notch'|'allpass'
  //       |'peaking'|'lowshelf'|'highshelf'
  // opts: { q = Math.SQRT1_2, gainDb = 0, slope }   (shelves use q unless slope given)
  // freq is clamped to (1 Hz, 0.49*sampleRate)
export function firstOrder(type, freq, sampleRate)      // 'lowpass'|'highpass' 1-pole (b2=a2=0)
export function butterworth(type, order, freq, sampleRate) // 'lowpass'|'highpass', order 1..8 → sections[]
export function linkwitzRiley4(type, freq, sampleRate)  // two identical Butterworth Q=0.7071 sections
export function processInPlace(buffer, sections)        // Float32Array, sections|section
export function processStereoInPlace(channels, sections) // independent state per channel
export function responseDb(sections, freq, sampleRate)  // analytic magnitude in dB
export class BiquadCascade {                             // per-sample use (sidechains, dynamic EQ)
  constructor(sections); process(x) /* → y */; reset();
}
```

### src/dsp/crossover.js
Phase-coherent Linkwitz-Riley 4th-order (24 dB/oct) band splitting. The sum of all
returned bands equals the input passed through the cascade of LR4 allpasses
(flat magnitude, |sum| within ±0.05 dB of input).
```js
export function splitBands(signal, crossovers, sampleRate)
  // signal: Float32Array; crossovers ascending Hz, length 1..4
  // → Float32Array[] with crossovers.length + 1 bands (low → high)
  // Lower bands get allpass compensation for every higher crossover (standard tree).
export function splitBandsStereo(channels, crossovers, sampleRate) // → bands[b] = [L, R]
export function sumBands(bands)          // Float32Array[] → Float32Array
```

### src/dsp/fft.js
```js
export class FFT {               // complex, radix-2, n power of two, precomputed twiddles
  constructor(n)
  forward(re, im)                // in place, Float64Array
  inverse(re, im)                // in place, scaled by 1/n
}
export class RealFFT {           // n-point real transform via n/2 complex FFT
  constructor(n)
  forward(input, outRe, outIm)   // input Float64Array(n) → bins 0..n/2 (length n/2+1)
  inverse(inRe, inIm, output)    // bins → Float64Array(n); inverse(forward(x)) === x
}
export function hann(n, periodic = true)   // Float64Array
```
Performance target: RealFFT(2048) forward+inverse < 25 µs in Node 20 / Chrome.

### src/dsp/oversample.js
```js
export function upsample(signal, factor)          // factor 2|4 → Float32Array(len*factor), linear-phase, delay-compensated
export function downsample(signal, factor)        // inverse; anti-alias filtered; len/factor
export function truePeakEnvelope(signal, sampleRate, out?, quality = 'limiter')
  // per-sample max |x| over the original sample and the interpolated points between it
  // and the next one (4x for sr < 96 kHz, 2x for 96..192 kHz, 1x above) → Float32Array(len)
  // quality 'meter' = BS.1770-4 Annex 2 48-tap filter (what platforms measure);
  // 'limiter' = better Kaiser-designed interpolator (BS.1770 filter only stops ~40 dB and
  // can under-read 0.5+ dB) within the limiter performance budget (e.g. 16–32 taps/phase).
export function truePeakDb(channels, sampleRate)  // max over channels of max(sample peak, interpolated), dBTP, BS.1770-4 Annex 2 filter
```

### src/dsp/resample.js
```js
export function resample(signal, fromRate, toRate)        // Float32Array → Float32Array
export function resampleAudio(audio, toRate)              // AudioData → new AudioData (same if equal rate)
  // Windowed-sinc (Kaiser, >= 32 zero crossings), passband flat to 0.45*min(fs), stopband < -100 dB.
```

---------------------------------------------------------------------------------

## 3. Processors

### src/dsp/dynamics.js
```js
export function gainComputerDb(levelDb, thresholdDb, ratio, kneeDb)
  // static soft-knee curve → gain change in dB (<= 0), Giannoulis/Massberg/Reiss 2012
export function levelStats(signal, sampleRate, opts = {})
  // signal: Float32Array (mono sidechain) or channels (linked max).
  // opts { windowMs = 50, gateDb = -60, relGateDb = -40, gateRefPct = 1 }
  // RMS over consecutive windows; windows below gate (absolute, and relGateDb below the
  // reference window: the loudest, or the gateRefPct quantile when < 1) are ignored.
  // → { p10, p50, p75, p90, p95, p99, max, mean, count } all in dBFS
export function thresholdForTargetGr(sidechain, sampleRate, opts)
  // Static auto threshold: binary-search thresholdDb so that the mean static gain reduction
  // (gainComputerDb over gated windowed RMS levels) equals opts.targetGrDb.
  // opts { ratio, kneeDb = 6, targetGrDb, windowMs = 50, gateDb = -60, relGateDb = -40,
  //        gateRefPct = 1, sidechainHpHz = 0, sidechainHpOrder = 2 }
  // → thresholdDb   (targetGrDb <= 0 → +Infinity i.e. no compression)
export function calibrateThreshold(channels, sampleRate, opts)
  // Ballistics-aware auto threshold (what the chain uses): static estimate, then the
  // compressor's own detector envelope (computed once) and gain smoothing are simulated
  // and the threshold corrected (Newton / secant, ≤ 5 simulations) until the REALISED mean
  // GR of the gated windows' level range is within 0.03 dB of targetGrDb.
  // opts = thresholdForTargetGr opts + compress ballistics { attackMs, releaseMs,
  //        autoRelease, detector, rmsMs, lookaheadMs }
  // → { thresholdDb, staticThresholdDb, statsGateDb, envelope, grLoudAvgDb, simulations,
  //     inputStats }  — pass envelope + statsGateDb to compress() (no second detector pass);
  //     inputStats = levelStats() of the input from the same pass
export function compress(channels, sampleRate, opts)
  // in place, stereo-linked feed-forward compressor
  // opts { thresholdDb, ratio, kneeDb = 6, attackMs, releaseMs, makeupDb = 0,
  //        detector: 'rms'|'peak' = 'rms', rmsMs = 10, autoRelease = false,
  //        sidechain?: Float32Array, sidechainHpHz = 0, sidechainHpOrder = 2 (or 4),
  //        lookaheadMs = 0, mix = 1, envelope?: calibrateThreshold().envelope, statsGateDb? }
  // autoRelease: GR = max(fast 40–100 ms branch, slow 0.5–2 s branch) style program dependence.
  // The peak detector's control level is the max over the whole control period (never
  // misses a sample, whatever the period vs the 1024-sample detector block).
  // → { grAvgDb, grMaxDb, grLoudAvgDb }   (grAvg over non-silent samples, grLoudAvg over
  //   control points above statsGateDb; values <= 0)
export function dynamicBandCut(channels, sampleRate, opts)
  // in place, phase-coherent dynamic cut.
  //   type 'band':  y = x - (1 - g[n]) * BP0(x)  — BP0 = RBJ constant-0dB-peak band-pass at
  //                 freq/q, so g=1 is an exact identity and g<1 is a peaking dip of depth
  //                 20log10(g) at freq.
  //   type 'shelf': y = x - (1 - g[n]) * HP1(x)  — first-order complementary high shelf.
  // channel 'stereo' (linked L/R), 'mid' or 'side' (process in M/S, convert back).
  // Detection is RELATIVE: d = env(band(sc)) - env(sc) in dB, sc = the processed channel
  // signal (mid for 'stereo'); spectral-balance based, so loud passages with normal balance
  // are untouched. threshold = (median of d over active windows) + thresholdRelDb;
  // g = gainComputer(d - threshold) limited to maxCutDb. Optional lookahead (aligned).
  // opts { type = 'band', channel = 'stereo', freq, q = 1, thresholdRelDb = 2, ratio = 2,
  //        maxCutDb, attackMs = 10, releaseMs = 120, kneeDb = 3, lookaheadMs = 0 }
  // → { grAvgDb, grMaxDb, activePct, thresholdDb }
export function relativeBandStats(channels, sampleRate, { freq, q = 1, type = 'band', channel = 'stereo', windowMs = 20 })
  // distribution of (band level − broadband level) in dB over active windows
  // → { p50, p75, p90, p95 }
```

### src/dsp/limiter.js
```js
export function limitTruePeak(channels, sampleRate, opts)
  // in place, stereo-linked lookahead limiter with oversampled (true-peak) detection.
  // opts { ceilingDb = -1, lookaheadMs = 3, releaseMs = 80, adaptiveRelease = true,
  //        safetyDb = 0.05 }
  // Signalsmith design (RESEARCH §7): target gain from linked oversampled peak
  // (truePeakEnvelope 'limiter' quality) → moving minimum over hold H >= L → release
  // r += (h − r)/(R + 1); r = min(r, h) (adaptive: faster for short transients) → two
  // cascaded box filters splitting L as 0.5822/0.4178 → y[n] = x[n − (L−1)]·g[n], then
  // re-aligned (zero-latency contract). Internal ceiling margin, then verify with
  // truePeakDb (meter filter): if still over, lower the internal ceiling by the excess +
  // 0.05 dB and re-run (max 3 runs).
  // Guarantee: truePeakDb(output) <= ceilingDb, also per ffmpeg ebur128.
  // → { grAvgDb, grMaxDb, grPctAbove1dB }
export function softClip(channels, sampleRate, opts)
  // in place, 4x oversampled smooth clipper. opts { thresholdDb, kneeDb = 1.5 }
  // Transparent below threshold - knee/2; output never exceeds threshold.
  // → { grMaxDb, clippedPct }
```

### src/dsp/spectral.js
```js
export function spectralCleanup(channels, sampleRate, opts, onProgress?)
  // in place STFT processor (sqrt-Hann analysis+synthesis, 75% overlap, N=2048 for
  // sr <= 50 kHz, 4096 above). Gains are computed from the linked L+R power so the
  // stereo image never shifts. Two independent sub-processes:
  // opts.deShimmer { enabled, amount 0..1, startHz = 5000, fullHz = 9000 }
  //   "de-ring": in the HF region, narrowband peaks that stick out of the local
  //   spectral envelope (≈1/6 oct) — the metallic/shimmering codec-like artifacts of AI
  //   generators — are pulled toward the envelope; notches are lifted only slightly.
  //   Gains smoothed in time (≈20 ms attack / 80 ms release) to avoid musical noise.
  //   Flicker co-modulated with the 1–5 kHz level (rhythmic gates, stabs, deep tremolo)
  //   is treated as music, not as an artifact, and is left untouched.
  //   Recipe (RESEARCH §2): peaks > 6 dB above the 1/6-oct envelope that flicker > 3 dB
  //   frame-to-frame get G = max(floor, 1 − 0.5·score·(amount/0.5)), where score ∈ [0,1]
  //   grows with the peak excess and flicker, and floor = −min(12, 18·amount) dB
  //   (amount 0.5 ≙ RESEARCH "Medium": −9 dB floor).
  // opts.denoise { enabled, amount 0..1, fromHz = 6000 }
  //   max reduction = 12 dB × amount (Light 3 / Medium 6 / Strong 9 dB), only above fromHz
  //   (smooth 1/2-octave ramp-in). Noise profile = per-bin low percentile of frame power
  //   (pass 1, histogram based); pass 2: Wiener gain with decision-directed smoothing
  //   (α ≈ 0.98) and frequency smoothing of gains to avoid musical noise.
  // Identity guarantee: with both disabled (or amount 0) output === input within 1e-6.
  // → { avgReductionDb, maxReductionDb }
```

### src/dsp/eq.js
```js
export const THIRD_OCTAVE_HZ    // 31 ISO centres 20 … 20000
export function ltas(channels, sampleRate, opts = {})
  // long-term average spectrum of the mid signal in 1/3-octave bands, dB (power, gated:
  // frames quieter than −50 dB rel. loudest ignored). → Float64Array(31)
export function hfCutoffHz(channels, sampleRate)
  // detects a codec low-pass (e.g. MP3 ~16 kHz): highest frequency where the long-term
  // spectrum is within 35 dB of its 4–8 kHz level; returns sampleRate/2 if none.
export function autoEqCurve(inputLtas, opts)
  // opts { strength 0..1, maxDb = 3, toleranceDb = 1.5, targetSlopeDbPerOct, styleTiltDbPerOct = 0,
  //        cutoffHz }  → Float64Array(31) correction in dB
  // Corrects (a) bumps/dips relative to the track's own smoothed trend beyond tolerance and
  // (b) the overall slope toward targetSlopeDbPerOct; never boosts above cutoffHz or below 30 Hz.
  // Low end: bump cuts fade to ¼ from 200 Hz to 63 Hz and stay at ¼ below; dips below
  // 63 Hz (the natural sub roll-off) are never filled.
export function matchEqCurve(inputLtas, referenceLtas, opts)
  // opts { strength 0..1, maxDb = 6, smoothingOct = 1/3, cutoffHz } → Float64Array(31)
export function fitGraphicEq(curveDb, sampleRate)
  // approximate a 31-point curve with a min-phase bank (low shelf 80 Hz, peaking at
  // 63,125,250,500,1k,2k,4k,8k Hz (Q≈1.4), high shelf 12 kHz) by iterative refinement.
  // → sections[] (BiquadCascade-compatible)
export function toneSections(tone, sampleRate)
  // tone { lowShelfDb, lowShelfHz = 90, boomDb, boomHz = 120, boomQ = 1.4,
  //        mudDb, mudHz = 300, mudQ = 0.9, presenceDb, presenceHz = 3000, presenceQ = 0.8,
  //        airDb, airHz = 12000 (high shelf), highShelfDb, highShelfHz = 2000 (broad high
  //        shelf, Q 0.4: Bright), hashDb, hashHz = 14000 (high shelf),
  //        tiltDbPerOct, tiltPivotHz = 1000 }  → sections[] (zero-gain bands omitted)
  // tilt realised with a complementary low-shelf/high-shelf pair around the pivot.
export function curveResponseDb(sections, freqs, sampleRate) // → Float64Array (UI drawing)
```

### src/dsp/stereo.js
```js
export function stereoImage(channels, sampleRate, opts)
  // in place M/S. Side gain vs frequency: 0 below monoBassHz (side high-passed with LR4;
  // 0 = off), 1 between monoBassHz and widthFromHz, `width` above widthFromHz
  // (widthFromHz = 0 → width applies to all side content above monoBassHz). LR4 splits
  // keep it phase-coherent. Never widens below 300 Hz (clamp widthFromHz when width > 1).
  // opts { width = 1, widthFromHz = 1500, monoBassHz = 0 }
export function correlation(channels)            // Pearson L/R, −1..1 (gated on silence)
export function sideToMidDb(channels)            // energy ratio S/M in dB
export function bandCorrelation(channels, sampleRate, crossovers) // per band, low→high
```

### src/dsp/saturation.js
```js
export function saturate(channels, sampleRate, opts)
  // in place, 2x oversampled asymmetric tape-style waveshaper with level-compensated
  // output and DC blocking. opts { drive 0..1, mix 0..1 = 1 }  drive 0 ⇒ identity.
export function airExciter(channels, sampleRate, opts)
  // in place: generates gentle upper harmonics from the band just below `fromHz`
  // and adds them above it (restores "air" lost to codec low-pass / de-shimmer).
  // opts { amount 0..1, fromHz = 8000 }  amount 0 ⇒ identity.
```

### src/dsp/dither.js
```js
export function floatToPcm(channels, bitDepth, opts = {})
  // bitDepth 16|24 → interleaved Int16Array | Int32Array (24-bit values in int32)
  // opts { sampleRate, dither: 'tpdf'|'none' = 'tpdf', noiseShaping = 'auto', seed = 1 }
  // noiseShaping 'auto' = lip44 error-feedback filter [2.033, −2.165, 1.959, −1.590, 0.6149]
  // only for 16-bit at 44.1 kHz (it is designed for that rate), flat TPDF otherwise;
  // shaped error limited to ±4 LSB. Clamps to the integer range (no wrap-around).
```

---------------------------------------------------------------------------------

## 4. Analysis

### src/analysis/loudness.js
BS.1770-4 / EBU R128. K-weighting coefficients derived for ANY sample rate (bilinear
transform from the analog prototype, as libebur128 / pyloudnorm), not hard-coded 48 kHz.
```js
export function kWeight(channels, sampleRate)              // → new Float32Array[] (K-weighted)
export function integratedLoudness(channels, sampleRate)   // LUFS (−70 abs gate, −10 LU rel gate); −Infinity for silence
export function loudnessRange(channels, sampleRate)        // LRA in LU (EBU Tech 3342)
export function shortTermMax(channels, sampleRate)         // max 3 s loudness, LUFS
export function momentaryMax(channels, sampleRate)         // max 400 ms loudness, LUFS
export function loudnessCurve(channels, sampleRate, { windowSec = 3, hopSec = 0.1 } = {})
  // → Float32Array of LUFS per hop (short-term curve for UI meters during playback)
export function measure(channels, sampleRate)
  // one pass over the K-weighted signal → { integrated, lra, shortTermMax, momentaryMax,
  //   truePeakDb, samplePeakDb, curve: Float32Array, curveHopSec }
```
Accuracy: within ±0.1 LU of `ffmpeg -af ebur128` for integrated; ±0.2 dB true peak.

### src/analysis/analyze.js
```js
export function analyzeTrack(audio, opts = {})   // AudioData → AnalysisReport (sync, may be slow)
/** AnalysisReport = {
 *   duration, sampleRate,
 *   loudness: { integrated, lra, shortTermMax, momentaryMax, truePeakDb, samplePeakDb, plr,
 *               curve, curveHopSec },
 *   rmsDb, crestDb, dcOffset: [l, r],
 *   stereo: { correlation, sideToMidDb, nearMono: boolean,
 *             bandCorrelation: [<120, 120–1k, 1k–8k, >8k] , sideToMidHfDb (>8 kHz) },
 *   spectrum: { ltas: number[31], hfCutoffHz,
 *               bands: { sub, low, lowMid, mid, highMid, high, air } }   // dB rel. total
 *   profile: 'legacy'|'midband'|'fullband'|'muffled',   // RESEARCH §2 profiles, from f_c
 *            // ('brightened' is no longer produced: it is the modifier below; still a valid id)
 *   brightened: number 0..1,     // modifier: 6–10 kHz excess ramp 6 → 9 dB (INDEX_GATES)
 *   indices: { mud, mudHz, boom, boomHz, harsh, harshHz, fizz, fizzHz, sibilance,
 *              sibilanceEventsPerMin, air, rumble, shimmer, hash, hiss, hfModulation },
 *              // dB excess vs the track's smooth trend (+ = too much); *Hz = detected peak
 *   clipping: { samples, pct, runs },            // runs of >= 3 consecutive |x| >= 0.999
 *   silence: { startSec, endSec },               // leading / trailing below −60 dBFS
 *   abruptEnd: boolean,                          // last 200 ms not faded (level > −30 dBFS)
 *   issues: [{ id, severity: 0..1, value }]      // ids listed in §7
 * } */
```

---------------------------------------------------------------------------------

## 5. Engine

### src/engine/params.js
Exports the parameter schema, defaults, `DESTINATIONS`, `STYLES`, `INTENSITIES`,
`CLEANUP_LEVELS`, `defaultChoices()`, `mergeParams(base, overrides)`, `validateParams(p)`,
`isUserOwned(params, path)`.
* `params.meta.userOwned: string[]` (C1) — dot paths whose values came from the user (the
  "Suona troppo…" buttons, Advanced overrides; the UI's composeParams fills it).
  validateParams keeps it as unique non-empty strings (max 200, other types dropped). QC
  rollback never softens a user-owned path (a path, its parent or child listed). The
  assistant ignores it.
* `DESTINATIONS[id].dynamics` scales the multiband / glue targets (Hi-Fi 0, Broadcast 0.5,
  Streaming / Video / Social 0.6, Loud / Club 1); `loudness.minTargetLufs` (Loud / Club:
  the range's low end) lets the chain settle below the target instead of over-limiting;
  `loudness.clipper.maxDepthDb` caps the escalated soft clip; `trim.head` / `trim.tail`
  select the edges trimming may cut; multiband bands carry `rmsMs` and `sidechainHpHz`;
  glue `sidechainHpOrder` (4).

### src/engine/assistant.js
```js
export function suggestParams(analysis, choices, opts = {})
  // choices { destination, style, intensity (0..1), cleanup: 'off'|'light'|'medium'|'strong',
  //           reference?: { ltas: number[31], name, loudness } }  → full Params (see params.js)
  // Implements RESEARCH §1 (intensity table → INTENSITY_TABLE, auto-adjust rules),
  // §2 (cleanup k × detector gates, profiles), §3 (DESTINATIONS, lufsRange by intensity),
  // §4 (STYLES deltas scaled by intensity/0.5). Fades: 5 ms in / 30 ms out by default;
  // abruptEnd does NOT auto-enable a long fade (the UI offers it as a one-click fix).
export function describeDecisions(analysis, params)  // → [{ key, vars }] i18n keys explaining what the assistant did
  // With report.paramsUsed it describes what ran: the chain adds paramsUsed.meta.realised
  // { autoEqDb (largest applied auto-EQ move), multibandGrDb, glueGrDb (realised loud-section
  // GR), trimmed, targetLufs (effective) } and paramsUsed already holds any QC rollback.
  // suggestParams also sets meta { destination, style, cleanup, intensity, profile,
  // brightened, styleTone } (styleTone: the tone moves the style made — QC treats them as
  // intended).
```

### src/engine/chain.js
```js
export async function renderMaster(audio, params, opts = {})
  // audio: AudioData (stereo, any rate). opts { onProgress(stage, fraction), cache, isCancelled() }
  // → { audio: AudioData, report: RenderReport }
  // Stages (in order; 1–9 at the SOURCE rate, so every destination shares caches A and B):
  //   1 prepare   DC block, subsonic HPF (zero phase)
  //   2 trim      optional leading/trailing silence trim (keepStartMs / keepEndMs; head / tail)
  //   3 spectral  spectralCleanup (de-shimmer, denoise)                 [cache key A]
  //   4 eq        auto/match + tone EQ (one min-phase cascade)
  //   5 dyneq     dynamicBandCut for every enabled dynEq band (mud, boom, harsh, fizz,
  //               deEss, deEssAir, sideHf)
  //   6 color     saturation, then air exciter
  //   7 multiband LR4 bands (band by band); per band calibrateThreshold(band, targetGrDb on
  //               the loud sections) → compress; preserveBalance: restore each band's
  //               gated loudness after compression
  //   8 stereo    mono bass, width
  //   9 glue      bus compressor (4th-order SC HPF), calibrated threshold   [cache key B]
  //  10 loudness  resample the post-glue audio to params.output.sampleRate when it differs
  //               (cached per B); iterate: gain → softClip (threshold so it shaves ≈ amountDb
  //               off the peaks, escalated never deeper than clipper.maxDepthDb) →
  //               limitTruePeak → integratedLoudness, until |LUFS − target| <= 0.1 (max 4
  //               iterations, secant update). Limiter GR above budgetDb → warn.heavyLimiting;
  //               Loud / Club settle within the budget down to minTargetLufs, others are
  //               capped at maxGrDb → warn.targetUnreachable.
  //  11 finish    fades in/out (equal-power)
  //  12 verify    final measure(); QC rollback (RESEARCH §2) when params.qc.enabled: the net
  //               EQ range (±4 dB) is settled on the intended curves before rendering; then
  //               8–16 kHz loss beyond the intended (style / user / reference) change > 3 dB
  //               (+2 × brightened), a band / overall correlation made worse than the input
  //               by widening, or < 0.7 below 120 Hz → soften the single module that moves the
  //               failing metric most (halve, then disable; never a user-owned path) and
  //               re-render from the nearest cache (max 2 rollbacks) → warn.qcRollback.
  //               The outcome is memoised per cache-B key (cache.qcMemo).
  // Cache: opts.cache is a plain object owned by the caller (one per track). When the
  // params relevant to stages 1–3 are unchanged, the post-stage-3 audio is reused; same for
  // stages 1–9 (cache.B, plus cache.B2 = the previous one: destinations differ in their
  // dynamics). Keys are JSON of the relevant param subsets (the output rate is in neither).
  // opts.inputInfo (extension): { loudness, ltas, cutoffHz, clippingRuns, bandCorrelation,
  // correlation } from the analysis, { lossy, bitrateKbps } from the decoder (C3).
/** RenderReport = {
 *   loudness: measure() of output, inputLoudness: measure() of input,
 *   limiter: { grAvgDb, grMaxDb }, clipper: { grMaxDb },
 *   multiband: [{ grAvgDb, grMaxDb }], glue: { grAvgDb, grMaxDb },
 *   deEss: {…}, deHarsh: {…}, spectral: {…},
 *   targetLufs, ceilingDb, targetReached: boolean, warnings: [{ id, vars }],
 *   effectiveTargetLufs,          // what the master was rendered to (Loud / Club may settle lower)
 *   timingsMs: { stage: ms }, eqCurveDb: number[31],  // net static EQ for UI drawing
 *   eqAutoDb: number[31],                             // the auto-EQ curve as applied
 *   ltas: number[31],                                 // master LTAS (UI spectrum overlay)
 *   correlation, bandCorrelation,
 *   qc: { passed, rollbacks: [module], failures: [{ check, value, intended }] },
 *     // passed: every check holds, or only user-owned / style-intended moves are responsible
 *   paramsUsed,                                       // final params after QC rollback (+ meta.realised)
 *   multiband: [{ grAvgDb, grLoudAvgDb, grMaxDb, thresholdDb, makeupDb }], glue: { … grLoudAvgDb },
 *   trim: { trimmed, startSample, sampleRate, startSec, endSample, endSec }
 *     // C2: in the master's sample units; master sample 0 = source time startSec
 * } */
```

### src/engine/worker.js  — message protocol (all messages carry `id`)
```
main → worker
  { type: 'load',    id, trackId, sampleRate, channels: [Float32Array, Float32Array], info? }  (transferred)
                     // info (C3): decodeFile()'s info (plain fields) → warn.lossySource
  { type: 'focus',   id, trackId }                   // the track on screen keeps its render caches
  { type: 'analyze', id, trackId }
  { type: 'render',  id, trackId, params }
  { type: 'ltas',    id, sampleRate, channels }      // reference track: → { ltas, loudness }
  { type: 'cancel',  id: renderIdToCancel }
  { type: 'unload',  id, trackId }
worker → main
  { type: 'progress', id, stage, fraction }
  { type: 'result',   id, result }                   // render result (and preview) channels are transferred
  { type: 'error',    id, message, code }
```
A newer `render` for the same track supersedes an older one: the older is cancelled at
its next stage boundary and rejects with `{ code: 'cancelled' }`. Render caches A / B are
kept for at most 2 tracks (the focused one and the most recently rendered); others keep
their input and analysis.

### src/engine/client.js
```js
export class EngineClient {
  constructor()                    // tries a Worker; falls back to in-thread execution
  get mode()                       // 'worker' | 'inline'
  async loadTrack(trackId, audio, info?) // copies the channels (caller keeps its own);
                                   // C3: info = decodeFile()'s info or null
  async analyze(trackId)           // → AnalysisReport
  async render(trackId, params, onProgress) // → { audio, report, preview? }; rejects {code:'cancelled'} if superseded
                                   // C2: preview (AudioData) only when audio.sampleRate differs from
                                   // the track's source rate: the master resampled back with
                                   // resample.js in the worker, for playback / waveform (export uses audio)
  focusTrack(trackId)              // extension: keep this track's render caches (fire and forget)
  async analyzeReference(audio)    // → { ltas, loudness }
  unload(trackId)
}
```
Worker creation: `globalThis.__AM_WORKER_URL__` (set by the single-file build to a Blob
URL) else `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.
If construction or the first ping fails, switch to inline mode transparently.

---------------------------------------------------------------------------------

## 6. I/O, playback, export

### src/audio/decode.js
```js
export async function decodeFile(file, { maxDurationSec = MAX_DURATION_SEC } = {})
                                         // File|Blob(with name) → { audio: AudioData, info }
/** info = { name, baseName, ext, format: 'wav'|'mp3'|'m4a'|'flac'|'ogg'|'other', codec,
 *           sampleRate, nativeSampleRate, decodedChannels, bitDepth|null, bitrateKbps|null,
 *           duration, sizeBytes, lossy, ... } */
export function sniffFormat(arrayBuffer)       // magic bytes → { format, container?, codec, nativeSampleRate|null, duration|null, ... }
export function parseWav(arrayBuffer)          // PCM 8/16/24/32, float 32/64, EXTENSIBLE → { sampleRate, channels, bitDepth } | throws
export const MAX_DURATION_SEC = 900, LOW_MEMORY_MAX_DURATION_SEC = 600
export function deviceMaxDurationSec(navigator?) // 600 on phones/tablets or deviceMemory ≤ 4, else 900
```
WAV is parsed in JS (exact, no resampling). Other formats: `decodeAudioData` on an
`OfflineAudioContext` created at the file's native sample rate (parsed from MP3 frame
header / MP4 `mdhd`+`esds` / FLAC STREAMINFO / OGG id header / Matroska-WebM Tracks) so
the browser does not resample. Errors are thrown as `{ code: 'unsupported'|'corrupt'|'too_long', message }`
plus details: `unsupported` → `reason` ('codec' = this browser has no decoder for a file
whose header parsed cleanly, probed with `<audio>.canPlayType`; 'format' = unrecognised
file; 'encoding' = exotic WAV/AIFF encoding; 'browser' = no Web Audio), `codec`,
`codecLabel`; `too_long` → `duration`, `maxDurationSec`, `estimated` (true when the
duration is a lower bound). A decode failure of a codec the browser has is `corrupt`.
Memory: the length cap is checked BEFORE decoding for every container (MP3 frame walk,
MP4 `mdhd`/`mehd`, FLAC STREAMINFO, Ogg granule, ADTS frame walk, Matroska Info Duration or
last Cluster time, else a size-based lower bound); `decodeAudioData` receives the file
bytes without a copy (they are detached afterwards); only the gapless-trimmed range of the
AudioBuffer is copied out. The UI may pass `deviceMaxDurationSec()` as the cap (its error
copy must then name the limit from `e.maxDurationSec`). Padding:
parse `iTunSMPB` in M4A and trim encoder delay/padding when the browser does not
(Firefox); MP3 without a LAME/Xing tag gets the known decoder delay trimmed (RESEARCH §6).

### src/audio/metadata.js (tags + cover art; environment-neutral)
```js
export async function readMetadata(fileOrBytes)  // File|Blob|ArrayBuffer|view → never rejects:
/** { format: 'mp3'|'aac'|'m4a'|'flac'|'ogg'|'wav'|'aiff'|'other',
 *    tagTypes: string[],          // blocks found, by priority: 'ID3v2.3', 'ID3v1.1', 'APEv2',
 *                                 // 'MP4 (iTunes ilst)', 'FLAC Vorbis comment', 'RIFF INFO', …
 *    tags: { title, artist, album, albumArtist, date, year, track, disc, genre, composer,
 *            lyricist, conductor, remixer, publisher, copyright, isrc, bpm, key, mood,
 *            language, grouping, subtitle, compilation, originalDate, comment, lyrics,
 *            encoder, encodedBy },  // strings, only present keys, TAG_KEYS order, '\n' EOLs
 *    extra: [{ key, label, value }],   // every other text field, source naming ('WOAS',
 *                                      // 'TXXX:desc', '----:mean:name', Vorbis keys, INFO ids)
 *    pictures: [{ mime, type, typeLabel, description, width|null, height|null, size, bytes }],
 *                                      // mime ∈ IMAGE_MIMES or 'application/octet-stream'
 *    warnings: string[] } */            // ≤ MAX_WARNINGS entries
export function pickCover(metaOrPictures)        // front cover (type 3) → type 0 → first | null,
                                    // only among pictures whose mime is in IMAGE_MIMES
export function prepareExportMetadata(meta, { encoder = 'AudioMaster' } = {})
                                    // drop source-encoding data (encoder, ReplayGain/R128,
                                    // iTunSMPB/iTunNORM, TLEN, play counter, UFID, store ids)
                                    // and pictures that are not a recognised image
export function hasExportMetadata(prepared)       // anything besides the encoder name?
export function buildId3v2(meta, { padding = 0 } = {})   // → Uint8Array, ID3v2.3
export function buildRiffInfo(tags)               // → 'LIST'/'INFO' chunk | null
export const TAG_KEYS, PICTURE_TYPES, MAX_REGION_BYTES (64 MiB), MAX_EXPORT_PICTURE_BYTES (16 MiB),
  MAX_EXPORT_PICTURES_TOTAL_BYTES (64 MiB), MAX_TAG_ITEMS (1024), MAX_PICTURES (64), MAX_WARNINGS (64),
  IMAGE_MIMES ('image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp')
```
Reads only tag regions, never the audio: ID3v2 at the head + ID3v1/APEv2/appended ID3v2 at
the tail, MP4 box headers down to `udta/meta/ilst` (never `mdat`/`stbl`), FLAC metadata
blocks, the Ogg header packets, WAV/AIFF chunk headers (a 1.5 GB WAV costs ~70 KB of reads;
a Blob is read with `slice()`). Several blocks: the first in `tagTypes` wins per field
(ID3v2 > APEv2 > ID3v1; FLAC Vorbis comment > stray ID3v2; WAV 'id3 ' > LIST/INFO);
pictures come from the first block that has any. Picture `bytes` are copies; dimensions
come from the JPEG SOF / PNG IHDR / GIF / BMP / WebP header. The UI shows it with
`URL.createObjectURL(new Blob([p.bytes], { type: p.mime }))`. **Picture bytes come from an
untrusted file: such a blob URL may only be an `<img src>`** — never opened, navigated to,
used as a link (`<a href>`, "view full size" in a new tab), iframe/object source or download
target; a full-size view is a larger `<img>` in the page. `mime` is the sniffed type, else
the declared one only when it is in `IMAGE_MIMES`, else 'application/octet-stream' (never
'text/html' or SVG). Hostile tags are capped (MAX_TAG_ITEMS values per field and extra
fields, MAX_PICTURES pictures per block) and parsing stays linear in the tag size.
Export: `encodeMp3`/`encodeWav` take `metadata` (the source's `readMetadata()` result) and
run `prepareExportMetadata` themselves; the source title is kept (the file name says
"Master"). MP3: ID3v2.3 (Latin-1 for ASCII text, else UTF-16 + BOM; USLT/COMM 'eng'; APIC
in source order) before the Info frame. WAV: LIST/INFO (UTF-8) + 'id3 ' (same ID3v2.3 tag)
before 'data' — read by FFmpeg, CoreAudio/Apple Music and foobar2000, nothing after the
audio (Spotify). Dates: TYER (+ TDAT/TIME), plus TXXX 'DATE' with the full value when those
frames cannot hold it (e.g. M4A '2024-05-06T07:00:00Z'); originalDate → TORY (+ TXXX
'ORIGINALDATE'); never the v2.4-only TDRC/TDOR, which CoreAudio ignores in v2.3. Metadata
that cannot be written never fails an export: the master is then written untagged.
TuneCore asks for WAVs without metadata: the UI may let the user opt out by passing
`metadata: null`.

### src/audio/player.js
```js
export class Player {
  constructor({ onTime, onEnded, onStateChange } = {})
  setTracks(original, mastered, { originalOffsetSec = 0 } = {})
                                     // AudioData|null each; same song keeps the position
  replaceMastered(mastered, { originalOffsetSec = 0 } = {})
                                     // seamless swap (30 ms crossfade) while playing
  async play(); pause(); toggle(); seek(seconds)
  setSource('original'|'master')     // 20 ms equal-gain crossfade, sample-synchronous
  setLoudnessMatch(enabled, lufsOriginal, lufsMaster) // attenuates the louder one only
  setVolume(0..1)
  get currentTime(); get duration(); get playing(); get source()
  get originalOffsetSec()            // effective offset (0 while no master is loaded)
  get analyser()                     // AnalyserNode after the A/B mix (fftSize 8192)
  // Range playback (cut tool), timeline seconds:
  async playRange(start, end, { loop = false, from } = {})
                                     // play [start, end) once (then stop, position = start,
                                     // range mode left) or loop it; restarts at once if playing;
                                     // `from` inside the range starts mid-range; < 10 ms refused
  setRangeLoop(loop)                 // switch looping of the active range live (position kept)
  clearRange()                       // leave range mode; playback continues normally
  get range()                        // { start, end, loop } | null
}
```
* (C5) Timeline = the master's (duration, end, currentTime, seek). `originalOffsetSec` is the
  original's time at master sample 0 (`report.trim.startSec`, the head cut by trim): the
  original voice plays at position + offset and is cut at the master's end. With no master
  the timeline is the original's own. A new master / offset keeps the musical (original)
  time of the position: the first master maps it by −offset, a trim change restarts both
  voices at the same musical moment. The UI passes the same offset to the waveform
  (`Waveform.setAudio(original, master, { originalOffsetSec })`: original lane shifted and
  cropped to the master) and looks the original's loudness curve up at position + offset.
* Sample rate: the AudioContext is created at the original's rate (rebuilt on the next
  play() for a track at another rate; device rate if the browser rejects it) and the UI
  passes `render().preview` (master resampled to the source rate) when present, so no
  voice goes through AudioBufferSourceNode interpolation. Start times, offsets and
  lengths are snapped to whole frames (Chromium interpolates a sub-frame `when`: −5 dB
  at 15 kHz measured).
* A/B uses equal gain (1 − θ, θ): the versions are coherent, equal power would swell
  +3 dB mid-fade. A context that stops running on its own (iOS 'interrupted') puts the
  Player in the paused state at the frozen position; the next play() resumes there.
* Range / loop: bounds are snapped to the reference's frames. A loop uses the sources'
  native `loop` / `loopStart` / `loopEnd`: master [start, end], original [start, end] +
  originalOffsetSec, both started with the same when/offset, so every repeat is the same
  musical range on both voices and A/B stays a gain crossfade (no restart); a seamless
  master swap starts its voice in phase with the running loop. `currentTime` wraps inside
  the loop; pause/play keeps range mode; a seek outside the range leaves it; a timeline
  shift (first master, new trim) moves the range by the same amount (same music); another
  song clears it. Turning the loop on/off or clearRange() restarts the voices LEAD later
  at the position LEAD later, so the music stays continuous.

### src/audio/edit.js (cut tool: non-destructive edits, environment-neutral)
```js
export const EDIT_CROSSFADE_SEC = 0.01, MIN_SELECTION_SEC = 0.05, MIN_RESULT_SEC = 1
// EditList = [[start, end), …] kept ORIGINAL source frames: ascending, disjoint, never
// adjacent (adjacent = one continuous piece, merged). Edited length = Σ(end − start).
export function fullEdit(length)                 // [[0, length]]
export function normalizeEdit(list, length?)     // clamp, sort, merge overlapping/adjacent
export function editLength(list); export function isFullEdit(list, length)
export function editedToSource(list, e)          // edited frame → source frame (clamped)
export function sourceToEdited(list, s)          // source frame → edited (removed part → its join)
export function sliceEdit(list, e0, e1)          // the ranges covering edited [e0, e1)
export function editProblem(list, 'keep'|'remove', e0, e1, { sampleRate | minFrames, minResultFrames })
                                                 // → null | 'tiny' | 'tooShort' | 'noop'
export function keepOnly(list, e0, e1, opts)     // → new list | null (old list untouched: undo)
export function removeRange(list, e0, e1, opts)  // → new list | null
export function applyEdit(audio, list, { crossfadeSec = 0.01 } = {}) // → AudioData, exact length
export function sliceAudio(audio, startSec, endSec, { fadeInSec, fadeOutSec }) // clip, equal-power fades
```
Selections arrive in EDITED frames. Joins: centred equal-power crossfade over 2h frames
(h ≤ crossfade/2, the audio available past each side and half of each adjacent piece),
so the edited length stays exact and the time map is piecewise linear with no drift; the
two sides of a cut are unrelated material, hence equal power. Round trips are exact:
sourceToEdited(editedToSource(e)) = e, and editedToSource(sourceToEdited(s)) = s for kept s.

### Cut tool UI (src/ui/cut.js, app.js, waveform.js cut mode)
* "Taglia" in the tape toolbar opens the bar under the waveform (closed by default: the
  simple view and the default waveform never change). `Waveform.setCutMode(true)`: drag =
  select (`onSelect(sel, final)`), IN / OUT edges grabbed within 24 px (finger) / 7 px
  (mouse), grips at the bottom, tap = seek; touch stays undecided for 8 px so a vertical
  swipe scrolls the page (touch-action: pan-y); `setView` / `zoomBy` / `scrollTo`,
  ctrl/⌘ + wheel zooms at the pointer, a horizontal wheel scrolls; the view pages forward
  with the playhead. Leaving cut mode restores the whole-song view.
* The selection lives on the player's timeline (master seconds), drawn on both lanes;
  `selectionToEdited(sel, { lead, sampleRate, timelineDuration, editedFrames })` maps it
  to the edited song (+ lead = report.trim; 0 / the end reach the edited ends). A new trim
  shifts it to stay on the same music; another song or an edit clears it. Keys I / O / L /
  Esc only while the bar is open and focus is not in a text field (`cutKeyAllowed`).
* Two separate actions: "Salva la selezione" (app.js `exportClip`) = the selected part of
  the MASTER at the export panel's format / rate (`ensureRendered` + `sliceAudio` +
  encodeWav / encodeMp3 + saveBlob, same toasts; an MP3 clip over −0.1 dBTP after decoding
  is turned down by the overshoot, never re-mastered), name `<nome> (Master) 0m12s-0m42s`.
  "Tieni solo / Elimina la selezione" edit the song: per track `source` (decoded audio)
  and `edits` (EditList | null); every edit and "Torna al brano completo" is a step of the
  global undo history (below), the "Modificato" strip has no undo of its own. An edit
  renders `applyEdit(source, edits)` into `tr.audio`, cancels the running render, drops master + analysis, reloads the engine under the SAME
  track id (handlers.handleLoad replaces the track: fresh caches and analysis) and
  re-analyzes / re-masters; analyze() ignores results for audio that is no longer the
  song's. The A/B original is the edited song, so A/B and the waveform stay aligned;
  choices, overrides and "suona troppo" offsets are kept; exports use the edited master.

### Undo / redo (src/ui/history.js, app.js)
* One global history, "Annulla" / "Ripeti" in the header (always present; `aria-disabled`
  when empty, accessible name and tooltip "Annulla: Carattere «Caldo»"), Ctrl/⌘+Z,
  Shift+Ctrl/⌘+Z, Ctrl+Y (`historyKey`; never in a text / number field, `undoKeyAllowed`,
  nor while a help card is open). After each undo / redo one toast names the step.
* history.js is pure (tests/history.test.mjs): `createHistory({ limit: 50 })` →
  `record({ label, trackId, before, after }, { key, now, windowMs, force })` (no step when
  before = after; a new step clears redo; same `key` within `windowMs` = 600 ms of the last
  event merges, Infinity while a fader is held, `seal()` on pointer release, `force` for
  the double-click reset; a merge back to the start removes the step and gives back the
  redo list it cleared), `undo()` / `redo()` hand the step back, `prune()` drops a
  removed song. `labelText()` translates `{ key, vars }` labels at display time.
* app.js `act(label, fn, { track, coalesce, force })` snapshots the undoable state before
  and after `fn`: destination, global choices and per song { choices (reference with its
  LTAS: never decoded again), overrides, problemOffsets, edits }. Undoable: destination
  (incl. "Altro…"), character, intensity (buttons; slider drag = one step), cleanup,
  "Suona troppo…" and Azzera, every Avanzate change (fader drag / switch / double-click
  reset / "Ripristina automatico"), the fade fix, reference load / remove, "Applica a
  tutti", cut edits and "Torna al brano completo". Not undoable: playback, A/B, zoom,
  selection, language, theme, export format / rate, adding / removing songs (a removed
  song's steps go), exports.
* `applySnapshot` touches only what differs: every song whose params it restored goes
  through `requeue` — the master it has matches them again: a render in flight is dropped
  at once (nothing renders); else the song on screen, or one that is rendering, through
  `scheduleRender` (debounced, the in-flight render superseded, a failed render retried);
  any other song waits for `pumpBackground`. A different edit goes through `setTrackEdit`
  (as a cut); a different destination re-masters all songs. A step of another song is
  restored with that song scheduled as the one on screen, then the app switches to it
  (the toast says which song), so its old render never lands in the player. A step that
  changes an edit waits while a save runs (cutProblem 'busy'). The destination's
  "loudness replaced" toast and the cut / reset toasts offer Annulla only while their
  step is the last one. After a cut, focus goes to the header's Annulla only when it is
  on screen (`focusUndo`); on a phone, where it is scrolled far above the cut bar, the
  edit card (`#am-cut-edit`, tabindex −1) keeps it.

### Help cards UI (src/ui/help.js)
* `helpButton(id, { P, label, current })` → the (i) button next to a control's label, or
  null when `help.<id>.what/.when/.example` do not exist (nothing is drawn). One shared
  card (Popover API, else a fixed layer): title, "Cosa fa", "Quando usarlo", "Esempio",
  optional "Valori" (`help.<id>.range`). Groups (destination, character, cleanup, "Suona
  troppo…", format, spectrum legend) have an intro (`help.<id>.what`) and one tab per
  option; `current()` picks the tab shown first. Esc / outside click / Tab past the end /
  the button scrolling out of view close it; focus moves in and back. Bottom sheet under
  `(pointer: coarse), (max-width: 520px)`; mouse hover shows the intro line after 400 ms.
* `HELP_TOPICS` lists every non-Advanced topic the UI places; `advancedHelpId(sec, ctl,
  sections)` finds an Advanced control's text as `<parent switch labelKey>.<own label>`
  (generic labels: adv.amount, adv.maxCut…) then its own `labelKey`; `output.sampleRate`
  → `export.rate`. tests/help.test.mjs fails when a section / control has no own entry,
  a text is orphaned or too long, or a slider's stated range no longer matches params.js.
* `advancedHint()`: the one-time tip under the Advanced heading (`am.helpHint` in
  localStorage, try/catch).

### Metadati box (src/ui/metabox.js, app.js)
* app.js calls `deps.readMetadata(file)` (src/audio/metadata.js) next to `decodeFile`;
  the result is `tr.meta` (`tr.metaState`: 'none' → 'loading' → 'ready', the promise in
  `tr.metaPromise`). The demo has none.
* `createMetaBox({ help, keep, onKeepChange })` → `{ el, update(tr), setKeep(on),
  setDisabled(on), relabel(), destroy() }`: update() rebuilds the rows only when the song,
  its metadata / info or the language changed (a focused link survives app renders); cover (`pickCover`, blob URL used only as `<img src>`, revoked when it
  changes; a click toggles a full-width view), title / artist / album · year, the other
  tags as rows, lyrics and the remaining fields under their original names in folds
  (http(s) values become links, rel="noopener noreferrer"), technical details from the
  decode info. Untagged files and the demo say so. Pure helpers are exported for tests.
* "Copia copertina e metadati nel master" (`state.exportMeta`, stored in `am.export` as
  `meta`, default on): exports pass `metadata: tr.meta` (or null) to `encodeWav` /
  `encodeMp3`, which run `prepareExportMetadata` themselves. Not an undo step. The switch
  is shown only when a master would carry something (`carriesMeta`), is locked while an
  export runs, and its value is read once per export; an export waits for a metadata read
  still in progress, and a song removed during the export is left out and named.

### Tema (src/ui/theme.js)
* Skins: auto (follows the host's `data-theme` / prefers-color-scheme), dark, light, fluo,
  analog, synthwave, contrast. Each is a full palette of the color tokens of styles.css,
  injected once as `<style id="am-skins">` with `html:root[data-am-skin="<id>"]` rules
  (specificity 0,2,1, independent of stylesheet order). `initSkin()` (main.js, before
  boot) applies the stored choice (`am.skin`); `setSkin()` also swaps an `am-skin-<id>`
  class on `<html>`, which app.js's MutationObserver turns into a canvas repaint.
* `createSkinPicker({ t })` → the header button + menu (menuitemradio, keyboard, type-ahead,
  kept inside the viewport). tests/theme.test.mjs checks every palette against WCAG
  contrast targets and the dark / light palettes against styles.css.

### src/export/*
```js
// wav.js
export function encodeWav(audio, { bitDepth = 24, dither = true, metadata = null } = {}) // → Blob 'audio/wav'
  // Integer PCM ALWAYS uses format tag 1 (WAVE_FORMAT_PCM, Spotify rejects 0xFFFE), float
  // uses tag 3 + 'fact' chunk; 'data' is the last chunk; no trailing chunks.
  // metadata (readMetadata() result of the source) → LIST/INFO + 'id3 ' chunks BEFORE 'data'.
export function encodeWavBuffer(audio, opts)  // same, → ArrayBuffer
export function wavMetadataChunks(metadata)   // → [LIST/INFO?, 'id3 '] | [] (nothing to write)
// mp3.js
export const LAME_URL, LAME_FALLBACK_URL            // exact pinned CDN URLs (cdnjs, jsdelivr)
export const LAME_INTEGRITY, LAME_FALLBACK_INTEGRITY // their SRI hashes
export async function loadLame()    // injects <script integrity crossorigin>, primary then
                                    // fallback; resolves window.lamejs; throws code 'mp3_load'
export async function encodeMp3(audio, { kbps = 320, onProgress, metadata = null } = {}) // → Blob 'audio/mpeg'
  // audio.sampleRate must be 32000|44100|48000 (caller resamples); chunked with yields
  // metadata → ID3v2.3 tag in front of the Info/LAME frame (gapless length unchanged)
// zip.js
export function makeZip(files)      // [{ name, data: Uint8Array|ArrayBuffer }] → Blob (store, CRC32)
// save.js (contract C4)
export async function saveBlob(blob, filename)
  // 1. If an embedding host defined globalThis.__AM_HOST__ = { downloads(), extensions? }
  //    (a sandboxed frame where <a download> is blocked) → its saver. Extensions not in
  //    `extensions` are wrapped in a STORE .zip when the host accepts .zip; otherwise (or
  //    for a .zip it refuses) → 'unavailable' / 'format_not_accepted' without a prompt
  //    (other formats may still save; the UI keeps the download on). NEVER falls back to
  //    <a download> there (the sandbox blocks it silently).
  // 2. Else classic <a download> with an object URL.
  // → { status, filename, code? }, never rejects. status:
  //   'saved' | 'declined' | 'busy' (code rate_limited | busy: a save prompt is open) |
  //   'too_large' (the host refused the size, or zip_too_large / zip_failed: offer MP3 /
  //   one track) | 'unavailable' (code 'no_capability' = downloads() resolved null or did
  //   not answer within 20 s, 'format_not_accepted', the host's own code; 'no_dom' outside
  //   a browser)
export function probeSaveSupport()  // → Promise<'host'|'browser'|'none'>; host.downloads() is
                                    // memoized per host object and shared with saveBlob. A null
                                    // answer (or none within 20 s) is not kept: the next probe
                                    // asks again (a save does not), and an answer arriving after
                                    // the timeout is kept for the next probe. app.js probes at
                                    // boot and, after 'none', again after 3 / 10 / 30 s and when
                                    // the page is back in front; a save's 'unavailable' stays.
```
`node tools/build.mjs --embed-adapter=<file> [--embed-head=<file>]` also writes
`dist/embed.html`: an HTML fragment (no doctype / head / body) with the adapter bundled as
an IIFE before the app; the build fails when the adapter does not assign
`globalThis.__AM_HOST__`. Without the flag, any older embed.html is removed.

---------------------------------------------------------------------------------

## 7. Issue ids (analysis → UI chips)

`clipping`, `overs` (true peak > 0 dBTP), `tooLoud` (LUFS > −9), `tooQuiet` (LUFS < −20),
`dcOffset`, `rumble`, `boomy`, `muddy`, `harsh`, `fizz`, `sibilant`, `shimmer` (AI HF
artifacts), `hiss`, `dull` (lacks air), `brightened` (Suno "Remaster"-like excess 6–10 kHz),
`codecCutoff` (low-pass ≤ 17 kHz), `nearMono`, `phase` (correlation < 0.2), `wideBass`
(correlation < 0.7 below 120 Hz), `abruptEnd`, `silence`, `overCompressed` (PLR < 8 dB and
LRA < 3 LU).

---------------------------------------------------------------------------------

## 8. Performance budgets (3:30 stereo 48 kHz, Apple M1 class, Chrome)

analyzeTrack < 2 s · full renderMaster < 8 s · re-render with spectral cache < 4 s ·
re-render loudness-only change (cache B) < 2 s · WAV encode < 1 s · MP3 320 < 10 s.

## 9. Testing

`node tests/run.mjs` runs every `tests/*.test.mjs` (each exports
`export const tests = { 'name': async () => {...} }`). `tests/helpers.mjs` provides
`assert`, `approx(a, b, tol, msg)`, signal generators (sine, pink noise, sweep, impulse),
`writeWavFile(path, audio, bitDepth)`, and `ffmpeg(args)` / `ffmpegLoudness(path)`
(skipped gracefully when ffmpeg is missing). Tests must be deterministic.

---------------------------------------------------------------------------------

## 10. Shared i18n keys (engine ↔ UI)

The engine never produces user-facing text; it returns keys + vars that `src/ui/i18n.js`
translates (IT default, EN). Every key below must exist in both languages.

* Stages (progress): `stage.decode`, `stage.analyze`, `stage.prepare`, `stage.trim`,
  `stage.spectral`, `stage.eq`, `stage.dyneq`, `stage.color`, `stage.multiband`,
  `stage.stereo`, `stage.glue`, `stage.loudness`, `stage.finish`, `stage.verify`,
  `stage.encode`, `stage.zip`.
* Issues: `issue.<id>` (short chip label) and `issue.<id>.hint` (one sentence) for every
  id in §7.
* Assistant decisions — `describeDecisions()` returns `[{ key, vars }]` with keys:
  `dec.highpass {hz}`, `dec.deShimmer {pct, hz}`, `dec.denoise {db, hz}`,
  `dec.mud {db, hz}`, `dec.boom {db, hz}`, `dec.harsh {db, hz}`, `dec.fizz {db, hz}`,
  `dec.deEss {db, hz}`, `dec.sideHf {db}`, `dec.hash {db}`, `dec.autoEq {db}`,
  `dec.match {name, pct}`, `dec.tone {style}`, `dec.saturation {pct}`, `dec.air {pct}`,
  `dec.multiband {db}`, `dec.monoBass {hz}`, `dec.width {pct}`, `dec.glue {db}`,
  `dec.loudness {lufs, ceiling, dest}`, `dec.fadeOut {sec}`, `dec.trim {}`,
  `dec.profile {profile}`.
  (`style` / `dest` / `profile` vars are ids: the UI translates them via `style.<id>` /
  `dest.<id>` / `profile.<id>`.)
* Render warnings — `report.warnings[]` ids: `warn.targetUnreachable {lufs, gr}`,
  `warn.heavyLimiting {gr}`, `warn.inputClipped {}`, `warn.lossySource {kbps}`,
  `warn.longTrack {min}`, `warn.qcRollback {module}`, `warn.loudArtifacts {}` (target
  −8 LUFS or louder on an artifact-heavy track), `warn.crushedInput {}`.
* Choice labels: `dest.<id>` + `dest.<id>.hint` (all DESTINATION_IDS),
  `style.<id>` + `style.<id>.hint`, `intensity.low|medium|high`,
  `cleanup.<id>` + `cleanup.<id>.hint`, `problem.<id>` (PROBLEM_IDS), `platform.<id>`
  (PLATFORMS), `profile.<id>`.
* Advanced panel: every `labelKey` in `ADVANCED_SECTIONS` (params.js).
  New or renamed controls also need `help.<id>.what/.when/.example` (+ `.range` for sliders,
  with the real min / max), see "Help cards UI"; without them the control simply has no (i).
* Notices: `notice.aiPolicy` (check your distributor's rules on AI-generated music),
  `notice.sunoLicense` (songs made on Suno's free plan are not licensed for release).
* Errors: `err.unsupported`, `err.corrupt`, `err.tooLong`, `err.render`, `err.export`,
  `err.mp3Load`.
