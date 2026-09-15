import { describe, expect, it } from 'vitest'
import { modelProviderMark, normalizedModelProvider } from './modelPresentation'

describe('model presentation', () => {
  it('recognizes managed model providers even when the runtime provider is custom', () => {
    expect(normalizedModelProvider('custom', 'deepseek-v4-flash')).toBe('deepseek')
    expect(normalizedModelProvider('custom', 'gpt-5.6-sol')).toBe('openai')
  })

  it('renders real provider marks', () => {
    expect(modelProviderMark('deepseek')).toContain('aria-label="DeepSeek"')
    expect(modelProviderMark('openai')).toContain('aria-label="OpenAI"')
  })
})
