import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// One .env for the whole repo, in the root. `/api` goes to apps/server, so the page and the API share an origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  return {
    plugins: [react()],
    envDir: '../..',
    server: {
      port: 5173,
      proxy: { '/api': `http://localhost:${env.SERVER_PORT || 8787}` },
    },
  }
})
