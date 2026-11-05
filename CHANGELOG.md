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
