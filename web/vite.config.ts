import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { aynaApi } from './server/dev';

export default defineConfig(({ mode }) => ({
  // The MuJoCo package locates its .wasm relative to itself; pre-bundling breaks that.
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  server: { port: 5190 },
  // Server-only environment (API keys) from the repo-root .env: handed to the /api middleware,
  // never to the client bundle (only VITE_* variables from web/ reach it).
  plugins: [aynaApi(loadEnv(mode, resolve(__dirname, '..'), ''))],
  build: {
    rollupOptions: {
      input: { landing: resolve(__dirname, 'index.html'), app: resolve(__dirname, 'app/index.html') },
    },
  },
}));
