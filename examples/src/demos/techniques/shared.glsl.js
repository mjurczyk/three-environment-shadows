// NOTE GLSL helpers shared by the techniques

export const octahedralGLSL = /* glsl */ `
// NOTE Full-sphere octahedral mapping, f in [-1, 1]^2
vec3 octDecode( vec2 f ) {
  vec3 n = vec3( f.x, f.y, 1.0 - abs( f.x ) - abs( f.y ) );
  float t = max( - n.z, 0.0 );
  n.x += n.x >= 0.0 ? - t : t;
  n.y += n.y >= 0.0 ? - t : t;
  return normalize( n );
}
`;

// NOTE Samples a PMREM cube (three r187+, mipmapped samplerCube) with a cone of the given half-angle
export const envConeGLSL = /* glsl */ `
float coneToMip( float halfAngle, float maxLod ) {
  // NOTE Rough fit: a 90 degree cone matches roughness 1 (the irradiance level)
  float r = clamp( sqrt( halfAngle / 1.5707963 ), 0.0, 1.0 );
  return maxLod * r * ( 2.0 - r );
}

vec3 envCone( samplerCube env, float maxLod, vec3 dir, float halfAngle ) {
  return textureLod( env, dir, coneToMip( halfAngle, maxLod ) ).rgb;
}

// NOTE Unoccluded irradiance around a world normal, the same as three.js getIBLIrradiance()
vec3 envIrradiance( samplerCube env, float maxLod, vec3 n ) {
  return 3.14159265 * textureLod( env, n, maxLod ).rgb;
}

float luminanceOf( vec3 c ) {
  return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}
`;

export const hashGLSL = /* glsl */ `
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
`;
