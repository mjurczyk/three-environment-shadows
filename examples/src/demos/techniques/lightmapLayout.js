import * as THREE from 'three';
import XAtlas from 'xatlas-web';
import wasmUrl from 'xatlas-web/dist/xatlas-web.wasm?url';
import { NO_PLACE, packCharts } from './atlasPacker.js';

/**
 * Lightmap atlas layouts, packed per chart.
 *
 * Each mesh is unwrapped once with xatlas. The result is split into charts (connected UV islands),
 * each turned to its smallest bounding rect. A layout packs the charts of the selected meshes into the
 * atlas (see atlasPacker.js), in a worker. A layout is a per-vertex UV, so the geometry is shared
 * between layouts. The meshes get new geometries (xatlas splits vertices at seams), positions, normals
 * and uvs do not change.
 */

let modulePromise = null;

const loadXAtlas = () => {
  modulePromise ??= new Promise((resolve, reject) => {
    const module = XAtlas({ locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path) });
    module.ready.then(() => resolve(module), reject);
  });

  return modulePromise;
};

// NOTE Unwraps one geometry, returns a new geometry with `lightmapUv` in 0..1
function unwrap(xatlas, source) {
  let geometry = source;

  if (!geometry.index) {
    geometry = geometry.clone();
    geometry.setIndex([...Array(geometry.attributes.position.count).keys()]);
  }

  const vertexCount = geometry.attributes.position.count;
  const indexCount = geometry.index.count;

  if (vertexCount >= 65536) throw new Error('lightmapLayout: xatlas-web needs 16-bit indices');

  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = geometry.attributes.uv;

  xatlas.createAtlas();

  const meshInfo = xatlas.createMesh(vertexCount, indexCount, true, true);
  xatlas.HEAPU16.set(geometry.index.array, meshInfo.indexOffset / 2);
  xatlas.HEAPF32.set(positions.array, meshInfo.positionOffset / 4);
  xatlas.HEAPF32.set(normals.array, meshInfo.normalOffset / 4);
  xatlas.HEAPF32.set(uvs ? uvs.array : new Float32Array(vertexCount * 2), meshInfo.uvOffset / 4);

  const status = xatlas.addMesh();

  if (status !== 0) {
    xatlas.destroyAtlas();
    throw new Error(`lightmapLayout: xatlas addMesh failed (${status})`);
  }

  xatlas.generateAtlas();

  const data = xatlas.getMeshData(meshInfo.meshId);
  const newVertexCount = data.newVertexCount;

  const atlasUv = new Float32Array(xatlas.HEAPF32.buffer, data.uvOffset, newVertexCount * 2).slice();
  const newIndex = new Uint32Array(xatlas.HEAPU32.buffer, data.indexOffset, data.newIndexCount).slice();
  const originalIndex = new Uint32Array(xatlas.HEAPU32.buffer, data.originalIndexOffset, newVertexCount).slice();

  xatlas.destroyAtlas();

  // NOTE Normalize, in case xatlas returns texel units
  let maxU = 0;
  let maxV = 0;

  for (let i = 0; i < newVertexCount; i++) {
    maxU = Math.max(maxU, atlasUv[i * 2]);
    maxV = Math.max(maxV, atlasUv[i * 2 + 1]);
  }

  if (maxU > 1.001 || maxV > 1.001) {
    for (let i = 0; i < newVertexCount; i++) {
      atlasUv[i * 2] /= Math.max(maxU, 1e-6);
      atlasUv[i * 2 + 1] /= Math.max(maxV, 1e-6);
    }
  }

  const result = new THREE.BufferGeometry();

  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name];
    const itemSize = attribute.itemSize;
    const array = new attribute.array.constructor(newVertexCount * itemSize);

    for (let i = 0; i < newVertexCount; i++) {
      for (let k = 0; k < itemSize; k++) array[i * itemSize + k] = attribute.array[originalIndex[i] * itemSize + k];
    }

    result.setAttribute(name, new THREE.BufferAttribute(array, itemSize, attribute.normalized));
  }

  result.setAttribute('lightmapUv', new THREE.BufferAttribute(atlasUv, 2));
  result.setIndex(new THREE.BufferAttribute(newIndex, 1));

  return result;
}

// NOTE The atlas UV of a mesh per layout, x < 0 when the mesh has no place in that layout
export const UV_ATTRIBUTES = ['lightmapUvBake', 'lightmapUvFront', 'lightmapUvPrevious'];


// NOTE Splits the unwrapped geometry into charts: triangles that share vertices (xatlas splits vertices at chart seams)
function findCharts(geometry, matrix) {
  const index = geometry.index.array;
  const position = geometry.attributes.position;
  const uv = geometry.attributes.lightmapUv;
  const vertexCount = position.count;

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

  const charts = new Map();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const triangle = new THREE.Triangle();

  const getChart = (root) => {
    let chart = charts.get(root);

    if (!chart) {
      chart = { vertices: [], triangles: [], worldArea: 0, uvArea: 0 };
      charts.set(root, chart);
    }

    return chart;
  };

  for (let v = 0; v < vertexCount; v++) {
    getChart(find(v)).vertices.push(v);
  }

  for (let t = 0; t < index.length; t += 3) {
    const i0 = index[t];
    const i1 = index[t + 1];
    const i2 = index[t + 2];
    const chart = charts.get(find(i0));

    chart.triangles.push(i0, i1, i2);

    a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
    b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
    c.fromBufferAttribute(position, i2).applyMatrix4(matrix);
    chart.worldArea += triangle.set(a, b, c).getArea();

    const du1 = uv.getX(i1) - uv.getX(i0);
    const dv1 = uv.getY(i1) - uv.getY(i0);
    const du2 = uv.getX(i2) - uv.getX(i0);
    const dv2 = uv.getY(i2) - uv.getY(i0);
    chart.uvArea += Math.abs(du1 * dv2 - du2 * dv1) / 2;
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

// NOTE Convex hull (monotone chain) of 2D points [ [ x, y ], ... ]
function convexHull(points) {
  const sorted = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  const upper = [];

  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }

  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }

  upper.pop();
  lower.pop();

  return lower.concat(upper);
}

// NOTE The rotation with the smallest bounding rect has one side along a hull edge (rotating calipers)
function smallestRect(vertices, uv) {
  const points = Array.from(vertices, (v) => [uv.getX(v), uv.getY(v)]);
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

/**
 * Unwraps the meshes once (cached on the meshes). Each mesh gets `lightmapUv` (xatlas charts in 0..1),
 * the layout attributes (see UV_ATTRIBUTES) and `userData.lightmapCharts`.
 */
export async function createLightmapLayout(meshes) {
  if (meshes.every((mesh) => mesh.userData.lightmapCharts)) return;

  const xatlas = await loadXAtlas();

  for (const mesh of meshes) {
    mesh.updateMatrixWorld();

    const geometry = unwrap(xatlas, mesh.geometry);
    const count = geometry.attributes.position.count;

    for (const name of UV_ATTRIBUTES) {
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * 2).fill(NO_PLACE), 2));
    }

    geometry.computeBoundingSphere();

    mesh.userData.lightmapCharts = findCharts(geometry, mesh.matrixWorld);

    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }
}

/** Writes a layout into one of the UV attributes of every mesh. */
export function setLayout(meshes, name, layout) {
  meshes.forEach((mesh, i) => {
    const attribute = mesh.geometry.attributes[name];

    if (layout[i]) attribute.array.set(layout[i]);
    else attribute.array.fill(NO_PLACE);

    attribute.needsUpdate = true;
  });
}

/**
 * Packs layouts in a worker, so the main thread does not stop (a pack takes ~100 ms).
 * pack( visible, atlasSize ) resolves with one Float32Array (atlas UVs) or null per mesh.
 */
export function createPacker(meshes) {
  const meshData = meshes.map((mesh) => ({
    charts: mesh.userData.lightmapCharts,
    uv: mesh.geometry.attributes.lightmapUv.array.slice(),
    vertexCount: mesh.geometry.attributes.position.count,
  }));

  let worker = null;

  try {
    worker = new Worker(new URL('./layoutWorker.js', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'init', meshData });
  } catch (error) {
    console.warn('lightmapLayout: no worker, packing on the main thread', error);
  }

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
    pack(visible, atlasSize) {
      if (!worker) return Promise.resolve(packCharts(meshData, visible, atlasSize));

      const id = nextId++;

      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ type: 'pack', id, visible, atlasSize });
      });
    },

    dispose() {
      worker?.terminate();
      pending.clear();
    },
  };
}
