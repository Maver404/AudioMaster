# 01 — Survey of automatic / assisted mastering tools

*Research for a browser-based (vanilla JS + Web Audio, no backend) one-click mastering app for Suno-generated songs (MP3/WAV/M4A).*
*Compiled 2026-10-26. Each tool section names its sources and their dates. Some claims could not be verified; these are marked **[UNVERIFIED]** or **[CONFLICT]**.*

---

## 0. TL;DR (decision-relevant)

1. **Every tool converges on the same chain**: corrective/tonal EQ → (adaptive resonance/tonal smoothing) → dynamics (multiband/microdynamics) → stereo image → (saturation/color) → true-peak limiter driven to a **measured** integrated-loudness target. The limiter always comes last.
2. **The consumer UX is almost always 3 choices + 1 amount:** a *style/character* (3–4 options), an *intensity/loudness* (3 levels, or a slider), an optional *reference track*, and a few optional "revision" tweaks (3-band tone, width, de-ess/sibilance, loudness fine-tune).
   - LANDR: Warm/Balanced/Open + Lo/Med/Hi.
   - Waves: Organic/Precise/Elevated.
   - Logic: Transparent/Clean/Valve/Punch.
   - BandLab: 8 presets + 11 intensity levels.
3. **Loudness defaults are too hot for streaming in several tools.**
   - Ozone 10 sets the middle of its Maximizer slider to −10 LUFS for genre targets.
   - CloudBounce was criticised as "considerably louder than we would have liked".
   - eMastered measured −9 to −11 LUFS.

   Better-behaved defaults:
   - Apple's Logic Mastering Assistant centres its loudness knob at about −14 LUFS-I.
   - RoEx defaults to Medium, about −14 LUFS.

   Spotify recommends ≤ −1 dBTP, and ≤ −2 dBTP if the master is louder than −14 LUFS.
4. **A loudness-matched A/B is table stakes.** It appears in Ozone (Gain Match), Logic (Loudness Compensation) and LANDR (volume matching). Without it, users judge "louder = better".
5. **Matchering 2 is a fully documented open-source blueprint for reference matching**, and it can be ported to JS.
   - It splits the signal into Mid/Side and measures RMS over the "loudest pieces" (segments at or above the average RMS).
   - It builds a 4096-tap linear-phase FIR from the reference/target average-spectrum ratio, smoothed by LOWESS on a log-frequency grid. It does this separately for Mid and Side, which is how it matches width.
   - It runs 4 iterative RMS-correction passes, then a custom brickwall limiter.
   - Caveats: the limiter does **not** detect true peaks, it outputs at −0.016 dBFS sample peak, and the EQ ratio is **uncapped**.
6. **Suno's own "Remaster" is not mastering.** It regenerates the song with a newer model (Variation strength: Subtle / Normal (default) / High). Suno offers no limiter or loudness meter. Suno output often has 200–400 Hz mud, sub rumble below 30 Hz, vocal sheen and top-end hiss or cymbal wash. These are the targets for a "Suno cleanup" stage placed before mastering.

---

## 1. Tool-by-tool survey

### 1.1 iZotope Ozone 11 / 12 (Master Assistant + modules)

**Versions and dates:**
- Ozone 11: help docs on docs.izotope.com; Sound On Sound (SOS) review, Jan 2024.
- Ozone 12: released Sept 2025; SOS review by John Walden, Dec 2025; iZotope "Inside Ozone 12" interview.
- Editions and prices: Elements $55, Standard $219, Advanced $499. Standard has 14 modules and Advanced has 20 (SOS).

#### Master Assistant (MA): workflow and controls
- **Analysis:**
  - Ozone 11 needs at least 8 s of audio. You play the loudest part, and short selections are looped.
  - Ozone 12 adds an "Analysis Time" slider, up to 60 s, with tempo sync (SOS; iZotope feature page).
  - "Relearn" re-runs the analysis.
- **Target types:**
  - Ozone 11: **Genre** gives 10 genre targets "derived from recent chart-topping hits", plus a **Cinematic** target built from box-office film scores. **Reference** imports your own files, and MA learns the loudest 8 s of each.
  - Ozone 9 built a unique target curve by weighting 10 genre curves by their similarity to the track. The iZotope support article on the Ozone 8 → 9 changes says it loads "a preset based on the genre class with the highest percentage of similarity".
  - Ozone 12 says it has "much more expansive" genre targets, but no list is published.
- **Sub-targets matched:** tonal balance, vocal balance, stereo width, dynamics (microdynamics) and loudness (integrated LUFS).
- **Macro controls in Ozone 11** (these are what Elements users get):

  | Macro | Module | Range |
  |---|---|---|
  | Maximizer | Maximizer gain | ±4 dB around target |
  | Equalizer amount | EQ 1 global amount | 0–200 % |
  | Dynamics Match | Impact, 4 bands | 0–100 % |
  | Width Match | Imager, 4 bands; may enable *Recover Sides*; **never Stereoize**; bass is not widened if already narrow | 0–100 % |
  | Clarity Amount | Clarity, genre-appropriate tilt | — |
  | Vocal Balance | Master Rebalance (AI vocal stem level). Skipped (with a check mark) if the vocal level already matches, no vocal is detected, or a custom reference is used | level slider |
  | Stabilizer Amount | Stabilizer. A reference creates a custom "Assistant" target | — |

- **Ozone 10 grouping (docs):**
  - Tone Match covers EQ (0–100 %) and Stabilizer.
  - Width Match covers the Imager.
  - Dynamics Match covers Impact and the Maximizer threshold (±4 dB).
  - Target display: the target appears as a "blue tunnel" and your audio as a white line. Raising EQ/Stabilizer amounts moves the line into the tunnel. **This is a good UX pattern to copy.**
- **Ozone 12 "Custom flow":**
  - Lets you toggle which modules MA may use.
  - One-knob **LUFS target**.
  - **Intensity fader** for "more transformative or subtle" processing.
  - Genre modifiers.
  - Settings can be saved as the default.
  - Forum users (KVR) report that MA does **not** use the new IRC 5 limiter mode by default **[forum, unverified]**.

#### Loudness handling
- **Ozone 9:**
  - Streaming destination = −1.0 dB ceiling; CD = −0.3 dB ceiling.
  - Intensity sets LUFS-target loudness: **Low −14, Medium −12, High −11 LUFS**.
- **Ozone 10:**
  - Streaming = −1 dB output, True Peak ON, and the **middle of the Maximizer slider = −10 LUFS** for genre targets. With a reference, it uses the reference's loudest-8-s integrated loudness.
  - DJ Player = −0.1 dB ceiling, TP OFF, and the slider range is shifted up 2 dB.
- **Ozone 11:**
  - MA measures integrated loudness during analysis and sets Maximizer gain to hit the target.
  - Streaming = −1 dB TP ON; Full Scale = about −0.1 dB TP OFF.
- **Maximizer "Learn Input Gain":** listens for 5 s and sets Gain to a Target LUFS. The docs say not to rely on it for compliance.

#### Before/after presentation
- **Gain Match** in the header compensates output level against input. It also applies during per-module bypass.
- **Delta** (on every module and globally) solos the difference between input and output.
- A global Bypass and a Reference panel let you compare against a reference track.

#### Module details (Ozone 11 docs unless noted)
- **Maximizer (IRC modes):**
  - *IRC LL:* low latency.
  - *IRC 1:* fast on transients, slow on bass.
  - *IRC 2:* keeps transients sharper.
  - *IRC 3:* most aggressive; high latency. Styles: Clipping, Crisp, Balanced (generally transparent), Pumping (legacy Ozone 5).
  - *IRC 4:* spectrally shapes the bands that cause overshoot. Styles: Classic, Modern, Transient.
  - *IRC 5 (Ozone 12):* the first true **multiband limiter** in Ozone. It uses **4 bands**, each with its own gain envelope and attack/release, plus a psychoacoustic model that predicts whether distortion is audible. It can cause a slight tonal shift (iZotope interview).
  - *Character:* 0.0 (Clipping) to 10.0 (Very Slow), adjusting attack and release.
  - *Other controls:* True Peak toggle; Transient Emphasis; Stereo Independence (Transient/Sustain, default linked 0 %); Upward Compress (parallel, in dB, runs *before* the IRC limiter; SOS used about 3 dB).
  - *Soft Clip:* 4× oversampled. Thresholds: **Light −3 dBFS, Moderate −9 dBFS, Heavy −30 dBFS**.
- **Clarity (Advanced):**
  - Adaptive contouring with hundreds of bands toward "flat noise". Tilt 0 dB/oct = pink (default); +3 = white; −3 = brown.
  - Amount at 100 gives up to **±6 dB**.
  - Action region **300 Hz–20 kHz**. Attack and release are in ms.
  - iZotope says it raises perceived loudness at equal integrated LUFS.
- **Stabilizer:**
  - Adaptive EQ with two modes: *Shape* (boost and cut toward the target, loudness-neutral) and *Cut* (cuts only, above the target's upper bound).
  - Amount at 100 gives a max boost of **9 dB**.
  - Speed, Smoothing (100 ≈ 3–4 filters; 0 = many), Sensitivity, Tame Transients.
  - Low/Mid/High amounts with splits at **100 Hz** and **5.6 kHz**.
  - The "All-purpose" target is based on the Tonal Balance Control "Bass Heavy" curve.
  - Ozone 12 adds more genre targets.
- **Impact:** microdynamics with up to 4 bands.
  - Impact control: + expands (punchier), − compresses (denser).
  - Envelope in ms or synced to tempo.
  - Per-band RMS auto-gain; Link Bands; Amount 0–100 % (default 100 %); Learn crossovers at spectral minima.
- **Imager:** up to 4 bands.
  - Width per band adjusts side gain; −100 = mono.
  - Stereoize I uses Haas-delayed mid injected into the side; Stereoize II preserves transients better.
  - Recover Sides.
  - Meters: vectorscope, correlation meter and trace, stereo-width spectrum.
- **Low End Focus:**
  - Action region **20–300 Hz**.
  - Punchy (fast) or Smooth (slow) mode.
  - Contrast: + emphasises transients, − blurs or saturates the low end. Gain.
- **Bass Control (Ozone 12, Standard and Advanced):**
  - Controls: Balance, Punch, Sustain Power, Peak Control.
  - The SOS reviewer preferred it to Low End Focus.
- **Match EQ:**
  - Linear-phase, "over 8,000 bands".
  - You capture a Reference snapshot and an "Apply To" snapshot, then set Smoothing. 0 % gives "extreme, unnatural EQs".
  - Amount 0–100 %. **iZotope recommends < 50 %.**
  - Low and high cutoff handles limit the range that is matched.
- **Tonal Balance Control (TBC) bands:**
  - Low 20–250 Hz, Low-mid 250 Hz–2 kHz, High-mid 2–8 kHz, High 8–20 kHz. Inspired by Bob Katz's "Carnegie" chart.
  - TBC2 had 13 factory genre targets; TBC3 advertises 30+.
  - The target names were not verifiable **[UNVERIFIED: names like Bass Heavy / Modern / Orchestral]**.
  - TBC also has a low-end crest-factor meter (peak/RMS) to flag a low end that is too dynamic or too compressed.
- **Stem EQ (Ozone 12 Advanced):**
  - Real-time 4-stem separation (vocals, drums, bass, other) using mixture-consistent stems that sum back to the input. About 85 ms latency (SOS).
  - Per-stem HP/LP, shelves and bells.
- **Unlimiter (Ozone 12 Advanced):**
  - Machine-learning sample-wise gain inversion that restores peaks lost to mix-bus limiting.
  - Controls: Threshold and Amount.
  - It was **not** designed for severely brick-walled or distorted sources.
  - Relevant because Suno output is often already limited.
- **Master Rebalance / Stem Focus:** AI 4-stem separation used to rebalance vocals or to process one stem.

#### Typical MA chain order
- Not stated explicitly in the docs.
- The modules MA uses are: Master Rebalance (optional) → EQ → Stabilizer and/or Clarity → Impact → Imager → Maximizer. This is the order normally shown in the UI **[ORDER UNVERIFIED in docs]**.
- Ozone 9 "Modern" listed EQ, Dynamics, Maximizer and Dynamic EQ.
- Ozone 9 "Vintage" listed EQ, Vintage EQ, Vintage Compressor, Vintage Limiter and Maximizer.
- iZotope's general guidance (Ian Stewart, Oct 2023): **corrective before sweetening, and linear (EQ) before non-linear (dynamics)**. A multiband example used crossovers at about 130 Hz (kick) and above 3 kHz (clap) with fast attack and release.

---

### 1.2 LANDR (web mastering, Revisions, Mastering Plugin)

**Sources:** LANDR site (2026); LANDR blog on Revisions (26 Nov 2025); SOS news on the plugin (18 Oct 2023); Planetary Group review (undated, promotional); ProducerHive (2021, updated 2023).

- **Styles:** **Warm** ("older mastering techniques", softer compression, fuller sound), **Balanced** (balance, clarity, depth), **Open** (modern Top-40, extra punch and presence).
- **Intensity:** **Lo / Med / Hi**.
  - Lo is the most subtle and preserves dynamic range; suggested for acoustic, orchestral and spoken word.
  - Med is the "safe bet" and the default.
  - Hi "greatly boosts" loudness and largely removes dynamic range; suggested for EDM.
  - The default in the Planetary Group test was Med + Open.
- **Loudness numbers:** not published by LANDR.
  - Third-party blogs map Lo/Med/Hi to roughly −14 / −11 / −9…−10 LUFS **[UNVERIFIED]**.
  - ProducerHive measured −13 LUFS (long-term) with a −0.3 dB peak.
- **Revisions (free for subscribers):**
  - *Sibilance protection.*
  - *EQ strength,* which scales the "Synapse" engine's EQ.
  - *EQ adjustment by descriptors* (thin / harsh / boomy) across lows, mids, highs and vocal range. **Descriptor-based EQ is a strong idea for non-experts.**
  - *Loudness fine-tune* beyond the 3 intensity levels.
  - *Stereo field,* with two toggles: widen, and focus the centre. Both on gives "enhanced width and prominent center".
- **Mastering plugin:**
  - Detects genre on the loudest section, builds a custom chain, and can re-analyse.
  - Controls: Style (Warm/Balanced/Open), 3-band EQ, Presence (vocal range), De-esser (Frequency + Amount), Stereo Field slider, Compression + Character, Saturation (valve/transformer), Loudness with a LUFS meter.
  - Runs locally in real time.
- **AI and genre detection:** trained on the adjustments engineers make. Reviewers report "micro-genre detection" with multiband compression, EQ, stereo enhancement, limiting and harmonic saturation.
- **Reference:** reference mastering accepts up to 3 references (Planetary Group). One 2026 blog says references now work only in the plugin **[CONFLICT]**.
- **Albums:** applies "the same settings and loudness standards" across all tracks. Batch processing up to 24 tracks.
- **Before/after:**
  - Free unlimited previews.
  - **Volume matching** of input and output so EQ, width and distortion changes can be heard.
  - Near-instant A/B switching.
  - Complaints: the comparison covers only 30 s, and every change requires a re-master (ProducerHive 2021).
- **Formats:** input WAV/AIFF/FLAC/MP3. Output MP3 320 kbps, WAV 16-bit and HD WAV 24-bit.

### 1.3 eMastered

**Sources:** eMastered v2 site (2026); help centre (403, read via search snippets); ProducerHive (2021/2023); MixingGPT (May 2026, written by a competitor, no data, low trust); Violet Recording (June 2026).

- **"Advanced Mastering Options"** (paid; can be saved as user presets):
  - *Mastering Intensity:* Low / Normal / High.
  - *Compressor Intensity:* 5 levels, Very Low → Extreme.
  - *EQ Intensity:* Very Low / Moderate / Normal / Extra / Extreme.
  - *Stereo Width:* Normal / Wider / Widest.
  - *Volume:* Normal / Louder / Loud / Extreme.
  - *3-band EQ:* Low / Mid / High, each set to Reduce, Normal or Increase.
- **Reference mastering:** matches loudness, balance and compression.
  - Styles: Standard / Bright / Brighter / Brightest / Custom.
  - Advanced: Amount, Smoothing, Bass (Low/Med/High).
  - The help centre has a "Reference Intensity" control that governs how bright the result gets relative to the reference.
- **Processing (per the FAQ):** "audio recognition algorithms" applying EQ, compression and volume normalisation.
  - The FAQ advises leaving −3 to −6 dB of headroom on input and suggests exporting at 48 kHz / 32-bit.
- **Before/after:** an "Original" vs "eMastered" player toggle, with real-time A/B and minimal lag (ProducerHive). Level-matched per MixingGPT **[UNVERIFIED]**.
- **Loudness measured:** −11 LUFS (ProducerHive, with increased compressor, −0.2 dB peak). Default about −9 to −10 LUFS (MixingGPT) **[low-trust source]**.
- **Complaints:** the most aggressive of the services tested; low-end pumping; slow uploads and re-masters; won't fix a narrow stereo image.
- **Formats:** input MP3/AIFF/WAV up to 900 MB. Output MP3 320 kbps, WAV 16/44.1, HD WAV 24-bit.

### 1.4 BandLab Mastering

**Sources:** bandlab.com/mastering (2026); BandLab help (snippets); MusicTech (15 Sep 2026); Magnetic Mag (9 Sep 2026).

- **Free presets:** official one-liners from BandLab help.
  - **Universal:** "organic dynamic processing and tonal enhancement".
  - **Fire:** "pushed and punchy lows without muted vocals".
  - **Clarity:** "pristine breathy highs with light dynamic expansion".
  - **Tape:** "warm tape saturation with analog dynamic processing".
- **Member presets:**
  - **Natural:** balanced dynamics, gentle compression.
  - **Spatial:** atmospheric reverb and a wider image.
  - **Cinematic:** intense saturation and harmonic distortion.
  - **Punch:** energetic bass with boosted highs.
- **Intensity:** older docs say Light ↔ Heavy (earlier Light/Normal/Heavy). Since Sept 2026 there are **11 intensity levels per preset**.
- **Max EQ:** a 3-band Mastering EQ (lows/mids/highs) for Max subscribers, added in Sept 2026.
- **Input gain** control.
- **Who made the presets:** human engineers (Mandy Parnell, Mike Tucci, Maria Elisa Ayerbe, Justus West, Will Quinnell). BandLab contrasts itself with services "developed by software engineers and AI". **Presets are hand-designed; there is no claim of AI genre detection.**
- **Loudness target:** not published.
- **Free:** unlimited masters with the 4 basic presets. Album/EP drag-and-drop. Mobile video export.

### 1.5 CloudBounce

**Sources:** RA review (May 2017); MusicRadar (undated); Avid guide (Nov 2021, 403, read via search snippet); ProducerHive (2021). The current site was unreachable (DNS failure on 2026-10-26), so **the service may be discontinued or moved [UNVERIFIED]**.

- **Genre presets:** 15+, user-selected. Examples: Default, Hip Hop/R&B, DnB/Bass, EDM, Electro House, Deep House, Tech House, Techno, Trance, Rock/Pop, Metal/Punk, Ambient, World, Classical, Jazz/Blues. What each preset does is **undocumented**, which users complained about.
- **Traits / "algorithm settings":** Louder / Less Loud, Mid Boost, Mid Dip, Warmer, More/Less Bass, Stereo Width. The desktop app adds EQ (Bass, Mid, Brightness) + Warmth and a **loudness knob defaulting to −12 LUFS** (Avid 2021, snippet).
- **Measurements and reviews:**
  - RA measured Deep House at about −7.9 dB RMS and Techno at about −6.1 dB RMS ("slightly hot").
  - MusicRadar: "considerably louder than we would have liked", with only one "Less Loud" step.
  - ProducerHive: −10 LUFS, −0.3 dB peak. Its stereo image collapsed guitars toward the centre.
  - The RA reviewer heard kick/bass clipping on Default, which was fixed by switching to Techno + Warmer.

### 1.6 Masterchannel

**Sources:** masterchannel.ai (2026); AI Musicpreneur (10 Sep 2026; affiliate site); Violet Recording (Aug 2026); Masterchannel blog.

- **Engineer "profiles":** Simon Hestermann, and Wez Clarke (Professional tier, described as a "Clone"). This is a persona-as-preset UX.
- **Inputs to the engine:** genre and mood, plus up to **3 reference tracks**.
- **Sliders:** Lows, Mids, Highs, Gain and Stereo ("post-mastering tweaks" are a Professional feature).
- **Platform targets:** a loudness/platform target picker exists only on Professional. The Artist tier has no LUFS picker.
- **Consistency:** a stated focus is consistency across an album or EP, including referencing your own previous masters.
- **Playback:** lossless playback with optional loudness normalisation for comparison.
- **Pricing (EUR):** Artist €15/mo, Professional €19/mo, Partner €79/mo (yearly). A public beta of v-next has run since Aug 2026 and accepts WAV only.

### 1.7 RoEx (Tonn API / Automix / Mix Check Studio)

**Sources:** RoEx Tonn API FAQ and tutorials (2026); RoEx blog (2026).

- **Mastering request fields:** `musicalStyle` (a genre preset, e.g. ROCK_INDIE, POP, ELECTRONIC) and `desiredLoudness`.
- **Loudness presets:**

  | Preset | Target |
  |---|---|
  | **LOW** | about **−16 LUFS** |
  | **MEDIUM** (default) | about **−14 LUFS** |
  | **HIGH** | about **−10 LUFS** "without clipping" |

  These are explicitly "targets, not guaranteed outputs"; the response returns `measured_lufs`. **Reporting measured LUFS back to the user is a good pattern.**
- **Mix Check Studio:** a free analysis of tonal balance, loudness, dynamics, stereo width, mono compatibility and clipping.
- **Automix:** per-stem EQ, compression and spatial processing, then mastering. Reference matching is on Pro.
- **Suno-specific issues named:** level inconsistency between sections, frequency masking, a narrow stereo field, loudness spikes, and low end lost in mono.

### 1.8 Waves Online Mastering

**Sources:** MusicTech (18 Sep 2023, launch); Mix (2023); SOS and MusicRadar reviews (via search snippets); Sonicstate (30 Jul 2025, update); waves.com (2026).

- **Styles:** **Precise** (default, balanced), **Organic** (dialled back, lower loudness) and **Elevated** (pushed further, more loudness). The July 2025 update fine-tuned "Precise" for electronic music.
- **Tone:** **Depth** (low end) and **Presence** (highs). MusicRadar found Depth "plummy" and Presence "overly harsh".
- **Reference:** you can upload a reference track.
- **Loudness:** there is **no LUFS target control**. Reviewers explicitly asked for one, saying "the ability to set a target loudness would be far preferable".
- **Engine:** Waves Neural Networks plus engineer input (Piper Payne).
- **Formats:** input WAV/AIF(F)/MP3 at 44.1–96 kHz. Output WAV or MP3.
- **Preview:** free, with on/off comparison. Credits are paid at export (about $1–$4 per track in 2026).

### 1.9 Apple Logic Pro Mastering Assistant (added as a UX benchmark)

**Source:** Apple Support HT213974 / 108294 (2023–2026).

- **Analysis:** it analyses on insert and can be limited to a section with the locators. "Reanalyse" re-runs it.
- **Character:** **Transparent** (default, all genres, based on classic analogue chains), **Clean** (EDM, acoustic), **Valve** (deep lows and refined highs; acoustic, hip-hop) and **Punch** (aggressive, subtle mid emphasis; rock).
- **EQ:** an **Auto EQ** amount slider, plus a **Custom EQ** with 3 points, ±6 dB each, and movable frequency.
- **Loudness:** the **Loudness** knob, where **centre ≈ −14 LUFS-I**. **Excite** adds upper-mid saturation.
- **Width:** a Width knob set automatically by analysis. Fully left = mono check. A correlation meter is included.
- **Loudness Compensation:** a level-matched comparison. Apple says to turn it off before bouncing.
- This is arguably the cleanest "simple-yet-pro" UI in the survey.

### 1.10 Matchering 2 (open source; exact algorithm)

**Sources:** github.com/sergree/matchering, source read on 2026-10-26; PyPI matchering 2.0.6 (released 2022-10-19, latest). GPL-3.0, so **porting code means GPL obligations; re-implementing from this description avoids copying it**.

**Purpose:** output the TARGET with the same **RMS, frequency response, peak amplitude and stereo width** as the REFERENCE.

**Pipeline (`stages.py`):**

1. **Load and check.**
   - Resample to the internal 44.1 kHz. Mono is duplicated to stereo.
   - Length limits: max 15 min; minimum length equals the FFT size.
   - Warns if more than 8 samples sit at full scale (clipping) or more than 128 samples sit at the same max peak (pre-limited).
2. **Normalise the reference.** If the reference peak is below the threshold, scale it up to the threshold, T = (2^15 − 61)/2^15 ≈ 0.99814 ≈ **−0.016 dBFS**. Keep the coefficient so the final output is scaled back down to the reference's *original* peak. This is how it matches peaks.
3. **Mid/Side split.** M = (L+R)/2 and S = (L−R)/2. Reconstruct with L = M+S and R = M−S.
4. **Level analysis ("loudest pieces").**
   - Cut the mid channel into `divisions = floor(len/15 s) + 1` equal pieces, so each piece is ≤ 15 s.
   - Compute each piece's RMS and the average RMS (the RMS of the piece RMSs).
   - **Keep the pieces with RMS ≥ average.** match_rms is the RMS of those pieces' RMS values.
   - Side pieces use the same indices.
5. **RMS match.** gain = ref_match_rms / target_match_rms, applied to target M and S.
6. **Frequency match.** Done separately for Mid and Side, which also matches width.
   - Average magnitude spectrum over the loudest pieces using STFT: **rectangular (boxcar) window, nperseg = 4096, no overlap**, |X| averaged over frames and channels.
   - ratio = ref_avg / max(target_avg, 1e-6). **No cap on boost or cut.**
   - Smoothing:
     - Cubic-interpolate the ratio from the linear grid (2049 bins, about 10.8 Hz spacing) to a **log grid** of 8193 points from about 21.5 Hz to Nyquist.
     - **LOWESS** with frac = 0.0375 (about 307 log-points window), it = 0, delta = 0.001.
     - Cubic-interpolate back to the linear grid. Set the DC bin to 0 and restore bin 1 to its raw value.
   - FIR = `ifftshift(irfft(curve)) × Hann(4096)`, giving a 4096-tap linear-phase FIR.
   - Apply with `fftconvolve(..., "same")` to M and S separately, then convert M/S back to L/R.
7. **Iterative level correction (4 steps).** On each step:
   - Hard-clip the result mid at ±1, used as a proxy for what the limiter will remove.
   - Re-measure the loudest-pieces RMS.
   - Re-apply the gain toward ref_match_rms.
8. **Limiter ("Hyrax", custom brickwall).**
   - Detection: per sample, the max of |L|,|R| (channels linked), floored at the threshold and divided by it.
   - Hard-clip gain: `1 − 1/rectified`, i.e. the gain-reduction amount.
   - **Attack:** 1 ms (44 samples).
     - Centred sliding max of size about 2·45−1, which acts as a lookahead of about 1 ms.
     - Then a zero-phase (`filtfilt`) one-pole smoother with coef = exp(−2/44).
   - **Hold:** 1 ms backward-looking sliding max, then a 1st-order Butterworth low-pass at 7 Hz.
   - **Release:** 1st-order Butterworth low-pass with cutoff = 800/3000 ms ≈ **0.27 Hz** (very slow, smooth release).
   - Final gain reduction = the element-wise max of (hard-clip GR, attack GR, release/hold GR), applied identically to both channels.
   - **No oversampling and no true-peak detection.** The output peaks at about −0.016 dBFS *sample* peak, then is scaled to the reference's peak.
9. **Outputs:** limited result (default); "no limiter" result; "no limiter, normalized" result. PCM16/PCM24 WAV.
   - **Preview:** finds the loudest 30 s window of the *result* (5 s analysis step) and exports the same window of the target and the result with 1 s fades. **The previews are NOT loudness-matched.**

**Implications for our app:**
- Port this as the "Reference" mode, but:
  - (a) **clamp the EQ ratio** to about ±6–9 dB and/or blend at ≤ 50 % (iZotope's Match EQ guidance);
  - (b) replace the limiter with a **true-peak (4× oversampled) limiter at −1 dBTP**;
  - (c) measure **LUFS (BS.1770)** for the final target rather than RMS;
  - (d) keep the clever "loudest pieces ≥ average RMS" analysis and the M/S-separate FIR matching.
- Integrations: UVR5, MVSEP, Moises, Songmastr and a ComfyUI node.

### 1.11 Suno's own features

**Sources:** Suno help article "Remaster" (undated, "Edited"); Suno Studio export help; AI Musicpreneur (10 Sep 2026); jackrighteous.com guides (2026).

- **Remaster:**
  - Opened from Create → Remaster. You choose a model and a **Variation strength**:
    - **Subtle:** small acoustic and production changes.
    - **Normal (default):** keeps duration and style, with slight musical changes.
    - **High:** noticeable changes, possibly to vocals.
  - It *regenerates* the clip, which can change the mix, textures and vocal clarity. **It is not a deterministic mastering stage.** Guides warn it may remove grit and aggression.
- **Suno Studio:** WAV export of the full song, a selected range, or multitrack stems. Per one 2026 source, Studio 2.0 has 7 effects and **no limiter and no loudness meter** **[single source]**.
- **Source quality:** 16-bit / 44.1 kHz (AI Musicpreneur).
- **Raw export loudness:** about −11 LUFS short-term (cited from a third party). Other claims range from −14 to −22 LUFS integrated, and from −8 to −12 LUFS **[CONFLICT/UNVERIFIED]**.
  - **The app must measure the input and never assume it.**
- **Typical faults:** 200–400 Hz mud, rumble below 30 Hz, vocal reverb "sheen", top-end hiss and cymbal wash, shimmer/metallic haze, and loudness spikes.
- **Suggested recipe** (Ozone-based, from AI Musicpreneur, **not an engineer**):
  - De-clip if peaks look flat.
  - A dynamic EQ band at **6–10 kHz** that ducks hiss only when it spikes.
  - A shelf or HPF **below 30 Hz**.
  - Target −9 to −12 LUFS.
  - **−1 dBTP, or −2 dBTP if louder than −14 LUFS.**
- **Policy flag:** a 2026 source cites Suno's terms (effective 2026-09-03) as prohibiting removal or circumvention of Suno's fingerprint, watermark or metadata **[UNVERIFIED]**. The app should not market itself as a watermark remover. It should preserve metadata where possible, or at least not deliberately strip it.

---

## 2. Cross-tool comparison

| Tool | Style / character | Intensity / loudness | Reference | Fine-tune | A/B | Genre detection |
|---|---|---|---|---|---|---|
| Ozone 11/12 MA | Genre targets (10 + Cinematic; more in 12) | Maximizer ±4 dB; Ozone 12 LUFS knob + intensity fader; Streaming −1 dBTP | Yes (loudest 8 s) | EQ 0–200 %, Width, Dynamics, Clarity, Stabilizer, Vocal Balance | Gain Match, Delta, per-module bypass | Yes (similarity to genre classes) |
| LANDR | Warm / Balanced / Open | Lo / Med / Hi + Revisions loudness | Yes (≤ 3) | Descriptor EQ, sibilance, width, EQ strength | Volume-matched preview | Yes ("micro-genre") |
| eMastered | Ref styles Standard → Brightest | Low / Normal / High; Volume 4 steps | Yes (Amount, Smoothing, Bass) | Compressor 5, EQ-intensity 5, Width 3, 3-band EQ (−/0/+) | Original / eMastered toggle | Not stated |
| BandLab | 8 presets (Universal, Fire, Clarity, Tape, Natural, Spatial, Cinematic, Punch) | 11 levels | No | 3-band EQ (Max) | Preset audition | No (human-designed presets) |
| CloudBounce | 15+ genre presets | Louder / Less Loud; −12 LUFS knob | No | Warmer, Mid ±, Bass ±, Width | Preview | User-picked |
| Masterchannel | Engineer profile + genre / mood | Platform target (Pro) | Yes (≤ 3) | Lows / Mids / Highs / Gain / Stereo | Normalised playback | Input-guided |
| RoEx | `musicalStyle` | LOW −16 / MED −14 / HIGH −10 | Pro (Automix) | — | — | User-specified |
| Waves | Organic / Precise / Elevated | Via style only | Yes | Depth / Presence | On / off | NN-based |
| Logic MA | Transparent / Clean / Valve / Punch | Knob, centre ≈ −14 LUFS | No | Auto-EQ amount, 3-pt EQ ±6 dB, Width, Excite | Loudness Compensation | Analysis-based |
| Matchering | — | Matches reference RMS and peak | Required | — | Previews (not level-matched) | No |
| Suno Remaster | Model + Subtle / Normal / High | n/a (generative) | No | — | Compare by ear | n/a |

---

## 3. Extracted: canonical mastering chain (for our Web Audio engine)

Order follows iZotope guidance ("corrective → sweetening; linear before non-linear; limiter last") and the Ozone, LANDR and Matchering chains. The ranges combine vendor documentation (cited above) with common practice. *Values marked (rec.) are our own recommendations, not vendor numbers.*

| # | Stage | Purpose | Typical parameters / ranges | Notes for a Suno-focused auto mode |
|---|---|---|---|---|
| 0 | **Analysis** | Measure before acting | LUFS-I / short-term / momentary (BS.1770), sample and true peak (4× oversampled), LRA, crest factor, spectrum (averaged over the loudest pieces, Matchering-style ≥ average RMS), M/S energy ratio, correlation, clipped-sample count | Analyse the **loudest section**: Ozone uses ≥ 8 s up to 60 s; Matchering uses ≥ average-RMS pieces. Never assume the input LUFS. |
| 1 | **Input conditioning** | Headroom, DC | DC / sub HPF 20–30 Hz, 2nd–4th order (rec.); trim so peaks sit around −6 dBFS (eMastered asks for −3 to −6 dB of input headroom) | Removes Suno sub rumble below 30 Hz |
| 2 | **Repair / cleanup** (optional, auto) | Suno artifacts | Dynamic EQ or de-hiss band at **6–10 kHz**, threshold-based, max −3 to −6 dB (rec.); de-ess 5–9 kHz (rec.); declip if more than 8 samples sit at full scale (Matchering heuristic) | Gentle. The guides warn that over-cleaning kills air and transients. |
| 3 | **Corrective / tonal EQ** | Move toward target curve | Static or linear-phase EQ toward a genre or reference curve. Broad bands per TBC: 20–250 / 250–2k / 2k–8k / 8k–20k Hz. Moves usually ±0.5–3 dB. Match-EQ amount ≤ 50 % (iZotope); clamp ±6 dB (rec.). Mud cut around 200–400 Hz, −1 to −3 dB (rec.) | Matchering-style FIR (4096 taps, LOWESS-smoothed) is ideal when a reference is given |
| 4 | **Adaptive tonal smoothing** | Resonances, harshness | Clarity-like: >300 Hz, max ±6 dB, pink-noise target, tilt ±3 dB/oct. Stabilizer-like: max boost 9 dB, splits 100 Hz / 5.6 kHz | Hard in Web Audio without AudioWorklet/STFT. A v1 can use a few dynamic EQ bands. |
| 5 | **Dynamics** | Glue, density | Broadband or 3–4-band compressor. Crossovers about 120–130 Hz and about 3 kHz (Ian Stewart example). Ratio **1.2:1–2:1** (up to 4:1). Attack **3–30 ms**. Release 50–300 ms or auto. **GR 1–3 dB**. Optional upward compression ≤ 3 dB (SOS example). Impact-style microdynamics ± | Suno output is often already dense. Detect a low crest factor and reduce compression automatically. |
| 6 | **Low-end focus** | Tight, mono-safe bass | Bass mono below about 100–150 Hz (rec.; Ozone never widens an already-narrow low band); low-end region 20–300 Hz (Low End Focus) | Addresses RoEx's "low end lost in mono" |
| 7 | **Saturation / color** (style-dependent) | Warmth, perceived loudness | Tape/tube-style, mix 0–30 % (rec.); upper-mid "Excite" (Logic); BandLab Tape/Cinematic; LANDR Saturation | Oversample (2–4×) to avoid aliasing |
| 8 | **Stereo imaging** | Width | Multiband width; low band ≤ 0 %, mids/highs 0 to +20 % (rec.); keep correlation > 0 (Logic, Ozone); avoid Haas "stereoize" on masters (Ozone MA never enables it) | CloudBounce and Ozone were criticised for collapsing width; widen conservatively |
| 9 | **Sweetening EQ** | Air, presence | High shelf +0.5–2 dB at 10–12 kHz (rec.); only if the cleanup stage did not flag hiss | "Bright" or "Open" styles |
| 10 | **Clipper** (optional) | Peak shaving before limiter | Soft clip 4× oversampled. Ozone thresholds: Light −3, Moderate −9, Heavy −30 dBFS onset. Shave ≤ 1–2 dB (rec.) | "Loud" destination only |
| 11 | **Limiter / maximizer** | Final loudness | True-peak (≥ 4× oversampled), lookahead 1–5 ms, attack about 1 ms, release 50–300 ms or adaptive (Matchering: 1 ms hold plus a very slow, about 0.27 Hz release filter). **Ceiling −1 dBTP** (−2 dBTP if > −14 LUFS, per Spotify). Gain set from measured LUFS, then iterate 2–4 passes (Matchering does 4) | Multiband limiting (IRC 5 style) is a v2 feature |
| 12 | **Verify and export** | Compliance | Re-measure LUFS-I and TP; TPDF dither when reducing to 16-bit (rec.); WAV 24-bit, WAV 16-bit, MP3 320 (LANDR and eMastered output set) | Show the measured LUFS and TP like RoEx's `measured_lufs` |

**Loudness targets used by the industry:**

| Source | Targets |
|---|---|
| Spotify | Normal −14, Loud −11, Quiet −19 LUFS (ITU-R BS.1770). Positive gain is limited by headroom, leaving 1 dB for lossy encoding. TP ≤ −1 dBTP, ≤ −2 dBTP if louder than −14 LUFS |
| Ozone 9 | Low / Med / High = −14 / −12 / −11 |
| RoEx | −16 / −14 / −10 |
| Logic | Centre ≈ −14 |
| Ozone 10 genre-target centre | −10 |

> **[CONFLICT]** RoEx's blog says quieter masters "aren't turned up". Spotify's own doc says positive gain *is* applied, but only up to the available headroom (Normal and Quiet modes have no limiter; Loud mode uses a limiter at −1 dB with 5 ms attack and 100 ms decay). **Trust Spotify's doc.**

---

## 4. Extracted: minimal user-control set (simple yet pro)

Based on what every tool converges on, and on the complaints in §5:

**Main screen (one-click path):**
1. **Drop file:** MP3 / WAV / M4A (AAC/ALAC). Decode with `decodeAudioData`.
2. **Style: 4 options** with one-line descriptions, modelled on LANDR, Logic and BandLab:
   - **Balanced / Transparent** (default).
   - **Warm** (softer top, light saturation, gentler compression).
   - **Bright / Open** (presence and air, modern pop).
   - **Punchy** (low-end weight, transient emphasis; hip-hop, EDM, rock).
3. **Loudness / destination: 3 options plus a readout.**
   - **Streaming −14 LUFS** (default, −1 dBTP).
   - **Balanced −11 LUFS** (matches Spotify "Loud").
   - **Loud −9 LUFS** (−2 dBTP, with a warning about Spotify turn-down).
   - Optional "Custom" LUFS in Advanced.
   - Always show the **measured** LUFS-I and TP after processing.
4. **Intensity: one slider, 0–100 %**, default about 50 % (rec.). It scales EQ, compression, saturation and width together, like Ozone's amount macros, BandLab's 11 levels and the Ozone 12 intensity fader.
5. **A/B button**, **loudness-matched by default** (like Ozone Gain Match and Logic Loudness Compensation), with instant switching at the same playhead position, covering the **full track** rather than 30 s.
6. **Export:** WAV 24-bit / WAV 16-bit (dithered) / MP3 320.

**"Fine-tune" drawer (collapsed by default, LANDR Revisions model):**
- **Tone:** Low / Mid / High, ±6 dB (Logic), *or* descriptor buttons such as "Too boomy / too muddy / too harsh / too dull / too thin" (LANDR's descriptor EQ is non-expert-friendly).
- **Width:** −50 to +50 %. Bass is always mono below about 120 Hz (rec.).
- **"Clean AI artifacts":** Off / Light / Strong. A Suno-specific toggle that controls the hiss band at 6–10 kHz, de-ess, the mud cut and the sub HPF.
- **Reference track** (optional): Matchering-style matching with an **Amount** of 0–100 % (default 50 %).
- Advanced readouts: LUFS-I, short-term, TP, LRA, correlation, and a spectrum against a target "tunnel" (Ozone 10 pattern).

**Do NOT expose** (keep as internal auto parameters): compressor ratio/attack/release, crossovers, limiter release, oversampling, FIR length.

---

## 5. What users praise and what they complain about

**Praised:**
- Speed and one-click results; previews before paying, with unlimited free previews (LANDR, eMastered, Waves, BandLab).
- **Level-matched A/B** and near-instant switching (LANDR, eMastered; Ozone Gain Match; Logic Loudness Compensation).
- **Reference matching** and **album/EP consistency** (eMastered, LANDR, Masterchannel).
- Presets made or voiced by named engineers (BandLab, Waves, Masterchannel).
- Simple descriptor-style tweaks (LANDR Revisions); the Logic MA UI.
- LANDR is described as the "most natural" and closest to the human master (ProducerHive).
- Bass Control in Ozone 12 is praised as intuitive (SOS).

**Complained about:**
- **Too loud or over-compressed by default:**
  - CloudBounce ("considerably louder than we would have liked", only one "Less Loud" step).
  - eMastered (the "most aggressive", low-end pumping).
  - Ozone MA (r/SunoAI users describe "squashed" results; the Ozone 10 slider centre is −10 LUFS).
- **Too bright:** Ozone MA "often boosts the high end a lot", even on already-bright mixes (KVR forum, Ozone 12); Waves "Presence" is harsh.
- **Stereo problems:** CloudBounce pulled the L/R guitars toward the centre; Ozone's Imager narrows by about 20–30 % (KVR forum); eMastered won't fix a narrow mix.
- **No loudness target control** (Waves) and **opaque presets** (CloudBounce).
- **Workflow friction:** only a 30-second comparison; a re-master is required after every change; slow uploads (LANDR, eMastered, per ProducerHive 2021); paywalled WAV and tier caps.
- **Garbage in, garbage out:** none of these tools "rescues" a muddy or over-limited mix. Matchering's quality depends heavily on choosing a suitable reference.
- **Suno users specifically:** Ozone and Ableton were "complex" and left tracks "muddy, squashed, or distorted" (r/SunoAI, cited by Masterchannel). Suno's Remaster can remove grit and character.

**Design takeaways:**
1. Default to −14 LUFS / −1 dBTP and make "Loud" an explicit opt-in.
2. Use a conservative brightness and width policy that also checks the input's existing tonal tilt and width (don't brighten an already-bright track).
3. Offer a full-length, loudness-matched, instant A/B.
4. Re-render locally in real time when a setting changes; there is no server round trip.
5. Show the measured results.
6. Provide a Suno-specific cleanup toggle.

---

## 6. Open questions / items not verified

- Official LANDR LUFS values for Lo/Med/Hi (unpublished; the blog figures conflict).
- Ozone 12 MA's default LUFS-knob value and range (the docs returned 403). Whether MA uses IRC 5 by default (forum says no).
- Ozone MA exact module order (inferred from the UI, not documented).
- Names of the TBC / Ozone genre targets.
- eMastered's default loudness (only low-trust measurements) and whether its A/B is level-matched.
- CloudBounce's current status (site DNS failed on 2026-10-26).
- Suno ToS watermark clause and the typical loudness of raw Suno exports (conflicting third-party numbers).
- BandLab loudness target (unpublished).

---

## Sources

**iZotope Ozone**
- Ozone 11 Help, Master Assistant: https://docs.izotope.com/ozone11/en/master-assistant/index.html (accessed 2026-10-26)
- Ozone 11 Help, Maximizer: https://docs.izotope.com/ozone11/en/maximizer/index.html
- Ozone 11 Help, Clarity: https://docs.izotope.com/ozone11/en/clarity/index.html
- Ozone 11 Help, Stabilizer: https://docs.izotope.com/ozone11/en/stabilizer/index.html
- Ozone 11 Help, Impact: https://docs.izotope.com/ozone11/en/impact/index.html
- Ozone 11 Help, Imager: https://docs.izotope.com/ozone11/en/imager/index.html
- Ozone 11 Help, Low End Focus: https://docs.izotope.com/ozone11/en/low-end-focus/index.html
- Ozone 11 Help, Match EQ: https://docs.izotope.com/ozone11/en/match-eq/index.html
- Ozone 10 Help, Master Assistant: https://docs.izotope.com/ozone10/en/master-assistant/index.html
- Ozone 9 Help, Master Assistant: https://downloads.izotope.com/docs/ozone9/en/master-assistant/index.html
- iZotope Support, "Differences Between Ozone 8 and Ozone 9 Master Assistant": https://support.izotope.com/hc/en-us/articles/6658201912977 (via search snippet)
- iZotope, "Inside Ozone 12" (IRC 5, Stem EQ, Unlimiter): https://www.izotope.com/en/learn/inside-ozone-12
- iZotope, Master Assistant Custom Flow feature page: https://www.izotope.com/en/products/ozone/features/new-master-assistant-custom-flow (via search snippet; HTTP 429)
- iZotope, "What is an ideal mastering signal chain?" (Ian Stewart, 2023-10-17): https://www.izotope.com/en/learn/what-is-an-ideal-mastering-signal-chain.html
- Tonal Balance Control 2 Help, Targets and Views: https://s3.amazonaws.com/izotopedownloads/docs/tbc2/en/targets-and-views/index.html
- Sound On Sound, Ozone 12 Advanced review (J. Walden, Dec 2025): https://www.soundonsound.com/reviews/izotope-ozone-12-advanced
- Sound On Sound, Ozone 11 Advanced review (J. Walden, Jan 2024): https://www.soundonsound.com/reviews/izotope-ozone-11-advanced
- KVR forum, Ozone 12 Assistant opinions: https://www.kvraudio.com/forum/viewtopic.php?p=9252759 (via search snippet)

**LANDR**
- LANDR Online Mastering: https://www.landr.com/online-audio-mastering/
- LANDR Blog, Mastering Revisions (2025-11-26): https://blog.landr.com/mastering-revisions/
- Sound On Sound, LANDR Mastering Plugin (2023-10-18): https://www.soundonsound.com/news/landr-mastering-plugin-announced
- Planetary Group, LANDR test: https://www.planetarygroup.com/landr-ai-mastering-engine-overview-test/
- ProducerHive, "Can a human beat 4 online mastering services?" (2021, updated 2023-08-07): https://producerhive.com/editorial/online-mastering-vs-human-mastering/

**eMastered**
- eMastered v2: https://v2.emastered.com
- eMastered FAQ: https://emastered.com/faq
- eMastered Help, Reference Intensity / Mastering Strength: https://help.emastered.com/hc/en-us/articles/5572743831181 and https://help.emastered.com/hc/en-us/articles/5571971090061 (via search snippets)
- MixingGPT eMastered review (2026-05-06; competitor-authored): https://mixinggpt.com/blog/emastered-review-2026
- Violet Recording eMastered review (2026-06-04): https://violetrecording.com/emastered-review/

**BandLab**
- BandLab Mastering: https://www.bandlab.com/mastering
- BandLab Help, How do I master my music: https://help.bandlab.com/hc/en-us/articles/360001374513 (via search snippet)
- MusicTech, BandLab mastering upgrade (2026-09-15): https://musictech.com/news/music/bandlabs-mastering-capabilities-just-got-an-upgrade-heres-whats-new/
- Magnetic Mag (2026-09-09): https://magneticmag.com/2026/09/bandlab-mastering-update-gives-artists-more-control-before-release/

**CloudBounce**
- Resident Advisor review (2017-05-17): https://ra.co/reviews/21067
- Avid guide (2021-11-09; via snippet): https://www.avid.com/resource-center/how-to-master-your-music-for-streaming-services-with-the-cloudbounce-desktop-app
- MusicRadar on online mastering services: https://musicradar.com/news/online-e-mastering-services (via snippet)

**Masterchannel**
- https://masterchannel.ai/
- Masterchannel blog, Suno: https://blog.masterchannel.ai/how-to-easily-master-your-suno-tracks-for-pro-quality/
- Violet Recording review (2026-08-06): https://violetrecording.com/masterchannel-review/

**RoEx**
- Tonn API FAQ: https://tonn-portal.roexaudio.com/docs/faq
- Tonn API batch mastering tutorial: https://tonn-portal.roexaudio.com/docs/tutorials/batch-mastering
- RoEx blog, Suno to Spotify: https://www.roexaudio.com/blog/suno-to-spotify-release-ready

**Waves Online Mastering**
- https://www.waves.com/online-mastering
- MusicTech launch (2023-09-18): https://musictech.com/news/gear/waves-online-mastering/
- Mix: https://www.mixonline.com/technology/news-products/waves-audio-launches-online-mastering-service
- Sonicstate update (2025-07-30): https://sonicstate.com/news/2025/07/30/waves-updates-online-mastering/
- SOS and MusicRadar reviews (via snippets): https://www.soundonsound.com/reviews/waves-online-mastering, https://musicradar.com/reviews/waves-online-mastering-review

**Apple Logic Pro**
- Use Mastering Assistant in Logic Pro: https://support.apple.com/en-gb/108294 (also HT213974)

**Matchering**
- GitHub repo (source read 2026-10-26): https://github.com/sergree/matchering
  - stages.py, defaults.py, dsp.py, utils.py, preview_creator.py, checker.py, stage_helpers/match_levels.py, stage_helpers/match_frequencies.py, limiter/hyrax.py under https://raw.githubusercontent.com/sergree/matchering/master/matchering/
- PyPI (v2.0.6, 2022-10-19): https://pypi.org/project/matchering/

**Suno**
- Suno Help, Remaster: https://help.suno.com/en/articles/8105281
- Suno Help, Exporting from Studio: https://help.suno.com/en/articles/8128193 (via snippet)
- AI Musicpreneur, "Suno mastering: 6 best AI mastering tools" (2026-09-10; affiliate): https://www.aimusicpreneur.com/ai-tools-news/best-ai-mastering-tools-for-suno/
- Jack Righteous, Remaster guide and shimmer/hiss guide (2026): https://jackrighteous.com/en-gb/blogs/guides-using-suno-ai-music-creation/suno-ai-remaster-guide-v4 , https://jackrighteous.com/en-gb/blogs/guides-using-suno-ai-music-creation/reduce-ai-music-noise-fix-shimmer-hiss-in-suno-ai

**Loudness platform reference**
- Spotify for Artists, Loudness normalization: https://support.spotify.com/us/artists/article/loudness-normalization/

**General dynamics references (secondary)**
- Waves SSL bus compressor guide: https://www.waves.com/how-to-use-ssl-bus-compressor-classic-mix-glue
- Music Guy Mixing, mastering compression: https://www.musicguymixing.com/mastering-compression/
- Mode Audio, Compression 101: https://modeaudio.com/magazine/compression-101-track-bus-master
