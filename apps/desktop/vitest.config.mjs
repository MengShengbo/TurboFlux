import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    maxWorkers: 2,
    exclude: ['node_modules/**'],
  },
})
