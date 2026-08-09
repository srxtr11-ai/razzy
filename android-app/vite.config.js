import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  // lib.js is shared with the server and the web client, one level up
  server: { fs: { allow: ['..'] } },
  resolve: {
    /**
     * The players and the friends panel are the website's files, imported from
     * outside this project — so their `import ... from 'react'` resolved against
     * `web/node_modules` while everything here used its own copy. Two Reacts in
     * one bundle means the second one's hook dispatcher is null, and the app
     * dies on the first useState with a blank screen and nothing else.
     */
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebViews on cheap Android hardware are old; don't ship syntax they choke on
    target: ['es2020', 'chrome87'],
  },
})
