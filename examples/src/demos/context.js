import * as THREE from 'three';

/**
 * Environment map helpers for the demo.
 */

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
