import { describe, expect, it } from 'vitest'
import { beginToolCall, settleToolCall } from './toolLifecycleModel'

describe('tool lifecycle model', () => {
  it('creates a running entry as soon as a call starts', () => {
    const tools = beginToolCall([], {
      id: 'call-1',
      name: 'read_file',
      args: '{"path":"src/App.tsx"}',
      startedAt: 100,
    })

    expect(tools).toEqual([{
      id: 'call-1',
      name: 'read_file',
      status: 'running',
      args: '{"path":"src/App.tsx"}',
      startTime: 100,
    }])
  })

  it('settles an existing call without losing its start time', () => {
    const running = beginToolCall([], { id: 'call-1', name: 'edit_file', startedAt: 100 })
    const settled = settleToolCall(running, {
      id: 'call-1',
      name: 'edit_file',
      status: 'done',
      output: 'updated',
      settledAt: 250,
    })

    expect(settled[0]).toMatchObject({ status: 'done', startTime: 100, endTime: 250, output: 'updated' })
  })

  it('records an out-of-order result instead of dropping it', () => {
    const tools = settleToolCall([], {
      id: 'call-1',
      name: 'run_command',
      status: 'error',
      output: 'failed',
      settledAt: 400,
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'run_command', status: 'error', output: 'failed' })
  })
})
