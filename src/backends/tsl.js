import {
  AddEquation,
  BackSide,
  CustomBlending,
  DoubleSide,
  FloatType,
  HalfFloatType,
  OneFactor,
  Texture,
  Vector3,
} from 'three';
import { LightingNode, MeshLambertNodeMaterial, NodeMaterial, QuadMesh } from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  cameraViewMatrix,
  clamp,
  cross,
  dot,
  float,
  hash,
  ivec2,
  max,
  mix,
  modelNormalMatrix,
  normalLocal,
  positionWorld,
  reference,
  renderGroup,
  screenCoordinate,
  select,
  texture,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * TSL backend for WebGPURenderer (WebGPU and its WebGL 2 fallback): node materials.
 *
 * @private
 */

// NOTE The baked lightmap replaces the environment diffuse (iblIrradiance), its visibility occludes the
// environment specular (radiance). Runs after the environment node in the material lighting list.
class EnvironmentShadowsLightingNode extends LightingNode {
  static get type() {
    return 'EnvironmentShadowsLightingNode';
  }

  constructor(display) {
    super();

    this.display = display;
  }

  setup(builder) {
    const { iblIrradiance, radiance } = builder.context;
    const display = this.display;

    const unoccluded = vec3(iblIrradiance).toVar();

    // NOTE The lightmap is baked at intensity 1. Same intensity as the environment node: material.envMapIntensity
    // with material.envMap, else scene.environmentIntensity. The unoccluded light has it already.
    const intensity = builder.material.envMap
      ? reference('envMapIntensity', 'float', builder.material)
      : reference('environmentIntensity', 'float', builder.scene);

    // NOTE Atlas UVs are > 0, meshes without a place (UV -10) keep the unoccluded light
    const valueA = select(
      display.uvA.x.greaterThan(1e-6),
      display.sampleA.rgb.mul(intensity),
      unoccluded,
    );
    const valueB = select(
      display.uvB.x.greaterThan(1e-6),
      display.sampleB.rgb.mul(intensity),
      unoccluded,
    );
    const frontIsA = display.frontIsA.greaterThan(0.5);
    const front = select(frontIsA, valueA, valueB);
    const previous = select(frontIsA, valueB, valueA);
    const baked = select(
      display.valid.greaterThan(0.5),
      mix(previous, front, display.blend),
      unoccluded,
    ).toVar();

    const weights = vec3(0.2126, 0.7152, 0.0722);
    const visibility = clamp(dot(baked, weights).div(max(dot(unoccluded, weights), 1e-6)), 0, 1);

    iblIrradiance.assign(baked);
    radiance.mulAssign(mix(float(1), visibility, display.specularOcclusion));
  }
}

const quad = new QuadMesh();

// NOTE Offsets of the dilation, nearest first
const DILATE = 4;
const OFFSETS = [];

for (let y = -DILATE; y <= DILATE; y++) {
  for (let x = -DILATE; x <= DILATE; x++) if (x !== 0 || y !== 0) OFFSETS.push([x, y]);
}

OFFSETS.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));

export const tslBackend = {
  // NOTE Blending into 32-bit float targets needs the optional float32-blendable feature (EXT_float_blend on
  // the WebGL 2 fallback). Half float always works, but loses small samples in long sums.
  getSumType(renderer) {
    const backend = renderer.backend;
    const blendable = backend.isWebGLBackend
      ? backend.gl.getExtension('EXT_float_blend') !== null
      : renderer.hasFeature('float32-blendable');

    return blendable ? FloatType : HalfFloatType;
  },

  // NOTE Lambert in lightmap space: each triangle is drawn at its lightmap UV, lit and shadowed in world space
  createBakeMaterial() {
    const uniforms = {
      noise: uniform(0),
      seed: uniform(0),
      mapTexel: uniform(1 / 512),
      shadowExtent: uniform(1),
      lightDirection: uniform(new Vector3(0, 1, 0)),
    };

    const material = new MeshLambertNodeMaterial({
      color: 0xffffff,
      side: DoubleSide,
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

    material.shadowSide = BackSide;

    // NOTE The atlas UV of this bake, v = 0 at the top (TSL follows the WebGPU conventions on both backends).
    // Meshes without a place (UV -10) are outside the clip space.
    const uv = attribute('lightmapUvBake', 'vec2');
    material.vertexNode = vec4(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)), 0, 1);

    // NOTE The winding in lightmap space is arbitrary (charts can be mirrored), keep the geometric normal
    material.normalNode = cameraViewMatrix
      .mul(vec4(modelNormalMatrix.mul(normalLocal), 0))
      .xyz.normalize();

    // NOTE Shadow noise: a random offset of the shadow lookup, across the light direction (three.js r176+)
    if ('receivedShadowPositionNode' in material) {
      const direction = uniforms.lightDirection.normalize();
      const reference = select(direction.y.abs().lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
      const tangent = cross(reference, direction).normalize();
      const bitangent = cross(direction, tangent);

      const key = screenCoordinate.x.add(screenCoordinate.y.mul(4099)).add(uniforms.seed.mul(7919));
      const offset = tangent
        .mul(hash(key).mul(2).sub(1))
        .add(bitangent.mul(hash(key.add(1337)).mul(2).sub(1)))
        .mul(uniforms.noise.mul(uniforms.mapTexel).mul(uniforms.shadowExtent));

      material.receivedShadowPositionNode = positionWorld.add(offset);
    }

    return { material, uniforms };
  },

  // NOTE Sum (rgb = pre-scaled irradiance sum, a = sample count) to mean, empty texels take the nearest filled texel
  createFinalize(sumTexture, size) {
    const scale = uniform(1);

    const fragment = Fn(() => {
      const pixel = ivec2(screenCoordinate.xy);
      const result = vec4(0).toVar();
      const center = textureLoad(sumTexture, pixel);

      If(center.a.greaterThan(0), () => {
        result.assign(vec4(center.rgb.mul(scale).div(center.a), 1));
      }).Else(() => {
        for (const [x, y] of OFFSETS) {
          If(result.a.equal(0), () => {
            const neighbor = pixel
              .add(ivec2(x, y))
              .max(ivec2(0, 0))
              .min(ivec2(size - 1, size - 1));
            const sample = textureLoad(sumTexture, neighbor);

            If(sample.a.greaterThan(0), () => {
              result.assign(vec4(sample.rgb.mul(scale).div(sample.a), 1));
            });
          });
        }
      });

      return result;
    });

    const material = new NodeMaterial();
    material.fragmentNode = fragment();
    material.depthTest = false;
    material.depthWrite = false;

    return {
      material,
      uniforms: { scale },
      dispose: () => material.dispose(),
    };
  },

  // NOTE WebGPURenderer advances its node frame once per animation frame, not per render(). Light colors and
  // shadow maps update once per node frame, so every sample of a frame would get the color and shadow map of the
  // first one. A new node frame per sample makes them update, like WebGLRenderer does on every render().
  beforeSample(renderer) {
    renderer._nodes.nodeFrame.update();
  },

  renderQuad(renderer, material) {
    quad.material = material;
    quad.render(renderer);
  },

  createDisplay() {
    const uvA = attribute('lightmapUvA', 'vec2');
    const uvB = attribute('lightmapUvB', 'vec2');

    const display = {
      uvA,
      uvB,
      // NOTE The lightmap textures stay the same (slots A and B), a swap only flips frontIsA. They are
      // placeholders here, EnvironmentShadowsBase sets the lightmaps before any material builds.
      sampleA: texture(new Texture(), uvA),
      sampleB: texture(new Texture(), uvB),
      // NOTE Render group: updated every render. Object group uniforms of materials without node properties
      // are only refreshed when three.js sees the material or object change, value changes would be lost.
      frontIsA: uniform(1).setGroup(renderGroup),
      blend: uniform(1).setGroup(renderGroup),
      valid: uniform(0).setGroup(renderGroup),
      specularOcclusion: uniform(1).setGroup(renderGroup),
    };

    const patched = new WeakSet();
    const materials = new Set();

    return {
      uniforms: {
        a: display.sampleA,
        b: display.sampleB,
        frontIsA: display.frontIsA,
        blend: display.blend,
        valid: display.valid,
        specularOcclusion: display.specularOcclusion,
      },

      // NOTE New lightmap textures (another atlas size) need a rebuild of the patched materials
      refresh() {
        for (const material of materials) material.needsUpdate = true;
      },

      patch(material) {
        if (patched.has(material)) return;

        if (!material.isNodeMaterial) {
          console.warn(
            'EnvironmentShadows: WebGPURenderer needs node materials (e.g. MeshStandardNodeMaterial), skipped',
            material,
          );
          return;
        }

        const prototype = Object.getPrototypeOf(material);

        // NOTE Lighting nodes run in the order of their ids (creation order). The node is created after the
        // environment node of this build, so it runs after it and replaces the environment diffuse.
        // Newer three.js versions build the material lighting list in setupMaterialLightings(), r172+ in setupLights().
        if (typeof prototype.setupMaterialLightings === 'function') {
          material.setupMaterialLightings = function (builder) {
            const list = prototype.setupMaterialLightings.call(this, builder);
            list.push(new EnvironmentShadowsLightingNode(display));
            return list;
          };
        } else {
          material.setupLights = function (builder) {
            const lightsNode = prototype.setupLights.call(this, builder);
            const lighting = new EnvironmentShadowsLightingNode(display);
            return builder.renderer.lighting.createNode([...lightsNode.getLights(), lighting]);
          };
        }

        patched.add(material);
        materials.add(material);
        material.needsUpdate = true;
      },

      unpatch(material) {
        if (!patched.has(material)) return;

        delete material.setupMaterialLightings;
        delete material.setupLights;
        patched.delete(material);
        materials.delete(material);
        material.needsUpdate = true;
      },
    };
  },
};
