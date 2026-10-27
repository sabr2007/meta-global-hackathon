import { defineConfig } from 'vite';

export default defineConfig({
  // The MuJoCo package locates its .wasm relative to itself; pre-bundling breaks that.
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  server: { port: 5190 },
});
