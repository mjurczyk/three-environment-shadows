import { Vector3, WebGPUCoordinateSystem } from 'three';

/**
 * Charts seen by the camera. Rays through a grid of screen points hit a BVH of all meshes in world space.
 * The chart of each hit triangle is visible. The hit count of a chart is its screen coverage.
 * The rays run in Blob workers, or on this thread where there are no workers.
 */

const _vector = /*@__PURE__*/ new Vector3();

// NOTE Workers for the visibility rays, each one casts some rows of the grid
const WORKER_COUNT =
  typeof Worker === 'undefined'
    ? 0
    : Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));

// NOTE Self-contained (no outside references), so its source can run in a worker. Plain arrays only.
function visibilityModule() {
  // NOTE Triangles per BVH leaf
  const LEAF_SIZE = 4;

  let local = null;
  let index = null;
  let vertexMesh = null;
  let vertexChart = null;
  let chartCounts = null;
  let positions = null;

  // NOTE BVH nodes in depth-first order: the left child of an inner node is the next node. nodeFirst is the
  // right child of an inner node (nodeCount 0) or the first entry in `order` of a leaf.
  let order = null;
  let nodeBounds = null;
  let nodeFirst = null;
  let nodeCount = null;
  let nodeTotal = 0;

  const stack = new Int32Array(1024);
  const near = [0, 0, 0];
  const far = [0, 0, 0];

  // NOTE World positions: the local position of each vertex times the matrix of its mesh (column-major)
  function transform(matrices) {
    for (let v = 0; v < vertexMesh.length; v++) {
      const m = vertexMesh[v] * 16;
      const x = local[v * 3];
      const y = local[v * 3 + 1];
      const z = local[v * 3 + 2];

      positions[v * 3] =
        matrices[m] * x + matrices[m + 4] * y + matrices[m + 8] * z + matrices[m + 12];
      positions[v * 3 + 1] =
        matrices[m + 1] * x + matrices[m + 5] * y + matrices[m + 9] * z + matrices[m + 13];
      positions[v * 3 + 2] =
        matrices[m + 2] * x + matrices[m + 6] * y + matrices[m + 10] * z + matrices[m + 14];
    }
  }

  // NOTE Midpoint split of the centroid bounds along the longest axis, half split where that fails
  function build() {
    const triangleCount = index.length / 3;
    const centroids = new Float32Array(triangleCount * 3);

    for (let t = 0; t < triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        centroids[t * 3 + k] =
          (positions[index[t * 3] * 3 + k] +
            positions[index[t * 3 + 1] * 3 + k] +
            positions[index[t * 3 + 2] * 3 + k]) /
          3;
      }
    }

    order = new Uint32Array(triangleCount);

    for (let t = 0; t < triangleCount; t++) order[t] = t;

    const maxNodes = Math.max(1, 2 * triangleCount);

    nodeBounds = new Float32Array(maxNodes * 6);
    nodeFirst = new Int32Array(maxNodes);
    nodeCount = new Int32Array(maxNodes);
    nodeTotal = 0;

    // NOTE Entries: parent, is right child, start, end. The left child is pushed last, so it is the next node.
    const pending = [-1, 0, 0, triangleCount];

    while (pending.length > 0) {
      const end = pending.pop();
      const start = pending.pop();
      const right = pending.pop();
      const parent = pending.pop();
      const node = nodeTotal++;

      if (right) nodeFirst[parent] = node;

      if (end - start <= LEAF_SIZE) {
        nodeFirst[node] = start;
        nodeCount[node] = end - start;
        continue;
      }

      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;

      for (let i = start; i < end; i++) {
        const c = order[i] * 3;

        minX = Math.min(minX, centroids[c]);
        minY = Math.min(minY, centroids[c + 1]);
        minZ = Math.min(minZ, centroids[c + 2]);
        maxX = Math.max(maxX, centroids[c]);
        maxY = Math.max(maxY, centroids[c + 1]);
        maxZ = Math.max(maxZ, centroids[c + 2]);
      }

      const extentX = maxX - minX;
      const extentY = maxY - minY;
      const extentZ = maxZ - minZ;
      const axis = extentX >= extentY && extentX >= extentZ ? 0 : extentY >= extentZ ? 1 : 2;
      const split =
        axis === 0 ? (minX + maxX) / 2 : axis === 1 ? (minY + maxY) / 2 : (minZ + maxZ) / 2;

      let i = start;
      let j = end - 1;

      while (i <= j) {
        if (centroids[order[i] * 3 + axis] < split) {
          i++;
        } else {
          const swap = order[i];
          order[i] = order[j];
          order[j] = swap;
          j--;
        }
      }

      const middle = i === start || i === end ? (start + end) >> 1 : i;

      nodeCount[node] = 0;
      pending.push(node, 1, middle, end, node, 0, start, middle);
    }

    refitBounds();
  }

  // NOTE Children come after their parent, so a reverse pass has the children ready
  function refitBounds() {
    for (let n = nodeTotal - 1; n >= 0; n--) {
      const b = n * 6;

      if (nodeCount[n] > 0) {
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        for (let i = nodeFirst[n]; i < nodeFirst[n] + nodeCount[n]; i++) {
          for (let k = 0; k < 3; k++) {
            const p = index[order[i] * 3 + k] * 3;

            minX = Math.min(minX, positions[p]);
            minY = Math.min(minY, positions[p + 1]);
            minZ = Math.min(minZ, positions[p + 2]);
            maxX = Math.max(maxX, positions[p]);
            maxY = Math.max(maxY, positions[p + 1]);
            maxZ = Math.max(maxZ, positions[p + 2]);
          }
        }

        nodeBounds[b] = minX;
        nodeBounds[b + 1] = minY;
        nodeBounds[b + 2] = minZ;
        nodeBounds[b + 3] = maxX;
        nodeBounds[b + 4] = maxY;
        nodeBounds[b + 5] = maxZ;
      } else {
        const l = (n + 1) * 6;
        const r = nodeFirst[n] * 6;

        for (let k = 0; k < 3; k++) {
          nodeBounds[b + k] = Math.min(nodeBounds[l + k], nodeBounds[r + k]);
          nodeBounds[b + 3 + k] = Math.max(nodeBounds[l + 3 + k], nodeBounds[r + 3 + k]);
        }
      }
    }
  }

  // NOTE Distance to the box of a node along the ray, Infinity on a miss or beyond `best`
  function slab(n, ox, oy, oz, ix, iy, iz, best) {
    const b = n * 6;
    const x1 = (nodeBounds[b] - ox) * ix;
    const x2 = (nodeBounds[b + 3] - ox) * ix;
    const y1 = (nodeBounds[b + 1] - oy) * iy;
    const y2 = (nodeBounds[b + 4] - oy) * iy;
    const z1 = (nodeBounds[b + 2] - oz) * iz;
    const z2 = (nodeBounds[b + 5] - oz) * iz;
    const enter = Math.max(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2), 0);
    const exit = Math.min(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));

    return exit < enter || enter > best ? Infinity : enter;
  }

  // NOTE The nearest triangle hit by the ray (both sides), or -1
  function raycast(ox, oy, oz, dx, dy, dz) {
    const ix = 1 / (dx || 1e-30);
    const iy = 1 / (dy || 1e-30);
    const iz = 1 / (dz || 1e-30);

    let best = Infinity;
    let hit = -1;
    let top = 0;

    if (nodeTotal === 0) return -1;

    stack[top++] = 0;

    while (top > 0) {
      const n = stack[--top];

      if (slab(n, ox, oy, oz, ix, iy, iz, best) === Infinity) continue;

      if (nodeCount[n] > 0) {
        for (let i = nodeFirst[n]; i < nodeFirst[n] + nodeCount[n]; i++) {
          const t = order[i];
          const a = index[t * 3] * 3;
          const b = index[t * 3 + 1] * 3;
          const c = index[t * 3 + 2] * 3;

          // NOTE Moller-Trumbore
          const e1x = positions[b] - positions[a];
          const e1y = positions[b + 1] - positions[a + 1];
          const e1z = positions[b + 2] - positions[a + 2];
          const e2x = positions[c] - positions[a];
          const e2y = positions[c + 1] - positions[a + 1];
          const e2z = positions[c + 2] - positions[a + 2];
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;

          if (Math.abs(det) < 1e-12) continue;

          const inv = 1 / det;
          const sx = ox - positions[a];
          const sy = oy - positions[a + 1];
          const sz = oz - positions[a + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;

          if (u < 0 || u > 1) continue;

          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;

          if (v < 0 || u + v > 1) continue;

          const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;

          if (distance > 1e-7 && distance < best) {
            best = distance;
            hit = t;
          }
        }

        continue;
      }

      // NOTE The nearer child is tested first: pushed last
      const l = n + 1;
      const r = nodeFirst[n];
      const tl = slab(l, ox, oy, oz, ix, iy, iz, best);
      const tr = slab(r, ox, oy, oz, ix, iy, iz, best);

      if (tl <= tr) {
        if (tr !== Infinity) stack[top++] = r;
        if (tl !== Infinity) stack[top++] = l;
      } else {
        if (tl !== Infinity) stack[top++] = l;
        if (tr !== Infinity) stack[top++] = r;
      }
    }

    return hit;
  }

  // NOTE Clip space point to world space: inverse projection, perspective divide, camera matrix
  function unproject(x, y, z, camera, out) {
    const p = camera.projectionMatrixInverse;
    const w = camera.matrixWorld;
    const d = p[3] * x + p[7] * y + p[11] * z + p[15];
    const vx = (p[0] * x + p[4] * y + p[8] * z + p[12]) / d;
    const vy = (p[1] * x + p[5] * y + p[9] * z + p[13]) / d;
    const vz = (p[2] * x + p[6] * y + p[10] * z + p[14]) / d;

    out[0] = w[0] * vx + w[4] * vy + w[8] * vz + w[12];
    out[1] = w[1] * vx + w[5] * vy + w[9] * vz + w[13];
    out[2] = w[2] * vx + w[6] * vy + w[10] * vz + w[14];

    return out;
  }

  return {
    // NOTE data: local, index, vertexMesh, vertexChart, chartCounts, matrices
    init(data) {
      local = data.local;
      index = data.index;
      vertexMesh = data.vertexMesh;
      vertexChart = data.vertexChart;
      chartCounts = data.chartCounts;
      positions = new Float32Array(local.length);

      transform(data.matrices);
      build();
    },

    // NOTE Moved meshes keep their triangles, new bounds are enough
    refit(matrices) {
      transform(matrices);
      refitBounds();
    },

    // NOTE Every stride-th row from offset of a width x height grid. Returns the hit count per chart and mesh.
    cast(camera, width, height, offset, stride) {
      const masks = chartCounts.map((count) => new Uint32Array(count));

      for (let y = offset; y < height; y += stride) {
        for (let x = 0; x < width; x++) {
          const nx = ((x + 0.5) / width) * 2 - 1;
          const ny = ((y + 0.5) / height) * 2 - 1;

          unproject(nx, ny, camera.zNear, camera, near);
          unproject(nx, ny, 1, camera, far);

          const dx = far[0] - near[0];
          const dy = far[1] - near[1];
          const dz = far[2] - near[2];
          const length = Math.hypot(dx, dy, dz) || 1;
          const t = raycast(near[0], near[1], near[2], dx / length, dy / length, dz / length);

          if (t < 0) continue;

          const a = index[t * 3];
          const chart = vertexChart[a];

          if (chart >= 0) masks[vertexMesh[a]][chart]++;
        }
      }

      return masks;
    },
  };
}

/**
 * Visibility test of the charts of the meshes, see visibilityModule.
 *
 * @private
 */
export function createVisibility(meshes) {
  const chartCounts = meshes.map((mesh) => (mesh.userData.environmentShadowCharts ?? []).length);

  let vertexCount = 0;
  let indexCount = 0;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;

    vertexCount += geometry.attributes.position.count;
    indexCount += geometry.index ? geometry.index.count : geometry.attributes.position.count;
  }

  // NOTE Merged geometry in local space, the mesh and chart of each vertex
  const local = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);
  const vertexMesh = new Int32Array(vertexCount);
  const vertexChart = new Int32Array(vertexCount).fill(-1);

  let vertexOffset = 0;
  let indexOffset = 0;

  meshes.forEach((mesh, meshIndex) => {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const count = position.count;

    vertexMesh.fill(meshIndex, vertexOffset, vertexOffset + count);

    for (let v = 0; v < count; v++) {
      _vector.fromBufferAttribute(position, v).toArray(local, (vertexOffset + v) * 3);
    }

    (mesh.userData.environmentShadowCharts ?? []).forEach((chart, c) => {
      for (const v of chart.vertices) vertexChart[vertexOffset + v] = c;
    });

    if (geometry.index) {
      const source = geometry.index.array;

      for (let i = 0; i < source.length; i++) index[indexOffset + i] = source[i] + vertexOffset;

      indexOffset += source.length;
    } else {
      for (let i = 0; i < count; i++) index[indexOffset + i] = i + vertexOffset;

      indexOffset += count;
    }

    vertexOffset += count;
  });

  // NOTE The world matrices of the meshes, the BVH transforms the local positions with them
  const matrices = new Float32Array(meshes.length * 16);
  const readMatrices = () =>
    meshes.forEach((mesh, i) => mesh.matrixWorld.toArray(matrices, i * 16));

  readMatrices();

  const data = { local, index, vertexMesh, vertexChart, chartCounts, matrices };
  const workers = [];
  const pending = new Map();
  let url = null;
  let inline = null;
  let generation = 0;

  if (WORKER_COUNT > 0) {
    const body = `const visibility = ( ${visibilityModule.toString()} )();
      self.onmessage = ( event ) => {
        const message = event.data;
        if ( message.type === 'init' ) { visibility.init( message.data ); return; }
        if ( message.type === 'refit' ) { visibility.refit( message.matrices ); return; }
        const masks = visibility.cast( message.camera, message.width, message.height, message.offset, message.stride );
        self.postMessage( { id: message.id, masks }, masks.map( ( mask ) => mask.buffer ) );
      };`;

    url = URL.createObjectURL(new Blob([body], { type: 'application/javascript' }));

    for (let k = 0; k < WORKER_COUNT; k++) {
      const worker = new Worker(url);

      worker.onmessage = (event) => pending.get(event.data.id)?.(event.data.masks);

      // NOTE Without workers the rays run on this thread, the running test resolves null
      worker.onerror = () => {
        console.warn('EnvironmentShadows: visibility worker failed, rays run on the main thread.');

        for (const w of workers) w.terminate();

        workers.length = 0;

        for (const resolve of [...pending.values()]) resolve(null);
      };

      worker.postMessage({ type: 'init', data });
      workers.push(worker);
    }
  }

  return {
    // NOTE Set when meshes moved: the next test refits the BVH bounds, the triangles stay
    needsRebuild: false,

    /**
     * Tests `resolution` x `resolution / aspect` rays. The view is wider by `margin` (percent).
     * Resolves per mesh a Uint32Array with the hit count of each chart, or null when cancelled.
     */
    request(camera, resolution, margin) {
      const id = ++generation;
      const view = camera.clone();

      view.zoom = camera.zoom / (1 + margin / 100);
      view.updateProjectionMatrix();
      view.updateMatrixWorld();

      const width = Math.max(1, Math.round(resolution));
      const height = Math.max(1, Math.round(resolution / (camera.aspect ?? 1)));
      const cameraData = {
        // NOTE The near plane is at clip z 0 in WebGPU, -1 in WebGL
        zNear: view.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1,
        matrixWorld: view.matrixWorld.toArray(),
        projectionMatrixInverse: view.projectionMatrixInverse.toArray(),
      };

      if (this.needsRebuild) {
        readMatrices();

        for (const worker of workers) worker.postMessage({ type: 'refit', matrices });

        inline?.refit(matrices);

        this.needsRebuild = false;
      }

      if (workers.length === 0) {
        if (inline === null) {
          inline = visibilityModule();
          inline.init(data);
        }

        return Promise.resolve(inline.cast(cameraData, width, height, 0, 1));
      }

      const parts = workers.map(
        (worker, k) =>
          new Promise((resolve) => {
            const partId = `${id}:${k}`;

            pending.set(partId, (masks) => {
              pending.delete(partId);
              resolve(masks);
            });
            worker.postMessage({
              type: 'test',
              id: partId,
              width,
              height,
              offset: k,
              stride: workers.length,
              camera: cameraData,
            });
          }),
      );

      return Promise.all(parts).then((results) => {
        if (id !== generation || results.includes(null)) return null;

        const masks = results[0];

        for (let k = 1; k < results.length; k++) {
          masks.forEach((mask, i) => {
            const other = results[k][i];

            for (let c = 0; c < mask.length; c++) mask[c] += other[c];
          });
        }

        return masks;
      });
    },

    // NOTE The running test resolves null
    cancel() {
      generation++;
    },

    dispose() {
      generation++;

      for (const worker of workers) worker.terminate();

      if (url !== null) URL.revokeObjectURL(url);

      pending.clear();
    },
  };
}
