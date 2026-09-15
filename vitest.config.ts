import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
