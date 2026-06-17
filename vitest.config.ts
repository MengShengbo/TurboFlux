import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src-desktop/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'dist-desktop/**',
      'tmp/**',
      'output/**',
      'edit-work/**',
    ],
  },
})
