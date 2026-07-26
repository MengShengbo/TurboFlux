import { describe, expect, it } from 'vitest'
import { FAST_CONTEXT_ENGINE_ID, FAST_CONTEXT_TUNING, getFastContextProfile, normalizeFastContextStrategy } from './fastContextTypes'
import { buildFastContextSystemPrompt } from './subAgent'

describe('FastContext architecture contract', () => {
  it('uses one adaptive architecture budget', () => {
    expect(FAST_CONTEXT_TUNING).toEqual({
      maxTurns: 6,
      maxParallel: 6,
      taskTimeoutMs: 600_000,
    })
  })

  it('keeps semantic decisions in one grounded controller', () => {
    const prompt = buildFastContextSystemPrompt()

    expect(prompt).toContain('read-only code-retrieval controller')
    expect(prompt).toContain('You own query rewriting')
    expect(prompt).toContain('Local tools only perform deterministic search')
    expect(prompt).toContain('submit_code_map')
    expect(prompt).toContain('edit counterfactual')
    expect(prompt).toContain('follow the imported or invoked symbol to its implementation owner')
    expect(prompt).toContain('no named unread owner can materially change')
    expect(prompt).toContain('read-confirmed evidence handle')
    expect(prompt).toContain('Do not enumerate the repository')
    expect(prompt).not.toContain('request_more_search')
    expect(prompt).not.toContain('get_codemap')
  })

  it('keeps Race as the only profile', () => {
    expect(FAST_CONTEXT_ENGINE_ID).toBe('fcrace-v1')
    expect(getFastContextProfile().strategy).toBe('autonomous-race')
    expect(normalizeFastContextStrategy('legacy_strategy')).toBe('autonomous-race')
    expect(normalizeFastContextStrategy('unknown')).toBe('autonomous-race')
    expect(getFastContextProfile('autonomous-race').maxTurns).toBe(FAST_CONTEXT_TUNING.maxTurns)
  })
})
