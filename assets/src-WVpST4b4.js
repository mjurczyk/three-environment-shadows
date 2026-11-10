import{t as e}from"./EnvironmentShadowsBase-CCTwIWWL.js";import{A as t,F as n,Gn as r,_t as i,at as a,c as o,j as s,rt as c,t as l,wn as u}from"./index-DqsUVizp.js";var d=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;`,f=`vDirectionalShadowCoord[ i ]`,p=`
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
`,m=`
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
`,h=`
  attribute vec2 lightmapUvA;
  attribute vec2 lightmapUvB;
  varying vec2 vLmA;
  varying vec2 vLmB;
  varying vec2 vLmHas;
`,g=`
  vLmA = lightmapUvA;
  vLmB = lightmapUvB;
  vLmHas = vec2( step( 1e-6, lightmapUvA.x ), step( 1e-6, lightmapUvB.x ) );
`,_=`
  varying vec2 vLmA;
  varying vec2 vLmB;
  varying vec2 vLmHas;
  uniform sampler2D lmA;
  uniform sampler2D lmB;
  uniform float lmFrontIsA;
  uniform float lmBlend;
  uniform float lmValid;
  uniform float lmSpecularOcclusion;
  uniform float lmShadowStart;
  uniform float lmShadowEnd;
`,v=`
  {
    vec3 lmUnoccluded = iblIrradiance;

    // NOTE The lightmap is baked at intensity 1. envMapIntensity is material.envMapIntensity or
    // scene.environmentIntensity, the same as for the environment diffuse. The unoccluded light has it already.
    #ifdef USE_ENVMAP
      float lmIntensity = envMapIntensity;
    #else
      float lmIntensity = 1.0;
    #endif

    vec3 lmValueA = vLmHas.x > 0.5 ? texture2D( lmA, vLmA ).rgb * lmIntensity : lmUnoccluded;
    vec3 lmValueB = vLmHas.y > 0.5 ? texture2D( lmB, vLmB ).rgb * lmIntensity : lmUnoccluded;
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
`,y=new o;y.setAttribute(`position`,new t([-1,3,0,-1,-1,0,3,-1,0],3));var b=new c(y);b.frustumCulled=!1;var x=new i,S={getSumType(e){return e.getContext().getExtension(`EXT_float_blend`)===null?n:s},createBakeMaterial(){let e={bakeNoise:{value:0},bakeSeed:{value:0},bakeMapTexel:{value:1/512}},t=new a({color:16777215,side:2,shadowSide:1,forceSinglePass:!0,blending:5,blendEquation:100,blendSrc:201,blendDst:201,blendSrcAlpha:201,blendDstAlpha:201,depthTest:!1,depthWrite:!1});return t.onBeforeCompile=t=>{let n=l.normal_fragment_begin,r=l.lights_fragment_begin;if(!n.includes(d)||!r.includes(f))throw Error(`EnvironmentShadows: Unsupported three.js shader chunks.`);Object.assign(t.uniforms,e),t.vertexShader=t.vertexShader.replace(`void main() {`,`attribute vec2 lightmapUvBake;
void main() {`).replace(`#include <fog_vertex>`,`#include <fog_vertex>
gl_Position = vec4( lightmapUvBake * 2.0 - 1.0, 0.0, 1.0 );`),t.fragmentShader=t.fragmentShader.replace(`void main() {`,`${p}\nvoid main() {`).replace(`#include <normal_fragment_begin>`,n.replace(d,`float faceDirection = 1.0;`)).replace(`#include <lights_fragment_begin>`,r.split(f).join(`( ${f} + bakeShadowJitter() )`))},t.customProgramCacheKey=()=>`environment-shadows-bake`,{material:t,uniforms:{noise:e.bakeNoise,seed:e.bakeSeed,mapTexel:e.bakeMapTexel,shadowExtent:{value:1},lightDirection:{value:new r}}}},createFinalize(e,t){let n=new u({vertexShader:`void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,fragmentShader:m,uniforms:{uSum:{value:e},uSize:{value:{x:t,y:t}},uScale:{value:1}},depthTest:!1,depthWrite:!1});return{material:n,uniforms:{scale:n.uniforms.uScale},dispose:()=>n.dispose()}},renderQuad(e,t){b.material=t,e.render(b,x)},createDisplay(){let e={lmA:{value:null},lmB:{value:null},lmFrontIsA:{value:1},lmBlend:{value:1},lmValid:{value:0},lmSpecularOcclusion:{value:1},lmShadowStart:{value:0},lmShadowEnd:{value:1}},t=new WeakMap;return{uniforms:{a:e.lmA,b:e.lmB,frontIsA:e.lmFrontIsA,blend:e.lmBlend,valid:e.lmValid,specularOcclusion:e.lmSpecularOcclusion,shadowStart:e.lmShadowStart,shadowEnd:e.lmShadowEnd},refresh(){},patch(n){if(t.has(n))return;let r=n.onBeforeCompile,i=n.customProgramCacheKey;t.set(n,{onBeforeCompile:r,customProgramCacheKey:i}),n.onBeforeCompile=function(t,n){r.call(this,t,n),t.fragmentShader.includes(`#include <lights_fragment_maps>`)&&(Object.assign(t.uniforms,e),t.vertexShader=t.vertexShader.replace(`void main() {`,`${h}\nvoid main() {`).replace(`#include <fog_vertex>`,`#include <fog_vertex>\n${g}`),t.fragmentShader=t.fragmentShader.replace(`void main() {`,`${_}\nvoid main() {`).replace(`#include <lights_fragment_maps>`,`#include <lights_fragment_maps>\n${v}`))},n.customProgramCacheKey=function(){return`${i.call(this)}|environment-shadows`},n.dispose(),n.needsUpdate=!0},unpatch(e){let n=t.get(e);n&&(e.onBeforeCompile=n.onBeforeCompile,e.customProgramCacheKey=n.customProgramCacheKey,t.delete(e),e.dispose(),e.needsUpdate=!0)}}}},C=class extends e{constructor(e,t,n={}){super(e,t,n,S)}};export{C as EnvironmentShadows};