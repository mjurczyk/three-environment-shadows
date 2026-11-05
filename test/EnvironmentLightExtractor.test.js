import { describe, expect, it } from 'vitest';
import { HalfFloatType, Vector3 } from 'three';
import { EnvironmentLightExtractor } from 'three-environment-shadows';
import { WIDTH, createEnvironment, getEnergy, getLuminance, getTexel, paintSun } from './utils.js';

describe('EnvironmentLightExtractor', () => {
  it('finds no light in a uniform environment', async () => {
    const result = await EnvironmentLightExtractor.extract(createEnvironment(() => {}));

    expect(result.lights).toHaveLength(0);
    expect(result.directionality).toBeLessThan(1e-6);
    expect(result.dominance).toBe(0);
  });

  it('finds the direction, color and energy of a sun', async () => {
    const elevation = Math.PI / 6;
    const azimuth = Math.PI / 2;
    const texture = createEnvironment(paintSun(elevation, azimuth, [5000, 4000, 3000]));

    const result = await EnvironmentLightExtractor.extract(texture);

    expect(result.lights).toHaveLength(1);

    const [light] = result.lights;
    const expected = new Vector3(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth),
    );
    const texelAngle = (2 * Math.PI) / WIDTH;

    expect(light.direction.angleTo(expected)).toBeLessThan(texelAngle);
    expect(light.color.g).toBeCloseTo(0.8, 3);
    expect(light.color.b).toBeCloseTo(0.6, 3);
    expect(result.directionality).toBeGreaterThan(0);

    // NOTE The sun is 3 x 3 texels, so its half-angle is between one and two texels
    expect(light.coneAngle).toBeGreaterThan(texelAngle);
    expect(light.coneAngle).toBeLessThan(2 * texelAngle);

    // NOTE The energy removed from the environment map is the energy of the light
    const original = getEnergy(texture);
    const total = getEnergy(result.texture) + getLuminance(light);

    expect(Math.abs(total - original)).toBeLessThan(1e-6 * original);
  });

  it('reads half float textures', async () => {
    const texture = createEnvironment(paintSun(Math.PI / 4, 0, [1000, 1000, 1000]), HalfFloatType);

    const result = await EnvironmentLightExtractor.extract(texture);

    expect(result.lights).toHaveLength(1);
    expect(result.texture.type).toBe(HalfFloatType);

    const original = getEnergy(texture);
    const total = getEnergy(result.texture) + getLuminance(result.lights[0]);

    // NOTE Within half float precision
    expect(Math.abs(total - original)).toBeLessThan(1e-3 * original);
  });

  it('ignores lights below the minimum elevation', async () => {
    const texture = createEnvironment(paintSun(-Math.PI / 6, 0, [5000, 5000, 5000]));

    const all = await EnvironmentLightExtractor.extract(texture);

    expect(all.lights).toHaveLength(1);

    const above = await EnvironmentLightExtractor.extract(texture, { minElevation: 0 });

    expect(above.lights).toHaveLength(0);
    expect(above.texture.image.data).toEqual(texture.image.data);
  });

  it('connects regions across the texture seam', async () => {
    // NOTE A sun at azimuth 180 degrees is split by the left and right edges of the texture
    const texture = createEnvironment((set) => {
      const [, y] = getTexel(Math.PI / 6, 0);

      for (const x of [0, 1, WIDTH - 2, WIDTH - 1]) set(x, y, [5000, 5000, 5000]);
    });

    const result = await EnvironmentLightExtractor.extract(texture);

    expect(result.lights).toHaveLength(1);
    expect(result.lights[0].direction.x).toBeLessThan(-0.85);
  });

  it('partitions keep the energy and split along the source', async () => {
    // NOTE A horizontal strip of light, 90 degrees wide
    const texture = createEnvironment((set) => {
      for (let azimuth = -Math.PI / 4; azimuth <= Math.PI / 4; azimuth += Math.PI / WIDTH) {
        const [x, y] = getTexel(Math.PI / 9, azimuth);
        set(x, y, [200, 200, 200]);
      }
    });

    const result = await EnvironmentLightExtractor.extract(texture, { samples: 4 });
    const [light] = result.lights;

    expect(light.partitions).toHaveLength(4);

    light.partitions.forEach((parts, index) => {
      const energy = parts.reduce((sum, part) => sum + getLuminance(part), 0);

      expect(parts).toHaveLength(index + 1);
      expect(Math.abs(energy - getLuminance(light))).toBeLessThan(1e-9 * energy);
    });

    // NOTE The parts are spread along the strip (z), not across it (y)
    const parts = light.partitions[3];
    const z = parts.map((part) => part.direction.z).sort((a, b) => a - b);

    expect(z[3] - z[0]).toBeGreaterThan(0.5);

    for (const part of parts) {
      expect(Math.abs(part.direction.y - parts[0].direction.y)).toBeLessThan(0.05);
      expect(part.coneAngle).toBeLessThan(light.coneAngle);
    }
  });

  it('limits the number of lights', async () => {
    const texture = createEnvironment((set) => {
      paintSun(Math.PI / 6, 0, [5000, 5000, 5000])(set);
      paintSun(Math.PI / 4, Math.PI, [3000, 3000, 3000])(set);
    });

    const two = await EnvironmentLightExtractor.extract(texture);

    expect(two.lights).toHaveLength(2);
    expect(two.lights[0].intensity).toBeGreaterThan(two.lights[1].intensity);

    const one = await EnvironmentLightExtractor.extract(texture, {
      maxLights: 1,
      removeLights: false,
    });

    expect(one.lights).toHaveLength(1);
    expect(one.texture).toBeNull();
  });

  it('keeps the texel data of the source texture', async () => {
    const texture = createEnvironment(paintSun(Math.PI / 6, 0, [5000, 5000, 5000]));
    const copy = texture.image.data.slice();

    await EnvironmentLightExtractor.extract(texture);

    expect(texture.image.data).toEqual(copy);
  });
});
