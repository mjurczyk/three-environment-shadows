import { BufferAttribute, BufferGeometry } from 'three';
import xatlasSource from 'xatlas-web/dist/xatlas-web.js?raw';
import { extractGeometry, getGeometryIds, setUnwrappedGeometries } from './batched.js';

/**
 * Lightmap unwrap of the receivers, with xatlas, in a worker.
 *
 * Each receiver is unwrapped once. The result is split into charts (connected UV islands), each turned
 * to its smallest bounding rect. A layout (see units.js) is a transform per chart, so the geometry is
 * shared between layouts. Receivers get new geometries (xatlas splits vertices at seams), positions,
 * normals and uvs do not change. A BatchedMesh is unwrapped per geometry.
 */

// NOTE The chart of each vertex ( chart + 1, base, stride ), 0 without a chart. See units.js.
export const CHART_ATTRIBUTE = 'lightmapChart';

// NOTE Self-contained (no outside references), so its source can run in a worker. Plain arrays only.
function unwrapModule() {
  // NOTE Unwraps one mesh: { index, attributes: { name: { array, itemSize, normalized } }, matrix }.
  // Returns the remapped attributes with `lightmapUv` (0..1), the new index and the charts.
  function unwrap(xatlas, mesh) {
    const position = mesh.attributes.position;
    const vertexCount = position.array.length / position.itemSize;
    const index = mesh.index ?? Uint32Array.from({ length: vertexCount }, (v, i) => i);

    if (vertexCount >= 65536)
      throw new Error(
        'EnvironmentShadows: xatlas-web needs meshes with fewer than 65536 vertices.',
      );

    const normal = mesh.attributes.normal;
    const uv = mesh.attributes.uv;

    xatlas.createAtlas();

    const meshInfo = xatlas.createMesh(vertexCount, index.length, true, true);
    xatlas.HEAPU16.set(index, meshInfo.indexOffset / 2);
    xatlas.HEAPF32.set(position.array, meshInfo.positionOffset / 4);
    xatlas.HEAPF32.set(
      normal ? normal.array : new Float32Array(vertexCount * 3),
      meshInfo.normalOffset / 4,
    );
    xatlas.HEAPF32.set(uv ? uv.array : new Float32Array(vertexCount * 2), meshInfo.uvOffset / 4);

    const status = xatlas.addMesh();

    if (status !== 0) {
      xatlas.destroyAtlas();
      throw new Error(`EnvironmentShadows: xatlas could not add a mesh (${status}).`);
    }

    xatlas.generateAtlas();

    const data = xatlas.getMeshData(meshInfo.meshId);
    const newVertexCount = data.newVertexCount;

    const lightmapUv = new Float32Array(
      xatlas.HEAPF32.buffer,
      data.uvOffset,
      newVertexCount * 2,
    ).slice();
    const newIndex = new Uint32Array(
      xatlas.HEAPU32.buffer,
      data.indexOffset,
      data.newIndexCount,
    ).slice();
    const originalIndex = new Uint32Array(
      xatlas.HEAPU32.buffer,
      data.originalIndexOffset,
      newVertexCount,
    ).slice();

    xatlas.destroyAtlas();

    // NOTE Normalize, in case xatlas returns texel units
    let maxU = 0;
    let maxV = 0;

    for (let i = 0; i < newVertexCount; i++) {
      maxU = Math.max(maxU, lightmapUv[i * 2]);
      maxV = Math.max(maxV, lightmapUv[i * 2 + 1]);
    }

    if (maxU > 1.001 || maxV > 1.001) {
      for (let i = 0; i < newVertexCount; i++) {
        lightmapUv[i * 2] /= Math.max(maxU, 1e-6);
        lightmapUv[i * 2 + 1] /= Math.max(maxV, 1e-6);
      }
    }

    const attributes = {};

    for (const name of Object.keys(mesh.attributes)) {
      const { array, itemSize, normalized } = mesh.attributes[name];
      const remapped = new array.constructor(newVertexCount * itemSize);

      for (let i = 0; i < newVertexCount; i++) {
        for (let k = 0; k < itemSize; k++)
          remapped[i * itemSize + k] = array[originalIndex[i] * itemSize + k];
      }

      attributes[name] = { array: remapped, itemSize, normalized };
    }

    attributes.lightmapUv = { array: lightmapUv, itemSize: 2, normalized: false };

    const charts = findCharts(newIndex, attributes.position, lightmapUv, mesh.matrix);

    return { index: newIndex, attributes, charts };
  }

  // NOTE Splits the unwrapped mesh into charts: triangles that share vertices (xatlas splits vertices at chart seams)
  function findCharts(index, position, uv, m) {
    const vertexCount = uv.length / 2;
    const p = position.array;
    const stride = position.itemSize;

    const parent = new Int32Array(vertexCount).map((v, i) => i);
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let t = 0; t < index.length; t += 3) {
      union(index[t], index[t + 1]);
      union(index[t], index[t + 2]);
    }

    // NOTE World position of a vertex, m is a column-major 4x4 matrix
    const world = (v, out) => {
      const x = p[v * stride];
      const y = p[v * stride + 1];
      const z = p[v * stride + 2];

      out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];

      return out;
    };

    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const c = [0, 0, 0];
    const charts = new Map();

    const getChart = (root) => {
      let chart = charts.get(root);

      if (!chart) {
        chart = { vertices: [], triangles: [], worldArea: 0, uvArea: 0 };
        charts.set(root, chart);
      }

      return chart;
    };

    for (let v = 0; v < vertexCount; v++) getChart(find(v)).vertices.push(v);

    for (let t = 0; t < index.length; t += 3) {
      const i0 = index[t];
      const i1 = index[t + 1];
      const i2 = index[t + 2];
      const chart = charts.get(find(i0));

      chart.triangles.push(i0, i1, i2);

      world(i0, a);
      world(i1, b);
      world(i2, c);

      // NOTE Half the length of the cross product of two edges
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];

      chart.worldArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;

      const du1 = uv[i1 * 2] - uv[i0 * 2];
      const dv1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1];
      const du2 = uv[i2 * 2] - uv[i0 * 2];
      const dv2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];

      chart.uvArea += Math.abs(du1 * dv2 - du2 * dv1) / 2;
    }

    // NOTE xatlas can return charts without UV area. They get a planar projection of their world positions.
    for (const chart of charts.values()) {
      if (chart.uvArea > 1e-12 || chart.worldArea <= 0) continue;

      projectChart(chart, world, uv, a, b, c);
    }

    // NOTE Each chart is turned to its smallest bounding rect, its size in meters: one density (texels per meter)
    // gives every chart the same texel size
    return [...charts.values()].map((chart) => {
      const vertices = Uint32Array.from(chart.vertices);
      const metersPerUv = chart.uvArea > 1e-12 ? Math.sqrt(chart.worldArea / chart.uvArea) : 0;
      const { cos, sin, minU, minV, maxU, maxV } = smallestRect(vertices, uv);

      return {
        vertices,
        triangles: Uint32Array.from(chart.triangles),
        worldArea: chart.worldArea,
        metersPerUv,
        cos,
        sin,
        minU,
        minV,
        width: (maxU - minU) * metersPerUv,
        height: (maxV - minV) * metersPerUv,
      };
    });
  }

  // NOTE Projects the chart onto the plane of its largest triangle, sets its uvArea
  function projectChart(chart, world, uv, a, b, c) {
    const { triangles } = chart;
    const normal = [0, 0, 1];
    let largest = -1;

    for (let t = 0; t < triangles.length; t += 3) {
      world(triangles[t], a);
      world(triangles[t + 1], b);
      world(triangles[t + 2], c);

      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);

      if (length > largest) {
        largest = length;
        normal[0] = nx / length;
        normal[1] = ny / length;
        normal[2] = nz / length;
      }
    }

    // NOTE Tangent and bitangent of the plane
    const helper = Math.abs(normal[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
    const tangent = [
      helper[1] * normal[2] - helper[2] * normal[1],
      helper[2] * normal[0] - helper[0] * normal[2],
      helper[0] * normal[1] - helper[1] * normal[0],
    ];
    const tangentLength = Math.hypot(...tangent);

    for (let k = 0; k < 3; k++) tangent[k] /= tangentLength;

    const bitangent = [
      normal[1] * tangent[2] - normal[2] * tangent[1],
      normal[2] * tangent[0] - normal[0] * tangent[2],
      normal[0] * tangent[1] - normal[1] * tangent[0],
    ];

    for (const v of chart.vertices) {
      world(v, a);
      uv[v * 2] = a[0] * tangent[0] + a[1] * tangent[1] + a[2] * tangent[2];
      uv[v * 2 + 1] = a[0] * bitangent[0] + a[1] * bitangent[1] + a[2] * bitangent[2];
    }

    chart.uvArea = 0;

    for (let t = 0; t < triangles.length; t += 3) {
      const i0 = triangles[t];
      const i1 = triangles[t + 1];
      const i2 = triangles[t + 2];
      const du1 = uv[i1 * 2] - uv[i0 * 2];
      const dv1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1];
      const du2 = uv[i2 * 2] - uv[i0 * 2];
      const dv2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];

      chart.uvArea += Math.abs(du1 * dv2 - du2 * dv1) / 2;
    }
  }

  // NOTE Convex hull (monotone chain) of 2D points [ [ x, y ], ... ]
  function convexHull(points) {
    const sorted = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    const upper = [];

    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
        lower.pop();
      lower.push(p);
    }

    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
        upper.pop();
      upper.push(p);
    }

    upper.pop();
    lower.pop();

    return lower.concat(upper);
  }

  // NOTE The rotation with the smallest bounding rect has one side along a hull edge (rotating calipers)
  function smallestRect(vertices, uv) {
    const points = Array.from(vertices, (v) => [uv[v * 2], uv[v * 2 + 1]]);
    const hull = points.length > 2 ? convexHull(points) : points;

    let best = null;

    const tryAngle = (cos, sin) => {
      let minU = Infinity;
      let minV = Infinity;
      let maxU = -Infinity;
      let maxV = -Infinity;

      for (const [x, y] of hull) {
        const u = cos * x + sin * y;
        const w = -sin * x + cos * y;
        minU = Math.min(minU, u);
        minV = Math.min(minV, w);
        maxU = Math.max(maxU, u);
        maxV = Math.max(maxV, w);
      }

      const area = (maxU - minU) * (maxV - minV);

      if (!best || area < best.area - 1e-12) best = { cos, sin, minU, minV, maxU, maxV, area };
    };

    tryAngle(1, 0);

    for (let i = 0; i < hull.length; i++) {
      const [x0, y0] = hull[i];
      const [x1, y1] = hull[(i + 1) % hull.length];
      const length = Math.hypot(x1 - x0, y1 - y0);

      if (length > 1e-12) tryAngle((x1 - x0) / length, (y1 - y0) / length);
    }

    return best;
  }

  // NOTE Unwraps all meshes with one xatlas instance, created from the wasm binary
  async function unwrapAll(createXAtlas, wasm, meshes) {
    const xatlas = createXAtlas({ wasmBinary: wasm });

    await xatlas.ready;

    return meshes.map((mesh) => unwrap(xatlas, mesh));
  }

  return { unwrapAll };
}

// NOTE xatlas-web is a browser build: it expects window and document, and defines a global Module factory
const XATLAS_FACTORY = `globalThis.window ??= globalThis;
  globalThis.document ??= { currentScript: null };
  const createXAtlas = ( function () { ${xatlasSource}
  ; return Module; } )();`;

let wasmPromise = null;

const loadWasm = (url) => {
  wasmPromise ??= fetch(url).then((response) => {
    if (!response.ok) throw new Error(`EnvironmentShadows: Could not load ${url}.`);
    return response.arrayBuffer();
  });

  return wasmPromise;
};

// NOTE Runs the unwrap in a Blob worker, or on this thread where there are no workers
async function runUnwrap(wasmUrl, meshes) {
  // NOTE A copy, the wasm binary is transferred to the worker
  const wasm = (await loadWasm(wasmUrl)).slice(0);

  if (typeof Worker === 'undefined') {
    const { createXAtlas, unwrapAll } = new Function(`${XATLAS_FACTORY}
      return { createXAtlas, unwrapAll: ( ${unwrapModule.toString()} )().unwrapAll };`)();

    return unwrapAll(createXAtlas, wasm, meshes);
  }

  const body = `${XATLAS_FACTORY}
    const { unwrapAll } = ( ${unwrapModule.toString()} )();
    self.onmessage = async ( event ) => {
      try {
        const results = await unwrapAll( createXAtlas, event.data.wasm, event.data.meshes );
        const buffers = [];
        for ( const result of results ) {
          buffers.push( result.index.buffer );
          for ( const attribute of Object.values( result.attributes ) ) buffers.push( attribute.array.buffer );
        }
        self.postMessage( { results }, buffers );
      } catch ( error ) {
        self.postMessage( { error: error.message } );
      }
    };`;

  const url = URL.createObjectURL(new Blob([body], { type: 'application/javascript' }));
  const worker = new Worker(url);

  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event) =>
        event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.results);
      worker.onerror = (event) =>
        reject(new Error(`EnvironmentShadows: Unwrap failed (${event.message}).`));
      worker.postMessage({ wasm, meshes }, [wasm]);
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

// NOTE A plain copy of an attribute, also of interleaved ones
const toArray = (attribute) => {
  const { count, itemSize } = attribute;
  const array = new Float32Array(count * itemSize);

  for (let i = 0; i < count; i++) {
    for (let k = 0; k < itemSize; k++) array[i * itemSize + k] = attribute.getComponent(i, k);
  }

  return array;
};

// NOTE Geometries without charts (casters) get zero lightmap attributes: no place in any layout
function addEmptyAttributes(geometry) {
  const count = geometry.attributes.position.count;

  if (!geometry.attributes.lightmapUv)
    geometry.setAttribute('lightmapUv', new BufferAttribute(new Float32Array(count * 2), 2));

  if (!geometry.attributes[CHART_ATTRIBUTE])
    geometry.setAttribute(CHART_ATTRIBUTE, new BufferAttribute(new Float32Array(count * 3), 3));

  return geometry;
}

// NOTE Plain copy of a geometry for the worker, positions in world space with `matrix`
function toUnwrapInput(geometry, matrix) {
  const attributes = {};

  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name];

    attributes[name] = {
      array: attribute.isInterleavedBufferAttribute ? toArray(attribute) : attribute.array.slice(),
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    };
  }

  return {
    index: geometry.index ? Uint32Array.from(geometry.index.array) : null,
    attributes,
    matrix: Float32Array.from(matrix.elements),
  };
}

// NOTE The worker result as a geometry with the lightmap attributes
function toGeometry({ index, attributes }) {
  const geometry = new BufferGeometry();

  for (const [name, { array, itemSize, normalized }] of Object.entries(attributes)) {
    geometry.setAttribute(name, new BufferAttribute(array, itemSize, normalized));
  }

  geometry.setIndex(new BufferAttribute(index, 1));
  addEmptyAttributes(geometry);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return geometry;
}

/**
 * Unwraps the receivers once, in a worker. Receivers get new geometries with `lightmapUv` and `lightmapChart`,
 * casters get zero lightmap attributes.
 *
 * @param {Array<Mesh>} receivers - Meshes that get a place in the lightmap.
 * @param {Array<Mesh>} casters - Meshes that only cast shadows.
 * @param {string} wasmUrl - URL of xatlas-web.wasm.
 */
export async function unwrapMeshes(receivers, casters, wasmUrl) {
  for (const mesh of casters) {
    if (!mesh.isBatchedMesh) {
      addEmptyAttributes(mesh.geometry);
      continue;
    }

    if (mesh.userData.environmentShadowBatch) continue;

    const geometries = new Map();

    for (const id of getGeometryIds(mesh)) {
      geometries.set(id, { geometry: addEmptyAttributes(extractGeometry(mesh, id)), charts: [] });
    }

    mesh.userData.environmentShadowBatch = { receives: false, geometries };
  }

  // NOTE One job per geometry: the worker input and the result handler. Charts go to userData, see units.js.
  const jobs = [];

  for (const mesh of receivers) {
    mesh.updateMatrixWorld();

    if (mesh.isBatchedMesh) {
      if (mesh.userData.environmentShadowBatch?.receives) continue;

      const geometries = new Map();

      mesh.userData.environmentShadowBatch = { receives: true, geometries };

      for (const id of getGeometryIds(mesh)) {
        jobs.push({
          input: toUnwrapInput(extractGeometry(mesh, id), mesh.matrixWorld),
          done: (geometry, charts) => geometries.set(id, { geometry, charts }),
        });
      }

      continue;
    }

    if (mesh.userData.environmentShadowCharts) continue;

    jobs.push({
      input: toUnwrapInput(mesh.geometry, mesh.matrixWorld),
      done: (geometry, charts) => {
        mesh.userData.environmentShadowCharts = charts;
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      },
    });
  }

  if (jobs.length === 0) return;

  const results = await runUnwrap(
    wasmUrl,
    jobs.map((job) => job.input),
  );

  jobs.forEach((job, i) => job.done(toGeometry(results[i]), results[i].charts));

  for (const mesh of receivers) {
    const batch = mesh.userData.environmentShadowBatch;

    if (!mesh.isBatchedMesh || batch.applied) continue;

    // NOTE In the batch, the chart attribute reads the base from the table (stride -1), see units.js
    for (const { geometry, charts } of batch.geometries.values()) {
      const chart = geometry.attributes[CHART_ATTRIBUTE];

      charts.forEach((c, k) => {
        for (const v of c.vertices) chart.setXYZ(v, k + 1, 0, -1);
      });
    }

    setUnwrappedGeometries(
      mesh,
      new Map([...batch.geometries].map(([id, { geometry }]) => [id, geometry])),
    );
    batch.applied = true;
  }
}
