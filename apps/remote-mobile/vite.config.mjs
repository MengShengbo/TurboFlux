import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  server: { host: '0.0.0.0', port: 4180 },
  preview: { host: '0.0.0.0', port: 4180 },
  build: { outDir: 'dist', emptyOutDir: true },
})
