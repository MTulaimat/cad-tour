import type { WebGLRenderer } from 'three';

export type Tier = 'low' | 'medium' | 'high';
export type TierSetting = Tier | 'auto';

export interface TierConfig {
  tier: Tier;
  mobile: boolean;
  /** Device pixel ratio cap before render scaling. */
  dprCap: number;
  /** Bounds for dynamic resolution, as a fraction of the capped DPR. */
  minScale: number;
  maxScale: number;
  shadows: boolean;
  shadowMapSize: number;
  shadowRadius: number;
  antialias: 'fxaa' | 'smaa';
  ao: boolean;
  /** 0 is off. */
  bloom: number;
  vignette: boolean;
  textureRes: '1k' | '2k';
  /** Stream 4K floor, wall and fabric maps after the tour starts (desktop High). */
  heroTextures: boolean;
  backplate: '2k' | '4k';
  pointLights: number;
  rectLights: number;
  /** Real refraction on glass (desktop High only); otherwise a cheap transparent pane. */
  transmissionGlass: boolean;
  probes: boolean;
  probeSize: number;
  anisotropy: number;
}

export function tierConfig(tier: Tier, mobile: boolean): TierConfig {
  switch (tier) {
    case 'low':
      return {
        tier,
        mobile,
        dprCap: mobile ? 1.5 : 1,
        minScale: 0.5,
        maxScale: 0.75,
        shadows: true,
        shadowMapSize: 1024,
        shadowRadius: 2,
        antialias: 'fxaa',
        ao: false,
        bloom: 0,
        vignette: false,
        textureRes: '1k',
        heroTextures: false,
        backplate: '2k',
        pointLights: 0,
        rectLights: 0,
        transmissionGlass: false,
        // Probes are a one-off capture; without them interiors take the HDRI's ground colour.
        probes: true,
        probeSize: 128,
        anisotropy: 2,
      };
    case 'medium':
      return {
        tier,
        mobile,
        dprCap: 2,
        minScale: 0.5,
        maxScale: 1,
        shadows: true,
        shadowMapSize: mobile ? 1024 : 2048,
        shadowRadius: 3,
        antialias: mobile ? 'fxaa' : 'smaa',
        ao: false,
        bloom: mobile ? 0 : 0.25,
        vignette: false,
        textureRes: mobile ? '1k' : '2k',
        heroTextures: false,
        backplate: mobile ? '2k' : '4k',
        pointLights: 3,
        rectLights: 0,
        transmissionGlass: false,
        probes: true,
        probeSize: 128,
        anisotropy: mobile ? 4 : 8,
      };
    case 'high':
      return {
        tier,
        mobile,
        dprCap: 2,
        minScale: 0.6,
        maxScale: 1,
        shadows: true,
        shadowMapSize: mobile ? 2048 : 4096,
        shadowRadius: 4,
        antialias: 'smaa',
        ao: true,
        bloom: 0.45,
        vignette: true,
        textureRes: '2k',
        heroTextures: !mobile,
        backplate: mobile ? '2k' : '4k',
        pointLights: 3,
        rectLights: 4,
        transmissionGlass: !mobile,
        probes: true,
        probeSize: 256,
        anisotropy: 8,
      };
  }
}

export function isMobileDevice(): boolean {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return coarse || /Android|iPhone|iPad|Mobile/i.test(ua);
}

export interface TierGuess {
  tier: Tier;
  reasons: string[];
  gpu: string;
}

/** First guess from device hints; the frame-time probe can lower it afterwards. */
export function detectTier(renderer: WebGLRenderer): TierGuess {
  const reasons: string[] = [];
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 8;
  const mobile = isMobileDevice();
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    gpu = '';
  }
  const g = gpu.toLowerCase();
  const software = /swiftshader|llvmpipe|software|basic render/.test(g);
  const strongDesktop = /rtx|radeon rx|geforce gtx 1[06-9]|apple m[1-9]|arc a/.test(g);
  let tier: Tier;
  if (software) {
    tier = 'low';
    reasons.push('software GPU');
  } else if (mobile) {
    tier = mem >= 6 && cores >= 6 ? 'medium' : 'low';
    reasons.push(`mobile, ${mem} GB, ${cores} cores`);
  } else if (strongDesktop || (mem >= 8 && cores >= 8)) {
    tier = 'high';
    reasons.push(strongDesktop ? 'discrete or Apple GPU' : `${mem} GB, ${cores} cores`);
  } else {
    tier = 'medium';
    reasons.push(`${mem} GB, ${cores} cores`);
  }
  return { tier, reasons, gpu };
}

export const lowerTier = (t: Tier): Tier => (t === 'high' ? 'medium' : 'low');

/**
 * Dynamic resolution: an exponential moving average of frame time with hysteresis.
 * Above 20 ms the render scale steps down; after a stable stretch under target it steps up.
 */
export class DynamicResolution {
  scale: number;
  private ema = 16.7;
  private stable = 0;
  private cooldown = 0;
  enabled = true;

  constructor(
    public min: number,
    public max: number,
    private target = 20,
  ) {
    this.scale = max;
  }

  setBounds(min: number, max: number): void {
    this.min = min;
    this.max = max;
    this.scale = Math.min(max, Math.max(min, this.scale));
  }

  /** Returns true when the scale changed. */
  update(frameMs: number): boolean {
    if (!this.enabled || frameMs <= 0 || frameMs > 250) return false;
    this.ema += (frameMs - this.ema) * 0.08;
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }
    if (this.ema > this.target && this.scale > this.min + 1e-3) {
      this.scale = Math.max(this.min, this.scale - 0.1);
      this.cooldown = 45;
      this.stable = 0;
      return true;
    }
    if (this.ema < this.target * 0.7) {
      this.stable++;
      if (this.stable > 180 && this.scale < this.max - 1e-3) {
        this.scale = Math.min(this.max, this.scale + 0.05);
        this.stable = 0;
        this.cooldown = 60;
        return true;
      }
    } else {
      this.stable = 0;
    }
    return false;
  }

  get frameTime(): number {
    return this.ema;
  }
}
