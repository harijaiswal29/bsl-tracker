// Hand-rolled SVG glucose chart: target band, glucose line/dots, meal markers,
// crosshair + tooltip. Colors come from CSS variables so light/dark both work.

import { h, s, fill, toUnit, fmtGlucose, fmtTime, MIN, HOUR } from './util.js';

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function nearest(arr, ts) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1].ts - ts) < Math.abs(arr[lo].ts - ts)) lo--;
  return arr[lo];
}

/**
 * @param {object} o
 * @param {number} o.width   pixel width of the chart
 * @param {number} o.from    start of x domain (ms)
 * @param {number} o.to      end of x domain (ms)
 * @param {Array}  o.readings sorted glucose readings in [from, to]
 * @param {Array}  o.meals    meals in [from, to]
 * @param {Array}  o.xTicks   [{ ts, label }]
 * @param {Array}  [o.marks]  [{ ts, mgdl, label }] annotated points (baseline / peak)
 */
export function glucoseChart(o) {
  const { width, height = 200, from, to, readings, meals = [], low, high, unit, xTicks, marks = [], onMeal } = o;
  const pad = { l: 36, r: 12, t: 12, b: 38 };
  const pw = Math.max(50, width - pad.l - pad.r);
  const ph = height - pad.t - pad.b;

  const vals = readings.map((r) => r.mgdl);
  const lo = Math.min(low - 15, ...vals.map((v) => v - 10));
  const hi = Math.max(high + 20, ...vals.map((v) => v + 10));
  const step = niceStep((toUnit(hi, unit) - toUnit(lo, unit)) / 4);
  const y0 = Math.floor(toUnit(lo, unit) / step) * step;
  const y1 = Math.ceil(toUnit(hi, unit) / step) * step;

  const x = (ts) => pad.l + ((ts - from) / (to - from)) * pw;
  const y = (mg) => pad.t + (1 - (toUnit(mg, unit) - y0) / (y1 - y0)) * ph;
  const base = pad.t + ph;

  const svg = s('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart',
    role: 'img',
    'aria-label': readings.length
      ? `Glucose from ${fmtGlucose(Math.min(...vals), unit)} to ${fmtGlucose(Math.max(...vals), unit)} ${unit}, ${meals.length} meals`
      : 'No glucose readings in this period',
  });

  // target band
  svg.append(s('rect', { class: 'band', x: pad.l, width: pw, y: y(high), height: Math.max(0, y(low) - y(high)) }));
  svg.append(s('text', { class: 'band-label', x: pad.l + pw - 4, y: y(high) + 12, 'text-anchor': 'end' }, 'target'));

  // y grid + labels
  for (let v = y0; v <= y1 + 1e-9; v += step) {
    const yy = pad.t + (1 - (v - y0) / (y1 - y0)) * ph;
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: pad.l + pw, y1: yy, y2: yy }));
    svg.append(s('text', { class: 'tick', x: pad.l - 6, y: yy + 3.5, 'text-anchor': 'end' }, unit === 'mmol/L' ? +v.toFixed(1) : Math.round(v)));
  }
  svg.append(s('line', { class: 'axis', x1: pad.l, x2: pad.l + pw, y1: base, y2: base }));
  for (const t of xTicks) {
    svg.append(s('text', { class: 'tick', x: x(t.ts), y: height - 6, 'text-anchor': 'middle' }, t.label));
  }

  // glucose line, broken across gaps > 3 h
  let d = '';
  readings.forEach((r, i) => {
    const gap = i === 0 || r.ts - readings[i - 1].ts > 3 * HOUR;
    d += `${gap ? 'M' : 'L'}${x(r.ts).toFixed(1)},${y(r.mgdl).toFixed(1)}`;
  });
  if (d) svg.append(s('path', { class: 'line', d }));
  for (const r of readings) {
    if (r.kind === 'cgm') continue;
    svg.append(s('circle', { class: 'dot', cx: x(r.ts), cy: y(r.mgdl), r: 4 }));
  }

  for (const m of marks) {
    svg.append(s('circle', { class: 'mark', cx: x(m.ts), cy: y(m.mgdl), r: 4.5 }));
    const above = y(m.mgdl) - 9 > pad.t + 4;
    svg.append(s('text', { class: 'mark-label', x: x(m.ts), y: above ? y(m.mgdl) - 9 : y(m.mgdl) + 17, 'text-anchor': 'middle' }, m.label));
  }

  // meal markers sit in a row just under the baseline
  for (const m of meals) {
    const g = s('g', { class: 'meal-marker', tabindex: onMeal ? 0 : null, role: onMeal ? 'button' : null, 'aria-label': `${fmtTime(m.ts)} ${m.text}` },
      s('circle', { class: 'meal-hit', cx: x(m.ts), cy: base + 10, r: 12 }),
      s('circle', { class: 'meal-dot', cx: x(m.ts), cy: base + 10, r: 5 }),
    );
    if (onMeal) {
      g.addEventListener('click', () => onMeal(m));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter') onMeal(m); });
    }
    svg.append(g);
  }

  // crosshair + tooltip
  const wrap = h('div', { class: 'chart-wrap' }, svg);
  const tip = h('div', { class: 'tooltip', hidden: true });
  wrap.append(tip);
  if (readings.length) {
    const cross = s('line', { class: 'cross', y1: pad.t, y2: base, visibility: 'hidden' });
    const hot = s('circle', { class: 'hot', r: 5, visibility: 'hidden' });
    const overlay = s('rect', { class: 'overlay', x: pad.l, y: pad.t, width: pw, height: ph });
    svg.append(cross, hot, overlay);
    const show = (clientX) => {
      const box = svg.getBoundingClientRect();
      const ts = from + ((clientX - box.left - pad.l) / pw) * (to - from);
      const r = nearest(readings, ts);
      const cx = x(r.ts), cy = y(r.mgdl);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      hot.setAttribute('cx', cx); hot.setAttribute('cy', cy); hot.setAttribute('visibility', 'visible');
      const meal = meals.find((m) => Math.abs(m.ts - r.ts) <= 20 * MIN);
      fill(tip,
        h('div', null, h('strong', null, fmtGlucose(r.mgdl, unit)), ' ', h('span', { class: 'muted' }, unit)),
        h('div', { class: 'muted' }, fmtTime(r.ts)),
        meal ? h('div', { class: 'tip-meal' }, meal.text) : null,
      );
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), width - tw)}px`;
      tip.style.top = `${Math.max(cy - tip.offsetHeight - 12, 0)}px`;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    overlay.addEventListener('pointermove', (e) => show(e.clientX));
    overlay.addEventListener('pointerdown', (e) => show(e.clientX));
    // Mouse: hide on leave. Touch fires pointerleave on lift, so keep the readout until the next tap elsewhere.
    overlay.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    const onDoc = (e) => {
      if (!wrap.isConnected) document.removeEventListener('pointerdown', onDoc); // chart was re-rendered
      else if (!wrap.contains(e.target)) hide();
    };
    document.addEventListener('pointerdown', onDoc);
  }
  return wrap;
}
