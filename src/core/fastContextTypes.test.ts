import { describe, expect, it } from 'vitest'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'
import { buildFastContextSystemPrompt } from './subAgent'

describe('FastContext architecture contract', () => {
  it('uses one adaptive architecture budget', () => {
    expect(FAST_CONTEXT_TUNING).toEqual({
      maxTurns: 4,
      maxParallel: 8,
      taskTimeoutMs: 600_000,
      reasoningEffort: 'high',
    })
  })

  it('keeps semantic decisions in one grounded controller', () => {
    const prompt = buildFastContextSystemPrompt()

    expect(prompt).toContain('read-only causal code-retrieval controller')
    expect(prompt).toContain('highest expected information gain')
    expect(prompt).toContain('deterministic local tools only execute')
    expect(prompt).toContain('submit_code_map')
    expect(prompt).toContain('Relationships are optional')
    expect(prompt).toContain('Read every submitted candidate')
    expect(prompt).toContain('counterfactual edit test')
    expect(prompt).toContain('Do not enumerate the repository')
  })
})
