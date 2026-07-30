import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { PersistedConversation } from './types'
import type { ConversationJournalWriterStats } from './journalWriter'

export interface ConversationRecoveryExportHealth {
  status: 'healthy' | 'degraded'
  error: string | null
  degradedAt: number | null
  pendingRecoveryEntries: number
}

export interface ConversationRecoveryBundle {
  schemaVersion: 1
  exportedAt: number
  readOnlyRecovery: true
  conversation: PersistedConversation
  persistence: ConversationRecoveryExportHealth
  journalStats: ConversationJournalWriterStats
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|cookie|password|secret|access[_-]?token|refresh[_-]?token|signature)/i
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const SECRET_TOKEN_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g
const ASSIGNED_SECRET_PATTERN = /\b((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,;]+/gi

export function redactRecoveryValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(BEARER_TOKEN_PATTERN, '[REDACTED]')
      .replace(SECRET_TOKEN_PATTERN, '[REDACTED]')
      .replace(ASSIGNED_SECRET_PATTERN, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(item => redactRecoveryValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactRecoveryValue(entryValue, entryKey),
    ]),
  )
}

export function writeConversationRecoveryBundle(
  workspacePath: string,
  bundle: ConversationRecoveryBundle,
  requestedPath?: string,
): string {
  const targetPath = requestedPath?.trim()
    ? (isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspacePath, requestedPath))
    : join(
        workspacePath,
        '.turboflux',
        'recovery',
        `${safeFileName(bundle.conversation.id)}-${new Date(bundle.exportedAt).toISOString().replace(/[:.]/g, '-')}.json`,
      )
  if (existsSync(targetPath)) throw new Error(`Recovery export already exists: ${targetPath}`)
  mkdirSync(dirname(targetPath), { recursive: true })
  const redacted = redactRecoveryValue(bundle) as ConversationRecoveryBundle
  writeFileSync(targetPath, `${JSON.stringify(redacted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return targetPath
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'conversation'
}
