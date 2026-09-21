import type {
  ArchiveComponentId,
  ArchiveOperationSnapshot,
  PersistedConversation,
  ProfileArchivePreview,
  ProfileImportPlan,
} from '@turboflux/workbench'
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

interface ProfileImportWizardOptions {
  showToast(message: string): void
  onVisibilityChange?(open: boolean, state?: ProfileDialogVisibilityState): void
}

type ImportSource = Exclude<Awaited<ReturnType<TurboFluxDesktopBridge['chooseProfileImportSource']>>, { canceled: true }>
type RebindState = Awaited<ReturnType<TurboFluxDesktopBridge['getProfileImportRebindState']>>
type RebindSelection = Exclude<Awaited<ReturnType<TurboFluxDesktopBridge['chooseProfileRebindFolder']>>, { canceled: true }>

export interface ProfileImportWizardController {
  open(): Promise<void>
  openRebind(profileId: string): Promise<void>
  close(): void
  isOpen(): boolean
}

const STEP_LABELS = ['文件', '认证', '预览', '内容', '安全确认', '创建资料']
const COMPONENT_LABELS: Record<ArchiveComponentId, string> = {
  'profile.preferences': '偏好与人设',
  conversations: '会话历史',
  'model.configurations': '模型配置',
  credentials: 'API 凭据',
  projects: '项目索引',
  automations: '自动化',
  memories: '记忆',
  attachments: '附件',
  'artifacts.index': '成果索引',
  'artifacts.blobs': '成果文件',
  'skills.user': '用户 Skills',
  'plugins.packages': '插件包',
  'plugins.storage': '插件数据',
  'mcp.configurations': 'MCP 配置',
  'runtime.transcripts': '运行记录',
  captures: '浏览器与电脑捕获',
}

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

function terminalPhase(phase: ArchiveOperationSnapshot['phase']): boolean {
  return ['completed', 'cancelled', 'rolled_back', 'failed'].includes(phase)
}

export function createProfileImportWizard(
  app: HTMLDivElement,
  bridge: TurboFluxDesktopBridge,
  options: ProfileImportWizardOptions,
): ProfileImportWizardController {
  const overlay = document.createElement('div')
  overlay.className = 'profile-export-overlay profile-import-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.innerHTML = '<section class="profile-export-window profile-import-window" role="dialog" aria-modal="true" aria-label="导入用户资料包"></section>'
  app.append(overlay)
  const windowElement = overlay.querySelector<HTMLElement>('.profile-import-window')!
  let source: ImportSource | null = null
  let preview: ProfileArchivePreview | null = null
  let selected = new Set<ArchiveComponentId>()
  let plan: ProfileImportPlan | null = null
  let operation: ArchiveOperationSnapshot | null = null
  let rebindState: RebindState | null = null
  let viewedConversation: PersistedConversation | null = null
  let pendingRebind: { workspaceId: string; selection: RebindSelection } | null = null
  let password = ''
  let displayName = ''
  let risksAccepted = false
  let step = 0
  let busy = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let returnFocusTarget: ProfileDialogReturnFocusTarget | null = null
  let profileChanged = false

  function activeOperation(): boolean {
    return Boolean(operation && !terminalPhase(operation.phase))
  }

  function shell(body: string, controls = true): void {
    const stepDescription = rebindState
      ? '导入后的工作区与历史'
      : `第 ${step + 1} 步，共 ${STEP_LABELS.length} 步 · ${STEP_LABELS[step]}`
    windowElement.innerHTML = `
      <header class="profile-export-header"><div><h2>导入用户资料包</h2><p>${escapeHtml(source?.displayName || '创建一份新的用户资料')} · ${stepDescription}</p></div><button class="profile-export-close" aria-label="关闭" ${activeOperation() ? 'disabled' : ''}>×</button></header>
      ${rebindState ? '' : `<ol class="profile-export-steps profile-import-steps" aria-label="导入步骤">${STEP_LABELS.map((label, index) => `<li class="${index === step ? 'active' : index < step ? 'complete' : ''}" aria-current="${index === step ? 'step' : 'false'}"><span>${index + 1}</span>${label}</li>`).join('')}</ol>`}
      <main class="profile-export-content">${body}</main>
      ${controls ? `<footer class="profile-export-footer"><button class="profile-export-secondary" data-import-action="back" ${step === 0 || busy || activeOperation() ? 'disabled' : ''}>上一步</button><div><button class="profile-export-secondary" data-import-action="cancel" ${busy ? 'disabled' : ''}>${activeOperation() ? '取消导入' : '取消'}</button><button class="profile-export-primary" data-import-action="next" ${busy || activeOperation() ? 'disabled' : ''}>${step === 5 ? '创建新资料' : '继续'}</button></div></footer>` : ''}`
    bindCommon()
  }

  function render(): void {
    if (rebindState) return renderRebindCenter()
    if (operation) return renderOperation()
    if (step === 0) return renderSource()
    if (step === 1) return renderAuthentication()
    if (step === 2) return renderPreview()
    if (step === 3) return renderComponents()
    if (step === 4) return renderRiskConfirmation()
    renderCreate()
  }

  function renderSource(): void {
    shell(`<section><h3>选择资料包</h3><p>TurboFlux 会先验证文件头和资源预算，不会直接解压到当前资料或工作区。</p>
      ${source ? `<div class="profile-export-target"><span>已选择</span><strong>${escapeHtml(source.displayName)}</strong><button data-import-action="choose-source">重新选择</button></div><div class="profile-export-summary"><div><span>文件大小</span><strong>${formatBytes(source.physicalBytes)}</strong></div><div><span>保护</span><strong>${source.encrypted ? '密码加密' : '未加密'}</strong></div><div><span>导入方式</span><strong>创建新资料</strong></div></div>` : '<button class="profile-export-choose" data-import-action="choose-source">选择 .turboflux-profile 文件</button>'}
      <div class="profile-export-notice safe"><strong>不会覆盖当前资料</strong><p>导入事务只会创建新的本地资料，完成后也不会自动切换。</p></div></section>`)
    windowElement.querySelectorAll<HTMLElement>('[data-import-action="choose-source"]').forEach(button => button.addEventListener('click', () => void chooseSource()))
  }

  function renderAuthentication(): void {
    shell(`<section><h3>${source?.encrypted ? '输入资料包密码' : '验证资料包'}</h3><p>${source?.encrypted ? '密码只用于本次认证，不会保存到设置、日志或资料快照。' : '这份资料包未加密。TurboFlux 仍会验证完整性、清单和所有组件摘要。'}</p>
      ${source?.encrypted ? '<div class="profile-export-passwords"><label>资料包密码<input id="profile-import-password" type="password" autocomplete="current-password" placeholder="输入导出时设置的密码"></label><p>连续认证失败不会产生任何资料目录。</p></div>' : '<div class="profile-export-notice"><strong>未使用密码保护</strong><p>请只从你信任的来源接收资料包；导入内容仍会按不可信输入扫描。</p></div>'}
    </section>`)
    const input = windowElement.querySelector<HTMLInputElement>('#profile-import-password')
    if (input) {
      input.value = password
      input.addEventListener('input', () => { password = input.value })
      input.focus()
    }
  }

  function renderPreview(): void {
    if (!preview) return shell('<div class="profile-export-loading">正在验证资料包…</div>', false)
    const sensitivities = preview.components.reduce<Record<string, number>>((counts, component) => {
      counts[component.sensitivity] = (counts[component.sensitivity] || 0) + 1
      return counts
    }, {})
    shell(`<section><h3>验证完成</h3><p>以下内容来自经过认证的 Manifest；预览不包含完整会话、插件源码、明文秘密或内部解压路径。</p>
      <div class="profile-export-summary"><div><span>来源平台</span><strong>${escapeHtml(preview.sourcePlatform)}</strong></div><div><span>组件</span><strong>${preview.components.length}</strong></div><div><span>工作区</span><strong>${preview.workspaces.length}</strong></div></div>
      <div class="profile-export-notice safe"><strong>兼容性：${escapeHtml(preview.compatibility)}</strong><p>${sensitivities.secret || 0} 个秘密组件，${sensitivities.executable || 0} 个可执行组件；后者导入后保持禁用。</p></div>
      ${preview.warnings.length ? `<div class="profile-export-notice"><strong>兼容性与风险提示</strong><ul>${preview.warnings.map(warning => `<li>${escapeHtml(warning.message)} ${escapeHtml(warning.action || '')}</li>`).join('')}</ul></div>` : ''}
    </section>`)
  }

  function renderComponents(): void {
    const rows = preview!.components.map(component => `<label class="profile-export-component ${selected.has(component.id) ? 'selected' : ''}">
      <input type="checkbox" value="${component.id}" ${selected.has(component.id) ? 'checked' : ''}>
      <span><strong>${escapeHtml(COMPONENT_LABELS[component.id])}</strong><small>${component.itemCount} 项 · ${formatBytes(component.logicalBytes)} · ${escapeHtml(component.sensitivity)}${component.importedEnabled ? '' : ' · 导入后禁用'}</small></span>
    </label>`).join('')
    shell(`<section><div class="profile-export-section-heading"><div><h3>选择导入内容</h3><p>只能从资料包已有内容中进一步减少；依赖项会在计划阶段再次校验。</p></div><strong>${selected.size} 项</strong></div><div class="profile-export-component-list">${rows}</div></section>`)
    windowElement.querySelectorAll<HTMLInputElement>('.profile-export-component input').forEach(input => input.addEventListener('change', () => {
      const id = input.value as ArchiveComponentId
      if (input.checked) selected.add(id)
      else selected.delete(id)
      plan = null
      renderComponents()
    }))
  }

  function renderRiskConfirmation(): void {
    const executable = preview!.components.filter(component => selected.has(component.id) && component.sensitivity === 'executable')
    shell(`<section><h3>确认导入后的安全状态</h3><p>导入只恢复定义和历史，不恢复来源电脑的执行授权。</p>
      <div class="profile-export-notice danger"><strong>以下能力不会自动运行</strong><ul><li>自动化全部暂停并清除活动执行</li><li>用户 Skills 进入隔离审查区，不会被 Agent 加载</li><li>插件包保持禁用，权限需要重新审查</li><li>MCP 服务器保持断开和禁用</li><li>工作区在明确重绑定前不可执行会话</li></ul></div>
      ${executable.length ? `<div class="profile-export-notice"><strong>选中了 ${executable.length} 类可执行内容</strong><p>${executable.map(component => COMPONENT_LABELS[component.id]).join('、')}</p></div>` : ''}
      <label class="profile-export-protection ${risksAccepted ? 'selected' : ''}"><input id="profile-import-risk" type="checkbox" ${risksAccepted ? 'checked' : ''}><span><strong>我理解导入后仍需重绑定和重新授权</strong><small>这不会启用任何自动化、插件或 MCP。</small></span></label>
    </section>`)
    windowElement.querySelector<HTMLInputElement>('#profile-import-risk')?.addEventListener('change', event => {
      risksAccepted = (event.target as HTMLInputElement).checked
      renderRiskConfirmation()
    })
  }

  function renderCreate(): void {
    shell(`<section><h3>创建新的用户资料</h3><p>确认后在隔离 staging 中迁移和验证，再原子提交为非活动资料。</p>
      <div class="profile-export-passwords"><label>用户资料名称<input id="profile-import-name" maxlength="80" placeholder="例如：小林的工作资料"></label></div>
      <div class="profile-export-summary"><div><span>组件</span><strong>${selected.size}</strong></div><div><span>来源工作区</span><strong>${preview?.workspaces.length || 0}</strong></div><div><span>当前资料</span><strong>保持不变</strong></div></div>
      ${plan?.blockers.length ? `<div class="profile-export-notice danger"><strong>暂时无法导入</strong><ul>${plan.blockers.map(blocker => `<li>${escapeHtml(blocker.message)} ${escapeHtml(blocker.action)}</li>`).join('')}</ul></div>` : ''}
    </section>`)
    const input = windowElement.querySelector<HTMLInputElement>('#profile-import-name')!
    input.value = displayName || preview?.suggestedProfileName || ''
    displayName = input.value
    input.addEventListener('input', () => { displayName = input.value; plan = null })
  }

  function renderOperation(): void {
    const terminal = terminalPhase(operation!.phase)
    const failed = operation!.phase === 'failed'
    const cancelled = operation!.phase === 'cancelled' || operation!.phase === 'rolled_back'
    const title = failed ? '导入失败' : cancelled ? '导入已回滚' : operation!.phase === 'completed' ? '新资料已创建' : '正在安全导入'
    const details = failed
      ? `<div class="profile-export-notice danger"><strong>${escapeHtml(operation!.error?.message || '导入失败')}</strong><p>${escapeHtml(operation!.error?.action || '请重试。')}</p></div>`
      : cancelled
        ? '<div class="profile-export-notice safe"><strong>当前资料未被修改</strong><p>临时内容已清理；若提交点已跨越，TurboFlux 会在下次启动完成一致性恢复。</p></div>'
        : `<div class="profile-export-progress" role="progressbar" aria-label="导入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(operation!.progress * 100)}"><div><span style="width:${Math.round(operation!.progress * 100)}%"></span></div><strong>${Math.round(operation!.progress * 100)}%</strong></div>`
    shell(`<section><h3>${title}</h3><p>${escapeHtml(operation!.message || '')}</p>${details}</section>`, false)
    windowElement.insertAdjacentHTML('beforeend', `<footer class="profile-export-footer"><span></span><div>${!terminal ? '<button class="profile-export-secondary" data-import-action="cancel">取消导入</button>' : ''}${terminal && operation!.phase !== 'completed' ? '<button class="profile-export-primary" data-import-action="restart">重新开始</button>' : ''}</div></footer>`)
    bindCommon()
  }

  function renderRebindCenter(): void {
    if (viewedConversation) return renderConversation()
    const pending = pendingRebind
    const workspaceCards = rebindState!.workspaces.map(workspace => `<article class="profile-import-workspace ${workspace.state}">
      <div><strong>${escapeHtml(workspace.displayName)}</strong><span>${workspace.conversationCount} 个会话 · ${workspace.state === 'bound' ? `已绑定 ${escapeHtml(workspace.boundFolderName || '')}` : '尚未绑定'}</span></div>
      ${pending?.workspaceId === workspace.id ? `<div class="profile-export-notice danger"><strong>文件夹名称与来源提示不一致</strong><p>来源提示为“${escapeHtml(workspace.sourceHint?.folderName || '未知')}”，当前选择为“${escapeHtml(pending.selection.displayName)}”。只有确认这是同一工作区后才能继续。</p><div class="profile-import-inline-actions"><button class="profile-export-secondary" data-import-action="discard-rebind">重新选择</button><button class="profile-export-primary" data-import-action="confirm-mismatch">确认绑定</button></div></div>` : `<button class="profile-export-secondary" data-rebind-workspace="${workspace.id}">${workspace.state === 'bound' ? '更换文件夹' : '选择本机文件夹'}</button>`}
    </article>`).join('')
    const conversationRows = rebindState!.conversations.map(conversation => `<button class="profile-import-history" data-import-conversation="${conversation.id}"><span><strong>${escapeHtml(conversation.title)}</strong><small>${conversation.turnCount} 条消息 · ${new Date(conversation.updatedAt).toLocaleString()}</small></span><em>只读查看</em></button>`).join('')
    shell(`<section><h3>资料已导入，等待重绑定</h3><p>新资料“${escapeHtml(rebindState!.profile.displayName)}”尚未激活。你可以先只读查看历史，再为每个来源工作区选择本机目录。</p>
      <div class="profile-export-notice safe"><strong>高风险内容保持禁用</strong><p>自动化 ${rebindState!.receipt?.disabled.automations || 0} 项、用户 Skills ${rebindState!.receipt?.disabled.skills || 0} 个文件、插件 ${rebindState!.receipt?.disabled.plugins || 0} 项、MCP ${rebindState!.receipt?.disabled.mcpServers || 0} 项不会自行运行。</p></div>
      <div class="profile-import-workspaces">${workspaceCards || '<div class="settings-inline-note">这份资料没有来源工作区，不需要重绑定。</div>'}</div>
      ${conversationRows ? `<div class="profile-export-section-heading"><div><h3>导入的会话历史</h3><p>查看不会创建工作区目录，也不会启动 Agent Runtime。</p></div></div><div class="profile-import-history-list">${conversationRows}</div>` : ''}
    </section>`, false)
    windowElement.insertAdjacentHTML('beforeend', '<footer class="profile-export-footer"><span>你可以稍后在资料中心继续</span><div><button class="profile-export-primary" data-import-action="done">完成</button></div></footer>')
    bindCommon()
    windowElement.querySelectorAll<HTMLElement>('[data-rebind-workspace]').forEach(button => button.addEventListener('click', () => void chooseRebind(button.dataset.rebindWorkspace!)))
    windowElement.querySelectorAll<HTMLElement>('[data-import-conversation]').forEach(button => button.addEventListener('click', () => void viewConversation(button.dataset.importConversation!)))
    windowElement.querySelector<HTMLElement>('[data-import-action="discard-rebind"]')?.addEventListener('click', () => { pendingRebind = null; renderRebindCenter() })
    windowElement.querySelector<HTMLElement>('[data-import-action="confirm-mismatch"]')?.addEventListener('click', () => void confirmRebind(true))
  }

  function renderConversation(): void {
    const turns = viewedConversation!.turns.map(turn => `<article class="profile-import-turn ${turn.role}"><strong>${turn.role === 'user' ? '用户' : turn.role === 'assistant' ? 'TurboFlux' : '工具结果'}</strong><p>${escapeHtml(turn.content)}</p></article>`).join('')
    shell(`<section><button class="profile-export-secondary" data-import-action="back-rebind">← 返回重绑定中心</button><div class="profile-import-conversation-head"><h3>${escapeHtml(viewedConversation!.title)}</h3><p>只读历史 · 不会继续执行</p></div><div class="profile-import-turns">${turns || '<p>这段会话没有消息。</p>'}</div></section>`, false)
    windowElement.querySelector<HTMLElement>('[data-import-action="back-rebind"]')?.addEventListener('click', () => { viewedConversation = null; renderRebindCenter() })
  }

  function bindCommon(): void {
    windowElement.querySelector<HTMLElement>('.profile-export-close')?.addEventListener('click', close)
    windowElement.querySelectorAll<HTMLElement>('[data-import-action="back"]').forEach(button => button.addEventListener('click', () => { step = Math.max(0, step - 1); render() }))
    windowElement.querySelectorAll<HTMLElement>('[data-import-action="next"]').forEach(button => button.addEventListener('click', () => void next()))
    windowElement.querySelectorAll<HTMLElement>('[data-import-action="cancel"]').forEach(button => button.addEventListener('click', () => void cancel()))
    windowElement.querySelectorAll<HTMLElement>('[data-import-action="done"]').forEach(button => button.addEventListener('click', close))
    windowElement.querySelectorAll<HTMLElement>('[data-import-action="restart"]').forEach(button => button.addEventListener('click', () => void open()))
  }

  async function chooseSource(): Promise<void> {
    try {
      const result = await bridge.chooseProfileImportSource()
      if (result.canceled) return
      source = result
      preview = null
      plan = null
      operation = null
      password = ''
      displayName = ''
      risksAccepted = false
      render()
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function authenticate(): Promise<boolean> {
    if (!source) return false
    if (source.encrypted && !password) return options.showToast('请输入资料包密码'), false
    busy = true
    render()
    try {
      preview = await bridge.inspectProfileImport({ pathToken: source.token, password: source.encrypted ? password : undefined })
      selected = new Set(preview.components.filter(component => component.defaultSelected && component.supported).map(component => component.id))
      displayName = preview.suggestedProfileName
      return true
    } catch (error) {
      options.showToast(presentDesktopError(error))
      return false
    } finally {
      busy = false
    }
  }

  async function next(): Promise<void> {
    if (busy || activeOperation()) return
    if (step === 0 && !source) return options.showToast('请先选择资料包文件')
    if (step === 1 && !(await authenticate())) return render()
    if (step === 3 && selected.size === 0) return options.showToast('请至少选择一项内容')
    if (step === 4 && !risksAccepted) return options.showToast('请确认导入后的安全状态')
    if (step < 5) {
      step += 1
      render()
      return
    }
    await startImport()
  }

  async function startImport(): Promise<void> {
    if (!source || !preview || !displayName.trim()) return options.showToast('请输入新资料名称')
    busy = true
    render()
    try {
      plan = await bridge.planProfileImport({ pathToken: source.token, archiveId: preview.archiveId, selectedComponents: [...selected], displayName: displayName.trim() })
      if (plan.blockers.length) return render()
      const reference = await bridge.startProfileImport({ planId: plan.planId, password: source.encrypted ? password : undefined })
      password = ''
      operation = await bridge.getProfileArchiveOperation(reference.operationId)
      poll(reference.operationId)
    } catch (error) {
      options.showToast(presentDesktopError(error))
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
        if (operation.phase === 'completed' && operation.result?.profileId) {
          profileChanged = true
          rebindState = await bridge.getProfileImportRebindState(operation.result.profileId)
          operation = null
        }
        render()
        if (operation && !terminalPhase(operation.phase)) poll(operationId)
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

  async function chooseRebind(workspaceId: string): Promise<void> {
    try {
      const result = await bridge.chooseProfileRebindFolder(rebindState!.profile.id, workspaceId)
      if (result.canceled) return
      pendingRebind = { workspaceId, selection: result }
      if (result.mismatch) return renderRebindCenter()
      await confirmRebind(false)
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function confirmRebind(acceptMismatch: boolean): Promise<void> {
    if (!pendingRebind || !rebindState) return
    busy = true
    try {
      await bridge.confirmProfileRebind({
        profileId: rebindState.profile.id,
        workspaceId: pendingRebind.workspaceId,
        pathToken: pendingRebind.selection.token,
        acceptMismatch,
      })
      profileChanged = true
      pendingRebind = null
      rebindState = await bridge.getProfileImportRebindState(rebindState.profile.id)
      renderRebindCenter()
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      busy = false
    }
  }

  async function viewConversation(conversationId: string): Promise<void> {
    try {
      viewedConversation = await bridge.getProfileImportedConversation(rebindState!.profile.id, conversationId)
      renderConversation()
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function open(): Promise<void> {
    if (!overlay.classList.contains('open')) returnFocusTarget = captureProfileDialogReturnFocus(document.activeElement)
    overlay.classList.add('open')
    overlay.setAttribute('aria-hidden', 'false')
    source = null
    preview = null
    selected = new Set()
    plan = null
    operation = null
    rebindState = null
    viewedConversation = null
    pendingRebind = null
    password = ''
    displayName = ''
    risksAccepted = false
    profileChanged = false
    step = 0
    render()
    windowElement.querySelector<HTMLElement>('button, input')?.focus()
    options.onVisibilityChange?.(true)
  }

  async function openRebind(profileId: string): Promise<void> {
    returnFocusTarget = captureProfileDialogReturnFocus(document.activeElement)
    overlay.classList.add('open')
    overlay.setAttribute('aria-hidden', 'false')
    source = null
    preview = null
    selected = new Set()
    plan = null
    operation = null
    viewedConversation = null
    pendingRebind = null
    password = ''
    displayName = ''
    risksAccepted = false
    profileChanged = false
    busy = true
    windowElement.innerHTML = '<div class="profile-export-loading">正在读取导入资料…</div>'
    options.onVisibilityChange?.(true)
    try {
      rebindState = await bridge.getProfileImportRebindState(profileId)
      renderRebindCenter()
      windowElement.querySelector<HTMLElement>('button, input')?.focus()
    } catch (error) {
      options.showToast(presentDesktopError(error))
      close()
    } finally {
      busy = false
    }
  }

  function close(): void {
    if (activeOperation()) return
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    password = ''
    overlay.classList.remove('open')
    overlay.setAttribute('aria-hidden', 'true')
    const restoreFocus = () => restoreProfileDialogReturnFocus(returnFocusTarget)
    restoreFocus()
    options.onVisibilityChange?.(false, { profileChanged, restoreFocus })
  }

  overlay.addEventListener('click', event => { if (event.target === overlay && !activeOperation()) close() })
  overlay.addEventListener('keydown', event => {
    if (handleProfileDialogEscape(event, !activeOperation(), close)) return
    trapProfileDialogFocus(event, windowElement)
  })
  return { open, openRebind, close, isOpen: () => overlay.classList.contains('open') }
}
