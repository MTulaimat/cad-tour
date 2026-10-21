import type { TierSetting } from '../render/quality';

export interface Settings {
  quality: TierSetting;
  /** Manual render scale; null lets dynamic resolution decide. */
  renderScale: number | null;
  sensitivity: number;
  invertY: boolean;
  leftHanded: boolean;
  minimap: boolean;
}

const KEY = 'cad-tour:settings';

export const DEFAULTS: Settings = {
  quality: 'auto',
  renderScale: null,
  sensitivity: 0.0022,
  invertY: false,
  leftHanded: false,
  minimap: true,
};

/** Settings persisted in localStorage; every access is guarded so private modes still work. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<Settings>;
    return {
      quality: ['auto', 'low', 'medium', 'high'].includes(v.quality as string) ? (v.quality as TierSetting) : DEFAULTS.quality,
      renderScale: typeof v.renderScale === 'number' && v.renderScale >= 0.5 && v.renderScale <= 1 ? v.renderScale : null,
      sensitivity: typeof v.sensitivity === 'number' && v.sensitivity > 0.0003 && v.sensitivity < 0.01 ? v.sensitivity : DEFAULTS.sensitivity,
      invertY: v.invertY === true,
      leftHanded: v.leftHanded === true,
      minimap: v.minimap !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); settings then last a session.
  }
}
