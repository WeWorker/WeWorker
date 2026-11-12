import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  // 使用相对资源路径，兼容入口前缀部署（如挂在 /adapterhub/ 下）
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8790' } },
})
