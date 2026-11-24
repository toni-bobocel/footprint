import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages serves the site under /footprint/.
  base: process.env.BASE ?? '/',
  server: { fs: { allow: ['..'] } },
  // Pre-bundling breaks MapLibre's worker URL in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1400 },
})
