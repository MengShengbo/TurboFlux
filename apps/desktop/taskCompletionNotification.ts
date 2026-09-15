export type TaskCompletionNotificationEvent = {
  type: string
  conversationId?: string
  status?: string
  resultSummary?: string
}

export interface TaskCompletionNotificationPresentation {
  title: string
  body: string
  taskTitle: string
  agentPreview?: string
}

const DEFAULT_TASK_TITLE = '这个任务'
const MAX_TASK_TITLE_LENGTH = 72
const MAX_AGENT_PREVIEW_LENGTH = 180
const MAX_AGENT_PREVIEW_SENTENCES = 2

export function taskCompletionNotificationDelivery(
  event: TaskCompletionNotificationEvent,
  appIsForeground: boolean,
): { showSystemNotification: boolean; requestBackgroundAttention: boolean } {
  const completed = event.type === 'conversation-run' && event.status === 'completed'
  return {
    showSystemNotification: completed,
    requestBackgroundAttention: completed && !appIsForeground,
  }
}

export function taskCompletionAgentPreview(value?: string): string | undefined {
  const normalized = value
    ?.replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)(?:[-*+]|\d+[.)])\s+/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined

  let cutoff = Math.min(normalized.length, MAX_AGENT_PREVIEW_LENGTH)
  let sentenceCount = 0
  let endedAtSentence = false
  for (let index = 0; index < cutoff; index += 1) {
    const character = normalized[index]
    const asciiSentenceEnd = /[.!?]/.test(character) && (index === normalized.length - 1 || /\s/.test(normalized[index + 1]))
    if (!/[\u3002！？]/.test(character) && !asciiSentenceEnd) continue
    sentenceCount += 1
    if (sentenceCount < MAX_AGENT_PREVIEW_SENTENCES) continue
    cutoff = index + 1
    endedAtSentence = true
    break
  }

  if (!endedAtSentence && cutoff < normalized.length) {
    const lastSpace = normalized.lastIndexOf(' ', cutoff)
    if (lastSpace >= Math.floor(MAX_AGENT_PREVIEW_LENGTH * 0.72)) cutoff = lastSpace
  }
  const preview = normalized.slice(0, cutoff).trim()
  return `${preview}${!endedAtSentence && cutoff < normalized.length ? '…' : ''}` || undefined
}

export function taskCompletionNotificationPresentation(
  event: TaskCompletionNotificationEvent,
  conversationTitle?: string,
): TaskCompletionNotificationPresentation | null {
  if (event.type !== 'conversation-run' || event.status !== 'completed') return null
  const normalizedTitle = conversationTitle?.replace(/\s+/g, ' ').trim() || DEFAULT_TASK_TITLE
  const taskTitle = normalizedTitle.length > MAX_TASK_TITLE_LENGTH
    ? `${normalizedTitle.slice(0, MAX_TASK_TITLE_LENGTH - 1).trimEnd()}…`
    : normalizedTitle
  const agentPreview = taskCompletionAgentPreview(event.resultSummary)
  return {
    title: '任务已完成',
    body: agentPreview ? `${taskTitle}\n${agentPreview}` : `${taskTitle} 已完成，点击查看结果。`,
    taskTitle,
    ...(agentPreview ? { agentPreview } : {}),
  }
}
