/**
 * Чистая 2D-геометрия для генератора планировок.
 * Никаких зависимостей от three.js — модуль покрыт тестами в tests/run.mjs.
 *
 * Система координат плана: X вправо, Y вверх (миллиметры в исходных данных,
 * после parsePlan всё переводится в метры). Мировая сцена three.js строится
 * преобразованием (x, y) -> (x, height, -y).
 */

export const EPS = 1e-6;

export function v(x, y) {
  return { x, y };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a, k) {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

export function len(a) {
  return Math.hypot(a.x, a.y);
}

export function dist(a, b) {
  return len(sub(a, b));
}

export function norm(a) {
  const l = len(a);
  if (l < EPS) throw new Error('Нулевая длина вектора');
  return { x: a.x / l, y: a.y / l };
}

/** Поворот вектора на +90° (для CCW-полигона даёт внутреннюю нормаль ребра). */
export function perp(a) {
  return { x: -a.y, y: a.x };
}

export function rotate(p, angleRad) {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Знаковая площадь (shoelace). > 0 — обход против часовой стрелки. */
export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += cross(a, b);
  }
  return s / 2;
}

export function polygonPerimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    p += dist(poly[i], poly[(i + 1) % poly.length]);
  }
  return p;
}

export function ensureCCW(poly) {
  return polygonArea(poly) < 0 ? [...poly].reverse() : poly;
}

export function lineIntersection(p1, p2, p3, p4) {
  const r = sub(p2, p1);
  const s = sub(p4, p3);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(p3, p1), s) / denom;
  return add(p1, scale(r, t));
}

/**
 * Смещение полигона внутрь на d (одно значение для всех рёбер).
 */
export function insetPolygon(poly, d) {
  return insetPolygonVar(poly, poly.map(() => d));
}

/**
 * Смещение полигона внутрь с индивидуальным отступом на каждое ребро:
 * offsets[i] — отступ для ребра poly[i] -> poly[i+1].
 * Вершина i — пересечение смещённых прямых рёбер (i-1) и (i).
 * Корректно для выпуклых и ортогональных контуров (все демо-планы такие).
 */
export function insetPolygonVar(poly, offsets) {
  const p = ensureCCW(poly);
  const n = p.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = p[(i - 1 + n) % n];
    const cur = p[i];
    const next = p[(i + 1) % n];
    const dPrev = offsets[(i - 1 + n) % n];
    const dCur = offsets[i];

    const dirPrev = norm(sub(cur, prev));
    const dirCur = norm(sub(next, cur));
    const nPrev = perp(dirPrev); // внутренняя сторона для CCW-обхода
    const nCur = perp(dirCur);

    const a1 = add(prev, scale(nPrev, dPrev));
    const a2 = add(cur, scale(nPrev, dPrev));
    const b1 = add(cur, scale(nCur, dCur));
    const b2 = add(next, scale(nCur, dCur));

    const ip = lineIntersection(a1, a2, b1, b2);
    out.push(ip || add(cur, scale(nCur, dCur)));
  }
  return out;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distancePointToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return dist(p, a);
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, scale(ab, t)));
}

export function distancePointToPolygonEdges(p, poly) {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = distancePointToSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (d < min) min = d;
  }
  return min;
}

/** Ориентированный прямоугольник (OBB) в 2D: центр, размеры по локальным осям, угол в радианах. */
export function obb(c, w, d, rot) {
  return { c, w, d, rot };
}

export function obbAxes(o) {
  const u = { x: Math.cos(o.rot), y: Math.sin(o.rot) };
  return [u, { x: -u.y, y: u.x }];
}

export function polygonFromOBB(o) {
  const [u, v] = obbAxes(o);
  const hw = o.w / 2;
  const hd = o.d / 2;
  return [
    add(o.c, add(scale(u, hw), scale(v, hd))),
    add(o.c, add(scale(u, -hw), scale(v, hd))),
    add(o.c, add(scale(u, -hw), scale(v, -hd))),
    add(o.c, add(scale(u, hw), scale(v, -hd))),
  ];
}

export function obbFromSegment(a, b, thickness) {
  const dir = norm(sub(b, a));
  return obb(scale(add(a, b), 0.5), dist(a, b), thickness, Math.atan2(dir.y, dir.x));
}

export function aabbFromPoints(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

export function aabbOverlap(a, b) {
  return !(
    a.max.x <= b.min.x ||
    b.max.x <= a.min.x ||
    a.max.y <= b.min.y ||
    b.max.y <= a.min.y
  );
}

export function aabbWidth(a) {
  return a.max.x - a.min.x;
}

export function aabbHeight(a) {
  return a.max.y - a.min.y;
}

/**
 * Пересечение двух OBB через теорему о разделяющей оси (SAT).
 * Возвращает { overlap, depth } — depth это минимальная глубина проникновения.
 * Касание (depth <= tolerance) пересечением не считается.
 */
export function satOverlapOBB(a, b, tolerance = 1e-3) {
  const axesA = obbAxes(a);
  const axesB = obbAxes(b);
  const delta = sub(b.c, a.c);
  let minDepth = Infinity;
  for (const axis of [...axesA, ...axesB]) {
    const ra =
      Math.abs(dot(axis, axesA[0])) * (a.w / 2) +
      Math.abs(dot(axis, axesA[1])) * (a.d / 2);
    const rb =
      Math.abs(dot(axis, axesB[0])) * (b.w / 2) +
      Math.abs(dot(axis, axesB[1])) * (b.d / 2);
    const d = Math.abs(dot(axis, delta));
    const overlapOnAxis = ra + rb - d;
    if (overlapOnAxis <= tolerance) return { overlap: false, depth: 0 };
    if (overlapOnAxis < minDepth) minDepth = overlapOnAxis;
  }
  return { overlap: true, depth: minDepth };
}

export function round(value, digits = 3) {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

