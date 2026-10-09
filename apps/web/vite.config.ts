import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks: { echarts: ['echarts', 'echarts-for-react'], react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] } } } },
});
