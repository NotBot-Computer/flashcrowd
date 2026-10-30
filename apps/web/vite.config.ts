import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// One .env for the whole repo, in the root. `/api` goes to apps/server, so the page and the API share an origin.
// SERVER_URL points it at a teammate's server instead (a cloudflared tunnel); otherwise the local one.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const server: ProxyOptions = {
    target: env.SERVER_URL || `http://localhost:${env.SERVER_PORT || 8787}`,
    // A tunnel routes by Host, so the request must carry the tunnel's host, not localhost:5173.
    changeOrigin: true,
    configure: (proxy) => {
      // The proxy holds response headers until the first body chunk. A quiet /api/feed sends none for a while,
      // so the browser's EventSource would never open: send an event stream's headers as soon as they are set.
      proxy.on('proxyRes', (proxyRes, _req, res) => {
        if (String(proxyRes.headers['content-type']).startsWith('text/event-stream')) {
          process.nextTick(() => res.flushHeaders())
        }
      })
    },
  }
  return {
    plugins: [react()],
    envDir: '../..',
    server: {
      port: 5173,
      proxy: { '/api': server, '/health': server },
    },
  }
})
