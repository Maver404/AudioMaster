# 05 — DSP algorithms and constants for the mastering chain (plain JS, offline)

Researched: 2026-10-26. Target runtime: vanilla JS, `Float32Array` sample buffers, offline (whole-file) processing, 44.1/48 kHz typical (Suno exports), 88.2/96 kHz possible.

How to read this file:
- **[STD]** = taken from a standard or a maintainer's reference code (source listed).
- **[VERIFIED]** = the researcher re-computed it numerically (Python, float64) during this research. Results are quoted.
- **[ENG]** = engineering proposal or typical value. Not from a standard. Tune by ear and with tests.
- **[UNCERTAIN]** = conflicting sources, or a source that could not be fully retrieved.

---

## 0. Global conventions (read first)

1. **Precision.** JS `Number` is float64. Keep **all filter coefficients and filter states in plain JS numbers** (locals) or `Float64Array`. Use `Float32Array` only for sample storage. Low-frequency biquads with float32 coefficients drift measurably. [VERIFIED] An RBJ HPF at 10 Hz/48 kHz with float32-rounded coefficients reads −0.302 dB at 20 Hz instead of −0.263 dB. At 5 Hz the error is about 0.8 dB at 2 Hz.
2. **Time constants.** Two conventions are in use. Always say which one you mean.
   - Giannoulis/Reiss and most DSP code: `α = exp(−1/(τ·fs))`. Then τ is the time to reach 63.2 % (1 − 1/e).
   - MathWorks `compressor`: `α = exp(−ln(9)/(τ·fs))`. Then τ is the 10 %→90 % rise time.
   - The ratio between the two is ln 9 ≈ 2.197. The same "10 ms attack" is 2.2× faster in the MathWorks convention.
3. **Mono input.** Convert mono to dual-mono (L = R) before processing. BS.1770 treats a single mono channel with weight 1.0, so a mono file reads 3.01 dB lower than the same audio as dual-mono stereo. libebur128 offers a "dual mono" weight of 2.0 for this case.
4. **Denormals.** JS gives no FTZ/DAZ control. Recursive filters decaying into silence can hit subnormals, which are slow on some CPUs. Flush states when `|s| < 1e-30`, or add ±1e-25 alternating "noise". [ENG]
5. **Determinism.** Use a seeded PRNG (e.g. mulberry32/xorshift) for dither and any randomness. Renders and tests then become reproducible. [ENG]

---

## 1. ITU-R BS.1770 loudness (integrated, momentary, short-term)

Source: ITU-R BS.1770-5 (11/2023). Annex 1 (loudness) and Annex 2 (true-peak) are numerically the same as in -4 (2015). What -5 adds is Annex 4 for object-based audio. [STD]

### 1.1 K-weighting pre-filter, coefficients at 48 kHz (BS.1770 Tables 1 and 2) [STD]

Difference equation (Fig. 3 of the Rec.): `y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] − a1 y[n-1] − a2 y[n-2]`, with a0 = 1.

| Stage | b0 | b1 | b2 | a1 | a2 |
|---|---|---|---|---|---|
| 1: high shelf ("spherical head") | 1.53512485958697 | −2.69169618940638 | 1.19839281085285 | −1.69065929318241 | 0.73248077421585 |
| 2: RLB high-pass | 1.0 | −2.0 | 1.0 | −1.99004745483398 | 0.99007225036621 |

The Rec. says that for other sample rates the coefficients "should be chosen to provide the same frequency response". It gives no formula. Do **not** leave the stage-2 numerator un-normalized in one place and normalize it in another. The spec numerator `[1, −2, 1]` gives about +0.043 dB passband gain. The −0.691 constant assumes exactly these filters.

### 1.2 Analytic formulas for any sample rate (libebur128 = Brecht De Man's derivation) [STD] [VERIFIED]

```js
// Returns [stage1, stage2] biquads {b0,b1,b2,a1,a2} with a0 = 1
function kWeightingCoefs(fs) {
  // Stage 1: high shelf
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass. Numerator stays [1, -2, 1] (NOT normalised), as in the Rec.
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}
```

Verification [VERIFIED]:
- At fs = 48000 these formulas reproduce Tables 1 and 2 **to all 14 printed decimals**.
- The K-weighting gain at 997 Hz is +0.6910 dB, which is exactly what the −0.691 offset cancels (Rec. Note 1).
- Derived coefficients at 44.1 kHz: stage 1 b = [1.53084123005035, −2.65097999515473, 1.16907907992159], a1 = −1.66365511325602, a2 = 0.71259542807323. Stage 2 a1 = −1.98916967362980, a2 = 0.98919903578704.
- At 96 kHz: stage 1 b = [1.55971422897580, −2.92674157825108, 1.37826120231582], a1 = −1.84460946989011, a2 = 0.85584332293064. Stage 2 a1 = −1.99501754472472, a2 = 0.99502375904092.
- The 44.1 kHz response differs from the 48 kHz response by < 0.005 dB from 1 kHz to 20 kHz.
- Total K-weighting magnitude at 48 kHz: 20 Hz −13.275 dB · 38 Hz −6.003 · 100 Hz −1.133 · 1 kHz +0.698 · 1.5 kHz +2.036 · 2 kHz +3.071 · 4 kHz +3.968 · 10 kHz +4.042 · 20 kHz +4.043 dB. Use these as unit-test values.

**Caveat (pyloudnorm).** pyloudnorm's *default* `filter_class="K-weighting"` approximates the curve with RBJ shelf (G = 4 dB, Q = 1/√2, fc = 1500 Hz) and RBJ HPF (fc = 38 Hz, Q = 0.5). [VERIFIED] It reads about **0.04 dB low** versus the exact filters at 48 kHz, mostly because the RBJ HPF is normalized to unity passband. pyloudnorm's `"DeMan"` class uses the exact formulas above. Use DeMan/libebur128 values if you compare results against pyloudnorm.

### 1.3 Power, channel weights, loudness [STD]

- Mean square per channel over interval T: `z_i = (1/T) Σ y_i²`, where y_i is the K-weighted signal.
- Loudness: `L_K = −0.691 + 10·log10( Σ_i G_i · z_i )` in LKFS (= LUFS).
- Channel weights: G_L = G_R = G_C = 1.0; G_Ls = G_Rs = 1.41 (≈ +1.5 dB); LFE excluded.

### 1.4 Gating (integrated loudness) [STD]

- Gating block T_g = 400 ms, "to the nearest sample". Overlap 75 % (hop = 100 ms). Incomplete blocks at the end are discarded.
- Block loudness: `l_j = −0.691 + 10 log10 Σ_i G_i z_ij`.
- Absolute gate: keep blocks with `l_j > Γ_a = −70 LKFS`.
- Relative gate: `Γ_r = −0.691 + 10 log10( Σ_i G_i · mean_{j∈J_a}(z_ij) ) − 10` (LU).
- Integrated: `L_KG = −0.691 + 10 log10( Σ_i G_i · mean_{j∈J_g}(z_ij) )`, where `J_g = { j : l_j > Γ_r and l_j > Γ_a }`.
- Averaging happens on **powers**, never on dB values.

### 1.5 Momentary / short-term (EBU Tech 3341 V4, Nov 2023) [STD]

- Momentary: sliding rectangular window of 0.4 s, **ungated**.
- Short-term: sliding rectangular window of 3 s, **ungated**.
- Meter update rate ≥ 10 Hz.
- The BS.1771 IIR (τ = 0.4 s) momentary variant can differ by up to 2 LU. Do not use it.

### 1.6 Efficient implementation (libebur128 approach) [STD]

Accumulate the sum of K-weighted squares per channel in **100 ms sub-blocks**. Then:
- a 400 ms block = 4 consecutive sub-blocks;
- a 3 s short-term window = 30 sub-blocks.

```js
function loudnessAnalysis(chans /* Float32Array[] */, fs) {
  const [s1, s2] = kWeightingCoefs(fs);
  const step = Math.round(0.1 * fs);               // 4410 @44.1k, 4800 @48k
  const nSub = Math.floor(chans[0].length / step);
  const sub = chans.map(() => new Float64Array(nSub));
  chans.forEach((x, c) => {
    let p1 = 0, p2 = 0, q1 = 0, q2 = 0;            // TDF-II states, float64
    const acc = sub[c];
    for (let n = 0, N = nSub * step; n < N; n++) {
      const xn = x[n];
      const y1 = s1.b0 * xn + p1; p1 = s1.b1 * xn - s1.a1 * y1 + p2; p2 = s1.b2 * xn - s1.a2 * y1;
      const y2 = y1 + q1;         q1 = -2 * y1 - s2.a1 * y2 + q2;   q2 = y1 - s2.a2 * y2;
      acc[(n / step) | 0] += y2 * y2;
    }
  });
  const G = chans.map(() => 1.0);                  // stereo: 1.0, 1.0
  const lk = p => -0.691 + 10 * Math.log10(p);
  const winPow = (j, len) => {                     // weighted mean-square of window starting at sub j
    let p = 0;
    for (let c = 0; c < chans.length; c++) {
      let s = 0; for (let k = 0; k < len; k++) s += sub[c][j + k];
      p += G[c] * s / (len * step);
    }
    return p;
  };
  const blocks = []; for (let j = 0; j + 4 <= nSub; j++) blocks.push(winPow(j, 4));      // 400 ms, hop 100 ms
  const st = [];     for (let j = 0; j + 30 <= nSub; j++) st.push(lk(winPow(j, 30)));     // 3 s, hop 100 ms
  const absG = blocks.filter(p => lk(p) > -70);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const I = absG.length ? (() => {
    const thr = lk(mean(absG)) - 10;
    const rel = absG.filter(p => lk(p) > thr);
    return lk(mean(rel));
  })() : -Infinity;
  return { integrated: I, momentary: blocks.map(lk), shortTerm: st };
}
```

(Use running sums instead of the inner `k` loops for long files.)

### 1.7 Compliance test vectors (EBU Tech 3341 V4, Table 1) [STD]

Minus signs were lost in PDF extraction. They are restored here from context, since all levels are dBFS.
- #1: stereo 1 kHz sine, −23.0 dBFS peak per channel, 20 s → M, S, I = −23.0 ±0.1 LUFS.
- #2: same at −33 dBFS → −33.0 ±0.1.
- #3: 10 s @ −36, 60 s @ −23, 10 s @ −36 → I = −23.0 ±0.1 (tests the relative gate).
- #4: 10 s @ −72, 10 s @ −36, 60 s @ −23, 10 s @ −36, 10 s @ −72 → I = −23.0 ±0.1 (tests the absolute gate).
- #5: 20 s @ −26, 20.1 s @ −20, 20 s @ −26 → I = −23.0 ±0.1.
- Calibration check: a stereo 1 kHz sine at −18 dBFS peak should read −18.0 LUFS.

---

## 2. Loudness Range — EBU Tech 3342 V4 (Nov 2023) [STD]

1. Input: short-term loudness values (BS.1770, 3 s sliding window, **ungated**) computed at **≥ 10 Hz**. That means a minimum overlap of 2.9 s, so a 100 ms hop is the natural choice. For file-based measurement, append ≥ 1.5 s of silence before finalizing.
2. Absolute gate: keep values `≥ −70 LUFS`.
3. Relative gate: `L_int = 10·log10( mean(10^(L/10)) )` over the abs-gated values. Keep values `≥ L_int − 20 LU`.
4. Sort ascending. Percentiles (Matlab, 1-based): `low = s[round((n−1)·10/100 + 1)]`, `high = s[round((n−1)·95/100 + 1)]`. In JS (0-based): `s[Math.round((n-1)*0.10)]` and `s[Math.round((n-1)*0.95)]`.
5. `LRA = high − low` (LU).

Test vectors (Tech 3342 Table 1): stereo 1 kHz, 20 s @ −20 dBFS then 20 s @ −30 → LRA = 10 ±1 LU. −20/−15 → 5 ±1. −40/−20 → 20 ±1.

[UNCERTAIN] libebur128 builds its LRA short-term blocks every **1 s** (its frame counter resets to 20 × 100 ms after each 3 s block). That predates the V3 (2016) ≥ 10 Hz requirement. Expect small LRA differences versus libebur128/ffmpeg, especially on short material. Follow Tech 3342 (100 ms hop).

---

## 3. True-peak — BS.1770-5 Annex 2 [STD] [VERIFIED]

### 3.1 Algorithm

1. Attenuate by 12.04 dB. This step exists only for integer headroom. **Skip it in float.**
2. Oversample 4× (48 → 192 kHz) by zero-stuffing plus a low-pass FIR (polyphase in practice).
3. Take the absolute value, then the maximum.
4. Convert: `dBTP = 20·log10(max)`. Add +12.04 dB only if step 1 was applied.

### 3.2 Reference FIR (order 48, 4 phases × 12 taps)

Signs were restored and checked: the restored filter is a proper low-pass (see 3.3).

```js
const TP_P0 = [ 0.0017089843750,  0.0109863281250, -0.0196533203125,  0.0332031250000,
               -0.0594482421875,  0.1373291015625,  0.9721679687500, -0.1022949218750,
                0.0476074218750, -0.0266113281250,  0.0148925781250, -0.0083007812500];
const TP_P1 = [-0.0291748046875,  0.0292968750000, -0.0517578125000,  0.0891113281250,
               -0.1665039062500,  0.4650878906250,  0.7797851562500, -0.2003173828125,
                0.1015625000000, -0.0582275390625,  0.0330810546875, -0.0189208984375];
const TP_P2 = TP_P1.slice().reverse();
const TP_P3 = TP_P0.slice().reverse();
// Phase p output at input time n:  y_p[n] = Σ_{k=0..11} TP_Pp[k] · x[n−k]
// Equivalent 48-tap prototype: h[4k + p] = TP_Pp[k]  (symmetric, linear phase,
// delay 23.5 samples @4x = 5.875 input samples)
```

### 3.3 Measured properties of this FIR [VERIFIED]

- Normalized to ×4: passband ripple within about ±0.1 dB up to 20 kHz (at 48 kHz in). −1.8 dB at 22 kHz, −6.2 dB at 24 kHz, −15 dB at 26 kHz, ≈ −40 dB stopband from 28 kHz up.
- Per-phase DC gains are uneven: phases 0/3 sum to 1.0016 and phases 1/2 sum to 0.9730 (−0.24 dB). This is inherent in the published quantized design and sits inside meter tolerance.
- EBU Tech 3341 true-peak cases run through this FIR at 48 kHz (tolerance +0.2/−0.4 dB):
  - #15 fs/4, 0.5 FS, 0° → −6.021 dBTP
  - #16 fs/4, 45° → −5.976
  - #17 fs/6, 60° → −6.316 (closest to the tolerance edge)
  - #18 fs/8, 67.5° → −6.028
  - #19 fs/4, 1.41 FS, 45° → **+3.029 dBTP**, while sample peak is −0.026 dBFS. All pass.
- Report `max(samplePeak, interpolatedPeak)`. Phase 0 is not exactly the original sample, because h[4k] is not a delta. [ENG, conservative]

### 3.4 Other sample rates [STD]

- BS.1770-5: "higher sampling rates require proportionately less over-sampling (e.g. … 96 kHz … 2× would be sufficient)". Meters that reach ≥ 192 kHz internally report dBTP.
- libebur128: 4× (49-tap Hann-windowed sinc) below 96 kHz; 2× for 96 ≤ fs < 192 kHz; no true-peak computed at ≥ 192 kHz.
- At 44.1 kHz the 48 kHz-designed FIR scales with fs: its −0.1 dB edge moves to about 18.4 kHz. That is fine for metering. [ENG]

### 3.5 Under-read bound vs oversampling ratio (BS.1770 Annex 2, Attachment 1) [STD] [VERIFIED]

`maxUnderRead_dB = −20·log10( cos(π·f_norm / n) )`, where f_norm = highest frequency / fs.

| Oversampling n | f_norm = 0.45 | f_norm = 0.5 |
|---|---|---|
| 2× | 2.379 dB | 3.010 dB |
| 4× | 0.554 | 0.688 |
| 8× | 0.136 | 0.169 |
| 16× | 0.034 | 0.042 |
| 32× | 0.008 | 0.010 |

Consequence: a limiter whose *detector* uses 4× can still let up to about 0.55–0.7 dB of inter-sample overshoot through in the worst (HF-heavy) case. Use **8× detection**, or 4× plus a ≥ 0.5 dB margin, plus an offline verification pass (section 4.4).

---

## 4. Transparent lookahead brickwall / true-peak limiter and soft clipping

### 4.1 Signalsmith "moving-minimum + box-filter" limiter (Geraint Luff, 2022-04-08) [STD]

Per sample:
1. **Target gain:** `gt[n] = min(1, ceiling / peak[n])`. `peak[n]` is the stereo-linked detector value: max over channels of |x|, or of the 4×/8× interpolated values for true-peak.
2. **Moving minimum** ("inverted peak hold") of `gt` over `Hh` samples.
3. **Release** (in the gain path, *before* smoothing): `r += (h − r)·slew; r = min(r, h)`, with `slew = 1/(releaseSamples + 1)`. Attack is instant here; smoothing provides it.
4. **Smoothing:** a finite moving average (box or cascaded boxes, "BoxStackFilter") with total support `L ≤ Hh`.
5. **Output:** `y[n] = x[n − (L−1)] · g[n]`. The latency is L − 1 samples, which is "the attack".

**No-overshoot proof (worked out here; the article states the principle).** g[n] is a convex combination of r[n−k], k = 0…L−1. Each `r[n−k] ≤ h[n−k] = min_{j<Hh} gt[n−k−j]`. The delayed sample index m = n−L+1 lies inside every one of those windows iff `Hh ≥ L`. Hence `g[n] ≤ gt[m]`, so `|y| ≤ ceiling` exactly, as measured by the detector. Requirements: **hold length ≥ smoothing support**, and delay = support − 1.

- Article example values: 5 ms attack (smoothing), +15 ms extra hold, 40 ms release. The basic version uses a 30 ms hold/smoothing with 30 ms latency.
- `BoxStackFilter(maxSize, layers = 4)`. Optimal layer-length ratios come from a table; for 2 layers they are 0.58224186169 / 0.41775813831. More layers give a smoother, more Gaussian kernel. Heuristics in the source: main-lobe width ≈ 1.58·(layers + 0.1); stop-band peak ≈ 5 − 18·layers dB.
- Hold also prevents gain "flutter" between closely spaced peaks.

JS building blocks [ENG]:

```js
// O(1) amortised moving minimum over W samples (monotonic deque in a ring of size >= W+1)
function movingMin(src, W) {
  const N = src.length, out = new Float32Array(N);
  const cap = 1 << Math.ceil(Math.log2(W + 1)), m = cap - 1, idx = new Int32Array(cap);
  let head = 0, tail = 0;
  for (let n = 0; n < N; n++) {
    const v = src[n];
    while (tail > head && src[idx[(tail - 1) & m]] >= v) tail--;
    idx[(tail++) & m] = n;
    if (idx[head & m] <= n - W) head++;
    out[n] = src[idx[head & m]];
  }
  return out;
}
// Box filter (causal moving average) of length Lb, float64 running sum
function boxFilter(src, Lb) {
  const out = new Float32Array(src.length); let sum = 0;
  for (let n = 0; n < src.length; n++) {
    sum += src[n] - (n >= Lb ? src[n - Lb] : 1.0);   // pre-fill history with gain 1.0
    out[n] = sum / Lb;
  }
  return out;
}
// Two cascaded boxes with total support L = L1 + L2 - 1: L1 = round(0.5822*(L+1)), L2 = L + 1 - L1
```

### 4.2 Other reference designs (for comparison)

- **Fons Adriaensen zita/x42 DPL** (GPLv3) [STD]:
  - Lookahead ≈ 1.2 ms, rounded up to a multiple of `div1`; at 48 kHz that is 64 samples (1.33 ms).
  - Two-stage block peak detection: `div1` = 8 samples (≤ 65 kHz), `div2` = 8.
  - A second detector on a 500 Hz one-pole low-passed signal.
  - Sliding-minimum histories.
  - One-pole attack `w1 = 10/delay`, so the attack time constant ≈ 1/10 of the lookahead.
  - Release clamped to 1 ms–1 s, `w3 = 1/(τ·fs)`, default 10 ms.
  - True-peak option: 4×, 48-tap "cosine-windowed sinc", used **for detection only**; the audio path is not oversampled.
- **Matchering "Hyrax"** limiter (GPLv3) [STD]:
  - Defaults: attack 1 ms, hold 1 ms, release 3000 ms.
  - Attack: sliding max of length `2·attack − 1`, then a one-pole with `coef = exp(−2/attackSamples)` run forward-backward (`filtfilt`), so zero phase.
  - Hold: one-sided sliding max, then a 1st-order Butterworth LP at 7 Hz.
  - Release: 1st-order Butterworth LP at `800 / release_ms` Hz = 0.267 Hz for 3000 ms.
  - Output threshold `(2^15 − 61)/2^15` = **−0.016 dBFS sample-peak**. It is not true-peak and **not streaming-safe** (see Spotify below).
- **Spotify** (artist support page, undated) [STD]:
  - Target −14 LUFS integrated.
  - Keep true peak below −1 dBTP; below −2 dBTP if the master is louder than −14 LUFS.
  - "Loud" mode is −11 LUFS, and its limiter engages at −1 dB (sample values) with 5 ms attack and 100 ms decay.

### 4.3 Recommended limiter for this app [ENG]

- **Detector:** stereo-linked; 4× polyphase interpolation (a longer, better filter than the BS.1770 one) or 8×. Compensate the FIR group delay: shift the detector by round(delay) samples and extend the hold by +2 samples to absorb sub-sample misalignment.
- **Gain** is applied at the base rate. A smooth gain is effectively bandlimited, so output inter-sample peaks ≈ gain × input inter-sample peaks.
- **Parameters:**
  - Attack/smoothing L = 1.5–5 ms (2–3 cascaded boxes).
  - Hold = L + 2–10 ms.
  - Release 50–200 ms, with exponential slew in the dB domain for constant dB/s recovery, or Signalsmith's linear slew.
  - Optional program-dependent release (section 6.5).
- **Ceiling:** target −1.0 dBTP. Use an internal ceiling of −1.2 to −1.3 dBTP with 4× detection, or −1.05 dBTP with 8×.

### 4.4 Offline closed-loop verification [ENG]

Offline processing allows a final check that real-time limiters cannot do:
1. Render.
2. Measure the true peak (BS.1770 4×, plus an 8× check).
3. If TP > target, lower the internal ceiling by the excess + 0.05 dB and re-render the limiter stage only. Two or three iterations are usually enough.
4. Re-measure LUFS last, because the limiter changes loudness.

### 4.5 Soft clippers (memoryless) [ENG unless noted]

Place before the limiter, at 4×–8× oversampling, driven 0.5–2 dB. This takes the fast transient peaks so the limiter works less.

- **tanh** with unity slope and ceiling c: `y = c·tanh(x/c)`.
- **Cubic, unity slope, ceiling 1:** `y = x − (4/27)·x³` for |x| ≤ 1.5, `y = sign(x)` otherwise. It is C¹-continuous at ±1.5 [VERIFIED]: y(1.5) = 1, y′(1.5) = 0. It starts saturating gently; y(1) = 0.852.
- **Knee clipper** (linear below threshold T, C¹ at T, asymptote c):
  `|y| = |x|` if |x| ≤ T, else `T + (c − T)·tanh((|x| − T)/(c − T))`, keeping the sign of x. Typical T = c·10^(−3/20).
- **Aliasing control:**
  - Either oversample (4× gives most of the benefit for gentle curves),
  - or use first-order **ADAA** (Parker et al. DAFx-16; Bilbao/Esqueda/Parker/Välimäki, IEEE SPL 24(7), 2017) [STD]: `y[n] = (F1(x[n]) − F1(x[n−1])) / (x[n] − x[n−1])`. If `|x[n] − x[n−1]| < 1e-5`, use `y = f((x[n] + x[n−1])/2)`.
    - Hard clip: F1 = x²/2 for |x| ≤ 1, else `x·sign(x) − 1/2`.
    - tanh: F1 = ln cosh x. Compute it stably as `|x| + Math.log1p(Math.exp(-2*|x|)) − Math.LN2`.
    - ADAA-1 adds about a ½-sample delay. Compensate it in any parallel/dry path. [UNCERTAIN: stated from theory, not from a fetched source]

### 4.6 Oversampling filter design (Kaiser window; Oppenheim & Schafer, also in SciPy) [STD]

- `β = 0.1102·(A − 8.7)` for A > 50 dB; `0.5842·(A − 21)^0.4 + 0.07886·(A − 21)` for 21 ≤ A ≤ 50; 0 below 21. Check: SciPy `kaiser_beta(65)` = 6.20426.
- `taps ≈ (A − 7.95) / (14.36·Δf/fs_out) + 1`.
- Example for 4× from 44.1 kHz, passband 20 kHz, first image at 24.1 kHz (Δf = 4.1 kHz at fs_out = 176.4 kHz), A = 90 dB: β ≈ 8.96, ≈ 247 taps (≈ 62 taps per phase). Use the same design for decimation after a clipper.

---

## 5. Linkwitz-Riley 4th-order crossovers with flat sum [STD] [VERIFIED]

- **LR4 = two cascaded 2nd-order Butterworth sections** at the same fc: RBJ LPF/HPF with Q = 1/√2, applied twice.
  - Use cascaded biquads (float64), not the direct 4th-order form. musicdsp #266 gives the direct-form coefficients and itself warns about instability under fast low-frequency automation.
  - LR4 outputs are in phase at fc, at −6 dB each. No polarity inversion is needed. LR2 needs one band inverted.
- **Identity:** `LP4(f) + HP4(f) = AP2(f)`. AP2 is the RBJ allpass at the same f with Q = 1/√2. Analog proof: (1 + s⁴)/(s² + √2 s + 1)² = (s² − √2 s + 1)/(s² + √2 s + 1). [VERIFIED] With RBJ biquads at 44.1 kHz the identity holds to 5·10⁻¹³.
- **3 bands (f1 < f2)** — the low band needs AP2(f2):
  - `low = LP4(f1)·AP2(f2)`, `mid = HP4(f1)·LP4(f2)`, `high = HP4(f1)·HP4(f2)`.
  - Sum = AP2(f1)·AP2(f2), which has flat magnitude.
  - [VERIFIED] Without the allpass, crossovers at 200/600 Hz dip −1.42 dB. With it the sum is flat to 6·10⁻¹² dB. At 200 Hz/3 kHz the uncompensated dip is only −0.04 dB, but phase errors still appear as soon as bands get different gains.
- **4 bands, balanced tree** (f1 < f2 < f3):
  - Split at f2.
  - Low branch: split at f1, then apply AP2(f3) to both of its outputs.
  - High branch: split at f3, then apply AP2(f1) to both of its outputs.
  - [VERIFIED] Flat to < 10⁻⁴ dB.
- **Cascade alternative (4 bands):**
  - `b1 = LP(f1)AP(f2)AP(f3)`
  - `b2 = HP(f1)LP(f2)AP(f3)`
  - `b3 = HP(f1)HP(f2)LP(f3)`
  - `b4 = HP(f1)HP(f2)HP(f3)`
- **Offline zero-phase option (null-able).** Digital Butterworth LP and HP at the same fc are power-complementary: `|B_lp|² + |B_hp|² = 1`. [VERIFIED to 5·10⁻¹³] So forward-backward filtering (filtfilt) with a 2nd-order Butterworth gives zero-phase bands with LR4-like magnitude that **sum exactly to the input**. Trade-off: symmetric pre-ringing, and edge padding is needed. [ENG]

---

## 6. Feed-forward compressor

### 6.1 Topology (Giannoulis, Massberg, Reiss, JAES 60(6) 2012) [STD]

The paper recommends feed-forward with a **log-domain detector placed after the gain computer**: smooth envelope, no attack lag, variable knee width. Steps:
- Level `x_dB = 20 log10(|x|)` (peak), or `10 log10(ms)` (RMS).
- Gain computer → `x_sc`.
- Gain change `g_c = x_sc − x_dB` (≤ 0).
- Smooth → `g_s`.
- Add make-up `M`.
- Apply `10^(g/20)`.

### 6.2 Gain computer with soft knee (threshold T, ratio R, knee width W, all in dB) [STD] (MathWorks `compressor`, citing Giannoulis 2012)

```js
function gainComputer(xdB, T, R, W) {
  const d = xdB - T;
  if (W > 0 && 2 * Math.abs(d) <= W) return xdB + (1 / R - 1) * (d + W / 2) ** 2 / (2 * W);
  return d <= 0 ? xdB : T + d / R;
}
```

### 6.3 Smoothing (branching, in the gain domain) [STD]

```js
// MathWorks: aA = exp(-Math.log(9)/(fs*tA)), aR = exp(-Math.log(9)/(fs*tR))   (10-90 % times)
// Giannoulis: aA = exp(-1/(fs*tA)), aR = exp(-1/(fs*tR))                       (63 % times)
gs = (gc <= gs) ? aA * gs + (1 - aA) * gc   // attack: more reduction
                : aR * gs + (1 - aR) * gc;  // release
```

[UNCERTAIN] Giannoulis' "smooth decoupled peak detector" is quoted here from the paper as remembered; the PDF could not be retrieved in this session. It operates on y_L = positive gain reduction in dB:
- `y1[n] = max(x_L[n], aR·y1[n−1] + (1−aR)·x_L[n])`
- `y_L[n] = aA·y_L[n−1] + (1−aA)·y1[n]`

Its advantage over branching: release is independent of attack and there are no level-dependent artifacts.

### 6.4 Detection, linking, make-up

- **Peak vs RMS** [ENG]: `ms[n] = a·ms[n−1] + (1−a)·x²[n]`, with an RMS window of 5–50 ms for bus/glue mastering. Peak detection is for limiting/fast control.
- **Stereo link** [ENG]: use `max(|L|, |R|)` (peak link) or `(L² + R²)/2` (power link) as the detector input, and apply **one** gain to both channels. This avoids image shift. In M/S mode, M and S get separate detectors and gains.
- **Sidechain HPF** [ENG]: 2nd-order Butterworth at 60–150 Hz on the detector only. It reduces bass-driven pumping.
- **Auto make-up** (MathWorks) [STD]: `M = −x_sc(0 dB)`, so a steady 0 dBFS input gives 0 dB output. For mastering, prefer **M = 0** and let the final loudness-normalization and limiter stage set the level. [ENG]
- **Typical gentle mastering glue** [ENG]: ratio 1.5–2:1, knee 6–10 dB, attack 10–30 ms, release 100–300 ms or auto, 1–3 dB gain reduction.

### 6.5 Program-dependent ("auto") release [ENG] [UNCERTAIN: no primary algorithm retrieved]

A simple, robust dual-envelope design:
- GR_fast: attack τ_a, release τ_f ≈ 40–100 ms.
- GR_slow: one-pole on GR_fast, τ_s ≈ 0.5–2 s, both directions.
- Applied reduction: `GR = max(GR_fast, GR_slow)` (positive dB).

Isolated transients recover fast, because GR_slow stays small. Sustained compression recovers slowly, which avoids pumping.

Alternative: crest-factor-driven time constants (Giannoulis, Massberg, Reiss, "Parameter Automation in a Dynamic Range Compressor", JAES 61(10) 2013). The formula was not verified here (paywalled).

---

## 7. Dynamic EQ and split-band de-esser (cheap forms) [VERIFIED]

- **Exact identity:** `Peaking(f0, Q, A) ≡ 1 + (A² − 1)·BP0(f0, Q·A)`, where BP0 is the RBJ "constant 0 dB peak gain" band-pass and A = 10^(dB/40). Verified to 4·10⁻¹⁶.
- **Cheapest dynamic EQ:** keep a *fixed* BP0(f0, Q) and vary only a scalar gain per sample: `y = x + (g[n] − 1)·bp[n]`, where `bp = BP0(x)`. No per-sample coefficient recomputation.
  - The gain at f0 is exactly g (verified: g = −6 dB gives exactly −6.000 dB at f0).
  - The effective bandwidth narrows slightly as the cut deepens (equivalent peaking Q = Q_bp/A).
  - The same `bp` signal feeds the detector.
- **Split-band de-esser, 1st-order (clean):** `y = x − (1 − g)·HP1(x)`. Since `1 − HP1 ≡ LP1` exactly for bilinear 1st order (verified 4.5·10⁻¹⁶), this is a perfect-reconstruction dynamic high shelf. At g = 1 it is transparent.
- **Higher-order splits:** with 2nd-order HP, `x − HP2` is *not* a clean low-pass (it has a bump near fc). Use the LR4 split from section 5 instead: `y = LP4 + g·HP4`, which at g = 1 is the allpass AP2.
- **Detector** [ENG]: envelope of `bp` (or of the HP band). For robustness across levels, use a **relative** threshold: band energy minus broadband energy in dB, e.g. trigger when sibilance band > broadband − 6…−10 dB.
  - Sibilance band 5–9 kHz, Q ≈ 1.5–3.
  - Attack 0.5–2 ms, release 30–80 ms.
  - Offline, apply zero-phase lookahead of 1–3 ms to the envelope.
  - Max reduction 3–8 dB.
- **Web Audio note:** BiquadFilterNode cannot do this per sample in JS, so do it in plain JS offline.

---

## 8. STFT spectral processing (denoise, de-ringing, "de-shimmer")

### 8.1 Frame, hop, COLA [VERIFIED]

- N = 2048 at 44.1/48 kHz (≈ 43–46 ms, Δf ≈ 21.5–23.4 Hz), hop H = N/4 = 512. Use N = 1024 for better transient handling at high frequencies.
- Periodic Hann, `w[n] = 0.5 − 0.5 cos(2πn/N)`:
  - Hann analysis only at H = N/2: Σw = 1.0.
  - Hann analysis and synthesis (WOLA) at H = N/4: Σw² = **1.5**. Divide the output by 1.5.
  - √Hann analysis and synthesis at H = N/2: the product sums to 1.
- Driedger et al. use a sine window with H = N/4. The sine window is √Hann.
- Process spectral gains as **real, non-negative masks**. Keep the original phase.

### 8.2 Spectral gating (reference: `noisereduce` 3.0.3, 2024-10-06) [STD]

- Defaults: n_fft 1024, win = n_fft, hop = win/4, `n_std_thresh_stationary` 1.5, `prop_decrease` 1.0, `freq_mask_smooth_hz` 500, `time_mask_smooth_ms` 50, non-stationary `time_constant_s` 2.0, `thresh_n_mult` 1, `sigmoid_slope` 10.
- Stationary mode: per-frequency mean + n_std·std of the noise-clip spectrum in dB is the threshold; build a mask; smooth it in frequency and time; apply.

### 8.3 Musical-noise avoidance [STD + ENG]

- Prefer Wiener/MMSE soft gains over binary masks: `G = ξ/(1 + ξ)`.
- Estimate a-priori SNR ξ with Ephraim–Malah **decision-directed** smoothing: `ξ = α·G_prev²·|X_prev|²/λ + (1 − α)·max(γ − 1, 0)`, with γ = |X|²/λ and **α = 0.98** (conventional value). Cappé (1994) shows this suppresses musical noise.
- **Gain floor** G_min = 0.1–0.3 (−20…−10 dB). For music mastering use −6…−12 dB. Never gate fully. [ENG]
- **Temporal smoothing per bin**, asymmetric: open fast (τ ≈ 5–10 ms), close slow (τ ≈ 50–150 ms). In frames, `a = exp(−H/(τ·fs))`. [ENG]
- **Frequency smoothing:** triangular kernel of about 1/6 octave, or ±2–3 bins at low frequency. [ENG]

### 8.4 Telling narrowband flickering peaks from broadband/stable content [ENG unless noted]

Per bin k and frame t, with L = 20·log10|X|:
1. **Peak salience:** `P = L[t,k] − median_{|j|≤w} L[t,k+j]`, with w ≈ ±1/6 octave (≥ 3 bins). A narrowband peak has P > 6 dB.
2. **Temporal instability ("flicker"):** std of L[·,k], or mean |ΔL| over the last 6–12 frames (≈ 70–140 ms at H = 512 / 44.1 kHz). Flicker > 3–4 dB. Stable partials < 1–2 dB.
3. **Phase stability:** second difference `d²φ = princarg(φ[t] − 2φ[t−1] + φ[t−2])`. It is ≈ 0 for stable sinusoids and uniformly random for noise or flicker. This is the phase-deviation idea from onset detection (Bello et al. 2005; not fetched).
4. **Harmonic/percussive/residual (HPR) split** (Driedger, Müller, Disch, ISMIR 2014) [STD]:
   - Median filters of 200 ms along time (harmonic enhancement) and 500 Hz along frequency (percussive enhancement).
   - Masks: `M_h = Ỹ_h/(Ỹ_p + ε) > β`, `M_p = Ỹ_p/(Ỹ_h + ε) ≥ β`, residual = 1 − M_h − M_p.
   - β ≥ 1; the paper's tuned values are β_h = 3 and β_p = 2.5.
   - The residual holds the noise-like content that is "neither harmonic nor percussive". This is where codec/generation shimmer tends to sit.
5. **De-shimmer recipe** [ENG]:
   - Above f_c ≈ 5–8 kHz, compute a soft artifact score from (P > 6 dB) ∧ (flicker > 3 dB) ∧ (|d²φ| large) ∧ (in the residual).
   - Attenuate with `G = max(G_min, 1 − λ·score)`, λ ≈ 0.5, G_min ≈ −9 dB.
   - Smooth the mask as in 8.3.
   - Offer a "residual duck" of a few dB above f_c as a simpler alternative.
6. **Static periodic peaks from neural upsampling** (Afchar et al., "A Fourier Explanation of AI-music Artifacts", arXiv 2506.19108, June 2025, ISMIR 2025):
   - Transposed-convolution upsamplers produce small, **regularly spaced spectral peaks** at multiples of each layer's input rate, giving a "fractal" pattern. Example: EnCodec strides {8, 5, 4, 2} give 161 peaks.
   - Peaks were detected in Suno v2/v3/v3.5 and Udio outputs at ≈ 99.9–100 % accuracy.
   - Detection method: long-term average spectrum, subtract a sliding local minimum, look for peaks.
   - [UNCERTAIN] **No Hz values are published for Suno, and removal/notching was not tested.** Notching is therefore experimental. Detect peaks on a long-term average and, at most, apply narrow, shallow static notches (≤ 3–6 dB).

---

## 9. Match EQ (reference matching)

### 9.1 Matchering (sergree/matchering, GPLv3, master branch, copyright 2016–2022) [STD]

- Internal rate 44.1 kHz. Max length 15 min. Analysis on **mid and side** separately.
- **Pieces:** `divisions = int(len / (15 s)) + 1`. Keep pieces with RMS ≥ RMS-of-piece-RMSs ("loudest pieces"). Match RMS: `coef = refMatchRMS / targetMatchRMS`.
- **Average spectrum:** `scipy.signal.stft` with **boxcar** window, `nperseg = 4096`, `noverlap = 0`. Take the mean of |X| over frames and channels.
- **Correction:** `ref / max(1e-6, target)`.
- **Smoothing:**
  - Interpolate (cubic) onto a log grid of `2048·4 + 1` points from 4/4096 to 1 (normalized).
  - LOWESS with `frac = 0.0375`, `it = 0`, `delta = 0.001`.
  - Interpolate back to linear. Set bin 0 to 0; bin 1 = raw ratio.
- **FIR:** `fir = hann(4096) · ifftshift(irfft(ratio))`. That is a **4096-tap linear-phase** filter with 2048-sample latency, compensated with `fftconvolve(..., "same")`. Applied to M and S separately.
- **Then:** 4 RMS-correction iterations (with clipping), the Hyrax limiter, and normalization to −0.016 dBFS sample peak.
- **No limit on the correction magnitude.** [Observation] With Suno MP3/M4A sources that roll off at about 16 kHz, an unclamped ratio boosts the top octave heavily and amplifies artifacts.

### 9.2 Recommended implementation for this app [ENG]

1. Spectra: average **power** (|X|²) with Hann, N = 8192 at 44.1/48 kHz, 50–75 % overlap. Use only frames above the integrated-loudness relative gate (reuse the BS.1770 blocks) so silence and fades are excluded. Do this for M and S, or M only plus a separate width match.
2. Loudness-normalize both spectra (equal LUFS) **before** the ratio, so the match EQ is purely tonal.
3. **Fractional-octave smoothing** (Hatziantoniou & Mourjopoulos, JAES 48(4) 2000): for bin k at frequency f, average power over `[f·2^(−1/(2b)), f·2^(+1/(2b))]` with b = 3 (1/3 oct, broad tonal balance) or b = 6 (finer). Smooth the ratio in dB *after* smoothing both spectra.
4. **Limits:**
   - Clamp the correction to ±6 dB (±3 dB in "gentle" mode).
   - Fade the correction to 0 dB below 30–40 Hz and above 14–16 kHz, or wherever the target spectrum is more than 30 dB below its 1–4 kHz average (codec cutoff detection).
   - Apply an "amount" of 0–100 % (default 50–70 %).
5. **FIR design:**
   - **Linear phase** (Matchering): no phase distortion. Pre-ringing is negligible for 1/3-octave-smoothed corrections, but can be audible for steep LF corrections.
   - **Minimum phase** by the homomorphic (real-cepstrum) method:
     1. `c = IFFT(log|H|)` on an FFT ≥ 4–8× the filter length (SciPy notes `n_fft` must be "a few times larger" than the signal);
     2. fold: `c_min[0] = c[0]`, `c_min[n] = 2c[n]` for 0 < n < N/2, `c_min[N/2] = c[N/2]`, 0 otherwise;
     3. `H_min = exp(FFT(c_min))`;
     4. `h_min = IFFT(H_min)`, truncated with a half-window.
   - Caveat: SciPy's `minimum_phase(h)` with default `half=True` returns √ of the input magnitude. Use `half=False`, or design from |H| directly as above.
   - Length: 4096–8192 taps at 44.1/48 kHz gives ≈ 5–11 Hz resolution, which is enough for 1/3-octave smoothing down to about 30 Hz. Apply by FFT overlap-add (partitioned convolution not needed offline).

---

## 10. TPDF dither and noise shaping (16-bit)

- **TPDF** [STD, SoX]: the sum of two independent uniform values of ±0.5 LSB, i.e. `d = (r1 + r2 − 1)` LSB with r ∈ [0, 1). Triangular pdf, ±1 LSB peak, variance LSB²/6. Total noise (quantization + dither) is 3 × LSB²/12, i.e. +4.77 dB over undithered. A 16-bit flat-TPDF floor is ≈ 93.3 dB below a full-scale sine.
- **Quantize:** `q = round(v·32768 + d)`, clamped to [−32768, 32767].
- **Error feedback (SoX sign convention)** [STD]:
  - `v = x − Σ_k c_k·e[n−1−k]`
  - `q = Q(v + dither)`
  - `e[n] = q − v`. The stored error *includes* the dither.
  - Noise transfer function: **NTF(z) = 1 − Σ c_k z^(−k−1)**.
- **Coefficient sets** (SoX `dither.c`; sample-rate specific):
  - `lip44` (Lipshitz, 44.1 kHz): `[2.033, −2.165, 1.959, −1.590, 0.6149]`.
    [VERIFIED] NTF −16.6 dB at DC, −27 dB at 4 kHz, +19.4 dB at Nyquist. Total noise power +12.2 dB, placed where hearing is least sensitive.
  - `fwe44` (F-weighted, labelled 46 kHz): `[2.412, −3.370, 3.937, −4.174, 3.353, −2.205, 1.281, −0.569, 0.0847]`.
    [VERIFIED] −25 dB at 3 kHz, +27 dB at Nyquist.
  - Simple and safe: `c = [1]`, giving NTF = 1 − z⁻¹ (+6 dB/oct, total +3 dB, −16.9 dB at 1 kHz @ 44.1 kHz). Or `c = [2, −1]`, giving (1 − z⁻¹)².
- **JS sketch:**

```js
function toInt16(x, c /* [] = flat TPDF */, rand /* seeded () => [0,1) */) {
  const out = new Int16Array(x.length), N = c.length, e = new Float64Array(Math.max(1, N));
  let pos = 0;
  for (let n = 0; n < x.length; n++) {
    let v = x[n] * 32768;
    for (let k = 0; k < N; k++) v -= c[k] * e[(pos + k) % N];   // e[(pos+k)%N] = e[n-1-k]
    let q = Math.round(v + rand() + rand() - 1);
    q = q > 32767 ? 32767 : q < -32768 ? -32768 : q;
    if (N) { pos = (pos + N - 1) % N; e[pos] = Math.max(-4, Math.min(4, q - v)); } // clamp: [ENG] stability after clipping
    out[n] = q;
  }
  return out;
}
```

- **Policy** [ENG]:
  - Dither is the *very last* step, and only when reducing word length.
  - Deliver 24-bit WAV to distributors when possible. Dither at 24-bit is optional and harmless.
  - Use shaped dither only at the rate its coefficients were designed for (44.1 kHz). Otherwise use flat TPDF.
  - Never process after shaped dither: no SRC, no gain.

---

## 11. RBJ Audio EQ Cookbook biquads (W3C Working Group Note, 2021-06-08) [STD]

- `A = 10^(dBgain/40)`, `w0 = 2π f0/Fs`.
- `α = sin(w0)/(2Q)`, or `sin(w0)·sinh(ln2/2 · BW · w0/sin(w0))` for bandwidth BW in octaves, or for shelves `α = sin(w0)/2 · √((A + 1/A)(1/S − 1) + 2)`. Equivalently `1/Q = √((A + 1/A)(1/S − 1) + 2)`. S = 1 is the steepest slope that is still monotonic.
- Coefficients, before dividing all by a0:

| Type | b0 | b1 | b2 | a0 | a1 | a2 |
|---|---|---|---|---|---|---|
| LPF | (1−cos)/2 | 1−cos | (1−cos)/2 | 1+α | −2cos | 1−α |
| HPF | (1+cos)/2 | −(1+cos) | (1+cos)/2 | 1+α | −2cos | 1−α |
| BPF (0 dB peak) | α | 0 | −α | 1+α | −2cos | 1−α |
| Notch | 1 | −2cos | 1 | 1+α | −2cos | 1−α |
| APF | 1−α | −2cos | 1+α | 1+α | −2cos | 1−α |
| Peaking | 1+αA | −2cos | 1−αA | 1+α/A | −2cos | 1−α/A |
| Low shelf | A[(A+1)−(A−1)cos+2√Aα] | 2A[(A−1)−(A+1)cos] | A[(A+1)−(A−1)cos−2√Aα] | (A+1)+(A−1)cos+2√Aα | −2[(A−1)+(A+1)cos] | (A+1)+(A−1)cos−2√Aα |
| High shelf | A[(A+1)+(A−1)cos+2√Aα] | −2A[(A−1)+(A+1)cos] | A[(A+1)+(A−1)cos−2√Aα] | (A+1)−(A−1)cos+2√Aα | 2[(A−1)−(A+1)cos] | (A+1)−(A−1)cos−2√Aα |

(cos = cos w0.) The Cookbook's peaking EQ is defined so that +N dB followed by −N dB at the same Q and f0 is exactly flat.

**Structures and stability:**
- **TDF-II in float64:** `y = b0x + s1; s1 = b1x − a1y + s2; s2 = b2x − a2y`. Best for static filters in JS.
- **DF-I** (states are past x/y) behaves better if coefficients change between blocks.
- For per-sample modulation or very low f0, use the **Cytomic/Simper trapezoidal SVF** [STD]:
  - `g = tan(π fc/fs)`, `k = 1/Q`, `a1 = 1/(1 + g(g + k))`, `a2 = g·a1`, `a3 = g·a2`.
  - Tick: `v3 = v0 − ic2; v1 = a1·ic1 + a2·v3; v2 = ic2 + a2·ic1 + a3·v3; ic1 = 2v1 − ic1; ic2 = 2v2 − ic2`.
  - Output `m0·v0 + m1·v1 + m2·v2`:
    - LP (0, 0, 1); BP (0, 1, 0); HP (1, −k, −1); notch (1, −k, 0); AP (1, −2k, 0).
    - Bell: k = 1/(Q·A), (1, k(A² − 1), 0).
    - Low shelf: g /= √A, (1, k(A − 1), A² − 1).
    - High shelf: g ·= √A, (A², k(1 − A)A, 1 − A²).
  - [VERIFIED] Bell, low shelf and high shelf match the RBJ responses to 0.001 dB at all test frequencies.

**Web Audio differences** (Web Audio API 1.1 WD, 2026-09-22) [STD]:
- BiquadFilterNode **lowpass/highpass interpret Q in dB**: `α = sin w0/(2·10^(Q/20))`. Butterworth is Q = −3.0103 dB, not 0.7071.
- Shelves use fixed S = 1.
- DynamicsCompressorNode has a fixed 6 ms pre-delay, and knee/envelope/detector shapes are *implementation-defined*. **Do not use it for deterministic mastering.** Use Web Audio only for decoding, preview playback and, optionally, OfflineAudioContext resampling.

---

## 12. M/S width, mono bass, correlation

- **Encode/decode:** `M = (L + R)/2`, `S = (L − R)/2`; `L = M + S`, `R = M − S`.
- **Width:** `S' = w·S`. w = 0 is mono, 1 is unchanged, > 1 is wider. Use w ≤ 1.2–1.3 for masters. [ENG]
- **Frequency-dependent width:** split S with LR4 and apply w only above about 300 Hz–1 kHz. [ENG]
- **Mono bass:** high-pass **S only** at f_mono = 80–150 Hz (2nd/4th-order Butterworth, or LR4 with the low part discarded). M is untouched, so the mono sum and the bass phase are unchanged. Offline, a linear-phase FIR on S avoids phase shift in S. [ENG]
- **Correlation:** `r = Σ L·R / √(Σ L²·Σ R²)` over a sliding window (exponential τ ≈ 100–300 ms) [ENG]. r = +1 is mono-compatible, 0 is uncorrelated, < 0 means phase problems.
  - Report a global r and per-band r. A low band (< 150 Hz) with r < 0.9 is a warning sign.
  - Report the side/mid ratio `10·log10(ΣS²/ΣM²)` dB as a width metric.

---

## 13. Suggested offline chain order (decision aid) [ENG]

1. Decode to float32 (mono → dual mono). Keep the native rate.
2. DC/subsonic: 2nd-order Butterworth HPF 20–30 Hz.
3. **Analyze:** LUFS-I/S/M, LRA, true peak, 1/3-octave long-term spectrum, correlation, codec-cutoff frequency, artifact score.
4. **Repair** (optional): STFT de-shimmer/denoise (section 8).
5. **Tone:** static RBJ EQ, plus optional clamped match EQ (section 9).
6. **Dynamics:** de-esser/dynamic EQ (7) → gentle 3-band LR4 compressor, compensated (5, 6) → stereo bus "glue" compressor.
7. **Stereo:** width + mono bass (12).
8. **Loudness:** gain toward the target → oversampled soft clip of 0–2 dB (4.5) → true-peak limiter at −1 dBTP (4.3).
9. **Verify and iterate** (4.4). Final LUFS/TP report.
10. Dither if exporting 16-bit (10).

---

## 14. Open points, conflicts, uncertainty (summary)

- **True-peak FIR signs:** minus signs were lost in PDF text extraction of BS.1770-5. The signs used here were checked by frequency response (a proper low-pass) and by EBU 3341 test tones (all pass).
- **LRA hop:** libebur128 uses 1 s; EBU Tech 3342 V3/V4 requires ≥ 10 Hz. Follow EBU.
- **pyloudnorm default filter** is about 0.04 dB off. Its "DeMan" class is exact.
- **Giannoulis decoupled detector** equations are from memory; the paper PDF was not retrieved (TLS/paywall). The soft-knee and branching equations were cross-checked with MathWorks.
- **Auto-release** algorithms in commercial units are not public. Section 6.5 is a proposal.
- **Suno-specific artifacts:** the only rigorous source (Afchar et al. 2025) shows periodic spectral peaks but gives no Hz values and no removal method. All de-shimmer constants are proposals and need listening tests.
- **ADAA half-sample delay** is stated from theory, not from a fetched source.
- **Signalsmith BoxStackFilter** ratio table: only the 1- and 2-layer values were retrieved.

---

## Sources

- ITU-R BS.1770-5 (11/2023), *Algorithms to measure audio programme loudness and true-peak audio level* — https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf
- EBU Tech 3341 V4 (Nov 2023), *Loudness Metering: "EBU Mode"* — https://tech.ebu.ch/docs/tech/tech3341.pdf
- EBU Tech 3342 V4 (Nov 2023), *Loudness Range* — https://tech.ebu.ch/docs/tech/tech3342.pdf
- libebur128, `ebur128/ebur128.c` (master, fetched 2026-10-26) — https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c
- pyloudnorm, `meter.py` and `iirfilter.py` (master, fetched 2026-10-26) — https://github.com/csteinmetz1/pyloudnorm
- Brecht De Man, loudness.py (cited by pyloudnorm; not fetched) — https://github.com/BrechtDeMan/loudness.py
- W3C, *Audio EQ Cookbook* (WG Note, 2021-06-08; R. Bristow-Johnson, ed. R. Toy) — https://www.w3.org/TR/audio-eq-cookbook/
- W3C, *Web Audio API 1.1* (WD, 2026-09-22) — https://www.w3.org/TR/webaudio/
- G. Luff, *Designing a straightforward limiter*, Signalsmith Audio (2022-04-08) — https://signalsmith-audio.co.uk/writing/2022/limiter/
- Signalsmith DSP library, `envelopes.h` (main) — https://github.com/Signalsmith-Audio/dsp/blob/main/envelopes.h
- F. Adriaensen / R. Gareus, x42 dpl.lv2 `peaklim.cc` (GPLv3, ©2010–2021) — https://github.com/x42/dpl.lv2/blob/master/src/peaklim.cc
- Matchering (sergree, GPLv3): `defaults.py`, `stages.py`, `stage_helpers/match_frequencies.py`, `stage_helpers/match_levels.py`, `limiter/hyrax.py` — https://github.com/sergree/matchering
- MathWorks, `compressor` System object, Algorithms section (cites Giannoulis 2012) — https://www.mathworks.com/help/audio/ref/compressor.html
- D. Giannoulis, M. Massberg, J. D. Reiss, *Digital Dynamic Range Compressor Design — A Tutorial and Analysis*, JAES 60(6):399–408, 2012 — https://aes2.org/publications/elibrary-page/?id=16354
- D. Giannoulis, M. Massberg, J. D. Reiss, *Parameter Automation in a Dynamic Range Compressor*, JAES 61(10):716–726, 2013 — https://aes2.org/publications/elibrary-page/?id=16965
- musicdsp.org #266, *4th order Linkwitz-Riley filters* — https://www.musicdsp.org/en/latest/Filters/266-4th-order-linkwitz-riley-filters.html
- A. Simper (Cytomic), *SvfLinearTrapOptimised2* (2013, upd. 2016) — https://cytomic.com/files/dsp/SvfLinearTrapOptimised2.pdf
- SoX `src/dither.c` and `src/dither.h` (mirror) — https://github.com/chirlu/sox/tree/master/src
- noisereduce 3.0.3 (2024-10-06) — https://pypi.org/project/noisereduce/
- J. Driedger, M. Müller, S. Disch, *Extending Harmonic-Percussive Separation of Audio Signals*, ISMIR 2014 — https://audiolabs-erlangen.com/resources/2014-ISMIR-ExtHPSep/2014_DriedgerMuellerDisch_ExtensionsHPSeparation_ISMIR.pdf
- Afchar et al., *A Fourier Explanation of AI-music Artifacts*, arXiv 2506.19108 (June 2025), ISMIR 2025 — https://arxiv.org/html/2506.19108v1 · https://ismir2025program.ismir.net/poster_229.html
- O. Cappé, *Elimination of the musical noise phenomenon with the Ephraim and Malah noise suppressor*, IEEE TSAP 1994 (self-archive) — https://www.di.ens.fr/olivier.cappe/Publications/Self-archive/ephma94.pdf
- J. Chowdhury, ADAA notebook (first-order ADAA, TOL 1e-5 fallback) — https://ccrma.stanford.edu/~jatin/Notebooks/adaa.html
- S. Bilbao, F. Esqueda, J. Parker, V. Välimäki, *Antiderivative Antialiasing for Memoryless Nonlinearities*, IEEE SPL 24(7), 2017 — https://aaltodoc.aalto.fi/items/a46ae786-3014-4c49-a409-957b4c330bcd
- SciPy 1.18 `signal.minimum_phase` — https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.minimum_phase.html ; `signal.kaiser_beta` — https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.kaiser_beta.html
- P. Hatziantoniou, J. Mourjopoulos, *Generalized Fractional-Octave Smoothing of Audio and Acoustic Responses*, JAES 48(4):259–280, 2000 — https://aes2.org/publications/elibrary-page/?id=12070
- Spotify for Artists, *Loudness normalization* (undated, fetched 2026-10-26) — https://support.spotify.com/us/artists/article/loudness-normalization/

Numerical verification for this document (researcher-run, float64 Python) covered: K-weighting at 44.1/48/88.2/96 kHz, the true-peak FIR response and the EBU 3341 true-peak cases, LR4 sum and allpass compensation (2/3/4 bands), the peaking/band-pass identity, 1st-order complementary split, Simper SVF vs RBJ, STFT window sums, noise-shaping NTFs, the cubic clipper, and float32 coefficient error.
