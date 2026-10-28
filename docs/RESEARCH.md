# AudioMaster: research brief

This brief turns `docs/research/01`–`05` (2026-10-26) into build decisions. Names follow `docs/ARCHITECTURE.md`.

**Tags:** **[P]** primary source or standard · **[M]** third-party measurement · **[S]** secondary source · **[E]** our own default, to be calibrated on real Suno files.

**Ground rules:**
- **Measure every file.** Raw Suno WAVs (n=337) have a median of −15.3 LUFS / −3.5 dBTP, a loudness range (LRA) of about 5–6.6 LU, and are 17% near-mono [M]. Claims run from −22 to −8 LUFS.
- **Default to −14 LUFS-I with a −1.0 dBTP ceiling.** Any target louder than −14 uses −2.0 dBTP [P Spotify].
- **Gate every cleanup module behind its detector.** Each corrective move is 1–3 dB, and cuts total at most −4 dB per octave.
- **Use only our own float64 JS DSP.** `DynamicsCompressorNode` differs by browser: −1.27 dB of gain reduction in Chrome vs −7.76 dB in Firefox.

## 1. Processing chain

**Intensity** (Low / Medium / High, at t = 0.25 / 0.5 / 0.75; the slider interpolates linearly) scales the mastering moves. The separate **Cleanup** control scales the repair moves (§2).

| Parameter | Low | Medium (default) | High |
|---|---|---|---|
| Auto-EQ strength / max correction | 0.35 / ±2 dB | 0.6 / ±3 dB | 0.85 / ±4 dB |
| Multiband gain reduction on the loud sections (low band: half) | 0.5 dB | 1 dB | 2 dB (cap 3) |
| Glue ratio / gain reduction on the loud sections | 1.4:1 / 0.5 dB | 1.7:1 / 1 dB | 2:1 / 2 dB (cap 2) |
| Saturation drive (Balanced style) | 0.03 | 0.06 | 0.10 |
| Soft clip before the limiter / deepest escalated clip | 0 / 2.5 dB | 0.5 / 3 dB | 1.5 / 4 dB |
| Limiter gain-reduction budget (warn beyond it) | 3 dB | 4 dB | 6 dB |
| Loud / Club target | −11 / −9 LUFS | −10 / −8 | −9 / −7 |

**Dynamics targets are realised values, scaled by destination [E, calibrated on 7 real Suno exports].** The multiband and glue rows are the *realised* mean gain reduction (attack/release included) of the loud sections: 50 ms windows within 5 dB of the 95th-percentile level. Verses below that are left alone; they no longer drag the threshold down so that the choruses take 3–7 dB. The destination scales the rows: Hi-Fi 0, Broadcast 0.5, Streaming / Video / Social 0.6, Loud / Club 1. They are halved again when the input is already at or above the target. On a normalising platform density only costs chorus lift: the old all-window, static-curve setting lost 1.2–2.5 LU of LRA on every real track at Streaming, and Hi-Fi measured the same as Streaming. Now the measured ΔLRA (ffmpeg, input → master) is −0.1 … −0.9 LU at Streaming / Medium and −0.4 … +0.3 at Hi-Fi. A stage loses about its chorus gain reduction in LRA. Loud / Club compress more by design.

**Stages, in order** (they match `chain.js`):

0. **Analyze.** Measure:
   - Loudness: integrated, short-term and momentary LUFS, LRA, sample and true peak, peak-to-loudness ratio (PLR), crest factor, DC offset.
   - Spectrum: 1/3-octave long-term average spectrum (LTAS) of the louder parts, the top-end cutoff f_c, and band excess indices.
   - Stereo: correlation per band (<120 Hz, 120–1k, 1k–8k, >8k Hz) and the side/mid ratio.
   - Detectors: sibilance events, HF flatness, shimmer index, leading/trailing silence, abrupt ending.
1. **Prepare.** DC blocker (1-pole, ~5 Hz), then a 2nd-order Butterworth high-pass at **25 Hz**. Raise it to 30–35 Hz if energy below 30 Hz is more than 3 dB above the reference; never above 40 Hz.
2. **Trim** leading silence to 50–150 ms of pre-roll [E], but only when the leading silence itself is over 0.5 s. A long tail alone trims only the tail. Cutting the head moves the master's time 0; the render report gives the offset (`report.trim.startSec`) so the A/B player can align the original.
3. **Spectral cleanup:** de-shimmer and denoise, both gated (§2).
4. **EQ cascade.**
   - Static floors of the detected mud and boom cuts, at half their dynamic maximum.
   - Auto-EQ: corrects bumps against the track's own smoothed trend (tolerance 1.5 dB). It never boosts below 30 Hz or above f_c.
   - Optional match-EQ, then the style's tone moves (§4).
5. **Dynamic EQ:** mud, harshness and fizz cuts, de-esser, side-channel HF control (§2).
6. **Color:** saturation (2× oversampled, level-compensated), then air. Air runs only after harshness is controlled.
7. **Multiband compression.**
   - 3 bands, Linkwitz-Riley 4th-order (LR4) splits at **120 Hz / 3 kHz**, processed band by band.
   - Low band: RMS 60 ms, attack 60 ms, release 300 ms, ratio 1.6, half the target. A short low-band detector ducked each sub-heavy kick or 808 note: −1.4 to −2 dB at 31–40 Hz and +1 dB at 100 Hz. Now ΔLTAS 31–63 Hz is −0.23 … +0.35 dB at Streaming on the real set.
   - Mid band: RMS 15 ms, attack 20 ms, release 120 ms, detector high-passed at 220 Hz (4th order) so kick harmonics do not pull the vocals down.
   - High band: RMS 5 ms, attack 5 ms, release 60 ms.
   - Threshold: `calibrateThreshold`. It starts from the static estimate, then simulates the compressor's own gain smoothing and corrects until the realised loud-section GR is within 0.03 dB of the target. The static estimate alone overshot it 1.3–1.9×.
   - Each band's make-up gain restores its average level.
8. **Stereo.** Mono bass: high-pass the side channel with an LR4 filter at 100 Hz. Width stays at 1.0. Never use Haas widening or decorrelation, and never widen below 300 Hz.
9. **Glue compressor.** Stereo-linked RMS detector (10 ms), knee 6–10 dB, attack 30 ms, auto release 100–300 ms, make-up 0, calibrated threshold like stage 7. Gain reduction on the loud sections ≤ 2 dB. The sidechain high-pass is **4th order at 130 Hz**. The 2nd-order 100 Hz filter left a 55 Hz kick only 6–9 dB down, and vocals dipped ≈ 1.5 dB on every kick (measured on reggaeton).
10. **Loudness loop.** It runs at the export rate: stages 1–9 run at the source rate, and the post-glue audio is resampled here. Every destination therefore shares the caches. Gain (target − measured) → soft clip → true-peak limiter → `measure`.
    - Repeat until |LUFS − target| ≤ 0.1 LU (ship limit ±0.5) and the true peak is at or below the ceiling. At most 4 passes.
    - If the target needs more limiting than allowed, the clipper escalates (2 dB, then toward the 99th/95th/90th-percentile peaks). It never clips the highest peak deeper than the cap in the table (3 dB Medium, 4 dB High). Without the cap Loud and Club clipped drum peaks by 4.4–10 dB.
    - Beyond that, Loud and Club settle at the loudest level the limiter reaches within its budget. They never go below the range's low end (−11 for Loud, −9 for Club). The 7 real files land at −8.4 … −9 LUFS at Club / Medium. This raises `targetUnreachable`, which is worded as a normal outcome. Other destinations cap the limiter at maxGrDb and warn the same way.
    - Warn `heavyLimiting` when the limiter budget is exceeded.
11. **Finish.** 5 ms fade-in, 10–50 ms fade-out.
12. **Verify.** Run QC rollback (§2), then dither and encode.

**Auto-adjust rules [E]:**
- **Crushed input** (PLR < 8 dB and LRA < 3 LU): halve the compression and skip the clipper. Warn rather than push past the limiter budget.
- **Input already at or above the target:** no clipper, and halve the multiband / glue targets.
- **Low crest factor:** lower the glue ratio by 0.3.
- **Bright style on an already bright track:** if the 1–10 kHz slope is already above the calibrated cap (−1 dB/oct) or the track is brightened, add no extra shelf or air. Most real Suno exports measure −0.5 … +0.3 dB/oct, so on them Bright only widens.
- **Bass correlation:** below 0.7 under 120 Hz, mono bass is forced even when Cleanup is Off.
- **Near-mono input:** add +5 / 10 / 15% width above 1.5 kHz only (Low / Medium / High). Revert if global correlation falls below +0.3.

## 2. Suno cleanup stage

The **cleanup multiplier k** is Off 0, Light 0.5, Medium 1.0 (default) or Strong 1.5. It scales maximum gain changes only; the detectors choose the frequencies. With Cleanup Off, the DC filter, high-pass and fades still run.

| Module | Recipe | Gate [E] |
|---|---|---|
| Dynamic EQ (`dynamicBandCut`; relative detector, attack 10 ms, release 120 ms, ratio 2:1, threshold = median relative level + 2 dB) | **Mud:** peak in 200–500 Hz (default 300; follow it up to 800), Q 0.9, −2.5 dB × k (cap −4). **Boom:** 100–150 Hz, Q 1.4, −2 × k (cap −3). **Harsh:** peak in 2–6 kHz, Q 2, −2.5 × k (cap −4). **Fizz:** 5–8 kHz (default 6), Q 2, −2.5 × k (cap −3.5) | Band more than 1.5 dB above the reference tilt (boom: 2 dB); fizz also fires on brightened tracks, scaled by the brightened amount |
| De-esser, **mid channel only**, split-band | **A, 5–9 kHz:** threshold 6–8 dB above the band median, −4 × k (cap −6), attack 5 ms, release 60 ms, lookahead 3 ms. **B, 10–16 kHz:** −3 × k, attack 2 ms, release 50 ms | Band peaks more than 8 dB above its 1 s median, more than 4 times per minute |
| Side-channel HF control | High shelf at 8 kHz on the **side channel only**, −3 dB × k, attack 5 ms, release 150 ms | Side/mid above 8 kHz > −6 dB **and** HF envelope modulation (4–20 Hz) above the reference's 80th percentile |
| Hash shelf | 14 kHz static high shelf, −1.5 dB × k | Hash index fires **and** f_c ≥ 17 kHz |
| De-shimmer (STFT) | Works from 5 kHz, at full strength by 9 kHz. Narrow peaks more than 6 dB above the 1/6-octave envelope and flickering more than 3 dB get G = max(−9 dB, 1 − 0.5·score·k). Smoothing 20 ms attack / 80 ms release. Flicker that is co-modulated with the frame's 1–5 kHz level (gated or stabbed synths, deep tremolo) is musical and is excluded, both in the processor and in the shimmer index | Shimmer index (experimental) |
| Denoise | STFT, N=2048, hop N/4. Wiener gain with decision-directed smoothing (α 0.98), **above 6 kHz only**. Max reduction 3 / 6 / 9 dB (Light / Medium / Strong); gain floor −6 to −12 dB | Quietest 10% of frames: 10–16 kHz flatness > 0.5 and level > −70 dBFS |
| Mono bass | LR4 high-pass on the side channel at 80 / 100 / 120 Hz (Light / Medium / Strong). Use 150 Hz if the bass correlation is < 0.5; 80 Hz if the track is near-mono | Always on when Cleanup is not Off |
| Air (exciter) | Source band f_c/2–f_c, tanh 2nd/3rd harmonics, oversampled. High-pass the output at f_c − 500 Hz. Mix −30 / −24 / −19 dB, mostly in the mid channel. Optional shelf +1 dB × k at 10–12 kHz (cap +2), **never above f_c** | f_c < 16 kHz or HF more than 3 dB under the reference; **and** low hash/hiss; **and** not the Brightened profile |
| Dynamics restore (v2) | Upward expansion 1:1.15, 30 ms RMS, release 200 ms, ≤ 3 dB | Crushed input (PLR < 8, LRA < 3) |
| Ending | 2.5 s (1–6 s) equal-power fade-out, keeping a 0.5–1 s tail. Shown as an issue chip with one-click enable | Last 200 ms within 6 dB of the 3 s before it and louder than −30 dBFS |

**Profiles, detected automatically from f_c:**

| Profile | Detector | Likely origin | Emphasis |
|---|---|---|---|
| Legacy band-limited | f_c ≈ 11–13 kHz | v3/v3.5 | exciter, no 14 kHz shelf, closer hiss check |
| Mid band-limited | f_c ≈ 14.5–17 kHz | v4/v4.5 | side-channel HF control at full strength, fizz, gentle exciter |
| Full-band | f_c ≥ 18 kHz | v5/v5.5 | mud, harshness, de-ess |
| Muffled | full-band, but 6–16 kHz more than 3 dB under the reference and more energy below 120 Hz | v6 (reported) | gentle air, low-mid cut, check top-octave noise first |

**Brightened** is a continuous modifier on top of the profile, not a profile of its own. Its amount (`report.brightened`) ramps from 0 at 6 dB to 1 at 9 dB of 6–10 kHz excess over the reference. Likely origin: Suno "Remaster" (Normal/High measured at +7/+10 dB). With the amount, harshness and de-ess cuts grow (×1 → 1.4 and ×1 → 1.25), the fizz cut is forced, the exciter is reduced and then off (≥ 0.5), and the QC allows 2 dB more HF loss. Calibration: normal Suno exports read 4.1–7.6 dB, so the old on/off gate at 5 dB split near-identical tracks (4.74 vs 5.35 dB).

**QC rollback.** Re-analyze, then undo modules one by one until all of these hold:
- 8–16 kHz drop ≤ 3 dB (+2 dB × brightened amount), measured beyond the change the chosen style, the user's own settings and the reference intend. Before this baseline, Warm halved the repairs.
- correlation ≥ +0.2 overall and ≥ +0.7 below 120 Hz, with no negative band. Width is blamed only when the master is worse than the input by more than 0.1. Suno mixes often carry a negative 1–8 kHz band of their own.
- total EQ within ±4 dB per 1/3 octave. This is checked on the intended curves before rendering, so it costs no render.
- true peak at or below the ceiling and loudness within ±0.5 LU of target.

Per failing check, soften only the module that moves that metric most: halve it, then remove it. A tone key is softened alone, in its assistant part only. Never touch a value the user set (`params.meta.userOwned`) or a reference match the user chose (the match curve is clamped to ±4 dB instead). If only those are responsible, the check counts as met. The outcome is remembered for the same settings, so a later destination change does not repeat the rollback renders.

Explain every decision in plain words, for example "Harsh peak at 3.4 kHz reduced up to 2.5 dB".

**Avoid:**
- boosting before cutting, or boosting into an empty band;
- broad treble cuts;
- a static noise print for shimmer;
- heavy denoise (it causes "musical noise");
- de-reverbing the full mix;
- the exciter before harshness is controlled;
- a high-pass above 40 Hz, or any widening of the low end;
- mastering artifact-heavy audio at −8 LUFS or louder.

Generation faults (garbled vocals, late-song decay) need regeneration in Suno, so tell the user rather than process.

## 3. Destination presets

Every preset is stereo, uses the true-peak limiter, and allows ±0.5 LU. Output is WAV PCM with format tag 1 and nothing after the `data` chunk, at the native sample rate unless the table says otherwise.

| Preset | LUFS | TP (dBTP) | Export | Why |
|---|---|---|---|---|
| **Streaming** (default) | −14 | −1.0 | WAV 24-bit, native rate | Spotify guidance [P]. YouTube, Amazon and Tidal use the same −14; Apple and Deezer only turn it down |
| **Loud** | −10 (−11 to −9) | −2.0 | WAV 24 | For dense genres. Above −14 Spotify/SoundCloud require −2 dBTP [P]; Spotify turns it down 4 dB |
| **Hi-Fi / Dynamic** | −16 | −1.0 | WAV 24 | Apple Sound Check and AES77 level. May play about 2 dB quiet on Spotify; show a note |
| YouTube / Video | −14 | −1.0 | WAV 24, 48 kHz | YouTube only turns loud tracks down; Google recommends 48 kHz [P] |
| SoundCloud | −14 | −1.0 | WAV 24 | SoundCloud's help page repeats Spotify's text; whether it actually normalizes is disputed |
| Social clips | −12 | −2.0 | WAV 24, 48 kHz | No official spec; −12 is a compromise for phone speakers, and the clip will be re-encoded |
| Club / DJ | −8 (−9 to −7) | −1.0 | WAV 24, 44.1 kHz | Clubs don't normalize. Warn that artifacts become more audible |
| Broadcast | −23 | −1.0 | WAV 24, 48 kHz | EBU R 128 [P]; advanced only |

**Format override:**
- **WAV 24-bit** (default).
- **WAV 16-bit / 44.1 kHz**: high-quality resampling plus TPDF dither (CD Baby requires this).
- **MP3 320 CBR**: decode the result, re-measure its true peak, and if it is above −0.1 dBTP lower the ceiling by 0.5 dB and re-render (at most twice).

**Album mode (v2):** the loudest track hits the target; the other tracks get the same gain.

## 4. Style presets

Changes are relative to Balanced and scale with t/0.5. Warm's tilt is a pair of complementary shelves pivoting at 1 kHz.

| Style | Tone | Dynamics and color | Width |
|---|---|---|---|
| **Balanced** (default) | auto-EQ only | baseline | 1.0 |
| **Warm** | tilt −0.4 dB/oct (about −1.3 dB at 10 kHz); low shelf +0.75 dB at 90 Hz; −0.5 dB at 3 kHz | tape saturation drive +0.15; glue release 200 ms, ratio −0.2; de-ess cap 1 dB deeper | 1.0 |
| **Bright / Open** | broad high shelf +1.2 dB at 2 kHz (Q 0.4: ≈ +1 dB from 6 kHz up, ≤ 0.05 dB below 300 Hz); +0.75 dB at 3 kHz (only if harshness index ≤ 0); air +1 dB at 12 kHz (only if f_c ≥ 17 kHz, no hash, not brightened) | no saturation | +5% above 1.5 kHz |
| **Punchy** | mud −0.5 dB extra; +0.5 dB at 2.5 kHz | low band follows each kick (RMS 15 ms, attack 40 ms, release 90 ms), mid-band attack 45 ms / release 70 ms, both +0.6 dB of gain reduction; low-band ratio +0.3; glue release 100 ms | 1.0 |

Bright used a +0.3 dB/oct tilt, whose low half cut ≈ 1 dB below 100 Hz and thinned the sub. Punchy had a +1 dB low shelf, which lifted the kick's body (≈ 50 Hz) more than its attack; with its clipper +0.5 dB and a glue "attack" equal to the default, kick attack-to-body fell on 5 of 5 tracks. Now attack-to-body rises by +0.06 … +0.45 dB over Balanced on 6 of 7 real tracks (the seventh: −0.02).

## 5. Simple UX

**Main screen:**
1. **Drop the file.** Issue chips appear ("Top end limited at 15.8 kHz", "Muddy").
2. **Pick the controls:**
   - Style: 4 segments, each with a one-line hint.
   - Destination: Streaming, Loud, Hi-Fi, plus "More".
   - Intensity: Low / Medium / High.
3. **It re-renders automatically on every change,** reusing the cache. There is no "master" button.
4. **Compare before/after (A/B), level-matched by default.** The louder version is turned down by the LUFS difference. The comparison covers the full track at the same playhead, with a 20 ms crossfade. Space plays.
5. **Export.**

**Meters (before → after):**
- integrated LUFS, true peak and LRA;
- limiter gain reduction;
- spectrum, input vs output;
- a "platform preview": gain = reference − I. Spotify's boost is capped at −1 − TP; YouTube and Tidal never boost.

**Fine-tune drawer (collapsed):**
- Cleanup: Off / Light / Medium / Strong.
- Describe-the-problem buttons: *Too dull / harsh / muddy / boomy / thin*. Each click is 1.5 dB, capped at ±4.5 dB.
- Width −50 to +50%, with the bass always mono.
- Reference track with an Amount control (default 50%).
- Fade-out toggle and custom LUFS.

**Wording and notices:**
- Italian by default, English as an option. Use plain verbs ("Pulisci artefatti AI") and keep the units small.
- Never expose ratios, crossovers or oversampling.
- Notices:
  - Check your distributor's AI policy: CD Baby reportedly refuses AI music, and TuneCore is strict.
  - Songs from Suno's free plan aren't licensed for release.
- Never market the app as a watermark remover.

## 6. Browser decisions

**Decoding:**

| Input | Path | Caveat |
|---|---|---|
| WAV (PCM 16/24/32, float 32/64, EXTENSIBLE) | **Our own JS parser** | Firefox decodes 64-bit float WAV as silence without an error; Chrome rejects it |
| MP3, FLAC, M4A-AAC, Ogg | `decodeAudioData(bytes.slice(0))` on `new OfflineAudioContext(2, 1, nativeRate)` | Read the rate from the header: MP3 frame header; MP4 `mdhd` (prefer it over `esds`, which reports the base rate for HE-AAC); FLAC STREAMINFO at offset 18; Vorbis offset 12; Opus is always 48 kHz. Valid context rates are 3000–768000 Hz (Safari: up to 384000) |
| M4A **ALAC** | Decodes only in Safari | v1: ask the user to convert to WAV or FLAC. v2: WASM decoder |
| M4A **Opus** (Suno's stream, as saved by downloaders) | Feature-detect | Safari supports it only after the WebKit 307632 fix (Mar 2026); Chrome untested |

**Padding fixes:**
- **MP3 without a LAME tag:** decoders add +1105 samples (Chrome/Firefox) or +576 (Safari).
- **Apple M4A in Firefox:** Firefox ignores the `iTunSMPB` padding info and adds +2112 samples, so parse that atom and trim.

**Sample rate:**
- Process at the native rate. `decodeAudioData` resamples with weak filters (Chrome uses a 32-tap sinc, Firefox Speex quality 4). Playing a buffer at a mismatched rate falls back to linear interpolation (Firefox: Speex quality 0).
- Use our own Kaiser-windowed sinc resampler (≥32 zero crossings) only when exporting at a different rate.
- Preview plays through an `AudioContext` at the device's default rate.

**MP3:**
- Encoder: **lamejs 1.2.1**, `https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js` (exposes a global `lamejs`). The npm source entry throws "MPEGMode is not defined".
- Fallback: `https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.iife.js`.
- Input must be dithered Int16 at 32, 44.1 or 48 kHz.
- 320 kbps CBR only, because the bit reservoir is off. No LAME tag is written. Licence LGPL-3.0.

**AAC export:** phase 2, using WebCodecs plus Mediabunny. Firefox cannot encode AAC.

**WAV writer:**
- Integer PCM always uses **format tag 1** (Spotify rejects 0xFFFE).
- Float uses tag 3 plus a `fact` chunk.
- `data` is the last chunk.

**Workers:**
- Run the DSP in a **classic Blob-URL worker** (IIFE build) via `__AM_WORKER_URL__`. Module Blob workers fail in Chrome on file://.
- Use neither `OfflineAudioContext` (unavailable in workers) nor AudioWorklet (fails on file:// in Chrome and Safari).
- No SharedArrayBuffer: transferring buffers is fast enough (230 MB in 22–250 ms).
- Keep the inline fallback, yielding with `setTimeout(0)`.

**Memory:** 10 min of 48 kHz stereo is 230 MB per copy, and a naive pipeline holds 4–5 copies. Drop the file bytes after decoding, transfer buffers instead of copying, and cap input at 15 min.

**Bundling:**
- Two esbuild passes: the worker as an IIFE string, then the main bundle with `define: {__AM_WORKER_SRC__: JSON.stringify(code)}`.
- Inline the result with **function** replacers, because the code may contain `$&`.
- After the build, grep for `</script` and `<!--`.

**Sandboxed hosts:**
- A host save API may not accept .wav or .mp3; then save a STORE `.zip`. Large files can be refused.
- Verify that `blob:` workers are allowed in each host.

## 7. DSP constants

**Conventions:** filter state in float64; sample buffers in Float32. One-pole coefficient `a = exp(−1/(τ·fs))`. Treat mono input as dual-mono, or it reads −3.01 dB. Use a seeded PRNG.

**K-weighting at any sample rate** (libebur128; reproduces the BS.1770 48 kHz table exactly):
- **Stage 1 (high shelf):** f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196.
  - K = tan(π·f0/fs), Vh = 10^(G/20), Vb = Vh^0.4996667741545416, a0 = 1 + K/Q + K².
  - b = [Vh + Vb·K/Q + K², 2(K² − Vh), Vh − Vb·K/Q + K²]/a0.
  - a1 = 2(K² − 1)/a0, a2 = (1 − K/Q + K²)/a0.
- **Stage 2 (high-pass):** f0 = 38.13547087602444, Q = 0.5003270373238773.
  - Keep the numerator **[1, −2, 1] un-normalized** (normalizing shifts readings by about 0.04 dB).
- **Unit-test points at 48 kHz:** 20 Hz −13.275 dB, 100 Hz −1.133 dB, 1 kHz +0.698 dB, 10 kHz +4.042 dB.
- **Loudness:** L = −0.691 + 10·log10(Σ G_i·z_i), with G = 1 for L and R.

**Gating:**
- 400 ms blocks with a 100 ms hop (sum 100 ms sub-blocks: 4 per block, 30 per short-term window).
- Absolute gate −70 LUFS, relative gate −10 LU.
- Average powers, never dB values.
- Momentary (0.4 s) and short-term (3 s) values are ungated.
- Test: a 1 kHz stereo sine at −23 dBFS reads −23.0 ±0.1 LUFS.

**LRA (EBU Tech 3342):**
- Short-term values every **100 ms**; libebur128 uses 1 s, so expect small differences.
- Gates −70 LUFS absolute and −20 LU relative.
- LRA = s[round((n−1)·0.95)] − s[round((n−1)·0.10)] on the sorted values.
- Test: 20 s at −20 dBFS then 20 s at −30 dBFS gives 10 ±1 LU.

**True peak (BS.1770 Annex 2).** 4× polyphase filter, y_p[n] = Σ_k P_p[k]·x[n−k] (signs restored):
```
P0 = [ .0017089843750, .0109863281250,-.0196533203125, .0332031250000,-.0594482421875, .1373291015625,
       .9721679687500,-.1022949218750, .0476074218750,-.0266113281250, .0148925781250,-.0083007812500]
P1 = [-.0291748046875, .0292968750000,-.0517578125000, .0891113281250,-.1665039062500, .4650878906250,
       .7797851562500,-.2003173828125, .1015625000000,-.0582275390625, .0330810546875,-.0189208984375]
P2 = reverse(P1);  P3 = reverse(P0)
```
- Report max(sample peak, interpolated peak). Use 2× oversampling at 96 kHz.
- Possible under-reading: up to 0.55–0.69 dB at 4×, up to 0.14–0.17 dB at 8×.
- The limiter detector needs a better filter, because this one stops only about 40 dB. Use a Kaiser-window design:
  - β = 0.1102·(A − 8.7);
  - taps ≈ (A − 7.95)/(14.36·Δf/fs_out) + 1;
  - example: 4× from 44.1 kHz with A = 90 dB gives β ≈ 8.96 and about 247 taps.

**Limiter** (Signalsmith design):
1. Target gain gt = min(1, ceiling/peak), from the linked oversampled peak.
2. Moving minimum over a hold window H.
3. Release: `r += (h − r)/(R + 1); r = min(r, h)`.
4. Smoothing: two cascaded boxes splitting the total length L 0.5822/0.4178.
5. Output: `y[n] = x[n − (L−1)]·g[n]`.

There is no overshoot as long as **H ≥ L**. Defaults: L = 3 ms (1.5–5), H = L + 5 ms, release 80 ms (50–200). The internal ceiling sits below the target: −0.25 dB lower with 4× detection, −0.05 dB with 8×. Offline loop: when the true peak is over, lower the ceiling by the excess plus 0.05 dB and re-run the limiter only (2–3 runs). Measure LUFS last.

**Soft clip:**
- Above the threshold T, |y| = T + (c − T)·tanh((|x| − T)/(c − T)), with T = c·10^(−3/20).
- Run it 4× oversampled, or with first-order antiderivative anti-aliasing (ADAA): F1 = ln cosh x, computed as `|x| + log1p(exp(−2|x|)) − LN2`.

**LR4 crossovers:**
- Each LR4 filter is two Butterworth sections (Q 0.7071), and LP4 + HP4 = AP2 (the matching 2nd-order allpass).
- 3 bands: low = LP4(f1)·AP2(f2), mid = HP4(f1)·LP4(f2), high = HP4(f1)·HP4(f2).
- Without the AP2 on the low band, splits at 200/600 Hz dip −1.42 dB.
- 4 bands: split at f2, then give the low branch AP2(f3) and the high branch AP2(f1).

**Compressor:**
- Soft-knee gain computer:
  - if 2|x − T| ≤ W: `x + (1/R − 1)(x − T + W/2)²/(2W)`;
  - otherwise: x below T, `T + (x − T)/R` above.
- Smoothing branches on attack/release in the gain domain.
- Auto release: GR = max(fast 40–100 ms, slow 0.5–2 s) [E].

**Dynamic EQ and de-esser:**
- Dynamic band: `y = x + (g − 1)·BP0(x)`, where BP0 is the RBJ constant-0 dB-peak bandpass. The gain at f0 is exactly g.
- Identity: `Peaking(f0, Q, A) ≡ 1 + (A² − 1)·BP0(f0, Q·A)`.
- Shelf de-esser: `x − (1 − g)·HP1(x)`, or `LP4 + g·HP4`.

**STFT:** √Hann analysis and synthesis at hop N/4 overlap-adds to **2.0**, so divide by 2. Masks are real; keep the original phase.

**Match EQ** (re-implement Matchering from its description; its code is GPL):
- Use the gated, louder parts of both tracks and set them to equal LUFS before taking the ratio.
- Smooth to 1/3 octave and clamp to ±6 dB (±3 dB when gentle).
- Fade the correction to 0 below 30–40 Hz and above min(14–16 kHz, f_c).
- Default amount 50%.

**Dither:**
- TPDF: `q = round(x·32768 − Σc_k·e[n−1−k] + r1 + r2 − 1)`, clamped to the 16-bit range; e = q − v, limited to ±4 LSB.
- Noise shaping with `lip44 = [2.033, −2.165, 1.959, −1.590, 0.6149]` **only at 44.1 kHz**; otherwise flat TPDF.
- Dither is always the very last step.

## 8. Open questions and conflicts

1. **Small calibration set.** Thresholds were checked on 7 real Suno exports (six 48 kHz / 192–340 kbps MP3s and one 48 kHz 16-bit WAV; pop, ballad, reggaeton/latin). Measured there: HF cutoff 15.5–16.9 kHz, R-channel DC −4e-4…−1.6e-3, sibilance events 43–121/min with a median excess of 2.2–4.4 dB, brightness 4.1–7.6 dB. This set drove the sibilance-excess gate, the dcOffset gate (0.001), the brightened ramp (6→9 dB) and the bass-hump protection in auto EQ. A larger set (20–40 files across Suno versions, plus commercial references) is still needed for the shimmer index and the tilt cap.
2. **Suno's export specs are unpublished:**
   - WAV sample rate: 48 kHz [M] vs 44.1 kHz [S];
   - whether the WAV is decoded from an Opus stream;
   - the MP3 bitrate;
   - each version's native rate.
3. **Raw loudness and stereo width conflict.** Measured loudness is about −15 LUFS, against claims from −8 to −22. Width reports say both "fake-wide" and "near-mono".
4. **Loud target.** Sources give −9, −10 and −11. **Decision:** −10, with intensity selecting −11 to −9.
5. **Ceilings above −14 LUFS.** Research 03 lists Social and Club at −1.0. **Decision:** Social −2.0, because it gets re-encoded; Club stays at −1.0 because playback is lossless.
6. **Platform numbers not confirmed by the platforms:** Apple −16 is unpublished by Apple; SoundCloud may not normalize; TikTok publishes no target; Amazon's true-peak advice is −1 or −2 dBTP. CD Baby's AI ban needs checking on its own site.
7. **WAV format tag.** FFmpeg writes 0xFFFE above 48 kHz, but Spotify requires tag 1. **Decision:** always tag 1.
8. **ARCHITECTURE.md conflict.** It enables noise shaping for every 16-bit export, but lip44 is valid at 44.1 kHz only. Make it conditional on the sample rate.
9. **Unverified browser behaviour:** Chrome and shipping Safari decoding Opus in M4A; lamejs speed; whether sandboxed hosts allow `blob:` workers.
10. **Unverified DSP details:** Giannoulis's detector and auto release (paper not retrieved); the ADAA half-sample delay; Afchar et al. give no Hz values for Suno's spectral peaks, so notching stays experimental.
11. **Suno terms of service.** They may forbid removing the watermark (unverified). Preserve metadata.
