import { describe, expect, it } from 'vitest'
import { deriveActivityModel, formatToolActivity } from './agentActivityModel'

describe('agent activity model', () => {
  it('keeps the center activity visible before the first stream delta', () => {
    const model = deriveActivityModel({
      runState: { phase: 'thinking', updatedAt: 1 },
      tools: [],
      thinkingText: '',
      streamText: '',
    })

    expect(model.visible).toBe(true)
    expect(model.detail).toBe('Thinking...')
  })

  it('prefers a running tool over the generic phase label', () => {
    const model = deriveActivityModel({
      runState: { phase: 'tool_running', updatedAt: 1 },
      tools: [{ name: 'write_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }) }],
    })

    expect(model.activeTool?.name).toBe('write_file')
    expect(model.detail).toBe('Writing src/App.tsx...')
  })

  it('prefers a concrete draft or tool subject over engine summary text', () => {
    const model = deriveActivityModel({
      runState: { phase: 'tool_running', updatedAt: 1, detail: 'Running 1 tool' },
      tools: [{ name: 'write_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }) }],
    })

    expect(model.detail).toBe('Writing src/App.tsx...')
  })

  it('formats command and search progress without exposing raw JSON', () => {
    expect(formatToolActivity({ name: 'run_command', args: JSON.stringify({ command: 'npm test' }) })).toBe('Running npm test...')
    expect(formatToolActivity({ name: 'search_content', args: JSON.stringify({ query: 'TranscriptViewport' }) })).toBe('Searching TranscriptViewport...')
  })

  it('does not create a visible activity row when fully idle', () => {
    expect(deriveActivityModel({ runState: { phase: 'idle', updatedAt: 1 }, tools: [] }).visible).toBe(false)
  })
})
