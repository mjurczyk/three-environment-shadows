import * as THREE from 'three';
import XAtlas from 'xatlas-web';
import wasmUrl from 'xatlas-web/dist/xatlas-web.wasm?url';

/**
 * Gives every mesh a `lightmapUv` attribute with a unique place in one shared atlas.
 *
 * Each mesh is unwrapped on its own with xatlas (charts packed into 0..1), then the per-mesh squares
 * are packed into the atlas with a size proportional to the surface area of the mesh. The meshes get
 * new geometries (xatlas splits vertices at seams), positions, normals and uvs do not change.
 */

let modulePromise = null;

const loadXAtlas = () => {
  modulePromise ??= new Promise((resolve, reject) => {
    const module = XAtlas({ locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path) });
    module.ready.then(() => resolve(module), reject);
  });

  return modulePromise;
};

function surfaceArea(geometry, matrix) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const triangle = new THREE.Triangle();
  const count = index ? index.count : position.count;

  let area = 0;

  for (let i = 0; i < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;

    a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
    b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
    c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

    area += triangle.set(a, b, c).getArea();
  }

  return area;
}

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

// NOTE Shelf packing of squares into the unit square, returns { x, y, size } per item or null if it does not fit
function pack(sides, padding) {
  const order = sides.map((side, i) => i).sort((a, b) => sides[b] - sides[a]);
  const rects = new Array(sides.length);

  let x = padding;
  let y = padding;
  let shelf = 0;

  for (const i of order) {
    const side = sides[i];

    if (x + side + padding > 1) {
      x = padding;
      y += shelf + padding;
      shelf = 0;
    }

    if (y + side + padding > 1) return null;

    rects[i] = { x, y, size: side };
    x += side + padding;
    shelf = Math.max(shelf, side);
  }

  return rects;
}

/**
 * Unwraps the meshes once (cached on the meshes), returns { meshes, rects }.
 */
export async function createLightmapLayout(meshes, atlasSize) {
  if (meshes.every((mesh) => mesh.geometry.attributes.lightmapUv)) return { meshes };

  const xatlas = await loadXAtlas();

  const areas = meshes.map((mesh) => {
    mesh.updateMatrixWorld();
    return surfaceArea(mesh.geometry, mesh.matrixWorld);
  });

  const total = areas.reduce((sum, area) => sum + area, 0);
  const padding = 4 / atlasSize;

  // NOTE Shrink until all squares fit
  let scale = 1;
  let rects = null;

  while (rects === null && scale > 0.05) {
    rects = pack(
      areas.map((area) => Math.sqrt(area / total) * scale),
      padding,
    );
    scale *= 0.95;
  }

  meshes.forEach((mesh, i) => {
    const geometry = unwrap(xatlas, mesh.geometry);
    const uv = geometry.attributes.lightmapUv;
    const { x, y, size } = rects[i];

    // NOTE Keep a texel of margin inside each square
    const inner = Math.max(size - 2 * padding, size * 0.5);

    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, x + padding + uv.getX(k) * inner, y + padding + uv.getY(k) * inner);
    }

    mesh.geometry.dispose();
    mesh.geometry = geometry;
  });

  return { meshes, rects };
}
