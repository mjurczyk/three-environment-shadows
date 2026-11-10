import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import Stats from 'three/addons/libs/stats.module.js';
import GUI from 'lil-gui';
import xatlasWasmUrl from 'xatlas-web/dist/xatlas-web.wasm?url';
import packageInfo from '../../package.json';

// NOTE Only the visual tests (test/visual) pass query params: renderer, env and test (no UI, a ready state)
const search = new URLSearchParams(location.search);
const TEST = search.get('test') === '1';

// NOTE The renderer choice survives the reload that switches it
const readRenderer = () => {
  try {
    return search.get('renderer') ?? sessionStorage.getItem('renderer');
  } catch {
    return search.get('renderer');
  }
};

const params = {
  renderer: readRenderer() === 'webgpu' ? 'webgpu' : 'webgl',
  environment: search.get('env') ?? 'sky_dusk',
  scene: 'Island Castle',
  view: 'combined',
  rotate: false,
  atlas: false,
};

const environments = [
  'studio_rgb',
  'desert',
  'grassland',
  'shore',
  'townsquare',
  'warehouse',
  'sky_midday',
  'sky_dusk',
  'sky_cloudy',
  'sky_night',
];

const textures = new Map();
const models = new Map();
const bounds = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 6);

// NOTE Shows the front lightmap atlas in the bottom left corner
const ATLAS_SIZE = 256;
const atlasScene = new THREE.Scene();
const atlasCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const atlasMaterial = new THREE.MeshBasicMaterial({
  toneMapped: false,
  depthTest: false,
  depthWrite: false,
});
atlasScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), atlasMaterial));

let renderer;
let scene;
let camera;
let controls;
let shadows;
let knot;
let stats;
let Material;
let EnvironmentShadows;
let model;
let shadowControllers = [];
let BasicMaterial;
let createLightmapMaterial;
// NOTE Position of the split line, 0 (left edge) to 1 (right edge)
let split = 0.5;

// NOTE WebGLRenderer uses the GLSL version, WebGPURenderer (WebGPU or its WebGL 2 fallback) the TSL version
const createRenderer = async () => {
  if (params.renderer === 'webgpu') {
    const { WebGPURenderer, MeshStandardNodeMaterial, MeshBasicNodeMaterial } =
      await import('three/webgpu');
    const { select } = await import('three/tsl');
    const { EnvironmentShadows } = await import('../../src/webgpu.js');

    const webgpu = new WebGPURenderer({ antialias: true });
    await webgpu.init();

    return {
      renderer: webgpu,
      Material: MeshStandardNodeMaterial,
      BasicMaterial: MeshBasicNodeMaterial,
      // NOTE The front lightmap, the texture nodes read the lightmap UV attributes
      createLightmapMaterial: ({ a, b, frontIsA }) => {
        const material = new MeshBasicNodeMaterial();
        material.colorNode = select(frontIsA.greaterThan(0.5), a, b).rgb;
        return material;
      },
      EnvironmentShadows,
    };
  }

  const { EnvironmentShadows } = await import('../../src/index.js');

  return {
    renderer: new THREE.WebGLRenderer({ antialias: true }),
    Material: THREE.MeshStandardMaterial,
    BasicMaterial: THREE.MeshBasicMaterial,
    // NOTE The front lightmap, magenta where a vertex has no place in the atlas
    createLightmapMaterial: ({ a, b, frontIsA }) =>
      new THREE.ShaderMaterial({
        uniforms: { lmA: a, lmB: b, lmFrontIsA: frontIsA },
        vertexShader: /* glsl */ `
          attribute vec2 lightmapUvA;
          attribute vec2 lightmapUvB;
          varying vec2 vLmA;
          varying vec2 vLmB;

          void main() {
            vLmA = lightmapUvA;
            vLmB = lightmapUvB;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D lmA;
          uniform sampler2D lmB;
          uniform float lmFrontIsA;
          varying vec2 vLmA;
          varying vec2 vLmB;

          void main() {
            vec2 uv = lmFrontIsA > 0.5 ? vLmA : vLmB;

            if ( uv.x < 1e-6 ) {
              gl_FragColor = vec4( 1.0, 0.0, 1.0, 1.0 );
              return;
            }

            gl_FragColor = vec4( mix( texture2D( lmB, vLmB ).rgb, texture2D( lmA, vLmA ).rgb, lmFrontIsA ), 1.0 );

            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      }),
    EnvironmentShadows,
  };
};

const createTorusian = () => {
  const group = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new Material({ color: 0xbbbbbb, roughness: 0.9 }),
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  const material = new Material({ color: 0xffffff, roughness: 0.4 });
  const metal = new Material({ color: 0xffffff, roughness: 0.2, metalness: 1 });

  knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.8, 0.3, 128, 32), material);
  knot.position.set(0, 1.8, 0);
  group.add(knot);

  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 1.2), material);
  box.position.set(-2.5, 1.2, -1);
  box.rotation.y = 0.4;
  group.add(box);

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.7, 64, 32), metal);
  sphere.position.set(2.4, 0.7, 1.2);
  group.add(sphere);

  for (let i = 0; i < 8; i++) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2, 16), material);
    const angle = (i / 8) * Math.PI * 2;
    pillar.position.set(Math.cos(angle) * 4.5, 1, Math.sin(angle) * 4.5);
    group.add(pillar);
  }

  // NOTE Every mesh casts and receives, the ground also blocks the light from below the horizon
  group.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  group.userData.rotate = { object: knot, speed: 0.5 };

  return group;
};

// NOTE New transparent materials keep only the original map. The model is scaled to the shadow bounds and placed on y = 0
const loadIslandCastle = async () => {
  const gltf = await new GLTFLoader().loadAsync(
    `${import.meta.env.BASE_URL}assets/island-castle.glb`,
  );
  const group = gltf.scene;

  group.traverse((object) => {
    if (object.isMesh) {
      object.material = new Material({
        map: object.material.map,
        transparent: true,
      });
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  group.getObjectByName('Sky_Sky_0').removeFromParent();

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = (bounds.radius * 2) / Math.max(size.x, size.z);

  group.scale.setScalar(scale);
  group.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

  // NOTE The pivot rotates the castle around its center
  const pivot = new THREE.Group();
  pivot.add(group);
  pivot.userData.rotate = { object: pivot, speed: 0.1 };

  return pivot;
};

const scenes = {
  Torusian: async () => createTorusian(),
  'Island Castle': loadIslandCastle,
};

const loadModel = async (name) => {
  if (!models.has(name)) models.set(name, await scenes[name]());

  return models.get(name);
};

// NOTE Shadow settings per scene, the rest use the library defaults
const sceneOptions = {
  Torusian: {
    autoUpdate: true,
  },
  'Island Castle': {
    autoUpdate: true,
    samplesPerFrame: 24,
    samplesPerBake: 128,
    atlasSize: 2048,
    mapSize: 1024,
    shadowBalance: 1,
    visibilityResolution: 32,
    visibleScale: 10,
    shadowNoise: 0.5,
    directionJitter: 8,
    fadeTime: 0.66,
  },
};

const createShadows = async () => {
  const environmentShadows = new EnvironmentShadows(renderer, scene, {
    bounds,
    xatlasWasmUrl,
    ...sceneOptions[params.scene],
  });

  await environmentShadows.ready;

  return environmentShadows;
};

const views = ['combined', 'flat white', 'only color', 'only shadowmap'];
const white = new THREE.Color(0xffffff);
let lightmapMaterial = null;
let lightmapShadows = null;

// NOTE Debug views: combined, flat white (no color map), only color (no light), only shadowmap (front lightmap)
const applyView = (target, view) => {
  if (view === 'only shadowmap' && shadows && lightmapShadows !== shadows) {
    lightmapMaterial?.dispose();
    lightmapMaterial = createLightmapMaterial(shadows._display.uniforms);
    lightmapShadows = shadows;
  }

  target.traverse((mesh) => {
    if (!mesh.isMesh) return;

    const original = (mesh.userData.view ??= {
      material: mesh.material,
      map: mesh.material.map,
      color: mesh.material.color.clone(),
    });
    const material = original.material;

    material.map = view === 'flat white' ? null : original.map;
    material.color.copy(view === 'flat white' ? white : original.color);
    material.needsUpdate = true;

    original.colorMaterial ??= new BasicMaterial({
      map: original.map,
      color: original.color,
      transparent: material.transparent,
    });

    if (view === 'only color') mesh.material = original.colorMaterial;
    else if (view === 'only shadowmap' && lightmapMaterial) mesh.material = lightmapMaterial;
    else mesh.material = material;
  });
};

// NOTE EnvironmentShadows collects the meshes once, so a new model needs a new instance.
// Until it is ready, the model shows its original materials.
// NOTE The spinner shows while a model loads and unwraps
const setLoading = (loading) =>
  document.querySelector('.loader').classList.toggle('visible', loading);

const setScene = async (name) => {
  params.scene = name;
  setLoading(true);

  const next = await loadModel(name);

  if (name !== params.scene) return;

  if (model) {
    applyView(model, 'combined');
    scene.remove(model);
  }

  model = next;
  applyView(model, 'combined');
  scene.add(model);

  shadows?.dispose();
  shadows = null;

  const environmentShadows = await createShadows();

  if (name !== params.scene) return environmentShadows.dispose();

  shadows = environmentShadows;
  setLoading(false);

  for (const controller of shadowControllers) {
    controller.object = shadows;
    controller.updateDisplay();
  }

  applyView(model, params.view);
};

// NOTE The 4096 px maps are scaled down, more on mobile
const MOBILE =
  /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) ||
  matchMedia('(pointer: coarse)').matches;
const BACKGROUND_WIDTH = MOBILE ? 1024 : 2048;
const ENVIRONMENT_WIDTH = MOBILE ? 512 : 1024;

const halfToFloat = new Float32Array(65536).map((v, i) => THREE.DataUtils.fromHalfFloat(i));

// NOTE Box filter of a half float equirect map (UltraHDRLoader)
const scaleDown = (texture, width) => {
  const { data, width: sourceWidth, height: sourceHeight } = texture.image;
  const factor = Math.max(1, Math.round(sourceWidth / width));
  const outWidth = Math.floor(sourceWidth / factor);
  const outHeight = Math.floor(sourceHeight / factor);
  const out = new Uint16Array(outWidth * outHeight * 4);
  const count = factor * factor;

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * sourceWidth + x * factor + dx) * 4;

          r += halfToFloat[data[i]];
          g += halfToFloat[data[i + 1]];
          b += halfToFloat[data[i + 2]];
        }
      }

      const o = (y * outWidth + x) * 4;

      out[o] = THREE.DataUtils.toHalfFloat(r / count);
      out[o + 1] = THREE.DataUtils.toHalfFloat(g / count);
      out[o + 2] = THREE.DataUtils.toHalfFloat(b / count);
      out[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  const scaled = new THREE.DataTexture(
    out,
    outWidth,
    outHeight,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  scaled.mapping = THREE.EquirectangularReflectionMapping;
  scaled.colorSpace = texture.colorSpace;
  scaled.flipY = texture.flipY;
  scaled.minFilter = THREE.LinearFilter;
  scaled.magFilter = THREE.LinearFilter;
  scaled.needsUpdate = true;

  return scaled;
};

const loadEnvironment = async (name) => {
  if (!textures.has(name)) {
    const texture = await new UltraHDRLoader()
      .setPath(`${import.meta.env.BASE_URL}assets/`)
      .loadAsync(`${name}.jpg`);

    const background = scaleDown(texture, BACKGROUND_WIDTH);
    const environment = scaleDown(background, ENVIRONMENT_WIDTH);

    textures.set(name, { background, environment });
  }

  return textures.get(name);
};

// NOTE EnvironmentShadows reads scene.environment, a new map starts a new bake
const setEnvironment = async (name) => {
  params.environment = name;

  const { background, environment } = await loadEnvironment(name);

  if (name !== params.environment) return;

  scene.background = background;
  scene.environment = environment;

  // NOTE Without autoUpdate a new environment needs a manual bake
  if (shadows) shadows.needsUpdate = true;
};

const createGUI = () => {
  const gui = new GUI({ title: 'three-environment-shadows' });

  // NOTE The renderer cannot change at runtime, the page reloads
  gui
    .add(params, 'renderer', { 'WebGL (GLSL)': 'webgl', 'WebGPU (TSL)': 'webgpu' })
    .onChange(() => {
      try {
        sessionStorage.setItem('renderer', params.renderer);
      } catch {
        // NOTE Without storage the page reloads with the default renderer
      }

      location.reload();
    });
  gui.add(params, 'scene', Object.keys(scenes)).onChange(setScene);
  gui.add(params, 'view', views).onChange((view) => applyView(model, view));
  gui.add(params, 'environment', environments).onChange(setEnvironment);
  gui.add(params, 'rotate');
  gui.add(params, 'atlas').name('display atlas');

  const rebake = () => shadows && (shadows.needsUpdate = true);

  const folder = gui.addFolder('EnvironmentShadows');
  folder.add(shadows, 'autoUpdate').name('auto update');
  folder.add(shadows, 'samplesPerFrame', 0, 1000, 1).name('shadow maps / frame');
  folder.add(shadows, 'samplesPerBake', 0, 1000, 1).name('samples / bake').onChange(rebake);
  folder.add(shadows, 'fadeTime', 0, 2, 0.05).name('crossfade (s)');
  folder.add(shadows, 'atlasSize', [512, 1024, 2048, 4096]).name('atlas size');
  folder.add(shadows, 'mapSize', [512, 1024, 2048, 4096]).name('shadow map size');
  folder.add(shadows, 'shadowNoise', 0, 1000, 0.1).name('shadow noise (texels)').onChange(rebake);
  folder
    .add(shadows, 'directionJitter', 0, 1000, 0.1)
    .name('direction jitter (deg)')
    .onChange(rebake);
  folder.add(shadows, 'visibleAtlas').name('atlas: visible charts larger (BVH)');
  folder.add(shadows, 'visibilityResolution', 32, 1024, 1).name('visibility rays (width)');
  folder.add(shadows, 'visibleScale', 1, 16, 0.1).name('visible charts area (x)');
  folder.add(shadows, 'frustumAtlas').name('atlas: only meshes in view');
  folder.add(shadows, 'frustumMargin', 0, 1000, 1).name('view margin (%)');
  folder.add(shadows, 'specularOcclusion').name('specular occlusion');
  folder.add(shadows, 'shadowBalance', 0, 1, 0.01).name('shadow balance');

  shadowControllers = folder.controllers;
};

const init = async () => {
  document.querySelector('.package-version').textContent = `v${packageInfo.version}`;

  if (TEST) document.body.classList.add('test');

  const created = await createRenderer();

  renderer = created.renderer;
  Material = created.Material;
  BasicMaterial = created.BasicMaterial;
  createLightmapMaterial = created.createLightmapMaterial;
  EnvironmentShadows = created.EnvironmentShadows;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // NOTE The split view clears once per frame, before both halves
  renderer.autoClear = false;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(8, 5, 10);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI / 2;
  controls.update();

  model = await loadModel(params.scene);
  scene.add(model);

  // NOTE Drag the split line to move it
  const splitLine = document.querySelector('.split-line');

  splitLine.addEventListener('pointerdown', (event) =>
    splitLine.setPointerCapture(event.pointerId),
  );
  splitLine.addEventListener('pointermove', (event) => {
    if (!splitLine.hasPointerCapture(event.pointerId)) return;

    split = Math.min(1, Math.max(0, event.clientX / window.innerWidth));
    splitLine.style.left = `${split * 100}%`;
  });

  stats = new Stats();
  stats.dom.classList.add('stats');
  document.body.appendChild(stats.dom);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const timer = new THREE.Timer();

  renderer.setAnimationLoop((time) => {
    stats.begin();

    timer.update(time);

    // NOTE The knot (Torusian) or the whole castle (Island Castle)
    const rotate = model?.userData.rotate;

    if (params.rotate && rotate) rotate.object.rotation.y += timer.getDelta() * rotate.speed;

    scene.updateMatrixWorld();

    shadows?.update(camera);

    // NOTE Left of the split line without the environment shadows, right of it with them
    const half = Math.floor(window.innerWidth * split);
    const uniforms = shadows?._display.uniforms;
    const valid = uniforms?.valid.value;

    renderer.clear();
    renderer.setScissorTest(true);

    renderer.setScissor(0, 0, half, window.innerHeight);
    if (uniforms) uniforms.valid.value = 0;
    renderer.render(scene, camera);

    renderer.setScissor(half, 0, window.innerWidth - half, window.innerHeight);
    if (uniforms) uniforms.valid.value = valid;
    renderer.render(scene, camera);

    if (params.atlas && shadows) {
      const texture = shadows._lightmaps[shadows._front].texture;
      // NOTE WebGLRenderer counts the viewport y from the bottom, WebGPURenderer from the top
      const bottom = document.querySelector('.bottom-tab').offsetHeight;
      const y = renderer.isWebGPURenderer ? window.innerHeight - bottom - ATLAS_SIZE : bottom;

      if (atlasMaterial.map !== texture) {
        atlasMaterial.map = texture;
        atlasMaterial.needsUpdate = true;
      }

      renderer.setViewport(0, y, ATLAS_SIZE, ATLAS_SIZE);
      renderer.setScissor(0, y, ATLAS_SIZE, ATLAS_SIZE);
      renderer.render(atlasScene, atlasCamera);
      renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    }

    renderer.setScissorTest(false);

    stats.end();
  });

  // NOTE The environment and background first, the shadows bake after
  await setEnvironment(params.environment);

  shadows = await createShadows();
  setLoading(false);

  createGUI();

  // NOTE Ready for a screenshot when the first bake of this environment is on screen and nothing else is pending
  if (TEST) {
    window.environmentShadowsTest = {
      isReady: () =>
        scene.environment !== null &&
        shadows._hasFront &&
        !shadows._baking &&
        !shadows._dirty &&
        !shadows._layoutPending &&
        shadows._layoutKey === shadows._bakeKey &&
        shadows._fade >= 1,
    };
  }
};

init().catch((error) => console.error(error));
