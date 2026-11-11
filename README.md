<a href="https://github.com/mjurczyk/three-environment-shadows" target="_blank">
  <img width="100%" src="https://github.com/user-attachments/assets/0e4dec8a-fcde-4fbb-9d53-1f7ffd9d6d5c" title="Three Environment Shadows" />
</a>

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
* `Three.Mesh`, `Three.InstancedMesh` and `Three.BatchedMesh` (r170+). Each instance gets its own place in the lightmap atlas.

The meshes, instances and BatchedMesh geometries are read when `EnvironmentShadows` is created. Moved instances bake again, a new mesh, instance or geometry needs a new `EnvironmentShadows`. Receivers get new, unwrapped geometries (a BatchedMesh gets its geometry ranges packed again).

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
| `shadowBalance` | `0.5` | Shadow strength (0 to 1), higher ignores more of the weak occlusion |
| `autoUpdate` | `false` | Moved meshes, a new environment or a new layout start a new bake. When `false`, set `needsUpdate = true` to start a bake |
| `frustumAtlas` | `true` | Only meshes in the camera frustum get a place in the atlas |
| `frustumMargin` | `20` | Growth of the bounding spheres for the frustum test (percent) |
| `visibleAtlas` | `false` | Charts seen by the camera (ray test) get more atlas area |
| `visibilityResolution` | `384` | Width of the ray grid of the visibility test |
| `visibleScale` | `2` | Atlas area of the visible charts, times the area of the hidden ones |
| `bounds` | mesh bounds | `Sphere`, the area that receives shadows |
| `meshes` | scene meshes | Meshes to use, default: all meshes that cast or receive shadows |
| `exclude` | none | Objects whose meshes (children included) do not cast shadows, they still receive. `shadows.exclude` is a `Set`, changes apply to the next bake |

### Credits

* "Island Castle" demo scene: [Sea Keep "Lonely Watcher"](https://sketchfab.com/3d-models/sea-keep-lonely-watcher-09a15a0c14cb4accaf060a92bc70413d) by [Artjoms Horosilovs](https://sketchfab.com/Artjoms_Horosilovs), [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/)
