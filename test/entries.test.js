import { describe, expect, it } from 'vitest';
import { EnvironmentShadows } from 'three-environment-shadows';

describe('entries', () => {
  it('exports EnvironmentShadows for WebGLRenderer', () => {
    expect(typeof EnvironmentShadows).toBe('function');
  });

  it('exports EnvironmentShadows for WebGPURenderer', async () => {
    const { EnvironmentShadows: EnvironmentShadowsGPU } =
      await import('three-environment-shadows/webgpu');

    expect(typeof EnvironmentShadowsGPU).toBe('function');
    expect(EnvironmentShadowsGPU).not.toBe(EnvironmentShadows);
  });
});
