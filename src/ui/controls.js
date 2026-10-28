// Tiny DOM helpers: element builder, i18n text bindings, segmented controls (radiogroup
// semantics), switches, sliders (linear or log), selects, unit formatting and the
// "Avanzate" rack generated from ADVANCED_SECTIONS. Nothing touches the DOM at import
// time, so the pure helpers (formatUnit, log mapping) are testable in Node.
import { t, formatNumber, formatHz } from './i18n.js';

const textVars = new WeakMap();
const attrBindings = new WeakMap();

/**
 * Create an element.
 * props: class, text, i18n (key | [key, vars]), on {event: fn}, dataset {}, style {},
 * any other key → attribute (true → empty attribute, false/null/undefined → omitted).
 * @param {string} tag
 * @param {object} [props]
 * @param {...(Node|string|null|false|Array)} kids
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'i18n') Array.isArray(v) ? bindText(el, v[0], v[1]) : bindText(el, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('i18n-')) bindAttr(el, k.slice(5), Array.isArray(v) ? v[0] : v, Array.isArray(v) ? v[1] : undefined);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Bind an element's text to an i18n key (re-translated by relabel()). */
export function bindText(el, key, vars) {
  el.dataset.i18n = key;
  if (vars) textVars.set(el, vars);
  else textVars.delete(el);
  el.textContent = t(key, vars);
  return el;
}

/** Bind an attribute (aria-label, title, …) to an i18n key. */
export function bindAttr(el, attr, key, vars) {
  let m = attrBindings.get(el);
  if (!m) attrBindings.set(el, (m = {}));
  m[attr] = { key, vars };
  el.setAttribute(attr, t(key, vars));
  el.setAttribute('data-i18n-attr', '');
  return el;
}

/** Re-translate every bound text and attribute below `root`. */
export function relabel(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, textVars.get(el));
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    const m = attrBindings.get(el);
    if (m) for (const [attr, b] of Object.entries(m)) el.setAttribute(attr, t(b.key, b.vars));
  }
}

let uid = 0;
/** Unique id with a readable prefix (ids must be stable per build, not globally). */
export function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Segmented control with radiogroup semantics (roving tabindex, arrow keys).
 * options: [{ value, key?, label?, sub? }] — `key` is an i18n key, `sub` a secondary line.
 * @returns {{ el: HTMLElement, buttons: HTMLButtonElement[], setValue(v): void, readonly value: any,
 *   setDisabled(d: boolean): void, setOptionDisabled(v, d: boolean): void, setSub(v, text: string): void }}
 */
export function segmented({ id, labelKey, labelledBy, options, value, onChange, className = '' }) {
  const group = h('div', { class: `seg ${className}`.trim(), role: 'radiogroup', id, 'aria-labelledby': labelledBy });
  if (labelKey && !labelledBy) bindAttr(group, 'aria-label', labelKey);
  let current = value;
  let disabled = false;
  const buttons = options.map((opt) => {
    const b = h(
      'button',
      { type: 'button', class: 'seg-btn', role: 'radio', id: `${id}-${String(opt.value).replace(/[^\w-]/g, '')}`, 'data-value': String(opt.value) },
      h('span', { class: 'seg-led', 'aria-hidden': 'true' }),
      h('span', { class: 'seg-label', i18n: opt.key, text: opt.key ? undefined : opt.label }),
      opt.sub !== undefined ? h('span', { class: 'seg-sub', text: opt.sub }) : null,
    );
    b.addEventListener('click', () => {
      if (disabled || b.getAttribute('aria-disabled') === 'true') return;
      choose(opt.value);
    });
    return b;
  });
  for (const b of buttons) group.append(b);
  group.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
    const enabled = buttons.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    if (!enabled.length || disabled) return;
    e.preventDefault();
    let i = enabled.indexOf(document.activeElement);
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = enabled.length - 1;
    else i = (i + keys[e.key] + enabled.length) % enabled.length;
    enabled[i].focus();
    const opt = options[buttons.indexOf(enabled[i])];
    choose(opt.value);
  });
  function choose(v) {
    const changed = String(v) !== String(current);
    setValue(v);
    if (changed && onChange) onChange(v);
  }
  function setValue(v) {
    current = v;
    let any = false;
    for (const b of buttons) {
      const on = b.dataset.value === String(v);
      any = any || on;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    if (!any && buttons[0]) buttons[0].tabIndex = 0;
  }
  setValue(value);
  return {
    el: group,
    buttons,
    setValue,
    get value() {
      return current;
    },
    setDisabled(d) {
      disabled = !!d;
      group.classList.toggle('is-disabled', disabled);
      for (const b of buttons) b.disabled = disabled;
    },
    setOptionDisabled(v, d) {
      const b = buttons.find((x) => x.dataset.value === String(v));
      if (b) b.setAttribute('aria-disabled', d ? 'true' : 'false');
    },
    setSub(v, text) {
      const b = buttons.find((x) => x.dataset.value === String(v));
      const s = b && b.querySelector('.seg-sub');
      if (s) s.textContent = text;
    },
  };
}

/**
 * On/off switch (button role="switch"). Space/Enter toggle natively via click.
 * @returns {{ el: HTMLElement, button: HTMLButtonElement, setChecked(c: boolean): void, setDisabled(d: boolean): void }}
 */
export function toggleSwitch({ id, labelKey, checked, onChange, className = '' }) {
  const button = h(
    'button',
    { type: 'button', class: `switch ${className}`.trim(), role: 'switch', id, 'aria-checked': checked ? 'true' : 'false' },
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })),
    labelKey ? h('span', { class: 'switch-label', i18n: labelKey }) : null,
  );
  let state = !!checked;
  button.addEventListener('click', () => {
    state = !state;
    button.setAttribute('aria-checked', state ? 'true' : 'false');
    if (onChange) onChange(state);
  });
  return {
    el: button,
    button,
    setChecked(c) {
      state = !!c;
      button.setAttribute('aria-checked', state ? 'true' : 'false');
    },
    setDisabled(d) {
      button.disabled = !!d;
    },
  };
}

// --- Slider mapping -----------------------------------------------------------------

const LOG_STEPS = 400;

/** Snap a value to `step` relative to `min`, clamped to [min, max]. */
export function snap(v, min, max, step) {
  if (!Number.isFinite(v)) return min;
  let x = Math.min(max, Math.max(min, v));
  if (step > 0) x = min + Math.round((x - min) / step) * step;
  x = Math.min(max, Math.max(min, x));
  // Kill float noise (0.1 + 0.2) so readouts and override JSON stay clean.
  const dec = step > 0 ? Math.max(0, Math.ceil(-Math.log10(step)) + 1) : 6;
  return Number(x.toFixed(Math.min(10, dec)));
}

/** Value → slider position for a log scale (position 0..LOG_STEPS). */
export function logToPos(v, min, max) {
  const lo = Math.max(min, 1e-9);
  const x = Math.min(max, Math.max(lo, v));
  return Math.round((LOG_STEPS * Math.log(x / lo)) / Math.log(max / lo));
}

/** Slider position → value for a log scale, snapped to step. */
export function posToLog(pos, min, max, step) {
  const lo = Math.max(min, 1e-9);
  const v = lo * Math.pow(max / lo, Math.min(LOG_STEPS, Math.max(0, pos)) / LOG_STEPS);
  return snap(v, min, max, step);
}

/**
 * Range slider with a live value readout. scale 'log' maps positions logarithmically.
 * Double-click (on the slider or its readout) calls onReset.
 * @returns {{ el: HTMLElement, input: HTMLInputElement, setValue(v: number): void, setDisabled(d: boolean): void, refresh(): void }}
 */
export function rangeSlider({ id, min, max, step, scale, value, format, onInput, onReset, labelledBy, className = '' }) {
  const isLog = scale === 'log' && min > 0;
  const input = h('input', {
    type: 'range',
    id,
    class: 'range-input',
    min: isLog ? 0 : min,
    max: isLog ? LOG_STEPS : max,
    step: isLog ? 1 : step,
    'aria-labelledby': labelledBy,
  });
  const out = h('output', { class: 'range-value', for: id });
  const el = h('div', { class: `range ${className}`.trim() }, input, out);
  let current = value;
  const fmt = (v) => (format ? format(v) : String(v));
  function toPos(v) {
    return isLog ? logToPos(v, min, max) : v;
  }
  function fromPos(p) {
    return isLog ? posToLog(Number(p), min, max, step) : snap(Number(p), min, max, step);
  }
  function paint() {
    const p = isLog ? Number(input.value) / LOG_STEPS : (Number(input.value) - min) / (max - min || 1);
    input.style.setProperty('--fill', `${Math.round(Math.min(1, Math.max(0, p)) * 1000) / 10}%`);
    out.textContent = fmt(current);
    input.setAttribute('aria-valuetext', fmt(current));
  }
  function setValue(v) {
    current = Number.isFinite(v) ? v : min;
    input.value = String(toPos(current));
    paint();
  }
  input.addEventListener('input', () => {
    current = fromPos(input.value);
    paint();
    if (onInput) onInput(current);
  });
  const reset = (e) => {
    if (input.disabled || !onReset) return;
    e.preventDefault();
    onReset();
  };
  input.addEventListener('dblclick', reset);
  out.addEventListener('dblclick', reset);
  setValue(value);
  return {
    el,
    input,
    setValue,
    setDisabled(d) {
      input.disabled = !!d;
      el.classList.toggle('is-disabled', !!d);
    },
    refresh: paint,
  };
}

/**
 * Native select. options: [{ value, key?, label? }].
 * @returns {{ el: HTMLSelectElement, setValue(v): void, setDisabled(d: boolean): void, relabel(): void }}
 */
export function selectBox({ id, options, value, onChange, labelledBy, className = '' }) {
  const el = h('select', { id, class: `select ${className}`.trim(), 'aria-labelledby': labelledBy });
  const opts = options.map((o) => h('option', { value: String(o.value), i18n: o.key, text: o.key ? undefined : o.label, disabled: o.disabled }));
  for (const o of opts) el.append(o);
  el.value = String(value);
  el.addEventListener('change', () => {
    const o = options.find((x) => String(x.value) === el.value);
    if (o && onChange) onChange(o.value);
  });
  return {
    el,
    setValue(v) {
      el.value = String(v);
    },
    setDisabled(d) {
      el.disabled = !!d;
    },
    relabel() {
      options.forEach((o, i) => {
        if (o.label && !o.key) opts[i].textContent = typeof o.label === 'function' ? o.label() : o.label;
      });
    },
  };
}

/**
 * Format a parameter value for a readout. Units follow params.js ADVANCED_SECTIONS.
 * '%' values are 0..1; 'dB' gets a sign when the control range is bipolar.
 * @param {number} v
 * @param {string} unit
 * @param {{ min?: number }} [ctl]
 */
export function formatUnit(v, unit, ctl = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  switch (unit) {
    case '%':
      return `${formatNumber(Math.round(v * 100), 0)}%`;
    case 'dB':
      return `${formatNumber(v, 1, { sign: (ctl.min ?? 0) < 0 })} dB`;
    case 'Hz':
      return v <= 0 ? t('adv.off') : formatHz(v);
    case 'ms':
      return v >= 1000 ? `${formatNumber(v / 1000, 1)} s` : `${formatNumber(Math.round(v), 0)} ms`;
    case 'LUFS':
      return `${formatNumber(v, 1)} LUFS`;
    case 'dBTP':
      return `${formatNumber(v, 1)} dBTP`;
    case 'dB/oct':
      return `${formatNumber(v, 2, { sign: true })} ${t('unit.dbOct')}`;
    case 'x':
      return `${formatNumber(v, 2)}×`;
    default:
      return formatNumber(v);
  }
}

/** Sample-rate option label: 'source' → 'Originale', 44100 → '44,1 kHz'. */
export function rateLabel(v) {
  return v === 'source' ? t('export.rate.source') : formatHz(Number(v));
}

/**
 * The "Avanzate" rack generated from ADVANCED_SECTIONS.
 * api: { getValue(path), isTruthy(path), isModified(sectionId), onChange(path, value),
 *        onReset(path), onResetSection(sectionId), extras: { [sectionId]: HTMLElement },
 *        helpFor?(section, control|null) → HTMLElement|null (the (i) button, help.js) }
 * @returns {{ el: HTMLElement, refresh(o?: { force?: boolean }): void, setDisabled(d: boolean): void }}
 */
export function createRack(sections, api) {
  const el = h('div', { class: 'rack' });
  const items = [];
  const heads = [];
  let disabled = false;
  for (const sec of sections) {
    const titleId = `adv-${sec.id}-title`;
    const badge = h('span', { class: 'badge badge-mod', i18n: 'adv.modified', hidden: true });
    const resetBtn = h('button', { type: 'button', class: 'btn-text', id: `adv-${sec.id}-reset`, i18n: 'adv.resetSection', hidden: true });
    const title = h('h3', { class: 'lbl', id: titleId, i18n: sec.labelKey, tabindex: '-1' });
    resetBtn.addEventListener('click', () => {
      api.onResetSection(sec.id);
      // The button hides itself once nothing is modified: keep focus in the section.
      if (resetBtn.hidden) title.focus();
    });
    const body = h('div', { class: 'rack-body' });
    const secHelp = api.helpFor ? api.helpFor(sec, null) : null;
    const mod = h(
      'section',
      { class: 'rack-mod', 'aria-labelledby': titleId, dataset: { section: sec.id } },
      h('header', { class: `rack-head${secHelp ? ' has-help' : ''}` }, title, secHelp, badge, resetBtn),
      body,
    );
    heads.push({ sec, badge, resetBtn });
    let lastToggle = null;
    for (const ctl of sec.controls) {
      const cid = `adv-${ctl.path.replace(/\./g, '-')}`;
      const labelId = `${cid}-label`;
      const indent = ctl.dependsOn && lastToggle && ctl.dependsOn === lastToggle;
      const row = h('div', { class: `rack-row rack-${ctl.type}${indent ? ' is-dep' : ''}`, dataset: { path: ctl.path } });
      // The (i) sits right after the control's name (api.helpFor → help.js), never inside it.
      const ctlHelp = api.helpFor ? api.helpFor(sec, ctl) : null;
      const named = (el) => (ctlHelp ? h('div', { class: 'rack-name' }, el, ctlHelp) : el);
      let widget;
      if (ctl.type === 'toggle') {
        lastToggle = ctl.path;
        widget = toggleSwitch({ id: cid, labelKey: ctl.labelKey, checked: !!api.getValue(ctl.path), onChange: (v) => api.onChange(ctl.path, v) });
        widget.button.addEventListener('dblclick', (e) => {
          e.preventDefault();
          api.onReset(ctl.path);
        });
        row.append(named(widget.el));
      } else if (ctl.type === 'range') {
        const label = h('label', { class: 'rack-label', id: labelId, for: cid, i18n: ctl.labelKey });
        widget = rangeSlider({
          id: cid,
          min: ctl.min,
          max: ctl.max,
          step: ctl.step,
          scale: ctl.scale,
          value: Number(api.getValue(ctl.path)),
          format: (v) => formatUnit(v, ctl.unit, ctl),
          onInput: (v) => api.onChange(ctl.path, v),
          onReset: () => resetRange(),
          labelledBy: labelId,
        });
        const w = widget;
        const resetRange = () => {
          api.onReset(ctl.path);
          w.setValue(Number(api.getValue(ctl.path)));
        };
        label.addEventListener('dblclick', resetRange);
        row.append(named(label), widget.el);
      } else if (ctl.type === 'select') {
        const label = h('label', { class: 'rack-label', id: labelId, for: cid, i18n: ctl.labelKey });
        const options = (ctl.options || []).map((o) => ({ value: o, label: rateLabel(o) }));
        widget = selectBox({ id: cid, options, value: api.getValue(ctl.path), onChange: (v) => api.onChange(ctl.path, v), labelledBy: labelId });
        widget.el.addEventListener('dblclick', () => api.onReset(ctl.path));
        widget.options = options;
        row.append(named(label), widget.el);
      }
      items.push({ ctl, widget, row });
      body.append(row);
    }
    if (api.extras && api.extras[sec.id]) body.append(api.extras[sec.id]);
    el.append(mod);
  }
  /** Re-sync every control; `force` also moves a focused fader (undo / redo, not a drag). */
  function refresh({ force = false } = {}) {
    for (const { ctl, widget, row } of items) {
      const v = api.getValue(ctl.path);
      const dep = ctl.dependsOn ? api.isTruthy(ctl.dependsOn) : true;
      const off = disabled || !dep;
      if (ctl.type === 'toggle') widget.setChecked(!!v);
      // Never move a fader under the user's pointer (log mapping would make it jitter).
      else if (ctl.type === 'range') {
        if (!force && typeof document !== 'undefined' && widget.input === document.activeElement) widget.refresh();
        else widget.setValue(Number(v));
      }
      else if (ctl.type === 'select') {
        widget.options.forEach((o, i) => {
          widget.el.options[i].textContent = rateLabel(o.value);
        });
        widget.setValue(v);
      }
      widget.setDisabled(off);
      row.classList.toggle('is-off', off);
      row.classList.toggle('is-modified', !!(api.isPathModified && api.isPathModified(ctl.path)));
    }
    for (const { sec, badge, resetBtn } of heads) {
      const m = !disabled && api.isModified(sec.id);
      badge.hidden = !m;
      resetBtn.hidden = !m;
    }
  }
  refresh();
  return {
    el,
    refresh,
    setDisabled(d) {
      disabled = !!d;
      refresh();
    },
  };
}

/** Inline SVG icon (stroke = currentColor). */
export function icon(name) {
  const paths = {
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor" stroke="none"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  };
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths[name] || ''}</svg>`;
  return span;
}
