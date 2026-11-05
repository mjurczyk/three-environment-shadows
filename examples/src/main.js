import * as Three from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import GUI from 'lil-gui';
import { EnvironmentLightExtractor, EnvironmentShadowLights } from '../../src/index.js';
import packageInfo from '../../package.json';

const params = {
  environment: 'desert',
  quality: 'medium',
  threshold: 2,
  shadows: true,
  helpers: false,
};

// NOTE The number of lights, shadow maps and parts of large light sources
const qualities = {
  low: { maxLights: 1, samples: 1, maxShadowMaps: 1, mapSize: 1024 },
  medium: { maxLights: 2, samples: 1, maxShadowMaps: 2, mapSize: 2048 },
  high: { maxLights: 2, samples: 4, maxShadowMaps: 8, mapSize: 1024 },
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
];

const renderer = new Three.WebGLRenderer({ antialias: true });
const scene = new Three.Scene();
const camera = new Three.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
const loader = new UltraHDRLoader().setPath(`${import.meta.env.BASE_URL}assets/`);
const analysis = document.querySelector('#analysis');
const textures = new Map();
const helpers = [];

let environmentLights;
let knot;
let residualTexture = null;
let request = 0;

const createScene = () => {
  const ground = new Three.Mesh(
    new Three.CircleGeometry(6, 64),
    new Three.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.9 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const material = new Three.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const metal = new Three.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 1 });

  knot = new Three.Mesh(new Three.TorusKnotGeometry(0.8, 0.3, 128, 32), material);
  knot.position.set(0, 1.8, 0);
  scene.add(knot);

  const box = new Three.Mesh(new Three.BoxGeometry(1.2, 2.4, 1.2), material);
  box.position.set(-2.5, 1.2, -1);
  box.rotation.y = 0.4;
  scene.add(box);

  const sphere = new Three.Mesh(new Three.SphereGeometry(0.7, 64, 32), metal);
  sphere.position.set(2.4, 0.7, 1.2);
  scene.add(sphere);

  for (let i = 0; i < 8; i++) {
    const pillar = new Three.Mesh(new Three.CylinderGeometry(0.12, 0.12, 2, 16), material);
    const angle = (i / 8) * Math.PI * 2;
    pillar.position.set(Math.cos(angle) * 4.5, 1, Math.sin(angle) * 4.5);
    scene.add(pillar);
  }

  scene.traverse((object) => {
    if (object.isMesh && object !== ground) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
};

const loadEnvironment = async (name) => {
  if (!textures.has(name)) {
    const texture = await loader.loadAsync(`${name}.jpg`);
    texture.mapping = Three.EquirectangularReflectionMapping;
    textures.set(name, texture);
  }

  return textures.get(name);
};

const updateHelpers = () => {
  for (const helper of helpers) {
    scene.remove(helper);
    helper.dispose();
  }

  helpers.length = 0;

  if (!params.helpers) return;

  for (const light of environmentLights.lights) {
    const helper = new Three.DirectionalLightHelper(light, 0.5);
    scene.add(helper);
    helpers.push(helper);
  }
};

const updateAnalysis = (result) => {
  if (result === null) {
    analysis.textContent = '';
    return;
  }

  const lights = result.lights.map((light) => {
    const percent = (light.energyFraction * 100).toFixed(0);
    const cone = Three.MathUtils.radToDeg(light.coneAngle).toFixed(1);

    return `${percent}% / ${cone}°`;
  });

  const shadowMaps = environmentLights.lights.filter((light) => light.castShadow).length;

  analysis.textContent =
    `directionality ${result.directionality.toFixed(2)} · ` +
    `lights (energy / cone): ${lights.length > 0 ? lights.join(', ') : 'none'} · ` +
    `${shadowMaps} shadow map(s)`;
};

const updateEnvironment = async () => {
  // NOTE Ignore the results of older requests
  const currentRequest = ++request;

  const texture = await loadEnvironment(params.environment);

  if (currentRequest !== request) return;

  const quality = qualities[params.quality];

  let result = null;

  if (params.shadows) {
    result = await EnvironmentLightExtractor.extract(texture, {
      maxLights: quality.maxLights,
      samples: quality.samples,
      threshold: params.threshold,
    });

    if (currentRequest !== request) {
      result.texture.dispose();
      return;
    }
  }

  if (residualTexture !== null) residualTexture.dispose();

  scene.background = texture;

  if (result === null) {
    // NOTE The original environment, without shadows
    residualTexture = null;
    scene.environment = texture;
    environmentLights.setLights([]);
  } else {
    // NOTE The extracted lights are removed from the environment, so the scene is not lit twice
    residualTexture = result.texture;
    scene.environment = residualTexture;

    environmentLights.samples = quality.samples;
    environmentLights.maxShadowMaps = quality.maxShadowMaps;
    environmentLights.mapSize = quality.mapSize;
    environmentLights.setLights(result.lights);
  }

  updateHelpers();
  updateAnalysis(result);
};

const init = () => {
  document.querySelector('.package-version').textContent = `v${packageInfo.version}`;

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = Three.PCFShadowMap;
  renderer.toneMapping = Three.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  camera.position.set(8, 5, 10);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI / 2;
  controls.update();

  createScene();

  environmentLights = new EnvironmentShadowLights();
  environmentLights.bounds.set(new Three.Vector3(0, 1, 0), 6);
  scene.add(environmentLights);

  const gui = new GUI();
  gui.add(params, 'environment', environments).onChange(updateEnvironment);
  gui.add(params, 'quality', Object.keys(qualities)).onChange(updateEnvironment);
  gui.add(params, 'threshold', 2, 32, 1).name('threshold (x mean)').onChange(updateEnvironment);
  gui.add(params, 'shadows').name('environment shadows').onChange(updateEnvironment);
  gui.add(params, 'helpers').onChange(updateHelpers);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const timer = new Three.Timer();

  renderer.setAnimationLoop((time) => {
    timer.update(time);
    knot.rotation.y += timer.getDelta() * 0.5;

    // NOTE Position the lights before the helpers read them
    scene.updateMatrixWorld();

    for (const helper of helpers) helper.update();

    renderer.render(scene, camera);
  });

  updateEnvironment();
};

init();
