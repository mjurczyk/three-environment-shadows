import type { Camera, Mesh, Object3D, Scene, Sphere, WebGLRenderer } from 'three';

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
  /** Width and height of the primary lightmap atlas (charts seen by the camera) in texels. Default 1024. */
  atlasSize?: number;
  /** Width and height of the secondary lightmap atlas (other charts in view) in texels. Default: half of atlasSize. */
  secondaryAtlasSize?: number;
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
  /**
   * Whether the charts seen by the camera (ray test) go to the primary atlas, the other charts in view to the
   * secondary atlas. Default true.
   */
  visibleAtlas?: boolean;
  /** Width of the ray grid of the visibility test, the height follows the aspect. Default 384. */
  visibilityResolution?: number;
  /** Shadow strength, 0 to 1: higher ignores more of the weak occlusion. Default 0.5. */
  shadowBalance?: number;
  /** Whether moved meshes, a new environment or a new layout start a new bake. Default false. */
  autoUpdate?: boolean;
  /** The area that receives shadows. Default: the bounds of the meshes. */
  bounds?: Sphere;
  /** The meshes (Mesh, InstancedMesh, BatchedMesh). Default: all meshes of the scene that cast or receive shadows. */
  meshes?: Mesh[];
  /** Objects whose meshes (children included) do not cast shadows. They still receive shadows. Default: none. */
  exclude?: Iterable<Object3D>;
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
  /** The area that receives shadows, set when {@link ready} resolves if not given. */
  bounds: Sphere | null;
  /**
   * Objects whose meshes (children included) do not cast shadows. Changes apply to the next bake,
   * with `autoUpdate` a change starts one.
   */
  exclude: Set<Object3D>;
  /** Set to `true` to start a new bake, e.g. after a change of the options. */
  needsUpdate: boolean;

  /** Resolves when the meshes are unwrapped and the shadows are ready to bake. */
  readonly ready: Promise<this>;

  /** Bakes a few samples and swaps in finished lightmaps. Call it once per frame before rendering. */
  update(camera: Camera): void;

  /** Removes the patches from the materials and frees the GPU resources. */
  dispose(): void;
}
