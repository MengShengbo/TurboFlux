import { describe, expect, it } from 'vitest'
import { AgentRunControl, createAgentRunInterruption, isAgentRunInterruption } from './runControl'

describe('AgentRunControl', () => {
  it('pauses only the current operation and creates a fresh operation generation on resume', async () => {
    const control = new AgentRunControl()
    const runSignal = control.start()
    const firstOperationSignal = control.getOperationSignal()!

    expect(control.pause()).toBe(true)
    expect(firstOperationSignal.aborted).toBe(true)
    expect(isAgentRunInterruption(firstOperationSignal.reason, 'pause')).toBe(true)
    expect(runSignal.aborted).toBe(false)
    expect(control.getSnapshot()).toMatchObject({ active: true, paused: true, generation: 1 })

    let released = false
    const paused = control.waitIfPaused().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)

    expect(control.resume()).toBe(true)
    await paused
    const resumedOperationSignal = control.getOperationSignal()!
    expect(resumedOperationSignal).not.toBe(firstOperationSignal)
    expect(resumedOperationSignal.aborted).toBe(false)
    expect(control.getSnapshot()).toMatchObject({ active: true, paused: false, generation: 2 })
  })

  it('stops the whole run, releases a pause gate, and cannot be resumed', async () => {
    const control = new AgentRunControl()
    const runSignal = control.start()
    control.pause()
    const paused = control.waitIfPaused()

    expect(control.stop()).toBe(true)
    await paused

    expect(runSignal.aborted).toBe(true)
    expect(isAgentRunInterruption(runSignal.reason, 'stop')).toBe(true)
    expect(control.getSnapshot()).toMatchObject({ active: true, paused: false, runAborted: true })
    expect(control.resume()).toBe(false)

    control.finish()
    expect(control.getSnapshot()).toMatchObject({ active: false, paused: false })
  })

  it('preserves a pending operation across pause and lets stop cancel it afterwards', async () => {
    const control = new AgentRunControl()
    const runSignal = control.start()
    const operationSignal = control.getOperationSignal()!

    expect(control.pause({ interruptOperation: false })).toBe(true)
    expect(operationSignal.aborted).toBe(false)

    expect(control.resume()).toBe(true)
    expect(control.getOperationSignal()).toBe(operationSignal)
    expect(operationSignal.aborted).toBe(false)

    expect(control.stop()).toBe(true)
    expect(runSignal.aborted).toBe(true)
    expect(operationSignal.aborted).toBe(true)
    expect(isAgentRunInterruption(operationSignal.reason, 'stop')).toBe(true)
  })

  it('rejects overlapping runs and allows a new run after finish', () => {
    const control = new AgentRunControl()
    control.start()

    expect(() => control.start()).toThrow('Agent run control is already active')

    control.finish()
    expect(() => control.start()).not.toThrow()
  })

  it('propagates the current operation interruption to linked child controllers', () => {
    const control = new AgentRunControl()
    control.start()
    const child = new AbortController()
    const unlink = control.linkOperation(child)

    control.pause()

    expect(child.signal.aborted).toBe(true)
    expect(isAgentRunInterruption(child.signal.reason, 'pause')).toBe(true)
    unlink()
  })

  it('retries an operation after pause resumes', async () => {
    const control = new AgentRunControl()
    const runController = new AbortController()
    control.start(runController)
    let attempts = 0

    const pending = control.runAcrossPause(async () => {
      attempts += 1
      if (attempts === 1) {
        control.pause()
        throw createAgentRunInterruption('pause')
      }
      return 'resumed'
    }, runController.signal)

    await Promise.resolve()
    control.resume()
    await expect(pending).resolves.toBe('resumed')
    expect(attempts).toBe(2)
  })

  it('releases a run when a startup operation never settles', async () => {
    const control = new AgentRunControl()
    const runSignal = control.start()
    const pending = control.raceWithStop(new Promise<never>(() => undefined), runSignal)

    control.stop()

    await expect(pending).rejects.toMatchObject({ aborted: true, interruption: 'stop' })
  })
})
