import { describe, expect, it } from 'vitest';
import { DataTexture, FloatType, RGBAFormat } from 'three';
import { createEnvironmentSampler, downsampleEquirect, halton } from '../src/core/sampler.js';

const WIDTH = 64;
const HEIGHT = 32;

// NOTE Sky of radiance 0.5, one bright texel (the sun) at the given row and column, row 0 at the top
const createEnvironment = (sunX, sunY, sun = 500) => {
  const data = new Float32Array(WIDTH * HEIGHT * 4);

  for (let i = 0; i < WIDTH * HEIGHT; i++) data.set([0.5, 0.5, 0.5, 1], i * 4);

  data.set([sun, sun * 0.8, sun * 0.6, 1], (sunY * WIDTH + sunX) * 4);

  const texture = new DataTexture(data, WIDTH, HEIGHT, RGBAFormat, FloatType);
  texture.flipY = true;

  return texture;
};

describe('sampler', () => {
  it('keeps the mean radiance when downsampling', () => {
    const map = downsampleEquirect(createEnvironment(10, 5), 32);
    const source = (0.5 * (WIDTH * HEIGHT - 1) + 500) / (WIDTH * HEIGHT);

    let sum = 0;

    for (let i = 0; i < map.width * map.height; i++) sum += map.data[i * 3];

    expect(map.width).toBe(32);
    expect(map.height).toBe(16);
    expect(sum / (map.width * map.height)).toBeCloseTo(source, 5);
  });

  it('samples bright texels more often, in the right direction', () => {
    // NOTE Column 48 of 64 is azimuth +90 degrees (+Z), row 4 of 32 is ~65 degrees above the horizon.
    // The sun texel has ~75% of the energy (luminance times solid angle).
    const sample = createEnvironmentSampler(
      downsampleEquirect(createEnvironment(48, 4, 5000), WIDTH),
    );

    let sunHits = 0;

    for (let i = 1; i <= 1000; i++) {
      const { direction } = sample(halton(i, 2), halton(i, 3), 0.5, 0.5);

      if (direction.z > 0.3 && direction.y > 0.8) sunHits++;
    }

    expect(sunHits).toBeGreaterThan(650);
  });

  it('is unbiased: the mean of radiance / pdf is the integral of the radiance', () => {
    const map = downsampleEquirect(createEnvironment(20, 12), WIDTH);
    const sample = createEnvironmentSampler(map);

    // NOTE Reference: sum of radiance times texel solid angle
    let reference = 0;

    for (let y = 0; y < map.height; y++) {
      const top = (0.5 - y / map.height) * Math.PI;
      const bottom = (0.5 - (y + 1) / map.height) * Math.PI;
      const solidAngle = ((2 * Math.PI) / map.width) * (Math.sin(top) - Math.sin(bottom));

      for (let x = 0; x < map.width; x++)
        reference += map.data[(y * map.width + x) * 3] * solidAngle;
    }

    let estimate = 0;
    const count = 4096;

    for (let i = 1; i <= count; i++)
      estimate += sample(halton(i, 2), halton(i, 3), halton(i, 5), halton(i, 7)).color.r;

    expect(estimate / count).toBeCloseTo(reference, 0);
  });
});
