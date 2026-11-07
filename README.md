# three-environment-shadows

Use environment as a source of light and _shadows_ in your Three.js scene.
Extracts light sources from environment map automatically - no need for any more of the manually set PointLights and SunLights 🤲

## Example

```js
// NOTE WebGLRenderer

import * as Three from 'three';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import { EnvironmentShadows } from 'three-environment-shadows';

const hdri = await new UltraHDRLoader().loadAsync('./environment.jpg');
hdri.mapping = Three.EquirectangularReflectionMapping;

scene.background = hdri;
scene.environment = hdri;

mesh.castShadow = true;
mesh.receiveShadow = true;

const shadows = new EnvironmentShadows(renderer, scene, {
  bounds: new Three.Sphere(new Three.Vector3(0, 1, 0), 6),
});
await shadows.ready;

renderer.setAnimationLoop(() => {
  shadows.update(camera);
  renderer.render(scene, camera);
});
```


```js
// NOTE WebGPURenderer

import * as Three from 'three/webgpu';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import { EnvironmentShadows } from 'three-environment-shadows/webgpu';

await renderer.init();

const hdri = await new UltraHDRLoader().loadAsync('./environment.jpg');
hdri.mapping = Three.EquirectangularReflectionMapping;

scene.background = hdri;
scene.environment = hdri;

mesh.material = new Three.MeshStandardNodeMaterial();
mesh.castShadow = true;
mesh.receiveShadow = true;

const shadows = new EnvironmentShadows(renderer, scene, {
  bounds: new Three.Sphere(new Three.Vector3(0, 1, 0), 6),
});
await shadows.ready;

renderer.setAnimationLoop(() => {
  shadows.update(camera);
  renderer.render(scene, camera);
});
```

### Support

* `Three.WebGLRenderer` (GLSL) r162+
* `Three.WebGPURenderer` (TSL) r172+

### Props

| Option | Default | |
|---|---|---|
| `samplesPerFrame` | `24` | Shadow maps rendered per frame while a bake runs |
| `samplesPerBake` | `512` | Samples per bake, more is smoother and slower to update |
| `fadeTime` | `0.3` | Crossfade time (seconds) from the old to the new lightmap |
| `mapSize` | `512` | Shadow map size of each sample |
| `atlasSize` | `1024` | Lightmap atlas size (texels) |
| `shadowNoise` | `8` | Random offset of the shadow lookups (shadow map texels), softens stair-stepped edges |
| `directionJitter` | `2` | Random tilt of the sample directions (degrees), blends the shadows of neighboring samples |
| `specularOcclusion` | `true` | The baked visibility also darkens environment reflections |
| `frustumAtlas` | `true` | Only meshes in the camera frustum get a place in the atlas |
| `frustumMargin` | `20` | Growth of the bounding spheres for the frustum test (percent) |
| `bounds` | mesh bounds | `Sphere`, the area that receives shadows |
| `meshes` | scene meshes | Meshes to use, default: all meshes that cast or receive shadows |
