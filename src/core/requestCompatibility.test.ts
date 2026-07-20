import { describe, expect, it } from 'vitest'
import {
  downgradeReasoningEffort,
  extractUnsupportedRequestParam,
  isReasoningEffortValueError,
  removeAnthropicCompatibleRequestParam,
  removeOpenAICompatibleRequestParam,
} from './requestCompatibility'

describe('request compatibility', () => {
  it('extracts rejected and deprecated optional parameters', () => {
    expect(extractUnsupportedRequestParam('Unsupported parameter: reasoning_effort')).toBe('reasoning_effort')
    expect(extractUnsupportedRequestParam('"output_config" is deprecated')).toBe('output_config')
  })

  it('removes only the rejected reasoning field', () => {
    const body = {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      output_config: { effort: 'high' },
    }

    expect(removeOpenAICompatibleRequestParam(body, 'output_config')).toBe(true)
    expect(body).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  })

  it('strips nested Anthropic cache controls without changing content', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
    }

    expect(removeAnthropicCompatibleRequestParam(body, {}, 'cache_control')).toBe(true)
    expect(body).toEqual({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  })

  it('detects invalid effort values and downgrades one level', () => {
    const body = { reasoning: { effort: 'max' } }
    expect(isReasoningEffortValueError('effort must be one of low, medium, high')).toBe(true)
    expect(downgradeReasoningEffort(body)).toEqual({ from: 'max', to: 'xhigh' })
    expect(body).toEqual({ reasoning: { effort: 'xhigh' } })
  })
})
