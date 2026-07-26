import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolResult } from '../shared/agentTypes'
import { AdaptiveAgentTurnBudget } from './agentRunBudget'

function successfulBatch(index: number): { calls: ToolCall[]; results: ToolResult[] } {
  return {
    calls: [{ id: `call-${index}`, name: 'read_file', arguments: { path: `src/file-${index}.ts` } }],
    results: [{ toolCallId: `call-${index}`, output: 'ok', isError: false }],
  }
}

describe('AdaptiveAgentTurnBudget', () => {
  it('extends a productive run beyond its soft turn checkpoint', () => {
    const budget = new AdaptiveAgentTurnBudget(25)
    for (let index = 0; index < 25; index++) {
      const batch = successfulBatch(index)
      budget.recordToolBatch(batch.calls, batch.results)
    }

    expect(budget.beforeModelTurn(24)).toEqual({ kind: 'continue' })
    expect(budget.beforeModelTurn(25)).toEqual({
      kind: 'extend',
      previousLimit: 25,
      nextLimit: 50,
      successfulToolTurns: 25,
    })
    expect(budget.beforeModelTurn(25)).toEqual({ kind: 'continue' })
  })

  it('pauses at a checkpoint when no successful tool work was recorded', () => {
    const budget = new AdaptiveAgentTurnBudget(25)

    expect(budget.beforeModelTurn(25)).toEqual({ kind: 'pause', reason: 'stalled', limit: 25 })
  })

  it('detects repeated identical tool batches instead of extending a loop', () => {
    const budget = new AdaptiveAgentTurnBudget(25)
    const batch = successfulBatch(1)
    for (let index = 0; index < 4; index++) budget.recordToolBatch(batch.calls, batch.results)

    expect(budget.beforeModelTurn(25)).toEqual({ kind: 'pause', reason: 'repeated_tools', limit: 25 })
  })

  it('enforces the hard safety ceiling after productive extensions', () => {
    const budget = new AdaptiveAgentTurnBudget(25, 60)
    for (let index = 0; index < 5; index++) {
      const batch = successfulBatch(index)
      budget.recordToolBatch(batch.calls, batch.results)
    }
    expect(budget.beforeModelTurn(25)).toMatchObject({ kind: 'extend', nextLimit: 50 })

    for (let index = 5; index < 10; index++) {
      const batch = successfulBatch(index)
      budget.recordToolBatch(batch.calls, batch.results)
    }
    expect(budget.beforeModelTurn(50)).toMatchObject({ kind: 'extend', nextLimit: 60 })
    expect(budget.beforeModelTurn(60)).toEqual({ kind: 'pause', reason: 'hard_limit', limit: 60 })
  })

  it('allows productive main-agent work to continue beyond hundreds of turns by default', () => {
    const budget = new AdaptiveAgentTurnBudget(25)
    let batchIndex = 0

    for (let checkpoint = 25; checkpoint <= 250; checkpoint += 25) {
      for (let successfulTurn = 0; successfulTurn < 4; successfulTurn++) {
        const batch = successfulBatch(batchIndex++)
        budget.recordToolBatch(batch.calls, batch.results)
      }
      expect(budget.beforeModelTurn(checkpoint)).toMatchObject({
        kind: 'extend',
        previousLimit: checkpoint,
        nextLimit: checkpoint + 25,
      })
    }

    expect(budget.beforeModelTurn(250)).toEqual({ kind: 'continue' })
  })
})
