import { Color, RepeatWrapping, type MeshStandardMaterial, type Texture, type WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { MaterialKey } from './keys';
import { SPECS, type MaterialLibrary } from './library';

/** One entry of public/textures/manifest.json. */
export interface TextureSetInfo {
  key: string;
  metersPerRepeat: { x: number; y: number };
  resolutions: string[];
  sourceUrl?: string;
  author?: string;
  files?: Record<string, Record<string, number>>;
}

export interface TextureSet {
  albedo: Texture;
  normal: Texture;
  orm: Texture;
  res: string;
}

/** Tints applied on top of a texture set, so one fabric scan serves the sofa, linen and accents. */
const TINTS: Partial<Record<MaterialKey, string>> = {
  'fabric-accent': '#a4b5a6',
  linen: '#ffffff',
  rug: '#efe6d8',
  'slab-edge': '#e3ddd3',
  'stair-wood': '#fff8ef',
  'wood-light': '#fffaf2',
};

/** Brightness multipliers on top of the tint, for scans that are darker than the palette. */
const GAIN: Partial<Record<MaterialKey, number>> = {};

/**
 * Per-channel linear multipliers that move a scan to the Scandinavian light palette (Q3).
 * Oak: the scan averages sRGB (155, 128, 99); target about (195, 170, 140), pale oak.
 * Tile: the scan is beige (170, 152, 132); target a light warm grey ceramic.
 */
const LINEAR_TINT: Partial<Record<MaterialKey, [number, number, number]>> = {
  'floor-oak': [1.65, 1.83, 2.18],
  'stair-wood': [1.6, 1.78, 2.1],
  'floor-tile': [1.3, 1.5, 1.95],
  'wood-light': [1.35, 1.35, 1.4],
  linen: [1.9, 1.9, 1.95],
};

/** Roughness multiplier on top of the map, per key (1 trusts the scan). */
const ROUGHNESS: Partial<Record<MaterialKey, number>> = {
  // Matte paint: push the scan's roughness up so walls never mirror the room.
  'wall-interior': 1.6,
  ceiling: 1.8,
  'wall-exterior': 1.4,
  'floor-tile': 0.85,
  'stair-wood': 0.95,
  'wood-light': 0.95,
};

/** Normal strength per key; furniture and ceilings read better with softer relief. */
const NORMAL_SCALE: Partial<Record<MaterialKey, number>> = {
  ceiling: 0.2,
  'wall-interior': 0.35,
  linen: 0.6,
  'wood-light': 0.7,
};

let loader: KTX2Loader | null = null;

export function ktx2Loader(renderer: WebGLRenderer): KTX2Loader {
  if (!loader) {
    // three r186 bundles the Basis transcoder (hashed asset URLs via import.meta.url).
    loader = new KTX2Loader().detectSupport(renderer);
  }
  return loader;
}

export async function loadManifest(): Promise<TextureSetInfo[]> {
  const r = await fetch(`${import.meta.env.BASE_URL}textures/manifest.json`);
  if (!r.ok) throw new Error(`Texture manifest missing (${r.status})`);
  const json = (await r.json()) as { materials?: TextureSetInfo[] | Record<string, TextureSetInfo> } | TextureSetInfo[];
  if (Array.isArray(json)) return json;
  const m = json.materials ?? [];
  return Array.isArray(m) ? m : Object.values(m);
}

/** Texture set keys the material specs actually use. */
export function usedSets(): string[] {
  return [...new Set(Object.values(SPECS).flatMap((s) => (s.texture ? [s.texture] : [])))];
}

/**
 * Loads the KTX2 maps for the given sets at `res` (falling back to the nearest available size).
 * `onProgress` gets the fraction of files done.
 */
export async function loadTextureSets(
  renderer: WebGLRenderer,
  manifest: TextureSetInfo[],
  sets: string[],
  res: string,
  anisotropy: number,
  onProgress: (fraction: number) => void = () => {},
): Promise<Map<string, TextureSet>> {
  const l = ktx2Loader(renderer);
  const out = new Map<string, TextureSet>();
  const jobs: Promise<void>[] = [];
  let done = 0;
  const total = sets.length * 3;
  const maxAniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  for (const key of sets) {
    const info = manifest.find((m) => m.key === key);
    if (!info) continue;
    const r = info.resolutions.includes(res) ? res : info.resolutions.includes('1k') ? '1k' : info.resolutions[0];
    const base = `${import.meta.env.BASE_URL}textures/${key}/${r}/`;
    const set: Partial<TextureSet> = { res: r };
    for (const map of ['albedo', 'normal', 'orm'] as const) {
      jobs.push(
        l.loadAsync(`${base}${map}.ktx2`).then((t) => {
          t.wrapS = RepeatWrapping;
          t.wrapT = RepeatWrapping;
          t.repeat.set(1 / info.metersPerRepeat.x, 1 / info.metersPerRepeat.y);
          // The tile scan is laid diagonally; turn it into a straight grid.
          if (key === 'tile') t.rotation = Math.PI / 4;
          t.anisotropy = maxAniso;
          set[map] = t;
          done++;
          onProgress(done / total);
        }),
      );
    }
    out.set(key, set as TextureSet);
  }
  await Promise.all(jobs);
  return out;
}

/** Attaches loaded maps to every material in a library whose spec names a texture set. */
export function applyTextureSets(lib: MaterialLibrary, sets: Map<string, TextureSet>): void {
  for (const [key, mat] of lib.all()) {
    const spec = SPECS[key];
    if (!spec.texture) continue;
    const set = sets.get(spec.texture);
    if (!set) continue;
    const m = mat as MeshStandardMaterial;
    m.map = set.albedo;
    m.normalMap = set.normal;
    // 2K and 4K normals are ETC1S, which softens relief a little; compensate.
    const ns = (NORMAL_SCALE[key] ?? 1) * (set.res === '1k' ? 1 : 1.3);
    m.normalScale.set(ns, ns);
    m.roughnessMap = set.orm;
    m.aoMap = set.orm;
    m.aoMapIntensity = 1;
    m.roughness = ROUGHNESS[key] ?? 1;
    m.metalness = 0;
    const lt = LINEAR_TINT[key];
    m.color = lt ? new Color(lt[0], lt[1], lt[2]) : new Color(TINTS[key] ?? '#ffffff').multiplyScalar(GAIN[key] ?? 1);
    m.needsUpdate = true;
  }
}

export function disposeTextureSets(sets: Map<string, TextureSet>): void {
  for (const s of sets.values()) {
    s.albedo.dispose();
    s.normal.dispose();
    s.orm.dispose();
  }
}
