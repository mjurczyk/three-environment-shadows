import { defineConfig } from 'vite';

export default defineConfig({
  // NOTE The examples import the library source, which must use the same three.js copy
  resolve: { dedupe: ['three'] },
});
