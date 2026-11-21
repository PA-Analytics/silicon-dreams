import { defineConfig, loadEnv } from 'vite';
import { handleChat } from './api/chat.ts';

export default defineConfig({
  plugins: [{
    name: 'local-chat-api',
    configureServer(server) {
      const env = { ...process.env, ...loadEnv(server.config.mode, process.cwd(), '') };
      server.middlewares.use('/api/chat', (req, res) => {
        void handleChat(req, res, env);
      });
    },
  }],
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
