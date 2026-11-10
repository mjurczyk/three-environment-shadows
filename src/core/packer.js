/**
 * Lightmap atlas packing.
 *
 * Charts are packed by their outline (the lowest and highest filled cell of each column) on a height
 * map, like Tetris, so curved charts nest into each other. One texel density (texels per meter) for
 * all charts, as large as fits. Packing runs in a worker, it takes ~100 ms.
 */

// NOTE The atlas UV of a vertex without a place in the layout
export const NO_PLACE = -10;

// NOTE Self-contained (no outside references), so its source can run in a worker
function packerModule() {
  const NO_PLACE = -10;

  // NOTE Chart coordinates in the frame of its smallest bounding rect, in meters
  function chartPoint(chart, uv, v, target) {
    const x = uv[v * 2];
    const y = uv[v * 2 + 1];

    target[0] = (chart.cos * x + chart.sin * y - chart.minU) * chart.metersPerUv;
    target[1] = (-chart.sin * x + chart.cos * y - chart.minV) * chart.metersPerUv;

    return target;
  }

  /**
   * Column outline of a chart on the packing grid: the lowest and highest filled cell of each column, plus
   * `pad` cells right and up. `turned` swaps u and v. Cells are `cell` meters.
   */
  function chartOutline(chart, uv, cell, pad, turned) {
    const w = Math.max(1, Math.ceil((turned ? chart.height : chart.width) / cell));
    const h = Math.max(1, Math.ceil((turned ? chart.width : chart.height) / cell));
    const bottom = new Float64Array(w).fill(Infinity);
    const top = new Float64Array(w).fill(-Infinity);
    const tri = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
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
          if ((p[0] - c) * (q[0] - c) < 0)
            ys.push(p[1] + ((c - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
          if ((p[0] - c - 1) * (q[0] - c - 1) < 0)
            ys.push(p[1] + ((c + 1 - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
        }

        for (const y of ys) {
          bottom[c] = Math.min(bottom[c], y);
          top[c] = Math.max(top[c], y);
        }
      }
    }

    // NOTE Grow by the padding: columns to the right, then higher tops
    const width = w + pad;
    const outBottom = new Int32Array(width).fill(1 << 30);
    const outTop = new Int32Array(width).fill(-(1 << 30));

    for (let c = 0; c < w; c++) {
      if (bottom[c] === Infinity) continue;

      const b = Math.max(0, Math.floor(bottom[c]));
      const tp = Math.min(h, Math.ceil(top[c]));

      for (let d = 0; d <= pad; d++) {
        outBottom[c + d] = Math.min(outBottom[c + d], b);
        outTop[c + d] = Math.max(outTop[c + d], tp + pad);
      }
    }

    // NOTE Empty columns (between parts) do not block anything
    for (let c = 0; c < width; c++) {
      if (outTop[c] < outBottom[c]) {
        outBottom[c] = 1 << 30;
        outTop[c] = -(1 << 30);
      }
    }

    return { w: width, h: h + pad, bottom: outBottom, top: outTop };
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
   * Each chart tries 4 variants (as is, turned, flipped, both). A chart without a place gets null.
   * All columns start at `start` (the rows below are the shelves of the small charts).
   */
  function outlinePack(items, size, start = 0) {
    const height = new Int32Array(size).fill(start);
    const placements = new Array(items.length).fill(null);
    let missed = 0;
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

      if (!best) {
        missed++;
        continue;
      }

      const { top, columns } = items[i].outlines[best.variant];

      for (const c of columns) height[best.x + c] = best.y + top[c];

      placements[i] = best;
    }

    return { placements, missed };
  }

  // NOTE Texels of margin around each chart, against bleeding of bilinear filtering and dilation.
  // Small atlases have large texels, so they get a wider margin.
  const atlasPadding = (atlasSize) => (atlasSize > 512 ? 2 : 4);

  // NOTE Smallest chart area, in texels
  const MIN_CHART_TEXELS = 1;

  // NOTE Charts with outlines of at most SMALL_CHART x SMALL_CHART cells go into shelves, the outline search is slow
  const SMALL_CHART = 8;

  /**
   * Shelf packing of the rects of small charts, rows from the atlas bottom.
   * Returns the placements (null without a place), the misses and the shelf height.
   */
  function shelfPack(items, size) {
    const placements = new Array(items.length).fill(null);
    const order = items
      .map((item, i) => i)
      .sort((i, j) => items[j].outlines[0].h - items[i].outlines[0].h);
    let x = 0;
    let y = 0;
    let shelf = 0;
    let missed = 0;

    for (const i of order) {
      const { w, h } = items[i].outlines[0];

      if (x + w > size) {
        y += shelf;
        x = 0;
        shelf = 0;
      }

      if (y + h > size) {
        missed++;
        continue;
      }

      placements[i] = { x, y, variant: 0 };
      x += w;
      shelf = Math.max(shelf, h);
    }

    return { placements, missed, height: y + shelf };
  }

  /**
   * Packs the charts of the meshes with visible[ i ] === true into the atlas, at the largest texel density
   * that fits. meshData[ i ] = { charts, uv (Float32Array, xatlas UVs), vertexCount }.
   * With masks (screen hit counts), the visible charts (hits > 0) get `visibleScale` times more area.
   * Returns per mesh a Float32Array of atlas UVs (2 per vertex), or null without a place.
   */
  function packCharts(
    meshData,
    visible,
    atlasSize,
    padding = atlasPadding(atlasSize),
    masks = null,
    visibleScale = 2,
  ) {
    const charts = [];

    meshData.forEach((mesh, meshIndex) => {
      if (!visible[meshIndex]) return;

      const mask = masks ? masks[meshIndex] : null;

      mesh.charts.forEach((chart, c) => {
        if (chart.metersPerUv <= 0 || chart.worldArea <= 0) return;

        if (!mask || mask[c] === 0 || visibleScale === 1) {
          charts.push({ meshIndex, chart, uv: mesh.uv });
          return;
        }

        const scale = Math.sqrt(visibleScale);

        charts.push({
          meshIndex,
          chart: {
            ...chart,
            metersPerUv: chart.metersPerUv * scale,
            width: chart.width * scale,
            height: chart.height * scale,
            worldArea: chart.worldArea * visibleScale,
          },
          uv: mesh.uv,
        });
      });
    });

    const result = meshData.map(() => null);

    if (charts.length === 0) return result;

    // NOTE The packing grid: cells of `texelsPerCell` texels, one texel per cell up to 2048
    const size = Math.min(atlasSize, 2048);
    const texelsPerCell = atlasSize / size;
    const pad = Math.max(1, Math.ceil(padding / texelsPerCell));

    const tryDensity = (density) => {
      // NOTE density in texels per meter, one cell is texelsPerCell / density meters
      const cell = texelsPerCell / density;

      const items = charts.map(({ chart, uv }) => {
        // NOTE Small charts grow to MIN_CHART_TEXELS, else their triangles cover no texel center and stay black
        const texels = chart.width * chart.height * density * density;
        const chartCell = cell / Math.max(1, Math.sqrt(MIN_CHART_TEXELS / Math.max(texels, 1e-12)));

        // NOTE Small charts only need their rect (the size of their plain outline), no rasterization
        const w = Math.max(1, Math.ceil(chart.width / chartCell)) + pad;
        const h = Math.max(1, Math.ceil(chart.height / chartCell)) + pad;

        if (w <= SMALL_CHART && h <= SMALL_CHART)
          return { area: chart.worldArea, cell: chartCell, small: true, outlines: [{ w, h }] };

        const plain = chartOutline(chart, uv, chartCell, pad, false);
        const turned = chartOutline(chart, uv, chartCell, pad, true);

        return {
          area: chart.worldArea,
          cell: chartCell,
          outlines: [plain, turned, flipOutline(plain), flipOutline(turned)].map(prepareOutline),
        };
      });

      // NOTE Small charts in shelves at the bottom, the others by their outlines above them
      const small = [];
      const large = [];

      items.forEach((item, i) => (item.small ? small : large).push(i));

      // NOTE The first `pad` columns stay empty: the display reads an atlas u of 0 as no place
      const shelves = shelfPack(
        small.map((i) => items[i]),
        size - pad,
      );
      const outlines = outlinePack(
        large.map((i) => items[i]),
        size - pad,
        shelves.height,
      );
      const placements = new Array(items.length).fill(null);

      small.forEach((i, k) => (placements[i] = shelves.placements[k]));
      large.forEach((i, k) => (placements[i] = outlines.placements[k]));

      return { placements, missed: shelves.missed + outlines.missed, items, cell };
    };

    // NOTE Binary search for the largest density that fits, around the density that fills the atlas
    // completely (an upper bound) down to a quarter of it
    const totalArea = charts.reduce((sum, { chart }) => sum + chart.worldArea, 0);
    const full = atlasSize / Math.sqrt(Math.max(totalArea, 1e-9));
    let low = 0.25 * full;
    let high = full;
    let best = tryDensity(low);
    // NOTE If not all charts fit, keep the result with the fewest charts without a place
    let partial = best;

    // NOTE Lower densities until all charts fit, or give up and use the partial result
    for (let step = 0; step < 8 && best.missed > 0; step++) {
      high = low;
      low *= 0.5;
      best = tryDensity(low);
      if (best.missed < partial.missed) partial = best;
    }

    if (best.missed === 0) {
      for (let step = 0; step < 5; step++) {
        const density = (low + high) / 2;
        const packed = tryDensity(density);

        if (packed.missed === 0) {
          low = density;
          best = packed;
        } else {
          high = density;
        }
      }
    } else {
      best = partial;
      console.warn(
        `EnvironmentShadows: ${best.missed} of ${charts.length} charts have no place in the atlas.`,
      );
    }

    meshData.forEach((mesh, meshIndex) => {
      if (visible[meshIndex])
        result[meshIndex] = new Float32Array(mesh.vertexCount * 2).fill(NO_PLACE);
    });

    const point = [0, 0];

    charts.forEach(({ meshIndex, chart, uv }, i) => {
      if (!best.placements[i]) return;

      const uvs = result[meshIndex];
      const { x, y, variant } = best.placements[i];
      const { h } = best.items[i].outlines[variant];
      const turned = variant === 1 || variant === 3;
      const flipped = variant >= 2;

      for (const v of chart.vertices) {
        chartPoint(chart, uv, v, point);

        // NOTE In cells. Turned / flipped charts are mirrored: the bake keeps the geometric normal, winding does not matter
        let u = point[0] / best.items[i].cell;
        let w = point[1] / best.items[i].cell;

        if (turned) [u, w] = [w, u];

        if (flipped) w = h - w;

        uvs[v * 2] = ((pad + x + u) * texelsPerCell) / atlasSize;
        uvs[v * 2 + 1] = ((y + w) * texelsPerCell) / atlasSize;
      }
    });

    return result;
  }

  return { packCharts };
}

/**
 * Creates a packer for the given meshes. pack( visible, atlasSize ) resolves with one Float32Array
 * (2 atlas UVs per vertex) or null per mesh.
 *
 * @param {Array<Mesh>} meshes - Unwrapped meshes, see unwrap.js.
 * @return {{pack: function(Array<boolean>, number): Promise<Array<?Float32Array>>, dispose: function()}}
 */
export function createPacker(meshes) {
  const meshData = meshes.map((mesh) => ({
    charts: mesh.userData.environmentShadowCharts ?? [],
    uv: mesh.geometry.attributes.lightmapUv?.array.slice() ?? new Float32Array(0),
    vertexCount: mesh.geometry.attributes.position.count,
  }));

  let worker = null;
  let url = null;

  if (typeof Worker !== 'undefined') {
    const body = `const { packCharts } = ( ${packerModule.toString()} )();
      let meshData = null;
      self.onmessage = ( event ) => {
        const message = event.data;
        if ( message.type === 'init' ) { meshData = message.meshData; return; }
        const layout = packCharts( meshData, message.visible, message.atlasSize, undefined, message.masks, message.visibleScale );
        self.postMessage( { id: message.id, layout }, layout.filter( Boolean ).map( ( uvs ) => uvs.buffer ) );
      };`;

    url = URL.createObjectURL(new Blob([body], { type: 'application/javascript' }));
    worker = new Worker(url);
    worker.postMessage({ type: 'init', meshData });
  }

  const { packCharts } = packerModule();
  const pending = new Map();
  let nextId = 0;

  if (worker) {
    worker.onmessage = (event) => {
      const { id, layout } = event.data;

      pending.get(id)?.(layout);
      pending.delete(id);
    };
  }

  return {
    pack(visible, atlasSize, masks = null, visibleScale = 2) {
      if (!worker)
        return Promise.resolve(
          packCharts(meshData, visible, atlasSize, undefined, masks, visibleScale),
        );

      const id = nextId++;

      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ type: 'pack', id, visible, atlasSize, masks, visibleScale });
      });
    },

    dispose() {
      worker?.terminate();

      if (url !== null) URL.revokeObjectURL(url);

      pending.clear();
    },
  };
}
