/**
 * Тесты чистой логики генератора (без three.js, без браузера).
 * Запуск: npm test  (или node tests/run.mjs)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as G from '../js/geometry.js';
import { parsePlan, DEFAULT_RULES } from '../js/plan.js';
import { validatePlan } from '../js/rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const loadPlan = (file) => JSON.parse(fs.readFileSync(path.join(root, 'plans', file), 'utf8'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: получено ${actual}, ожидалось ${expected} (±${tolerance})`,
  );
}

console.log('\n[1] Геометрия');

test('площадь полигона считается со знаком (CCW > 0)', () => {
  const square = [G.v(0, 0), G.v(4, 0), G.v(4, 4), G.v(0, 4)];
  near(G.polygonArea(square), 16, 1e-9, 'площадь CCW');
  near(G.polygonArea([...square].reverse()), -16, 1e-9, 'площадь CW');
  assert.equal(G.ensureCCW([...square].reverse())[0].x, 0);
});

test('insetPolygon сдвигает контур внутрь на заданный отступ', () => {
  const square = [G.v(0, 0), G.v(4, 0), G.v(4, 4), G.v(0, 4)];
  const inner = G.insetPolygon(square, 0.1);
  near(G.polygonArea(inner), 3.8 * 3.8, 1e-9, 'площадь внутреннего контура');
  near(inner[0].x, 0.1, 1e-9, 'вершина x');
  near(inner[0].y, 0.1, 1e-9, 'вершина y');
});

test('insetPolygonVar поддерживает разную толщину стен', () => {
  const rect = [G.v(0, 0), G.v(10, 0), G.v(10, 6), G.v(0, 6)];
  const inner = G.insetPolygonVar(rect, [0.15, 0.2, 0.15, 0.2]);
  near(G.aabbWidth(G.aabbFromPoints(inner)), 10 - 0.2 - 0.2, 1e-9, 'ширина');
  near(G.aabbHeight(G.aabbFromPoints(inner)), 6 - 0.15 - 0.15, 1e-9, 'высота');
});

test('SAT: разнесённые и пересекающиеся прямоугольники', () => {
  const a = G.obb(G.v(0, 0), 1, 1, 0);
  assert.equal(G.satOverlapOBB(a, G.obb(G.v(2, 0), 1, 1, 0)).overlap, false);
  const touching = G.satOverlapOBB(a, G.obb(G.v(1, 0), 1, 1, 0));
  assert.equal(touching.overlap, false, 'касание не считается пересечением');
  const inside = G.satOverlapOBB(a, G.obb(G.v(0.5, 0), 1, 1, 0));
  assert.equal(inside.overlap, true);
  near(inside.depth, 0.5, 1e-9, 'глубина проникновения');
});

test('SAT: повёрнутый прямоугольник у границы пересечения', () => {
  const a = G.obb(G.v(0, 0), 1, 1, 0);
  const b = G.obb(G.v(0.8, 0.8), 1, 1, Math.PI / 4);
  assert.equal(G.satOverlapOBB(a, b).overlap, true);
  const far = G.obb(G.v(1.5, 1.5), 1, 1, Math.PI / 4);
  assert.equal(G.satOverlapOBB(a, far).overlap, false);
});

test('distancePointToSegment и точка внутри полигона', () => {
  near(G.distancePointToSegment(G.v(0, 2), G.v(-5, 0), G.v(5, 0)), 2, 1e-9, 'расстояние до отрезка');
  const square = [G.v(0, 0), G.v(2, 0), G.v(2, 2), G.v(0, 2)];
  assert.equal(G.pointInPolygon(G.v(1, 1), square), true);
  assert.equal(G.pointInPolygon(G.v(3, 1), square), false);
});


console.log('\n[2] Разбор плана и метрики');

test('demo_1room: метрики считаются из геометрии', () => {
  const plan = parsePlan(loadPlan('demo_1room.json'));
  near(plan.metrics.floorArea, 4.05 * 3.45, 1e-3, 'площадь пола');
  near(plan.metrics.perimeter, 15, 1e-3, 'периметр');
  near(plan.metrics.wallAreaGross, 15.6 * 2.7, 1e-3, 'площадь стен без вычета проёмов');
  near(plan.metrics.openingsArea, 0.9 * 2.1 + 1.8 * 1.5, 1e-3, 'площадь проёмов');
  near(plan.metrics.wallAreaNet, plan.metrics.wallAreaGross - plan.metrics.openingsArea, 1e-3, 'площадь стен нетто');
  assert.equal(plan.metrics.openingCount, 2);
  assert.equal(plan.metrics.furnitureCount, 6);
  assert.ok(plan.metrics.occupancy > 0.3 && plan.metrics.occupancy < 0.6, 'коэффициент занятости в разумных пределах');
});

test('demo_2rooms: перегородка учитывается в метриках', () => {
  const plan = parsePlan(loadPlan('demo_2rooms.json'));
  assert.equal(plan.partitions.length, 1);
  near(plan.metrics.floorArea, 5.85 * 3.85, 1e-3, 'площадь пола');
  near(plan.metrics.wallLength, 20 + 4, 1e-3, 'длина всех стен и перегородок');
});

test('единицы измерения "m" поддерживаются', () => {
  const plan = parsePlan({
    units: 'm',
    walls: [
      { start: [0, 0], end: [4, 0], thickness: 0.15 },
      { start: [4, 0], end: [4, 3], thickness: 0.15 },
      { start: [4, 3], end: [0, 3], thickness: 0.15 },
      { start: [0, 3], end: [0, 0], thickness: 0.15 },
    ],
    furniture: [],
  });
  near(plan.metrics.floorArea, 3.85 * 2.85, 1e-3, 'площадь пола в метрах');
  assert.deepEqual(plan.rules, DEFAULT_RULES);
});

console.log('\n[3] Валидация входных данных (ошибки должны быть понятными)');

function expectError(fn, pattern, label) {
  let message = '';
  try {
    fn();
  } catch (error) {
    message = error.message;
  }
  assert.ok(message, `${label}: ожидалась ошибка, но её не было`);
  assert.match(message, pattern, `${label}: текст ошибки "${message}"`);
}

test('незамкнутый контур стен отклоняется', () => {
  expectError(
    () =>
      parsePlan({
        units: 'mm',
        walls: [
          { start: [0, 0], end: [4000, 0] },
          { start: [4000, 0], end: [4000, 3000] },
          { start: [4000, 3000], end: [0, 3000] },
        ],
      }),
    /не замкнут/,
    'разрыв контура',
  );
});

test('проём за пределами стены отклоняется', () => {
  const plan = loadPlan('demo_1room.json');
  plan.walls[0].openings[0].offset = 3800;
  expectError(() => parsePlan(plan), /выходит за стену/, 'проём за стеной');
});

test('проём выше стены отклоняется', () => {
  const plan = loadPlan('demo_1room.json');
  plan.walls[0].openings[0].height = 3000;
  expectError(() => parsePlan(plan), /выше стены/, 'проём выше стены');
});

test('некорректные единицы измерения отклоняются', () => {
  const plan = loadPlan('demo_1room.json');
  plan.units = 'cm';
  expectError(() => parsePlan(plan), /units/, 'единицы');
});

test('меньше трёх стен в контуре отклоняется', () => {
  expectError(
    () => parsePlan({ units: 'mm', walls: [{ start: [0, 0], end: [1, 0] }] }),
    /минимум из 3 стен/,
    'две стены',
  );
});


console.log('\n[4] Правила дизайна');

const planA = parsePlan(loadPlan('demo_1room.json'));
const planB = parsePlan(loadPlan('demo_2rooms.json'));
const reportA = validatePlan(planA);
const reportB = validatePlan(planB);

test('demo_1room проходит все проверки без нарушений', () => {
  assert.equal(
    reportA.violations.length,
    0,
    `неожиданные нарушения: ${reportA.violations.map((x) => x.code).join(', ')}`,
  );
  assert.equal(reportA.stats.status, 'ok');
  assert.ok(reportA.stats.checksRun > 30, 'количество выполненных проверок');
});

test('demo_2rooms: находятся нарушения каждого типа', () => {
  const codes = new Set(reportB.violations.map((x) => x.code));
  for (const expected of [
    'FURNITURE_OUT_OF_ROOM',
    'FURNITURE_OVERLAP',
    'FURNITURE_OVERLAP_WALL',
    'OPENING_BLOCKED',
    'WALL_CLEARANCE',
    'DOOR_CLEARANCE',
  ]) {
    assert.ok(codes.has(expected), `не найдено нарушение ${expected} (найдено: ${[...codes].join(', ')})`);
  }
  assert.equal(reportB.stats.status, 'error');
});

test('нарушения содержат понятное сообщение и объект-виновник', () => {
  const overlap = reportB.violations.find((x) => x.code === 'FURNITURE_OVERLAP');
  assert.match(overlap.message, /пересекаются/);
  assert.ok(overlap.targetId, 'у нарушения указан объект');
  const outside = reportB.violations.find((x) => x.code === 'FURNITURE_OUT_OF_ROOM');
  assert.equal(outside.targetId, 'desk');
});

test('порог minWallClearance влияет на результат проверки', () => {
  const strict = parsePlan({
    ...loadPlan('demo_1room.json'),
    rules: { minWallClearance: 2000 },
  });
  const report = validatePlan(strict);
  assert.ok(
    report.violations.some((x) => x.code === 'WALL_CLEARANCE'),
    'при завышенном пороге появляются предупреждения о зазоре',
  );
});

test('занятая зона перед дверью определяется как нарушение', () => {
  const blocked = parsePlan({
    units: 'm',
    walls: [
      {
        start: [0, 0],
        end: [4, 0],
        thickness: 0.15,
        openings: [{ kind: 'door', offset: 1, width: 0.9, height: 2.1, sill: 0 }],
      },
      { start: [4, 0], end: [4, 3], thickness: 0.15 },
      { start: [4, 3], end: [0, 3], thickness: 0.15 },
      { start: [0, 3], end: [0, 0], thickness: 0.15 },
    ],
    furniture: [{ id: 'box', pos: [1.45, 0.5], w: 0.8, d: 0.8, h: 0.5 }],
  });
  const report = validatePlan(blocked);
  assert.ok(
    report.violations.some((x) => x.code === 'DOOR_CLEARANCE'),
    `ожидалось DOOR_CLEARANCE, получено: ${report.violations.map((x) => x.code).join(', ')}`,
  );
});


console.log('\n[5] Отчёт по демо-планам');

for (const [plan, report] of [
  [planA, reportA],
  [planB, reportB],
]) {
  console.log(`\n  ${plan.name}`);
  console.log(
    `    пол ${plan.metrics.floorArea} м2 | стены нетто ${plan.metrics.wallAreaNet} м2 | проёмов ${plan.metrics.openingCount} | мебель ${plan.metrics.furnitureCount} (занято ${Math.round(plan.metrics.occupancy * 100)}%)`,
  );
  console.log(
    `    проверок: ${report.stats.checksRun}, ошибок: ${report.stats.errors}, предупреждений: ${report.stats.warnings}`,
  );
  for (const item of report.violations) {
    const mark = item.severity === 'error' ? 'x' : '!';
    console.log(`    ${mark} [${item.code}] ${item.message}`);
  }
}

console.log(`\nИтог: ${passed} тестов пройдено, ${failures.length} упало`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`  - ${failure.name}: ${failure.error.message}`);
  }
  process.exit(1);
}
