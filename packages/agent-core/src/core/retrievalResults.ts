import type { RetrievalResult } from '../shared/retrievalTypes'
import type { SearchContentPage, SearchFilesPage } from '../tools/executor'

export function fileSearchResult(page: Partial<SearchFilesPage> & { matches: string[] }, scope: string, query: string, relativePath: (path: string) => string): RetrievalResult {
  return {
    operation: 'search_files', scope, query,
    resources: page.matches.map(path => ({ path: relativePath(path), kind: 'file', state: 'found' })),
    total: page.totalMatches,
    totalIsExact: page.totalIsExact === true,
    truncated: page.truncated === true,
    nextOffset: page.nextOffset,
    warning: page.warning,
  }
}

export function contentSearchResult(page: SearchContentPage, scope: string, query: string, relativePath: (path: string) => string): RetrievalResult {
  return {
    operation: 'search_content', scope, query, outputMode: page.outputMode || 'content',
    resources: page.outputMode === 'files' || page.outputMode === 'count'
      ? (page.files || []).map(item => ({ path: relativePath(item.file), kind: 'file', state: 'matched', matchCount: item.count }))
      : page.hits.map(hit => ({
          path: relativePath(hit.file), kind: 'file', state: 'matched', line: hit.line, endLine: hit.endLine ?? hit.line,
          preview: [hit.text, hit.context].filter(Boolean).join('\n'), textTruncated: hit.textTruncated,
          lines: [
            ...hit.text.split('\n').map((text, offset) => ({ line: hit.line + offset, text, matched: true })),
            ...(hit.contextLines || []),
          ].sort((left, right) => left.line - right.line),
        })),
    total: page.totalMatches,
    totalIsExact: page.totalIsExact !== false,
    truncated: page.truncated,
    nextOffset: page.nextOffset,
    warning: page.warning,
  }
}

export function formatRetrievalResult(result: RetrievalResult): string {
  const count = result.resources.length
  const unit = result.outputMode === 'content' ? 'matching lines/blocks' : 'files'
  const total = result.total === undefined ? '' : ` of ${result.totalIsExact ? '' : 'at least '}${result.total}`
  const lines = [
    `Scope: ${result.scope || '.'}; query: ${JSON.stringify(result.query || '')}; mode: ${result.outputMode || 'files'}`,
    `${count === 0 ? 'No results in this page.' : `Returned ${count}${total} ${unit}.`}`,
  ]
  for (const resource of result.resources) {
    const location = resource.line ? `${resource.path}:${resource.line}` : resource.path
    lines.push(`${location}${resource.matchCount === undefined ? '' : `: ${resource.matchCount} matching lines/blocks`}${resource.preview ? `\n${resource.preview}` : ''}`)
    if (resource.textTruncated) lines.push('[Text preview shortened; read this file range for full text.]')
  }
  if (result.warning) lines.push(result.warning)
  if (result.nextOffset !== undefined) lines.push(`More results available. Keep the same query, scope and output_mode; continue with offset=${result.nextOffset}.`)
  else if (result.truncated) lines.push('Results are incomplete. Narrow the scope or query; absence is not established.')
  return lines.join('\n')
}
