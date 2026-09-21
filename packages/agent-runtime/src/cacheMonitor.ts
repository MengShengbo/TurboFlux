/**
 * Cache break detection - lightweight cross-turn monitoring for prompt prefix
 * cache stability. Inspired by Claude Code's promptCacheBreakDetection.ts but
 * trimmed to TurboFlux's scope.
 *
 * Design goals:
 *   - Detect when cacheReadTokens drops > 5% and > 2000 absolute tokens
 *   - Pinpoint root cause by diffing system prompt, tool schemas, cache
 *     controls, model/provider, and request params
 *   - Emit a compact diagnostic string for the UI or console
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum absolute token drop to trigger a break warning. */
const MIN_CACHE_MISS_TOKENS = 2_000

/** Anthropic / OpenRouter cache TTL thresholds for server-side expiry detection. */
const CACHE_TTL_5MIN_MS = 5 * 60 * 1_000
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1_000
const CACHE_TTL_GPT_5_6_MS = 30 * 60 * 1_000

function cacheTtlThresholdMs(model: string): number {
  return /gpt-5\.6/i.test(model) ? CACHE_TTL_GPT_5_6_MS : CACHE_TTL_5MIN_MS
}

function minimumCacheableTokens(model: string): number {
  return /gpt-5\.6/i.test(model) ? 1_024 : 2_048
}

// ---------------------------------------------------------------------------
// Hash helpers (fast, dependency-free)
// ---------------------------------------------------------------------------

function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
  }
  return hash >>> 0
}

function normalizeForHash(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(normalizeForHash)
  }
  if (data && typeof data === 'object') {
    const input = data as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) {
      output[key] = normalizeForHash(input[key])
    }
    return output
  }
  return data
}

function computeHash(data: unknown): number {
  try {
    return djb2Hash(JSON.stringify(normalizeForHash(data)))
  } catch {
    return 0
  }
}

function computePerToolHashes(
  toolSchemas: unknown[] | undefined,
  toolNames: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < toolNames.length; i++) {
    hashes[toolNames[i]] = computeHash(toolSchemas?.[i] ?? toolNames[i])
  }
  return hashes
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptStateSnapshot {
  systemPrompt: string
  toolCount: number
  toolNames: string[]
  toolSchemas?: unknown[]
  model: string
  provider: string
  strategy?: string | null
  cacheControl?: unknown
  extraBodyParams?: unknown
  messages?: unknown[]
}

export interface PromptMessageDifference {
  index: number
  previousHash?: number
  currentHash?: number
  previousRole?: string
  currentRole?: string
}

export interface CacheBreakResult {
  broken: boolean
  /** Human-readable reason (empty when broken === false) */
  reason: string
  /** Previous -> current cache read tokens */
  tokenDrop: number
  /** True if the drop is likely due to server-side TTL expiry */
  likelyTtlExpiry: boolean
  firstMessageDifference?: PromptMessageDifference
  requestTiming?: { idleMs: number; durationMs: number }
}

interface TrackedState {
  systemHash: number
  toolsHash: number
  cacheControlHash: number
  extraBodyHash: number
  toolNames: string[]
  perToolHashes: Record<string, number>
  model: string
  provider: string
  strategy: string | null
  systemCharCount: number
  prevCacheReadTokens: number | null
  lastTurnAt: number
  pendingChanges: PendingChanges | null
  messageHashes: number[]
  messageRoles: string[]
  zeroReadStreak: number
  zeroReadAlerted: boolean
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  cacheControlChanged: boolean
  extraBodyChanged: boolean
  modelChanged: boolean
  providerChanged: boolean
  strategyChanged: boolean
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  systemCharDelta: number
  previousModel: string
  newModel: string
  messagePrefixChanged: boolean
  messageCountDelta: number
  firstMessageDifference?: PromptMessageDifference
}

function messageRole(message: unknown): string {
  if (!message || typeof message !== 'object') return typeof message
  const item = message as Record<string, unknown>
  if (typeof item.role === 'string') return item.role
  if (typeof item.type === 'string') return item.type
  return 'unknown'
}

function firstMessageDifference(
  previousHashes: number[],
  currentHashes: number[],
  previousRoles: string[],
  currentRoles: string[],
): PromptMessageDifference | undefined {
  const length = Math.max(previousHashes.length, currentHashes.length)
  for (let index = 0; index < length; index += 1) {
    if (previousHashes[index] === currentHashes[index]) continue
    return {
      index,
      previousHash: previousHashes[index],
      currentHash: currentHashes[index],
      previousRole: previousRoles[index],
      currentRole: currentRoles[index],
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export class CacheMonitor {
  private state: TrackedState | null = null

  /**
   * Phase 1 - compare the prompt/tool state for the response being measured.
   * Callers supply the final sent request, including compatibility changes,
   * rather than a speculative pre-retry configuration. Usage is checked next.
   */
  recordPromptState(snapshot: PromptStateSnapshot): void {
    const systemHash = computeHash(snapshot.systemPrompt)
    const toolsHash = computeHash(snapshot.toolSchemas ?? {
      names: snapshot.toolNames,
      count: snapshot.toolCount,
    })
    const cacheControlHash = computeHash(snapshot.cacheControl ?? null)
    const extraBodyHash = computeHash(snapshot.extraBodyParams ?? null)
    const perToolHashes = computePerToolHashes(snapshot.toolSchemas, snapshot.toolNames)
    const systemCharCount = snapshot.systemPrompt.length
    const messageHashes = (snapshot.messages ?? []).map(computeHash)
    const messageRoles = (snapshot.messages ?? []).map(messageRole)

    if (!this.state) {
      this.state = {
        systemHash,
        toolsHash,
        cacheControlHash,
        extraBodyHash,
        toolNames: snapshot.toolNames,
        perToolHashes,
        model: snapshot.model,
        provider: snapshot.provider,
        strategy: snapshot.strategy ?? null,
        systemCharCount,
        prevCacheReadTokens: null,
        lastTurnAt: Date.now(),
        pendingChanges: null,
        messageHashes,
        messageRoles,
        zeroReadStreak: 0,
        zeroReadAlerted: false,
      }
      return
    }

    const prev = this.state
    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash
    const modelChanged = snapshot.model !== prev.model
    const providerChanged = snapshot.provider !== prev.provider
    const strategyChanged = (snapshot.strategy ?? null) !== prev.strategy
    const messageDifference = firstMessageDifference(prev.messageHashes, messageHashes, prev.messageRoles, messageRoles)
    const messagePrefixChanged = Boolean(messageDifference && (
      messageDifference.index < Math.min(prev.messageHashes.length, messageHashes.length)
      || messageHashes.length < prev.messageHashes.length
    ))
    const messageCountDelta = messageHashes.length - prev.messageHashes.length

    const prevToolSet = new Set(prev.toolNames)
    const newToolSet = new Set(snapshot.toolNames)
    const addedTools = snapshot.toolNames.filter(n => !prevToolSet.has(n))
    const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
    const changedToolSchemas: string[] = []
    if (toolSchemasChanged) {
      for (const name of snapshot.toolNames) {
        if (!prevToolSet.has(name)) continue
        if (perToolHashes[name] !== prev.perToolHashes[name]) {
          changedToolSchemas.push(name)
        }
      }
    }

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      cacheControlChanged ||
      extraBodyChanged ||
      modelChanged ||
      providerChanged ||
      strategyChanged
      || messagePrefixChanged
    ) {
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        cacheControlChanged,
        extraBodyChanged,
        modelChanged,
        providerChanged,
        strategyChanged,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: snapshot.model,
        messagePrefixChanged,
        messageCountDelta,
        firstMessageDifference: messagePrefixChanged ? messageDifference : undefined,
      }
    } else {
      prev.pendingChanges = null
    }

    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.extraBodyHash = extraBodyHash
    prev.toolNames = snapshot.toolNames
    prev.perToolHashes = perToolHashes
    prev.model = snapshot.model
    prev.provider = snapshot.provider
    prev.strategy = snapshot.strategy ?? null
    prev.systemCharCount = systemCharCount
    prev.messageHashes = messageHashes
    prev.messageRoles = messageRoles
  }

  /**
   * Phase 2 - inspect the API response's cache metrics AFTER the call.
   * Returns a diagnostic result. Does not throw.
   */
  checkCacheBreak(
    cacheReadTokens: number,
    cacheCreationTokens: number,
    totalInputTokens?: number,
    timing?: { requestStartedAt: number; responseReceivedAt: number },
  ): CacheBreakResult {
    void cacheCreationTokens
    const state = this.state
    if (!state) {
      return { broken: false, reason: '', tokenDrop: 0, likelyTtlExpiry: false }
    }

    const prevCacheRead = state.prevCacheReadTokens
    const responseReceivedAt = timing?.responseReceivedAt ?? Date.now()
    const requestStartedAt = timing?.requestStartedAt ?? responseReceivedAt
    // Cache lookup occurs when the request starts. Time spent generating this
    // response is not an idle gap and cannot explain a miss that preceded it.
    const timeSinceLast = Math.max(0, requestStartedAt - state.lastTurnAt)
    const requestTiming = timing ? {
      idleMs: timeSinceLast,
      durationMs: Math.max(0, responseReceivedAt - requestStartedAt),
    } : undefined
    state.prevCacheReadTokens = cacheReadTokens
    state.lastTurnAt = responseReceivedAt
    const cacheEligible = typeof totalInputTokens === 'number'
      && totalInputTokens >= minimumCacheableTokens(state.model)
    if (cacheReadTokens === 0 && cacheEligible) {
      state.zeroReadStreak += 1
    } else {
      state.zeroReadStreak = 0
      state.zeroReadAlerted = false
    }

    // First call has no baseline.
    if (prevCacheRead === null) {
      return { broken: false, reason: '', tokenDrop: 0, likelyTtlExpiry: false }
    }

    if (
      cacheReadTokens === 0
      && state.zeroReadStreak >= 2
      && !state.zeroReadAlerted
      && state.pendingChanges === null
    ) {
      state.zeroReadAlerted = true
      return {
        broken: true,
        reason: `cache remained at zero for ${state.zeroReadStreak} eligible requests with a stable prefix`,
        tokenDrop: 0,
        likelyTtlExpiry: false,
        ...(requestTiming ? { requestTiming } : {}),
      }
    }

    const tokenDrop = prevCacheRead - cacheReadTokens

    // Detection threshold: drop > 5% AND absolute drop > 2000 tokens.
    if (
      cacheReadTokens >= prevCacheRead * 0.95 ||
      tokenDrop < MIN_CACHE_MISS_TOKENS
    ) {
      return { broken: false, reason: '', tokenDrop, likelyTtlExpiry: false }
    }

    const parts: string[] = []
    const changes = state.pendingChanges

    if (changes) {
      if (changes.modelChanged) {
        parts.push(`model changed (${changes.previousModel} -> ${changes.newModel})`)
      }
      if (changes.providerChanged) {
        parts.push('provider changed')
      }
      if (changes.systemPromptChanged) {
        const delta = changes.systemCharDelta
        const info = delta === 0 ? '' : delta > 0 ? ` (+${delta} chars)` : ` (${delta} chars)`
        parts.push(`system prompt changed${info}`)
      }
      if (changes.toolSchemasChanged) {
        const diff =
          changes.addedTools.length > 0 || changes.removedTools.length > 0
            ? ` (+${changes.addedTools.length}/-${changes.removedTools.length} tools)`
            : changes.changedToolSchemas.length > 0
              ? ` (schema drift: ${changes.changedToolSchemas.slice(0, 5).join(', ')})`
              : ' (schema drift, same set)'
        parts.push(`tools changed${diff}`)
      }
      if (changes.cacheControlChanged && !changes.systemPromptChanged) {
        parts.push('cache_control changed')
      }
      if (changes.extraBodyChanged) {
        parts.push('request params changed')
      }
      if (changes.strategyChanged) {
        parts.push('strategy changed')
      }
      if (changes.messagePrefixChanged && changes.firstMessageDifference) {
        const difference = changes.firstMessageDifference
        parts.push(`message prefix changed at index ${difference.index} (${difference.previousRole || 'missing'} -> ${difference.currentRole || 'missing'})`)
      }
    }

    const ttlThresholdMs = cacheTtlThresholdMs(state.model)
    const likelyTtlExpiry = !changes && timeSinceLast > ttlThresholdMs

    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ')
    } else if (timeSinceLast > CACHE_TTL_1HOUR_MS) {
      reason = 'possible 1h TTL expiry (prompt unchanged)'
    } else if (timeSinceLast > ttlThresholdMs) {
      reason = /gpt-5\.6/i.test(state.model)
        ? 'possible 30m+ TTL expiry (prompt unchanged)'
        : 'possible 5min TTL expiry (prompt unchanged)'
    } else {
      reason = /gpt-5\.6/i.test(state.model)
        ? 'likely server-side (prompt unchanged, <30min gap)'
        : 'likely server-side (prompt unchanged, <5min gap)'
    }

    return {
      broken: true,
      reason,
      tokenDrop,
      likelyTtlExpiry,
      firstMessageDifference: changes?.firstMessageDifference,
      ...(requestTiming ? { requestTiming } : {}),
    }
  }

  /** Reset state - useful on session restart or mode switch. */
  reset(): void {
    this.state = null
  }

  /** Reset only the response-token baseline after expected context deletion. */
  resetBaseline(): void {
    if (!this.state) return
    this.state.prevCacheReadTokens = null
    this.state.pendingChanges = null
    this.state.lastTurnAt = Date.now()
    this.state.zeroReadStreak = 0
    this.state.zeroReadAlerted = false
  }
}
