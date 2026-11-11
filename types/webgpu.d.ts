import type { Camera, Object3D, Scene, Sphere } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { EnvironmentShadowsOptions } from './index.js';

export type { EnvironmentShadowsOptions };

/**
 * Soft, colored shadows from the whole environment map (`scene.environment`), for WebGPURenderer
 * (WebGPU and its WebGL 2 fallback). Materials of the receivers must be node materials.
 */
export class EnvironmentShadows {
  constructor(renderer: WebGPURenderer, scene: Scene, options?: EnvironmentShadowsOptions);

  readonly isEnvironmentShadows: true;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;

  samplesPerFrame: number;
  samplesPerBake: number;
  fadeTime: number;
  atlasSize: number;
  secondaryAtlasSize: number;
  mapSize: number;
  shadowNoise: number;
  directionJitter: number;
  specularOcclusion: boolean;
  frustumAtlas: boolean;
  frustumMargin: number;
  visibleAtlas: boolean;
  visibilityResolution: number;
  shadowBalance: number;
  autoUpdate: boolean;
  bounds: Sphere | null;
  exclude: Set<Object3D>;
  needsUpdate: boolean;

  readonly ready: Promise<this>;

  update(camera: Camera): void;

  dispose(): void;
}
