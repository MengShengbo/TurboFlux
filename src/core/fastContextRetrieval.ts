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
  confidence: number
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
  weight?: number
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

async function runLimited<T>(tasks: Array<() => Promise<T>>, concurrency = 4): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() }
      } catch (firstReason) {
        try {
          results[index] = { status: 'fulfilled', value: await tasks[index]() }
        } catch (reason) {
          results[index] = { status: 'rejected', reason: reason || firstReason }
        }
      }
    }
  }))
  return results
}

function regexPhrase(value: string): string {
  return value
    .trim()
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_.-]*')
}

export function __testSelectPrimerContentPatterns(queries: Pick<FastContextPrimerQueries, 'structuralSignals' | 'behavioralSignals'>): string[] {
  const structuralPatterns = unique(queries.structuralSignals.slice(0, 8).map(regexPhrase), 8)
  const behavioralPatterns = unique(queries.behavioralSignals.map(regexPhrase), 4)
  return unique([
    ...structuralPatterns.slice(0, 2),
    ...Array.from({ length: 4 })
      .flatMap((_, index) => [behavioralPatterns[index], structuralPatterns[index + 2]])
      .filter((pattern): pattern is string => Boolean(pattern)),
    ...structuralPatterns.slice(6),
  ], 10)
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

function semanticPathScore(path: string, objective: string): number {
  const objectiveTerms = new Set((objective.slice(0, 2_400).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [])
    .flatMap(term => term.split('_'))
    .map(term => term.endsWith('s') && term.length > 4 ? term.slice(0, -1) : term)
    .filter(term => !STOP_WORDS.has(term)))
  return path.toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(term => term.endsWith('s') && term.length > 4 ? term.slice(0, -1) : term)
    .filter(term => objectiveTerms.has(term))
    .length
}

function identifierTerms(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function __testImplementationStem(path: string): string {
  return path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.[^.]+$/, '')
    .replace(/^(?:test_|spec_)/i, '')
    .replace(/[._](?:test|spec)$/i, '')
    .toLowerCase()
}

function resolvePythonModulePath(moduleName: string, knownPaths: string[]): string {
  const modulePath = moduleName.replace(/\./g, '/')
  const root = modulePath.split('/')[0].toLowerCase()
  if (knownPaths.some(candidate => candidate === `${root}.py` || candidate.startsWith(`${root}/`))) return modulePath
  const marker = `/${root}/`
  const prefixed = knownPaths.find(candidate => candidate.includes(marker))
  if (!prefixed) return modulePath
  return `${prefixed.slice(0, prefixed.indexOf(marker) + 1)}${modulePath}`
}

function firstPartyImportPatterns(evidence: SubAgentEvidence[], candidatePaths: string[], objective = ''): string[] {
  const knownPaths = candidatePaths.map(path => path.replace(/\\/g, '/').toLowerCase())
  const objectiveTerms = new Set((objective.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [])
    .flatMap(term => term.split('_'))
    .map(term => term.endsWith('s') && term.length > 4 ? term.slice(0, -1) : term)
    .filter(term => !STOP_WORDS.has(term)))
  const scored = new Map<string, number>()
  const evidenceByPath = new Map<string, { path: string; contents: string[] }>()
  for (const item of evidence) {
    const path = item.path.replace(/\\/g, '/')
    const key = path.toLowerCase()
    const grouped = evidenceByPath.get(key) || { path, contents: [] }
    grouped.contents.push(item.content || item.preview || '')
    evidenceByPath.set(key, grouped)
  }
  for (const item of evidenceByPath.values()) {
    const path = item.path
    const content = item.contents.join('\n')
    if (/\.py$/i.test(path)) {
      for (const match of content.matchAll(/^\s*from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\s+([^\n#]+)/gm)) {
        const rawModulePath = match[1].replace(/\./g, '/')
        const root = rawModulePath.split('/')[0].toLowerCase()
        if (!knownPaths.some(candidate => candidate === `${root}.py` || candidate.startsWith(`${root}/`) || candidate.includes(`/${root}/`))) continue
        const modulePath = resolvePythonModulePath(match[1], knownPaths)
        const importedNames = match[2]
          .replace(/[()]/g, '')
          .split(',')
          .map(value => {
            const [name, alias] = value.trim().split(/\s+as\s+/i)
            return { name, localName: alias || name }
          })
          .filter(value => /^[A-Za-z][A-Za-z0-9_]*$/.test(value.name) && /^[A-Za-z][A-Za-z0-9_]*$/.test(value.localName))
        const moduleParts = modulePath.split('/')
        if (moduleParts.length >= 2) {
          const moduleReferences = content.match(new RegExp(`\\b${moduleParts[moduleParts.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'))?.length || 1
          const importedSemanticScore = importedNames
            .flatMap(value => [value.name, value.localName])
            .flatMap(identifierTerms)
            .filter(term => objectiveTerms.has(term))
            .length * 10
          scored.set(`${modulePath}.py`, Math.max(scored.get(`${modulePath}.py`) || 0, moduleReferences + 6 + importedSemanticScore))
        }
        for (const { name: importedName, localName } of importedNames) {
          if (moduleParts[moduleParts.length - 1] === importedName || moduleParts.length < 2) continue
          if (!/^[a-z][a-z0-9_]*$/.test(importedName)) continue
          const qualifiedReferences = content.match(new RegExp(`\\b${localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`, 'g'))?.length || 0
          if (qualifiedReferences === 0 && localName === importedName) continue
          const importedPath = `${modulePath}/${importedName}`
          scored.set(`${importedPath}.py`, Math.max(scored.get(`${importedPath}.py`) || 0, Math.max(1, qualifiedReferences)))
        }
      }
      for (const match of content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)/gm)) {
        const moduleName = match[1]
        const rawModulePath = moduleName.replace(/\./g, '/')
        const root = rawModulePath.split('/')[0].toLowerCase()
        if (!knownPaths.some(candidate => candidate === `${root}.py` || candidate.startsWith(`${root}/`) || candidate.includes(`/${root}/`))) continue
        const modulePath = resolvePythonModulePath(moduleName, knownPaths)
        const basename = modulePath.slice(modulePath.lastIndexOf('/') + 1)
        const references = content.match(new RegExp(`\\b${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'))?.length || 1
        for (const pattern of [`${modulePath}.py`, `${modulePath}/__init__.py`]) {
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
  const semanticScore = (pattern: string): number => pattern.toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(term => term.endsWith('s') && term.length > 4 ? term.slice(0, -1) : term)
    .filter(term => objectiveTerms.has(term))
    .length * 8
  return [...scored.entries()]
    .sort((left, right) => right[1] + semanticScore(right[0]) - left[1] - semanticScore(left[0])
      || Number(left[0].startsWith('**/')) - Number(right[0].startsWith('**/'))
      || left[0].localeCompare(right[0]))
    .slice(0, 32)
    .map(([pattern]) => pattern)
}

export const __testFirstPartyImportPatterns = firstPartyImportPatterns

function titleWords(objective: string): string[] {
  const title = objective.split(/\r?\n/, 1)[0]
  return unique((title.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])
    .map(word => word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .filter(word => !STOP_WORDS.has(word)), 8)
}

function responsibilityTerms(objective: string): string[] {
  const terms: string[] = []
  if (/\b(?:parse|parser|syntax|annotation|ast|unparse)\b/i.test(objective)) terms.push('ast', 'parser')
  if (/\b(?:serializ|deserializ|json|encode|decode)\b/i.test(objective)) terms.push('serializer', 'encoder')
  if (/\b(?:validat|invalid|schema|constraint)\b/i.test(objective)) terms.push('validator')
  if (/\b(?:permission|authoriz|access|policy)\b/i.test(objective)) terms.push('authoriz', 'permission')
  if (/\b(?:dispatch|route|handler|middleware)\b/i.test(objective)) terms.push('handler', 'dispatcher')
  return unique(terms, 4)
}

function commonPathPrefix(left: string, right: string): number {
  const leftParts = left.replace(/\\/g, '/').toLowerCase().split('/')
  const rightParts = right.replace(/\\/g, '/').toLowerCase().split('/')
  let index = 0
  while (index < leftParts.length && index < rightParts.length && leftParts[index] === rightParts[index]) index += 1
  return index
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
  const linkedSourcePaths = [...objective.matchAll(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[^/\s]+\/([^#?\s)]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte))(?=$|[#?\s)"',])/gi)]
    .map(match => {
      try { return decodeURIComponent(match[1]) } catch { return match[1] }
    })
  const stackTracePaths = [
    ...[...objective.matchAll(/\bFile\s+["']([^"'\r\n]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte))["']/gi)].map(match => match[1]),
    ...[...objective.matchAll(/\bat\s+(?:[^\r\n(]+\s+\()?([^\s()]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte)):\d+(?::\d+)?\)?/gi)].map(match => match[1]),
  ]
  const focusedObjective = `${title}\n${objective.slice(0, 1_800)}\n${objective.length > 1_800 ? objective.slice(-2_400) : ''}`
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
  const titleSymbols = [
    ...[...title.matchAll(/(?:@|\b)([A-Za-z_$][\w$]{2,})(?=\s*\()/g)].map(match => match[1]),
    ...(title.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || [])
      .filter(token => /[a-z][A-Z]|_|[A-Z].*[A-Z]/.test(token)),
  ]
  const rawSymbols = [
    ...titleSymbols,
    ...callAndAnnotationSymbols,
    ...(focusedObjective.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || [])
      .filter(token => /[a-z][A-Z]|_|[A-Z].*[A-Z]/.test(token)),
    ...dottedIdentifiers.flatMap(value => value.split(/[.-]/)).filter(value => /^[A-Za-z_$][\w$]{3,}$/.test(value)),
  ]
  const symbols = unique(rawSymbols.flatMap(identifierVariants), 10)
  const pathHints = unique([...linkedSourcePaths, ...stackTracePaths, ...(focusedObjective.match(/(?:[A-Za-z0-9_.-]+[\\/]){1,}[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|php|scala|vue|svelte|rst|md)(?=$|[#?\s)"',])/gi) || [])]
    .map(path => path.replace(/\\/g, '/').replace(/^\/+/, ''))
    .map(path => path.includes('site-packages/') ? path.slice(path.indexOf('site-packages/') + 'site-packages/'.length) : path), 12)
  const words = titleWords(objective)
  const titleRoles = unique(title.toLowerCase().match(/\b(?:functions?|parsers?|serializers?|deserializers?|validators?|handlers?|adapters?|providers?|renderers?|compilers?|resolvers?|dispatchers?|widgets?|registries?)\b/g) || [], 3)
  const roleFilePatterns = titleRoles.flatMap(role => [...words]
    .reverse()
    .slice(0, 6)
    .flatMap(word => {
      const flexibleWord = `[${word[0]?.toLowerCase() || ''}${word[0]?.toUpperCase() || ''}]${word.slice(1)}`
      const flexibleRole = `[${role[0]?.toLowerCase() || ''}${role[0]?.toUpperCase() || ''}]${role.slice(1)}`
      return [`**/*${flexibleWord}*${flexibleRole}*.*`]
    }))
  const filePatterns = unique([
    ...pathHints.flatMap(path => [`**/${path}`, `**/${path.split('/').slice(-2).join('/')}`]),
    ...roleFilePatterns,
    ...words.slice(0, -1).flatMap((word, index) => {
      const next = words[index + 1]
      const camel = `${word}${next[0]?.toUpperCase() || ''}${next.slice(1)}`
      return [`**/*${word}*${next}*.*`, `**/*${camel}*/**`, `**/*${word}*${next}*/**`, `**/*${word}${next}*.*`]
    }),
  ], 28)
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

function normalizeContentHits(workspacePath: string, query: string, hits: SearchContentHit[], limit = 8, weight = 1): PrimerHit[] {
  const seenPaths = new Set<string>()
  const selected: PrimerHit[] = []
  const sourcePriority = (path: string): number => {
    const normalized = path.replace(/\\/g, '/').toLowerCase()
    if (/(?:^|\/)(?:test|tests|__tests__|testing|benchmarks?)(?:\/|$)|(?:\.(?:test|spec)\.)/.test(normalized)) return 0
    if (/(?:^|\/)(?:docs?|documentation|examples?)(?:\/|$)|\.md$|\.rst$/.test(normalized)) return 1
    return 2
  }
  const pathFrequency = new Map<string, number>()
  for (const hit of hits) {
    const key = relativePath(workspacePath, hit.file).toLowerCase()
    pathFrequency.set(key, (pathFrequency.get(key) || 0) + 1)
  }
  const rankedHits = [...hits].sort((left, right) => {
    const leftPath = relativePath(workspacePath, left.file)
    const rightPath = relativePath(workspacePath, right.file)
    return sourcePriority(right.file) - sourcePriority(left.file)
      || (pathFrequency.get(rightPath.toLowerCase()) || 0) - (pathFrequency.get(leftPath.toLowerCase()) || 0)
      || leftPath.localeCompare(rightPath)
      || left.line - right.line
  })
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
      weight,
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
  const selectedContentPatterns = __testSelectPrimerContentPatterns(queries)
  const explicitPathPatterns = new Set(queries.pathHints
    .flatMap(path => [`**/${path}`, `**/${path.split('/').slice(-2).join('/')}`])
    .map(pattern => pattern.toLowerCase()))
  const contentTasks = selectedContentPatterns.map((pattern, index) => async () => {
    const result = params.toolExecutor.searchContentPage
      ? await params.toolExecutor.searchContentPage(pattern, params.workspacePath, SOURCE_FILE_GLOB, true, { limit: 200 })
      : await params.toolExecutor.searchContent(pattern, params.workspacePath, SOURCE_FILE_GLOB, true)
    const hits = Array.isArray(result.data) ? result.data : result.data?.hits || []
    const weight = index < 2 ? 3 : index < 4 ? 2 : 1
    return result.success ? normalizeContentHits(params.workspacePath, pattern, hits, 16, weight) : []
  })
  const filenameTasks: Array<() => Promise<PrimerHit[]>> = [
    ...queries.filePatterns.slice(0, 18).map(pattern => async () => {
      const result = await params.toolExecutor.searchFiles(pattern, params.workspacePath)
      return result.success ? (result.data?.matches || []).slice(0, 8).map(path => {
        const workspaceRelative = relativePath(params.workspacePath, path)
        const explicit = explicitPathPatterns.has(pattern.toLowerCase())
        const semanticRolePattern = /unction|arser|erializ|alidat|andler|dapter|rovider|enderer|ompiler|esolver|ispatch|idget|egistr/i.test(pattern)
        return {
          path: workspaceRelative,
          line: `${explicit ? 'resolved-path' : semanticRolePattern ? 'role-filename' : 'filename'}[${pattern}] ${workspaceRelative}`,
          source: explicit ? 'explicit' as const : semanticRolePattern ? 'symbol' as const : 'filename' as const,
          weight: explicit || semanticRolePattern ? 4 : 1,
        }
      }) : []
    }),
  ]
  const initialTasks = [...contentTasks, ...filenameTasks]
  const initialSettled = await runLimited(initialTasks)
  const initialSearchCalls = initialTasks.length
  const initialHits = [
    ...initialSettled.flatMap(result => result.status === 'fulfilled' ? result.value : []),
  ]
  if (initialHits.length === 0) return { confidence: 0, calls: initialSearchCalls, readCalls: 0, candidatePaths: [], seedEvidence: [], queries }
  const directoryScores = new Map<string, number>()
  for (const hit of initialHits) {
    const weight = (hit.source === 'explicit' ? 8 : hit.source === 'content' ? 3 : hit.source === 'symbol' ? 2 : 1) * (hit.weight || 1)
    for (const directory of parentDirectories(hit.path)) {
      directoryScores.set(directory, (directoryScores.get(directory) || 0) + weight)
    }
  }
  const directSourceDirectories = unique(initialHits
    .filter(hit => (hit.source === 'content' || hit.source === 'filename' || hit.source === 'explicit') && SOURCE_FILE.test(hit.path))
    .filter(hit => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples?|benchmarks?)(?:\/|$)/i.test(hit.path))
    .flatMap(hit => parentDirectories(hit.path)), 8)
  const familyDirectories = unique([
    ...directSourceDirectories,
    ...[...directoryScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
      .map(([directory]) => directory),
  ], 6)
  const familyTasks = familyDirectories.map(directory => async () => {
    const result = await params.toolExecutor.searchFiles(`${directory}/**/*`, params.workspacePath)
    const matches = result.success ? result.data?.matches || [] : []
    return unique(matches
      .map(path => relativePath(params.workspacePath, path))
      .filter(path => SOURCE_FILE.test(path) && !/(?:^|\/)(?:test|tests|__tests__|benchmarks?)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(path))
      .map(path => `family[${directory}] ${path}`), 32)
  })
  const familySettled = await runLimited(familyTasks)
  const familyLines = unique(familySettled.flatMap(result => result.status === 'fulfilled' ? result.value : []), 160)
  const hitLines = unique(initialHits.map(hit => hit.line), 80)
  const candidatePaths = unique([
    ...initialHits.map(hit => hit.path),
    ...familyLines.map(line => line.replace(/^family\[[^\]]+\]\s+/, '')),
  ], 200)
  const pathSignals = new Map<string, { path: string; score: number; sources: Set<PrimerHit['source']>; lines: number[] }>()
  for (const hit of initialHits) {
    if (!SOURCE_FILE.test(hit.path) || /(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples?|benchmarks?)(?:\/|$)/i.test(hit.path)) continue
    const key = hit.path.toLowerCase()
    const current = pathSignals.get(key) || { path: hit.path, score: 0, sources: new Set(), lines: [] }
    current.sources.add(hit.source)
    current.score += (hit.source === 'explicit' ? 30 : hit.source === 'content' ? 20 : hit.source === 'symbol' ? 20 : 4) * (hit.weight || 1)
    if (hit.lineNumber && hit.lineNumber > 0) current.lines.push(hit.lineNumber)
    pathSignals.set(key, current)
  }
  const responsibilityName = /authori[sz]|permission|validat|integrat|response|serializ|deserializ|adapter|handler|registry|dispatch|resolver|transform|normaliz|parser|compiler|schema|policy|resource|cors|method/i
  for (const line of familyLines) {
    const path = line.replace(/^family\[[^\]]+\]\s+/, '')
    const familyDirectory = line.match(/^family\[([^\]]+)\]/)?.[1] || ''
    if (!SOURCE_FILE.test(path) || /(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples?|benchmarks?)(?:\/|$)/i.test(path)) continue
    const key = path.toLowerCase()
    const current = pathSignals.get(key) || { path, score: 0, sources: new Set<PrimerHit['source']>(), lines: [] }
    current.sources.add('filename')
    current.score += 2
      + Math.min(6, directoryScores.get(familyDirectory) || 0)
      + (responsibilityName.test(path.slice(path.lastIndexOf('/') + 1)) ? 4 : 0)
    pathSignals.set(key, current)
  }
  const rankedSeedPaths = [...pathSignals.values()]
    .filter(item => item.sources.has('explicit') || item.sources.has('content') || item.sources.size >= 2 || item.score >= 8)
    .sort((left, right) => {
      const sourceRank = (item: typeof left) => item.sources.has('explicit') ? 4 : item.sources.has('symbol') ? 3 : item.sources.has('content') ? 2 : 0
      return sourceRank(right) - sourceRank(left)
        || right.score - left.score
        || right.sources.size - left.sources.size
        || left.path.localeCompare(right.path)
    })
  const coreSeedPaths = rankedSeedPaths.slice(0, 8)
  const coreKeys = new Set(coreSeedPaths.map(item => item.path.toLowerCase()))
  const coreDirectories = new Set(rankedSeedPaths.slice(0, 12).flatMap(item => parentDirectories(item.path)).map(value => value.toLowerCase()))
  const frontierFilenamePaths = candidatePaths
    .filter(path => SOURCE_FILE.test(path))
    .filter(path => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples?|benchmarks?|migrations?)(?:\/|$)/i.test(path))
    .filter(path => responsibilityName.test(path.slice(path.lastIndexOf('/') + 1)))
    .map(path => ({ path, score: 0, sources: new Set<PrimerHit['source']>(['filename']), lines: [] }))
  const frontierPool = [...pathSignals.values(), ...frontierFilenamePaths]
    .filter(item => !coreKeys.has(item.path.toLowerCase()))
    .filter(item => parentDirectories(item.path).some(directory => coreDirectories.has(directory.toLowerCase())))
    .sort((left, right) => Number(right.sources.has('content')) - Number(left.sources.has('content'))
      || right.score - left.score
      || left.path.localeCompare(right.path))
  const contentFrontier = frontierPool.find(item => item.sources.has('content'))
  const testStems = new Set(initialHits
    .filter(hit => /(?:^|\/)(?:test|tests|testing|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(hit.path))
    .map(hit => __testImplementationStem(hit.path)))
  const mirroredImplementation = frontierPool.find(item => testStems.has(__testImplementationStem(item.path)))
  const objectiveTerms = new Set((params.objective.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []).filter(term => !STOP_WORDS.has(term)))
  const roleFrontier = frontierPool
    .filter(item => item !== contentFrontier && responsibilityName.test(item.path.slice(item.path.lastIndexOf('/') + 1)))
    .map(item => {
      const normalizedPath = item.path.toLowerCase()
      const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
      const roleScore = /compiler|parser|validat|serializ|deserializ|resolver|handler|adapter|dispatch/.test(filename) ? 4 : 1
      const objectiveScore = [...objectiveTerms].filter(term => normalizedPath.includes(term)).length
      return { item, score: roleScore + Math.min(4, objectiveScore) }
    })
    .sort((left, right) => right.score - left.score || right.item.score - left.item.score || left.item.path.localeCompare(right.item.path))[0]?.item
  const frontierSeedPaths = [contentFrontier, mirroredImplementation, roleFrontier]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  const featureRequest = /\b(?:add|feature|implement|proposal|support)\b/i.test(params.objective.slice(0, 800))
  const featureDirectories = new Set(coreSeedPaths.slice(0, 5)
    .flatMap(item => parentDirectories(item.path))
    .map(directory => directory.toLowerCase()))
  const featureFrontierPaths = featureRequest
    ? candidatePaths
      .filter(path => SOURCE_FILE.test(path))
      .filter(path => !coreKeys.has(path.toLowerCase()))
      .filter(path => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples?|benchmarks?)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(path))
      .filter(path => responsibilityName.test(path.slice(path.lastIndexOf('/') + 1)))
      .filter(path => parentDirectories(path).some(directory => featureDirectories.has(directory.toLowerCase())))
      .map(path => ({
        path,
        score: semanticPathScore(path, params.objective)
          + Math.max(...coreSeedPaths.slice(0, 5).map(item => commonPathPrefix(path, item.path))),
        sources: new Set<PrimerHit['source']>(['filename']),
        lines: [],
      }))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 6)
    : []
  const frontierKeys = new Set(frontierSeedPaths.map(item => item.path.toLowerCase()))
  const featureKeys = new Set(featureFrontierPaths.map(item => item.path.toLowerCase()))
  const seedPaths = [
    ...coreSeedPaths,
    ...featureFrontierPaths.filter(item => !coreKeys.has(item.path.toLowerCase())),
    ...frontierSeedPaths,
    ...rankedSeedPaths.filter(item => !coreKeys.has(item.path.toLowerCase())
      && !frontierKeys.has(item.path.toLowerCase())
      && !featureKeys.has(item.path.toLowerCase())),
  ].filter((item, index, all) => all.findIndex(other => other.path.toLowerCase() === item.path.toLowerCase()) === index)
    .slice(0, featureRequest ? 14 : 10)
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
  const headerProbePaths = seedPaths
    .filter(item => /\.(?:py|pyi|[cm]?[jt]sx?)$/i.test(item.path))
    .filter(item => Math.min(...item.lines, 97) > 96)
    .slice(0, 4)
  const headerResults = await Promise.allSettled(headerProbePaths.map(async item => {
    if (!params.toolExecutor.readFileRange) return undefined
    const result = await params.toolExecutor.readFileRange(item.path, 0, 96, 48_000)
    if (!result.success || !result.data?.content) return undefined
    return {
      path: item.path,
      startLine: result.data.startLine,
      endLine: result.data.endLine,
      preview: result.data.content.split('\n').slice(0, 12).join('\n'),
      content: result.data.content.slice(0, 12_000),
      reason: 'file read',
    } satisfies SubAgentEvidence
  }))
  const headerEvidence = headerResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const responsibilityRoots = [...new Set(directSeedEvidence
    .map(item => item.path.replace(/\\/g, '/').split('/')[0])
    .filter(Boolean))].slice(0, 2)
  const responsibilityPatterns = responsibilityTerms(params.objective)
    .flatMap(term => responsibilityRoots.map(root => `${root}/**/*${term}*.*`))
  const responsibilitySearchResults = await runLimited(responsibilityPatterns.map(pattern => () => params.toolExecutor.searchFiles(pattern, params.workspacePath)))
  const knownSeedPaths = new Set([...directSeedEvidence, ...headerEvidence].map(item => item.path.toLowerCase()))
  const responsibilityPathRanks = new Map<string, { path: string; patternRank: number }>()
  responsibilitySearchResults.forEach((result, patternRank) => {
    if (result.status !== 'fulfilled' || !result.value.success) return
    for (const matchedPath of result.value.data?.matches || []) {
      const path = relativePath(params.workspacePath, matchedPath)
      const key = path.toLowerCase()
      if (!responsibilityPathRanks.has(key)) responsibilityPathRanks.set(key, { path, patternRank })
    }
  })
  const responsibilityPaths = [...responsibilityPathRanks.values()]
    .sort((left, right) => left.patternRank - right.patternRank || left.path.localeCompare(right.path))
    .slice(0, 24)
    .map(item => item.path)
    .filter(path => SOURCE_FILE.test(path))
    .filter(path => !knownSeedPaths.has(path.toLowerCase()))
    .filter(path => !/(?:^|\/)(?:docs?|documentation|test|tests|__tests__|examples?|benchmarks?)(?:\/|$)/i.test(path))
    .sort((left, right) => {
      const leftScore = Math.max(...directSeedEvidence.map(item => commonPathPrefix(left, item.path)))
      const rightScore = Math.max(...directSeedEvidence.map(item => commonPathPrefix(right, item.path)))
      const leftRank = responsibilityPathRanks.get(left.toLowerCase())?.patternRank || 0
      const rightRank = responsibilityPathRanks.get(right.toLowerCase())?.patternRank || 0
      return rightScore - leftScore || leftRank - rightRank || left.localeCompare(right)
    })
    .slice(0, 2)
  const responsibilityReadResults = await runLimited(responsibilityPaths.map(path => () => (async () => {
    const result = params.toolExecutor.readFileRange
      ? await params.toolExecutor.readFileRange(path, 0, 320, 96_000)
      : undefined
    if (!result?.success || !result.data?.content) return undefined
    return {
      path,
      startLine: result.data.startLine,
      endLine: result.data.endLine,
      preview: result.data.content.split('\n').slice(0, 12).join('\n'),
      content: result.data.content.slice(0, 24_000),
      reason: 'file read',
    } satisfies SubAgentEvidence
  })()))
  const responsibilityEvidence = responsibilityReadResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  candidatePaths.push(...responsibilityEvidence.map(item => item.path).filter(path => !candidatePaths.some(candidate => candidate.toLowerCase() === path.toLowerCase())))
  const importPatterns = firstPartyImportPatterns([...directSeedEvidence, ...headerEvidence, ...responsibilityEvidence], candidatePaths, params.objective)
  const importSearchResults = await runLimited(importPatterns.map(pattern => () => params.toolExecutor.searchFiles(pattern, params.workspacePath)))
  const rankedImportPaths = unique(importSearchResults.flatMap(result => result.status === 'fulfilled' && result.value.success
    ? result.value.data?.matches || []
    : []).map(path => relativePath(params.workspacePath, path)), 64)
    .sort((left, right) => semanticPathScore(right, params.objective) - semanticPathScore(left, params.objective)
      || left.localeCompare(right))
  const seenImportDirectories = new Set<string>()
  const diverseImportPaths = rankedImportPaths.filter(path => {
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).toLowerCase() : ''
    if (seenImportDirectories.has(directory)) return false
    seenImportDirectories.add(directory)
    return true
  })
  const importPaths = unique([...rankedImportPaths.slice(0, 16), ...diverseImportPaths, ...rankedImportPaths], 20)
  const importReadResults = await runLimited(importPaths.map(path => async () => {
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
  const seedEvidence = [
    ...responsibilityEvidence,
    ...directSeedEvidence.slice(0, 12),
    ...importEvidence.slice(0, 10),
    ...directSeedEvidence.slice(12),
    ...importEvidence.slice(10),
  ]
    .filter((item, index, all) => all.findIndex(other => other.path.toLowerCase() === item.path.toLowerCase()) === index)
    .slice(0, 22)
  candidatePaths.push(...importEvidence.map(item => item.path).filter(path => !candidatePaths.some(candidate => candidate.toLowerCase() === path.toLowerCase())))
  const seedLines = seedEvidence.map(item => `${item.path}:${item.startLine}-${item.endLine}\n${(item.content || item.preview).slice(0, 1_400)}`)
  const strongestSeed = seedPaths[0]
  const confidence = strongestSeed?.sources.has('explicit') || strongestSeed?.sources.has('symbol')
    ? 0.9
    : strongestSeed?.sources.has('content') && (featureFrontierPaths.length >= 2 || strongestSeed.score >= 40)
      ? 0.8
      : strongestSeed?.sources.has('content')
        ? 0.7
        : seedEvidence.length >= 4
          ? 0.55
          : 0.3
  const sections = [
    queries.structuralSignals.length > 0 ? `Structural query signals:\n${queries.structuralSignals.map(value => `- ${value}`).join('\n')}` : '',
    queries.behavioralSignals.length > 0 ? `Behavioral query signals:\n${queries.behavioralSignals.map(value => `- ${value}`).join('\n')}` : '',
    hitLines.length > 0 ? `Multi-route retrieval candidates:\n${hitLines.join('\n')}` : '',
    familyLines.length > 0 ? `Implementation-family census (filenames only; inspect relevance before reading):\n${familyLines.join('\n')}` : '',
    seedLines.length > 0 ? `High-confidence read-confirmed source seeds:\n${seedLines.join('\n---\n')}` : '',
  ].filter(Boolean)
  return {
    confidence,
    calls: initialSearchCalls + familyTasks.length + seedPaths.length + headerProbePaths.length + responsibilityPatterns.length + responsibilityPaths.length + importPatterns.length + importPaths.length,
    readCalls: seedPaths.length + headerProbePaths.length + responsibilityPaths.length + importPaths.length,
    candidatePaths,
    seedEvidence,
    queries,
    text: sections.length > 0 ? sections.join('\n\n').slice(0, 48_000) : undefined,
  }
}
