import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths so the build works at any GitHub Pages URL (user.github.io/repo-name/).
  base: './',
  worker: {
    format: 'es',
  },
  // The codecs load their own .wasm files; pre-bundling breaks those paths in dev.
  optimizeDeps: {
    exclude: [
      '@jsquash/jpeg',
      '@jsquash/png',
      '@jsquash/oxipng',
      '@jsquash/resize',
      '@jsquash/webp',
      'libimagequant-wasm',
    ],
  },
  build: {
    target: 'es2022',
  },
});
