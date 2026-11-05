import { defineConfig } from 'vite';

export default defineConfig({
  // NOTE The examples import the library source, which must use the same three.js copy
  resolve: { dedupe: ['three'] },
  base: '/three-environment-shadows/',
  // NOTE three.js alone is about 600 kB
  build: { chunkSizeWarningLimit: 1000 },
});
