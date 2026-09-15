import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '@turboflux/agent-core/workbench'
import { projectHistoryRewrite } from '../historyRewrite'

describe('history rewrite projection', () => {
  it('truncates the abandoned branch and preserves edited-message inputs', () => {
    const turns: AgentTurn[] = [
      { id: 'user-1', role: 'user', content: 'first task', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'first answer', timestamp: 2 },
      {
        id: 'user-2',
        role: 'user',
        content: 'old follow-up',
        timestamp: 3,
        metadata: {
          attachments: [{ id: 'image-1', type: 'image', path: '/tmp/image.png', mime: 'image/png', filename: 'image.png', size: 12 }],
          capabilities: { items: [{ type: 'skill', id: 'research', name: '调研' }] },
          workRunId: 'old-run',
        },
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'abandoned answer',
        timestamp: 4,
        toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { path: 'src/app.ts' } }],
      },
      {
        id: 'result-2',
        role: 'tool_result',
        content: 'ok',
        timestamp: 4,
        toolResults: [{
          toolCallId: 'write-1',
          name: 'write_file',
          output: 'ok',
          isError: false,
          changeSummary: { path: 'src/app.ts', operation: 'write' },
        }],
      },
      { id: 'user-3', role: 'user', content: 'abandoned prompt', timestamp: 5 },
    ]

    const projection = projectHistoryRewrite(turns, 'user-2', 'edited follow-up', 10)

    expect(projection?.retainedTurns.map(turn => turn.id)).toEqual(['user-1', 'assistant-1'])
    expect(projection?.prompts).toEqual(['first task', 'edited follow-up'])
    expect(projection?.promptCount).toBe(2)
    expect(projection?.abandonedToolCount).toBe(1)
    expect(projection?.abandonedChangedPaths).toEqual(['src/app.ts'])
    expect(projection?.optimisticTurn).toEqual(expect.objectContaining({
      id: 'user-2',
      content: 'edited follow-up',
      timestamp: 10,
      metadata: expect.objectContaining({
        workRunId: 'user-2',
        attachments: [expect.objectContaining({ id: 'image-1' })],
        capabilities: { items: [expect.objectContaining({ id: 'research' })] },
      }),
    }))
  })

  it('rejects missing turns and empty edited text', () => {
    const turns: AgentTurn[] = [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 1 }]
    expect(projectHistoryRewrite(turns, 'missing', 'edited')).toBeUndefined()
    expect(projectHistoryRewrite(turns, 'user-1', '   ')).toBeUndefined()
  })
})
