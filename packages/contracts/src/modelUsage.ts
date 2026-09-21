import type { ModelRequestRecord, TokenUsage } from './agentTypes'

const tokenFields = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'] as const
const requestFields = new Set(['id', 'requestId', 'runId', 'model', 'provider', 'protocol', 'purpose', 'status', 'startedAt', 'updatedAt', 'endedAt', 'durationMs', 'providerResponseId', 'requestFingerprint', 'httpStatus', 'usage', 'usageFinal', 'cacheDiagnostic'])

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  if (Object.keys(usage).some(key => key !== 'source' && !tokenFields.includes(key as typeof tokenFields[number]))) return false
  if (usage.source !== undefined && usage.source !== 'provider' && usage.source !== 'unknown') return false
  if (!tokenFields.every(key => usage[key] === undefined || (Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0))) return false
  if (usage.source === 'provider' && !tokenFields.some(key => usage[key] !== undefined)) return false
  if (typeof usage.input === 'number' && typeof usage.cached === 'number' && usage.cached > usage.input) return false
  return true
}

export function isModelRequestRecord(value: unknown): value is ModelRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !requestFields.has(key))) return false
  if (typeof item.id !== 'string' || !item.id || typeof item.requestId !== 'string' || !item.requestId) return false
  if (!['running', 'completed', 'failed', 'interrupted'].includes(String(item.status))) return false
  if (!['turn', 'compaction', 'legacy'].includes(String(item.purpose))) return false
  if (!Number.isFinite(item.startedAt) || !Number.isFinite(item.updatedAt) || typeof item.usageFinal !== 'boolean') return false
  if (!isTokenUsage(item.usage)) return false
  if (item.usageFinal && (item.status === 'running' || item.usage.source !== 'provider')) return false
  if (item.protocol !== undefined && !['openai_responses', 'openai_chat', 'anthropic_messages'].includes(String(item.protocol))) return false
  for (const key of ['model', 'provider', 'runId', 'providerResponseId', 'requestFingerprint']) {
    if (item[key] !== undefined && typeof item[key] !== 'string') return false
  }
  if (item.endedAt !== undefined && !Number.isFinite(item.endedAt)) return false
  if (item.durationMs !== undefined && (!Number.isFinite(item.durationMs) || Number(item.durationMs) < 0)) return false
  if (item.httpStatus !== undefined && (!Number.isSafeInteger(item.httpStatus) || Number(item.httpStatus) < 100 || Number(item.httpStatus) > 599)) return false
  if (item.cacheDiagnostic !== undefined) {
    const diagnostic = item.cacheDiagnostic as Record<string, unknown>
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
      || Object.keys(diagnostic).some(key => !['broken', 'reason', 'tokenDrop', 'likelyTtlExpiry', 'requestTiming'].includes(key))
      || typeof diagnostic.broken !== 'boolean'
      || typeof diagnostic.reason !== 'string' || !Number.isFinite(diagnostic.tokenDrop)
      || typeof diagnostic.likelyTtlExpiry !== 'boolean') return false
    const timing = diagnostic.requestTiming as Record<string, unknown> | undefined
    if (timing && (typeof timing !== 'object' || Array.isArray(timing)
      || Object.keys(timing).some(key => !['idleMs', 'durationMs'].includes(key))
      || !Number.isFinite(timing.idleMs) || Number(timing.idleMs) < 0 || !Number.isFinite(timing.durationMs) || Number(timing.durationMs) < 0)) return false
  }
  return true
}

export function mergeModelRequest(previous: ModelRequestRecord | undefined, incoming: ModelRequestRecord): ModelRequestRecord {
  if (!previous) return structuredClone(incoming)
  if (previous.id !== incoming.id || previous.requestId !== incoming.requestId) throw new Error('Model request identity changed')
  if (incoming.updatedAt < previous.updatedAt || (previous.status !== 'running' && incoming.status === 'running')) return previous
  return { ...structuredClone(previous), ...structuredClone(incoming),
    usage: incoming.usage.source === 'unknown' && previous.usage.source === 'provider'
      ? { ...previous.usage } : { ...previous.usage, ...incoming.usage },
  }
}

/** Totals cover known provider fields only; unknown/partial attempts remain explicit. */
export function summarizeModelRequests(records: readonly ModelRequestRecord[]) {
  const latest = new Map<string, ModelRequestRecord>()
  for (const record of records) latest.set(record.id, mergeModelRequest(latest.get(record.id), record))
  const attempts = [...latest.values()]
  const totals = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 }
  let cacheInput = 0
  let cacheTokens = 0
  let knownUsageAttempts = 0
  for (const record of attempts) {
    if (record.usage.source !== 'provider') continue
    knownUsageAttempts += 1
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += record.usage[key] ?? 0
    if (record.usage.cached !== undefined && record.usage.input !== undefined) {
      cacheInput += record.usage.input
      cacheTokens += record.usage.cached
    }
  }
  return {
    attempts: attempts.length,
    requests: new Set(attempts.map(record => record.requestId)).size,
    knownUsageAttempts,
    unknownUsageAttempts: attempts.length - knownUsageAttempts,
    incompleteUsageAttempts: attempts.filter(record => !record.usageFinal).length,
    totals,
    cacheHitRate: cacheInput > 0 ? cacheTokens / cacheInput : undefined,
    cacheMeasuredInput: cacheInput,
  }
}

export type ModelUsageSummary = ReturnType<typeof summarizeModelRequests>
