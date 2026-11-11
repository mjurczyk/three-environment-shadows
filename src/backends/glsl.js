import {
  AddEquation,
  BackSide,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  HalfFloatType,
  Mesh,
  MeshLambertMaterial,
  OneFactor,
  OrthographicCamera,
  ShaderChunk,
  ShaderMaterial,
  Vector3,
} from 'three';
import { NO_PLACE } from '../core/packer.js';
import { LAYOUT_WIDTH } from '../core/units.js';

/**
 * GLSL backend for WebGLRenderer: materials are patched with onBeforeCompile.
 *
 * @private
 */

const FACE_LINE = 'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;';
const SHADOW_COORD = 'vDirectionalShadowCoord[ i ]';

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

// NOTE Sum (rgb = pre-scaled irradiance sum, a = sample count) to mean, empty texels take the nearest filled texel
const FINALIZE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D uSum;
  uniform ivec2 uSize;
  uniform float uScale;

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

          vec4 s = texelFetch( uSum, clamp( pixel + ivec2( x, y ), ivec2( 0 ), uSize - 1 ), 0 );

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

// NOTE The instance id expression of the batching chunk of this three.js version
const BATCH_INSTANCE =
  ShaderChunk.batching_vertex?.match(/getBatchingMatrix\(\s*(.+?)\s*\);/)?.[1] ?? null;

// NOTE Atlas UV of a vertex in a layout texture, see units.js. A missing chart attribute reads 0: no place.
const LAYOUT_PARS = /* glsl */ `
  attribute vec2 lightmapUv;
  attribute vec3 lightmapChart;

  vec4 lmLayoutTexel( highp sampler2D lmLayout, int texel ) {
    return texelFetch( lmLayout, ivec2( texel % ${LAYOUT_WIDTH}, texel / ${LAYOUT_WIDTH} ), 0 );
  }

  // NOTE ( atlas u, atlas v, atlas: 0 primary, 1 secondary )
  vec3 lmAtlasUv( highp sampler2D lmLayout ) {
    #if defined( USE_INSTANCING )
      int instance = gl_InstanceID;
    #elif defined( USE_BATCHING )
      int instance = int( ${BATCH_INSTANCE ?? '0.0'} );
    #else
      int instance = 0;
    #endif

    int chart = int( lightmapChart.x + 0.5 ) - 1;
    int base = int( floor( lightmapChart.y + 0.5 ) );

    if ( lightmapChart.z < - 0.5 ) base = int( floor( lmLayoutTexel( lmLayout, 2 * ( base + instance ) ).x + 0.5 ) );
    else base += instance * int( lightmapChart.z + 0.5 );

    if ( chart < 0 || base < 0 ) return vec3( ${NO_PLACE}.0, ${NO_PLACE}.0, 0.0 );

    int texel = 2 * ( base + chart );
    vec3 uv = vec3( lightmapUv, 1.0 );
    vec4 row = lmLayoutTexel( lmLayout, texel );

    return vec3( dot( row.xyz, uv ), dot( lmLayoutTexel( lmLayout, texel + 1 ).xyz, uv ), row.w );
  }
`;

const DISPLAY_VERTEX_PARS = /* glsl */ `
  ${LAYOUT_PARS}
  uniform highp sampler2D lmLayoutA;
  uniform highp sampler2D lmLayoutB;
  varying vec3 vLmA;
  varying vec3 vLmB;
  varying vec2 vLmHas;
`;

// NOTE The lightmap of an atlas UV: z selects the primary or the secondary atlas
const LIGHTMAP_SAMPLE = /* glsl */ `
  vec3 lmSample( sampler2D primary, sampler2D secondary, vec3 uv ) {
    return mix( texture2D( primary, uv.xy ).rgb, texture2D( secondary, uv.xy ).rgb, step( 0.5, uv.z ) );
  }
`;

// NOTE Atlas UVs are > 0, a unit without a place reads NO_PLACE (-10)
const DISPLAY_VERTEX = /* glsl */ `
  vLmA = lmAtlasUv( lmLayoutA );
  vLmB = lmAtlasUv( lmLayoutB );
  vLmHas = vec2( step( 1e-6, vLmA.x ), step( 1e-6, vLmB.x ) );
`;

// NOTE Debug view: the front lightmap, magenta where a unit has no place in the atlas
const LIGHTMAP_VERTEX = /* glsl */ `
  #include <common>
  #include <batching_pars_vertex>
  ${DISPLAY_VERTEX_PARS}

  void main() {
    #include <batching_vertex>
    #include <begin_vertex>
    #include <project_vertex>
    ${DISPLAY_VERTEX}
  }
`;

const LIGHTMAP_FRAGMENT = /* glsl */ `
  uniform sampler2D lmA;
  uniform sampler2D lmB;
  uniform sampler2D lmSecondaryA;
  uniform sampler2D lmSecondaryB;
  uniform float lmFrontIsA;
  varying vec3 vLmA;
  varying vec3 vLmB;

  ${LIGHTMAP_SAMPLE}

  void main() {
    vec3 uv = lmFrontIsA > 0.5 ? vLmA : vLmB;

    if ( uv.x < 1e-6 ) {
      gl_FragColor = vec4( 1.0, 0.0, 1.0, 1.0 );
      return;
    }

    gl_FragColor = vec4( lmFrontIsA > 0.5 ? lmSample( lmA, lmSecondaryA, vLmA ) : lmSample( lmB, lmSecondaryB, vLmB ), 1.0 );

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const DISPLAY_FRAGMENT_PARS = /* glsl */ `
  varying vec3 vLmA;
  varying vec3 vLmB;
  varying vec2 vLmHas;
  uniform sampler2D lmA;
  uniform sampler2D lmB;
  uniform sampler2D lmSecondaryA;
  uniform sampler2D lmSecondaryB;
  uniform float lmFrontIsA;
  uniform float lmBlend;
  uniform float lmValid;
  uniform float lmSpecularOcclusion;
  uniform float lmShadowStart;
  uniform float lmShadowEnd;
  ${LIGHTMAP_SAMPLE}
`;

// NOTE After lights_fragment_maps: iblIrradiance holds the environment diffuse, radiance the environment specular.
// The baked lightmap replaces the diffuse, its visibility occludes the specular.
const DISPLAY_FRAGMENT = /* glsl */ `
  {
    vec3 lmUnoccluded = iblIrradiance;

    // NOTE The lightmap is baked at intensity 1. envMapIntensity is material.envMapIntensity or
    // scene.environmentIntensity, the same as for the environment diffuse. The unoccluded light has it already.
    #ifdef USE_ENVMAP
      float lmIntensity = envMapIntensity;
    #else
      float lmIntensity = 1.0;
    #endif

    vec3 lmValueA = vLmHas.x > 0.5 ? lmSample( lmA, lmSecondaryA, vLmA ) * lmIntensity : lmUnoccluded;
    vec3 lmValueB = vLmHas.y > 0.5 ? lmSample( lmB, lmSecondaryB, vLmB ) * lmIntensity : lmUnoccluded;
    vec3 lmFront = lmFrontIsA > 0.5 ? lmValueA : lmValueB;
    vec3 lmPrevious = lmFrontIsA > 0.5 ? lmValueB : lmValueA;
    vec3 lmIrradiance = lmValid > 0.5 ? mix( lmPrevious, lmFront, lmBlend ) : lmUnoccluded;

    vec3 lmWeights = vec3( 0.2126, 0.7152, 0.0722 );
    float lmVisibility = clamp( dot( lmIrradiance, lmWeights ) / max( 1e-6, dot( lmUnoccluded, lmWeights ) ), 0.0, 1.0 );

    // NOTE Occlusion remap: no darkening below the start, full darkening at the end.
    // Scaling the baked light keeps its color and direction.
    float lmOcclusion = clamp( ( 1.0 - lmVisibility - lmShadowStart ) / max( 1e-4, lmShadowEnd - lmShadowStart ), 0.0, 1.0 );
    float lmRemapped = 1.0 - lmOcclusion;

    lmIrradiance *= lmRemapped / max( 1e-3, lmVisibility );
    lmVisibility = lmRemapped;

    iblIrradiance = lmIrradiance;
    radiance *= mix( 1.0, lmVisibility, lmSpecularOcclusion );
  }
`;

const quadGeometry = new BufferGeometry();
quadGeometry.setAttribute(
  'position',
  new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
);

const quad = new Mesh(quadGeometry);
quad.frustumCulled = false;

const quadCamera = new OrthographicCamera();

export const glslBackend = {
  supportsBatchedMesh: BATCH_INSTANCE !== null,

  getSumType(renderer) {
    // NOTE Blending into 32-bit float targets needs EXT_float_blend, three.js does not enable it
    return renderer.getContext().getExtension('EXT_float_blend') !== null
      ? FloatType
      : HalfFloatType;
  },

  // NOTE Lambert in lightmap space: each triangle is drawn at its lightmap UV, lit and shadowed in world space
  createBakeMaterial() {
    const uniforms = {
      bakeNoise: { value: 0 },
      bakeSeed: { value: 0 },
      bakeMapTexel: { value: 1 / 512 },
      lmLayoutBake: { value: null },
      bakeAtlas: { value: 0 },
    };

    const material = new MeshLambertMaterial({
      color: 0xffffff,
      side: DoubleSide,
      shadowSide: BackSide,
      // NOTE Not transparent: transparent double-sided materials render in two passes, the back pass flips normals
      forceSinglePass: true,
      // NOTE Plain sum: rgb += sample, a += 1 (sample count)
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      depthTest: false,
      depthWrite: false,
    });

    material.onBeforeCompile = (shader) => {
      const normalChunk = ShaderChunk.normal_fragment_begin;
      const lightsChunk = ShaderChunk.lights_fragment_begin;

      if (!normalChunk.includes(FACE_LINE) || !lightsChunk.includes(SHADOW_COORD)) {
        throw new Error('EnvironmentShadows: Unsupported three.js shader chunks.');
      }

      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          `${LAYOUT_PARS}\nuniform highp sampler2D lmLayoutBake;\nuniform float bakeAtlas;\nvoid main() {`,
        )
        // NOTE The atlas UV of this bake. Units without a place (UV -10) and charts of the other atlas are
        // outside the clip space.
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
          vec3 lmBakeUv = lmAtlasUv( lmLayoutBake );
          gl_Position = vec4( abs( lmBakeUv.z - bakeAtlas ) < 0.5 ? lmBakeUv.xy * 2.0 - 1.0 : vec2( - 2.0 ), 0.0, 1.0 );`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${JITTER_PARS}\nvoid main() {`)
        // NOTE The winding in lightmap space is arbitrary (charts can be mirrored), keep the geometric normal
        .replace(
          '#include <normal_fragment_begin>',
          normalChunk.replace(FACE_LINE, 'float faceDirection = 1.0;'),
        )
        .replace(
          '#include <lights_fragment_begin>',
          lightsChunk.split(SHADOW_COORD).join(`( ${SHADOW_COORD} + bakeShadowJitter() )`),
        );
    };

    material.customProgramCacheKey = () => 'environment-shadows-bake';

    return {
      material,
      uniforms: {
        noise: uniforms.bakeNoise,
        seed: uniforms.bakeSeed,
        mapTexel: uniforms.bakeMapTexel,
        layout: uniforms.lmLayoutBake,
        atlas: uniforms.bakeAtlas,
        // NOTE Only the TSL backend needs these
        shadowExtent: { value: 1 },
        lightDirection: { value: new Vector3() },
      },
    };
  },

  createFinalize(sumTexture, size) {
    const material = new ShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: FINALIZE_FRAGMENT,
      uniforms: {
        uSum: { value: sumTexture },
        uSize: { value: { x: size, y: size } },
        uScale: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    return {
      material,
      uniforms: { scale: material.uniforms.uScale },
      dispose: () => material.dispose(),
    };
  },

  renderQuad(renderer, material) {
    quad.material = material;
    renderer.render(quad, quadCamera);
  },

  createDisplay() {
    const uniforms = {
      lmA: { value: null },
      lmB: { value: null },
      lmFrontIsA: { value: 1 },
      lmBlend: { value: 1 },
      lmValid: { value: 0 },
      lmSpecularOcclusion: { value: 1 },
      lmShadowStart: { value: 0 },
      lmShadowEnd: { value: 1 },
      lmLayoutA: { value: null },
      lmLayoutB: { value: null },
      lmSecondaryA: { value: null },
      lmSecondaryB: { value: null },
    };

    const originals = new WeakMap();

    return {
      uniforms: {
        a: uniforms.lmA,
        b: uniforms.lmB,
        frontIsA: uniforms.lmFrontIsA,
        blend: uniforms.lmBlend,
        valid: uniforms.lmValid,
        specularOcclusion: uniforms.lmSpecularOcclusion,
        shadowStart: uniforms.lmShadowStart,
        shadowEnd: uniforms.lmShadowEnd,
        layoutA: uniforms.lmLayoutA,
        layoutB: uniforms.lmLayoutB,
        secondaryA: uniforms.lmSecondaryA,
        secondaryB: uniforms.lmSecondaryB,
      },

      // NOTE WebGLRenderer uploads material uniforms every frame, new textures need nothing
      refresh() {},

      createLightmapMaterial() {
        return new ShaderMaterial({
          uniforms: {
            lmA: uniforms.lmA,
            lmB: uniforms.lmB,
            lmSecondaryA: uniforms.lmSecondaryA,
            lmSecondaryB: uniforms.lmSecondaryB,
            lmFrontIsA: uniforms.lmFrontIsA,
            lmLayoutA: uniforms.lmLayoutA,
            lmLayoutB: uniforms.lmLayoutB,
          },
          vertexShader: LIGHTMAP_VERTEX,
          fragmentShader: LIGHTMAP_FRAGMENT,
        });
      },

      patch(material) {
        if (originals.has(material)) return;

        const onBeforeCompile = material.onBeforeCompile;
        const customProgramCacheKey = material.customProgramCacheKey;

        originals.set(material, { onBeforeCompile, customProgramCacheKey });

        material.onBeforeCompile = function (shader, renderer) {
          onBeforeCompile.call(this, shader, renderer);

          // NOTE Only lit materials with environment lighting (standard, physical, lambert, phong)
          if (!shader.fragmentShader.includes('#include <lights_fragment_maps>')) return;

          Object.assign(shader.uniforms, uniforms);

          shader.vertexShader = shader.vertexShader
            .replace('void main() {', `${DISPLAY_VERTEX_PARS}\nvoid main() {`)
            .replace('#include <fog_vertex>', `#include <fog_vertex>\n${DISPLAY_VERTEX}`);

          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', `${DISPLAY_FRAGMENT_PARS}\nvoid main() {`)
            .replace(
              '#include <lights_fragment_maps>',
              `#include <lights_fragment_maps>\n${DISPLAY_FRAGMENT}`,
            );
        };

        material.customProgramCacheKey = function () {
          return `${customProgramCacheKey.call(this)}|environment-shadows`;
        };

        // NOTE A cached program is reused without onBeforeCompile, dispose drops the cached programs
        material.dispose();
        material.needsUpdate = true;
      },

      unpatch(material) {
        const original = originals.get(material);

        if (!original) return;

        material.onBeforeCompile = original.onBeforeCompile;
        material.customProgramCacheKey = original.customProgramCacheKey;
        originals.delete(material);

        material.dispose();
        material.needsUpdate = true;
      },
    };
  },
};
