/**
 * Append-only persistent store for agent-written workspace memories.
 *
 * Storage format: one JSON object per line in `.turboflux/memory/facts.jsonl`.
 * Later lines with the same id override earlier ones when loaded.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type {
  Memory,
  MemoryEvidence,
  MemoryWriteRequest,
  MemoryWriteResponse,
  MemoryForgetRequest,
  MemoryForgetResponse,
  MemoryUpdateRequest,
  MemoryUpdateResponse,
} from '../../shared/memoryTypes'
import { sanitizeMemoryText } from './sanitizer'

const DYNAMIC_STORE_SOFT_CAP = 500
const DEDUP_THRESHOLD = 0.75

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1),
  )
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  return intersection / (a.size + b.size - intersection)
}

export class MemoryWriter {
  private readonly workspaceIndex = new Map<string, Map<string, Memory>>()
  private readonly workspaceTokens = new Map<string, Map<string, Set<string>>>()
  private readonly loaded = new Map<string, boolean>()

  private factsPath(workspacePath: string): string {
    return path.join(workspacePath, '.turboflux', 'memory', 'facts.jsonl')
  }

  private ensureDirForWrite(workspacePath: string): void {
    fs.mkdirSync(path.join(workspacePath, '.turboflux', 'memory'), { recursive: true })
  }

  private getIndex(workspacePath: string): Map<string, Memory> {
    let index = this.workspaceIndex.get(workspacePath)
    if (!index) {
      index = new Map()
      this.workspaceIndex.set(workspacePath, index)
    }
    return index
  }

  private getTokenIndex(workspacePath: string): Map<string, Set<string>> {
    let index = this.workspaceTokens.get(workspacePath)
    if (!index) {
      index = new Map()
      this.workspaceTokens.set(workspacePath, index)
    }
    return index
  }

  private loadIndex(workspacePath: string): void {
    if (this.loaded.get(workspacePath)) return

    const index = this.getIndex(workspacePath)
    const tokenIndex = this.getTokenIndex(workspacePath)
    try {
      const content = fs.readFileSync(this.factsPath(workspacePath), 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue
        try {
          const parsed = JSON.parse(trimmed) as Memory
          if (parsed.id && parsed.text) {
            index.set(parsed.id, parsed)
            tokenIndex.set(parsed.id, tokenize(parsed.text))
          }
        } catch {
          // Skip malformed lines; one bad append should not hide valid memories.
        }
      }
    } catch {
      // The file is created on first write.
    }

    this.loaded.set(workspacePath, true)
  }

  private findDuplicate(text: string, workspacePath: string): string | null {
    this.loadIndex(workspacePath)
    const tokens = tokenize(text)
    const index = this.getIndex(workspacePath)
    const tokenIndex = this.getTokenIndex(workspacePath)

    for (const [id, existingTokens] of tokenIndex) {
      const existing = index.get(id)
      if (!existing || existing.status !== 'active') continue
      if (jaccardSimilarity(tokens, existingTokens) >= DEDUP_THRESHOLD) return id
    }
    return null
  }

  private appendLine(workspacePath: string, memory: Memory): void {
    this.ensureDirForWrite(workspacePath)
    fs.appendFileSync(this.factsPath(workspacePath), `${JSON.stringify(memory)}\n`, 'utf-8')

    this.getIndex(workspacePath).set(memory.id, memory)
    this.getTokenIndex(workspacePath).set(memory.id, tokenize(memory.text))
  }

  async remember(request: MemoryWriteRequest): Promise<MemoryWriteResponse> {
    const { workspacePath, text, kind, scope, tags, evidence, confidence, conversationId, messageId } = request
    const sanitized = sanitizeMemoryText(text)
    if (!sanitized) {
      return { success: false, error: 'Memory text is empty after sanitization' }
    }

    this.loadIndex(workspacePath)
    const index = this.getIndex(workspacePath)
    const activeCount = Array.from(index.values()).filter(m => m.status === 'active').length
    if (activeCount >= DYNAMIC_STORE_SOFT_CAP) {
      return { success: false, error: `Memory store has reached ${DYNAMIC_STORE_SOFT_CAP} active entries` }
    }

    const duplicateId = this.findDuplicate(sanitized, workspacePath)
    if (duplicateId) {
      const existing = index.get(duplicateId)!
      const updated: Memory = {
        ...existing,
        text: sanitized,
        updatedAt: Date.now(),
        tags: Array.from(new Set([...(existing.tags || []), ...(tags || [])])).slice(0, 12),
      }
      this.appendLine(workspacePath, updated)
      return { success: true, id: duplicateId, deduplicated: true }
    }

    const memEvidence: MemoryEvidence[] = evidence ? [...evidence] : []
    if (conversationId) memEvidence.push({ kind: 'conversation', conversationId, messageId })
    if (memEvidence.length === 0) memEvidence.push({ kind: 'tool_result', quote: 'agent:remember tool' })

    const now = Date.now()
    const memory: Memory = {
      id: `dyn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scope: scope ?? 'workspace_private',
      kind: kind ?? 'fact',
      text: sanitized,
      source: conversationId ? `conversation:${conversationId}` : 'agent:remember',
      evidence: memEvidence,
      confidence: confidence ?? 'observed',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      tags: (tags ?? []).slice(0, 8),
      reviewState: 'auto',
      status: 'active',
    }

    this.appendLine(workspacePath, memory)
    return { success: true, id: memory.id }
  }

  async forget(request: MemoryForgetRequest): Promise<MemoryForgetResponse> {
    const { workspacePath, id, reason } = request
    this.loadIndex(workspacePath)

    const existing = this.getIndex(workspacePath).get(id)
    if (!existing) return { success: false, error: `Memory not found: ${id}` }
    if (existing.status !== 'active') return { success: false, error: `Memory already ${existing.status}: ${id}` }

    const updated: Memory = {
      ...existing,
      status: 'rejected',
      updatedAt: Date.now(),
      tags: [...(existing.tags || []), reason ? `forget:${reason.slice(0, 30)}` : 'forget:manual'],
    }
    this.appendLine(workspacePath, updated)
    return { success: true }
  }

  async update(request: MemoryUpdateRequest): Promise<MemoryUpdateResponse> {
    const { workspacePath, id, text, kind, tags, pinned, status } = request
    this.loadIndex(workspacePath)

    const existing = this.getIndex(workspacePath).get(id)
    if (!existing) return { success: false, error: `Memory not found: ${id}` }

    const updated: Memory = { ...existing, updatedAt: Date.now() }
    if (text !== undefined) {
      const sanitized = sanitizeMemoryText(text)
      if (!sanitized) return { success: false, error: 'Updated text is empty after sanitization' }
      updated.text = sanitized
    }
    if (kind !== undefined) updated.kind = kind
    if (tags !== undefined) updated.tags = tags.slice(0, 12)
    if (pinned !== undefined) updated.pinned = pinned
    if (status !== undefined) updated.status = status

    this.appendLine(workspacePath, updated)
    return { success: true }
  }

  invalidate(workspacePath: string): void {
    this.workspaceIndex.delete(workspacePath)
    this.workspaceTokens.delete(workspacePath)
    this.loaded.delete(workspacePath)
  }
}
