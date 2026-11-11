import {
  BasicShadowMap,
  Box3,
  Color,
  DirectionalLight,
  Frustum,
  HalfFloatType,
  InstancedMesh,
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
import { unwrapMeshes } from './unwrap.js';
import { createPacker } from './packer.js';
import { createVisibility } from './visibility.js';
import { updateExcluded } from './exclude.js';
import { isBatchedSupported, isInstanceVisible } from './batched.js';
import {
  createLayoutTexture,
  createUnits,
  getUnitMatrix,
  isUnitDrawn,
  writeLayout,
} from './units.js';

const _box = /*@__PURE__*/ new Box3();
const _sphere = /*@__PURE__*/ new Sphere();
const _matrix = /*@__PURE__*/ new Matrix4();
const _unitMatrix = /*@__PURE__*/ new Matrix4();
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
    // NOTE Hidden charts need fewer texels, but every chart needs a few: half the primary size, at least 256
    this.secondaryAtlasSize = options.secondaryAtlasSize ?? Math.max(256, this.atlasSize / 2);
    this.mapSize = options.mapSize ?? 512;
    this.shadowNoise = options.shadowNoise ?? 8;
    this.directionJitter = options.directionJitter ?? 2;
    this.specularOcclusion = options.specularOcclusion ?? true;
    this.shadowBalance = options.shadowBalance ?? 0.5;
    this.frustumAtlas = options.frustumAtlas ?? true;
    this.frustumMargin = options.frustumMargin ?? 20;
    this.visibleAtlas = options.visibleAtlas ?? true;
    this.visibilityResolution = options.visibilityResolution ?? 384;
    this.bounds = options.bounds ? options.bounds.clone() : null;
    // NOTE Meshes of these objects (and their children) do not cast shadows, but still receive them
    this.exclude = new Set(options.exclude);
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

    // NOTE A BatchedMesh needs three.js internals (r170+), and the instance id in the shaders
    const supported = list.filter((mesh) => {
      if (!mesh.isBatchedMesh) return true;
      if (this._backend.supportsBatchedMesh && isBatchedSupported(mesh)) return true;

      console.warn('EnvironmentShadows: BatchedMesh needs three.js r170+, skipped', mesh);

      return false;
    });

    this._receivers = supported.filter((mesh) => mesh.receiveShadow);
    this._meshes = supported.filter((mesh) => mesh.receiveShadow || mesh.castShadow);

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

    // NOTE Units: meshes and instances, each with its own place in the atlas (see units.js)
    const { geometries, units, proxies, entryCount, table } = createUnits(this._meshes);

    this._units = units;
    this._geometries = geometries;
    this._table = table;

    // NOTE Bake scene: proxies share the geometry, transforms are a snapshot at bake start. BatchedMesh: one
    // InstancedMesh proxy per geometry.
    this._bakeScene = new Scene();
    // NOTE One camera per sample of a frame: WebGPURenderer renders a shadow map at most once per frame and camera.
    // The cameras are the same, the bake draws in lightmap space and only uses them for view space normals.
    this._bakeCameras = [];
    this._bake = backend.createBakeMaterial();

    this._proxies = proxies.map(({ mesh, geometry, instances }) => {
      const source = this._meshes[mesh];
      const proxy =
        instances !== null
          ? new InstancedMesh(geometry, this._bake.material, instances.length)
          : source.isInstancedMesh
            ? new InstancedMesh(geometry, this._bake.material, source.instanceMatrix.count)
            : new Mesh(geometry, this._bake.material);

      proxy.matrixAutoUpdate = false;
      proxy.matrixWorldAutoUpdate = false;
      proxy.frustumCulled = false;
      proxy.receiveShadow = true;
      this._bakeScene.add(proxy);

      return { proxy, mesh, instances };
    });

    // NOTE Layout textures: the bake in progress and the lightmap slots A and B
    this._bakeLayoutTexture = createLayoutTexture(entryCount, table);
    this._layoutTextures = [
      createLayoutTexture(entryCount, table),
      createLayoutTexture(entryCount, table),
    ];
    this._bake.uniforms.layout.value = this._bakeLayoutTexture;

    this._light = new DirectionalLight(0xffffff, 1);
    this._light.castShadow = true;
    this._light.shadow.mapSize.setScalar(this.mapSize);
    this._lightTarget = new Object3D();
    this._light.target = this._lightTarget;
    this._bakeScene.add(this._light, this._lightTarget);

    this._sumType = backend.getSumType(renderer);
    this._display = backend.createDisplay();
    this._display.uniforms.layoutA.value = this._layoutTextures[0];
    this._display.uniforms.layoutB.value = this._layoutTextures[1];
    this._createTargets();

    this._packer = createPacker(geometries, units, entryCount);

    // NOTE Charts seen by the camera (visibleAtlas): masks per unit of the last test and of the latest layout
    this._visibility = createVisibility(this._meshes, units, geometries);
    this._chartMasks = null;
    this._layoutMasks = null;
    this._visibilityMatrix = new Matrix4();
    this._cameraMatrix = new Matrix4();
    this._visibilityRequest = null;
    this._visibilitySerial = 0;
    this._visibilityTime = -Infinity;
    this._visibilityStale = false;
    this._moving = false;

    // NOTE World matrix and drawn state of each unit, to detect movement
    this._lastMatrices = new Float64Array(units.length * 16);
    this._drawn = units.map(() => false);
    this._detectMovement();

    // NOTE Excluded meshes stay unwrapped, so a change of exclude only changes the casters of the next bake
    this._casters = this._meshes.map((mesh) => mesh.castShadow);
    this._excluded = this._meshes.map(() => false);
    updateExcluded(this._meshes, this.exclude, this._excluded);

    // NOTE Layouts (chart transforms, see units.js): the latest one and the one of the bake. Keys name the
    // visible set and atlas size.
    this._layout = null;
    this._layoutKey = null;
    this._layoutPending = false;
    this._layoutGeneration = 0;
    this._bakeKey = null;
    this._bakeLayout = null;
    this._bakeSecondary = false;
    this._visible = units.map(() => true);
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

    // NOTE The secondary atlas (charts in view that the camera does not see) exists only with visibleAtlas
    const secondary = this.visibleAtlas;
    const secondarySize = this.secondaryAtlasSize;

    this._secondarySumTarget = secondary
      ? makeTarget(secondarySize, this._sumType, NearestFilter)
      : null;
    this._secondaryLightmaps = secondary
      ? [
          makeTarget(secondarySize, HalfFloatType, LinearFilter),
          makeTarget(secondarySize, HalfFloatType, LinearFilter),
        ]
      : null;
    this._secondaryFinalize = secondary
      ? this._backend.createFinalize(this._secondarySumTarget.texture, secondarySize)
      : null;
    this._bakeVisibleAtlas = secondary;
    this._bakeSecondaryAtlasSize = secondarySize;

    // NOTE Without a secondary atlas all charts are in the primary one, its lightmaps are placeholders
    const secondaryLightmaps = this._secondaryLightmaps ?? this._lightmaps;
    const uniforms = this._display.uniforms;

    uniforms.a.value = this._lightmaps[0].texture;
    uniforms.b.value = this._lightmaps[1].texture;
    uniforms.secondaryA.value = secondaryLightmaps[0].texture;
    uniforms.secondaryB.value = secondaryLightmaps[1].texture;
    uniforms.frontIsA.value = 1;
    uniforms.valid.value = 0;

    // NOTE New textures need new bindings in materials that are already built
    this._display.refresh();
  }

  _disposeTargets() {
    this._sumTarget.dispose();
    for (const target of this._lightmaps) target.dispose();
    this._finalize.dispose();

    this._secondarySumTarget?.dispose();
    for (const target of this._secondaryLightmaps ?? []) target.dispose();
    this._secondaryFinalize?.dispose();
  }

  // NOTE Units inside the camera frustum (bounding sphere grown by the margin) get a place in the atlas
  _updateVisible(camera) {
    camera.updateMatrixWorld();
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_matrix, camera.coordinateSystem);

    this._visible = this._units.map((unit) => {
      const mesh = this._meshes[unit.mesh];

      if (!mesh.receiveShadow || !isUnitDrawn(mesh, unit.instance)) return false;
      if (!this.frustumAtlas) return true;

      const geometry = this._geometries[unit.geometry].geometry;

      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();

      getUnitMatrix(mesh, unit.instance, _unitMatrix);
      _sphere.copy(geometry.boundingSphere).applyMatrix4(_unitMatrix);
      _sphere.radius *= 1 + this.frustumMargin / 100;

      return _frustum.intersectsSphere(_sphere);
    });

    const units = this._visible.map((v) => (v ? '1' : '0')).join('');

    if (!this.visibleAtlas) {
      this._chartMasks = null;
      this._visibleKey = `${units}|${this.atlasSize}`;
      return;
    }

    this._visibleKey = `${units}|charts${this._visibilitySerial}|${this.atlasSize}|${this.secondaryAtlasSize}`;
    this._updateVisibleCharts(camera);
  }

  // NOTE Charts seen by the camera go to the primary atlas. The test runs when the camera stops, every 500 ms
  // while meshes move.
  _updateVisibleCharts(camera) {
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
    const generation = this._layoutGeneration;

    this._layoutPending = true;

    this._packer
      .pack(
        this._visible.slice(),
        [this.atlasSize, this.secondaryAtlasSize],
        masks,
        this._getScales(),
      )
      .then((layout) => {
        this._layoutPending = false;

        // NOTE A layout requested before a rebuild can need atlases that do not exist now
        if (this._disposed || generation !== this._layoutGeneration) return;

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

  // NOTE WebGPURenderer uploads a texture only when a binding of it refreshes. Unchanged objects do not refresh,
  // so upload here.
  _writeLayout(texture, layout) {
    writeLayout(texture, layout, this._table);
    this.renderer.initTexture(texture);
  }

  // NOTE Instance scale (cube root of the volume scale) per unit: the charts were measured without it
  _getScales() {
    return Float32Array.from(this._units, (unit) => {
      const mesh = this._meshes[unit.mesh];

      if (unit.instance < 0 || !isUnitDrawn(mesh, unit.instance)) return 1;

      mesh.getMatrixAt(unit.instance, _matrix);

      return Math.max(1e-3, Math.cbrt(Math.abs(_matrix.determinant())));
    });
  }

  // NOTE A unit moved when its world matrix or drawn state changed
  _detectMovement() {
    const last = this._lastMatrices;
    let moved = false;

    this._units.forEach((unit, i) => {
      const mesh = this._meshes[unit.mesh];
      const drawn = isUnitDrawn(mesh, unit.instance);

      if (drawn !== this._drawn[i]) {
        this._drawn[i] = drawn;
        moved = true;
      }

      if (!drawn) return;

      const elements = getUnitMatrix(mesh, unit.instance, _unitMatrix).elements;
      const offset = i * 16;

      for (let k = 0; k < 16; k++) {
        if (last[offset + k] !== elements[k]) {
          last.set(elements, offset);
          moved = true;
          break;
        }
      }
    });

    return moved;
  }

  // NOTE Snapshot of the transforms. Instances that are not drawn get a zero scale.
  _updateProxies() {
    for (const { proxy, mesh: m, instances } of this._proxies) {
      const mesh = this._meshes[m];

      proxy.matrixWorld.copy(mesh.matrixWorld);
      proxy.castShadow = this._casters[m] && !this._excluded[m];

      if (mesh.isInstancedMesh) {
        proxy.instanceMatrix.array.set(mesh.instanceMatrix.array);
        proxy.instanceMatrix.needsUpdate = true;
        proxy.count = mesh.count;
      } else if (instances !== null) {
        instances.forEach((id, k) => {
          if (isInstanceVisible(mesh, id)) mesh.getMatrixAt(id, _matrix);
          else _matrix.makeScale(0, 0, 0);

          proxy.setMatrixAt(k, _matrix);
        });

        proxy.instanceMatrix.needsUpdate = true;
      }
    }
  }

  _startBake() {
    this._updateProxies();

    this._bakeLayout = this._layout;
    this._bakeKey = this._layoutKey;
    this._writeLayout(this._bakeLayoutTexture, this._bakeLayout);

    // NOTE The first bake is on screen while it converges, so the front slot uses its layout
    if (!this._hasFront) this._writeLayout(this._layoutTextures[this._front], this._bakeLayout);

    // NOTE Only a layout from a visibility test has secondary charts
    this._bakeSecondary = this._secondarySumTarget !== null && this._layoutMasks !== null;

    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();

    renderer.setClearColor(0x000000, 0);

    for (const target of [this._sumTarget, this._secondarySumTarget]) {
      if (target === null) continue;

      renderer.setRenderTarget(target);
      renderer.clear();
    }

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
      uniforms.atlas.value = 0;
      renderer.setRenderTarget(this._sumTarget);
      renderer.render(this._bakeScene, bakeCamera);

      // NOTE Secondary atlas: a second draw, same shadow map. WebGPURenderer renders it once per frame and camera,
      // WebGLRenderer skips it without autoUpdate.
      if (this._bakeSecondary) {
        const autoUpdate = renderer.shadowMap.autoUpdate;

        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
        uniforms.atlas.value = 1;
        renderer.setRenderTarget(this._secondarySumTarget);
        renderer.render(this._bakeScene, bakeCamera);
        renderer.shadowMap.autoUpdate = autoUpdate;
      }

      this._count++;
    }
  }

  // NOTE Sums to the lightmaps of a slot
  _renderFinalize(slot) {
    const renderer = this.renderer;

    this._finalize.uniforms.scale.value = this._bakeSamples;
    renderer.setRenderTarget(this._lightmaps[slot]);
    this._backend.renderQuad(renderer, this._finalize.material);

    if (!this._bakeSecondary) return;

    this._secondaryFinalize.uniforms.scale.value = this._bakeSamples;
    renderer.setRenderTarget(this._secondaryLightmaps[slot]);
    this._backend.renderQuad(renderer, this._secondaryFinalize.material);
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

    // NOTE The next bake waits for a layout of the new atlases
    this._layoutGeneration++;
    this._layout = null;
    this._layoutKey = null;
    this._layoutMasks = null;

    for (const texture of this._layoutTextures) this._writeLayout(texture, null);
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

    if (
      this.atlasSize !== this._bakeAtlasSize ||
      this.mapSize !== this._bakeMapSize ||
      this.visibleAtlas !== this._bakeVisibleAtlas ||
      (this.visibleAtlas && this.secondaryAtlasSize !== this._bakeSecondaryAtlasSize)
    )
      this._rebuild();

    this._updateEnvironment();

    if (!this._sample) return;

    const moved = this._detectMovement();
    const excludeChanged = updateExcluded(this._meshes, this.exclude, this._excluded);

    // NOTE The visibility BVH is in world space
    if (moved) {
      this._visibility.needsRebuild = true;
      this._visibilityStale = true;
    }

    this._moving = moved;

    if (((moved || excludeChanged) && this.autoUpdate) || this.needsUpdate) {
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
        this._renderFinalize(this._front);
        uniforms.valid.value = 1;
        uniforms.blend.value = 1;
      }

      // NOTE A finished bake waits for the running crossfade, a swap in the middle of it would jump
      if (this._count >= this._bakeSamples && !(this._hasFront && this._fade < 1)) {
        this._baking = false;

        if (this._hasFront) {
          // NOTE Finish into the slot behind the front one, then flip: the new lightmap fades in over the old one
          const back = 1 - this._front;

          this._renderFinalize(back);
          this._writeLayout(this._layoutTextures[back], this._bakeLayout);

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
    this._bakeLayoutTexture.dispose();
    for (const texture of this._layoutTextures) texture.dispose();
    for (const { proxy } of this._proxies) if (proxy.isInstancedMesh) proxy.dispose();
    this._bake.material.dispose();
    this._light.dispose();
    this._packer.dispose();
    this._visibility.dispose();
  }
}
