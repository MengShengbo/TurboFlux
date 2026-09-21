import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '@turboflux/workbench'
import { runtimeTransitionBlocker } from '../runtimeTransitionPolicy'

function snapshot(status: WorkbenchSnapshot['conversationRuntimes'][number]['status']): Pick<WorkbenchSnapshot, 'conversationRuntimes'> {
  return {
    conversationRuntimes: [{ conversationId: 'conversation-1', status, updatedAt: 1 }],
  } as Pick<WorkbenchSnapshot, 'conversationRuntimes'>
}

describe('profile switch lifecycle policy', () => {
  it.each([
    ['running', '有任务仍在运行'],
    ['paused', '有任务已暂停'],
    ['awaiting-action', '有任务正在等待确认'],
    ['error', '有任务需要处理恢复状态'],
  ] as const)('blocks profile switching while a conversation is %s', (status, message) => {
    expect(runtimeTransitionBlocker(snapshot(status))).toContain(message)
  })

  it('allows switching only when every conversation is ready', () => {
    expect(runtimeTransitionBlocker(snapshot('ready'))).toBeNull()
  })
})
