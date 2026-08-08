import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  // lib.js is shared with the server and the web client, one level up
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebViews on cheap Android hardware are old; don't ship syntax they choke on
    target: ['es2020', 'chrome87'],
  },
})
