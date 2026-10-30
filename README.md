# AudioMaster

[Italiano](README.it.md)

One-click mastering in the browser for songs made with **Suno** (or any other track). It
cleans up the typical artifacts of AI-generated audio, balances the sound and sets the
loudness exactly where Spotify, Apple Music, YouTube and the other platforms want it.
Everything runs on your computer: no file is ever uploaded to a server.

The interface starts in Italian: press **EN** at the top to switch to English (the choice
is remembered).

## How to use it

1. Choose where the song is going (**Streaming** is the recommended choice), then drop
   the file (MP3, WAV, M4A/AAC, FLAC, OGG) or press **Try the demo**.
2. AudioMaster analyses it and creates a master with the recommended settings right away.
3. Listen to the **Original / Master** comparison (space bar to play, **B** to switch).
   Both are played at the same loudness, so you judge the quality, not the volume.
4. Press **Download master**: 24-bit WAV (recommended for distributors), 16-bit WAV (CD
   quality, 44.1 kHz) or 320 kbps MP3. The sample rate is chosen automatically.
5. If you like, adjust **Character**, **Intensity**, how much to **clean AI artifacts** and
   the **It sounds too…** buttons: the master updates by itself. With several songs (album,
   EP), **Export all (ZIP)** saves them together, all with the same destination.
6. **Cut** (above the waveform) opens the cutting tools: drag to select a part, listen to
   it (also in a loop), save it as a clip of the master (**Save selection**), or remove or
   keep only that part of the song before mastering (**Delete the selection** / **Keep only
   the selection**, always undoable).
7. **Undo** / **Redo** (at the top, or Ctrl/⌘ + Z and Ctrl/⌘ + Shift + Z) step back and
   forth through every change to the sound: destination, character, settings, cuts (last
   50 steps).
8. The **Metadata** box shows the cover art and every tag in the file (title, artist,
   album, lyrics, links, technical details). By default the master keeps the cover and the
   tags; switch it off to export a clean file.
9. **Theme** (top right) switches the look: Automatic, Dark, Light, Fluo Techno, Analog,
   Synthwave or High contrast.

Every control has an **(i)** button that explains what it does, when to use it, with an
example.

## What it does to the sound

| Stage | What it fixes |
|---|---|
| Spectral cleanup | metallic hiss and "shimmer" in the highs, background noise |
| Dynamic EQ | muddy low mids, boom, 2–6 kHz harshness, sibilance, "fizz" |
| Automatic EQ | tonal balance against the song's own natural curve, or against a reference track |
| Saturation and "air" | light warmth; rebuilds highs cut off by MP3 encoding |
| Multiband and glue compression | more cohesive, controlled dynamics without squashing |
| Stereo | mono bass (compatibility and punch), controlled width |
| Loudness and true-peak limiter | exact loudness (e.g. −14 LUFS, −1 dBTP) without codec distortion |
| Quality check | if a stage made something worse (dull highs, phase), it is softened |

The thresholds and recipes are documented in [docs/RESEARCH.md](docs/RESEARCH.md); the
contracts between modules in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it locally

You only need Node.js 18+ (for the dev server, the build and the tests).

```bash
npm ci             # installs esbuild, the only dependency (build only)
npm run dev        # → http://localhost:5173
```

The dev server only answers this computer. To try the app on a phone on the same Wi-Fi:
`npm run dev -- --host=0.0.0.0` (hidden files and folders, such as `.git/`, are never served).

```bash
npm test           # DSP, loudness (checked against ffmpeg when installed), engine, UI logic
```

```bash
npm run build      # → dist/index.html, one file that also works opened from disk
```

`dist/` is not committed: it is always rebuilt with `npm run build`.

## Run it with Docker

The image builds the app and serves it with nginx on port 8080 (no Node needed on the
host). Songs are still processed in the browser: nothing is uploaded to the container.

```bash
docker build -t audiomaster .
docker run --rm -p 8080:8080 audiomaster   # → http://localhost:8080
```

Or with Compose, which rebuilds it from the current sources at every start and runs it
read-only, without extra privileges:

```bash
docker compose up -d                       # → http://localhost:8080
```

## Publish on GitHub Pages

The workflow [.github/workflows/pages.yml](.github/workflows/pages.yml) runs
`npm ci && npm run build` on every push to `main` and publishes `dist/`. Enable it once:
**Settings → Pages → Build and deployment → Source: GitHub Actions**. No secrets are
needed. You can also start it by hand from the **Actions** tab (*Run workflow*).

## Before you release

- Check your distributor's rules on AI-generated music.
- Songs made on Suno's free plan are not licensed for commercial use.

## Under the hood

A zero-backend web app in plain ES modules, with no runtime dependencies (MP3 export loads
lamejs from a CDN on demand). The engine runs in a Web Worker, with an inline fallback:

- STFT de-shimmer and denoise for AI artifacts;
- relative-detection dynamic EQ (mud, boom, harshness, fizz, de-ess) and auto / match EQ;
- gentle saturation and an air exciter;
- 3-band and bus compression with thresholds calibrated on the loud sections;
- mono bass and an oversampled true-peak lookahead limiter, iterated to an exact LUFS
  target, followed by a QC rollback step.

Loudness metering follows ITU-R BS.1770-4 / EBU R128 and is tested against ffmpeg's
`ebur128`. Metadata is read from ID3v1/v2, MP4, FLAC, Ogg, RIFF and AIFF tags and written
back as ID3v2.3 (MP3) or LIST/INFO plus an `id3 ` chunk (WAV).

## License

MIT — see [LICENSE](LICENSE). The MP3 encoder (lamejs, LGPL-3.0) is loaded at runtime and
is not included in the repository.
