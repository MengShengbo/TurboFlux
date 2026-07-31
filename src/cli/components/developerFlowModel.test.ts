import { describe, expect, it } from 'vitest'
import { deriveDeveloperFlow, type DeveloperFlowInput } from './developerFlowModel'

function input(overrides: Partial<DeveloperFlowInput> = {}): DeveloperFlowInput {
  return {
    runState: { phase: 'idle', updatedAt: 1 },
    isRunning: false,
    tools: [],
    draft: null,
    subagents: [],
    terminals: 0,
    queuedCount: 0,
    task: null,
    ...overrides,
  }
}

describe('developer flow model', () => {
  it('gives user-blocking states priority over generic running state', () => {
    const model = deriveDeveloperFlow(input({
      isRunning: true,
      runState: { phase: 'awaiting_approval', updatedAt: 2, detail: 'Reviewing run_command' },
    }))

    expect(model.label).toBe('REVIEW REQUIRED')
    expect(model.detail).toBe('Reviewing run_command')
    expect(model.tone).toBe('warning')
  })

  it('describes concrete editing work instead of generic execution', () => {
    const model = deriveDeveloperFlow(input({
      isRunning: true,
      runState: { phase: 'tool_running', updatedAt: 2 },
      tools: [{ name: 'write_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }) }],
    }))

    expect(model.label).toBe('EDITING')
    expect(model.detail).toBe('Writing src/App.tsx')
  })

  it('keeps delegated work and terminals visible', () => {
    const model = deriveDeveloperFlow(input({
      isRunning: true,
      runState: { phase: 'thinking', updatedAt: 2 },
      subagents: [{
        id: 'review-1',
        label: 'Reviewer',
        objective: 'Review changes',
        detail: 'turn 2/5',
        startedAt: 1,
        status: 'running',
      }],
      terminals: 1,
      queuedCount: 2,
    }))

    expect(model.background).toEqual([
      'Reviewer 2/5',
      '1 terminal active',
      '2 queued',
    ])
  })

  it('exposes a completed delegated result for handoff', () => {
    const model = deriveDeveloperFlow(input({
      subagents: [{
        id: 'review-1',
        label: 'Reviewer',
        objective: 'Review changes',
        detail: 'finalizing result',
        startedAt: 1,
        completedAt: 2,
        status: 'completed',
      }],
    }))

    expect(model.background).toContain('Reviewer result ready')
  })
})
