import { describe, expect, it } from 'vitest'
import { AgentFlowController } from './agentFlowController'

describe('AgentFlowController cross-thread actions', () => {
  it('uses the final answer instead of the original request for result notifications', () => {
    const controller = new AgentFlowController('conversation-1')
    controller.startRun('请整理一份很长的原始要求')
    controller.handle({ type: 'stream:start' })
    controller.handle({ type: 'stream:delta', text: '已完成整理，结果可以直接使用。' })
    controller.handle({ type: 'stream:end' })
    controller.handle({ type: 'run:state', state: { phase: 'completed', detail: 'Run completed', updatedAt: 2 } })
    expect(Object.values(controller.store.getThread('conversation-1')?.notifications || {})).toHaveLength(0)
    controller.handle({
      type: 'turn:complete',
      turn: { id: 'assistant-1', role: 'assistant', content: '已完成整理，结果可以直接使用。后续说明不会进入摘要。', timestamp: 1 },
    })
    controller.finishRun('succeeded')

    const notification = Object.values(controller.store.getThread('conversation-1')?.notifications || {})[0]
    expect(notification?.message).toBe('已完成整理，结果可以直接使用。')
  })

  it('acknowledges a result without changing the active thread', () => {
    const controller = new AgentFlowController('conversation-1')
    controller.startRun('整理结果')
    controller.finishRun('succeeded')
    const notificationId = Object.keys(controller.store.getThread('conversation-1')?.notifications || {})[0]
    expect(notificationId).toBeTruthy()

    controller.activateThread('conversation-2')
    expect(controller.store.getSnapshot().activeThreadId).toBe('conversation-2')
    expect(controller.acknowledgeNotification(notificationId, 'conversation-1')).not.toBeNull()
    expect(controller.store.getThread('conversation-1')?.notifications[notificationId].acknowledged).toBe(true)
    expect(controller.store.getSnapshot().activeThreadId).toBe('conversation-2')
  })

  it('drops the superseded run projection before an edited message restarts', () => {
    const controller = new AgentFlowController('conversation-1')
    controller.startRun('old task')
    controller.handle({ type: 'tool:call', toolCall: { id: 'tool-1', name: 'read_file', arguments: { path: 'old.ts' } } })

    controller.resetForHistoryRewrite()

    const reset = controller.store.getThread('conversation-1')
    expect(reset?.run.id).toBeNull()
    expect(Object.keys(reset?.tools || {})).toHaveLength(0)
    controller.startRun('edited task')
    expect(controller.store.getThread('conversation-1')?.run.objective).toBe('edited task')
  })

  it('samples a growing tool argument draft instead of publishing every chunk', () => {
    const controller = new AgentFlowController('conversation-1')
    controller.startRun('生成一个较长文件')
    const startingRevision = controller.store.getSnapshot().revision
    let publishes = 0
    controller.store.subscribe(() => { publishes += 1 })

    for (let index = 1; index <= 2_000; index += 1) {
      controller.handle({
        type: 'stream:tool_call_delta',
        toolCallId: 'write-1',
        toolName: 'write_file',
        partialJson: 'x'.repeat(Math.min(index, 2_048)),
      })
    }

    expect(publishes).toBe(1)
    expect(controller.store.getSnapshot().revision - startingRevision).toBe(1)
    expect(controller.store.getThread('conversation-1')?.toolDraft).toMatchObject({
      id: 'write-1',
      name: 'write_file',
      partialJson: 'x',
    })
  })

  it('creates stream nodes in the order content actually appears', () => {
    const controller = new AgentFlowController('conversation-1')
    const events = [] as ReturnType<typeof controller.handle>
    controller.startRun('分析后回答')
    events.push(...controller.handle({ type: 'stream:start' }))
    events.push(...controller.handle({ type: 'stream:thinking_delta', text: '先分析' }))
    events.push(...controller.handle({ type: 'stream:delta', text: '再回答' }))
    events.push(...controller.handle({ type: 'stream:end' }))
    events.push(...controller.handle({ type: 'stream:start' }))
    events.push(...controller.handle({ type: 'stream:thinking_delta', text: '继续分析' }))

    const starts = events.filter(event => event.type === 'stream.started')
    expect(starts.map(event => event.payload.channel)).toEqual(['thinking', 'answer', 'thinking'])
    expect(starts[0]?.itemId).toContain('stream-1-thinking')
    expect(starts[1]?.itemId).toContain('stream-1-answer')
    expect(starts[2]?.itemId).toContain('stream-2-thinking')
    expect(new Set(starts.map(event => event.itemId)).size).toBe(starts.length)
  })

  it('uses the work execution id as the shared run identity', () => {
    const controller = new AgentFlowController('conversation-1')
    const started = controller.startRun('检查项目', 'desktop-input-1')
    const turnEvents = controller.handle({
      type: 'turn:start',
      turn: {
        id: 'desktop-input-1',
        role: 'user',
        content: '检查项目',
        timestamp: 1,
        metadata: { workRunId: 'desktop-input-1' },
      },
    })

    expect(started).toHaveLength(1)
    expect([...started, ...turnEvents].every(event => event.runId === 'desktop-input-1')).toBe(true)
  })
})
