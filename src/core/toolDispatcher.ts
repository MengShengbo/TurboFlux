/**
 * Tool dispatch context interface.
 *
 * The dispatchTool method in agentEngine.ts accesses many private fields.
 * Rather than extracting the entire switch statement (which would require
 * passing 15+ fields), we define a clean interface that the engine implements.
 * This enables future extraction when the tool count grows beyond 30.
 *
 * For now, this file provides shared helper formatters used by tool cases.
 */
import type { CodeMapNode, CodeSearchHit } from '../shared/codeIndexTypes'
import { toWorkspaceRelative } from './pathUtils'

// ============================================
// Code search result formatters
// ============================================

export function formatContentSearchResults(
  results: Array<{ file: string; startLine: number; endLine: number; line: number; snippet?: string; content: string }>,
  basePath?: string,
): string {
  const lines: string[] = []
  for (const result of results.slice(0, 50)) {
    const relPath = basePath ? toWorkspaceRelative(basePath, result.file) : result.file
    if (result.snippet) {
      lines.push(`${relPath}:${result.line}\n${result.snippet}\n`)
    } else {
      lines.push(`${relPath}:${result.line} | ${result.content}`)
    }
  }
  if (results.length > 50) {
    lines.push(`... ${results.length - 50} more results truncated`)
  }
  return lines.join('\n')
}

export function formatCodeSearchHits(hits: CodeSearchHit[]): string {
  if (!hits || hits.length === 0) return 'No matches found'
  const lines = hits.map(hit => {
    const loc = hit.startLine && hit.endLine ? `:${hit.startLine}-${hit.endLine}` : ''
    const score = typeof hit.score === 'number' ? ` (score=${hit.score.toFixed(2)})` : ''
    return `- ${hit.symbolKind || hit.source}: ${hit.title} @ ${hit.path}${loc}${score}\n  ${hit.subtitle || ''}`
  })
  return lines.join('\n')
}

export function formatCodeMap(node: CodeMapNode, depth = 0): string {
  const indent = '  '.repeat(depth)
  const anchor = node.path && typeof node.startLine === 'number' && typeof node.endLine === 'number'
    ? ` @ ${node.path}:${node.startLine}-${node.endLine}`
    : ''
  const score = typeof node.score === 'number' ? ` score=${node.score.toFixed(2)}` : ''
  const current = `${indent}- ${node.kind}: ${node.title}${anchor}${score}\n${indent}  ${node.summary}`
  const children = node.children.map(child => formatCodeMap(child, depth + 1))
  return [current, ...children].join('\n')
}

