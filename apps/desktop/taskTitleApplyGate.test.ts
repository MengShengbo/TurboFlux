import { describe, expect, it, vi } from 'vitest'
import { TaskTitleApplyGateRegistry } from './taskTitleApplyGate'

describe('TaskTitleApplyGateRegistry', () => {
  it('keeps title application waiting until the first response releases it', async () => {
    const registry = new TaskTitleApplyGateRegistry()
    const gate = registry.begin('conversation-1')
    const applied = vi.fn()
    const update = gate.wait.then(applied)

    await Promise.resolve()
    expect(applied).not.toHaveBeenCalled()

    registry.release('conversation-1', gate)
    await update
    expect(gate.released).toBe(true)
    expect(applied).toHaveBeenCalledOnce()
  })

  it('does not let an older run release a newer title gate', async () => {
    const registry = new TaskTitleApplyGateRegistry()
    const older = registry.begin('conversation-1')
    const newer = registry.begin('conversation-1')

    expect(older.released).toBe(true)
    registry.release('conversation-1', older)
    expect(newer.released).toBe(false)

    registry.release('conversation-1', newer)
    await newer.wait
    expect(newer.released).toBe(true)
  })

  it('releases every waiter during runtime replacement', async () => {
    const registry = new TaskTitleApplyGateRegistry()
    const first = registry.begin('conversation-1')
    const second = registry.begin('conversation-2')

    registry.clear()
    await Promise.all([first.wait, second.wait])
    expect(first.released).toBe(true)
    expect(second.released).toBe(true)
  })
})
