import { BufferAttribute, BufferGeometry } from 'three';

/**
 * BatchedMesh helpers. Unwrapped geometries are larger, three.js cannot grow their reserved space, so the ranges
 * are packed again with internal `_geometryInfo` (r170+).
 *
 * @private
 */

// NOTE The attributes the unwrap adds to the batched geometry, with their item sizes
const LIGHTMAP_ATTRIBUTES = { lightmapUv: 2, lightmapChart: 3 };

/** Whether this three.js version has the BatchedMesh internals the helpers need. */
export function isBatchedSupported(batched) {
  return (
    typeof batched.setGeometrySize === 'function' &&
    typeof batched.getGeometryRangeAt === 'function' &&
    Array.isArray(batched._geometryInfo) &&
    Array.isArray(batched._instanceInfo)
  );
}

/** Ids of the geometries that are not deleted. */
export function getGeometryIds(batched) {
  const ids = [];

  batched._geometryInfo.forEach((info, id) => info.active && ids.push(id));

  return ids;
}

/** Ids of the instances that are not deleted, per geometry id. */
export function getInstanceIds(batched) {
  const instances = new Map();

  batched._instanceInfo.forEach((info, id) => {
    if (!info.active) return;

    const geometryId = batched.getGeometryIdAt(id);

    if (!instances.has(geometryId)) instances.set(geometryId, []);

    instances.get(geometryId).push(id);
  });

  return instances;
}

/** Number of instance ids, deleted ones included. */
export const getInstanceIdCount = (batched) => batched._instanceInfo.length;

/** Whether the instance exists and is visible. */
export function isInstanceVisible(batched, id) {
  const info = batched._instanceInfo[id];

  return info !== undefined && info.active && info.visible;
}

/** A standalone copy of one geometry of the batch. */
export function extractGeometry(batched, geometryId) {
  const source = batched.geometry;
  const { vertexStart, vertexCount, indexStart, indexCount } =
    batched.getGeometryRangeAt(geometryId);
  const geometry = new BufferGeometry();

  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (name in LIGHTMAP_ATTRIBUTES) continue;

    const { itemSize, normalized } = attribute;
    const array = attribute.array.slice(
      vertexStart * itemSize,
      (vertexStart + vertexCount) * itemSize,
    );

    geometry.setAttribute(name, new BufferAttribute(array, itemSize, normalized));
  }

  if (source.index) {
    const index = new Uint32Array(indexCount);

    for (let i = 0; i < indexCount; i++)
      index[i] = source.index.array[indexStart + i] - vertexStart;

    geometry.setIndex(new BufferAttribute(index, 1));
  }

  return geometry;
}

/**
 * Replaces the batch geometries with the unwrapped ones (geometry id to geometry), ranges packed one after the other.
 */
export function setUnwrappedGeometries(batched, geometries) {
  const indexed = batched.geometry.index !== null;
  const display = new Map();

  for (const [id, geometry] of geometries) {
    // NOTE xatlas output is indexed, a batch without index needs plain triangles
    display.set(id, indexed ? geometry : geometry.toNonIndexed());
  }

  // NOTE setGeometrySize copies the attributes of the old geometry, so it has the new ones too
  const old = batched.geometry;

  for (const [name, itemSize] of Object.entries(LIGHTMAP_ATTRIBUTES)) {
    if (!old.attributes[name])
      old.setAttribute(
        name,
        new BufferAttribute(new Float32Array(old.attributes.position.count * itemSize), itemSize),
      );
  }

  let vertexStart = 0;
  let indexStart = 0;

  batched._geometryInfo.forEach((info, id) => {
    const geometry = display.get(id);
    const vertexCount = info.active && geometry ? geometry.attributes.position.count : 0;
    const indexCount = info.active && geometry && indexed ? geometry.index.count : 0;

    info.vertexStart = vertexStart;
    info.reservedVertexCount = vertexCount;
    info.indexStart = indexed ? indexStart : -1;
    info.reservedIndexCount = indexed ? indexCount : -1;

    vertexStart += vertexCount;
    indexStart += indexCount;
  });

  batched._nextVertexStart = vertexStart;
  batched._nextIndexStart = indexStart;
  batched.setGeometrySize(Math.max(1, vertexStart), Math.max(1, indexStart));

  for (const [id, geometry] of display) batched.setGeometryAt(id, geometry);

  // NOTE The bounds of the batch follow the new geometries
  batched.boundingBox = null;
  batched.boundingSphere = null;
}
