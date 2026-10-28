# 04 — Browser technology feasibility for a client-side mastering app (2025-2026)

Researched 2026-10-26. Scope: decoding, offline rendering, workers, MP3/AAC encoding, WAV
writing, downloads, and a single-file esbuild build for a vanilla JS + Web Audio app with
no backend.

**Method.** I used two kinds of evidence:

1. **Primary sources.** Browser engine source code (Chromium `main`, WebKit `main`,
   mozilla-central `tip`, all read on 2026-10-26), the W3C specs, MDN, caniuse, npm and CDN
   metadata, and the Microsoft and McGill WAV specifications.
2. **A browser probe on macOS 14** in **Chrome 155**, **Firefox 155**, **Safari 17.2.1**
   and an older Chromium 152 build. It
   decoded 46 test files, made from one 10.000 s stereo signal with a single impulse at
   exactly 1.000 s. I encoded the files with LAME 3.100, afconvert, FFmpeg 8.1.1 and FLAC.
   The probe also checked sample-rate limits, workers (http:// and file://), AudioWorklet,
   a 10-minute OfflineAudioContext render, WebCodecs support, and 250 MB Blobs. Rows marked
   "tested" below come from this probe.

> **Caveats.** The Safari here is 17.2.1. Current Safari (26/27, shipped 2025-2026) adds
> WebCodecs audio and Ogg Opus/Vorbis (since 18.4). Safari rows for those features are
> therefore sourced, not tested. Edge was not tested: it is Blink with the same FFmpeg
> build and proprietary codecs, so it is assumed equal to Chrome. Windows and Linux were
> not tested.

---

## 0. Decision summary (TL;DR)

| # | Decision | Why (evidence) |
|---|---|---|
| D1 | **Parse WAV in JS ourselves**; never send WAV through `decodeAudioData` | Firefox 155 decodes 64-bit float WAV **silently wrong**: double length, all zeros, no error (tested). Chrome rejects it. JS parsing is exact, fast and avoids resampling. |
| D2 | For MP3/M4A/FLAC/OGG, call `decodeAudioData` on an **`OfflineAudioContext(2, 1, nativeRate)`**, with `nativeRate` sniffed from the header | `decodeAudioData` **always resamples** to the context rate (spec). The built-in resamplers are mediocre: Chrome uses a 32-tap sinc, Firefox uses Speex quality 4 of 10. Decoding at the native rate gave sample-exact length and alignment in all 3 browsers (tested). |
| D3 | **Never let Web Audio resample** during processing (an AudioBufferSourceNode whose buffer rate differs from the context rate) | Chromium and WebKit use **linear interpolation**. Firefox uses Speex **QUALITY_MIN** (source code). If sample-rate conversion is needed, write our own windowed-sinc. |
| D4 | DSP goes in **JS in a classic (non-module) Worker** created from a Blob URL, with an inline fallback | There is **no OfflineAudioContext/AudioContext inside workers** (Chromium source says "Workers are not supported."; tested in all 3). Classic Blob workers work everywhere, **including file://**. **Module** Blob workers **fail in Chrome under file://** (tested). |
| D5 | **Do not depend on `DynamicsCompressorNode`** for the mastering dynamics/limiter | The same 10-minute render reported −1.27 dB reduction in Chrome/Safari and −7.76 dB in Firefox (tested): implementations differ. There is no true-peak limiting and no control of lookahead. Biquads are fine. |
| D6 | **No SharedArrayBuffer** | It needs COOP/COEP (cross-origin isolation). `crossOriginIsolated` was false and SAB undefined in every probe. Transferable ArrayBuffers are enough: 230 MB moved in 22-250 ms (tested). |
| D7 | **MP3 export: lamejs.** Either `lame.min.js` 1.2.1 from cdnjs as a classic script, or `@breezystack/lamejs@1.2.7` as ESM/IIFE. Encode 32/44.1/48 kHz only. | The npm `lamejs@1.2.1` CommonJS entry (`src/js/index.js`) throws "MPEGMode is not defined" under bundlers. The prebuilt `lame.min.js` and the fork do not have this problem. lamejs writes **no LAME/Info tag**, so decoders add 1105 samples (Chrome/Firefox) or 576 samples (Safari) of leading silence (tested with LAME `-t` files). |
| D8 | **AAC/M4A export is optional (phase 2)**: WebCodecs `AudioEncoder('mp4a.40.2')` + Mediabunny muxer, with the `@mediabunny/aac-encoder` WASM fallback for Firefox | WebCodecs AAC encoding: Chrome/Edge on Windows/macOS yes, Safari 26+ yes, **Firefox no** (tested: `false`). Opus encoding works everywhere. |
| D9 | **WAV export**: 16-bit (dithered) or 24-bit PCM with **WAVE_FORMAT_PCM (tag 1)** for ≤2 channels at ≤48 kHz; 32-bit float with tag 3 + `fact` chunk; WAVE_FORMAT_EXTENSIBLE only if needed | All 3 browsers decode tag 1 / 3 / 0xFFFE identically (tested). The spec "should" (Microsoft/McGill) says EXTENSIBLE for >16 bit. FFmpeg follows it, libsndfile-based tools write tag 1. Both are universally accepted. |
| D10 | **Sandboxed hosts: deliver audio inside a `.zip` (STORE)** when the host's save API has an extension allowlist without audio types | Embedding hosts that run the page in a sandboxed frame block `<a download>` and offer their own save call, often limited to document and image extensions (**no wav/mp3/m4a/flac**). The app gets that call from an optional host adapter (`globalThis.__AM_HOST__`, src/export/save.js). |
| D11 | Single-file build = **two esbuild passes** (worker → string, then main with the string injected) + a tiny Node script that inlines JS/CSS into the HTML | esbuild cannot bundle `new Worker(new URL(...))` (issue #312 is still open as of June 2026) and does not take HTML as an entry point. It escapes `</script>` in browser output automatically. |

---

## 1. Decoding with `decodeAudioData`

### 1.1 Codec / container support matrix

Legend: **T** = tested in the probe on macOS (Chrome 155 / Firefox 155 / Safari 17.2.1).
**S** = from sources only.

| Input | Chrome / Edge (Win, mac, Linux) | Firefox | Safari (macOS/iOS) | Notes |
|---|---|---|---|---|
| WAV PCM 16-bit, tag 1 | yes (T) | yes (T) | yes (T) | |
| WAV PCM 24-bit, tag 1 | yes (T) | yes (T) | yes (T) | |
| WAV PCM 24-bit, EXTENSIBLE (0xFFFE) | yes (T) | yes (T) | yes (T) | Firefox demuxer reads the SubFormat GUID (source) |
| WAV PCM 32-bit int (tag 1 and 0xFFFE) | yes (T) | yes (T) | yes (T) | |
| WAV IEEE float 32 (tag 3 + fact, and 0xFFFE) | yes (T) | yes (T) | yes (T) | |
| WAV IEEE float 64 | **no**, EncodingError (T) | **silently wrong** (T): 2× length, zeros | yes (T) | Firefox maps tag 3 to `pcm_f32le` regardless of bit depth (source). This is why we parse WAV ourselves. |
| WAV A-law/µ-law/u8 | yes (S: Chrome FFmpeg codec list) | yes (S) | yes (S) | irrelevant for Suno |
| MP3 (MPEG-1/2/2.5 L3) CBR/VBR | yes (T) | yes (T) | yes (T) | gapless: §1.4 |
| M4A / MP4 AAC-LC | yes (T) (**not** in vanilla open-source Chromium builds: their FFmpeg config has no `aac` decoder or ADTS demuxer) | yes (T) on macOS. Uses platform/system decoders; on Linux it depends on system FFmpeg (S, unverified) | yes (T) | Firefox ignores `iTunSMPB` priming: §1.4 |
| M4A / MP4 **ALAC** | **no** (T): Chrome FFmpeg codec list has no `alac` | **no** (T): "unknown content type" | yes (T) | Only Safari. Otherwise needs a WASM decoder (e.g. `@audio/decode-aac`, which claims AAC+ALAC) or a "convert to WAV" message |
| FLAC 16/24-bit, up to 96 kHz | yes (T) | yes (T) (since FF 51) | yes (T) (since Safari 11) | |
| Ogg Vorbis | yes (T) | yes (T) | 17.2: **no** (T). 18.4+: yes per MDN PR / release-note reports (S, reported buggy) | |
| Ogg Opus / .opus | yes (T) | yes (T) | 17.2: **no** (T). 18.4+: reportedly yes (S); a WebKit bug reports wrong duration for 48 kHz Ogg Opus in 26.1 | |
| WebM Opus | yes (S) | yes (S) | `<audio>` since 15. `decodeAudioData` was historically broken (WebKit bug 226922, 2021) | |
| AIFF / CAF | **no**: no demuxer in Chrome's FFmpeg build (source) | no (S) | yes (S, CoreAudio) | not needed for Suno |

Chrome's FFmpeg build (`chromium/config/Chrome/.../codec_list.c`) contains exactly these
decoders: `aac flac mp3 vorbis pcm_alaw pcm_f32le pcm_mulaw pcm_s16be pcm_s16le pcm_s24be pcm_s24le pcm_s32le pcm_u8 libopus`.
Its demuxers are `aac flac matroska mov mp3 ogg wav`. The open-source "Chromium" config has
the same list minus `aac`.

Chromium is also experimenting with a Rust **Symphonia** decoder behind a build flag and a
feature flag (`ENABLE_SYMPHONIA` in `media/filters/audio_file_reader.cc`). This has no
effect on us today.

**Other gotchas, tested:**

* **`decodeAudioData` detaches its input ArrayBuffer** in Chrome and Firefox (per spec).
  Safari 17.2 did **not** detach it. Always pass `bytes.slice(0)` (or `.slice().buffer`) if
  you still need the bytes for header or metadata parsing.
* **Decode speed is not an issue.** 10 s files decoded in 1-700 ms. First-call warm-up
  was ~500-700 ms in Chrome; Safari was fastest.
* **int16 → float scaling differs.** I infer from residuals that Chromium/Firefox map
  +32767 to 1.0 (asymmetric) while Safari divides by 32768. The difference is sub-LSB and
  irrelevant for mastering, but a null test against a "golden" file would show it.

### 1.2 Resampling: what happens and how to avoid it

* **Spec** (Web Audio API 1.1 Editor's Draft, 2026-09-09): decoded PCM is resampled "to the
  sample-rate of the BaseAudioContext if it is different from the sample-rate of
  audioData". This applies to `AudioContext` **and** `OfflineAudioContext`.
* **Resampler quality inside the engines** (source code, 2026-10-26):
  * Chromium `AudioBus::CreateBySampleRateConverting`: `media::SincResampler` with a
    **32-tap kernel**. A TODO says it is kept at 32 taps "for backwards compatibility".
  * Firefox `MediaBufferDecoder.cpp`: Speex resampler at **`SPEEX_RESAMPLER_QUALITY_DEFAULT` = 4** (range 0-10).
  * WebKit `AudioFileReaderCocoa.mm`: CoreAudio `AudioConverter` with the client format at
    the context rate. It sets no explicit quality property, so the CoreAudio default
    applies (exact quality unverified).
  * **AudioBufferSourceNode playing a buffer at a different rate**: Chromium
    `audio_buffer_source_handler.cc` and WebKit `AudioBufferSourceNode.cpp` use **linear
    interpolation**. Firefox uses Speex **`SPEEX_RESAMPLER_QUALITY_MIN` (0)**.
    **Never use an OfflineAudioContext as a resampler.**
* **How to avoid it:** sniff the native rate (§1.3), then
  `new OfflineAudioContext(2, 1, nativeRate).decodeAudioData(bytes.slice(0))`.
  Length 1 is fine, because the context is used only for decoding. Tested results:
  * Every lossless and lossy file came back at its native rate with **exactly 441000 or
    480000 frames** (MP3 needs a LAME tag and AAC needs priming info, see §1.4).
  * Through a mismatched context, 96 k→44.1 k and 48 k→44.1 k gave **440999** frames in
    Chrome (an off-by-one) and 441000 in Firefox/Safari.
  * Opus always decodes at 48 kHz natively.
* **Allowed rates** (tested and confirmed in source):

  | Context | Chrome / Firefox | Safari |
  |---|---|---|
  | `OfflineAudioContext` | **3000-768000 Hz** | **3000-384000 Hz** |
  | `AudioContext({sampleRate})` | 3000-768000 | 3000-384000 (Safari 17.2 accepted 3000-96000 in the probe and rejected 768000) |

  * Sources for the ranges: Chromium `MinAudioBufferSampleRate()=3000`,
    `MaxAudioBufferSampleRate()=768000`; Firefox `WebAudioUtils.h` `MinSampleRate=3000`,
    `MaxSampleRate=768000`; WebKit `isSupportedSampleRate`: `>= 3000 && <= 384000`.
  * The spec resolved to require [3000, 768000] (issue #2649, closed by PR #2657 on
    2026-01-07). Older spec text says "at least 8000-96000".
* **Preview playback.** A real-time `AudioContext({ sampleRate: fileRate })` works in all
  3. Safari has a history of glitches with a non-default rate (WebKit bugs 219201 in 2020
  and 274507 in iPadOS 17.5.1, both fixed). Use the **default device rate for preview**
  and accept the browser's resampling *for monitoring only*. Never use it for export.

### 1.3 Detecting the native sample rate from headers (for D2)

| Format | Where | Notes |
|---|---|---|
| WAV/RF64 | Walk RIFF chunks; `fmt ` data offset +4 = `uint32 LE` sampleRate (offset 24 only when `fmt ` is the first chunk) | `JUNK`, `bext`, `LIST` and `iXML` chunks can precede `fmt `. Chunks are padded to even sizes. Tag 0xFFFE: real format = first 2 bytes of SubFormat GUID at fmt data offset +24. |
| MP3 | Skip ID3v2: `"ID3"`, size = 4 synchsafe bytes at offset 6 (7 bits each), +10 header, +10 if footer flag (byte 5 bit 4). Then find sync `0xFFE`. Version bits `(b1>>3)&3`, rate index `(b2>>2)&3`. | Rates: MPEG-1 [44100, 48000, 32000]; MPEG-2 [22050, 24000, 16000]; MPEG-2.5 [11025, 12000, 8000]. Validate 2-3 consecutive frames to avoid false syncs. |
| MP4/M4A | `moov/trak/mdia/mdhd` timescale (normally = sample rate), cross-checked with the `mp4a` sample entry `samplerate` (16.16 fixed at entry offset 32) | For HE-AAC (SBR) the `esds` AudioSpecificConfig shows the core rate (e.g. 24 k) while output is 48 k. Prefer `mdhd`. For ALAC, the `alac` box has a 32-bit rate. |
| FLAC | `"fLaC"` + 4-byte block header + STREAMINFO: 20-bit sample rate at **file offset 18** (`(b18<<12)\|(b19<<4)\|(b20>>4)`) | The same bytes hold channels−1 (3 bits), bps−1 (5 bits) and total samples (36 bits) |
| Ogg Vorbis | First page, packet `\x01vorbis`: `uint32 LE` rate at packet offset 12 | |
| Ogg Opus | `OpusHead`: input rate at offset 12 is **informational only**. Decode at 48000. | |

All of this fits in ~150 lines of JS. Mediabunny (`Input…getPrimaryAudioTrack().getSampleRate()`)
can do it too, but that is a ~690 KB dependency.

### 1.4 Encoder delay / padding (gapless) in browser decoders (tested)

Test signal: impulse at exactly frame 44100. "Offset" = decoded impulse position − 44100.

| File | Chrome 155 | Firefox 155 | Safari 17.2 |
|---|---|---|---|
| MP3 LAME 3.100, **with** Info/LAME tag (CBR 320 and V0) | offset 0, length 441000 ✓ | 0, 441000 ✓ | 0, 441000 ✓ |
| MP3 **without** tag (`lame -t`, which is what lamejs produces) | **+1105**, length 442368 | **+1105**, 442368 | **+576**, 442368 |
| M4A AAC from afconvert (priming only in `iTunSMPB`) | 0, 441000 ✓ | **+2112, 443392** ✗ | 0, 441000 ✓ |
| M4A AAC from FFmpeg (`elst` media_time 1024) | 0 ✓ | 0 ✓ | 0 ✓ |
| Opus (pre-skip) | 0 ✓ | 0 ✓ | n/a |

Consequences:

* **LAME tag layout** (verified on the test files):
  * For MPEG-1 stereo the `Xing`/`Info` tag sits at offset 36 of the first frame, and
    `LAME` at Xing+120.
  * Encoder delay/padding are 3 bytes at **LAME+21**: `delay = b0<<4 | b1>>4`,
    `pad = (b1&15)<<8 | b2`. LAME 3.100 gave delay 576; padding was 792 at 44.1 k and
    960 at 48 k.
  * Decoders also remove the 529-sample decoder delay, hence 1105.
  * Only trust the bytes when an `Xing`/`Info` tag exists: untagged LAME files still
    contain the ASCII `LAME` string inside the frame data.
* **Firefox does not apply `iTunSMPB`.** Apple-encoded M4A (Music/iTunes/GarageBand/
  afconvert) gets ~48 ms of extra leading silence and a longer tail. Fix: parse
  `moov/udta/meta/ilst/----` `iTunSMPB` (hex fields: priming, padding, original length)
  and trim when `decoded length ≠ original length`.
* Firefox fixed MP3 LAME-tag trimming in **Firefox 83** (bug 1566389).
* For a mastering app this is cosmetic: a few ms at the head. But keep the head/tail
  trimming deterministic so A/B alignment and the reported duration match across browsers.

---

## 2. OfflineAudioContext

* **Constructor limits** (Chromium source):
  * `length ≥ 1`. New Chromium also supports an *optional* length (indefinite
    rendering, Web Audio 1.1), but don't rely on it.
  * `1 ≤ numberOfChannels ≤ 32`.
  * Sample rate within the §1.2 range.
  * Optional `renderSizeHint`.
  * Allocation failure throws `NotSupportedError: "...could not be created due to memory
    limitations."` The destination buffer (length × channels × 4 bytes) is allocated **up
    front**.
* **Not available in workers.** Chromium throws `NotSupportedError: "Workers are not
  supported."`. The probe confirmed `typeof OfflineAudioContext === 'undefined'` in
  workers in Chrome, Firefox and Safari. WebCodecs `AudioEncoder`/`AudioDecoder` *are*
  available in workers (Chrome and Firefox).
* **Speed, tested.** A 10-minute stereo 48 kHz render through HP biquad, peaking biquad
  and DynamicsCompressor:

  | Browser | Render time | Speed |
  |---|---|---|
  | Chrome 155 | 3.5 s | 170× realtime |
  | Chromium 152 | 7.0 s | 86× |
  | Firefox 155 | 4.5 s | 133× |
  | Safari 17.2 | 2.2 s | 274× |

  Rendering runs off the main thread. Filling the input buffer from JS took 0.5-3 s
  (JS-bound).
* **DynamicsCompressorNode is not portable** (tested). The same render ended at
  −1.27 dB reduction in Chrome/Safari and −7.76 dB in Firefox. Keep dynamics in our own
  JS DSP.
* **AudioWorklet in OfflineAudioContext** works when loaded from a Blob URL over http
  in all 3. Under **file://** `addModule(blob:)` **fails in Chrome and Safari** and
  works in Firefox (tested). This is another reason to keep DSP in plain JS (worker or
  inline).
* **WebKit history:** each OfflineAudioContext used a thread and leaked up to ~2048
  (bug 198964, fixed 2019). iOS 14.4 failed after ~26 contexts (bug 224279, fixed).
  Create few contexts and drop references.

### 2.1 Memory budget (float32 = 4 bytes/sample)

| Item | 5 min @44.1 k | 5 min @48 k | 10 min @48 k | 10 min @96 k |
|---|---|---|---|---|
| Decoded stereo Float32 (one copy) | 106 MB | 115 MB | **230 MB** | 461 MB |
| 24-bit stereo WAV output | 79 MB | 86 MB | 173 MB | 346 MB |
| 16-bit stereo WAV output | 53 MB | 58 MB | 115 MB | 230 MB |
| MP3 320 kbps | 12 MB | 12 MB | 24 MB | n/a (resample) |

A naive pipeline peaks at **~4-5× the decoded size**: file bytes, AudioBuffer, worker
copy, rendered output, and A/B original kept for preview, plus the encoded file. That is
about 1 GB for 10 min @48 k: fine on desktop, risky on iOS.

Mitigations:

* Drop the `File` ArrayBuffer after decoding.
* Move channel data to the worker by transfer. Tested in Chromium 152: transferring
  `audioBuffer.getChannelData(c).buffer` is zero-copy and empties the AudioBuffer. That is
  not verified in Firefox/Safari, so the safe path is `copyFromChannel` → transfer.
* Process in place.
* Build the WAV Blob from an array of chunk `Uint8Array`s instead of one giant buffer.
* Cap input at ~15 min (Suno songs are ≤ 8 min).

Blob and ArrayBuffer limits are not the bottleneck:

* 250 MB Blobs were created in 110-340 ms in all 3 (tested).
* Chrome blob storage: 2 GB in memory on 64-bit desktop, then disk-backed up to
  disk/10. Android: physical RAM/100 in memory.
* Firefox max ArrayBuffer: 8 GiB on 64-bit (since FF 89).

---

## 3. Workers

| Feature | Chrome | Firefox | Safari | Source |
|---|---|---|---|---|
| Module workers `{type:'module'}` | 80 | 114 | 15 | caniuse |
| Classic Blob-URL worker over http | ✓ (T) | ✓ (T) | ✓ (T) | probe |
| **Classic Blob-URL worker from file://** | ✓ (T) | ✓ (T) | ✓ (T) | probe (`blob:null/...`) |
| **Module Blob-URL worker from file://** | **✗ (T)**, error event with no message | ✓ (T) | ✓ (T) | probe |
| Transfer 230 MB Float32Array (round trip) | 133-246 ms (T) | 34-48 ms (T) | 22-24 ms (T) | probe. Sender is detached ✓ |
| `crossOriginIsolated` / `SharedArrayBuffer` | false / undefined (T) | same | same | needs `COOP: same-origin` + `COEP: require-corp` (or `credentialless`) |

Recommendations:

* Build the worker as **one IIFE bundle**, then
  `new Worker(URL.createObjectURL(new Blob([code], {type:'text/javascript'})))`.
* In a Blob worker, relative URLs (`importScripts('x.js')`, `fetch('./a.wasm')`,
  `new URL(..., import.meta.url)`) resolve against `blob:` and fail. Inline everything.
  WASM can be passed as bytes, or as a compiled `WebAssembly.Module`, which is
  structured-cloneable, through `postMessage`.
* CSP: workers are governed by `worker-src` → `child-src` → `script-src` → `default-src`
  (MDN). A host page that omits `blob:` blocks this. **Always keep the inline fallback**:
  run the same DSP functions on the main thread and yield with `scheduler.yield()`
  (present in Chrome 155 and Firefox 155, absent in Safari 17.2, tested) or with a
  `setTimeout(0)` / `MessageChannel` fallback. This matches ARCHITECTURE.md
  `EngineClient`.
* Dev mode (served over http) can keep `new Worker(new URL('./worker.js', import.meta.url), {type:'module'})`.
  The single-file build must set the Blob URL to a **classic** worker.

---

## 4. Encoding in the browser

### 4.1 MP3

| Option | Version (date) | License | Size | Notes |
|---|---|---|---|---|
| `lamejs` (zhuker) | **1.2.1** (2021-12-02, last release) | LGPL-3.0 | `lame.min.js` 156 KB | npm `main` = `src/js/index.js` (CommonJS). Several open issues (#86, #89, #91, #101-#103, 2022-2025) report "MPEGMode is not defined" / "Lame is not defined" under bundlers (webpack/vite), because the npm sources lack some `require`s. The **prebuilt `lame.min.js`** (a global `lamejs` function) does not have this problem. |
| `@breezystack/lamejs` | **1.2.7** (2023-10-17) | LGPL-3.0 | ESM 260 KB / IIFE 169 KB | Fork published from upstream `main`. Adds ESM `dist/lamejs.js`, IIFE `dist/lamejs.iife.js` and types. Same API. |
| `@mediabunny/mp3-encoder` | 1.61.3 (2026-10-05) … 1.62.1 (2026-10-22) | MPL-2.0 (wraps LAME) | 312 KB min (WASM inlined) | Real LAME in WASM, run in its **own Blob-URL classic worker**, so CSP must allow `worker-src blob:` and WASM. Needs `mediabunny` (~690 KB min, tree-shakable). Mp3OutputFormat writes a Xing header by default. Whether it writes LAME delay/padding is unverified. |
| `wasm-media-encoders` | 0.7.0 (2024-05-24) | MIT | — | LAME/Ogg WASM, older |

**Exact CDN URLs** (all returned HTTP 200 on 2026-10-26; versions are ≥ 2 weeks old):

* `https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js`
  (cdnjs has 1.2.1, 1.2.0, 1.1.0, 1.0.0; the fork is not on cdnjs)
* `https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js`
* `https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js` (ESM:
  `export { Mp3Encoder, WavHeader }`, default export)
* `https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.iife.js`
  (global `lamejs`)
* `https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs`
* `https://cdn.jsdelivr.net/npm/@mediabunny/mp3-encoder@1.61.3/dist/bundles/mediabunny-mp3-encoder.min.mjs`

**What lamejs's `Mp3Encoder` actually configures** (read from the 1.2.7 source, same as
upstream; type definitions shown below):

```js
// new Mp3Encoder(channels, sampleRate, kbps) sets:
R.mode = STEREO /* plain L/R, not joint stereo */; R.quality = 3; R.bWriteVbrTag = false;
R.disable_reservoir = true; R.write_id3tag_automatic = false;   // CBR only
encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array   // feed 1152-sample blocks
flush(): Int8Array
```

What that means in practice:

* **No Info/LAME tag**, so decoders add 1105 (Chrome/Firefox) or 576 (Safari) samples
  of leading silence plus end padding (§1.4). This is acceptable for a release single.
  An optional improvement is to prepend our own Info frame with delay = 576 and the
  computed padding.
* **The bit reservoir is disabled** and the mode is L/R stereo. At 320 kbps the quality
  cost is negligible; at ≤192 kbps it matters. Offer 320 CBR only.
* **Input must be Int16** (dither from float first) at **32/44.1/48 kHz**. 320 kbps
  exists only for MPEG-1 rates; MPEG-2 rates max out at 160 kbps.
* **Speed:** the README claims ~20× realtime (132 s encoded in 6.5 s, 2015-era hardware).
  The probe could not benchmark it, because executing downloaded code was not permitted
  in this session. Expect a 4-minute song to take a few seconds on a modern laptop. Run it
  in the worker, or chunked on the main thread with progress (ARCHITECTURE.md budget:
  MP3 320 < 10 s).
* **Licensing:** LGPL-3.0. Keep lamejs as a separately replaceable file or chunk with its
  license notice. That is fine for an open-source GitHub project.

### 4.2 AAC (.m4a) and Opus via WebCodecs

| `AudioEncoder.isConfigSupported` | Chrome 155 mac (T) | Firefox 155 mac (T) | Safari 17.2 (T) | Field data (webcodecsfundamentals.org, 7.6 M sessions, 2026) |
|---|---|---|---|---|
| `mp4a.40.2` AAC-LC 44.1/48 k, 256 kbps | **true** | **false** | no WebCodecs audio | Chrome Win 99.7%, mac 99.6%, Android 97%, **Linux 49%**; Edge Win/mac ~100%, Linux 0.6%; Safari mac 77.5% / iOS 78% (≈ users on 26+); **Firefox ≈ 0%** |
| `mp4a.40.5` HE-AAC | true | false | — | |
| `opus` | true | true | — | ~97% overall; Firefox Android ~0% |
| `vorbis` | false | true | — | |
| `flac`, `mp3`, `pcm-*` | false | false | — | 0% (no browser encodes these) |

* **Version support:** `AudioEncoder`/`AudioDecoder` shipped in Chrome/Edge 94,
  Firefox 130 (desktop; not Firefox Android), and **Safari 26.0** (macOS/iOS), per
  caniuse.
* **Speed:** AAC 256 kbps, 10 s stereo → 434 chunks / 133.7 KB in **142-154 ms** in
  Chrome (~70× realtime, tested). `decoderConfig.description` = 2-byte
  AudioSpecificConfig.
* **Bitstream format** (W3C AAC registration, 2026-09-24): `aac: { format: 'aac' }` is
  the default and puts the ASC in `description`, as needed for MP4. `'adts'` carries a
  header in every frame (raw `.aac`).
* **A muxer is required for .m4a.** WebCodecs outputs raw packets.
  * **Mediabunny** (`Mp4OutputFormat`, `fastStart: 'in-memory'` with `BufferTarget`)
    supersedes the deprecated `mp4-muxer` 5.2.2, whose npm page says "superseded by
    Mediabunny".
  * A hand-written minimal muxer is ~300 lines: `ftyp`, `moov/mvhd/trak/tkhd/mdia/mdhd/hdlr/minf/smhd/dinf/stbl(stsd/mp4a/esds, stts, stsc, stsz, stco)`
    + `mdat`. Add an `edts/elst` priming entry so Firefox trims the encoder delay (§1.4).
    The encoder's priming count is not exposed by WebCodecs, so it is **uncertain** and
    must be tested per platform.
* **Firefox fallback:** `@mediabunny/aac-encoder` (FFmpeg's native AAC encoder in WASM,
  ~990 KB min, first published 2026-03-04). Its quality is below Apple/FDK at low
  bitrates; at 256 kbps it is acceptable.
* **Recommendation:** distributors want WAV (see 03-platform-specs), so ship AAC/M4A as
  a phase-2 nice-to-have. If it is shipped, a sandboxed host may need it saved as **`.mp4`
  or inside a `.zip`** (D10).

---

## 5. Writing WAV

Header layout (little-endian, every chunk word-aligned, pad byte after an odd-sized chunk):

```
RIFF <u32 fileSize-8> WAVE
fmt  <u32 16|18|40>  u16 formatTag  u16 channels  u32 sampleRate
                     u32 byteRate(=sr*ch*bytesPerSample)  u16 blockAlign(=ch*bytesPerSample)
                     u16 bitsPerSample(container: 16|24|32)
     [u16 cbSize]                       // 18-byte fmt: non-PCM (tag 3) → cbSize = 0
     [u16 validBits u32 channelMask GUID SubFormat]   // 40-byte fmt: tag 0xFFFE, cbSize = 22
fact <u32 4> u32 sampleFramesPerChannel // required for non-PCM (tag 3 float); harmless otherwise
data <u32 byteLength> interleaved samples
```

| Output | formatTag | fmt size | bits / blockAlign (stereo) | Sample encoding |
|---|---|---|---|---|
| 16-bit PCM | 1 | 16 | 16 / 4 | `Int16 = clamp(round(x·32767 + TPDF dither))` |
| 24-bit PCM | 1 (or 0xFFFE) | 16 (or 40) | 24 / 6 | 3 bytes LE, two's complement, `round(x·8388607)` |
| 32-bit float | 3 | 18 (cbSize 0) + `fact` | 32 / 8 | `setFloat32(..., true)` |
| EXTENSIBLE | 0xFFFE | 40 (cbSize 22) | container multiple of 8; `wValidBitsPerSample`; `dwChannelMask` 0x3 for stereo | SubFormat `0000000{1\|3}-0000-0010-8000-00aa00389b71` |

* **When EXTENSIBLE is "required":** Microsoft (mmreg.h, updated 2024-02-22) says it is
  for "more than two channels or higher sample resolutions than allowed by WAVEFORMATEX".
  McGill/Kabal (2022-09-27) says use it when PCM is >16 bits, >2 channels, valid bits ≠
  container, or a speaker mapping is needed.
* **What real tools do:** FFmpeg `riffenc.c` writes 0xFFFE when the layout is not
  mono/stereo, the **rate is >48 kHz**, or integer PCM is **>16-bit**. Float stays tag 3.
  libsndfile-based tools (Audacity) and most DAWs write tag 1 for 24-bit stereo.
* **Browser behavior:** all three browsers decode tag 1, 3 and 0xFFFE identically
  (tested).
* **Recommendation:** tag 1 for 16/24-bit stereo ≤48 kHz (maximum legacy compatibility);
  0xFFFE when >2 channels or >48 kHz; tag 3 + `fact` for float.
* Size limit: RIFF is limited to 4 GiB (u32). Not an issue (10 min 24/48 = 173 MB).
  RF64 is unnecessary.
* Optional metadata: a `LIST/INFO` chunk (INAM title, IART artist, ISFT "AudioMaster") and
  an `id3 ` chunk, both before `data` (data stays the last chunk). Some distributors ignore
  them; they are harmless.

---

## 6. Downloading / saving

* **Standalone page:**
  `a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();`
  then `URL.revokeObjectURL` **after a delay** (e.g. 30-60 s, or on the next export).
  Revoking immediately can cancel the download in some Safari/Firefox versions (common
  practice; not verified here).
  * `<a download>` is supported everywhere (tested).
  * `showSaveFilePicker` exists in Chrome only; it is undefined in Firefox/Safari (tested).
* **Sandboxed iframes** need `allow-downloads`, which Chrome enforces since v83. Hosts
  that embed pages without it usually provide their own save API.
* **Embedding host build:** an optional adapter defines `globalThis.__AM_HOST__` with
  `downloads()` (resolving the host's saver, or `null` when this view cannot save, so the
  button is hidden) and the host's accepted `extensions`. Save with
  `await saver.save({ filename, data: blob })`.
  * The viewer may see a confirmation and decline (`declined`); never auto-retry.
  * When the allowlist has **no audio extensions**, wrap WAV/MP3 in a **STORE zip**. That
    is ~80 lines with CRC-32, or `fflate@0.8.3` (MIT) `zipSync(files, { level: 0 })`.
    AAC could go out as `.mp4`.
  * Passing a Blob avoids copies (a Blob is handed over as-is; an ArrayBuffer is
    transferred and detached). A host may refuse large files (`too_large`).
* **Unknown per host:** whether its CSP allows `blob:` workers and WASM. Design for
  absence (inline DSP fallback; lamejs is pure JS, not WASM), and verify on each host.

---

## 7. esbuild: vanilla ES modules + worker → one self-contained HTML

esbuild 0.28.2 is the current version (2026-08-08). Recipe (`tools/build.mjs`, Node 20):

```js
import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const common = { bundle: true, minify: true, platform: 'browser', target: ['es2020'], write: false, legalComments: 'eof' };
// 1) worker → one classic IIFE string (no imports left; WASM, if any, inlined as base64)
const w = await esbuild.build({ ...common, entryPoints: ['src/engine/worker.js'], format: 'iife' });
const workerCode = w.outputFiles[0].text;
// 2) main app; inject the worker source as a string constant
const m = await esbuild.build({ ...common, entryPoints: ['src/main.js'], format: 'iife',
  define: { __AM_WORKER_SRC__: JSON.stringify(workerCode) } });
const css = (await esbuild.build({ ...common, entryPoints: ['src/ui/styles.css'] })).outputFiles[0].text;
let html = await readFile('index.html', 'utf8');
// use FUNCTION replacers: string replacers interpret $&, $', $` sequences found in minified code
html = html.replace('<!--CSS-->', () => `<style>${css}</style>`)
           .replace(/<script type="module" src="[^"]+"><\/script>/, () => `<script>${m.outputFiles[0].text}</script>`);
await writeFile('dist/index.html', html);
```

At runtime:

```js
const url = URL.createObjectURL(new Blob([__AM_WORKER_SRC__], { type: 'text/javascript' }));
const worker = new Worker(url); // classic, NOT {type:'module'} (fails in Chrome on file://)
```

Gotchas:

1. **No native worker bundling.** Issue #312 is open (2020-08 → latest comment 2026-06-19).
   PR #2508 is unmerged. evanw calls the inline-Blob technique "fragile". It *is* robust
   when you control it as above: a separate IIFE build plus `define`.
2. **`define` needs a JSON-encoded string.** A large string is fine (hundreds of KB).
   Alternatively use a plugin resolving `virtual:worker` with `loader: 'text'`.
3. **`</script>` inside inlined JS.** With platform `browser`, esbuild escapes `</script`
   in strings, regexes, template literals and comments automatically (since 0.12.5;
   regression fixed in 0.16.8). The same applies to `</style` in CSS (the
   `supported: { 'inline-script': false }` switch turns it off). After the build, still
   `grep -c '</script' dist/index.html` (expect exactly the real closing tags), and also
   check for `<!--`, which can trigger the legacy "script data escaped" parsing state.
4. **No `import.meta.url` / dynamic `import()` of relative files** in the single file:
   format `iife` flattens imports. Code paths that use `new URL('./worker.js', import.meta.url)`
   must be behind a check for the injected constant (as ARCHITECTURE.md already does with
   `__AM_WORKER_URL__`).
5. **Third-party code** (lamejs) can be bundled (the fork's ESM imports cleanly) or kept
   as a CDN `<script>` with an exact version. If bundled, keep the LGPL notice
   (`legalComments`).
6. **file:// distribution** ("download and double-click"):
   * Classic Blob workers, `decodeAudioData`, OfflineAudioContext and Blob downloads all
     work (tested in all 3).
   * Module Blob workers fail in Chrome; `audioWorklet.addModule(blob:)` fails in Chrome
     and Safari.
   * `fetch()` of sibling files fails.
   * CDN `<script>` tags work if online.
7. esbuild does not process HTML. The 20-line string-replace step above is the standard
   approach. Plugins like `esbuild-plugin-html` exist but add dependencies.

---

## 8. Open questions / to verify during implementation

* **Safari 26/27:**
  * Ogg Opus/Vorbis `decodeAudioData` reliability.
  * WebCodecs AAC encoding parameters.
  * Whether `decodeAudioData` now detaches its input.
  * Real-time AudioContext at 44.1 k on iOS.
* **Windows/Linux:**
  * Firefox AAC (platform decoders: Media Foundation / system FFmpeg).
  * Chrome Linux AAC encoding (field data: only ~49%).
* **Zero-copy transfer** of `getChannelData().buffer` in Firefox/Safari. Chrome 152:
  works and empties the AudioBuffer.
* **WebCodecs AAC priming** (for a correct `elst`), and whether Mediabunny writes it.
* **Sandboxed hosts:** `blob:` worker and WASM CSP; save behavior with ~150 MB zips.
* **lamejs throughput** on target hardware (not benchmarked here).
* **Suno's exact export specs** (rate/bit depth/bitrate) are not officially documented,
  so sniff them from headers rather than assuming 44.1 or 48 kHz.

## 9. Reproducing the probe

The probe page (decode / worker / WebCodecs and file:// checks), the test-signal generator
and the raw JSON results were produced in a temporary research workspace and are not part
of the repository. The measured results are summarised in the sections above; a browser
compatibility smoke test could be added under `tests/browser/`.

---

## Sources

Specs and standards:

* W3C Web Audio API 1.1 Editor's Draft (2026-09-09): https://webaudio.github.io/web-audio-api/ (decodeAudioData resampling and detach; createBuffer ≥32 channels)
* Web Audio issue #2649, "supported sample rates" (closed 2026-01-07 by PR #2657, range 3000-768000): https://github.com/WebAudio/web-audio-api/issues/2649
* W3C WebCodecs AAC codec registration (Group Note Draft, 2026-09-24): https://www.w3.org/TR/webcodecs-aac-codec-registration/
* Microsoft WAVEFORMATEXTENSIBLE (updated 2024-02-22): https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible
* P. Kabal, McGill, WAVE file specifications (2022-09-27): https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html
* LAME/Xing info tag spec (delay/padding bytes $B1-$B3): http://gabriel.mp3-tech.org/mp3infotag.html

Engine source code (read 2026-10-26):

* Chromium `audio_utilities.cc` (3000/768000): https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/audio_utilities.cc
* Chromium `offline_audio_context.cc` ("Workers are not supported.", memory error): https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webaudio/offline_audio_context.cc
* Chromium `audio_bus.cc` (32-tap SincResampler for decode): https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/audio/audio_bus.cc
* Chromium `audio_buffer_source_handler.cc` (linear interpolation): https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webaudio/audio_buffer_source_handler.cc
* Chromium `media/filters/audio_file_reader.cc` (AAC priming 2112/519, MP3 packet handling, Symphonia flag): https://chromium.googlesource.com/chromium/src/+/main/media/filters/audio_file_reader.cc
* Chrome/Chromium FFmpeg codec and demuxer lists: https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/refs/heads/master/chromium/config/
* WebKit `BaseAudioContext.cpp` (3000-384000): https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/BaseAudioContext.cpp
* WebKit `AudioBufferSourceNode.cpp` (linear interpolation): https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioBufferSourceNode.cpp
* WebKit `AudioFileReaderCocoa.mm` (AudioConverter, prime info): https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/AudioFileReaderCocoa.mm
* Firefox `WebAudioUtils.h` (3000/768000): https://searchfox.org/mozilla-central/source/dom/media/webaudio/WebAudioUtils.h
* Firefox `MediaBufferDecoder.cpp` (Speex quality default): https://hg.mozilla.org/mozilla-central/file/tip/dom/media/webaudio/MediaBufferDecoder.cpp
* Firefox `AudioBufferSourceNode.cpp` (Speex QUALITY_MIN): https://hg.mozilla.org/mozilla-central/file/tip/dom/media/webaudio/AudioBufferSourceNode.cpp
* Firefox `WaveDemuxer.cpp` and `FFmpegAudioDecoder.cpp` (WAV tag → pcm_u8/s16/s24/s32/f32/alaw/mulaw): https://hg.mozilla.org/mozilla-central/file/tip/dom/media/wave/WaveDemuxer.cpp, https://hg.mozilla.org/mozilla-central/file/tip/dom/media/platforms/ffmpeg/FFmpegAudioDecoder.cpp
* Speex resampler quality constants: https://github.com/xiph/speexdsp/blob/master/include/speex/speex_resampler.h
* FFmpeg `riffenc.c` (when WAVE_FORMAT_EXTENSIBLE is written): https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/riffenc.c
* Chromium blob storage limits: https://chromium.googlesource.com/chromium/src/+/main/storage/browser/blob/README.md

Bugs and issues:

* Mozilla bug 1566389 (MP3 LAME delay/padding trimming, fixed Firefox 83): https://bugzilla.mozilla.org/show_bug.cgi?id=1566389
* WebKit bug 226922 (Safari 15 WebM Opus decodeAudioData): https://bugs.webkit.org/show_bug.cgi?id=226922
* WebKit bug 215289 (wider sample-rate range, fixed 2020-08-07): https://bugs.webkit.org/show_bug.cgi?id=215289
* WebKit bugs 219201, 274507 (non-default AudioContext rate glitches): https://bugs.webkit.org/show_bug.cgi?id=219201, https://bugs.webkit.org/show_bug.cgi?id=274507
* WebKit bugs 198964, 224279 (OfflineAudioContext thread/instance limits): https://bugs.webkit.org/show_bug.cgi?id=198964, https://bugs.webkit.org/show_bug.cgi?id=224279
* WebKit bug 293310 (Ogg Opus 48 kHz duration in Safari 26.1): https://bugs.webkit.org/show_bug.cgi?id=293310
* Report that Ogg Opus is incomplete in Safari 18.4 (May 2025): https://frequal.com/java/OggOpusStillNotWorkingInSafari18_4.html
* MDN PR on Safari 18.4 Ogg Opus/Vorbis: https://github.com/mdn/content/pull/39592
* lamejs issues ("MPEGMode is not defined": #86, #89, #91, #101, #102, #103): https://github.com/zhuker/lamejs/issues?q=MPEGMode
* esbuild issue #312 (worker bundling): https://github.com/evanw/esbuild/issues/312
* esbuild 0.12.5 and 0.16.8 release notes (`</script>` escaping): https://github.com/evanw/esbuild/releases/tag/v0.12.5, https://newreleases.io/project/npm/esbuild/release/0.16.8

Docs and compatibility data:

* MDN audio codec guide (modified 2026-10-13): https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs
* MDN SharedArrayBuffer security requirements (modified 2026-02-10): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
* MDN CSP worker-src (modified 2025-07-04): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src
* MDN invalid array length (Firefox 8 GiB ArrayBuffer): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Invalid_array_length
* caniuse, module workers: https://caniuse.com/mdn-api_worker_worker_ecmascript_modules
* caniuse, AudioEncoder: https://caniuse.com/mdn-api_audioencoder
* caniuse, AudioDecoder: https://caniuse.com/mdn-api_audiodecoder
* caniuse, Opus: https://caniuse.com/opus
* WebCodecs field data (AAC encoder/decoder by browser and OS, 2026): https://webcodecsfundamentals.org/codecs/mp4a.40.2.html, https://webcodecsfundamentals.org/codecs/opus.html, https://webcodecsfundamentals.org/datasets/codec-support-table/
* esbuild API docs: https://esbuild.github.io/api/
* Mediabunny supported formats and codecs: https://mediabunny.dev/guide/supported-formats-and-codecs
* Mediabunny output formats: https://mediabunny.dev/guide/output-formats
* lamejs README (~20× realtime claim): https://github.com/zhuker/lamejs
* `@breezystack/lamejs` README and types (v1.2.7): https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/README.md
* `@mediabunny/mp3-encoder` and `@mediabunny/aac-encoder` READMEs (v1.62.1): https://cdn.jsdelivr.net/npm/@mediabunny/mp3-encoder@1.62.1/README.md, https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.62.1/README.md
* npm registry metadata (versions, dates, licenses): https://registry.npmjs.org/lamejs, https://registry.npmjs.org/@breezystack/lamejs, https://registry.npmjs.org/mediabunny, https://registry.npmjs.org/mp4-muxer, https://registry.npmjs.org/esbuild, https://registry.npmjs.org/fflate
* cdnjs lamejs listing: https://api.cdnjs.com/libraries/lamejs
* `audio-decode` 3.11 README (WASM decoders incl. ALAC): https://cdn.jsdelivr.net/npm/audio-decode@3.11.0/readme.md
