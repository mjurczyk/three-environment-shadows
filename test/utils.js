import {
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearSRGBColorSpace,
  RGBAFormat,
} from 'three';

export const WIDTH = 256;
export const HEIGHT = 128;

const SKY = [0.5, 0.6, 1];

// NOTE Texel of the given direction, with flipY = true (row 0 at the top)
export const getTexel = (elevation, azimuth) => [
  Math.floor((azimuth / (2 * Math.PI) + 0.5) * WIDTH),
  Math.floor((0.5 - elevation / Math.PI) * HEIGHT),
];

export const createEnvironment = (paint, type = FloatType) => {
  const data = new Float32Array(WIDTH * HEIGHT * 4);

  for (let i = 0; i < WIDTH * HEIGHT; i++) data.set([...SKY, 1], i * 4);

  paint((x, y, rgb) => data.set([...rgb, 1], (y * WIDTH + x) * 4));

  let texelData = data;

  if (type === HalfFloatType) {
    texelData = new Uint16Array(data.length);

    for (let i = 0; i < data.length; i++) texelData[i] = DataUtils.toHalfFloat(data[i]);
  }

  const texture = new DataTexture(texelData, WIDTH, HEIGHT, RGBAFormat, type);
  texture.flipY = true;
  texture.colorSpace = LinearSRGBColorSpace;

  return texture;
};

export const paintSun = (elevation, azimuth, radiance) => (set) => {
  const [x, y] = getTexel(elevation, azimuth);

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) set(x + dx, y + dy, radiance);
  }
};

// NOTE Sum of luminance times solid angle
export const getEnergy = (texture) => {
  const data = texture.image.data;
  const decode = texture.type === HalfFloatType ? DataUtils.fromHalfFloat : (value) => value;

  let energy = 0;

  for (let y = 0; y < HEIGHT; y++) {
    const solidAngle =
      ((2 * Math.PI) / WIDTH) *
      Math.abs(Math.cos((Math.PI * y) / HEIGHT) - Math.cos((Math.PI * (y + 1)) / HEIGHT));

    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const luminance =
        0.2126 * decode(data[i]) + 0.7152 * decode(data[i + 1]) + 0.0722 * decode(data[i + 2]);

      energy += luminance * solidAngle;
    }
  }

  return energy;
};

export const getLuminance = (light) =>
  light.intensity * (0.2126 * light.color.r + 0.7152 * light.color.g + 0.0722 * light.color.b);
