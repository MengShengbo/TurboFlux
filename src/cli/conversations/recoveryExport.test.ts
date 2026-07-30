import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { redactRecoveryValue, writeConversationRecoveryBundle, type ConversationRecoveryBundle } from './recoveryExport'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('conversation recovery export', () => {
  it('redacts credential keys and common inline tokens without removing recovery text', () => {
    expect(redactRecoveryValue({
      apiKey: 'secret-key',
      content: 'keep this task; Authorization: Bearer token.value',
      nested: { password: 'hidden' },
    })).toEqual({
      apiKey: '[REDACTED]',
      content: 'keep this task; Authorization: [REDACTED]',
      nested: { password: '[REDACTED]' },
    })
  })

  it('writes a non-overwriting read-only recovery bundle', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'turboflux-recovery-export-'))
    directories.push(workspace)
    const target = join(workspace, 'recovery.json')
    const bundle = {
      schemaVersion: 1,
      exportedAt: 100,
      readOnlyRecovery: true,
      conversation: {
        id: 'conversation-1',
        title: 'Recover me',
        workspacePath: workspace,
        createdAt: 1,
        updatedAt: 2,
        mode: 'vibe',
        model: 'test',
        provider: 'custom',
        turnCount: 0,
        turns: [],
      },
      persistence: { status: 'degraded', error: 'disk full', degradedAt: 99, pendingRecoveryEntries: 1 },
      journalStats: {
        physicalWrites: 0,
        entriesWritten: 0,
        streamingEntriesQueued: 0,
        streamingBatchesWritten: 0,
        retryAttempts: 0,
      },
    } satisfies ConversationRecoveryBundle

    expect(writeConversationRecoveryBundle(workspace, bundle, target)).toBe(target)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({
      readOnlyRecovery: true,
      conversation: { title: 'Recover me' },
      persistence: { status: 'degraded' },
    })
    expect(() => writeConversationRecoveryBundle(workspace, bundle, target)).toThrow(/already exists/)
  })
})
