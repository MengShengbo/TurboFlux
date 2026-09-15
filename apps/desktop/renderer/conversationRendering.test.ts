import { describe, expect, it } from 'vitest'
import type { AgentTurn, WorkbenchSnapshot } from '@turboflux/agent-core/workbench'
import {
  conversationRenderSignature,
  isHistoryRewriteUserTurn,
  isLegacyRecoveryPlaceholder,
  isInternalRequestErrorTurn,
  latestUserTurnId,
  latestConversationFailure,
  presentDesktopError,
  presentFailureMessage,
  requestStatusTerminalFenceApplies,
  resolveWorkTurnPresentation,
  shouldDeferWorkDelivery,
  shouldIgnoreSnapshotAfterRequestTerminal,
  shouldAttachUserAnswerToLiveWork,
  shouldPublishPendingWorkDelivery,
  shouldPresentWorkMetadata,
  shouldRestoreRequestStatus,
} from './conversationRendering'

describe('conversation presentation', () => {
  it('keeps ordinary answers free of work metadata', () => {
    expect(shouldPresentWorkMetadata({ visibleToolCount: 0, explicitTaskSignal: false })).toBe(false)
  })

  it('shows work metadata when the model starts operational work', () => {
    expect(shouldPresentWorkMetadata({ visibleToolCount: 1 })).toBe(true)
    expect(shouldPresentWorkMetadata({ explicitTaskSignal: true })).toBe(true)
  })

  it('holds a task conclusion until the matching run reaches a terminal state', () => {
    expect(shouldDeferWorkDelivery({
      turnRunId: 'run-1',
      activeRunId: 'run-1',
      runTerminal: false,
      hasLiveWork: true,
    })).toBe(true)
    expect(shouldDeferWorkDelivery({
      turnRunId: 'run-1',
      activeRunId: 'run-1',
      runTerminal: true,
      hasLiveWork: true,
    })).toBe(false)
    expect(shouldDeferWorkDelivery({
      turnRunId: 'run-2',
      activeRunId: 'run-1',
      runTerminal: false,
      hasLiveWork: true,
    })).toBe(false)
  })

  it('only publishes a pending conclusion for completed or partial work', () => {
    expect(shouldPublishPendingWorkDelivery('completed')).toBe(true)
    expect(shouldPublishPendingWorkDelivery('partial')).toBe(true)
    expect(shouldPublishPendingWorkDelivery('failed')).toBe(false)
    expect(shouldPublishPendingWorkDelivery('cancelled')).toBe(false)
  })

  it('keeps work prose in one stable semantic lane across model loops', () => {
    expect(resolveWorkTurnPresentation({
      hasLiveWork: false,
      visibleToolCount: 0,
      runTerminal: false,
      matchesActiveRun: false,
    })).toBe('ordinary')
    expect(resolveWorkTurnPresentation({
      hasLiveWork: true,
      visibleToolCount: 1,
      runTerminal: false,
      matchesActiveRun: true,
    })).toBe('progress')
    expect(resolveWorkTurnPresentation({
      hasLiveWork: true,
      visibleToolCount: 0,
      runTerminal: false,
      matchesActiveRun: true,
    })).toBe('candidate-delivery')
    expect(resolveWorkTurnPresentation({
      hasLiveWork: true,
      visibleToolCount: 0,
      runTerminal: true,
      matchesActiveRun: true,
    })).toBe('delivery')
  })

  it('recognizes the canonical user turn that commits a history rewrite', () => {
    expect(isHistoryRewriteUserTurn({
      resendingTurnId: 'turn-2',
      eventType: 'turn.started',
      turnRole: 'user',
      turnId: 'turn-2',
    })).toBe(true)
  })

  it('fences late active snapshots after the current run is terminal', () => {
    const fence = { conversationId: 'conversation-1', latestUserTurnId: 'turn-2' }
    expect(requestStatusTerminalFenceApplies({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-2',
    })).toBe(true)
    expect(requestStatusTerminalFenceApplies({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-3',
    })).toBe(false)
    expect(shouldIgnoreSnapshotAfterRequestTerminal({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-2',
      runtimeStatus: 'running',
      runPhase: 'thinking',
      activeRunId: 'run-2',
    })).toBe(true)
    expect(shouldIgnoreSnapshotAfterRequestTerminal({
      fence,
      conversationId: 'conversation-1',
      latestUserTurnId: 'turn-2',
      runtimeStatus: 'ready',
      runPhase: 'completed',
      activeRunId: null,
    })).toBe(false)
  })

  it('restores request progress only for a genuinely active run', () => {
    expect(shouldRestoreRequestStatus({
      terminalFenceApplies: false,
      activeTask: true,
      activeRunId: 'run-1',
      runtimeStatus: 'running',
      runPhase: 'thinking',
      startedAt: 100,
    })).toBe(true)
    expect(shouldRestoreRequestStatus({
      terminalFenceApplies: false,
      activeTask: true,
      activeRunId: null,
      runtimeStatus: 'ready',
      runPhase: 'thinking',
      startedAt: 100,
    })).toBe(false)
    expect(shouldRestoreRequestStatus({
      terminalFenceApplies: true,
      activeTask: true,
      activeRunId: 'run-1',
      runtimeStatus: 'running',
      runPhase: 'thinking',
      startedAt: 100,
    })).toBe(false)
    expect(latestUserTurnId([
      { id: 'turn-1', role: 'user', content: 'one', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 2 },
      { id: 'turn-2', role: 'user', content: 'two', timestamp: 3 },
    ])).toBe('turn-2')
  })

  it('keeps an interactive answer inside its active work run', () => {
    expect(shouldAttachUserAnswerToLiveWork({
      role: 'user',
      turnRunId: 'run-1',
      liveRunId: 'run-1',
      hasLiveGroup: true,
    })).toBe(true)
    expect(shouldAttachUserAnswerToLiveWork({
      role: 'user',
      turnRunId: 'run-2',
      liveRunId: 'run-1',
      hasLiveGroup: true,
    })).toBe(false)
  })

  it('hides placeholders produced by older recovery versions', () => {
    const placeholder = {
      id: 'recovered-assistant-101',
      role: 'assistant' as const,
      content: 'Interrupted: assistant response was not recorded before restart.',
      timestamp: 101,
    }
    expect(isLegacyRecoveryPlaceholder(placeholder)).toBe(true)
    expect(conversationRenderSignature([placeholder])).not.toContain('Interrupted:')
  })

  it('restores a failed request as a Chinese retryable state', () => {
    const snapshot = {
      conversation: {
        id: 'conversation-1',
        turns: [{
          id: 'input-1',
          role: 'user',
          content: '继续完成任务',
          timestamp: 100,
          metadata: { workRunId: 'run-1' },
        }],
      },
      activity: {
        execution: {
          runs: [{
            id: 'run-1',
            conversationId: 'conversation-1',
            status: 'failed',
            error: 'HTTP 402: {"error":"insufficient_credits"}',
          }],
        },
      },
    } as unknown as WorkbenchSnapshot

    expect(latestConversationFailure(snapshot)).toEqual({
      runId: 'run-1',
      turnId: 'input-1',
      prompt: '继续完成任务',
      title: '请求未完成',
      message: '你配置的模型 API 拒绝了请求，请检查该连接的服务状态。',
      detail: 'insufficient_credits',
    })
  })

  it('presents the real upstream reason separately from the friendly summary', () => {
    const snapshot = {
      conversation: {
        id: 'conversation-1',
        turns: [{ id: 'input-1', role: 'user', content: '继续', timestamp: 100, metadata: { workRunId: 'run-1' } }],
      },
      activity: { execution: { runs: [{
        id: 'run-1', conversationId: 'conversation-1', status: 'failed',
        error: '当前模型暂不可用，请切换模型后重试。\n上游返回：Model "gpt-6-astra" is not supported by this account',
      }] } },
    } as unknown as WorkbenchSnapshot
    expect(latestConversationFailure(snapshot)).toMatchObject({
      message: '当前模型暂不可用，请切换模型后重试。',
      detail: 'Model "gpt-6-astra" is not supported by this account',
    })
  })

  it('presents an immediate provider failure without raw English errors', () => {
    expect(presentFailureMessage('HTTP 503 service unavailable')).toBe('模型服务暂时不可用，请稍后重试。')
  })

  it('normalizes previously persisted raw stream errors', () => {
    expect(presentFailureMessage('模型服务返回：stream_read_error')).toBe('与模型服务的连接中断了，请重试。')
    expect(presentFailureMessage('模型服务返回：{"error":"private upstream details"}')).toBe('模型服务未能完成这次请求，请重试。')
  })

  it('hides a previous failure as soon as a retry is running', () => {
    const snapshot = {
      runtime: { status: 'running' },
      conversation: { id: 'c', turns: [{ id: 'u', role: 'user', content: '继续', metadata: { workRunId: 'r' } }] },
      activity: { execution: { runs: [{ id: 'r', conversationId: 'c', status: 'failed', error: 'HTTP 503' }] } },
    } as unknown as WorkbenchSnapshot
    expect(latestConversationFailure(snapshot)).toBeUndefined()
  })

  it('unwraps Electron IPC errors before showing them in the interface', () => {
    expect(presentDesktopError(new Error("Error invoking remote method 'desktop:new-conversation': Error: 有任务仍在运行，请先等待完成或停止任务后再操作")))
      .toBe('有任务仍在运行，请先等待完成或停止任务后再操作')
    expect(presentDesktopError(new Error('Error: 操作未完成'))).toBe('操作未完成')
  })

  it('does not confuse an upstream provider quota error with TurboFlux credits', () => {
    expect(presentFailureMessage('HTTP 502 upstream billing quota exceeded')).toBe('模型服务暂时不可用，请稍后重试。')
    expect(presentFailureMessage('HTTP 402 {"error":"insufficient_credits"}')).toBe('你配置的模型 API 拒绝了请求，请检查该连接的服务状态。')
  })

  it('hides the transient internal request-error turn', () => {
    expect(isInternalRequestErrorTurn({
      id: 'request-error-1', role: 'assistant', content: '**Request Error**', timestamp: 100,
      metadata: { internal: true, internalKind: 'request_error', internalError: 'HTTP 502' },
    })).toBe(true)
  })

  it('builds a bounded signature without copying large tool payloads', () => {
    const largePayload = 'private-payload-'.repeat(80_000)
    const signature = conversationRenderSignature([{
      id: 'tool-result-1',
      role: 'tool_result',
      content: largePayload,
      timestamp: 100,
      toolResults: [{
        toolCallId: 'write-1',
        name: 'write_file',
        output: largePayload,
        isError: false,
      }],
    }])

    expect(signature).not.toContain('private-payload')
    expect(signature.length).toBeLessThan(160)
  })

  it('detects same-length replacements in every rendered turn surface', () => {
    const original: AgentTurn = {
      id: 'assistant-1',
      role: 'assistant',
      content: '完成甲项',
      timestamp: 100,
      metadata: {
        duration: 1_000,
        thinking: { content: '检查甲项', status: 'complete' },
        attachments: [{ id: 'attachment-1', type: 'file', path: '/tmp/a.md', mime: 'text/markdown', filename: 'a.md', size: 10 }],
        capabilities: { items: [{ type: 'skill', id: 'skill-a', name: '能力甲' }] },
      },
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: '/tmp/a.md' } }],
      toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: '结果甲', isError: false }],
    }
    const signature = conversationRenderSignature([original])
    const replacement = (update: Partial<AgentTurn>) => conversationRenderSignature([{ ...original, ...update }])

    expect(replacement({ content: '完成乙项' })).not.toBe(signature)
    expect(replacement({ metadata: { ...original.metadata, thinking: { content: '检查乙项', status: 'complete' } } })).not.toBe(signature)
    expect(replacement({ metadata: { ...original.metadata, attachments: [{ ...original.metadata!.attachments![0], filename: 'b.md' }] } })).not.toBe(signature)
    expect(replacement({ metadata: { ...original.metadata, capabilities: { items: [{ type: 'skill', id: 'skill-b', name: '能力乙' }] } } })).not.toBe(signature)
    expect(replacement({ toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: '/tmp/b.md' } }] })).not.toBe(signature)
    expect(replacement({ toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: '结果乙', isError: false }] })).not.toBe(signature)
  })

  it('detects a same-length replacement in a request failure', () => {
    const original = {
      runId: 'run-1',
      turnId: 'turn-1',
      prompt: '继续',
      title: '请求未完成',
      message: '服务故障',
    }

    expect(conversationRenderSignature([], original)).not.toBe(conversationRenderSignature([], {
      ...original,
      message: '网络故障',
    }))
  })
})
