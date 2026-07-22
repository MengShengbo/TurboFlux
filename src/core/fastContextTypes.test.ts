import { describe, expect, it } from 'vitest'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'
import { buildFastContextSystemPrompt } from './subAgent'

describe('FastContext architecture contract', () => {
  it('uses one adaptive architecture budget', () => {
    expect(FAST_CONTEXT_TUNING).toEqual({
      maxTurns: 10,
      maxParallel: 8,
      taskTimeoutMs: 600_000,
      reasoningEffort: 'high',
    })
  })

  it('requires an architecture-level code map', () => {
    const prompt = buildFastContextSystemPrompt()

    expect(prompt).toContain('architecture-level code map')
    expect(prompt).toContain('change-impact frontier')
    expect(prompt).toContain('local tools only execute the exact searches and reads you request')
    expect(prompt).toContain('submit_code_map')
    expect(prompt).toContain('Candidate order is secondary')
    expect(prompt).toContain('behavior-bearing mirrors')
    expect(prompt).not.toContain('Depth level')
  })
})
