import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5186,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', 'three/webgpu', 'three/tsl'],
        },
      },
    },
  },
});
