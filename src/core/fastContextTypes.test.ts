import { describe, expect, it } from 'vitest'
import { getFastContextTuning, normalizeFastContextLevel } from './fastContextTypes'
import { buildFastContextSystemPrompt } from './subAgent'

describe('FastContext retrieval levels', () => {
  it('maps the three levels to progressively deeper budgets', () => {
    const low = getFastContextTuning('low')
    const medium = getFastContextTuning('medium')
    const max = getFastContextTuning('max')

    expect(low).toMatchObject({ maxTurns: 5, maxParallel: 4, minimumSearchCalls: 1, minimumReadCalls: 2, reasoningEffort: 'low' })
    expect(medium).toMatchObject({ maxTurns: 8, maxParallel: 6, minimumSearchCalls: 2, minimumReadCalls: 3, reasoningEffort: 'medium' })
    expect(max).toMatchObject({ maxTurns: 12, maxParallel: 8, minimumSearchCalls: 4, minimumReadCalls: 6, reasoningEffort: 'max' })
    expect(low.maxTurns).toBeLessThan(medium.maxTurns)
    expect(medium.maxTurns).toBeLessThan(max.maxTurns)
  })

  it('keeps legacy thoroughness values compatible', () => {
    expect(normalizeFastContextLevel('quick')).toBe('low')
    expect(normalizeFastContextLevel('very_thorough')).toBe('max')
    expect(normalizeFastContextLevel('very-thorough')).toBe('max')
    expect(normalizeFastContextLevel('unknown')).toBe('medium')
    expect(normalizeFastContextLevel(undefined)).toBe('medium')
  })

  it('changes the model contract with the selected level', () => {
    const lowPrompt = buildFastContextSystemPrompt('low')
    const mediumPrompt = buildFastContextSystemPrompt('medium')
    const maxPrompt = buildFastContextSystemPrompt('max')

    expect(lowPrompt).toContain('Depth level: low')
    expect(lowPrompt).toContain('at least 1 model-directed search call(s)')
    expect(mediumPrompt).toContain('Depth level: medium')
    expect(mediumPrompt).toContain('at least 2 model-directed search call(s)')
    expect(maxPrompt).toContain('Depth level: max')
    expect(maxPrompt).toContain('6 model-directed read_file call(s)')
    expect(maxPrompt).toContain('disproves the leading interpretation')
  })
})
