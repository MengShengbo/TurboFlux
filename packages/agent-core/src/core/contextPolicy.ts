import type { ContextPolicyMode } from '../shared/agentTypes'

export interface ContextPolicyProfile {
  mode: ContextPolicyMode
  targetRatio: number
  keepRecentTurns: number
  maxSegmentTokens: number
  minTailTurns: number
}

export const CONTEXT_POLICY_PROFILES: Record<ContextPolicyMode, ContextPolicyProfile> = {
  normal: {
    mode: 'normal',
    targetRatio: 0.72,
    keepRecentTurns: 10,
    maxSegmentTokens: 16_000,
    minTailTurns: 6,
  },
  qualityFirst: {
    mode: 'qualityFirst',
    targetRatio: 0.56,
    keepRecentTurns: 14,
    maxSegmentTokens: 24_000,
    minTailTurns: 8,
  },
}

export function resolveContextPolicyProfile(mode?: ContextPolicyMode): ContextPolicyProfile {
  return CONTEXT_POLICY_PROFILES[mode ?? 'normal'] ?? CONTEXT_POLICY_PROFILES.normal
}

export const MAX_OUTPUT_TOKENS_FOR_COMPACTION = 20_000
export const NORMAL_AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const QUALITY_AUTOCOMPACT_BUFFER_TOKENS = 28_000
export const WARNING_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export function effectiveInputWindow(contextWindow: number, maxOutputTokens: number): number {
  const reservedOutput = Math.min(
    Math.max(0, maxOutputTokens || 0),
    MAX_OUTPUT_TOKENS_FOR_COMPACTION,
  )
  return Math.max(1_024, contextWindow - reservedOutput)
}

export function autoCompactThreshold(contextWindow: number, maxOutputTokens: number, mode?: ContextPolicyMode): number {
  const effectiveWindow = effectiveInputWindow(contextWindow, maxOutputTokens)
  const buffer = mode === 'qualityFirst'
    ? Math.max(QUALITY_AUTOCOMPACT_BUFFER_TOKENS, Math.floor(effectiveWindow * 0.18))
    : NORMAL_AUTOCOMPACT_BUFFER_TOKENS
  return Math.max(1_024, effectiveWindow - buffer)
}

export function blockingContextLimit(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(1_024, effectiveInputWindow(contextWindow, maxOutputTokens) - MANUAL_COMPACT_BUFFER_TOKENS)
}
