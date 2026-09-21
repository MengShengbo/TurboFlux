import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolResult } from '@turboflux/contracts/agentTypes'
import { TranscriptIndex } from './transcriptIndex'

describe('transcript content revisions', () => {
  it('detects same-length corrections, metadata changes and in-place mutations', () => {
    const index = new TranscriptIndex()
    const turn: AgentTurn = { id: 'turn', role: 'assistant', content: 'old', timestamp: 1 }
    index.setTurn(turn); const first = index.turnVersion(turn.id)
    index.setTurn({ ...turn }); expect(index.turnVersion(turn.id)).toBe(first)
    turn.content = 'new'; index.setTurn(turn); expect(index.turnVersion(turn.id)).toBeGreaterThan(first)
    const result: ToolResult = { toolCallId: 'call', output: 'old', isError: false }
    index.setResult(result); const tool = index.toolVersion('call')
    result.output = 'new'; index.setResult(result); expect(index.toolVersion('call')).toBeGreaterThan(tool)
  })
  it('indexes historical and live tools together and discards them on navigation', () => {
    const index = new TranscriptIndex()
    index.setTurn({ id: 'turn', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'call', name: 'search', arguments: { query: 'first' } }] })
    index.setResult({ toolCallId: 'call', output: 'found', isError: false })
    expect(index.calls.get('call')?.name).toBe('search'); expect(index.results.get('call')?.output).toBe('found')
    index.reset(); expect(index.turns.size + index.calls.size + index.results.size).toBe(0)
  })
})
