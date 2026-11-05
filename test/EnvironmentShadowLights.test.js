import { afterEach, describe, expect, it, vi } from 'vitest';
import { CubeTexture, DataTexture, FloatType, Group, RGBAFormat, Scene, Vector3 } from 'three';
import { EnvironmentShadowLights } from 'three-environment-shadows';
import { WIDTH, createEnvironment, getTexel, paintSun } from './utils.js';

// NOTE One texel, so its penumbra is narrower than one shadow map texel
const sun = (set) => {
  const [x, y] = getTexel(Math.PI / 6, 0);
  set(x, y, [50000, 50000, 50000]);
};

const twoSuns = (set) => {
  paintSun(Math.PI / 6, 0, [5000, 5000, 5000])(set);
  paintSun(Math.PI / 4, Math.PI, [3000, 3000, 3000])(set);
};

// NOTE A horizontal strip of light, 90 degrees wide
const strip = (set) => {
  for (let azimuth = -Math.PI / 4; azimuth <= Math.PI / 4; azimuth += Math.PI / WIDTH) {
    const [x, y] = getTexel(Math.PI / 9, azimuth);
    set(x, y, [200, 200, 200]);
  }
};

const nextChange = (shadows) =>
  new Promise((resolve) => {
    const listener = () => {
      shadows.removeEventListener('change', listener);
      resolve();
    };

    shadows.addEventListener('change', listener);
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// NOTE Creates the group in a scene with the given environment map and waits for the lights
const setup = async (environment, options) => {
  const scene = new Scene();
  scene.environment = environment;

  const shadows = new EnvironmentShadowLights(scene, options);
  const changed = nextChange(shadows);

  scene.updateMatrixWorld();
  await changed;
  scene.updateMatrixWorld();

  return { scene, shadows };
};

const getTotalIntensity = (lights) => lights.reduce((sum, light) => sum + light.intensity, 0);

describe('EnvironmentShadowLights', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces the environment map and puts it back on dispose', async () => {
    const environment = createEnvironment(sun);
    const { scene, shadows } = await setup(environment);

    expect(shadows.parent).toBe(scene);
    expect(scene.environment).not.toBe(environment);
    expect(scene.environment.image.width).toBe(WIDTH);
    expect(shadows.result.lights).toHaveLength(1);
    expect(shadows.lights).toHaveLength(1);
    expect(shadows.lights[0].castShadow).toBe(true);
    expect(shadows.lights[0].shadow.radius).toBe(1);

    shadows.dispose();

    expect(scene.environment).toBe(environment);
    expect(shadows.parent).toBeNull();
    expect(shadows.lights).toHaveLength(0);
  });

  it('divides wide light sources into more shadow maps', async () => {
    const { shadows } = await setup(createEnvironment(strip), { samples: 4, maxShadowMaps: 8 });

    expect(shadows.lights.length).toBeGreaterThan(1);
    expect(shadows.lights.every((light) => light.castShadow)).toBe(true);
    expect(shadows.lights[0].shadow.radius).toBeGreaterThan(1);
    expect(getTotalIntensity(shadows.lights)).toBeCloseTo(shadows.result.lights[0].intensity, 9);
  });

  it('keeps the shadow map budget and the energy', async () => {
    const { shadows } = await setup(createEnvironment(twoSuns), { maxShadowMaps: 1 });

    expect(shadows.lights.map((light) => light.castShadow)).toEqual([true, false]);
    expect(getTotalIntensity(shadows.lights)).toBeCloseTo(
      getTotalIntensity(shadows.result.lights),
      9,
    );
  });

  it('follows changes of the environment map', async () => {
    const { scene, shadows } = await setup(createEnvironment(sun));

    scene.environment = createEnvironment(twoSuns);
    scene.updateMatrixWorld();

    // NOTE The lights of the previous environment map are removed at once
    expect(shadows.lights).toHaveLength(0);

    await nextChange(shadows);

    expect(shadows.result.lights).toHaveLength(2);

    scene.environment = null;
    scene.updateMatrixWorld();

    expect(shadows.result).toBeNull();
    expect(shadows.lights).toHaveLength(0);
    expect(scene.environment).toBeNull();
  });

  it('waits for textures that are loading', async () => {
    const scene = new Scene();
    const texture = new DataTexture(new Float32Array(0), 0, 0, RGBAFormat, FloatType);
    scene.environment = texture;

    const shadows = new EnvironmentShadowLights(scene);

    scene.updateMatrixWorld();
    await settle();

    expect(shadows.result).toBeNull();
    expect(scene.environment).toBe(texture);

    // NOTE What a loader does when the file is loaded
    texture.image = createEnvironment(sun).image;
    texture.flipY = true;
    texture.needsUpdate = true;

    const changed = nextChange(shadows);
    scene.updateMatrixWorld();
    await changed;

    expect(shadows.result.lights).toHaveLength(1);
    expect(scene.environment).not.toBe(texture);
  });

  it('warns once about environment maps without texel data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const scene = new Scene();
    const cubeTexture = new CubeTexture([{ width: 16, height: 16 }]);
    scene.environment = cubeTexture;

    const shadows = new EnvironmentShadowLights(scene);

    for (let i = 0; i < 3; i++) {
      scene.updateMatrixWorld();
      await settle();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(shadows.lights).toHaveLength(0);
    expect(scene.environment).toBe(cubeTexture);
  });

  it('puts the environment map back when removed and uses the same lights when added again', async () => {
    const environment = createEnvironment(sun);
    const { scene, shadows } = await setup(environment);

    const residual = scene.environment;
    const change = vi.fn();
    shadows.addEventListener('change', change);

    scene.remove(shadows);

    expect(scene.environment).toBe(environment);

    scene.add(shadows);
    scene.updateMatrixWorld();
    await settle();

    expect(scene.environment).toBe(residual);
    expect(change).not.toHaveBeenCalled();
  });

  it('finds the light sources again when needsUpdate is set', async () => {
    const { scene, shadows } = await setup(createEnvironment(twoSuns));

    const previous = scene.environment;
    const disposed = vi.fn();
    previous.addEventListener('dispose', disposed);

    expect(shadows.result.lights).toHaveLength(2);

    shadows.maxLights = 1;
    shadows.needsUpdate = true;

    const changed = nextChange(shadows);
    scene.updateMatrixWorld();
    await changed;

    expect(shadows.result.lights).toHaveLength(1);
    expect(scene.environment).not.toBe(previous);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('follows the scene environment, not the group transformation', async () => {
    const { scene, shadows } = await setup(createEnvironment(sun));

    const parent = new Group();
    parent.position.set(100, 0, 0);
    parent.rotation.y = 1;
    scene.add(parent);
    parent.add(shadows);

    shadows.bounds.set(new Vector3(0, 1, 0), 5);
    scene.environmentIntensity = 2;
    scene.environmentRotation.y = Math.PI / 2;

    scene.updateMatrixWorld();

    const [light] = shadows.lights;
    const [source] = shadows.result.lights;
    const position = new Vector3().setFromMatrixPosition(light.matrixWorld);
    const expected = source.direction
      .clone()
      .applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
      .multiplyScalar(10)
      .add(new Vector3(0, 1, 0));

    expect(position.distanceTo(expected)).toBeLessThan(1e-9);
    expect(new Vector3().setFromMatrixPosition(light.target.matrixWorld)).toEqual(
      new Vector3(0, 1, 0),
    );
    expect(light.intensity).toBe(2 * source.intensity);
    expect(light.shadow.camera.right).toBe(5);
  });

  it('clones the options, not the lights', async () => {
    const { shadows } = await setup(createEnvironment(sun), { samples: 2, maxShadowMaps: 3 });
    shadows.add(new Group());

    const clone = shadows.clone();

    expect(clone.samples).toBe(2);
    expect(clone.maxShadowMaps).toBe(3);
    expect(clone.lights).toHaveLength(0);
    expect(clone.children).toHaveLength(2);
  });
});
