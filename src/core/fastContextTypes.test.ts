import { describe, expect, it } from 'vitest'
import { getFastContextTuning, normalizeFastContextLevel } from './fastContextTypes'
import { buildFastContextSystemPrompt } from './subAgent'

describe('FastContext retrieval levels', () => {
  it('maps the three levels to progressively deeper budgets', () => {
    const low = getFastContextTuning('low')
    const medium = getFastContextTuning('medium')
    const max = getFastContextTuning('max')

    expect(low).toMatchObject({ maxTurns: 5, maxParallel: 4, taskTimeoutMs: 180_000, reasoningEffort: 'low' })
    expect(medium).toMatchObject({ maxTurns: 8, maxParallel: 6, taskTimeoutMs: 360_000, reasoningEffort: 'medium' })
    expect(max).toMatchObject({ maxTurns: 12, maxParallel: 8, taskTimeoutMs: 720_000, reasoningEffort: 'max' })
    expect(low.maxTurns).toBeLessThan(medium.maxTurns)
    expect(medium.maxTurns).toBeLessThan(max.maxTurns)
    expect(low.taskTimeoutMs).toBeLessThan(medium.taskTimeoutMs)
    expect(medium.taskTimeoutMs).toBeLessThan(max.taskTimeoutMs)
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
    expect(mediumPrompt).toContain('Depth level: medium')
    expect(maxPrompt).toContain('Depth level: max')
    expect(maxPrompt).toContain('disproves the leading interpretation')
    expect(mediumPrompt).toContain('local tools only execute the exact searches and reads you request')
    expect(mediumPrompt).toContain('submit_code_map')
    expect(mediumPrompt).toContain('Rank by edit necessity')
    expect(mediumPrompt).toContain('behavior-bearing mirrors')
    expect(mediumPrompt).not.toContain('at least 2 model-directed search call(s)')
    expect(mediumPrompt).not.toContain('prefetch')
  })
})
