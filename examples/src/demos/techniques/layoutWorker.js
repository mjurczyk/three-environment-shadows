import { packCharts } from './atlasPacker.js';

// NOTE Packs lightmap layouts off the main thread, see createPacker() in lightmapLayout.js
let meshData = null;

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'init') {
    meshData = message.meshData;
    return;
  }

  if (message.type === 'pack') {
    const layout = packCharts(meshData, message.visible, message.atlasSize);
    const buffers = layout.filter(Boolean).map((uvs) => uvs.buffer);

    self.postMessage({ id: message.id, layout }, buffers);
  }
};
