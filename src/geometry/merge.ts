import { BufferGeometry, Group, Material, Mesh, Quaternion, Vector3 } from 'three';
import type { MaterialKey } from '../materials/keys';
import { angleOf } from '../util/math2d';
import type { DoorLeafDef, FloorBuild } from './index';
import { W } from './builder';

export type MaterialSource = (key: MaterialKey) => Material;

/** Keys that should not cast shadows (glass lets the sun through; rugs and shades are thin). */
const NO_SHADOW = new Set<MaterialKey>(['glass', 'facade-glass', 'rug', 'lamp-shade']);

export function meshesFor(map: Map<MaterialKey, BufferGeometry>, materials: MaterialSource, name: string): Group {
  const g = new Group();
  g.name = name;
  for (const [key, geom] of map) {
    const m = new Mesh(geom, materials(key));
    m.name = `${name}:${key}`;
    m.userData.materialKey = key;
    m.castShadow = !NO_SHADOW.has(key);
    m.receiveShadow = key !== 'glass';
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    g.add(m);
  }
  return g;
}

/** A door leaf as a pivoting group; the controller sets `rotation.y` or the slide offset. */
export class DoorObject {
  readonly group = new Group();
  readonly baseYaw: number;
  readonly turnSign: number;
  amount = 0;

  constructor(
    readonly def: DoorLeafDef,
    materials: MaterialSource,
  ) {
    this.baseYaw = angleOf(def.closedDir);
    this.turnSign = Math.sign(def.closedDir.x * def.openDir.y - def.closedDir.y * def.openDir.x) || 1;
    this.group.name = def.id;
    this.group.position.copy(W(def.pivot, def.elevation));
    this.group.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), this.baseYaw));
    for (const part of def.parts) {
      const m = new Mesh(part.geometry, materials(part.key));
      m.castShadow = part.key !== 'glass';
      m.receiveShadow = true;
      m.userData.materialKey = part.key;
      this.group.add(m);
    }
  }

  /** amount: radians for hinged leaves, meters for sliding panels. */
  set(amount: number): void {
    this.amount = amount;
    if (this.def.kind === 'hinged') {
      this.group.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), this.baseYaw + this.turnSign * amount);
    } else {
      const p = { x: this.def.pivot.x + this.def.openDir.x * amount, y: this.def.pivot.y + this.def.openDir.y * amount };
      this.group.position.copy(W(p, this.def.elevation));
    }
  }

  dispose(): void {
    for (const c of this.group.children) (c as Mesh).geometry.dispose();
  }
}

export interface FloorObjects {
  build: FloorBuild;
  root: Group;
  shell: Group;
  furniture: Group;
  doors: DoorObject[];
}

export function floorObjects(build: FloorBuild, materials: MaterialSource): FloorObjects {
  const root = new Group();
  root.name = `floor:${build.floorId}`;
  const shell = meshesFor(build.shell, materials, `${build.floorId}:shell`);
  const furniture = meshesFor(build.furniture, materials, `${build.floorId}:furniture`);
  const doors = build.doors.map((d) => new DoorObject(d, materials));
  root.add(shell, furniture, ...doors.map((d) => d.group));
  return { build, root, shell, furniture, doors };
}

export function disposeGroup(g: Group): void {
  g.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}
