import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Stable vendor chunks cache across deploys; recharts stays in the lazy workshop-performance chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/node_modules[\\/](react-router|react-router-dom)[\\/]/.test(id)) return 'vendor-router'
          if (/node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons'
          if (/node_modules[\\/]axios[\\/]/.test(id)) return 'vendor-http'
          return undefined
        },
      },
    },
  },
})
