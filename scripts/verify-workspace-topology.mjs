#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedWorkspaces = new Map([
  ['apps/desktop', '@turboflux/desktop'],
  ['apps/remote-mobile', '@turboflux/remote-mobile'],
  ['packages/agent-core', '@turboflux/agent-core'],
  ['packages/remote-protocol', '@turboflux/remote-protocol'],
])
const failures = []
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

if (JSON.stringify(manifest.workspaces) !== JSON.stringify(['packages/*', 'apps/*'])) {
  failures.push('npm workspaces must contain packages/* and apps/*')
}

for (const [directory, name] of expectedWorkspaces) {
  const manifestPath = join(repoRoot, directory, 'package.json')
  if (!existsSync(manifestPath)) {
    failures.push(`missing workspace manifest: ${directory}/package.json`)
    continue
  }
  const workspace = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (workspace.name !== name) failures.push(`${directory} must be named ${name}`)
}

for (const parent of ['apps', 'packages']) {
  if (!existsSync(join(repoRoot, parent))) continue
  for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
    const directory = `${parent}/${entry.name}`
    if (entry.isDirectory() && existsSync(join(repoRoot, directory, 'package.json')) && !expectedWorkspaces.has(directory)) {
      failures.push(`unexpected workspace: ${directory}`)
    }
  }
}

for (const directory of ['archive', 'tui', 'orbit', 'apps/orbit', 'apps/terminal', 'src/cli']) {
  if (existsSync(join(repoRoot, directory))) failures.push(`unexpected source directory: ${directory}`)
}

for (const file of ['README.md', 'README.zh.md', 'docs/README.md', 'docs/architecture/repository-boundary.md']) {
  if (!existsSync(join(repoRoot, file))) failures.push(`missing documentation: ${file}`)
}

for (const name of ['dev:desktop', 'build:desktop', 'verify:workspace']) {
  if (!manifest.scripts?.[name]) failures.push(`missing script: ${name}`)
}

if (failures.length > 0) {
  console.error(`Workspace topology check failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('Core and Desktop workspace topology is consistent.')
}
