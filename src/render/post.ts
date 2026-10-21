import { HalfFloatType, type Camera, type Scene, type WebGLRenderer } from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { TierConfig } from './quality';

/**
 * Post-processing chain. The scene renders linear HDR into a half-float buffer; ACES filmic tone
 * mapping and sRGB output happen exactly once, in the final effect pass. The renderer itself keeps
 * NoToneMapping so nothing is tone mapped twice.
 */
export class PostPipeline {
  readonly composer: EffectComposer;
  private renderPass: RenderPass;
  private ao: N8AOPostPass | null = null;
  private effectPass: EffectPass | null = null;
  private aaPass: EffectPass | null = null;
  private config: TierConfig;
  private width = 1;
  private height = 1;

  constructor(
    renderer: WebGLRenderer,
    private scene: Scene,
    private camera: Camera,
    config: TierConfig,
  ) {
    this.config = config;
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.rebuild(config);
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.renderPass.mainCamera = camera;
    if (this.ao) this.ao.camera = camera;
    if (this.effectPass) this.effectPass.mainCamera = camera;
    if (this.aaPass) this.aaPass.mainCamera = camera;
  }

  rebuild(config: TierConfig): void {
    this.config = config;
    if (this.ao) {
      this.composer.removePass(this.ao);
      this.ao.dispose();
      this.ao = null;
    }
    for (const pass of [this.effectPass, this.aaPass]) {
      if (!pass) continue;
      this.composer.removePass(pass);
      pass.dispose();
    }
    this.effectPass = null;
    this.aaPass = null;
    if (config.ao) {
      const ao = new N8AOPostPass(this.scene, this.camera, Math.max(1, this.width), Math.max(1, this.height));
      ao.configuration.aoRadius = 0.6;
      ao.configuration.distanceFalloff = 0.8;
      ao.configuration.intensity = 2.2;
      ao.configuration.halfRes = true;
      ao.configuration.gammaCorrection = false;
      ao.setQualityMode('Medium');
      this.ao = ao;
      this.composer.addPass(ao);
    }
    const effects: Effect[] = [];
    if (config.bloom > 0) {
      effects.push(new BloomEffect({ mipmapBlur: true, intensity: config.bloom, luminanceThreshold: 0.92, luminanceSmoothing: 0.25, radius: 0.7 }));
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    if (config.vignette) effects.push(new VignetteEffect({ offset: 0.32, darkness: 0.38 }));
    // Anti-aliasing runs on tone-mapped colors, last.
    const aa = config.antialias === 'smaa' ? new SMAAEffect({ preset: SMAAPreset.HIGH }) : new FXAAEffect();
    this.effectPass = new EffectPass(this.camera, ...effects);
    this.aaPass = new EffectPass(this.camera, aa);
    this.composer.addPass(this.effectPass);
    this.composer.addPass(this.aaPass);
    this.setSize(this.width, this.height);
  }

  get tier(): TierConfig {
    return this.config;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // The composer passes the drawing-buffer size (CSS size times pixel ratio) to every pass,
    // n8ao included; resizing passes here with CSS pixels would mismatch their buffers.
    this.composer.setSize(width, height, false);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
