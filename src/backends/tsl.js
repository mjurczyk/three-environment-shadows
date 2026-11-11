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
import {
  LightingNode,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  NodeMaterial,
  QuadMesh,
} from 'three/webgpu';
import {
  Fn,
  If,
  attribute,
  cameraViewMatrix,
  clamp,
  cross,
  dot,
  drawIndex,
  float,
  hash,
  instanceIndex,
  int,
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
  step,
  texture,
  textureLoad,
  textureSize,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { NO_PLACE } from '../core/packer.js';
import { CHART_ATTRIBUTE } from '../core/unwrap.js';
import { LAYOUT_WIDTH } from '../core/units.js';

/**
 * TSL backend for WebGPURenderer (WebGPU and its WebGL 2 fallback): node materials.
 *
 * @private
 */

// NOTE The instance of the vertex: of an InstancedMesh, or the instance id of a BatchedMesh (as in three.js batch())
function getInstance(builder) {
  const object = builder.object;

  if (object.isInstancedMesh) return int(instanceIndex);
  if (!object.isBatchedMesh) return int(0);

  const id = int(builder.getDrawIndex() === null ? instanceIndex : drawIndex);
  const indirect = object._indirectTexture;
  const size = int(textureSize(textureLoad(indirect), 0).x);

  return int(textureLoad(indirect, ivec2(id.mod(size), id.div(size))).x);
}

// NOTE ( atlas u, atlas v, atlas: 0 primary, 1 secondary ) of the vertex, see units.js. NO_PLACE without a place.
function getAtlasUv(layout, builder) {
  if (!builder.hasGeometryAttribute(CHART_ATTRIBUTE)) return vec3(NO_PLACE, NO_PLACE, 0);

  return Fn(() => {
    const chart = attribute(CHART_ATTRIBUTE, 'vec3');
    const uv = vec3(attribute('lightmapUv', 'vec2'), 1);
    const instance = getInstance(builder);
    const texel = (t) => textureLoad(layout, ivec2(t.mod(LAYOUT_WIDTH), t.div(LAYOUT_WIDTH)));

    const index = int(chart.x.add(0.5)).sub(1).toVar();
    const base = int(chart.y.add(0.5).floor()).toVar();

    If(chart.z.lessThan(-0.5), () => {
      base.assign(int(texel(base.add(instance).mul(2)).x.add(0.5).floor()));
    }).Else(() => {
      base.addAssign(instance.mul(int(chart.z.add(0.5))));
    });

    const result = vec3(NO_PLACE, NO_PLACE, 0).toVar();

    If(index.greaterThanEqual(0).and(base.greaterThanEqual(0)), () => {
      const t = base.add(index).mul(2);
      const row = texel(t);

      result.assign(vec3(dot(row.xyz, uv), dot(texel(t.add(1)).xyz, uv), row.w));
    });

    return result;
  })();
}

// NOTE The atlas UVs of slots A and B, computed per vertex
const getDisplayUvs = (display, builder) => ({
  uvA: varying(getAtlasUv(display.layoutA, builder)),
  uvB: varying(getAtlasUv(display.layoutB, builder)),
});

// NOTE The lightmap of an atlas UV: z selects the primary or the secondary atlas
const sampleLightmap = (primary, secondary, uv) =>
  mix(texture(primary, uv.xy).rgb, texture(secondary, uv.xy).rgb, step(0.5, uv.z));

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
    const { uvA, uvB } = getDisplayUvs(display, builder);

    const unoccluded = vec3(iblIrradiance).toVar();

    // NOTE The lightmap is baked at intensity 1. Same intensity as the environment node: material.envMapIntensity
    // with material.envMap, else scene.environmentIntensity. The unoccluded light has it already.
    const intensity = builder.material.envMap
      ? reference('envMapIntensity', 'float', builder.material)
      : reference('environmentIntensity', 'float', builder.scene);

    // NOTE Atlas UVs are > 0, units without a place (UV -10) keep the unoccluded light
    const valueA = select(
      uvA.x.greaterThan(1e-6),
      sampleLightmap(display.a, display.secondaryA, uvA).mul(intensity),
      unoccluded,
    );
    const valueB = select(
      uvB.x.greaterThan(1e-6),
      sampleLightmap(display.b, display.secondaryB, uvB).mul(intensity),
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
    const visibility = clamp(
      dot(baked, weights).div(max(dot(unoccluded, weights), 1e-6)),
      0,
      1,
    ).toVar();

    // NOTE Occlusion remap: no darkening below the start, full darkening at the end.
    // Scaling the baked light keeps its color and direction.
    const occlusion = clamp(
      float(1)
        .sub(visibility)
        .sub(display.shadowStart)
        .div(max(display.shadowEnd.sub(display.shadowStart), 1e-4)),
      0,
      1,
    );
    const remapped = float(1).sub(occlusion).toVar();

    iblIrradiance.assign(baked.mul(remapped.div(max(visibility, 1e-3))));
    radiance.mulAssign(mix(float(1), remapped, display.specularOcclusion));
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
      // NOTE The layout texture of the bake, a placeholder here
      layout: texture(new Texture()),
      // NOTE The atlas of this bake pass. Render group: two passes per frame, both see their value.
      atlas: uniform(0).setGroup(renderGroup),
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
    // Units without a place (UV -10) are outside the clip space.
    material.vertexNode = Fn((builder) => {
      const uv = getAtlasUv(uniforms.layout, builder);
      const inAtlas = uv.z.sub(uniforms.atlas).abs().lessThan(0.5);

      return select(
        inAtlas,
        vec4(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)), 0, 1),
        vec4(-2, -2, 0, 1),
      );
    })();

    // NOTE Charts can be mirrored, so keep the geometric normal. The varying reads normalLocal in the vertex
    // stage, with the instance transform.
    material.normalNode = cameraViewMatrix
      .mul(vec4(varying(modelNormalMatrix.mul(normalLocal)), 0))
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

  supportsBatchedMesh: true,

  createDisplay() {
    const display = {
      // NOTE Lightmap and layout textures of slots A and B. Placeholders: EnvironmentShadowsBase sets them
      // before any material builds.
      a: texture(new Texture()),
      b: texture(new Texture()),
      secondaryA: texture(new Texture()),
      secondaryB: texture(new Texture()),
      layoutA: texture(new Texture()),
      layoutB: texture(new Texture()),
      // NOTE Render group: updated every render. Object group uniforms of materials without node properties
      // are only refreshed when three.js sees the material or object change, value changes would be lost.
      frontIsA: uniform(1).setGroup(renderGroup),
      blend: uniform(1).setGroup(renderGroup),
      valid: uniform(0).setGroup(renderGroup),
      specularOcclusion: uniform(1).setGroup(renderGroup),
      shadowStart: uniform(0).setGroup(renderGroup),
      shadowEnd: uniform(1).setGroup(renderGroup),
    };

    const patched = new WeakSet();
    const materials = new Set();

    return {
      uniforms: {
        a: display.a,
        b: display.b,
        layoutA: display.layoutA,
        layoutB: display.layoutB,
        secondaryA: display.secondaryA,
        secondaryB: display.secondaryB,
        frontIsA: display.frontIsA,
        blend: display.blend,
        valid: display.valid,
        specularOcclusion: display.specularOcclusion,
        shadowStart: display.shadowStart,
        shadowEnd: display.shadowEnd,
      },

      // NOTE New lightmap textures (another atlas size) need a rebuild of the patched materials
      refresh() {
        for (const material of materials) material.needsUpdate = true;
      },

      // NOTE Debug view: the front lightmap, magenta where a unit has no place in the atlas
      createLightmapMaterial() {
        const material = new MeshBasicNodeMaterial();

        material.colorNode = Fn((builder) => {
          const { uvA, uvB } = getDisplayUvs(display, builder);
          const frontIsA = display.frontIsA.greaterThan(0.5);
          const uv = select(frontIsA, uvA, uvB);
          const color = select(
            frontIsA,
            sampleLightmap(display.a, display.secondaryA, uvA),
            sampleLightmap(display.b, display.secondaryB, uvB),
          );

          return select(uv.x.greaterThan(1e-6), color, vec3(1, 0, 1));
        })();

        return material;
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
