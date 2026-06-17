import type { ContextPolicyMode } from '../shared/agentTypes'

export interface ContextPolicyProfile {
  mode: ContextPolicyMode
  recapRatio: number
  compactRatio: number
  emergencyRatio: number
  targetRatio: number
  keepRecentTurns: number
  recapKeepRecentTurns: number
  recentToolResultTurns: number
  maxSegmentTokens: number
  minTailTurns: number
}

export const CONTEXT_POLICY_PROFILES: Record<ContextPolicyMode, ContextPolicyProfile> = {
  normal: {
    mode: 'normal',
    recapRatio: 0.55,
    compactRatio: 0.75,
    emergencyRatio: 0.88,
    targetRatio: 0.72,
    keepRecentTurns: 10,
    recapKeepRecentTurns: 8,
    recentToolResultTurns: 10,
    maxSegmentTokens: 16_000,
    minTailTurns: 6,
  },
  qualityFirst: {
    mode: 'qualityFirst',
    recapRatio: 0.40,
    compactRatio: 0.60,
    emergencyRatio: 0.72,
    targetRatio: 0.56,
    keepRecentTurns: 14,
    recapKeepRecentTurns: 10,
    recentToolResultTurns: 8,
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

export function recapThreshold(contextWindow: number, maxOutputTokens: number, mode?: ContextPolicyMode): number {
  const effectiveWindow = effectiveInputWindow(contextWindow, maxOutputTokens)
  const profile = resolveContextPolicyProfile(mode)
  return Math.max(1_024, Math.floor(effectiveWindow * profile.recapRatio))
}

export function blockingContextLimit(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(1_024, effectiveInputWindow(contextWindow, maxOutputTokens) - MANUAL_COMPACT_BUFFER_TOKENS)
}
