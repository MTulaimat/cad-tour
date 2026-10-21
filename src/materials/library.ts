import { Color, DoubleSide, Material, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import type { MaterialKey } from './keys';

/**
 * Material keys to PBR materials, Scandinavian light palette.
 * Base parameters live here; textures.ts attaches the KTX2 maps per quality tier.
 */
interface Spec {
  color: string;
  roughness: number;
  metalness?: number;
  /** Texture set from public/textures, if any. */
  texture?: string;
  envIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  side?: 'double';
  physical?: boolean;
}

export const SPECS: Record<MaterialKey, Spec> = {
  'wall-interior': { color: '#f3efe8', roughness: 0.92, texture: 'plaster' },
  'wall-exterior': { color: '#e6e1d8', roughness: 0.95, texture: 'exterior' },
  ceiling: { color: '#f7f5f1', roughness: 0.95, texture: 'plaster' },
  'floor-oak': { color: '#d9bf98', roughness: 0.55, texture: 'oak' },
  'floor-tile': { color: '#e9e7e2', roughness: 0.35, texture: 'tile' },
  'floor-concrete': { color: '#b9b6b0', roughness: 0.85, texture: 'concrete' },
  'slab-edge': { color: '#d8d3ca', roughness: 0.9, texture: 'exterior' },
  skirting: { color: '#f4f2ee', roughness: 0.5 },
  trim: { color: '#f6f4f0', roughness: 0.6 },
  'door-frame': { color: '#f4f2ee', roughness: 0.45 },
  'door-leaf': { color: '#f2f0ec', roughness: 0.4 },
  'window-frame': { color: '#f1f1ef', roughness: 0.4 },
  glass: { color: '#dfe9ee', roughness: 0.02, metalness: 0, transparent: true, opacity: 0.14, side: 'double', physical: true },
  sill: { color: '#efece6', roughness: 0.35 },
  'sill-exterior': { color: '#b8b9ba', roughness: 0.35, metalness: 0.8 },
  'stair-wood': { color: '#d6b98f', roughness: 0.5, texture: 'oak' },
  'stair-paint': { color: '#f3f1ed', roughness: 0.5 },
  'metal-brushed': { color: '#c9cbcd', roughness: 0.32, metalness: 1 },
  'metal-dark': { color: '#2c2d2f', roughness: 0.45, metalness: 0.6 },
  chrome: { color: '#e8e9ea', roughness: 0.08, metalness: 1 },
  fabric: { color: '#c5c5c3', roughness: 0.95, texture: 'fabric' },
  'fabric-accent': { color: '#8f9b93', roughness: 0.95, texture: 'fabric' },
  linen: { color: '#f2f0eb', roughness: 0.95, texture: 'fabric' },
  mirror: { color: '#ffffff', roughness: 0.02, metalness: 1, envIntensity: 1.2 },
  'wood-light': { color: '#d8bc93', roughness: 0.5, texture: 'oak' },
  'lacquer-white': { color: '#f4f3f0', roughness: 0.3 },
  'lacquer-grey': { color: '#b9bab8', roughness: 0.45 },
  'stone-white': { color: '#ecebe7', roughness: 0.25 },
  ceramic: { color: '#f7f7f5', roughness: 0.12 },
  rug: { color: '#d9d3c7', roughness: 1, texture: 'fabric' },
  plant: { color: '#4f6f3d', roughness: 0.7 },
  pot: { color: '#c99f7d', roughness: 0.8 },
  'lamp-shade': { color: '#f6f1e6', roughness: 0.9, emissive: '#fff2dc', emissiveIntensity: 0.35, side: 'double' },
  'black-glass': { color: '#101112', roughness: 0.08, metalness: 0.2 },
  'facade-glass': { color: '#3a4550', roughness: 0.15, metalness: 0.6 },
  mannequin: { color: '#9c9c9a', roughness: 0.75 },
};

export class MaterialLibrary {
  private cache = new Map<MaterialKey, Material>();

  get = (key: MaterialKey): Material => {
    let m = this.cache.get(key);
    if (!m) {
      m = this.create(key);
      this.cache.set(key, m);
    }
    return m;
  };

  private create(key: MaterialKey): Material {
    const s = SPECS[key];
    const params = {
      color: new Color(s.color),
      roughness: s.roughness,
      metalness: s.metalness ?? 0,
      transparent: s.transparent ?? false,
      opacity: s.opacity ?? 1,
      side: s.side === 'double' ? DoubleSide : undefined,
      emissive: s.emissive ? new Color(s.emissive) : undefined,
      emissiveIntensity: s.emissiveIntensity ?? 1,
      envMapIntensity: s.envIntensity ?? 1,
    };
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    const m = s.physical ? new MeshPhysicalMaterial(clean) : new MeshStandardMaterial(clean);
    m.name = key;
    if (s.transparent) m.depthWrite = false;
    return m;
  }

  all(): [MaterialKey, Material][] {
    return [...this.cache.entries()];
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
