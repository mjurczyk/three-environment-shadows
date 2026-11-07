/**
 * Technique registry.
 *
 * Definition: { id, label, lights, create }
 *   lights: 'partitions' -> EnvironmentShadowLights, many partition lights (current library behaviour)
 *           'hybrid'     -> EnvironmentShadowLights with 1 light + 1 shadow map per extracted source,
 *                           scene.environment = residual (environment without the extracted sources)
 *           'none'       -> no extracted lights, scene.environment = original environment
 *   create(ctx) -> Promise<instance>
 *
 * Instance (all optional):
 *   hook                      material hook, see materialHook.js (replace IBL diffuse / specular / direct light)
 *   setEnvironment(env)       env = { source, environment, lights, shadowLights, pmrem: { texture, maxLod } }
 *                             called after every environment change / extraction; may be async
 *   beforeRender(frame)       run own passes before the main render
 *   render(frame) -> bool     return true to replace the main renderer.render(scene, camera)
 *   resize(width, height)     drawing buffer size in pixels
 *   gui(folder)               add own controls (lil-gui folder)
 *   stats() -> string         extra line(s) for the stats panel
 *   memory() -> number        GPU bytes of own resources
 *   dispose()
 *
 * frame = { index, time, delta, cameraMoved, sceneChanged }
 *
 * ctx = see main.js `ctx`.
 */
export const techniques = [
  {
    id: 'ibl',
    label: '0 · IBL only (no env shadows)',
    lights: 'none',
    create: async () => ({}),
  },
  {
    id: 'baseline',
    label: 'A · Partition dir lights (current)',
    lights: 'partitions',
    create: async () => ({}),
  },
  {
    id: 'sun',
    label: 'A2 · Sun shadow map only (hybrid, no sky visibility)',
    lights: 'hybrid',
    create: async () => ({}),
  },
  {
    id: 'rc-bvh',
    label: 'B · Radiance cascades (BVH)',
    lights: 'hybrid',
    create: (ctx) => import('./rc.js').then((m) => m.createRadianceCascades(ctx, 'bvh')),
  },
  {
    id: 'rc-ss',
    label: 'C · Radiance cascades (screen space)',
    lights: 'hybrid',
    create: (ctx) => import('./rc.js').then((m) => m.createRadianceCascades(ctx, 'screen')),
  },
  {
    id: 'sdf',
    label: 'D · SDF cone tracing',
    lights: 'hybrid',
    create: (ctx) => import('./sdf.js').then((m) => m.createSDFConeTracing(ctx)),
  },
  {
    id: 'temporal',
    label: 'E · Temporal accumulation',
    lights: 'none',
    create: (ctx) => import('./temporal.js').then((m) => m.createTemporalAccumulation(ctx)),
  },
  {
    id: 'baked',
    label: 'E2 · Background-baked lightmap (double buffered)',
    lights: 'none',
    create: (ctx) => import('./baked.js').then((m) => m.createBakedLightmap(ctx)),
  },
  {
    id: 'reference',
    label: 'Ref · Path traced (ground truth)',
    lights: 'none',
    create: (ctx) => import('./reference.js').then((m) => m.createReference(ctx)),
  },
];
