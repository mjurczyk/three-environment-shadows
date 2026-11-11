// NOTE Compile-time check of the type declarations (`tsc` in `npm test`)
import { Mesh, PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { EnvironmentShadows, type EnvironmentShadowsOptions } from 'three-environment-shadows';
import { EnvironmentShadows as EnvironmentShadowsGPU } from 'three-environment-shadows/webgpu';

export async function usage(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): Promise<void> {
  const options: EnvironmentShadowsOptions = {
    samplesPerBake: 256,
    secondaryAtlasSize: 256,
    bounds: new Sphere(new Vector3(0, 1, 0), 6),
    exclude: [new Mesh()],
  };
  const shadows = await new EnvironmentShadows(renderer, scene, options).ready;

  shadows.shadowNoise = 4;
  shadows.exclude.add(scene);
  shadows.needsUpdate = true;
  shadows.update(camera);
  shadows.dispose();
}

export async function usageWebGPU(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): Promise<void> {
  const shadows = new EnvironmentShadowsGPU(renderer, scene, { atlasSize: 512 });
  await shadows.ready;

  shadows.exclude.delete(scene);
  shadows.update(camera);
  shadows.dispose();
}
