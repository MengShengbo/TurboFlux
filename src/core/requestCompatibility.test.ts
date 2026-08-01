import { describe, expect, it } from 'vitest'
import {
  downgradeReasoningEffort,
  extractUnsupportedRequestParam,
  isReasoningEffortValueError,
  removeAnthropicCompatibleRequestParam,
  removeOpenAICompatibleRequestParam,
  setOpenAIChatMaxTokens,
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

  it('removes an unsupported reasoning summary without disabling effort', () => {
    const body = { reasoning: { effort: 'xhigh', summary: 'detailed' } }

    expect(removeOpenAICompatibleRequestParam(body, 'reasoning.summary')).toBe(true)
    expect(body).toEqual({ reasoning: { effort: 'xhigh' } })
  })

  it('removes unsupported Responses verbosity without leaving an empty text object', () => {
    const body = { text: { verbosity: 'low' }, stream: true }

    expect(removeOpenAICompatibleRequestParam(body, 'text.verbosity')).toBe(true)
    expect(body).toEqual({ stream: true })
  })

  it('maps a bare unsupported verbosity field back to Responses text verbosity', () => {
    const body = { text: { verbosity: 'low' }, stream: true }

    expect(removeOpenAICompatibleRequestParam(body, 'verbosity')).toBe(true)
    expect(body).toEqual({ stream: true })
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

  it('uses Kimi completion token limits and falls back to legacy max_tokens', () => {
    const body: Record<string, unknown> = {}
    expect(setOpenAIChatMaxTokens(body, 8192, 'kimi', 'kimi-k3')).toBe('max_completion_tokens')
    expect(body).toEqual({ max_completion_tokens: 8192 })
    expect(removeOpenAICompatibleRequestParam(body, 'max_completion_tokens')).toBe(true)
    expect(body).toEqual({ max_tokens: 8192 })
  })
})
