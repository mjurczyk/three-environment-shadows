import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, TorusKnotGeometry } from 'three';
import { NO_PLACE } from '../src/core/packer.js';
import { UV_ATTRIBUTES, unwrapMeshes } from '../src/core/unwrap.js';

// NOTE xatlas-web is a browser build: stub its environment checks, load the wasm from a data URL
globalThis.window ??= globalThis;
globalThis.document ??= { currentScript: null };

const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('xatlas-web/dist/xatlas-web.wasm'));
const wasmUrl = `data:application/wasm;base64,${wasm.toString('base64')}`;

describe('unwrap', () => {
  it('unwraps receivers into charts and adds the layout attributes', async () => {
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

    for (const name of UV_ATTRIBUTES) {
      expect(caster.geometry.attributes[name].array.every((v) => v === NO_PLACE)).toBe(true);
      expect(box.geometry.attributes[name].count).toBe(box.geometry.attributes.position.count);
    }
  }, 30000);
});
