import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import { ENTRY_SIZE, emptyLayout } from './packer.js';
import { CHART_ATTRIBUTE } from './unwrap.js';
import { getInstanceIdCount, getInstanceIds, isInstanceVisible } from './batched.js';

/**
 * Units and layout textures. A unit is a Mesh, or one instance of an InstancedMesh or BatchedMesh,
 * with its own atlas place.
 *
 * @private
 */

// NOTE Texels per row of a layout texture, even: both texels of an entry are in one row
export const LAYOUT_WIDTH = 1024;

// NOTE lightmapChart ( chart + 1, base, stride ) finds the entry of a vertex: base + instance * stride + chart
function setChartAttribute(geometry, charts, base, stride) {
  const attribute = geometry.attributes[CHART_ATTRIBUTE];

  charts.forEach((chart, c) => {
    for (const v of chart.vertices) attribute.setXYZ(v, c + 1, base, stride);
  });

  attribute.needsUpdate = true;
}

/**
 * Creates the units of the unwrapped meshes.
 *
 * @param {Array<Mesh>} meshes - Meshes, InstancedMeshes and BatchedMeshes.
 * @return {Object} geometries, units, bake proxies, transform entry count and the table.
 */
export function createUnits(meshes) {
  const geometries = [];
  const units = [];
  const proxies = [];
  let entryCount = 0;

  const addGeometry = (geometry, charts) =>
    geometries.push({
      charts,
      uv: geometry.attributes.lightmapUv?.array.slice() ?? new Float32Array(0),
      geometry,
    }) - 1;

  // NOTE Batched meshes that receive, their table comes after all transforms
  const tables = [];

  meshes.forEach((mesh, m) => {
    if (!mesh.isBatchedMesh) {
      const charts = mesh.userData.environmentShadowCharts ?? [];
      const g = addGeometry(mesh.geometry, charts);
      const count = mesh.isInstancedMesh ? mesh.instanceMatrix.count : 1;

      for (let k = 0; k < count; k++) {
        units.push({
          mesh: m,
          instance: mesh.isInstancedMesh ? k : -1,
          geometry: g,
          base: entryCount + k * charts.length,
        });
      }

      setChartAttribute(
        mesh.geometry,
        charts,
        entryCount,
        mesh.isInstancedMesh ? charts.length : 0,
      );
      proxies.push({ mesh: m, geometry: mesh.geometry, instances: null });
      entryCount += count * charts.length;
      return;
    }

    const batch = mesh.userData.environmentShadowBatch;
    const instances = getInstanceIds(mesh);
    const bases = new Float32Array(getInstanceIdCount(mesh)).fill(-1);

    // NOTE One proxy per geometry: an InstancedMesh of the instances of that geometry
    for (const [geometryId, { geometry, charts }] of batch.geometries) {
      const ids = instances.get(geometryId) ?? [];
      const g = addGeometry(geometry, charts);

      ids.forEach((id, k) => {
        const base = entryCount + k * charts.length;

        units.push({ mesh: m, instance: id, geometry: g, base });
        bases[id] = base;
      });

      setChartAttribute(geometry, charts, entryCount, charts.length);

      if (ids.length > 0) proxies.push({ mesh: m, geometry, instances: ids });

      entryCount += ids.length * charts.length;
    }

    if (batch.receives) tables.push({ mesh, bases });
  });

  // NOTE Stride -1 (BatchedMesh): texel 0 x of table entry ( base + instance id ) holds the instance base
  let tableCount = 0;

  for (const table of tables) {
    const attribute = table.mesh.geometry.attributes[CHART_ATTRIBUTE];

    // NOTE Only the base changes, chart and stride (-1) are set at unwrap
    for (let v = 0; v < attribute.count; v++) attribute.setY(v, entryCount + tableCount);

    attribute.needsUpdate = true;
    table.start = tableCount;
    tableCount += table.bases.length;
  }

  const table = new Float32Array(tableCount * ENTRY_SIZE);

  for (const { start, bases } of tables) {
    bases.forEach((base, i) => (table[(start + i) * ENTRY_SIZE] = base));
  }

  return { geometries, units, proxies, entryCount, table };
}

/** World matrix of a unit: the mesh matrix, times the instance matrix of an instance. */
export function getUnitMatrix(mesh, instance, target) {
  if (instance < 0) return target.copy(mesh.matrixWorld);

  mesh.getMatrixAt(instance, target);

  return target.premultiply(mesh.matrixWorld);
}

/** Whether an instance is drawn: within the count of an InstancedMesh, visible in a BatchedMesh. */
export function isUnitDrawn(mesh, instance) {
  if (instance < 0) return true;
  if (mesh.isInstancedMesh) return instance < mesh.count;

  return isInstanceVisible(mesh, instance);
}

/** Creates a layout texture: per unit chart the 2x3 transform from lightmapUv to the atlas UV, in two RGBA texels. */
export function createLayoutTexture(entryCount, table) {
  const texels = entryCount * 2 + table.length / 4;
  const rows = Math.max(1, Math.ceil(texels / LAYOUT_WIDTH));
  const texture = new DataTexture(
    new Float32Array(LAYOUT_WIDTH * rows * 4),
    LAYOUT_WIDTH,
    rows,
    RGBAFormat,
    FloatType,
  );

  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.userData.entryCount = entryCount;

  writeLayout(texture, null, table);

  return texture;
}

/** Writes a layout (null: no place for any unit) into a layout texture. The table follows the transforms. */
export function writeLayout(texture, layout, table) {
  const { entryCount } = texture.userData;
  const data = texture.image.data;

  data.set(layout ?? emptyLayout(entryCount));
  data.set(table, entryCount * ENTRY_SIZE);
  texture.needsUpdate = true;
}
