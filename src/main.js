// Boot: wires the real engine / IO modules into the UI (src/ui/app.js).
// The single-file build bundles this entry; tests/ui-harness.js wires fakes instead.
import { createApp } from './ui/app.js';
import { t } from './ui/i18n.js';
import { initSkin } from './ui/theme.js';
import { EngineClient } from './engine/client.js';
import { decodeFile, deviceMaxDurationSec } from './audio/decode.js';
import { readMetadata } from './audio/metadata.js';
import { Player } from './audio/player.js';
import { encodeWav } from './export/wav.js';
import { encodeMp3 } from './export/mp3.js';
import { makeZip } from './export/zip.js';
import { saveBlob, probeSaveSupport } from './export/save.js';
import { resampleAudio } from './dsp/resample.js';
import { truePeakDb } from './dsp/oversample.js';
import { generateDemoTrack } from './demo/demo-track.js';
import { suggestParams, describeDecisions } from './engine/assistant.js';
import * as params from './engine/params.js';

// The stored theme applies before the app builds its DOM (theme.js injects its own CSS).
initSkin();

function boot() {
  const root = document.getElementById('app');
  if (!root) return;
  try {
    const app = createApp(root, {
      EngineClient,
      // memory-aware length cap: phones and ≤ 4 GB devices get 10 minutes instead of 15
      decodeFile: (file, opts) => decodeFile(file, { maxDurationSec: deviceMaxDurationSec(), ...opts }),
      readMetadata,
      Player,
      encodeWav,
      encodeMp3,
      makeZip,
      saveBlob,
      probeSaveSupport,
      resampleAudio,
      truePeakDb,
      generateDemoTrack,
      suggestParams,
      describeDecisions,
      params,
    });
    globalThis.__AM_APP__ = app;
  } catch (e) {
    console.error('AudioMaster failed to start', e);
    root.textContent = t('app.bootError');
    root.setAttribute('role', 'alert');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
