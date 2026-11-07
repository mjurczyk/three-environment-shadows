import * as THREE from 'three';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';

/**
 * Shared helpers for techniques. See techniques/index.js for the technique interface.
 */

// NOTE Direction of a texel center of an equirect map with row 0 at the top (v = 1), see equirectUv() in three.js
export function texelDirection(x, y, width, height, target = new THREE.Vector3()) {
  const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
  const lat = (0.5 - (y + 0.5) / height) * Math.PI;

  return target.set(Math.cos(lat) * Math.cos(phi), Math.sin(lat), Math.cos(lat) * Math.sin(phi));
}

/**
 * Box-filters an equirect DataTexture (half float, float or byte) to `width` x `width / 2`, linear RGB.
 * Returns { data: Float32Array (RGB, row 0 = top / +Y), width, height }.
 */
export function downsampleEquirect(texture, width = 256) {
  const image = texture.image;

  if (!image) throw new Error('downsampleEquirect: the texture has no image');

  if (image.data === undefined) return downsampleImage(texture, width);

  const sw = image.width;
  const sh = image.height;
  const src = image.data;
  const channels = texture.format === THREE.RGBAFormat ? 4 : 3;
  const height = Math.max(1, width / 2);

  const decode =
    texture.type === THREE.HalfFloatType
      ? THREE.DataUtils.fromHalfFloat
      : texture.type === THREE.UnsignedByteType
        ? byteDecoder(texture)
        : (v) => v;

  const out = new Float32Array(width * height * 3);
  const count = new Float32Array(width * height);

  for (let y = 0; y < sh; y++) {
    // NOTE Row 0 of the output is at the top
    const row = texture.flipY ? y : sh - 1 - y;
    const oy = Math.min(height - 1, Math.floor((row * height) / sh));

    for (let x = 0; x < sw; x++) {
      const ox = Math.min(width - 1, Math.floor((x * width) / sw));
      const i = (y * sw + x) * channels;
      const o = oy * width + ox;

      out[o * 3] += decode(src[i]);
      out[o * 3 + 1] += decode(src[i + 1]);
      out[o * 3 + 2] += decode(src[i + 2]);
      count[o]++;
    }
  }

  for (let o = 0; o < width * height; o++) {
    const c = Math.max(1, count[o]);
    out[o * 3] /= c;
    out[o * 3 + 1] /= c;
    out[o * 3 + 2] /= c;
  }

  return { data: out, width, height };
}

// NOTE Byte value -> linear, with the sRGB transfer function for sRGB textures
function byteDecoder(texture) {
  const table = new Float32Array(256);
  const color = new THREE.Color();
  const isSRGB = texture.colorSpace === THREE.SRGBColorSpace;

  for (let i = 0; i < 256; i++) table[i] = isSRGB ? color.setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r : i / 255;

  return (v) => table[v];
}

// NOTE Image textures (e.g. SDR JPGs): the browser scales the image, then texels are decoded to linear
function downsampleImage(texture, width) {
  const height = Math.max(1, width / 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(texture.image, 0, 0, width, height);

  // NOTE Canvas row 0 is the top of the image, the sky of an equirect map
  const pixels = context.getImageData(0, 0, width, height).data;
  const decode = byteDecoder(texture);
  const out = new Float32Array(width * height * 3);

  for (let i = 0; i < width * height; i++) {
    out[i * 3] = decode(pixels[i * 4]);
    out[i * 3 + 1] = decode(pixels[i * 4 + 1]);
    out[i * 3 + 2] = decode(pixels[i * 4 + 2]);
  }

  return { data: out, width, height };
}

/** PMREM cache, one cube render target per source texture. */
export class PMREMCache {
  constructor(renderer) {
    this.generator = new THREE.PMREMGenerator(renderer);
    this.cache = new Map();
  }

  /** Returns { texture: CubeTexture (render target, mipmapped), maxLod } for an equirect texture. */
  get(texture) {
    if (!texture) return null;

    let entry = this.cache.get(texture);

    if (!entry) {
      const target = this.generator.fromEquirectangular(texture);
      entry = { target, texture: target.texture, maxLod: target.texture.mipmaps.length - 1 };
      this.cache.set(texture, entry);
    }

    return entry;
  }

  clear() {
    for (const entry of this.cache.values()) entry.target.dispose();

    this.cache.clear();
  }
}

/**
 * Merged world-space geometry + BVH of all scene meshes.
 * update() regenerates the geometry and refits the BVH when meshes moved, returns the CPU ms spent.
 */
export class SceneBVH {
  constructor(meshes) {
    this.meshes = meshes;
    this.version = 0;
    this.lastUpdateMs = 0;
    this.build();
  }

  build() {
    this.geometry?.dispose();
    this.sources = this.meshes.map((mesh) => mesh.geometry);
    this.generator = new StaticGeometryGenerator(this.meshes);
    this.generator.attributes = ['position', 'normal'];
    // NOTE Groups make a multi-root BVH, MeshBVHUniformStruct supports one root only
    this.generator.useGroups = false;
    this.geometry = this.generator.generate();
    this.geometry.clearGroups();
    this.bvh = new MeshBVH(this.geometry);
    this.geometry.boundsTree = this.bvh;
  }

  update() {
    const start = performance.now();

    // NOTE A mesh got a new geometry (e.g. the lightmap unwrap of E2): the vertex count changed, build again
    if (this.meshes.some((mesh, i) => mesh.geometry !== this.sources[i])) {
      this.build();
    } else {
      this.generator.generate(this.geometry);
      this.geometry.clearGroups();
      this.bvh.refit();
    }

    this.version++;

    this.lastUpdateMs = performance.now() - start;

    return this.lastUpdateMs;
  }

  dispose() {
    this.geometry.dispose();
  }
}
