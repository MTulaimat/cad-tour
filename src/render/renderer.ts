import { NoToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';

/**
 * WebGL2 renderer. Tone mapping is off here because the post chain applies ACES once; output is
 * sRGB. Antialiasing is done in post (SMAA or FXAA), so the context is created without MSAA.
 */
export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  return renderer;
}
