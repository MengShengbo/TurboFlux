/**
 * Workspace memory service.
 *
 * Loads project rule files plus `.turboflux/memory/facts.jsonl`, exposes
 * simple query/write/delete/update operations, and renders a compact memory
 * block for prompt injection.
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  Memory,
  MemoryGroup,
  MemoryKind,
  MemoryQueryParams,
  MemorySnapshot,
  MemoryWriteRequest,
  MemoryWriteResponse,
  MemoryForgetRequest,
  MemoryForgetResponse,
  MemoryUpdateRequest,
  MemoryUpdateResponse,
} from '../../shared/memoryTypes'
import { loadAllMemoryGroups } from './loaders'
import { MemoryWriter } from './writer'

function approxTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

const MEMORY_INJECTION_TOKEN_BUDGET = 2000
const MEMORY_QUERY_TOKEN_BUDGET = 1000

const FINGERPRINT_PATHS = [
  '.turboflux/memory/rules.md',
  '.turboflux/memory/facts.jsonl',
  'CLAUDE.md',
  'claude.md',
  '.claude/CLAUDE.md',
  '.claude/claude.md',
  'AGENTS.md',
  'agents.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
]

const FINGERPRINT_DIRS = [
  '.cursor/rules',
  '.windsurf/rules',
]

interface CacheEntry {
  fingerprint: string
  snapshot: MemorySnapshot
}

function computeFingerprint(workspacePath: string): string {
  const parts: string[] = []
  for (const rel of FINGERPRINT_PATHS) {
    const abs = path.join(workspacePath, rel)
    try {
      const stat = fs.statSync(abs)
      parts.push(`${rel}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
    } catch {
      parts.push(`${rel}:absent`)
    }
  }
  for (const rel of FINGERPRINT_DIRS) {
    const abs = path.join(workspacePath, rel)
    try {
      const stat = fs.statSync(abs)
      if (!stat.isDirectory()) {
        parts.push(`${rel}:notdir`)
        continue
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter(d => d.isFile())
        .map(d => d.name)
        .sort()
      const dirSig = entries
        .map(name => {
          try {
            const sub = fs.statSync(path.join(abs, name))
            return `${name}:${sub.size}:${Math.floor(sub.mtimeMs)}`
          } catch {
            return `${name}:err`
          }
        })
        .join(',')
      parts.push(`${rel}:[${dirSig}]`)
    } catch {
      parts.push(`${rel}:absent`)
    }
  }
  return parts.join('|')
}

function renderInjection(groups: MemoryGroup[], budgetTokens: number): {
  text: string
  tokens: number
} {
  if (groups.length === 0) return { text: '', tokens: 0 }

  const header = 'Project memory from this workspace. Rules are hard constraints. If a user request contradicts a rule, surface the conflict.'
  const lines: string[] = ['<workspace_memory>', header, '']
  let tokensUsed = approxTokens(lines.join('\n'))
  let truncated = false

  for (const group of groups) {
    if (truncated) break
    const escapedSource = group.source.replace(/"/g, '&quot;')
    const escapedLabel = group.label.replace(/"/g, '&quot;')
    const groupOpen = `<group label="${escapedLabel}" source="${escapedSource}" loader="${group.loader}">`
    const groupClose = '</group>'
    lines.push(groupOpen)
    tokensUsed += approxTokens(groupOpen)

    for (const item of group.items) {
      const tag = getKindTag(item.kind)
      const itemLine = `  - <${tag}>${item.text}</${tag}>`
      const cost = approxTokens(itemLine)
      if (tokensUsed + cost > budgetTokens) {
        lines.push('  - <truncated>additional items omitted for token budget</truncated>')
        truncated = true
        break
      }
      lines.push(itemLine)
      tokensUsed += cost
    }
    lines.push(groupClose)
    tokensUsed += approxTokens(groupClose)
  }

  lines.push('</workspace_memory>')
  tokensUsed += approxTokens('</workspace_memory>')
  return { text: lines.join('\n'), tokens: tokensUsed }
}

function getKindTag(kind: MemoryKind): string {
  switch (kind) {
    case 'rule': return 'rule'
    case 'fact': return 'fact'
    case 'preference': return 'pref'
    case 'strategy': return 'strategy'
    case 'pitfall': return 'pitfall'
    case 'workflow': return 'workflow'
    case 'episode': return 'episode'
    case 'todo': return 'todo'
    case 'verdict': return 'verdict'
    default: return 'memory'
  }
}

function tokenizeMemoryText(text: string): string[] {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

function scoreItemAgainstQuery(itemText: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 1
  const itemTokens = new Set(tokenizeMemoryText(itemText))
  if (itemTokens.size === 0) return 0
  let overlap = 0
  for (const token of itemTokens) {
    if (queryTokens.has(token)) overlap += 1
  }
  return overlap / Math.sqrt(itemTokens.size)
}

export class MemoryService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly writer: MemoryWriter

  constructor() {
    this.writer = new MemoryWriter()
  }

  async getSnapshot(workspacePath: string, options?: { force?: boolean }): Promise<MemorySnapshot> {
    const fingerprint = computeFingerprint(workspacePath)
    const cached = this.cache.get(workspacePath)
    if (!options?.force && cached && cached.fingerprint === fingerprint) {
      return cached.snapshot
    }

    const { groups, warnings, loadersAttempted } = loadAllMemoryGroups(workspacePath)
    const totalCount = groups.reduce((sum, group) => sum + group.items.length, 0)
    const { text, tokens } = renderInjection(groups, MEMORY_INJECTION_TOKEN_BUDGET)

    const snapshot: MemorySnapshot = {
      workspacePath,
      injectionText: text,
      injectionTokens: tokens,
      groups,
      totalCount,
      warnings,
      loadersAttempted,
      builtAt: Date.now(),
    }

    this.cache.set(workspacePath, { fingerprint, snapshot })
    return snapshot
  }

  invalidate(workspacePath: string): void {
    this.cache.delete(workspacePath)
    this.writer.invalidate(workspacePath)
  }

  async query(params: MemoryQueryParams): Promise<Memory[]> {
    const snapshot = await this.getSnapshot(params.workspacePath)
    const { scope, kind, query, limit, includeStale } = params
    const cap = Math.min(Math.max(1, limit ?? 50), 200)
    const queryTokens = new Set(tokenizeMemoryText(query || ''))
    const scored: Array<{ item: Memory; score: number; order: number }> = []
    let order = 0

    for (const group of snapshot.groups) {
      for (const item of group.items) {
        order += 1
        if (scope && item.scope !== scope) continue
        if (kind && item.kind !== kind) continue
        if (!includeStale && item.status !== 'active') continue
        const score = scoreItemAgainstQuery(item.text, queryTokens)
        if (queryTokens.size > 0 && score <= 0) continue
        scored.push({ item, score, order })
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, cap)
      .map(entry => entry.item)
  }

  async getRelevantInjection(
    workspacePath: string,
    query: string,
    options?: { tokenBudget?: number; minScore?: number; baselineRules?: number },
  ): Promise<{ text: string; tokens: number; includedCount: number; totalCount: number }> {
    const snapshot = await this.getSnapshot(workspacePath)
    if (snapshot.groups.length === 0) {
      return { text: '', tokens: 0, includedCount: 0, totalCount: 0 }
    }

    const budget = options?.tokenBudget ?? MEMORY_QUERY_TOKEN_BUDGET
    const minScore = options?.minScore ?? 0.15
    const baselineRules = options?.baselineRules ?? 5
    const queryTokens = new Set(tokenizeMemoryText(query))
    const allItems: Array<{ group: MemoryGroup; item: Memory; score: number }> = []

    for (const group of snapshot.groups) {
      for (const item of group.items) {
        if (item.status !== 'active') continue
        allItems.push({ group, item, score: scoreItemAgainstQuery(item.text, queryTokens) })
      }
    }

    const baseline = allItems.slice(0, baselineRules)
    const includedIds = new Set(baseline.map(entry => entry.item.id))
    const orderedItems = [...baseline]

    for (const scored of allItems
      .slice(baselineRules)
      .filter(entry => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)) {
      if (includedIds.has(scored.item.id)) continue
      includedIds.add(scored.item.id)
      orderedItems.push(scored)
    }

    const groupMap = new Map<string, { group: MemoryGroup; items: Memory[] }>()
    for (const scored of orderedItems) {
      const key = scored.group.source
      const entry = groupMap.get(key) || { group: scored.group, items: [] }
      entry.items.push(scored.item)
      groupMap.set(key, entry)
    }

    const filteredGroups: MemoryGroup[] = Array.from(groupMap.values()).map(({ group, items }) => ({
      ...group,
      items,
    }))

    const { text, tokens } = renderInjection(filteredGroups, budget)
    return {
      text,
      tokens,
      includedCount: orderedItems.length,
      totalCount: snapshot.totalCount,
    }
  }

  async remember(request: MemoryWriteRequest): Promise<MemoryWriteResponse> {
    const result = await this.writer.remember(request)
    if (result.success) {
      this.cache.delete(request.workspacePath)
    }
    return result
  }

  async forget(request: MemoryForgetRequest): Promise<MemoryForgetResponse> {
    const result = await this.writer.forget(request)
    if (result.success) {
      this.cache.delete(request.workspacePath)
    }
    return result
  }

  async update(request: MemoryUpdateRequest): Promise<MemoryUpdateResponse> {
    const result = await this.writer.update(request)
    if (result.success) {
      this.cache.delete(request.workspacePath)
    }
    return result
  }
}
