import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { buildSampler, halton } from './sampler.js';
import { createLightmapLayout, createPacker, setLayout } from './lightmapLayout.js';

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
      .replace('void main() {', 'attribute vec2 lightmapUvBake;\nvoid main() {')
      .replace(
        '#include <fog_vertex>',
        // NOTE The atlas UV in the layout of this bake. Meshes without a place (UV -10) are outside the clip space
        '#include <fog_vertex>\ngl_Position = vec4( lightmapUvBake * 2.0 - 1.0, 0.0, 1.0 );',
      );

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
    samplesPerFrame: 12,
    samplesPerBake: 512,
    fadeTime: 0.35,
    mapSize: 512,
    specularOcclusion: true,
    shadowNoise: 8,
    directionJitter: 2,
    frustumAtlas: true,
    frustumMargin: 20,
    debug: 'off',
  };

  await createLightmapLayout(ctx.meshes);

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

  // NOTE Corner preview of the front lightmap, empty texels (no mesh) in dark grey
  const previewMaterial = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D( uMap, vUv );
        vec3 c = texel.rgb / 3.14159265;
        vec3 color = pow( c / ( 1.0 + c ), vec3( 1.0 / 2.2 ) );
        gl_FragColor = vec4( texel.a > 0.0 ? color : vec3( 0.12 ), 1.0 );
      }
    `,
    uniforms: { uMap: { value: null } },
    depthTest: false,
    depthWrite: false,
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
  let fade = 1;

  // NOTE Layouts (per mesh atlas UVs or null): the latest packed one, the one of the bake in progress and
  // the one of the front lightmap. Keys name the visible set and atlas size a layout was packed for.
  const packer = createPacker(ctx.meshes);
  let layout = null;
  let layoutKey = null;
  let layoutPending = false;
  let bakeKey = null;
  let bakeLayout = ctx.meshes.map(() => null);
  let frontLayout = ctx.meshes.map(() => null);
  let visible = ctx.meshes.map(() => true);
  let visibleKey = '';

  const frustum = new THREE.Frustum();
  const projectionScreen = new THREE.Matrix4();
  const sphere = new THREE.Sphere();

  // NOTE Meshes inside the camera frustum (bounding sphere grown by the margin) get a place in the atlas
  const updateVisible = () => {
    const camera = ctx.camera;

    camera.updateMatrixWorld();
    projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projectionScreen);

    visible = ctx.meshes.map((mesh) => {
      if (!settings.frustumAtlas) return true;

      sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      sphere.radius *= 1 + settings.frustumMargin / 100;

      return frustum.intersectsSphere(sphere);
    });

    visibleKey = `${visible.map((v) => (v ? '1' : '0')).join('')}|${settings.atlasSize}`;
  };

  // NOTE Packing runs in a worker, the bake starts when the layout is back
  const requestLayout = () => {
    const key = visibleKey;

    layoutPending = true;

    packer.pack(visible.slice(), settings.atlasSize).then((result) => {
      layout = result;
      layoutKey = key;
      layoutPending = false;
    });
  };

  const startBake = () => {
    for (let i = 0; i < proxies.length; i++) proxies[i].matrixWorld.copy(ctx.meshes[i].matrixWorld);

    bakeLayout = layout;
    bakeKey = layoutKey;
    setLayout(ctx.meshes, 'lightmapUvBake', bakeLayout);

    // NOTE The first bake is on screen while it converges, so the front uses its layout
    if (!hasFront) {
      frontLayout = bakeLayout;
      setLayout(ctx.meshes, 'lightmapUvFront', frontLayout);
    }

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
    bakeKey = null;
    setLayout(ctx.meshes, 'lightmapUvPrevious', ctx.meshes.map(() => null));
  };

  return {
    hook: {
      key: 'baked-lightmap',
      uniforms: hookUniforms,
      vertexPars: /* glsl */ `
        attribute vec2 lightmapUvFront;
        attribute vec2 lightmapUvPrevious;
        varying vec2 vLmFront;
        varying vec2 vLmPrevious;
        varying vec2 vLmHas;
      `,
      vertex: /* glsl */ `
        // NOTE Each lightmap is read with the layout it was baked with
        vLmFront = lightmapUvFront;
        vLmPrevious = lightmapUvPrevious;
        vLmHas = vec2( step( 0.0, lightmapUvFront.x ), step( 0.0, lightmapUvPrevious.x ) );
      `,
      pars: /* glsl */ `
        varying vec2 vLmFront;
        varying vec2 vLmPrevious;
        varying vec2 vLmHas;
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
        // NOTE A mesh without a place in a lightmap (it was outside the frustum) uses the unoccluded light
        vec3 lmFrontValue = vLmHas.x > 0.5 ? texture2D( lmFront, vLmFront ).rgb : lmUnoccluded;
        vec3 lmPreviousValue = vLmHas.y > 0.5 ? texture2D( lmPrevious, vLmPrevious ).rgb : lmUnoccluded;
        vec3 lmBaked = mix( lmPreviousValue, lmFrontValue, lmBlend );
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
      if (!sample) return;

      if (frame.sceneChanged) dirty = true;

      // NOTE A different visible set needs a new layout, camera moves inside the same set cost nothing
      updateVisible();

      if (visibleKey !== layoutKey && !layoutPending) requestLayout();

      if (layoutKey !== bakeKey) dirty = true;

      if (!baking && dirty && layout) startBake();

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

          if (hasFront) {
            // NOTE Finish into the previous slot, then swap: the new lightmap fades in over the old one
            finalize(lightmaps[1]);
            lightmaps.reverse();
            fade = 0;

            // NOTE The layouts swap with the lightmaps
            setLayout(ctx.meshes, 'lightmapUvPrevious', frontLayout);
            frontLayout = bakeLayout;
            setLayout(ctx.meshes, 'lightmapUvFront', frontLayout);
            hookUniforms.lmBlend.value = 0;
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

    // NOTE Draws the front lightmap into a square at the bottom left of the canvas, in CSS pixels
    renderPreview(x, y, size) {
      const viewport = renderer.getViewport(new THREE.Vector4());
      const scissor = renderer.getScissor(new THREE.Vector4());
      const scissorTest = renderer.getScissorTest();

      previewMaterial.uniforms.uMap.value = lightmaps[0].texture;
      quad.material = previewMaterial;

      renderer.setRenderTarget(null);
      renderer.setViewport(x, y, size, size);
      renderer.setScissor(x, y, size, size);
      renderer.setScissorTest(true);
      quad.render(renderer);

      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
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
      folder.add(settings, 'frustumAtlas').name('atlas: only meshes in view');
      folder.add(settings, 'frustumMargin', 0, 1000, 1).name('view margin (%)');
      folder.add(settings, 'specularOcclusion').name('specular occlusion');
      folder.add(settings, 'debug', ['off', 'atlas']).name('debug view');
      folder.add({ rebake: () => (dirty = true) }, 'rebake').name('rebake now');
    },

    dispose() {
      sumTarget.dispose();
      for (const t of lightmaps) t.dispose();
      bakeMaterial.dispose();
      finalizeMaterial.dispose();
      debugMaterial.dispose();
      previewMaterial.dispose();
      packer.dispose();
      quad.dispose();
      light.dispose();
    },
  };
}
