import { describe, expect, it, vi } from 'vitest'
import { AgentRunLifecycle } from './agentRunLifecycle'

function createLifecycle() {
  const states: string[] = []
  const inputs: string[] = []
  const lifecycle = new AgentRunLifecycle<string>({
    onStateChanged: state => states.push(state.phase),
    onStateFallback: state => states.push(`fallback:${state.phase}`),
    onInputState: (input, state) => inputs.push(`${input.id}:${state}`),
    onNotification: () => undefined,
  })
  return { lifecycle, states, inputs }
}

describe('AgentRunLifecycle', () => {
  it('owns one tracked run and releases it after settlement', async () => {
    const { lifecycle } = createLifecycle()
    const controller = new AbortController()
    lifecycle.beginRun(controller)
    let release!: (value: string) => void
    const run = new Promise<string>(resolve => { release = resolve })
    lifecycle.trackRun(run)

    expect(lifecycle.isRunning()).toBe(true)
    expect(() => lifecycle.beginRun(new AbortController())).toThrow('already active')
    release('done')
    await run
    await Promise.resolve()
    expect(lifecycle.isRunning()).toBe(false)
    expect(lifecycle.getControlSnapshot().active).toBe(false)
  })

  it('queues, commits, and rejects steering only during an open run', async () => {
    const { lifecycle, inputs } = createLifecycle()
    lifecycle.beginRun(new AbortController())
    let release!: (value: string) => void
    const run = new Promise<string>(resolve => { release = resolve })
    lifecycle.trackRun(run)

    expect(lifecycle.submitSteering(' first ', 'steer-1')).toBe(true)
    const committed: string[] = []
    expect(lifecycle.consumeSteering(input => committed.push(input.text))).toBe(true)
    expect(lifecycle.submitSteering('second', 'steer-2')).toBe(true)
    lifecycle.closeSteering('finished')

    expect(committed).toEqual(['first'])
    expect(inputs).toEqual(['steer-1:accepted', 'steer-1:committed', 'steer-2:accepted', 'steer-2:rejected'])
    expect(lifecycle.submitSteering('late', 'steer-3')).toBe(false)
    release('done')
    await run
  })

  it('restores the pre-pause phase and keeps one cancellation tree', () => {
    const { lifecycle, states } = createLifecycle()
    lifecycle.beginRun(new AbortController())
    lifecycle.setState('tool_running', { detail: 'Reading', activeTool: 'read_file' })
    const abortActiveStream = vi.fn()

    expect(lifecycle.pause(false, abortActiveStream)).toBe(true)
    expect(lifecycle.getControlSnapshot().paused).toBe(true)
    expect(abortActiveStream).toHaveBeenCalledOnce()
    expect(lifecycle.resume()).toBe(true)
    expect(lifecycle.getState()).toMatchObject({ phase: 'tool_running', detail: 'Reading', activeTool: 'read_file' })
    expect(states).toEqual(['tool_running', 'paused', 'tool_running'])
  })

  it('settles stopped and failed runs into monotonic terminal states', () => {
    const stopped = createLifecycle()
    stopped.lifecycle.beginRun(new AbortController())
    stopped.lifecycle.control.stop()
    expect(stopped.lifecycle.settleFailure(new Error('stopped'))).toMatchObject({ aborted: true })
    expect(stopped.lifecycle.getState()).toMatchObject({ phase: 'completed', detail: 'Run stopped' })

    const failed = createLifecycle()
    failed.lifecycle.beginRun(new AbortController())
    expect(failed.lifecycle.settleFailure(new Error('provider failed'))).toMatchObject({ aborted: false })
    expect(failed.lifecycle.getState()).toMatchObject({ phase: 'recoverable_error', recoverable: true })
  })
})
