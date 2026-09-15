#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const distRoot = path.resolve(process.argv[2] || 'dist')
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const relativeImportPattern = /((?:from\s*|import\s*\(\s*)['"])(\.[^'"]+)(['"])/g
const runtimeAssets = process.argv.includes('--skip-runtime-assets')
  ? []
  : ['application/plugins/pluginHostChild.mjs']

function walk(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(fullPath))
    else if (fullPath.endsWith('.js')) files.push(fullPath)
  }
  return files
}

function resolveImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier)
  if (fs.existsSync(`${base}.js`)) return `${specifier}.js`
  if (fs.existsSync(path.join(base, 'index.js'))) return `${specifier}/index.js`
  return null
}

let rewrittenFiles = 0
let rewrittenImports = 0
for (const filePath of walk(distRoot)) {
  const original = fs.readFileSync(filePath, 'utf8')
  const rewritten = original.replace(relativeImportPattern, (full, prefix, specifier, suffix) => {
    if (path.extname(specifier)) return full
    const resolved = resolveImport(filePath, specifier)
    if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${filePath}`)
    rewrittenImports += 1
    return `${prefix}${resolved}${suffix}`
  })
  if (rewritten !== original) {
    fs.writeFileSync(filePath, rewritten)
    rewrittenFiles += 1
  }
}

for (const asset of runtimeAssets) {
  const source = path.join(repositoryRoot, 'packages', 'agent-core', 'src', asset)
  if (!fs.existsSync(source)) throw new Error(`Runtime asset is missing: ${source}`)
  const target = path.join(distRoot, asset)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

console.log(`Rewrote ${rewrittenImports} relative imports in ${rewrittenFiles} files and copied ${runtimeAssets.length} runtime assets`)
