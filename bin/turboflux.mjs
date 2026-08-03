#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const entry = join(root, 'dist', 'cli', 'index.js')

if (process.argv[2] === '--version' || process.argv[2] === '-V') {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  process.stdout.write(`${packageJson.version}\n`)
  process.exit(0)
}

await import(pathToFileURL(entry).href)
