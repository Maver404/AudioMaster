# 02 — Audio problems in Suno songs and how to fix them in mastering

Compiled: 2026-10-26. Scope: Suno models v3.5, v4, v4.5, v5, v5.5 and v6 (current). The goal is to turn the evidence into DSP recipes for an automatic "Suno cleanup" stage in a browser-only (vanilla JS + Web Audio) mastering app.

**Confidence legend**, used throughout:

- **[P] Primary**: Suno's help center or release notes, a standards body, a platform's own docs, a manufacturer's manual, or a peer-reviewed paper.
- **[M] Measured**: a secondary source that publishes a measurement method and sample size.
- **[S] Secondary**: vendor blogs, guides, press. Many of these sell a Suno-mastering product, so treat their numbers as directional.
- **[E] Engineering default**: my own proposed starting value, derived from the ranges above. It is not sourced and needs calibration on real files.
- **[!] Conflict or unverified**: sources disagree, or nothing could be verified.

> Research limitation: Reddit (r/SunoAI, r/audioengineering, r/mastering) and YouTube transcripts could not be reached with the available tools. Reddit sentiment is therefore known only second-hand, through press (MusicRadar, EDM.com) and blogs that quote threads. No Suno audio files were downloaded or measured for this report. All file measurements are third-party.

---

## 0. TL;DR (decision-relevant)

1. **Measure first, then process.** The sources contradict each other on raw Suno loudness (from −22 to −8 LUFS), on stereo (either "fake-wide/phasey" or "near-mono"), and on bandwidth (12 kHz to 22 kHz, depending on version). The only large published measurement (n=337 files) gives a median of **−15.3 LUFS and −3.5 dBTP for WAV**, a median LRA of about 5–6.6 LU, a near-mono rate of about 17%, and a top end at or below 17.5 kHz in about 15% of files. The cleanup stage must be **analysis-driven, with every module gated by a detector**, not a fixed preset.
2. **Formats.** MP3 is available on all plans. WAV is Pro/Premier only and web-only [P]. Stems come in 2-stem or up to 12-stem modes, plus "Split from Mix" and "Advanced Split" (about 100 instruments, Premier only). Stems download as MP3, WAV, tempo-locked WAV or MIDI [P]. Suno Studio exports **32-bit WAV** or MP3 and has **no limiter or mastering module** [P]. WAVs that have been measured are **48 kHz / 16-bit stereo** [M]. Reportedly, Suno's served stream is **Opus at about 150 kbps in an MP4 container (".m4a")**, and the WAV is decoded from it, so "WAV" is not a true lossless master [S][!].
3. **Artifacts, in order of how often they come up:**
   - low-mid mud, 200–500 Hz (some sources say 400–800 Hz);
   - harshness, 2–6 kHz;
   - fizz and sibilance, 5–9 kHz, with AI sibilance reaching up to 12–16 kHz;
   - metallic or watery "shimmer" on vocals, cymbals and reverb tails (worst on v4);
   - HF "hash" and top-octave noise, 12–16 kHz;
   - a missing top end. Reported ceilings are about 12 kHz on v3/v3.5, about 16 kHz on v4/v4.5 and about 20 kHz or more on v5+. v6 is widely reported as "muffled" with buried vocals;
   - baked-in reverb "sheen", mostly in the sides;
   - a phasey low end below about 200 Hz;
   - occasional true-peak overs (10% of WAVs and 22% of MP3s exceed −1 dBTP);
   - abrupt endings.
4. **What mastering can fix:** tonal balance, done with small cuts of 1–3 dB, mostly dynamic. It can also fix low-end mono, peaks and loudness, and fades. **What it cannot fix:** shimmer or warble baked into the generation, garbled vocals, or missing bandwidth. A boost into an empty band only amplifies hash. Every guide says the same thing: be conservative, cut before you boost, A/B at matched loudness, and don't master loud (above about −11 LUFS) because loudness exposes artifacts.
5. **Recommended cleanup order**, consolidated across sources:
   1. analyze;
   2. remove DC and rumble;
   3. set headroom;
   4. apply corrective dynamic EQ (mud, harshness, fizz);
   5. de-ess (mid channel, multiband);
   6. control HF hash and shimmer (side-channel and HF dynamic);
   7. optionally denoise stationary hiss;
   8. mono the bass and check correlation;
   9. optionally restore dynamics;
   10. optionally add "air" with an exciter, only after harshness is controlled and only if the band is clean;
   11. hand off to mastering (tone match, glue, true-peak limiter);
   12. apply the end fade and dither.

---

## 1. Suno model timeline (official release notes [P])

| Date | Release | Audio-relevant note |
|---|---|---|
| 2024-05-24 | v3.5 early access | Pro/Premier can generate and download **.wav** |
| 2024-05-30 | v3.5 for everyone | — |
| 2024-07-23 | Instrumental + vocal stems | 2-stem split for Pro/Premier |
| 2024-11-19 | **v4** | "Better audio", plus a **Remaster** feature to upgrade older tracks |
| 2025-05-01 | **v4.5** | Richer vocals and more complex sounds |
| 2025-06-03 | Stem extraction up to **12 stems** | — |
| 2025-09-23 | **v5** | "Clearer, more immersive audio"; remaster to v5 |
| 2025-09-25 | Suno Studio | Generative workstation with stems and audio/MIDI export |
| 2025-10-21 | v4.5-all | Free model |
| 2026-03-26 | **v5.5** | "Sharper vocals, more dynamic sound" |
| 2026-06-11 | Stem separation improvements | 3 extraction modes; Suno claims "free from artifacts" |
| 2026-08-13 | Studio 2.0 (Premier) | Built-in effects: EQ, compressor, gate, reverb, delay, distortion, convolution. **No limiter or mastering** |
| 2026-09-02 | Studio update | Less wavetable aliasing; fixed missing MP3/MIDI in exports |
| 2026-09-09 | **v6 / v6-wild / v6-mini** | All earlier models **retired**. Old songs can still be played, remastered and covered. v6-mini is free; v6 and v6-wild are Pro/Premier |

Implication: users will bring files from **every** generation. The app cannot assume one artifact profile, so it should infer a profile from the spectrum (see §7.4).

---

## 2. Export formats and technical specs

### 2.1 What Suno officially offers [P]

| Format | Who | Notes |
|---|---|---|
| MP3 | All plans, web and mobile | Free plan gets a "lightweight mp3". **Suno does not publish the bitrate** [!] |
| WAV | Pro and Premier, **web only**; mobile defaults to MP3 | Sample rate and bit depth are not published |
| Video | All | Song-as-video download |
| Stems | Pro and Premier | **Auto Split**: up to 12 stems, 50 credits. **Split from Mix**: one instrument plus its complement, 10 credits per stem. **Advanced Split** (Premier only): choose from about 100 instruments, 10 credits per stem. Downloads as MP3, WAV, tempo-locked WAV, MIDI, or WAV+MIDI. Downloading stems does not count against the song's download limit |
| Studio export | Studio 2.0 (Premier) | Full song, a selected range, or **multitrack** (all tracks as stems). Format is **32-bit WAV or MP3**; one older help page says only "high-quality WAV". MIDI from stems costs 10 credits |
| MIDI | Premier, for Studio songs | — |

Download caps reportedly began on 2026-09-03: Free gets 7 lifetime, Pro 20/month, Premier 60/month [S, TrackGleam citing Suno; not verified on Suno's site].

### 2.2 Sample rate, bit depth and bitrate (third-party evidence)

| Claim | Source | Grade |
|---|---|---|
| WAV = **48 kHz / 16-bit stereo**. All 19 Suno-tagged WAVs (Jan–Sep 2026) matched, and 209 older WAVs matched too | TrackGleam library measurement | [M] |
| WAV = "48 kHz 16-bit PCM", **decoded from Suno's Opus stream at about 150 kbps** | Unifically API docs (updated 2026-10-12) | [S] |
| Served audio is **Opus in an MP4 container (.m4a)**; MP3/WAV from downloaders are on-device transcodes | chunks.md downloader docs | [S] |
| m4a-opus media URL: about 4.7 MB for a 5-minute track (about 125 kbps), apparently encrypted. Raw CDN mp3 returns 403 | GitHub issue gcui-art/suno-api #289 (2026-08-29) | [S] |
| WAV = 44.1 kHz / 16-bit | sunodownloader.ai blog (unsourced) | [S][!] |
| WAV = 48 kHz / 24-bit | Maxify Audio (Dec 2024) | [S][!] |
| MP3 bitrate: 128 kbps free, 192 Starter, 320 Pro | CometAPI (reseller) | [S][!] |
| v4 output is 48 kHz MP3 at 128–192 kbps | Undetectr FAQ | [S][!] |
| v6 MP3s decode at 48 kHz | TrackGleam (n=2) | [M] |
| **Native generation rate**: v3/v3.5 = **24 kHz** (so nothing above 12 kHz); v4/v4.5 = 24 kHz upsampled (about 16 kHz bandwidth); v5/v5.5 = **44.1 kHz native**; v5.5 on Premier = 48 kHz. The same article elsewhere says Suno generates "natively at 32 kHz internally" | Undetectr version comparison (2026-09-25); repeated by Replayed Studio | [S][!] internally inconsistent |
| Suno v5 recordings are 44,100 Hz | Deezer research, arXiv 2607.27454 v2 (2026-07-31) | [P] for the dataset only |

The two rates are not incompatible. Generation can happen at 44.1 kHz while delivery goes through an Opus pipeline, and Opus always decodes at 48 kHz.

**Plausibility check [P]:** Suno's open-source TTS model **Bark** uses **EnCodec** tokens (github.com/suno-ai/bark), and EnCodec's standard model runs at 24 kHz. So a 24 kHz neural-codec origin for early Suno music models is plausible, but it is not confirmed for the music models.

### 2.3 Implications for the app

- **Supported inputs.** Handle MP3, WAV (16-bit, 24-bit and **32-bit float**, since Studio exports may exceed 0 dBFS because Studio has no limiter, an inference [E]), M4A with **AAC or ALAC** (Apple) and **M4A with Opus** (Suno's served stream, via downloaders), plus FLAC.
- **Safari.** It could not `decodeAudioData` Opus-in-MP4 until WebKit bug 307632 (fix committed 2026-03-12; the shipping Safari version is unknown) [P][!]. Provide a fallback decoder (WebCodecs `AudioDecoder`, or an ffmpeg/opus wasm build) and feature-detect it.
- **Internal rate.** Process at the file's native rate, usually 48 kHz, in Float32. Resample to 44.1 kHz only if the user picks a 44.1 deliverable.
- **Source-quality badge.** Treat every Suno file as having already been through a lossy codec. A WAV is not more "lossless" than the Opus stream it came from. Recommend **WAV or original M4A over MP3**, because MP3 adds one more lossy generation. Never re-encode lossy to lossy for the master [S, TrackGleam].

---

## 3. Measured baseline of raw Suno files

### 3.1 The best available dataset: TrackGleam library study [M]

Method: ITU-R BS.1770-4 gated loudness, 4× true peak, validated on EBU Tech 3341/3342. n = 337 downloads (218 WAV, 119 MP3), Feb 2024 – Sep 2026, mixed versions, from one creator's library.

| Metric | WAV (n=218) | MP3 (n=119) |
|---|---|---|
| Integrated loudness, median (middle 80%) | **−15.3 LUFS** (−16.3 to −14.0) | −14.4 LUFS (−16.0 to −12.2) |
| Share quieter than −14 LUFS | 89% | 65% |
| True peak, median | **−3.5 dBTP** | −2.1 dBTP |
| True peak above −1 dBTP | 10% | 22% |
| Near-mono (L/R correlation above 0.95 in at least half of the 1-second windows) | 17% | 18% |
| HF ceiling at or below 17.5 kHz | 14% | 16% |
| Clipping (3+ consecutive full-scale samples) | 0 | 1 file |

Other figures from the same source:

- Loudest file: −10.5 LUFS.
- Median LRA: about 5 LU. A separate 12-file set gave 6.6 LU.
- Peak-to-loudness gap (PLR): about 12–13 dB.
- **v6** (2 takes): −15.8 and −15.7 LUFS; −2.55 and −2.43 dBTP; correlation 0.88 and 0.84.

v5.5 vs v6, 7 matched pairs (AI Musicpreneur, via TrackGleam, 2026-09-18) [S]:

- v6 has **less 2–10 kHz harshness** (7/7);
- **wider dynamic range** (7/7);
- **more energy below 120 Hz** (6/7);
- **a noisier top octave** (7/7);
- a wider stereo image (5/7);
- less steady vocals in the second half of the song (5/7).

The effect of Suno's **Remaster** feature was measured by one user on note.com (2026-09-15), via TrackGleam [S]:

- Subtle, Normal and High lift **6–10 kHz by about +2, +7 and +10 dB**;
- the Boost variants add about +2 dB of sample peak;
- the Natural variant cuts 10–20 kHz by about 3.4 dB.

A "Remastered (High)" file therefore arrives very bright in 6–10 kHz.

### 3.2 Conflicting loudness claims [!]

| Claim about raw Suno loudness | Source |
|---|---|
| −20 to −22 LUFS | Maxify Audio (Dec 2024) [S] |
| −18 to −22 LUFS, and "often peaks at 0 dBFS" | Magic Master (2026-08) [S] |
| −14 to −19 LUFS; one example at −16 LUFS / −0.5 dBTP | Transientik (2026-06) [S] |
| Median −15.2 LUFS (n=12); −15.3 LUFS (n=218 WAV) | TrackGleam [M] |
| −8 to −12 LUFS ("louder than streaming targets") | Dynamoi (2026-06); Replayed Studio [S] |

**Conclusion:** the measured data point to **about −15 LUFS with 3–4 dB of true-peak headroom, which is not crushed**. Claims that Suno output is "pre-squashed at −8 LUFS" are not supported by measurement for recent files, though older versions or specific genres may differ. **The app must measure every file.** It must not assume the file is quiet, and it must not assume it is crushed.

---

## 4. Artifact catalogue

Each entry gives what the artifact is, where it sits in frequency, which versions are affected, the evidence, and whether mastering can fix it.

| # | Artifact | Band / location | Versions | Evidence | Mastering-fixable? |
|---|---|---|---|---|---|
| A1 | **Missing top end / brick-wall ceiling.** A dull, "muffled" sound; the cutoff can drift upward over the song (e.g. 13→15 kHz) | Ceiling at about 12 kHz (v3/v3.5), about 15–16 kHz (v4/v4.5), about 20 kHz or more (v5/v5.5). v6 is reported muffled with buried vocals (tone, not necessarily bandwidth) | All, decreasing with newer versions | NeuralAnalog, Undetectr, Replayed [S]; ≤17.5 kHz in about 15% of the library [M]; v6 backlash in MusicRadar 2026-09-17 and EDM.com [S] | **Partially.** An exciter or bandwidth extension can synthesize "air". EQ alone cannot create missing content, and boosting an empty band amplifies hash [S, several] |
| A2 | **Metallic shimmer / "watery" / "phasey".** A glassy, moving synthetic texture on vocals, cymbals and reverb tails; warble on sustained notes; "granular residue" | Mostly 6–16 kHz, moving with the music | Strongest on **v4** ("signature shimmer"); much reduced in v4.5 and v5+ | Jack Righteous, Replayed, Undetectr, YouTube "fix the shimmer effect in Suno v4" [S] | **Mostly no.** It can be masked or reduced by about 2–3 dB with side and HF dynamic control. A static noise print fails because the texture follows the instruments [S, Sunofix] |
| A3 | **Digital fizz** (codec-synthesis harshness on hi-hats and sibilants) | **5–8 kHz** (cut about 2–3 dB around 6 kHz) | All | MixMasterAI, Replayed [S] | Yes: dynamic EQ or de-esser |
| A4 | **HF "hash" / quantization noise / top-octave noise** | **12–16 kHz** | All; v6 has a noisier top octave than v5.5 [S] | MixMasterAI (shelf −2 to −3 dB at 14 kHz), Replayed (14–16 kHz shelf) [S] | Partially: gentle shelf or dynamic cut, and side-only HF reduction |
| A5 | **Steady hiss / noise floor**, most audible between phrases and in intros and outros | Broadband, mainly above 6 kHz | All | Jack Righteous, Sunofix [S]. Deezer paper: architectural upsampling artifacts sound like a "hissing noise" [P] | Yes, if stationary: light spectral denoise. Heavy denoise creates "musical noise" (chirpy, watery) [P, iZotope RX docs] |
| A6 | **Harsh upper mids** | **2–6 kHz** (vocals 3–6 kHz; guitars and synths brittle) | All; v6 measured less harsh than v5.5 | RoEx, Undetectr (2–4 kHz narrow −2 to −3 dB), Transientik (wide dip 4–8 kHz), Magic Master ("glare") [S] | Yes: dynamic EQ, 1–3 dB |
| A7 | **Sibilance** | Classic band **5–9 kHz** (4–10 kHz). AI vocals can extend to **12–16 kHz** | All | TrackGleam, Dubspot (5–8 kHz), Maxify (4–8 kHz), Sonarworks (AI 12–16 kHz) [S] | Yes: mid-channel multiband de-ess, 3–6 dB at most |
| A8 | **Low-mid mud / boxiness** | **200–500 Hz** (most sources); **400–800 Hz** (MixMasterAI, "cut 3–5 dB at 500 Hz") [!] | All; v3 congestion 200 Hz–2 kHz | Many [S] | Yes: dynamic EQ, −1 to −3 dB, at the detected peak |
| A9 | **Low-end problems** | Boom at **100–150 Hz** (v3); weak sub at **20–60 Hz**; rumble **below 30 Hz** eating limiter headroom | Version-dependent; v6 has more energy below 120 Hz | Undetectr, TrackGleam, Sunofix [S] | Yes: HP at 20–35 Hz, small bell cut, small sub shelf |
| A10 | **Unstable / fake stereo.** Width made by phase shift, which wanders or cancels in mono, worst in the bass | Below about 200 Hz is critical; "phase smear below 200 Hz" | All | MixMasterAI, Replayed, RoEx (stems) [S]. Counter-evidence: 17% of files are near-mono [M]; others call Suno "narrow, centre-focused" [S][!] | Yes for the low end (mono the bass below 80–150 Hz). Widening is optional and risky |
| A11 | **"Suno sheen".** Baked-in diffuse reverb or ambience that sounds artificial, especially on vocals | Mostly in the **side** channel | All | RoEx, TrackGleam [S] | Only reducible (M/S EQ and dynamics). Full-mix de-reverb is discouraged [S, Sunofix] |
| A12 | **Dynamics.** "Pre-squashed", sections equally intense, soft transients | Full band | Claimed for all [S] | Measured LRA about 5–6.6 LU and PLR about 12–13 dB [M], so this is **not** brick-walled [!] | Partially: gentle upward expansion or transient shaping restores 2–4 dB [S, MixMasterAI 1.2:1] |
| A13 | **True-peak overs / clipping** | — | 10% of WAVs and 22% of MP3s exceed −1 dBTP; clipping is rare | TrackGleam [M]; "exports often peak at 0 dBFS" [S][!] | Yes: gain staging and TP limiting |
| A14 | **DC offset** | 0 Hz | **No Suno-specific evidence found** [!] | General: DC causes clicks at file boundaries; a 15–20 Hz HP or mean removal fixes it [S, forums] | Yes, and cheap. Always run it |
| A15 | **Abrupt endings / repetitions / long tails** | Time domain | All. Late-song decline on long v6 tracks [S] | Jack Righteous guides (crop first, leave a small tail, fade matched to the material) [S] | Yes for the fade. A structural problem means regenerating or cropping in Suno |
| A16 | **Late-song degradation** (vocal steadiness, "underwater" quality, repetition) | Time-varying | v6, long tracks | TrackGleam / Jack Righteous user reports [S] | **No.** Regenerate the section |
| A17 | **Stem-separation artifacts** (bleed, swirls, lost transients, phase between stems) | Varies | Any stems | RoEx, Jack Righteous, AI Central (acoustic guitar and strings separate poorly) [S] | Out of scope for a stereo master. Warn the user |
| A18 | **Regular spectral peaks** ("checkerboard" fingerprint from deconvolution/upsampling layers) | Peaks at integer multiples of the layer input rate; EnCodec strides {8,5,4,2} give 161 peaks | Detected at about 100% on Suno v2/v3/v3.5 | Afchar et al., Deezer, ISMIR 2025 (arXiv 2506.19108) [P] | Not practical to remove (positions are unknown for closed models). Low audibility; it contributes to "hiss" |

---

## 5. What engineers recommend: the numbers consolidated

"Agreement" counts how many independent sources give compatible values.

| Move | Values reported | Agreement | Sources |
|---|---|---|---|
| High-pass / rumble | 20–50 Hz (auto); **30 Hz**; test **30–35 Hz**; 30–40 Hz on non-bass stems; "below 30 Hz" | High | TrackGleam, Maxify, Sunofix, Dubspot, Undetectr |
| Low-mid mud | Broad cut **−1 to −3 dB at 200–500 Hz**; −2 to −3 dB around 300 Hz; **−3 to −5 dB at 500 Hz, medium Q** (an outlier); dynamic cuts at 250 and 500 Hz | High on the band; the amount varies | Undetectr, Maxify, Dynamoi, MixMasterAI, TrackGleam, Replayed |
| Boom | Narrow cut at 100–150 Hz if boomy | Low | Undetectr |
| Sub | Wide **+1 to +2 dB at 20–60 Hz** (only after HP) | Low | Undetectr |
| Harshness | Narrow **−2 to −3 dB at the peak in 2–6 kHz**; **−1 to −3 dB at 2–4 kHz**; gentle wide dip at 4–8 kHz | High | Undetectr, Replayed, Transientik, RoEx |
| Fizz | **−2 to −3 dB at about 6 kHz**; notch 5–8 kHz by "a couple of dB" | Medium | MixMasterAI, Replayed |
| Top end (bright files) | High shelf **−1 to −2 dB above 8 kHz**, or −1 to −3 dB from 6–8 kHz; 1–2 dB from 8 kHz | Medium | Dynamoi, Sonarworks |
| HF hash | Shelf **−2 to −3 dB at 14 kHz** (14–16 kHz) | Low (one vendor, echoed) | MixMasterAI, Replayed |
| Air (dull files) | Shelf **+2 to +4 dB at 10–12 kHz and up** [!]; "modest" shelf; exciter 5–12 kHz. All carry warnings about boosting empty bands | **Conflict** | Undetectr, Maxify vs Replayed, NeuralAnalog, TrackGleam |
| De-esser | **5–9 kHz** on the full master, last resort; 5–8 kHz; 4–8 kHz; AI bands 4–8 / 8–12 / 12–16 kHz with attack 5–10 ms (low band) and 1–3 ms (high bands); M/S on the mid channel | High on the band | TrackGleam, Dubspot, Maxify, Sonarworks, iZotope (Zambrano 2020) |
| Corrective EQ ceiling | Each corrective move **at most 1–3 dB** | Very high | Replayed, Undetectr, TrackGleam, Peak-Studios |
| Mono bass | Mono **below 80 Hz**; crossover 80–220 Hz (adaptive); nothing wide below about 200 Hz; reduce sides −2 to −3 dB below 200 Hz | High | MixMasterAI, TrackGleam, Replayed, Dubspot, Peak-Studios |
| Width | Widen at most 10–25% with a mono check; avoid Haas; narrow above 8 kHz with M/S | Low / conflicting | Maxify, Sonarworks, Joytxis (warns against over-widening) |
| Glue compression | **1–2 dB of gain reduction**, no more | High | Transientik, Dubspot, Peak-Studios |
| Multiband compression | At most 2–3 dB of gain reduction; e.g. 20–120 Hz at 2:1, 120 Hz–3 kHz at 3:1, 3 kHz+ at 2:1 | Medium | Dynamoi, Maxify |
| Dynamics restore | Upward expansion at **1.2:1** before the limiter, restoring 2–4 dB of dynamic range | Low | MixMasterAI, Replayed |
| Saturation | Tape 10–20% mix; tube 2nd/3rd harmonics | Low | Maxify |
| Denoise / artifact removal | Artifact removers at **50–70% strength**; vocal de-reverb with **about 70% dry** | Low | Replayed, NeuralAnalog |
| Limiter | **−1.0 dBTP** ceiling (−1.5 for margin); **−2 dBTP if louder than −14 LUFS**; 4× oversampling; attack 1–3 ms; release auto or about 50 ms; at most 3–6 dB of gain reduction | Very high on the ceiling | Spotify [P], Maxify, TrackGleam, Transientik |
| Loudness target | **−14 LUFS** (Spotify, YouTube, Amazon, Tidal); **−16** (Apple Sound Check); −15 (Deezer); "loud" option **−11**; genre range −14 to −11; club −7 to −9 | High | Spotify [P]; others [S] |
| Export | 24-bit WAV; 44.1 or 48 kHz; dither when reducing to 16-bit | High | Replayed, Dynamoi, Magic Master |

Platform loudness facts from a primary source (Spotify for Artists):

- Normal = −14 LUFS, Loud = −11, Quiet = −19 (ITU 1770).
- Keep true peak at or below −1 dBTP, or **below −2 dBTP if the master is louder than −14 LUFS**.
- In Loud mode Spotify's own limiter engages at −1 dB with a 5 ms attack and 100 ms decay.

Apple at −16 LUFS, YouTube at −14 and Deezer at −15 are **secondary-source** values [S][!].

---

## 6. What NOT to do

These pitfalls are consolidated across the sources:

1. **Don't boost before you cut.** Boosting highs on a lossy or band-limited source amplifies codec fizz and hash.
2. **Don't EQ into an empty band.** If the ceiling is 12–16 kHz, a +4 dB shelf at 16 kHz adds only noise. Use harmonic generation sparingly, or nothing.
3. **Don't apply broad treble cuts to "kill artifacts".** The artifact stays and the track just gets darker.
4. **Don't use a fixed noise print on moving shimmer or fizz.** Don't use static cuts for problems that come and go; use dynamic EQ.
5. **Don't use heavy spectral denoise.** It causes musical noise (chirpy, watery) and dulls low-level detail. Apply only as much reduction as you need [P, iZotope].
6. **Don't run broad de-reverb on the stereo mix**, and don't run a whole-mix denoiser when only one element is affected.
7. **Don't add an exciter or limiter before the harsh peaks are controlled.**
8. **Don't treat the de-esser as a general brightness control.** It can duck hats and shakers, so use the mid channel or a keyed approach [P, iZotope].
9. **Don't high-pass so high that the kick and bass lose weight.** Above about 40 Hz on a full mix is risky.
10. **Don't widen with decorrelation or Haas on the full mix.** Never widen below about 200–300 Hz. Watch correlation.
11. **Don't master artifact-heavy audio loud** (−8 LUFS or louder). Loudness and limiting raise shimmer and hiss along with the music.
12. **Don't judge a change without loudness-matched A/B.** Louder always sounds "better".
13. **Don't convert MP3 to WAV expecting better quality.** Don't re-encode lossy to lossy.
14. **Don't stack large corrective moves.** Keep each to 1–3 dB. Several small cuts beat one big one.
15. **Don't try to fix generation problems with mastering** (garbled lyrics, warbling vocals, late-song collapse, bad timing). Tell the user to regenerate or replace the section in Suno.
16. **Don't make separate masters per platform** unless you have a reason. One master at −14 LUFS / −1 dBTP works everywhere.

---

## 7. DSP recipes for the automatic "Suno cleanup" stage

Design principle: **every module is gated by an analysis detector and capped**. The intensity control (Gentle / Balanced / Strong) scales those caps. When the detectors find nothing, the stage should be close to a no-op, apart from the DC and rumble filter, gain staging and edge fades. TrackGleam's own engine works this way: cleanup is blended in only above an "artifact risk" threshold, and two clean v6 takes received none.

### 7.1 Pipeline order

```
decode → [ANALYSIS PASS] → DC/rumble HP → headroom gain → dynamic corrective EQ
(mud / boom / harsh / fizz) → mid-channel multiband de-esser → HF hash & shimmer control
(side-HF dynamic + optional 14k shelf) → optional stationary-hiss spectral denoise
→ low-end mono / stereo safety → optional dynamics restore → optional air exciter
→ [handoff to mastering chain: tonal match, glue, TP limiter] → edge/end fades → dither/export
→ [QC PASS: re-analyse, compare, auto-rollback]
```

All of this can run in an `OfflineAudioContext` plus AudioWorklets, or in plain JS DSP inside a Worker. The detectors need the whole file before processing starts.

### 7.2 Analysis pass: metrics and initial thresholds

Thresholds are **[E]** and must be calibrated on a corpus of real Suno files from v3.5 to v6, plus commercial references.

| Metric | How to compute | Initial trigger [E] |
|---|---|---|
| DC offset | Mean per channel | \|mean\| > 0.0005 (about −66 dBFS) → note it; always HP anyway |
| Sample peak, **true peak** | 4× polyphase oversampling, per BS.1770-4 Annex 2 | TP > −1 dBTP → flag; ≥ 3 consecutive \|x\| ≥ 0.999 → "clipped" |
| Integrated LUFS, LRA, max short-term, PLR | BS.1770-4/5 K-weighting, 400 ms blocks with 75% overlap, gates at −70 LUFS absolute and −10 LU relative; LRA per EBU Tech 3342 | PLR < 8 dB **and** LRA < 3 LU → "crushed" (enables dynamics restore) |
| **Spectral ceiling f_c** | Long-term average spectrum: Hann window, N=8192, hop 4096, excluding frames below −50 dBFS RMS, 1/6-octave smoothing. f_c = the highest f in 10–22 kHz where LTAS(f−300 Hz) − LTAS(f+300 Hz) > 18 dB (a "cliff"). If there is no cliff, f_c = where LTAS falls 50 dB below the 2–8 kHz mean. Repeat per 10 s segment to detect **drift** | f_c < 17.5 kHz → "band-limited / lossy origin" badge; see the profiles in §7.4 |
| Band balance | Energy in bands 20–40, 40–100, 100–150, 150–200, 200–500, 500–2k, 2–6k, 6–10k, 10–16k Hz, compared to a reference tilt curve (commercial average or genre curve; see the tonal-balance doc). Also find the **peak frequency** inside 200–500 Hz and 2–6 kHz at 1/12-octave resolution | Excess > +1.5 dB vs reference → enable that EQ band; the amount scales with the excess |
| Remaster signature | 6–10 kHz excess vs reference | > +5 dB → "brightened" profile: stronger de-harsh, exciter disabled |
| Sibilance events | Mid channel, 5–9 kHz band envelope (5 ms RMS) vs its 1 s moving median; repeat for 10–16 kHz | > 8 dB above the median in > 4 events/min → enable de-esser |
| **Stereo per band** | LR4-split into below 120 Hz, 120–1k, 1k–8k and above 8k Hz; Pearson correlation per band and per 1 s window; S/M energy ratio per band | Correlation below 120 Hz < 0.7 → force mono-bass. Any 1 s window with correlation < 0 → warn. Above 0.95 in > 50% of windows → "near-mono" |
| HF hash / hiss | In the quietest 10% of non-silent frames: 10–16 kHz level and **spectral flatness** in that band. Also measure the intro and outro | Flatness > 0.5 and quiet-frame HF level > −70 dBFS/band → enable denoise; scale with level |
| Shimmer index (experimental) [E][!] | (a) Side-to-mid ratio above 8 kHz; (b) 4–20 Hz modulation energy of the 6–16 kHz envelope that is *not* coincident with broadband transients (onset-masked) | S/M_HF > −6 dB **and** modulation above the 80th percentile of the reference → enable side-HF dynamic control. No validated metric exists in the literature; calibrate before shipping |
| Ending | RMS of the last 200 ms vs the preceding 3 s; level of the final sample; trailing silence below −60 dBFS | Last 200 ms within 6 dB of the preceding 3 s and > −30 dBFS → "abrupt ending"; final \|sample\| > −50 dBFS → needs a micro-fade |
| Leading silence | First sample above −60 dBFS | Trim to 50–150 ms of pre-roll [E] |

### 7.3 Processing modules: parameters

Values are given as default (range). The intensity multiplier k is Gentle 0.5, Balanced 1.0, Strong 1.5 and applies to *maximum gain changes only*. Frequencies stay detector-driven.

**M1 – DC and rumble filter (always on).**

- Fix DC with a 1-pole DC blocker (about 5 Hz).
- Then a high-pass: Butterworth, 2nd order (12 dB/oct), **25 Hz** (20–35 Hz).
- Use 30–35 Hz only if energy below 30 Hz exceeds the reference by > 3 dB.
- Never go above 40 Hz on the full mix.
- Sources: TrackGleam, Sunofix, Maxify, Dubspot [S]; DC forums [S].

**M2 – Headroom.**

- Apply static gain so the true peak is about **−6 dBTP** before processing (float internally, so this is only for the detector and limiter math).
- Magic Master suggests about −3 dB of peak headroom [S].

**M3 – Dynamic corrective EQ.** One band per detected problem. Peaking filter driven by a sidechain bandpass at the same frequency and Q. RMS detector: attack 10 ms, release 120 ms. Ratio 2:1 above an auto-threshold equal to the band's running median plus 2 dB. The static floor cut is half the maximum cut.

| Band | Center | Q | Max cut × k | Enable |
|---|---|---|---|---|
| Mud | detected peak in **200–500 Hz** (default 300 Hz). If the peak is at 500–800 Hz, follow it (MixMasterAI) | 0.9 (0.7–1.4) | **−2.5 dB** (cap −4) | excess > 1.5 dB |
| Boom | detected peak in 100–150 Hz | 1.4 | −2 dB (cap −3) | excess > 2 dB |
| Harsh | detected peak in **2–6 kHz** | 2.0 (1.2–3.0) | **−2.5 dB** (cap −4) | excess > 1.5 dB |
| Fizz | 6 kHz (5–8 kHz, detected) | 2.0 | −2.5 dB (cap −3.5) | excess > 1.5 dB or remaster signature |

Rule: the **total static plus dynamic cut in any one octave is capped at −4 dB** at Strong intensity. Sources: §5 [S].

**M4 – De-esser.** Multiband, **mid channel only**, split-band (it reduces the band rather than the whole signal).

- Band A: **5–9 kHz** (detection 4.5–10 kHz). Threshold auto, set at 6–8 dB above the band median. Max reduction **4 dB × k** (cap 6). Attack 5 ms (3–10). Release 60 ms (40–100). Lookahead 3 ms.
- Band B (AI sibilance): **10–16 kHz**. Max reduction 3 dB × k. Attack 2 ms (1–3). Release 50 ms.
- Sources: TrackGleam, Dubspot, Sonarworks (AI bands and attacks), iZotope M/S de-essing [S][P].

**M5 – HF hash and shimmer control.**

- (a) **Side-channel HF dynamic cut:** high-shelf at **8 kHz** on S only. Max **−3 dB × k**, attack 5 ms, release 150 ms. Triggered by the S/M_HF excess. This narrows synthetic HF width and "sheen" without touching the centre vocal.
- (b) **Static high shelf at 14 kHz:** −1.5 dB (−1 to −3) × k. Only if the hash index triggers *and* the file is not band-limited (f_c ≥ 17 kHz). There is no point cutting an empty band.
- Sources: Sonarworks (M/S narrowing above 8 kHz), MixMasterAI and Replayed (14–16 kHz shelf), TrackGleam (sheen sits in the sides), ComfyUI HF-repair node (side HF from 8 kHz, for a different generator) [S].

**M6 – Stationary hiss denoise.** Optional; default OFF unless the hiss detector fires.

- STFT, Hann, **N = 2048 at 48 kHz (about 43 ms)**, hop N/4.
- Noise profile: per-bin minimum statistics over about 1.5 s, or the median of the quietest 5% of frames.
- Gain: Wiener-style, with **max reduction 6 dB × k (cap 10 dB)**, applied **only above 6 kHz**. Smooth the gain over ±2 bins and in time (attack 5 ms, release 150 ms) to suppress musical noise.
- Keep the residual noise shape (no whitening). Never gate fully.
- Source: iZotope RX 9 Spectral De-noise docs (threshold default about 0 dB; strong suppression degrades low-level signal; smoothing and higher-quality algorithms reduce musical noise) [P]. Values are [E].

**M7 – Low-end mono and stereo safety.**

- **Mono-bass:** high-pass the **side** channel at **100 Hz** (adaptive 80–150 Hz). Use LR4 (24 dB/oct) for a clean crossover, or a 2nd-order HP on S for a gentler transition.
  - Raise it to 120–150 Hz if the correlation below 120 Hz is < 0.5.
  - Use 80 Hz if the file is near-mono already.
  - TrackGleam uses 80–220 Hz adaptively; MixMasterAI uses 80 Hz and also cuts S by 2–3 dB below 200 Hz [S].
- **Width:** default 0 (no widening).
  - Near-mono files: optional S gain of +1 to +1.5 dB above 1.5 kHz only (about +10–15% width), *only if* the post-check keeps the global correlation ≥ +0.3 and no band goes below 0 [E].
  - No Haas, no all-pass decorrelation [S].
- Sources: Dubspot, Peak-Studios, Sonible correlation guide [S].

**M8 – Dynamics restore.** Only if "crushed" (PLR < 8 dB and LRA < 3 LU). Per §3, it is expected to be rare.

- Gentle upward expansion: ratio **1:1.15** (1.1–1.2), RMS window 30 ms, release 200 ms, about 3 dB at most.
- Or a transient shaper giving +1 to +2 dB on attacks above 1 kHz.
- Source: MixMasterAI (1.2:1, restores 2–4 dB) [S].

**M9 – Air / bandwidth restoration.** Optional and the **last** corrective step.

- Enable when f_c < 16 kHz, or when HF is more than 3 dB below reference, **and** the hash/hiss index is low, **and** there is no remaster signature.
- **Harmonic exciter:**
  - Source band: bandpass from f_c/2 to f_c (e.g. 6–12 kHz).
  - Waveshaper: soft clip (tanh) or a Chebyshev mix of mostly 2nd harmonic with some 3rd, using `WaveShaperNode.oversample = '4x'`.
  - Post-filter: high-pass at about f_c − 500 Hz.
  - Mix the generated signal at **−24 dB (−30 to −18) × k** relative to the dry signal (about 3–12% wet). Keep it mid-dominant to avoid fake width.
- **Shelf:** +1 dB at 10–12 kHz × k (cap +2 dB). Never boost above f_c.
- Run it **after** de-harsh and de-ess (Sunofix).
- Evidence: NeuralAnalog (ML bandwidth extension to 20 kHz); Ozone Exciter docs (oversampling reduces aliasing; harmonic modes) [P]; Undetectr (+2–4 dB shelf, conflicting with the warnings) [S]. Keep the boost conservative.
- ML bandwidth extension (e.g. spectral band replication or GAN-based) is out of scope for the vanilla-JS MVP.

**M10 – Edge and end fades.**

- Always: 5 ms fade-in after the trimmed pre-roll, and a 10–50 ms fade-out at the final sample. The forum fix for boundary clicks is about 50 ms [S].
- Abrupt ending detected: offer an **auto fade-out of 2.5 s (1–6 s)**, equal-power or exponential, ending at −60 dBFS or below. Keep a 0.5–1 s silent tail.
- Short fades suit hard endings; long fades suit ambient tracks [S, Jack Righteous]. Make this a visible toggle, because it changes the music.

**M11 – Handoff to mastering** (covered in the mastering-chain doc; these are the Suno-relevant constraints):

- Glue compression: at most 1–2 dB of gain reduction.
- Multiband: at most 2–3 dB per band.
- Limiter: 4× oversampled true-peak detection, lookahead 1.5–5 ms, release 50–200 ms (program-dependent), at most 3–6 dB of gain reduction.
- **Ceiling −1.0 dBTP, automatically −2.0 dBTP when the target is louder than −14 LUFS** [P Spotify].
- Destination presets:

| Preset | Target |
|---|---|
| Streaming (default) | −14 LUFS |
| Apple | −16 LUFS |
| Loud | −11 LUFS / −2 dBTP |
| Club | −8 to −9 LUFS, with a warning that artifacts become more audible |

- Dither: TPDF on 16-bit export.

### 7.4 Profile auto-detection (no user input needed) [E][!]

Profiles are inferred from the measured spectral ceiling f_c and tonal indexes. The version mapping is approximate and comes from secondary claims.

| Profile | Detector | Likely origin | Cleanup emphasis |
|---|---|---|---|
| **Legacy band-limited** | f_c ≈ 11–13 kHz | v3 / v3.5 (24 kHz native) | Exciter on (Balanced), no 14 kHz shelf, mud and harsh EQ, stronger hiss check |
| **Mid band-limited** | f_c ≈ 14.5–17 kHz | v4 / v4.5 | Shimmer control (M5a) at full strength, fizz, gentle exciter |
| **Full-band** | f_c ≥ 18 kHz | v5 / v5.5 (44.1 kHz) | Mainly mud, harshness and de-ess; 14 kHz hash shelf if triggered |
| **Muffled full-band** | f_c ≥ 18 kHz but 6–16 kHz more than 3 dB below reference, and more energy below 120 Hz | v6 (reported) | Gentle air shelf and exciter, low-mid cut, check the noisy top octave before boosting |
| **Brightened** | 6–10 kHz more than 5 dB above reference | Suno "Remaster High/Normal" | Stronger harsh, fizz and de-ess; exciter disabled |

### 7.5 Intensity mapping (user-facing "Cleanup" slider)

| Parameter | Gentle | Balanced | Strong |
|---|---|---|---|
| Max dynamic EQ cut per band | −1.25 dB | −2.5 dB | −3.75 dB (cap −4) |
| De-esser max (band A / B) | 2 / 1.5 dB | 4 / 3 dB | 6 / 4.5 dB |
| Side-HF cut max | −1.5 dB | −3 dB | −4.5 dB |
| Denoise max (if triggered) | 3 dB | 6 dB | 9 dB |
| Exciter mix | −30 dB | −24 dB | −19 dB |
| Mono-bass crossover | 80 Hz | 100 Hz | 120 Hz (150 Hz if correlation < 0.5) |

### 7.6 QC and guardrails (automatic)

After processing, re-run the analysis and roll back module by module if any check fails [E]:

1. Every A/B in the UI is **loudness-matched** to the same integrated LUFS (required by every source).
2. The broadband HF level (8–16 kHz) must not drop more than 3 dB vs the input, unless the brightened profile is active. This prevents the "dull after cleanup" failure.
3. Correlation must stay ≥ +0.2 globally and ≥ +0.7 below 120 Hz. No band may have a negative correlation.
4. The output true peak must be ≤ the ceiling (measured at 4×), integrated loudness within ±0.5 LU of the target, and no clipped runs.
5. Total EQ deviation from the input must stay within ±4 dB in any 1/3 octave.
6. Late-song checks: per-segment f_c drift above 2 kHz, or vocal instability, means **inform the user** that this is a generation problem and that they should regenerate or replace the section in Suno. Don't try to "fix" it.
7. Show plain-language findings, for example: "Top end limited at 15.8 kHz – added light air", "Harsh peak at 3.4 kHz reduced up to 2.5 dB", "Bass made mono below 100 Hz".

### 7.7 Web Audio implementation notes

- **Static filters:** `BiquadFilterNode` covers HP, peaking and shelves. For automation-free offline rendering, a JS biquad (RBJ cookbook) gives deterministic results.
- **Dynamic EQ, de-esser, expander and limiter:** these need an **AudioWorklet**, or JS DSP in a Worker, for sidechain detection, lookahead and 4× true-peak oversampling. `DynamicsCompressorNode` has fixed internals and no true-peak mode, so it is unsuitable for the final limiter.
- **M/S:** use `ChannelSplitter` and `ChannelMerger` with gain matrices, M = (L+R)/2 and S = (L−R)/2, or do it in a worklet.
- **Exciter:** `WaveShaperNode` with `oversample='4x'` to limit aliasing.
- **Spectral denoise and LTAS analysis:** use an FFT library in a Worker (e.g. a radix-2 real FFT). For 5-minute files, process in chunks to keep memory bounded: 48 kHz × 2 ch × 300 s × 4 B ≈ 115 MB per float copy.

---

## 8. Open questions and uncertainties to resolve with real files

1. Suno's actual MP3 bitrate per plan, and whether the paid WAV is a separate rendition or decoded from the about 150 kbps Opus stream. Sources conflict, and Suno publishes nothing. **Measure with ffprobe and a spectrogram.**
2. Native generation rate per version (24 vs 32 vs 44.1 kHz claims) and the real f_c per version. Calibrate the §7.4 thresholds.
3. Whether Suno stereo is typically "fake-wide/phasey" or "near-mono". Both are reported; the measured data show 17% near-mono. Calibrate the stereo thresholds.
4. Raw loudness differences between versions and genres. The −8 LUFS claims vs the −15 LUFS measurements are unresolved for older or loud genres.
5. A validated "shimmer" metric. None exists in the literature found; the index in §7.2 is a heuristic.
6. Whether DC offset ever occurs in Suno exports. No evidence was found. Keep the cheap fix.
7. Which Safari version ships Opus-in-MP4 `decodeAudioData` (WebKit 307632).
8. Reddit engineer consensus (r/audioengineering, r/mastering) could not be checked directly.

Recommended next step: build a **calibration corpus** of 20–40 Suno files (v3.5 through v6, WAV, MP3 and M4A, several genres, some remastered) plus 10–20 commercial references. Run the §7.2 analyzer on it and fix the thresholds before shipping the auto mode.

---

## Sources

Dates are publication or last-update dates as shown; "n.d." means no date shown. Accessed 2026-10-26.

**Primary**
- Suno release notes (v3.5 → v6, stems, Studio): https://suno.com/release-notes
- Suno Help, "What types of files can I download?" (n.d.): https://help.suno.com/en/articles/13926081
- Suno Help, "Why can't I download wav files?" (n.d.): https://help.suno.com/en/articles/2479873
- Suno Help, "How do I get stems?" (about 2026-09): https://help.suno.com/en/articles/13925185
- Suno Help, "Exporting from Studio" (n.d.): https://help.suno.com/en/articles/8128193
- Suno Help, "Introducing Suno Studio 2.0" (32-bit WAV/MP3 export, effect list): https://help.suno.com/en/articles/13670529
- Suno Help, v6 FAQ (models, retirement of earlier models): https://help.suno.com/en/articles/13924481
- Suno Bark repo (EnCodec tokens): https://github.com/suno-ai/bark
- Spotify for Artists, Loudness normalization: https://support.spotify.com/us/artists/article/loudness-normalization/
- Afchar, Meseguer-Brocal, Akesbi, Hennequin, "A Fourier Explanation of AI-music Artifacts", ISMIR 2025: https://arxiv.org/html/2506.19108v1
- Dugelay et al. (Deezer), "Improved Robustness in AI-Generated Music Detection", arXiv 2607.27454 v2 (2026-07-31): https://arxiv.org/html/2607.27454v2
- iZotope RX 9 Spectral De-noise help: https://s3.amazonaws.com/izotopedownloads/docs/rx9/en/spectral-de-noise/index.html
- iZotope Ozone 8/9 Exciter help: https://s3.amazonaws.com/izotopedownloads/docs/ozone9/en/exciter/index.html
- iZotope (Oscar Zambrano), "De-essing a Master" (2020-03-24): https://www.izotope.com/en/learn/de-essing-a-master-tools-tips-and-tricks.html
- WebKit bug 307632 (Opus in MP4 decodeAudioData): https://bugs.webkit.org/show_bug.cgi?id=307632

**Measured (secondary, with method)**
- TrackGleam, "Why Is My Suno Song So Quiet?" (2026-07-30, updated 2026-09-29), n=337: https://trackgleam.com/learn/suno-song-too-quiet
- TrackGleam, "Suno v6 Mastering" (checked 2026-09-29): https://trackgleam.com/learn/suno-v6-mastering
- TrackGleam, "Why Your Suno Song Sounds Off" (2026-07-12, updated 2026-09-29): https://trackgleam.com/learn/suno-sounds-bad
- TrackGleam, "How to Master a Suno Song" (2026-07-12, updated 2026-09-29): https://trackgleam.com/learn/master-suno-songs

**Secondary (guides, vendors, press)**
- Replayed Studio, "Suno Artifacts and Mastering" (2026, n.d.): https://replayedstudio.com/blog/why-suno-song-sounds-bad/
- Undetectr, "Suno AI Audio Quality" (updated, n.d.): https://undetectr.com/blog/suno-ai-audio-quality-improvement
- Undetectr, "Suno V6 vs 5.5 vs 5 vs 4.5" (updated 2026-09-25): https://undetectr.com/blog/suno-version-comparison-distribution
- NeuralAnalog, "Improve Suno AI audio quality" (2026-05-19): https://neuralanalog.com/docs/improve-suno-ai-audio-quality
- Dynamoi, "Master AI Music for Streaming" (2026-01-12, modified 2026-06-03): https://dynamoi.com/learn/ai-music-distribution/how-to-master-ai-music-for-streaming
- MixMasterAI, "AI Music Fixer" (2026, n.d.): https://www.mixmasterai.co/mastering/fix
- RoEx, "How to Mix and Master Your Suno Tracks" (2026-02-23): https://www.roexaudio.com/blog/how-to-mix-and-master-your-suno-tracks-(and-actually-sound-professional)
- RoEx, "Suno Stems Sound Bad?" (2026-06-29): https://www.roexaudio.com/blog/suno-stems-sound-bad-here-is-why-and-how-to-fix-them
- Jack Righteous (G. Whittaker), "Reduce AI Music Noise: Fix Shimmer, Hiss" (2025-02-06, updated 2026-08/10): https://jackrighteous.com/en-us/blogs/guides-using-suno-ai-music-creation/reduce-ai-music-noise-fix-shimmer-hiss-in-suno-ai
- Jack Righteous, "Fix Suno Songs That Repeat or Won't End": https://jackrighteous.com/en-gb/blogs/guides-using-suno-ai-music-creation/fix-suno-song-repeats-wont-end
- Sunofix, "How to Remove Suno Artifacts" (n.d.): https://sunofix.app/how-to-remove-suno-artifacts/
- Sunofix, "Audio to Spectrogram" (2026-09-04, updated 2026-10-07): https://sunofix.app/blog/audio-to-spectrogram-guide/
- Dubspot (P. Raman), "How to Mix AI-Generated Stems" (2026-06-12): https://blog.dubspot.com/mixing-ai-generated-stems-2026
- Sonarworks, "De-Essing and High-Frequency Control for AI Voice Processing" (2026-01-21): https://www.sonarworks.com/blog/learn/de-essing-and-high-frequency-control-for-ai-voice-processing
- Transientik, "How to Master a Suno Song" (2026-06-10): https://transientik.com/blog/how-to-master-a-suno-song
- Magic Master, "How to Master a Suno Song" (2026-08-06, updated 2026-10-26): https://magicmaster.pro/blog/how-to-master-suno-songs-en
- Maxify Audio, "SUNO AI Music Mastering Complete Guide" (2024-12-17): https://maxifyaudio.cloud/en/blog/suno-ai-music-mastering
- Peak-Studios (C. Jones), "How to properly mix Suno stems" (2026, n.d.): https://www.peak-studios.de/en/suno-stems-mixen/
- AI Central (M. Genie), "Mastering AI Music" (2025-06-16): https://substack.aicentral.blog/p/mastering-ai-music
- Joytxis, "How to Fix AI Music Quality" (about 2026-04): https://joytxis.hashnode.dev/fix-ai-music-quality-suno-udio
- MusicMake, "Suno v5 audio quality" (2026-06-07): https://musicmake.ai/blog/suno-v5-audio-quality-khz-2026
- Unifically, Suno WAV download (updated 2026-10-12): https://unifically.com/models/suno-wav-download
- chunks.md, Suno Downloader docs (n.d.): https://chunks.md/docs/suno-downloader
- sunodownloader.ai, "Highest quality audio from Suno" (2026-08): https://sunodownloader.ai/blog/suno-high-quality-download
- GitHub gcui-art/suno-api issue #289 (2026-08-29): https://github.com/gcui-art/suno-api/issues/289
- CometAPI, "How to download Suno AI songs" (bitrate claims): https://www.cometapi.com/how-to-download-suno-ai-songs/
- MusicRadar, Suno v6 backlash: https://www.musicradar.com/music-tech/im-cancelling-my-subscription-suno-users-slam-its-v6-update-as-muffled-generic-soulless-garbage
- EDM.com, Suno users vs v6: https://edm.com/news/suno-own-users-revolting-against-v6-ai-model-ai-slop/
- Sonible, "Avoiding the Collapse: Stereo to Mono": https://www.sonible.com/blog/stereo-to-mono/
- Audacity forum, DC offset / boundary clicks: https://forum.audacityteam.org/t/dc-offset-removal-to-do-or-not-to-do/22268
- ComfyUI HF cymbal/shimmer repair node (side-HF from 8 kHz, for a different generator): https://comfy.icu/node/HFCymbalShimmerRepair
- YouTube (titles only; transcripts not accessible): "How to Fix the Shimmer Effect in Suno v4" https://www.youtube.com/watch?v=W8199xodz_M ; "Modernist Mixing – How to properly remaster Suno Tracks" https://www.youtube.com/watch?v=PWrBQRq9JR8
