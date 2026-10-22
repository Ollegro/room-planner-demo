/**
 * Валидатор планировки: превращает «правила дизайна» в проверяемые условия.
 * Работает только на нормализованном плане из plan.js (в метрах).
 */

import * as G from './geometry.js';

const mm = (value) => `${Math.round(value * 1000)} мм`;

/** Центр проёма в координатах плана. */
function openingCenter(wall, op) {
  const t = (op.from + op.to) / 2;
  return G.add(wall.start, G.scale(wall.dir, t));
}

/** OBB проёма: длина = ширина проёма, глубина = толщина стены. */
function openingBox(wall, op) {
  return G.obb(openingCenter(wall, op), op.width, wall.thickness, Math.atan2(wall.dir.y, wall.dir.x));
}

/** Минимальный зазор от footprint объекта до внутренних поверхностей стен. */
function wallClearance(furniture, roomPolygon) {
  let min = Infinity;
  for (const corner of furniture.corners) {
    min = Math.min(min, G.distancePointToPolygonEdges(corner, roomPolygon));
  }
  return min;
}

/**
 * Свободные зоны перед дверью (по одну и другую сторону стены).
 * Зона берётся только с той стороны, где действительно помещение.
 */
function doorClearanceZones(plan, wall, op, depth) {
  const center = openingCenter(wall, op);
  const zones = [];
  for (const side of [wall.normal, G.scale(wall.normal, -1)]) {
    const probe = G.add(center, G.scale(side, depth / 2));
    if (!G.pointInPolygon(probe, plan.room.polygon)) continue;
    zones.push({
      side,
      box: G.obb(probe, depth, op.width, Math.atan2(side.y, side.x)),
    });
  }
  return zones;
}

/**
 * Полная проверка плана.
 * Возвращает { violations, stats } — список нарушений и агрегаты.
 */
export function validatePlan(plan) {
  const violations = [];
  const push = (code, severity, message, targetId, point) => {
    violations.push({ code, severity, message, targetId, point });
  };
  const room = plan.room.polygon;
  const allWalls = [...plan.walls, ...plan.partitions];
  let checksRun = 0;

  // 1. Мебель не должна выходить за контур помещения.
  for (const f of plan.furniture) {
    checksRun += 1;
    const outside = f.corners.filter((corner) => !G.pointInPolygon(corner, room));
    if (outside.length > 0) {
      push(
        'FURNITURE_OUT_OF_ROOM',
        'error',
        `«${f.id}» выходит за контур помещения: ${outside.length} из 4 углов снаружи`,
        f.id,
        f.rect.c,
      );
    }
  }

  // 2. Мебель не должна пересекаться между собой.
  for (let i = 0; i < plan.furniture.length; i++) {
    for (let j = i + 1; j < plan.furniture.length; j++) {
      checksRun += 1;
      const a = plan.furniture[i];
      const b = plan.furniture[j];
      const { overlap, depth } = G.satOverlapOBB(a.rect, b.rect);
      if (overlap) {
        push(
          'FURNITURE_OVERLAP',
          'error',
          `«${a.id}» и «${b.id}» пересекаются, глубина ${mm(depth)}`,
          a.id,
          G.scale(G.add(a.rect.c, b.rect.c), 0.5),
        );
      }
    }
  }

  // 3. Мебель не должна врезаться в перегородку.
  for (const f of plan.furniture) {
    for (const p of plan.partitions) {
      checksRun += 1;
      const { overlap, depth } = G.satOverlapOBB(f.rect, G.obbFromSegment(p.start, p.end, p.thickness));
      if (overlap) {
        push(
          'FURNITURE_OVERLAP_WALL',
          'error',
          `«${f.id}» пересекает перегородку «${p.id}», глубина ${mm(depth)}`,
          f.id,
          f.rect.c,
        );
      }
    }
  }

  // 4. Проёмы должны оставаться свободными.
  for (const wall of allWalls) {
    for (const op of wall.openings) {
      for (const f of plan.furniture) {
        checksRun += 1;
        const { overlap } = G.satOverlapOBB(f.rect, openingBox(wall, op));
        if (overlap) {
          const label = op.kind === 'door' ? 'дверной проём' : op.kind === 'window' ? 'оконный проём' : 'проход';
          push('OPENING_BLOCKED', 'error', `«${f.id}» перекрывает ${label} «${op.id}»`, f.id, f.rect.c);
        }
      }
    }
  }

  // 5. Зазор до стены: либо примыкание (встроенный объект), либо нормативный зазор.
  const { minWallClearance, builtInGapTolerance } = plan.rules;
  for (const f of plan.furniture) {
    checksRun += 1;
    const clearance = wallClearance(f, room);
    if (f.againstWall) {
      if (clearance > builtInGapTolerance) {
        push(
          'BUILTIN_GAP',
          'warning',
          `«${f.id}» помечен как встроенный (againstWall), но отходит от стены на ${mm(clearance)}`,
          f.id,
          f.rect.c,
        );
      }
    } else if (clearance < minWallClearance) {
      push(
        'WALL_CLEARANCE',
        'warning',
        `«${f.id}»: зазор до стены ${mm(clearance)} меньше ${mm(minWallClearance)} — либо прижать (againstWall: true), либо отодвинуть`,
        f.id,
        f.rect.c,
      );
    }
  }

  // 6. Перед дверью должна оставаться свободная зона doorClearance.
  for (const wall of allWalls) {
    for (const op of wall.openings) {
      if (op.kind !== 'door' || !op.checkClearance) continue;
      for (const zone of doorClearanceZones(plan, wall, op, plan.rules.doorClearance)) {
        for (const f of plan.furniture) {
          checksRun += 1;
          const { overlap } = G.satOverlapOBB(f.rect, zone.box);
          if (overlap) {
            push(
              'DOOR_CLEARANCE',
              'warning',
              `перед дверью «${op.id}» занята зона ${mm(plan.rules.doorClearance)} x ${mm(op.width)}: мешает «${f.id}»`,
              f.id,
              zone.box.c,
            );
          }
        }
      }
    }
  }

  const errors = violations.filter((x) => x.severity === 'error').length;
  const warnings = violations.filter((x) => x.severity === 'warning').length;
  return {
    violations,
    stats: {
      checksRun,
      errors,
      warnings,
      passed: checksRun - violations.length,
      status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
    },
  };
}
