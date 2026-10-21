import {
  CircleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  IcosahedronGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Texture,
} from 'three';
import { MeshBuilder } from '../geometry/builder';

/**
 * Exterior context (Q5): the apartment sits a few storeys up. The HDRI backplate is the sky and the
 * distant city; up close, a ground plane well below the balcony with low neighbouring blocks and
 * street trees, whose far edge fades into the backplate in the same view direction, so looking
 * down never shows a void and the join is invisible.
 */

export interface GroundOptions {
  groundY: number;
  backplate: Texture;
  /** Sky yaw (radians), as set on scene.backgroundRotation. */
  rotation: number;
  /** Matches scene.backgroundIntensity. */
  intensity: number;
  /** Footprint center of the apartment (world xz), kept clear of neighbours. */
  center: Vector3;
  /** Half size of the apartment footprint, to keep neighbours clear. */
  clearRadius: number;
}

const FADE_START = 70;
const FADE_END = 240;

function patchFade(mat: MeshStandardMaterial, o: GroundOptions): void {
  const rot = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(0, -o.rotation, 0)));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.bgMap = { value: o.backplate };
    shader.uniforms.bgRot = { value: rot };
    shader.uniforms.bgIntensity = { value: o.intensity };
    shader.uniforms.fadeCenter = { value: o.center };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vGroundWorld;
uniform sampler2D bgMap;
uniform mat3 bgRot;
uniform float bgIntensity;
uniform vec3 fadeCenter;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  vec3 dir = bgRot * normalize( vGroundWorld - cameraPosition );
  vec2 euv = vec2( atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5, asin( clamp( dir.y, -1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5 );
  vec3 bg = texture2D( bgMap, euv ).rgb * bgIntensity;
  float d = length( vGroundWorld.xz - fadeCenter.xz );
  float fade = smoothstep( ${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, d );
  outgoingLight = mix( outgoingLight, bg, fade );
}
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'ground-fade';
}

/** Deterministic pseudo random in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function buildGround(o: GroundOptions, facade: MeshStandardMaterial, glass: MeshStandardMaterial): Group {
  const g = new Group();
  g.name = 'exterior-context';

  // Ground: paving near, fading to the backplate far away.
  const groundMat = new MeshStandardMaterial({ color: new Color('#8d8a83'), roughness: 0.95, metalness: 0 });
  patchFade(groundMat, o);
  const ground = new Mesh(new CircleGeometry(FADE_END + 40, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(o.center.x, o.groundY, o.center.z);
  ground.receiveShadow = true;
  ground.name = 'ground';
  g.add(ground);

  // Streets and lawns as large flat strips just above the ground.
  const lawnMat = new MeshStandardMaterial({ color: new Color('#6f8656'), roughness: 1 });
  const roadMat = new MeshStandardMaterial({ color: new Color('#5b5d60'), roughness: 0.9 });
  patchFade(lawnMat, o);
  patchFade(roadMat, o);
  const lawns = new MeshBuilder();
  const roads = new MeshBuilder();
  // Three facade tones so the neighbourhood is not a single massing colour.
  const blockSets = [new MeshBuilder(), new MeshBuilder(), new MeshBuilder()];
  const roofs = new MeshBuilder();
  const windows = new MeshBuilder();
  const trunks = new MeshBuilder();
  const crowns = new MeshBuilder();
  const rand = rng(7);
  const pitch = 42;
  const y0 = o.groundY;
  const flat = (b: MeshBuilder, cx: number, cz: number, sx: number, sz: number, y: number) => {
    b.quad(new Vector3(cx - sx / 2, y, cz + sz / 2), new Vector3(cx + sx / 2, y, cz + sz / 2), new Vector3(cx + sx / 2, y, cz - sz / 2), new Vector3(cx - sx / 2, y, cz - sz / 2), new Vector3(0, 1, 0), [
      [0, 0],
      [sx, 0],
      [sx, sz],
      [0, sz],
    ]);
  };
  const trunkG = new CylinderGeometry(0.12, 0.18, 2.6, 7);
  const crownG = new IcosahedronGeometry(1.8, 1);
  const tree = (x: number, z: number, s: number) => {
    trunks.append(trunkG, new Matrix4().compose(new Vector3(x, y0 + 1.3 * s, z), new Quaternion(), new Vector3(s, s, s)), false);
    crowns.append(crownG, new Matrix4().compose(new Vector3(x, y0 + 3.6 * s, z), new Quaternion().setFromEuler(new Euler(rand(), rand(), 0)), new Vector3(s, s * 0.85, s)), false);
  };
  for (let i = -5; i <= 5; i++) {
    for (let j = -5; j <= 5; j++) {
      const cx = o.center.x + i * pitch;
      const cz = o.center.z + j * pitch;
      const dist = Math.hypot(i * pitch, j * pitch);
      if (dist > FADE_END) continue;
      // Roads along the grid lines.
      flat(roads, cx + pitch / 2, cz, 9, pitch, y0 + 0.02);
      flat(roads, cx, cz + pitch / 2, pitch, 9, y0 + 0.021);
      const own = i === 0 && j === 0;
      // Lawn courtyards in some blocks.
      if (own || rand() < 0.6) flat(lawns, cx, cz, pitch - 16, pitch - 16, y0 + 0.015);
      // Street trees along the roads.
      for (let k = 0; k < 3; k++) {
        if (rand() < 0.35) continue;
        tree(cx + pitch / 2 - 6, cz - pitch / 2 + 8 + k * 12, 0.8 + rand() * 0.5);
      }
      if (own || dist < o.clearRadius + 14) continue;
      // Neighbouring blocks: lower than the apartment so the view goes over them.
      const n = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const w = 12 + rand() * 12;
        const d = 10 + rand() * 10;
        const storeys = 2 + Math.floor(rand() * 3);
        const h = storeys * 3;
        const bx = cx + (rand() - 0.5) * (pitch - w - 12);
        const bz = cz + (rand() - 0.5) * (pitch - d - 12);
        blockSets[Math.floor(rand() * 3)].box(new Matrix4().makeTranslation(bx, y0 + h / 2, bz), w, h, d, [true, true, false, false, true, true]);
        roofs.box(new Matrix4().makeTranslation(bx, y0 + h + 0.15, bz), w + 0.3, 0.3, d + 0.3, [true, true, true, false, true, true]);
        // Window bands on each storey.
        for (let s = 0; s < storeys; s++) {
          const wy = y0 + s * 3 + 1.5;
          for (const [nx, nz, len] of [
            [0, 1, w],
            [0, -1, w],
            [1, 0, d],
            [-1, 0, d],
          ] as [number, number, number][]) {
            const px = bx + (nx * w) / 2 + nx * 0.02;
            const pz = bz + (nz * d) / 2 + nz * 0.02;
            const m = new Matrix4().compose(new Vector3(px, wy, pz), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(nx, nz)), new Vector3(1, 1, 1));
            windows.box(m, len * 0.82, 1.1, 0.02, [false, false, false, false, true, false]);
          }
        }
      }
    }
  }
  const add = (b: MeshBuilder, mat: MeshStandardMaterial, name: string, cast = true) => {
    if (b.isEmpty()) return;
    const m = new Mesh(b.toGeometry(), mat);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
  };
  add(lawns, lawnMat, 'lawns', false);
  add(roads, roadMat, 'roads', false);
  const tones = ['#ffffff', '#e9dcc6', '#d8c2b0'].map((c) => {
    const m = facade.clone();
    m.color = new Color(c);
    return m;
  });
  blockSets.forEach((b, i) => add(b, tones[i], `neighbours-${i}`));
  const roofMat = new MeshStandardMaterial({ color: new Color('#6e6c69'), roughness: 0.9 });
  add(roofs, roofMat, 'neighbour-roofs');
  add(windows, glass, 'neighbour-windows', false);
  const trunkMat = new MeshStandardMaterial({ color: new Color('#5a4636'), roughness: 0.9 });
  const crownMat = new MeshStandardMaterial({ color: new Color('#5d7843'), roughness: 0.85 });
  add(trunks, trunkMat, 'tree-trunks');
  add(crowns, crownMat, 'tree-crowns');
  trunkG.dispose();
  crownG.dispose();
  g.userData.dispose = () => {
    g.traverse((c) => {
      const m = c as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of [groundMat, lawnMat, roadMat, trunkMat, crownMat, roofMat, ...tones]) m.dispose();
  };
  return g;
}
