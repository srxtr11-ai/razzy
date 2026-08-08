import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    fs: { allow: ['..'] }, // lib.js is shared with the server, one level up
    proxy: {
      '/api': 'http://localhost:3000',
      '/avatars': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
