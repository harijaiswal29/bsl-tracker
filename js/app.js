import * as db from './db.js';
import {
  MIN, HOUR, DAY, uid, startOfDay, addDays, fmtTime, fmtDay, fmtDate, fmtAgo, mealName,
  toLocalInput, fromLocalInput, fromUnit, fmtGlucose, fmtRise, h, fill,
} from './util.js';
import { analyse, mealKey, rankMeals, rankFoods, tagEffects, summarise, readingsBetween, eatingEvents } from './analysis.js';
import { importGlucoseCSV } from './importers.js';
import { glucoseChart } from './chart.js';

export const VERSION = '1.0.0';

const DEFAULTS = { unit: 'mg/dL', low: 70, high: 180, checks: '2h', dateOrder: 'auto', lastBackup: null };

const TAGS = [
  { id: 'walk', icon: '🚶', label: 'Walked after' },
  { id: 'veg-first', icon: '🥗', label: 'Veggies first' },
  { id: 'meds', icon: '💊', label: 'Took meds' },
  { id: 'ate-out', icon: '🍽️', label: 'Ate out' },
  { id: 'stress', icon: '😣', label: 'Stressed' },
  { id: 'poor-sleep', icon: '😴', label: 'Slept badly' },
  { id: 'unwell', icon: '🤒', label: 'Unwell' },
];
const tagInfo = (id) => TAGS.find((t) => t.id === id) || { id, icon: '•', label: id };

const CONTEXTS = ['Fasting', 'Before meal', '1 hr after', '2 hr after', 'Bedtime', 'Other'];

const WHEN = [
  { id: 'now', label: 'Now', off: 0 },
  { id: '15', label: '15 min ago', off: 15 },
  { id: '30', label: '30 min ago', off: 30 },
  { id: '60', label: '1 hr ago', off: 60 },
  { id: 'custom', label: 'Pick time…' },
];

const CHECK_OFFSETS = { off: [], '2h': [120], '1h2h': [60, 120] };

const state = {
  meals: [],
  glucose: [],
  settings: { ...DEFAULTS },
  log: freshLog(),
  dayTs: startOfDay(Date.now()),
  range: 30,
  version: 0,
};

function freshLog(mode = 'meal') {
  return { mode, text: '', when: 'now', custom: null, tags: new Set(), value: '', context: null };
}

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $sub = document.getElementById('sub');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

// ---------- data ----------

let cached = { v: -1 };
function analysis() {
  if (cached.v !== state.version) cached = { v: state.version, ...analyse(state.meals, state.glucose) };
  return cached;
}
const changed = () => { state.version++; };
const byTs = (a, b) => a.ts - b.ts;

async function saveMeal(meal) {
  await db.put('meals', meal);
  state.meals = [...state.meals.filter((m) => m.id !== meal.id), meal].sort(byTs);
  changed();
  db.requestPersistence();
}
async function deleteMeal(meal) {
  await db.remove('meals', meal.id);
  state.meals = state.meals.filter((m) => m.id !== meal.id);
  changed();
}
async function saveReadings(readings) {
  await db.putMany('glucose', readings);
  const ids = new Set(readings.map((r) => r.id));
  state.glucose = [...state.glucose.filter((r) => !ids.has(r.id)), ...readings].sort(byTs);
  changed();
  db.requestPersistence();
}
async function deleteReading(r) {
  await db.remove('glucose', r.id);
  state.glucose = state.glucose.filter((x) => x.id !== r.id);
  changed();
}
async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await db.setKV('settings', state.settings);
  changed();
}

// ---------- small UI pieces ----------

const unit = () => state.settings.unit;

function glucoseStatus(mgdl) {
  const { low, high } = state.settings;
  if (mgdl < low) return { cls: 'critical', icon: '▼', label: 'Low' };
  if (mgdl > high) return { cls: 'serious', icon: '▲', label: 'High' };
  return { cls: 'good', icon: '✓', label: 'In range' };
}
const RISE_STATUS = {
  gentle: { cls: 'good', icon: '✓', label: 'Gentle' },
  moderate: { cls: 'warning', icon: '▲', label: 'Moderate' },
  spike: { cls: 'critical', icon: '▲▲', label: 'Spike' },
};
const pill = (st) => h('span', { class: `pill ${st.cls}` }, h('span', { 'aria-hidden': 'true' }, st.icon), ' ', st.label);

function chips(options, isOn, onTap, { cls = '' } = {}) {
  return h('div', { class: `chips ${cls}` }, options.map((o) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!isOn(o)), onclick: () => onTap(o) }, o.icon ? `${o.icon} ${o.label}` : o.label)));
}

function segmented(options, value, onChange, label) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map((o) =>
    h('button', { type: 'button', 'aria-pressed': String(o.id === value), onclick: () => onChange(o.id) }, o.label)));
}

let toastTimer;
function toast(msg, action) {
  clearTimeout(toastTimer);
  fill($toast, h('span', null, msg), action ? h('button', { type: 'button', onclick: () => { hideToast(); action.run(); } }, action.label) : null);
  $toast.classList.add('show');
  if (!action?.sticky) toastTimer = setTimeout(hideToast, action ? 5000 : 2500);
}
function hideToast() { $toast.classList.remove('show'); }

function chartWidth(inset = 0) {
  return Math.round(Math.min($view.clientWidth, 600) - 32 - 26 - inset);
}

function download(name, text, type) {
  const file = new File([text], name, { type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// ---------- entries list (shared by Log + Days) ----------

function entryRow(e) {
  if (e.type === 'meal') {
    const m = e.item;
    const resp = analysis().byMeal.get(m.id);
    return h('button', { type: 'button', class: 'entry', onclick: () => openMealSheet(m) },
      h('span', { class: 'entry-time' }, fmtTime(m.ts)),
      h('span', { class: 'entry-main' },
        h('span', { class: 'entry-kicker' }, mealName(m.ts)),
        h('span', { class: 'entry-text' }, m.text),
        m.tags?.length ? h('span', { class: 'entry-tags' }, m.tags.map((t) => `${tagInfo(t).icon} ${tagInfo(t).label}`).join(' · ')) : null),
      resp?.rise != null
        ? h('span', { class: 'entry-side' }, h('strong', null, fmtRise(resp.rise, unit())), pill(RISE_STATUS[resp.status]))
        : null);
  }
  const r = e.item;
  const st = glucoseStatus(r.mgdl);
  return h('button', { type: 'button', class: 'entry', onclick: () => openReadingSheet(r) },
    h('span', { class: 'entry-time' }, fmtTime(r.ts)),
    h('span', { class: 'entry-main' },
      h('span', { class: 'entry-kicker' }, r.kind === 'manual' ? 'Glucose' : r.kind === 'strip' ? 'Glucose · Libre strip' : r.kind === 'scan' ? 'Glucose · Libre scan' : 'Glucose · imported'),
      h('span', { class: 'entry-text' }, h('strong', null, fmtGlucose(r.mgdl, unit())), ` ${unit()}`, r.context ? h('span', { class: 'muted' }, ` · ${r.context}`) : null)),
    h('span', { class: 'entry-side' }, pill(st)));
}

function entriesBetween(from, to) {
  const meals = state.meals.filter((m) => m.ts >= from && m.ts < to).map((item) => ({ type: 'meal', ts: item.ts, item }));
  // Continuous CGM points live in the chart; the list shows readings someone actually took.
  const readings = readingsBetween(state.glucose, from, to - 1).filter((r) => r.kind !== 'cgm' && r.kind !== 'scan').map((item) => ({ type: 'glucose', ts: item.ts, item }));
  return [...meals, ...readings].sort(byTs);
}

// ---------- Log ----------

function resolveWhen(L) {
  if (L.when === 'custom') return L.custom ?? Date.now();
  return Date.now() - (WHEN.find((w) => w.id === L.when)?.off || 0) * MIN;
}

function whenPicker(L) {
  const box = h('div', { class: 'field' });
  const render = () => {
    const custom = L.when === 'custom'
      ? h('input', { type: 'datetime-local', class: 'input', value: toLocalInput(L.custom ?? Date.now()), max: toLocalInput(Date.now() + HOUR),
          onchange: (e) => { L.custom = fromLocalInput(e.target.value); render(); } })
      : null;
    if (L.when === 'custom' && L.custom == null) L.custom = Date.now();
    fill(box,
      h('div', { class: 'label' }, 'When', h('span', { class: 'muted' }, ` · ${fmtDay(resolveWhen(L))} ${fmtTime(resolveWhen(L))}`)),
      chips(WHEN, (w) => w.id === L.when, (w) => { L.when = w.id; render(); }),
      custom);
  };
  render();
  return box;
}

function suggestions(text) {
  const now = Date.now();
  const groups = new Map();
  for (const m of state.meals) {
    const key = mealKey(m.text);
    const g = groups.get(key) || { text: m.text, n: 0, last: 0, sameSlot: 0 };
    g.n++;
    if (m.ts >= g.last) { g.last = m.ts; g.text = m.text; }
    if (mealName(m.ts) === mealName(now)) g.sameSlot++;
    groups.set(key, g);
  }
  let list = [...groups.values()];
  const q = text.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter((g) => g.text.toLowerCase() !== q && words.every((w) => g.text.toLowerCase().includes(w)));
    list.sort((a, b) => b.n - a.n || b.last - a.last);
  } else {
    // nothing typed: what you usually eat at this time of day, then recent
    list.sort((a, b) => b.sameSlot - a.sameSlot || b.last - a.last);
  }
  return list.slice(0, 6);
}

function dueChecks() {
  const offsets = CHECK_OFFSETS[state.settings.checks] || [];
  if (!offsets.length) return null;
  const now = Date.now();
  const events = eatingEvents(state.meals.filter((m) => m.ts > now - 4 * HOUR && m.ts <= now));
  const due = [], upcoming = [];
  for (const e of events) {
    for (const off of offsets) {
      const at = e.ts + off * MIN;
      const taken = readingsBetween(state.glucose, at - 25 * MIN, at + 40 * MIN).length > 0;
      if (taken) continue;
      const item = { e, off, at };
      if (now >= at - 10 * MIN && now <= at + 60 * MIN) due.push(item);
      else if (now < at - 10 * MIN) upcoming.push(item);
    }
  }
  if (!due.length && !upcoming.length) return null;
  const label = (i) => `${i.off === 60 ? '1 hr' : '2 hr'} check after ${mealName(i.e.ts).toLowerCase()}`;
  const next = upcoming.sort((a, b) => a.at - b.at)[0];
  return h('div', { class: 'card due' },
    due.map((i) => h('div', { class: 'due-row' },
      h('span', null, '⏰ ', h('strong', null, label(i)), h('span', { class: 'muted' }, ` · due ${fmtTime(i.at)}`)),
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        state.log = freshLog('glucose');
        state.log.context = i.off === 60 ? '1 hr after' : '2 hr after';
        render();
      } }, 'Log reading'))),
    !due.length && next ? h('div', { class: 'muted' }, `Next: ${label(next)} at ${fmtTime(next.at)}`) : null);
}

function mealForm(L) {
  const ta = h('textarea', {
    class: 'input big', rows: 2, placeholder: 'What did you eat?  e.g. 2 rotis, dal, salad',
    'aria-label': 'What did you eat', enterkeyhint: 'done', value: L.text,
    oninput: (e) => { L.text = e.target.value; renderSugg(); },
  });
  const sugg = h('div', { class: 'sugg' });
  const renderSugg = () => {
    const list = suggestions(L.text);
    sugg.replaceChildren(list.length
      ? chips(list.map((g) => ({ label: g.text, g })), () => false, (o) => { L.text = o.g.text; ta.value = o.g.text; renderSugg(); }, { cls: 'scroll' })
      : '');
  };
  renderSugg();
  const tags = h('div', { class: 'field' });
  const renderTags = () => tags.replaceChildren(
    h('div', { class: 'label' }, 'Anything else? ', h('span', { class: 'muted' }, '(optional)')),
    chips(TAGS, (t) => L.tags.has(t.id), (t) => { L.tags.has(t.id) ? L.tags.delete(t.id) : L.tags.add(t.id); renderTags(); }));
  renderTags();

  const save = async () => {
    const text = L.text.trim().replace(/\s+/g, ' ');
    if (!text) { ta.focus(); toast('Type what you ate first'); return; }
    const meal = { id: uid(), ts: resolveWhen(L), text, tags: [...L.tags], createdAt: Date.now() };
    await saveMeal(meal);
    state.log = freshLog('meal');
    render();
    const checks = CHECK_OFFSETS[state.settings.checks];
    const hint = checks.length && meal.ts > Date.now() - HOUR ? ` · check at ${fmtTime(meal.ts + checks[checks.length - 1] * MIN)}` : '';
    toast(`${mealName(meal.ts)} logged${hint}`, { label: 'Undo', run: async () => { await deleteMeal(meal); render(); } });
  };

  return h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault(); save(); } },
    ta, sugg, whenPicker(L), tags,
    h('button', { type: 'submit', class: 'btn primary block' }, 'Save meal'));
}

function glucoseForm(L) {
  const u = unit();
  const input = h('input', {
    class: 'input huge', type: 'number', inputmode: u === 'mmol/L' ? 'decimal' : 'numeric', step: u === 'mmol/L' ? '0.1' : '1',
    placeholder: u === 'mmol/L' ? '6.2' : '112', 'aria-label': `Glucose in ${u}`, value: L.value,
    oninput: (e) => { L.value = e.target.value; },
  });
  const ctx = h('div', { class: 'field' });
  const renderCtx = () => ctx.replaceChildren(
    h('div', { class: 'label' }, 'Reading taken ', h('span', { class: 'muted' }, '(optional)')),
    chips(CONTEXTS.map((c) => ({ label: c })), (c) => c.label === L.context, (c) => { L.context = L.context === c.label ? null : c.label; renderCtx(); }));
  renderCtx();

  const save = async () => {
    const v = parseFloat(String(L.value).replace(',', '.'));
    const mgdl = Math.round(fromUnit(v, u));
    if (!Number.isFinite(v) || mgdl < 20 || mgdl > 600) { input.focus(); toast(`Enter a reading in ${u}`); return; }
    const r = { id: uid(), ts: resolveWhen(L), mgdl, kind: 'manual', context: L.context, createdAt: Date.now() };
    await saveReadings([r]);
    state.log = freshLog('glucose');
    render();
    const st = glucoseStatus(mgdl);
    toast(`${fmtGlucose(mgdl, u)} ${u} · ${st.label}`, { label: 'Undo', run: async () => { await deleteReading(r); render(); } });
  };

  return h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'huge-wrap' }, input, h('span', { class: 'unit' }, u)),
    whenPicker(L), ctx,
    h('button', { type: 'submit', class: 'btn primary block' }, 'Save reading'));
}

function viewLog() {
  const L = state.log;
  const today = startOfDay(Date.now());
  const list = entriesBetween(today, addDays(today, 1)).reverse();
  return [
    dueChecks(),
    segmented([{ id: 'meal', label: '🍽️  Meal' }, { id: 'glucose', label: '🩸  Glucose' }], L.mode, (mode) => {
      if (mode !== L.mode) { L.mode = mode; render(); }
    }, 'What to log'),
    L.mode === 'meal' ? mealForm(L) : glucoseForm(L),
    h('section', null,
      h('h2', null, 'Today'),
      list.length
        ? h('div', { class: 'card list' }, list.map(entryRow))
        : h('p', { class: 'empty' }, 'Nothing logged yet today. Your first entry will show up here.')),
  ];
}

// ---------- Days ----------

function statLine(items) {
  return h('div', { class: 'stats' }, items.filter(Boolean).map(([label, value, extra]) =>
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value, extra ? h('span', { class: 'stat-unit' }, extra) : null))));
}

function legend() {
  return h('div', { class: 'legend' },
    h('span', null, h('span', { class: 'key-line' }), 'Glucose'),
    h('span', null, h('span', { class: 'key-dot' }), 'Meal'),
    h('span', null, h('span', { class: 'key-band' }), `Target ${fmtGlucose(state.settings.low, unit())}–${fmtGlucose(state.settings.high, unit())}`));
}

function viewDays() {
  const from = state.dayTs, to = addDays(from, 1);
  const isToday = from === startOfDay(Date.now());
  const readings = readingsBetween(state.glucose, from, to);
  const meals = state.meals.filter((m) => m.ts >= from && m.ts < to);
  const sum = summarise(state.glucose, from, to, state.settings.low, state.settings.high);
  const u = unit();
  const nav = h('div', { class: 'daynav' },
    h('button', { type: 'button', class: 'btn icon', 'aria-label': 'Previous day', onclick: () => { state.dayTs = addDays(state.dayTs, -1); render(); } }, '‹'),
    h('label', { class: 'daypick' }, h('span', null, fmtDay(from)), h('span', { class: 'muted' }, ` ${fmtDate(from)}`),
      h('input', { type: 'date', 'aria-label': 'Pick a day', value: toLocalInput(from).slice(0, 10), max: toLocalInput(Date.now()).slice(0, 10),
        onchange: (e) => { if (e.target.value) { state.dayTs = startOfDay(new Date(`${e.target.value}T00:00`).getTime()); render(); } } })),
    h('button', { type: 'button', class: 'btn icon', 'aria-label': 'Next day', disabled: isToday, onclick: () => { state.dayTs = addDays(state.dayTs, 1); render(); } }, '›'));

  const list = entriesBetween(from, to);
  const xTicks = [0, 6, 12, 18].map((hr) => ({ ts: from + hr * HOUR, label: hr === 0 ? '12am' : hr === 12 ? '12pm' : hr < 12 ? `${hr}am` : `${hr - 12}pm` }));
  return [
    nav,
    sum ? statLine([
      ['Average', fmtGlucose(sum.mean, u), u],
      ['Lowest', fmtGlucose(sum.min, u)],
      ['Highest', fmtGlucose(sum.max, u)],
      sum.tir != null ? ['In range', `${Math.round(sum.tir * 100)}%`] : ['Readings', String(sum.n)],
    ]) : null,
    h('div', { class: 'card' },
      legend(),
      readings.length || meals.length
        ? glucoseChart({ width: chartWidth(), from, to, readings, meals, low: state.settings.low, high: state.settings.high, unit: u, xTicks, onMeal: openMealSheet })
        : h('p', { class: 'empty' }, 'No data for this day.')),
    list.length ? h('div', { class: 'card list' }, list.map(entryRow)) : null,
  ];
}

// ---------- Insights ----------

function rankRow(g, maxAbs, onTap) {
  const st = RISE_STATUS[g.status];
  const pct = maxAbs ? Math.max(2, (Math.max(0, g.avgRise) / maxAbs) * 100) : 0;
  return h('button', { type: 'button', class: 'rank', onclick: onTap },
    h('div', { class: 'rank-top' },
      h('span', { class: 'rank-label' }, g.label),
      h('span', { class: 'rank-value' }, h('strong', null, fmtRise(g.avgRise, unit())), pill(st))),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar', style: `width:${pct}%` })),
    h('div', { class: 'rank-meta muted' }, `${g.n}× · last ${fmtDay(g.lastTs)}${g.minRise !== g.maxRise ? ` · ranged ${fmtRise(g.minRise, unit())} to ${fmtRise(g.maxRise, unit())}` : ''}`));
}

function viewInsights() {
  const u = unit();
  const now = Date.now();
  const from = state.range ? startOfDay(addDays(now, -state.range + 1)) : 0;
  const { responses } = analysis();
  const inRange = responses.filter((r) => r.event.ts >= from);
  const usable = inRange.filter((r) => r.rise != null && !r.overlapped);
  const sum = summarise(state.glucose, from || (state.glucose[0]?.ts ?? now), now, state.settings.low, state.settings.high);

  const rangeSeg = segmented([{ id: 7, label: '7 days' }, { id: 30, label: '30 days' }, { id: 90, label: '90 days' }, { id: 0, label: 'All' }],
    state.range, (id) => { state.range = id; render(); }, 'Period');

  const avgRise = usable.length ? usable.reduce((a, r) => a + r.rise, 0) / usable.length : null;
  const tiles = statLine([
    ['Avg glucose', sum ? fmtGlucose(sum.mean, u) : '–', sum ? u : ''],
    sum?.tir != null ? ['Time in range', `${Math.round(sum.tir * 100)}%`] : ['Readings', sum ? String(sum.n) : '0'],
    ['Avg rise after meals', avgRise != null ? fmtRise(avgRise, u) : '–'],
    sum?.gmi != null ? ['GMI (est. A1c)', `${sum.gmi.toFixed(1)}%`] : ['Meals with data', `${usable.length}/${inRange.length}`],
  ]);

  if (!usable.length) {
    return [rangeSeg, tiles, h('div', { class: 'card explain' },
      h('h2', null, 'How insights work'),
      h('p', null, 'For each meal, the app compares your glucose ', h('strong', null, 'just before eating'), ' with the ', h('strong', null, 'highest reading in the next 2½ hours'), '. That rise is the meal’s effect on you.'),
      h('p', null, h('strong', null, 'Fingerstick (Accu-Chek): '), 'take a reading before you eat, and again ~1 hr and 2 hrs after. The Log screen reminds you when a check is due.'),
      h('p', null, h('strong', null, 'Libre CGM: '), 'just log meals. Every week or so, import your LibreView CSV from the More tab and every meal is scored automatically.'),
      h('p', { class: 'muted' }, `${inRange.length} meal${inRange.length === 1 ? '' : 's'} in this period, none with readings around them yet.`))];
  }

  const meals = rankMeals(usable);
  const foods = rankFoods(usable).sort((a, b) => b.avgRise - a.avgRise).slice(0, 10);
  const maxAbs = Math.max(1, ...meals.map((g) => g.avgRise), ...foods.map((g) => g.avgRise));
  const effects = tagEffects(usable, TAGS.map((t) => t.id));

  const out = [rangeSeg, tiles];
  if (meals.length >= 10) {
    out.push(h('section', null, h('h2', null, 'Gentlest meals'), h('p', { class: 'hint' }, 'Smallest average rise — good go-to choices.'),
      h('div', { class: 'card list' }, meals.slice(0, 5).map((g) => rankRow(g, maxAbs, () => openGroupSheet(g))))));
    out.push(h('section', null, h('h2', null, 'Biggest spikes'), h('p', { class: 'hint' }, 'Largest average rise — worth swapping, shrinking, or walking after.'),
      h('div', { class: 'card list' }, [...meals].reverse().slice(0, 5).map((g) => rankRow(g, maxAbs, () => openGroupSheet(g))))));
  } else {
    out.push(h('section', null, h('h2', null, 'Your meals'), h('p', { class: 'hint' }, 'Gentlest first. Rankings firm up once you have repeat meals.'),
      h('div', { class: 'card list' }, meals.map((g) => rankRow(g, maxAbs, () => openGroupSheet(g))))));
  }
  if (foods.length) {
    out.push(h('section', null, h('h2', null, 'Foods across meals'),
      h('p', { class: 'hint' }, 'Average rise of meals that included each food (needs 2+ meals). Biggest first.'),
      h('div', { class: 'card list' }, foods.map((g) => rankRow(g, maxAbs, () => openGroupSheet(g))))));
  }
  if (effects.length) {
    out.push(h('section', null, h('h2', null, 'Habits'),
      h('div', { class: 'card list' }, effects.map((e) => {
        const t = tagInfo(e.tag);
        const better = e.diff < 0;
        return h('div', { class: 'habit' },
          h('div', null, `${t.icon} `, h('strong', null, t.label)),
          h('div', null, `${fmtRise(e.withAvg, u)} avg with (${e.withN}) vs ${fmtRise(e.withoutAvg, u)} without (${e.withoutN})`),
          h('div', { class: better ? 'good-text' : 'muted' }, better ? `${fmtGlucose(-e.diff, u)} ${u} smaller rise` : `${fmtGlucose(e.diff, u)} ${u} larger rise`));
      }))));
  }
  const overlapped = inRange.filter((r) => r.rise != null && r.overlapped).length;
  const missing = inRange.filter((r) => r.rise == null).length;
  if (overlapped || missing) {
    out.push(h('p', { class: 'hint' },
      missing ? `${missing} meal${missing === 1 ? '' : 's'} had no readings around them. ` : '',
      overlapped ? `${overlapped} ${overlapped === 1 ? 'was' : 'were'} left out because you ate again within 2 hrs.` : ''));
  }
  out.push(h('p', { class: 'disclaimer' }, 'Patterns, not medical advice. Discuss changes to diet or medication with your doctor.'));
  return out;
}

// ---------- More ----------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

function viewMore() {
  const S = state.settings;
  const u = S.unit;
  const rangeInput = (key) => h('input', {
    class: 'input', type: 'number', inputmode: 'decimal', step: u === 'mmol/L' ? '0.1' : '1', 'aria-label': key === 'low' ? 'Target low' : 'Target high',
    value: fmtGlucose(S[key], u),
    onchange: async (e) => {
      const mg = Math.round(fromUnit(parseFloat(e.target.value), u));
      if (!Number.isFinite(mg) || mg < 40 || mg > 400) { toast('That target looks off'); render(); return; }
      await saveSettings({ [key]: mg });
      toast('Saved');
    },
  });

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);

  const backupAge = S.lastBackup ? fmtAgo(S.lastBackup) : 'never';
  const needsBackup = (state.meals.length || state.glucose.length) && (!S.lastBackup || Date.now() - S.lastBackup > 14 * DAY);

  return [
    h('section', null, h('h2', null, 'Import glucose data'),
      h('div', { class: 'card' },
        h('p', null, h('strong', null, 'FreeStyle Libre 2: '), 'on libreview.com open ', h('em', null, 'Glucose History'), ' → ', h('em', null, 'Download glucose data'), ', then pick the CSV here.'),
        h('p', null, h('strong', null, 'Accu-Chek: '), 'log readings on the Log tab, or import a CSV export (e.g. from mySugr) that has a date and a glucose column.'),
        h('p', { class: 'muted' }, 'Importing the same file twice is safe — duplicates are skipped.'),
        h('button', { type: 'button', class: 'btn primary block', onclick: importFlow }, 'Choose CSV file…'),
        h('div', { id: 'import-preview' }))),

    h('section', null, h('h2', null, 'Settings'),
      h('div', { class: 'card form' },
        h('div', { class: 'field' }, h('div', { class: 'label' }, 'Units'),
          segmented([{ id: 'mg/dL', label: 'mg/dL' }, { id: 'mmol/L', label: 'mmol/L' }], u, async (id) => { await saveSettings({ unit: id }); render(); }, 'Units')),
        h('div', { class: 'field' }, h('div', { class: 'label' }, `Target range (${u})`),
          h('div', { class: 'range-row' }, rangeInput('low'), h('span', null, 'to'), rangeInput('high')),
          h('div', { class: 'muted small' }, 'Common targets: 70–180 mg/dL (3.9–10.0) for diabetes; ask your doctor for yours.')),
        h('div', { class: 'field' }, h('div', { class: 'label' }, 'After-meal check reminders'),
          segmented([{ id: 'off', label: 'Off' }, { id: '2h', label: '2 hr' }, { id: '1h2h', label: '1 & 2 hr' }], S.checks, async (id) => { await saveSettings({ checks: id }); render(); }, 'Reminders'),
          h('div', { class: 'muted small' }, 'Shown on the Log screen. Turn off if you use a Libre CGM.')),
        h('div', { class: 'field' }, h('div', { class: 'label' }, 'Dates in imported CSVs'),
          segmented([{ id: 'auto', label: 'Auto' }, { id: 'DMY', label: 'Day first' }, { id: 'MDY', label: 'Month first' }], S.dateOrder, async (id) => { await saveSettings({ dateOrder: id }); render(); }, 'Date order')))),

    h('section', null, h('h2', null, 'Backup'),
      h('div', { class: `card ${needsBackup ? 'warn' : ''}` },
        h('p', null, 'Your data is stored only on this device. Last backup: ', h('strong', null, backupAge), '.'),
        needsBackup ? h('p', null, '⚠️ Save a backup (to Drive, email or WhatsApp-to-self) every couple of weeks.') : null,
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: exportBackup }, 'Back up'),
          h('button', { type: 'button', class: 'btn', onclick: restoreBackup }, 'Restore…'),
          h('button', { type: 'button', class: 'btn', onclick: exportCSV }, 'Export CSV')),
        h('p', { class: 'muted small' }, `${state.meals.length} meals · ${state.glucose.length.toLocaleString()} glucose readings`))),

    standalone ? null : h('section', null, h('h2', null, 'Add to home screen'),
      h('div', { class: 'card' },
        installPrompt
          ? h('button', { type: 'button', class: 'btn primary block', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); } }, 'Install app')
          : ios
            ? h('p', null, 'In Safari tap ', h('strong', null, 'Share'), ' → ', h('strong', null, 'Add to Home Screen'), '.')
            : h('p', null, 'In Chrome tap the ', h('strong', null, '⋮'), ' menu → ', h('strong', null, 'Add to Home screen'), ' (or ', h('strong', null, 'Install app'), ').'))),

    h('section', null, h('h2', null, 'About'),
      h('div', { class: 'card' },
        h('p', null, `BSL Tracker ${VERSION}. Works offline. No account, no server — nothing leaves your phone unless you export it.`),
        h('p', { class: 'muted' }, 'This is a personal tracking tool, not a medical device. Discuss diet or medication changes with your doctor.'),
        h('button', { type: 'button', class: 'btn danger', onclick: async () => {
          if (!confirm('Delete ALL meals, readings and settings from this device?')) return;
          if (!confirm('Really delete everything? This cannot be undone.')) return;
          await db.clearAll();
          state.meals = []; state.glucose = []; state.settings = { ...DEFAULTS }; changed();
          render(); toast('All data deleted');
        } }, 'Delete all data'))),
  ];
}

async function importFlow() {
  const file = await pickFile('.csv,text/csv,text/plain');
  if (!file) return;
  const box = document.getElementById('import-preview');
  let result;
  try {
    result = importGlucoseCSV(await file.text(), { dateOrder: state.settings.dateOrder });
  } catch (err) {
    box.replaceChildren(h('p', { class: 'error' }, err.message));
    return;
  }
  const have = new Set(state.glucose.map((r) => r.id));
  const fresh = result.readings.filter((r) => !have.has(r.id));
  if (!result.readings.length) {
    box.replaceChildren(h('p', { class: 'error' }, `Recognised ${result.format}, but found no readings.`));
    return;
  }
  box.replaceChildren(h('div', { class: 'preview' },
    h('p', null, h('strong', null, result.format)),
    h('p', null, `${result.readings.length.toLocaleString()} readings, ${fmtDate(result.from)} ${fmtTime(result.from)} → ${fmtDate(result.to)} ${fmtTime(result.to)}`),
    h('p', null, h('strong', null, `${fresh.length.toLocaleString()} new`), result.skipped ? h('span', { class: 'muted' }, ` · ${result.skipped} rows skipped (HI/LO or unreadable)`) : null),
    h('p', { class: 'muted small' }, 'Check the dates look right. If day and month are swapped, change “Dates in imported CSVs” in Settings and import again.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn primary', disabled: !fresh.length, onclick: async () => {
        await saveReadings(fresh);
        toast(`Imported ${fresh.length.toLocaleString()} readings`);
        state.dayTs = startOfDay(result.to);
        location.hash = '#days';
      } }, 'Import'),
      h('button', { type: 'button', class: 'btn', onclick: () => box.replaceChildren() }, 'Cancel'))));
}

async function exportBackup() {
  const data = { app: 'bsl-tracker', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, meals: state.meals, glucose: state.glucose };
  download(`bsl-backup-${toLocalInput(Date.now()).slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  await saveSettings({ lastBackup: Date.now() });
  render();
}

async function restoreBackup() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'bsl-tracker' || !Array.isArray(data.meals) || !Array.isArray(data.glucose)) throw new Error('Not a BSL Tracker backup');
    const okMeal = (m) => m && typeof m.id === 'string' && Number.isFinite(m.ts) && typeof m.text === 'string';
    const okReading = (r) => r && typeof r.id === 'string' && Number.isFinite(r.ts) && Number.isFinite(r.mgdl);
    const meals = data.meals.filter(okMeal).map((m) => ({ ...m, tags: Array.isArray(m.tags) ? m.tags : [] }));
    const glucose = data.glucose.filter(okReading);
    await db.putMany('meals', meals);
    await saveReadings(glucose);
    state.meals = await db.getAll('meals');
    if (data.settings) await saveSettings({ ...DEFAULTS, ...data.settings });
    changed();
    render();
    toast(`Restored ${meals.length} meals, ${glucose.length.toLocaleString()} readings`);
  } catch (err) {
    toast(`Couldn’t restore: ${err.message}`);
  }
}

function exportCSV() {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const { byMeal } = analysis();
  const rows = [['type', 'date', 'time', 'meal', 'tags', 'glucose_mgdl', 'context_or_source', 'meal_rise_mgdl', 'meal_peak_mgdl']];
  const all = [...state.meals.map((m) => ({ type: 'meal', ts: m.ts, m })), ...state.glucose.map((r) => ({ type: 'glucose', ts: r.ts, r }))].sort(byTs);
  for (const e of all) {
    const d = toLocalInput(e.ts);
    if (e.m) {
      const resp = byMeal.get(e.m.id);
      rows.push(['meal', d.slice(0, 10), d.slice(11), e.m.text, (e.m.tags || []).map((t) => tagInfo(t).label).join('; '), '', '', resp?.rise ?? '', resp?.peak?.mgdl ?? '']);
    } else {
      rows.push(['glucose', d.slice(0, 10), d.slice(11), '', '', e.r.mgdl, e.r.context || e.r.kind, '', '']);
    }
  }
  download(`bsl-export-${toLocalInput(Date.now()).slice(0, 10)}.csv`, rows.map((r) => r.map(esc).join(',')).join('\n'), 'text/csv');
}

// ---------- sheets ----------

function openSheet(title, ...body) {
  fill($sheet, h('div', { class: 'sheet-inner' },
    h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { type: 'button', class: 'btn icon', 'aria-label': 'Close', onclick: () => $sheet.close() }, '✕')),
    ...body));
  if (!$sheet.open) $sheet.showModal();
}
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) $sheet.close(); });

function responseBlock(meal) {
  const u = unit();
  const resp = analysis().byMeal.get(meal.id);
  const t = resp ? resp.event.ts : meal.ts;
  const from = t - 45 * MIN, to = t + 3 * HOUR;
  const readings = readingsBetween(state.glucose, from, to);
  const meals = state.meals.filter((m) => m.ts >= from && m.ts <= to);
  const others = resp ? resp.event.meals.filter((m) => m.id !== meal.id) : [];
  const parts = [];
  if (readings.length) {
    const marks = [];
    if (resp?.baseline) marks.push({ ts: resp.baseline.ts, mgdl: resp.baseline.mgdl, label: 'before' });
    if (resp?.peak) marks.push({ ts: resp.peak.ts, mgdl: resp.peak.mgdl, label: 'peak' });
    parts.push(glucoseChart({
      width: chartWidth(-26), height: 180, from, to, readings, meals, marks, low: state.settings.low, high: state.settings.high, unit: u,
      xTicks: [0, 1, 2, 3].map((n) => ({ ts: t + n * HOUR, label: n ? `+${n}h` : 'ate' })),
    }));
  }
  if (resp?.rise != null) {
    parts.push(h('p', { class: 'result' }, pill(RISE_STATUS[resp.status]), ' ',
      h('strong', null, `${fmtRise(resp.rise, u)} ${u}`), ` — ${fmtGlucose(resp.baseline.mgdl, u)} before, peaked at ${fmtGlucose(resp.peak.mgdl, u)}, ${resp.minutesToPeak} min after eating.`));
    if (resp.overlapped) parts.push(h('p', { class: 'muted small' }, 'You ate again within 2 hrs, so this one is left out of the rankings.'));
  } else if (resp?.baseline && !resp.peak) {
    parts.push(h('p', { class: 'muted' }, 'Got a before-meal reading. Add one 1–2 hrs after eating to see the rise.'));
  } else if (resp?.peak && !resp.baseline) {
    parts.push(h('p', { class: 'muted' }, 'Got an after-meal reading, but none from just before eating, so the rise can’t be measured.'));
  } else {
    parts.push(h('p', { class: 'muted' }, 'No glucose readings around this meal yet. Add one before and 1–2 hrs after eating, or import Libre data.'));
  }
  if (others.length) parts.push(h('p', { class: 'muted small' }, `Counted together with: ${others.map((m) => m.text).join('; ')} (eaten within 30 min).`));
  return h('div', { class: 'response' }, parts);
}

function openMealSheet(meal) {
  const draft = { text: meal.text, ts: meal.ts, tags: new Set(meal.tags || []) };
  const tags = h('div', { class: 'field' });
  const renderTags = () => tags.replaceChildren(chips(TAGS, (t) => draft.tags.has(t.id), (t) => { draft.tags.has(t.id) ? draft.tags.delete(t.id) : draft.tags.add(t.id); renderTags(); }));
  renderTags();
  openSheet(`${mealName(meal.ts)} · ${fmtDay(meal.ts)}`,
    responseBlock(meal),
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const text = draft.text.trim();
      if (!text) return toast('Meal can’t be empty');
      await saveMeal({ ...meal, text, ts: draft.ts, tags: [...draft.tags], updatedAt: Date.now() });
      $sheet.close(); render(); toast('Saved');
    } },
      h('textarea', { class: 'input', rows: 2, 'aria-label': 'Meal', value: draft.text, oninput: (e) => { draft.text = e.target.value; } }),
      h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'Time', value: toLocalInput(draft.ts), onchange: (e) => { draft.ts = fromLocalInput(e.target.value) ?? draft.ts; } }),
      tags,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn danger', onclick: async () => {
          await deleteMeal(meal); $sheet.close(); render();
          toast('Meal deleted', { label: 'Undo', run: async () => { await saveMeal(meal); render(); } });
        } }, 'Delete'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
}

function openReadingSheet(r) {
  const u = unit();
  const draft = { value: fmtGlucose(r.mgdl, u), ts: r.ts, context: r.context || null };
  const ctx = h('div', { class: 'field' });
  const renderCtx = () => ctx.replaceChildren(chips(CONTEXTS.map((c) => ({ label: c })), (c) => c.label === draft.context, (c) => { draft.context = draft.context === c.label ? null : c.label; renderCtx(); }));
  renderCtx();
  const manual = r.kind === 'manual';
  openSheet(`Glucose · ${fmtDay(r.ts)} ${fmtTime(r.ts)}`,
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const mgdl = Math.round(fromUnit(parseFloat(String(draft.value).replace(',', '.')), u));
      if (!Number.isFinite(mgdl) || mgdl < 20 || mgdl > 600) return toast(`Enter a reading in ${u}`);
      await saveReadings([{ ...r, mgdl, ts: draft.ts, context: draft.context, updatedAt: Date.now() }]);
      $sheet.close(); render(); toast('Saved');
    } },
      manual ? null : h('p', { class: 'muted small' }, 'Imported reading.'),
      h('div', { class: 'huge-wrap' }, h('input', { class: 'input huge', type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': `Glucose in ${u}`, value: draft.value, oninput: (e) => { draft.value = e.target.value; } }), h('span', { class: 'unit' }, u)),
      h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'Time', value: toLocalInput(draft.ts), onchange: (e) => { draft.ts = fromLocalInput(e.target.value) ?? draft.ts; } }),
      ctx,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn danger', onclick: async () => {
          await deleteReading(r); $sheet.close(); render();
          toast('Reading deleted', { label: 'Undo', run: async () => { await saveReadings([r]); render(); } });
        } }, 'Delete'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
}

function openGroupSheet(g) {
  const u = unit();
  openSheet(g.label,
    h('p', null, pill(RISE_STATUS[g.status]), ' ', h('strong', null, `${fmtRise(g.avgRise, u)} ${u}`), ` average over ${g.n} time${g.n === 1 ? '' : 's'}`),
    h('div', { class: 'list' }, [...g.responses].reverse().map((r) => {
      const m = r.event.meals[0];
      return h('button', { type: 'button', class: 'entry', onclick: () => openMealSheet(m) },
        h('span', { class: 'entry-time' }, fmtDay(r.event.ts), h('br'), fmtTime(r.event.ts)),
        h('span', { class: 'entry-main' }, h('span', { class: 'entry-text' }, r.event.text),
          r.event.tags.length ? h('span', { class: 'entry-tags' }, r.event.tags.map((t) => `${tagInfo(t).icon} ${tagInfo(t).label}`).join(' · ')) : null),
        h('span', { class: 'entry-side' }, h('strong', null, fmtRise(r.rise, u)), pill(RISE_STATUS[r.status])));
    })));
}

// ---------- routing ----------

const VIEWS = {
  log: { title: 'Log', render: viewLog },
  days: { title: 'Days', render: viewDays },
  insights: { title: 'Insights', render: viewInsights },
  more: { title: 'More', render: viewMore },
};

function currentTab() {
  const t = location.hash.slice(1);
  return VIEWS[t] ? t : 'log';
}

function render() {
  const tab = currentTab();
  $title.textContent = VIEWS[tab].title;
  $sub.textContent = tab === 'log' ? fmtDate(Date.now()) : '';
  $view.replaceChildren(...[VIEWS[tab].render()].flat().filter(Boolean));
  for (const b of document.querySelectorAll('.tabs a')) b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
}

window.addEventListener('hashchange', () => { if ($sheet.open) $sheet.close(); render(); window.scrollTo(0, 0); });
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentTab() !== 'log') render(); }, 150);
});
// Due-check cards and "15 min ago" times drift; refresh when coming back to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTab() === 'log' && !$sheet.open && !document.activeElement?.matches('input, textarea')) render();
});

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let reloading = false;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready', { label: 'Refresh', sticky: true, run: () => { reloading = true; w.postMessage('skipWaiting'); } });
        }
      });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
}

async function init() {
  try {
    const [meals, glucose, settings] = await Promise.all([db.getAll('meals'), db.getAll('glucose'), db.getKV('settings', null)]);
    state.meals = meals;
    state.glucose = glucose;
    state.settings = { ...DEFAULTS, ...(settings || {}) };
  } catch (err) {
    $view.replaceChildren(h('p', { class: 'error' }, `Storage unavailable: ${err.message}. Private browsing can block it.`));
    return;
  }
  changed();
  render();
  registerSW();
}

init();
