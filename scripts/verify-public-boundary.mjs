import { readWorkspaces } from './workspace-packages.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const privatePrefixes = [
  'control-plane/',
]

function gitFiles(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
}

const tracked = gitFiles(['ls-files'])
const staged = gitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
const exposed = [...new Set([...tracked, ...staged])].filter(file => privatePrefixes.some(prefix => file === prefix || file.startsWith(prefix)))

const failures = []
if (exposed.length) failures.push(`private product paths are tracked or staged:\n${exposed.map(file => `  - ${file}`).join('\n')}`)

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packedFiles = Array.isArray(packageJson.files) ? packageJson.files : []
const unsafePackEntry = packedFiles.filter(file => privatePrefixes.some(prefix => file === prefix || file.startsWith(prefix)))
if (unsafePackEntry.length) failures.push(`package.json files exposes private paths: ${unsafePackEntry.join(', ')}`)
if (packageJson.private !== true) failures.push('workspace root must be private; the kernel owns its package entrypoints')
if (packageJson.main !== undefined) failures.push('workspace root must not expose a main entry')
if (packageJson.bin !== undefined) failures.push('workspace root must not expose command-line binaries')
if (packageJson.scripts?.dev !== 'npm run dev:desktop') failures.push('workspace dev script must launch the desktop app')
if (packageJson.scripts?.start !== 'npm run dev:desktop') failures.push('workspace start script must launch the desktop app')
if (packageJson.scripts?.['dev:cli'] !== undefined) failures.push('workspace package must not keep an active dev:cli script')
if (packageJson.scripts?.['build:cli'] !== undefined) failures.push('workspace package must not keep an active build:cli script')
if (packageJson.scripts?.['link:tf'] !== undefined) failures.push('workspace package must not keep an active link:tf script')
if (packageJson.scripts?.['unlink:tf'] !== undefined) failures.push('workspace package must not keep an active unlink:tf script')
if (packageJson.scripts?.['perf:flow'] !== undefined) failures.push('workspace package must not keep an active perf:flow script')
if (packageJson.scripts?.['smoke:tui'] !== undefined) failures.push('workspace package must not keep an active smoke:tui script')
if (packageJson.scripts?.['baseline:terminal'] !== undefined) failures.push('workspace package must not keep an active baseline:terminal script')

const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
const productDependencies = dependencyNames.filter(name => ['electron', 'electron-builder', 'fastify', '@fastify/static', 'better-sqlite3', 'pg'].includes(name))
if (productDependencies.length) failures.push(`public package contains product-only dependencies: ${productDependencies.join(', ')}`)

const corePackage = JSON.parse(readFileSync(new URL('../packages/agent-core/package.json', import.meta.url), 'utf8'))
const desktopPackage = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))
const expectedCoreExports = ['.', './contracts', './runtime', './renderer', './workbench', './extensions']
if (corePackage.name !== '@turboflux/agent-core') failures.push('shared kernel package must be named @turboflux/agent-core')
if (corePackage.private === true) failures.push('@turboflux/agent-core must be publishable')
if (packageJson.turbofluxCoreVersion !== corePackage.version) failures.push('Workspace turbofluxCoreVersion must match the Agent kernel version')
if (desktopPackage.dependencies?.['@turboflux/workbench'] !== '*') failures.push('Desktop must link the workspace workbench package')
if (desktopPackage.dependencies?.['@turboflux/agent-core']) failures.push('Desktop must not depend on the compatibility facade')
if (desktopPackage.version !== packageJson.version) failures.push('Workspace and Desktop product versions must stay aligned')
if (JSON.stringify(Object.keys(corePackage.exports)) !== JSON.stringify(expectedCoreExports)) {
  failures.push(`Agent kernel exports changed without an explicit boundary update: ${Object.keys(corePackage.exports).join(', ')}`)
}
const coreDependencies = Object.keys({ ...corePackage.dependencies, ...corePackage.devDependencies })
const forbiddenCoreDependencies = coreDependencies.filter(name => ['electron', 'electron-builder', 'fastify', '@fastify/static', 'better-sqlite3', 'pg', 'react', 'ink'].includes(name))
if (forbiddenCoreDependencies.length) failures.push(`Agent kernel contains shell or product dependencies: ${forbiddenCoreDependencies.join(', ')}`)

const workspaces = readWorkspaces()
const workspaceRoots = workspaces.map(({ manifest, kind }) => `${kind}/${manifest.name.replace('@turboflux/', '')}`)
for (const root of workspaceRoots) {
  const manifest = JSON.parse(readFileSync(new URL(`../${root}/package.json`, import.meta.url), 'utf8'))
  const internalDependencies = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([name]) => name.startsWith('@turboflux/') && name !== manifest.name)
  for (const [name, version] of internalDependencies) {
    if (version !== '*') failures.push(`${root} pins workspace dependency "${name}": "${version}" — use "*" so npm always links the workspace copy instead of silently resolving a stale registry version when versions drift`)
  }
  for (const lockfileName of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    if (existsSync(new URL(`../${root}/${lockfileName}`, import.meta.url))) {
      failures.push(`${root}/${lockfileName} must not exist — nested lockfiles desync from the workspace root install; run npm install at the repository root instead`)
    }
  }
}

const publicSourceRoots = workspaces.filter(entry => entry.kind === 'packages').map(entry => join(entry.directory, 'src'))
const publicSourceFiles = []
function collectSourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collectSourceFiles(path)
    else if (/\.(?:ts|tsx|mjs|cjs)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) publicSourceFiles.push(path)
  }
}
for (const root of publicSourceRoots) collectSourceFiles(root)
for (const file of publicSourceFiles) {
  const source = readFileSync(file, 'utf8')
  if (/from ['"][^'"]*desktop\//.test(source) || /import\(['"][^'"]*desktop\//.test(source)) {
    failures.push(`public source imports Desktop product code: ${file}`)
  }
  if (/controlPlane|productAccount|safeStorage|@turboflux\/desktop-product/.test(source)) {
    failures.push(`public source contains private product coupling: ${file}`)
  }
}

const removedCommercialPaths = [
  'apps/control-plane', 'apps/desktop/product',
  'apps/desktop/renderer/accountCenter.ts', 'apps/desktop/renderer/creditPresentation.ts',
  'marketplace/catalog.json', 'marketplace/packages', 'scripts/build-plugin-marketplace.ts',
  'packages/agent-core/src/application/plugins/marketplace.ts',
  'packages/agent-core/src/application/plugins/pluginMarketplaceFeed.ts',
  'packages/agent-core/src/core/skills/marketplace.ts',
  'packages/agent-core/src/core/skills/marketplaceNetwork.ts',
  'packages/agent-core/src/core/skills/marketplaceInstallManager.ts',
]
for (const path of removedCommercialPaths) {
  const url = new URL(`../${path}`, import.meta.url)
  if (existsSync(url) && (!path.endsWith('/packages') || readdirSync(url).length > 0)) {
    failures.push(`removed commercial runtime or catalog has returned: ${path}`)
  }
}
const commercialSymbolPattern = /PluginMarketplaceFeedClient|MarketplaceInstallManager|TURBOFLUX_WORK_PACK_CATALOG_URL|turboflux-managed|controlPlane|productAccount|creditBalance|creditUsage|official-market/
collectSourceFiles(fileURLToPath(new URL('../apps/desktop/renderer/', import.meta.url)))
for (const file of [...publicSourceFiles, ...['main.mjs', 'runtimeHost.ts', 'preload.cjs'].map(name => fileURLToPath(new URL(`../apps/desktop/${name}`, import.meta.url)))]) {
  if (commercialSymbolPattern.test(readFileSync(file, 'utf8'))) failures.push(`source contains removed commercial coupling: ${file}`)
}

if (failures.length) {
  process.stderr.write(`TurboFlux public boundary check failed:\n\n${failures.join('\n\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('TurboFlux public boundary check passed.\n')
}
