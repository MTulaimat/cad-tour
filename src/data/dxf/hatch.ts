/**
 * HATCH entity handler for dxf-parser, which has none. Only the boundary paths are kept
 * (polyline paths with bulges, and edge paths made of lines and circular arcs); fill patterns
 * are skipped. Wall layers often carry hatched wall outlines, so the boundaries matter.
 */

interface Group {
  code: number;
  value: number | string | boolean;
}

interface Scanner {
  next(): Group;
  isEOF(): boolean;
}

export interface HatchLoop {
  points: { x: number; y: number; bulge?: number }[];
  closed: boolean;
}

export interface HatchEntity {
  type: 'HATCH';
  layer?: string;
  inPaperSpace?: boolean;
  loops: HatchLoop[];
  extrusionDirectionZ?: number;
  /** Pattern name (group 2), for example SOLID or ANSI37. */
  pattern?: string;
  /** Solid fill flag (group 70). Solid hatches are filled shapes; patterned ones mark a surface. */
  solid?: boolean;
}

const num = (g: Group) => Number(g.value);

/** Samples an arc edge (degrees, counterclockwise flag) into points. */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, ccw: boolean): { x: number; y: number }[] {
  let s = (a0 * Math.PI) / 180;
  let e = (a1 * Math.PI) / 180;
  if (!ccw) {
    // Clockwise edges store mirrored angles.
    s = -s;
    e = -e;
  }
  while (e <= s) e += Math.PI * 2;
  const n = Math.max(2, Math.ceil(((e - s) / (Math.PI / 2)) * 6));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = s + ((e - s) * i) / n;
    pts.push({ x: cx + Math.cos(t) * r, y: cy + (ccw ? 1 : -1) * Math.sin(t) * r });
  }
  return pts;
}

export default class Hatch {
  public ForEntityName = 'HATCH' as const;

  public parseEntity(scanner: Scanner, curr: Group): HatchEntity {
    const entity: HatchEntity = { type: 'HATCH', loops: [] };
    let pathsLeft = -1;
    curr = scanner.next();
    while (!scanner.isEOF()) {
      if (curr.code === 0) break;
      if (curr.code === 8) entity.layer = String(curr.value);
      else if (curr.code === 67) entity.inPaperSpace = Number(curr.value) !== 0;
      else if (curr.code === 230) entity.extrusionDirectionZ = num(curr);
      else if (curr.code === 2 && pathsLeft < 0 && entity.pattern === undefined) entity.pattern = String(curr.value).trim();
      else if (curr.code === 70 && pathsLeft < 0 && entity.solid === undefined) entity.solid = num(curr) === 1;
      else if (curr.code === 91 && pathsLeft < 0) pathsLeft = num(curr);
      else if (curr.code === 92 && pathsLeft > 0) {
        pathsLeft--;
        const flags = num(curr);
        const loop: HatchLoop = { points: [], closed: true };
        if (flags & 2) {
          // Polyline path: 72 has-bulge, 73 closed, 93 count, then 10/20(/42).
          let hasBulge = false;
          let count = 0;
          curr = scanner.next();
          while (curr.code !== 10 && curr.code !== 0) {
            if (curr.code === 72) hasBulge = num(curr) !== 0;
            if (curr.code === 73) loop.closed = num(curr) !== 0;
            if (curr.code === 93) count = num(curr);
            curr = scanner.next();
          }
          for (let i = 0; i < count && curr.code === 10; i++) {
            const x = num(curr);
            curr = scanner.next();
            const y = curr.code === 20 ? num(curr) : 0;
            const p: { x: number; y: number; bulge?: number } = { x, y };
            curr = scanner.next();
            if (hasBulge && curr.code === 42) {
              p.bulge = num(curr);
              curr = scanner.next();
            }
            loop.points.push(p);
          }
          entity.loops.push(loop);
          continue;
        }
        // Edge path: 93 edge count, then per edge 72 type and its fields.
        curr = scanner.next();
        let edges = 0;
        if (curr.code === 93) {
          edges = num(curr);
          curr = scanner.next();
        }
        for (let e = 0; e < edges; e++) {
          if (curr.code !== 72) break;
          const type = num(curr);
          const f: Record<number, number> = {};
          curr = scanner.next();
          while (curr.code !== 72 && curr.code !== 97 && curr.code !== 0 && curr.code !== 92) {
            f[curr.code] = num(curr);
            curr = scanner.next();
          }
          if (type === 1) {
            if (loop.points.length === 0) loop.points.push({ x: f[10], y: f[20] });
            loop.points.push({ x: f[11], y: f[21] });
          } else if (type === 2) {
            const pts = arcPoints(f[10], f[20], f[40], f[50], f[51], (f[73] ?? 1) !== 0);
            loop.points.push(...(loop.points.length ? pts.slice(1) : pts));
          }
        }
        if (loop.points.length >= 3) entity.loops.push(loop);
        continue;
      }
      curr = scanner.next();
    }
    // The parser reads the terminating 0 group from scanner.lastReadGroup.
    return entity;
  }
}
