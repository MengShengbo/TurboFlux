import type { CodeMapNode } from '../shared/codeIndexTypes'
import type { ToolExecutor } from '../tools/executor'

export interface ContextMapsPrimer {
  text: string
  confidence: number
  nodes: number
  relationships: number
  paths: number
  elapsedMs: number
}

export interface ContextMapsBuildResult {
  status: 'on' | 'unavailable'
  elapsedMs: number
  primer?: ContextMapsPrimer
}

const QUERY_STOP_WORDS = new Set([
  'about', 'after', 'before', 'could', 'does', 'from', 'have', 'into', 'should', 'that', 'their',
  'there', 'these', 'this', 'when', 'where', 'which', 'with', 'would',
])

function flattenMap(nodes: readonly CodeMapNode[]): CodeMapNode[] {
  const flattened: CodeMapNode[] = []
  const visit = (node: CodeMapNode): void => {
    flattened.push(node)
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return flattened
}

function objectiveTokens(objective: string): string[] {
  return [...new Set((objective.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])
    .filter(token => !QUERY_STOP_WORDS.has(token)))]
    .slice(0, 16)
}

export function scoreContextMap(nodes: readonly CodeMapNode[], objective: string): {
  confidence: number
  nodes: number
  relationships: number
  paths: number
} {
  const flattened = flattenMap(nodes)
  const relationships = flattened.filter(node => /^\[(?:caller|callee)\]/i.test(node.summary)).length
  const paths = new Set(flattened.map(node => node.path).filter((path): path is string => Boolean(path))).size
  const tokens = objectiveTokens(objective)
  const searchable = nodes
    .map(node => `${node.title} ${node.summary} ${node.path || ''}`.toLowerCase())
    .join('\n')
  const matchedTokens = tokens.filter(token => searchable.includes(token)).length
  const rootSignal = Math.min(1, nodes.filter(node => node.kind === 'symbol' && node.path).length / 4)
  const relationshipSignal = flattened.length > 0 ? Math.min(1, relationships / flattened.length) : 0
  const pathSignal = Math.min(1, paths / 6)
  const lexicalSignal = tokens.length > 0 ? Math.min(1, matchedTokens / Math.min(tokens.length, 4)) : 0
  const confidence = Math.min(0.99, 0.35
    + rootSignal * 0.12
    + relationshipSignal * 0.15
    + pathSignal * 0.08
    + lexicalSignal * 0.25)
  return {
    confidence: Number(confidence.toFixed(2)),
    nodes: flattened.length,
    relationships,
    paths,
  }
}

function formatNode(node: CodeMapNode, depth = 0): string[] {
  const indent = '  '.repeat(depth)
  const location = node.path ? ` ${node.path}${node.line ? `:${node.line}` : ''}` : ''
  const line = `${indent}- ${node.title}${location} | ${node.summary}`
  return [line, ...node.children.flatMap(child => formatNode(child, depth + 1))]
}

export function formatContextMap(nodes: readonly CodeMapNode[], confidence: number): string {
  return [
    `<context_maps confidence="${confidence.toFixed(2)}" authority="static_graph_hypotheses">`,
    'Use these symbol and call relationships to prioritize exploration. They are not edit evidence: read every submitted file range before relying on it.',
    ...nodes.flatMap(node => formatNode(node)),
    '</context_maps>',
  ].join('\n').slice(0, 12_000)
}

export async function buildContextMapsPrimer(params: {
  workspacePath: string
  objective: string
  toolExecutor: ToolExecutor
  waitForGraphMs?: number
}): Promise<ContextMapsBuildResult> {
  const startedAt = Date.now()
  if (typeof params.toolExecutor.getCodeMap !== 'function') {
    return { status: 'unavailable', elapsedMs: Date.now() - startedAt }
  }
  try {
    const response = await params.toolExecutor.getCodeMap({
      workspacePath: params.workspacePath,
      query: params.objective,
      depth: 1,
      maxPaths: 6,
      preferGraph: true,
      graphOnly: true,
      waitForGraphMs: params.waitForGraphMs ?? 1_800,
    }) as {
      success: boolean
      data?: { map?: CodeMapNode[] | CodeMapNode; source?: string }
    }
    const rawMap = response.data?.map
    const nodes = rawMap ? (Array.isArray(rawMap) ? rawMap : [rawMap]) : []
    if (!response.success || response.data?.source !== 'graph' || nodes.length === 0) {
      return { status: 'unavailable', elapsedMs: Date.now() - startedAt }
    }
    const assessment = scoreContextMap(nodes, params.objective)
    if (assessment.confidence < 0.55) {
      return { status: 'unavailable', elapsedMs: Date.now() - startedAt }
    }
    const elapsedMs = Date.now() - startedAt
    return {
      status: 'on',
      elapsedMs,
      primer: {
        text: formatContextMap(nodes, assessment.confidence),
        ...assessment,
        elapsedMs,
      },
    }
  } catch {
    return { status: 'unavailable', elapsedMs: Date.now() - startedAt }
  }
}
