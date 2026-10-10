import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: join(appDir, 'renderer'),
  plugins: [react()],
  // Electron prod 用 file:// 加载:必须相对路径,否则 /assets/... 解析到盘根
  // → JS 加载失败 → 黑屏(2026-10-10 用户装机实测踩中)
  base: './',
  build: {
    outDir: join(appDir, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
