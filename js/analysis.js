// Pure functions that turn meals + glucose readings into "how did this food affect me".
// No DOM, no storage — unit-tested in tests/analysis.test.mjs.
//
// Glucose readings: { id, ts, mgdl, kind }   kind: 'cgm' | 'scan' | 'strip' | 'meter' | 'manual'
// Meals:            { id, ts, text, tags: [] }

import { MIN, DAY } from './util.js';

export const WINDOW = {
  baseBefore: 45 * MIN, // a "before" reading may be up to 45 min before eating…
  baseAfter: 10 * MIN,  // …or up to 10 min after the logged time (logged late)
  postStart: 15 * MIN,  // post-meal readings count from 15 min…
  postEnd: 150 * MIN,   // …to 2.5 h after eating
  combine: 30 * MIN,    // meals logged within 30 min of each other are one eating event
  overlap: 120 * MIN,   // another eating event within 2 h muddies the response
};

// Rise above the pre-meal reading, in mg/dL. Common rule of thumb for post-meal
// excursions; shown to the user as gentle / moderate / spike.
export const RISE = { moderate: 30, spike: 50 };

export function riseStatus(rise) {
  if (rise == null) return null;
  if (rise >= RISE.spike) return 'spike';
  if (rise >= RISE.moderate) return 'moderate';
  return 'gentle';
}

function lowerBound(arr, ts) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function readingsBetween(readings, from, to) {
  const out = [];
  for (let i = lowerBound(readings, from); i < readings.length && readings[i].ts <= to; i++) out.push(readings[i]);
  return out;
}

// Group meals eaten close together (chai, then breakfast 15 min later) into one event.
export function eatingEvents(meals) {
  const sorted = [...meals].sort((a, b) => a.ts - b.ts);
  const events = [];
  for (const m of sorted) {
    const last = events[events.length - 1];
    if (last && m.ts - last.ts <= WINDOW.combine) last.meals.push(m);
    else events.push({ ts: m.ts, meals: [m] });
  }
  for (const e of events) {
    e.text = e.meals.map((m) => m.text).join(', ');
    e.tags = [...new Set(e.meals.flatMap((m) => m.tags || []))];
  }
  return events;
}

// readings must be sorted by ts.
export function eventResponse(event, readings, prevEvent, nextEvent) {
  const t = event.ts;
  const pre = readingsBetween(readings, t - WINDOW.baseBefore, t + WINDOW.baseAfter);
  const atOrBefore = pre.filter((r) => r.ts <= t);
  const baseline = atOrBefore.length ? atOrBefore[atOrBefore.length - 1] : pre[0] || null;

  const post = readingsBetween(readings, t + WINDOW.postStart, t + WINDOW.postEnd);
  let peak = null;
  for (const r of post) if (!peak || r.mgdl > peak.mgdl) peak = r;

  const overlapped =
    (nextEvent && nextEvent.ts - t < WINDOW.overlap) ||
    (prevEvent && t - prevEvent.ts < WINDOW.overlap / 2) ||
    false;

  const rise = baseline && peak ? peak.mgdl - baseline.mgdl : null;
  return {
    event,
    baseline,
    peak,
    rise,
    minutesToPeak: peak ? Math.round((peak.ts - t) / MIN) : null,
    nPost: post.length,
    dense: post.length >= 4,
    overlapped,
    status: riseStatus(rise),
  };
}

// One response per eating event. Map meal.id -> response for quick lookup in the UI.
export function analyse(meals, readings) {
  const events = eatingEvents(meals);
  const responses = events.map((e, i) => eventResponse(e, readings, events[i - 1], events[i + 1]));
  const byMeal = new Map();
  for (const r of responses) for (const m of r.event.meals) byMeal.set(m.id, r);
  return { responses, byMeal };
}

// ---- grouping foods ----

const SPLIT = /\s*(?:,|;|\+|&|\n|\band\b|\bwith\b)\s*/i;
const PORTION = /^(?:\d+(?:[.,/]\d+)?|a|an|one|two|three|four|half|small|large|big|medium|bowl|bowls|cup|cups|plate|plates|glass|glasses|piece|pieces|pc|pcs|slice|slices|katori|katoris|serving|servings|spoon|spoons|tbsp|tsp|g|gm|gms|grams|ml|of|x)\b\.?\s*/i;

export function items(text) {
  return String(text)
    .toLowerCase()
    .split(SPLIT)
    .map((s) => s.replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// "2 Rotis + dal" and "dal, 2 rotis" are the same meal.
export function mealKey(text) {
  return [...new Set(items(text))].sort().join(', ');
}

// "2 rotis" -> "roti", "small bowl of rice" -> "rice"
export function foodName(item) {
  let s = item;
  for (let i = 0; i < 6 && PORTION.test(s); i++) s = s.replace(PORTION, '');
  s = s.trim();
  if (s.length > 3 && /[^su]s$/.test(s)) s = s.slice(0, -1); // rotis -> roti, not hummus/glass
  return s;
}

function usable(r) {
  return r.rise != null && !r.overlapped;
}

function aggregate(groups) {
  return [...groups.values()]
    .map((g) => {
      const rises = g.rs.map((r) => r.rise);
      return {
        key: g.key,
        label: g.label,
        n: rises.length,
        avgRise: rises.reduce((a, b) => a + b, 0) / rises.length,
        minRise: Math.min(...rises),
        maxRise: Math.max(...rises),
        lastTs: Math.max(...g.rs.map((r) => r.event.ts)),
        responses: g.rs,
      };
    })
    .map((g) => ({ ...g, status: riseStatus(g.avgRise) }));
}

// Whole meals, e.g. "dal, rice, salad": average rise each time you ate it.
export function rankMeals(responses) {
  const groups = new Map();
  for (const r of responses.filter(usable)) {
    const key = mealKey(r.event.text);
    if (!key) continue;
    const g = groups.get(key) || { key, label: r.event.text, rs: [] };
    g.rs.push(r);
    g.label = r.event.text; // responses are chronological: keep the latest wording
    groups.set(key, g);
  }
  return aggregate(groups).sort((a, b) => a.avgRise - b.avgRise);
}

// Single foods across different meals, e.g. every meal that had "rice" in it.
export function rankFoods(responses, minCount = 2) {
  const groups = new Map();
  for (const r of responses.filter(usable)) {
    const names = new Set(items(r.event.text).map(foodName).filter(Boolean));
    for (const name of names) {
      const g = groups.get(name) || { key: name, label: name, rs: [] };
      g.rs.push(r);
      groups.set(name, g);
    }
  }
  return aggregate(groups)
    .filter((g) => g.n >= minCount)
    .sort((a, b) => a.avgRise - b.avgRise);
}

// Does a habit (e.g. "walk after") go with smaller rises?
export function tagEffects(responses, tags, minEach = 2) {
  const rs = responses.filter(usable);
  const avg = (arr) => (arr.length ? arr.reduce((a, r) => a + r.rise, 0) / arr.length : null);
  return tags
    .map((tag) => {
      const withTag = rs.filter((r) => r.event.tags.includes(tag));
      const without = rs.filter((r) => !r.event.tags.includes(tag));
      return { tag, withN: withTag.length, withoutN: without.length, withAvg: avg(withTag), withoutAvg: avg(without) };
    })
    .filter((e) => e.withN >= minEach && e.withoutN >= minEach)
    .map((e) => ({ ...e, diff: e.withAvg - e.withoutAvg }));
}

// ---- overall glucose summary ----

export function summarise(readings, from, to, low, high) {
  const rs = readingsBetween(readings, from, to);
  if (!rs.length) return null;
  const vals = rs.map((r) => r.mgdl);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const cgm = rs.filter((r) => r.kind === 'cgm');
  const span = cgm.length ? readingsBetween(cgm, from, to) : [];
  const inRange = (arr) => arr.filter((r) => r.mgdl >= low && r.mgdl <= high).length / arr.length;
  const cgmDays = new Set(cgm.map((r) => new Date(r.ts).toDateString())).size;
  return {
    n: rs.length,
    mean,
    min: Math.min(...vals),
    max: Math.max(...vals),
    // Time-in-range and GMI only mean something with continuous data.
    tir: span.length >= 48 ? inRange(span) : null,
    below: span.length >= 48 ? span.filter((r) => r.mgdl < low).length / span.length : null,
    above: span.length >= 48 ? span.filter((r) => r.mgdl > high).length / span.length : null,
    cgmDays,
    // Glucose Management Indicator (estimated A1c) — needs ~2 weeks of CGM.
    gmi: cgmDays >= 10 ? 3.31 + 0.02392 * (span.reduce((a, r) => a + r.mgdl, 0) / span.length) : null,
    days: Math.max(1, Math.round((to - from) / DAY)),
  };
}
