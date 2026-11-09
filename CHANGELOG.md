# v2.0.x

Core:

- Replace `EnvironmentLightExtractor` and `EnvironmentShadowLights` with `EnvironmentShadows`: soft, colored shadows from the whole environment map, baked into a lightmap atlas in the background
- Add `three-environment-shadows/webgpu`: TSL version for `WebGPURenderer`
- Support three.js r162+ (`WebGLRenderer`) and r172+ (`WebGPURenderer`)
- The baked lightmap follows `scene.environmentIntensity` (or `material.envMapIntensity` with `material.envMap`)

Examples:

- One example with WebGL (GLSL) and WebGPU (TSL)

# v1.0.x

Core:

- `EnvironmentShadowLights` reads `scene.environment`: `new EnvironmentShadowLights(scene)`
- Replace `setLights()` with `needsUpdate` and the `change` event

# v0.1.x

Core:

- Add `EnvironmentLightExtractor`: light sources, directionality and environment map without the lights
- Add `EnvironmentShadowLights`: shadow casting lights with a shadow map budget and soft shadows for large sources

Examples:

- Add environment shadows example
