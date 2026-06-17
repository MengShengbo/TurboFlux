import type { AgentMode, ResolvedThinkingMode } from '../shared/agentTypes'

/**
 * Structured runtime signals collected per request to inform Auto-mode.
 * The resolver deliberately avoids natural-language keyword matching.
 */
export interface AutoThinkingSignals {
  agentMode: AgentMode
  recentToolErrorCount?: number
  recentTurnCount?: number
  hasUnresolvedTaskFailure?: boolean
  hasOpenContextOverflow?: boolean
}

const PROMPT_LENGTH_STANDARD_THRESHOLD = 220
const PROMPT_WORD_STANDARD_THRESHOLD = 60
const PROMPT_LENGTH_MAX_THRESHOLD = 700
const PROMPT_WORD_MAX_THRESHOLD = 140

export function resolveAutoThinkingMode(
  userMessage: string,
  signals: AutoThinkingSignals,
): ResolvedThinkingMode {
  const trimmed = (userMessage || '').trim()
  if (!trimmed) return 'off'

  const length = trimmed.length
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  const hasRecentFailures = (signals.recentToolErrorCount ?? 0) >= 2 || signals.hasUnresolvedTaskFailure === true
  const isVeryLong = length >= PROMPT_LENGTH_MAX_THRESHOLD || wordCount >= PROMPT_WORD_MAX_THRESHOLD

  if (hasRecentFailures || isVeryLong) return 'max'

  const isModerateLength = length >= PROMPT_LENGTH_STANDARD_THRESHOLD || wordCount >= PROMPT_WORD_STANDARD_THRESHOLD
  if (isModerateLength || signals.agentMode === 'plan' || signals.hasOpenContextOverflow === true) {
    return 'standard'
  }

  const isTiny = length < 80 && wordCount < 18
  return isTiny ? 'off' : 'standard'
}
