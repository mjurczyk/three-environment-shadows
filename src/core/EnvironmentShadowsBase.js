import {
  BasicShadowMap,
  Box3,
  Color,
  DirectionalLight,
  Frustum,
  HalfFloatType,
  LinearFilter,
  MathUtils,
  Matrix4,
  Mesh,
  NearestFilter,
  Object3D,
  OrthographicCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { createEnvironmentSampler, downsampleEquirect, halton } from './sampler.js';
import { setLayout, unwrapMeshes } from './unwrap.js';
import { createPacker } from './packer.js';
import { createVisibility } from './visibility.js';

// NOTE Layout attributes of the lightmap slots A and B
const SLOTS = ['lightmapUvA', 'lightmapUvB'];

const _box = /*@__PURE__*/ new Box3();
const _sphere = /*@__PURE__*/ new Sphere();
const _matrix = /*@__PURE__*/ new Matrix4();
const _frustum = /*@__PURE__*/ new Frustum();
const _clearColor = /*@__PURE__*/ new Color();
const _axis = /*@__PURE__*/ new Vector3();
const _tangent = /*@__PURE__*/ new Vector3();
const _bitangent = /*@__PURE__*/ new Vector3();

// NOTE Tilts the direction by a random angle, uniform over a cone with the given half-angle
function jitterDirection(direction, halfAngle, u1, u2) {
  if (halfAngle <= 0) return direction;

  _axis.copy(direction);
  _tangent
    .set(Math.abs(_axis.y) < 0.99 ? 0 : 1, Math.abs(_axis.y) < 0.99 ? 1 : 0, 0)
    .cross(_axis)
    .normalize();
  _bitangent.crossVectors(_axis, _tangent);

  const cosTheta = 1 - u2 * (1 - Math.cos(halfAngle));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = 2 * Math.PI * u1;

  return direction
    .copy(_axis)
    .multiplyScalar(cosTheta)
    .addScaledVector(_tangent, sinTheta * Math.cos(phi))
    .addScaledVector(_bitangent, sinTheta * Math.sin(phi))
    .normalize();
}

const makeTarget = (size, type, filter) =>
  new WebGLRenderTarget(size, size, {
    type,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
    generateMipmaps: false,
  });

/**
 * Renderer-independent part of {@link EnvironmentShadows}, see the entry points for the docs.
 * A backend (GLSL or TSL) creates the materials and renders the passes.
 *
 * @private
 */
export class EnvironmentShadowsBase {
  constructor(renderer, scene, options = {}, backend) {
    this.isEnvironmentShadows = true;

    this.renderer = renderer;
    this.scene = scene;

    this.samplesPerFrame = options.samplesPerFrame ?? 24;
    this.samplesPerBake = options.samplesPerBake ?? 512;
    this.fadeTime = options.fadeTime ?? 0.3;
    this.atlasSize = options.atlasSize ?? 1024;
    this.mapSize = options.mapSize ?? 512;
    this.shadowNoise = options.shadowNoise ?? 8;
    this.directionJitter = options.directionJitter ?? 2;
    this.specularOcclusion = options.specularOcclusion ?? true;
    this.shadowBalance = options.shadowBalance ?? 0.5;
    this.frustumAtlas = options.frustumAtlas ?? true;
    this.frustumMargin = options.frustumMargin ?? 20;
    this.visibleAtlas = options.visibleAtlas ?? false;
    this.visibilityResolution = options.visibilityResolution ?? 384;
    this.visibleScale = options.visibleScale ?? 2;
    this.bounds = options.bounds ? options.bounds.clone() : null;
    this.needsUpdate = false;
    // NOTE false: after the first bake, new bakes only with needsUpdate (or a new atlas or shadow map size)
    this.autoUpdate = options.autoUpdate ?? false;

    this._backend = backend;
    this._xatlasWasmUrl =
      options.xatlasWasmUrl ?? new URL('./xatlas-web.wasm', import.meta.url).href;
    this._disposed = false;
    this._initialized = false;

    /**
     * Resolves when the meshes are unwrapped and the shadows are ready to bake.
     *
     * @type {Promise<EnvironmentShadowsBase>}
     */
    this.ready = this._init(options.meshes ?? null);
  }

  async _init(meshes) {
    const list = meshes ?? [];

    if (meshes === null) this.scene.traverse((object) => object.isMesh && list.push(object));

    this.scene.updateMatrixWorld();

    this._receivers = list.filter((mesh) => mesh.receiveShadow);
    this._meshes = list.filter((mesh) => mesh.receiveShadow || mesh.castShadow);

    await unwrapMeshes(
      this._receivers,
      this._meshes.filter((mesh) => !mesh.receiveShadow),
      this._xatlasWasmUrl,
    );

    if (this._disposed) return this;

    if (this.bounds === null) {
      _box.makeEmpty();

      for (const mesh of this._meshes) _box.expandByObject(mesh);

      this.bounds = _box.isEmpty()
        ? new Sphere(new Vector3(), 1)
        : _box.getBoundingSphere(new Sphere());
    }

    const backend = this._backend;
    const renderer = this.renderer;

    // NOTE Bake scene: proxies share the geometry, their transforms are a snapshot taken at bake start
    this._bakeScene = new Scene();
    // NOTE One camera per sample of a frame: WebGPURenderer renders a shadow map at most once per frame and camera.
    // The cameras are the same, the bake draws in lightmap space and only uses them for view space normals.
    this._bakeCameras = [];
    this._bake = backend.createBakeMaterial();

    this._proxies = this._meshes.map((mesh) => {
      const proxy = new Mesh(mesh.geometry, this._bake.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrixWorldAutoUpdate = false;
      proxy.frustumCulled = false;
      proxy.castShadow = mesh.castShadow;
      proxy.receiveShadow = true;
      this._bakeScene.add(proxy);
      return proxy;
    });

    this._light = new DirectionalLight(0xffffff, 1);
    this._light.castShadow = true;
    this._light.shadow.mapSize.setScalar(this.mapSize);
    this._lightTarget = new Object3D();
    this._light.target = this._lightTarget;
    this._bakeScene.add(this._light, this._lightTarget);

    this._sumType = backend.getSumType(renderer);
    this._display = backend.createDisplay();
    this._createTargets();

    this._packer = createPacker(this._meshes);

    // NOTE Charts seen by the camera (visibleAtlas): masks of the last visibility test and of the latest layout
    this._visibility = createVisibility(this._meshes);
    this._chartMasks = null;
    this._layoutMasks = null;
    this._visibilityMatrix = new Matrix4();
    this._cameraMatrix = new Matrix4();
    this._visibilityRequest = null;
    this._visibilitySerial = 0;
    this._visibilityTime = -Infinity;
    this._visibilityStale = false;
    this._moving = false;
    this._lastMatrices = this._meshes.map((mesh) => mesh.matrixWorld.clone());

    // NOTE Layouts (per mesh atlas UVs or null): the latest packed one, the one of the bake in progress and the
    // one of the front lightmap. Keys name the visible set and atlas size a layout was packed for.
    this._layout = null;
    this._layoutKey = null;
    this._layoutPending = false;
    this._bakeKey = null;
    this._bakeLayout = this._meshes.map(() => null);
    this._visible = this._meshes.map(() => true);
    this._visibleKey = '';

    this._environment = null;
    this._environmentVersion = -1;
    this._sample = null;
    this._sequence = 0;
    this._baking = false;
    this._dirty = false;
    this._hasFront = false;
    this._front = 0;
    this._count = 0;
    this._bakeSamples = this.samplesPerBake;
    this._bakeAtlasSize = this.atlasSize;
    this._bakeMapSize = this.mapSize;
    this._fade = 1;
    this._lastTime = null;

    for (const mesh of this._receivers) this._patch(mesh.material);

    this._initialized = true;

    return this;
  }

  _patch(material) {
    const materials = Array.isArray(material) ? material : [material];

    for (const m of materials) this._display.patch(m);
  }

  _createTargets() {
    const size = this.atlasSize;

    this._sumTarget = makeTarget(size, this._sumType, NearestFilter);
    // NOTE Two fixed lightmap slots (A, B), each with its own layout attribute. A finished bake goes into the
    // slot behind the front one, then the front flips. The textures never change, only uniforms do.
    this._lightmaps = [
      makeTarget(size, HalfFloatType, LinearFilter),
      makeTarget(size, HalfFloatType, LinearFilter),
    ];
    this._front = 0;
    this._finalize = this._backend.createFinalize(this._sumTarget.texture, size);

    const uniforms = this._display.uniforms;
    uniforms.a.value = this._lightmaps[0].texture;
    uniforms.b.value = this._lightmaps[1].texture;
    uniforms.frontIsA.value = 1;
    uniforms.valid.value = 0;

    // NOTE New textures need new bindings in materials that are already built
    this._display.refresh();
  }

  _disposeTargets() {
    this._sumTarget.dispose();
    for (const target of this._lightmaps) target.dispose();
    this._finalize.dispose();
  }

  // NOTE Meshes inside the camera frustum (bounding sphere grown by the margin) get a place in the atlas
  _updateVisible(camera) {
    if (this.visibleAtlas) return this._updateVisibleCharts(camera);

    this._chartMasks = null;
    camera.updateMatrixWorld();
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_matrix, camera.coordinateSystem);

    this._visible = this._meshes.map((mesh) => {
      if (!mesh.receiveShadow) return false;
      if (!this.frustumAtlas) return true;

      if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();

      _sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      _sphere.radius *= 1 + this.frustumMargin / 100;

      return _frustum.intersectsSphere(_sphere);
    });

    this._visibleKey = `${this._visible.map((v) => (v ? '1' : '0')).join('')}|${this.atlasSize}`;
  }

  // NOTE Visible charts get more atlas area. The test runs when the camera stops, and every 500 ms while meshes move.
  // _covers decides if the layout stays.
  _updateVisibleCharts(camera) {
    camera.updateMatrixWorld();
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    this._visibleKey = `charts${this._visibilitySerial}|${this.atlasSize}|${this.visibleScale}`;
    this._visible = this._meshes.map((mesh) => mesh.receiveShadow);

    // NOTE A moving camera cancels the test
    if (!_matrix.equals(this._cameraMatrix)) {
      this._cameraMatrix.copy(_matrix);

      if (this._visibilityRequest) {
        this._visibility.cancel();
        this._visibilityRequest = null;
      }

      return;
    }

    if (this._visibilityRequest) return;

    const now = performance.now();
    const current = this._chartMasks !== null && _matrix.equals(this._visibilityMatrix);

    if (current && !this._visibilityStale) return;
    if (this._moving && now - this._visibilityTime < 500) return;

    const matrix = _matrix.clone();
    const request = this._visibility.request(camera, this.visibilityResolution, this.frustumMargin);

    this._visibilityRequest = request;
    this._visibilityTime = now;
    this._visibilityStale = false;

    request.then((masks) => {
      if (this._visibilityRequest === request) this._visibilityRequest = null;
      if (masks === null || this._disposed) return;

      this._visibilityMatrix.copy(matrix);

      if (!this._layoutMasks || !this._covers(this._layoutMasks, masks)) {
        this._chartMasks = masks;
        this._visibilitySerial++;
      }
    });
  }

  // NOTE True when the layout has every visible chart and less than twice the visible charts
  _covers(layoutMasks, masks) {
    let laidOut = 0;
    let visible = 0;

    for (let i = 0; i < masks.length; i++) {
      for (let c = 0; c < masks[i].length; c++) {
        if (masks[i][c] > 0 && layoutMasks[i][c] === 0) return false;

        if (layoutMasks[i][c] > 0) laidOut++;
        if (masks[i][c] > 0) visible++;
      }
    }

    return laidOut < 2 * visible;
  }

  // NOTE Packing runs in a worker, the bake starts when the layout is back
  _requestLayout() {
    const key = this._visibleKey;
    const masks = this._chartMasks;

    this._layoutPending = true;

    this._packer
      .pack(this._visible.slice(), this.atlasSize, masks, this.visibleScale)
      .then((layout) => {
        this._layoutPending = false;

        if (this._disposed) return;

        this._layout = layout;
        this._layoutKey = key;
        this._layoutMasks = masks;
      });
  }

  _updateEnvironment() {
    const environment = this.scene.environment;
    const loaded =
      environment && environment.image && (environment.image.data || environment.image.width > 0);

    if (
      environment === this._environment &&
      (!environment || environment.version === this._environmentVersion)
    )
      return;

    if (environment && !loaded) return;

    this._environment = environment;
    this._environmentVersion = environment ? environment.version : -1;
    this._sample = environment
      ? createEnvironmentSampler(downsampleEquirect(environment, 512))
      : null;

    // NOTE The current front stays on screen until the bake for the new environment is done
    if (this.autoUpdate || !this._hasFront) this._dirty = true;

    if (!environment) this._display.uniforms.valid.value = 0;
  }

  _detectMovement() {
    let moved = false;

    this._meshes.forEach((mesh, i) => {
      if (!this._lastMatrices[i].equals(mesh.matrixWorld)) {
        this._lastMatrices[i].copy(mesh.matrixWorld);
        moved = true;
      }
    });

    return moved;
  }

  _startBake() {
    this._meshes.forEach((mesh, i) => this._proxies[i].matrixWorld.copy(mesh.matrixWorld));

    this._bakeLayout = this._layout;
    this._bakeKey = this._layoutKey;
    setLayout(this._meshes, 'lightmapUvBake', this._bakeLayout);

    // NOTE The first bake is on screen while it converges, so the front slot uses its layout
    if (!this._hasFront) setLayout(this._meshes, SLOTS[this._front], this._bakeLayout);

    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();

    renderer.setRenderTarget(this._sumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.setRenderTarget(previous);

    this._count = 0;
    // NOTE At least one sample, 0 would divide by zero
    this._bakeSamples = Math.max(1, Math.round(this.samplesPerBake));
    this._baking = true;
    this._dirty = false;
  }

  _renderSamples(amount) {
    const renderer = this.renderer;
    const { center, radius } = this.bounds;
    const light = this._light;
    const camera = light.shadow.camera;
    const uniforms = this._bake.uniforms;

    renderer.setRenderTarget(this._sumTarget);

    for (let s = 0; s < amount; s++) {
      const bakeCamera = (this._bakeCameras[s] ??= new OrthographicCamera());
      const sequence = ++this._sequence;
      const { direction, color } = this._sample(
        halton(sequence, 2),
        halton(sequence, 3),
        halton(sequence, 5),
        halton(sequence, 7),
      );

      // NOTE Direction jitter in degrees, a cone wider than a hemisphere makes no sense
      jitterDirection(
        direction,
        MathUtils.degToRad(Math.min(180, this.directionJitter)),
        halton(sequence, 11),
        halton(sequence, 13),
      );

      light.position
        .copy(direction)
        .multiplyScalar(2 * radius)
        .add(center);
      this._lightTarget.position.copy(center);
      // NOTE Pre-scaled, so the sum stays in half float range
      light.color.copy(color).multiplyScalar(1 / this._bakeSamples);

      camera.left = -radius;
      camera.right = radius;
      camera.top = radius;
      camera.bottom = -radius;
      camera.near = radius;
      camera.far = 3 * radius;
      camera.updateProjectionMatrix();
      light.shadow.normalBias = (2 * radius) / this.mapSize;

      uniforms.seed.value = sequence % 4096;
      uniforms.noise.value = this.shadowNoise;
      uniforms.mapTexel.value = 1 / this.mapSize;
      uniforms.shadowExtent.value = 2 * radius;
      uniforms.lightDirection.value.copy(direction);

      // NOTE Optional backend step, e.g. the TSL backend makes frame-based nodes update for every sample
      this._backend.beforeSample?.(renderer);

      // NOTE One shadow map + one draw of all meshes in lightmap space, added to the sum
      renderer.render(this._bakeScene, bakeCamera);
      this._count++;
    }
  }

  _renderFinalize(output) {
    const renderer = this.renderer;

    this._finalize.uniforms.scale.value = this._bakeSamples;
    renderer.setRenderTarget(output);
    this._backend.renderQuad(renderer, this._finalize.material);
  }

  _rebuild() {
    this._disposeTargets();

    this._light.shadow.mapSize.setScalar(this.mapSize);
    this._light.shadow.map?.dispose();
    this._light.shadow.map = null;

    this._createTargets();
    this._bakeAtlasSize = this.atlasSize;
    this._bakeMapSize = this.mapSize;

    this._hasFront = false;
    this._baking = false;
    this._dirty = true;
    this._bakeKey = null;

    for (const slot of SLOTS)
      setLayout(
        this._meshes,
        slot,
        this._meshes.map(() => null),
      );
  }

  /**
   * Bakes a few samples and swaps in finished lightmaps. Call it once per frame before rendering.
   *
   * @param {Camera} camera - The camera, its frustum selects the meshes that get a place in the atlas.
   */
  update(camera) {
    if (!this._initialized || this._disposed) return;

    const now = performance.now();
    const delta = this._lastTime === null ? 0 : Math.min(0.1, (now - this._lastTime) / 1000);
    this._lastTime = now;

    if (this.atlasSize !== this._bakeAtlasSize || this.mapSize !== this._bakeMapSize)
      this._rebuild();

    this._updateEnvironment();

    if (!this._sample) return;

    const moved = this._detectMovement();

    // NOTE The visibility BVH is in world space
    if (moved) {
      this._visibility.needsRebuild = true;
      this._visibilityStale = true;
    }

    this._moving = moved;

    if ((moved && this.autoUpdate) || this.needsUpdate) {
      this._dirty = true;
      this.needsUpdate = false;
    }

    // NOTE A different visible set needs a new layout, camera moves inside the same set cost nothing
    this._updateVisible(camera);

    if (this._visibleKey !== this._layoutKey && !this._layoutPending) this._requestLayout();

    // NOTE Without autoUpdate a new layout waits for needsUpdate, except before the first lightmap
    const auto = this.autoUpdate || !this._hasFront;

    if (auto && this._layoutKey !== this._bakeKey) this._dirty = true;

    // NOTE A new layout restarts a bake on the old layout, the front lightmap stays on screen meanwhile
    if (
      this.autoUpdate &&
      this._baking &&
      this._hasFront &&
      this._layout &&
      this._layoutKey !== this._bakeKey
    )
      this._baking = false;

    if (!this._baking && this._dirty && this._layout) this._startBake();

    const renderer = this.renderer;
    const uniforms = this._display.uniforms;

    if (this._baking) {
      const previousTarget = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      const shadowEnabled = renderer.shadowMap.enabled;
      const shadowType = renderer.shadowMap.type;
      const clearAlpha = renderer.getClearAlpha();

      renderer.getClearColor(_clearColor);
      renderer.autoClear = false;
      renderer.shadowMap.enabled = true;
      // NOTE No PCF filtering: the bake softens shadows with noise and many samples
      renderer.shadowMap.type = BasicShadowMap;

      this._renderSamples(
        Math.min(Math.max(0, Math.round(this.samplesPerFrame)), this._bakeSamples - this._count),
      );

      if (!this._hasFront) {
        // NOTE First bake: show it while it converges, there is nothing to keep on screen yet
        this._renderFinalize(this._lightmaps[this._front]);
        uniforms.valid.value = 1;
        uniforms.blend.value = 1;
      }

      // NOTE A finished bake waits for the running crossfade, a swap in the middle of it would jump
      if (this._count >= this._bakeSamples && !(this._hasFront && this._fade < 1)) {
        this._baking = false;

        if (this._hasFront) {
          // NOTE Finish into the slot behind the front one, then flip: the new lightmap fades in over the old one
          const back = 1 - this._front;

          this._renderFinalize(this._lightmaps[back]);
          setLayout(this._meshes, SLOTS[back], this._bakeLayout);

          this._front = back;
          uniforms.frontIsA.value = back === 0 ? 1 : 0;
          this._fade = 0;
          uniforms.blend.value = 0;
        } else {
          this._hasFront = true;
          this._fade = 1;
        }
      }

      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(_clearColor, clearAlpha);
      renderer.autoClear = autoClear;
      renderer.shadowMap.enabled = shadowEnabled;
      renderer.shadowMap.type = shadowType;
    }

    if (this._fade < 1) {
      this._fade = Math.min(1, this._fade + delta / Math.max(1e-3, this.fadeTime));
      uniforms.blend.value = this._fade;
    }

    uniforms.specularOcclusion.value = this.specularOcclusion ? 1 : 0;
    // NOTE shadowBalance 0 / 0.5 / 1 gives the occlusion range 0.25-1 / 0.5-0.99 / 0.75-0.95, linear in between.
    const balance = MathUtils.clamp(this.shadowBalance, 0, 1);
    const lower = Math.min(1, balance * 2);
    const upper = Math.max(0, balance * 2 - 1);

    uniforms.shadowStart.value = 0.25 + 0.25 * lower + 0.25 * upper;
    uniforms.shadowEnd.value = 1 - 0.01 * lower - 0.04 * upper;
  }

  /**
   * Removes the patches from the materials and frees the GPU resources.
   */
  dispose() {
    this._disposed = true;

    if (!this._initialized) return;

    for (const mesh of this._receivers) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      for (const material of materials) this._display.unpatch(material);
    }

    this._disposeTargets();
    this._bake.material.dispose();
    this._light.dispose();
    this._packer.dispose();
    this._visibility.dispose();
  }
}
