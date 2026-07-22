import { isAbsolute, relative } from 'node:path'
import type { CodeSearchHit } from '../shared/codeIndexTypes'
import type { SubAgentEvidence } from '../shared/subAgentTypes'
import type { SearchContentHit, ToolExecutor } from '../tools/executor'

export interface FastContextPrimerQueries {
  symbols: string[]
  filePatterns: string[]
  contentPatterns: string[]
  structuralSignals: string[]
  behavioralSignals: string[]
}

export interface FastContextRetrievalPrimer {
  text?: string
  calls: number
  readCalls: number
  candidatePaths: string[]
  seedEvidence: SubAgentEvidence[]
  queries: FastContextPrimerQueries
}

interface PrimerHit {
  path: string
  line: string
  lineNumber?: number
  source: 'symbol' | 'filename' | 'content'
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'always', 'argument', 'before', 'behavior', 'behaviour', 'current',
  'description', 'feature', 'function', 'issue', 'option', 'proposal', 'response', 'should', 'support',
  'their', 'there', 'these', 'this', 'value', 'values', 'when', 'where', 'which', 'with', 'would',
])

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte)$/i

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
    if (result.length >= limit) break
  }
  return result
}

function regexPhrase(value: string): string {
  return value
    .trim()
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_.-]*')
}

function relativePath(workspacePath: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (!isAbsolute(filePath)) return normalized.replace(/^\.\//, '')
  const workspaceRelative = relative(workspacePath, filePath).replace(/\\/g, '/')
  return workspaceRelative.startsWith('../') ? normalized : workspaceRelative
}

function parentDirectories(path: string): string[] {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = normalized.split('/')
  if (parts.length < 2) return []
  const directory = parts.slice(0, -1).join('/')
  const parent = parts.length > 2 ? parts.slice(0, -2).join('/') : ''
  return [directory, parent].filter(value => value && value !== '.')
}

function titleWords(objective: string): string[] {
  const title = objective.split(/\r?\n/, 1)[0]
  return unique((title.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
    .map(word => word === 'multiple' ? 'multi' : word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .filter(word => !STOP_WORDS.has(word)), 8)
}

export function buildFastContextPrimerQueries(objective: string): FastContextPrimerQueries {
  const title = objective.split(/\r?\n/, 1)[0]
  const focusedObjective = `${title}\n${objective.slice(0, 2_400)}`
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
  const inlineCode = [...focusedObjective.matchAll(/`([^`\r\n]{2,80})`/g)]
    .map(match => match[1].trim())
    .filter(value => !value.startsWith('```') && !/[<>]{2}|\s{3,}/.test(value))
  const flags = focusedObjective.match(/--[a-z][a-z0-9-]*(?:=[^\s`]+)?/gi) || []
  const dottedIdentifiers = focusedObjective.match(/\b[A-Za-z_$][\w$]*(?:[._-][A-Za-z_$][\w$]*)+\b/g) || []
  const symbols = unique([
    ...(focusedObjective.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || [])
      .filter(token => /[a-z][A-Z]|_|[A-Z].*[A-Z]/.test(token)),
    ...dottedIdentifiers.flatMap(value => value.split(/[.-]/)).filter(value => /^[A-Za-z_$][\w$]{3,}$/.test(value)),
  ], 8)
  const words = titleWords(objective)
  const filePatterns = unique(words.slice(0, -1).flatMap((word, index) => {
    const next = words[index + 1]
    return [`**/*${word}*${next}*.*`, `**/*${word}${next}*.*`]
  }), 8)
  const structuralSignals = unique([
    ...inlineCode,
    ...flags.flatMap(flag => [flag, flag.replace(/^--/, '').replace(/=.*/, '')]),
    ...dottedIdentifiers,
    ...symbols,
  ], 10)
  const behavioralSignals = unique([
    ...words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`),
    words.join(' '),
  ], 6)
  const contentPatterns = unique([
    ...structuralSignals.slice(0, 6).map(regexPhrase),
    ...behavioralSignals.map(regexPhrase),
  ].filter(pattern => pattern.length >= 4), 12)
  return { symbols, filePatterns, contentPatterns, structuralSignals, behavioralSignals }
}

function normalizeSymbolHits(workspacePath: string, query: string, hits: CodeSearchHit[]): PrimerHit[] {
  return hits.slice(0, 8).map(hit => ({
    path: relativePath(workspacePath, hit.path),
    line: `symbol[${query}] ${relativePath(workspacePath, hit.path)}:${hit.line || hit.startLine || 1} ${hit.title}`,
    lineNumber: hit.line || hit.startLine || 1,
    source: 'symbol',
  }))
}

function normalizeContentHits(workspacePath: string, query: string, hits: SearchContentHit[]): PrimerHit[] {
  const seenPaths = new Set<string>()
  const selected: PrimerHit[] = []
  for (const hit of hits) {
    const path = relativePath(workspacePath, hit.file)
    const key = path.toLowerCase()
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    selected.push({
      path,
      line: `content[${query}] ${path}:${hit.line} ${hit.text.replace(/\s+/g, ' ').trim().slice(0, 180)}`,
      lineNumber: hit.line,
      source: 'content',
    })
    if (selected.length >= 8) break
  }
  return selected
}

export async function buildFastContextRetrievalPrimer(params: {
  workspacePath: string
  objective: string
  toolExecutor: ToolExecutor
}): Promise<FastContextRetrievalPrimer> {
  const queries = buildFastContextPrimerQueries(params.objective)
  const tasks: Array<Promise<PrimerHit[]>> = [
    ...queries.symbols.map(async query => {
      const result = await params.toolExecutor.searchCodeSymbols({ workspacePath: params.workspacePath, query, limit: 8 })
      return result.success ? normalizeSymbolHits(params.workspacePath, query, (result.data || []) as CodeSearchHit[]) : []
    }),
    ...queries.filePatterns.map(async pattern => {
      const result = await params.toolExecutor.searchFiles(pattern, params.workspacePath)
      return result.success ? (result.data?.matches || []).slice(0, 8).map(path => {
        const workspaceRelative = relativePath(params.workspacePath, path)
        return { path: workspaceRelative, line: `filename[${pattern}] ${workspaceRelative}`, source: 'filename' as const }
      }) : []
    }),
    ...queries.contentPatterns.map(async pattern => {
      const result = params.toolExecutor.searchContentPage
        ? await params.toolExecutor.searchContentPage(pattern, params.workspacePath, undefined, true, { limit: 24 })
        : await params.toolExecutor.searchContent(pattern, params.workspacePath, undefined, true)
      const hits = Array.isArray(result.data) ? result.data : result.data?.hits || []
      return result.success ? normalizeContentHits(params.workspacePath, pattern, hits) : []
    }),
  ]
  if (tasks.length === 0) return { calls: 0, readCalls: 0, candidatePaths: [], seedEvidence: [], queries }
  const settled = await Promise.allSettled(tasks)
  const initialHits = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const directoryScores = new Map<string, number>()
  for (const hit of initialHits) {
    const weight = hit.source === 'content' ? 3 : hit.source === 'symbol' ? 2 : 1
    for (const directory of parentDirectories(hit.path)) {
      directoryScores.set(directory, (directoryScores.get(directory) || 0) + weight)
    }
  }
  const directSourceDirectories = unique(initialHits
    .filter(hit => hit.source === 'content' && SOURCE_FILE.test(hit.path))
    .filter(hit => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples)(?:\/|$)/i.test(hit.path))
    .flatMap(hit => parentDirectories(hit.path)), 8)
  const familyDirectories = unique([
    ...directSourceDirectories,
    ...[...directoryScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
      .map(([directory]) => directory),
  ], 10)
  const familyTasks = familyDirectories.map(async directory => {
    const [directResult, nestedResult] = await Promise.all([
      params.toolExecutor.searchFiles(`${directory}/*`, params.workspacePath),
      params.toolExecutor.searchFiles(`${directory}/*/*`, params.workspacePath),
    ])
    const matches = [
      ...(directResult.success ? directResult.data?.matches || [] : []),
      ...(nestedResult.success ? nestedResult.data?.matches || [] : []),
    ]
    return unique(matches
      .map(path => relativePath(params.workspacePath, path))
      .filter(path => SOURCE_FILE.test(path) && !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(path))
      .map(path => `family[${directory}] ${path}`), 32)
  })
  const familySettled = await Promise.allSettled(familyTasks)
  const familyLines = unique(familySettled.flatMap(result => result.status === 'fulfilled' ? result.value : []), 160)
  const hitLines = unique(initialHits.map(hit => hit.line), 80)
  const candidatePaths = unique([
    ...initialHits.map(hit => hit.path),
    ...familyLines.map(line => line.replace(/^family\[[^\]]+\]\s+/, '')),
  ], 200)
  const pathSignals = new Map<string, { path: string; score: number; sources: Set<PrimerHit['source']>; lines: number[] }>()
  for (const hit of initialHits) {
    if (!SOURCE_FILE.test(hit.path) || /(?:^|\/)(?:docs?|documentation|test|tests|__tests__)(?:\/|$)/i.test(hit.path)) continue
    const key = hit.path.toLowerCase()
    const current = pathSignals.get(key) || { path: hit.path, score: 0, sources: new Set(), lines: [] }
    current.sources.add(hit.source)
    current.score += hit.source === 'content' ? 3 : hit.source === 'symbol' ? 3 : 2
    if (hit.lineNumber && hit.lineNumber > 0) current.lines.push(hit.lineNumber)
    pathSignals.set(key, current)
  }
  const seedPaths = [...pathSignals.values()]
    .filter(item => item.sources.size >= 2 || item.score >= 4)
    .sort((left, right) => right.sources.size - left.sources.size || right.score - left.score)
    .slice(0, 8)
  const seedResults = await Promise.allSettled(seedPaths.map(async item => {
    const anchor = item.lines.length > 0 ? Math.min(...item.lines) : 1
    const offset = Math.max(0, anchor - 61)
    const limit = 280
    const rangeResult = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(item.path, offset, limit, 96_000)
      : undefined
    if (rangeResult?.success && rangeResult.data?.content) {
      return {
        path: item.path,
        startLine: rangeResult.data.startLine,
        endLine: rangeResult.data.endLine,
        preview: rangeResult.data.content.split('\n').slice(0, 12).join('\n'),
        content: rangeResult.data.content.slice(0, 24_000),
        reason: 'file read',
      } satisfies SubAgentEvidence
    }
    const fileResult = await params.toolExecutor.readFile(item.path)
    if (!fileResult.success || !fileResult.data) return undefined
    const lines = String(fileResult.data).split('\n').slice(offset, offset + limit)
    return {
      path: item.path,
      startLine: offset + 1,
      endLine: offset + lines.length,
      preview: lines.slice(0, 12).join('\n'),
      content: lines.join('\n').slice(0, 24_000),
      reason: 'file read',
    } satisfies SubAgentEvidence
  }))
  const seedEvidence = seedResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const seedLines = seedEvidence.map(item => `${item.path}:${item.startLine}-${item.endLine}\n${(item.content || item.preview).slice(0, 1_400)}`)
  const sections = [
    queries.structuralSignals.length > 0 ? `Structural query signals:\n${queries.structuralSignals.map(value => `- ${value}`).join('\n')}` : '',
    queries.behavioralSignals.length > 0 ? `Behavioral query signals:\n${queries.behavioralSignals.map(value => `- ${value}`).join('\n')}` : '',
    hitLines.length > 0 ? `Multi-route retrieval candidates:\n${hitLines.join('\n')}` : '',
    familyLines.length > 0 ? `Implementation-family census (filenames only; inspect relevance before reading):\n${familyLines.join('\n')}` : '',
    seedLines.length > 0 ? `High-confidence read-confirmed source seeds:\n${seedLines.join('\n---\n')}` : '',
  ].filter(Boolean)
  return {
    calls: tasks.length + familyTasks.length * 2 + seedPaths.length,
    readCalls: seedPaths.length,
    candidatePaths,
    seedEvidence,
    queries,
    text: sections.length > 0 ? sections.join('\n\n').slice(0, 48_000) : undefined,
  }
}
