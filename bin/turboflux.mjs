#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const entry = join(root, 'src', 'cli', 'index.ts')
const require = createRequire(import.meta.url)
const tsxLoader = pathToFileURL(require.resolve('tsx')).href

// Use node with tsx --import to run TypeScript directly.
const { spawnSync } = await import('node:child_process')
const args = ['--import', tsxLoader, entry, ...process.argv.slice(2)]

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: { ...process.env, NODE_PATH: join(root, 'node_modules') },
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
