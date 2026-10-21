import {
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  PMREMGenerator,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  type DataTexture,
  type WebGLRenderer,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export interface SunInfo {
  direction: Vector3;
  intensity: number;
  color: string;
}

export interface Environment {
  envMap: Texture;
  /** Yaw applied to the sky so its city view and sun suit the plan (set on scene.environmentRotation). */
  rotation: number;
  /** PMREM cube size, which probes must match to share the shader's cube-UV constants. */
  cubeSize: number;
  /** Sky and distant city, used as scene.background (rotated by `rotation`). */
  backplate: Texture;
  sun: SunInfo;
  /** Rebuilds the PMREM from the kept HDR (after a WebGL context restore). */
  regenerate(renderer: WebGLRenderer): Texture;
  dispose(): void;
}

export interface EnvironmentUrls {
  hdr: string;
  backplate: string;
  sun: string;
}

/**
 * Sky yaw in radians. Rhodes Memorial's city view sits around azimuth 110 degrees and its sun at
 * 47 degrees (atan2(z, x)); turning the sky by 100 degrees puts the city out of the balcony (east)
 * and the afternoon sun through the north windows. Rotating a direction by +yaw about Y lowers its
 * azimuth by yaw.
 */
export const SKY_ROTATION = (100 * Math.PI) / 180;

/**
 * Lighting comes from a small 1K HDR through PMREM; the view through the windows is a separate,
 * sharper LDR backplate (2K or 4K). The near ground is real geometry (see ground.ts) that fades
 * into this backplate, so looking down from the balcony never shows the HDRI's own foreground.
 */
export async function loadEnvironment(
  renderer: WebGLRenderer,
  urls: EnvironmentUrls,
  onProgress: (part: 'hdr' | 'backplate', fraction: number) => void = () => {},
): Promise<Environment> {
  const pmrem = new PMREMGenerator(renderer);
  const [hdr, backplate, sunJson] = await Promise.all([
    new HDRLoader().loadAsync(urls.hdr, (e) => e.total && onProgress('hdr', e.loaded / e.total)) as Promise<DataTexture>,
    new TextureLoader().loadAsync(urls.backplate, (e) => e.total && onProgress('backplate', e.loaded / e.total)),
    fetch(urls.sun)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  hdr.mapping = EquirectangularReflectionMapping;
  const cubeSize = Math.max(16, Math.round(hdr.image.width / 4));
  let target = pmrem.fromEquirectangular(hdr);
  pmrem.dispose();

  backplate.mapping = EquirectangularReflectionMapping;
  backplate.colorSpace = SRGBColorSpace;
  backplate.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  backplate.generateMipmaps = true;
  backplate.minFilter = LinearMipmapLinearFilter;
  backplate.magFilter = LinearFilter;

  const d = Array.isArray(sunJson?.direction) ? new Vector3(...(sunJson.direction as [number, number, number])) : new Vector3(0.55, 0.62, 0.56);
  d.applyAxisAngle(new Vector3(0, 1, 0), SKY_ROTATION);
  const env: Environment = {
    envMap: target.texture,
    rotation: SKY_ROTATION,
    cubeSize,
    backplate,
    sun: {
      direction: d.normalize(),
      intensity: typeof sunJson?.suggestedIntensity === 'number' ? sunJson.suggestedIntensity : 4.9,
      color: typeof sunJson?.color === 'string' ? sunJson.color : '#fff6ea',
    },
    regenerate(r: WebGLRenderer) {
      const g = new PMREMGenerator(r);
      target.dispose();
      hdr.needsUpdate = true;
      target = g.fromEquirectangular(hdr);
      g.dispose();
      env.envMap = target.texture;
      return target.texture;
    },
    dispose() {
      target.dispose();
      hdr.dispose();
      backplate.dispose();
    },
  };
  return env;
}
