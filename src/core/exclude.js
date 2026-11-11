// NOTE An object is excluded when it or one of its ancestors is in the set
export function isExcluded(object, exclude) {
  if (exclude.size === 0) return false;

  for (let node = object; node !== null; node = node.parent) if (exclude.has(node)) return true;

  return false;
}

/**
 * Writes the excluded state of each mesh into `flags`.
 *
 * @param {Mesh[]} meshes - The meshes.
 * @param {Set<Object3D>} exclude - The excluded objects.
 * @param {boolean[]} flags - Excluded state per mesh, updated in place.
 * @returns {boolean} Whether a state changed.
 */
export function updateExcluded(meshes, exclude, flags) {
  let changed = false;

  for (let i = 0; i < meshes.length; i++) {
    const excluded = isExcluded(meshes[i], exclude);

    if (flags[i] !== excluded) {
      flags[i] = excluded;
      changed = true;
    }
  }

  return changed;
}
