export interface TaskTitleApplyGate {
  readonly conversationId: string
  readonly wait: Promise<void>
  readonly released: boolean
}

interface MutableTaskTitleApplyGate extends TaskTitleApplyGate {
  release(): void
}

export class TaskTitleApplyGateRegistry {
  private readonly gates = new Map<string, MutableTaskTitleApplyGate>()

  begin(conversationId: string): TaskTitleApplyGate {
    this.release(conversationId)
    let resolveWait: (() => void) | undefined
    let released = false
    const wait = new Promise<void>(resolve => {
      resolveWait = resolve
    })
    const gate: MutableTaskTitleApplyGate = {
      conversationId,
      wait,
      get released() {
        return released
      },
      release: () => {
        if (released) return
        released = true
        resolveWait?.()
      },
    }
    this.gates.set(conversationId, gate)
    return gate
  }

  release(conversationId: string, expected?: TaskTitleApplyGate): void {
    const gate = this.gates.get(conversationId)
    if (!gate || expected && gate !== expected) return
    this.gates.delete(conversationId)
    gate.release()
  }

  clear(): void {
    for (const gate of this.gates.values()) gate.release()
    this.gates.clear()
  }
}
