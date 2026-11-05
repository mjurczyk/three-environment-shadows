# three-environment-shadows

Use environment as a source of light and _shadows_ in your Three.js scene.
Extracts light sources from environment map automatically - no need for any more of the manually set PointLights and SunLights 🤲

```js
import * as Three from 'three';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import { EnvironmentShadowLights } from 'three-environment-shadows';

renderer.shadowMap.enabled = true;

const hdri = await new UltraHDRLoader().loadAsync('./environment.jpg');
hdri.mapping = Three.EquirectangularReflectionMapping;

scene.background = hdri;
scene.environment = hdri;

const shadows = new EnvironmentShadowLights(scene);
shadows.bounds.set(new Three.Vector3(0, 1, 0), 6);

mesh.castShadow = true;
mesh.receiveShadow = true;
```
