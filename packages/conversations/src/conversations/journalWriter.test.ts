import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationJournalWriter } from './journalWriter'

describe.sequential('ConversationJournalWriter', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'turboflux-journal-writer-'))
    process.env.TURBOFLUX_CONVERSATIONS_DIR = directory
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.TURBOFLUX_CONVERSATIONS_DIR
    rmSync(directory, { recursive: true, force: true })
  })

  it('coalesces a delta burst into one physical write', () => {
    const writer = new ConversationJournalWriter('conversation-1')
    for (let index = 0; index < 100; index += 1) {
      writer.append({ version: 1, type: 'stream_delta', timestamp: index, text: 'x' }, 'streaming')
    }

    expect(writer.getStats().physicalWrites).toBe(0)
    expect(writer.getHealth().pendingStreamingEntries).toBe(1)
    writer.flush(true)

    expect(writer.getStats()).toMatchObject({
      physicalWrites: 1,
      entriesWritten: 1,
      streamingEntriesQueued: 100,
      streamingBatchesWritten: 1,
    })
    const records = readFileSync(join(directory, 'conversation-1.jsonl'), 'utf-8').trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([expect.objectContaining({ type: 'stream_delta', text: 'x'.repeat(100) })])
  })

  it('flushes pending streaming data before a terminal record', () => {
    const writer = new ConversationJournalWriter('conversation-1')
    writer.append({ version: 1, type: 'stream_delta', timestamp: 1, text: 'partial' }, 'streaming')
    writer.append({ version: 1, type: 'stream_end', timestamp: 2, interrupted: false }, 'terminal')

    const records = readFileSync(join(directory, 'conversation-1.jsonl'), 'utf-8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.map(record => record.type)).toEqual(['stream_delta', 'stream_end'])
    expect(writer.getStats().physicalWrites).toBe(2)
  })

  it('flushes streaming data on the bounded timer', () => {
    vi.useFakeTimers()
    const writer = new ConversationJournalWriter('conversation-1', { flushIntervalMs: 80 })
    writer.append({ version: 1, type: 'stream_delta', timestamp: 1, text: 'partial' }, 'streaming')

    vi.advanceTimersByTime(79)
    expect(writer.getStats().physicalWrites).toBe(0)
    vi.advanceTimersByTime(1)
    expect(writer.getStats().physicalWrites).toBe(1)
  })

  it('retains a failed critical entry for explicit retry', () => {
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf8')
    const writer = new ConversationJournalWriter('conversation-1')
    const entry = { version: 1, type: 'stream_start', timestamp: 1 } as const

    expect(() => writer.append(entry, 'critical')).toThrow()
    expect(writer.getHealth()).toMatchObject({
      status: 'degraded',
      pendingRecoveryEntries: 1,
    })

    rmSync(directory, { force: true })
    mkdirSync(directory)
    expect(writer.retry()).toBe(true)
    expect(writer.getHealth()).toMatchObject({ status: 'healthy', pendingRecoveryEntries: 0 })
    expect(JSON.parse(readFileSync(join(directory, 'conversation-1.jsonl'), 'utf8').trim())).toMatchObject(entry)
  })

  it('can roll streaming batching back without creating a second writer', () => {
    const writer = new ConversationJournalWriter('conversation-1', { batchStreaming: false })
    writer.append({ version: 1, type: 'stream_delta', timestamp: 1, text: 'a' }, 'streaming')
    writer.append({ version: 1, type: 'stream_delta', timestamp: 2, text: 'b' }, 'streaming')

    expect(writer.getStats()).toMatchObject({ physicalWrites: 2, streamingBatchesWritten: 2 })
  })

  it('bounds streaming and recovery buffers while persistence stays unavailable', () => {
    vi.useFakeTimers()
    rmSync(directory, { recursive: true, force: true })
    writeFileSync(directory, 'not a directory', 'utf8')
    const writer = new ConversationJournalWriter('conversation-1', {
      flushIntervalMs: 60_000,
      retryIntervalMs: 60_000,
      maxPendingStreamingEntries: 2,
      maxPendingStreamingCharacters: 500,
      maxPendingRecoveryEntries: 1,
      maxPendingRecoveryCharacters: 300,
    })

    for (let index = 0; index < 40; index += 1) {
      writer.append({ version: 1, type: 'stream_delta', timestamp: index, text: 'x'.repeat(30) }, 'streaming')
    }

    expect(writer.getHealth()).toMatchObject({
      status: 'degraded',
      pendingRecoveryEntries: expect.any(Number),
      pendingStreamingEntries: 1,
    })
    expect(writer.getHealth().pendingRecoveryEntries).toBeLessThanOrEqual(1)
    expect(writer.getHealth().pendingRecoveryCharacters).toBeLessThanOrEqual(300)
    expect(writer.getHealth().pendingStreamingCharacters).toBeLessThanOrEqual(500)
    writer.close()
  })
})
