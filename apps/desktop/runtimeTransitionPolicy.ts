import type { WorkbenchSnapshot } from '@turboflux/agent-core/workbench'

export function runtimeTransitionBlocker(
  snapshot: Pick<WorkbenchSnapshot, 'conversationRuntimes'>,
  options: { allowRecoverableError?: boolean } = {},
): string | null {
  const active = snapshot.conversationRuntimes.find(runtime => runtime.status !== 'ready')
  if (!active) return null
  if (active.status === 'paused') return '有任务已暂停，请先继续或停止任务后再操作'
  if (active.status === 'awaiting-action') return '有任务正在等待确认，请先处理或停止任务后再操作'
  if (active.status === 'error') return options.allowRecoverableError ? null : '有任务需要处理恢复状态，请先完成处理后再操作'
  return '有任务仍在运行，请先等待完成或停止任务后再操作'
}
