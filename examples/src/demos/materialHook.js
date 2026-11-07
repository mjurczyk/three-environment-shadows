import * as THREE from 'three';

/**
 * A material hook lets a technique replace parts of the MeshStandardMaterial lighting.
 *
 * hook = {
 *   key: string,                 // program cache key, unique per hook variant
 *   uniforms: { name: { value } }, // shared uniform objects, update .value at any time
 *   pars: string,                // GLSL declared before main()
 *   diffuse: string,             // GLSL that REPLACES `iblIrradiance += getIBLIrradiance( geometryNormal );`
 *                                // It must add irradiance E (W/m2, cosine included) to `iblIrradiance`.
 *                                // Unoccluded reference: getIBLIrradiance( geometryNormal ) == PI * L for uniform radiance L.
 *   specular: string,            // GLSL that runs before `radiance += iblRadiance;`, may scale `iblRadiance`
 *   direct: string,              // GLSL that runs for each directional light after getDirectionalLightInfo(),
 *                                // may scale `directLight.color`. `directLight.direction` is in view space.
 *   vertexPars: string,          // GLSL declared before the vertex main()
 *   vertex: string,              // GLSL at the end of the vertex main()
 * }
 *
 * Helpers always available in hook GLSL:
 *   vec3 hookWorldPosition()     // world-space fragment position
 *   vec3 hookWorldDirection(v)   // view-space direction -> world space (normalized)
 *   vec2 hookScreenUv()          // 0..1 over the drawing buffer
 *   uniform mat4 hookViewInverse; uniform vec2 hookResolution;
 */

export const hookUniforms = {
  hookViewInverse: { value: new THREE.Matrix4() },
  hookResolution: { value: new THREE.Vector2(1, 1) },
};

const HOOK_PARS = /* glsl */ `
uniform mat4 hookViewInverse;
uniform vec2 hookResolution;

vec3 hookWorldPosition() { return ( hookViewInverse * vec4( - vViewPosition, 1.0 ) ).xyz; }
vec3 hookWorldDirection( vec3 v ) { return normalize( ( hookViewInverse * vec4( v, 0.0 ) ).xyz ); }
vec2 hookScreenUv() { return gl_FragCoord.xy / hookResolution; }
`;

const DIFFUSE_LINE = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const SPECULAR_LINE = 'radiance += iblRadiance;';
const DIRECT_LINE = 'getDirectionalLightInfo( directionalLight, directLight );';

function patch(shader, hook) {
  Object.assign(shader.uniforms, hookUniforms, hook.uniforms ?? {});

  let maps = THREE.ShaderChunk.lights_fragment_maps;
  let begin = THREE.ShaderChunk.lights_fragment_begin;

  if (!maps.includes(DIFFUSE_LINE) || !maps.includes(SPECULAR_LINE) || !begin.includes(DIRECT_LINE)) {
    throw new Error('materialHook: three.js light chunks changed, update the patch lines');
  }

  if (hook.diffuse) maps = maps.replace(DIFFUSE_LINE, `{\n${hook.diffuse}\n}`);
  if (hook.specular) maps = maps.replace(SPECULAR_LINE, `{\n${hook.specular}\n}\n${SPECULAR_LINE}`);
  if (hook.direct) begin = begin.replace(DIRECT_LINE, `${DIRECT_LINE}\n{\n${hook.direct}\n}`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_fragment_maps>', maps)
    .replace('#include <lights_fragment_begin>', begin)
    .replace('void main() {', `${HOOK_PARS}\n${hook.pars ?? ''}\nvoid main() {`);

  // NOTE Optional vertex code, runs at the end of main()
  if (hook.vertexPars || hook.vertex) {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${hook.vertexPars ?? ''}\nvoid main() {`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${hook.vertex ?? ''}`);
  }
}

/** Applies a hook (or null to remove it) to the given materials. */
export function applyMaterialHook(materials, hook) {
  for (const material of materials) {
    // NOTE A cached program is reused without onBeforeCompile and keeps the uniforms of the last compile.
    // The hook samplers are then missing and read texture unit 0. Dispose drops the cached programs.
    material.dispose();

    if (hook) {
      material.onBeforeCompile = (shader) => patch(shader, hook);
      material.customProgramCacheKey = () => hook.key;
    } else {
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = () => '';
    }

    material.needsUpdate = true;
  }
}
