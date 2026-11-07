import { WebGLPathTracer } from 'three-gpu-pathtracer';

// NOTE Ground truth: progressive path tracing of the same scene and environment
export async function createReference(ctx) {
  const { renderer, scene, camera } = ctx;

  const pathTracer = new WebGLPathTracer(renderer);
  pathTracer.bounces = 4;
  pathTracer.minSamples = 1;
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 0;
  pathTracer.dynamicLowRes = true;
  pathTracer.tiles.set(2, 2);

  // NOTE setSceneAsync needs a BVH worker, the sync version blocks for a moment
  pathTracer.setScene(scene, camera);

  let sceneVersion = 0;

  return {
    setEnvironment() {
      pathTracer.updateEnvironment();
    },

    render(frame) {
      if (frame.sceneChanged) {
        // NOTE Animated meshes need a new BVH, very slow - the reference is for static views
        if (++sceneVersion % 30 === 0) pathTracer.setScene(scene, camera);
      }

      if (frame.cameraMoved) pathTracer.updateCamera();

      pathTracer.renderSample();

      return true;
    },

    stats() {
      return `samples ${Math.floor(pathTracer.samples)} · bounces ${pathTracer.bounces} (turn off "animate")`;
    },

    gui(folder) {
      folder.add(pathTracer, 'bounces', 1, 8, 1).onChange(() => pathTracer.reset());
    },

    dispose() {
      pathTracer.dispose();
    },
  };
}
