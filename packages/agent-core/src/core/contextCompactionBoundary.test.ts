import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import { planContextCompaction, projectTurnsForModelContext, splitTurnsForCompaction } from './contextCompactionBoundary'

describe('context compaction boundary', () => {
  it('clones tool payloads without rewriting the model projection', () => {
    const originalOutput = 'full tool result '.repeat(20)
    const turns: AgentTurn[] = [
      { id: 'user-old', role: 'user', content: 'inspect', timestamp: 1 },
      { id: 'assistant-tool', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'tool-old', role: 'tool_result', content: '', timestamp: 3, toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: originalOutput, isError: false }] },
      { id: 'assistant-old', role: 'assistant', content: 'inspection complete', timestamp: 4 },
      { id: 'user-current', role: 'user', content: 'continue', timestamp: 5 },
      { id: 'assistant-current', role: 'assistant', content: 'working', timestamp: 6 },
    ]

    const projected = projectTurnsForModelContext(turns)

    expect(projected[2]?.toolResults?.[0]?.output).toBe(originalOutput)
    expect(turns[2]?.toolResults?.[0]?.output).toBe(originalOutput)
    expect(projected[2]).not.toBe(turns[2])
    expect(projected[2]?.toolResults?.[0]).not.toBe(turns[2]?.toolResults?.[0])
  })

  it('keeps a referenced old tool result in the model projection', () => {
    const originalOutput = 'important result '.repeat(20)
    const turns: AgentTurn[] = [
      { id: 'tool-old', role: 'tool_result', content: '', timestamp: 1, toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: originalOutput, isError: false }] },
      { id: 'assistant-reference', role: 'assistant', content: `Using ${originalOutput.slice(0, 40)} for the fix`, timestamp: 2 },
      { id: 'user-current', role: 'user', content: 'continue', timestamp: 3 },
      { id: 'assistant-current', role: 'assistant', content: 'working', timestamp: 4 },
    ]

    expect(projectTurnsForModelContext(turns)[0]?.toolResults?.[0]?.output).toBe(originalOutput)
  })

  it('keeps immutable runtime context on every captured user turn', () => {
    const turns: AgentTurn[] = [
      { id: 'user-old', role: 'user', content: 'old', timestamp: 1, metadata: { runtimeContext: 'old repeated context' } },
      { id: 'assistant-old', role: 'assistant', content: 'done', timestamp: 2 },
      { id: 'user-current', role: 'user', content: 'current', timestamp: 3, metadata: { runtimeContext: 'current context' } },
    ]

    const projected = projectTurnsForModelContext(turns)

    expect(projected[0]?.metadata?.runtimeContext).toBe('old repeated context')
    expect(projected[2]?.metadata?.runtimeContext).toBe('current context')
    expect(turns[0]?.metadata?.runtimeContext).toBe('old repeated context')
  })

  it('never omits tool results from the active work run', () => {
    const originalOutput = 'active work evidence '.repeat(20)
    const turns: AgentTurn[] = [
      { id: 'user-current', role: 'user', content: 'inspect', timestamp: 1, metadata: { workRunId: 'run-1' } },
      { id: 'assistant-tool', role: 'assistant', content: '', timestamp: 2, metadata: { workRunId: 'run-1' }, toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'tool-current', role: 'tool_result', content: '', timestamp: 3, metadata: { workRunId: 'run-1' }, toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: originalOutput, isError: false }] },
      { id: 'assistant-next', role: 'assistant', content: 'continue checking', timestamp: 4, metadata: { workRunId: 'run-1' } },
      { id: 'assistant-later', role: 'assistant', content: 'still working', timestamp: 5, metadata: { workRunId: 'run-1' } },
    ]

    expect(projectTurnsForModelContext(turns)[2]?.toolResults?.[0]?.output).toBe(originalOutput)
  })

  it('keeps a tool result attached to its assistant turn', () => {
    const turns: AgentTurn[] = [
      { id: 'user-old', role: 'user', content: 'old', timestamp: 1 },
      { id: 'assistant-tools', role: 'assistant', content: '', timestamp: 2 },
      { id: 'tool-result', role: 'tool_result', content: '', timestamp: 3 },
      { id: 'user-recent', role: 'user', content: 'recent', timestamp: 4 },
    ]

    expect(splitTurnsForCompaction(turns, 2)).toEqual({
      oldTurns: [turns[0]],
      recentTurns: turns.slice(1),
    })
  })

  it('plans visible boundaries and reuses a matching segment', () => {
    const turns: AgentTurn[] = [
      { id: 'system', role: 'system', content: 'system', timestamp: 0 },
      { id: 'old-user', role: 'user', content: '1234', timestamp: 1 },
      { id: 'old-assistant', role: 'assistant', content: '12', timestamp: 2 },
      { id: 'recent-user', role: 'user', content: 'recent', timestamp: 3 },
    ]
    const segment = {
      startMessageId: 'old-user',
      endMessageId: 'old-assistant',
      summary: 'existing summary',
      isModelGenerated: true,
      kind: 'compact' as const,
      originalCharCount: 6,
      isValid: true,
      createdAt: 1,
    }

    expect(planContextCompaction({
      turns,
      keepRecent: 1,
      segments: [segment],
      countTurnChars: turn => turn.content.length,
    })).toMatchObject({
      startMessageId: 'old-user',
      endMessageId: 'old-assistant',
      originalCharCount: 6,
      existingSegment: segment,
    })
  })
})
