import { readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export function readWorkspaces(root = repositoryRoot) {
  return ['packages', 'apps'].flatMap(parent => readdirSync(join(root, parent), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const directory = join(root, parent, entry.name)
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        return [{ directory, manifest, kind: parent }]
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
    }))
}

export function orderedPackages(workspaces = readWorkspaces()) {
  const packages = new Map(workspaces.filter(entry => entry.kind === 'packages').map(entry => [entry.manifest.name, entry]))
  const visited = new Set()
  const visiting = new Set()
  const result = []
  function visit(name, path = []) {
    if (visited.has(name)) return
    if (visiting.has(name)) throw new Error(`Package dependency cycle: ${[...path, name].join(' -> ')}`)
    const entry = packages.get(name)
    if (!entry) throw new Error(`Unknown package: ${name}`)
    visiting.add(name)
    for (const dependency of Object.keys(entry.manifest.dependencies || {})) {
      if (dependency.startsWith('@turboflux/')) visit(dependency, [...path, name])
    }
    visiting.delete(name)
    visited.add(name)
    result.push(entry)
  }
  for (const name of packages.keys()) visit(name)
  return result
}

// Tests exercise current sources across package boundaries; production resolves dist.
export function workspaceSourceAliases() {
  return readWorkspaces().filter(entry => entry.kind === 'packages').flatMap(({ directory, manifest }) => (
    Object.entries(manifest.exports || {}).map(([subpath, entry]) => ({
      find: manifest.name + (subpath === '.' ? '' : subpath.slice(1)),
      replacement: resolve(directory, entry.types.replace('./dist/', './src/').replace(/\.d\.ts$/, '.ts')),
    }))
  )).sort((a, b) => b.find.length - a.find.length)
}
