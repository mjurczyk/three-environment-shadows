import { describe, expect, it } from 'vitest';
import { createPacker, NO_PLACE } from '../src/core/packer.js';

// NOTE A mesh of `count` square charts of `size` meters, each two triangles with its own 4 vertices
const createMesh = (count, size) => {
  const uv = new Float32Array(count * 4 * 2);
  const charts = [];

  for (let c = 0; c < count; c++) {
    const v = c * 4;

    uv.set([0, 0, 1, 0, 1, 1, 0, 1], v * 2);

    charts.push({
      vertices: Uint32Array.from([v, v + 1, v + 2, v + 3]),
      triangles: Uint32Array.from([v, v + 1, v + 2, v, v + 2, v + 3]),
      worldArea: size * size,
      metersPerUv: size,
      cos: 1,
      sin: 0,
      minU: 0,
      minV: 0,
      width: size,
      height: size,
    });
  }

  return {
    userData: { environmentShadowCharts: charts },
    geometry: { attributes: { lightmapUv: { array: uv }, position: { count: count * 4 } } },
  };
};

// NOTE Rasterizes the triangles of all meshes, counts texels covered twice and triangles outside the atlas
const check = (meshes, layout, size) => {
  const grid = new Uint8Array(size * size);
  let overlap = 0;
  let outside = 0;

  meshes.forEach((mesh, m) => {
    const uvs = layout[m];

    if (!uvs) return;

    for (const chart of mesh.userData.environmentShadowCharts) {
      const t = chart.triangles;

      for (let k = 0; k < t.length; k += 3) {
        const p = [0, 1, 2].map((j) => [uvs[t[k + j] * 2] * size, uvs[t[k + j] * 2 + 1] * size]);

        if (p.some(([x, y]) => x < 0 || y < 0 || x > size || y > size)) outside++;

        const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        const area = edge(p[0], p[1], p[2][0], p[2][1]);

        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const cx = x + 0.5;
            const cy = y + 0.5;
            const w0 = edge(p[1], p[2], cx, cy) / area;
            const w1 = edge(p[2], p[0], cx, cy) / area;
            const w2 = edge(p[0], p[1], cx, cy) / area;

            // NOTE Strict inside test, texels on a shared edge of two triangles are not counted twice
            if (w0 > 0 && w1 > 0 && w2 > 0) {
              if (grid[y * size + x] && grid[y * size + x] !== m + 1) overlap++;
              grid[y * size + x] = m + 1;
            }
          }
        }
      }
    }
  });

  return { overlap, outside };
};

describe('packer', () => {
  it('packs charts of several meshes without overlaps, inside the atlas', async () => {
    const meshes = [createMesh(6, 1), createMesh(3, 2), createMesh(10, 0.5)];
    const packer = createPacker(meshes);
    const layout = await packer.pack([true, true, true], 128);

    expect(layout.every(Boolean)).toBe(true);
    expect(check(meshes, layout, 128)).toEqual({ overlap: 0, outside: 0 });

    packer.dispose();
  });

  it('gives hidden meshes no place and more texels to the visible ones', async () => {
    const meshes = [createMesh(4, 1), createMesh(4, 1)];
    const packer = createPacker(meshes);

    const both = await packer.pack([true, true], 128);
    const first = await packer.pack([true, false], 128);

    expect(first[1]).toBeNull();

    // NOTE The width of the first chart in the atlas
    const width = (uvs) => uvs[2] - uvs[0];
    expect(width(first[0])).toBeGreaterThan(width(both[0]) * 1.2);

    packer.dispose();
  });

  it('uses NO_PLACE for vertices of hidden charts', () => {
    expect(NO_PLACE).toBeLessThan(0);
  });
});
