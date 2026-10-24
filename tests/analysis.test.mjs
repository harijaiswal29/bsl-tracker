import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyse, eatingEvents, mealKey, foodName, items, rankMeals, rankFoods, tagEffects, summarise, riseStatus,
} from '../js/analysis.js';

const MIN = 60_000;
const T0 = new Date(2026, 9, 24, 12, 0).getTime(); // 24 Oct 2026, 12:00 local

const meal = (id, offMin, text, tags = []) => ({ id, ts: T0 + offMin * MIN, text, tags });
const read = (offMin, mgdl, kind = 'cgm') => ({ id: `g${offMin}`, ts: T0 + offMin * MIN, mgdl, kind });

// CGM every 15 min: 100 before lunch, peaks 160 at +45, back to 110 by +150
const cgm = [[-30, 98], [-15, 100], [0, 102], [15, 120], [30, 145], [45, 160], [60, 150], [90, 130], [120, 115], [150, 110]].map(([o, v]) => read(o, v));

test('rise = peak in 2.5 h minus last reading at/before eating', () => {
  const { responses } = analyse([meal('a', 0, 'rice, dal')], cgm);
  const r = responses[0];
  assert.equal(r.baseline.mgdl, 102);
  assert.equal(r.peak.mgdl, 160);
  assert.equal(r.rise, 58);
  assert.equal(r.minutesToPeak, 45);
  assert.equal(r.status, 'spike');
  assert.equal(r.dense, true);
  assert.equal(r.overlapped, false);
});

test('fingerstick: before + 1h + 2h readings', () => {
  const readings = [read(-10, 105, 'manual'), read(60, 172, 'manual'), read(120, 138, 'manual')];
  const r = analyse([meal('a', 0, 'poha, chai')], readings).responses[0];
  assert.equal(r.rise, 67);
  assert.equal(r.dense, false);
});

test('a reading logged a few minutes after the meal time still counts as baseline', () => {
  const readings = [read(5, 100, 'manual'), read(120, 125, 'manual')];
  assert.equal(analyse([meal('a', 0, 'idli')], readings).responses[0].rise, 25);
});

test('missing baseline or post reading gives no rise', () => {
  assert.equal(analyse([meal('a', 0, 'x')], [read(90, 150, 'manual')]).responses[0].rise, null);
  assert.equal(analyse([meal('a', 0, 'x')], [read(-10, 100, 'manual')]).responses[0].rise, null);
  assert.equal(analyse([meal('a', 0, 'x')], []).responses[0].rise, null);
});

test('meals within 30 min are one eating event', () => {
  const events = eatingEvents([meal('b', 20, 'chai'), meal('a', 0, 'poha'), meal('c', 200, 'apple')]);
  assert.equal(events.length, 2);
  assert.equal(events[0].text, 'poha, chai');
  const { byMeal } = analyse([meal('a', 0, 'poha'), meal('b', 20, 'chai')], cgm);
  assert.equal(byMeal.get('a'), byMeal.get('b'));
});

test('eating again within 2 h marks the response as overlapped', () => {
  const { responses } = analyse([meal('a', 0, 'lunch'), meal('b', 90, 'biscuits')], cgm);
  assert.equal(responses[0].overlapped, true);
  assert.equal(responses[1].overlapped, false); // previous meal was 90 min earlier (> 1 h)
});

test('mealKey ignores order, case and separators', () => {
  assert.equal(mealKey('2 Rotis + Dal'), mealKey('dal, 2 rotis'));
  assert.equal(mealKey('Rice and rajma.'), 'rajma, rice');
  assert.deepEqual(items('dosa with chutney & sambar'), ['dosa', 'chutney', 'sambar']);
});

test('foodName strips portions and plurals', () => {
  assert.equal(foodName('2 rotis'), 'roti');
  assert.equal(foodName('small bowl of rice'), 'rice');
  assert.equal(foodName('1 glass milk'), 'milk');
  assert.equal(foodName('dal'), 'dal');
  assert.equal(foodName('hummus'), 'hummus');
});

test('rankings average repeat meals and skip overlapped ones', () => {
  const day = 24 * 60;
  const meals = [meal('a', 0, 'rice, dal'), meal('b', day, 'Dal + Rice'), meal('c', 2 * day, 'eggs')];
  const readings = [
    read(-5, 100), read(60, 160),               // +60
    read(day - 5, 100), read(day + 60, 140),     // +40
    read(2 * day - 5, 100), read(2 * day + 60, 110), // +10
  ];
  const { responses } = analyse(meals, readings);
  const ranked = rankMeals(responses);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].label, 'eggs');
  assert.equal(ranked[1].n, 2);
  assert.equal(ranked[1].avgRise, 50);
  assert.equal(ranked[1].label, 'Dal + Rice'); // latest wording
  const foods = rankFoods(responses);
  assert.deepEqual(foods.map((f) => f.key).sort(), ['dal', 'rice']);
});

test('tagEffects compares with vs without', () => {
  const day = 24 * 60;
  const meals = [0, 1, 2, 3].map((i) => meal(`m${i}`, i * day, 'rice', i < 2 ? ['walk'] : []));
  const readings = [0, 1, 2, 3].flatMap((i) => [read(i * day - 5, 100), read(i * day + 60, i < 2 ? 125 : 165)]);
  const [e] = tagEffects(analyse(meals, readings).responses, ['walk', 'meds']);
  assert.equal(e.tag, 'walk');
  assert.equal(e.withAvg, 25);
  assert.equal(e.withoutAvg, 65);
  assert.equal(e.diff, -40);
});

test('riseStatus thresholds', () => {
  assert.equal(riseStatus(null), null);
  assert.equal(riseStatus(-5), 'gentle');
  assert.equal(riseStatus(29), 'gentle');
  assert.equal(riseStatus(30), 'moderate');
  assert.equal(riseStatus(50), 'spike');
});

test('summarise: time in range needs CGM density', () => {
  const day = Array.from({ length: 96 }, (_, i) => read(i * 15, i < 72 ? 120 : 200));
  const s = summarise(day, T0, T0 + 24 * 60 * MIN, 70, 180);
  assert.equal(s.n, 96);
  assert.equal(s.tir, 0.75);
  assert.equal(s.above, 0.25);
  const sparse = summarise([read(0, 100, 'manual'), read(60, 150, 'manual')], T0, T0 + 120 * MIN, 70, 180);
  assert.equal(sparse.tir, null);
  assert.equal(sparse.mean, 125);
});
