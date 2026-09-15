import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-desktop', 'release', 'coverage',
  'douyin-chat-export', 'docs', 'generated', 'poc', 'cli',
])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|mjs|cjs)$/
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mjs|cjs)$/
const STATIC_USER_ROOT_ALLOWLIST = new Set([
  'packages/agent-core/src/core/profilePaths.ts',
  'apps/desktop/main.mjs',
])

const SRC_LAYERS = new Set(['kernel', 'application', 'core', 'tools', 'platform', 'shared', 'state', 'server'])
const PRODUCT_LAYERS = new Set(['server'])
const FOUNDATION_LAYERS = new Set(['core', 'tools', 'platform', 'shared', 'state'])
const ORCHESTRATION_LAYERS = new Set(['application', 'kernel'])

const IMPORT_PATTERNS = [
  /^[ \t]*import\s[^'"`\n]*?from\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*export\s[^'"`\n]*?from\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*\}\s*from\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist-')) continue
      walk(join(directory, entry.name), files)
    } else if (SOURCE_RE.test(entry.name) && !TEST_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(join(directory, entry.name))
    }
  }
  return files
}

function classify(absPath) {
  const rel = relative(ROOT, absPath).replaceAll('\\', '/')
  if (rel.startsWith('../')) return { kind: 'outside' }
  if (rel.startsWith('packages/agent-core/src/')) {
    const parts = rel.split('/')
    if (parts.length === 3) return { kind: 'src-root' }
    return { kind: 'layer', layer: parts[3] }
  }
  if (rel.startsWith('apps/')) return { kind: 'app', app: rel.split('/')[1] }
  if (rel.startsWith('packages/')) return { kind: 'package', pkg: rel.split('/')[1] }
  return { kind: 'outside' }
}

function specifiersOf(source) {
  const specs = new Set()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source))) specs.add(match[1])
  }
  return specs
}

function evaluate(from, to, spec) {
  if (from.kind === 'layer') {
    if (!SRC_LAYERS.has(from.layer)) {
      return `unclassified src/ layer "${from.layer}": classify it in scripts/verify-architecture.mjs before adding cross-layer imports`
    }
    if (to.kind === 'layer' && !SRC_LAYERS.has(to.layer)) {
      return `unclassified src/ layer "${to.layer}": classify it in scripts/verify-architecture.mjs before importing from it`
    }
    if (spec.startsWith('@turboflux/')) {
      return `src/${from.layer} imports published package "${spec}" — src/ IS the package source, use relative imports`
    }
    if (!PRODUCT_LAYERS.has(from.layer)) {
      if (to.kind === 'layer' && PRODUCT_LAYERS.has(to.layer)) {
        return `src/${from.layer} imports product layer src/${to.layer} — products (cli, server) are leaves, nothing below them may depend on them`
      }
      if (to.kind === 'app') {
        return `src/${from.layer} imports app "${to.app}" — apps are product shells on top of the kernel`
      }
    }
    if (FOUNDATION_LAYERS.has(from.layer) && to.kind === 'layer' && ORCHESTRATION_LAYERS.has(to.layer)) {
      return `foundation layer src/${from.layer} imports orchestration layer src/${to.layer} — dependencies must point downward`
    }
    return null
  }
  if (from.kind === 'app') {
    if (spec.startsWith('@turboflux/')) return null
    if (to.kind === 'layer') {
      return `apps/${from.app} reaches into src/${to.layer} via relative import — apps must consume the kernel through @turboflux/* package exports`
    }
    if (to.kind === 'package') {
      return `apps/${from.app} reaches into packages/${to.pkg} source — import the package by name instead`
    }
    if (to.kind === 'app' && to.app !== from.app) {
      return `apps/${from.app} imports sibling app "${to.app}" — apps must not share source`
    }
    return null
  }
  if (from.kind === 'package') {
    if (to.kind === 'layer') {
      return `packages/${from.pkg} imports repo src/${to.layer} — packages must stay independent of the workspace source tree`
    }
    if (to.kind === 'app') {
      return `packages/${from.pkg} imports app "${to.app}" — packages must stay independent of product shells`
    }
    if (to.kind === 'package' && to.pkg !== from.pkg) {
      return `packages/${from.pkg} imports sibling packages/${to.pkg} via relative path — use the package name and declare the dependency`
    }
    return null
  }
  return null
}

const files = walk(ROOT)
const violations = []
let edgeCount = 0
const zoneCounts = {}

for (const file of files) {
  const from = classify(file)
  if (from.kind === 'outside' || from.kind === 'src-root') continue
  zoneCounts[from.kind === 'layer' ? `packages/agent-core/src/${from.layer}` : from.kind === 'app' ? `apps/${from.app}` : `packages/${from.pkg}`] =
    (zoneCounts[from.kind === 'layer' ? `packages/agent-core/src/${from.layer}` : from.kind === 'app' ? `apps/${from.app}` : `packages/${from.pkg}`] || 0) + 1

  const source = readFileSync(file, 'utf8')
  const relativeFile = relative(ROOT, file).replaceAll('\\', '/')
  if (
    !STATIC_USER_ROOT_ALLOWLIST.has(relativeFile)
    && /homedir\s*\(\s*\)[\s\S]{0,120}['"]\.turboflux['"]/u.test(source)
  ) {
    violations.push(`${relativeFile}\n    static user storage root\n    → resolve user-owned paths through ActiveProfilePaths or ProfileStorageLayout`)
  }
  for (const spec of specifiersOf(source)) {
    const to = spec.startsWith('.')
      ? classify(resolve(dirname(file), spec))
      : spec.startsWith('@turboflux/')
        ? { kind: 'package-name', name: spec.split('/').slice(0, 2).join('/') }
        : null
    if (!to || to.kind === 'outside') continue
    if (to.kind === 'layer' && from.kind === 'layer' && to.layer === from.layer) continue
    if (to.kind === 'app' && from.kind === 'app' && to.app === from.app) continue
    edgeCount += 1
    const violation = evaluate(from, to, spec)
    if (violation) violations.push(`${relative(ROOT, file)}\n    import "${spec}"\n    → ${violation}`)
  }
}

if (violations.length) {
  process.stderr.write(`TurboFlux architecture boundary check failed (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n\n${violations.join('\n\n')}\n`)
  process.exitCode = 1
} else {
  const zones = Object.entries(zoneCounts).map(([zone, count]) => `${zone}(${count})`).join(' ')
  process.stdout.write(`TurboFlux architecture boundary check passed.\n  ${files.length} source files scanned, ${edgeCount} cross-layer import edges verified.\n  zones: ${zones}\n`)
}
