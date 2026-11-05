import uglify from '@lopatnov/rollup-plugin-uglify';
import copy from 'rollup-plugin-copy';
import externalPeerDependencies from 'rollup-plugin-peer-deps-external';
import cleanUpDir from 'rollup-plugin-delete';

export default [
  {
    // NOTE ESM only: three.js deprecates `require('three')`
    input: './src/index.js',
    output: {
      file: './build/index.js',
      format: 'esm',
    },
    plugins: [
      cleanUpDir({ targets: './build' }),
      externalPeerDependencies(),
      uglify(),
      copy({
        targets: [
          { src: './package.json', dest: './build/' },
          { src: './README.md', dest: './build/' },
          { src: './types/index.d.ts', dest: './build/' },
        ],
      }),
    ],
  },
];
