import { describe, expect, it } from 'vitest'
import type { RuntimeTask } from '@turboflux/agent-core/contracts'
import { describeRuntimeTask, normalizeRuntimePreviewUrl, runtimeTaskStatusLabel } from './runtimeTaskPresentation'

function task(overrides: Partial<RuntimeTask> = {}): RuntimeTask {
  return {
    id: 'task-1',
    kind: 'terminal',
    status: 'running',
    command: 'npm run dev -- --port 9999',
    startedAt: 1,
    updatedAt: 1,
    interactive: true,
    restartPolicy: 'never',
    presentation: {
      kind: 'service',
      title: '启动本地预览',
      detail: '正在准备可查看的网站',
      previewUrl: 'http://0.0.0.0:5174/',
    },
    ...overrides,
  }
}

describe('runtime task presentation', () => {
  it('accepts only local preview URLs', () => {
    expect(normalizeRuntimePreviewUrl('http://0.0.0.0:3000/dashboard')).toBe('http://localhost:3000/dashboard')
    expect(normalizeRuntimePreviewUrl('https://example.com')).toBeUndefined()
  })

  it('uses model-provided semantics without inspecting commands', () => {
    expect(describeRuntimeTask(task())).toEqual({
      category: 'service',
      title: '启动本地预览',
      detail: '正在准备可查看的网站',
      previewUrl: 'http://localhost:5174',
      active: true,
    })
    expect(describeRuntimeTask(task({ command: 'pnpm install', presentation: undefined }))).toBeNull()
  })

  it('derives only generic lifecycle state when detail is omitted', () => {
    expect(describeRuntimeTask(task({
      status: 'completed',
      presentation: { kind: 'check', title: '验证应用质量' },
    }))).toMatchObject({ detail: '已完成', active: false })
    expect(runtimeTaskStatusLabel('orphaned')).toBe('等待恢复')
  })
})
