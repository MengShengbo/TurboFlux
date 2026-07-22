import { isAbsolute, relative } from 'node:path'
import type { SubAgentEvidence } from '../shared/subAgentTypes'
import type { SearchContentHit, ToolExecutor } from '../tools/executor'

export interface FastContextPrimerQueries {
  symbols: string[]
  pathHints: string[]
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
  source: 'symbol' | 'filename' | 'content' | 'explicit'
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'always', 'an', 'and', 'argument', 'before', 'behavior', 'behaviour', 'current',
  'description', 'feature', 'function', 'issue', 'option', 'proposal', 'response', 'should', 'support',
  'the', 'their', 'there', 'these', 'this', 'value', 'values', 'when', 'where', 'whether', 'which', 'with', 'would',
])

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte)$/i
const SOURCE_FILE_GLOB = '*.{ts,tsx,js,jsx,mjs,cjs,py,pyi,rs,go,java,kt,kts,cs,c,cc,cpp,cxx,h,hpp,swift,scala,rb,php,vue,svelte}'

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

function firstPartyImportPatterns(evidence: SubAgentEvidence[], candidatePaths: string[]): string[] {
  const knownPaths = candidatePaths.map(path => path.replace(/\\/g, '/').toLowerCase())
  const scored = new Map<string, number>()
  for (const item of evidence) {
    const path = item.path.replace(/\\/g, '/')
    const content = item.content || item.preview || ''
    if (/\.py$/i.test(path)) {
      for (const match of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)/gm)) {
        const moduleName = match[1]
        const modulePath = moduleName.replace(/\./g, '/')
        const root = modulePath.split('/')[0].toLowerCase()
        if (!knownPaths.some(candidate => candidate === `${root}.py` || candidate.startsWith(`${root}/`) || candidate.includes(`/${root}/`))) continue
        const basename = modulePath.slice(modulePath.lastIndexOf('/') + 1)
        const references = content.match(new RegExp(`\\b${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'))?.length || 1
        for (const pattern of [`${modulePath}.py`, `${modulePath}/__init__.py`, `**/${modulePath}.py`, `**/${modulePath}/__init__.py`]) {
          scored.set(pattern, Math.max(scored.get(pattern) || 0, references))
        }
      }
    }
    if (/\.[cm]?[jt]sx?$/i.test(path)) {
      const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      for (const match of content.matchAll(/(?:from\s+|require\s*\(|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g)) {
        const relativeImport = match[1]
        const parts = `${directory}/${relativeImport}`.split('/')
        const resolved: string[] = []
        for (const part of parts) {
          if (!part || part === '.') continue
          if (part === '..') resolved.pop()
          else resolved.push(part)
        }
        const base = resolved.join('/').replace(/\.[cm]?[jt]sx?$/i, '')
        if (!base) continue
        const references = content.split(relativeImport).length - 1
        scored.set(`${base}.{ts,tsx,js,jsx,mjs,cjs}`, Math.max(scored.get(`${base}.{ts,tsx,js,jsx,mjs,cjs}`) || 0, references))
        scored.set(`${base}/index.{ts,tsx,js,jsx,mjs,cjs}`, Math.max(scored.get(`${base}/index.{ts,tsx,js,jsx,mjs,cjs}`) || 0, references))
      }
    }
  }
  return [...scored.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([pattern]) => pattern)
}

function titleWords(objective: string): string[] {
  const title = objective.split(/\r?\n/, 1)[0]
  return unique((title.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
    .map(word => word === 'multiple' ? 'multi' : word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .filter(word => !STOP_WORDS.has(word)), 8)
}

function identifierVariants(value: string): string[] {
  const parts = value.split(/[_-]+/).filter(Boolean)
  if (parts.length < 2) return [value]
  return [
    `${parts[0]}${parts.slice(1).map(part => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`).join('')}`,
    value,
  ]
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
  const callAndAnnotationSymbols = [...focusedObjective.matchAll(/(?:@|\b)([A-Za-z_$][\w$]{2,})(?=\s*\()/g)]
    .map(match => match[1])
    .concat([...focusedObjective.matchAll(/@([A-Za-z_$][\w$]{2,})/g)].map(match => match[1]))
  const rawSymbols = [
    ...callAndAnnotationSymbols,
    ...(focusedObjective.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || [])
      .filter(token => /[a-z][A-Z]|_|[A-Z].*[A-Z]/.test(token)),
    ...dottedIdentifiers.flatMap(value => value.split(/[.-]/)).filter(value => /^[A-Za-z_$][\w$]{3,}$/.test(value)),
  ]
  const symbols = unique(rawSymbols.flatMap(identifierVariants), 10)
  const pathHints = unique((focusedObjective.match(/(?:[A-Za-z0-9_.-]+[\\/]){1,}[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte|rst|md)/gi) || [])
    .map(path => path.replace(/\\/g, '/').replace(/^\/+/, ''))
    .map(path => path.includes('site-packages/') ? path.slice(path.indexOf('site-packages/') + 'site-packages/'.length) : path), 8)
  const words = titleWords(objective)
  const filePatterns = unique([
    ...pathHints.flatMap(path => [`**/${path}`, `**/${path.split('/').slice(-2).join('/')}`]),
    ...words.slice(0, -1).flatMap((word, index) => {
      const next = words[index + 1]
      const camel = `${word}${next[0]?.toUpperCase() || ''}${next.slice(1)}`
      return [`**/*${word}*${next}*.*`, `**/*${camel}*/**`, `**/*${word}*${next}*/**`, `**/*${word}${next}*.*`]
    }),
  ], 10)
  const structuralSignals = unique([
    ...flags.flatMap(flag => [flag, flag.replace(/^--/, '').replace(/=.*/, '')]),
    ...symbols,
    ...dottedIdentifiers,
    ...inlineCode,
  ], 10)
  const behavioralSignals = unique([
    ...words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`),
    words.join(' '),
  ], 6)
  const contentPatterns = unique([
    ...structuralSignals.slice(0, 6).map(regexPhrase),
    ...behavioralSignals.map(regexPhrase),
  ].filter(pattern => pattern.length >= 4), 12)
  return { symbols, pathHints, filePatterns, contentPatterns, structuralSignals, behavioralSignals }
}

function normalizeContentHits(workspacePath: string, query: string, hits: SearchContentHit[], limit = 8): PrimerHit[] {
  const seenPaths = new Set<string>()
  const selected: PrimerHit[] = []
  const sourcePriority = (path: string): number => {
    const normalized = path.replace(/\\/g, '/').toLowerCase()
    if (/(?:^|\/)(?:test|tests|__tests__|testing)(?:\/|$)|(?:\.(?:test|spec)\.)/.test(normalized)) return 0
    if (/(?:^|\/)(?:docs?|documentation|examples?)(?:\/|$)|\.md$|\.rst$/.test(normalized)) return 1
    return 2
  }
  const rankedHits = [...hits].sort((left, right) => sourcePriority(right.file) - sourcePriority(left.file))
  for (const hit of rankedHits) {
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
    if (selected.length >= limit) break
  }
  return selected
}

export async function buildFastContextRetrievalPrimer(params: {
  workspacePath: string
  objective: string
  toolExecutor: ToolExecutor
}): Promise<FastContextRetrievalPrimer> {
  const queries = buildFastContextPrimerQueries(params.objective)
  const structuralPatterns = unique(queries.structuralSignals.slice(0, 8).map(regexPhrase), 8)
  const behavioralPatterns = unique(queries.behavioralSignals.map(regexPhrase), 4)
  const selectedContentPatterns = unique([...structuralPatterns, ...behavioralPatterns], 8)
  const tasks: Array<Promise<PrimerHit[]>> = [
    ...queries.filePatterns.slice(0, 10).map(async pattern => {
      const result = await params.toolExecutor.searchFiles(pattern, params.workspacePath)
      return result.success ? (result.data?.matches || []).slice(0, 8).map(path => {
        const workspaceRelative = relativePath(params.workspacePath, path)
        return { path: workspaceRelative, line: `filename[${pattern}] ${workspaceRelative}`, source: 'filename' as const }
      }) : []
    }),
    ...selectedContentPatterns.map(async pattern => {
      const result = params.toolExecutor.searchContentPage
        ? await params.toolExecutor.searchContentPage(pattern, params.workspacePath, SOURCE_FILE_GLOB, true, { limit: 128 })
        : await params.toolExecutor.searchContent(pattern, params.workspacePath, SOURCE_FILE_GLOB, true)
      const hits = Array.isArray(result.data) ? result.data : result.data?.hits || []
      return result.success ? normalizeContentHits(params.workspacePath, pattern, hits, 10) : []
    }),
  ]
  if (tasks.length === 0) return { calls: 0, readCalls: 0, candidatePaths: [], seedEvidence: [], queries }
  const settled = await Promise.allSettled(tasks)
  const initialHits = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const directoryScores = new Map<string, number>()
  for (const hit of initialHits) {
    const weight = hit.source === 'explicit' ? 8 : hit.source === 'content' ? 3 : hit.source === 'symbol' ? 2 : 1
    for (const directory of parentDirectories(hit.path)) {
      directoryScores.set(directory, (directoryScores.get(directory) || 0) + weight)
    }
  }
  const directSourceDirectories = unique(initialHits
    .filter(hit => (hit.source === 'content' || hit.source === 'filename' || hit.source === 'explicit') && SOURCE_FILE.test(hit.path))
    .filter(hit => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples)(?:\/|$)/i.test(hit.path))
    .flatMap(hit => parentDirectories(hit.path)), 8)
  const familyDirectories = unique([
    ...directSourceDirectories,
    ...[...directoryScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
      .map(([directory]) => directory),
  ], 6)
  const familyTasks = familyDirectories.map(async directory => {
    const result = await params.toolExecutor.searchFiles(`${directory}/**/*`, params.workspacePath)
    const matches = result.success ? result.data?.matches || [] : []
    return unique(matches
      .map(path => relativePath(params.workspacePath, path))
      .filter(path => SOURCE_FILE.test(path) && !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(path))
      .map(path => `family[${directory}] ${path}`), 32)
  })
  const familySettled = await Promise.allSettled(familyTasks)
  const familyLines = unique(familySettled.flatMap(result => result.status === 'fulfilled' ? result.value : []), 160)
  const hitLines = unique(initialHits.map(hit => hit.line), 80)
  const candidatePaths = unique([
    ...queries.pathHints,
    ...initialHits.map(hit => hit.path),
    ...familyLines.map(line => line.replace(/^family\[[^\]]+\]\s+/, '')),
  ], 200)
  const pathSignals = new Map<string, { path: string; score: number; sources: Set<PrimerHit['source']>; lines: number[] }>()
  for (const hit of initialHits) {
    if (!SOURCE_FILE.test(hit.path) || /(?:^|\/)(?:docs?|documentation|test|tests|__tests__)(?:\/|$)/i.test(hit.path)) continue
    const key = hit.path.toLowerCase()
    const current = pathSignals.get(key) || { path: hit.path, score: 0, sources: new Set(), lines: [] }
    current.sources.add(hit.source)
    current.score += hit.source === 'explicit' ? 30 : hit.source === 'content' ? 20 : hit.source === 'symbol' ? 20 : 4
    if (hit.lineNumber && hit.lineNumber > 0) current.lines.push(hit.lineNumber)
    pathSignals.set(key, current)
  }
  const responsibilityName = /authori[sz]|permission|validat|integrat|response|serializ|deserializ|adapter|handler|registry|dispatch|resolver|transform|normaliz|parser|schema|policy|resource|cors|method/i
  for (const line of familyLines) {
    const path = line.replace(/^family\[[^\]]+\]\s+/, '')
    const familyDirectory = line.match(/^family\[([^\]]+)\]/)?.[1] || ''
    if (!SOURCE_FILE.test(path) || /(?:^|\/)(?:docs?|documentation|test|tests|__tests__)(?:\/|$)/i.test(path)) continue
    const key = path.toLowerCase()
    const current = pathSignals.get(key) || { path, score: 0, sources: new Set<PrimerHit['source']>(), lines: [] }
    current.sources.add('filename')
    current.score += 2
      + Math.min(6, directoryScores.get(familyDirectory) || 0)
      + (responsibilityName.test(path.slice(path.lastIndexOf('/') + 1)) ? 4 : 0)
    pathSignals.set(key, current)
  }
  const seedPaths = [...pathSignals.values()]
    .filter(item => item.sources.size >= 2 || item.score >= 4)
    .sort((left, right) => right.score - left.score || right.sources.size - left.sources.size || left.path.localeCompare(right.path))
    .slice(0, 12)
  const seedResults = await Promise.allSettled(seedPaths.map(async item => {
    const anchor = item.lines.length > 0 ? Math.min(...item.lines) : 1
    const offset = Math.max(0, anchor - 61)
    const limit = 220
    const rangeResult = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(item.path, offset, limit, 96_000)
      : undefined
    if (rangeResult?.success && rangeResult.data?.content) {
      return {
        path: item.path,
        startLine: rangeResult.data.startLine,
        endLine: rangeResult.data.endLine,
        preview: rangeResult.data.content.split('\n').slice(0, 12).join('\n'),
        content: rangeResult.data.content.slice(0, 12_000),
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
      content: lines.join('\n').slice(0, 12_000),
      reason: 'file read',
    } satisfies SubAgentEvidence
  }))
  const directSeedEvidence = seedResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const importPatterns = firstPartyImportPatterns(directSeedEvidence, candidatePaths)
  const importSearchResults = await Promise.allSettled(importPatterns.map(pattern => params.toolExecutor.searchFiles(pattern, params.workspacePath)))
  const importPaths = unique(importSearchResults.flatMap(result => result.status === 'fulfilled' && result.value.success
    ? result.value.data?.matches || []
    : []).map(path => relativePath(params.workspacePath, path)), 6)
  const importReadResults = await Promise.allSettled(importPaths.map(async path => {
    const result = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(path, 0, 220, 64_000)
      : undefined
    if (!result?.success || !result.data?.content) return undefined
    return {
      path,
      startLine: result.data.startLine,
      endLine: result.data.endLine,
      preview: result.data.content.split('\n').slice(0, 12).join('\n'),
      content: result.data.content.slice(0, 12_000),
      reason: 'file read',
    } satisfies SubAgentEvidence
  }))
  const importEvidence = importReadResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const seedEvidence = [...directSeedEvidence, ...importEvidence]
    .filter((item, index, all) => all.findIndex(other => other.path.toLowerCase() === item.path.toLowerCase()) === index)
    .slice(0, 18)
  candidatePaths.push(...importEvidence.map(item => item.path).filter(path => !candidatePaths.some(candidate => candidate.toLowerCase() === path.toLowerCase())))
  const seedLines = seedEvidence.map(item => `${item.path}:${item.startLine}-${item.endLine}\n${(item.content || item.preview).slice(0, 1_400)}`)
  const sections = [
    queries.structuralSignals.length > 0 ? `Structural query signals:\n${queries.structuralSignals.map(value => `- ${value}`).join('\n')}` : '',
    queries.behavioralSignals.length > 0 ? `Behavioral query signals:\n${queries.behavioralSignals.map(value => `- ${value}`).join('\n')}` : '',
    hitLines.length > 0 ? `Multi-route retrieval candidates:\n${hitLines.join('\n')}` : '',
    familyLines.length > 0 ? `Implementation-family census (filenames only; inspect relevance before reading):\n${familyLines.join('\n')}` : '',
    seedLines.length > 0 ? `High-confidence read-confirmed source seeds:\n${seedLines.join('\n---\n')}` : '',
  ].filter(Boolean)
  return {
    calls: tasks.length + familyTasks.length + seedPaths.length + importPatterns.length + importPaths.length,
    readCalls: seedPaths.length + importPaths.length,
    candidatePaths,
    seedEvidence,
    queries,
    text: sections.length > 0 ? sections.join('\n\n').slice(0, 48_000) : undefined,
  }
}
