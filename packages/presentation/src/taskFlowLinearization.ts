import type { TaskFlowNode, TaskFlowProjectionState } from './taskFlowProjection'

export type LinearTaskFlowItem =
  | { key: string; kind: 'node'; node: TaskFlowNode }
  | { key: string; kind: 'tool-group'; runId?: string; group: LinearToolGroupKind; nodes: TaskFlowNode[]; active?: boolean }

export type LinearToolGroupKind = 'inspection' | 'keyboard' | 'scroll' | 'repeat' | 'retrieval'

export type LinearFlowGap = 'none' | 'content' | 'turn'

const PASSIVE_BROWSER_OPERATIONS = new Set([
  'browser__observe',
  'browser__visual_observe',
  'browser__diagnostics',
  'browser__wait',
  'browser__screenshot',
  'browser__assert',
  'browser__find',
  'browser__tabs',
])
const RETRIEVAL_OPERATIONS = new Set(['read_file', 'read_file_full', 'search_content', 'search_files', 'list_directory'])

function orderedPresentationNodes(state: TaskFlowProjectionState): { nodes: TaskFlowNode[]; phase?: TaskFlowNode } {
  const nodes = state.order.map(id => state.nodes[id])
    .filter((node): node is TaskFlowNode => Boolean(node))
    .filter(node => node.kind !== 'tool' || (node.toolName || node.content) !== 'set_response_mode')
  const hasActivePresentation = Boolean(state.activeRunId && nodes.some(node => (
    node.kind !== 'phase'
    && node.runId === state.activeRunId
    && !node.settled
    && (node.status === 'running' || node.status === 'waiting')
  )))
  const hasAnswerPresentation = Boolean(state.activeRunId && nodes.some(node => (
    node.kind === 'answer'
    && node.runId === state.activeRunId
    && node.content.trim()
  )))
  const phase = !state.activeRunId || hasActivePresentation || hasAnswerPresentation
    ? undefined
    : [...nodes].reverse().find(node => (
        node.kind === 'phase'
        && (node.status === 'running' || node.status === 'paused')
        && !node.settled
        && node.runId === state.activeRunId
      ))
  const ordinary = nodes.filter(node => node.kind !== 'phase')
  const firstInputByRun = new Map<string, TaskFlowNode>()
  for (const node of ordinary) {
    if (node.kind !== 'input' || !node.runId || firstInputByRun.has(node.runId)) continue
    firstInputByRun.set(node.runId, node)
  }
  const ordered: TaskFlowNode[] = []
  const emittedFirstInputs = new Set<string>()
  for (const node of ordinary) {
    const runId = node.runId
    const firstInput = runId ? firstInputByRun.get(runId) : undefined
    if (runId && firstInput && !emittedFirstInputs.has(runId) && node !== firstInput) {
      ordered.push(firstInput)
      emittedFirstInputs.add(runId)
    }
    if (runId && firstInput === node) {
      if (emittedFirstInputs.has(runId)) continue
      emittedFirstInputs.add(runId)
    }
    ordered.push(node)
  }
  return { nodes: ordered, phase }
}

export function browserToolGroupKind(node: TaskFlowNode): Exclude<LinearToolGroupKind, 'repeat'> | null {
  if (node.kind !== 'tool') return null
  const name = node.toolName || node.content
  if (PASSIVE_BROWSER_OPERATIONS.has(name)) return 'inspection'
  if (name === 'browser__press') return 'keyboard'
  if (name === 'browser__scroll') return 'scroll'
  return null
}

function repeatToolFingerprint(node: TaskFlowNode): string | null {
  if (node.kind !== 'tool' || !node.settled || !node.detail) return null
  const name = node.toolName || node.content
  return `${name}\u0000${node.content}\u0000${node.detail}`
}

export function linearTaskFlowItems(state: TaskFlowProjectionState, groupBoundary?: (node: TaskFlowNode) => string): LinearTaskFlowItem[] {
  const items: LinearTaskFlowItem[] = []
  const inspectionGroups = new Map<string, Extract<LinearTaskFlowItem, { kind: 'tool-group' }>>()
  const { nodes, phase } = orderedPresentationNodes(state)
  const runPaused = state.nodes[`phase:${state.activeRunId}`]?.status === 'paused'
  for (const node of nodes) {
    if (node.kind === 'input') {
      items.push({ key: `node:${node.id}`, kind: 'node', node })
      inspectionGroups.clear()
      continue
    }
    const group = node.kind === 'tool' && RETRIEVAL_OPERATIONS.has(node.toolName || node.content)
      ? 'retrieval'
      : browserToolGroupKind(node)
    const previous = items.at(-1)
    const previousNode = previous?.kind === 'node' ? previous.node : previous?.nodes.at(-1)
    const sameBoundary = !groupBoundary || !previousNode || groupBoundary(previousNode) === groupBoundary(node)
    if (group === 'inspection') {
      const groupKey = `${node.runId || state.conversationId}:inspection:${groupBoundary?.(node) || ''}`
      const existing = inspectionGroups.get(groupKey)
      if (existing) {
        existing.nodes.push(node)
      } else {
        const item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }> = {
          key: `tool-group:${node.id}`,
          kind: 'tool-group',
          runId: node.runId,
          group,
          nodes: [node],
          active: Boolean(node.runId && node.runId === state.activeRunId && !runPaused),
        }
        inspectionGroups.set(groupKey, item)
        items.push(item)
      }
      continue
    }
    if (group && sameBoundary && previous?.kind === 'tool-group' && previous.group === group && previous.runId === node.runId) {
      previous.nodes.push(node)
    } else if (group) {
      items.push({
        key: `tool-group:${node.id}`,
        kind: 'tool-group',
        runId: node.runId,
        group,
        nodes: [node],
        active: Boolean(node.runId && node.runId === state.activeRunId && !runPaused),
      })
    } else {
      const fingerprint = repeatToolFingerprint(node)
      if (fingerprint && sameBoundary && previous?.kind === 'node' && repeatToolFingerprint(previous.node) === fingerprint) {
        items[items.length - 1] = {
          key: `tool-group:${previous.node.id}`,
          kind: 'tool-group',
          runId: node.runId,
          group: 'repeat',
          nodes: [previous.node, node],
        }
      } else if (
        fingerprint
        && sameBoundary
        && previous?.kind === 'tool-group'
        && previous.group === 'repeat'
        && repeatToolFingerprint(previous.nodes.at(-1)!) === fingerprint
      ) {
        previous.nodes.push(node)
      } else {
        items.push({ key: `node:${node.id}`, kind: 'node', node })
      }
    }
  }
  const phaseHasInput = Boolean(phase?.runId && nodes.some(node => node.kind === 'input' && node.runId === phase.runId))
  if (phase && phaseHasInput) items.push({ key: `node:${phase.id}`, kind: 'node', node: phase })
  return items
}

function linearFlowItemRole(item: LinearTaskFlowItem): 'input' | 'content' {
  if (item.kind === 'node' && item.node.kind === 'input') return 'input'
  return 'content'
}

export function linearFlowGapBefore(previous: LinearTaskFlowItem | undefined, current: LinearTaskFlowItem): LinearFlowGap {
  if (!previous) return 'none'
  return linearFlowItemRole(current) === 'input' ? 'turn' : 'content'
}

export function groupedToolStatus(item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>): TaskFlowNode['status'] {
  if (item.nodes.some(node => node.status === 'paused' && !node.settled)) return 'paused'
  if (item.nodes.some(node => node.status === 'running' && !node.settled)) return 'running'
  if (item.nodes.some(node => node.status === 'failed')) return 'failed'
  if (item.nodes.some(node => node.status === 'cancelled')) return 'cancelled'
  if (item.nodes.some(node => node.status === 'interrupted')) return 'interrupted'
  if (item.nodes.some(node => node.status === 'waiting')) return 'waiting'
  return 'completed'
}

export function phaseTitle(node: Pick<TaskFlowNode, 'content' | 'status'>): string {
  if (node.status === 'paused') return '工作已暂停'
  if (node.status === 'failed') return '任务需要处理'
  if (node.status === 'cancelled' || node.status === 'interrupted') return '任务已停止'
  if (node.status === 'completed') return '任务已完成'
  const normalized = node.content.trim().toLowerCase()
  if (normalized.includes('paused by user') || normalized === 'paused') return '工作已暂停'
  if (normalized.includes('resuming')) return '正在继续工作'
  if (normalized.includes('planning') || normalized.includes('next step')) return '正在请求中'
  // Concrete tools have their own rows. Internal dispatch must not change the waiting label.
  if (/^running\s+/.test(normalized) || normalized.includes('tool_running')) return '正在请求中'
  if (normalized.includes('thinking')) return '正在请求中'
  if (normalized.includes('compact')) return '正在压缩上下文'
  if (normalized.includes('approval')) return '正在等待确认'
  if (normalized.includes('input')) return '正在等待补充信息'
  if (normalized.includes('abort')) return '正在停止任务'
  return node.content.trim() || '正在请求中'
}
