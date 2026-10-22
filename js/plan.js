/**
 * Разбор и нормализация плана помещения.
 * Вход: JSON (единицы "mm" или "m"), выход: нормализованная модель в метрах,
 * готовая и для валидатора (rules.js), и для построения сцены (build.js).
 */

import * as G from './geometry.js';

/** Правила дизайна по умолчанию (в метрах). */
export const DEFAULT_RULES = {
  minWallClearance: 0.05, // зазор до стены: либо 0 (встроенный), либо >= значения
  doorClearance: 0.9, // свободная зона перед дверью
  flushTolerance: 0.01, // допуск «примыкает к стене»
  builtInGapTolerance: 0.1, // допуск отхода для помеченного встроенного объекта
};

const OPENING_KINDS = ['door', 'window', 'passage'];

function requireNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Поле "${path}" должно быть числом`);
  }
  return value;
}

function toPoint(raw, path) {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error(`Поле "${path}" должно быть массивом [x, y]`);
  }
  return { x: requireNumber(raw[0], `${path}[0]`), y: requireNumber(raw[1], `${path}[1]`) };
}

function toScale(units) {
  if (units === 'mm' || units === undefined) return 0.001;
  if (units === 'm') return 1;
  throw new Error('Поле "units" должно быть "mm" или "m"');
}

/** Число из JSON с приведением к метрам. */
function scaledNumber(value, path, k, fallback) {
  const source = value === undefined ? fallback : value;
  if (source === undefined) throw new Error(`Поле "${path}" обязательно`);
  return requireNumber(source, path) * k;
}

/** raw уже в метрах (масштабирование выполнено в parsePlan). */
function parseOpening(raw, wall, index) {
  const path = `walls["${wall.id}"].openings[${index}]`;
  const offset = raw.offset;
  const width = raw.width;
  const height = raw.height;
  const kind = raw.kind || 'window';
  if (!OPENING_KINDS.includes(kind)) {
    throw new Error(`${path}.kind: ожидается одно из ${OPENING_KINDS.join(', ')}`);
  }
  const sill = raw.sill !== undefined ? raw.sill : kind === 'door' || kind === 'passage' ? 0 : 0.9;

  if (width <= 0 || height <= 0) throw new Error(`${path}: ширина и высота должны быть > 0`);
  if (offset < 0) throw new Error(`${path}.offset: не может быть отрицательным`);
  if (offset + width > wall.length + 1e-6) {
    throw new Error(
      `${path}: проём выходит за стену (offset + width = ${G.round(offset + width, 3)} м > длина стены ${G.round(wall.length, 3)} м)`,
    );
  }
  if (sill + height > wall.height + 1e-6) {
    throw new Error(
      `${path}: проём выше стены (sill + height = ${G.round(sill + height, 3)} м > высота стены ${G.round(wall.height, 3)} м)`,
    );
  }

  const from = offset;
  const to = offset + width;
  return {
    id: raw.id || `${wall.id}-opening-${index + 1}`,
    kind,
    from,
    to,
    width,
    height,
    sill,
    top: sill + height,
    checkClearance: raw.checkClearance !== false,
  };
}

/**
 * Главная функция разбора: JSON -> нормализованный план в метрах.
 * Бросает Error с понятным текстом на любые неконсистентные данные —
 * это первая линия «вычислительной логики», которая защищает генератор.
 */
export function parsePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('План должен быть объектом JSON');
  }
  const k = toScale(raw.units);
  const wallDefs = raw.walls;
  if (!Array.isArray(wallDefs) || wallDefs.length < 3) {
    throw new Error('Поле "walls": нужен замкнутый контур минимум из 3 стен');
  }

  const walls = wallDefs.map((w, i) => parseWall(w, i, k, 'walls'));
  const lastWall = walls[walls.length - 1];
  const gap = G.dist(lastWall.end, walls[0].start);
  if (gap > 0.001) {
    throw new Error(
      `Контур стен не замкнут: разрыв ${G.round(gap, 3)} м между концом "${lastWall.id}" и началом "${walls[0].id}"`,
    );
  }

  const partitions = (raw.partitions || []).map((p, i) => parseWall(p, i, k, 'partitions'));

  const axisPolygon = walls.map((w) => w.start);
  const roomPolygon = G.insetPolygonVar(axisPolygon, walls.map((w) => w.thickness / 2));
  const floorArea = Math.abs(G.polygonArea(roomPolygon));
  if (floorArea <= 0.1) {
    throw new Error('Стены слишком толстые для заданного контура: внутренняя площадь <= 0.1 м²');
  }

  const furniture = (raw.furniture || []).map((f, i) => parseFurniture(f, i, k));

  const rulesRaw = raw.rules || {};
  const rules = {
    minWallClearance: scaledNumber(
      rulesRaw.minWallClearance,
      'rules.minWallClearance',
      k,
      DEFAULT_RULES.minWallClearance / k,
    ),
    doorClearance: scaledNumber(rulesRaw.doorClearance, 'rules.doorClearance', k, DEFAULT_RULES.doorClearance / k),
    flushTolerance: scaledNumber(rulesRaw.flushTolerance, 'rules.flushTolerance', k, DEFAULT_RULES.flushTolerance / k),
    builtInGapTolerance: scaledNumber(
      rulesRaw.builtInGapTolerance,
      'rules.builtInGapTolerance',
      k,
      DEFAULT_RULES.builtInGapTolerance / k,
    ),
  };

  const plan = {
    name: raw.name || 'План без названия',
    units: raw.units || 'mm',
    walls,
    partitions,
    furniture,
    room: {
      axisPolygon,
      polygon: roomPolygon,
      area: floorArea,
      perimeter: G.polygonPerimeter(roomPolygon),
    },
    rules,
  };
  plan.metrics = computeMetrics(plan);
  return plan;
}
/** Разбор стены или перегородки (единый формат описания). */
function parseWall(def, index, k, field) {
  const path = `${field}[${index}]`;
  const id = def.id || `${field === 'walls' ? 'wall' : 'partition'}-${index + 1}`;
  const start = G.scale(toPoint(def.start, `${path}.start`), k);
  const end = G.scale(toPoint(def.end, `${path}.end`), k);
  const length = G.dist(start, end);
  if (length <= 1e-6) throw new Error(`${path} ("${id}"): нулевая длина`);
  const dir = G.norm(G.sub(end, start));
  const wall = {
    id,
    kind: field === 'walls' ? 'perimeter' : 'partition',
    start,
    end,
    dir,
    length,
    thickness: scaledNumber(def.thickness, `${path}.thickness`, k, field === 'walls' ? 150 : 100),
    height: scaledNumber(def.height, `${path}.height`, k, 2700),
    normal: G.perp(dir),
  };
  wall.openings = (def.openings || []).map((o, j) =>
    parseOpening(
      {
        id: o.id,
        kind: o.kind,
        offset: scaledNumber(o.offset, `${path}.openings[${j}].offset`, k),
        width: scaledNumber(o.width, `${path}.openings[${j}].width`, k),
        height: scaledNumber(o.height, `${path}.openings[${j}].height`, k),
        sill: o.sill === undefined ? undefined : scaledNumber(o.sill, `${path}.openings[${j}].sill`, k),
        checkClearance: o.checkClearance,
      },
      wall,
      j,
    ),
  );
  return wall;
}

/** Разбор единицы мебели: центр footprint, габариты, угол поворота. */
function parseFurniture(def, index, k) {
  const path = `furniture[${index}]`;
  const id = def.id || `${def.type || 'item'}-${index + 1}`;
  const pos = G.scale(toPoint(def.pos, `${path}.pos`), k);
  const width = scaledNumber(def.w, `${path}.w`, k);
  const depth = scaledNumber(def.d, `${path}.d`, k);
  const height = scaledNumber(def.h, `${path}.h`, k, 750);
  if (width <= 0 || depth <= 0) throw new Error(`${path} ("${id}"): габариты должны быть > 0`);
  const rot = (((def.rotation || 0) % 360) * Math.PI) / 180;
  const rect = G.obb(pos, width, depth, rot);
  const corners = G.polygonFromOBB(rect);
  return {
    id,
    type: def.type || 'box',
    rect,
    width,
    depth,
    height,
    againstWall: def.againstWall === true,
    corners,
    aabb: G.aabbFromPoints(corners),
  };
}

/**
 * Метрики плана: то, что уходит в спецификацию/смету.
 * Считается из геометрии, а не задаётся руками — это и есть связка
 * «данные -> модель -> числа».
 */
export function computeMetrics(plan) {
  const allWalls = [...plan.walls, ...plan.partitions];
  let wallAreaGross = 0;
  let openingsArea = 0;
  let openingCount = 0;
  let wallLength = 0;

  for (const wall of allWalls) {
    wallAreaGross += wall.length * wall.height;
    wallLength += wall.length;
    for (const op of wall.openings) {
      openingsArea += op.width * op.height;
      openingCount += 1;
    }
  }

  const floorArea = Math.abs(G.polygonArea(plan.room.polygon));
  const furnitureArea = plan.furniture.reduce((sum, f) => sum + f.width * f.depth, 0);
  const height = plan.walls[0] ? plan.walls[0].height : 2.7;

  return {
    floorArea: G.round(floorArea),
    ceilingArea: G.round(floorArea),
    volume: G.round(floorArea * height),
    perimeter: G.round(G.polygonPerimeter(plan.room.polygon)),
    wallLength: G.round(wallLength),
    wallAreaGross: G.round(wallAreaGross),
    openingsArea: G.round(openingsArea),
    wallAreaNet: G.round(wallAreaGross - openingsArea),
    openingCount,
    furnitureCount: plan.furniture.length,
    furnitureArea: G.round(furnitureArea),
    occupancy: G.round(floorArea > 0 ? furnitureArea / floorArea : 0, 4),
    freeArea: G.round(floorArea - furnitureArea),
    ceilingHeight: G.round(height),
  };
}


