#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const distRoot = path.resolve('dist')
const relativeImportPattern = /((?:from\s*|import\s*\(\s*)['"])(\.[^'"]+)(['"])/g

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

console.log(`Rewrote ${rewrittenImports} relative imports in ${rewrittenFiles} files`)
