import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * E · Temporal accumulation of importance-sampled shadow maps.
 *
 * Each frame picks a few directions from the whole environment (sun included), with a probability
 * proportional to their energy. For each direction one shadow casting DirectionalLight renders the
 * diffuse irradiance of the scene (Lambert, white) into a float target. A running mean over frames
 * converges to the shadowed environment irradiance. When the camera moves the mean starts again.
 * With 'moving average' mode, animated geometry keeps a short history instead (ghosting, noise).
 */

const accumulateFragment = /* glsl */ `
  precision highp float;

  uniform sampler2D uPrevious;
  uniform sampler2D uSample;
  uniform float uWeight;

  void main() {
    ivec2 pixel = ivec2( gl_FragCoord.xy );
    vec3 previous = texelFetch( uPrevious, pixel, 0 ).rgb;
    // NOTE Lambert output is E / PI for white albedo
    vec3 irradiance = 3.14159265 * texelFetch( uSample, pixel, 0 ).rgb;

    gl_FragColor = vec4( mix( previous, irradiance, uWeight ), 1.0 );
  }
`;

const passVertex = /* glsl */ `
  void main() {
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

// NOTE Radical inverse, for a low-discrepancy (Halton) sample sequence
export const halton = (index, base) => {
  let result = 0;
  let f = 1 / base;
  let i = index;

  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }

  return result;
};

// NOTE Energy CDF of an equirect map with row 0 at the top
export function buildSampler(map) {
  const { data, width, height } = map;
  const rowSolidAngle = new Float64Array(height);
  const conditional = new Float64Array(width * height);
  const marginal = new Float64Array(height);

  let total = 0;

  for (let y = 0; y < height; y++) {
    const top = (0.5 - y / height) * Math.PI;
    const bottom = (0.5 - (y + 1) / height) * Math.PI;

    rowSolidAngle[y] = ((2 * Math.PI) / width) * (Math.sin(top) - Math.sin(bottom));

    let row = 0;

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

      row += Math.max(0, luminance) * rowSolidAngle[y];
      conditional[y * width + x] = row;
    }

    total += row;
    marginal[y] = total;
  }

  const search = (array, offset, count, value) => {
    let low = 0;
    let high = count - 1;

    while (low < high) {
      const mid = (low + high) >> 1;

      if (array[offset + mid] < value) low = mid + 1;
      else high = mid;
    }

    return low;
  };

  const direction = new THREE.Vector3();
  const color = new THREE.Color();

  // NOTE Returns { direction, color = radiance / pdf } for four uniform numbers (texel, position in texel)
  return (u1, u2, fx, fy) => {
    const y = search(marginal, 0, height, u1 * total);
    const rowStart = y > 0 ? marginal[y - 1] : 0;
    const rowTotal = marginal[y] - rowStart;

    const x = search(conditional, y * width, width, u2 * rowTotal);

    const phi = ((x + fx) / width - 0.5) * 2 * Math.PI;
    const lat = (0.5 - (y + fy) / height) * Math.PI;

    direction.set(Math.cos(lat) * Math.cos(phi), Math.sin(lat), Math.cos(lat) * Math.sin(phi));

    const i = (y * width + x) * 3;
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    // NOTE pdf per solid angle = ( luminance * texel solid angle / total ) / texel solid angle
    const pdf = Math.max(1e-12, luminance / total);

    color.setRGB(data[i] / pdf, data[i + 1] / pdf, data[i + 2] / pdf);

    return { direction, color };
  };
}

const makeTarget = (width, height, depthBuffer) =>
  new THREE.WebGLRenderTarget(width, height, {
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer,
  });

export async function createTemporalAccumulation(ctx) {
  const { renderer, scene, camera, bounds } = ctx;

  const settings = {
    samplesPerFrame: 4,
    maxSamples: 1024,
    mode: 'converge',
    movingAverage: 0.08,
    mapSize: 2048,
    specularOcclusion: true,
  };

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  light.shadow.radius = 1;

  const target = new THREE.Object3D();
  light.target = target;

  const lambert = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const accumulateMaterial = new THREE.ShaderMaterial({
    vertexShader: passVertex,
    fragmentShader: accumulateFragment,
    uniforms: { uPrevious: { value: null }, uSample: { value: null }, uWeight: { value: 1 } },
  });

  const quad = new FullScreenQuad(accumulateMaterial);

  const sampleTarget = makeTarget(1, 1, true);
  const accumulation = [makeTarget(1, 1, false), makeTarget(1, 1, false)];

  const hookUniforms = {
    taIrradiance: { value: accumulation[0].texture },
    taValid: { value: 0 },
    taSpecularOcclusion: { value: 1 },
  };

  let sample = null;
  let count = 0;
  let sequence = 0;
  let current = 0;

  const reset = () => {
    count = 0;
    hookUniforms.taValid.value = 0;
  };

  const setMapSize = () => {
    light.shadow.mapSize.setScalar(settings.mapSize);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  };

  setMapSize();

  const renderSample = (direction, color) => {
    const { center, radius } = bounds;

    light.position.copy(direction).multiplyScalar(2 * radius).add(center);
    target.position.copy(center);
    light.color.copy(color);

    const shadowCamera = light.shadow.camera;
    shadowCamera.left = -radius;
    shadowCamera.right = radius;
    shadowCamera.top = radius;
    shadowCamera.bottom = -radius;
    shadowCamera.near = radius;
    shadowCamera.far = 3 * radius;
    shadowCamera.updateProjectionMatrix();
    light.shadow.normalBias = (2 * radius) / settings.mapSize;

    light.updateMatrixWorld();
    target.updateMatrixWorld();

    renderer.setRenderTarget(sampleTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
  };

  return {
    hook: {
      key: 'temporal',
      uniforms: hookUniforms,
      pars: /* glsl */ `
        uniform sampler2D taIrradiance;
        uniform float taValid;
        uniform float taSpecularOcclusion;

        float taVisibility = 1.0;

        float taLuminance( vec3 c ) {
          return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
        }
      `,
      diffuse: /* glsl */ `
        vec3 taUnoccluded = getIBLIrradiance( geometryNormal );
        vec3 taAccumulated = taValid > 0.5 ? texture2D( taIrradiance, hookScreenUv() ).rgb : taUnoccluded;

        taVisibility = clamp( taLuminance( taAccumulated ) / max( 1e-6, taLuminance( taUnoccluded ) ), 0.0, 1.0 );
        iblIrradiance += taAccumulated;
      `,
      specular: /* glsl */ `
        iblRadiance *= mix( 1.0, taVisibility, taSpecularOcclusion );
      `,
    },

    setEnvironment(info) {
      sample = buildSampler(ctx.downsampleEquirect(info.source, 512));
      reset();
    },

    resize(width, height) {
      sampleTarget.setSize(width, height);
      for (const t of accumulation) t.setSize(width, height);
      reset();
    },

    beforeRender(frame) {
      if (!sample) return;

      const moving = settings.mode === 'moving average';

      if (frame.cameraMoved || (frame.sceneChanged && !moving)) reset();

      if (count >= settings.maxSamples && !(moving && frame.sceneChanged)) return;

      // NOTE Only the sample light, no environment, every mesh casts (the ground blocks light from below)
      const background = scene.background;
      const environment = scene.environment;
      const override = scene.overrideMaterial;
      const previousTarget = renderer.getRenderTarget();
      const clearColor = renderer.getClearColor(new THREE.Color());
      const clearAlpha = renderer.getClearAlpha();
      const castShadow = ctx.meshes.map((mesh) => mesh.castShadow);

      scene.background = null;
      scene.environment = null;
      scene.overrideMaterial = lambert;
      for (const mesh of ctx.meshes) mesh.castShadow = true;
      scene.add(light, target);

      for (let s = 0; s < settings.samplesPerFrame; s++) {
        sequence++;

        const { direction, color } = sample(
          halton(sequence, 2),
          halton(sequence, 3),
          halton(sequence, 5),
          halton(sequence, 7),
        );

        renderSample(direction, color);

        const weight = moving ? Math.max(settings.movingAverage, 1 / (count + 1)) : 1 / (count + 1);

        accumulateMaterial.uniforms.uPrevious.value = accumulation[current].texture;
        accumulateMaterial.uniforms.uSample.value = sampleTarget.texture;
        accumulateMaterial.uniforms.uWeight.value = weight;

        current = 1 - current;
        renderer.setRenderTarget(accumulation[current]);
        quad.render(renderer);

        count++;
      }

      scene.remove(light, target);
      ctx.meshes.forEach((mesh, i) => (mesh.castShadow = castShadow[i]));
      scene.background = background;
      scene.environment = environment;
      scene.overrideMaterial = override;
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(clearColor, clearAlpha);

      hookUniforms.taIrradiance.value = accumulation[current].texture;
      hookUniforms.taValid.value = 1;
      hookUniforms.taSpecularOcclusion.value = settings.specularOcclusion ? 1 : 0;
    },

    gui(folder) {
      folder.add(settings, 'samplesPerFrame', 1, 16, 1).name('shadow maps / frame');
      folder.add(settings, 'maxSamples', 64, 4096, 64).name('stop after samples');
      folder.add(settings, 'mode', ['converge', 'moving average']).onChange(reset);
      folder.add(settings, 'movingAverage', 0.01, 0.5, 0.01).name('moving average weight');
      folder.add(settings, 'mapSize', [512, 1024, 2048, 4096]).name('shadow map size').onChange(() => {
        setMapSize();
        reset();
      });
      folder.add(settings, 'specularOcclusion').name('specular occlusion');
    },

    stats() {
      const done = count >= settings.maxSamples;

      return `samples ${count} / ${settings.maxSamples}${done ? ' (converged, 0 cost)' : ''} · ${settings.samplesPerFrame} shadow maps + scene renders / frame\nresets when the camera moves`;
    },

    memory() {
      const pixels = sampleTarget.width * sampleTarget.height;
      const shadow = settings.mapSize * settings.mapSize * 4;

      return pixels * 16 * 3 + pixels * 4 + shadow;
    },

    dispose() {
      scene.remove(light, target);
      light.dispose();
      lambert.dispose();
      accumulateMaterial.dispose();
      quad.dispose();
      sampleTarget.dispose();
      for (const t of accumulation) t.dispose();
    },
  };
}
