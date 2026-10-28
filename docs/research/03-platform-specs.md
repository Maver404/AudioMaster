# 03 — Streaming platform loudness and distributor delivery specs (2025–2026)

**Research date:** 2026-10-26
**Scope:** The loudness normalization behaviour of the major streaming and social platforms; the file specs and AI-music policies of the main distributors; true-peak headroom for lossy codecs; and the AES and EBU recommendations that apply. The goal is to set defensible values for the app's **Destination** selector.

**How to read this:** **[P]** marks a primary source (the platform, the standards body or the vendor itself). **[S]** marks a secondary source (blogs, trade press, competitors). **⚠** marks a value that is uncertain or that sources disagree on. Every number lists its source; the URLs and dates are in the Sources section at the end.

---

## 0. Key takeaways for the app (TL;DR)

1. **A distributor sends one file to every store.** DistroKid, TuneCore and the others each send the same WAV to Spotify, Apple, Amazon, TikTok and the rest. So a "Spotify master" and an "Apple master" are not two separate deliverables. The Destination selector really chooses a *loudness strategy* (balanced, loud or dynamic) plus a *container* (hi-res WAV, 16/44.1 WAV, MP3 and so on), not a per-store file.
2. **The safe default is −14 LUFS integrated with a −1.0 dBTP ceiling.** This is Spotify's published guidance [P], SoundCloud repeats the same text [P], and it matches the reference level of YouTube, Amazon and Tidal [S]. Apple (−16) turns it down 2 dB and Deezer (−15) turns it down 1 dB. Neither causes any loss.
3. **If the master is louder than −14 LUFS, use a −2.0 dBTP ceiling.** Both Spotify and SoundCloud say this explicitly [P], because lossy transcoding distorts dense masters more.
4. **Mastering louder than about −14 LUFS buys no loudness on the major services.** Spotify, YouTube, Apple, Amazon, Tidal and Deezer all turn loud masters down. Loud masters only "win" where nothing normalizes: club/DJ playback, Beatport downloads, possibly TikTok ⚠, and normalization switched off.
5. **Delivery container:** stereo **WAV PCM (format tag 0x0001, not WAVE_FORMAT_EXTENSIBLE)**, **24-bit**, at the **native sample rate (44.1 or 48 kHz), never upsampled**, with no metadata chunks after `data` (Spotify [P]). Also offer a **16-bit/44.1 kHz dithered** WAV for CD Baby, whose official spec still requires it [P via search index], and for legacy TuneCore guides.
6. **The app's true-peak limiter must oversample (≥4×, preferably 8× at 44.1/48 kHz)** and should offer a **codec check**: encode to MP3/AAC, decode, re-measure true peak. Apple ships a tool that does exactly this (`afclip`) and recommends checking the *encoded* file [P].
7. **The AI-music policy matters for Suno users.** CD Baby reportedly refuses AI-generated content ⚠. TuneCore is strict (licensed-model requirement) ⚠. DistroKid, Ditto, Amuse and UnitedMasters accept it with rights, disclosure and anti-spam conditions. Some may keep fully AI tracks away from Meta/TikTok. Spotify, Apple and Deezer now label AI music and/or filter it from recommendations. Suno's *trial* downloads are **not** cleared for commercial use; only paid-plan downloads are [P]. Mastering does not change any of this. The app must not present itself as a way to hide AI provenance.

---

## 1. Measurement basis

| Item | Value | Source |
|---|---|---|
| Loudness/true-peak algorithm | **ITU-R BS.1770-5** (Nov 2023) is the version in force. A revision draft dated 2026-08 exists but is not published. | ITU [P] |
| Integrated loudness gating | Absolute gate −70 LUFS, relative gate −10 LU | BS.1770, summarized by iZotope 2025 [S] |
| True-peak meter | 4× oversampling interpolation (BS.1770 Annex 2). EBU Tech 3344 v2.1 says the gap between a 4× true-peak reading and the real analogue peak is "less than 1 dB (typically a few tenths of a dB)". | EBU Tech 3344 v2.1, July 2016 [P] (extracted from PDF) |
| K-weighting has no low-pass | Spotify warns that because "ITU 1770 doesn't apply a lowpass filter", ultrasonic content inflates the LUFS reading, so the track gets turned down more than its audible loudness justifies. | Spotify "Track not as loud as others?" [P] |

**App implication:** low-pass or clean up content above about 20 kHz before measuring and normalizing. Suno renders often carry high-frequency hash or "shimmer" artifacts. Use ≥4× (preferably 8×) oversampled true-peak detection in both the meter and the limiter, or keep about 0.3–0.5 dB of extra margin on top of 4× detection.

---

## 2. Streaming platforms

### 2.1 Spotify [P — Spotify for Artists help, page undated, read 2026-10-26]

| Parameter | Value |
|---|---|
| Method | ITU-R BS.1770 integrated loudness, measured at ingest and applied at playback. Files are not altered. |
| **Normal (default)** | **−14 LUFS** |
| **Loud** (Premium) | **−11 LUFS**, "set regardless of maximum True Peak". A limiter engages at **−1 dB (sample values)** with a **5 ms attack** and **100 ms decay**. |
| **Quiet** (Premium) | **−19 LUFS** |
| User behaviour | Over 87% of users keep the default setting (iZotope 2025, citing Spotify) [S] |
| Louder tracks | Negative gain, with "no additional distortion" |
| Quieter tracks | Positive gain, but only as far as **1 dB of true-peak headroom** allows. Spotify's example: −20 LUFS with TP −5 dBFS is lifted only to −16 LUFS. So the gain is roughly `min(−14 − I, −1 − TP)`. |
| Album vs track | **Album normalization** when an album is played in order (one gain for the whole album, so relative levels survive). **Track normalization** on shuffle and in playlists mixing albums. Applies to both lossy and FLAC playback. |
| Where it is *not* applied | Web player and third-party devices (speakers, TVs) |
| Mastering advice | Target **−14 LUFS integrated, TP ≤ −1 dBTP** ("best for lossy formats (Ogg/Vorbis and AAC)"). **If louder than −14 LUFS, keep TP below −2 dBTP.** The same guidance applies to lossless. |
| Encoding note | "Very loud masters with true peaks above −2 dB can introduce distortion during encoding." |
| Streaming formats | App: Low ~24, Normal ~96, High ~160, Very High ~320 kbit/s. **Lossless: up to 24-bit/44.1 kHz FLAC** (rolled out to Premium from 2025-09-10). Web player: AAC 128 (Free) / 256 (Premium). |
| Upload spec (via distributor) | **FLAC preferred, WAV accepted.** Native rate ≥44.1 kHz, 24-bit if the master is 24-bit (16-bit only if no higher master exists), **stereo**, one master per track. WAV must be **WAVE_FORMAT_PCM 0x0001, not 0xFFFE (EXTENSIBLE)**, with valid fmt/data chunks and **only audio after the start of `data`**. Rates above 44.1 kHz are downsampled by Spotify. Files below 16-bit or below 44.1 kHz are upconverted and **not eligible for lossless**. Spotify says not to make a 16-bit copy from a 24-bit master and not to deliver both. |

### 2.2 Apple Music / iTunes

| Parameter | Value | Source |
|---|---|---|
| Normalization | **Sound Check**. It measures loudness, stores the value in metadata, and **raises or lowers** playback volume. It can also work **per album**. | Apple Digital Masters tech brief, April 2021 [P] |
| Reference | **−16 LUFS** ⚠. Apple has not published the number itself. It is consistently reported since Apple moved Sound Check to LUFS in **March 2022**, on by default on new iOS/macOS installs and only on recent OS versions. Older macOS and downloaded songs may still use "legacy" values. | MeterPlugs 2022-03-23 [S]; Production Expert 2022-05 [S]; iZotope 2025 [S]; RecordJet 2024 [S] |
| Limiting | iZotope (2025) says Apple "never uses limiting". So positive gain is presumably capped by peak headroom ⚠ (inference). | [S] |
| Headroom advice | "Leave **at least 1 dB of headroom**" to avoid clipping from oversampling or reconstruction. Check the **encoded** file, because "levels that don't show overs on PCM can still cause clipping when encoded". The `afclip` tool reports on-sample and **inter-sample** clips. | Apple ADM brief [P] |
| Delivery | **24-bit**, highest *native* sample rate. **Do not upsample. Do not bit-pad 16→24.** Apple downsamples with mastering-grade SRC into 32-bit float and encodes **AAC 256 kbps VBR**. **ALAC lossless** uses the same master. Accepted ADM rates: 44.1, 48, 88.2, 96, 176.4, 192 kHz. | Apple ADM brief [P]; Apple asset guide [P via search index] |
| Apple Digital Masters badge | Requires an **Apple-certified mastering engineer**. Tracks with audible clipping do not qualify. **This app cannot confer ADM status.** | Apple asset guide / distributor pages [P/S] |
| Spatial / Atmos (out of scope) | ≤ −18 LKFS, ≤ −1 dBTP, BWF ADM 24/48. **Apple rejects Atmos up-mixed from stereo**, so the app should not offer a "spatial" export. | Apple asset guide [P]; TuneCore [S] |

### 2.3 YouTube / YouTube Music

| Parameter | Value | Source |
|---|---|---|
| Reference | **−14 LUFS**. Moved to exactly −14 LUFS in 2019; before that it was about −13 and not LUFS-based. | Production Advice (2015, updated 2019) [S]; Wikipedia [S] |
| Direction | **Turns loud content down only; does not boost quiet uploads.** | Youlean [S]; Wikipedia [S]; RecordJet 2024 [S] ⚠ (Google publishes no official doc) |
| Inspection | "Stats for nerds" → "content loudness". Sources disagree on the sign convention ⚠. | forums [S] |
| Stable Volume | On by default in the mobile apps since 2023, later on Android TV / Google TV (2024). It is a *dynamic* leveller (compression-like), not static normalization, and can be switched off. | TechCrunch 2023-07-17; 9to5Google 2024-06-24 [S] |
| YouTube Music bitrates | Low 48, Normal 128, High/Always High up to **256 kbps AAC/Opus** | Google support [P] |
| Upload recommendation (video) | **AAC-LC (or Opus), stereo, 48 kHz, 384 kbps** | Google support [P] |

### 2.4 Amazon Music

| Parameter | Value | Source |
|---|---|---|
| Reference | **−14 LUFS**, track normalization | MeterPlugs 2019-10-15 [S]; RecordJet 2024 [S]; iZotope 2025 [S] |
| True peak | **−1 vs −2 dBTP** ⚠ (conflict). The −2 figure probably comes from Amazon's *Alexa* content spec (−14 LUFS, TP ≤ −2 dBFS), which covers Alexa skills and flash briefings, **not** Amazon Music. | Amazon developer docs [P, different product] |
| Toggle | "Loudness Normalization" setting in the Android/iOS/FireOS apps. The default state is unclear ⚠. | Amazon help [P] |

### 2.5 TIDAL

| Parameter | Value | Source |
|---|---|---|
| Reference | **−14 LUFS for the loudest track of each album**. The other tracks keep their relative album levels, **even in playlists or shuffle** ("album normalization always"). | audioXpress 2017-11-27 [S]; iZotope 2025 [S]; RecordJet 2024 [S] |
| Direction | Recommends attenuating only, never positive gain. Tidal "does not raise" tracks below −14 LUFS [S]. | |
| Default | On by default in the mobile apps (since 2017) | audioXpress [S] |
| Basis | Eelco Grimm's study of 4.2M albums; 80% of listeners preferred album normalization | [S] |
| ⚠ | No current official Tidal help article was found. These facts date from 2017 but are repeated in 2024–2025 sources. | |

### 2.6 Deezer

| Parameter | Value | Source |
|---|---|---|
| Reference | **−15 LUFS**, track normalization | MeterPlugs 2019 [S]; RecordJet 2024 [S]; iZotope 2025 [S] |
| Toggle | Deezer's own help page (2025-05-27) shows a **"Normalize audio" on/off toggle** on iOS, Android and Desktop but gives no number. iZotope says it is "always on, can't be disabled" ⚠ (conflict; the Deezer page is newer and primary). | Deezer support [P] |

### 2.7 SoundCloud

| Parameter | Value | Source |
|---|---|---|
| Normalization | The official help article says SoundCloud **applies loudness normalization at playback**. It recommends **−14 LUFS, TP ≤ −1 dBTP**, and **≤ −2 dBTP if louder than −14** (the text matches Spotify's). | SoundCloud Help Center [P via search index; page returned 403 to direct fetch] |
| Conflict ⚠ | iZotope (2025-07) says SoundCloud has "no normalization and no lossless streams". Treat −14 as the target but expect the behaviour to vary. | [S] |
| Upload | WAV, FLAC, AIFF, ALAC recommended. MP3, AAC, Ogg, M4A and others accepted. **Max 4 GB** uncompressed, ≤24 h. Guidance asks for a 16-bit, **48 kHz** stereo lossless file with **−0.5 to −1 dBFS** headroom ⚠ (another page says 44.1 kHz). | SoundCloud Help Center [P via search index] |

### 2.8 Pandora (for completeness)

Pandora sits at about −14 but its measure is not true LUFS. Normalization is always on and **turns up quiet songs** (iZotope 2025 [S]; RecordJet 2024 [S]). It has no published target.

### 2.9 TikTok / Instagram Reels / YouTube Shorts

- **Neither TikTok nor Meta publishes an official loudness target** (APU Software [S]).
- Third-party claims conflict ⚠. Some say "≈ −14 LUFS / −1 dBTP" (several tool vendors). Some say TikTok has **no in-feed normalization** (songbrain). Some say TikTok turns hot masters down more in 2026 (mrvocal). Others recommend −12 to −10 LUFS for phone speakers.
- **Music distributed to TikTok/Instagram goes out as the same distributor master** used for DSPs. A "social" preset only matters for clips the user uploads directly inside a video.
- Practical compromise: **about −12 LUFS, −1 dBTP, 48 kHz**. That is slightly hot for phone playback, costs at most a 2 dB turn-down if −14 normalization applies, and keeps codec headroom. Mono compatibility matters here (phone speakers).

### 2.10 Beatport / club / DJ

- **No normalization on Beatport downloads, USB/CDJ or club systems** [S]. No club loudness standard exists [S].
- Typical club or EDM masters run **−9 to −6 LUFS integrated**. Deep house, melodic techno and progressive sit around −10 to −8 (median −10.5 in one dataset), and the overall median release is −8.8 LUFS (mixgraph dataset [S]; Violet Recording [S]).
- Delivery via a label or distributor (LabelGrid): **WAV or AIFF, ≥44.1 kHz, 16- or 24-bit**. FLAC or MP3 320 are also accepted by some. Beatport requires label-level approval [S]. Beatport sells MP3/AAC as well as lossless, so keep about −1 dBTP.

### 2.11 Summary of platform playback references

| Platform | Reference (LUFS) | Turns loud down | Boosts quiet | Album mode | True-peak advice | Confidence |
|---|---|---|---|---|---|---|
| Spotify (Normal) | −14 (Loud −11, Quiet −19) | yes | yes, up to TP −1 (limiter only in Loud) | yes (album playback) | −1 dBTP; −2 if > −14 LUFS | **P** |
| Apple Music | −16 ⚠ | yes | yes (no limiter, so peak-limited ⚠) | yes | ≥1 dB headroom; check encode | P (behaviour) / S (number) |
| YouTube | −14 | yes | no | no | −1 dBTP (common practice) | S |
| Amazon Music | −14 | yes | unclear ⚠ | no | −1 or −2 ⚠ | S |
| TIDAL | −14 (loudest track of album) | yes | no | always | −1 dBTP | S |
| Deezer | −15 | yes | unclear ⚠ | no | −1 dBTP | S (number) / P (toggle) |
| SoundCloud | −14 ⚠ | yes ⚠ | yes ⚠ | ? | −1; −2 if > −14 | P (text) vs S (conflict) |
| Pandora | ~−14 (non-LUFS) | yes | yes | no | — | S |
| TikTok / Reels | unpublished ⚠ | ? | ? | — | −1 to −2 | S (low) |
| Beatport / club | none | no | no | — | −1 (−0.5 lossless-only) | S |

**Model for the "how will it sound on X" preview** (optional feature): playback gain = `ref − I`.
- If the gain is positive: Spotify caps it at `−1 − TP`. YouTube and Tidal cap it at 0. Apple caps it at about `−1 − TP` ⚠. For others, assume 0 to be conservative.
- For Tidal (and Spotify or Apple in album context), use the loudest track's `I` across the album/batch.

---

## 3. Standards and recommendations

### 3.1 AES TD1004 → TD1008 → **AES77-2023**

| Doc | Key numbers | Source |
|---|---|---|
| AES TD1004.1.15-10 (2015) | Target window **−16 to −20 LUFS**, **max TP −1 dBTP** | Production Expert 2015 [S] |
| AES TD1008 (Sept 2021; supersedes TD1004) | **Distribution loudness: music −16 LUFS**; speech and "assorted" −18 LUFS; mixed −17. **Album normalization preferred**, with the loudest track at **−14 LUFS**, which gives about −16 integrated over a stream. "Target loudness" was renamed **"Distribution Loudness"** to stress that it is *not a mastering target*. | Production Advice 2021-10-01 [S]; Telos 2025-03 [S] |
| TD1008 §4 (quoted) | "Maximum True Peak level not exceed **−1 dBTP** at the codec input of lossy-encoded streams" | baken docs quoting TD1008 [S, verbatim quote] |
| TD1008 §7B (quoted) | "peak overshoot increases as the bit rate decreases"; at low rates "the limiting threshold may need to be reduced below the recommended −1.0 dBTP"; "high-rate (e.g., 256 kbps) coders may work satisfactorily with as little as **−0.5 dBTP**" | same |
| **AES77-2023** | TD1008 was upgraded to an official AES standard on **2023-07-11** (free to AES members, $100 for others) | Grimm Audio [S]; Radio World [S] |

⚠ The AES PDF itself could not be fetched (403). The numbers above are cross-checked across 3–4 secondary sources and agree.

### 3.2 EBU R 128 / Tech 3344

- **R 128:** programme loudness **−23 LUFS ±0.5 LU** (±1 LU for live), **max true peak −1 dBTP** in production. Permitted peaks "may be lower for different distribution systems and data reduction rates"; see Tech 3344 (EBU R 128 [P via search]; Wikipedia [S]).
- **Tech 3344 v2.1 (July 2016)** [P, extracted]: an end-stage peak limiter is placed before the encoder, and "it might be necessary to decrease the limiter level in front of the codec system if relatively low bitrates are used. On high bitrates, a higher limiter level might be possible." The per-codec numbers in its figures could not be extracted reliably ⚠. A commentator says EBU distribution specs use **−3 dBTP** for lossy codecs ⚠ (not verified in the primary text).
- R 128 matters to the app only for a **"Broadcast/Sync" preset** (TV/radio sync licensing). Music streaming does not use −23.

---

## 4. Lossy codec headroom (MP3 / AAC / Ogg / Opus)

| Evidence | Value | Source |
|---|---|---|
| Spotify | −1 dBTP for lossy; −2 dBTP when > −14 LUFS | [P] |
| SoundCloud | same text as Spotify | [P] |
| Apple | ≥1 dB headroom; verify the encoded file (afclip counts inter-sample clips) | [P] |
| AES TD1008/AES77 | −1 dBTP at codec input; lower at low bitrates; −0.5 possible at ≥256 kbps | [S, verbatim quotes] |
| EBU Tech 3344 | lower the limiter for low bitrates; higher is possible at high bitrates | [P] |
| iZotope 2025 | at least 1 dB TP headroom for lossy, more for loud material or low bitrates; **lossless-only: about −0.3 dBTP** | [S] |
| Measured anecdotes | MP3 320: up to **+0.7 dB** overshoot (forum). One MP3 example **+1.73 dB**. Pathological signals up to **+10 dB**. Overshoot is program-dependent. | Gearspace [S, low]; Fora Soft [S] |

**Recommended rule set for the app** (combines the evidence above; the low-bitrate value is a heuristic ⚠):

| Condition | TP ceiling |
|---|---|
| Target ≤ −14 LUFS, any delivery | **−1.0 dBTP** |
| Target > −14 LUFS (louder), DSP delivery | **−2.0 dBTP** (Spotify/SoundCloud rule) |
| App's own MP3/AAC export ≥ 256 kbps | −1.0 (≤ −14 LUFS) / −2.0 (louder) |
| App's own MP3/AAC export ≤ 192 kbps | −2.0 / −3.0 ⚠ heuristic |
| Lossless-only playback (club WAV/AIFF, CD) | −0.5 to −1.0 (default −1.0, because Beatport also sells lossy files) |

Also implement a **post-encode verification**, as Apple's afclip does: encode the export (e.g. lamejs MP3 or WebCodecs AAC), decode it, measure true peak. If it exceeds −0.1 dBTP (or the decoded file clips), lower the ceiling by 0.5 dB and re-render.

---

## 5. Distributors

⚠ Most distributor help centers (Zendesk) returned **HTTP 403** to direct fetches. The values below come from search-indexed text of the official pages where noted ("P-idx"), otherwise from secondary sources.

### 5.1 Technical delivery specs

| Distributor | Accepted formats | Bit depth / sample rate | Channels | Max size | Notes / confidence |
|---|---|---|---|---|---|
| **DistroKid** | WAV, FLAC, MP3, M4A, AIFF, WMA (WAV/FLAC recommended) | WAV up to **24-bit / 96 kHz**; 16/44.1 "typical" | stereo (implied; not stated officially ⚠) | **1 GB** ⚠ (studio blog and forum, not official) | P-idx (formats), S (limits) |
| **TuneCore** | WAV | Support article: **24-bit / 192 kHz recommended; 16/44.1 accepted "but not recommended"**. Older official guide: **16-bit / 44.1 kHz / 1411 kbps stereo WAV** ⚠ (internal conflict). Do not embed metadata or artwork. | stereo | not found | P-idx / P |
| **CD Baby** | **WAV or FLAC** (MP3 accepted, not recommended) | **16-bit / 44.1 kHz required**. A 24-bit/48 kHz file is cited as a mismatch that must be converted. | **stereo** | not found | P-idx. One secondary blog says 24-bit is accepted and converted ⚠ |
| **Amuse** | WAV, FLAC (stereo) | 16-bit/44.1 kHz (2024 guide) ⚠ | stereo | **3 GB** ⚠ | S only |
| **Ditto** | **WAV or MP3** | **≥16-bit, ≥44.1 kHz** | **stereo** | not stated | P (updated 2024-03-04). No snippets or long silences. |
| **UnitedMasters** | not found ⚠ | — | — | — | Assume WAV 16/24-bit, 44.1 kHz+, stereo (industry norm) |

**Common denominator** (works everywhere): **stereo WAV, PCM, 44.1 kHz, 16-bit (dithered)**. **Best-quality option** (Spotify, Apple, DistroKid, TuneCore): **stereo WAV, PCM, 24-bit, native 44.1/48 kHz.** For CD Baby, 16/44.1 is mandatory.

Other cross-distributor rules:
- **Stereo only.** Export mono material as dual-mono 2-channel.
- **Full tracks only.** No clips, no abrupt cut-offs, no extended silence (Ditto, Spotify).
- **Don't upsample. Don't bit-pad** (Apple, Spotify).
- **No embedded metadata or artwork** (TuneCore). Spotify also requires only audio after `data`, so the WAV writer must not append LIST/ID3 chunks at the end.
- A 5-minute 24-bit/48 kHz stereo WAV is about 86 MB, far below every size limit.

### 5.2 AI-generated music policies (state as of Oct 2026)

| Entity | Policy | Date / confidence |
|---|---|---|
| **Suno (source)** | **Paid-plan downloads carry commercial rights.** **Trial downloads (Free) are personal use only.** Download caps since **2026-09-03**: Free 7 lifetime trial; **Pro 20/month; Premier 60/month**; Premier + Suno Studio unlimited; extra downloads purchasable. Songs made on the Free plan are not commercial even after upgrading [S]. New licensed **v6 / v6-wild / v6-mini** models (WMG, BMG, Believe) launched in **Sept 2026**; older models are being retired. Believe/TuneCore distribution eligibility is "may become" ⚠. | Suno blog 2026-08-10 [P]; ProPakistani 2026-09-10 [S]; MBW Nov 2025 [S] |
| **Spotify** | AI music allowed. **Spam filter** (mass uploads, duplicates, SEO tricks, artificially short tracks are kept off recommendations); **impersonation/voice-clone ban** without authorization; **DDEX AI-disclosure credits** (vocals, instrumentation, post-production). | Announced 2025-09-25 [S, multiple] |
| **Apple Music** | **"Transparency Tags"** (track, composition/lyrics, artwork, video), self-reported by labels and distributors. Mandatory status disputed ⚠ ("required going forward" per DMN vs "optional for now" per others). | 2026-03-04 [S] |
| **Deezer** | AI detection since Jan 2025. **Fully AI tracks are excluded from algorithmic and editorial recommendations** and tagged. AI was over 50% of new uploads in June 2026. An "exclude AI from search" toggle is rolling out by end of 2026. 85% of AI-track streams are detected as fraudulent and demonetized. | Deezer newsroom 2026-04, 2026-07; MBW 2026-10 [P/S] |
| **DistroKid** | Accepts AI-made music **if you hold all rights**. **AI disclosure ("AI Credits")** in the upload flow, which Spotify and Apple display. Bans impersonation and spam. | S (multiple); official page not fetched ⚠ |
| **TuneCore** | "GenAI Music Content Framework": only models trained on **fully licensed data** qualify (guide reviewed 2026-08). Another source says 100% AI is rejected ⚠. Its Suno v6 partnership (via Believe) may change eligibility. | S, conflicting ⚠ |
| **CD Baby** | **Does not distribute AI-generated content**, even with paid-plan commercial rights (support page reportedly updated 2025-10-29). AI as a production tool (mixing, mastering) is OK only if composition and performance are human. | Dynamoi [S]; Hypebot 2023 [S]; Soundverse 2026 claims "disclosure" instead ⚠ |
| **Amuse** | Accepted with **mandatory per-track and per-release disclosure**. Reported limits: 10 releases per 7 days; excluded from Meta ⚠. | LabelGrid (a competitor) [S] |
| **Ditto** | Allowed with full rights, no voice cloning, no spam. **Warns that fully AI releases may be rejected by Apple Music, Shazam, Beatport, iTunes, Audiomack, Meta Rights Manager, Pandora and YouTube Content ID.** Fully AI songs are not eligible for Ditto Publishing. | Ditto support 2026-08-04 [P] |
| **UnitedMasters** | Not prohibited. TV/movie voice clones and sample-imitating beats are rejected. **Fully AI (vocals + instrumental) is not delivered to Meta or TikTok.** | Dynamoi 2026-04-26 [S] |

**App implications:**
- Show an info note when the user picks a distributor-oriented export, e.g. "Check your distributor's AI policy; CD Baby does not accept AI-generated music; Suno trial downloads aren't licensed for release". Link to the policy pages and avoid legal advice.
- **Do not** add features meant to defeat AI detection or remove watermarks. Suno uses watermarking/fingerprinting [S], and Deezer and others detect AI output. The app's value is sound quality, not provenance laundering.

---

## 6. Recommended **Destination** presets

All presets: **stereo**; **TP limiter with ≥4× (preferably 8×) oversampling**; HF clean-up above about 20 kHz before measuring; **LUFS tolerance ±0.5 LU**; export WAV PCM (tag 0x0001), no trailing chunks, native sample rate unless stated otherwise.

| # | Preset (UI name) | Target integrated LUFS | TP ceiling (dBTP) | Recommended export | Justification |
|---|---|---|---|---|---|
| 1 | **Streaming — Balanced** *(default)* — Spotify, Apple Music, YouTube, Amazon, Tidal, Deezer, via any distributor | **−14** | **−1.0** | WAV 24-bit, native 44.1/48 kHz | Spotify [P] and SoundCloud [P] guidance; YouTube, Amazon and Tidal reference [S]. Apple (−16) and Deezer (−15) only turn it down, with no limiting. 1 dB codec margin per Spotify, AES77 and Apple. Spotify never needs positive gain. |
| 2 | **Streaming — Loud** (pop, EDM, hip-hop, rock) | **−10** (intensity range −11 … −9) | **−2.0** | WAV 24-bit native | For genre density, not platform loudness: it is turned down 4 dB on Spotify Normal. **Spotify and SoundCloud explicitly require −2 dBTP above −14 LUFS** [P]. −11 equals Spotify "Loud", where no boost or limiter applies [P]. |
| 3 | **Hi-Fi / Dynamic** (acoustic, jazz, classical, ambient, cinematic) | **−16** | **−1.0** | WAV 24-bit native | Apple Sound Check reference (−16) [S] and AES77 music distribution loudness [S]. Trade-off: on Spotify it can only be lifted if TP < −1, so it may play about 2 dB quieter there. Show this note in the UI. |
| 4 | **YouTube / Video** | **−14** | **−1.0** | **WAV 24-bit 48 kHz** (resample if the source is 44.1) | YouTube −14 turn-down-only [S]; Google recommends 48 kHz AAC 384 kbps for uploads [P], so deliver 48 kHz PCM for the video editor or encoder. |
| 5 | **SoundCloud (direct upload)** | **−14** | **−1.0** | WAV 24-bit (or 16-bit/48 kHz per SC guidance) | SoundCloud help: −14 / −1 / −2 if louder [P]; asks for −0.5 to −1 dBFS headroom [P-idx]. Normalization behaviour is disputed ⚠. |
| 6 | **Social Clips** (TikTok, Reels, Shorts — direct video use) | **−12** ⚠ | **−1.0** | WAV 24-bit 48 kHz (AAC 256+ for quick share) | No official spec. Sources split between −14 and −10 [S]. −12 is a compromise: at most a 2 dB turn-down if normalized, and extra density on phone speakers. Run a mono-compatibility check. |
| 7 | **Club / DJ** (Beatport, USB, CDJ) | **−8** (intensity range −9 … −6) | **−1.0** | WAV (or AIFF) 24-bit 44.1 kHz | No normalization in clubs or on Beatport [S]. Typical releases are −9 to −6 [S], median about −8.8 [S]. −1.0 because Beatport also sells lossy files. |
| 8 | **Broadcast / Sync** (TV, radio, EBU R128) | **−23** | **−1.0** | WAV 24-bit 48 kHz | EBU R 128 [P]. Optional or advanced; only for sync and broadcast delivery. |
| 9 | **Quick Share MP3** (demos, WhatsApp, email) | **−14** | **−1.0** (or **−2.0** if the user forces it louder) | MP3 320 kbps CBR (or AAC 256) + **post-encode TP check** | Codec headroom rules in §4. Verify after encoding, like Apple's afclip [P]. |

**Export-format override (orthogonal to the preset):**

| Option | Spec | When |
|---|---|---|
| **Hi-res (default)** | WAV PCM 24-bit, native rate (44.1/48 kHz) | Spotify, Apple, DistroKid, TuneCore, Amuse, Ditto |
| **Compatibility / CD Baby** | WAV PCM **16-bit, 44.1 kHz**, high-quality SRC + **TPDF dither** | CD Baby (required), legacy TuneCore guide, CD |
| **Lossless compact** | FLAC 24-bit | Spotify prefers it; DistroKid and CD Baby accept it |

**Album / batch mode:** offer "Keep album balance". Measure every track, set the gain so the **loudest track** hits the preset target, and apply the same limiter ceiling to all tracks. This matches Spotify, Apple and Tidal album normalization and AES77's album recommendation (loudest track at −14).

### 6.1 Machine-readable preset sketch

```js
// Values justified in docs/research/03-platform-specs.md §6
export const DESTINATIONS = {
  streaming:   { lufs: -14, tp: -1.0, sr: 'native', bits: 24, label: 'Streaming — Balanced' },
  loud:        { lufs: -10, tp: -2.0, sr: 'native', bits: 24, range: [-11, -9], label: 'Streaming — Loud' },
  dynamic:     { lufs: -16, tp: -1.0, sr: 'native', bits: 24, label: 'Hi-Fi / Dynamic' },
  youtube:     { lufs: -14, tp: -1.0, sr: 48000,   bits: 24, label: 'YouTube / Video' },
  soundcloud:  { lufs: -14, tp: -1.0, sr: 'native', bits: 24, label: 'SoundCloud' },
  social:      { lufs: -12, tp: -1.0, sr: 48000,   bits: 24, label: 'Social Clips' },
  club:        { lufs:  -8, tp: -1.0, sr: 44100,   bits: 24, range: [-9, -6], label: 'Club / DJ' },
  broadcast:   { lufs: -23, tp: -1.0, sr: 48000,   bits: 24, label: 'Broadcast (EBU R128)' },
  mp3:         { lufs: -14, tp: -1.0, codec: 'mp3', kbps: 320, verifyEncode: true, label: 'Quick Share MP3' },
};
// Rule: if (lufs > -14) tp = Math.min(tp, -2.0);  // Spotify/SoundCloud guidance
// Rule: lossy export <= 192 kbps -> tp -= 1.0 (heuristic, AES77 §7B / EBU Tech 3344)
// Format override 'cdbaby': { sr: 44100, bits: 16, dither: 'tpdf' }
```

---

## 7. Implementation notes from this research (browser / Web Audio)

- **Sample-rate preservation:** `decodeAudioData` resamples to the context's rate. Create the `OfflineAudioContext` at the **source's native rate** (parse the WAV/MP3/M4A header) so the app doesn't silently resample (Spotify and Apple say keep native, don't upsample). Suno WAVs are reportedly **48 kHz/16-bit, decoded from an Opus stream of about 150 kbps** ⚠ (third-party API vendor). Keep 48 kHz for streaming exports and convert to 44.1 only for the CD Baby/Club override.
- **Bit depth:** processing in float and exporting 24-bit is legitimate. The mastering chain creates real information below 16 bits, so this is not the "bit-padding" Apple forbids. The 16-bit export needs TPDF dither.
- **WAV writer:** `wFormatTag = 1` even for 24-bit stereo, a 16-byte `fmt` chunk, and `data` as the last chunk.
- **Meters to show in the UI:** Integrated LUFS (BS.1770-5), true peak (dBTP, oversampled), LRA, and a "platform preview" (gain each platform will apply, using the model in §2.11).
- **Codec check:** encode → decode → TP and clip count, like Apple's afclip [P].

---

## 8. Open questions / flagged uncertainties

1. Apple's −16 LUFS is not published by Apple. It is consistently reported since 2022 and treated as fact by iZotope (2025).
2. Amazon's true-peak advice is −1 vs −2 dBTP. The −2 likely comes from the Alexa spec. −1 is fine for −14 masters; −2 is used anyway for louder ones.
3. Whether SoundCloud normalizes: its official help says yes, iZotope 2025 says no.
4. TikTok and Instagram have no official numbers. −12 LUFS is a reasoned heuristic, not a spec.
5. Deezer: toggle (official, 2025) vs "always on" (iZotope).
6. DistroKid's exact maximum file size (1 GB) and its maximum sample rate (96 kHz) come from secondary sources. TuneCore's recommendation of 24/192 conflicts with its own older 16/44.1 guide.
7. CD Baby's AI ban is reported by two secondary sources (2023 Hypebot quote; Oct 2025 page per Dynamoi). One 2026 source suggests a disclosure model instead. Verify on the CD Baby support site before showing a hard "not accepted" message.
8. The EBU Tech 3344 per-codec dBTP values could not be extracted from the PDF figures. The commentator's "−3 dBTP for lossy" claim is unverified.
9. AES TD1008/AES77 primary PDF not accessible (403). Quotes come via secondary sources and agree with each other.

---

## Sources

Accessed 2026-10-26 unless noted. Dates are publication or last-updated dates where the page shows one.

**Platforms**
- Spotify for Artists — Loudness normalization (undated page) [P]: https://support.spotify.com/artists/article/loudness-normalization/
- Spotify for Artists — Track not as loud as others? [P]: https://support.spotify.com/us/artists/article/track-not-as-loud-as-others/
- Spotify for Artists — Audio file formats for Spotify [P]: https://support.spotify.com/us/artists/article/audio-file-formats/
- Spotify — Audio quality (bitrates) [P]: https://support.spotify.com/us/article/audio-quality/
- audioXpress — Spotify launches 24-bit lossless (Sept 2025) [S]: https://audioxpress.com/news/spotify-finally-launches-24-bit-lossless-streaming
- Apple — Apple Digital Masters technology brief (April 2021) [P]: https://apple.com/itunes/docs/apple-digital-masters.pdf
- Apple — iTunes/Apple Music Video & Audio Asset Guide (ADM) [P]: https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html
- Apple — Asset Guide, immersive audio [P]: https://help.apple.com/itc/videoaudioassetguide/en.lproj/itcf946aaace.html
- MeterPlugs — Apple switch to LUFS (2022-03-23) [S]: https://www.meterplugs.com/blog/2022/03/23/apple-switch-to-lufs.html
- Production Expert — Apple choose −16 LUFS (2022-05-10) [S]: https://www.production-expert.com/production-expert-1/apple-choose-16lufs-loudness-level-for-apple-music-heres-why
- Production Advice — YouTube loudness (2015, updated 2019) [S]: https://productionadvice.co.uk/youtube-loudness/
- Wikipedia — Audio normalization [S]: https://en.wikipedia.org/wiki/Audio_normalization
- Youlean — YouTube normalization [S]: https://youlean.co/?p=30813
- Google — YouTube recommended upload encoding settings [P]: https://support.google.com/youtube/answer/1722171
- Google — YouTube Music audio quality [P]: https://support.google.com/youtubemusic/answer/9076559
- TechCrunch — YouTube Stable Volume (2023-07-17) [S]: https://techcrunch.com/2023/07/17/youtube-is-testing-a-new-stable-volume-feature-across-its-mobile-apps/
- 9to5Google — Stable Volume (2024-06-24) [S]: https://9to5google.com/2024/06/24/youtube-stable-volume/
- MeterPlugs — Loudness Penalty adds Amazon & Deezer (2019-10-15) [S]: https://meterplugs.com/blog/2019/10/15/loudness-penalty-amazon-deezer.html
- Amazon developer — Normalizing loudness (Alexa) [P, other product]: https://developer.amazon.com/en-GB/docs/alexa/flashbriefing/normalizing-the-loudness-of-audio-content.html
- Amazon help — Turn on Loudness Normalization [P]: https://digprjsurvey.amazon.com/csad/help/node/TgG1d8mPjGwf885hRP
- audioXpress — TIDAL album normalization (2017-11-27) [S]: https://audioxpress.com/news/tidal-implements-album-loudness-normalization-and-activates-it-by-default-for-mobile-players
- Deezer support — Volume normalization (2025-05-27) [P]: https://support.deezer.com/hc/en-gb/articles/360005369938-Volume-Normalization-on-Deezer
- SoundCloud Help — Will SoundCloud play my track at the level it's mastered? [P, via search index]: https://help.soundcloud.com/hc/en-us/articles/360053660014-Will-SoundCloud-play-my-track-at-the-level-it-s-mastered
- SoundCloud Help — Uploading requirements [P, via search index]: https://help.soundcloud.com/hc/en-us/articles/46020588217499-Uploading-Requirements
- RecordJet FAQ — store loudness requirements (2024-10-29) [S]: https://faq.recordjet.com/en/articles/6959419-how-loud-should-my-master-be-what-are-the-store-requirements
- iZotope — Mastering for streaming platforms (2025-07-23) [S]: https://www.izotope.com/en/learn/mastering-for-streaming-platforms.html
- APU Software — TikTok/Reels loudness [S]: https://apu.software/tiktok-instagram-reels-loudness/
- Songbrain — LUFS for Spotify & TikTok (2026) [S]: https://www.songbrain.ai/guides/lufs-for-spotify-and-tiktok
- Critical Listening Lab — Social media loudness [S]: https://www.criticallisteninglab.com/en/learn/loudness/social-media
- mixgraph — LUFS meter / genre medians [S]: https://www.mixgraph.io/tools/lufs-meter
- Violet Recording — How to master EDM [S]: https://violetrecording.com/how-to-master-edm/
- LabelGrid — Beatport requirements [S]: https://help.labelgrid.com/en/distribution/beatport-requirements/

**Standards**
- ITU-R BS.1770-5 (2023-11) [P]: https://www.itu.int/rec/R-REC-BS.1770-5-202311-I
- EBU Tech 3344 v2.1 (July 2016) [P]: https://tech.ebu.ch/docs/tech/tech3344.pdf
- EBU R 128 (2014 edition PDF) [P]: https://tech.ebu.ch/docs/r/r128-2014.pdf ; summary: https://en.wikipedia.org/wiki/EBU_R_128
- Production Advice — AES TD1008 explained (2021-10-01) [S]: https://productionadvice.co.uk/td1008/
- Grimm Audio — TD1008 / AES77 (2023-07-11 standardization) [S]: https://www.grimmaudio.com/?p=4698
- Telos Alliance — Understanding loudness for streaming (2025-03-06) [S]: https://docs.telosalliance.com/docs/understanding-loudness-for-streaming-audio
- Pro Tools Expert — AES update loudness recommendations (TD1008) [S]: https://www.pro-tools-expert.com/production-expert-1/aes-update-loudness-recommendations-for-audio-only-streaming
- Production Expert — AES TD1004 (2015-11-17) [S]: https://www.production-expert.com/home-page/2015/11/17/aes-release-recommendations-for-loudness-of-audio-streaming-and-network-file-playback
- baken docs — true-peak ceiling (quotes TD1008 §4, §7B) [S]: https://docs.rs/crate/baken/3.0.2/source/docs/true-peak-ceiling.md
- AES TD1008 download (403 on fetch) [P]: https://www.aes.org/technical/documentDownloads.cfm?docID=731

**Codec overshoot**
- Fora Soft — True peak / inter-sample (2026-06-06) [S]: https://www.forasoft.com/learn/audio-for-video/articles-audio/true-peak-dbtp-inter-sample
- Gearspace — ISP, MP3 and ceiling [S, anecdotal]: https://gearspace.com/threads/isp-mp3-and-ceiling.935434/

**Distributors**
- emastered (quotes DistroKid policy) [S]: https://intercom.help/emastered/en/articles/2645051-i-m-uploading-this-song-to-spotify-tunecore-apple-music-soundcloud-distrokid-cdbaby-what-file-type-do-i-need
- DistroKid help center (403 on fetch) [P]: https://support.distrokid.com/hc/en-us/categories/360001857214-Uploading
- Masterchannel — Uploading to DistroKid [S]: https://blog.masterchannel.ai/uploading-music-to-distrokid-what-to-know/
- Black Sheep Studios — CD Baby and DistroKid (1 GB) [S]: https://blacksheeprecordingstudios.com/blog/cd-baby-and-distrokid
- Audacity forum — DistroKid 1 GB report [S]: https://forum.audacityteam.org/t/creating-8-hour-long-tracks-to-upload-onto-spotify/98838
- TuneCore support — audio file requirements [P, via search index]: https://support.tunecore.com/hc/en-us/articles/115006499327
- TuneCore guide — Get your audio files ready [P]: https://www.tunecore.com/guides/how-to-get-your-audio-files-ready-for-distribution
- CD Baby support — Uploading audio [P, via search index]: https://support.cdbaby.com/hc/en-us/articles/204498645-Uploading-Audio
- Ditto support — audio format (2024-03-04) [P]: https://support.dittomusic.com/en/articles/4283815-what-format-does-my-audio-need-to-be-in
- Loop.fans — Amuse upload guide (2024) [S]: https://music.loop.fans/blog/amuse-upload-music
- LabelGrid — Amuse comparison [S, competitor]: https://labelgrid.com/compare/amuse-alternative/

**AI policies**
- Suno — Downloads policy & ToS update (2026-08-10) [P]: https://blog.suno.com/blog/suno-updates-tos
- ProPakistani — Suno v6 licensed models (2026-09-10) [S]: https://propakistani.pk/2026/09/10/suno-launches-licensed-ai-music-models-after-warner-copyright-settlement/
- Music Business Worldwide — WMG/Suno settlement (Nov 2025) [S]: https://www.musicbusinessworldwide.com/warner-music-group-settles-with-suno-strikes-first-of-its-kind-deal-with-ai-song-generator/
- Unifically — Suno WAV download spec [S, vendor]: https://unifically.com/models/suno-wav-download
- Relix — Spotify AI policy (2025-09) [S]: https://relix.com/news/detail/spotify-targets-ai-slop-and-embraces-ai-music-in-new-policy
- Mixmag — Spotify AI crackdown [S]: https://mixmag.net/read/spotify-ai-artificial-intelligence-crackdown-policies-news
- MusicTech — Apple Music Transparency Tags (2026-03) [S]: https://musictech.com/news/industry/apple-music-transparency-tags-ai/
- Digital Music News — Apple Transparency Tags requirement (2026-03-05) [S]: https://www.digitalmusicnews.com/2026/03/05/apple-music-ai-transparency-tags-requirement/
- Deezer newsroom — AI over 50% of uploads (2026-07) [P]: https://newsroom-deezer.com/2026/07/ai-music-exceeds-50-percent-daily-uploads-deezer/
- Deezer newsroom — AI 44% of uploads (2026-04) [P]: https://newsroom-deezer.com/2026/04/ai-generated-tracks-represent-44-of-new-uploaded-music/
- MBW — Deezer AI search filter (2026-10) [S]: https://www.musicbusinessworldwide.com/deezer-to-let-users-block-ai-generated-music-from-search-results/
- Music in Africa — DistroKid AI disclosure [S]: https://www.musicinafrica.net/fr/node/391306
- Jack Righteous — TuneCore AI policy 2026 (reviewed 2026-08) [S]: https://jackrighteous.com/en-us/blogs/ai-music-distribution-guide/tunecore-ai-music-policy-2026-how-to-avoid-release-rejection
- Dynamoi — Does TuneCore accept AI music [S]: https://dynamoi.com/learn/faqs/does-tunecore-accept-ai-music
- Dynamoi — Does CD Baby accept AI music [S]: https://dynamoi.com/learn/ai-music-distribution/does-cd-baby-accept-ai-music
- Hypebot — Are TuneCore, CD Baby, DistroKid blocking AI music (2023) [S]: https://www.hypebot.com/hypebot/2023/05/are-tunecore-cd-baby-distrokid-symphonic-blocking-ai-music.html
- Soundverse — CD Baby AI guidelines 2026 [S, conflicting]: https://www.soundverse.ai/blog/article/cd-baby-ai-music-guidelines-upload-rules-1201
- Ditto support — Can I release AI-generated music (2026-08-04) [P]: https://support.dittomusic.com/en/articles/13973284-can-i-release-ai-generated-music-with-ditto-music
- Dynamoi — Does UnitedMasters accept AI music (2026-04-26) [S]: https://dynamoi.com/learn/ai-music-distribution/does-unitedmasters-accept-ai-music
