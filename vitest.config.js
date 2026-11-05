import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// NOTE `npm run test:build` runs the same tests against the minified bundle
const entry = process.env.TEST_BUILD ? './build/index.js' : './src/index.js';

export default defineConfig({
  resolve: {
    alias: {
      'three-environment-shadows': fileURLToPath(new URL(entry, import.meta.url)),
    },
  },
});
