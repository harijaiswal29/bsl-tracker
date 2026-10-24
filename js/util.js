// Small shared helpers: time, units, formatting, DOM.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const MGDL_PER_MMOL = 18.016;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export const fmtTime = (ts) => timeFmt.format(ts).toLowerCase().replace(/\s+/g, ' ');
export const fmtDate = (ts) => dateFmt.format(ts);

export function fmtDay(ts, now = Date.now()) {
  const d = startOfDay(ts);
  const today = startOfDay(now);
  if (d === today) return 'Today';
  if (d === addDays(today, -1)) return 'Yesterday';
  return dayFmt.format(ts);
}

export function fmtAgo(ts, now = Date.now()) {
  const m = Math.round((now - ts) / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function mealName(ts) {
  const h = new Date(ts).getHours();
  if (h < 4) return 'Late night';
  if (h < 11) return 'Breakfast';
  if (h < 16) return 'Lunch';
  if (h < 19) return 'Snack';
  return 'Dinner';
}

// "2026-10-24T13:05" for <input type="datetime-local">, in local time.
export function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(s) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

// ---- units: everything is stored in mg/dL ----

export function toUnit(mgdl, unit) {
  return unit === 'mmol/L' ? mgdl / MGDL_PER_MMOL : mgdl;
}

export function fromUnit(value, unit) {
  return unit === 'mmol/L' ? value * MGDL_PER_MMOL : value;
}

export function fmtGlucose(mgdl, unit) {
  if (mgdl == null) return '–';
  return unit === 'mmol/L' ? (mgdl / MGDL_PER_MMOL).toFixed(1) : String(Math.round(mgdl));
}

export function fmtRise(mgdl, unit) {
  if (mgdl == null) return '–';
  const v = unit === 'mmol/L' ? (mgdl / MGDL_PER_MMOL).toFixed(1) : String(Math.round(mgdl));
  return mgdl >= 0 ? `+${v}` : `−${v.replace('-', '')}`;
}

// ---- DOM ----

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

// replaceChildren() that skips null/false (replaceChildren itself would print "null").
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
