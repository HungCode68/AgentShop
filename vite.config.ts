import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev: forward /api to the local gateway (cd gateway && npm start), same as nginx does in production.
    proxy: {
      '/api': 'http://localhost:8090',
    },
  },
})
