import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(appDir, 'renderer'),
  plugins: [react()],
  build: {
    outDir: join(appDir, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
