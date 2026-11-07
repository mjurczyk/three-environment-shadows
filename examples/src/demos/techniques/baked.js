import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { buildSampler, halton } from './temporal.js';
import { createLightmapLayout } from './lightmapLayout.js';

/**
 * E2 · Background-baked lightmap (double buffered).
 *
 * The same importance-sampled shadow maps as E, accumulated in a lightmap atlas instead of screen
 * space. The result does not depend on the camera, so camera moves cost nothing.
 *
 * - front: the finished lightmap on screen
 * - back:  a bake in progress, from a snapshot of the object transforms at its start
 *
 * When objects move (or the environment changes), a new bake starts in the background. The front stays
 * on screen until the bake has all its samples, then the new lightmap crossfades in. While objects keep
 * moving, bakes run back to back, each one consistent with its own snapshot. When nothing changes, the
 * technique renders no shadow maps at all.
 */

const passVertex = /* glsl */ `
  void main() {
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

// NOTE Sum (rgb = irradiance sum, a = sample count) -> mean, empty texels take the nearest filled texel
const finalizeFragment = /* glsl */ `
  precision highp float;

  uniform sampler2D uSum;
  uniform ivec2 uSize;
  uniform float uScale; // the samples are added pre-scaled by 1 / uScale

  #define DILATE 4

  void main() {
    ivec2 pixel = ivec2( gl_FragCoord.xy );
    vec4 sum = texelFetch( uSum, pixel, 0 );

    if ( sum.a > 0.0 ) {
      gl_FragColor = vec4( sum.rgb * uScale / sum.a, 1.0 );
      return;
    }

    for ( int r = 1; r <= DILATE; r ++ ) {
      for ( int y = - r; y <= r; y ++ ) {
        for ( int x = - r; x <= r; x ++ ) {
          if ( abs( x ) != r && abs( y ) != r ) continue;

          ivec2 p = clamp( pixel + ivec2( x, y ), ivec2( 0 ), uSize - 1 );
          vec4 s = texelFetch( uSum, p, 0 );

          if ( s.a > 0.0 ) {
            gl_FragColor = vec4( s.rgb * uScale / s.a, 1.0 );
            return;
          }
        }
      }
    }

    gl_FragColor = vec4( 0.0 );
  }
`;

// NOTE Per lightmap texel and per sample random offset of the shadow map lookup, in shadow map UV
const JITTER_PARS = /* glsl */ `
  uniform float bakeNoise; // in shadow map texels
  uniform float bakeSeed; // changes every sample
  uniform float bakeMapTexel; // 1 / shadow map size

  float bakeHash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  vec4 bakeShadowJitter() {
    vec2 seed = gl_FragCoord.xy + vec2( bakeSeed * 17.31, bakeSeed * 5.79 );
    vec2 offset = vec2( bakeHash( seed ), bakeHash( seed.yx + 11.7 ) ) * 2.0 - 1.0;
    return vec4( offset * bakeNoise * bakeMapTexel, 0.0, 0.0 );
  }
`;

const SHADOW_COORD = 'vDirectionalShadowCoord[ i ]';

// NOTE Lambert in lightmap space: each triangle is drawn at its lightmap UV, lit and shadowed in world space
function createBakeMaterial(jitterUniforms) {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    shadowSide: THREE.BackSide,
    // NOTE Plain sum: rgb += sample, a += 1 (sample count)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec2 lightmapUv;\nvoid main() {')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\ngl_Position = vec4( lightmapUv * 2.0 - 1.0, 0.0, 1.0 );');

    // NOTE The winding in lightmap space is arbitrary (xatlas mirrors some charts), keep the geometric normal.
    // onBeforeCompile sees the #include lines, so the chunk is replaced as a whole.
    const faceLine = 'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;';
    const normalChunk = THREE.ShaderChunk.normal_fragment_begin;

    if (!normalChunk.includes(faceLine) || !shader.fragmentShader.includes('#include <normal_fragment_begin>')) {
      throw new Error('baked: three.js normal chunk changed, update the faceDirection patch');
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      normalChunk.replace(faceLine, 'float faceDirection = 1.0;'),
    );

    // NOTE Shadow noise: the shadow lookup of the directional light gets a random offset
    const lightsChunk = THREE.ShaderChunk.lights_fragment_begin;

    if (!lightsChunk.includes(SHADOW_COORD)) {
      throw new Error('baked: three.js lights chunk changed, update the shadow jitter patch');
    }

    Object.assign(shader.uniforms, jitterUniforms);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${JITTER_PARS}\nvoid main() {`)
      .replace(
        '#include <lights_fragment_begin>',
        lightsChunk.replaceAll(SHADOW_COORD, `( ${SHADOW_COORD} + bakeShadowJitter() )`),
      );
  };

  material.customProgramCacheKey = () => 'lightmap-bake';

  return material;
}

const makeTarget = (size, type, filter) =>
  new THREE.WebGLRenderTarget(size, size, {
    type,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
    generateMipmaps: false,
  });

export async function createBakedLightmap(ctx) {
  const { renderer, bounds } = ctx;

  const settings = {
    atlasSize: 1024,
    samplesPerFrame: 64,
    samplesPerBake: 1000,
    fadeTime: 0.25,
    mapSize: 512,
    specularOcclusion: true,
    shadowNoise: 2,
    directionJitter: 0,
    shadowBlur: 2,
    debug: 'off',
  };

  const unwrapStart = performance.now();
  await createLightmapLayout(ctx.meshes, settings.atlasSize);
  const unwrapMs = performance.now() - unwrapStart;

  // NOTE Bake scene: proxies share the geometry, their transforms are a snapshot taken at bake start
  const bakeScene = new THREE.Scene();
  const bakeCamera = new THREE.OrthographicCamera();
  const jitterUniforms = {
    bakeNoise: { value: settings.shadowNoise },
    bakeSeed: { value: 0 },
    bakeMapTexel: { value: 1 / settings.mapSize },
  };
  const bakeMaterial = createBakeMaterial(jitterUniforms);

  const proxies = ctx.meshes.map((mesh) => {
    const proxy = new THREE.Mesh(mesh.geometry, bakeMaterial);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.frustumCulled = false;
    proxy.castShadow = true;
    proxy.receiveShadow = true;
    bakeScene.add(proxy);
    return proxy;
  });

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  light.shadow.radius = settings.shadowBlur;
  light.shadow.mapSize.setScalar(settings.mapSize);

  const jitterAxis = new THREE.Vector3();
  const jitterTangent = new THREE.Vector3();
  const jitterBitangent = new THREE.Vector3();

  // NOTE Tilts the direction by a random angle, uniform over a cone with the given half-angle
  const jitterDirection = (direction, halfAngle, u1, u2) => {
    if (halfAngle <= 0) return direction;

    jitterAxis.copy(direction);
    jitterTangent.set(Math.abs(jitterAxis.y) < 0.99 ? 0 : 1, Math.abs(jitterAxis.y) < 0.99 ? 1 : 0, 0).cross(jitterAxis).normalize();
    jitterBitangent.crossVectors(jitterAxis, jitterTangent);

    const cosTheta = 1 - u2 * (1 - Math.cos(halfAngle));
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = 2 * Math.PI * u1;

    return direction
      .copy(jitterAxis)
      .multiplyScalar(cosTheta)
      .addScaledVector(jitterTangent, sinTheta * Math.cos(phi))
      .addScaledVector(jitterBitangent, sinTheta * Math.sin(phi))
      .normalize();
  };

  const target = new THREE.Object3D();
  light.target = target;
  bakeScene.add(light, target);

  const finalizeMaterial = new THREE.ShaderMaterial({
    vertexShader: passVertex,
    fragmentShader: finalizeFragment,
    uniforms: { uSum: { value: null }, uSize: { value: new THREE.Vector2() }, uScale: { value: 1 } },
  });

  const debugMaterial = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec2 uViewport;
      varying vec2 vUv;
      void main() {
        // NOTE Square atlas, centered
        vec2 p = gl_FragCoord.xy / uViewport;
        float aspect = uViewport.x / uViewport.y;
        vec2 uv = vec2( ( p.x - 0.5 ) * aspect + 0.5, p.y );
        if ( uv.x < 0.0 || uv.x > 1.0 ) { gl_FragColor = vec4( 0.1, 0.1, 0.1, 1.0 ); return; }
        vec3 c = texture2D( uMap, uv ).rgb / 3.14159265;
        gl_FragColor = vec4( pow( c / ( 1.0 + c ), vec3( 1.0 / 2.2 ) ), 1.0 );
      }
    `,
    uniforms: { uMap: { value: null }, uViewport: { value: new THREE.Vector2() } },
  });

  const quad = new FullScreenQuad(finalizeMaterial);

  // NOTE Blending into 32-bit float targets needs EXT_float_blend, three.js does not enable it
  const floatBlend = renderer.getContext().getExtension('EXT_float_blend') !== null;
  const sumType = floatBlend ? THREE.FloatType : THREE.HalfFloatType;

  let sumTarget = makeTarget(settings.atlasSize, sumType, THREE.NearestFilter);
  // NOTE [ front, previous ], swapped when a bake finishes
  let lightmaps = [
    makeTarget(settings.atlasSize, THREE.HalfFloatType, THREE.LinearFilter),
    makeTarget(settings.atlasSize, THREE.HalfFloatType, THREE.LinearFilter),
  ];

  const hookUniforms = {
    lmFront: { value: lightmaps[0].texture },
    lmPrevious: { value: lightmaps[1].texture },
    lmBlend: { value: 1 },
    lmValid: { value: 0 },
    lmSpecularOcclusion: { value: 1 },
  };

  let sample = null;
  let sequence = 0;
  let baking = false;
  let dirty = false;
  let hasFront = false;
  let count = 0;
  let bakeSamples = settings.samplesPerBake;
  let bakeStart = 0;
  let lastBakeMs = 0;
  let swaps = 0;
  let fade = 1;
  let shadowMapsThisFrame = 0;

  const startBake = () => {
    for (let i = 0; i < proxies.length; i++) proxies[i].matrixWorld.copy(ctx.meshes[i].matrixWorld);

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(sumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.setRenderTarget(previous);

    count = 0;
    // NOTE At least one sample, 0 would divide by zero
    bakeSamples = Math.max(1, settings.samplesPerBake);
    baking = true;
    dirty = false;
    bakeStart = performance.now();
  };

  const finalize = (output) => {
    finalizeMaterial.uniforms.uSum.value = sumTarget.texture;
    finalizeMaterial.uniforms.uSize.value.set(sumTarget.width, sumTarget.height);
    finalizeMaterial.uniforms.uScale.value = bakeSamples;
    quad.material = finalizeMaterial;
    renderer.setRenderTarget(output);
    quad.render(renderer);
  };

  const renderSamples = (amount) => {
    const { center, radius } = bounds;
    const autoClear = renderer.autoClear;

    renderer.autoClear = false;
    renderer.setRenderTarget(sumTarget);

    for (let s = 0; s < amount; s++) {
      sequence++;

      const { direction, color } = sample(halton(sequence, 2), halton(sequence, 3), halton(sequence, 5), halton(sequence, 7));

      // NOTE Direction jitter in degrees, a cone wider than a hemisphere makes no sense
      const jitterAngle = THREE.MathUtils.degToRad(Math.min(180, settings.directionJitter));
      jitterDirection(direction, jitterAngle, halton(sequence, 11), halton(sequence, 13));

      jitterUniforms.bakeSeed.value = sequence % 4096;
      jitterUniforms.bakeNoise.value = settings.shadowNoise;
      jitterUniforms.bakeMapTexel.value = 1 / settings.mapSize;
      light.shadow.radius = settings.shadowBlur;

      light.position.copy(direction).multiplyScalar(2 * radius).add(center);
      target.position.copy(center);
      // NOTE Pre-scaled, so the sum stays in half float range
      light.color.copy(color).multiplyScalar(1 / bakeSamples);

      const camera = light.shadow.camera;
      camera.left = -radius;
      camera.right = radius;
      camera.top = radius;
      camera.bottom = -radius;
      camera.near = radius;
      camera.far = 3 * radius;
      camera.updateProjectionMatrix();
      light.shadow.normalBias = (2 * radius) / settings.mapSize;

      // NOTE One shadow map + one draw of all meshes in lightmap space, added to the sum
      renderer.render(bakeScene, bakeCamera);
      count++;
    }

    renderer.autoClear = autoClear;
    shadowMapsThisFrame = amount;
  };

  const rebuildTargets = () => {
    sumTarget.dispose();
    for (const t of lightmaps) t.dispose();

    sumTarget = makeTarget(settings.atlasSize, sumType, THREE.NearestFilter);
    lightmaps = [
      makeTarget(settings.atlasSize, THREE.HalfFloatType, THREE.LinearFilter),
      makeTarget(settings.atlasSize, THREE.HalfFloatType, THREE.LinearFilter),
    ];

    hasFront = false;
    hookUniforms.lmValid.value = 0;
    baking = false;
    dirty = true;
  };

  return {
    hook: {
      key: 'baked-lightmap',
      uniforms: hookUniforms,
      vertexPars: /* glsl */ `
        attribute vec2 lightmapUv;
        varying vec2 vLightmapUv;
      `,
      vertex: /* glsl */ `
        vLightmapUv = lightmapUv;
      `,
      pars: /* glsl */ `
        varying vec2 vLightmapUv;
        uniform sampler2D lmFront;
        uniform sampler2D lmPrevious;
        uniform float lmBlend;
        uniform float lmValid;
        uniform float lmSpecularOcclusion;

        float lmVisibility = 1.0;

        float lmLuminance( vec3 c ) {
          return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
        }
      `,
      diffuse: /* glsl */ `
        vec3 lmUnoccluded = getIBLIrradiance( geometryNormal );
        vec3 lmBaked = mix( texture2D( lmPrevious, vLightmapUv ).rgb, texture2D( lmFront, vLightmapUv ).rgb, lmBlend );
        vec3 lmIrradiance = lmValid > 0.5 ? lmBaked : lmUnoccluded;

        lmVisibility = clamp( lmLuminance( lmIrradiance ) / max( 1e-6, lmLuminance( lmUnoccluded ) ), 0.0, 1.0 );
        iblIrradiance += lmIrradiance;
      `,
      specular: /* glsl */ `
        iblRadiance *= mix( 1.0, lmVisibility, lmSpecularOcclusion );
      `,
    },

    setEnvironment(info) {
      sample = buildSampler(ctx.downsampleEquirect(info.source, 512));
      // NOTE The current front stays on screen until the bake for the new environment is done
      dirty = true;
    },

    beforeRender(frame) {
      shadowMapsThisFrame = 0;

      if (!sample) return;

      if (frame.sceneChanged) dirty = true;

      if (!baking && dirty) startBake();

      const previousTarget = renderer.getRenderTarget();
      const clearColor = renderer.getClearColor(new THREE.Color());
      const clearAlpha = renderer.getClearAlpha();

      if (baking) {
        renderSamples(Math.min(settings.samplesPerFrame, bakeSamples - count));

        if (!hasFront) {
          // NOTE First bake: show it while it converges, there is nothing to keep on screen yet
          finalize(lightmaps[0]);
          hookUniforms.lmValid.value = 1;
          hookUniforms.lmBlend.value = 1;
        }

        if (count >= bakeSamples) {
          baking = false;
          lastBakeMs = performance.now() - bakeStart;

          if (hasFront) {
            // NOTE Finish into the previous slot, then swap: the new lightmap fades in over the old one
            finalize(lightmaps[1]);
            lightmaps.reverse();
            fade = 0;
            swaps++;
          } else {
            hasFront = true;
            fade = 1;
          }

          hookUniforms.lmFront.value = lightmaps[0].texture;
          hookUniforms.lmPrevious.value = lightmaps[1].texture;
        }
      }

      if (fade < 1) {
        fade = Math.min(1, fade + frame.delta / Math.max(1e-3, settings.fadeTime));
        hookUniforms.lmBlend.value = fade;
      }

      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(clearColor, clearAlpha);

      hookUniforms.lmSpecularOcclusion.value = settings.specularOcclusion ? 1 : 0;
    },

    render() {
      if (settings.debug !== 'atlas') return false;

      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      debugMaterial.uniforms.uMap.value = lightmaps[0].texture;
      debugMaterial.uniforms.uViewport.value.copy(size);
      quad.material = debugMaterial;
      renderer.setRenderTarget(null);
      quad.render(renderer);

      return true;
    },

    gui(folder) {
      folder.add(settings, 'samplesPerFrame', 0, 1000, 1).name('shadow maps / frame (bake)');
      folder.add(settings, 'samplesPerBake', 0, 1000, 1).name('samples / bake').onChange(() => (dirty = true));
      folder.add(settings, 'fadeTime', 0, 2, 0.05).name('crossfade (s)');
      folder.add(settings, 'atlasSize', [512, 1024, 2048, 4096]).name('atlas size').onChange(rebuildTargets);
      folder
        .add(settings, 'mapSize', [512, 1024, 2048, 4096])
        .name('shadow map size')
        .onChange(() => {
          light.shadow.mapSize.setScalar(settings.mapSize);
          light.shadow.map?.dispose();
          light.shadow.map = null;
          dirty = true;
        });
      folder.add(settings, 'shadowNoise', 0, 1000, 0.1).name('shadow noise (texels)').onChange(() => (dirty = true));
      folder.add(settings, 'directionJitter', 0, 1000, 0.1).name('direction jitter (deg)').onChange(() => (dirty = true));
      folder.add(settings, 'shadowBlur', 0, 1000, 0.1).name('shadow blur (PCF radius)').onChange(() => (dirty = true));
      folder.add(settings, 'specularOcclusion').name('specular occlusion');
      folder.add(settings, 'debug', ['off', 'atlas']).name('debug view');
      folder.add({ rebake: () => (dirty = true) }, 'rebake').name('rebake now');
    },

    stats() {
      const state = baking
        ? `${hasFront ? 'background bake' : 'first bake'} ${count}/${bakeSamples}`
        : dirty
          ? 'queued'
          : 'idle (0 shadow maps / frame)';

      return (
        `${state} · ${shadowMapsThisFrame} shadow maps this frame · camera moves never rebake\n` +
        `last bake ${lastBakeMs.toFixed(0)} ms · swaps ${swaps} · atlas ${settings.atlasSize}² · unwrap ${unwrapMs.toFixed(0)} ms`
      );
    },

    memory() {
      const texels = settings.atlasSize * settings.atlasSize;

      return texels * 16 + texels * 8 * 2 + settings.mapSize * settings.mapSize * 4;
    },

    dispose() {
      sumTarget.dispose();
      for (const t of lightmaps) t.dispose();
      bakeMaterial.dispose();
      finalizeMaterial.dispose();
      debugMaterial.dispose();
      quad.dispose();
      light.dispose();
    },
  };
}
