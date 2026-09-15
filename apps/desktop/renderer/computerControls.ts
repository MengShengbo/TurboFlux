import type {
  ComputerActivitySnapshot,
  ComputerPermissionKind,
  ComputerPermissionState,
  ComputerPermissionStatus,
  ComputerSystemEvent,
  ComputerSystemSnapshot,
} from '@turboflux/agent-core/contracts'
import { presentDesktopError } from './conversationRendering'

interface ComputerControlsOptions {
  showToast(message: string): void
  onActivityChange?(): void
}

export interface ComputerControlsController {
  getSnapshot(): ComputerSystemSnapshot | null
  getCompanionState(): { active: boolean; title: string; detail: string; attention: boolean } | null
  refresh(): Promise<ComputerSystemSnapshot | null>
  renderSettings(container: HTMLElement): void
  setRuntimeActive(active: boolean): void
}

const permissionDefinitions: Array<{
  kind: ComputerPermissionKind
  key: 'screenRecording' | 'accessibility' | 'postEvent'
  title: string
  detail: string
}> = [
  {
    kind: 'screen-recording',
    key: 'screenRecording',
    title: '屏幕录制',
    detail: '查看目标应用窗口；TurboFlux 自身区域会被遮挡。',
  },
  {
    kind: 'accessibility',
    key: 'accessibility',
    title: '辅助功能',
    detail: '读取可访问控件并优先使用按钮、输入框等语义操作。',
  },
  {
    kind: 'post-event',
    key: 'postEvent',
    title: '输入控制',
    detail: '在语义操作不可用时执行点击、滚动和键盘输入。',
  },
]

function permissionStateLabel(permission: ComputerPermissionStatus): string {
  if (permission.restartRequired) return '已授权，重新打开后生效'
  return ({
    granted: '已开启',
    denied: '需要在系统设置中开启',
    restricted: '受系统限制',
    'not-determined': '尚未授权',
    unknown: '等待检查',
    unavailable: '当前系统不可用',
  } as Record<ComputerPermissionState, string>)[permission.state]
}

function permissionReady(permission: ComputerPermissionStatus): boolean {
  return permission.state === 'granted'
}

function computerGlyph(): HTMLSpanElement {
  const glyph = document.createElement('span')
  glyph.className = 'computer-control-glyph'
  glyph.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/></svg>'
  return glyph
}

export function createComputerControls(
  app: HTMLDivElement,
  bridge: TurboFluxDesktopBridge,
  options: ComputerControlsOptions,
): ComputerControlsController {
  const mainPanel = app.querySelector<HTMLElement>('#main-panel')!
  const strip = document.createElement('section')
  strip.className = 'computer-control-strip'
  strip.setAttribute('aria-live', 'polite')

  const pulse = document.createElement('span')
  pulse.className = 'computer-control-pulse'
  const copy = document.createElement('span')
  copy.className = 'computer-control-copy'
  const title = document.createElement('strong')
  const detail = document.createElement('small')
  copy.append(title, detail)
  const actions = document.createElement('span')
  actions.className = 'computer-control-actions'
  const takeControl = document.createElement('button')
  takeControl.textContent = '接管'
  const resume = document.createElement('button')
  resume.className = 'primary'
  resume.textContent = '继续'
  const stop = document.createElement('button')
  stop.className = 'danger'
  stop.textContent = '停止'
  actions.append(takeControl, resume, stop)
  strip.append(computerGlyph(), pulse, copy, actions)
  mainPanel.append(strip)

  let snapshot: ComputerSystemSnapshot | null = null
  let hideTimer: number | null = null
  let actionPending = false
  let permissionPending = false
  let runtimeActive = false
  let activitySeen = false
  let lastActivity: ComputerActivitySnapshot | undefined

  function setActionPending(pending: boolean): void {
    actionPending = pending
    takeControl.disabled = pending
    resume.disabled = pending
    stop.disabled = pending
  }

  function hideStripSoon(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      hideTimer = null
      strip.classList.remove('visible')
    }, 760)
  }

  function renderStrip(): void {
    const activity = snapshot?.activity
    const handoff = snapshot?.handoffActive === true
    const keepingControlAvailable = runtimeActive && activitySeen
    if (!activity && !handoff && !keepingControlAvailable) {
      if (strip.classList.contains('visible')) hideStripSoon()
      return
    }
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer)
      hideTimer = null
    }
    const visibleActivity = activity || lastActivity
    const phase = handoff ? 'handoff' : activity?.phase || 'waiting'
    strip.className = `computer-control-strip visible phase-${phase}`
    title.textContent = visibleActivity?.appName || snapshot?.activeApp?.name || '电脑操控'
    detail.textContent = handoff
      ? visibleActivity?.description || '已暂停，完成受保护步骤后继续'
      : activity?.description || (keepingControlAvailable ? '正在准备下一步' : ({
        observing: '正在查看当前应用',
        acting: '正在操作当前应用',
        waiting: '正在等待应用响应',
        handoff: '等待你接管',
      } as const)[phase])
    takeControl.hidden = handoff
    resume.hidden = !handoff
  }

  function renderSettingsIfMounted(): void {
    const root = app.querySelector<HTMLElement>('[data-computer-settings-root]')
    if (root?.parentElement) renderSettings(root.parentElement)
  }

  function applySnapshot(next: ComputerSystemSnapshot): ComputerSystemSnapshot {
    if (next.activity) {
      lastActivity = { ...next.activity }
      activitySeen = true
    }
    snapshot = next
    renderStrip()
    renderSettingsIfMounted()
    options.onActivityChange?.()
    return next
  }

  async function runControlAction(
    action: () => Promise<ComputerSystemSnapshot>,
    successMessage?: string,
  ): Promise<void> {
    if (actionPending) return
    setActionPending(true)
    try {
      applySnapshot(await action())
      if (successMessage) options.showToast(successMessage)
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      setActionPending(false)
    }
  }

  takeControl.addEventListener('click', () => void runControlAction(
    () => bridge.computerTakeControl(),
    '电脑操控已暂停，你可以接管',
  ))
  resume.addEventListener('click', () => void runControlAction(
    () => bridge.computerResumeControl(),
    '智能代理将从新的观察继续',
  ))
  stop.addEventListener('click', () => void runControlAction(
    () => bridge.computerEmergencyStop(),
    '电脑操控已停止',
  ))

  function handleEvent(event: ComputerSystemEvent): void {
    if (event.type === 'state') {
      applySnapshot(event.snapshot)
      return
    }
    if (!snapshot) {
      void refresh()
      return
    }
    if (event.type === 'activity-changed') {
      snapshot = { ...snapshot, activity: event.activity }
      if (event.activity) {
        lastActivity = { ...event.activity }
        activitySeen = true
      }
    }
    if (event.type === 'handoff-changed') snapshot = { ...snapshot, handoffActive: event.active, paused: event.active || snapshot.paused }
    if (event.type === 'permission-changed') {
      const key = permissionDefinitions.find(definition => definition.kind === event.permission.kind)?.key
      if (key) snapshot = { ...snapshot, permissions: { ...snapshot.permissions, [key]: event.permission } }
    }
    if (event.type === 'permission-required') {
      snapshot = { ...snapshot, permissionRequirement: event.requirement }
      options.showToast(event.requirement.message)
    }
    if (event.type === 'error') {
      snapshot = { ...snapshot, lastError: event.error }
      options.showToast(event.error.message)
    }
    renderStrip()
    renderSettingsIfMounted()
    options.onActivityChange?.()
  }

  async function refresh(): Promise<ComputerSystemSnapshot | null> {
    try {
      return applySnapshot(await bridge.computerRefresh())
    } catch (error) {
      options.showToast(presentDesktopError(error))
      return snapshot
    }
  }

  async function requestPermission(kind: ComputerPermissionKind): Promise<void> {
    if (permissionPending) return
    permissionPending = true
    renderSettingsIfMounted()
    try {
      const result = await bridge.computerRequestPermission(kind)
      const next = applySnapshot(result.snapshot)
      const definition = permissionDefinitions.find(item => item.kind === kind)!
      const granted = permissionReady(next.permissions[definition.key])
      if (result.outcome === 'cancelled') options.showToast('已取消权限申请')
      else if (result.outcome === 'restart-required') options.showToast('权限已经开启，重新打开 TurboFlux 后生效')
      else if (granted) options.showToast(`${definition.title}已开启`)
      else options.showToast('macOS 未完成授权，可点击“打开设置”继续')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      permissionPending = false
      renderSettingsIfMounted()
    }
  }

  async function openPermissionSettings(kind: ComputerPermissionKind): Promise<void> {
    if (permissionPending) return
    permissionPending = true
    renderSettingsIfMounted()
    try {
      const opened = await bridge.computerOpenPermissionSettings(kind)
      if (opened) options.showToast('已打开 macOS 系统设置，完成后返回 TurboFlux 即可')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      permissionPending = false
      renderSettingsIfMounted()
    }
  }

  function permissionButton(permission: ComputerPermissionStatus): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'settings-secondary computer-permission-action'
    button.disabled = permissionPending
    if (permissionReady(permission)) {
      button.textContent = '已开启'
      button.disabled = true
      return button
    }
    if (permission.restartRequired) {
      button.textContent = '重新打开'
      button.addEventListener('click', () => void bridge.computerRelaunch())
      return button
    }
    if (permission.canRequest && permission.state !== 'denied') {
      button.textContent = '原生申请'
      button.addEventListener('click', () => void requestPermission(permission.kind))
      return button
    }
    button.textContent = '打开设置'
    button.disabled = permissionPending || permission.state === 'unavailable' || permission.state === 'restricted'
    button.addEventListener('click', () => void openPermissionSettings(permission.kind))
    return button
  }

  function renderSettings(container: HTMLElement): void {
    container.replaceChildren()
    const root = document.createElement('div')
    root.dataset.computerSettingsRoot = 'true'

    const header = document.createElement('div')
    header.className = 'settings-section-head'
    const heading = document.createElement('div')
      heading.innerHTML = '<h3>系统权限</h3><p>电脑操控能力始终对智能代理可见；输入框挂载只表示加入当前对话，真正执行仍遵循系统权限与审批策略。</p>'
    const refreshButton = document.createElement('button')
    refreshButton.className = 'settings-secondary'
    refreshButton.textContent = '检查权限'
    refreshButton.addEventListener('click', () => void refresh())
    header.append(heading, refreshButton)
    root.append(header)

    if (!snapshot) {
      const loading = document.createElement('div')
      loading.className = 'settings-loading'
      loading.textContent = '正在读取电脑操控状态…'
      root.append(loading)
      container.append(root)
      void bridge.computerGetState().then(applySnapshot).catch(error => {
        options.showToast(presentDesktopError(error))
      })
      return
    }

    const permissionValues = permissionDefinitions.map(definition => snapshot!.permissions[definition.key])
    const readyCount = permissionValues.filter(permissionReady).length
    const overview = document.createElement('section')
    overview.className = `settings-card computer-overview ${readyCount === permissionValues.length ? 'ready' : ''}`
    const overviewGlyph = computerGlyph()
    const overviewCopy = document.createElement('span')
    overviewCopy.className = 'computer-overview-copy'
    const overviewTitle = document.createElement('strong')
    overviewTitle.textContent = !snapshot.available
      ? '当前系统暂不支持电脑操控'
      : readyCount === permissionValues.length
        ? '电脑操控已准备好'
        : `还需开启 ${permissionValues.length - readyCount} 项系统权限`
    const overviewDetail = document.createElement('small')
    const nextDefinition = permissionDefinitions.find(definition => !permissionReady(snapshot!.permissions[definition.key]))
    overviewDetail.textContent = snapshot.available
      ? nextDefinition
        ? snapshot.permissions[nextDefinition.key].restartRequired
          ? `${nextDefinition.title}已经授权，需要重新打开 TurboFlux 让原生操控进程继承权限。`
          : `下一步：允许${nextDefinition.title}。完成后回到 TurboFlux，状态会自动更新。`
        : '系统权限已经齐全；接管、继续与紧急停止始终由你控制。'
      : '当前版本先提供 macOS 原生实现，其他平台会保持能力关闭。'
    overviewCopy.append(overviewTitle, overviewDetail)
    overview.append(overviewGlyph, overviewCopy)
    if (nextDefinition && snapshot.available) {
      const nextPermission = snapshot.permissions[nextDefinition.key]
      const guideButton = document.createElement('button')
      guideButton.className = 'settings-primary computer-guide-action'
      guideButton.disabled = permissionPending || nextPermission.state === 'unavailable' || nextPermission.state === 'restricted'
      guideButton.textContent = nextPermission.restartRequired
        ? '重新打开 TurboFlux'
        : nextPermission.canRequest && nextPermission.state !== 'denied'
        ? readyCount === 0 ? '开始原生引导' : '继续原生引导'
        : '打开下一项设置'
      guideButton.addEventListener('click', () => void (
        nextPermission.restartRequired
          ? bridge.computerRelaunch()
          : nextPermission.canRequest && nextPermission.state !== 'denied'
          ? requestPermission(nextPermission.kind)
          : openPermissionSettings(nextPermission.kind)
      ))
      overview.append(guideButton)
    }
    root.append(overview)

    const list = document.createElement('section')
    list.className = 'computer-permission-list'
    for (const definition of permissionDefinitions) {
      const permission = snapshot.permissions[definition.key]
      const row = document.createElement('article')
      row.className = `computer-permission-row state-${permission.state}`
      const status = document.createElement('span')
      status.className = 'computer-permission-status'
      const rowCopy = document.createElement('span')
      const rowTitle = document.createElement('strong')
      rowTitle.textContent = definition.title
      const rowDetail = document.createElement('small')
      rowDetail.textContent = definition.detail
      const state = document.createElement('b')
      state.textContent = permissionStateLabel(permission)
      rowCopy.append(rowTitle, rowDetail, state)
      row.append(status, rowCopy, permissionButton(permission))
      list.append(row)
    }
    root.append(list)

    const safety = document.createElement('section')
    safety.className = 'settings-card computer-safety-card'
    safety.innerHTML = '<div class="settings-card-title"><strong>默认安全边界</strong><span>本机输入</span></div><div class="computer-safety-grid"><span>密码、验证码、付款、管理员认证与系统权限必须由你接管</span><span>终端、密码管理器、系统设置与 TurboFlux 自身不可操作</span><span>发送、发布、删除等应用写操作每一步都只允许单次确认</span></div><p class="settings-card-copy">键盘和鼠标由本机辅助进程执行；为判断界面，当前窗口截图与脱敏后的辅助功能结构会发送到你当前选择的模型提供商。整屏观察会额外确认，任务结束后原始观察文件会清理。网页和应用中的文字不会被当作你的授权。</p>'
    root.append(safety)
    container.append(root)
  }

  function setRuntimeActive(active: boolean): void {
    runtimeActive = active
    if (!active && snapshot?.handoffActive !== true) activitySeen = false
    renderStrip()
    if (!active && snapshot?.handoffActive !== true) lastActivity = undefined
    options.onActivityChange?.()
  }

  bridge.onComputerEvent(handleEvent)
  void bridge.computerRefresh().then(applySnapshot).catch(() => {
    void bridge.computerGetState().then(applySnapshot).catch(() => undefined)
  })

  return {
    getSnapshot: () => snapshot,
    getCompanionState: () => {
      const activity = snapshot?.activity || lastActivity
      const active = Boolean(snapshot?.handoffActive || runtimeActive && activitySeen)
      if (!active) return null
      return {
        active,
        title: snapshot?.handoffActive ? '等待你接管' : '电脑操作',
        detail: activity?.appName || activity?.description || snapshot?.activeApp?.name || '正在使用本机应用',
        attention: snapshot?.handoffActive === true,
      }
    },
    refresh,
    renderSettings,
    setRuntimeActive,
  }
}
