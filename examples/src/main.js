import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
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
  environment: search.get('env') ?? 'studio_rgb',
  animate: false,
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

let renderer;
let scene;
let camera;
let controls;
let shadows;
let knot;
let stats;

// NOTE WebGLRenderer uses the GLSL version, WebGPURenderer (WebGPU or its WebGL 2 fallback) the TSL version
const createRenderer = async () => {
  if (params.renderer === 'webgpu') {
    const { WebGPURenderer, MeshStandardNodeMaterial } = await import('three/webgpu');
    const { EnvironmentShadows } = await import('../../src/webgpu.js');

    const webgpu = new WebGPURenderer({ antialias: true });
    await webgpu.init();

    return {
      renderer: webgpu,
      Material: MeshStandardNodeMaterial,
      EnvironmentShadows,
    };
  }

  const { EnvironmentShadows } = await import('../../src/index.js');

  return {
    renderer: new THREE.WebGLRenderer({ antialias: true }),
    Material: THREE.MeshStandardMaterial,
    EnvironmentShadows,
  };
};

const createScene = (Material) => {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new Material({ color: 0xbbbbbb, roughness: 0.9 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const material = new Material({ color: 0xffffff, roughness: 0.4 });
  const metal = new Material({ color: 0xffffff, roughness: 0.2, metalness: 1 });

  knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.8, 0.3, 128, 32), material);
  knot.position.set(0, 1.8, 0);
  scene.add(knot);

  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 1.2), material);
  box.position.set(-2.5, 1.2, -1);
  box.rotation.y = 0.4;
  scene.add(box);

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.7, 64, 32), metal);
  sphere.position.set(2.4, 0.7, 1.2);
  scene.add(sphere);

  for (let i = 0; i < 8; i++) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2, 16), material);
    const angle = (i / 8) * Math.PI * 2;
    pillar.position.set(Math.cos(angle) * 4.5, 1, Math.sin(angle) * 4.5);
    scene.add(pillar);
  }

  // NOTE Every mesh casts and receives, the ground also blocks the light from below the horizon
  scene.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
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
  gui.add(params, 'environment', environments).onChange(setEnvironment);
  gui.add(params, 'animate').name('animate knot');

  const rebake = () => (shadows.needsUpdate = true);

  const folder = gui.addFolder('EnvironmentShadows');
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
  folder.add(shadows, 'frustumAtlas').name('atlas: only meshes in view');
  folder.add(shadows, 'frustumMargin', 0, 1000, 1).name('view margin (%)');
  folder.add(shadows, 'specularOcclusion').name('specular occlusion');
};

const init = async () => {
  document.querySelector('.package-version').textContent = `v${packageInfo.version}`;

  if (TEST) document.body.classList.add('test');

  const created = await createRenderer();

  renderer = created.renderer;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(8, 5, 10);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI / 2;
  controls.update();

  createScene(created.Material);

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

    if (params.animate) knot.rotation.y += timer.getDelta() * 0.5;

    scene.updateMatrixWorld();

    shadows?.update(camera);
    renderer.render(scene, camera);

    stats.end();
  });

  // NOTE The environment and background first, the shadows bake after
  await setEnvironment(params.environment);

  const environmentShadows = new created.EnvironmentShadows(renderer, scene, {
    bounds: new THREE.Sphere(new THREE.Vector3(0, 1, 0), 6),
    xatlasWasmUrl,
  });

  await environmentShadows.ready;

  shadows = environmentShadows;

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
