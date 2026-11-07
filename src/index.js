import { EnvironmentShadowsBase } from './core/EnvironmentShadowsBase.js';
import { glslBackend } from './backends/glsl.js';

/**
 * Soft, colored shadows from the whole environment map (`scene.environment`), for WebGLRenderer.
 *
 * The environment is sampled by energy: each sample is a directional light with one shadow map. The
 * shadowed light of hundreds of samples is accumulated in a lightmap atlas of the meshes that receive
 * shadows, and replaces the diffuse environment light of their materials. The lightmap does not depend
 * on the camera. When meshes move or the environment changes, a new lightmap bakes in the background and
 * crossfades in when it is done. Only the meshes in the camera frustum get a place in the atlas.
 *
 * ```js
 * import { EnvironmentShadows } from 'three-environment-shadows';
 *
 * scene.environment = hdri; // equirectangular, e.g. from HDRLoader or UltraHDRLoader
 *
 * mesh.castShadow = true;
 * mesh.receiveShadow = true;
 *
 * const shadows = new EnvironmentShadows(renderer, scene);
 * await shadows.ready;
 *
 * renderer.setAnimationLoop(() => {
 *   shadows.update(camera);
 *   renderer.render(scene, camera);
 * });
 * ```
 *
 * For WebGPURenderer, import it from `three-environment-shadows/webgpu`.
 */
export class EnvironmentShadows extends EnvironmentShadowsBase {
  /**
   * @param {WebGLRenderer} renderer - The renderer.
   * @param {Scene} scene - The scene. Its environment map is the light source.
   * @param {EnvironmentShadowsOptions} [options] - The options, see the properties of the same name.
   */
  constructor(renderer, scene, options = {}) {
    super(renderer, scene, options, glslBackend);
  }
}
