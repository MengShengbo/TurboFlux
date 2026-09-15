import type { AutomationDraftInput, AutomationRecord, AutomationSchedule, WorkbenchSnapshot } from '@turboflux/agent-core/workbench'
import type { AutomationNotificationNavigationIntent } from '../automationNotificationNavigation'
import { automationApprovalScopeRows } from './automationApprovalPresentation'
import './automationsView.css'

type Options = {
  bridge: TurboFluxDesktopBridge
  icon: (name: string) => string
  refresh: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  confirm: (name: string) => Promise<boolean>
  onError: (error: unknown) => void
}

const statusLabels: Record<string, string> = {
  queued: '已排队', preparing: '准备中', running: '运行中', waiting_for_workspace: '等待工作区',
  waiting_for_approval: '等待审批', retry_scheduled: '等待重试', completed: '已完成', failed: '失败',
  canceled: '已停止', interrupted: '已中断', needs_review: '需要检查', invalid: '已失效',
  skipped: '已跳过', missed: '已错过', draft: '草稿', testing: '试运行', paused: '已暂停',
}

export function automationScheduleLabel(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case 'manual': return '手动运行'
    case 'once': return new Date(schedule.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    case 'interval': return `每 ${schedule.everyMinutes} 分钟`
    case 'daily': return `每天 ${schedule.time}`
    case 'weekly': return `每周${'日一二三四五六'[schedule.weekday]} ${schedule.time}`
    case 'cron': return schedule.expression
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function dateLabel(at?: number): string {
  return at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

export function createAutomationsView(container: HTMLElement, options: Options) {
  const { bridge } = options
  let snapshot: WorkbenchSnapshot
  let filter = 'all'
  let query = ''
  let expandedId: string | null = null
  let editor: HTMLElement | null = null
  const busy = new Set<string>()

  function button(label: string, glyph: string, action: () => void | Promise<void>, iconOnly = false): HTMLButtonElement {
    const node = element('button', iconOnly ? 'av-icon-button' : 'av-button')
    node.type = 'button'
    node.title = label
    node.setAttribute('aria-label', label)
    if (glyph) node.innerHTML = options.icon(glyph)
    if (!iconOnly) node.append(element('span', '', label))
    node.addEventListener('click', () => { void Promise.resolve().then(action).catch(options.onError) })
    return node
  }

  async function perform(id: string, action: () => Promise<unknown>) {
    if (busy.has(id)) return
    busy.add(id)
    render()
    try { await action(); await options.refresh() } finally { busy.delete(id); render() }
  }

  function openEditor(existing?: AutomationRecord) {
    let savedId = existing?.id
    let revision = existing?.revision
    const form = element('form', 'av-editor')
    editor = form
    const header = element('header', 'av-editor-header')
    const close = () => { editor = null; render(); container.querySelector<HTMLButtonElement>('[data-create]')?.focus() }
    header.append(element('h2', '', existing ? '编辑自动化' : '新建自动化'), button('返回列表', 'close', close, true))
    const fields = element('div', 'av-fields')
    function field(label: string, input: HTMLElement, wide = false) {
      const wrapper = element('label', `av-field${wide ? ' av-wide' : ''}`)
      const control = input.matches('input, select, textarea') ? input : input.querySelector('input')
      control?.setAttribute('aria-label', label)
      wrapper.append(element('span', '', label), input)
      fields.append(wrapper)
      return wrapper
    }
    function input(value: string, type = 'text') {
      const node = element('input')
      node.type = type
      node.value = value
      return node
    }
    function select(values: [string, string][], value: string) {
      const node = element('select')
      values.forEach(([key, label]) => node.add(new Option(label, key)))
      node.value = value
      return node
    }
    const name = input(existing?.name ?? '')
    name.required = true
    name.maxLength = 120
    field('名称', name, true)
    const prompt = element('textarea')
    prompt.rows = 5
    prompt.required = true
    prompt.value = existing?.prompt ?? ''
    field('任务内容', prompt, true)
    const workspace = input(existing?.workspacePath ?? snapshot.workspace.path)
    workspace.readOnly = true
    workspace.required = true
    const picker = element('div', 'av-workspace')
    const choose = button('选择文件夹', 'folder', async () => {
      const selected = await bridge.chooseAutomationWorkspace()
      if (selected) workspace.value = selected
    }, true)
    choose.disabled = Boolean(existing)
    picker.append(workspace, choose)
    field('工作区', picker, true)
    const original = existing?.schedule
    const frequency = select([
      ['daily', '每天'], ['weekly', '每周'], ['interval', '固定间隔'], ['once', '指定日期'], ['manual', '仅手动'], ['cron', 'Cron'],
    ], original?.kind ?? 'daily')
    field('重复', frequency)
    const time = input(original?.kind === 'daily' || original?.kind === 'weekly' ? original.time : '09:00', 'time')
    const timeField = field('时间', time)
    const weekday = select(Array.from('日一二三四五六', (day, index) => [String(index), `星期${day}`]), String(original?.kind === 'weekly' ? original.weekday : 1))
    const weekdayField = field('星期', weekday)
    const minutes = input(String(original?.kind === 'interval' ? original.everyMinutes : 60), 'number')
    minutes.min = '1'
    minutes.step = '1'
    const intervalField = field('间隔（分钟）', minutes)
    const date = original?.kind === 'once' ? new Date(original.at) : new Date(Date.now() + 3_600_000)
    const once = input(new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16), 'datetime-local')
    const onceField = field('日期与时间', once)
    const cron = input(original?.kind === 'cron' ? original.expression : '0 9 * * 1-5')
    const cronField = field('Cron 表达式', cron)
    const timezone = input(existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    const timezoneField = field('时区', timezone)
    const approval = select([['ask', '高风险操作需确认'], ['agent', '低风险操作自动执行'], ['full', '完全访问']], existing?.approvalPolicy ?? 'ask')
    field('权限', approval)
    const preview = element('p', 'av-schedule-preview')
    let previewRevision = 0
    function schedule(): AutomationSchedule {
      switch (frequency.value) {
        case 'daily': return { kind: 'daily', time: time.value }
        case 'weekly': return { kind: 'weekly', time: time.value, weekday: Number(weekday.value) }
        case 'interval': return { kind: 'interval', everyMinutes: Number(minutes.value) }
        case 'once': return { kind: 'once', at: new Date(once.value).toISOString() }
        case 'cron': return { kind: 'cron', expression: cron.value.trim() }
        default: return { kind: 'manual' }
      }
    }
    async function updateSchedule() {
      const current = ++previewRevision
      timeField.hidden = !['daily', 'weekly'].includes(frequency.value)
      weekdayField.hidden = frequency.value !== 'weekly'
      intervalField.hidden = frequency.value !== 'interval'
      onceField.hidden = frequency.value !== 'once'
      cronField.hidden = frequency.value !== 'cron'
      timezoneField.hidden = !['daily', 'weekly', 'cron'].includes(frequency.value)
      for (const node of [time, weekday, minutes, once, cron, timezone]) node.disabled = node.closest('label')!.hidden
      preview.textContent = ''
      if (frequency.value === 'manual') return
      try {
        const times = await bridge.previewAutomationSchedule(schedule(), timezone.value.trim(), 1)
        if (current === previewRevision) preview.textContent = times[0] ? `下次运行 ${dateLabel(times[0])}` : '没有后续运行时间'
      } catch (error) {
        if (current === previewRevision) preview.textContent = error instanceof Error ? error.message : String(error)
      }
    }
    for (const node of [frequency, time, weekday, minutes, once, cron, timezone]) node.addEventListener('change', () => void updateSchedule())
    const enabled = input('', 'checkbox')
    enabled.checked = existing?.enabled ?? true
    const enableLabel = element('label', 'av-enable-label')
    enableLabel.append(enabled, document.createTextNode('启用自动化'))
    const error = element('p', 'av-form-error')
    error.setAttribute('role', 'alert')
    const footer = element('footer', 'av-editor-footer')
    const save = element('button', 'av-button av-primary', '保存')
    save.type = 'submit'
    footer.append(enableLabel, button('取消', 'close', close), save)
    let submitting = false
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (submitting || !form.reportValidity()) return
      submitting = true
      save.disabled = true
      error.textContent = ''
      void (async () => {
        const value: AutomationDraftInput = {
          id: savedId, expectedRevision: revision, name: name.value.trim(), prompt: prompt.value.trim(),
          objective: { goal: prompt.value.trim(), originalPrompt: prompt.value.trim() },
          workspacePath: workspace.value, schedule: schedule(), timezone: timezone.value.trim(), triggers: [],
          approvalPolicy: approval.value as AutomationDraftInput['approvalPolicy'],
          mode: existing?.mode ?? 'isolated',
          capabilityPolicy: existing ? { ...existing.capabilityPolicy, approvalPolicy: approval.value as AutomationRecord['approvalPolicy'] } : undefined,
          contextPolicy: existing?.contextPolicy,
          reliabilityPolicy: existing?.reliabilityPolicy,
        }
        if (!value.name || !value.prompt) throw new Error('请填写名称和任务内容。')
        const detail = await bridge.saveAutomationDraft(value)
        savedId = detail.definition.id
        revision = detail.definition.revision
        if (enabled.checked) {
          const issues = detail.validation.issues.filter(issue => issue.severity === 'error')
          if (issues.length) throw new Error(issues.map(issue => issue.message).join('\n'))
          await bridge.publishAutomationDefinition(savedId, revision)
        }
        editor = null
        expandedId = savedId
        await options.refresh()
        render()
      })().catch(reason => { error.textContent = reason instanceof Error ? reason.message : String(reason) })
        .finally(() => { submitting = false; save.disabled = false })
    })
    form.append(header, fields, preview, error, footer)
    render()
    void updateSchedule()
    name.focus()
  }

  function renderApprovals() {
    if (!snapshot.automations.pendingApprovals.length) return
    const section = element('section', 'av-approvals')
    section.append(element('h2', '', `待确认 · ${snapshot.automations.pendingApprovals.length}`))
    for (const request of snapshot.automations.pendingApprovals) {
      const row = element('article', 'av-approval')
      row.dataset.approvalId = request.id
      row.tabIndex = -1
      const copy = element('div')
      copy.append(element('span', 'av-muted', request.automationName), element('h3', '', request.question))
      const scope = element('ul', 'av-approval-scope')
      for (const item of automationApprovalScopeRows(request)) scope.append(element('li', '', `${item.label}：${item.value}`))
      copy.append(scope)
      const actions = element('div', 'av-actions')
      const response = element('input')
      response.name = `approval:${request.id}`
      response.setAttribute('aria-label', '补充信息')
      if (request.kind === 'input' && !request.options?.length) actions.append(response)
      const choices = request.options?.length ? request.options : request.kind === 'input' ? ['submit'] : ['allow-once', 'deny']
      for (const choice of choices) {
        const labels: Record<string, string> = { 'allow-once': '允许一次', 'allow-run': '本次运行允许', 'allow-session': '本次会话允许', deny: '拒绝', submit: '提交' }
        const control = button(labels[choice] ?? choice, choice === 'deny' ? 'close' : 'check', () => perform(request.id, async () => {
          if (choice === 'submit' && !response.value.trim()) return
          await bridge.resolveAutomationApproval(request.id, choice === 'submit' ? response.value.trim() : choice)
        }))
        control.disabled = busy.has(request.id)
        actions.append(control)
      }
      row.append(copy, actions)
      section.append(row)
    }
    container.append(section)
  }

  function renderHistory(automation: AutomationRecord): HTMLElement {
    const section = element('div', 'av-history')
    section.append(element('p', 'av-task', automation.prompt))
    for (const issue of automation.validationIssues.filter(issue => issue.severity === 'error')) section.append(element('p', 'av-form-error', issue.message))
    section.append(element('h3', '', '执行记录'))
    if (!automation.history.length) section.append(element('p', 'av-muted', '暂无执行记录'))
    for (const run of automation.history.slice(0, 20)) {
      const row = element('div', 'av-history-row')
      const copy = element('div')
      copy.append(element('span', `av-status av-status-${run.status}`, statusLabels[run.status] ?? run.status), element('time', 'av-muted', dateLabel(run.startedAt)))
      if (run.resultSummary || run.error) copy.append(element('p', '', run.error || run.resultSummary))
      const actions = element('div', 'av-actions')
      if (run.conversationId) actions.append(button('查看结果', 'chevron', () => options.openConversation(run.conversationId!)))
      if (['failed', 'canceled', 'interrupted', 'retry_scheduled'].includes(run.status) && !automation.activeRunId) {
        const retry = button('重试', 'reload', () => perform(automation.id, () => bridge.retryAutomationRun(automation.id, run.id)), true)
        retry.disabled = busy.has(automation.id)
        actions.append(retry)
      }
      if (run.status === 'needs_review') actions.append(button('停止恢复', 'pauseBlock', () => perform(automation.id, () => bridge.abandonAutomationRunRecovery(run.id))))
      row.append(copy, actions)
      section.append(row)
    }
    return section
  }

  function renderRows(list: HTMLElement) {
    list.replaceChildren()
    const records = snapshot.automations.automations.filter(item => item.lifecycleStatus !== 'archived')
    const visible = records.filter(item => (filter === 'all' || (filter === 'enabled' ? item.enabled : !item.enabled)) && `${item.name} ${item.prompt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    if (!visible.length) {
      const empty = element('div', 'av-empty')
      const mark = element('div', 'av-empty-icon')
      mark.innerHTML = options.icon('parallel')
      empty.append(mark, element('h2', '', records.length ? '没有匹配的自动化' : '暂无自动化'))
      if (!records.length) empty.append(button('新建自动化', 'plus', () => openEditor()))
      list.append(empty)
      return
    }
    for (const item of visible) {
      const article = element('article', 'av-plan')
      const row = element('div', 'av-plan-row')
      const title = button(item.name, expandedId === item.id ? 'chevronDown' : 'chevron', () => { expandedId = expandedId === item.id ? null : item.id; renderRows(list) })
      title.className = 'av-plan-title'
      title.setAttribute('aria-expanded', String(expandedId === item.id))
      const copy = element('div', 'av-plan-copy')
      copy.append(title, element('p', 'av-muted av-plan-workspace', item.workspacePath.split(/[/\\]/).filter(Boolean).pop() || item.workspacePath))
      const schedule = element('div', 'av-plan-schedule')
      schedule.append(element('span', '', automationScheduleLabel(item.schedule)), element('small', 'av-muted', item.enabled && item.nextRunAt ? `下次 ${dateLabel(item.nextRunAt)}` : item.enabled ? '已启用' : '已暂停'))
      const status = item.lifecycleStatus === 'invalid' ? 'invalid' : item.lastStatus || (item.enabled ? '' : item.lifecycleStatus)
      const state = element('span', `av-status av-status-${status || 'idle'}`, statusLabels[status || ''] || '尚未运行')
      const actions = element('div', 'av-actions')
      const toggle = button(item.enabled ? '暂停自动化' : '启用自动化', '', () => perform(item.id, () => item.enabled
        ? bridge.setAutomationDefinitionStatus(item.id, 'paused')
        : bridge.publishAutomationDefinition(item.id, item.revision)), true)
      toggle.className = 'av-switch'
      toggle.innerHTML = '<span></span>'
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-checked', String(item.enabled))
      const run = button(item.activeRunId ? '停止运行' : '立即运行', item.activeRunId ? 'pauseBlock' : 'play', () => perform(item.id, () => item.activeRunId ? bridge.cancelAutomationRun(item.id) : bridge.runAutomation(item.id)), true)
      const edit = button('编辑', 'edit', () => openEditor(item), true)
      edit.disabled = Boolean(item.activeRunId)
      const remove = button('删除', 'trash', async () => {
        if (await options.confirm(item.name)) await perform(item.id, () => bridge.removeAutomation(item.id))
      }, true)
      remove.disabled = Boolean(item.activeRunId)
      actions.append(toggle, run, edit, remove)
      if (busy.has(item.id)) actions.querySelectorAll('button').forEach(node => { node.disabled = true })
      row.append(copy, schedule, state, actions)
      article.append(row)
      if (expandedId === item.id) article.append(renderHistory(item))
      list.append(article)
    }
  }

  function render() {
    if (!snapshot) return
    if (editor && container.firstElementChild === editor) return
    const inputs = new Map(Array.from(container.querySelectorAll<HTMLInputElement>('input[name]'), node => [node.name, {
      value: node.value, start: node.selectionStart, end: node.selectionEnd, focused: node === document.activeElement,
    }]))
    container.replaceChildren()
    container.classList.add('automations-view')
    if (editor) { container.append(editor); return }
    const records = snapshot.automations.automations.filter(item => item.lifecycleStatus !== 'archived')
    const header = element('header', 'av-header')
    const heading = element('div')
    heading.append(element('h1', '', '自动化'), element('span', 'av-muted', `${records.length} 个计划 · ${records.filter(item => item.enabled).length} 个已启用`))
    const create = button('新建自动化', 'plus', () => openEditor())
    create.classList.add('av-primary')
    create.dataset.create = ''
    header.append(heading, create)
    container.append(header)
    if (snapshot.automations.scheduler.error || snapshot.automations.warnings.length) {
      const message = element('p', 'av-form-error', snapshot.automations.scheduler.error || snapshot.automations.warnings.join('\n'))
      message.setAttribute('role', 'status')
      container.append(message)
    }
    renderApprovals()
    const toolbar = element('div', 'av-toolbar')
    const tabs = element('div', 'av-tabs')
    tabs.setAttribute('aria-label', '计划状态')
    const list = element('div', 'av-list')
    for (const [key, label] of [['all', '全部'], ['enabled', '已启用'], ['paused', '已暂停']]) {
      const tab = button(label!, '', () => { filter = key!; render() })
      tab.className = 'av-tab'
      tab.setAttribute('aria-pressed', String(filter === key))
      tabs.append(tab)
    }
    const search = element('input', 'av-search')
    search.type = 'search'
    search.name = 'search'
    search.placeholder = '搜索自动化'
    search.setAttribute('aria-label', '搜索自动化')
    search.value = query
    search.addEventListener('input', () => { query = search.value; renderRows(list) })
    toolbar.append(tabs, search)
    container.append(toolbar, list)
    renderRows(list)
    container.append(element('p', 'av-footnote', '本机执行 · TurboFlux 运行且电脑唤醒时生效'))
    for (const node of container.querySelectorAll<HTMLInputElement>('input[name]')) {
      const previous = inputs.get(node.name)
      if (!previous) continue
      if (node.name !== 'search') node.value = previous.value
      if (previous.focused) {
        node.focus({ preventScroll: true })
        node.setSelectionRange(previous.start, previous.end)
      }
    }
  }

  return {
    update(next: WorkbenchSnapshot) { snapshot = next; render() },
    async navigate(intent: AutomationNotificationNavigationIntent) {
      editor = null
      filter = 'all'
      query = ''
      if (intent.kind === 'automation-run') {
        const detail = await bridge.getAutomationRun(intent.runId)
        expandedId = detail.run.definitionId
      }
      render()
      if (intent.kind === 'automation-approval') {
        const target = [...container.querySelectorAll<HTMLElement>('[data-approval-id]')].find(item => item.dataset.approvalId === intent.approvalId)
        target?.scrollIntoView({ block: 'center' })
        target?.focus()
      }
    },
  }
}
