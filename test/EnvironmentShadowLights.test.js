import { describe, expect, it } from 'vitest';
import { Color, Group, Scene, Vector3 } from 'three';
import { EnvironmentShadowLights } from 'three-environment-shadows';

const createPart = (direction, intensity, coneAngle) => ({
  direction: new Vector3(...direction).normalize(),
  color: new Color(1, 1, 1),
  intensity,
  coneAngle,
});

// NOTE A source with the given parts, partitions[ n - 1 ] has the first n parts
const createSource = (parts) => {
  const intensity = parts.reduce((sum, part) => sum + part.intensity, 0);

  const partitions = parts.map((part, index) => {
    const subset = parts.slice(0, index + 1);
    const scale = intensity / subset.reduce((sum, p) => sum + p.intensity, 0);

    return subset.map((p) => createPart(p.direction.toArray(), p.intensity * scale, p.coneAngle));
  });

  return { ...partitions[0][0], energyFraction: 0.5, partitions };
};

// NOTE A sun with a sharp shadow and a softbox with a soft shadow
const sun = createSource([createPart([1, 1, 0], 3, 0.004)]);

const softbox = createSource([
  createPart([0, 1, 1], 1, 0.2),
  createPart([0.1, 1, 1], 1, 0.1),
  createPart([-0.1, 1, 1], 1, 0.1),
  createPart([0, 1.1, 1], 1, 0.1),
]);

const getTotalIntensity = (lights) =>
  lights.lights.reduce((sum, light) => sum + light.intensity, 0);

describe('EnvironmentShadowLights', () => {
  it('uses more shadow maps only for sources with a wide penumbra', () => {
    const lights = new EnvironmentShadowLights([sun, softbox], { samples: 4, maxShadowMaps: 8 });

    expect(lights.lights).toHaveLength(5);
    expect(lights.lights.every((light) => light.castShadow)).toBe(true);
    expect(lights.lights[0].shadow.radius).toBe(1);
    expect(lights.lights[1].shadow.radius).toBeGreaterThan(1);
    expect(getTotalIntensity(lights)).toBeCloseTo(sun.intensity + softbox.intensity, 9);

    lights.dispose();
  });

  it('keeps the shadow map budget and the energy', () => {
    const lights = new EnvironmentShadowLights([sun, softbox, sun], {
      samples: 4,
      maxShadowMaps: 2,
    });

    expect(lights.lights.map((light) => light.castShadow)).toEqual([true, true, false]);
    expect(getTotalIntensity(lights)).toBeCloseTo(2 * sun.intensity + softbox.intensity, 9);

    lights.dispose();
  });

  it('follows the scene environment, not the group transformation', () => {
    const lights = new EnvironmentShadowLights([sun]);
    lights.bounds.set(new Vector3(0, 1, 0), 5);

    const parent = new Group();
    parent.position.set(100, 0, 0);
    parent.rotation.y = 1;
    parent.add(lights);

    const scene = new Scene();
    scene.environmentIntensity = 2;
    scene.environmentRotation.y = Math.PI / 2;
    scene.add(parent);

    scene.updateMatrixWorld();

    const [light] = lights.lights;
    const position = new Vector3().setFromMatrixPosition(light.matrixWorld);
    const expected = sun.direction
      .clone()
      .applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
      .multiplyScalar(10)
      .add(new Vector3(0, 1, 0));

    expect(position.distanceTo(expected)).toBeLessThan(1e-9);
    expect(new Vector3().setFromMatrixPosition(light.target.matrixWorld)).toEqual(
      new Vector3(0, 1, 0),
    );
    expect(light.intensity).toBe(2 * sun.intensity);
    expect(light.shadow.camera.right).toBe(5);

    lights.dispose();
  });

  it('clones lights from the sources', () => {
    const lights = new EnvironmentShadowLights([sun, softbox], { samples: 2, maxShadowMaps: 3 });
    lights.add(new Group());

    const clone = lights.clone();

    expect(clone.lights).toHaveLength(lights.lights.length);
    expect(clone.children).toHaveLength(lights.children.length);
    expect(clone.lights.every((light) => light.target === clone.target)).toBe(true);

    lights.dispose();
    clone.dispose();
  });
});
