import { describe, expect, it } from 'vitest'
import {
  BoundedStreamBuffer,
  appendBoundedString,
  extractResponsesReasoningEventDelta,
  extractResponsesReasoningSummary,
  hasCompleteToolPayloads,
  isOutputLimitFinishReason,
} from './modelStream'

describe('BoundedStreamBuffer', () => {
  it('returns accepted deltas and marks truncated output', () => {
    const buffer = new BoundedStreamBuffer(5)

    expect(buffer.append('abc')).toBe('abc')
    expect(buffer.append('def')).toBe('de')
    expect(buffer.append('ignored')).toBe('')
    expect(buffer.toString()).toBe('abcde\n\n[stream output truncated after 5 characters]')
  })

  it('preserves complete output without a truncation marker', () => {
    const buffer = new BoundedStreamBuffer(5)

    expect(buffer.append('hello')).toBe('hello')
    expect(buffer.toString()).toBe('hello')
  })
})

describe('model stream helpers', () => {
  it('bounds incrementally assembled strings', () => {
    expect(appendBoundedString('abc', 'def', 5)).toBe('abcde')
    expect(appendBoundedString('abcde', 'f', 5)).toBe('abcde')
  })

  it('recognizes provider output limits', () => {
    expect(isOutputLimitFinishReason('length')).toBe(true)
    expect(isOutputLimitFinishReason('MAX_OUTPUT_TOKENS')).toBe(true)
    expect(isOutputLimitFinishReason('stop')).toBe(false)
  })

  it('requires named tool calls with complete JSON payloads', () => {
    expect(hasCompleteToolPayloads([{ name: 'read_file', argumentsJson: '{"path":"a.ts"}' }])).toBe(true)
    expect(hasCompleteToolPayloads([{ name: '', argumentsJson: '{}' }])).toBe(false)
    expect(hasCompleteToolPayloads([{ name: 'read_file', argumentsJson: '{' }])).toBe(false)
  })
})

describe('Responses reasoning summaries', () => {
  it('extracts completed summary blocks from Responses output', () => {
    expect(extractResponsesReasoningSummary([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspecting the failure path.' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
    ])).toBe('Inspecting the failure path.')
  })

  it.each([
    'response.reasoning_summary_text.delta',
    'response.reasoning_text.delta',
    'response.reasoning.delta',
    'response.reasoning_summary.delta',
    'response.thinking.delta',
    'response.analysis.delta',
  ])('accepts streaming reasoning event variant %s', type => {
    expect(extractResponsesReasoningEventDelta({ type, delta: 'Inspecting now.' })).toBe('Inspecting now.')
  })

  it('accepts object-shaped reasoning deltas without classifying answer text', () => {
    expect(extractResponsesReasoningEventDelta({ type: 'response.reasoning.delta', delta: { text: 'Next step.' } })).toBe('Next step.')
    expect(extractResponsesReasoningEventDelta({ type: 'response.output_text.delta', delta: 'Visible answer.' })).toBe('')
  })
})
