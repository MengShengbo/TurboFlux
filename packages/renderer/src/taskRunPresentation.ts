import { phaseTitle, type LinearTaskFlowItem, type TaskFlowNode, type WorkRun } from '@turboflux/presentation'

export type TaskRunFlowItem = LinearTaskFlowItem | {
  key: string
  kind: 'run-status'
  run: WorkRun
  segmentIndex: number
}

export function formatTaskDuration(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0) / 1_000)
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

export function taskRunElapsedMs(run: WorkRun, now = Date.now()): number {
  const running = ['pending', 'running', 'waiting'].includes(run.status)
  const end = running ? now : run.completedAt ?? run.updatedAt
  if (!run.executionSegments?.length) return Math.max(0, end - run.startedAt)
  return run.executionSegments.reduce((total, segment) => total + Math.max(0, (segment.endedAt ?? end) - segment.startedAt), 0)
}

export function phaseStatusLabel(node: TaskFlowNode, run?: WorkRun, now = Date.now()): string {
  const title = phaseTitle(node)
  if (title !== '正在请求中') return title
  const elapsed = run ? taskRunElapsedMs(run, now) : now - node.createdAt
  return `${title} ${formatTaskDuration(elapsed)}`
}

export function taskRunStatusLabel(run: WorkRun, segmentIndex: number, now = Date.now()): string {
  const segment = run.executionSegments?.[segmentIndex]
  if (segment?.outcome === 'paused' || segment?.outcome === 'stopped') {
    return `你在 ${formatTaskDuration((segment.endedAt ?? run.updatedAt) - segment.startedAt)} 后停止了`
  }
  const duration = formatTaskDuration(taskRunElapsedMs(run, now))
  if (run.status === 'completed') return `用时 ${duration}`
  if (run.status === 'failed') return `执行失败 · 已处理 ${duration}`
  if (run.status === 'partial') return `已中断 · 已处理 ${duration}`
  if (run.status === 'cancelled' || run.status === 'paused') return `你在 ${duration} 后停止了`
  return `已处理 ${duration}`
}

export function taskRunSegmentIndex(run: WorkRun | undefined, timestamp: number): number {
  const segments = run?.executionSegments || []
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].startedAt <= timestamp) return index
  }
  return 0
}

export function withTaskRunStatus(
  items: LinearTaskFlowItem[],
  resolveRun: (runId: string) => WorkRun | undefined,
): TaskRunFlowItem[] {
  const result: TaskRunFlowItem[] = []
  const emitted = new Map<string, number>()
  const lastItemByRun = new Map<string, number>()
  const runIdFor = (item: LinearTaskFlowItem) => item.kind === 'node' ? item.node.runId : item.runId
  items.forEach((item, index) => {
    const runId = runIdFor(item)
    if (runId) lastItemByRun.set(runId, index)
  })
  const appendThrough = (run: WorkRun, segmentIndex: number) => {
    for (let index = emitted.get(run.id) ?? 0; index <= segmentIndex; index += 1) {
      result.push({ key: `run-status:${run.id}:${index}`, kind: 'run-status', run, segmentIndex: index })
      emitted.set(run.id, index + 1)
    }
  }
  items.forEach((item, index) => {
    const runId = runIdFor(item)
    const run = runId ? resolveRun(runId) : undefined
    if (run?.responseMode !== 'task') {
      result.push(item)
      return
    }
    const input = item.kind === 'node' && item.node.kind === 'input'
    const phase = item.kind === 'node' && item.node.kind === 'phase'
    if (!input && !phase) {
      const at = item.kind === 'node' ? item.node.createdAt : item.nodes[0].createdAt
      appendThrough(run, taskRunSegmentIndex(run, at))
    }
    if (!phase) result.push(item)
    if (input && !emitted.has(run.id)) appendThrough(run, 0)
    if (lastItemByRun.get(run.id) === index) appendThrough(run, Math.max(0, (run.executionSegments?.length ?? 1) - 1))
  })
  return result
}
