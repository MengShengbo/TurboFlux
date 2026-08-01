import type { ConversationJournalEntry } from './types'
import { appendConversationJournalBatch } from './store'

export type JournalDurability = 'critical' | 'terminal' | 'streaming'

export interface ConversationJournalWriterStats {
  physicalWrites: number
  entriesWritten: number
  streamingEntriesQueued: number
  streamingBatchesWritten: number
  retryAttempts: number
}

export interface ConversationJournalWriterHealth {
  status: 'healthy' | 'degraded'
  error: string | null
  failedAt: number | null
  pendingRecoveryEntries: number
  pendingStreamingEntries: number
  pendingRecoveryCharacters: number
  pendingStreamingCharacters: number
}

export interface ConversationJournalWriterOptions {
  flushIntervalMs?: number
  retryIntervalMs?: number
  batchStreaming?: boolean
  maxPendingStreamingEntries?: number
  maxPendingStreamingCharacters?: number
  maxPendingRecoveryEntries?: number
  maxPendingRecoveryCharacters?: number
  onStatus?: (error: Error | null) => void
}

const DEFAULT_MAX_PENDING_STREAMING_ENTRIES = 2_048
const DEFAULT_MAX_PENDING_STREAMING_CHARACTERS = 2 * 1024 * 1024
const DEFAULT_MAX_PENDING_RECOVERY_ENTRIES = 4_096
const DEFAULT_MAX_PENDING_RECOVERY_CHARACTERS = 16 * 1024 * 1024

type StreamingTextEntry = Extract<ConversationJournalEntry, { type: 'stream_delta' | 'stream_thinking_delta' }>

interface PendingStreamingEntry {
  entry: ConversationJournalEntry
  chunks?: string[]
}

function isStreamingTextEntry(entry: ConversationJournalEntry): entry is StreamingTextEntry {
  return entry.version === 1 && (entry.type === 'stream_delta' || entry.type === 'stream_thinking_delta')
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value!)) : fallback
}

function journalEntryCharacters(entry: ConversationJournalEntry): number {
  try {
    return JSON.stringify(entry).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export function coalesceStreamingEntries(entries: ConversationJournalEntry[]): ConversationJournalEntry[] {
  const coalesced: ConversationJournalEntry[] = []
  for (let index = 0; index < entries.length;) {
    const entry = entries[index]!
    if (entry.version === 1 && (entry.type === 'stream_delta' || entry.type === 'stream_thinking_delta')) {
      const chunks = [entry.text]
      let nextIndex = index + 1
      while (nextIndex < entries.length) {
        const next = entries[nextIndex]!
        if (next.version !== 1 || next.type !== entry.type) break
        chunks.push(next.text)
        nextIndex += 1
      }
      coalesced.push({ ...entry, text: chunks.join('') })
      index = nextIndex
      continue
    }
    if (entry.version === 2 && entry.type === 'draft_state') {
      let latest = entry
      let nextIndex = index + 1
      while (nextIndex < entries.length) {
        const next = entries[nextIndex]!
        if (next.version !== 2 || next.type !== 'draft_state') break
        latest = next
        nextIndex += 1
      }
      coalesced.push({ ...latest, draft: { ...latest.draft } })
      index = nextIndex
      continue
    }
    coalesced.push({ ...entry } as ConversationJournalEntry)
    index += 1
  }
  return coalesced
}

export class ConversationJournalWriter {
  private conversationId: string
  private readonly flushIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly batchStreaming: boolean
  private readonly maxPendingStreamingEntries: number
  private readonly maxPendingStreamingCharacters: number
  private readonly maxPendingRecoveryEntries: number
  private readonly maxPendingRecoveryCharacters: number
  private readonly onStatus?: (error: Error | null) => void
  private pendingStreaming: PendingStreamingEntry[] = []
  private pendingStreamingSourceEntries = 0
  private pendingStreamingCharacters = 0
  private pendingRecovery: ConversationJournalEntry[] = []
  private pendingRecoveryCharacters = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private persistenceError: Error | null = null
  private failedAt: number | null = null
  private closed = false
  private stats: ConversationJournalWriterStats = {
    physicalWrites: 0,
    entriesWritten: 0,
    streamingEntriesQueued: 0,
    streamingBatchesWritten: 0,
    retryAttempts: 0,
  }

  constructor(conversationId: string, options: ConversationJournalWriterOptions = {}) {
    this.conversationId = conversationId
    this.flushIntervalMs = options.flushIntervalMs ?? 80
    this.retryIntervalMs = options.retryIntervalMs ?? 250
    this.batchStreaming = options.batchStreaming ?? true
    this.maxPendingStreamingEntries = positiveLimit(options.maxPendingStreamingEntries, DEFAULT_MAX_PENDING_STREAMING_ENTRIES)
    this.maxPendingStreamingCharacters = positiveLimit(options.maxPendingStreamingCharacters, DEFAULT_MAX_PENDING_STREAMING_CHARACTERS)
    this.maxPendingRecoveryEntries = positiveLimit(options.maxPendingRecoveryEntries, DEFAULT_MAX_PENDING_RECOVERY_ENTRIES)
    this.maxPendingRecoveryCharacters = positiveLimit(options.maxPendingRecoveryCharacters, DEFAULT_MAX_PENDING_RECOVERY_CHARACTERS)
    this.onStatus = options.onStatus
  }

  append(entry: ConversationJournalEntry, durability: JournalDurability): void {
    if (this.closed) throw new Error('Conversation journal writer is closed')
    if (durability === 'streaming' && this.batchStreaming) {
      this.stats.streamingEntriesQueued += 1
      this.enqueueStreaming(entry)
      return
    }

    if (durability === 'streaming') this.stats.streamingEntriesQueued += 1
    const throwOnError = durability === 'critical'
    try {
      if (!this.flush(throwOnError)) {
        this.enqueueRecovery([entry])
        if (throwOnError) throw (this.persistenceError ?? new Error('Conversation journal is degraded'))
        return
      }
      const written = this.writeBatch([entry], throwOnError, durability === 'streaming')
      if (!written) {
        this.enqueueRecovery([entry])
        this.scheduleFlush(this.retryIntervalMs)
      }
    } catch (error) {
      this.enqueueRecovery([entry])
      throw error
    }
  }

  flush(throwOnError = false): boolean {
    this.clearTimer()
    if (this.pendingRecovery.length === 0 && this.pendingStreaming.length === 0) {
      return this.persistenceError === null
    }
    const hadStreaming = this.pendingStreaming.length > 0
    const batch = [
      ...this.pendingRecovery,
      ...coalesceStreamingEntries(this.materializePendingStreaming()),
    ]
    try {
      const written = this.writeBatch(batch, throwOnError, hadStreaming)
      if (written) {
        this.clearPendingRecovery()
        this.clearPendingStreaming()
      } else {
        this.replacePendingRecovery(batch)
        this.clearPendingStreaming()
        this.scheduleFlush(this.retryIntervalMs)
      }
      return written
    } catch (error) {
      this.replacePendingRecovery(batch)
      this.clearPendingStreaming()
      throw error
    }
  }

  retry(probeEntry?: ConversationJournalEntry): boolean {
    this.stats.retryAttempts += 1
    if (this.pendingRecovery.length > 0 || this.pendingStreaming.length > 0) return this.flush(true)
    if (!probeEntry) return this.persistenceError === null
    try {
      return this.writeBatch([probeEntry], true, false)
    } catch (error) {
      this.enqueueRecovery([probeEntry])
      throw error
    }
  }

  switchConversation(conversationId: string): void {
    this.flush(true)
    this.conversationId = conversationId
  }

  close(): void {
    if (this.closed) return
    this.flush(false)
    this.closed = true
    this.clearTimer()
  }

  getStats(): ConversationJournalWriterStats {
    return { ...this.stats }
  }

  getHealth(): ConversationJournalWriterHealth {
    return {
      status: this.persistenceError ? 'degraded' : 'healthy',
      error: this.persistenceError?.message ?? null,
      failedAt: this.failedAt,
      pendingRecoveryEntries: this.pendingRecovery.length,
      pendingStreamingEntries: this.pendingStreaming.length,
      pendingRecoveryCharacters: this.pendingRecoveryCharacters,
      pendingStreamingCharacters: this.pendingStreamingCharacters,
    }
  }

  private enqueueStreaming(entry: ConversationJournalEntry): void {
    const characters = journalEntryCharacters(entry)
    let persistenceReady = true
    if (
      this.pendingStreamingSourceEntries + 1 > this.maxPendingStreamingEntries
      || this.pendingStreamingCharacters + characters > this.maxPendingStreamingCharacters
    ) {
      persistenceReady = this.flush(false)
    }

    if (characters > this.maxPendingStreamingCharacters) {
      const written = persistenceReady && this.writeBatch([entry], false, true)
      if (!written) {
        this.enqueueRecovery([entry])
        this.scheduleFlush(this.retryIntervalMs)
      }
      return
    }

    const last = this.pendingStreaming.at(-1)
    if (isStreamingTextEntry(entry) && last && isStreamingTextEntry(last.entry) && last.entry.type === entry.type) {
      last.chunks!.push(entry.text)
    } else if (isStreamingTextEntry(entry)) {
      this.pendingStreaming.push({ entry: { ...entry, text: '' }, chunks: [entry.text] })
    } else {
      this.pendingStreaming.push({ entry })
    }
    this.pendingStreamingSourceEntries += 1
    this.pendingStreamingCharacters += characters
    this.scheduleFlush(this.flushIntervalMs)
  }

  private materializePendingStreaming(): ConversationJournalEntry[] {
    return this.pendingStreaming.map(({ entry, chunks }) => {
      if (!chunks || !isStreamingTextEntry(entry)) return entry
      return { ...entry, text: chunks.join('') }
    })
  }

  private enqueueRecovery(entries: ConversationJournalEntry[]): void {
    this.replacePendingRecovery([...this.pendingRecovery, ...entries])
  }

  private replacePendingRecovery(entries: ConversationJournalEntry[]): void {
    const bounded: ConversationJournalEntry[] = []
    let characters = 0
    let overflowed = false
    for (const entry of coalesceStreamingEntries(entries)) {
      const entryCharacters = journalEntryCharacters(entry)
      if (
        bounded.length >= this.maxPendingRecoveryEntries
        || characters + entryCharacters > this.maxPendingRecoveryCharacters
      ) {
        overflowed = true
        continue
      }
      bounded.push(entry)
      characters += entryCharacters
    }
    this.pendingRecovery = bounded
    this.pendingRecoveryCharacters = characters
    if (overflowed) {
      this.reportFailure(new Error('Conversation journal recovery buffer limit exceeded'))
    }
  }

  private clearPendingStreaming(): void {
    this.pendingStreaming = []
    this.pendingStreamingSourceEntries = 0
    this.pendingStreamingCharacters = 0
  }

  private clearPendingRecovery(): void {
    this.pendingRecovery = []
    this.pendingRecoveryCharacters = 0
  }

  private writeBatch(entries: ConversationJournalEntry[], throwOnError: boolean, streaming: boolean): boolean {
    try {
      appendConversationJournalBatch(this.conversationId, entries)
      this.stats.physicalWrites += 1
      this.stats.entriesWritten += entries.length
      if (streaming) this.stats.streamingBatchesWritten += 1
      this.reportSuccess()
      return true
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.reportFailure(normalized)
      if (throwOnError) throw normalized
      return false
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush(false)
    }, delayMs)
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private reportFailure(error: Error): void {
    if (this.persistenceError?.message === error.message) return
    this.persistenceError = error
    this.failedAt = Date.now()
    this.onStatus?.(error)
  }

  private reportSuccess(): void {
    if (!this.persistenceError) return
    this.persistenceError = null
    this.failedAt = null
    this.onStatus?.(null)
  }
}
