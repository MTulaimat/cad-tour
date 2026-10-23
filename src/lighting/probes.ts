import {
  BufferAttribute,
  CubeCamera,
  DataTexture,
  HalfFloatType,
  Material,
  PMREMGenerator,
  ShaderChunk,
  Texture,
  Vector3,
  WebGLCubeRenderTarget,
  type BufferGeometry,
  type Object3D,
  type Scene,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { Floor, Room, Vec2 } from '../data/schema';
import { bounds, interiorPoint, pointInPolygon } from '../util/math2d';

/**
 * Per-room environment probes. Outdoor HDRI light alone makes interiors flat and over-bright, so
 * each indoor room gets its own cube capture (at its interior point, 1.4 m up), filtered by PMREM.
 *
 * Merged floor meshes mix rooms, so instead of one material per room every triangle carries a
 * `probeSlot` vertex attribute (0 means "use the sky"), and the standard material's environment
 * lookup is patched to pick that room's probe, with box projection for reflections. No extra draw
 * calls; one set of samplers per floor.
 */

export const MAX_PROBES_PER_FLOOR = 6;

export interface FloorProbeUniforms {
  probeMap: { value: Texture[] };
  probeMin: { value: Vector3[] };
  probeMax: { value: Vector3[] };
  probePos: { value: Vector3[] };
  probeIntensity: { value: number };
  probesOn: { value: number };
}

export interface ProbeRoom {
  roomId: string;
  slot: number;
  polygon: Vec2[];
  position: Vector3;
  min: Vector3;
  max: Vector3;
}

const W3 = (p: Vec2, h: number) => new Vector3(p.x, h, -p.y);

/**
 * Picks up to MAX_PROBES_PER_FLOOR indoor rooms (largest first) and assigns slots 1..N. Spaces rising
 * from a floor below (a double-height room beside a mezzanine) take the slots left, captured at this
 * floor's level, so the faces of this floor that look into them are lit like them.
 */
export function probeRooms(floor: Floor, rising: { floor: Floor; room: Room }[] = []): ProbeRoom[] {
  const rooms = floor.rooms
    .filter((r) => !r.outdoor)
    .map((r) => {
      const b = bounds(r.polygon);
      return { r, area: (b.maxX - b.minX) * (b.maxY - b.minY) };
    })
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_PROBES_PER_FLOOR);
  const own = rooms.map(({ r }, i) => {
    const b = bounds(r.polygon);
    const ceil = r.ceilingHeight ?? floor.ceilingHeight;
    const ip = interiorPoint(r.polygon);
    return {
      roomId: r.id,
      slot: i + 1,
      polygon: r.polygon,
      position: W3(ip, floor.elevation + Math.min(1.4, ceil - 0.3)),
      min: new Vector3(b.minX, floor.elevation, -b.maxY),
      max: new Vector3(b.maxX, floor.elevation + ceil, -b.minY),
    };
  });
  const extra = rising.slice(0, MAX_PROBES_PER_FLOOR - own.length).map(({ floor: f, room: r }, i) => {
    const b = bounds(r.polygon);
    const top = f.elevation + (r.ceilingHeight ?? f.ceilingHeight);
    return {
      roomId: r.id,
      slot: own.length + i + 1,
      polygon: r.polygon,
      // Captured where the room's own probe on its floor is, so both floors light it alike.
      position: W3(interiorPoint(r.polygon), f.elevation + Math.min(1.4, top - f.elevation - 0.3)),
      min: new Vector3(b.minX, f.elevation, -b.maxY),
      max: new Vector3(b.maxX, top, -b.minY),
    };
  });
  return [...own, ...extra];
}

/** Writes the probeSlot attribute: each triangle takes the room it faces (centroid + normal). */
export function assignProbeSlots(geom: BufferGeometry, rooms: ProbeRoom[], floor: Floor, offset = 0.12): void {
  const pos = geom.getAttribute('position');
  const nor = geom.getAttribute('normal');
  const idx = geom.getIndex();
  const slots = new Float32Array(pos.count);
  const tri = idx ? idx.count / 3 : pos.count / 3;
  // This floor's rooms first, then the spaces rising from below that have probes.
  const roomPolys = [...floor.rooms.map((r) => ({ id: r.id, poly: r.polygon })), ...rooms.filter((r) => !floor.rooms.some((x) => x.id === r.roomId)).map((r) => ({ id: r.roomId, poly: r.polygon }))];
  const slotOf = new Map(rooms.map((r) => [r.roomId, r.slot]));
  const lo = floor.elevation - 0.25;
  const hi = floor.elevation + Math.max(floor.ceilingHeight, ...floor.rooms.map((r) => r.ceilingHeight ?? 0)) + 0.25;
  for (let t = 0; t < tri; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const cx = (pos.getX(ia) + pos.getX(ib) + pos.getX(ic)) / 3 + ((nor.getX(ia) + nor.getX(ib) + nor.getX(ic)) / 3) * offset;
    const cy = (pos.getY(ia) + pos.getY(ib) + pos.getY(ic)) / 3;
    const cz = (pos.getZ(ia) + pos.getZ(ib) + pos.getZ(ic)) / 3 + ((nor.getZ(ia) + nor.getZ(ib) + nor.getZ(ic)) / 3) * offset;
    let slot = 0;
    if (cy > lo && cy < hi) {
      const p = { x: cx, y: -cz };
      const room = roomPolys.find((r) => pointInPolygon(p, r.poly));
      slot = room ? (slotOf.get(room.id) ?? 0) : 0;
    }
    slots[ia] = slot;
    slots[ib] = slot;
    slots[ic] = slot;
  }
  geom.setAttribute('probeSlot', new BufferAttribute(slots, 1));
}

/** Sets one slot on a whole geometry (door leaves, which move). */
export function setProbeSlot(geom: BufferGeometry, slot: number): void {
  geom.setAttribute('probeSlot', new BufferAttribute(new Float32Array(geom.getAttribute('position').count).fill(slot), 1));
}

export function createProbeUniforms(): FloorProbeUniforms {
  const blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  return {
    probeMap: { value: Array.from({ length: MAX_PROBES_PER_FLOOR }, () => blank) },
    probeMin: { value: Array.from({ length: MAX_PROBES_PER_FLOOR }, () => new Vector3()) },
    probeMax: { value: Array.from({ length: MAX_PROBES_PER_FLOOR }, () => new Vector3(1, 1, 1)) },
    probePos: { value: Array.from({ length: MAX_PROBES_PER_FLOOR }, () => new Vector3()) },
    probeIntensity: { value: 1.0 },
    probesOn: { value: 0 },
  };
}

const N = MAX_PROBES_PER_FLOOR;

const fragPars = /* glsl */ `
uniform sampler2D probeMap[${N}];
uniform vec3 probeMin[${N}];
uniform vec3 probeMax[${N}];
uniform vec3 probePos[${N}];
uniform float probeIntensity;
uniform float probesOn;
flat varying float vProbeSlot;
varying vec3 vProbeWorld;

vec4 probeFetch( const in int i, const in vec3 dir, const in float roughness ) {
  ${Array.from({ length: N }, (_, i) => `if ( i == ${i} ) return textureCubeUV( probeMap[ ${i} ], dir, roughness );`).join('\n  ')}
  return vec4( 0.0 );
}

// Parallax-corrected direction: intersect the ray with the room box, look from the probe.
vec3 probeBoxDir( const in int i, const in vec3 dir ) {
  vec3 rbmax = ( probeMax[ i ] - vProbeWorld ) / dir;
  vec3 rbmin = ( probeMin[ i ] - vProbeWorld ) / dir;
  vec3 rbminmax = max( rbmax, rbmin );
  float d = min( min( rbminmax.x, rbminmax.y ), rbminmax.z );
  vec3 hit = vProbeWorld + dir * max( d, 0.0 );
  return normalize( hit - probePos[ i ] );
}

vec4 probeSample( const in vec3 dir, const in float roughness, const in bool specular ) {
  int slot = int( vProbeSlot + 0.5 ) - 1;
  if ( probesOn < 0.5 || slot < 0 ) return textureCubeUV( envMap, dir, roughness );
  // envMapRotation is identity for probes; undo it on the direction we were given.
  vec3 d = transpose( envMapRotation ) * dir;
  if ( specular ) d = probeBoxDir( slot, d );
  return probeFetch( slot, d, roughness ) * probeIntensity;
}
`;

const physicalPars = ShaderChunk.envmap_physical_pars_fragment
  .replace('textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 )', 'probeSample( envMapRotation * worldNormal, 1.0, false )')
  .replace('textureCubeUV( envMap, envMapRotation * reflectVec, roughness )', 'probeSample( envMapRotation * reflectVec, roughness, true )');

/** Patches a standard or physical material to read this floor's probes. */
export function patchMaterialForProbes(material: Material, uniforms: FloorProbeUniforms): void {
  const m = material as Material & { isMeshStandardMaterial?: boolean };
  if (!m.isMeshStandardMaterial) return;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float probeSlot;\nflat varying float vProbeSlot;\nvarying vec3 vProbeWorld;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvProbeSlot = probeSlot;\nvProbeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <envmap_physical_pars_fragment>',
      `#ifdef USE_ENVMAP\n#ifdef ENVMAP_TYPE_CUBE_UV\n${fragPars}\n#endif\n#endif\n${physicalPars}`,
    );
  };
  material.customProgramCacheKey = () => `probes${N}`;
  material.needsUpdate = true;
}

/**
 * Captures the probes for one floor. `hide` is hidden during capture (avatar, helpers);
 * probes stay off while capturing so a room never reflects an older probe of itself.
 */
export class ProbeCapture {
  private pmrem: PMREMGenerator;
  private targets: WebGLRenderTarget[] = [];

  constructor(
    private renderer: WebGLRenderer,
    private size: number,
  ) {
    this.pmrem = new PMREMGenerator(renderer);
  }

  capture(scene: Scene, rooms: ProbeRoom[], uniforms: FloorProbeUniforms, hide: Object3D[] = []): void {
    const cubeRT = new WebGLCubeRenderTarget(this.size, { type: HalfFloatType, generateMipmaps: false });
    const cam = new CubeCamera(0.05, 200, cubeRT);
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const on = uniforms.probesOn.value;
    uniforms.probesOn.value = 0;
    // The post composer turns autoClear off; each cube face needs a cleared depth buffer.
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    for (const r of rooms) {
      cam.position.copy(r.position);
      cam.update(this.renderer, scene);
      const pm = this.pmrem.fromCubemap(cubeRT.texture);
      this.targets.push(pm);
      const i = r.slot - 1;
      uniforms.probeMap.value[i] = pm.texture;
      uniforms.probeMin.value[i].copy(r.min);
      uniforms.probeMax.value[i].copy(r.max);
      uniforms.probePos.value[i].copy(r.position);
    }
    this.renderer.autoClear = autoClear;
    hide.forEach((o, i) => (o.visible = was[i]));
    uniforms.probesOn.value = rooms.length > 0 ? 1 : on;
    cubeRT.dispose();
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    this.pmrem.dispose();
  }
}
