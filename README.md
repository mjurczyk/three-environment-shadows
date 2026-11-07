# three-environment-shadows

Soft, colored shadows from the whole environment map in your Three.js scene - every light in the HDRI casts its own shadow, no manually placed lights 🤲

Works with `WebGLRenderer` (GLSL, three.js r162+) and `WebGPURenderer` (TSL, WebGPU and its WebGL 2 fallback, three.js r172+).

```js
import * as THREE from 'three';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';
import { EnvironmentShadows } from 'three-environment-shadows';

const hdri = await new UltraHDRLoader().loadAsync('./environment.jpg');
hdri.mapping = THREE.EquirectangularReflectionMapping;

scene.background = hdri;
scene.environment = hdri;

mesh.castShadow = true;
mesh.receiveShadow = true;

const shadows = new EnvironmentShadows(renderer, scene);
await shadows.ready;

renderer.setAnimationLoop(() => {
  shadows.update(camera);
  renderer.render(scene, camera);
});
```

For `WebGPURenderer`, import from `three-environment-shadows/webgpu` and use node materials (e.g. `MeshStandardNodeMaterial`) on the meshes that receive shadows.

## How it works

1. The environment map is importance sampled by energy. Each sample is a directional light with one shadow map.
2. Each sample lights the receivers in lightmap space: every triangle is drawn at its lightmap UV, lit and shadowed in world space, and added to an atlas. Hundreds of samples give soft, colored shadows.
3. The lightmap replaces the diffuse environment light of the materials and darkens their environment reflections. It does not depend on the camera.
4. When meshes move or the environment changes, a new lightmap bakes in the background and crossfades in when it is done.
5. Meshes are unwrapped once with [xatlas](https://github.com/jpcy/xatlas). Only meshes in the camera frustum get a place in the atlas, packed by chart shape in a worker.

## Options

`new EnvironmentShadows(renderer, scene, options)`, all options are also properties:

| Option | Default | |
|---|---|---|
| `samplesPerFrame` | `24` | Shadow maps rendered per frame while a bake runs |
| `samplesPerBake` | `512` | Samples per bake, more is smoother and slower to update |
| `fadeTime` | `0.3` | Crossfade time (seconds) from the old to the new lightmap |
| `atlasSize` | `1024` | Lightmap atlas size (texels) |
| `mapSize` | `512` | Shadow map size of each sample |
| `shadowNoise` | `8` | Random offset of the shadow lookups (shadow map texels), softens stair-stepped edges |
| `directionJitter` | `2` | Random tilt of the sample directions (degrees), blends the shadows of neighboring samples |
| `specularOcclusion` | `true` | The baked visibility also darkens environment reflections |
| `frustumAtlas` | `true` | Only meshes in the camera frustum get a place in the atlas |
| `frustumMargin` | `20` | Growth of the bounding spheres for the frustum test (percent) |
| `bounds` | mesh bounds | `Sphere`, the area that receives shadows |
| `meshes` | scene meshes | Meshes to use, default: all meshes that cast or receive shadows |
| `xatlasWasmUrl` | next to the bundle | URL of `xatlas-web.wasm` |

After a change of an option that affects the bake, set `shadows.needsUpdate = true`.

## Notes

- Meshes with `receiveShadow` get a place in the lightmap (they get new geometry with lightmap UVs). Meshes with `castShadow` block light.
- `scene.environment` must be equirectangular, with its texel data on the CPU (`HDRLoader`, `EXRLoader`, `UltraHDRLoader`, or an image texture).
- The meshes are unwrapped once, when the shadows are created. Moving meshes trigger new bakes, new meshes need a new `EnvironmentShadows`.
