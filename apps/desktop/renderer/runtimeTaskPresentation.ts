import type { RuntimeTask, RuntimeTaskPresentationKind, RuntimeTaskStatus } from '@turboflux/agent-core/contracts'

export interface RuntimeTaskViewModel {
  category: RuntimeTaskPresentationKind
  title: string
  detail: string
  previewUrl?: string
  active: boolean
}

const ACTIVE_STATUSES = new Set<RuntimeTaskStatus>(['starting', 'running', 'stopping'])

const STATUS_LABELS: Record<RuntimeTaskStatus, string> = {
  starting: '正在启动',
  running: '进行中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '已中断',
  orphaned: '等待恢复',
}

export function runtimeTaskStatusLabel(status: RuntimeTaskStatus): string {
  return STATUS_LABELS[status]
}

export function normalizeRuntimePreviewUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim())
    const hostname = parsed.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined
    if (hostname === '0.0.0.0' || hostname === '[::]' || hostname === '::') parsed.hostname = 'localhost'
    else if (hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1' && !hostname.startsWith('127.')) return undefined
    return parsed.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

export function describeRuntimeTask(task: RuntimeTask): RuntimeTaskViewModel | null {
  const presentation = task.presentation
  if (!presentation?.title.trim()) return null
  return {
    category: presentation.kind,
    title: presentation.title.trim(),
    detail: presentation.detail?.trim() || runtimeTaskStatusLabel(task.status),
    previewUrl: presentation.previewUrl ? normalizeRuntimePreviewUrl(presentation.previewUrl) : undefined,
    active: ACTIVE_STATUSES.has(task.status),
  }
}
