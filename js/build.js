/**
 * Построение 3D-сцены из нормализованного плана.
 * Геометрия строится по правилам, а не задаётся руками:
 * стены — панели, вырезанные по проёмам, мебель — параметрические блоки.
 */

import * as THREE from 'three';

export const COLORS = {
  floor: 0xd8d1c4,
  wall: 0xf3f0ea,
  partition: 0xe9e4db,
  glass: 0x9ec7e8,
  furniture: 0x8f9aa6,
  violation: 0xe0554d,
  marker: 0xff3b30,
};

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...extra });
}

/** Цвета по типам мебели: сцена читается лучше, чем однотонные серые блоки. */
const FURNITURE_COLORS = {
  sofa: 0x7c8794,
  table: 0xb08d57,
  chair: 0x8a8f96,
  bed: 0x9aa7b4,
  wardrobe: 0x9c8a6e,
  box: 0x8f9aa6,
};

export function createMaterials() {
  const furnitureByType = {};
  for (const [type, color] of Object.entries(FURNITURE_COLORS)) {
    furnitureByType[type] = standard(color);
  }
  return {
    floor: standard(COLORS.floor, { roughness: 0.95 }),
    wall: standard(COLORS.wall),
    partition: standard(COLORS.partition),
    glass: new THREE.MeshPhysicalMaterial({
      color: COLORS.glass,
      transparent: true,
      opacity: 0.35,
      roughness: 0.1,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    furniture: standard(COLORS.furniture),
    furnitureByType,
    violation: standard(COLORS.violation, { emissive: 0x330000 }),
    marker: new THREE.MeshBasicMaterial({ color: COLORS.marker }),
    wireframe: new THREE.MeshBasicMaterial({ color: 0x1f2933, wireframe: true }),
  };
}

/** Точка плана -> мировая точка three.js: (x, y) -> (x, height, -y). */
export function toWorld(point, height = 0) {
  return new THREE.Vector3(point.x, height, -point.y);
}

/**
 * Матрица стены: локальные оси X (вдоль стены), Y (вверх), Z (нормаль).
 * Правая тройка: X x Y = Z, поэтому геометрия не выворачивается наизнанку.
 */
export function wallMatrix(wall) {
  const dir = wall.dir;
  const xAxis = new THREE.Vector3(dir.x, 0, -dir.y);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(dir.y, 0, dir.x);
  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(wall.start.x, 0, -wall.start.y);
}

/**
 * Разбиение стены на панели с учётом проёмов.
 * Простой и надёжный путь вместо булевых операций CSG:
 * стена = набор прямоугольников (сплошные участки + перемычки над/под проёмами).
 */
export function wallPanels(wall) {
  const openings = [...wall.openings].sort((a, b) => a.from - b.from);
  const panels = [];
  let cursor = 0;
  for (const op of openings) {
    if (op.from > cursor + 1e-6) panels.push({ x0: cursor, x1: op.from, y0: 0, y1: wall.height });
    if (op.sill > 1e-6) panels.push({ x0: op.from, x1: op.to, y0: 0, y1: op.sill });
    if (op.top < wall.height - 1e-6) panels.push({ x0: op.from, x1: op.to, y0: op.top, y1: wall.height });
    cursor = op.to;
  }
  if (cursor < wall.length - 1e-6) panels.push({ x0: cursor, x1: wall.length, y0: 0, y1: wall.height });
  return panels;
}


/** Стена целиком: панели по проёмам + стекло в окнах. */
export function buildWall(wall, materials) {
  const group = new THREE.Group();
  group.name = `${wall.kind}:${wall.id}`;
  group.matrixAutoUpdate = false;
  group.matrix.copy(wallMatrix(wall));
  const material = wall.kind === 'partition' ? materials.partition : materials.wall;

  for (const panel of wallPanels(wall)) {
    const geometry = new THREE.BoxGeometry(panel.x1 - panel.x0, panel.y1 - panel.y0, wall.thickness);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((panel.x0 + panel.x1) / 2, (panel.y0 + panel.y1) / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  for (const op of wall.openings) {
    if (op.kind !== 'window') continue;
    const glassThickness = Math.min(0.04, wall.thickness * 0.3);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(op.width, op.height, glassThickness), materials.glass);
    glass.position.set((op.from + op.to) / 2, (op.sill + op.top) / 2, 0);
    group.add(glass);
  }
  return group;
}

/** Пол или потолок по внутреннему контуру помещения. */
export function buildSlab(polygon, y, materials, { ceiling = false } = {}) {
  const shape = new THREE.Shape(polygon.map((p) => new THREE.Vector2(p.x, p.y)));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), materials.floor);
  mesh.rotation.x = ceiling ? Math.PI / 2 : -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = !ceiling;
  mesh.name = ceiling ? 'ceiling' : 'floor';
  return mesh;
}


/**
 * Параметрическая мебель: набор блоков по типу объекта.
 * Локальные оси объекта: X — ширина (w), Z — глубина (d), Y — высота.
 * Спинка/фасад всегда с одной стороны (Z+), поэтому rotation в плане
 * поворачивает объект целиком, как реальный предмет.
 */
export function furnitureParts(f) {
  const w = f.width;
  const d = f.depth;
  const h = f.height;
  const t = 0.05;

  switch (f.type) {
    case 'sofa': {
      const seat = h * 0.45;
      const back = h - seat;
      const arm = w * 0.1;
      return [
        { size: [w, seat, d], pos: [0, seat / 2, 0] },
        { size: [w - arm * 2, back, d * 0.25], pos: [0, seat + back / 2, d / 2 - d * 0.125] },
        { size: [arm, h * 0.75, d], pos: [-(w / 2 - arm / 2), h * 0.375, 0] },
        { size: [arm, h * 0.75, d], pos: [w / 2 - arm / 2, h * 0.375, 0] },
      ];
    }
    case 'table': {
      const top = t * 1.5;
      const leg = t;
      const parts = [{ size: [w, top, d], pos: [0, h - top / 2, 0] }];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          parts.push({
            size: [leg, h - top, leg],
            pos: [sx * (w / 2 - leg), (h - top) / 2, sz * (d / 2 - leg)],
          });
        }
      }
      return parts;
    }
    case 'chair': {
      const seat = h * 0.5;
      return [
        { size: [w, t * 1.5, d], pos: [0, seat, 0] },
        { size: [w, h - seat, t * 1.5], pos: [0, seat + (h - seat) / 2, -(d / 2 - t)] },
      ];
    }
    case 'bed': {
      const base = h * 0.35;
      return [
        { size: [w, base, d], pos: [0, base / 2, 0] },
        { size: [w, h - base, d * 0.92], pos: [0, base + (h - base) / 2, d * 0.04] },
        { size: [w, h * 0.75, 0.06], pos: [0, h * 0.375, -(d / 2 - 0.03)] },
      ];
    }
    case 'wardrobe': {
      return [
        { size: [w, h, d], pos: [0, h / 2, 0] },
        { size: [0.02, h * 0.9, 0.02], pos: [0, h / 2, -(d / 2 + 0.01)] },
      ];
    }
    default:
      return [{ size: [w, h, d], pos: [0, h / 2, 0] }];
  }
}

/** Единица мебели. violated=true — объект подсвечивается как нарушитель. */
export function buildFurniture(f, materials, violated = false) {
  const group = new THREE.Group();
  group.name = `furniture:${f.id}`;
  group.position.copy(toWorld(f.rect.c));
  group.rotation.y = f.rect.rot;
  group.userData.furnitureId = f.id;
  const material = violated
    ? materials.violation
    : materials.furnitureByType[f.type] || materials.furniture;
  for (const part of furnitureParts(f)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...part.size), material);
    mesh.position.set(...part.pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Маркеры нарушений на полу — чтобы проблема была видна в 3D, а не только в списке. */
export function buildViolationMarkers(violations, materials) {
  const group = new THREE.Group();
  group.name = 'violations';
  for (const item of violations) {
    if (!item.point) continue;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 24), materials.marker);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(toWorld(item.point, 0.02));
    ring.userData.violation = item;
    group.add(ring);
  }
  return group;
}


/**
 * Полная сцена по плану: пол, стены, перегородки, мебель, маркеры нарушений.
 * byId нужен интерфейсу, чтобы фокусировать камеру на объекте-нарушителе.
 */
export function buildScene(plan, report, options = {}) {
  const materials = createMaterials();
  const root = new THREE.Group();
  root.name = 'plan';
  const byId = new Map();
  const violated = new Set(report ? report.violations.map((v) => v.targetId) : []);

  const floor = buildSlab(plan.room.polygon, 0, materials);
  root.add(floor);
  byId.set('floor', floor);

  if (options.ceiling) {
    root.add(buildSlab(plan.room.polygon, plan.metrics.ceilingHeight, materials, { ceiling: true }));
  }

  for (const wall of [...plan.walls, ...plan.partitions]) {
    root.add(buildWall(wall, materials));
  }

  for (const f of plan.furniture) {
    const mesh = buildFurniture(f, materials, violated.has(f.id));
    root.add(mesh);
    byId.set(f.id, mesh);
  }

  const markers = buildViolationMarkers(report ? report.violations : [], materials);
  root.add(markers);

  return { root, byId, markers, materials };
}
