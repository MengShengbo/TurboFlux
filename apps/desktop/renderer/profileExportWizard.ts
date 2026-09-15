import type { ArchiveComponentId, ArchiveOperationSnapshot, ProfileExportEstimate } from '@turboflux/agent-core/workbench'
import { presentDesktopError } from './conversationRendering'
import {
  captureProfileDialogReturnFocus,
  handleProfileDialogEscape,
  restoreProfileDialogReturnFocus,
  trapProfileDialogFocus,
  type ProfileDialogReturnFocusTarget,
} from './profileDialogAccessibility'

interface ProfileDialogVisibilityState {
  profileChanged: boolean
  restoreFocus(): void
}

interface ProfileExportWizardOptions {
  showToast(message: string): void
  onVisibilityChange?(open: boolean, state?: ProfileDialogVisibilityState): void
}

interface ExportOptions {
  profile: { id: string; displayName: string }
  components: Array<{
    id: ArchiveComponentId
    defaultSelected: boolean
    sensitivity: 'normal' | 'private' | 'secret' | 'executable'
    description: string
    requiresEncryption: boolean
  }>
  format: { extension: '.turboflux-profile'; encryptedByDefault: boolean }
}

export interface ProfileExportWizardController {
  open(): Promise<void>
  close(): void
  isOpen(): boolean
}

const STEP_LABELS = ['范围', '内容', '隐私', '保护', '确认与导出']

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function sensitivityLabel(value: ExportOptions['components'][number]['sensitivity']): string {
  return value === 'secret' ? '秘密' : value === 'executable' ? '可执行' : value === 'private' ? '私密' : '常规'
}

export function createProfileExportWizard(
  app: HTMLDivElement,
  bridge: TurboFluxDesktopBridge,
  options: ProfileExportWizardOptions,
): ProfileExportWizardController {
  const overlay = document.createElement('div')
  overlay.className = 'profile-export-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.innerHTML = '<section class="profile-export-window" role="dialog" aria-modal="true" aria-label="导出用户资料包"></section>'
  app.append(overlay)
  const windowElement = overlay.querySelector<HTMLElement>('.profile-export-window')!
  let exportOptions: ExportOptions | null = null
  let selected = new Set<ArchiveComponentId>()
  let estimate: ProfileExportEstimate | null = null
  let step = 0
  let encrypted = true
  let target: { token: string; expiresAt: number; displayName: string } | null = null
  let operation: ArchiveOperationSnapshot | null = null
  let pendingPassword = ''
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let returnFocusTarget: ProfileDialogReturnFocusTarget | null = null

  function activeOperation(): boolean {
    return Boolean(operation && !['completed', 'cancelled', 'failed'].includes(operation.phase))
  }

  function requiresEncryption(): boolean {
    return Boolean(exportOptions?.components.some(component => component.requiresEncryption && selected.has(component.id)))
  }

  function renderShell(body: string, controls = true): void {
    const stepDescription = `第 ${step + 1} 步，共 ${STEP_LABELS.length} 步 · ${STEP_LABELS[step]}`
    windowElement.innerHTML = `
      <header class="profile-export-header">
        <div><h2>导出用户资料包</h2><p>${escapeHtml(exportOptions?.profile.displayName || '当前资料')} · ${stepDescription}</p></div>
        <button class="profile-export-close" aria-label="关闭" ${activeOperation() ? 'disabled' : ''}>×</button>
      </header>
      <ol class="profile-export-steps" aria-label="导出步骤">${STEP_LABELS.map((label, index) => `<li class="${index === step ? 'active' : index < step ? 'complete' : ''}" aria-current="${index === step ? 'step' : 'false'}"><span>${index + 1}</span>${label}</li>`).join('')}</ol>
      <main class="profile-export-content">${body}</main>
      ${controls ? `<footer class="profile-export-footer"><button class="profile-export-secondary" data-export-action="back" ${step === 0 || busy || activeOperation() ? 'disabled' : ''}>上一步</button><div><button class="profile-export-secondary" data-export-action="cancel" ${busy ? 'disabled' : ''}>${activeOperation() ? '取消导出' : '取消'}</button><button class="profile-export-primary" data-export-action="next" ${busy || activeOperation() ? 'disabled' : ''}>${step === 4 ? '开始导出' : '继续'}</button></div></footer>` : ''}`
    bindCommonActions()
  }

  function render(): void {
    if (!exportOptions) return renderShell('<div class="profile-export-loading">正在读取当前资料…</div>', false)
    if (step === 0) renderScope()
    if (step === 1) renderComponents()
    if (step === 2) renderPrivacy()
    if (step === 3) renderProtection()
    if (step === 4) renderConfirmation()
  }

  function renderScope(): void {
    renderShell(`<section class="profile-export-panel"><h3>导出“${escapeHtml(exportOptions!.profile.displayName)}”</h3><p>生成一份可在其他电脑导入的 TurboFlux 资料包。下一步可以逐项决定要带走的内容。</p><div class="profile-export-boundary-list"><div><strong>可以带走</strong><span>所选会话、设置、记忆、附件、成果与扩展定义</span></div><div><strong>始终留在本机</strong><span>项目源码、设备授权、浏览器登录状态和其他用户资料</span></div></div></section>`)
  }

  function renderComponents(): void {
    const rows = exportOptions!.components.map(component => {
      const componentEstimate = estimate?.components.find(item => item.id === component.id)
      return `<label class="profile-export-component ${selected.has(component.id) ? 'selected' : ''}">
        <input type="checkbox" value="${component.id}" ${selected.has(component.id) ? 'checked' : ''}>
        <span><strong>${escapeHtml(component.description)}</strong><small>${sensitivityLabel(component.sensitivity)}${component.defaultSelected ? ' · 默认包含' : ' · 默认不包含'}${componentEstimate?.logicalBytes ? ` · ${formatBytes(componentEstimate.logicalBytes)}` : ''}</small></span>
      </label>`
    }).join('')
    renderShell(`<section><div class="profile-export-section-heading"><div><h3>选择要带走的内容</h3><p>接收方只能进一步减少，不能恢复这里没有选择的内容。</p></div><strong>${selected.size} 项</strong></div><div class="profile-export-component-list">${rows}</div></section>`)
    windowElement.querySelectorAll<HTMLInputElement>('.profile-export-component input').forEach(input => input.addEventListener('change', () => {
      const id = input.value as ArchiveComponentId
      if (input.checked) selected.add(id)
      else selected.delete(id)
      estimate = null
      renderComponents()
    }))
  }

  function renderPrivacy(): void {
    const blockers = estimate?.blockers ?? []
    renderShell(`<section><h3>确认隐私边界</h3><p>TurboFlux 会在写入前把本机路径替换为工作区身份，并清除活动执行状态。</p>
      <div class="profile-export-summary"><div><span>条目</span><strong>${estimate?.itemCount ?? 0}</strong></div><div><span>逻辑大小</span><strong>${formatBytes(estimate?.logicalBytes ?? 0)}</strong></div><div><span>预计文件</span><strong>${formatBytes(estimate?.estimatedPhysicalBytes ?? 0)}</strong></div></div>
      <div class="profile-export-notice safe"><strong>始终不会导出</strong><ul>${(estimate?.excluded ?? []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
      ${(estimate?.warnings ?? []).length ? `<div class="profile-export-notice"><strong>需要注意</strong><ul>${estimate!.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
      ${blockers.length ? `<div class="profile-export-notice danger"><strong>暂时无法继续</strong><ul>${blockers.map(item => `<li>${escapeHtml(item.message)} ${escapeHtml(item.action)}</li>`).join('')}</ul></div>` : ''}
    </section>`)
  }

  function renderProtection(): void {
    const forced = requiresEncryption()
    if (forced) encrypted = true
    renderShell(`<section><h3>保护资料包</h3><p>会话属于私密数据，建议始终设置密码。密码不会保存到 TurboFlux，丢失后无法恢复。</p>
      <label class="profile-export-protection ${encrypted ? 'selected' : ''}"><input id="profile-export-encrypted" type="checkbox" ${encrypted ? 'checked' : ''} ${forced ? 'disabled' : ''}><span><strong>使用密码加密完整资料包</strong><small>${forced ? '所选内容包含秘密，此项必须开启' : '使用 scrypt 与 AES-256-GCM 保护内容和完整性'}</small></span></label>
      <div class="profile-export-passwords" ${encrypted ? '' : 'hidden'}><label>资料包密码<input id="profile-export-password" type="password" autocomplete="new-password" minlength="12" placeholder="至少 12 个字符"></label><label>再次输入<input id="profile-export-password-confirm" type="password" autocomplete="new-password" minlength="12" placeholder="再次输入密码"></label><p>TurboFlux 不会把密码写入设置、日志或资料包清单。</p></div>
    </section>`)
    windowElement.querySelector<HTMLInputElement>('#profile-export-encrypted')?.addEventListener('change', event => {
      encrypted = (event.target as HTMLInputElement).checked
      estimate = null
      renderProtection()
    })
  }

  function renderConfirmation(): void {
    if (operation) return renderOperation()
    const chosen = target ? `<div class="profile-export-target"><span>保存为</span><strong>${escapeHtml(target.displayName)}</strong><button data-export-action="choose-target">重新选择</button></div>` : '<button class="profile-export-choose" data-export-action="choose-target">选择保存位置</button>'
    renderShell(`<section><h3>准备导出</h3><p>确认后将使用已冻结的快照生成资料包。目标文件已存在时不会覆盖。</p>
      <div class="profile-export-summary"><div><span>组件</span><strong>${selected.size}</strong></div><div><span>预计大小</span><strong>${formatBytes(estimate?.estimatedPhysicalBytes ?? 0)}</strong></div><div><span>保护</span><strong>${encrypted ? '密码加密' : '仅校验'}</strong></div></div>
      ${chosen}
      <div class="profile-export-recovery"><strong>恢复提示</strong><p>请将资料包和密码分开保存。导入另一台电脑后，工作区需要重新选择，自动化、插件和 MCP 会保持禁用。</p></div>
    </section>`)
    windowElement.querySelectorAll<HTMLElement>('[data-export-action="choose-target"]').forEach(button => button.addEventListener('click', () => void chooseTarget()))
  }

  function renderOperation(): void {
    const terminal = ['completed', 'cancelled', 'failed'].includes(operation!.phase)
    const title = operation!.phase === 'completed' ? '资料包已导出' : operation!.phase === 'cancelled' ? '导出已取消' : operation!.phase === 'failed' ? '导出失败' : '正在生成资料包'
    const details = operation!.phase === 'completed'
      ? `<div class="profile-export-result"><strong>${escapeHtml(target?.displayName)}</strong><span>${formatBytes(operation!.result?.physicalBytes ?? 0)}</span><code>${escapeHtml(operation!.result?.sha256 ?? '')}</code><p>请妥善保存密码；TurboFlux 无法找回遗失的资料包密码。</p></div>`
      : operation!.phase === 'failed'
        ? `<div class="profile-export-notice danger"><strong>${escapeHtml(operation!.error?.message || '导出失败')}</strong><p>${escapeHtml(operation!.error?.action || '请重试。')}</p></div>`
        : `<div class="profile-export-progress" role="progressbar" aria-label="导出进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(operation!.progress * 100)}"><div><span style="width:${Math.round(operation!.progress * 100)}%"></span></div><strong>${Math.round(operation!.progress * 100)}%</strong></div>`
    renderShell(`<section><h3>${title}</h3><p>${escapeHtml(operation!.message || '')}</p>${details}</section>`, false)
    windowElement.insertAdjacentHTML('beforeend', `<footer class="profile-export-footer"><span></span><div>${!terminal ? '<button class="profile-export-secondary" data-export-action="cancel">取消导出</button>' : ''}<button class="profile-export-primary" data-export-action="done" ${terminal ? '' : 'disabled'}>完成</button></div></footer>`)
    bindCommonActions()
  }

  function bindCommonActions(): void {
    windowElement.querySelector<HTMLElement>('.profile-export-close')?.addEventListener('click', close)
    windowElement.querySelectorAll<HTMLElement>('[data-export-action="back"]').forEach(button => button.addEventListener('click', () => { step = Math.max(0, step - 1); render() }))
    windowElement.querySelectorAll<HTMLElement>('[data-export-action="next"]').forEach(button => button.addEventListener('click', () => void next()))
    windowElement.querySelectorAll<HTMLElement>('[data-export-action="cancel"]').forEach(button => button.addEventListener('click', () => void cancel()))
    windowElement.querySelectorAll<HTMLElement>('[data-export-action="done"]').forEach(button => button.addEventListener('click', close))
  }

  async function estimateSelection(): Promise<boolean> {
    if (selected.size === 0) return options.showToast('请至少选择一项内容'), false
    busy = true
    render()
    try {
      estimate = await bridge.estimateProfileExport({ components: [...selected], includeBlobs: selected.has('attachments') || selected.has('artifacts.blobs'), encrypted })
      return estimate.blockers.length === 0
    } catch (error) {
      options.showToast(presentDesktopError(error))
      return false
    } finally {
      busy = false
      render()
    }
  }

  async function next(): Promise<void> {
    if (busy || activeOperation()) return
    if (step === 1 && !(await estimateSelection())) {
      if (estimate?.blockers.some(blocker => blocker.code === 'SECRET_EXPORT_REQUIRES_ENCRYPTION')) {
        encrypted = true
        step = 3
      } else if (estimate) step = 2
      return render()
    }
    if (step === 2 && estimate?.blockers.length) return options.showToast(estimate.blockers[0]!.message)
    if (step === 3) {
      const password = windowElement.querySelector<HTMLInputElement>('#profile-export-password')?.value || ''
      const confirmation = windowElement.querySelector<HTMLInputElement>('#profile-export-password-confirm')?.value || ''
      if (encrypted && password.length < 12) return options.showToast('资料包密码至少需要 12 个字符')
      if (encrypted && password !== confirmation) return options.showToast('两次输入的密码不一致')
      pendingPassword = password
      if (!(await estimateSelection())) return
    }
    if (step < 4) {
      step += 1
      render()
      return
    }
    await startExport()
  }

  async function chooseTarget(): Promise<void> {
    if (busy) return
    try {
      const result = await bridge.chooseProfileExportTarget()
      if (!result.canceled) target = result
      render()
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function startExport(): Promise<void> {
    if (!estimate) return options.showToast('导出计划已过期，请返回重新检查内容')
    if (!target || target.expiresAt < Date.now()) {
      await chooseTarget()
      if (!target) return
    }
    const password = pendingPassword
    pendingPassword = ''
    busy = true
    render()
    try {
      const reference = await bridge.startProfileExport({ planId: estimate.planId, pathToken: target.token, password: encrypted ? password : undefined })
      operation = await bridge.getProfileArchiveOperation(reference.operationId)
      poll(reference.operationId)
    } catch (error) {
      options.showToast(presentDesktopError(error))
      target = null
    } finally {
      busy = false
      render()
    }
  }

  function poll(operationId: string): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      try {
        operation = await bridge.getProfileArchiveOperation(operationId)
        render()
        if (!['completed', 'cancelled', 'failed'].includes(operation.phase)) poll(operationId)
      } catch (error) {
        options.showToast(presentDesktopError(error))
      }
    }, 250)
  }

  async function cancel(): Promise<void> {
    if (activeOperation()) {
      await bridge.cancelProfileArchiveOperation(operation!.operationId).catch(error => options.showToast(presentDesktopError(error)))
      return
    }
    close()
  }

  async function open(): Promise<void> {
    returnFocusTarget = captureProfileDialogReturnFocus(document.activeElement)
    overlay.classList.add('open')
    overlay.setAttribute('aria-hidden', 'false')
    exportOptions = null
    estimate = null
    target = null
    operation = null
    step = 0
    render()
    try {
      exportOptions = await bridge.getProfileExportOptions()
      selected = new Set(exportOptions.components.filter(component => component.defaultSelected).map(component => component.id))
      encrypted = exportOptions.format.encryptedByDefault
      render()
      windowElement.querySelector<HTMLElement>('button, input')?.focus()
      options.onVisibilityChange?.(true)
    } catch (error) {
      options.showToast(presentDesktopError(error))
      close()
    }
  }

  function close(): void {
    if (activeOperation()) return
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    pendingPassword = ''
    overlay.classList.remove('open')
    overlay.setAttribute('aria-hidden', 'true')
    const restoreFocus = () => restoreProfileDialogReturnFocus(returnFocusTarget)
    restoreFocus()
    options.onVisibilityChange?.(false, { profileChanged: false, restoreFocus })
  }

  overlay.addEventListener('click', event => {
    if (event.target === overlay && !activeOperation()) close()
  })
  overlay.addEventListener('keydown', event => {
    if (handleProfileDialogEscape(event, !activeOperation(), close)) return
    trapProfileDialogFocus(event, windowElement)
  })

  return { open, close, isOpen: () => overlay.classList.contains('open') }
}
