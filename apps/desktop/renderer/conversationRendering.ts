import { extractProviderErrorDetail, requestErrorSummary } from '@turboflux/presentation'
import type { AgentTurn, WorkbenchSnapshot } from '@turboflux/workbench'

const LEGACY_RECOVERY_PLACEHOLDERS = new Set([
  'Interrupted: assistant response was not recorded before restart.',
  'The previous response was interrupted before content was generated.',
  '上次回复在生成内容前中断。',
])

export interface ConversationFailurePresentation {
  runId: string
  turnId: string
  prompt: string
  title: string
  message: string
  detail?: string
}

function renderFingerprint(value: unknown): string {
  let hash = 0x811c9dc5
  let size = 0
  const activeObjects = new WeakSet<object>()

  const write = (chunk: string) => {
    size += chunk.length
    for (let index = 0; index < chunk.length; index += 1) {
      hash = Math.imul(hash ^ chunk.charCodeAt(index), 0x01000193)
    }
  }
  const visit = (candidate: unknown) => {
    if (candidate === null) return write('null;')
    if (typeof candidate === 'string') {
      write(`s${candidate.length}:`)
      write(candidate)
      return
    }
    if (typeof candidate === 'number') return write(`n${String(candidate)};`)
    if (typeof candidate === 'boolean') return write(candidate ? 'b1;' : 'b0;')
    if (typeof candidate === 'undefined') return write('u;')
    if (typeof candidate !== 'object') return write(`${typeof candidate}:${String(candidate)};`)
    if (activeObjects.has(candidate)) return write('circular;')

    activeObjects.add(candidate)
    if (Array.isArray(candidate)) {
      write(`a${candidate.length}[`)
      for (const item of candidate) visit(item)
      write(']')
    } else {
      const record = candidate as Record<string, unknown>
      const keys = Object.keys(record).sort()
      write(`o${keys.length}{`)
      for (const key of keys) {
        visit(key)
        visit(record[key])
      }
      write('}')
    }
    activeObjects.delete(candidate)
  }

  visit(value)
  return `${size.toString(36)}.${(hash >>> 0).toString(36)}`
}

export function isInternalRequestErrorTurn(turn: AgentTurn): boolean {
  return turn.role === 'assistant' && turn.metadata?.internalKind === 'request_error'
}

export function presentFailureMessage(error: string): string {
  return requestErrorSummary(error)
}

export function presentDesktopError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : String(error)
  const unwrapped = raw
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  return unwrapped || '操作未完成，请稍后重试。'
}

export function isLegacyRecoveryPlaceholder(turn: AgentTurn): boolean {
  return turn.role === 'assistant'
    && turn.id.startsWith('recovered-assistant-')
    && LEGACY_RECOVERY_PLACEHOLDERS.has(turn.content.trim())
}

export function latestConversationFailure(snapshot: WorkbenchSnapshot): ConversationFailurePresentation | undefined {
  if (['running', 'paused', 'awaiting-action'].includes(snapshot.runtime?.status)) return undefined
  const userTurn = [...snapshot.conversation.turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)
  if (!userTurn) return undefined
  const runId = userTurn.metadata?.workRunId || userTurn.id
  const run = [...snapshot.activity.execution.runs].reverse().find(candidate => (
    candidate.id === runId
    && candidate.conversationId === snapshot.conversation.id
  ))
  if (!run?.error || run.status !== 'failed') return undefined
  return {
    runId,
    turnId: userTurn.id,
    prompt: userTurn.content,
    title: '请求未完成',
    message: presentFailureMessage(run.error),
    detail: extractProviderErrorDetail(run.error),
  }
}

export function conversationRenderSignature(
  turns: AgentTurn[],
  failure?: ConversationFailurePresentation,
): string {
  const turnSignature = turns
    .filter(turn => !isLegacyRecoveryPlaceholder(turn))
    .filter(turn => !isInternalRequestErrorTurn(turn))
    .map(turn => {
      return [
        turn.id,
        turn.role,
        turn.timestamp,
        renderFingerprint(turn.content),
        renderFingerprint(turn.metadata?.thinking),
        renderFingerprint(turn.metadata?.duration),
        renderFingerprint(turn.metadata?.attachments),
        renderFingerprint(turn.metadata?.capabilities),
        renderFingerprint(turn.toolCalls),
        renderFingerprint(turn.toolResults),
      ].join(':')
    })
    .join('|')
  const failureSignature = renderFingerprint(failure)
  return `${turnSignature}#${failureSignature}`
}

export function preferCompletedAssistantContent(
  turn: AgentTurn,
  streamedContent: string,
  completedVisibleContent: string,
): AgentTurn {
  if (turn.role !== 'assistant' || streamedContent.length <= completedVisibleContent.length) return turn
  return { ...turn, content: streamedContent }
}

export function hasRenderableTurnPayload(input: {
  visibleContent: string
  hasThinking: boolean
  attachmentCount: number
  capabilityCount: number
  visibleToolCount: number
}): boolean {
  return Boolean(
    input.visibleContent
    || input.hasThinking
    || input.attachmentCount
    || input.capabilityCount
    || input.visibleToolCount,
  )
}

export function shouldPresentWorkMetadata(input: {
  visibleToolCount?: number
  explicitTaskSignal?: boolean
}): boolean {
  return Boolean(input.explicitTaskSignal || (input.visibleToolCount || 0) > 0)
}

export function shouldDeferWorkDelivery(input: {
  turnRunId?: string
  activeRunId?: string
  runTerminal: boolean
  hasLiveWork: boolean
}): boolean {
  return Boolean(
    input.hasLiveWork
    && input.turnRunId
    && input.activeRunId
    && input.turnRunId === input.activeRunId
    && !input.runTerminal,
  )
}

export function shouldPublishPendingWorkDelivery(outcome: string | undefined): boolean {
  return outcome === 'completed' || outcome === 'partial'
}

export type WorkTurnPresentationRole = 'ordinary' | 'progress' | 'candidate-delivery' | 'delivery'

export function resolveWorkTurnPresentation(input: {
  hasLiveWork: boolean
  visibleToolCount: number
  runTerminal: boolean
  matchesActiveRun: boolean
}): WorkTurnPresentationRole {
  if (!input.hasLiveWork) return 'ordinary'
  if (input.visibleToolCount > 0) return 'progress'
  if (!input.matchesActiveRun || input.runTerminal) return 'delivery'
  return 'candidate-delivery'
}

export function latestUserTurnId(turns: readonly AgentTurn[]): string | undefined {
  return [...turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)?.id
}

export function shouldRestoreRequestStatus(input: {
  terminalFenceApplies: boolean
  activeTask: boolean
  activeRunId?: string | null
  runtimeStatus?: WorkbenchSnapshot['runtime']['status']
  runPhase?: WorkbenchSnapshot['runtime']['runState']['phase']
  startedAt?: number
}): boolean {
  return Boolean(
    !input.terminalFenceApplies
    && input.activeTask
    && input.activeRunId
    && input.runtimeStatus === 'running'
    && input.runPhase === 'thinking'
    && input.startedAt,
  )
}

export function isHistoryRewriteUserTurn(input: {
  resendingTurnId: string
  eventType: string
  turnId?: string
  turnRole?: string
}): boolean {
  return Boolean(
    input.resendingTurnId
    && input.eventType === 'turn.started'
    && input.turnRole === 'user'
    && input.turnId === input.resendingTurnId,
  )
}

export function shouldAttachUserAnswerToLiveWork(input: {
  role: string
  turnRunId?: string
  liveRunId?: string
  hasLiveGroup: boolean
}): boolean {
  return Boolean(
    input.role === 'user'
    && input.hasLiveGroup
    && input.turnRunId
    && input.liveRunId
    && input.turnRunId === input.liveRunId,
  )
}
