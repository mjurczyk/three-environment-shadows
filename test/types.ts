// NOTE Compile-time check of the type declarations (`tsc` in `npm test`)
import { DataTexture, DirectionalLight, Scene, Vector3 } from 'three';
import {
  EnvironmentLightExtractor,
  EnvironmentShadowLights,
  type ExtractedLight,
  type ExtractionResult,
} from 'three-environment-shadows';

export async function usage(hdri: DataTexture, scene: Scene): Promise<void> {
  scene.environment = hdri;

  const shadows = new EnvironmentShadowLights(scene, { maxShadowMaps: 4, threshold: 2 });
  shadows.bounds.set(new Vector3(0, 1, 0), 6);

  shadows.addEventListener('change', () => {
    const lights: ExtractedLight[] = shadows.result?.lights ?? [];
    const casters: DirectionalLight[] = shadows.lights.filter((light) => light.castShadow);

    shadows.maxShadowMaps = Math.max(lights.length, casters.length);
  });

  shadows.threshold = 4;
  shadows.needsUpdate = true;

  const result: ExtractionResult = await EnvironmentLightExtractor.extract(hdri, { samples: 4 });
  result.texture?.dispose();

  shadows.dispose();
}
