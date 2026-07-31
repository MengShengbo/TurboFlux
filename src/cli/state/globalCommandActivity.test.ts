import { describe, expect, it } from 'vitest'
import { GlobalCommandActivityController } from './globalCommandActivity'

describe('GlobalCommandActivityController', () => {
  it('publishes activity before yielding and clears it after work', async () => {
    const events: string[] = []
    const controller = new GlobalCommandActivityController({
      now: () => 42,
      yieldToRenderer: async () => { events.push('yield') },
    })
    controller.subscribe(() => {
      const activity = controller.getSnapshot()
      events.push(activity ? `start:${activity.command}` : 'clear')
    })

    const result = await controller.run('/resume', 'Loading conversations', async () => {
      events.push('work')
      return 'done'
    })

    expect(result).toBe('done')
    expect(events).toEqual(['start:/resume', 'yield', 'work', 'clear'])
    expect(controller.getSnapshot()).toBeNull()
  })

  it('serializes overlapping global operations', async () => {
    let releaseFirst: (() => void) | undefined
    const events: string[] = []
    const controller = new GlobalCommandActivityController({ yieldToRenderer: async () => {} })
    const first = controller.run('/first', 'First', async () => {
      events.push('first:start')
      await new Promise<void>(resolve => { releaseFirst = resolve })
      events.push('first:end')
    })
    const second = controller.run('/second', 'Second', async () => {
      events.push('second:start')
    })

    expect(controller.getSnapshot()?.command).toBe('/first')
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot()?.command).toBe('/first')
    expect(events).toEqual(['first:start'])

    releaseFirst?.()
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    expect(controller.getSnapshot()).toBeNull()
  })

  it('clears failed activity and keeps the queue usable', async () => {
    const controller = new GlobalCommandActivityController({ yieldToRenderer: async () => {} })

    await expect(controller.run('/broken', 'Broken', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(controller.run('/next', 'Next', async () => 'ok')).resolves.toBe('ok')

    expect(controller.getSnapshot()).toBeNull()
  })
})
