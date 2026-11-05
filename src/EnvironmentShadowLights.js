import { DirectionalLight, Group, Object3D, Sphere, Vector3 } from 'three';
import { EnvironmentLightExtractor } from './EnvironmentLightExtractor.js';

// NOTE Larger PCF kernels show banding
const _MAX_SHADOW_RADIUS = 8;

const _direction = /*@__PURE__*/ new Vector3();
const _position = /*@__PURE__*/ new Vector3();

const getRoot = (object) => {
  let root = object;

  while (root.parent !== null) root = root.parent;

  return root;
};

// NOTE False while a loader has not filled the texture yet
const isLoaded = (texture) => {
  const image = texture.image;

  if (image === null || image === undefined) return false;
  if (Array.isArray(image)) return true;

  return image.width > 0 && image.height > 0 && (image.data === undefined || image.data.length > 0);
};

/**
 * Casts shadows from the light sources of `scene.environment`.
 *
 * The group reads the environment map of its scene, finds the light sources with
 * {@link EnvironmentLightExtractor}, and creates shadow casting {@link DirectionalLight}s for them.
 * It replaces `scene.environment` with a copy without the lights, so the scene is not lit twice,
 * and puts the original back when the group is removed from the scene or disposed.
 * `scene.background` does not change.
 *
 * ```js
 * import { EnvironmentShadowLights } from 'three-environment-shadows';
 *
 * scene.environment = hdri;
 *
 * const shadows = new EnvironmentShadowLights(scene);
 * shadows.bounds.set(new THREE.Vector3(0, 1, 0), 10); // the area that receives shadows
 * ```
 *
 * When `scene.environment` changes, the group finds the new light sources (in a Web Worker) and
 * dispatches a `change` event. It waits for textures that are still loading. Environment maps
 * without texel data on the CPU (PMREM render targets, cube textures) cast no shadows and log a
 * warning. After a change of the options, set {@link EnvironmentShadowLights#needsUpdate} to `true`.
 *
 * If the penumbra of a source is wider than one shadow map texel (a window, a softbox, a hazy sun),
 * the source is divided into up to `samples` parts, each with its own light. Sources that do not
 * get a shadow map from the `maxShadowMaps` budget still light the scene, without shadows.
 *
 * The lights are in world space, so the transformation of the group has no effect. They follow
 * `scene.environmentRotation`, `scene.environmentIntensity` and {@link EnvironmentShadowLights#bounds}.
 *
 * Performance notes:
 * - Each shadow map renders all shadow casters once per frame. For static scenes, set
 * `renderer.shadowMap.autoUpdate` to `false`.
 * - Each shadow map uses one texture unit in all lit materials. WebGL guarantees only 16 per shader.
 * - The number of lights and shadow maps is part of the shader. Materials compile again when it changes.
 * - One shadow map covers the whole bounds. For large scenes, use `SunLight` from
 * `three/addons/lights/SunLight.js` with the direction and intensity of the strongest light instead.
 *
 * @augments Group
 */
class EnvironmentShadowLights extends Group {
  /**
   * Constructs a new environment shadow lights group and adds it to the scene.
   *
   * @param {?Scene} [scene=null] - The scene. The group reads the environment map of the scene that contains it.
   * @param {Object} [options] - The options, see the properties of the same name.
   */
  constructor(scene = null, options = {}) {
    super();

    /**
     * This flag can be used for type testing.
     *
     * @type {boolean}
     * @readonly
     * @default true
     */
    this.isEnvironmentShadowLights = true;

    this.type = 'EnvironmentShadowLights';

    /**
     * The maximum number of lights.
     *
     * @type {number}
     * @default 2
     */
    this.maxLights = options.maxLights ?? 2;

    /**
     * Texels brighter than this factor times the mean radiance are part of a light.
     *
     * @type {number}
     * @default 8
     */
    this.threshold = options.threshold ?? 8;

    /**
     * The minimum fraction of the total energy a light must emit.
     *
     * @type {number}
     * @default 0.05
     */
    this.minEnergy = options.minEnergy ?? 0.05;

    /**
     * The minimum elevation (in radians) of a light, in the space of the environment map.
     *
     * @type {number}
     * @default -Math.PI/2
     */
    this.minElevation = options.minElevation ?? -Math.PI / 2;

    /**
     * The width of the grid used to group bright texels into regions.
     *
     * @type {number}
     * @default 512
     */
    this.resolution = options.resolution ?? 512;

    /**
     * The maximum number of shadow casting lights per light source.
     *
     * @type {number}
     * @default 4
     */
    this.samples = options.samples ?? 4;

    /**
     * The maximum number of shadow maps of all light sources.
     *
     * @type {number}
     * @default 4
     */
    this.maxShadowMaps = options.maxShadowMaps ?? 4;

    /**
     * The shadow map size of each light.
     *
     * @type {number}
     * @default 1024
     */
    this.mapSize = options.mapSize ?? 1024;

    /**
     * The typical distance between shadow casters and receivers, relative to the bounds radius.
     * It defines the shadow blur.
     *
     * @type {number}
     * @default 0.1
     */
    this.relativeOccluderDistance = options.relativeOccluderDistance ?? 0.1;

    /**
     * Set to `true` to find the light sources again, e.g. after a change of the options.
     *
     * @type {boolean}
     * @default false
     */
    this.needsUpdate = false;

    /**
     * The area that receives shadows, in world space.
     *
     * @type {Sphere}
     */
    this.bounds = new Sphere(new Vector3(), 10);

    /**
     * The light sources of the environment map, or `null` before they are found.
     *
     * @type {?{lights: Array<EnvironmentLightExtractor~ExtractedLight>, directionality: number, dominance: number, threshold: number}}
     * @readonly
     */
    this.result = null;

    /**
     * The target of all lights, at the center of the bounds.
     *
     * @type {Object3D}
     * @readonly
     */
    this.target = new Object3D();
    this.target.matrixAutoUpdate = false;
    this.target.matrixWorldAutoUpdate = false;
    this.add(this.target);

    /**
     * The lights. The shadow casting lights come first.
     *
     * @type {Array<DirectionalLight>}
     * @readonly
     */
    this.lights = [];

    // NOTE The source part of each light
    this._parts = [];

    // NOTE The environment map of the lights, its copy without the lights, and the scene that uses the copy
    this._source = null;
    this._sourceVersion = -1;
    this._residual = null;
    this._scene = null;

    // NOTE The texture and version of the last extraction that has not finished or failed
    this._request = null;

    this.addEventListener('removed', () => this._restoreEnvironment());

    if (scene !== null) scene.add(this);
  }

  /**
   * Updates the world matrices of the group, reads the environment map of the scene and positions
   * the lights in world space.
   *
   * @param {boolean} [force=false] - When set to `true`, a recomputation of world matrices is forced even
   * when {@link Object3D#matrixWorldNeedsUpdate} is `false`.
   */
  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);

    const scene = getRoot(this);

    if (scene.isScene) this._syncEnvironment(scene);

    const rotation = scene.isScene ? scene.environmentRotation : null;
    const intensity = scene.isScene ? scene.environmentIntensity : 1;

    const { center, radius } = this.bounds;

    this.target.position.copy(center);
    this.target.matrix.makeTranslation(center);
    this.target.matrixWorld.copy(this.target.matrix);

    const texelSize = (2 * radius) / this.mapSize;

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const part = this._parts[i];

      _direction.copy(part.direction);

      if (rotation !== null) _direction.applyEuler(rotation);

      _position
        .copy(_direction)
        .multiplyScalar(2 * radius)
        .add(center);

      light.position.copy(_position);
      light.matrix.makeTranslation(_position);
      light.matrixWorld.copy(light.matrix);
      light.intensity = part.intensity * intensity;

      if (light.castShadow) {
        const camera = light.shadow.camera;

        camera.left = -radius;
        camera.right = radius;
        camera.top = radius;
        camera.bottom = -radius;
        camera.near = radius;
        camera.far = 3 * radius;
        camera.updateProjectionMatrix();

        light.shadow.normalBias = texelSize;
      }
    }
  }

  copy(source, recursive = true) {
    super.copy(source, false);

    this.maxLights = source.maxLights;
    this.threshold = source.threshold;
    this.minEnergy = source.minEnergy;
    this.minElevation = source.minElevation;
    this.resolution = source.resolution;
    this.samples = source.samples;
    this.maxShadowMaps = source.maxShadowMaps;
    this.mapSize = source.mapSize;
    this.relativeOccluderDistance = source.relativeOccluderDistance;
    this.bounds.copy(source.bounds);

    // NOTE The lights and the target belong to the group, the copy finds its own lights
    if (recursive) {
      for (const child of source.children) {
        if (child === source.target || source.lights.includes(child)) continue;

        this.add(child.clone());
      }
    }

    return this;
  }

  /**
   * Puts the original environment map back, frees the GPU-related resources and removes the group
   * from its parent.
   */
  dispose() {
    this._restoreEnvironment();
    this._clear();
    this.removeFromParent();
  }

  _syncEnvironment(scene) {
    let environment = scene.environment;

    if (environment !== null && environment === this._residual) {
      // NOTE The copy without the lights is in use, update it when its source changes
      if (!this.needsUpdate && this._source.version === this._sourceVersion) return;

      environment = this._source;
    } else if (
      environment !== null &&
      environment === this._source &&
      this._residual !== null &&
      !this.needsUpdate &&
      environment.version === this._sourceVersion
    ) {
      // NOTE The group is in the scene again, use the same lights
      scene.environment = this._residual;
      this._scene = scene;
      return;
    }

    const request = this._request;

    // NOTE A different environment map, the lights of the previous one are not correct
    if (environment !== this._source && (request === null || environment !== request.texture)) {
      this._clear();
    }

    if (environment === null || !isLoaded(environment)) return;

    if (
      request !== null &&
      request.texture === environment &&
      request.version === environment.version &&
      !this.needsUpdate
    ) {
      return;
    }

    this._extract(scene, environment);
  }

  _extract(scene, environment) {
    const request = { texture: environment, version: environment.version };

    this.needsUpdate = false;
    this._request = request;

    EnvironmentLightExtractor.extract(environment, {
      maxLights: this.maxLights,
      threshold: this.threshold,
      minEnergy: this.minEnergy,
      minElevation: this.minElevation,
      samples: this.samples,
      resolution: this.resolution,
    }).then(
      (result) => {
        // NOTE A newer extraction or dispose() replaced this one
        if (this._request !== request) {
          result.texture.dispose();
          return;
        }

        this._request = null;
        this._apply(scene, request, result);
      },
      (error) => {
        // NOTE The request stays, so the same texture version is not extracted again
        if (this._request === request) console.warn(error.message);
      },
    );
  }

  _apply(scene, request, result) {
    const previous = this._residual;
    const environment = scene.environment;

    this._source = request.texture;
    this._sourceVersion = request.version;
    this._residual = result.texture;

    this.result = {
      lights: result.lights,
      directionality: result.directionality,
      dominance: result.dominance,
      threshold: result.threshold,
    };

    this._setLights(result.lights);

    // NOTE The group may have left the scene while the extraction ran
    if (getRoot(this) === scene && (environment === this._source || environment === previous)) {
      scene.environment = this._residual;
      this._scene = scene;
    }

    if (previous !== null) previous.dispose();

    this.dispatchEvent({ type: 'change' });
  }

  _restoreEnvironment() {
    const scene = this._scene;

    if (scene !== null && scene.environment === this._residual) scene.environment = this._source;

    this._scene = null;
  }

  _clear() {
    this._request = null;

    if (this._residual !== null) this._residual.dispose();

    this._source = null;
    this._sourceVersion = -1;
    this._residual = null;
    this._scene = null;

    if (this.result === null && this.lights.length === 0) return;

    this.result = null;
    this._setLights([]);
    this.dispatchEvent({ type: 'change' });
  }

  _setLights(sources) {
    for (const light of this.lights) {
      this.remove(light);
      light.dispose();
    }

    this.lights.length = 0;
    this._parts.length = 0;

    // NOTE The penumbra width of a source with the given cone half-angle, in shadow map texels
    const getPenumbra = (coneAngle) =>
      (Math.tan(coneAngle) * this.relativeOccluderDistance * this.mapSize) / 2;

    // NOTE One shadow map per source first, then more for the sources with a wide penumbra
    const shadowMaps = sources.map(() => 0);

    let budget = this.maxShadowMaps;

    for (let i = 0; i < sources.length && budget > 0; i++) {
      shadowMaps[i] = 1;
      budget--;
    }

    for (let i = 0; i < sources.length && budget > 0; i++) {
      const source = sources[i];

      if (shadowMaps[i] === 0 || getPenumbra(source.coneAngle) <= 1) continue;

      const extra = Math.min(Math.min(this.samples, source.partitions.length) - 1, budget);

      shadowMaps[i] += extra;
      budget -= extra;
    }

    for (let i = 0; i < sources.length; i++) {
      const castShadow = shadowMaps[i] > 0;
      const parts = sources[i].partitions[Math.max(1, shadowMaps[i]) - 1];

      for (const part of parts) {
        const light = new DirectionalLight(part.color, part.intensity);
        light.matrixAutoUpdate = false;
        light.matrixWorldAutoUpdate = false;
        light.target = this.target;

        if (castShadow) {
          light.castShadow = true;
          light.shadow.mapSize.setScalar(this.mapSize);
          light.shadow.radius = Math.min(
            _MAX_SHADOW_RADIUS,
            Math.max(1, getPenumbra(part.coneAngle)),
          );
        }

        this.lights.push(light);
        this._parts.push(part);
        this.add(light);
      }
    }
  }
}

export { EnvironmentShadowLights };
