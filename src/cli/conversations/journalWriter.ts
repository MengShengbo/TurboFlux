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
}

export interface ConversationJournalWriterOptions {
  flushIntervalMs?: number
  retryIntervalMs?: number
  batchStreaming?: boolean
  onStatus?: (error: Error | null) => void
}

export function coalesceStreamingEntries(entries: ConversationJournalEntry[]): ConversationJournalEntry[] {
  const coalesced: ConversationJournalEntry[] = []
  for (const entry of entries) {
    const previous = coalesced[coalesced.length - 1]
    if (
      previous
      && entry.version === 1
      && previous.version === 1
      && (entry.type === 'stream_delta' || entry.type === 'stream_thinking_delta')
      && previous.type === entry.type
    ) {
      previous.text += entry.text
      continue
    }
    if (previous && entry.version === 2 && previous.version === 2 && entry.type === 'draft_state' && previous.type === 'draft_state') {
      coalesced[coalesced.length - 1] = { ...entry, draft: { ...entry.draft } }
      continue
    }
    coalesced.push({ ...entry } as ConversationJournalEntry)
  }
  return coalesced
}

export class ConversationJournalWriter {
  private conversationId: string
  private readonly flushIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly batchStreaming: boolean
  private readonly onStatus?: (error: Error | null) => void
  private pendingStreaming: ConversationJournalEntry[] = []
  private pendingRecovery: ConversationJournalEntry[] = []
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
    this.onStatus = options.onStatus
  }

  append(entry: ConversationJournalEntry, durability: JournalDurability): void {
    if (this.closed) throw new Error('Conversation journal writer is closed')
    if (durability === 'streaming' && this.batchStreaming) {
      this.pendingStreaming.push(entry)
      this.stats.streamingEntriesQueued += 1
      this.scheduleFlush(this.flushIntervalMs)
      return
    }

    if (durability === 'streaming') this.stats.streamingEntriesQueued += 1
    const throwOnError = durability === 'critical'
    try {
      if (!this.flush(throwOnError)) {
        this.pendingRecovery.push(entry)
        if (throwOnError) throw (this.persistenceError ?? new Error('Conversation journal is degraded'))
        return
      }
      const written = this.writeBatch([entry], throwOnError, durability === 'streaming')
      if (!written) {
        this.pendingRecovery.push(entry)
        this.scheduleFlush(this.retryIntervalMs)
      }
    } catch (error) {
      this.pendingRecovery.push(entry)
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
      ...coalesceStreamingEntries(this.pendingStreaming),
    ]
    try {
      const written = this.writeBatch(batch, throwOnError, hadStreaming)
      if (written) {
        this.pendingRecovery = []
        this.pendingStreaming = []
      } else {
        this.pendingRecovery = batch
        this.pendingStreaming = []
        this.scheduleFlush(this.retryIntervalMs)
      }
      return written
    } catch (error) {
      this.pendingRecovery = batch
      this.pendingStreaming = []
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
      this.pendingRecovery.push(probeEntry)
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
    }
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
