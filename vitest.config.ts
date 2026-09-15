import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    maxWorkers: 2,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/agent-core/src/{kernel,application,core,platform,server,shared,state,tools}/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'tmp/**',
      'output/**',
      'edit-work/**',
    ],
  },
})
