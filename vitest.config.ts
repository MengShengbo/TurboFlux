import { defineConfig } from 'vitest/config'
import { workspaceSourceAliases } from './scripts/workspace-packages.mjs'

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    maxWorkers: 2,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/*/src/**/*.{test,spec}.{ts,tsx}',
      'apps/model-proxy/src/**/*.test.ts',
      'scripts/**/*.test.ts',
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
