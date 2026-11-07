import { EnvironmentShadowsBase } from './core/EnvironmentShadowsBase.js';
import { tslBackend } from './backends/tsl.js';

/**
 * Soft, colored shadows from the whole environment map (`scene.environment`), for WebGPURenderer
 * (WebGPU and its WebGL 2 fallback). Materials of the receivers must be node materials, e.g.
 * `MeshStandardNodeMaterial`. See `three-environment-shadows` for the WebGLRenderer version.
 *
 * ```js
 * import { EnvironmentShadows } from 'three-environment-shadows/webgpu';
 *
 * await renderer.init();
 *
 * const shadows = new EnvironmentShadows(renderer, scene);
 * await shadows.ready;
 *
 * renderer.setAnimationLoop(() => {
 *   shadows.update(camera);
 *   renderer.render(scene, camera);
 * });
 * ```
 */
export class EnvironmentShadows extends EnvironmentShadowsBase {
  /**
   * @param {WebGPURenderer} renderer - The renderer.
   * @param {Scene} scene - The scene. Its environment map is the light source.
   * @param {EnvironmentShadowsOptions} [options] - The options, see the properties of the same name.
   */
  constructor(renderer, scene, options = {}) {
    super(renderer, scene, options, tslBackend);
  }
}
