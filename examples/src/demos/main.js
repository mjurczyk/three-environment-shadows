import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import GUI from 'lil-gui';
import Stats from 'three/addons/libs/stats.module.js';
import { createScene } from './scene.js';
import { applyMaterialHook, hookUniforms } from './materialHook.js';
import { downsampleEquirect } from './context.js';
import { createBakedLightmap } from './techniques/baked.js';

const LABEL = 'E2 · Background-baked lightmap (double buffered)';

const search = new URLSearchParams(location.search);

const params = {
  environment: search.get('env') ?? 'desert',
  view: search.get('view') ?? 'default',
  animate: search.get('animate') === '1',
};

const environments = [
  'desert',
  'grassland',
  'shore',
  'townsquare',
  'warehouse',
  'sky_midday',
  'sky_dusk',
  'sky_cloudy',
  'sky_night',
  'studio_rgb',
  'fiery-sky-1-8K', // SDR
  'magic-forest-5-8K', // SDR
];

// NOTE Plain SDR JPGs (no gain map), loaded as 8-bit sRGB textures. Light intensities are clipped.
const sdrEnvironments = new Set(['fiery-sky-1-8K', 'magic-forest-5-8K']);

// NOTE Fixed views, so results can be compared on the same image
const views = {
  default: { position: [8, 5, 10], target: [0, 1, 0] },
  low: { position: [4.5, 1.2, 5.5], target: [0, 1, 0] },
  top: { position: [0.01, 13, 0.01], target: [0, 0, 0] },
  contact: { position: [-0.5, 1.6, 3.4], target: [-2.2, 0.6, -0.8] },
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
const loader = new UltraHDRLoader().setPath(`${import.meta.env.BASE_URL}assets/`);
const analysisElement = document.querySelector('#analysis');
const textures = new Map();
const drawingBufferSize = new THREE.Vector2();
const previousCamera = new THREE.Matrix4();

let controls;
let sceneData;
let technique = null;
let ready = false;
let frameIndex = 0;
let lastTime = performance.now();
let stats;

// NOTE Atlas preview at the bottom left, above the bottom bar, in CSS pixels
const PREVIEW_SIZE = 256;
const PREVIEW_MARGIN = 8;
const BOTTOM_BAR = 32;

/**
 * The context given to the technique.
 */
const ctx = {
  renderer,
  scene,
  camera,
  get meshes() {
    return sceneData.meshes;
  },
  // NOTE The area that receives shadows
  bounds: new THREE.Sphere(new THREE.Vector3(0, 1, 0), 6),
  downsampleEquirect,
};

const loadEnvironment = async (name) => {
  if (!textures.has(name)) {
    let texture;

    if (sdrEnvironments.has(name)) {
      texture = await new THREE.TextureLoader().setPath(`${import.meta.env.BASE_URL}assets/`).loadAsync(`${name}.jpg`);
      texture.colorSpace = THREE.SRGBColorSpace;
    } else {
      texture = await loader.loadAsync(`${name}.jpg`);
    }

    texture.mapping = THREE.EquirectangularReflectionMapping;
    textures.set(name, texture);
  }

  return textures.get(name);
};

const setEnvironment = async (name) => {
  params.environment = name;
  updateURL();

  const texture = await loadEnvironment(name);

  if (name !== params.environment) return;

  scene.background = texture;
  scene.environment = texture;

  if (!technique) return;

  try {
    await technique.setEnvironment({ source: texture });
    ready = true;
    analysisElement.textContent = LABEL;
  } catch (error) {
    console.error(error);
    analysisElement.textContent = `${LABEL} failed: ${error.message}`;
  }
};

const setView = (name) => {
  const view = views[name] ?? views.default;

  params.view = name;
  camera.position.fromArray(view.position);
  controls.target.fromArray(view.target);
  controls.update();
  updateURL();
};

const updateURL = () => {
  const query = new URLSearchParams({
    env: params.environment,
    view: params.view,
    animate: params.animate ? '1' : '0',
  });

  history.replaceState(null, '', `${location.pathname}?${query}`);
};

const resize = () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(drawingBufferSize);

  hookUniforms.hookResolution.value.copy(drawingBufferSize);
};

const frame = (time) => {
  stats.begin();

  const start = performance.now();
  const delta = Math.min(0.1, (start - lastTime) / 1000);

  lastTime = start;
  frameIndex++;

  let sceneChanged = false;

  if (params.animate) {
    sceneData.knot.rotation.y += delta * 0.5;
    sceneChanged = true;
  }

  scene.updateMatrixWorld();

  const cameraMoved = !previousCamera.equals(camera.matrixWorld);
  previousCamera.copy(camera.matrixWorld);

  hookUniforms.hookViewInverse.value.copy(camera.matrixWorld);

  const frameInfo = { index: frameIndex, time, delta, cameraMoved, sceneChanged };

  let handled = false;

  if (technique && ready) {
    technique.beforeRender(frameInfo);
    handled = technique.render(frameInfo) === true;
  }

  if (!handled) renderer.render(scene, camera);

  if (technique && ready) {
    const size = Math.max(64, Math.min(PREVIEW_SIZE, window.innerWidth - 2 * PREVIEW_MARGIN, window.innerHeight - BOTTOM_BAR - 3 * PREVIEW_MARGIN));
    technique.renderPreview(PREVIEW_MARGIN, BOTTOM_BAR + PREVIEW_MARGIN, size);
  }

  stats.end();
};

const init = async () => {
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // NOTE No PCF filtering: the bake softens shadows with noise and many samples
  renderer.shadowMap.type = THREE.BasicShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  // NOTE FPS / ms panel, below the label at the top left
  stats = new Stats();
  stats.dom.style.top = '40px';
  stats.dom.style.left = '8px';
  document.body.appendChild(stats.dom);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI / 2;

  sceneData = createScene(scene);

  const gui = new GUI({ title: 'VDB-147 · E2 baked lightmap' });
  gui.add(params, 'environment', environments).onChange(setEnvironment);
  gui.add(params, 'view', Object.keys(views)).onChange(setView);
  gui.add(params, 'animate').name('animate knot (dynamic geometry)').onChange(updateURL);

  setView(params.view);
  resize();
  window.addEventListener('resize', resize);

  document.querySelector('.package-version').textContent = 'VDB-147 demos';
  analysisElement.textContent = `${LABEL} · loading…`;

  renderer.setAnimationLoop(frame);

  try {
    technique = await createBakedLightmap(ctx);
  } catch (error) {
    console.error(error);
    analysisElement.textContent = `${LABEL} failed: ${error.message}`;
    return;
  }

  applyMaterialHook(sceneData.materials, technique.hook);
  technique.gui(gui.addFolder(LABEL));

  await setEnvironment(params.environment);
};

init();
