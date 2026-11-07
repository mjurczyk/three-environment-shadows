import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import GUI from 'lil-gui';
import { EnvironmentShadowLights } from '../../../src/index.js';
import { createScene } from './scene.js';
import { applyMaterialHook, hookUniforms } from './materialHook.js';
import { GBuffer } from './gbuffer.js';
import { GpuTimer } from './gpuTimer.js';
import { PMREMCache, SceneBVH, downsampleEquirect, texelDirection } from './context.js';
import { techniques } from './techniques/index.js';

const search = new URLSearchParams(location.search);

const params = {
  technique: search.get('technique') ?? 'baseline',
  environment: search.get('env') ?? 'desert',
  view: search.get('view') ?? 'default',
  animate: search.get('animate') === '1',
  threshold: Number(search.get('threshold') ?? 2),
};

const CHECK = search.get('check') === '1';

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
  'fiery-sky-1-8K', // SDR
  'magic-forest-5-8K', // SDR
];

// NOTE Fixed views, so techniques can be compared on the same image
const views = {
  default: { position: [8, 5, 10], target: [0, 1, 0] },
  low: { position: [4.5, 1.2, 5.5], target: [0, 1, 0] },
  top: { position: [0.01, 13, 0.01], target: [0, 0, 0] },
  contact: { position: [-0.5, 1.6, 3.4], target: [-2.2, 0.6, -0.8] },
};

// NOTE Light presets per light mode
const lightPresets = {
  partitions: { maxLights: 2, samples: 4, maxShadowMaps: 8, mapSize: 1024 },
  hybrid: { maxLights: 2, samples: 1, maxShadowMaps: 2, mapSize: 2048 },
};

const errors = [];
const consoleError = console.error.bind(console);
console.error = (...args) => {
  errors.push(args.map(String).join(' ').slice(0, 2000));
  consoleError(...args);
};
window.addEventListener('error', (event) => errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.stack ?? event.reason)));

const renderer = new THREE.WebGLRenderer({ antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
const loader = new UltraHDRLoader().setPath(`${import.meta.env.BASE_URL}assets/`);
const statsElement = document.querySelector('#stats');
const analysisElement = document.querySelector('#analysis');
const textures = new Map();
const drawingBufferSize = new THREE.Vector2();
const previousCamera = new THREE.Matrix4();

let controls;
let gui;
let techniqueFolder;
let gpuTimer;
let sceneData;
let source = null; // the original environment map
let group = null; // EnvironmentShadowLights of the active technique
let active = null; // { definition, instance }
let switching = 0;
let frameIndex = 0;
let readyFrame = -1;
let cpuMs = null;
let fps = null;
let lastTime = performance.now();
let sceneBVH = null;

/**
 * The context given to techniques.
 */
const ctx = {
  THREE,
  renderer,
  scene,
  camera,
  params,
  get controls() {
    return controls;
  },
  get meshes() {
    return sceneData.meshes;
  },
  get dynamicMeshes() {
    return sceneData.dynamicMeshes;
  },
  get materials() {
    return sceneData.materials;
  },
  // NOTE The area that receives shadows, the same as EnvironmentShadowLights.bounds
  bounds: new THREE.Sphere(new THREE.Vector3(0, 1, 0), 6),
  gbuffer: new GBuffer(),
  pmrem: null,
  // NOTE One shared BVH of all scene meshes. Call sceneBVH.update() when frame.sceneChanged
  getSceneBVH() {
    sceneBVH ??= new SceneBVH(sceneData.meshes);
    return sceneBVH;
  },
  downsampleEquirect,
  texelDirection,
  // NOTE Renders the G-buffer (once per frame)
  renderGBuffer() {
    ctx.gbuffer.render(renderer, scene, camera, frameIndex);
    return ctx.gbuffer;
  },
  getDrawingBufferSize() {
    return renderer.getDrawingBufferSize(new THREE.Vector2());
  },
};

// NOTE Plain SDR JPGs (no gain map), loaded as 8-bit sRGB textures. Light intensities are clipped.
const sdrEnvironments = new Set(['fiery-sky-1-8K', 'magic-forest-5-8K']);

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

const environmentInfo = () => ({
  source,
  environment: scene.environment,
  lights: group?.result?.lights ?? [],
  shadowLights: group?.lights ?? [],
  pmrem: ctx.pmrem.get(scene.environment),
});

const notifyEnvironment = async (token) => {
  if (!active || token !== switching || scene.environment === null) return;

  try {
    await active.instance.setEnvironment?.(environmentInfo());
  } catch (error) {
    console.error(error);
    analysisElement.textContent = `${active.definition.label} failed: ${error.message}`;
    return;
  }

  if (token === switching) readyFrame = frameIndex;

  updateAnalysis();
};

const updateAnalysis = () => {
  const result = group?.result;

  if (!result) {
    analysisElement.textContent = active ? active.definition.label : '';
    return;
  }

  const lights = result.lights.map((light) => {
    const percent = (light.energyFraction * 100).toFixed(0);
    const cone = THREE.MathUtils.radToDeg(light.coneAngle).toFixed(1);

    return `${percent}% / ${cone}°`;
  });

  const shadowMaps = group.lights.filter((light) => light.castShadow).length;

  analysisElement.textContent =
    `${active.definition.label} · lights (energy / cone): ${lights.length > 0 ? lights.join(', ') : 'none'} · ` +
    `${shadowMaps} shadow map(s) · ${group.lights.length} light(s)`;
};

// NOTE Always resets everything, also after a technique failed to create
const disposeTechnique = () => {
  if (active) {
    try {
      active.instance.dispose?.();
    } catch (error) {
      console.error(error);
    }
  }

  applyMaterialHook(sceneData.materials, null);

  if (group) {
    group.dispose();
    group = null;
  }

  scene.environment = source;
  ctx.pmrem.clear();
  active = null;
};

const setTechnique = async (id) => {
  const token = ++switching;
  const definition = techniques.find((t) => t.id === id) ?? techniques[0];

  disposeTechnique();
  readyFrame = -1;

  params.technique = definition.id;
  updateURL();

  if (definition.lights !== 'none') {
    group = new EnvironmentShadowLights(scene, { ...lightPresets[definition.lights], threshold: params.threshold });
    group.bounds.copy(ctx.bounds);
    group.addEventListener('change', () => notifyEnvironment(token));
  }

  let instance;

  try {
    instance = await definition.create(ctx);
  } catch (error) {
    console.error(error);

    if (token === switching) {
      disposeTechnique();
      analysisElement.textContent = `${definition.label} failed: ${error.message}`;
    }

    return;
  }

  if (token !== switching) {
    instance.dispose?.();
    return;
  }

  active = { definition, instance };

  applyMaterialHook(sceneData.materials, instance.hook ?? null);

  instance.resize?.(drawingBufferSize.x, drawingBufferSize.y);

  techniqueFolder?.destroy();
  techniqueFolder = gui.addFolder(definition.label);
  instance.gui?.(techniqueFolder);

  // NOTE Without a group, the environment is ready now. With a group, its change event follows.
  if (definition.lights === 'none' || group.result !== null) notifyEnvironment(token);

  updateAnalysis();
};

const setEnvironment = async (name) => {
  params.environment = name;
  updateURL();

  const texture = await loadEnvironment(name);

  if (name !== params.environment) return;

  source = texture;
  scene.background = texture;
  scene.environment = texture;
  readyFrame = -1;

  // NOTE The group finds the lights again and dispatches change, techniques without a group get notified now
  if (!group) notifyEnvironment(switching);
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
    technique: params.technique,
    env: params.environment,
    view: params.view,
    animate: params.animate ? '1' : '0',
    threshold: String(params.threshold),
  });

  if (CHECK) query.set('check', '1');

  history.replaceState(null, '', `${location.pathname}?${query}`);
};

const resize = () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(drawingBufferSize);

  hookUniforms.hookResolution.value.copy(drawingBufferSize);
  ctx.gbuffer.setSize(drawingBufferSize.x, drawingBufferSize.y);

  active?.instance.resize?.(drawingBufferSize.x, drawingBufferSize.y);
};

const formatMs = (ms) => (ms === null ? 'n/a' : `${ms.toFixed(2)} ms`);

const updateStats = () => {
  const info = renderer.info;
  const shadowMaps = group ? group.lights.filter((light) => light.castShadow).length : 0;
  const memory = active?.instance.memory?.() ?? 0;

  const lines = [
    `${active ? active.definition.label : 'loading…'}`,
    `fps ${fps === null ? '-' : fps.toFixed(0)} · cpu ${formatMs(cpuMs)} · gpu ${formatMs(gpuTimer.ms)}`,
    `draw calls ${info.render.calls} · triangles ${info.render.triangles} · shadow maps ${shadowMaps}`,
  ];

  if (memory > 0) lines.push(`technique gpu memory ${(memory / 1048576).toFixed(1)} MB`);

  const extra = active?.instance.stats?.();

  if (extra) lines.push(extra);

  statsElement.textContent = lines.join('\n');
};

const frame = (time) => {
  const start = performance.now();
  const delta = Math.min(0.1, (start - lastTime) / 1000);

  fps = fps === null ? 1 / Math.max(delta, 1e-3) : fps * 0.95 + (1 / Math.max(delta, 1e-3)) * 0.05;
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

  renderer.info.reset();
  gpuTimer.begin();

  const frameInfo = { index: frameIndex, time, delta, cameraMoved, sceneChanged };

  let handled = false;

  if (active && readyFrame >= 0) {
    active.instance.beforeRender?.(frameInfo);
    handled = active.instance.render?.(frameInfo) === true;
  }

  if (!handled) renderer.render(scene, camera);

  gpuTimer.end();

  const spent = performance.now() - start;
  cpuMs = cpuMs === null ? spent : cpuMs * 0.9 + spent * 0.1;

  if (frameIndex % 10 === 0) updateStats();

  if (CHECK && readyFrame >= 0 && frameIndex - readyFrame === 120) {
    const report = {
      technique: params.technique,
      environment: params.environment,
      errors,
      cpuMs,
      gpuMs: gpuTimer.ms,
      stats: statsElement.textContent,
    };

    window.__demoCheck = report;
    console.log('DEMO_CHECK ' + JSON.stringify(report));
  }
};

const init = async () => {
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.info.autoReset = false;
  document.body.appendChild(renderer.domElement);

  gpuTimer = new GpuTimer(renderer.getContext());
  ctx.pmrem = new PMREMCache(renderer);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI / 2;

  sceneData = createScene(scene);

  gui = new GUI({ title: 'VDB-147 · env shadow options' });
  gui
    .add(params, 'technique', Object.fromEntries(techniques.map((t) => [t.label, t.id])))
    .onChange(setTechnique);
  gui.add(params, 'environment', environments).onChange(setEnvironment);
  gui.add(params, 'view', Object.keys(views)).onChange(setView);
  gui.add(params, 'animate').name('animate knot (dynamic geometry)').onChange(updateURL);
  gui
    .add(params, 'threshold', 2, 32, 1)
    .name('light threshold (x mean)')
    .onFinishChange(() => setTechnique(params.technique));

  setView(params.view);
  resize();
  window.addEventListener('resize', resize);

  document.querySelector('.package-version').textContent = 'VDB-147 demos';

  renderer.setAnimationLoop(frame);

  await setEnvironment(params.environment);
  await setTechnique(params.technique);
};

init();
