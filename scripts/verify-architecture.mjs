import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { readWorkspaces, orderedPackages, repositoryRoot } from './workspace-packages.mjs'

// Includes type-only edges: package ownership is explicit and dependencies point down.
export const packageDependencies = {
  contracts: [], platform: [], renderer: ['presentation'],
  models: ['contracts', 'platform'],
  tools: ['contracts', 'platform'],
  extensions: ['contracts', 'platform'],
  presentation: ['contracts'],
  'agent-runtime': ['contracts', 'platform', 'models', 'tools', 'extensions', 'presentation'],
  conversations: ['contracts', 'platform', 'models', 'agent-runtime', 'presentation'],
  profiles: ['platform', 'conversations'],
  automations: ['contracts', 'platform'],
  workbench: ['contracts', 'platform', 'models', 'tools', 'extensions', 'presentation', 'agent-runtime', 'conversations', 'profiles', 'automations'],
  'remote-protocol': [],
  'agent-core': ['models', 'platform', 'tools', 'contracts', 'agent-runtime', 'conversations', 'extensions', 'presentation', 'workbench'],
}
const browserPackages = new Set(['contracts', 'presentation', 'renderer'])
const builtin = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
const skipped = new Set(['node_modules', 'dist', 'generated', 'build', 'release', 'coverage', '.git'])

export function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (skipped.has(entry.name)) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx|mjs|cjs|mts|cts)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [path] : []
  })
}

export function moduleReferences(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const references = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings || node.exportClause
      const typeOnly = node.isTypeOnly || clause?.isTypeOnly || Boolean(!clause?.name && bindings?.elements?.length && bindings.elements.every(item => item.isTypeOnly))
      references.push({ specifier: node.moduleSpecifier.text, typeOnly })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      references.push({ specifier: node.argument.literal.text, typeOnly: true })
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      references.push({ specifier: node.arguments[0].text, typeOnly: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return references
}

export function verifyArchitecture(root = repositoryRoot) {
  const workspaces = readWorkspaces(root)
  const byName = new Map(workspaces.map(entry => [entry.manifest.name, entry]))
  const failures = []
  let edges = 0, count = 0
  try { orderedPackages(workspaces) } catch (error) { failures.push(error.message) }
  for (const workspace of workspaces) {
    const { directory, manifest, kind } = workspace
    const packageId = manifest.name.replace('@turboflux/', '')
    if (kind === 'packages' && !packageDependencies[packageId]) failures.push(`Unclassified package: ${manifest.name}`)
    for (const dependency of Object.keys(manifest.dependencies || {})) {
      if (kind === 'packages' && dependency.startsWith('@turboflux/') && !packageDependencies[packageId]?.includes(dependency.replace('@turboflux/', ''))) failures.push(`${manifest.name}: forbidden dependency ${dependency}`)
    }
    const sourceRoot = kind === 'packages' ? join(directory, 'src') : directory
    for (const file of sourceFiles(sourceRoot)) {
      count++
      const source = readFileSync(file, 'utf8'), label = relative(root, file)
      if (packageId === 'agent-core' && ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true).statements.some(statement => !ts.isExportDeclaration(statement))) failures.push(`${label}: compatibility facade must contain exports only`)
      if (!['packages/platform/src/profilePaths.ts', 'apps/desktop/main.mjs'].includes(label.replaceAll('\\', '/')) && /homedir\s*\(\s*\)[\s\S]{0,120}['"]\.turboflux['"]/.test(source)) failures.push(`${label}: resolve user storage through ActiveProfilePaths or ProfileStorageLayout`)
      for (const { specifier, typeOnly } of moduleReferences(file, source)) {
        edges++
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier)
          if (relative(directory, target).startsWith('..') && !(kind === 'apps' && relative(root, target).replaceAll('\\', '/').startsWith('scripts/'))) failures.push(`${label}: relative import crosses workspace boundary: ${specifier}`)
          continue
        }
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        const isNode = specifier.startsWith('node:') || builtin.has(name)
        if (browserPackages.has(packageId) && (isNode || name === 'electron')) failures.push(`${label}: browser package imports ${specifier}`)
        if (label.replaceAll('\\', '/').startsWith('apps/desktop/renderer/') && !typeOnly && (isNode || name.startsWith('@turboflux/') && !browserPackages.has(name.replace('@turboflux/', '')))) failures.push(`${label}: renderer runtime imports host module ${specifier}`)
        if (isNode) continue
        if (name !== manifest.name && !manifest.dependencies?.[name] && !manifest.devDependencies?.[name]) failures.push(`${label}: undeclared dependency ${name}`)
        if (!name.startsWith('@turboflux/')) continue
        const target = byName.get(name)
        if (!target) { failures.push(`${label}: unknown workspace ${name}`); continue }
        if (target.kind === 'apps' && target !== workspace) failures.push(`${label}: imports application ${name}`)
        if (name === '@turboflux/agent-core' && manifest.name !== name) failures.push(`${label}: use domain packages instead of the compatibility facade`)
        const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
        if (!target.manifest.exports?.[subpath]) failures.push(`${label}: package does not export ${specifier}`)
      }
    }
  }
  return { failures, files: count, edges }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyArchitecture()
  if (result.failures.length) { console.error(`Package boundary check failed:\n${result.failures.join('\n')}`); process.exitCode = 1 }
  else console.log(`Package boundaries passed: ${result.files} files, ${result.edges} imports; no cycles, undeclared dependencies or browser/host leaks.`)
}
