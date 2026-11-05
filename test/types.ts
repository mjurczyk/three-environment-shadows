// NOTE Compile-time check of the type declarations (`tsc` in `npm test`)
import { DataTexture, DirectionalLight, Scene, Sphere, Vector3 } from 'three';
import {
  EnvironmentLightExtractor,
  EnvironmentShadowLights,
  type ExtractedLight,
  type ExtractionResult,
} from 'three-environment-shadows';

export async function usage(hdr: DataTexture, scene: Scene): Promise<void> {
  const result: ExtractionResult = await EnvironmentLightExtractor.extract(hdr, {
    maxLights: 2,
    threshold: 8,
    samples: 4,
  });

  const first: ExtractedLight | undefined = result.lights[0];
  const parts: number = first ? first.partitions[first.partitions.length - 1].length : 0;

  if (result.texture !== null) scene.environment = result.texture;

  const lights = new EnvironmentShadowLights(result.lights, { maxShadowMaps: parts + 1 });
  lights.bounds.copy(new Sphere(new Vector3(0, 1, 0), 6));
  lights.setLights(result.lights).dispose();

  const shadowCasters: DirectionalLight[] = lights.lights.filter((light) => light.castShadow);
  lights.maxShadowMaps = shadowCasters.length;
  scene.add(lights);
}
