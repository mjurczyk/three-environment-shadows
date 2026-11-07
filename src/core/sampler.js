import {
  Color,
  DataUtils,
  HalfFloatType,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three';

const _color = /*@__PURE__*/ new Color();

/**
 * Radical inverse in the given base, for a low-discrepancy (Halton) sample sequence.
 *
 * @param {number} index - The sample index.
 * @param {number} base - The base, a prime number.
 * @return {number} A number in [0, 1).
 */
export function halton(index, base) {
  let result = 0;
  let f = 1 / base;
  let i = index;

  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }

  return result;
}

// NOTE Byte value to linear, with the sRGB transfer function for sRGB textures
function byteDecoder(texture) {
  const table = new Float32Array(256);
  const isSRGB = texture.colorSpace === SRGBColorSpace;

  for (let i = 0; i < 256; i++)
    table[i] = isSRGB ? _color.setRGB(i / 255, 0, 0, SRGBColorSpace).r : i / 255;

  return (v) => table[v];
}

// NOTE Image textures (e.g. SDR JPGs): the browser scales the image, then texels are decoded to linear
function downsampleImage(texture, width) {
  const height = Math.max(1, width / 2);
  const canvas =
    typeof document !== 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(width, height);

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

/**
 * Box-filters an equirectangular texture (float, half float or byte data, or an image) to
 * `width` x `width / 2` texels of linear RGB.
 *
 * @param {Texture} texture - The equirectangular environment map.
 * @param {number} [width=512] - The output width.
 * @return {{data: Float32Array, width: number, height: number}} RGB texels, row 0 at the top (+Y).
 */
export function downsampleEquirect(texture, width = 512) {
  const image = texture.image;

  if (!image) throw new Error('EnvironmentShadows: The environment map has no image.');

  if (image.data === undefined || image.data === null) return downsampleImage(texture, width);

  const sw = image.width;
  const sh = image.height;
  const src = image.data;
  const channels = texture.format === RGBAFormat ? 4 : 3;
  const height = Math.max(1, width / 2);

  const decode =
    texture.type === HalfFloatType
      ? DataUtils.fromHalfFloat
      : texture.type === UnsignedByteType
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

/**
 * Importance sampling of an environment map by energy (luminance times solid angle).
 *
 * @param {{data: Float32Array, width: number, height: number}} map - See {@link downsampleEquirect}.
 * @return {function(number, number, number, number): {direction: Vector3, color: Color}} Returns a
 * direction and its radiance divided by the pdf, for four uniform numbers (texel and position in the texel).
 * The returned objects are reused.
 */
export function createEnvironmentSampler(map) {
  const { data, width, height } = map;
  const rowSolidAngle = new Float64Array(height);
  const conditional = new Float64Array(width * height);
  const marginal = new Float64Array(height);

  let total = 0;

  for (let y = 0; y < height; y++) {
    const top = (0.5 - y / height) * Math.PI;
    const bottom = (0.5 - (y + 1) / height) * Math.PI;

    rowSolidAngle[y] = ((2 * Math.PI) / width) * (Math.sin(top) - Math.sin(bottom));

    let row = 0;

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

      row += Math.max(0, luminance) * rowSolidAngle[y];
      conditional[y * width + x] = row;
    }

    total += row;
    marginal[y] = total;
  }

  const search = (array, offset, count, value) => {
    let low = 0;
    let high = count - 1;

    while (low < high) {
      const mid = (low + high) >> 1;

      if (array[offset + mid] < value) low = mid + 1;
      else high = mid;
    }

    return low;
  };

  const direction = new Vector3();
  const color = new Color();

  return (u1, u2, fx, fy) => {
    if (total <= 0) {
      direction.set(0, 1, 0);
      color.setRGB(0, 0, 0);

      return { direction, color };
    }

    const y = search(marginal, 0, height, u1 * total);
    const rowStart = y > 0 ? marginal[y - 1] : 0;
    const x = search(conditional, y * width, width, u2 * (marginal[y] - rowStart));

    // NOTE See equirectUv() in common.glsl
    const phi = ((x + fx) / width - 0.5) * 2 * Math.PI;
    const lat = (0.5 - (y + fy) / height) * Math.PI;

    direction.set(Math.cos(lat) * Math.cos(phi), Math.sin(lat), Math.cos(lat) * Math.sin(phi));

    const i = (y * width + x) * 3;
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

    // NOTE pdf per solid angle = ( luminance * texel solid angle / total ) / texel solid angle
    const pdf = Math.max(1e-12, luminance / total);

    color.setRGB(data[i] / pdf, data[i + 1] / pdf, data[i + 2] / pdf);

    return { direction, color };
  };
}
