import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      // 本地开发：前端 dev server 把 API 请求转发给网关（默认 8045）
      '/admin': 'http://127.0.0.1:8045',
      '/v1': 'http://127.0.0.1:8045',
      '/healthz': 'http://127.0.0.1:8045',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
