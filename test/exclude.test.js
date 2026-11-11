import { describe, expect, it } from 'vitest';
import { Group, Mesh } from 'three';
import { isExcluded, updateExcluded } from '../src/core/exclude.js';

// NOTE model > child > mesh, and one mesh outside the model
const createScene = () => {
  const model = new Group();
  const child = new Group();
  const mesh = new Mesh();
  const other = new Mesh();

  model.add(child);
  child.add(mesh);

  return { model, child, mesh, other };
};

describe('isExcluded', () => {
  it('is false for an empty set', () => {
    const { mesh } = createScene();

    expect(isExcluded(mesh, new Set())).toBe(false);
  });

  it('is true for an excluded mesh', () => {
    const { mesh } = createScene();

    expect(isExcluded(mesh, new Set([mesh]))).toBe(true);
  });

  it('is true for a mesh with an excluded ancestor', () => {
    const { model, mesh, other } = createScene();
    const exclude = new Set([model]);

    expect(isExcluded(mesh, exclude)).toBe(true);
    expect(isExcluded(other, exclude)).toBe(false);
  });
});

describe('updateExcluded', () => {
  it('writes the flags and tells if one changed', () => {
    const { model, mesh, other } = createScene();
    const meshes = [mesh, other];
    const flags = [false, false];
    const exclude = new Set();

    expect(updateExcluded(meshes, exclude, flags)).toBe(false);

    exclude.add(model);
    expect(updateExcluded(meshes, exclude, flags)).toBe(true);
    expect(flags).toEqual([true, false]);
    expect(updateExcluded(meshes, exclude, flags)).toBe(false);

    exclude.delete(model);
    exclude.add(other);
    expect(updateExcluded(meshes, exclude, flags)).toBe(true);
    expect(flags).toEqual([false, true]);
  });
});
