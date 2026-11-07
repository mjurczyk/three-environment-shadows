import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// NOTE `npm run test:build` runs the entry tests against the minified bundle
const build = !!process.env.TEST_BUILD;
const path = (file) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'three-environment-shadows/webgpu': path(build ? './build/webgpu.js' : './src/webgpu.js'),
      'three-environment-shadows': path(build ? './build/index.js' : './src/index.js'),
    },
  },
});
