import { KeyedList } from '@turboflux/renderer'
import {
  browserToolGroupKind,
  groupedToolStatus,
  linearFlowGapBefore,
  linearTaskFlowItems,
  phaseTitle,
  type ChangeSummary,
  type AgentAttachment,
  type AgentTurn,
  type LinearTaskFlowItem,
  type LinearToolGroupKind,
  type ToolCall,
  type ToolResult,
  type WorkRun,
  stripTextToolCallMarkup,
} from '@turboflux/presentation'
import {
  browserToolActionTitle,
  browserToolResultDetail,
  normalizeThinkingContent,
  renderMarkdown,
  renderDiffPreview,
  toolDisplayName,
} from './richContent'
import type { TaskFlowNode, TaskFlowProjectionState } from '@turboflux/presentation'
import { Brain, createElement } from 'lucide'
import { toolActivityIcon, toolActivityStatus, toolActivitySummary } from './toolActivityPresentation'
import { createRetrievalGroupView, replaceRetrievalView } from './retrievalView'
import { createToolResultView } from './toolResultView'
import { phaseStatusLabel, taskRunSegmentIndex, taskRunStatusLabel, withTaskRunStatus, type TaskRunFlowItem } from './taskRunPresentation'

export {
  browserToolGroupKind,
  groupedToolStatus,
  linearFlowGapBefore,
  linearTaskFlowItems,
  phaseTitle,
}
export type { LinearFlowGap, LinearTaskFlowItem, LinearToolGroupKind } from '@turboflux/presentation'

export interface LinearTaskFlowTool {
  call: ToolCall
  result?: ToolResult
  onPreviewDiff?: (change: ChangeSummary) => void
  onOpenBrowser?: () => void
  createImagePreview?: (attachment: AgentAttachment) => HTMLElement
}

export interface LinearTaskFlowRendererOptions {
  createInput(node: TaskFlowNode): HTMLElement | null
  createAnswer(node: TaskFlowNode, presentation: { finalDelivery: boolean }): HTMLElement | null
  updateAnswer?(row: HTMLElement, node: TaskFlowNode, presentation: { finalDelivery: boolean }): boolean
  resolveTool(node: TaskFlowNode): LinearTaskFlowTool
  resolveTurn?(turnId: string): AgentTurn | undefined
  resolveRun?(runId: string): WorkRun | undefined
  nodeVersion?(node: TaskFlowNode): string
}

export interface LinearTaskFlowRenderer {
  render(state: TaskFlowProjectionState, force?: boolean): void
  clear(): void
}

export function shouldDeferCanonicalTaskFlowRender(input: {
  force?: boolean
  streamingAnswer: boolean
  streamingReasoning: boolean
}): boolean {
  return !input.force && (input.streamingAnswer || input.streamingReasoning)
}

export function shouldUpdateLinearAnswerInPlace(node: Pick<TaskFlowNode, 'kind' | 'status' | 'settled'>, hasExistingAnswer: boolean): boolean {
  return hasExistingAnswer && node.kind === 'answer' && node.status === 'running' && !node.settled
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])
const reasoningOverflowObservers = new WeakMap<HTMLElement, ResizeObserver>()

export function isFinalDeliveryAnswer(input: {
  nodeKind: TaskFlowNode['kind']
  nodeId: string
  runId?: string
  finalAnswerId?: string
  runStatus?: string
  hasToolCalls?: boolean
  interrupted?: boolean
}): boolean {
  return Boolean(
    input.nodeKind === 'answer'
    && input.runId
    && input.finalAnswerId === input.nodeId
    && input.runStatus
    && TERMINAL_RUN_STATUSES.has(input.runStatus)
    && input.hasToolCalls !== true
    && input.interrupted !== true,
  )
}

function disclosureChevron(): HTMLElement {
  const chevron = document.createElement('span')
  chevron.className = 'linear-disclosure-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.innerHTML = '<svg viewBox="0 0 16 16"><path d="m6 3.75 4.25 4.25L6 12.25"/></svg>'
  return chevron
}

function toggleDisclosure(root: HTMLElement, expanded: boolean): void {
  root.classList.toggle('expanded', expanded)
  root.querySelector<HTMLElement>('.linear-disclosure-row')?.setAttribute('aria-expanded', String(expanded))
  const body = root.querySelector<HTMLElement>('.linear-disclosure-body')
  body?.setAttribute('aria-hidden', String(!expanded))
  if (body) body.inert = !expanded
  const expandLabel = root.querySelector<HTMLElement>('.linear-reasoning-expand-label')
  if (expandLabel) expandLabel.textContent = expanded ? '收起' : '展开'
  scheduleReasoningOverflowSync(root)
}

export function reasoningBodyOverflows(
  dimensions: Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>,
): boolean {
  return dimensions.scrollHeight > dimensions.clientHeight + 1
}

export function reasoningFollowStateFromScroll(
  dimensions: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
): boolean {
  return dimensions.scrollHeight - dimensions.scrollTop - dimensions.clientHeight <= 2
}

function syncReasoningOverflow(root: HTMLElement): void {
  const body = root.querySelector<HTMLElement>('.linear-reasoning-body')
  if (!body) return
  const overflows = root.classList.contains('expanded')
    && body.clientHeight > 0
    && reasoningBodyOverflows(body)
  body.classList.toggle('has-overflow', overflows)
  if (!overflows) body.scrollTop = 0
}

function scheduleReasoningOverflowSync(root: HTMLElement): void {
  const previousFrame = Number(root.dataset.reasoningOverflowFrame || 0)
  if (previousFrame) window.cancelAnimationFrame(previousFrame)
  const frame = window.requestAnimationFrame(() => {
    delete root.dataset.reasoningOverflowFrame
    syncReasoningOverflow(root)
  })
  root.dataset.reasoningOverflowFrame = String(frame)
}

function observeReasoningOverflow(root: HTMLElement, body: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') {
    scheduleReasoningOverflowSync(root)
    return
  }
  const observer = new ResizeObserver(() => scheduleReasoningOverflowSync(root))
  observer.observe(body)
  reasoningOverflowObservers.set(root, observer)
  scheduleReasoningOverflowSync(root)
}

function stopReasoningOverflowObserver(root: HTMLElement | null): void {
  if (!root) return
  reasoningOverflowObservers.get(root)?.disconnect()
  reasoningOverflowObservers.delete(root)
  const frame = Number(root.dataset.reasoningOverflowFrame || 0)
  if (frame) window.cancelAnimationFrame(frame)
  delete root.dataset.reasoningOverflowFrame
}

function disposeReasoningNode(root: HTMLElement | null): void {
  stopReasoningDurationTicker(root)
  stopReasoningOverflowObserver(root)
}

export function reasoningDurationLabel(
  node: Pick<TaskFlowNode, 'createdAt' | 'updatedAt' | 'status' | 'settled'>,
  now = Date.now(),
): string {
  const running = node.status === 'running' && !node.settled
  const endedAt = running ? now : node.updatedAt
  const seconds = Math.max(1, Math.round(Math.max(0, endedAt - node.createdAt) / 1_000))
  return `思考了 ${seconds} 秒`
}

function stopReasoningDurationTicker(root: HTMLElement | null): void {
  if (!root) return
  const timer = Number(root.dataset.reasoningDurationTimer || 0)
  if (timer) window.clearInterval(timer)
  delete root.dataset.reasoningDurationTimer
}

function syncReasoningDuration(root: HTMLElement, node: TaskFlowNode): void {
  const duration = root.querySelector<HTMLElement>('.linear-reasoning-duration')
  if (!duration) return
  root.dataset.reasoningCreatedAt = String(node.createdAt)
  root.dataset.reasoningUpdatedAt = String(node.updatedAt)
  duration.textContent = reasoningDurationLabel(node)
  const running = node.status === 'running' && !node.settled
  if (!running) {
    stopReasoningDurationTicker(root)
    return
  }
  if (root.dataset.reasoningDurationTimer) return
  const timer = window.setInterval(() => {
    if (!root.isConnected || !root.classList.contains('running')) {
      stopReasoningDurationTicker(root)
      return
    }
    const createdAt = Number(root.dataset.reasoningCreatedAt)
    duration.textContent = reasoningDurationLabel({
      createdAt,
      updatedAt: Number(root.dataset.reasoningUpdatedAt),
      status: 'running',
      settled: false,
    })
  }, 1_000)
  root.dataset.reasoningDurationTimer = String(timer)
}

export function nextReasoningDisclosureState(input: {
  running: boolean
  expanded: boolean
  userExpanded?: boolean
}): { expanded: boolean; userExpanded: boolean } {
  const expanded = !input.expanded
  return { expanded, userExpanded: expanded }
}

function scrollReasoningToLatest(root: HTMLElement): void {
  window.requestAnimationFrame(() => {
    const body = root.querySelector<HTMLElement>('.linear-reasoning-body')
    syncReasoningOverflow(root)
    if (body?.classList.contains('has-overflow') && root.dataset.reasoningFollowLatest !== 'false') {
      body.scrollTop = body.scrollHeight
    }
  })
}

function createReasoningNode(node: TaskFlowNode): HTMLElement {
  const content = normalizeThinkingContent(node.content)
  const root = document.createElement('section')
  root.className = 'linear-reasoning linear-disclosure'
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row'
  const leading = document.createElement('span')
  leading.className = 'linear-disclosure-leading linear-reasoning-leading'
  const icon = document.createElement('span')
  icon.className = 'linear-reasoning-icon'
  icon.append(createElement(Brain, { width: 14, height: 14, 'stroke-width': 1.7, 'aria-hidden': 'true' }))
  leading.append(icon)
  row.append(leading)
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = '推理过程'
  const duration = document.createElement('span')
  duration.className = 'linear-reasoning-duration'
  const expandAction = document.createElement('span')
  expandAction.className = 'linear-reasoning-expand-action'
  const expandLabel = document.createElement('span')
  expandLabel.className = 'linear-reasoning-expand-label'
  expandLabel.textContent = '展开'
  expandAction.append(expandLabel, disclosureChevron())
  row.append(title, duration, expandAction)
  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyFrame = document.createElement('div')
  bodyFrame.className = 'linear-disclosure-body-inner linear-reasoning-frame'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-reasoning-body'
  bodyInner.textContent = content || '正在整理思路…'
  bodyFrame.append(bodyInner)
  body.append(bodyFrame)
  root.append(row, body)
  observeReasoningOverflow(root, bodyInner)
  const running = node.status === 'running' && !node.settled
  root.dataset.status = node.status
  root.dataset.userExpanded = 'false'
  root.dataset.reasoningFollowLatest = 'true'
  root.classList.toggle('running', running)
  toggleDisclosure(root, false)
  syncReasoningDuration(root, node)
  if (running) scrollReasoningToLatest(root)
  bodyInner.addEventListener('scroll', () => {
    root.dataset.reasoningFollowLatest = String(reasoningFollowStateFromScroll(bodyInner))
  }, { passive: true })
  bodyInner.addEventListener('wheel', event => {
    if (event.deltaY < 0) root.dataset.reasoningFollowLatest = 'false'
  }, { passive: true })
  row.addEventListener('click', () => {
    const next = nextReasoningDisclosureState({
      running: root.classList.contains('running'),
      expanded: root.classList.contains('expanded'),
      userExpanded: root.dataset.userExpanded === undefined ? undefined : root.dataset.userExpanded === 'true',
    })
    root.dataset.userExpanded = String(next.userExpanded)
    toggleDisclosure(root, next.expanded)
  })
  return root
}

function updateReasoningNode(root: HTMLElement, node: TaskFlowNode): void {
  const content = normalizeThinkingContent(node.content)
  const running = node.status === 'running' && !node.settled
  root.dataset.status = node.status
  root.classList.toggle('running', running)
  root.querySelector<HTMLElement>('.linear-disclosure-title')!.textContent = '推理过程'
  root.querySelector<HTMLElement>('.linear-reasoning-body')!.textContent = content || '正在整理思路…'
  scheduleReasoningOverflowSync(root)
  syncReasoningDuration(root, node)
  if (running) scrollReasoningToLatest(root)
}

function safeJson(value: string | undefined): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function compactText(value: unknown, limit = 132): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}


const TASK_PLAN_TOOLS = new Set(['create_task', 'create_tasks', 'update_task'])

export function isTaskPlanTool(name: string): boolean {
  return TASK_PLAN_TOOLS.has(name)
}

function taskStatusLabel(status: unknown): string {
  return ({
    pending: '等待',
    in_progress: '开始',
    completed: '完成',
    failed: '遇到问题',
  } as Record<string, string>)[String(status || '')] || '更新'
}

function taskPlanSummary(call: ToolCall, result?: ToolResult): { title: string; summary: string } {
  if (call.name === 'create_tasks') {
    const tasks = Array.isArray(call.arguments.tasks)
      ? call.arguments.tasks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
    const firstTitle = compactText(tasks[0]?.title, 72)
    return {
      title: '建立任务计划',
      summary: firstTitle || '正在整理工作步骤',
    }
  }
  if (call.name === 'create_task') {
    return { title: '加入任务计划', summary: compactText(call.arguments.title, 88) || '新增 1 项任务' }
  }
  const output = safeJson(result?.output)
  const outputTitle = output && typeof output === 'object' ? compactText((output as Record<string, unknown>).title, 88) : ''
  return {
    title: '更新任务计划',
    summary: `${taskStatusLabel(call.arguments.status)}${outputTitle ? ` · ${outputTitle}` : ''}`,
  }
}

function toolIcon(name: string): string {
  return toolActivityIcon(name)
}

function toolStatusLabel(status: TaskFlowNode['status'], result?: ToolResult): string {
  if (status === 'paused') return '已暂停'
  if (result?.interruption?.kind === 'pause') return '已中断（任务暂停）'
  if (status === 'running') return '执行中'
  if (status === 'waiting') return '等待中'
  if (status === 'failed') return '失败'
  if (status === 'cancelled' || status === 'interrupted') return '已停止'
  return '完成'
}

function toolPresentation(node: TaskFlowNode, tool: LinearTaskFlowTool): {
  title: string
  summary: string
} {
  const { call, result } = tool
  const plan = isTaskPlanTool(call.name) ? taskPlanSummary(call, result) : undefined
  const title = plan?.title || (call.name === 'run_command' ? compactText(call.arguments.display_title, 72) : '') || browserToolActionTitle(call.name) || toolDisplayName(call.name)
  const browserDetail = browserToolResultDetail(call.name, result)
  const change = result?.changeSummary
  const interruption = node.status === 'paused' || node.status === 'cancelled' || node.status === 'interrupted'
    ? toolStatusLabel(node.status, result) : ''
  const failure = node.status === 'failed' || result?.isError ? toolActivitySummary(call, result, node.status) : ''
  const summary = interruption || failure || plan?.summary || browserDetail
    || (change ? `${change.path} · +${change.addedLines ?? 0} −${change.removedLines ?? 0}` : '')
    || toolActivitySummary(call, result, node.status)
  return { title, summary }
}

const retrievalVersions = new WeakMap<HTMLElement, string>()

function updateToolBody(host: HTMLElement, tool: LinearTaskFlowTool, status?: TaskFlowNode['status']): void {
  const previous = host.querySelector<HTMLElement>(':scope > .tool-result-view')
  const fingerprint = JSON.stringify([tool.call, tool.result, status])
  if (previous && retrievalVersions.get(previous) === fingerprint) return
  const view = createToolResultView(tool.call, tool.result, { renderMarkdown, renderDiffPreview, onPreviewDiff: tool.onPreviewDiff, onOpenBrowser: tool.onOpenBrowser, createImagePreview: tool.createImagePreview, status })
  retrievalVersions.set(view, fingerprint)
  if (previous) replaceRetrievalView(previous, view)
  else host.replaceChildren(view)
}

function createToolNode(node: TaskFlowNode, tool: LinearTaskFlowTool): HTMLElement {
  const presentation = toolPresentation(node, tool)
  const root = document.createElement('section')
  root.className = `linear-tool linear-disclosure status-${node.status}`
  root.classList.toggle('linear-plan-audit', isTaskPlanTool(tool.call.name))
  root.dataset.toolId = node.callId || tool.call.id
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row linear-tool-row'
  const leading = document.createElement('span')
  leading.className = 'linear-disclosure-leading'
  const icon = document.createElement('span')
  icon.className = 'linear-tool-icon'
  icon.dataset.toolName = tool.call.name
  icon.innerHTML = toolIcon(tool.call.name)
  const hoverChevron = disclosureChevron()
  hoverChevron.classList.add('linear-tool-hover-chevron')
  leading.append(icon, hoverChevron)
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = presentation.title
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  separator.setAttribute('aria-hidden', 'true')
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = presentation.summary
  const status = document.createElement('span')
  status.className = 'visually-hidden'
  status.textContent = toolStatusLabel(node.status, tool.result)
  row.append(leading, title, separator, summary, status)
  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-tool-body'
  updateToolBody(bodyInner, tool, node.status)
  body.append(bodyInner)
  root.append(row, body)
  toggleDisclosure(root, false)
  row.onclick = () => {
    const expanded = !root.classList.contains('expanded')
    root.dataset.userExpanded = String(expanded)
    toggleDisclosure(root, expanded)
  }
  return root
}

function updateToolNode(root: HTMLElement, node: TaskFlowNode, tool: LinearTaskFlowTool): boolean {
  if (!root.classList.contains('linear-tool') || root.classList.contains('linear-tool-group')) return false
  const presentation = toolPresentation(node, tool)
  root.classList.remove('status-waiting', 'status-running', 'status-paused', 'status-completed', 'status-failed', 'status-cancelled', 'status-interrupted')
  root.classList.add(`status-${node.status}`)
  root.classList.toggle('linear-plan-audit', isTaskPlanTool(tool.call.name))
  root.dataset.toolId = node.callId || tool.call.id
  const icon = root.querySelector<HTMLElement>('.linear-tool-icon')
  if (icon && icon.dataset.toolName !== tool.call.name) {
    icon.innerHTML = toolIcon(tool.call.name)
    icon.dataset.toolName = tool.call.name
  }
  root.querySelector<HTMLElement>('.linear-disclosure-title')!.textContent = presentation.title
  root.querySelector<HTMLElement>('.linear-disclosure-summary')!.textContent = presentation.summary
  root.querySelector<HTMLElement>('.visually-hidden')!.textContent = toolStatusLabel(node.status, tool.result)
  const body = root.querySelector<HTMLElement>('.linear-tool-body')!
  updateToolBody(body, tool, node.status)
  const row = root.querySelector<HTMLButtonElement>(':scope > .linear-tool-row')
  if (row) {
    row.onclick = () => {
      const expanded = !root.classList.contains('expanded')
      root.dataset.userExpanded = String(expanded)
      toggleDisclosure(root, expanded)
    }
  }
  return true
}

function browserToolGroupTitle(group: LinearToolGroupKind, repeatedTitle = '', count = 2): string {
  if (group === 'retrieval') return count === 1 ? repeatedTitle : '查找与阅读'
  if (count === 1) return repeatedTitle || '浏览器操作'
  if (group === 'repeat') return repeatedTitle || '重复工具调用'
  if (group === 'keyboard') return '浏览器键盘操作'
  if (group === 'scroll') return '浏览器页面滚动'
  return '浏览器状态检查'
}

function toolGroupSummary(item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>, status: TaskFlowNode['status'], firstSummary: string): string {
  if (item.nodes.length === 1) return firstSummary
  if (status === 'paused') return '已暂停'
  if (status === 'failed') return '部分操作失败'
  if (status === 'cancelled' || status === 'interrupted') return '已停止'
  return status === 'running' ? '进行中' : status === 'waiting' ? '等待中' : ''
}

function createToolGroupEntry(node: TaskFlowNode, options: LinearTaskFlowRendererOptions, index: number): HTMLDetailsElement {
  const tool = options.resolveTool(node)
  const presentation = toolPresentation(node, tool)
  const detail = document.createElement('details')
  detail.className = 'linear-tool-group-entry'
  detail.dataset.taskFlowNodeId = node.id
  const entrySummary = document.createElement('summary')
  const entryTitle = document.createElement('strong')
  entryTitle.textContent = `${index + 1}. ${presentation.title}`
  const entryDetail = document.createElement('span')
  entryDetail.textContent = presentation.summary
  entrySummary.append(entryTitle, entryDetail)
  const entryBody = document.createElement('div')
  entryBody.className = 'linear-tool-group-entry-body'
  updateToolBody(entryBody, tool, node.status)
  detail.append(entrySummary, entryBody)
  return detail
}

function updateToolGroupEntry(
  detail: HTMLDetailsElement,
  node: TaskFlowNode,
  options: LinearTaskFlowRendererOptions,
  index: number,
): void {
  const tool = options.resolveTool(node)
  const presentation = toolPresentation(node, tool)
  detail.dataset.taskFlowNodeId = node.id
  const summary = detail.querySelector<HTMLElement>(':scope > summary')!
  summary.querySelector<HTMLElement>(':scope > strong')!.textContent = `${index + 1}. ${presentation.title}`
  summary.querySelector<HTMLElement>(':scope > span')!.textContent = presentation.summary
  const body = detail.querySelector<HTMLElement>(':scope > .linear-tool-group-entry-body')!
  updateToolBody(body, tool, node.status)
}

function createToolGroupNode(
  item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>,
  options: LinearTaskFlowRendererOptions,
): HTMLElement {
  const status = groupedToolStatus(item)
  const firstPresentation = toolPresentation(item.nodes[0]!, options.resolveTool(item.nodes[0]!))
  const root = document.createElement('section')
  root.className = `linear-tool linear-tool-group linear-disclosure status-${status}`
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row linear-tool-row'
  const leading = document.createElement('span')
  leading.className = 'linear-disclosure-leading'
  const icon = document.createElement('span')
  icon.className = 'linear-tool-icon'
  const firstToolName = item.nodes[0]?.toolName || item.nodes[0]?.content || 'browser__observe'
  icon.dataset.toolName = firstToolName
  icon.innerHTML = toolIcon(firstToolName)
  const hoverChevron = disclosureChevron()
  hoverChevron.classList.add('linear-tool-hover-chevron')
  leading.append(icon, hoverChevron)
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = browserToolGroupTitle(item.group, firstPresentation.title, item.nodes.length)
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = toolGroupSummary(item, status, firstPresentation.summary)
  row.append(leading, title, separator, summary)

  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-tool-group-body'
  updateGroupResources(bodyInner, item, options)
  if (item.group !== 'retrieval') {
    if (item.nodes.length === 1) updateToolBody(bodyInner, options.resolveTool(item.nodes[0]!), item.nodes[0]!.status)
    else for (const [index, node] of item.nodes.entries()) bodyInner.append(createToolGroupEntry(node, options, index))
  }
  body.append(bodyInner)
  root.append(row, body)
  toggleDisclosure(root, false)
  row.onclick = () => {
    const expanded = !root.classList.contains('expanded')
    root.dataset.userExpanded = String(expanded)
    toggleDisclosure(root, expanded)
  }
  return root
}

function updateToolGroupNode(
  root: HTMLElement,
  item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>,
  options: LinearTaskFlowRendererOptions,
): boolean {
  if (!root.classList.contains('linear-tool-group')) return false
  const status = groupedToolStatus(item)
  const firstNode = item.nodes[0]
  if (!firstNode) return false
  const firstPresentation = toolPresentation(firstNode, options.resolveTool(firstNode))
  root.classList.remove('status-waiting', 'status-running', 'status-paused', 'status-completed', 'status-failed', 'status-cancelled', 'status-interrupted')
  root.classList.add(`status-${status}`)
  const icon = root.querySelector<HTMLElement>('.linear-tool-icon')
  const toolName = firstNode.toolName || firstNode.content || 'browser__observe'
  if (icon && icon.dataset.toolName !== toolName) {
    icon.dataset.toolName = toolName
    icon.innerHTML = toolIcon(toolName)
  }
  root.querySelector<HTMLElement>('.linear-disclosure-title')!.textContent = browserToolGroupTitle(item.group, firstPresentation.title, item.nodes.length)
  root.querySelector<HTMLElement>('.linear-disclosure-summary')!.textContent = toolGroupSummary(item, status, firstPresentation.summary)
  const row = root.querySelector<HTMLButtonElement>(':scope > .linear-tool-row')
  if (row) {
    row.onclick = () => {
      const expanded = !root.classList.contains('expanded')
      root.dataset.userExpanded = String(expanded)
      toggleDisclosure(root, expanded)
    }
  }

  const body = root.querySelector<HTMLElement>('.linear-tool-group-body')!
  updateGroupResources(body, item, options)
  if (item.group === 'retrieval') return true
  if (item.nodes.length === 1) {
    const previous = body.querySelector<HTMLElement>(':scope > .linear-tool-group-entry > .linear-tool-group-entry-body > .tool-result-view')
    if (previous) body.replaceChildren(previous)
    updateToolBody(body, options.resolveTool(firstNode), firstNode.status)
    return true
  }
  const standalone = body.querySelector<HTMLElement>(':scope > .tool-result-view')
  const desired = new Set(item.nodes.map(node => node.id))
  const entries = new Map(Array.from(body.querySelectorAll<HTMLDetailsElement>(':scope > .linear-tool-group-entry'))
    .map(entry => [entry.dataset.taskFlowNodeId || '', entry]))
  for (const entry of entries.values()) {
    if (!desired.has(entry.dataset.taskFlowNodeId || '')) entry.remove()
  }
  let cursor: ChildNode | null = body.querySelector(':scope > .linear-tool-group-entry')
  for (const [index, node] of item.nodes.entries()) {
    let entry = entries.get(node.id)
    if (!entry) {
      entry = createToolGroupEntry(node, options, index)
      if (index === 0 && standalone) {
        entry.querySelector('.linear-tool-group-entry-body')!.replaceChildren(standalone)
        entry.open = root.classList.contains('expanded')
        updateToolGroupEntry(entry, node, options, index)
      }
    }
    else updateToolGroupEntry(entry, node, options, index)
    if (entry !== cursor) body.insertBefore(entry, cursor)
    cursor = entry.nextSibling
  }
  return true
}

function updateGroupResources(host: HTMLElement, item: Extract<LinearTaskFlowItem, { kind: 'tool-group' }>, options: LinearTaskFlowRendererOptions): void {
  const existing = host.querySelector<HTMLElement>(':scope > .retrieval-group-results')
  if (item.group !== 'retrieval') { existing?.remove(); return }
  const tools = item.nodes.map(node => ({ tool: options.resolveTool(node), status: node.status }))
  const retrievals = tools.flatMap(({ tool }) => !tool.result?.isError && tool.result?.retrieval || [])
  const fingerprint = JSON.stringify(tools)
  if (existing && retrievalVersions.get(existing) === fingerprint) return
  const results = createRetrievalGroupView(retrievals)
  for (const { tool, status } of tools) {
    if (tool.result?.retrieval && !tool.result.isError) continue
    results.append(createToolResultView(tool.call, tool.result, { renderMarkdown, renderDiffPreview, status }))
  }
  results.classList.add('retrieval-group-results')
  retrievalVersions.set(results, fingerprint)
  if (existing) replaceRetrievalView(existing, results)
  else host.prepend(results)
}

function createRuntimeNode(node: TaskFlowNode): HTMLElement {
  if (node.kind === 'phase' && (node.status === 'running' || node.status === 'paused')) {
    const row = document.createElement('div')
    row.className = 'linear-turn-status'
    row.setAttribute('role', 'status')
    row.textContent = phaseTitle(node)
    return row
  }
  const root = document.createElement('section')
  root.className = `linear-runtime linear-disclosure status-${node.status}`
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'linear-disclosure-row'
  row.append(disclosureChevron())
  const title = document.createElement('strong')
  title.className = 'linear-disclosure-title'
  title.textContent = node.kind === 'approval' ? approvalNodeTitle(node.status) : phaseTitle(node)
  const separator = document.createElement('span')
  separator.className = 'linear-disclosure-separator'
  const summary = document.createElement('span')
  summary.className = 'linear-disclosure-summary'
  summary.textContent = node.detail || node.content
  row.append(title, separator, summary)
  const body = document.createElement('div')
  body.className = 'linear-disclosure-body'
  const bodyInner = document.createElement('div')
  bodyInner.className = 'linear-disclosure-body-inner linear-runtime-body'
  bodyInner.textContent = node.detail || node.content
  body.append(bodyInner)
  root.append(row, body)
  toggleDisclosure(root, false)
  row.addEventListener('click', () => toggleDisclosure(root, !root.classList.contains('expanded')))
  return root
}

export function approvalNodeTitle(status: TaskFlowNode['status']): string {
  if (status === 'completed') return '已确认'
  if (status === 'cancelled' || status === 'interrupted') return '确认已取消'
  if (status === 'failed') return '确认失败'
  return '等待确认'
}

function nodeContent(
  node: TaskFlowNode,
  options: LinearTaskFlowRendererOptions,
  finalDelivery = false,
): HTMLElement | null {
  if (node.kind === 'input') return options.createInput(node)
  if (node.kind === 'answer') return options.createAnswer(node, { finalDelivery })
  if (node.kind === 'thinking') return createReasoningNode(node)
  if (node.kind === 'tool') return createToolNode(node, options.resolveTool(node))
  return createRuntimeNode(node)
}

function updateRunningAnswerElement(element: HTMLElement, node: TaskFlowNode): boolean {
  const row = element.querySelector<HTMLElement>(':scope > .message-row.assistant')
  if (!shouldUpdateLinearAnswerInPlace(node, Boolean(row)) || !row) return false
  let content = row.querySelector<HTMLElement>('.message-content')
  if (!content) {
    content = document.createElement('div')
    content.className = 'message-content'
    row.append(content)
  }
  row.classList.add('streaming')
  const visible = stripTextToolCallMarkup(node.content, { stripIncomplete: true }).trim()
  renderMarkdown(content, visible || '…', true)
  return true
}

function directPreservedChildren(host: HTMLElement): HTMLElement[] {
  return Array.from(host.children).filter((child): child is HTMLElement => (
    child instanceof HTMLElement
    && !child.dataset.linearFlowKey
      && (
      child.classList.contains('workflow-surface-inline')
      || child.classList.contains('request-card')
      || child.classList.contains('conversation-failure')
      || child.classList.contains('optimistic-user-turn')
      || child.classList.contains('history-rewrite-leading-space')
      || child.classList.contains('history-rewrite-viewport-space')
    )
  ))
}

export function createLinearTaskFlowRenderer(
  host: HTMLElement,
  options: LinearTaskFlowRendererOptions,
): LinearTaskFlowRenderer {
  const versions = new WeakMap<HTMLElement, string>()
  let items: TaskRunFlowItem[] = []
  let cursor: ChildNode | null = null
  let renderOptions = options
  const finalAnswerByRun = new Map<string, string>()
  const elements = new KeyedList<TaskRunFlowItem, HTMLElement>({
    key: item => item.key,
    create: item => {
        const element = document.createElement('div')
        element.dataset.linearFlowKey = item.key
        if (item.kind === 'run-status') {
          element.className = 'linear-flow-item linear-flow-run-status'
          element.dataset.runId = item.run.id
          const label = document.createElement('div')
          label.className = 'task-run-status'
          element.append(label)
        } else if (item.kind === 'tool-group') {
          element.className = 'linear-flow-item linear-flow-tool linear-flow-tool-group'
          element.dataset.runId = item.runId || ''
        } else {
          element.className = `linear-flow-item linear-flow-${item.node.kind}`
          element.dataset.taskFlowNodeId = item.node.id
          element.dataset.runId = item.node.runId || ''
        }
        // Only newly inserted items enter. Removing a restoration class or
        // reconciling a completed snapshot must never restart old animations.
        if (!host.classList.contains('restoring')) {
          element.classList.add('linear-flow-entering')
          element.addEventListener('animationend', event => {
            if (event.target === element) element?.classList.remove('linear-flow-entering')
          })
        }
      return element
    },
    update: (element, item, index, force) => {
      const previous = items[index - 1]
      element.dataset.flowGap = item.kind === 'run-status' || previous?.kind === 'run-status'
        ? item.kind === 'node' && item.node.kind === 'input' ? 'turn' : 'content'
        : linearFlowGapBefore(previous, item)
      if (item.kind === 'tool-group') {
        element.classList.toggle('is-running', item.nodes.some(node => node.status === 'running' && !node.settled))
        const version = `${groupedToolStatus(item)}|` + item.nodes.map(node => [
          node.id,
          node.status,
          node.settled ? 1 : 0,
          node.updatedAt,
          node.detail || '',
          options.nodeVersion?.(node) || JSON.stringify(renderOptions.resolveTool(node)),
        ].join(':')).join('|')
        if (force || versions.get(element) !== version) {
          const previousDisclosure = element.querySelector<HTMLElement>('.linear-disclosure')
          const previousExpanded = previousDisclosure?.classList.contains('expanded') === true
          const previousUserExpanded = previousDisclosure?.dataset.userExpanded
          if (
            !(element.firstElementChild instanceof HTMLElement)
            || !updateToolGroupNode(element.firstElementChild, item, renderOptions)
          ) {
            const content = createToolGroupNode(item, renderOptions)
            if (previousUserExpanded !== undefined) content.dataset.userExpanded = previousUserExpanded
            if (previousExpanded) toggleDisclosure(content, true)
            element.replaceChildren(content)
          }
          versions.set(element, version)
        }
      } else if (item.kind === 'node') {
        const run = item.node.runId ? options.resolveRun?.(item.node.runId) : undefined
        const answerTurn = item.node.kind === 'answer' && item.node.turnId
          ? options.resolveTurn?.(item.node.turnId)
          : undefined
        const finalDelivery = isFinalDeliveryAnswer({
          nodeKind: item.node.kind,
          nodeId: item.node.id,
          runId: item.node.runId,
          finalAnswerId: item.node.runId ? finalAnswerByRun.get(item.node.runId) : undefined,
          runStatus: run?.status,
          hasToolCalls: Boolean(answerTurn?.toolCalls?.length),
          interrupted: item.node.status === 'interrupted' || answerTurn?.metadata?.interrupted === true,
        })
        element.dataset.finalDelivery = finalDelivery ? 'true' : 'false'
        element.classList.toggle('is-running', item.node.status === 'running' && !item.node.settled)
        const version = [
          item.node.status,
          item.node.settled ? 1 : 0,
          item.node.updatedAt,
          item.node.content,
          item.node.detail || '',
          finalDelivery ? 1 : 0,
          options.nodeVersion?.(item.node) || (item.node.kind === 'tool' ? JSON.stringify(renderOptions.resolveTool(item.node)) : ''),
        ].join(':')
        if (force || versions.get(element) !== version) {
          const previousDisclosure = element.querySelector<HTMLElement>('.linear-disclosure')
          const previousExpanded = previousDisclosure?.classList.contains('expanded') === true
          const previousUserExpanded = previousDisclosure?.dataset.userExpanded
          if (item.node.kind === 'thinking' && previousDisclosure) {
            updateReasoningNode(previousDisclosure, item.node)
          } else if (
            item.node.kind === 'phase'
            && (item.node.status === 'running' || item.node.status === 'paused')
            && element.firstElementChild?.classList.contains('linear-turn-status')
          ) {
            // Keep the waiting row and its animation in place across internal phase updates.
            element.firstElementChild.textContent = phaseStatusLabel(item.node, run)
          } else if (
            item.node.kind === 'tool'
            && element.firstElementChild instanceof HTMLElement
            && updateToolNode(element.firstElementChild, item.node, renderOptions.resolveTool(item.node))
          ) {
          } else if (!updateRunningAnswerElement(element, item.node) && !(
            item.node.kind === 'answer'
            && element.firstElementChild instanceof HTMLElement
            && options.updateAnswer?.(element.firstElementChild, item.node, { finalDelivery })
          )) {
            const content = nodeContent(item.node, renderOptions, finalDelivery)
            element.hidden = !content
            if (content) {
              if (previousUserExpanded !== undefined) content.dataset.userExpanded = previousUserExpanded
              if (previousExpanded && content.classList.contains('linear-disclosure')) toggleDisclosure(content, true)
              element.replaceChildren(content)
            } else {
              element.replaceChildren()
            }
          }
          versions.set(element, version)
        }
      }
    },
    place: element => {
      if (element !== cursor) host.insertBefore(element, cursor)
      cursor = element.nextSibling
    },
    remove: element => {
      disposeReasoningNode(element.querySelector<HTMLElement>('.linear-reasoning'))
      element.remove()
    },
  })
  let statusItems: Extract<TaskRunFlowItem, { kind: 'run-status' }>[] = []
  let phaseItems: Extract<TaskRunFlowItem, { kind: 'node' }>[] = []
  let statusTimer: number | undefined
  const stopStatusTimer = () => {
    if (statusTimer !== undefined) window.clearInterval(statusTimer)
    statusTimer = undefined
  }
  const updateStatusLabels = () => {
    for (const item of statusItems) {
      const label = elements.get(item.key)?.firstElementChild
      const text = taskRunStatusLabel(item.run, item.segmentIndex)
      if (label && label.textContent !== text) label.textContent = text
    }
    for (const item of phaseItems) {
      const label = elements.get(item.key)?.querySelector('.linear-turn-status')
      if (!label) continue
      const run = item.node.runId ? options.resolveRun?.(item.node.runId) : undefined
      const text = phaseStatusLabel(item.node, run)
      if (label.textContent !== text) label.textContent = text
    }
  }

  const render = (state: TaskFlowProjectionState, force = false): void => {
    host.classList.add('linear-task-flow')
    const resolveRun = options.resolveRun || (() => undefined)
    const tools = new Map<string, LinearTaskFlowTool>()
    renderOptions = {
      ...options,
      resolveTool: node => {
        const cached = tools.get(node.id)
        if (cached) return cached
        const tool = options.resolveTool(node)
        tools.set(node.id, tool)
        return tool
      },
    }
    state = {
      ...state,
      nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => {
        if (node.kind !== 'tool') return [id, node]
        const result = renderOptions.resolveTool(node).result
        const status = toolActivityStatus(node, result, node.runId ? resolveRun(node.runId)?.status : undefined)
        const settled = !['running', 'waiting', 'paused'].includes(status)
        return [id, status === node.status && settled === node.settled ? node : { ...node, status, settled }]
      })),
    }
    items = withTaskRunStatus(linearTaskFlowItems(state, node => (
      `${node.runId || ''}:${taskRunSegmentIndex(node.runId ? resolveRun(node.runId) : undefined, node.createdAt)}`
    )), resolveRun)
    statusItems = items.filter((item): item is Extract<TaskRunFlowItem, { kind: 'run-status' }> => item.kind === 'run-status')
    phaseItems = items.filter((item): item is Extract<TaskRunFlowItem, { kind: 'node' }> => item.kind === 'node' && item.node.kind === 'phase')
    finalAnswerByRun.clear()
    for (const item of items) {
      if (item.kind === 'node' && item.node.kind === 'answer' && item.node.runId) {
        finalAnswerByRun.set(item.node.runId, item.node.id)
      }
    }
    const preserved = directPreservedChildren(host)
    const preservedSet = new Set(preserved)
    for (const child of Array.from(host.children)) {
      if (!(child instanceof HTMLElement) || child.dataset.linearFlowKey || preservedSet.has(child)) continue
      child.remove()
    }
    const leading = preserved.filter(element => element.classList.contains('history-rewrite-leading-space'))
    cursor = leading.at(-1)?.nextSibling || host.firstChild
    elements.render(items, force)
    updateStatusLabels()
    const ticking = statusItems.some(item => ['pending', 'running', 'waiting'].includes(item.run.status))
      || phaseItems.some(item => item.node.status === 'running' && !item.node.settled && phaseTitle(item.node) === '正在请求中')
    if (!ticking) stopStatusTimer()
    else if (statusTimer === undefined) {
      statusTimer = window.setInterval(() => {
        if (!host.isConnected) stopStatusTimer()
        else updateStatusLabels()
      }, 1_000)
    }
  }

  return {
    render,
    clear: () => {
      stopStatusTimer()
      statusItems = []
      phaseItems = []
      elements.clear()
      host.classList.remove('linear-task-flow')
    },
  }
}

export function createFallbackLinearMessage(node: TaskFlowNode, role: 'user' | 'assistant'): HTMLElement {
  const row = document.createElement('article')
  row.className = `message-row ${role}${node.status === 'running' ? ' streaming' : ''}`
  if (node.turnId) row.dataset.turnId = node.turnId
  const content = document.createElement('div')
  content.className = 'message-content'
  if (role === 'assistant') renderMarkdown(content, node.content || '…', node.status === 'running')
  else content.textContent = node.content
  row.append(content)
  return row
}
