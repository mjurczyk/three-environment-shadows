/**
 * Lightmap atlas packing, without three.js so it can run in a worker.
 *
 * Charts are packed by their outline (the lowest and highest filled cell of each column) on a height
 * map, like Tetris, so curved charts nest into each other. One texel density (texels per meter) for
 * all charts, as large as fits.
 */

// NOTE The UV of a vertex without a place in the layout
export const NO_PLACE = -10;

// NOTE Chart coordinates in the frame of its smallest bounding rect, in meters
function chartPoint(chart, uv, v, target) {
  const x = uv[v * 2];
  const y = uv[v * 2 + 1];

  target[0] = (chart.cos * x + chart.sin * y - chart.minU) * chart.metersPerUv;
  target[1] = (-chart.sin * x + chart.cos * y - chart.minV) * chart.metersPerUv;

  return target;
}

/**
 * Column outline of a chart on the packing grid: for each column the lowest and highest filled cell,
 * grown by `pad` cells. `turned` rasterizes with u and v swapped. Cells are `cell` meters.
 */
function chartOutline(chart, uv, cell, pad, turned) {
  const w = Math.max(1, Math.ceil((turned ? chart.height : chart.width) / cell));
  const h = Math.max(1, Math.ceil((turned ? chart.width : chart.height) / cell));
  const bottom = new Float64Array(w).fill(Infinity);
  const top = new Float64Array(w).fill(-Infinity);
  const tri = [[0, 0], [0, 0], [0, 0]];
  const ys = [];

  const { triangles } = chart;

  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      chartPoint(chart, uv, triangles[t + k], tri[k]);

      if (turned) [tri[k][0], tri[k][1]] = [tri[k][1], tri[k][0]];

      tri[k][0] /= cell;
      tri[k][1] /= cell;
    }

    const minX = Math.max(0, Math.floor(Math.min(tri[0][0], tri[1][0], tri[2][0])));
    const maxX = Math.min(w - 1, Math.floor(Math.max(tri[0][0], tri[1][0], tri[2][0])));

    // NOTE The y range of the triangle inside each column slab [ c, c + 1 ]
    for (let c = minX; c <= maxX; c++) {
      ys.length = 0;

      for (let k = 0; k < 3; k++) {
        const p = tri[k];
        const q = tri[(k + 1) % 3];

        if (p[0] >= c && p[0] <= c + 1) ys.push(p[1]);

        // NOTE Crossings of the edge with both slab borders
        if ((p[0] - c) * (q[0] - c) < 0) ys.push(p[1] + ((c - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
        if ((p[0] - c - 1) * (q[0] - c - 1) < 0) ys.push(p[1] + ((c + 1 - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
      }

      for (const y of ys) {
        bottom[c] = Math.min(bottom[c], y);
        top[c] = Math.max(top[c], y);
      }
    }
  }

  // NOTE Grow by the padding: wider columns, then lower bottoms and higher tops
  const width = w + 2 * pad;
  const outBottom = new Int32Array(width).fill(1 << 30);
  const outTop = new Int32Array(width).fill(-(1 << 30));

  for (let c = 0; c < w; c++) {
    if (bottom[c] === Infinity) continue;

    const b = Math.max(0, Math.floor(bottom[c]));
    const tp = Math.min(h, Math.ceil(top[c]));

    for (let d = 0; d <= 2 * pad; d++) {
      outBottom[c + d] = Math.min(outBottom[c + d], b);
      outTop[c + d] = Math.max(outTop[c + d], tp + 2 * pad);
    }
  }

  // NOTE Empty columns (between parts) do not block anything
  for (let c = 0; c < width; c++) {
    if (outTop[c] < outBottom[c]) {
      outBottom[c] = 1 << 30;
      outTop[c] = -(1 << 30);
    }
  }

  return { w: width, h: h + 2 * pad, bottom: outBottom, top: outTop };
}

// NOTE Flips an outline vertically (mirror in v)
function flipOutline(outline) {
  const { w, h, bottom, top } = outline;
  const flippedBottom = new Int32Array(w);
  const flippedTop = new Int32Array(w);

  for (let c = 0; c < w; c++) {
    const empty = top[c] < bottom[c];
    flippedBottom[c] = empty ? 1 << 30 : h - top[c];
    flippedTop[c] = empty ? -(1 << 30) : h - bottom[c];
  }

  return { w, h, bottom: flippedBottom, top: flippedTop };
}

// NOTE Adds what the packer needs per outline: filled columns, highest top, sum of bottoms
function prepareOutline(outline) {
  const columns = [];
  let topMax = 0;
  let bottomSum = 0;

  for (let c = 0; c < outline.w; c++) {
    if (outline.top[c] < outline.bottom[c]) continue;

    columns.push(c);
    topMax = Math.max(topMax, outline.top[c]);
    bottomSum += outline.bottom[c];
  }

  return { ...outline, columns: Int32Array.from(columns), topMax, bottomSum };
}

/**
 * Outline (Tetris) packing on a grid of `size` columns: a height map of the filled part of each column,
 * every chart rests on it with its own bottom outline, so curved charts nest into each other.
 * Each chart tries 4 variants (as is, turned, flipped, both). Returns placements or null.
 */
function outlinePack(items, size) {
  const height = new Int32Array(size);
  const placements = new Array(items.length);
  const order = items.map((item, i) => i).sort((i, j) => items[j].area - items[i].area);

  for (const i of order) {
    let best = null;

    for (let variant = 0; variant < 4; variant++) {
      const { w, bottom, columns, topMax, bottomSum } = items[i].outlines[variant];
      const count = columns.length;

      if (w > size || count === 0) continue;

      for (let x = 0; x + w <= size; x++) {
        // NOTE The rest height y, cut short when this position cannot beat the best peak
        const limit = best ? best.peak - topMax : size - topMax;
        let y = 0;
        let heightSum = 0;
        let rejected = false;

        for (let k = 0; k < count; k++) {
          const c = columns[k];
          const h = height[x + c];
          const rest = h - bottom[c];

          if (rest > y) {
            y = rest;

            if (y > limit) {
              rejected = true;
              break;
            }
          }

          heightSum += h;
        }

        if (rejected) continue;

        const peak = y + topMax;
        const waste = count * y + bottomSum - heightSum;

        // NOTE Lowest peak first, then the least space lost under the chart
        if (!best || peak < best.peak || (peak === best.peak && waste < best.waste)) {
          best = { x, y, variant, peak, waste };
        }
      }
    }

    if (!best) return null;

    const { top, columns } = items[i].outlines[best.variant];

    for (const c of columns) height[best.x + c] = best.y + top[c];

    placements[i] = best;
  }

  return placements;
}

// NOTE Texels of margin around each chart, against bleeding of bilinear filtering and dilation.
// Small atlases have large texels, so they get a wider margin.
export const atlasPadding = (atlasSize) => (atlasSize > 512 ? 2 : 4);

/**
 * Packs the charts of the meshes with visible[ i ] === true into the atlas, at the largest texel density
 * that fits. meshData[ i ] = { charts, uv (Float32Array, xatlas UVs), vertexCount }.
 * Returns per mesh a Float32Array of atlas UVs (2 per vertex), or null without a place.
 */
export function packCharts(meshData, visible, atlasSize, padding = atlasPadding(atlasSize)) {
  const charts = [];

  meshData.forEach((mesh, meshIndex) => {
    if (!visible[meshIndex]) return;

    for (const chart of mesh.charts) {
      if (chart.metersPerUv > 0) charts.push({ meshIndex, chart, uv: mesh.uv });
    }
  });

  const result = meshData.map(() => null);

  if (charts.length === 0) return result;

  // NOTE The packing grid: cells of `texelsPerCell` texels
  const size = Math.min(atlasSize, 512);
  const texelsPerCell = atlasSize / size;
  const pad = Math.max(1, Math.ceil(padding / texelsPerCell));

  const tryDensity = (density) => {
    // NOTE density in texels per meter, one cell is texelsPerCell / density meters
    const cell = texelsPerCell / density;

    const items = charts.map(({ chart, uv }) => {
      const plain = chartOutline(chart, uv, cell, pad, false);
      const turned = chartOutline(chart, uv, cell, pad, true);

      return {
        area: chart.worldArea,
        outlines: [plain, turned, flipOutline(plain), flipOutline(turned)].map(prepareOutline),
      };
    });

    const placements = outlinePack(items, size);

    return placements ? { placements, items, cell } : null;
  };

  // NOTE Binary search for the largest density that fits, around the density that fills the atlas
  // completely (an upper bound) down to a quarter of it
  const totalArea = charts.reduce((sum, { chart }) => sum + chart.worldArea, 0);
  const full = atlasSize / Math.sqrt(Math.max(totalArea, 1e-9));
  let low = 0.25 * full;
  let high = full;
  let best = tryDensity(low);

  for (let step = 0; step < 7; step++) {
    const density = (low + high) / 2;
    const packed = tryDensity(density);

    if (packed) {
      low = density;
      best = packed;
    } else {
      high = density;
    }
  }

  if (!best) return result;

  meshData.forEach((mesh, meshIndex) => {
    if (visible[meshIndex]) result[meshIndex] = new Float32Array(mesh.vertexCount * 2).fill(NO_PLACE);
  });

  const point = [0, 0];

  charts.forEach(({ meshIndex, chart, uv }, i) => {
    const uvs = result[meshIndex];
    const { x, y, variant } = best.placements[i];
    const { h } = best.items[i].outlines[variant];
    const turned = variant === 1 || variant === 3;
    const flipped = variant >= 2;

    for (const v of chart.vertices) {
      chartPoint(chart, uv, v, point);

      // NOTE In cells. Turned / flipped charts are mirrored: the bake keeps the geometric normal, winding does not matter
      let u = point[0] / best.cell;
      let w = point[1] / best.cell;

      if (turned) [u, w] = [w, u];

      w += pad;
      if (flipped) w = h - w;

      uvs[v * 2] = ((x + pad + u) * texelsPerCell) / atlasSize;
      uvs[v * 2 + 1] = ((y + w) * texelsPerCell) / atlasSize;
    }
  });

  return result;
}
