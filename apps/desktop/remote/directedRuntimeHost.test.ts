import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { DesktopRuntimeHost } from '../runtimeHost'

interface FakeRuntime {
  getSnapshot(): {
    workspace: { path: string }
    conversationCatalog: Array<{ id: string; workspacePath: string }>
  }
  resolveRequestForConversation(conversationId: string, requestId: string, response: string): Promise<boolean>
}

describe('DesktopRuntimeHost directed remote operations', () => {
  it('serializes cross-workspace targets and re-resolves each conversation before execution', async () => {
    const executed: string[] = []
    const workspaceA = resolve('/workspace/a')
    const workspaceB = resolve('/workspace/b')
    const catalog = [
      { id: 'a', workspacePath: workspaceA },
      { id: 'b', workspacePath: workspaceB },
    ]
    const runtime = (workspacePath: string): FakeRuntime => ({
      getSnapshot: () => ({ workspace: { path: workspacePath }, conversationCatalog: catalog }),
      resolveRequestForConversation: async (conversationId, requestId, response) => {
        executed.push(`${workspacePath}:${conversationId}:${requestId}:${response}`)
        return true
      },
    })
    const runtimes = new Map([
      [workspaceA, runtime(workspaceA)],
      [workspaceB, runtime(workspaceB)],
    ])
    const host = Object.create(DesktopRuntimeHost.prototype) as DesktopRuntimeHost & Record<string, unknown>
    host.runtime = runtimes.get(workspaceA)
    host.directedConversationOperations = Promise.resolve()
    host.runtimeTransitioning = false
    host.suppressRuntimeEvents = false
    host.assertRuntimeReadyForRun = () => undefined
    host.assertRuntimeTransitionAllowed = () => undefined
    host.setWorkspace = async (workspacePath: string) => {
      host.runtime = runtimes.get(workspacePath)
      return {} as never
    }

    await Promise.all([
      host.resolveRequestForConversation('b', 'request-b', 'allow'),
      host.resolveRequestForConversation('a', 'request-a', 'deny'),
    ])

    expect(executed).toEqual([
      `${workspaceB}:b:request-b:allow`,
      `${workspaceA}:a:request-a:deny`,
    ])
  })
})
