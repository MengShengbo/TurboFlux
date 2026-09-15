import type { WorkRun, WorkStep } from '@turboflux/agent-core/workbench'
import { presentWorkStages } from './workExecutionPresentation'

export interface WorkPlanSummary {
  completed: number
  total: number
  activeTitle: string
}

const COMPLETED_STATUSES = new Set<WorkStep['status']>(['completed', 'skipped'])
const ACTIVE_STATUSES = new Set<WorkStep['status']>(['running', 'retrying', 'waiting'])

export function workPlanSummary(run: WorkRun): WorkPlanSummary {
  const steps = Object.values(run.steps)
  const completed = steps.filter(step => COMPLETED_STATUSES.has(step.status)).length
  const active = steps
    .filter(step => ACTIVE_STATUSES.has(step.status))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.order - right.order)[0]
  const pending = steps
    .filter(step => !COMPLETED_STATUSES.has(step.status))
    .sort((left, right) => left.order - right.order)[0]
  return { completed, total: steps.length, activeTitle: active?.title || pending?.title || '' }
}

export function workPlanVersion(run: WorkRun): string {
  return [
    run.updatedAt,
    run.status,
    ...Object.values(run.steps)
      .sort((left, right) => left.order - right.order)
      .map(step => `${step.id}:${step.status}:${step.updatedAt}:${step.title}`),
  ].join('|')
}

function checklistIcon(state: ReturnType<typeof presentWorkStages>[number]['state']): HTMLElement {
  const icon = document.createElement('span')
  icon.className = `work-plan-state state-${state}`
  icon.setAttribute('aria-hidden', 'true')
  if (state === 'completed') {
    icon.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="m5.1 8.1 1.85 1.85 4-4.15"/></svg>'
  } else if (state === 'running') {
    icon.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/></svg>'
  } else if (state === 'failed' || state === 'partial' || state === 'cancelled') {
    icon.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="m5.7 5.7 4.6 4.6m0-4.6-4.6 4.6"/></svg>'
  } else {
    icon.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" stroke-dasharray="2.1 2.1"/></svg>'
  }
  return icon
}

function createChecklist(run: WorkRun): HTMLElement {
  const list = document.createElement('ul')
  list.className = 'work-plan-list'
  for (const stage of presentWorkStages(run)) {
    const item = document.createElement('li')
    item.className = `work-plan-item state-${stage.state}`
    item.dataset.stepId = stage.id
    item.dataset.status = stage.state
    item.style.setProperty('--work-plan-depth', String(stage.depth))
    const content = document.createElement('span')
    content.className = 'work-plan-item-content'
    content.textContent = stage.title
    content.title = stage.title
    item.append(checklistIcon(stage.state), content)
    list.append(item)
  }
  return list
}

function planChevron(): HTMLElement {
  const chevron = document.createElement('span')
  chevron.className = 'work-plan-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>'
  return chevron
}

function progressLabel(run: WorkRun, summary: WorkPlanSummary): string {
  const active = Object.values(run.steps).filter(step => ACTIVE_STATUSES.has(step.status)).length
  const pending = Math.max(0, summary.total - summary.completed - active)
  return [
    summary.completed ? `${summary.completed} 已完成` : '',
    active ? `${active} 进行中` : '',
    pending ? `${pending} 待处理` : '',
  ].filter(Boolean).join(' · ') || `${summary.completed}/${summary.total} 已完成`
}

function setDisclosureExpanded(root: HTMLElement, expanded: boolean): void {
  root.classList.toggle('expanded', expanded)
  root.querySelector<HTMLElement>('.work-plan-header')?.setAttribute('aria-expanded', String(expanded))
  root.querySelector<HTMLElement>('.work-plan-body')?.setAttribute('aria-hidden', String(!expanded))
}

export function createWorkPlanDisclosure(
  run: WorkRun,
  variant: 'inline' | 'dock',
  options: { expanded?: boolean } = {},
): HTMLElement {
  const summary = workPlanSummary(run)
  const root = document.createElement('section')
  root.className = variant === 'inline' ? 'work-plan work-plan-inline' : 'work-plan work-plan-projected'
  root.dataset.status = run.status
  root.setAttribute('aria-label', variant === 'dock' ? '当前任务进度' : '任务计划变更')
  const header = document.createElement('button')
  header.type = 'button'
  header.className = 'work-plan-header'
  const lead = document.createElement('span')
  lead.className = 'work-plan-lead'
  lead.setAttribute('aria-hidden', 'true')
  lead.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6.5 4h6M6.5 8h6M6.5 12h6"/><circle cx="3.2" cy="4" r=".7"/><circle cx="3.2" cy="8" r=".7"/><circle cx="3.2" cy="12" r=".7"/></svg>'
  const title = document.createElement('strong')
  title.textContent = variant === 'inline' ? '更新任务计划' : '当前任务'
  const progress = document.createElement('span')
  progress.className = 'work-plan-progress'
  progress.textContent = variant === 'inline'
    ? `${summary.completed}/${summary.total} 已完成${summary.activeTitle ? ` · ${summary.activeTitle}` : ''}`
    : summary.activeTitle
      ? `${summary.activeTitle} · ${summary.completed}/${summary.total}`
      : progressLabel(run, summary)
  header.append(lead, title, progress, planChevron())
  const body = document.createElement('div')
  body.className = 'work-plan-body'
  body.append(createChecklist(run))
  root.append(header, body)
  const expanded = options.expanded ?? false
  setDisclosureExpanded(root, expanded)
  header.addEventListener('click', () => {
    const next = !root.classList.contains('expanded')
    root.dataset.userToggled = 'true'
    setDisclosureExpanded(root, next)
  })
  return root
}

export interface WorkPlanDockRenderer {
  render(run?: WorkRun): void
  clear(): void
}

export function createWorkPlanDockRenderer(host: HTMLElement): WorkPlanDockRenderer {
  let renderedRunId = ''
  let renderedVersion = ''
  let userCollapsed: boolean | null = null
  return {
    render(run) {
      if (!run || run.presentation !== 'work' || Object.keys(run.steps).length === 0) {
        host.replaceChildren()
        host.hidden = true
        renderedRunId = ''
        renderedVersion = ''
        userCollapsed = null
        return
      }
      const version = workPlanVersion(run)
      if (renderedRunId === run.id && renderedVersion === version) return
      const previous = host.querySelector<HTMLElement>('.work-plan')
      if (renderedRunId === run.id && previous?.dataset.userToggled === 'true') {
        userCollapsed = !previous.classList.contains('expanded')
      } else if (renderedRunId !== run.id) {
        userCollapsed = null
      }
      const panel = createWorkPlanDisclosure(run, 'dock', {
        expanded: userCollapsed === null ? !['completed', 'cancelled'].includes(run.status) : !userCollapsed,
      })
      if (userCollapsed !== null) panel.dataset.userToggled = 'true'
      host.replaceChildren(panel)
      host.hidden = false
      renderedRunId = run.id
      renderedVersion = version
    },
    clear() {
      host.replaceChildren()
      host.hidden = true
      renderedRunId = ''
      renderedVersion = ''
      userCollapsed = null
    },
  }
}
