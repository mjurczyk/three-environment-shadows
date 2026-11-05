# three-environment-shadows

```js
import * as Three from 'three';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import { EnvironmentLightExtractor, EnvironmentShadowLights } from 'three-environment-shadows';

renderer.shadowMap.enabled = true;

const hdri = await new UltraHDRLoader().loadAsync('./environment.jpg');
hdri.mapping = Three.EquirectangularReflectionMapping;

const result = await EnvironmentLightExtractor.extract(hdri);

scene.background = hdri;
scene.environment = result.texture;

const lights = new EnvironmentShadowLights(result.lights);
lights.bounds.set(new Three.Vector3(0, 1, 0), 6);
scene.add(lights);

mesh.castShadow = true;
mesh.receiveShadow = true;
```
