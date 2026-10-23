import type { FloorPlan, Vec2 } from './schema';
import { FLOOR_MATERIALS, SCHEMA_VERSION, STAIR_FINISHES } from './schema';
import { ensureCCW, normalize, polylineLength, samePoint } from '../util/math2d';

/**
 * Hand-written structural validation for FloorPlan objects that come from outside the app
 * (imported JSON, the plan stored on the device). It reports every problem with a path,
 * and never throws.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

export function validatePlan(input: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => {
    if (errors.length < 50) errors.push(`${path}: ${msg}`);
  };

  const vec = (v: unknown, path: string) => {
    if (!isObj(v) || !isNum(v.x) || !isNum(v.y)) err(path, 'expected a point {x, y}');
  };
  const vecs = (v: unknown, path: string, min: number) => {
    if (!Array.isArray(v)) return err(path, 'expected a list of points');
    if (v.length < min) err(path, `expected at least ${min} points`);
    v.forEach((q, i) => vec(q, `${path}[${i}]`));
  };
  const num = (o: Obj, key: string, path: string, opts: { min?: number; max?: number; optional?: boolean } = {}) => {
    const v = o[key];
    if (v === undefined && opts.optional) return;
    if (!isNum(v)) return err(`${path}.${key}`, 'expected a number');
    if (opts.min !== undefined && v < opts.min) err(`${path}.${key}`, `must be at least ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) err(`${path}.${key}`, `must be at most ${opts.max}`);
  };
  const str = (o: Obj, key: string, path: string, optional = false) => {
    const v = o[key];
    if (v === undefined && optional) return;
    if (!isStr(v) || v.length === 0) err(`${path}.${key}`, 'expected a non-empty string');
  };
  const list = (o: Obj, key: string, path: string): unknown[] => {
    const v = o[key];
    if (!Array.isArray(v)) {
      err(`${path}.${key}`, 'expected a list');
      return [];
    }
    return v;
  };

  if (!isObj(input)) return { ok: false, errors: ['plan: expected an object'] };
  const plan = input;
  if (plan.schemaVersion !== SCHEMA_VERSION) err('plan.schemaVersion', `expected ${SCHEMA_VERSION}`);
  if (plan.units !== 'm') err('plan.units', "expected 'm'");
  str(plan, 'name', 'plan');

  const floorIds = new Set<string>();
  const floors = list(plan, 'floors', 'plan');
  if (floors.length === 0) err('plan.floors', 'expected at least one floor');
  floors.forEach((f, fi) => {
    const fp = `floors[${fi}]`;
    if (!isObj(f)) return err(fp, 'expected an object');
    str(f, 'id', fp);
    if (isStr(f.id)) {
      if (floorIds.has(f.id)) err(`${fp}.id`, `duplicate id ${f.id}`);
      floorIds.add(f.id);
    }
    str(f, 'name', fp);
    num(f, 'elevation', fp, { min: -1000, max: 1000 });
    num(f, 'ceilingHeight', fp, { min: 1.8, max: 10 });
    num(f, 'slabThickness', fp, { min: 0, max: 2 });

    const wallIds = new Map<string, number>();
    list(f, 'walls', fp).forEach((w, wi) => {
      const wp = `${fp}.walls[${wi}]`;
      if (!isObj(w)) return err(wp, 'expected an object');
      str(w, 'id', wp);
      vecs(w.centerline, `${wp}.centerline`, 2);
      num(w, 'thickness', wp, { min: 0.01, max: 2 });
      num(w, 'height', wp, { min: 0.1, max: 20 });
      if (isStr(w.id)) {
        if (wallIds.has(w.id)) err(`${wp}.id`, `duplicate id ${w.id}`);
        const pts = Array.isArray(w.centerline) ? (w.centerline as Vec2[]) : [];
        wallIds.set(w.id, pts.every((q) => isObj(q) && isNum(q.x) && isNum(q.y)) ? polylineLength(pts) : 0);
      }
    });

    list(f, 'openings', fp).forEach((o, oi) => {
      const op = `${fp}.openings[${oi}]`;
      if (!isObj(o)) return err(op, 'expected an object');
      str(o, 'id', op);
      if (o.type !== 'door' && o.type !== 'window') err(`${op}.type`, "expected 'door' or 'window'");
      str(o, 'wallId', op);
      num(o, 'offset', op, { min: 0 });
      num(o, 'width', op, { min: 0.2, max: 20 });
      num(o, 'height', op, { min: 0.2, max: 20 });
      num(o, 'sill', op, { min: 0, max: 20 });
      if (isStr(o.wallId)) {
        const l = wallIds.get(o.wallId);
        if (l === undefined) err(`${op}.wallId`, `no wall ${o.wallId} on this floor`);
        else if (isNum(o.offset) && isNum(o.width) && (o.offset - o.width / 2 < -0.01 || o.offset + o.width / 2 > l + 0.01))
          err(op, 'opening does not fit inside its wall');
      }
      if (o.swing !== undefined) {
        const s = o.swing;
        if (!isObj(s) || (s.hinge !== 'start' && s.hinge !== 'end') || (s.side !== 'left' && s.side !== 'right'))
          err(`${op}.swing`, "expected {hinge: 'start'|'end', side: 'left'|'right'}");
      }
      if (o.style !== undefined && o.style !== 'hinged' && o.style !== 'sliding-glass' && o.style !== 'passage')
        err(`${op}.style`, "expected 'hinged', 'sliding-glass' or 'passage'");
    });

    list(f, 'rooms', fp).forEach((r, ri) => {
      const rp = `${fp}.rooms[${ri}]`;
      if (!isObj(r)) return err(rp, 'expected an object');
      str(r, 'id', rp);
      if (!isStr(r.name)) err(`${rp}.name`, 'expected a string');
      vecs(r.polygon, `${rp}.polygon`, 3);
      if (!FLOOR_MATERIALS.includes(r.floorMaterial as never)) err(`${rp}.floorMaterial`, `expected one of ${FLOOR_MATERIALS.join(', ')}`);
      num(r, 'ceilingHeight', rp, { min: 1.8, max: 20, optional: true });
      if (r.glazed !== undefined && typeof r.glazed !== 'boolean') err(`${rp}.glazed`, 'expected true or false');
    });

    if (f.columns !== undefined) {
      list(f, 'columns', fp).forEach((c, ci) => {
        const cp = `${fp}.columns[${ci}]`;
        if (!isObj(c)) return err(cp, 'expected an object');
        str(c, 'id', cp);
        vec(c.center, `${cp}.center`);
        num(c, 'radius', cp, { min: 0.02, max: 3, optional: true });
        num(c, 'width', cp, { min: 0.02, max: 5, optional: true });
        num(c, 'depth', cp, { min: 0.02, max: 5, optional: true });
        num(c, 'rotation', cp, { optional: true });
        if (c.radius === undefined && (c.width === undefined || c.depth === undefined)) err(cp, 'expected a radius, or a width and depth');
      });
    }

    list(f, 'furniture', fp).forEach((it, ii) => {
      const ip = `${fp}.furniture[${ii}]`;
      if (!isObj(it)) return err(ip, 'expected an object');
      str(it, 'id', ip);
      str(it, 'type', ip);
      vec(it.position, `${ip}.position`);
      num(it, 'rotation', ip);
      if (it.size !== undefined) {
        const s = it.size;
        if (!isObj(s) || !isNum(s.x) || !isNum(s.y) || !isNum(s.z)) err(`${ip}.size`, 'expected {x, y, z}');
      }
    });

    if (f.railings !== undefined) {
      list(f, 'railings', fp).forEach((r, ri) => {
        const rp = `${fp}.railings[${ri}]`;
        if (!isObj(r)) return err(rp, 'expected an object');
        str(r, 'id', rp);
        vecs(r.points, `${rp}.points`, 2);
        num(r, 'height', rp, { min: 0.3, max: 3 });
        if (r.finish !== undefined && r.finish !== 'brushed' && r.finish !== 'black-steel') err(`${rp}.finish`, "expected 'brushed' or 'black-steel'");
      });
    }
  });

  list(plan, 'stairs', 'plan').forEach((s, si) => {
    const sp = `stairs[${si}]`;
    if (!isObj(s)) return err(sp, 'expected an object');
    str(s, 'id', sp);
    str(s, 'fromFloorId', sp);
    str(s, 'toFloorId', sp);
    if (isStr(s.fromFloorId) && !floorIds.has(s.fromFloorId)) err(`${sp}.fromFloorId`, `no floor ${s.fromFloorId}`);
    if (isStr(s.toFloorId) && !floorIds.has(s.toFloorId)) err(`${sp}.toFloorId`, `no floor ${s.toFloorId}`);
    vecs(s.outline, `${sp}.outline`, 3);
    if (s.finish !== undefined && !STAIR_FINISHES.includes(s.finish as never)) err(`${sp}.finish`, `expected one of ${STAIR_FINISHES.join(', ')}`);
    const flights = list(s, 'flights', sp);
    if (flights.length === 0) err(`${sp}.flights`, 'expected at least one flight');
    flights.forEach((fl, i) => {
      const flp = `${sp}.flights[${i}]`;
      if (!isObj(fl)) return err(flp, 'expected an object');
      vec(fl.start, `${flp}.start`);
      vec(fl.direction, `${flp}.direction`);
      num(fl, 'width', flp, { min: 0.3, max: 10 });
      num(fl, 'risers', flp, { min: 1, max: 100 });
      num(fl, 'riserHeight', flp, { min: 0.05, max: 0.4 });
      num(fl, 'going', flp, { min: 0.1, max: 1 });
      num(fl, 'baseElevation', flp, { min: -1, max: 20 });
    });
    list(s, 'landings', sp).forEach((l, i) => {
      const lp = `${sp}.landings[${i}]`;
      if (!isObj(l)) return err(lp, 'expected an object');
      vecs(l.polygon, `${lp}.polygon`, 3);
      num(l, 'elevation', lp);
    });
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Normalizes a structurally valid plan in place: drops repeated closing points,
 * makes room and landing polygons counterclockwise, unit-length flight directions,
 * fills optional lists. Returns the same object for chaining.
 */
export function normalizePlan(plan: FloorPlan): FloorPlan {
  const openRing = (poly: Vec2[]): Vec2[] => {
    const out = poly.map((q) => ({ x: q.x, y: q.y }));
    while (out.length > 3 && samePoint(out[0], out[out.length - 1], 1e-6)) out.pop();
    return ensureCCW(out);
  };
  for (const f of plan.floors) {
    f.railings ??= [];
    f.furniture ??= [];
    for (const r of f.rooms) r.polygon = openRing(r.polygon);
  }
  for (const s of plan.stairs) {
    s.outline = openRing(s.outline);
    for (const l of s.landings) l.polygon = openRing(l.polygon);
    for (const fl of s.flights) fl.direction = normalize(fl.direction);
  }
  return plan;
}
