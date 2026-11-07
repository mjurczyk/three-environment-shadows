import type { Camera, Mesh, Scene, Sphere, WebGLRenderer } from 'three';

/**
 * Options of {@link EnvironmentShadows}, see the properties of the same name.
 */
export interface EnvironmentShadowsOptions {
  /** Shadow maps rendered per frame while a bake runs. Default 24. */
  samplesPerFrame?: number;
  /** Samples (shadow maps) per bake. More is smoother and slower to update. Default 512. */
  samplesPerBake?: number;
  /** Crossfade time in seconds from the old to the new lightmap. Default 0.3. */
  fadeTime?: number;
  /** Width and height of the lightmap atlas in texels. Default 1024. */
  atlasSize?: number;
  /** Width and height of the shadow map of each sample. Default 512. */
  mapSize?: number;
  /** Random offset of each shadow lookup, in shadow map texels. Softens stair-stepped edges. Default 8. */
  shadowNoise?: number;
  /** Random tilt of each sample direction, in degrees. Blends the shadows of neighboring samples. Default 2. */
  directionJitter?: number;
  /** Whether the baked visibility also darkens environment reflections. Default true. */
  specularOcclusion?: boolean;
  /** Whether only the meshes in the camera frustum get a place in the atlas. Default true. */
  frustumAtlas?: boolean;
  /** Growth of the bounding spheres for the frustum test, in percent. Default 20. */
  frustumMargin?: number;
  /** The area that receives shadows. Default: the bounds of the meshes. */
  bounds?: Sphere;
  /** The meshes. Default: all meshes of the scene that cast or receive shadows. */
  meshes?: Mesh[];
  /** URL of xatlas-web.wasm. Default: next to the bundle. */
  xatlasWasmUrl?: string;
}

/**
 * Soft, colored shadows from the whole environment map (`scene.environment`), for WebGLRenderer.
 * For WebGPURenderer, import it from `three-environment-shadows/webgpu`.
 */
export class EnvironmentShadows {
  constructor(renderer: WebGLRenderer, scene: Scene, options?: EnvironmentShadowsOptions);

  readonly isEnvironmentShadows: true;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;

  samplesPerFrame: number;
  samplesPerBake: number;
  fadeTime: number;
  atlasSize: number;
  mapSize: number;
  shadowNoise: number;
  directionJitter: number;
  specularOcclusion: boolean;
  frustumAtlas: boolean;
  frustumMargin: number;
  /** The area that receives shadows, set when {@link ready} resolves if not given. */
  bounds: Sphere | null;
  /** Set to `true` to start a new bake, e.g. after a change of the options. */
  needsUpdate: boolean;

  /** Resolves when the meshes are unwrapped and the shadows are ready to bake. */
  readonly ready: Promise<this>;

  /** Bakes a few samples and swaps in finished lightmaps. Call it once per frame before rendering. */
  update(camera: Camera): void;

  /** Removes the patches from the materials and frees the GPU resources. */
  dispose(): void;
}
