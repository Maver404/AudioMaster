// Before → After loudness readouts, the live short-term loudness bars (driven by the
// precomputed loudness curves, not by a realtime meter: the curves are exact BS.1770
// values and cost nothing to look up) and the "Sulle piattaforme" preview.
import { t, formatNumber } from './i18n.js';
import { h, bindText, clear } from './controls.js';

const LIVE_LO = -36;
const LIVE_HI = -3;

/**
 * Short-term loudness at time `sec` from a curve sampled every `hop` seconds.
 * @returns {number|null}
 */
export function curveValueAt(curve, hop, sec) {
  if (!curve || !curve.length || !(hop > 0) || !Number.isFinite(sec)) return null;
  const i = Math.min(curve.length - 1, Math.max(0, Math.round(sec / hop)));
  const v = curve[i];
  return Number.isFinite(v) ? v : null;
}

/** LUFS → fraction of the live bar width. */
export function liveFraction(lufs) {
  if (!Number.isFinite(lufs)) return 0;
  return Math.min(1, Math.max(0, (lufs - LIVE_LO) / (LIVE_HI - LIVE_LO)));
}

/**
 * Text and direction of a platform playback gain.
 * @param {number} g dB
 * @returns {{ text: string, kind: 'down'|'same'|'up' }}
 */
export function platformGainText(g) {
  if (!Number.isFinite(g) || Math.abs(g) < 0.05) return { text: t('platforms.unchanged'), kind: 'same' };
  return { text: `${formatNumber(g, 1, { sign: true })} dB`, kind: g < 0 ? 'down' : 'up' };
}

/** Readout value or '—'. */
function num(v, d = 1) {
  return Number.isFinite(v) ? formatNumber(v, d) : '—';
}

function sameTarget(a, b) {
  return !!a && !!b && a.lufs === b.lufs && a.ceiling === b.ceiling;
}

/**
 * Meters panel.
 * @param {HTMLElement} root container (gets the markup)
 * @param {{ help?: (id: string) => HTMLElement|null }} [o] help: the (i) button of a row (help.js)
 * @returns {{ set(data: object): void, setLive(live: object): void, relabel(): void }}
 */
export function createMeters(root, { help = () => null } = {}) {
  const defs = [
    { k: 'lufs', key: 'meters.lufs', unit: 'LUFS', help: 'meters.lufs' },
    { k: 'tp', key: 'meters.tp', unit: 'dBTP', help: 'meters.tp' },
    { k: 'lra', key: 'meters.lra', unit: 'LU', help: 'meters.lra' },
    { k: 'plr', key: 'meters.plr', unit: 'dB', help: 'meters.plr' },
  ];
  const rows = {};
  const table = h('div', { class: 'mtable', role: 'table' });
  table.append(
    h(
      'div',
      { class: 'mrow mhead', role: 'row' },
      // The first cell must stay in the grid flow (an sr-only cell is position:absolute and
      // would shift "Prima" / "Dopo" one column left): only its text is visually hidden.
      h('span', { role: 'columnheader' }, h('span', { class: 'sr-only', i18n: 'meters.title' })),
      h('span', { role: 'columnheader', class: 'mcol-before lbl', i18n: 'meters.before' }),
      h('span', { 'aria-hidden': 'true' }),
      h('span', { role: 'columnheader', class: 'mcol-after lbl', i18n: 'meters.after' }),
    ),
  );
  for (const d of defs) {
    const before = h('span', { class: 'mval mbefore', role: 'cell', text: '—' });
    const after = h('span', { class: 'mval mafter', role: 'cell', text: '—' });
    const status = h('span', { class: 'mstatus', hidden: true });
    const row = h(
      'div',
      { class: `mrow mrow-${d.k}`, role: 'row' },
      // The header is named by its label only, so the (i) inside it is not read with every cell.
      h('span', { class: 'mname', role: 'rowheader', 'i18n-aria-label': d.key }, h('span', { class: 'mname-t', i18n: d.key }), h('span', { class: 'munit', text: d.unit }), help(d.help), h('span', { class: 'mhint', i18n: `${d.key}.hint` })),
      before,
      h('span', { class: 'marrow', 'aria-hidden': 'true', text: '→' }),
      h('span', { class: 'mafter-wrap', role: 'cell' }, after, status),
    );
    rows[d.k] = { before, after, status, row };
    table.append(row);
  }
  const grVal = h('span', { class: 'mgr-val', text: '—' });
  const gr = h('div', { class: 'mgr' }, h('span', { class: 'mname' }, h('span', { class: 'mname-t', i18n: 'meters.gr' }), help('meters.gr'), h('span', { class: 'mhint', i18n: 'meters.gr.hint' })), grVal);
  const target = h('p', { class: 'mtarget' });

  // Live short-term bars.
  const mkBar = (kind, letterKey, nameKey) => {
    const fill = h('span', { class: 'lbar-fill' });
    const val = h('span', { class: 'lbar-val', text: '—' });
    const el = h(
      'div',
      { class: `lbar lbar-${kind}` },
      h('span', { class: 'lbar-tag' }, h('span', { class: 'lbar-letter', i18n: letterKey }), h('span', { class: 'sr-only', i18n: nameKey })),
      h('span', { class: 'lbar-track' }, fill),
      val,
    );
    return { el, fill, val };
  };
  const barA = mkBar('orig', 'meters.liveA', 'ab.original');
  const barB = mkBar('master', 'meters.liveB', 'ab.master');
  const marker = h('span', { class: 'lbar-marker', 'aria-hidden': 'true' });
  const scale = h('div', { class: 'lbar-scale', 'aria-hidden': 'true' });
  for (const v of [-30, -20, -10]) {
    scale.append(h('span', { style: { left: `${liveFraction(v) * 100}%` }, text: `−${-v}` }));
  }
  const bars = h('div', { class: 'lbars' }, barA.el, barB.el, h('div', { class: 'lbar-overlay', 'aria-hidden': 'true' }, marker), scale);
  const live = h(
    'div',
    { class: 'mlive' },
    h('div', { class: 'mlive-head' }, h('span', { class: 'lbl', i18n: 'meters.live' }), help('meters.live')),
    bars,
    h('p', { class: 'mhint-line', i18n: 'meters.live.hint' }),
  );
  root.append(table, gr, target, live);

  let data = null;
  let liveData = null;

  /**
   * d: { before, after, gr, target, nextTarget?, stale? }. `target` is what the shown
   * master was rendered for and judges it; while `stale` (a re-render is pending) the
   * values are dimmed, no on/off-target verdict is given and the target line shows
   * `nextTarget`, the one the coming master will meet.
   */
  function set(d) {
    data = d;
    const b = d.before || {};
    const a = d.after || {};
    root.classList.toggle('is-stale', !!d.stale);
    for (const def of defs) {
      const r = rows[def.k];
      r.before.textContent = num(b[def.k]);
      r.after.textContent = num(a[def.k]);
      r.status.hidden = true;
      r.row.classList.remove('is-ok', 'is-off');
    }
    const tg = d.target;
    if (!d.stale) {
      if (tg && Number.isFinite(a.lufs)) setStatus(rows.lufs, Math.abs(a.lufs - tg.lufs) <= 0.5);
      if (tg && Number.isFinite(a.tp)) setStatus(rows.tp, a.tp <= tg.ceiling + 0.05);
    }
    grVal.textContent = d.gr && Number.isFinite(d.gr.avg) ? t('meters.grValue', { avg: formatNumber(d.gr.avg, 1), max: formatNumber(d.gr.max, 1) }) : '—';
    const line = d.stale && d.nextTarget ? d.nextTarget : tg;
    if (line && Number.isFinite(line.lufs)) {
      bindText(target, 'meters.target', { lufs: formatNumber(line.lufs, 1), ceiling: formatNumber(line.ceiling, 1) });
      marker.style.left = `${liveFraction(line.lufs) * 100}%`;
      marker.hidden = false;
    } else {
      target.textContent = '';
      marker.hidden = true;
    }
  }

  function setStatus(r, ok) {
    r.status.hidden = false;
    bindText(r.status, ok ? 'meters.onTarget' : 'meters.offTarget');
    r.row.classList.toggle('is-ok', ok);
    r.row.classList.toggle('is-off', !ok);
  }

  function setLive(l) {
    liveData = l;
    const paint = (bar, v, isActive) => {
      bar.fill.style.width = `${liveFraction(v) * 100}%`;
      bar.val.textContent = Number.isFinite(v) ? formatNumber(v, 1) : '—';
      bar.el.classList.toggle('is-active', !!isActive);
    };
    paint(barA, l.orig, l.active === 'original');
    paint(barB, l.master, l.active === 'master');
  }

  set({});
  setLive({ orig: null, master: null, active: 'master' });
  return {
    set,
    setLive,
    /** Toggle the "updating" state without new values (a re-render was scheduled). */
    setStale(on, nextTarget) {
      if (!data) return;
      if (!!data.stale === !!on && (!on || sameTarget(data.nextTarget, nextTarget))) return;
      set({ ...data, stale: !!on, nextTarget: nextTarget || data.nextTarget });
    },
    relabel() {
      if (data) set(data);
      if (liveData) setLive(liveData);
    },
  };
}

/**
 * "Sulle piattaforme" table.
 * @param {HTMLElement} root
 * @param {{ PLATFORMS: object[], platformGainDb: Function }} P params.js exports
 * @returns {{ set(I: number|null, TP: number|null): void, relabel(): void }}
 */
export function createPlatforms(root, P) {
  const list = h('ul', { class: 'plist' });
  const empty = h('p', { class: 'muted small', i18n: 'platforms.empty' });
  root.append(list, empty);
  let last = [null, null];
  function set(I, TP) {
    last = [I, TP];
    clear(list);
    const ok = Number.isFinite(I) && Number.isFinite(TP);
    empty.hidden = ok;
    for (const p of P.PLATFORMS) {
      const g = ok ? P.platformGainDb(p, I, TP) : NaN;
      const gt = ok ? platformGainText(g) : { text: '—', kind: 'none' };
      // Bar: ±8 dB around the centre line.
      const frac = ok ? Math.min(1, Math.abs(g) / 8) : 0;
      const bar = h('span', { class: `pbar pbar-${gt.kind}`, 'aria-hidden': 'true' }, h('span', { class: 'pbar-fill', style: { width: `${frac * 50}%` } }));
      list.append(
        h(
          'li',
          { class: `prow is-${gt.kind}` },
          h(
            'span',
            { class: 'pcol' },
            h('span', { class: 'pname', i18n: `platform.${p.id}` }),
            ok ? h('span', { class: 'pplays', text: t('platforms.playsAt', { lufs: `${formatNumber(I + g, 1)} LUFS` }) }) : null,
          ),
          bar,
          h('span', { class: 'pgain', text: gt.text }),
        ),
      );
    }
  }
  set(null, null);
  return {
    set,
    relabel() {
      set(last[0], last[1]);
    },
  };
}
