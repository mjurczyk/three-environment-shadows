import uglify from '@lopatnov/rollup-plugin-uglify';
import copy from 'rollup-plugin-copy';
import externalPeerDependencies from 'rollup-plugin-peer-deps-external';
import cleanUpDir from 'rollup-plugin-delete';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// NOTE `import text from 'file?raw'` (as in vite): the file as a string. Used to run xatlas-web in a Blob worker.
const raw = () => ({
  name: 'raw',
  resolveId: (id) => (id.endsWith('?raw') ? `${require.resolve(id.slice(0, -4))}?raw` : null),
  load: (id) =>
    id.endsWith('?raw')
      ? `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))};`
      : null,
});

export default [
  {
    // NOTE ESM only: three.js deprecates `require('three')`. Two entries: WebGLRenderer (GLSL) and WebGPURenderer (TSL)
    input: {
      index: './src/index.js',
      webgpu: './src/webgpu.js',
    },
    output: {
      dir: './build',
      format: 'esm',
      chunkFileNames: 'shared.js',
    },
    // NOTE three, three/webgpu, three/tsl are peer dependencies. xatlas-web is bundled (as text, for the worker).
    external: (id) => id === 'three' || id.startsWith('three/'),
    plugins: [
      cleanUpDir({ targets: './build' }),
      raw(),
      externalPeerDependencies(),
      uglify(),
      copy({
        targets: [
          { src: './package.json', dest: './build/' },
          { src: './README.md', dest: './build/' },
          { src: './types/index.d.ts', dest: './build/' },
          { src: './types/webgpu.d.ts', dest: './build/' },
          // NOTE Loaded next to the bundle with new URL( './xatlas-web.wasm', import.meta.url )
          { src: './node_modules/xatlas-web/dist/xatlas-web.wasm', dest: './build/' },
        ],
      }),
    ],
  },
];
