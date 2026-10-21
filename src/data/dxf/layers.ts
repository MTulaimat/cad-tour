import type { DrawingModel, FloorAssignment, LayerInfo, LayerRole } from './types';

/**
 * Layer auto-detection by name (case-insensitive), English and Arabic, as in the plan:
 * walls WALL, A-WALL, MUR, جدار جدران حوائط; doors DOOR, A-DOOR, باب أبواب;
 * windows WIN, WINDOW, A-GLAZ, نافذة نوافذ شباك شبابيك; stairs STAIR, A-STRS, درج سلم سلالم;
 * furniture FURN, A-FURN, أثاث فرش. Room names and area lines go to "rooms".
 */
const RULES: { role: LayerRole; words: RegExp[] }[] = [
  { role: 'ignore', words: [/dim/, /anno/, /hatch-pat/, /grid/, /axis/, /title/, /viewport/, /defpoints/, /^xref/, /border/, /تخطيط/, /ابعاد/, /أبعاد/] },
  { role: 'windows', words: [/win/, /window/, /glaz/, /\bwdw\b/, /نافذة/, /نوافذ/, /شباك/, /شبابيك/] },
  { role: 'doors', words: [/door/, /\bdr\b/, /\bdoor/, /باب/, /أبواب/, /ابواب/] },
  { role: 'stairs', words: [/stair/, /strs/, /\bstr\b/, /step/, /درج/, /سلم/, /سلالم/] },
  { role: 'furniture', words: [/furn/, /fixt/, /equip/, /sanit/, /plumb/, /kitchen/, /appl/, /أثاث/, /اثاث/, /فرش/, /مفروشات/] },
  { role: 'rooms', words: [/room/, /area/, /space/, /label/, /name/, /text/, /\btxt\b/, /iden/, /zone/, /balc/, /rail/, /غرف/, /اسماء/, /أسماء/, /مساحات/, /نصوص/] },
  { role: 'walls', words: [/wall/, /\bmur/, /\bwal\b/, /partition/, /column/, /\bcol\b/, /جدار/, /جدران/, /حوائط/, /حائط/, /اعمدة/, /أعمدة/] },
];

/** Strips a floor prefix such as "L1_" or "GF-" before matching role keywords. */
export function stripFloorPrefix(name: string): string {
  return name.replace(/^(l\d+|level\s*\d+|f\d+|\d+f|gf|ff|sf|b\d+)[\s_\-.]+/i, '');
}

export function detectRole(name: string, layer?: LayerInfo): LayerRole {
  const n = stripFloorPrefix(name).toLowerCase();
  for (const rule of RULES) if (rule.words.some((w) => w.test(n))) return rule.role;
  // Unnamed layers ("0") with real geometry are usually where everything was drawn.
  if (layer && layer.total > 0 && (name === '0' || /^layer\s*\d*$/i.test(name))) return 'walls';
  if (layer && layer.total > 0 && (layer.counts.TEXT ?? 0) + (layer.counts.MTEXT ?? 0) === layer.total) return 'rooms';
  return layer && layer.total === 0 ? 'ignore' : 'ignore';
}

export function detectRoles(model: DrawingModel): Record<string, LayerRole> {
  const out: Record<string, LayerRole> = {};
  for (const l of model.layers) out[l.name] = l.frozen ? 'ignore' : detectRole(l.name, l);
  return out;
}

/**
 * Floors by layer prefix: if layers share prefixes like L1_, L2_ (or GF_/FF_, Level 1),
 * they are floors, ordered by their number.
 */
export function detectFloorPrefixes(model: DrawingModel): string[] | null {
  const found = new Map<string, number>();
  for (const l of model.layers) {
    if (l.total === 0) continue;
    const m = /^(l(\d+)|level\s*(\d+)|f(\d+)|(\d+)f|(gf)|(ff)|(sf))[\s_\-.]/i.exec(l.name);
    if (!m) continue;
    const prefix = l.name.slice(0, m[0].length);
    const rank = m[2] ?? m[3] ?? m[4] ?? m[5];
    const order = rank !== undefined ? Number(rank) : m[6] ? 0 : m[7] ? 1 : 2;
    const key = prefix.toUpperCase();
    if (!found.has(key)) found.set(key, order);
  }
  if (found.size < 2) return null;
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

export function detectFloors(model: DrawingModel): FloorAssignment {
  const prefixes = detectFloorPrefixes(model);
  return prefixes ? { mode: 'prefix', prefixes } : { mode: 'single' };
}

/** Which floor (index) a layer belongs to under a prefix assignment, or -1. */
export function floorOfLayer(name: string, prefixes: string[]): number {
  const up = name.toUpperCase();
  return prefixes.findIndex((p) => up.startsWith(p.toUpperCase()));
}

/** Mapping memory: stored per file content hash (SHA-256) in localStorage. */
const KEY = 'cad-tour:dxf-mapping:';

export interface SavedMapping {
  roles: Record<string, LayerRole>;
  hidden: string[];
  floors: FloorAssignment;
  units?: string;
  settings?: Record<string, number>;
}

export function loadMapping(hash: string): SavedMapping | null {
  try {
    const raw = localStorage.getItem(KEY + hash);
    return raw ? (JSON.parse(raw) as SavedMapping) : null;
  } catch {
    return null;
  }
}

export function saveMapping(hash: string, m: SavedMapping): void {
  try {
    localStorage.setItem(KEY + hash, JSON.stringify(m));
  } catch {
    // Storage unavailable: the mapping just isn't remembered.
  }
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
