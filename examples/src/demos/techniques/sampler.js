import * as THREE from 'three';

// NOTE Importance sampling of an environment map by energy, used by the lightmap bake

// NOTE Radical inverse, for a low-discrepancy (Halton) sample sequence
export const halton = (index, base) => {
  let result = 0;
  let f = 1 / base;
  let i = index;

  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }

  return result;
};

// NOTE Energy CDF of an equirect map with row 0 at the top
export function buildSampler(map) {
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

  const direction = new THREE.Vector3();
  const color = new THREE.Color();

  // NOTE Returns { direction, color = radiance / pdf } for four uniform numbers (texel, position in texel)
  return (u1, u2, fx, fy) => {
    const y = search(marginal, 0, height, u1 * total);
    const rowStart = y > 0 ? marginal[y - 1] : 0;
    const rowTotal = marginal[y] - rowStart;

    const x = search(conditional, y * width, width, u2 * rowTotal);

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

