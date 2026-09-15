import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import { ModelSurface } from './modelSurface'

function turn(id: string, role: AgentTurn['role'], content: string, timestamp: number): AgentTurn {
  return { id, role, content, timestamp }
}

describe('ModelSurface', () => {
  it('keeps unchanged history append-only and snapshots only changed state', () => {
    const surface = new ModelSurface()
    const turns = [turn('user-1', 'user', 'build it', 1)]

    expect(surface.syncTurns(turns)).toBe(true)
    expect(surface.appendSnapshot('work_execution', '<work>one</work>', 2)).toBe(true)
    expect(surface.appendSnapshot('work_execution', '<work>one</work>', 3)).toBe(false)
    expect(surface.syncTurns([...turns, turn('assistant-1', 'assistant', 'working', 4)])).toBe(true)

    const state = surface.getState()
    expect(state.generation).toBe(0)
    expect(state.events.map(event => event.kind)).toEqual(['turn', 'snapshot', 'turn'])
    expect(surface.projectTurns().map(item => item.content)).toEqual([
      'build it',
      expect.stringContaining('<work>one</work>'),
      'working',
    ])
  })

  it('records one explicit replacement when an earlier turn changes', () => {
    const surface = new ModelSurface(undefined, [turn('user-1', 'user', 'before', 1)])
    surface.appendSnapshot('runtime', 'workspace A', 2)

    expect(surface.syncTurns([turn('user-1', 'user', 'after', 1)])).toBe(true)
    const state = surface.getState()
    const replacement = state.events.at(-1)
    expect(replacement).toMatchObject({ kind: 'replacement', generation: 1, reason: 'turn_divergence' })
    expect(surface.projectConversationTurns().map(item => item.content)).toEqual(['after'])
    expect(surface.projectTurns().some(item => item.content.includes('workspace A'))).toBe(true)
  })

  it('prunes stale tool output through a replacement generation', () => {
    const surface = new ModelSurface(undefined, [
      turn('user-1', 'user', 'inspect', 1),
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'result-1', role: 'tool_result', content: '', timestamp: 3, toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: 'x'.repeat(200), isError: false }] },
      turn('assistant-2', 'assistant', 'done', 4),
      turn('user-2', 'user', 'next', 5),
    ])

    expect(surface.pruneStaleToolResults()).toBe(true)
    expect(surface.getState()).toMatchObject({ generation: 1 })
    expect(surface.projectTurns()[2]?.toolResults?.[0]?.output).toContain('result omitted from model context')
    expect(surface.pruneStaleToolResults()).toBe(false)
    const generation = surface.getState().generation
    expect(surface.syncTurns([
      turn('user-1', 'user', 'inspect', 1),
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { id: 'result-1', role: 'tool_result', content: '', timestamp: 3, toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: 'x'.repeat(200), isError: false }] },
      turn('assistant-2', 'assistant', 'done', 4),
      turn('user-2', 'user', 'next', 5),
    ])).toBe(false)
    expect(surface.getState().generation).toBe(generation)
  })

  it('evicts old images in one explicit replacement while retaining the newest evidence', () => {
    const image = (id: string, timestamp: number): AgentTurn => ({
      id: `user-${id}`,
      role: 'user',
      content: id,
      timestamp,
      metadata: { attachments: [{ id, type: 'image', path: `/tmp/${id}.png`, mime: 'image/png', filename: `${id}.png`, size: 100 }] },
    })
    const surface = new ModelSurface(undefined, [image('one', 1), image('two', 2), image('three', 3), image('four', 4)])

    expect(surface.enforceImageBudget({ maxImages: 3, maxImageBytes: 1000, maxTotalBytes: 1000 })).toBe(true)
    const projected = surface.projectConversationTurns()
    expect(projected[0]?.metadata?.attachments).toBeUndefined()
    expect(projected[0]?.content).toContain('explicit model-context replacement')
    expect(projected.slice(1).flatMap(item => item.metadata?.attachments ?? []).map(item => item.id)).toEqual(['two', 'three', 'four'])
  })

  it('round-trips persisted state without changing projected messages', () => {
    const surface = new ModelSurface(undefined, [turn('user-1', 'user', 'hello', 1)])
    surface.appendSnapshot('work_execution', 'step 1', 2)
    const restored = new ModelSurface(surface.getState())

    expect(restored.projectTurns()).toEqual(surface.projectTurns())
    expect(restored.firstDifference(surface.projectTurns())).toBeNull()
  })
})
