// Read glucose exports into readings: { id, ts, mgdl, kind }.
//  - LibreView CSV (FreeStyle Libre 2 / LibreLink): libreview.com → Glucose History → Download
//  - Generic meter CSV (e.g. mySugr export from an Accu-Chek meter): any CSV with a
//    date/time column and a glucose / blood sugar column.
// Pure functions — unit-tested in tests/importers.test.mjs.

import { MGDL_PER_MMOL } from './util.js';

export function detectDelimiter(line) {
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/, 3);
  // LibreView's first line is a short title row; sniff the delimiter from the busiest line.
  const sample = firstLines.reduce((a, b) => (b.length > a.length ? b : a), '');
  const d = detectDelimiter(sample);
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ''));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMERIC_DATE = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/;
const TIME = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?/i;

// Which way round are "05-10-2026"-style dates? Look for a part > 12.
export function detectDateOrder(dateStrings) {
  let dmy = false, mdy = false;
  for (const s of dateStrings) {
    const m = NUMERIC_DATE.exec(String(s).trim());
    if (!m || m[1].length === 4) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  return null;
}

export function defaultDateOrder() {
  const lang = (globalThis.navigator?.language || 'en-IN').toLowerCase();
  return /^en-us|^en-ph|^es-us/.test(lang) ? 'MDY' : 'DMY';
}

// Parse a local date-time string. Returns epoch ms or NaN.
export function parseDateTime(str, order = 'DMY') {
  const s = String(str).trim();
  let y, mo, d;
  let rest = s;
  const num = NUMERIC_DATE.exec(s);
  if (num) {
    const [a, b, c] = [num[1], num[2], num[3]];
    if (a.length === 4) [y, mo, d] = [+a, +b, +c];
    else if (order === 'MDY') [mo, d, y] = [+a, +b, +c];
    else [d, mo, y] = [+a, +b, +c];
    rest = s.slice(num[0].length);
  } else {
    const dMy = /^(\d{1,2})[\s-]+([a-z]{3,})\.?,?[\s-]+(\d{2,4})/i.exec(s); // 24 Oct 2026
    const Mdy = /^(?:[a-z]+,?\s+)?([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s); // Oct 24, 2026
    const m = dMy || Mdy;
    if (!m) return NaN;
    const monthWord = (dMy ? m[2] : m[1]).slice(0, 3).toLowerCase();
    mo = MONTHS.indexOf(monthWord) + 1;
    d = +(dMy ? m[1] : m[2]);
    y = +m[3];
    rest = s.slice(m[0].length);
    if (!mo) return NaN;
  }
  if (y < 100) y += 2000;
  let hh = 0, mm = 0, ss = 0;
  const t = TIME.exec(rest);
  if (t) {
    hh = +t[1]; mm = +t[2]; ss = +(t[3] || 0);
    const ap = t[4]?.toLowerCase();
    if (ap === 'p' && hh < 12) hh += 12;
    if (ap === 'a' && hh === 12) hh = 0;
  }
  const date = new Date(y, mo - 1, d, hh, mm, ss);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return NaN;
  return date.getTime();
}

function toNumber(v) {
  if (v == null) return NaN;
  const t = String(v).trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
}

const VALID = (mgdl) => mgdl >= 20 && mgdl <= 600;

function finish(format, readings, skipped) {
  readings.sort((a, b) => a.ts - b.ts);
  return {
    format,
    readings,
    skipped,
    from: readings[0]?.ts ?? null,
    to: readings[readings.length - 1]?.ts ?? null,
  };
}

function findHeader(rows, test) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) if (test(rows[i])) return i;
  return -1;
}

export function parseLibreView(rows, order) {
  const hi = findHeader(rows, (r) => r.some((c) => /device timestamp/i.test(c)) && r.some((c) => /record type/i.test(c)));
  if (hi < 0) return null;
  const head = rows[hi];
  const col = (re) => head.findIndex((c) => re.test(c));
  const iTs = col(/device timestamp/i);
  const iType = col(/record type/i);
  const cols = {
    0: col(/^historic glucose/i),
    1: col(/^scan glucose/i),
    2: col(/^strip glucose/i),
  };
  const kinds = { 0: 'cgm', 1: 'scan', 2: 'strip' };
  const isMmol = (i) => i >= 0 && /mmol/i.test(head[i]);
  const data = rows.slice(hi + 1);
  order = order || detectDateOrder(data.map((r) => r[iTs])) || defaultDateOrder();
  const readings = [];
  let skipped = 0;
  for (const r of data) {
    const type = r[iType];
    const ci = cols[type];
    if (ci == null || ci < 0) continue; // insulin, food, notes… rows
    let v = toNumber(r[ci]);
    const ts = parseDateTime(r[iTs], order);
    if (!Number.isFinite(v) || !Number.isFinite(ts)) { skipped++; continue; }
    if (isMmol(ci)) v *= MGDL_PER_MMOL;
    if (!VALID(v)) { skipped++; continue; }
    readings.push({ id: `libre:${ts}:${type}`, ts, mgdl: Math.round(v), kind: kinds[type] });
  }
  return finish('LibreView (FreeStyle Libre)', readings, skipped);
}

const GLUCOSE_COL = /glucose|blood sugar|\bbg\b|mg\/dl|mmol/i;
const NOT_GLUCOSE = /insulin|ketone|carb|unit|target|serial|device|type|tag|note/i;

export function parseGeneric(rows, order) {
  const hi = findHeader(rows, (r) => r.some((c) => GLUCOSE_COL.test(c) && !NOT_GLUCOSE.test(c)));
  if (hi < 0) return null;
  const head = rows[hi];
  const iG = head.findIndex((c) => GLUCOSE_COL.test(c) && !NOT_GLUCOSE.test(c));
  let iDT = head.findIndex((c) => /timestamp|date\s*(and|&|\/)?\s*time/i.test(c));
  let iD = -1, iT = -1;
  if (iDT < 0) {
    iD = head.findIndex((c) => /date|day/i.test(c));
    iT = head.findIndex((c, i) => i !== iD && /time/i.test(c));
    if (iD < 0) return null;
  }
  const data = rows.slice(hi + 1);
  const when = (r) => (iDT >= 0 ? r[iDT] : `${r[iD]} ${iT >= 0 ? r[iT] : ''}`);
  order = order || detectDateOrder(data.map(when)) || defaultDateOrder();
  let mmol = /mmol/i.test(head[iG]);
  const vals = data.map((r) => toNumber(r[iG])).filter(Number.isFinite);
  if (!/mg\/dl/i.test(head[iG]) && vals.length && Math.max(...vals) < 35) mmol = true;
  const readings = [];
  let skipped = 0;
  for (const r of data) {
    if (r[iG] == null || r[iG] === '') continue;
    let v = toNumber(r[iG]);
    const ts = parseDateTime(when(r), order);
    if (!Number.isFinite(v) || !Number.isFinite(ts)) { skipped++; continue; }
    if (mmol) v *= MGDL_PER_MMOL;
    if (!VALID(v)) { skipped++; continue; }
    readings.push({ id: `meter:${ts}:${Math.round(v)}`, ts, mgdl: Math.round(v), kind: 'meter' });
  }
  return finish(`Glucose meter CSV (column “${head[iG]}”)`, readings, skipped);
}

export function importGlucoseCSV(text, { dateOrder } = {}) {
  const rows = parseCSV(text);
  const order = dateOrder && dateOrder !== 'auto' ? dateOrder : null;
  const result = parseLibreView(rows, order) || parseGeneric(rows, order);
  if (!result) throw new Error('Could not find a date column and a glucose column in this file.');
  return result;
}
