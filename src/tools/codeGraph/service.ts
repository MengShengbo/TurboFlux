import { relative, resolve } from 'node:path'
import type CodeGraph from '@colbymchenry/codegraph'
import type { Node as GraphNode, NodeKind, Subgraph } from '@colbymchenry/codegraph'
import type { CodeMapNode, CodeSearchHit, CodeSymbolKind } from '../../shared/codeIndexTypes.js'

type CodeGraphConstructor = typeof CodeGraph

const initializationLocks = new Map<string, Promise<void>>()
const excludedPathSegments = new Set([
  '.git', '.claude', '.turboflux', '.codegraph', '.vscode', '.cache', '.next', '.turbo',
  'node_modules', 'vendor', 'venv', '.venv', 'dist', 'build', 'out', 'coverage', 'target', 'tmp', 'temp',
])

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function isWithinPath(filePath: string, requestedPath?: string): boolean {
  if (!requestedPath || requestedPath === '.') return true
  const prefix = normalizePath(requestedPath).replace(/^\.\//, '').replace(/\/$/, '')
  const candidate = normalizePath(filePath)
  return candidate === prefix || candidate.startsWith(`${prefix}/`)
}

function isSearchablePath(filePath: string): boolean {
  return !normalizePath(filePath).split('/').some(segment => excludedPathSegments.has(segment.toLowerCase()))
}

function toSymbolKind(kind: NodeKind): CodeSymbolKind | undefined {
  if (kind === 'class' || kind === 'function' || kind === 'interface' || kind === 'enum') return kind
  if (kind === 'method') return 'function'
  if (kind === 'type_alias' || kind === 'struct' || kind === 'trait') return 'type'
  if (kind === 'variable' || kind === 'constant' || kind === 'field') return 'constant'
  return undefined
}

function toSearchHit(node: GraphNode, score: number): CodeSearchHit {
  const symbolKind = toSymbolKind(node.kind)
  return {
    id: node.id,
    path: normalizePath(node.filePath),
    title: node.name,
    subtitle: node.signature || node.qualifiedName,
    line: node.startLine,
    startLine: node.startLine,
    endLine: node.endLine,
    score,
    source: 'symbol',
    symbolId: node.id,
    symbolName: node.name,
    symbolKind,
    preview: [node.kind, node.signature || node.qualifiedName].filter(Boolean).join(' '),
  }
}

function graphNodeToMapNode(
  graph: CodeGraph,
  node: GraphNode,
  depth: number,
  relation?: 'caller' | 'callee',
  ancestors: ReadonlySet<string> = new Set(),
): CodeMapNode {
  const visited = new Set(ancestors)
  visited.add(node.id)
  const callers = depth > 0
    ? graph.getCallers(node.id, 1).map(item => ({ ...item, relation: 'caller' as const }))
    : []
  const callees = depth > 0
    ? graph.getCallees(node.id, 1).map(item => ({ ...item, relation: 'callee' as const }))
    : []
  const relations = Array.from({ length: Math.max(callers.length, callees.length) })
    .flatMap((_, index) => [callers[index], callees[index]])
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  const children = relations
    .filter(item => isSearchablePath(item.node.filePath))
    .filter(item => !visited.has(item.node.id))
    .filter((relation, index, all) => all.findIndex(item => item.node.id === relation.node.id) === index)
    .slice(0, 6)
    .map(item => graphNodeToMapNode(graph, item.node, depth - 1, item.relation, visited))
  return {
    id: node.id,
    kind: 'symbol',
    title: node.name,
    summary: `${relation ? `[${relation}] ` : ''}${node.kind}${node.signature ? ` ${node.signature}` : ''}`,
    path: normalizePath(node.filePath),
    line: node.startLine,
    startLine: node.startLine,
    endLine: node.endLine,
    score: children.length,
    children,
  }
}

function graphQueryTokens(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])
    .filter(token => !['and', 'for', 'from', 'into', 'the', 'this', 'trace', 'with'].includes(token)))]
    .slice(0, 12)
}

function graphRootRelevance(node: GraphNode, tokens: readonly string[]): number {
  const title = node.name.toLowerCase()
  const qualifiedName = (node.qualifiedName || '').toLowerCase()
  const signature = (node.signature || '').toLowerCase()
  const path = normalizePath(node.filePath).toLowerCase()
  return tokens.reduce((score, token) => score
    + (title === token ? 12 : title.includes(token) ? 7 : 0)
    + (qualifiedName.includes(token) ? 4 : 0)
    + (signature.includes(token) ? 2 : 0)
    + (path.includes(token) ? 3 : 0), 0)
}

function subgraphRoots(subgraph: Subgraph): GraphNode[] {
  const roots = subgraph.roots
    .map(id => subgraph.nodes.get(id))
    .filter((node): node is GraphNode => Boolean(node && node.kind !== 'file'))
  if (roots.length > 0) return roots
  return Array.from(subgraph.nodes.values()).filter(node => node.kind !== 'file').slice(0, 12)
}

export class CodeGraphService {
  private constructor(private readonly CodeGraphClass: CodeGraphConstructor) {}

  static async load(): Promise<CodeGraphService> {
    const imported = await import('@colbymchenry/codegraph') as unknown as {
      CodeGraph?: CodeGraphConstructor
      default?: CodeGraphConstructor | { CodeGraph?: CodeGraphConstructor; default?: CodeGraphConstructor }
      'module.exports'?: { CodeGraph?: CodeGraphConstructor; default?: CodeGraphConstructor }
    }
    const defaultExport = imported.default
    const wrappedDefault = typeof defaultExport === 'object' ? defaultExport : undefined
    const CodeGraphClass = imported.CodeGraph
      || wrappedDefault?.CodeGraph
      || wrappedDefault?.default
      || (typeof defaultExport === 'function' ? defaultExport : undefined)
      || imported['module.exports']?.CodeGraph
      || imported['module.exports']?.default
    if (!CodeGraphClass) throw new Error('CodeGraph SDK is unavailable')
    return new CodeGraphService(CodeGraphClass)
  }

  async searchSymbols(params: {
    workspacePath: string
    query: string
    path?: string
    kind?: string
    limit: number
  }): Promise<CodeSearchHit[]> {
    return this.withGraph(params.workspacePath, graph => {
      const requestedKinds = params.kind ? [params.kind] : []
      const raw = graph.searchNodes(params.query, { limit: Math.max(params.limit * 4, 24) })
        .filter(result => result.node.kind !== 'file')
        .filter(result => isSearchablePath(result.node.filePath))
        .filter(result => isWithinPath(result.node.filePath, params.path))
        .filter(result => requestedKinds.length === 0 || requestedKinds.includes(toSymbolKind(result.node.kind) || result.node.kind))
        .slice(0, params.limit)
      const maxScore = Math.max(...raw.map(result => result.score), 1)
      return raw.map(result => toSearchHit(result.node, result.score / maxScore))
    })
  }

  async prepare(workspacePath: string): Promise<void> {
    await this.startInitialization(resolve(workspacePath))
  }

  async getCodeMap(params: {
    workspacePath: string
    query?: string
    path?: string
    targetPaths?: string[]
    depth: number
    maxPaths: number
  }): Promise<{ map: CodeMapNode[]; relatedPaths: string[] }> {
    return this.withGraph(params.workspacePath, async graph => {
      const query = params.query?.trim() || params.path || params.targetPaths?.join(' ') || 'architecture entry point'
      const subgraph = await graph.findRelevantContext(query, {
        searchLimit: Math.max(5, params.maxPaths),
        traversalDepth: Math.max(1, params.depth),
        maxNodes: Math.max(24, params.maxPaths * 8),
      })
      const requestedPaths = params.targetPaths?.length ? params.targetPaths : params.path ? [params.path] : []
      const queryTokens = graphQueryTokens(query)
      const roots = subgraphRoots(subgraph)
        .filter(node => isSearchablePath(node.filePath))
        .filter(node => requestedPaths.length === 0 || requestedPaths.some(path => isWithinPath(node.filePath, path)))
        .sort((left, right) => graphRootRelevance(right, queryTokens) - graphRootRelevance(left, queryTokens)
          || left.filePath.localeCompare(right.filePath)
          || left.startLine - right.startLine)
        .slice(0, params.maxPaths)
      return {
        map: roots.map(node => graphNodeToMapNode(graph, node, Math.min(params.depth, 2))),
        relatedPaths: Array.from(new Set(Array.from(subgraph.nodes.values()).map(node => normalizePath(node.filePath)))).slice(0, 80),
      }
    })
  }

  private async withGraph<T>(workspacePath: string, operation: (graph: CodeGraph) => T | Promise<T>): Promise<T> {
    const root = resolve(workspacePath)
    await this.ensureInitialized(root)
    const graph = await this.CodeGraphClass.open(root, { sync: true })
    try {
      return await operation(graph)
    } finally {
      graph.close()
    }
  }

  private async ensureInitialized(root: string): Promise<void> {
    if (initializationLocks.has(root)) throw new Error('CodeGraph warmup continues in the background')
    if (this.CodeGraphClass.isInitialized(root)) return
    void this.startInitialization(root).catch(() => {})
    throw new Error('CodeGraph warmup started in the background')
  }

  private startInitialization(root: string): Promise<void> {
    const active = initializationLocks.get(root)
    if (active) return active
    if (this.CodeGraphClass.isInitialized(root)) return Promise.resolve()
    let initialization: Promise<void>
    initialization = this.CodeGraphClass.init(root, { index: true })
      .then(graph => graph.close())
      .finally(() => {
        if (initializationLocks.get(root) === initialization) initializationLocks.delete(root)
      })
    initializationLocks.set(root, initialization)
    return initialization
  }
}
