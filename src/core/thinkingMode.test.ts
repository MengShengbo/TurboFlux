import { describe, expect, it } from 'vitest'
import { resolveAutoThinkingMode, type AutoThinkingSignals } from './thinkingMode'
import type { AgentMode } from '../shared/agentTypes'

describe('resolveAutoThinkingMode', () => {
  const createSignals = (overrides: Partial<AutoThinkingSignals> = {}): AutoThinkingSignals => ({
    agentMode: 'vibe' as AgentMode,
    recentToolErrorCount: 0,
    recentTurnCount: 0,
    hasUnresolvedTaskFailure: false,
    hasOpenContextOverflow: false,
    ...overrides,
  })

  it('returns off for empty inputs', () => {
    expect(resolveAutoThinkingMode('', createSignals())).toBe('off')
    expect(resolveAutoThinkingMode('   ', createSignals())).toBe('off')
    expect(resolveAutoThinkingMode(null as any, createSignals())).toBe('off')
    expect(resolveAutoThinkingMode(undefined as any, createSignals())).toBe('off')
  })

  it('uses max for recent runtime failures', () => {
    expect(resolveAutoThinkingMode('short task', createSignals({ recentToolErrorCount: 2 }))).toBe('max')
    expect(resolveAutoThinkingMode('short task', createSignals({ hasUnresolvedTaskFailure: true }))).toBe('max')
  })

  it('uses max for very long prompts by length or word count', () => {
    expect(resolveAutoThinkingMode('a'.repeat(800), createSignals())).toBe('max')
    expect(resolveAutoThinkingMode('word '.repeat(150), createSignals())).toBe('max')
  })

  it('uses standard for moderate prompt size', () => {
    expect(resolveAutoThinkingMode('test '.repeat(60), createSignals())).toBe('standard')
    expect(resolveAutoThinkingMode('word '.repeat(65), createSignals())).toBe('standard')
  })

  it('uses standard for plan mode and context pressure', () => {
    expect(resolveAutoThinkingMode('short task', createSignals({ agentMode: 'plan' }))).toBe('standard')
    expect(resolveAutoThinkingMode('short task', createSignals({ hasOpenContextOverflow: true }))).toBe('standard')
  })

  it('keeps tiny vibe prompts lightweight without keyword matching', () => {
    expect(resolveAutoThinkingMode('hi', createSignals({ agentMode: 'vibe' }))).toBe('off')
    expect(resolveAutoThinkingMode('implement refactor debug review', createSignals({ agentMode: 'vibe' }))).toBe('off')
  })

  it('uses standard as the fallback for non-tiny vibe prompts', () => {
    const message = 'this is a medium length request with enough words to avoid the tiny prompt downgrade path'
    expect(resolveAutoThinkingMode(message, createSignals({ agentMode: 'vibe' }))).toBe('standard')
  })
})
