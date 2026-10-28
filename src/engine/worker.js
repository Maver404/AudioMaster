// Engine Web Worker (ARCHITECTURE §5 protocol). Source-level ES module; production bundles
// it to a classic IIFE Blob worker (tools/build.mjs), dev loads it with { type: 'module' }.
// Nothing here may assume module-worker-only features at runtime (no top-level await,
// no import.meta). Every request is answered with 'result' or 'error' — never a crash.
//
// main → worker: load / analyze / render / ltas / unload / cancel / focus (+ ping for the
// client's liveness check). worker → main: progress / result / error. Render results
// transfer their output channels (and the preview's, C2). A newer render for a track
// supersedes the older one (see handlers.js): the older rejects with code 'cancelled'.

import { createEngineState, handleMessage, handleCancel } from './handlers.js';

const scope = typeof self !== 'undefined' ? self : globalThis;
const state = createEngineState();

function post(msg, transfer) {
  try {
    scope.postMessage(msg, transfer && transfer.length ? transfer : []);
  } catch (err) {
    // e.g. a non-cloneable value slipped into a result: report it instead of dying
    try {
      scope.postMessage({ type: 'error', id: msg && msg.id, message: `postMessage failed: ${err && err.message}`, code: 'render' });
    } catch {
      /* nothing left to do */
    }
  }
}

/** Progress throttle: at most one message per stage per 1 % step. */
function progressPoster(id) {
  let lastStage = null, lastF = -1;
  return (stage, fraction) => {
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    if (stage === lastStage && f < 1 && f - lastF < 0.01) return;
    lastStage = stage;
    lastF = f;
    post({ type: 'progress', id, stage, fraction: f });
  };
}

async function onMessage(e) {
  const msg = (e && e.data) || {};
  const id = msg.id;
  if (msg.type === 'cancel') {
    handleCancel(state, msg);
    return;
  }
  try {
    const result = await handleMessage(state, msg, { onProgress: progressPoster(id) });
    const transfer = msg.type === 'render' && result && result.audio ? result.audio.channels.map((c) => c.buffer) : [];
    if (msg.type === 'render' && result && result.preview) for (const c of result.preview.channels) transfer.push(c.buffer);
    post({ type: 'result', id, result }, transfer);
  } catch (err) {
    post({ type: 'error', id, message: String((err && err.message) || err || 'error'), code: (err && err.code) || 'render' });
  }
}

scope.onmessage = onMessage;
if (typeof scope.addEventListener === 'function') {
  scope.addEventListener('unhandledrejection', (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  });
}
