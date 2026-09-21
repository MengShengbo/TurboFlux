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
    let release!: (value: string) => void
    const run = lifecycle.run(() => new Promise<string>(resolve => { release = resolve }))

    expect(lifecycle.isRunning()).toBe(true)
    expect(() => lifecycle.run(async () => 'overlap')).toThrow('already active')
    release('done')
    await run
    expect(lifecycle.isRunning()).toBe(false)
    expect(lifecycle.getControlSnapshot().active).toBe(false)
  })

  it('queues, commits, and rejects steering only during an open run', async () => {
    const { lifecycle, inputs } = createLifecycle()
    let release!: (value: string) => void
    const run = lifecycle.run(() => new Promise<string>(resolve => { release = resolve }))

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

  it('restores the pre-pause phase and keeps one cancellation tree', async () => {
    const { lifecycle, states } = createLifecycle()
    const run = lifecycle.run(async () => 'done')
    lifecycle.setState('tool_running', { detail: 'Reading', activeTool: 'read_file' })
    const abortActiveStream = vi.fn()

    expect(lifecycle.pause(false, abortActiveStream)).toBe(true)
    expect(lifecycle.getControlSnapshot().paused).toBe(true)
    expect(abortActiveStream).toHaveBeenCalledOnce()
    expect(lifecycle.resume()).toBe(true)
    expect(lifecycle.getState()).toMatchObject({ phase: 'tool_running', detail: 'Reading', activeTool: 'read_file' })
    expect(states).toEqual(['tool_running', 'paused', 'tool_running'])
    await run
  })

  it('settles stopped and failed runs into monotonic terminal states', async () => {
    const stopped = createLifecycle()
    const stoppedRun = stopped.lifecycle.run(async () => 'stopped')
    stopped.lifecycle.control.stop()
    expect(stopped.lifecycle.settleFailure(new Error('stopped'))).toMatchObject({ aborted: true })
    expect(stopped.lifecycle.getState()).toMatchObject({ phase: 'completed', detail: 'Run stopped' })

    const failed = createLifecycle()
    const failedRun = failed.lifecycle.run(async () => 'failed')
    expect(failed.lifecycle.settleFailure(new Error('provider failed'))).toMatchObject({ aborted: false })
    expect(failed.lifecycle.getState()).toMatchObject({ phase: 'recoverable_error', recoverable: true })
    await Promise.all([stoppedRun, failedRun])
  })

  it('releases ownership after a synchronous startup failure and allows retry', async () => {
    const { lifecycle } = createLifecycle()
    await expect(lifecycle.run(() => { throw new Error('startup failed') })).rejects.toThrow('startup failed')
    expect(lifecycle.getControlSnapshot().active).toBe(false)
    await expect(lifecycle.run(async () => 'retried')).resolves.toBe('retried')
  })

  it('closes uncommitted steering when the operation settles', async () => {
    const { lifecycle, inputs } = createLifecycle()
    const run = lifecycle.run(async () => 'done')
    lifecycle.submitSteering('late guidance', 'late')
    await run

    expect(inputs).toEqual(['late:accepted', 'late:rejected'])
    expect(lifecycle.submitSteering('after completion')).toBe(false)
  })

  it.each(['completed', 'recoverable_error'] as const)('preserves %s while the run is finishing', async phase => {
    const { lifecycle } = createLifecycle()
    const run = lifecycle.run(async () => 'done')
    lifecycle.setState(phase)

    expect(lifecycle.pause(false, vi.fn())).toBe(false)
    lifecycle.abort(() => undefined)
    expect(lifecycle.resume()).toBe(false)
    expect(lifecycle.getState().phase).toBe(phase)
    await run
  })
})
