import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  BatchedMesh,
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusKnotGeometry,
} from 'three';
import { CHART_ATTRIBUTE, unwrapMeshes } from '../src/core/unwrap.js';
import { createUnits } from '../src/core/units.js';

// NOTE xatlas-web is a browser build: stub its environment checks, load the wasm from a data URL
globalThis.window ??= globalThis;
globalThis.document ??= { currentScript: null };

const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('xatlas-web/dist/xatlas-web.wasm'));
const wasmUrl = `data:application/wasm;base64,${wasm.toString('base64')}`;

describe('unwrap', () => {
  it('unwraps receivers into charts and adds the lightmap attributes', async () => {
    const box = new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
    const knot = new Mesh(new TorusKnotGeometry(0.8, 0.3, 64, 16), new MeshStandardMaterial());
    const caster = new Mesh(new BoxGeometry(), new MeshStandardMaterial());

    await unwrapMeshes([box, knot], [caster], wasmUrl);

    for (const mesh of [box, knot]) {
      const charts = mesh.userData.environmentShadowCharts;
      const vertices = charts.reduce((sum, chart) => sum + chart.vertices.length, 0);

      expect(charts.length).toBeGreaterThan(0);
      expect(vertices).toBe(mesh.geometry.attributes.position.count);
      expect(
        charts.every((chart) => chart.metersPerUv > 0 && chart.width > 0 && chart.height > 0),
      ).toBe(true);
    }

    // NOTE A box unwraps into one chart per face
    expect(box.userData.environmentShadowCharts.length).toBe(6);

    // NOTE Casters get zero attributes: chart 0 is no chart
    expect(caster.geometry.attributes[CHART_ATTRIBUTE].array.every((v) => v === 0)).toBe(true);
    expect(box.geometry.attributes.lightmapUv.count).toBe(box.geometry.attributes.position.count);
  }, 30000);

  it('gives each instance of an InstancedMesh its own entries', async () => {
    const instanced = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 3);
    const plain = new Mesh(new BoxGeometry(), new MeshStandardMaterial());

    await unwrapMeshes([plain, instanced], [], wasmUrl);

    const { units, entryCount } = createUnits([plain, instanced]);
    const chart = instanced.geometry.attributes[CHART_ATTRIBUTE];

    expect(units.map((unit) => [unit.mesh, unit.instance, unit.base])).toEqual([
      [0, -1, 0],
      [1, 0, 6],
      [1, 1, 12],
      [1, 2, 18],
    ]);
    expect(entryCount).toBe(24);
    // NOTE ( chart + 1, base, stride ): stride is the chart count of the geometry
    expect([chart.getY(0), chart.getZ(0)]).toEqual([6, 6]);
    expect(plain.geometry.attributes[CHART_ATTRIBUTE].getZ(0)).toBe(0);
  }, 30000);

  it('unwraps the geometries of a BatchedMesh and finds the instance bases in a table', async () => {
    const batched = new BatchedMesh(4, 1000, 4000, new MeshStandardMaterial());
    const box = batched.addGeometry(new BoxGeometry());
    const sphere = batched.addGeometry(new SphereGeometry(0.5, 8, 6));
    const ids = [box, sphere, box].map((geometryId) => batched.addInstance(geometryId));

    ids.forEach((id, k) => batched.setMatrixAt(id, new Matrix4().makeTranslation(k * 2, 0, 0)));

    await unwrapMeshes([batched], [], wasmUrl);

    const batch = batched.userData.environmentShadowBatch;
    const boxCharts = batch.geometries.get(box).charts.length;
    const sphereCharts = batch.geometries.get(sphere).charts.length;
    const { units, proxies, entryCount, table } = createUnits([batched]);

    expect(boxCharts).toBe(6);
    expect(entryCount).toBe(2 * boxCharts + sphereCharts);

    // NOTE The batch has the unwrapped geometries, ranges one after the other
    const boxRange = batched.getGeometryRangeAt(box);
    const sphereRange = batched.getGeometryRangeAt(sphere);

    expect(boxRange.vertexCount).toBe(batch.geometries.get(box).geometry.attributes.position.count);
    expect(sphereRange.vertexStart).toBe(boxRange.vertexStart + boxRange.vertexCount);

    // NOTE Proxies: one InstancedMesh per geometry, units of the box instances first
    expect(proxies.map((proxy) => proxy.instances)).toEqual([[ids[0], ids[2]], [ids[1]]]);
    expect(units.map((unit) => [unit.instance, unit.base])).toEqual([
      [ids[0], 0],
      [ids[2], boxCharts],
      [ids[1], 2 * boxCharts],
    ]);

    // NOTE Table: texel 0 x of entry ( base + instance id ) is the base of the instance, stride -1
    const chart = batched.geometry.attributes[CHART_ATTRIBUTE];
    const start = chart.getY(boxRange.vertexStart);

    expect(start).toBe(entryCount);
    expect(chart.getZ(sphereRange.vertexStart)).toBe(-1);
    expect(ids.map((id) => table[id * 8])).toEqual([0, 2 * boxCharts, boxCharts]);
  }, 30000);
});
