import type { WorkbenchSnapshot, WorkStep, WorkStepControlAction } from '@turboflux/workbench'
import { contextUsageTokenCount } from '../contextUsageRecovery'
import {
  activeSiblingCount,
  orderedWorkSteps,
  presentWorkRun,
  selectWorkRun,
  workRunHistory,
  workRunStatusLabel,
  workStepDependencies,
} from './workExecutionPresentation'
import { describeRuntimeTask, runtimeTaskStatusLabel } from './runtimeTaskPresentation'
import { presentDesktopError } from './conversationRendering'

export interface WorkbenchPanelActions {
  compactContext(): Promise<void>
  refreshGit(): Promise<void>
  acknowledgeNotification(id: string): Promise<void>
  controlWorkStep(id: string, action: WorkStepControlAction): Promise<void>
  pauseRun(): Promise<void>
  resumeRun(): Promise<void>
  stopRun(): Promise<void>
  selectWorkRun(id: string): void
  stageGit(paths: string[]): Promise<void>
  unstageGit(paths: string[]): Promise<void>
  commitGit(message: string): Promise<void>
  createGitBranch(name: string): Promise<void>
  switchGitBranch(name: string): Promise<void>
  restoreGit(paths: string[]): Promise<void>
  pushGit(remote?: string, branch?: string, setUpstream?: boolean): Promise<void>
  readGitDiff(path: string, scope: 'working' | 'staged' | 'all'): Promise<string>
  confirm(title: string, message: string, danger?: boolean): Promise<boolean>
  prompt(title: string, message: string, initialValue?: string): Promise<string | null>
  openSettings(section: 'mcp' | 'workpacks'): void
}

const expandedWorkStepIds = new Set<string>()
const selectedGitPaths = new Set<string>()
const gitDiffCache = new Map<string, string>()
let expandedGitPath: string | null = null
const gitBranchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="5" r="2"/><circle cx="17" cy="19" r="2"/><path d="M7 7v6a6 6 0 0 0 6 6h2M17 17V7M14 10l3-3 3 3"/></svg>'
const rightChevronIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
const gitAheadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M7 10l5-5 5 5"/></svg>'
const gitBehindIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M7 14l5 5 5-5"/></svg>'

function gitFileStateIcon(state: 'conflicted' | 'untracked' | 'mixed' | 'staged' | 'modified'): string {
  const icons: Record<typeof state, string> = {
    conflicted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 9 16H3z"/><path d="M12 9v4M12 16h.01"/></svg>',
    untracked: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/></svg>',
    mixed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 17.8 9.9-9.9 3.2 3.2-9.9 9.9H5z"/><path d="m13.8 8.9 1.7-1.7a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8l-1.7 1.7"/></svg>',
    staged: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    modified: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2"/></svg>',
  }
  return icons[state]
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function section(title: string, count?: number): HTMLElement {
  const wrapper = document.createElement('section')
  wrapper.className = 'workbench-panel-section'
  const header = document.createElement('header')
  const label = document.createElement('strong')
  label.textContent = title
  header.append(label)
  if (count !== undefined) {
    const badge = document.createElement('span')
    badge.textContent = String(count)
    header.append(badge)
  }
  wrapper.append(header)
  return wrapper
}

function empty(text: string): HTMLElement {
  const note = document.createElement('p')
  note.className = 'panel-empty-note'
  note.textContent = text
  return note
}

function queuedInputs(snapshot: WorkbenchSnapshot) {
  const projection = snapshot.work.projection
  return projection.order
    .map(id => projection.nodes[id])
    .filter(node => node?.kind === 'input' && node.status === 'waiting' && !node.settled)
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '待处理',
    in_progress: '进行中',
    completed: '已完成',
    succeeded: '已完成',
    failed: '失败',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    interrupted: '已中断',
    orphaned: '需恢复',
    exited: '已退出',
    error: '错误',
    ready: '可开始',
    waiting: '等待中',
    blocked: '被阻塞',
    retrying: '恢复中',
    partial: '部分完成',
    cancelled: '已取消',
    skipped: '已跳过',
    paused: '已暂停',
    unavailable: '不可用',
  }
  return labels[status] || status
}

function workStepControls(step: WorkStep, actions: WorkbenchPanelActions): HTMLElement | null {
  const controls = document.createElement('span')
  controls.className = 'work-step-controls'
  const options: Array<{ action: WorkStepControlAction; label: string }> = []
  if (step.status === 'failed' || step.status === 'cancelled') options.push({ action: 'retry', label: '重试' })
  if (step.status === 'pending' || step.status === 'ready' || step.status === 'blocked') options.push({ action: 'skip', label: '跳过' })
  if (step.status === 'running' || step.status === 'waiting' || step.status === 'retrying') options.push({ action: 'cancel', label: '取消' })
  for (const option of options) {
    const button = document.createElement('button')
    button.textContent = option.label
    button.addEventListener('click', event => {
      event.stopPropagation()
      button.disabled = true
      void actions.controlWorkStep(step.id, option.action).finally(() => { button.disabled = false })
    })
    controls.append(button)
  }
  return controls.childElementCount > 0 ? controls : null
}

function renderRuntimeProcesses(snapshot: WorkbenchSnapshot): HTMLElement | null {
  const processes = snapshot.activity.runtimeTasks
    .filter(task => task.kind === 'shell' || task.kind === 'terminal')
    .map(task => ({ task, view: describeRuntimeTask(task) }))
    .filter(item => item.view !== null)
    .sort((left, right) => right.task.updatedAt - left.task.updatedAt)
  if (processes.length === 0) return null

  const list = section('终端进程', processes.length)
  for (const { task, view } of processes) {
    if (!view) continue
    const row = document.createElement('div')
    row.className = `runtime-activity-row status-${task.status}`
    const marker = document.createElement('i')
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = view.title
    const detail = document.createElement('small')
    detail.textContent = view.detail
    const status = document.createElement('b')
    status.textContent = runtimeTaskStatusLabel(task.status)
    copy.append(title, detail)
    row.append(marker, copy, status)
    list.append(row)
  }
  return list
}

function renderExecutionStep(
  step: WorkStep,
  run: WorkbenchSnapshot['activity']['execution']['runs'][number],
  actions: WorkbenchPanelActions,
  depth = 0,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = `work-step status-${step.status}`
  wrapper.style.setProperty('--work-step-depth', String(depth))
  const row = document.createElement('button')
  row.className = 'work-step-row'
  const marker = document.createElement('i')
  const copy = document.createElement('span')
  const title = document.createElement('strong')
  title.textContent = step.title
  const detail = document.createElement('small')
  const dependencies = workStepDependencies(step, run)
  const parallel = activeSiblingCount(step, run) > 1
  detail.textContent = [
    statusLabel(step.status),
    step.progress !== null ? `${Math.round(step.progress)}%` : '',
    parallel ? '并行' : '',
    dependencies.unresolved.length > 0 ? `等待 ${dependencies.unresolved.map(item => item.title).join('、')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  copy.append(title, detail)
  const disclosure = document.createElement('b')
  const hasDetails = Boolean(step.description || step.outcome || step.error || step.childIds.length || dependencies.all.length)
  disclosure.innerHTML = hasDetails ? (expandedWorkStepIds.has(step.id) ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>' : rightChevronIcon) : ''
  row.append(marker, copy, disclosure)
  row.addEventListener('click', () => {
    if (!hasDetails) return
    if (expandedWorkStepIds.has(step.id)) expandedWorkStepIds.delete(step.id)
    else expandedWorkStepIds.add(step.id)
    const host = wrapper.parentElement
    if (host) host.replaceChild(renderExecutionStep(step, run, actions, depth), wrapper)
  })
  wrapper.append(row)
  const controls = workStepControls(step, actions)
  if (controls) wrapper.append(controls)
  if (expandedWorkStepIds.has(step.id)) {
    const detailHost = document.createElement('div')
    detailHost.className = 'work-step-detail'
    if (step.description) {
      const description = document.createElement('p')
      description.textContent = step.description
      detailHost.append(description)
    }
    if (step.outcome || step.error) {
      const outcome = document.createElement('p')
      outcome.className = step.error ? 'work-step-error' : 'work-step-outcome'
      outcome.textContent = step.error || step.outcome || ''
      detailHost.append(outcome)
    }
    if (dependencies.all.length > 0) {
      const dependencyDetail = document.createElement('p')
      dependencyDetail.className = 'work-step-dependencies'
      dependencyDetail.textContent = `前置步骤：${dependencies.all.map(item => `${item.title}（${statusLabel(item.status)}）`).join(' · ')}`
      detailHost.append(dependencyDetail)
    }
    for (const child of orderedWorkSteps(run, step.childIds)) detailHost.append(renderExecutionStep(child, run, actions, depth + 1))
    wrapper.append(detailHost)
  }
  return wrapper
}

export function renderActivityPanel(
  container: HTMLElement,
  snapshot: WorkbenchSnapshot,
  actions: WorkbenchPanelActions,
  selectedRunId?: string | null,
): void {
  container.replaceChildren()
  const execution = snapshot.activity.execution
  const run = selectWorkRun(execution, selectedRunId)
  const runtimeProcesses = renderRuntimeProcesses(snapshot)

  if (!run || run.presentation !== 'work') {
    if (runtimeProcesses) {
      container.append(runtimeProcesses)
      return
    }
    const blank = document.createElement('div')
    blank.className = 'work-execution-empty'
    blank.innerHTML = '<strong>还没有工作过程</strong><p>复杂工作开始后，步骤、验证和结果会在这里保持同步。</p>'
    container.append(blank)
    return
  }

  const history = workRunHistory(execution)
  if (history.length > 1) {
    const navigation = document.createElement('label')
    navigation.className = 'work-run-history'
    const copy = document.createElement('span')
    const selectedIndex = history.findIndex(item => item.id === run.id)
    copy.textContent = `工作记录 · 第 ${selectedIndex + 1}/${history.length} 轮`
    const selector = document.createElement('select')
    selector.setAttribute('aria-label', '选择历史工作轮次')
    for (const [index, item] of history.entries()) {
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = `第 ${index + 1} 轮 · ${workRunStatusLabel(item.status)}`
      option.selected = item.id === run.id
      selector.append(option)
    }
    selector.addEventListener('change', () => actions.selectWorkRun(selector.value))
    navigation.append(copy, selector)
    container.append(navigation)
  }

  const header = document.createElement('header')
  header.className = `work-run-header status-${run.status}`
  const presentation = presentWorkRun(run)
  const copy = document.createElement('span')
  const title = document.createElement('strong')
  title.textContent = presentation.statusLabel
  const meta = document.createElement('small')
  meta.textContent = [
    !presentation.terminal && presentation.currentStep ? presentation.currentStep.title : '',
    presentation.detail,
    presentation.duration,
  ]
    .filter(Boolean)
    .join(' · ')
  copy.append(title, meta)
  const runControls = document.createElement('span')
  runControls.className = 'work-run-controls'
  const isCurrentRun = run.id === execution.currentRunId
  if (isCurrentRun && (run.status === 'running' || run.status === 'waiting')) {
    const pause = document.createElement('button')
    pause.textContent = '暂停'
    pause.addEventListener('click', () => void actions.pauseRun())
    runControls.append(pause)
  } else if (isCurrentRun && run.status === 'paused') {
    const resume = document.createElement('button')
    resume.textContent = '继续'
    resume.addEventListener('click', () => void actions.resumeRun())
    runControls.append(resume)
  }
  if (isCurrentRun && ['running', 'waiting', 'paused'].includes(run.status)) {
    const stop = document.createElement('button')
    stop.textContent = '停止'
    stop.className = 'danger'
    stop.addEventListener('click', () => void actions.stopRun())
    runControls.append(stop)
  }
  header.append(copy, runControls)
  container.append(header)

  const rootSteps = orderedWorkSteps(run, run.rootStepIds)
  if (rootSteps.length > 0) {
    const steps = section('步骤')
    steps.classList.add('work-execution-steps')
    for (const step of rootSteps) steps.append(renderExecutionStep(step, run, actions))
    container.append(steps)
  }

  if (runtimeProcesses) container.append(runtimeProcesses)

  const queued = queuedInputs(snapshot)
  if (queued.length > 0) {
    const queue = section('接下来', queued.length)
    for (const input of queued) {
      const row = document.createElement('div')
      row.className = 'work-queue-row'
      row.innerHTML = '<strong></strong><small>已排队</small>'
      row.querySelector('strong')!.textContent = input.content.slice(0, 120) || '附件工作'
      queue.append(row)
    }
    container.append(queue)
  }

  if (run.error || (run.completedAt && run.outcome)) {
    const result = document.createElement('section')
    result.className = `work-run-result ${run.error ? 'failed' : ''}`
    const title = document.createElement('strong')
    title.textContent = run.error ? '需要你处理' : '结果'
    const text = document.createElement('p')
    text.textContent = run.error || run.outcome || ''
    result.append(title, text)
    container.append(result)
  }
}

export function renderContextPanel(
  container: HTMLElement,
  snapshot: WorkbenchSnapshot,
  actions: WorkbenchPanelActions,
): void {
  container.replaceChildren()
  const usage = snapshot.context.usage
  const used = contextUsageTokenCount(usage)
  const contextWindow = Math.max(1, snapshot.context.contextWindow || 1)
  const percent = Math.max(0, Math.min(100, (used / contextWindow) * 100))
  const meter = document.createElement('section')
  meter.className = 'context-meter-card'
  meter.innerHTML = `<div><span>上下文</span><strong>${formatCount(used)} / ${formatCount(contextWindow)}</strong></div><div class="context-meter"><i style="width:${percent}%"></i></div><footer><span>${Math.round(percent)}% 已使用</span><button id="compact-context">压缩</button></footer>`
  const compactButton = meter.querySelector<HTMLButtonElement>('#compact-context')!
  compactButton.disabled = snapshot.runtime.status !== 'ready' || snapshot.conversation.turns.length === 0
  compactButton.addEventListener('click', () => void actions.compactContext())
  container.append(meter)

  const compaction = snapshot.context.compaction
  if (compaction && !['completed', 'interrupted'].includes(compaction.phase)) {
    const card = document.createElement('section')
    card.className = `compaction-card ${compaction.phase}`
    card.innerHTML = `<div><span class="compaction-spinner"></span><strong>正在整理上下文</strong><b>${Math.round(compaction.progress || 0)}%</b></div><p></p><div class="compaction-progress"><i style="width:${Math.max(4, compaction.progress || 0)}%"></i></div>`
    card.querySelector('p')!.textContent = compaction.error || compaction.detail || statusLabel(compaction.phase)
    container.append(card)
  }

  const metrics = document.createElement('div')
  metrics.className = 'context-metrics'
  metrics.innerHTML = `<div><span>上下文输入</span><strong>${formatCount(usage.input || 0)}</strong></div><div><span>新增输出</span><strong>${formatCount(usage.output || 0)}</strong></div><div><span>缓存命中</span><strong>${formatCount(usage.cached || 0)}</strong></div>`
  container.append(metrics)

  const segments = section('上下文段', snapshot.context.segments.length)
  if (snapshot.context.segments.length === 0) segments.append(empty('压缩后形成的连续工作摘要会保存在这里。'))
  for (const segment of [...snapshot.context.segments].reverse()) {
    const item = document.createElement('article')
    item.className = `context-segment ${segment.isValid ? '' : 'invalid'}`
    const header = document.createElement('div')
    header.innerHTML = `<strong>${segment.kind === 'manual' ? '手动压缩' : segment.kind === 'compact' ? '自动压缩' : '工作摘要'}</strong><span>${formatCount(segment.originalCharCount)} 字符</span>`
    const summary = document.createElement('p')
    summary.textContent = segment.summary
    item.append(header, summary)
    segments.append(item)
  }
  container.append(segments)

  const abilities = section('能力')
  const skill = snapshot.skills.find(item => item.active)
  const skillRow = document.createElement('button')
  skillRow.className = 'panel-link-row'
  const skillCopy = document.createElement('span')
  const skillName = document.createElement('strong')
  skillName.textContent = skill ? skill.name : '插件'
  const skillDetail = document.createElement('small')
  skillDetail.textContent = skill ? '当前优先使用' : '浏览和管理插件'
  skillCopy.append(skillName, skillDetail)
  const skillArrow = document.createElement('b')
  skillArrow.innerHTML = rightChevronIcon
  skillRow.append(skillCopy, skillArrow)
  skillRow.addEventListener('click', () => actions.openSettings('workpacks'))
  const mcpRow = document.createElement('button')
  mcpRow.className = 'panel-link-row'
  mcpRow.innerHTML = `<span><strong>MCP 连接</strong><small>管理外部工具和服务</small></span><b>${rightChevronIcon}</b>`
  mcpRow.addEventListener('click', () => actions.openSettings('mcp'))
  abilities.append(skillRow, mcpRow)
  container.append(abilities)
}

export function renderGitPanel(
  container: HTMLElement,
  snapshot: WorkbenchSnapshot,
  actions: WorkbenchPanelActions,
): void {
  container.replaceChildren()
  const header = document.createElement('section')
  header.className = `git-summary-card phase-${snapshot.git.phase}`
  const git = snapshot.git.snapshot
  header.innerHTML = `<div><span class="git-branch-symbol">${gitBranchIcon}</span><span><strong></strong><small></small></span><button id="refresh-git">刷新</button></div>`
  header.querySelector('strong')!.textContent = git?.branch || (snapshot.git.enabled ? '正在读取仓库' : 'Git 已关闭')
  header.querySelector('small')!.textContent = snapshot.git.error || (git ? `${git.head?.slice(0, 8) || '无提交'}${git.upstream ? ` · ${git.upstream}` : ''}` : statusLabel(snapshot.git.phase))
  header.querySelector<HTMLButtonElement>('#refresh-git')!.addEventListener('click', () => void actions.refreshGit())
  container.append(header)
  if (!git) {
    container.append(empty(snapshot.git.enabled ? '当前工作区不是 Git 仓库，或状态仍在加载。' : '可在设置中开启 Git 集成。'))
    return
  }

  const metrics = document.createElement('div')
  metrics.className = 'git-metrics'
  metrics.innerHTML = `<div><span>已暂存</span><strong>${git.stagedCount}</strong></div><div><span>未暂存</span><strong>${git.unstagedCount}</strong></div><div><span>未跟踪</span><strong>${git.untrackedCount}</strong></div><div class="${git.conflictedCount ? 'danger' : ''}"><span>冲突</span><strong>${git.conflictedCount}</strong></div>`
  container.append(metrics)
  if (git.ahead || git.behind) {
    const sync = document.createElement('div')
    sync.className = 'git-sync-row'
    sync.innerHTML = `<span class="git-sync-item">${gitAheadIcon}<span>领先 ${git.ahead}</span></span><span class="git-sync-item">${gitBehindIcon}<span>落后 ${git.behind}</span></span>`
    container.append(sync)
  }

  const branch = document.createElement('section')
  branch.className = 'git-control-card'
  const branchSelect = document.createElement('select')
  branchSelect.setAttribute('aria-label', '切换分支')
  for (const name of git.branches?.length ? git.branches : [git.branch]) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    option.selected = name === git.branch
    branchSelect.append(option)
  }
  branchSelect.disabled = snapshot.git.phase === 'syncing' || git.detached
  branchSelect.addEventListener('change', async () => {
    const name = branchSelect.value
    if (name === git.branch) return
    const confirmed = git.clean || await actions.confirm('切换分支？', `将从 ${git.branch} 切换到 ${name}。当前有未提交变更，Git 会在不安全时阻止切换。`)
    if (!confirmed) {
      branchSelect.value = git.branch
      return
    }
    await actions.switchGitBranch(name)
  })
  const createBranch = document.createElement('button')
  createBranch.textContent = '新建分支'
  createBranch.disabled = snapshot.git.phase === 'syncing'
  createBranch.addEventListener('click', async () => {
    const name = await actions.prompt('新建分支', `从 ${git.branch} 创建并切换到新分支。`)
    if (name) await actions.createGitBranch(name)
  })
  const push = document.createElement('button')
  push.textContent = git.ahead > 0 ? `推送 ${git.ahead}` : '推送'
  push.disabled = snapshot.git.phase === 'syncing' || git.detached || (!git.upstream && !git.branch)
  push.addEventListener('click', async () => {
    const remote = git.upstream?.split('/')[0] || 'origin'
    const confirmed = await actions.confirm('推送到远端？', `将 ${git.branch} 推送到 ${git.upstream || `${remote}/${git.branch}`}。不会使用强制推送。`)
    if (confirmed) await actions.pushGit(remote, git.branch, !git.upstream)
  })
  branch.append(branchSelect, createBranch, push)
  container.append(branch)

  for (const path of [...selectedGitPaths]) {
    if (!git.files.some(file => file.path === path)) selectedGitPaths.delete(path)
  }
  const toolbar = document.createElement('div')
  toolbar.className = 'git-selection-toolbar'
  const selection = document.createElement('span')
  selection.textContent = selectedGitPaths.size ? `已选 ${selectedGitPaths.size} 项` : '选择文件后操作'
  const stage = document.createElement('button')
  stage.textContent = '暂存'
  stage.disabled = !git.files.some(file => selectedGitPaths.has(file.path) && (file.unstaged || file.untracked)) || snapshot.git.phase === 'syncing'
  stage.addEventListener('click', () => void actions.stageGit([...selectedGitPaths]))
  const unstage = document.createElement('button')
  unstage.textContent = '取消暂存'
  unstage.disabled = !git.files.some(file => selectedGitPaths.has(file.path) && file.staged) || snapshot.git.phase === 'syncing'
  unstage.addEventListener('click', () => void actions.unstageGit([...selectedGitPaths]))
  const restore = document.createElement('button')
  restore.className = 'danger'
  restore.textContent = '恢复'
  restore.disabled = !git.files.some(file => selectedGitPaths.has(file.path) && file.unstaged && !file.untracked) || snapshot.git.phase === 'syncing'
  restore.addEventListener('click', async () => {
    const paths = git.files.filter(file => selectedGitPaths.has(file.path) && file.unstaged && !file.untracked).map(file => file.path)
    const confirmed = await actions.confirm('恢复所选文件？', `将丢弃这些文件的未暂存修改：\n${paths.join('\n')}`, true)
    if (confirmed) await actions.restoreGit(paths)
  })
  toolbar.append(selection, stage, unstage, restore)
  container.append(toolbar)

  const files = section('变更文件', git.files.length)
  if (git.files.length === 0) files.append(empty('工作区干净，没有未提交变更。'))
  for (const file of git.files.slice(0, 80)) {
    const item = document.createElement('div')
    item.className = `git-file-item${expandedGitPath === file.path ? ' expanded' : ''}`
    const row = document.createElement('div')
    row.className = `git-file-row${file.conflicted ? ' conflicted' : ''}`
    const stateKey = file.conflicted ? 'conflicted' : file.untracked ? 'untracked' : file.staged && file.unstaged ? 'mixed' : file.staged ? 'staged' : 'modified'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selectedGitPaths.has(file.path)
    checkbox.setAttribute('aria-label', `选择 ${file.path}`)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedGitPaths.add(file.path)
      else selectedGitPaths.delete(file.path)
      renderGitPanel(container, snapshot, actions)
    })
    const state = document.createElement('b')
    state.className = `git-file-state ${stateKey}`
    state.innerHTML = gitFileStateIcon(stateKey)
    const copy = document.createElement('button')
    copy.className = 'git-file-copy'
    copy.innerHTML = `<span><strong></strong><small></small></span><i>${rightChevronIcon}</i>`
    copy.querySelector('strong')!.textContent = file.path.split(/[\\/]/).at(-1) || file.path
    copy.querySelector('small')!.textContent = file.path
    copy.addEventListener('click', () => {
      expandedGitPath = expandedGitPath === file.path ? null : file.path
      renderGitPanel(container, snapshot, actions)
    })
    row.append(checkbox, state, copy)
    item.append(row)
    if (expandedGitPath === file.path) {
      const diff = document.createElement('pre')
      diff.className = 'git-inline-diff'
      const scope = file.staged && !file.unstaged ? 'staged' : file.staged && file.unstaged ? 'all' : 'working'
      const key = `${scope}:${file.path}`
      const cached = gitDiffCache.get(key)
      diff.textContent = cached || '正在读取差异…'
      item.append(diff)
      if (!cached) {
        void actions.readGitDiff(file.path, scope).then(output => {
          gitDiffCache.set(key, output)
          if (expandedGitPath === file.path && diff.isConnected) diff.textContent = output
        }).catch(error => {
          if (diff.isConnected) diff.textContent = presentDesktopError(error)
        })
      }
    }
    files.append(item)
  }
  container.append(files)

  const commit = document.createElement('section')
  commit.className = 'git-commit-card'
  const message = document.createElement('textarea')
  message.rows = 2
  message.maxLength = 4_000
  message.placeholder = git.stagedCount > 0 ? '说明这次改动' : '先暂存要提交的文件'
  message.disabled = git.stagedCount === 0 || snapshot.git.phase === 'syncing'
  const commitButton = document.createElement('button')
  commitButton.textContent = `提交 ${git.stagedCount || ''}`.trim()
  commitButton.disabled = git.stagedCount === 0 || snapshot.git.phase === 'syncing'
  commitButton.addEventListener('click', async () => {
    const value = message.value.trim()
    if (!value) {
      message.focus()
      return
    }
    const paths = git.files.filter(file => file.staged).map(file => file.path)
    const confirmed = await actions.confirm('创建提交？', `将提交以下已暂存文件：\n${paths.join('\n')}`)
    if (confirmed) await actions.commitGit(value)
  })
  commit.append(message, commitButton)
  container.append(commit)

  if (git.recentCommits.length > 0) {
    const recent = section('最近提交', git.recentCommits.length)
    for (const entry of git.recentCommits) {
      const row = document.createElement('div')
      row.className = 'git-commit-row'
      row.innerHTML = '<code></code><span><strong></strong><small></small></span>'
      row.querySelector('code')!.textContent = entry.shortHash
      row.querySelector('strong')!.textContent = entry.subject
      row.querySelector('small')!.textContent = `${entry.author} · ${new Date(entry.authoredAt).toLocaleDateString()}`
      recent.append(row)
    }
    container.append(recent)
  }
}
