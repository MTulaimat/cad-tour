import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, ShapeUtils, Vector2, Vector3 } from 'three';
import type { Vec2 } from '../data/schema';
import type { MaterialKey } from '../materials/keys';

/**
 * Triangulates a plan polygon with holes. Returns index triples into [...outer, ...holes.flat()],
 * each counterclockwise in plan (so they face up once mapped to world space).
 */
export function triangulate(outer: Vec2[], holes: Vec2[][] = []): { points: Vec2[]; tris: [number, number, number][] } {
  const ring = (r: Vec2[]) => {
    const out = r.slice();
    while (out.length > 3 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-9) out.pop();
    return out;
  };
  const o = ring(outer);
  const hs = holes.map(ring).filter((h) => h.length >= 3);
  const points = [...o, ...hs.flat()];
  const faces = ShapeUtils.triangulateShape(
    o.map((p) => new Vector2(p.x, p.y)),
    hs.map((h) => h.map((p) => new Vector2(p.x, p.y))),
  ) as [number, number, number][];
  const tris = faces.map(([a, b, c]): [number, number, number] => {
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    const s = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    return s >= 0 ? [a, b, c] : [a, c, b];
  });
  return { points, tris };
}

/** Plan point (x, y) at height h, in world coordinates (x, h, -y). */
export const W = (p: Vec2, h: number): Vector3 => new Vector3(p.x, h, -p.y);

const _v = new Vector3();
const _n = new Vector3();
const _nm = new Matrix3();

/**
 * Accumulates triangles for one material. Positions are world space, normals are per vertex,
 * UVs are in meters (the material decides how many meters one texture repeat covers).
 */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: Vector3, n: Vector3, u: number, v: number): number {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /**
   * Quad p0 p1 p2 p3 in counterclockwise order seen from the front (normal side).
   * UVs are given per corner.
   */
  quad(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, n: Vector3, uv: [number, number][]): void {
    const a = this.vertex(p0, n, uv[0][0], uv[0][1]);
    const b = this.vertex(p1, n, uv[1][0], uv[1][1]);
    const c = this.vertex(p2, n, uv[2][0], uv[2][1]);
    const d = this.vertex(p3, n, uv[3][0], uv[3][1]);
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Planar quad with UVs projected onto its own plane in meters (u along p0 to p1). */
  quadAuto(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, uOffset = 0, vOffset = 0): void {
    const e1 = new Vector3().subVectors(p1, p0);
    const e3 = new Vector3().subVectors(p3, p0);
    const n = new Vector3().crossVectors(e1, e3).normalize();
    const uAxis = e1.clone().normalize();
    const vAxis = new Vector3().crossVectors(n, uAxis).normalize();
    const uv = (p: Vector3): [number, number] => {
      _v.subVectors(p, p0);
      return [_v.dot(uAxis) + uOffset, _v.dot(vAxis) + vOffset];
    };
    this.quad(p0, p1, p2, p3, n, [uv(p0), uv(p1), uv(p2), uv(p3)]);
  }

  /**
   * Axis-aligned (in local space) box transformed by `m`. UVs are box-projected in meters.
   * `faces` can skip sides: order +x, -x, +y, -y, +z, -z.
   */
  box(m: Matrix4, sx: number, sy: number, sz: number, faces: boolean[] = [true, true, true, true, true, true]): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const c = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m);
    _nm.getNormalMatrix(m);
    const nrm = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix3(_nm).normalize();
    // +x
    if (faces[0])
      this.quad(c(hx, -hy, hz), c(hx, -hy, -hz), c(hx, hy, -hz), c(hx, hy, hz), nrm(1, 0, 0), [
        [0, 0],
        [sz, 0],
        [sz, sy],
        [0, sy],
      ]);
    // -x
    if (faces[1])
      this.quad(c(-hx, -hy, -hz), c(-hx, -hy, hz), c(-hx, hy, hz), c(-hx, hy, -hz), nrm(-1, 0, 0), [
        [0, 0],
        [sz, 0],
        [sz, sy],
        [0, sy],
      ]);
    // +y
    if (faces[2])
      this.quad(c(-hx, hy, hz), c(hx, hy, hz), c(hx, hy, -hz), c(-hx, hy, -hz), nrm(0, 1, 0), [
        [0, 0],
        [sx, 0],
        [sx, sz],
        [0, sz],
      ]);
    // -y
    if (faces[3])
      this.quad(c(-hx, -hy, -hz), c(hx, -hy, -hz), c(hx, -hy, hz), c(-hx, -hy, hz), nrm(0, -1, 0), [
        [0, 0],
        [sx, 0],
        [sx, sz],
        [0, sz],
      ]);
    // +z
    if (faces[4])
      this.quad(c(-hx, -hy, hz), c(hx, -hy, hz), c(hx, hy, hz), c(-hx, hy, hz), nrm(0, 0, 1), [
        [0, 0],
        [sx, 0],
        [sx, sy],
        [0, sy],
      ]);
    // -z
    if (faces[5])
      this.quad(c(hx, -hy, -hz), c(-hx, -hy, -hz), c(-hx, hy, -hz), c(hx, hy, -hz), nrm(0, 0, -1), [
        [0, 0],
        [sx, 0],
        [sx, sy],
        [0, sy],
      ]);
  }

  /**
   * Appends an existing geometry transformed by `m`. When `boxUV` is set, UVs are recomputed
   * by box projection of the local positions (meters), which keeps textures at true scale on
   * primitives whose own UVs are normalized.
   */
  append(geom: BufferGeometry, m: Matrix4, boxUV = true): void {
    const pos = geom.getAttribute('position');
    const nor = geom.getAttribute('normal');
    const uv = geom.getAttribute('uv');
    _nm.getNormalMatrix(m);
    const base = this.vertexCount;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const ly = pos.getY(i);
      const lz = pos.getZ(i);
      _v.set(lx, ly, lz).applyMatrix4(m);
      _n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
      let u = 0;
      let w = 0;
      if (boxUV) {
        const ax = Math.abs(_n.x);
        const ay = Math.abs(_n.y);
        const az = Math.abs(_n.z);
        if (ax >= ay && ax >= az) {
          u = lz;
          w = ly;
        } else if (ay >= az) {
          u = lx;
          w = lz;
        } else {
          u = lx;
          w = ly;
        }
      } else if (uv) {
        u = uv.getX(i);
        w = uv.getY(i);
      }
      _n.applyMatrix3(_nm).normalize();
      this.positions.push(_v.x, _v.y, _v.z);
      this.normals.push(_n.x, _n.y, _n.z);
      this.uvs.push(u, w);
    }
    const index = geom.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.indices.push(base + i);
    }
    // A mirroring transform flips winding; fix it so faces stay front facing.
    if (m.determinant() < 0) {
      const start = this.indices.length - (index ? index.count : pos.count);
      for (let i = start; i < this.indices.length; i += 3) {
        const t = this.indices[i + 1];
        this.indices[i + 1] = this.indices[i + 2];
        this.indices[i + 2] = t;
      }
    }
  }

  /** Horizontal polygon (plan points) at height h; `up` chooses the facing. UVs are plan meters. */
  polygon(outer: Vec2[], h: number, up: boolean, holes: Vec2[][] = []): void {
    const { points, tris } = triangulate(outer, holes);
    const n = new Vector3(0, up ? 1 : -1, 0);
    const base = this.vertexCount;
    for (const p of points) this.vertex(W(p, h), n, p.x, p.y);
    for (const [a, b, c] of tris) {
      if (up) this.tri(base + a, base + b, base + c);
      else this.tri(base + a, base + c, base + b);
    }
  }

  isEmpty(): boolean {
    return this.indices.length === 0;
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    const count = this.vertexCount;
    g.setIndex(count > 65535 ? new BufferAttribute(new Uint32Array(this.indices), 1) : new BufferAttribute(new Uint16Array(this.indices), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** One builder per material key. */
export class BuilderSet {
  private map = new Map<MaterialKey, MeshBuilder>();

  get(key: MaterialKey): MeshBuilder {
    let b = this.map.get(key);
    if (!b) {
      b = new MeshBuilder();
      this.map.set(key, b);
    }
    return b;
  }

  entries(): [MaterialKey, MeshBuilder][] {
    return [...this.map.entries()].filter(([, b]) => !b.isEmpty());
  }
}
