import { describe, expect, it } from 'vitest';
import { createPacker, ENTRY_SIZE, NO_PLACE } from '../src/core/packer.js';

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

  return { charts, uv };
};

// NOTE One unit per geometry (scales: per unit), entries one after the other
const createUnits = (geometries) => {
  let entryCount = 0;
  const units = geometries.map((geometry, g) => {
    const unit = { geometry: g, base: entryCount };

    entryCount += geometry.charts.length;

    return unit;
  });

  return { units, entryCount };
};

// NOTE The atlas UVs of the vertices of a unit chart, from its layout entry
const atlasUvs = (layout, entry, chart, uv) => {
  const o = entry * ENTRY_SIZE;

  return Array.from(chart.vertices, (v) => [
    layout[o] * uv[v * 2] + layout[o + 1] * uv[v * 2 + 1] + layout[o + 2],
    layout[o + 4] * uv[v * 2] + layout[o + 5] * uv[v * 2 + 1] + layout[o + 6],
  ]);
};

const hasPlace = (layout, unit, geometry) =>
  geometry.charts.every((chart, c) =>
    atlasUvs(layout, unit.base + c, chart, geometry.uv).every(([u]) => u > 0),
  );

// NOTE Rasterizes the triangles of all units, counts texels covered twice (in one atlas) and triangles outside
const check = (geometries, units, layout, size) => {
  const grids = [new Uint8Array(size * size), new Uint8Array(size * size)];
  let overlap = 0;
  let outside = 0;

  units.forEach((unit, m) => {
    const { charts, uv } = geometries[unit.geometry];

    charts.forEach((chart, c) => {
      const uvs = new Map();
      const grid = grids[layout[(unit.base + c) * ENTRY_SIZE + 3]];

      atlasUvs(layout, unit.base + c, chart, uv).forEach((p, i) => uvs.set(chart.vertices[i], p));

      const t = chart.triangles;

      for (let k = 0; k < t.length; k += 3) {
        const p = [0, 1, 2].map((j) => uvs.get(t[k + j]).map((value) => value * size));

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
    });
  });

  return { overlap, outside };
};

describe('packer', () => {
  it('packs charts of several units without overlaps, inside the atlas', async () => {
    const geometries = [createMesh(6, 1), createMesh(3, 2), createMesh(10, 0.5)];
    const { units, entryCount } = createUnits(geometries);
    const packer = createPacker(geometries, units, entryCount);
    const layout = await packer.pack([true, true, true], 128);

    expect(units.every((unit) => hasPlace(layout, unit, geometries[unit.geometry]))).toBe(true);
    expect(check(geometries, units, layout, 128)).toEqual({ overlap: 0, outside: 0 });

    packer.dispose();
  });

  it('gives hidden units no place and more texels to the visible ones', async () => {
    const geometries = [createMesh(4, 1), createMesh(4, 1)];
    const { units, entryCount } = createUnits(geometries);
    const packer = createPacker(geometries, units, entryCount);

    const both = await packer.pack([true, true], 128);
    const first = await packer.pack([true, false], 128);

    expect(first[units[1].base * ENTRY_SIZE + 2]).toBe(NO_PLACE);

    // NOTE The width of the first chart in the atlas
    const width = (layout) => {
      const [a, b] = atlasUvs(layout, 0, geometries[0].charts[0], geometries[0].uv);

      return b[0] - a[0];
    };
    expect(width(first)).toBeGreaterThan(width(both) * 1.2);

    packer.dispose();
  });

  it('packs instances of one geometry apart, larger instances get more texels', async () => {
    const geometry = createMesh(2, 1);
    const units = [0, 1, 2].map((k) => ({ geometry: 0, base: k * 2 }));
    const packer = createPacker([geometry], units, 6);
    const layout = await packer.pack([true, true, true], 128, null, [1, 1, 2]);

    expect(check([geometry], units, layout, 128)).toEqual({ overlap: 0, outside: 0 });

    const width = (unit) => {
      const [a, b] = atlasUvs(layout, unit.base, geometry.charts[0], geometry.uv);

      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    expect(width(units[2]) / width(units[0])).toBeCloseTo(2, 1);

    packer.dispose();
  });

  it('packs visible charts into the primary atlas, hidden charts into the secondary atlas', async () => {
    const geometries = [createMesh(4, 1), createMesh(4, 1)];
    const { units, entryCount } = createUnits(geometries);
    const packer = createPacker(geometries, units, entryCount);
    const masks = [Uint32Array.from([3, 0, 1, 0]), Uint32Array.from([0, 0, 0, 0])];
    const layout = await packer.pack([true, true], 128, masks);
    const atlas = (entry) => layout[entry * ENTRY_SIZE + 3];

    expect([0, 1, 2, 3, 4, 5, 6, 7].map(atlas)).toEqual([0, 1, 0, 1, 1, 1, 1, 1]);
    expect(units.every((unit) => hasPlace(layout, unit, geometries[unit.geometry]))).toBe(true);
    expect(check(geometries, units, layout, 128)).toEqual({ overlap: 0, outside: 0 });

    // NOTE The 2 visible charts have the primary atlas to themselves, the 6 hidden ones share the secondary atlas
    const width = (entry, unit) => {
      const [a, b] = atlasUvs(layout, entry, geometries[unit].charts[0], geometries[unit].uv);

      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    expect(width(0, 0)).toBeGreaterThan(width(4, 1) * 1.4);

    packer.dispose();
  });

  it('packs the secondary atlas at its own size', async () => {
    const geometries = [createMesh(4, 1)];
    const { units, entryCount } = createUnits(geometries);
    const packer = createPacker(geometries, units, entryCount);
    const masks = [Uint32Array.from([1, 0, 0, 0])];
    const same = await packer.pack([true], [128, 128], masks);
    const small = await packer.pack([true], [128, 32], masks);

    // NOTE Texels along the first edge of a chart: UV length times the atlas size
    const texels = (layout, entry, size) => {
      const [a, b] = atlasUvs(layout, entry, geometries[0].charts[entry], geometries[0].uv);

      return Math.hypot(b[0] - a[0], b[1] - a[1]) * size;
    };

    expect(texels(small, 0, 128)).toBeCloseTo(texels(same, 0, 128), 5);
    expect(texels(small, 1, 32)).toBeLessThan(texels(same, 1, 128) * 0.5);

    packer.dispose();
  });

  it('uses NO_PLACE for charts without a place', () => {
    expect(NO_PLACE).toBeLessThan(0);
  });
});
