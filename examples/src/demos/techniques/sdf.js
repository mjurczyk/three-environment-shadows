import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BVHShaderGLSL, MeshBVHUniformStruct } from 'three-mesh-bvh';

/**
 * D · SDF cone tracing.
 *
 * An unsigned distance field of the scene is generated on the GPU into a 3D texture (closest point
 * queries against the scene BVH). Lit materials then trace cones through it:
 * - residual environment: 6 cones of 30 degrees over the hemisphere (1 up, 5 at 60 degrees),
 *   each cone samples the prefiltered environment, weighted by its visibility -> colored occlusion
 * - extracted sources (sun): one cone toward the light with the measured cone angle -> soft shadow
 *   with a penumbra from the real source size, no shadow map
 */

// NOTE The volume around the test scene (ground radius 6, objects up to ~2.6 m)
const VOLUME_MIN = new THREE.Vector3(-6.5, -0.3, -6.5);
const VOLUME_MAX = new THREE.Vector3(6.5, 3.7, 6.5);

const generateVertex = /* glsl */ `
  void main() {
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

const generateFragment = /* glsl */ `
  precision highp float;
  precision highp int;

  ${BVHShaderGLSL.common_functions}
  ${BVHShaderGLSL.bvh_struct_definitions}
  ${BVHShaderGLSL.bvh_distance_functions}

  uniform BVH bvh;
  uniform vec3 uMin;
  uniform vec3 uMax;
  uniform vec3 uResolution;
  uniform float uLayer;

  void main() {
    vec3 uvw = vec3( gl_FragCoord.xy, uLayer + 0.5 ) / uResolution;
    vec3 p = mix( uMin, uMax, uvw );

    uvec4 faceIndices = uvec4( 0u );
    vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
    vec3 barycoord = vec3( 0.0 );
    float side = 1.0;
    vec3 outPoint = vec3( 0.0 );

    float dist = bvhClosestPointToPoint( bvh, p, 100.0, faceIndices, faceNormal, barycoord, side, outPoint );

    gl_FragColor = vec4( dist, 0.0, 0.0, 1.0 );
  }
`;

const hookPars = /* glsl */ `
  precision highp sampler3D;

  uniform sampler3D sdfVolume;
  uniform vec3 sdfMin;
  uniform vec3 sdfMax;
  uniform float sdfVoxel;
  uniform float sdfMaxDistance;
  uniform float sdfSun;
  uniform float sdfMinCone;
  uniform float sdfSpecularOcclusion;
  uniform vec4 sdfLights[ 4 ];
  uniform int sdfLightCount;

  float sdfAmbientVisibility = 1.0;

  #define SDF_STEPS 48

  // NOTE Fraction of a cone (sine of half-angle sinHalf) that is not blocked
  float sdfCone( vec3 origin, vec3 dir, float sinHalf, float maxT ) {
    vec3 extent = sdfMax - sdfMin;
    float visibility = 1.0;
    float t = sdfVoxel;

    for ( int k = 0; k < SDF_STEPS; k ++ ) {
      vec3 uvw = ( origin + dir * t - sdfMin ) / extent;

      if ( t > maxT || any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) break;

      float d = texture( sdfVolume, uvw ).r - 0.5 * sdfVoxel;
      float r = max( t * sinHalf, 1e-4 );

      visibility = min( visibility, clamp( d / r, 0.0, 1.0 ) );

      if ( visibility < 0.02 ) break;

      t += max( max( d, 0.6 * r ), 0.5 * sdfVoxel );
    }

    return visibility * visibility * ( 3.0 - 2.0 * visibility );
  }

  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_PMREM )

  // NOTE 6 cones of 30 degrees, weights of a cosine distribution (sum 1)
  vec3 sdfIrradiance( vec3 p, vec3 n ) {
    vec3 t = normalize( abs( n.y ) < 0.99 ? cross( n, vec3( 0.0, 1.0, 0.0 ) ) : cross( n, vec3( 1.0, 0.0, 0.0 ) ) );
    vec3 b = cross( n, t );

    float lod = roughnessToMip( 0.65 );
    vec3 sum = vec3( 0.0 );
    float visibilitySum = 0.0;

    for ( int k = 0; k < 6; k ++ ) {
      vec3 dir;
      float weight;

      if ( k == 0 ) {
        dir = n;
        weight = 0.25;
      } else {
        float phi = 6.2831853 * float( k - 1 ) / 5.0;
        dir = normalize( 0.5 * n + 0.8660254 * ( cos( phi ) * t + sin( phi ) * b ) );
        weight = 0.15;
      }

      float visibility = sdfCone( p, dir, 0.5, sdfMaxDistance );
      vec3 radiance = textureLod( envMap, envMapRotation * dir, lod ).rgb * envMapIntensity;

      sum += weight * visibility * radiance;
      visibilitySum += weight * visibility;
    }

    sdfAmbientVisibility = visibilitySum;

    return 3.14159265 * sum;
  }

  #endif
`;

const makeVolume = (resolution) => {
  const extent = new THREE.Vector3().subVectors(VOLUME_MAX, VOLUME_MIN);
  const voxel = extent.x / resolution;
  const size = new THREE.Vector3(
    resolution,
    Math.max(8, Math.ceil(extent.y / voxel)),
    Math.max(8, Math.ceil(extent.z / voxel)),
  );

  const target = new THREE.WebGL3DRenderTarget(size.x, size.y, size.z, { depthBuffer: false });
  const texture = target.texture;
  texture.format = THREE.RedFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;

  return { target, size, voxel: Math.max(voxel, extent.y / size.y, extent.z / size.z) };
};

export async function createSDFConeTracing(ctx) {
  const { renderer } = ctx;

  const settings = {
    resolution: 128,
    sunShadows: true,
    minCone: 0.5,
    maxDistance: 8,
    specularOcclusion: true,
    dynamic: true,
  };

  const sceneBVH = ctx.getSceneBVH();
  sceneBVH.update();

  const bvhStruct = new MeshBVHUniformStruct();
  bvhStruct.updateFrom(sceneBVH.bvh);

  const generateMaterial = new THREE.ShaderMaterial({
    vertexShader: generateVertex,
    fragmentShader: generateFragment,
    uniforms: {
      bvh: { value: bvhStruct },
      uMin: { value: VOLUME_MIN },
      uMax: { value: VOLUME_MAX },
      uResolution: { value: new THREE.Vector3() },
      uLayer: { value: 0 },
    },
  });

  const quad = new FullScreenQuad(generateMaterial);

  let volume = makeVolume(settings.resolution);
  let generateMs = 0;
  let shadowLights = [];

  const lightData = [0, 1, 2, 3].map(() => new THREE.Vector4());

  const hookUniforms = {
    sdfVolume: { value: volume.target.texture },
    sdfMin: { value: VOLUME_MIN },
    sdfMax: { value: VOLUME_MAX },
    sdfVoxel: { value: volume.voxel },
    sdfMaxDistance: { value: settings.maxDistance },
    sdfSun: { value: 1 },
    sdfMinCone: { value: THREE.MathUtils.degToRad(settings.minCone) },
    sdfSpecularOcclusion: { value: 1 },
    sdfLights: { value: lightData },
    sdfLightCount: { value: 0 },
  };

  const generate = () => {
    const start = performance.now();
    const previousTarget = renderer.getRenderTarget();
    const { target, size } = volume;

    generateMaterial.uniforms.uResolution.value.copy(size);

    for (let layer = 0; layer < size.z; layer++) {
      generateMaterial.uniforms.uLayer.value = layer;
      renderer.setRenderTarget(target, layer);
      quad.render(renderer);
    }

    renderer.setRenderTarget(previousTarget);
    generateMs = performance.now() - start;
  };

  const rebuildVolume = () => {
    volume.target.dispose();
    volume = makeVolume(settings.resolution);
    hookUniforms.sdfVolume.value = volume.target.texture;
    hookUniforms.sdfVoxel.value = volume.voxel;
    generate();
  };

  // NOTE The SDF replaces the shadow maps of the extracted sources
  const applyShadowMode = () => {
    for (const light of shadowLights) light.castShadow = !settings.sunShadows;
    hookUniforms.sdfSun.value = settings.sunShadows ? 1 : 0;
  };

  generate();

  return {
    hook: {
      key: 'sdf',
      uniforms: hookUniforms,
      pars: hookPars,
      diffuse: /* glsl */ `
        vec3 sdfN = hookWorldDirection( geometryNormal );
        vec3 sdfP = hookWorldPosition() + sdfN * 1.5 * sdfVoxel;
        iblIrradiance += sdfIrradiance( sdfP, sdfN );
      `,
      specular: /* glsl */ `
        iblRadiance *= mix( 1.0, sdfAmbientVisibility, sdfSpecularOcclusion );
      `,
      direct: /* glsl */ `
        if ( sdfSun > 0.5 ) {
          vec3 sdfL = hookWorldDirection( directLight.direction );
          float sdfAngle = sdfMinCone;
          float sdfBest = - 2.0;

          // NOTE The extracted source closest to this light gives the cone angle
          for ( int k = 0; k < 4; k ++ ) {
            if ( k >= sdfLightCount ) break;

            float c = dot( sdfL, sdfLights[ k ].xyz );

            if ( c > sdfBest ) {
              sdfBest = c;
              sdfAngle = max( sdfLights[ k ].w, sdfMinCone );
            }
          }

          vec3 sdfNormal = hookWorldDirection( geometryNormal );
          vec3 sdfOrigin = hookWorldPosition() + sdfNormal * 1.5 * sdfVoxel;

          directLight.color *= sdfCone( sdfOrigin, sdfL, sin( sdfAngle ), 1e3 );
        }
      `,
    },

    setEnvironment(info) {
      shadowLights = info.shadowLights;

      const lights = info.lights.slice(0, 4);

      lights.forEach((light, i) => lightData[i].set(light.direction.x, light.direction.y, light.direction.z, light.coneAngle));
      hookUniforms.sdfLightCount.value = lights.length;

      applyShadowMode();
    },

    beforeRender(frame) {
      if (frame.sceneChanged && settings.dynamic) {
        sceneBVH.update();
        bvhStruct.updateFrom(sceneBVH.bvh);
        generate();
      }

      hookUniforms.sdfMaxDistance.value = settings.maxDistance;
      hookUniforms.sdfMinCone.value = THREE.MathUtils.degToRad(settings.minCone);
      hookUniforms.sdfSpecularOcclusion.value = settings.specularOcclusion ? 1 : 0;
    },

    gui(folder) {
      folder.add(settings, 'resolution', [64, 96, 128, 192]).name('volume resolution (x)').onChange(rebuildVolume);
      folder.add(settings, 'sunShadows').name('sun via SDF (no shadow map)').onChange(applyShadowMode);
      folder.add(settings, 'minCone', 0.05, 5, 0.05).name('min sun cone (deg)');
      folder.add(settings, 'maxDistance', 1, 20, 0.5).name('ambient cone reach (m)');
      folder.add(settings, 'specularOcclusion').name('specular occlusion');
      folder.add(settings, 'dynamic').name('regenerate when animating');
    },

    stats() {
      const { size, voxel } = volume;

      return (
        `SDF ${size.x}x${size.y}x${size.z} · voxel ${(voxel * 100).toFixed(1)} cm · 6 ambient cones + ${settings.sunShadows ? 'SDF' : 'shadow map'} sun\n` +
        `SDF generate ${generateMs.toFixed(2)} ms cpu submit (+ BVH ${sceneBVH.lastUpdateMs.toFixed(2)} ms) when animating`
      );
    },

    memory() {
      const { size } = volume;

      return size.x * size.y * size.z * 2;
    },

    dispose() {
      for (const light of shadowLights) light.castShadow = true;
      volume.target.dispose();
      generateMaterial.dispose();
      quad.dispose();
      bvhStruct.dispose();
    },
  };
}
