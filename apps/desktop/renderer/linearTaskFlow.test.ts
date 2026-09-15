import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  approvalNodeTitle,
  browserToolGroupKind,
  groupedToolStatus,
  isFinalDeliveryAnswer,
  isTaskPlanTool,
  linearFlowGapBefore,
  linearTaskFlowItems,
  nextReasoningDisclosureState,
  phaseTitle,
  reasoningBodyOverflows,
  reasoningDurationLabel,
  reasoningFollowStateFromScroll,
  shouldDeferCanonicalTaskFlowRender,
  shouldUpdateLinearAnswerInPlace,
} from './linearTaskFlow'
import type { TaskFlowNode, TaskFlowProjectionState } from './taskFlowProjection'

const linearTaskFlowSource = readFileSync(new URL('./linearTaskFlow.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function node(id: string, kind: TaskFlowNode['kind'], content: string, runId = 'run-1'): TaskFlowNode {
  return {
    id,
    runId,
    ordinal: 1,
    kind,
    phase: kind === 'thinking' ? 'reasoning' : kind === 'answer' ? 'delivery' : kind === 'input' ? 'control' : 'execution',
    status: 'completed',
    content,
    createdAt: 1,
    updatedAt: 1,
    settled: true,
  }
}

describe('linear task flow', () => {
  it('stops activity indicators for paused tool groups and completed browser inspections', () => {
    const read = { ...node('read', 'tool', 'read_file'), status: 'paused' as const, settled: false }
    const browser = node('browser', 'tool', 'browser__observe')
    const phase = { ...node('phase:run-1', 'phase', 'Paused by user'), status: 'paused' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 3,
      nodes: { read, browser, 'phase:run-1': phase }, order: ['read', 'browser', 'phase:run-1'], sequenceGaps: [],
    }
    const groups = linearTaskFlowItems(state).filter(item => item.kind === 'tool-group')
    expect(groups.map(groupedToolStatus)).toEqual(['paused', 'completed'])
    expect(phaseTitle(phase)).toBe('工作已暂停')
  })

  it('hides the mode declaration and splits tool groups at execution segment boundaries', () => {
    const mode = node('mode', 'tool', 'set_response_mode')
    const first = { ...node('first', 'tool', 'read_file'), createdAt: 1_000 }
    const second = { ...node('second', 'tool', 'read_file'), createdAt: 100_000 }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 3,
      nodes: { mode, first, second }, order: ['mode', 'first', 'second'], sequenceGaps: [],
    }
    const items = linearTaskFlowItems(state, node => node.createdAt < 100_000 ? 'first' : 'resumed')
    expect(items.map(item => item.key)).toEqual(['tool-group:first', 'tool-group:second'])
  })

  it('groups consecutive retrieval without hiding failures or keeping completed scans running', () => {
    const files = node('files', 'tool', 'search_files')
    const search = node('search', 'tool', 'search_content')
    const read = { ...node('read', 'tool', 'read_file'), status: 'failed' as const }
    const answer = node('answer', 'answer', '检查结果')
    const later = node('later', 'tool', 'read_file')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 5,
      nodes: { files, search, read, answer, later }, order: ['files', 'search', 'read', 'answer', 'later'], sequenceGaps: [],
    }
    const items = linearTaskFlowItems(state)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ kind: 'tool-group', group: 'retrieval', nodes: [files, search, read] })
    if (items[0].kind !== 'tool-group' || items[2].kind !== 'tool-group') throw new Error('Expected retrieval groups')
    expect(groupedToolStatus(items[0])).toBe('failed')
    expect(groupedToolStatus(items[2])).toBe('completed')
  })

  it('does not label resolved workflow checkpoints as waiting', () => {
    expect(approvalNodeTitle('waiting')).toBe('等待确认')
    expect(approvalNodeTitle('completed')).toBe('已确认')
    expect(approvalNodeTitle('cancelled')).toBe('确认已取消')
  })
  it('keeps an inline workflow surface while canonical task flow re-renders', () => {
    expect(linearTaskFlowSource).toContain("child.classList.contains('workflow-surface-inline')")
  })
  it('renders assistant response segments without product signatures', () => {
    const nodes = {
      input: node('input', 'input', '开始'),
      thinking: node('thinking', 'thinking', '分析'),
      tool: node('tool', 'tool', 'web_fetch'),
      answer: node('answer', 'answer', '完成'),
      steering: node('steering', 'input', '继续'),
      next: node('next', 'thinking', '继续分析'),
    }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1',
      source: 'work',
      revision: 1,
      lastSeq: 6,
      nodes,
      order: ['input', 'thinking', 'tool', 'answer', 'steering', 'next'],
      sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:thinking',
      'node:tool',
      'node:answer',
      'node:steering',
      'node:next',
    ])
  })

  it('derives one non-stacking rhythm from adjacent semantic items', () => {
    const input = { key: 'node:input', kind: 'node' as const, node: node('input', 'input', '开始') }
    const answer = { key: 'node:answer', kind: 'node' as const, node: node('answer', 'answer', '正文') }
    const tool = { key: 'node:tool', kind: 'node' as const, node: node('tool', 'tool', 'read_file') }
    const nextInput = { key: 'node:next-input', kind: 'node' as const, node: node('next-input', 'input', '继续') }

    expect(linearFlowGapBefore(undefined, input)).toBe('none')
    expect(linearFlowGapBefore(input, answer)).toBe('content')
    expect(linearFlowGapBefore(answer, tool)).toBe('content')
    expect(linearFlowGapBefore(tool, answer)).toBe('content')
    expect(linearFlowGapBefore(answer, nextInput)).toBe('turn')
  })

  it('moves an early phase to the tail without adding presentation nodes', () => {
    const nodes = {
      phase: { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false },
      input: node('input', 'input', '开始'),
      thinking: node('thinking', 'thinking', '分析'),
      tool: node('tool', 'tool', 'web_fetch'),
    }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1',
      source: 'work',
      revision: 1,
      activeRunId: 'run-1',
      lastSeq: 4,
      nodes,
      order: ['phase', 'thinking', 'input', 'tool'],
      sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:thinking',
      'node:tool',
      'node:phase',
    ])
  })

  it('moves each run input ahead of interleaved work without changing run order', () => {
    const toolB = node('tool-b', 'tool', 'read b', 'run-b')
    const toolA = node('tool-a', 'tool', 'read a', 'run-a')
    const inputA = node('input-a', 'input', 'start a', 'run-a')
    const inputB = node('input-b', 'input', 'start b', 'run-b')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1',
      source: 'work',
      revision: 1,
      lastSeq: 4,
      nodes: {
        'tool-b': toolB,
        'tool-a': toolA,
        'input-a': inputA,
        'input-b': inputB,
      },
      order: ['tool-b', 'tool-a', 'input-a', 'input-b'],
      sequenceGaps: [],
    }

    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input-b',
      'node:tool-b',
      'node:input-a',
      'node:tool-a',
    ])
  })

  it('suppresses the phase placeholder while real active work is visible', () => {
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const thinking = { ...node('thinking', 'thinking', '正在分析'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 2,
      nodes: { phase, thinking }, order: ['phase', 'thinking'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:thinking',
    ])
  })

  it('keeps one canonical request phase below the user input', () => {
    const input = node('input', 'input', '开始')
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 2,
      nodes: { input, phase }, order: ['input', 'phase'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:phase',
    ])
  })

  it('does not restore a running request phase after the answer is visible', () => {
    const input = node('input', 'input', '开始')
    const answer = node('answer', 'answer', '最终答案')
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 3,
      nodes: { input, answer, phase }, order: ['input', 'answer', 'phase'], sequenceGaps: [],
    }

    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'node:input',
      'node:answer',
    ])
  })

  it('does not show a run phase before its user input exists', () => {
    const phase = { ...node('phase', 'phase', 'Planning the next step'), status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 1,
      nodes: { phase }, order: ['phase'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state)).toEqual([])
  })

  it('groups settled browser inspections across one run while keeping raw nodes', () => {
    const observe = { ...node('observe', 'tool', 'browser__observe'), toolName: 'browser__observe' }
    const diagnostics = { ...node('diagnostics', 'tool', 'browser__diagnostics'), toolName: 'browser__diagnostics' }
    const visual = { ...node('visual', 'tool', 'browser__visual_observe'), toolName: 'browser__visual_observe' }
    const thinking = node('thinking', 'thinking', '核对页面状态')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 4,
      nodes: { observe, thinking, diagnostics, visual },
      order: ['observe', 'thinking', 'diagnostics', 'visual'],
      sequenceGaps: [],
    }
    const items = linearTaskFlowItems(state)
    expect(items.map(item => item.key)).toEqual([
      'tool-group:observe',
      'node:thinking',
    ])
    expect(items[0]).toMatchObject({ kind: 'tool-group', group: 'inspection' })
    expect(items[0]?.kind === 'tool-group' ? items[0].nodes.map(item => item.id) : []).toEqual([
      'observe',
      'diagnostics',
      'visual',
    ])
  })

  it('keeps browser inspection grouping stable while the latest call is running', () => {
    const completed = { ...node('completed', 'tool', 'browser__observe'), toolName: 'browser__observe' }
    const running = { ...node('running', 'tool', 'browser__observe'), toolName: 'browser__observe', status: 'running' as const, settled: false }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 2,
      nodes: { completed, running }, order: ['completed', 'running'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state).map(item => item.key)).toEqual([
      'tool-group:completed',
    ])
    expect(linearTaskFlowItems(state)[0]).toMatchObject({
      kind: 'tool-group',
      group: 'inspection',
      nodes: [completed, running],
      active: true,
    })
  })

  it('does not change the browser group key when a call settles', () => {
    const running = { ...node('observe', 'tool', 'browser__observe'), toolName: 'browser__observe', status: 'running' as const, settled: false }
    const completed = { ...running, status: 'completed' as const, settled: true }
    const state = (tool: TaskFlowNode): TaskFlowProjectionState => ({
      conversationId: 'conversation-1', source: 'work', revision: 1, activeRunId: 'run-1', lastSeq: 1,
      nodes: { observe: tool }, order: ['observe'], sequenceGaps: [],
    })
    expect(browserToolGroupKind(running)).toBe('inspection')
    expect(linearTaskFlowItems(state(running))[0]?.key).toBe('tool-group:observe')
    expect(linearTaskFlowItems(state(completed))[0]?.key).toBe('tool-group:observe')
    const activeGroup = linearTaskFlowItems(state(completed))[0]
    expect(activeGroup).toMatchObject({ active: true })
    expect(activeGroup?.kind === 'tool-group' ? groupedToolStatus(activeGroup) : null).toBe('running')
    const settledGroup = linearTaskFlowItems({ ...state(completed), activeRunId: undefined })[0]
    expect(settledGroup?.kind === 'tool-group' ? groupedToolStatus(settledGroup) : null).toBe('completed')
  })

  it('collapses exact consecutive duplicate tool results', () => {
    const first = { ...node('search-1', 'tool', 'web_search'), toolName: 'web_search', detail: 'same result' }
    const second = { ...node('search-2', 'tool', 'web_search'), toolName: 'web_search', detail: 'same result' }
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 2,
      nodes: { first, second }, order: ['first', 'second'], sequenceGaps: [],
    }
    const items = linearTaskFlowItems(state)
    expect(items.map(item => item.key)).toEqual(['tool-group:search-1'])
    expect(items[0]).toMatchObject({ kind: 'tool-group', group: 'repeat' })
  })

  it('recognizes task mutations as semantic plan audit rows', () => {
    expect(isTaskPlanTool('create_task')).toBe(true)
    expect(isTaskPlanTool('create_tasks')).toBe(true)
    expect(isTaskPlanTool('update_task')).toBe(true)
    expect(isTaskPlanTool('read_file')).toBe(false)
  })

  it('does not render settled phases as conversation rows', () => {
    const phase = node('phase', 'phase', 'completed')
    const state: TaskFlowProjectionState = {
      conversationId: 'conversation-1', source: 'work', revision: 1, lastSeq: 1,
      nodes: { phase }, order: ['phase'], sequenceGaps: [],
    }
    expect(linearTaskFlowItems(state)).toEqual([])
  })

  it('localizes pause and resume runtime phases', () => {
    expect(phaseTitle({ content: 'Paused by user', status: 'running' })).toBe('工作已暂停')
    expect(phaseTitle({ content: 'Resuming run', status: 'running' })).toBe('正在继续工作')
  })

  it('keeps running reasoning collapsed until the user opens a bounded scroll region', () => {
    expect(nextReasoningDisclosureState({ running: true, expanded: false })).toEqual({
      expanded: true,
      userExpanded: true,
    })
    expect(nextReasoningDisclosureState({ running: true, expanded: true, userExpanded: true })).toEqual({
      expanded: false,
      userExpanded: false,
    })
    expect(linearTaskFlowSource).toContain("root.dataset.userExpanded = 'false'")
    expect(linearTaskFlowSource).toContain('toggleDisclosure(root, false)')
    expect(linearTaskFlowSource).toContain("title.textContent = '推理过程'")
    expect(linearTaskFlowSource).toContain("expandAction.className = 'linear-reasoning-expand-action'")
    expect(linearTaskFlowSource).toContain("expandLabel.className = 'linear-reasoning-expand-label'")
    expect(linearTaskFlowSource).toContain("expandLabel.textContent = expanded ? '收起' : '展开'")
    expect(linearTaskFlowSource).not.toContain('linear-reasoning-collapse-action')
    expect(linearTaskFlowSource).not.toContain('reasoningSummary(node)')
    expect(linearTaskFlowSource).not.toContain('scheduleReasoningCollapse')
    expect(styles).toContain('max-height: min(260px, 34vh)')
    expect(reasoningBodyOverflows({ scrollHeight: 44, clientHeight: 44 })).toBe(false)
    expect(reasoningBodyOverflows({ scrollHeight: 45, clientHeight: 44 })).toBe(false)
    expect(reasoningBodyOverflows({ scrollHeight: 47, clientHeight: 44 })).toBe(true)
    expect(reasoningFollowStateFromScroll({ scrollHeight: 200, scrollTop: 100, clientHeight: 100 })).toBe(true)
    expect(reasoningFollowStateFromScroll({ scrollHeight: 200, scrollTop: 40, clientHeight: 100 })).toBe(false)
    expect(linearTaskFlowSource).toContain("body.classList.toggle('has-overflow', overflows)")
    expect(styles).toContain('.linear-reasoning-body.has-overflow {')
    expect(styles).toContain('transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%')
    expect(styles).toContain('scrollbar-gutter: stable')
    expect(styles).toContain('.linear-reasoning-body::-webkit-scrollbar { width: 6px; }')
    expect(styles).toContain('.linear-reasoning:not(.expanded) > .linear-disclosure-row:hover .linear-reasoning-expand-action')
    expect(styles).toContain('.linear-reasoning.expanded > .linear-disclosure-row .linear-reasoning-expand-action')
    expect(styles).not.toContain('.linear-reasoning-collapse-action')
    expect(styles).not.toContain('.linear-reasoning[data-user-expanded="true"] .linear-reasoning-body { max-height: none;')
  })

  it('shows a live reasoning duration and freezes the completed value', () => {
    expect(reasoningDurationLabel({
      createdAt: 1_000,
      updatedAt: 2_000,
      status: 'running',
      settled: false,
    }, 8_600)).toBe('思考了 8 秒')
    expect(reasoningDurationLabel({
      createdAt: 1_000,
      updatedAt: 6_400,
      status: 'completed',
      settled: true,
    }, 20_000)).toBe('思考了 5 秒')
    expect(linearTaskFlowSource).toContain("duration.className = 'linear-reasoning-duration'")
    expect(linearTaskFlowSource).toContain('window.setInterval')
  })

  it('only exposes message actions on the final answer of a terminal run', () => {
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-1', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'completed',
    })).toBe(false)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'running',
    })).toBe(false)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'completed',
    })).toBe(true)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'failed',
    })).toBe(true)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'cancelled', hasToolCalls: true,
    })).toBe(false)
    expect(isFinalDeliveryAnswer({
      nodeKind: 'answer', nodeId: 'answer-2', runId: 'run-1', finalAnswerId: 'answer-2', runStatus: 'partial', interrupted: true,
    })).toBe(false)
  })

  it('keeps streaming answers on one stable DOM node', () => {
    const running = { ...node('answer', 'answer', '正在输出'), status: 'running' as const, settled: false }
    expect(shouldUpdateLinearAnswerInPlace(running, true)).toBe(true)
    expect(shouldUpdateLinearAnswerInPlace(running, false)).toBe(false)
    expect(shouldUpdateLinearAnswerInPlace(node('answer', 'answer', '完成'), true)).toBe(false)
  })

  it('defers canonical rendering while live transcript nodes own the stream', () => {
    expect(shouldDeferCanonicalTaskFlowRender({
      streamingAnswer: true, streamingReasoning: false,
    })).toBe(true)
    expect(shouldDeferCanonicalTaskFlowRender({
      streamingAnswer: false, streamingReasoning: false,
    })).toBe(false)
    expect(shouldDeferCanonicalTaskFlowRender({
      force: true, streamingAnswer: true, streamingReasoning: true,
    })).toBe(false)
  })
})
