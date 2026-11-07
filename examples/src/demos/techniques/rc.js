import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BVHShaderGLSL, MeshBVHUniformStruct } from 'three-mesh-bvh';
import { envConeGLSL, hashGLSL, octahedralGLSL } from './shared.glsl.js';

/**
 * B / C · Sky-visibility radiance cascades.
 *
 * Probes sit on visible surfaces (screen-space probe placement). Cascade i has probe spacing s0 * 2^i
 * and (d0 * 2^i)^2 octahedral directions, so every cascade texture has about the same size. Cascade i
 * traces the interval [ t_i, t_i+1 ] with t_i = r0 * ( 4^i - 1 ) / 3. Rays that hit geometry carry 0
 * (no bounce light, only visibility). Rays that pass take the radiance of the next cascade (merged
 * from top to bottom). Rays of the last cascade that pass sample the environment with a cone the size
 * of their direction cell. A resolve pass integrates cascade 0 into irradiance per pixel.
 *
 * mode 'bvh'    - rays are traced against a BVH of the scene (three-mesh-bvh), in world space
 * mode 'screen' - rays march the G-buffer depth (offscreen / hidden occluders are not seen)
 */

const D0 = 4; // directions per axis of cascade 0 (16 directions)
const S0 = 4; // probe spacing of cascade 0 in work pixels

const passVertex = /* glsl */ `
  void main() {
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

const commonPars = /* glsl */ `
  uniform sampler2D uGPosition;
  uniform sampler2D uGNormal;
  uniform ivec2 uGSize;
  uniform float uGScale; // G-buffer pixels per work pixel

  ivec2 gPixel( vec2 workPixel ) {
    return clamp( ivec2( workPixel * uGScale ), ivec2( 0 ), uGSize - 1 );
  }

  // NOTE Bilateral weight of a probe q for a point with position p and normal n
  float probeWeight( vec4 qPosition, vec3 qNormal, vec3 p, vec3 n, float depth ) {
    if ( qPosition.w <= 0.0 ) return 0.0;

    float planeDistance = abs( dot( qPosition.xyz - p, n ) );
    float sigma = 0.03 + 0.01 * depth;

    return exp( - planeDistance / sigma ) * max( 0.05, dot( qNormal, n ) );
  }
`;

function tracePars(mode) {
  if (mode === 'bvh') {
    return /* glsl */ `
      ${BVHShaderGLSL.common_functions}
      ${BVHShaderGLSL.bvh_struct_definitions}
      ${BVHShaderGLSL.bvh_ray_functions}

      uniform BVH bvh;

      bool traceInterval( vec3 origin, vec3 dir, float t0, float t1, float jitter ) {
        uvec4 faceIndices = uvec4( 0u );
        vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
        vec3 barycoord = vec3( 0.0 );
        float side = 1.0;
        float dist = 0.0;

        bool hit = bvhIntersectFirstHit( bvh, origin + dir * t0, dir, faceIndices, faceNormal, barycoord, side, dist );

        return hit && dist <= t1 - t0;
      }
    `;
  }

  return /* glsl */ `
    uniform mat4 uView;
    uniform mat4 uProjection;
    uniform float uThickness;

    #define SS_STEPS 12

    bool traceInterval( vec3 origin, vec3 dir, float t0, float t1, float jitter ) {
      for ( int k = 0; k < SS_STEPS; k ++ ) {
        float t = mix( t0, t1, ( float( k ) + jitter ) / float( SS_STEPS ) );
        vec3 p = origin + dir * t;

        vec4 view = uView * vec4( p, 1.0 );
        float depth = - view.z;

        // NOTE Behind the camera or off screen: unknown, counted as free
        if ( depth <= 0.0 ) return false;

        vec4 clip = uProjection * view;
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;

        if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return false;

        float sceneDepth = texelFetch( uGPosition, clamp( ivec2( uv * vec2( uGSize ) ), ivec2( 0 ), uGSize - 1 ), 0 ).w;

        if ( sceneDepth > 0.0 && depth > sceneDepth + 0.01 + 0.004 * sceneDepth && depth < sceneDepth + uThickness ) return true;
      }

      return false;
    }
  `;
}

function cascadeFragment(mode) {
  return /* glsl */ `
    precision highp float;
    precision highp int;

    ${commonPars}
    ${octahedralGLSL}
    ${envConeGLSL}
    ${hashGLSL}
    ${tracePars(mode)}

    uniform int uSpacing;
    uniform int uDirRes;
    uniform ivec2 uProbeCount;
    uniform float uT0;
    uniform float uT1;
    uniform float uBias;
    uniform bool uIsTop;

    uniform sampler2D uUpper;
    uniform int uUpperSpacing;
    uniform int uUpperDirRes;
    uniform ivec2 uUpperProbeCount;

    uniform samplerCube uEnv;
    uniform float uEnvMaxLod;

    vec3 mergeUpper( vec2 probePixel, vec3 p, vec3 n, float depth, ivec2 dirCell, vec3 dir, float cellAngle ) {
      vec2 up = probePixel / float( uUpperSpacing ) - 0.5;
      ivec2 base = ivec2( floor( up ) );
      vec2 f = up - vec2( base );

      vec3 sum = vec3( 0.0 );
      float weightSum = 0.0;

      for ( int k = 0; k < 4; k ++ ) {
        ivec2 offset = ivec2( k & 1, k >> 1 );
        ivec2 q = clamp( base + offset, ivec2( 0 ), uUpperProbeCount - 1 );
        vec2 qPixel = ( vec2( q ) + 0.5 ) * float( uUpperSpacing );
        ivec2 gq = gPixel( qPixel );

        vec4 qPosition = texelFetch( uGPosition, gq, 0 );
        vec3 qNormal = texelFetch( uGNormal, gq, 0 ).xyz;

        float bilinear = ( offset.x == 1 ? f.x : 1.0 - f.x ) * ( offset.y == 1 ? f.y : 1.0 - f.y );
        float w = bilinear * probeWeight( qPosition, qNormal, p, n, depth );

        if ( w <= 0.0 ) continue;

        // NOTE The 4 child directions of this direction cell
        ivec2 child = q * uUpperDirRes + dirCell * 2;
        vec3 r = texelFetch( uUpper, child, 0 ).rgb + texelFetch( uUpper, child + ivec2( 1, 0 ), 0 ).rgb +
          texelFetch( uUpper, child + ivec2( 0, 1 ), 0 ).rgb + texelFetch( uUpper, child + ivec2( 1, 1 ), 0 ).rgb;

        sum += w * r * 0.25;
        weightSum += w;
      }

      // NOTE No valid upper probe (e.g. next to the sky): unoccluded
      if ( weightSum <= 1e-5 ) return envCone( uEnv, uEnvMaxLod, dir, cellAngle );

      return sum / weightSum;
    }

    void main() {
      ivec2 texel = ivec2( gl_FragCoord.xy );
      ivec2 probe = texel / uDirRes;
      ivec2 dirCell = texel - probe * uDirRes;

      if ( probe.x >= uProbeCount.x || probe.y >= uProbeCount.y ) {
        gl_FragColor = vec4( 0.0 );
        return;
      }

      vec2 probePixel = ( vec2( probe ) + 0.5 ) * float( uSpacing );
      ivec2 gp = gPixel( probePixel );
      vec4 position = texelFetch( uGPosition, gp, 0 );

      if ( position.w <= 0.0 ) {
        gl_FragColor = vec4( 0.0 );
        return;
      }

      vec3 n = texelFetch( uGNormal, gp, 0 ).xyz;
      vec3 dir = octDecode( ( vec2( dirCell ) + 0.5 ) / float( uDirRes ) * 2.0 - 1.0 );

      // NOTE Half-angle of a cone with the solid angle of one direction cell
      float cellSolidAngle = 12.566371 / float( uDirRes * uDirRes );
      float cellAngle = acos( clamp( 1.0 - cellSolidAngle / 6.2831853, - 1.0, 1.0 ) );

      if ( dot( dir, n ) <= 0.0 ) {
        gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
        return;
      }

      vec3 origin = position.xyz + n * uBias;
      float jitter = hash12( vec2( probe ) + float( uSpacing ) );

      if ( traceInterval( origin, dir, uT0, uT1, jitter ) ) {
        gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
        return;
      }

      vec3 radiance = uIsTop
        ? envCone( uEnv, uEnvMaxLod, dir, cellAngle )
        : mergeUpper( probePixel, position.xyz, n, position.w, dirCell, dir, cellAngle );

      gl_FragColor = vec4( radiance, 1.0 );
    }
  `;
}

const resolveFragment = /* glsl */ `
  precision highp float;
  precision highp int;

  ${commonPars}
  ${octahedralGLSL}
  ${envConeGLSL}

  uniform sampler2D uCascade0;
  uniform ivec2 uProbeCount;
  uniform float uWorkScale; // work pixels per G-buffer pixel
  uniform samplerCube uEnv;
  uniform float uEnvMaxLod;

  void main() {
    ivec2 pixel = ivec2( gl_FragCoord.xy );
    vec4 position = texelFetch( uGPosition, pixel, 0 );

    if ( position.w <= 0.0 ) {
      gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
      return;
    }

    vec3 p = position.xyz;
    vec3 n = texelFetch( uGNormal, pixel, 0 ).xyz;
    vec3 unoccluded = envIrradiance( uEnv, uEnvMaxLod, n );

    vec2 workPixel = ( vec2( pixel ) + 0.5 ) * uWorkScale;
    vec2 up = workPixel / float( ${S0} ) - 0.5;
    ivec2 base = ivec2( floor( up ) );
    vec2 f = up - vec2( base );

    vec3 sum = vec3( 0.0 );
    float cosineSum = 0.0;

    for ( int k = 0; k < 4; k ++ ) {
      ivec2 offset = ivec2( k & 1, k >> 1 );
      ivec2 q = clamp( base + offset, ivec2( 0 ), uProbeCount - 1 );
      vec2 qPixel = ( vec2( q ) + 0.5 ) * float( ${S0} );
      ivec2 gq = gPixel( qPixel );

      vec4 qPosition = texelFetch( uGPosition, gq, 0 );
      vec3 qNormal = texelFetch( uGNormal, gq, 0 ).xyz;

      float bilinear = ( offset.x == 1 ? f.x : 1.0 - f.x ) * ( offset.y == 1 ? f.y : 1.0 - f.y );
      float w = bilinear * probeWeight( qPosition, qNormal, p, n, position.w );

      if ( w <= 0.0 ) continue;

      for ( int y = 0; y < ${D0}; y ++ ) {
        for ( int x = 0; x < ${D0}; x ++ ) {
          vec3 dir = octDecode( ( vec2( x, y ) + 0.5 ) / float( ${D0} ) * 2.0 - 1.0 );
          float c = max( 0.0, dot( dir, n ) );

          sum += w * c * texelFetch( uCascade0, q * ${D0} + ivec2( x, y ), 0 ).rgb;
          cosineSum += w * c;
        }
      }
    }

    // NOTE Normalized, so uniform radiance L gives exactly PI * L
    vec3 irradiance = cosineSum > 1e-5 ? 3.14159265 * sum / cosineSum : unoccluded;
    float visibility = clamp( luminanceOf( irradiance ) / max( 1e-6, luminanceOf( unoccluded ) ), 0.0, 1.0 );

    gl_FragColor = vec4( irradiance, visibility );
  }
`;

const debugFragment = /* glsl */ `
  precision highp float;

  uniform sampler2D uIrradiance;
  uniform int uMode;

  void main() {
    vec4 value = texelFetch( uIrradiance, ivec2( gl_FragCoord.xy ), 0 );
    vec3 color = uMode == 1 ? value.rgb / 3.14159265 : vec3( value.a );
    gl_FragColor = vec4( pow( color / ( 1.0 + color ), vec3( 1.0 / 2.2 ) ), 1.0 );
  }
`;

const makeTarget = (width, height) =>
  new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });

export async function createRadianceCascades(ctx, mode) {
  const { renderer, camera } = ctx;

  const settings = {
    scale: 0.5,
    cascades: 5,
    baseInterval: 0.12,
    bias: 0.02,
    thickness: 0.6,
    specularOcclusion: true,
    debug: 'off',
  };

  const sceneBVH = mode === 'bvh' ? ctx.getSceneBVH() : null;
  const bvhStruct = mode === 'bvh' ? new MeshBVHUniformStruct() : null;

  if (sceneBVH) {
    sceneBVH.update();
    bvhStruct.updateFrom(sceneBVH.bvh);
  }

  const cascadeMaterial = new THREE.ShaderMaterial({
    vertexShader: passVertex,
    fragmentShader: cascadeFragment(mode),
    uniforms: {
      uGPosition: { value: null },
      uGNormal: { value: null },
      uGSize: { value: new THREE.Vector2() },
      uGScale: { value: 1 },
      uSpacing: { value: S0 },
      uDirRes: { value: D0 },
      uProbeCount: { value: new THREE.Vector2() },
      uT0: { value: 0 },
      uT1: { value: 1 },
      uBias: { value: settings.bias },
      uIsTop: { value: true },
      uUpper: { value: null },
      uUpperSpacing: { value: S0 },
      uUpperDirRes: { value: D0 },
      uUpperProbeCount: { value: new THREE.Vector2() },
      uEnv: { value: null },
      uEnvMaxLod: { value: 0 },
      ...(mode === 'bvh'
        ? { bvh: { value: bvhStruct } }
        : {
            uView: { value: camera.matrixWorldInverse },
            uProjection: { value: camera.projectionMatrix },
            uThickness: { value: settings.thickness },
          }),
    },
  });

  const resolveMaterial = new THREE.ShaderMaterial({
    vertexShader: passVertex,
    fragmentShader: resolveFragment,
    uniforms: {
      uGPosition: { value: null },
      uGNormal: { value: null },
      uGSize: { value: new THREE.Vector2() },
      uGScale: { value: 1 },
      uCascade0: { value: null },
      uProbeCount: { value: new THREE.Vector2() },
      uWorkScale: { value: 1 },
      uEnv: { value: null },
      uEnvMaxLod: { value: 0 },
    },
  });

  const debugMaterial = new THREE.ShaderMaterial({
    vertexShader: passVertex,
    fragmentShader: debugFragment,
    uniforms: { uIrradiance: { value: null }, uMode: { value: 1 } },
  });

  const quad = new FullScreenQuad(cascadeMaterial);

  const targets = [makeTarget(1, 1), makeTarget(1, 1)];
  const irradianceTarget = makeTarget(1, 1);

  const hookUniforms = {
    rcIrradiance: { value: irradianceTarget.texture },
    rcSpecularOcclusion: { value: 1 },
  };

  const size = new THREE.Vector2(1, 1);
  const workSize = new THREE.Vector2(1, 1);
  const gSize = new THREE.Vector2(1, 1);

  let env = null;
  let raysPerFrame = 0;

  const resizeTargets = () => {
    workSize.set(Math.max(1, Math.round(size.x * settings.scale)), Math.max(1, Math.round(size.y * settings.scale)));

    // NOTE Every cascade texture is about work size, plus one probe of the top cascade
    const margin = D0 * 2 ** (settings.cascades - 1);
    const width = Math.ceil(workSize.x / S0) * D0 + margin;
    const height = Math.ceil(workSize.y / S0) * D0 + margin;

    for (const target of targets) target.setSize(width, height);

    irradianceTarget.setSize(size.x, size.y);
  };

  const intervalStart = (i) => (settings.baseInterval * (4 ** i - 1)) / 3;

  return {
    hook: {
      key: `rc-${mode}`,
      uniforms: hookUniforms,
      pars: /* glsl */ `
        uniform sampler2D rcIrradiance;
        uniform float rcSpecularOcclusion;
      `,
      diffuse: /* glsl */ `
        iblIrradiance += texture2D( rcIrradiance, hookScreenUv() ).rgb;
      `,
      specular: /* glsl */ `
        iblRadiance *= mix( 1.0, texture2D( rcIrradiance, hookScreenUv() ).a, rcSpecularOcclusion );
      `,
    },

    setEnvironment(info) {
      env = info.pmrem;
    },

    resize(width, height) {
      size.set(width, height);
      resizeTargets();
    },

    beforeRender(frame) {
      if (!env) return;

      if (sceneBVH && frame.sceneChanged) {
        sceneBVH.update();
        bvhStruct.updateFrom(sceneBVH.bvh);
      }

      const gbuffer = ctx.renderGBuffer();
      gSize.set(gbuffer.target.width, gbuffer.target.height);

      const previousTarget = renderer.getRenderTarget();

      const u = cascadeMaterial.uniforms;
      u.uGPosition.value = gbuffer.position;
      u.uGNormal.value = gbuffer.normal;
      u.uGSize.value.copy(gSize);
      u.uGScale.value = gSize.x / workSize.x;
      u.uBias.value = settings.bias;
      u.uEnv.value = env.texture;
      u.uEnvMaxLod.value = env.maxLod;
      if (u.uThickness) u.uThickness.value = settings.thickness;

      quad.material = cascadeMaterial;
      raysPerFrame = 0;

      let write = 0;
      let upper = null;

      // NOTE Top cascade first, each cascade merges the one above it
      for (let i = settings.cascades - 1; i >= 0; i--) {
        const spacing = S0 * 2 ** i;
        const dirRes = D0 * 2 ** i;
        const probesX = Math.ceil(workSize.x / spacing);
        const probesY = Math.ceil(workSize.y / spacing);

        u.uSpacing.value = spacing;
        u.uDirRes.value = dirRes;
        u.uProbeCount.value.set(probesX, probesY);
        u.uT0.value = intervalStart(i);
        u.uT1.value = intervalStart(i + 1);
        u.uIsTop.value = upper === null;
        u.uUpper.value = upper ? upper.target.texture : null;

        if (upper) {
          u.uUpperSpacing.value = upper.spacing;
          u.uUpperDirRes.value = upper.dirRes;
          u.uUpperProbeCount.value.set(upper.probesX, upper.probesY);
        }

        const target = targets[write];
        renderer.setRenderTarget(target);
        quad.render(renderer);

        raysPerFrame += probesX * probesY * dirRes * dirRes;

        upper = { target, spacing, dirRes, probesX, probesY };
        write = 1 - write;
      }

      const r = resolveMaterial.uniforms;
      r.uGPosition.value = gbuffer.position;
      r.uGNormal.value = gbuffer.normal;
      r.uGSize.value.copy(gSize);
      r.uGScale.value = gSize.x / workSize.x;
      r.uCascade0.value = upper.target.texture;
      r.uProbeCount.value.set(Math.ceil(workSize.x / S0), Math.ceil(workSize.y / S0));
      r.uWorkScale.value = workSize.x / gSize.x;
      r.uEnv.value = env.texture;
      r.uEnvMaxLod.value = env.maxLod;

      quad.material = resolveMaterial;
      renderer.setRenderTarget(irradianceTarget);
      quad.render(renderer);

      renderer.setRenderTarget(previousTarget);

      hookUniforms.rcSpecularOcclusion.value = settings.specularOcclusion ? 1 : 0;
    },

    render() {
      if (settings.debug === 'off') return false;

      debugMaterial.uniforms.uIrradiance.value = irradianceTarget.texture;
      debugMaterial.uniforms.uMode.value = settings.debug === 'irradiance' ? 1 : 2;
      quad.material = debugMaterial;
      renderer.setRenderTarget(null);
      quad.render(renderer);

      return true;
    },

    gui(folder) {
      folder.add(settings, 'scale', { quarter: 0.25, half: 0.5, full: 1 }).name('resolution').onChange(resizeTargets);
      folder.add(settings, 'cascades', 3, 6, 1).onChange(resizeTargets);
      folder.add(settings, 'baseInterval', 0.02, 0.5, 0.01).name('cascade 0 length (m)');
      folder.add(settings, 'bias', 0.0, 0.1, 0.005);
      if (mode === 'screen') folder.add(settings, 'thickness', 0.05, 3, 0.05).name('depth thickness (m)');
      folder.add(settings, 'specularOcclusion').name('specular occlusion');
      folder.add(settings, 'debug', ['off', 'irradiance', 'visibility']).name('debug view');
    },

    stats() {
      const lines = [
        `${settings.cascades} cascades · c0 ${Math.ceil(workSize.x / S0)}x${Math.ceil(workSize.y / S0)} probes x ${D0 * D0} dirs · ${(raysPerFrame / 1e6).toFixed(1)} M rays/frame`,
        `reach ${intervalStart(settings.cascades).toFixed(1)} m · ${mode === 'bvh' ? 'BVH' : 'screen-space depth'} tracing`,
      ];

      if (sceneBVH) lines.push(`BVH regenerate + refit ${sceneBVH.lastUpdateMs.toFixed(2)} ms cpu (when animating)`);

      return lines.join('\n');
    },

    memory() {
      const cascades = targets.reduce((sum, t) => sum + t.width * t.height * 8, 0);
      const gbuffer = ctx.gbuffer.target.width * ctx.gbuffer.target.height * 36;

      return cascades + irradianceTarget.width * irradianceTarget.height * 8 + gbuffer;
    },

    dispose() {
      for (const target of targets) target.dispose();
      irradianceTarget.dispose();
      cascadeMaterial.dispose();
      resolveMaterial.dispose();
      debugMaterial.dispose();
      quad.dispose();
      bvhStruct?.dispose();
    },
  };
}
