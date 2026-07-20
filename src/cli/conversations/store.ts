import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import type { AgentTurn, ToolCall, ToolResult } from '../../shared/agentTypes'
import type { ConversationJournalEntry, ConversationMeta, PersistedConversation } from './types'

const DEFAULT_CONVERSATIONS_DIR = join(homedir(), '.turboflux', 'conversations')
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const checkedJournalBoundaries = new Set<string>()

function conversationsDir(): string {
  return process.env.TURBOFLUX_CONVERSATIONS_DIR || DEFAULT_CONVERSATIONS_DIR
}

function ensureDir(): string {
  const directory = conversationsDir()
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function conversationPath(id: string, extension: 'json' | 'jsonl'): string {
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error(`Invalid conversation id: ${id}`)
  return join(ensureDir(), `${id}.${extension}`)
}

function cloneConversation(conversation: PersistedConversation): PersistedConversation {
  return JSON.parse(JSON.stringify(conversation)) as PersistedConversation
}

function readLegacyConversation(id: string): PersistedConversation | null {
  let filePath: string
  try {
    filePath = conversationPath(id, 'json')
  } catch {
    return null
  }
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedConversation
  } catch {
    return null
  }
}

function readJournal(id: string): { entries: ConversationJournalEntry[]; truncated: boolean } {
  let filePath: string
  try {
    filePath = conversationPath(id, 'jsonl')
  } catch {
    return { entries: [], truncated: false }
  }
  if (!existsSync(filePath)) return { entries: [], truncated: false }

  const entries: ConversationJournalEntry[] = []
  let truncated = false
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as ConversationJournalEntry
      if (entry.version !== 1 || typeof entry.type !== 'string') throw new Error('Unsupported journal entry')
      entries.push(entry)
    } catch {
      truncated = true
    }
  }
  return { entries, truncated }
}

function createConversation(meta: ConversationMeta): PersistedConversation {
  return {
    ...meta,
    turnCount: 0,
    turns: [],
    activeTurns: [],
    contextSegments: [],
    contextReservoir: [],
  }
}

function upsertTurn(turns: AgentTurn[], turn: AgentTurn): void {
  const index = turns.findIndex(existing => existing.id === turn.id)
  if (index >= 0) turns[index] = turn
  else turns.push(turn)
}

function createRecoveredAssistantTurn(timestamp: number, content: string, toolCalls?: ToolCall[], thinking = ''): AgentTurn {
  return {
    id: `recovered-assistant-${timestamp}`,
    role: 'assistant',
    content,
    timestamp,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    metadata: {
      interrupted: true,
      thinking: thinking ? {
        content: thinking,
        source: 'provider',
        status: 'interrupted',
        tokenCount: Math.max(1, Math.ceil(thinking.length / 4)),
      } : undefined,
    },
  }
}

function createRecoveredToolResultTurn(timestamp: number, results: ToolResult[], sourceTurnId = ''): AgentTurn {
  return {
    id: `recovered-tools-${timestamp}${sourceTurnId ? `-${sourceTurnId}` : ''}`,
    role: 'tool_result',
    content: results.map(result => `${result.name}: ${result.isError ? '[failed]' : '[ok]'} ${result.output.slice(0, 500)}`).join('\n\n'),
    timestamp,
    toolResults: results,
    metadata: { interrupted: results.some(result => result.errorKind === 'abort') },
  }
}

function replayConversation(id: string, legacy: PersistedConversation | null, entries: ConversationJournalEntry[], truncatedJournal: boolean): PersistedConversation | null {
  let conversation = legacy ? cloneConversation(legacy) : null
  let pendingStream: { startedAt: number; content: string; thinking: string; interrupted: boolean } | null = null
  const pendingToolCalls = new Map<string, ToolCall>()
  const journalToolResults = new Map<string, ToolResult>()
  let latestTimestamp = conversation?.updatedAt || 0
  let interrupted = false

  for (const entry of entries) {
    latestTimestamp = Math.max(latestTimestamp, entry.timestamp)
    switch (entry.type) {
      case 'meta':
        conversation = conversation || createConversation(entry.meta)
        Object.assign(conversation, entry.meta)
        break
      case 'snapshot':
        conversation = cloneConversation(entry.conversation)
        pendingStream = null
        pendingToolCalls.clear()
        journalToolResults.clear()
        break
      case 'turn':
        if (!conversation) break
        upsertTurn(conversation.turns, entry.turn)
        conversation.activeTurns = conversation.activeTurns || []
        upsertTurn(conversation.activeTurns, entry.turn)
        if (entry.turn.role === 'assistant') pendingStream = null
        if (entry.turn.toolResults) {
          for (const result of entry.turn.toolResults) journalToolResults.delete(result.toolCallId)
        }
        break
      case 'stream_start':
        if (pendingStream && (pendingStream.content || pendingStream.thinking || pendingToolCalls.size > 0)) interrupted = true
        pendingToolCalls.clear()
        pendingStream = { startedAt: entry.timestamp, content: '', thinking: '', interrupted: false }
        break
      case 'stream_delta':
        pendingStream = pendingStream || { startedAt: entry.timestamp, content: '', thinking: '', interrupted: false }
        pendingStream.content += entry.text
        break
      case 'stream_thinking_delta':
        pendingStream = pendingStream || { startedAt: entry.timestamp, content: '', thinking: '', interrupted: false }
        pendingStream.thinking += entry.text
        break
      case 'stream_end':
        if (pendingStream) pendingStream.interrupted = entry.interrupted
        break
      case 'tool_call':
        pendingToolCalls.set(entry.toolCall.id, entry.toolCall)
        break
      case 'tool_result':
        journalToolResults.set(entry.toolResult.toolCallId, entry.toolResult)
        pendingToolCalls.delete(entry.toolResult.toolCallId)
        break
      case 'state':
        if (!conversation) break
        conversation.activeTurns = entry.activeTurns
        conversation.contextSegments = entry.contextSegments
        conversation.contextReservoir = entry.contextReservoir
        break
    }
  }

  if (!conversation) return null
  conversation.activeTurns = conversation.activeTurns || [...conversation.turns]

  if (pendingStream && (pendingStream.content || pendingStream.thinking || pendingToolCalls.size > 0)) {
    const calls = Array.from(pendingToolCalls.values())
    const recovered = createRecoveredAssistantTurn(
      Math.max(latestTimestamp, pendingStream.startedAt),
      pendingStream.content,
      calls,
      pendingStream.thinking,
    )
    upsertTurn(conversation.turns, recovered)
    upsertTurn(conversation.activeTurns, recovered)
    interrupted = true
  }

  const existingResultIds = new Set(conversation.turns.flatMap(turn => turn.toolResults?.map(result => result.toolCallId) || []))
  const unresolvedGroups = conversation.turns
    .map((turn, index) => ({
      turn,
      index,
      calls: (turn.toolCalls || []).filter(call => !existingResultIds.has(call.id)),
    }))
    .filter(group => group.calls.length > 0)
  const missingToolResults = unresolvedGroups.flatMap(group => group.calls).filter(call => !journalToolResults.has(call.id))
  for (const group of [...unresolvedGroups].reverse()) {
    const recoveredResults = group.calls.map(call => journalToolResults.get(call.id) || {
      toolCallId: call.id,
      name: call.name,
      output: 'Interrupted: tool result was not recorded before restart.',
      isError: true,
      errorKind: 'abort' as const,
    })
    const resultTimestamp = group.turn.timestamp + 1
    const resultTurn = createRecoveredToolResultTurn(resultTimestamp, recoveredResults, group.turn.id)
    conversation.turns.splice(group.index + 1, 0, resultTurn)
    const activeIndex = conversation.activeTurns.findIndex(turn => turn.id === group.turn.id)
    if (activeIndex >= 0) conversation.activeTurns.splice(activeIndex + 1, 0, resultTurn)
    latestTimestamp = Math.max(latestTimestamp, resultTimestamp)
    interrupted = interrupted || recoveredResults.some(result => result.errorKind === 'abort')
  }

  const lastTurn = conversation.turns[conversation.turns.length - 1]
  if (lastTurn?.role === 'user') {
    const recovered = createRecoveredAssistantTurn(
      Math.max(latestTimestamp, lastTurn.timestamp + 1),
      'Interrupted: assistant response was not recorded before restart.',
    )
    upsertTurn(conversation.turns, recovered)
    upsertTurn(conversation.activeTurns, recovered)
    interrupted = true
  }

  conversation.id = id
  const firstUserTurn = conversation.turns.find(turn => turn.role === 'user')
  if (firstUserTurn && (!conversation.title || conversation.title === 'Untitled')) {
    conversation.title = firstUserTurn.content.slice(0, 60).replace(/\n/g, ' ')
  }
  conversation.turnCount = conversation.turns.length
  conversation.updatedAt = Math.max(conversation.updatedAt, latestTimestamp)
  conversation.recovery = {
    interrupted,
    truncatedJournal,
    unresolvedToolCalls: missingToolResults.length,
  }
  return conversation
}

export function appendConversationJournal(id: string, entry: ConversationJournalEntry): void {
  const filePath = conversationPath(id, 'jsonl')
  if (!checkedJournalBoundaries.has(filePath) && existsSync(filePath)) {
    const descriptor = openSync(filePath, 'r')
    let needsBoundary = false
    try {
      const size = fstatSync(descriptor).size
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1)
        readSync(descriptor, lastByte, 0, 1, size - 1)
        needsBoundary = lastByte[0] !== 0x0a
      }
    } finally {
      closeSync(descriptor)
    }
    if (needsBoundary) appendFileSync(filePath, '\n', 'utf-8')
  }
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 })
  checkedJournalBoundaries.add(filePath)
  try { chmodSync(filePath, 0o600) } catch {}
}

export function saveConversation(conv: PersistedConversation): void {
  appendConversationJournal(conv.id, {
    version: 1,
    type: 'snapshot',
    timestamp: Date.now(),
    conversation: conv,
  })
}

export function loadConversation(id: string): PersistedConversation | null {
  const legacy = readLegacyConversation(id)
  const journal = readJournal(id)
  if (!legacy && journal.entries.length === 0) return null
  return replayConversation(id, legacy, journal.entries, journal.truncated)
}

export function deleteConversation(id: string): boolean {
  let deleted = false
  for (const extension of ['json', 'jsonl'] as const) {
    let filePath: string
    try {
      filePath = conversationPath(id, extension)
    } catch {
      return false
    }
    if (!existsSync(filePath)) continue
    unlinkSync(filePath)
    checkedJournalBoundaries.delete(filePath)
    deleted = true
  }
  return deleted
}

export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value).replace(/\\/g, '/')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

export function listConversations(workspacePath?: string): ConversationMeta[] {
  const files = readdirSync(ensureDir()).filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
  const ids = new Set(files.map(file => file.replace(/\.(json|jsonl)$/, '')))
  const metas: ConversationMeta[] = []

  for (const id of ids) {
    const conv = loadConversation(id)
    if (!conv) continue
    if (workspacePath && !sameWorkspacePath(conv.workspacePath, workspacePath)) continue
    metas.push({
      id: conv.id,
      title: conv.title,
      workspacePath: conv.workspacePath,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      mode: conv.mode,
      model: conv.model,
      provider: conv.provider,
      turnCount: conv.turnCount || conv.turns.length,
    })
  }

  return metas.sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getConversationsDir(): string {
  return conversationsDir()
}
