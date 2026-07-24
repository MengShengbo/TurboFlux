import { describe, expect, it } from 'vitest'
import { FAST_CONTEXT_TUNING } from './fastContextTypes'
import { buildFastContextSystemPrompt } from './subAgent'

describe('FastContext architecture contract', () => {
  it('uses one adaptive architecture budget', () => {
    expect(FAST_CONTEXT_TUNING).toEqual({
      maxTurns: 6,
      maxParallel: 6,
      taskTimeoutMs: 600_000,
      reasoningEffort: 'high',
    })
  })

  it('keeps semantic decisions in one grounded controller', () => {
    const prompt = buildFastContextSystemPrompt()

    expect(prompt).toContain('read-only code-retrieval controller')
    expect(prompt).toContain('model owns query rewriting')
    expect(prompt).toContain('Local tools only search, read')
    expect(prompt).toContain('submit_code_map')
    expect(prompt).toContain('edit counterfactual')
    expect(prompt).toContain('Do not let an early textual match become the only hypothesis')
    expect(prompt).toContain('Relationships, rejected hypotheses')
    expect(prompt).toContain('Read every probable direct behavior owner')
    expect(prompt).toContain('Do not prove that the whole repository')
    expect(prompt).toContain('Do not enumerate the repository')
    expect(prompt).not.toContain('request_more_search')
    expect(prompt).not.toContain('get_codemap')
  })
})
