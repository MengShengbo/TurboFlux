import type {
  WorkbenchApiConfigInput,
  WorkbenchMcpServerInput,
  WorkbenchMemoryFilters,
  WorkbenchMemorySnapshot,
  WorkbenchModelOption,
  WorkbenchWorkPackSnapshot,
  WorkbenchSettingsSnapshot,
  WorkbenchSettingsUpdate,
  WorkbenchSnapshot,
  AgentCapabilityReference,
  NativeReasoningConfig,
} from '@turboflux/agent-core/workbench'
import {
  buildReasoningOptions,
  effectiveReasoningConfig,
  reasoningBudgetLabel,
  reasoningEffortLabel,
  reasoningOptionIndex,
  reasoningSliderDetentIndex,
  reasoningSliderDetentValue,
  reasoningSliderIndex,
  reasoningSliderProgress,
} from './reasoningPresentation'
import type { ComputerControlsController } from './computerControls'
import { presentDesktopError } from './conversationRendering'
import { modelProviderMark, normalizedModelProvider } from './modelPresentation'
import {
  anchoredComposerPopoverPosition,
  type ComposerPopoverPlacement,
} from './composerPopoverPlacement'
import {
  currentThemePreference,
  setThemePreference,
  type ThemePreference,
} from './theme'
import {
  applyBackgroundMediaSnapshot,
  backgroundBrightnessMultiplier,
  currentBackgroundMediaSettings,
  currentBackgroundMediaSnapshot,
  normalizeWindowOpacity,
  setBackgroundMediaSettings,
  type BackgroundMediaFit,
  type BackgroundMediaSettings,
} from './backgroundMedia'
import { createProfileExportWizard } from './profileExportWizard'
import { createProfileImportWizard } from './profileImportWizard'
import { createProfileCenter, type ProfileCenterController } from './profileCenter'
import { createApiSettingsPage } from './apiSettings'
import { applyApiModel, applyApiModelCapabilities } from './apiSettingsModel'
import { renderLocalExtensions } from './localExtensionsView'

type SettingsSection = 'appearance' | 'api' | 'mcp' | 'computer' | 'remote' | 'workpacks' | 'memory' | 'persona' | 'permissions' | 'data' | 'advanced'
type SettingsGroup = 'basics' | 'capabilities' | 'system'

interface SettingsSectionMeta {
  id: SettingsSection
  title: string
  subtitle: string
  group: SettingsGroup
  icon: 'appearance' | 'model' | 'plug' | 'computer' | 'remote' | 'skills' | 'plugins' | 'memory' | 'persona' | 'shield' | 'advanced'
  keywords: string
}

interface SettingsCenterOptions {
  showToast(message: string): void
  onSnapshot(snapshot: WorkbenchSnapshot): void
  onOpenConversation(conversationId: string): Promise<void>
  onUseCapability(capability: AgentCapabilityReference): Promise<void>
  onOpen?(): Promise<void> | void
  onClose?(): void
  computerControls?: ComputerControlsController
  getComposerPopoverPlacement?(): ComposerPopoverPlacement
}

export interface SettingsCenterController {
  open(section?: SettingsSection): Promise<void>
  openProfiles(mode?: 'library' | 'create' | 'import'): Promise<void>
  openModelPicker(anchor: HTMLElement): Promise<void>
  openReasoningPicker(anchor: HTMLElement): Promise<void>
  repositionComposerPicker(): void
  close(): void
  isOpen(): boolean
  handleSettingsUpdate(settings: WorkbenchSettingsSnapshot): void
}

const sectionGroups: Array<[SettingsGroup, string]> = [
  ['basics', '基础'],
  ['capabilities', '能力与集成'],
  ['system', '系统'],
]

const sectionLabels: SettingsSectionMeta[] = [
  { id: 'api', title: '模型与 API', subtitle: '连接、模型与推理', group: 'basics', icon: 'model', keywords: '供应商 密钥 base url provider reasoning' },
  { id: 'appearance', title: '外观', subtitle: '主题与背景', group: 'basics', icon: 'appearance', keywords: '外观 主题 深色 浅色 dark light system appearance' },
  { id: 'persona', title: '人设与语言', subtitle: '行为风格与全局指令', group: 'basics', icon: 'persona', keywords: '语言 风格 persona prompt instructions' },
  { id: 'permissions', title: '权限与审批', subtitle: '工具边界与确认策略', group: 'basics', icon: 'shield', keywords: 'approval policy git sandbox 安全' },
  { id: 'workpacks', title: '插件', subtitle: '安装与管理本地插件', group: 'capabilities', icon: 'skills', keywords: '插件 能力 安装 工作流 工具 集成' },
  { id: 'mcp', title: 'MCP', subtitle: '外部连接与工具', group: 'capabilities', icon: 'plug', keywords: 'server tools 插件 服务' },
  { id: 'computer', title: '电脑操控', subtitle: '系统权限与接管边界', group: 'capabilities', icon: 'computer', keywords: 'computer use accessibility screen recording 辅助功能 屏幕录制' },
  { id: 'remote', title: '手机远程', subtitle: '端到端加密与设备确认', group: 'capabilities', icon: 'remote', keywords: 'remote mobile p2p 手机 远程 配对 https 二维码 设备' },
  { id: 'memory', title: '长期记忆', subtitle: '审核、编辑与遗忘', group: 'capabilities', icon: 'memory', keywords: 'memory 记忆 规则 偏好 审核 固定 删除' },
  { id: 'data', title: '用户资料', subtitle: '本机用户、迁移与恢复', group: 'system', icon: 'advanced', keywords: 'profile export archive backup migrate 用户 资料 导出 迁移 备份' },
  { id: 'advanced', title: '高级', subtitle: '模型元数据与运行参数', group: 'system', icon: 'advanced', keywords: 'metadata runtime context tokens' },
]

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function settingsSystemIcon(name: string): string {
  if (name === 'browser') return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/><circle cx="7" cy="6.75" r=".65"/><circle cx="10" cy="6.75" r=".65"/></svg>'
  if (name === 'computer') return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="12" rx="2.5"/><path d="M8 20h8M12 16.5V20"/><path d="M8 9h8M8 12h5"/></svg>'
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5v4M16 4.5v4M6 8.5h12v2a6 6 0 0 1-6 6v3"/><path d="M9 19.5h6"/></svg>'
}

function settingsInlineIcon(name: 'plus' | 'minus' | 'close' | 'search' | 'back' | 'check' | 'info'): string {
  const paths: Record<typeof name, string> = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}












function settingsNavIcon(name: SettingsSectionMeta['icon']): string {
  const paths: Record<SettingsSectionMeta['icon'], string> = {
    appearance: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
    model: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    plug: '<path d="M8 4v5m8-5v5M6 9h12v1a6 6 0 0 1-6 6v4m-3 0h6"/>',
    computer: '<rect x="3.5" y="4.5" width="17" height="12" rx="2.5"/><path d="M8 20h8M12 16.5V20"/>',
    remote: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10 5h4M11 18.5h2"/><path d="M3 8.5h2M19 8.5h2M3 13.5h2M19 13.5h2"/>',
    skills: '<path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    plugins: '<path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-6 6v5m-3 0h6"/><path d="M8 8h8"/>',
    memory: '<path d="M7 5.5A3.5 3.5 0 0 1 10.5 2H12v20h-1.5A3.5 3.5 0 0 1 7 18.5a3.5 3.5 0 0 1-1.1-6.9A3.5 3.5 0 0 1 7 5.5Z"/><path d="M17 5.5A3.5 3.5 0 0 0 13.5 2H12v20h1.5a3.5 3.5 0 0 0 3.5-3.5 3.5 3.5 0 0 0 1.1-6.9A3.5 3.5 0 0 0 17 5.5Z"/>',
    persona: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
    shield: '<path d="M12 3.5 19 6v5.4c0 4.2-2.9 7.5-7 9.1-4.1-1.6-7-4.9-7-9.1V6z"/><path d="m9 12 2 2 4-4"/>',
    advanced: '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h7m4 0h5"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
  }
  return `<span class="settings-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${paths[name]}</svg></span>`
}

function settingsNavigationMarkup(): string {
  return sectionGroups.map(([group, label]) => {
    const items = sectionLabels.filter(item => item.group === group)
    return `<section class="settings-nav-group" data-settings-group="${group}">
      <div class="settings-nav-group-label">${label}</div>
      <div class="settings-nav-items">${items.map(item => `<button data-settings-section="${item.id}" aria-label="${item.title}" title="${item.title}" data-settings-search="${escapeHtml(`${item.title} ${item.subtitle} ${item.keywords}`.toLowerCase())}">${settingsNavIcon(item.icon)}<strong>${item.title}</strong></button>`).join('')}</div>
    </section>`
  }).join('')
}

export function createSettingsUpdate(snapshot: WorkbenchSettingsSnapshot): WorkbenchSettingsUpdate {
  return {
    activeApiConfigId: snapshot.activeApiConfigId,
    approvalPolicy: snapshot.approvalPolicy,
    capabilityProfile: snapshot.capabilityProfile,
    gitEnabled: snapshot.gitEnabled,
    mcpServers: snapshot.mcpServers.filter(server => !server.system).map(server => ({
      name: server.name,
      enabled: server.enabled,
      command: server.command,
      args: server.args ? [...server.args] : undefined,
      url: server.url,
      cwd: server.cwd,
      startupTimeoutMs: server.startupTimeoutMs,
      toolTimeoutMs: server.toolTimeoutMs,
      enabledTools: server.enabledTools ? [...server.enabledTools] : undefined,
      disabledTools: server.disabledTools ? [...server.disabledTools] : undefined,
      preserveEnv: server.envKeys.length > 0,
      preserveHttpHeaders: server.headerKeys.length > 0,
    })),
    apiProfiles: snapshot.apiProfiles.map(({ hasApiKey: _hasApiKey, apiKeyPreview: _apiKeyPreview, ...profile }) => ({
      ...profile,
      apiKey: '',
      reasoning: profile.reasoning ? { ...profile.reasoning } : undefined,
    })),
    profile: {
      ...snapshot.profile,
      enabledPersonaIds: [...snapshot.profile.enabledPersonaIds],
    },
  }
}

function mcpStatusLabel(status: string): string {
  return ({
    disabled: '已停用',
    disconnected: '未连接',
    connecting: '连接中',
    connected: '已连接',
    error: '连接失败',
    closed: '已关闭',
  } as Record<string, string>)[status] || status
}

function selectedProfile(draft: WorkbenchSettingsUpdate): WorkbenchApiConfigInput | undefined {
  return draft.apiProfiles.find(profile => profile.id === draft.activeApiConfigId) ?? draft.apiProfiles[0]
}

function modelFor(settings: WorkbenchSettingsSnapshot, id: string): WorkbenchModelOption | undefined {
  return settings.models.find(model => model.model === id || model.id === id)
}

function reasoningLabel(config?: NativeReasoningConfig): string {
  if (!config) return '默认'
  if (config.enabled === false || config.effort === 'none') return '关闭'
  if (config.budgetTokens) return reasoningBudgetLabel(config.budgetTokens)
  return config.effort ? reasoningEffortLabel(config.effort) : '开启'
}

export function settingsFieldMarkup(label: string, control: string, hint = ''): string {
  return `<label class="settings-field"><span>${escapeHtml(label)}</span>${control}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</label>`
}

const field = settingsFieldMarkup

function settingsRow(title: string, description: string, control: string, className = ''): string {
  return `<div class="settings-row ${className}"><div class="settings-row-copy"><strong>${title}</strong>${description ? `<span>${description}</span>` : ''}</div><div class="settings-row-control">${control}</div></div>`
}

export function createSettingsCenter(
  app: HTMLDivElement,
  bridge: TurboFluxDesktopBridge,
  options: SettingsCenterOptions,
): SettingsCenterController {
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.innerHTML = `
    <section class="settings-window" role="dialog" aria-modal="true" aria-label="TurboFlux 设置">
      <aside class="settings-nav">
        <div class="settings-nav-drag-region" aria-hidden="true"></div>
        <button class="settings-back" id="settings-back" aria-label="返回应用"><span class="settings-back-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></span><span>返回应用</span></button>
        <label class="settings-search"><span aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg></span><input id="settings-search" type="search" placeholder="搜索设置…" autocomplete="off" spellcheck="false"><kbd>⌘F</kbd></label>
        <div class="settings-nav-scroll">${settingsNavigationMarkup()}<div class="settings-nav-empty" id="settings-nav-empty" hidden>没有匹配的设置</div></div>
      </aside>
      <main class="settings-main">
        <header class="settings-header"><div class="settings-header-inner"><h2 id="settings-title">模型与 API</h2></div></header>
        <div class="settings-content" id="settings-content"><div class="settings-loading">正在读取设置…</div></div>
        <footer class="settings-footer"><div class="settings-footer-inner"><span id="settings-state">修改后需要保存</span><div><button class="settings-secondary" id="settings-cancel">取消</button><button class="settings-primary" id="settings-save">保存更改</button></div></div></footer>
      </main>
    </section>`
  app.append(overlay)

  const popover = document.createElement('section')
  popover.className = 'model-popover'
  popover.setAttribute('aria-hidden', 'true')
  app.append(popover)
  let profileCenter: ProfileCenterController | null = null
  const archiveWizardVisibility = (open: boolean, state?: { profileChanged: boolean; restoreFocus(): void }) => {
    overlay.setAttribute('aria-hidden', open ? 'true' : 'false')
    if (!open && state?.profileChanged && section === 'data') {
      void profileCenter?.refresh().finally(state.restoreFocus)
    }
  }
  const profileExportWizard = createProfileExportWizard(app, bridge, { showToast: options.showToast, onVisibilityChange: archiveWizardVisibility })
  const profileImportWizard = createProfileImportWizard(app, bridge, { showToast: options.showToast, onVisibilityChange: archiveWizardVisibility })

  const content = overlay.querySelector<HTMLDivElement>('#settings-content')!
  const settingsWindow = overlay.querySelector<HTMLElement>('.settings-window')!
  const desktopShell = app.querySelector<HTMLElement>('.desktop-shell')
  const saveButton = overlay.querySelector<HTMLButtonElement>('#settings-save')!
  const stateLabel = overlay.querySelector<HTMLElement>('#settings-state')!
  const searchInput = overlay.querySelector<HTMLInputElement>('#settings-search')!
  const navEmpty = overlay.querySelector<HTMLElement>('#settings-nav-empty')!
  const backButton = overlay.querySelector<HTMLButtonElement>('#settings-back')!
  let settings: WorkbenchSettingsSnapshot | null = null
  let draft: WorkbenchSettingsUpdate | null = null
  let baseline = ''
  let section: SettingsSection = 'api'
  let selectedMcpName = ''
  let activePickerAnchor: HTMLElement | null = null
  let activePickerWidth = 252
  let loading: Promise<void> | null = null
  let workPackPage: 'catalog' | 'detail' = 'catalog'
  let workPacks: WorkbenchWorkPackSnapshot | null = null
  let workPacksLoading = false
  let workPacksError = ''
  let workPackSearch = ''
  let selectedWorkPackId = ''
  let workPackBusyId = ''
  let memorySnapshot: WorkbenchMemorySnapshot | null = null
  let memoryLoading = false
  let memoryEditorId: string | null | undefined
  let memorySearchTimer: ReturnType<typeof setTimeout> | null = null
  const memoryFilters: WorkbenchMemoryFilters = { includeInactive: true }
  let previousFocus: HTMLElement | null = null
  let remoteStatus: DesktopRemoteHostStatus | null = null
  let remotePairing: DesktopRemotePairingCode | null = null
  let remotePublicEndpointDraft: string | undefined
  let remoteClientUrlDraft: string | undefined
  let remoteLoading = false
  let remoteRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let hostPreferences: DesktopHostPreferences | null = null
  const apiSettings = createApiSettingsPage(bridge, { onChange: updateDirtyState, showToast: options.showToast })
  profileCenter = createProfileCenter(bridge, {
    showToast: options.showToast,
    onSnapshot: options.onSnapshot,
    openExport: () => profileExportWizard.open(),
    openImport: () => profileImportWizard.open(),
    openRebind: profileId => profileImportWizard.openRebind(profileId),
    openConversation: async conversationId => {
      close()
      await options.onOpenConversation(conversationId)
    },
    close: () => close(),
    async onProfileSwitched() {
      settings = await bridge.getSettings(true)
      draft = createSettingsUpdate(settings)
      baseline = serializedDraft()
      workPacks = null
      memorySnapshot = null
      remoteStatus = null
      remotePairing = null
      if (section === 'data') profileCenter?.render(content)
    },
  })

  function filterNavigation(value: string): void {
    const query = value.trim().toLocaleLowerCase()
    let visibleCount = 0
    overlay.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach(button => {
      const visible = !query || (button.dataset.settingsSearch || '').includes(query)
      button.hidden = !visible
      if (visible) visibleCount += 1
    })
    overlay.querySelectorAll<HTMLElement>('[data-settings-group]').forEach(group => {
      group.hidden = !group.querySelector('[data-settings-section]:not([hidden])')
    })
    navEmpty.hidden = visibleCount > 0
  }

  function serializedDraft(): string {
    return JSON.stringify(draft)
  }

  function updateDirtyState(): void {
    const dirty = Boolean(draft && serializedDraft() !== baseline)
    saveButton.disabled = !dirty
    stateLabel.dataset.dirty = String(dirty)
    stateLabel.textContent = dirty ? '有未保存的更改' : section === 'api' ? '所有更改已保存' : '修改后需要保存'
  }

  function handleSettingsUpdate(next: WorkbenchSettingsSnapshot): void {
    const wasDirty = Boolean(draft && serializedDraft() !== baseline)
    settings = next
    if (!wasDirty) {
      draft = createSettingsUpdate(next)
      baseline = serializedDraft()
    }
    if (isOpen() && section !== 'appearance') {
      renderSection()
      updateDirtyState()
    }
    if (popover.classList.contains('model-only-popover') && activePickerAnchor?.isConnected) {
      const anchor = activePickerAnchor
      hidePicker()
      void openModelPicker(anchor)
    }
  }

  async function ensureSettings(force = false): Promise<void> {
    if (settings && !force) return
    if (loading) return loading
    loading = bridge.getSettings(force).then(snapshot => {
      settings = snapshot
      draft = createSettingsUpdate(snapshot)
      baseline = serializedDraft()
    }).finally(() => {
      loading = null
    })
    return loading
  }

  function renderApi(): void {
    if (settings && draft) apiSettings.render(content, settings, draft)
  }

  function bindText(selector: string, update: (value: string) => void): void {
    content.querySelector<HTMLInputElement>(selector)?.addEventListener('input', event => {
      update((event.target as HTMLInputElement).value)
      updateDirtyState()
    })
  }

  function mcpDrafts(): WorkbenchMcpServerInput[] {
    if (!draft) return []
    draft.mcpServers ||= []
    return draft.mcpServers
  }

  function selectedMcp(): WorkbenchMcpServerInput | undefined {
    const servers = mcpDrafts()
    return servers.find(server => server.name === selectedMcpName) || servers[0]
  }

  function splitValues(value: string): string[] | undefined {
    const values = value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
    return values.length > 0 ? values : undefined
  }

  function parseRecord(value: string, label: string): Record<string, string> | undefined {
    if (!value.trim()) return undefined
    const parsed = JSON.parse(value) as unknown
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label} 必须是 JSON 对象`)
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]))
  }

  function renderMcp(): void {
    if (!settings || !draft) return
    const systemServers = settings.mcpServers.filter(server => server.system)
    const servers = mcpDrafts()
    const server = selectedMcp()
    if (server && !selectedMcpName) selectedMcpName = server.name
    const systemMarkup = systemServers.length > 0
      ? `<div class="settings-section-head"><div><h3>内置能力</h3><p>随 TurboFlux 桌面端提供，由核心维护，不会写入项目 MCP 配置。</p></div></div>
        <div class="system-plugin-list">${systemServers.map(item => `
          <article class="system-plugin-row">
            <span class="system-plugin-glyph" aria-hidden="true">${settingsSystemIcon(item.name)}</span>
            <div class="system-plugin-copy"><div><strong>${escapeHtml(item.displayName || item.name)}</strong><small>系统内置</small></div><p>${escapeHtml(item.description || 'TurboFlux 内置能力')}</p></div>
            <div class="system-plugin-state ${escapeHtml(item.status)}"><span></span><strong>${escapeHtml(mcpStatusLabel(item.status))}</strong><small>${item.tools.length} 个工具</small></div>
          </article>`).join('')}</div>`
      : ''
    if (!server) {
      content.innerHTML = `${systemMarkup}<div class="settings-section-head external-mcp-heading"><div><h3>外部连接</h3><p>添加本地命令或 HTTP MCP 服务，让智能代理获得额外能力。</p></div></div><div class="settings-empty"><strong>还没有外部 MCP 连接</strong><p>内置能力保持只读，外部服务会保存到当前项目。</p><button class="settings-primary" id="mcp-add-empty">添加连接</button></div>`
      content.querySelector('#mcp-add-empty')?.addEventListener('click', addMcp)
      return
    }
    const summary = settings.mcpServers.find(item => item.name === server.name)
    const transport = server.url ? 'http' : 'stdio'
    content.innerHTML = `
      ${systemMarkup}
      <div class="settings-section-head external-mcp-heading"><div><h3>外部连接</h3><p>连接外部工具服务。敏感环境变量和请求头不会回显，留空会保留已有值。</p></div><button class="settings-secondary" id="mcp-reconnect">重新连接</button></div>
      <div class="api-profile-toolbar">
        <select id="mcp-select">${servers.map(item => `<option value="${escapeHtml(item.name)}" ${item === server ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>
        <button class="settings-icon-action" id="mcp-add" title="添加 MCP">${settingsInlineIcon('plus')}</button>
        <button class="settings-icon-action danger" id="mcp-delete" title="删除 MCP">${settingsInlineIcon('minus')}</button>
      </div>
      <div class="settings-card settings-grid-two">
        ${field('名称', `<input id="mcp-name" value="${escapeHtml(server.name)}" spellcheck="false">`)}
        ${field('连接方式', `<select id="mcp-transport"><option value="stdio" ${transport === 'stdio' ? 'selected' : ''}>本地命令</option><option value="http" ${transport === 'http' ? 'selected' : ''}>HTTP</option></select>`)}
        <label class="settings-switch"><input id="mcp-enabled" type="checkbox" ${server.enabled ? 'checked' : ''}><span></span><b>启用此连接</b></label>
        <div class="mcp-status ${escapeHtml(summary?.status || 'disconnected')}"><span></span><strong>${escapeHtml(summary ? mcpStatusLabel(summary.status) : '尚未保存')}</strong>${summary?.error ? `<small>${escapeHtml(summary.error)}</small>` : ''}</div>
      </div>
      <div class="settings-card settings-grid-two">
        ${transport === 'http'
          ? field('服务地址', `<input id="mcp-url" value="${escapeHtml(server.url || '')}" placeholder="https://example.com/mcp" spellcheck="false">`)
          : `${field('命令', `<input id="mcp-command" value="${escapeHtml(server.command || '')}" placeholder="npx" spellcheck="false">`)}${field('参数', `<textarea id="mcp-args" rows="4" placeholder="每行一个参数">${escapeHtml((server.args || []).join('\n'))}</textarea>`)}`}
        ${field('工作目录', `<input id="mcp-cwd" value="${escapeHtml(server.cwd || '')}" placeholder="默认继承当前工作区" spellcheck="false">`)}
      </div>
      <div class="settings-card settings-grid-two">
        ${field('环境变量 JSON', `<textarea id="mcp-env" rows="5" placeholder="${summary?.envKeys.length ? `已保存：${escapeHtml(summary.envKeys.join(', '))} · 留空保持` : '{&quot;TOKEN&quot;:&quot;...&quot;}'}</textarea>`)}
        ${field('HTTP Headers JSON', `<textarea id="mcp-headers" rows="5" placeholder="${summary?.headerKeys.length ? `已保存：${escapeHtml(summary.headerKeys.join(', '))} · 留空保持` : '{&quot;Authorization&quot;:&quot;Bearer ...&quot;}'}</textarea>`)}
        ${field('启用工具', `<textarea id="mcp-enabled-tools" rows="3" placeholder="留空表示全部">${escapeHtml((server.enabledTools || []).join('\n'))}</textarea>`)}
        ${field('禁用工具', `<textarea id="mcp-disabled-tools" rows="3" placeholder="每行一个工具名">${escapeHtml((server.disabledTools || []).join('\n'))}</textarea>`)}
      </div>
      <div class="settings-card"><div class="settings-card-title"><strong>已发现工具</strong><span>${summary?.tools.length || 0}</span></div><div class="mcp-tool-list">${summary?.tools.length ? summary.tools.map(tool => `<div><strong>${escapeHtml(tool.name.replace(`${server.name}__`, ''))}</strong><small>${escapeHtml(tool.description || '无描述')}</small></div>`).join('') : '<p class="settings-card-copy">连接成功后会在这里显示可用工具。</p>'}</div></div>
    `
    content.querySelector<HTMLSelectElement>('#mcp-select')!.addEventListener('change', event => {
      selectedMcpName = (event.target as HTMLSelectElement).value
      renderSection()
    })
    content.querySelector('#mcp-add')?.addEventListener('click', addMcp)
    content.querySelector('#mcp-delete')?.addEventListener('click', deleteMcp)
    content.querySelector('#mcp-reconnect')?.addEventListener('click', () => void reconnectMcp())
    bindText('#mcp-name', value => {
      const previous = server.name
      server.name = value
      selectedMcpName = value || previous
    })
    content.querySelector<HTMLSelectElement>('#mcp-transport')!.addEventListener('change', event => {
      if ((event.target as HTMLSelectElement).value === 'http') {
        server.url ||= 'https://'
      } else {
        server.url = undefined
        server.command ||= 'npx'
      }
      renderSection()
      updateDirtyState()
    })
    content.querySelector<HTMLInputElement>('#mcp-enabled')!.addEventListener('change', event => {
      server.enabled = (event.target as HTMLInputElement).checked
      updateDirtyState()
    })
    bindText('#mcp-url', value => { server.url = value })
    bindText('#mcp-command', value => { server.command = value })
    bindText('#mcp-cwd', value => { server.cwd = value })
    content.querySelector<HTMLTextAreaElement>('#mcp-args')?.addEventListener('input', event => {
      server.args = splitValues((event.target as HTMLTextAreaElement).value)
      updateDirtyState()
    })
    content.querySelector<HTMLTextAreaElement>('#mcp-enabled-tools')!.addEventListener('input', event => {
      server.enabledTools = splitValues((event.target as HTMLTextAreaElement).value)
      updateDirtyState()
    })
    content.querySelector<HTMLTextAreaElement>('#mcp-disabled-tools')!.addEventListener('input', event => {
      server.disabledTools = splitValues((event.target as HTMLTextAreaElement).value)
      updateDirtyState()
    })
    const bindRecord = (selector: string, key: 'env' | 'httpHeaders', preserveKey: 'preserveEnv' | 'preserveHttpHeaders', label: string) => {
      content.querySelector<HTMLTextAreaElement>(selector)!.addEventListener('change', event => {
        try {
          const value = (event.target as HTMLTextAreaElement).value
          const record = parseRecord(value, label)
          if (record) {
            server[key] = record
            server[preserveKey] = false
          }
          updateDirtyState()
        } catch (error) {
          options.showToast(presentDesktopError(error))
        }
      })
    }
    bindRecord('#mcp-env', 'env', 'preserveEnv', '环境变量')
    bindRecord('#mcp-headers', 'httpHeaders', 'preserveHttpHeaders', '请求头')
  }

  function addMcp(): void {
    const servers = mcpDrafts()
    let index = servers.length + 1
    let name = `mcp-${index}`
    while (servers.some(server => server.name === name)) name = `mcp-${++index}`
    servers.push({ name, enabled: true, command: 'npx', args: [], preserveEnv: false, preserveHttpHeaders: false })
    selectedMcpName = name
    renderSection()
    updateDirtyState()
  }

  function deleteMcp(): void {
    if (!draft) return
    const server = selectedMcp()
    if (!server) return
    draft.mcpServers = mcpDrafts().filter(item => item !== server)
    selectedMcpName = draft.mcpServers[0]?.name || ''
    renderSection()
    updateDirtyState()
  }

  async function reconnectMcp(): Promise<void> {
    const server = selectedMcp()
    if (!server) return
    if (serializedDraft() !== baseline && !await save()) return
    try {
      settings = await bridge.reconnectMcp(server.name)
      draft = createSettingsUpdate(settings)
      baseline = serializedDraft()
      renderSection()
      options.showToast('MCP 已重新连接')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  function renderPersona(): void {
    if (!settings || !draft) return
    const profile = draft.profile
    const enabled = new Set(profile.enabledPersonaIds || [])
    const personas = settings.personas.filter(persona => !persona.isCustom)
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>语言与行为</h3><p>这些设置会组成 TurboFlux 的全局行为与输出偏好。</p></div></div>
      <div class="settings-card settings-grid-two">
        ${field('界面语言', `<select id="interface-language"><option value="zh-CN" ${profile.interfaceLanguage === 'zh-CN' ? 'selected' : ''}>简体中文</option><option value="en" ${profile.interfaceLanguage === 'en' ? 'selected' : ''}>英语</option></select>`)}
        ${field('模型输出语言', `<select id="output-language"><option value="follow-user">跟随用户</option><option value="zh-CN">简体中文</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="custom">自定义</option></select>`)}
        ${field('默认人设', `<select id="default-persona">${settings.personas.map(persona => `<option value="${persona.id}" ${persona.id === profile.defaultPersonaId ? 'selected' : ''}>${escapeHtml(persona.nameZh)}</option>`).join('')}</select>`)}
        ${field('自定义输出语言', `<input id="custom-output-language" value="${escapeHtml(profile.customAiOutputLanguage || '')}" placeholder="例如：粤语、德语">`)}
      </div>
      <div class="settings-card"><div class="settings-card-title"><strong>可用人设</strong><span>选择会出现在切换列表中的内置人设</span></div><div class="persona-grid">${personas.map(persona => `<label class="persona-option"><input type="checkbox" data-persona-id="${persona.id}" ${enabled.has(persona.id) ? 'checked' : ''}><span><strong>${escapeHtml(persona.nameZh)}</strong><small>${escapeHtml(persona.descriptionZh)}</small></span></label>`).join('')}</div></div>
      <div class="settings-card settings-grid-two">
        ${field('自定义人设名称', `<input id="custom-persona-name" value="${escapeHtml(profile.customPersonaName || '')}" placeholder="我的人设">`)}
        ${field('自定义人设提示词', `<textarea id="custom-persona-prompt" rows="5" placeholder="描述智能助手的身份、风格与行为边界">${escapeHtml(profile.customPersonaPrompt || '')}</textarea>`)}
      </div>
      <div class="settings-card">${field('全局指令', `<textarea id="custom-instructions" rows="7" placeholder="会附加到所有人设之后，例如你的工作习惯、输出偏好和长期约束">${escapeHtml(profile.customInstructions || '')}</textarea>`)}</div>
    `
    const output = content.querySelector<HTMLSelectElement>('#output-language')!
    output.value = String(profile.aiOutputLanguage || 'follow-user')
    content.querySelector<HTMLSelectElement>('#interface-language')!.addEventListener('change', event => updateProfileData('interfaceLanguage', (event.target as HTMLSelectElement).value))
    output.addEventListener('change', event => updateProfileData('aiOutputLanguage', (event.target as HTMLSelectElement).value))
    content.querySelector<HTMLSelectElement>('#default-persona')!.addEventListener('change', event => updateProfileData('defaultPersonaId', (event.target as HTMLSelectElement).value))
    bindProfileText('#custom-output-language', 'customAiOutputLanguage')
    bindProfileText('#custom-persona-name', 'customPersonaName')
    bindProfileText('#custom-persona-prompt', 'customPersonaPrompt')
    bindProfileText('#custom-instructions', 'customInstructions')
    content.querySelectorAll<HTMLInputElement>('[data-persona-id]').forEach(input => input.addEventListener('change', () => {
      const ids = Array.from(content.querySelectorAll<HTMLInputElement>('[data-persona-id]:checked')).map(item => item.dataset.personaId!)
      draft!.profile.enabledPersonaIds = ids
      if (draft!.profile.defaultPersonaId !== 'custom' && !ids.includes(String(draft!.profile.defaultPersonaId))) {
        draft!.profile.defaultPersonaId = ids[0] || 'default'
      }
      updateDirtyState()
    }))
  }

  function updateProfileData(key: string, value: unknown): void {
    if (!draft) return
    ;(draft.profile as Record<string, unknown>)[key] = value
    updateDirtyState()
  }

  function bindProfileText(selector: string, key: string): void {
    content.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.addEventListener('input', event => {
      updateProfileData(key, (event.target as HTMLInputElement | HTMLTextAreaElement).value)
    })
  }

  function optionCard(group: string, value: string, title: string, description: string, checked: boolean): string {
    return `<label class="policy-option"><input type="radio" name="${group}" value="${value}" ${checked ? 'checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`
  }

  function renderPermissions(): void {
    if (!draft) return
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>执行边界</h3><p>决定智能代理在执行工具前何时需要你确认，以及它能触达的文件范围。</p></div></div>
      <div class="settings-card"><div class="settings-card-title"><strong>审批策略</strong></div><div class="policy-grid">
        ${optionCard('approval', 'ask', '每次询问', '文件修改、命令、MCP 与外部动作前都确认。', draft.approvalPolicy === 'ask')}
        ${optionCard('approval', 'agent', '低风险自动', '工作区内低风险操作自动继续，检测到风险时询问。', draft.approvalPolicy === 'agent')}
        ${optionCard('approval', 'full', '完全访问', '不弹出审批，并自动使用完整主机能力。', draft.approvalPolicy === 'full')}
      </div></div>
      <div class="settings-card"><div class="settings-card-title"><strong>能力边界</strong></div><div class="policy-grid">
        ${optionCard('capability', 'read-only', '只读', '只读取工作区，禁止写入与命令。', draft.capabilityProfile === 'read-only')}
        ${optionCard('capability', 'workspace-write', '工作区读写', '可读写当前工作区，阻止外部路径与主机命令。', draft.capabilityProfile === 'workspace-write')}
        ${optionCard('capability', 'danger-full-access', '完整主机访问', '允许访问工作区外路径和主机命令，仍受审批策略约束。', draft.capabilityProfile === 'danger-full-access')}
      </div></div>
      <div class="settings-card"><label class="settings-switch"><input id="git-enabled" type="checkbox" ${draft.gitEnabled ? 'checked' : ''}><span></span><b>启用 Git 工具</b></label><p class="settings-card-copy">让核心使用结构化 Git 状态、Diff、提交与分支能力。</p></div>
    `
    content.querySelectorAll<HTMLInputElement>('input[name="approval"]').forEach(input => input.addEventListener('change', () => {
      draft!.approvalPolicy = input.value as WorkbenchSettingsUpdate['approvalPolicy']
      if (draft!.approvalPolicy === 'full') draft!.capabilityProfile = 'danger-full-access'
      content.querySelectorAll<HTMLInputElement>('input[name="capability"]').forEach(control => { control.checked = control.value === draft!.capabilityProfile })
      updateDirtyState()
    }))
    content.querySelectorAll<HTMLInputElement>('input[name="capability"]').forEach(input => input.addEventListener('change', () => {
      draft!.capabilityProfile = input.value as WorkbenchSettingsUpdate['capabilityProfile']
      updateDirtyState()
    }))
    content.querySelector<HTMLInputElement>('#git-enabled')!.addEventListener('change', event => {
      draft!.gitEnabled = (event.target as HTMLInputElement).checked
      updateDirtyState()
    })
  }

  function renderAdvanced(): void {
    if (!settings || !draft) return
    if (!hostPreferences) {
      content.innerHTML = '<div class="settings-loading">正在读取后台运行设置…</div>'
      void bridge.getHostPreferences().then(preferences => {
        hostPreferences = preferences
        if (section === 'advanced') renderAdvanced()
      }).catch(error => { content.innerHTML = `<div class="settings-empty"><strong>后台设置读取失败</strong><p>${escapeHtml(presentDesktopError(error))}</p></div>` })
      return
    }
    const profile = selectedProfile(draft)
    const model = profile ? modelFor(settings, profile.model) : undefined
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>运行信息</h3><p>查看模型发现来源与当前运行参数。</p></div><button class="settings-secondary" id="advanced-refresh">重新发现模型</button></div>
      <div class="settings-metrics">
        <div><span>模型数量</span><strong>${settings.models.length}</strong></div>
        <div><span>发现来源</span><strong>${escapeHtml(settings.modelDiscovery.source)}</strong></div>
        <div><span>当前模型</span><strong>${escapeHtml(profile?.model || '未配置')}</strong></div>
        <div><span>推理强度</span><strong>${escapeHtml(reasoningLabel(profile?.reasoning))}</strong></div>
      </div>
      <div class="settings-card"><div class="settings-card-title"><strong>模型能力</strong><span>${escapeHtml(model?.name || profile?.model || '未配置')}</span></div><div class="capability-tags">
        ${model?.capabilities?.vision ? '<span>图像</span>' : ''}${model?.capabilities?.tools !== false ? '<span>工具调用</span>' : ''}${model?.reasoningCapabilities ? '<span>原生推理</span>' : ''}${model?.capabilities?.structuredOutput ? '<span>结构化输出</span>' : ''}
      </div><p class="settings-card-copy">${escapeHtml(model?.description || settings.modelDiscovery.error || '模型能力会从 API、网关元数据和 TurboFlux 内置注册表合并。')}</p></div>
      <div class="settings-card"><div class="settings-card-title"><strong>窗口与后台运行</strong><span>行为明确可控</span></div>
        <label class="settings-field"><span>关闭最后一个窗口</span><select id="host-close-window-behavior"><option value="platform-default" ${hostPreferences.closeWindowBehavior === 'platform-default' ? 'selected' : ''}>遵循平台默认（macOS 驻留，Windows/Linux 退出）</option><option value="keep-running" ${hostPreferences.closeWindowBehavior === 'keep-running' ? 'selected' : ''}>隐藏窗口，继续后台运行</option><option value="quit" ${hostPreferences.closeWindowBehavior === 'quit' ? 'selected' : ''}>退出 TurboFlux</option></select></label>
        <label class="settings-field"><span>退出时仍有自动化 Run</span><select id="host-active-run-quit-behavior"><option value="ask" ${hostPreferences.activeRunQuitBehavior === 'ask' ? 'selected' : ''}>每次询问：等待 / 保存并中断 / 取消退出</option><option value="wait" ${hostPreferences.activeRunQuitBehavior === 'wait' ? 'selected' : ''}>等待全部完成后退出</option><option value="interrupt" ${hostPreferences.activeRunQuitBehavior === 'interrupt' ? 'selected' : ''}>保存检查点并中断</option></select></label>
        <p class="settings-card-copy">关闭窗口与“退出 TurboFlux”是两件不同的事。系统休眠期间不保证任务继续执行；唤醒后会按错过策略补算。</p>
        <div class="settings-profile-actions"><button class="settings-secondary" id="host-preferences-save">保存后台设置</button></div>
      </div>
      <div class="settings-inline-note">配置与人设保存在 <code>~/.turboflux</code>，API 密钥单独保存，界面仅显示遮挡后的密钥摘要。</div>
    `
    content.querySelector<HTMLButtonElement>('#advanced-refresh')?.addEventListener('click', async event => {
      if (!draft || !settings) return
      const button = event.currentTarget as HTMLButtonElement
      const fingerprint = serializedDraft()
      button.disabled = true
      try {
        const latest = await bridge.previewSettingsModels(structuredClone(draft))
        if (serializedDraft() !== fingerprint) return
        settings = { ...settings, models: latest.models, modelDiscovery: latest.modelDiscovery }
        if (section === 'advanced') renderAdvanced()
        if (latest.modelDiscovery.error) options.showToast(latest.modelDiscovery.error)
      } catch (error) {
        options.showToast(presentDesktopError(error))
      } finally {
        button.disabled = false
      }
    })
    content.querySelector('#host-preferences-save')?.addEventListener('click', () => void bridge.saveHostPreferences({
      schemaVersion: 1,
      closeWindowBehavior: content.querySelector<HTMLSelectElement>('#host-close-window-behavior')!.value as DesktopHostPreferences['closeWindowBehavior'],
      activeRunQuitBehavior: content.querySelector<HTMLSelectElement>('#host-active-run-quit-behavior')!.value as DesktopHostPreferences['activeRunQuitBehavior'],
    }).then(preferences => {
      hostPreferences = preferences
      options.showToast('后台运行设置已保存')
      renderAdvanced()
    }).catch(error => options.showToast(presentDesktopError(error))))
  }

  function renderData(): void {
    profileCenter?.render(content)
  }

  function memoryScopeLabel(scope: string): string {
    return ({ global: '全局', workspace_shared: '项目共享', workspace_private: '项目私有', conversation: '对话' } as Record<string, string>)[scope] || scope
  }

  function memoryKindLabel(kind: string): string {
    return ({ rule: '规则', fact: '事实', preference: '偏好', episode: '经历', todo: '待办', verdict: '结论', strategy: '策略', pitfall: '避坑', workflow: '流程' } as Record<string, string>)[kind] || kind
  }

  async function loadMemories(forceReload = false): Promise<void> {
    if (memoryLoading) return
    memoryLoading = true
    if (section === 'memory') content.innerHTML = '<div class="settings-loading">正在整理长期记忆…</div>'
    try {
      memorySnapshot = await bridge.listMemories({ ...memoryFilters }, forceReload)
      if (section === 'memory') renderMemory()
    } catch (error) {
      if (section === 'memory') content.innerHTML = `<div class="settings-empty"><strong>记忆读取失败</strong><p>${escapeHtml(presentDesktopError(error))}</p><button class="settings-primary" id="memory-retry">重试</button></div>`
      content.querySelector('#memory-retry')?.addEventListener('click', () => void loadMemories(true))
    } finally {
      memoryLoading = false
    }
  }

  function memoryEditorMarkup(): string {
    if (memoryEditorId === undefined) return ''
    const item = memoryEditorId ? memorySnapshot?.items.find(candidate => candidate.id === memoryEditorId) : undefined
    return `<section class="settings-card memory-editor">
      <div class="settings-card-title"><strong>${item ? '编辑记忆' : '新增记忆'}</strong><button class="settings-icon-action" id="memory-editor-close" aria-label="关闭">${settingsInlineIcon('close')}</button></div>
      ${field('内容', `<textarea id="memory-editor-text" rows="5" placeholder="写下需要长期保留的规则、偏好或事实">${escapeHtml(item?.text || '')}</textarea>`)}
      <div class="settings-grid-three">
        ${field('范围', `<select id="memory-editor-scope"><option value="workspace_private" ${item?.scope === 'workspace_private' ? 'selected' : ''}>项目私有</option><option value="workspace_shared" ${item?.scope === 'workspace_shared' ? 'selected' : ''}>项目共享</option><option value="global" ${item?.scope === 'global' ? 'selected' : ''}>全局</option><option value="conversation" ${item?.scope === 'conversation' ? 'selected' : ''}>当前对话</option></select>`)}
        ${field('类型', `<select id="memory-editor-kind">${['rule', 'fact', 'preference', 'episode', 'todo', 'verdict', 'strategy', 'pitfall', 'workflow'].map(kind => `<option value="${kind}" ${item?.kind === kind ? 'selected' : ''}>${memoryKindLabel(kind)}</option>`).join('')}</select>`)}
        ${field('可信度', `<select id="memory-editor-confidence"><option value="asserted" ${item?.confidence === 'asserted' ? 'selected' : ''}>明确确认</option><option value="observed" ${!item || item.confidence === 'observed' ? 'selected' : ''}>实际观察</option><option value="inferred" ${item?.confidence === 'inferred' ? 'selected' : ''}>推断</option></select>`)}
      </div>
      ${field('标签', `<input id="memory-editor-tags" value="${escapeHtml(item?.tags.join(', ') || '')}" placeholder="用逗号分隔，最多 12 个">`)}
      <div class="memory-editor-footer"><label class="settings-switch"><input id="memory-editor-pinned" type="checkbox" ${item?.pinned ? 'checked' : ''}><span></span><b>固定到优先记忆</b></label><button class="settings-primary" id="memory-editor-save">保存</button></div>
    </section>`
  }

  function renderWorkPacks(): void {
    if (!settings) return
    if (!workPacks) {
      content.innerHTML = workPacksError
        ? `<div class="settings-empty"><strong>插件读取失败</strong><p>${escapeHtml(workPacksError)}</p><button class="settings-primary" id="work-pack-retry">重新载入</button></div>`
        : '<div class="settings-loading">正在读取本地插件</div>'
      content.querySelector('#work-pack-retry')?.addEventListener('click', () => void loadWorkPacks(true))
      if (!workPacksLoading && !workPacksError) void loadWorkPacks()
      return
    }
    renderLocalExtensions(content, {
      entries: workPacks.entries, query: workPackSearch,
      selectedId: workPackPage === 'detail' ? selectedWorkPackId : undefined,
      busy: Boolean(workPackBusyId), error: workPacksError,
      onQuery: query => { workPackSearch = query; renderWorkPacks() },
      onSelect: id => { selectedWorkPackId = id || ''; workPackPage = id ? 'detail' : 'catalog'; renderWorkPacks() },
      onInstall: () => void installLocalPlugin(),
      onRefresh: () => void loadWorkPacks(true),
      onUse: (id, index) => void useWorkPack(id, index),
      onToggle: (id, enabled) => void toggleWorkPack(id, enabled),
      onUninstall: id => void uninstallWorkPack(id),
    })
  }

  async function installLocalPlugin(): Promise<void> {
    if (workPackBusyId) return
    workPackBusyId = 'local-install'
    renderWorkPacks()
    try {
      const next = await bridge.installLocalPlugin()
      if (!next) return
      workPacks = next
      settings = await bridge.getSettings(false)
      options.showToast('本地插件已安装并启用')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      workPackBusyId = ''
      renderWorkPacks()
    }
  }

  async function loadWorkPacks(force = false): Promise<void> {
    if (workPacksLoading) return
    workPacksLoading = true
    workPacksError = ''
    if (isOpen() && section === 'workpacks') renderWorkPacks()
    try {
      workPacks = force ? await bridge.refreshWorkPacks() : await bridge.listWorkPacks()
      settings = await bridge.getSettings(false)
    } catch (error) {
      workPacksError = presentDesktopError(error)
    } finally {
      workPacksLoading = false
      if (isOpen() && section === 'workpacks') renderWorkPacks()
    }
  }

  async function useWorkPack(id: string, index = 0): Promise<void> {
    const entry = workPacks?.entries.find(candidate => candidate.id === id)
    const emphasis = entry?.emphases?.[index] || entry?.emphasis
    if (!entry?.enabled || !emphasis) return
    try {
      await options.onUseCapability(emphasis)
      close()
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }


  async function toggleWorkPack(id: string, enabled: boolean): Promise<void> {
    workPackBusyId = id
    renderWorkPacks()
    try {
      workPacks = await bridge.setWorkPackEnabled(id, enabled)
      settings = await bridge.getSettings(false)
      options.showToast(enabled ? '插件已启用' : '插件已停用')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      workPackBusyId = ''
      renderWorkPacks()
    }
  }

  async function uninstallWorkPack(id: string): Promise<void> {
    const entry = workPacks?.entries.find(candidate => candidate.id === id)
    if (!entry || !window.confirm(`卸载“${entry.name}”？由它提供的工作流和工具将同时移除。`)) return
    workPackBusyId = id
    renderWorkPacks()
    try {
      workPacks = await bridge.uninstallWorkPack(id)
      settings = await bridge.getSettings(false)
      options.showToast('插件已卸载')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      workPackBusyId = ''
      renderWorkPacks()
    }
  }

  function renderMemory(): void {
    if (!memorySnapshot) {
      void loadMemories()
      return
    }
    const kinds = ['', 'rule', 'fact', 'preference', 'episode', 'todo', 'verdict', 'strategy', 'pitfall', 'workflow']
    const scopes = ['', 'global', 'workspace_shared', 'workspace_private', 'conversation']
    content.innerHTML = `
      <div class="settings-section-head"><div><h3>长期记忆</h3><p>管理会参与后续任务的规则、偏好、事实与经验。</p></div><div class="settings-head-actions"><button class="settings-secondary" id="memory-refresh">刷新</button><button class="settings-primary" id="memory-add">新增记忆</button></div></div>
      <div class="memory-metrics"><div><span>记录</span><strong>${memorySnapshot.totalCount}</strong></div><div><span>当前结果</span><strong>${memorySnapshot.items.length}</strong></div><div><span>注入预算</span><strong>${memorySnapshot.injectionTokens.toLocaleString()}</strong></div></div>
      ${memorySnapshot.warnings.length ? `<div class="settings-inline-note memory-warning">${memorySnapshot.warnings.map(warning => escapeHtml(warning)).join('<br>')}</div>` : ''}
      <div class="memory-toolbar">
        <input id="memory-search" type="search" value="${escapeHtml(memoryFilters.query || '')}" placeholder="搜索内容、标签或来源">
        <select id="memory-scope">${scopes.map(scope => `<option value="${scope}" ${memoryFilters.scope === scope ? 'selected' : ''}>${scope ? memoryScopeLabel(scope) : '全部范围'}</option>`).join('')}</select>
        <select id="memory-kind">${kinds.map(kind => `<option value="${kind}" ${memoryFilters.kind === kind ? 'selected' : ''}>${kind ? memoryKindLabel(kind) : '全部类型'}</option>`).join('')}</select>
        <select id="memory-status"><option value="" ${!memoryFilters.status ? 'selected' : ''}>全部状态</option><option value="active" ${memoryFilters.status === 'active' ? 'selected' : ''}>生效中</option><option value="rejected" ${memoryFilters.status === 'rejected' ? 'selected' : ''}>已遗忘</option><option value="stale" ${memoryFilters.status === 'stale' ? 'selected' : ''}>待复核</option><option value="superseded" ${memoryFilters.status === 'superseded' ? 'selected' : ''}>已替代</option></select>
      </div>
      ${memoryEditorMarkup()}
      <div class="memory-list">${memorySnapshot.items.map(item => `<article class="memory-card status-${item.status}">
        <header><div><span>${memoryKindLabel(item.kind)}</span><span>${memoryScopeLabel(item.scope)}</span>${item.pinned ? '<span class="memory-pinned">已固定</span>' : ''}</div><small>${new Date(item.updatedAt).toLocaleString()}</small></header>
        <p>${escapeHtml(item.text)}</p>
        <div class="memory-tags">${item.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        <footer><span>${escapeHtml(item.source)} · ${item.reviewState === 'auto' ? '待审核' : item.reviewState === 'user_approved' ? '已审核' : '用户编辑'} · ${item.status === 'active' ? '生效中' : '已遗忘'}</span><div>
          <button data-memory-pin="${escapeHtml(item.id)}">${item.pinned ? '取消固定' : '固定'}</button>
          ${item.reviewState === 'auto' || item.status !== 'active' ? `<button data-memory-approve="${escapeHtml(item.id)}">${item.status === 'active' ? '通过审核' : '恢复'}</button>` : ''}
          <button data-memory-edit="${escapeHtml(item.id)}">编辑</button>
          ${item.status === 'active' ? `<button class="danger" data-memory-forget="${escapeHtml(item.id)}">删除</button>` : ''}
        </div></footer>
      </article>`).join('') || '<div class="settings-empty compact"><strong>没有匹配的记忆</strong><p>调整筛选条件，或新增一条经过确认的长期记忆。</p></div>'}</div>`

    content.querySelector('#memory-refresh')?.addEventListener('click', () => void loadMemories(true))
    content.querySelector('#memory-add')?.addEventListener('click', () => { memoryEditorId = null; renderMemory() })
    content.querySelector('#memory-editor-close')?.addEventListener('click', () => { memoryEditorId = undefined; renderMemory() })
    const reloadFromControls = () => {
      memoryFilters.scope = (content.querySelector<HTMLSelectElement>('#memory-scope')?.value || undefined) as WorkbenchMemoryFilters['scope']
      memoryFilters.kind = (content.querySelector<HTMLSelectElement>('#memory-kind')?.value || undefined) as WorkbenchMemoryFilters['kind']
      memoryFilters.status = (content.querySelector<HTMLSelectElement>('#memory-status')?.value || undefined) as WorkbenchMemoryFilters['status']
      void loadMemories()
    }
    content.querySelectorAll<HTMLSelectElement>('#memory-scope, #memory-kind, #memory-status').forEach(select => select.addEventListener('change', reloadFromControls))
    content.querySelector<HTMLInputElement>('#memory-search')?.addEventListener('input', event => {
      memoryFilters.query = (event.target as HTMLInputElement).value
      if (memorySearchTimer) clearTimeout(memorySearchTimer)
      memorySearchTimer = setTimeout(() => void loadMemories(), 180)
    })
    content.querySelector('#memory-editor-save')?.addEventListener('click', async () => {
      const text = content.querySelector<HTMLTextAreaElement>('#memory-editor-text')?.value.trim() || ''
      if (!text) return options.showToast('记忆内容不能为空')
      const input = {
        text,
        scope: content.querySelector<HTMLSelectElement>('#memory-editor-scope')?.value as 'global' | 'workspace_shared' | 'workspace_private' | 'conversation',
        kind: content.querySelector<HTMLSelectElement>('#memory-editor-kind')?.value as 'rule' | 'fact' | 'preference' | 'episode' | 'todo' | 'verdict' | 'strategy' | 'pitfall' | 'workflow',
        confidence: content.querySelector<HTMLSelectElement>('#memory-editor-confidence')?.value as 'asserted' | 'observed' | 'inferred',
        tags: (content.querySelector<HTMLInputElement>('#memory-editor-tags')?.value || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 12),
        pinned: content.querySelector<HTMLInputElement>('#memory-editor-pinned')?.checked === true,
      }
      try {
        memorySnapshot = memoryEditorId ? await bridge.updateMemory(memoryEditorId, input) : await bridge.rememberMemory(input)
        memoryEditorId = undefined
        renderMemory()
        options.showToast('长期记忆已保存')
      } catch (error) {
        options.showToast(presentDesktopError(error))
      }
    })
    content.querySelectorAll<HTMLButtonElement>('[data-memory-edit]').forEach(button => button.addEventListener('click', () => { memoryEditorId = button.dataset.memoryEdit || null; renderMemory() }))
    content.querySelectorAll<HTMLButtonElement>('[data-memory-pin]').forEach(button => button.addEventListener('click', async () => {
      const item = memorySnapshot?.items.find(candidate => candidate.id === button.dataset.memoryPin)
      if (!item) return
      try { memorySnapshot = await bridge.updateMemory(item.id, { pinned: !item.pinned }); renderMemory() } catch (error) { options.showToast(presentDesktopError(error)) }
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-memory-approve]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.memoryApprove
      if (!id) return
      try { memorySnapshot = await bridge.updateMemory(id, { reviewState: 'user_approved', status: 'active' }); renderMemory() } catch (error) { options.showToast(presentDesktopError(error)) }
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-memory-forget]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.memoryForget
      if (!id || !window.confirm('删除后这条记忆将不再参与后续任务。继续吗？')) return
      try { memorySnapshot = await bridge.forgetMemory(id, 'desktop-user-delete'); renderMemory() } catch (error) { options.showToast(presentDesktopError(error)) }
    }))
  }

  function renderAppearance(): void {
    const activeTheme = currentThemePreference()
    const backgroundMedia = currentBackgroundMediaSnapshot()
    let backgroundSettings = currentBackgroundMediaSettings()
    if (backgroundMedia && backgroundSettings.fit !== 'cover' && backgroundSettings.fit !== 'contain') {
      backgroundSettings = setBackgroundMediaSettings({ fit: 'cover' })
    }
    const resolvedTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    const activeBrightness = resolvedTheme === 'dark' ? backgroundSettings.darkBrightness : backgroundSettings.lightBrightness
    const activeMaterial = backgroundSettings.materialOpacity <= 0.44
      ? 'clear'
      : backgroundSettings.materialOpacity >= 0.7 ? 'readable' : 'standard'
    const windowOpacity = normalizeWindowOpacity(Number(document.documentElement.style.getPropertyValue('--window-opacity')) || 1)
    const themeChoices: Array<{ id: ThemePreference; title: string; description: string }> = [
      { id: 'system', title: '跟随系统', description: '自动匹配 macOS 的浅色或深色外观。' },
      { id: 'light', title: '浅色', description: '明亮、中性的工作台，适合日间环境。' },
      { id: 'dark', title: '深色', description: '低眩光深色工作台，适合夜间与长时间工作。' },
    ]
    content.innerHTML = `
      <div class="appearance-page">
        <div class="settings-page-intro"><div><h3>主题</h3><p>浅色与深色使用同一套语义层级、状态颜色和可读性标准，切换立即生效。</p></div></div>
        <div class="theme-choice-grid" role="radiogroup" aria-label="界面主题">
          ${themeChoices.map(choice => `<button class="theme-choice ${choice.id === activeTheme ? 'selected' : ''}" type="button" role="radio" aria-checked="${choice.id === activeTheme}" data-theme-choice="${choice.id}">
            <span class="theme-choice-preview theme-choice-preview-${choice.id}" aria-hidden="true"><i></i><b></b><em></em></span>
            <span class="theme-choice-copy"><strong>${choice.title}</strong><small>${choice.description}</small></span>
            <span class="theme-choice-check" aria-hidden="true">${settingsInlineIcon('check')}</span>
          </button>`).join('')}
        </div>
        <div class="settings-footnote"><span aria-hidden="true">${settingsInlineIcon('info')}</span><p>选择“跟随系统”时，TurboFlux 会实时响应系统外观变化，并在下次启动时保持该选择。</p></div>
        <section class="background-studio ${backgroundMedia ? 'has-media' : ''}">
          <div class="settings-page-intro"><div><h3>背景</h3><p>预览就是最终画面：拖动调整构图，滚动缩放，其他效果即时呈现在整个应用中。</p></div><span class="background-media-kind">${backgroundMedia?.kind === 'video' ? '动态视频' : backgroundMedia ? '静态图片' : '未设置'}</span></div>
          <div class="background-media-file"><div><strong>${backgroundMedia ? escapeHtml(backgroundMedia.filename) : '默认纯色背景'}</strong><small>${backgroundMedia ? `${backgroundMedia.kind === 'video' ? '视频' : '图片'} · ${(backgroundMedia.size / 1024 / 1024).toFixed(1)} MB · 仅保存在本机` : '支持图片，也为动态视频预留了同一套编辑方式'}</small></div><div><button class="settings-primary" id="background-media-choose">${backgroundMedia ? '更换' : '选择背景'}</button>${backgroundMedia ? '<button class="settings-secondary danger-text" id="background-media-remove">移除</button>' : ''}</div></div>
          <div class="background-editor">
            <div class="background-studio-preview ${backgroundMedia ? 'is-editable' : ''}" id="background-media-preview" tabindex="${backgroundMedia ? '0' : '-1'}" aria-label="背景构图预览">
              ${backgroundMedia?.kind === 'video' ? `<video src="${escapeHtml(backgroundMedia.url)}" autoplay loop muted playsinline></video>` : backgroundMedia ? `<img src="${escapeHtml(backgroundMedia.url)}" alt="背景预览" draggable="false">` : '<div class="background-studio-empty"><strong>选择一张图片或视频</strong><span>添加后可直接在这里拖动和缩放</span></div>'}
              ${backgroundMedia ? '<div class="background-editor-grid" aria-hidden="true"></div><div class="background-editor-hint">拖动构图 · 滚动缩放</div>' : ''}
            </div>
            <div class="background-editor-bar">
              <div class="background-fit-segment" role="radiogroup" aria-label="背景显示方式">
                ${([['cover', '铺满'], ['contain', '完整']] as Array<[BackgroundMediaFit, string]>).map(([fit, label]) => `<button type="button" role="radio" aria-checked="${backgroundSettings.fit === fit}" class="${backgroundSettings.fit === fit ? 'selected' : ''}" data-background-fit="${fit}" ${backgroundMedia ? '' : 'disabled'}>${label}</button>`).join('')}
              </div>
              <div class="background-zoom-controls" aria-label="缩放背景">
                <button type="button" data-background-zoom="out" aria-label="缩小" ${backgroundMedia ? '' : 'disabled'}>−</button>
                <button type="button" id="background-settings-reset" ${backgroundMedia ? '' : 'disabled'}>居中</button>
                <button type="button" data-background-zoom="in" aria-label="放大" ${backgroundMedia ? '' : 'disabled'}>＋</button>
              </div>
            </div>
          </div>
          <div class="background-effect-panel ${backgroundMedia ? '' : 'disabled'}">
            <div class="background-effect-row">
              <div><strong>${resolvedTheme === 'dark' ? '深色背景' : '浅色背景'}</strong><small>${resolvedTheme === 'dark' ? '压暗背景，不在内容上加黑色罩层' : '提亮背景，不在内容上叠白色雾层'}</small></div>
              ${backgroundRange('background-brightness', '背景亮度', Math.round(activeBrightness), resolvedTheme === 'dark' ? 0 : 50, resolvedTheme === 'dark' ? 50 : 100, '', !backgroundMedia, resolvedTheme === 'dark' ? '更暗' : '原图', resolvedTheme === 'dark' ? '原图' : '更亮')}
            </div>
            <div class="background-effect-row">
              <div><strong>背景柔化</strong><small>只虚化壁纸，界面玻璃保持独立。</small></div>
              ${backgroundRange('background-blur', '背景柔化', Math.round(backgroundSettings.blur), 0, 24, '', !backgroundMedia, '清晰', '柔和')}
            </div>
            <div class="background-effect-row material-row">
              <div><strong>界面材质</strong><small>只作用于侧栏、顶栏、输入框和浮层。</small></div>
              <div class="background-material-segment" role="radiogroup" aria-label="界面材质">
                ${([['clear', '通透'], ['standard', '标准'], ['readable', '清晰']] as const).map(([preset, label]) => `<button type="button" role="radio" aria-checked="${activeMaterial === preset}" class="${activeMaterial === preset ? 'selected' : ''}" data-background-material="${preset}" ${backgroundMedia ? '' : 'disabled'}>${label}</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="window-opacity-row"><div><strong>透出系统桌面</strong><small>调整整个应用窗口的透明度，与壁纸强度互不影响。</small></div><input id="window-opacity" aria-label="应用窗口透明度" type="range" min="45" max="100" step="1" value="${Math.round(windowOpacity * 100)}"><span class="range-endpoints"><i>更透明</i><i>不透明</i></span></div>
          ${backgroundMedia?.kind === 'video' ? `<details class="background-advanced"><summary>视频选项</summary><div class="background-control-grid">${backgroundRange('background-playback-rate', '播放速度', Math.round(backgroundSettings.playbackRate * 100), 50, 200, '%', false, '慢', '快')}</div></details>` : ''}
        </section>
      </div>`
    reflectBackgroundPreview(backgroundSettings)
    content.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach(button => button.addEventListener('click', () => {
      const preference = button.dataset.themeChoice as ThemePreference
      setThemePreference(preference)
      content.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach(item => {
        const selected = item.dataset.themeChoice === preference
        item.classList.toggle('selected', selected)
        item.setAttribute('aria-checked', String(selected))
      })
      const brightness = content.querySelector<HTMLInputElement>('#background-brightness')
      const current = currentBackgroundMediaSettings()
      const dark = document.documentElement.dataset.theme === 'dark'
      if (brightness) {
        brightness.min = dark ? '0' : '50'
        brightness.max = dark ? '50' : '100'
        brightness.value = String(dark ? current.darkBrightness : current.lightBrightness)
        const row = brightness.closest('.background-effect-row')!
        row.querySelector('strong')!.textContent = dark ? '深色背景' : '浅色背景'
        row.querySelector('small')!.textContent = dark ? '压暗背景，不在内容上加黑色罩层' : '提亮背景，不在内容上叠白色雾层'
        row.querySelector('.range-endpoints i:first-child')!.textContent = dark ? '更暗' : '原图'
        row.querySelector('.range-endpoints i:last-child')!.textContent = dark ? '原图' : '更亮'
      }
      options.showToast(`已切换为${preference === 'system' ? '跟随系统' : preference === 'light' ? '浅色' : '深色'}主题`)
    }))
    content.querySelector('#background-media-choose')?.addEventListener('click', async () => {
      try {
        const result = await bridge.chooseBackgroundMedia()
        if (result.canceled) return
        applyBackgroundMediaSnapshot(result.media)
        renderAppearance()
        options.showToast(result.media?.kind === 'video' ? '动态视频背景已启用' : '背景图片已更新')
      } catch (error) {
        options.showToast(presentDesktopError(error))
      }
    })
    content.querySelector('#background-media-remove')?.addEventListener('click', async () => {
      try {
        await bridge.removeBackgroundMedia()
        applyBackgroundMediaSnapshot(null)
        renderAppearance()
        options.showToast('已恢复默认背景')
      } catch (error) {
        options.showToast(presentDesktopError(error))
      }
    })
    content.querySelectorAll<HTMLButtonElement>('[data-background-fit]').forEach(button => button.addEventListener('click', () => {
      const settings = setBackgroundMediaSettings({ fit: button.dataset.backgroundFit as BackgroundMediaFit })
      reflectBackgroundPreview(settings)
      content.querySelectorAll<HTMLButtonElement>('[data-background-fit]').forEach(item => {
        const selected = item.dataset.backgroundFit === settings.fit
        item.classList.toggle('selected', selected)
        item.setAttribute('aria-checked', String(selected))
      })
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-background-zoom]').forEach(button => button.addEventListener('click', () => {
      const current = currentBackgroundMediaSettings()
      const direction = button.dataset.backgroundZoom === 'in' ? 1 : -1
      reflectBackgroundPreview(setBackgroundMediaSettings({ scale: current.scale + direction * 0.1 }))
    }))
    content.querySelectorAll<HTMLButtonElement>('[data-background-material]').forEach(button => button.addEventListener('click', () => {
      const preset = button.dataset.backgroundMaterial
      const presetSettings: Record<string, Partial<BackgroundMediaSettings>> = {
        clear: { materialOpacity: 0.38, materialBlur: 26 },
        standard: { materialOpacity: 0.58, materialBlur: 20 },
        readable: { materialOpacity: 0.76, materialBlur: 14 },
      }
      const update = presetSettings[preset || '']
      if (!update) return
      reflectBackgroundPreview(setBackgroundMediaSettings(update))
      content.querySelectorAll<HTMLButtonElement>('[data-background-material]').forEach(item => {
        const selected = item === button
        item.classList.toggle('selected', selected)
        item.setAttribute('aria-checked', String(selected))
      })
    }))
    const editor = content.querySelector<HTMLElement>('#background-media-preview')
    if (backgroundMedia && editor) {
      let drag: { pointerId: number; x: number; y: number; positionX: number; positionY: number } | null = null
      editor.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        const settings = currentBackgroundMediaSettings()
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, positionX: settings.positionX, positionY: settings.positionY }
        editor.setPointerCapture(event.pointerId)
        editor.classList.add('is-dragging')
        const hint = editor.querySelector<HTMLElement>('.background-editor-hint')
        if (hint) hint.textContent = '松开即可保存构图'
      })
      editor.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId) return
        const bounds = editor.getBoundingClientRect()
        const positionX = Math.max(0, Math.min(100, drag.positionX - ((event.clientX - drag.x) / bounds.width) * 100))
        const positionY = Math.max(0, Math.min(100, drag.positionY - ((event.clientY - drag.y) / bounds.height) * 100))
        reflectBackgroundPreview(setBackgroundMediaSettings({ positionX, positionY }))
      })
      const finishDragging = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId) return
        drag = null
        editor.classList.remove('is-dragging')
        const hint = editor.querySelector<HTMLElement>('.background-editor-hint')
        if (hint) hint.textContent = '拖动构图 · 滚动缩放'
        if (editor.hasPointerCapture(event.pointerId)) editor.releasePointerCapture(event.pointerId)
      }
      editor.addEventListener('pointerup', finishDragging)
      editor.addEventListener('pointercancel', finishDragging)
      editor.addEventListener('wheel', event => {
        event.preventDefault()
        const current = currentBackgroundMediaSettings()
        reflectBackgroundPreview(setBackgroundMediaSettings({ scale: current.scale - event.deltaY * 0.0015 }))
      }, { passive: false })
      editor.addEventListener('keydown', event => {
        const movement = event.shiftKey ? 5 : 1
        const current = currentBackgroundMediaSettings()
        const update: Partial<BackgroundMediaSettings> = {}
        if (event.key === 'ArrowLeft') update.positionX = Math.max(0, current.positionX - movement)
        else if (event.key === 'ArrowRight') update.positionX = Math.min(100, current.positionX + movement)
        else if (event.key === 'ArrowUp') update.positionY = Math.max(0, current.positionY - movement)
        else if (event.key === 'ArrowDown') update.positionY = Math.min(100, current.positionY + movement)
        else return
        event.preventDefault()
        reflectBackgroundPreview(setBackgroundMediaSettings(update))
      })
    }
    bindBackgroundRange('background-brightness', resolvedTheme === 'dark' ? 'darkBrightness' : 'lightBrightness')
    bindBackgroundRange('background-blur', 'blur')
    bindBackgroundRange('background-playback-rate', 'playbackRate', 100)
    content.querySelector('#background-settings-reset')?.addEventListener('click', () => {
      const settings = setBackgroundMediaSettings({ fit: 'cover', scale: 1, positionX: 50, positionY: 50 })
      reflectBackgroundPreview(settings)
      content.querySelectorAll<HTMLButtonElement>('[data-background-fit]').forEach(item => {
        const selected = item.dataset.backgroundFit === settings.fit
        item.classList.toggle('selected', selected)
        item.setAttribute('aria-checked', String(selected))
      })
      options.showToast('背景已居中')
    })
    content.querySelector<HTMLInputElement>('#window-opacity')?.addEventListener('input', event => {
      const value = Number((event.target as HTMLInputElement).value) / 100
      void bridge.setWindowOpacity(value).then(opacity => {
        document.documentElement.style.setProperty('--window-opacity', String(opacity))
      }).catch(error => options.showToast(presentDesktopError(error)))
    })

    function bindBackgroundRange(id: string, key: keyof BackgroundMediaSettings, divisor = 1): void {
      content.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('input', event => {
        const input = event.target as HTMLInputElement
        const currentKey = id === 'background-brightness' ? document.documentElement.dataset.theme === 'dark' ? 'darkBrightness' : 'lightBrightness' : key
        const settings = setBackgroundMediaSettings({ [currentKey]: Number(input.value) / divisor })
        const output = content.querySelector<HTMLOutputElement>(`#${id}-value`)
        if (output) output.value = `${Math.round(Number(input.value))}${id === 'background-blur' ? ' px' : '%'}`
        reflectBackgroundPreview(settings)
      })
    }
  }

  function backgroundRange(id: string, label: string, value: number, min: number, max: number, suffix: string, disabled: boolean, start = '', end = ''): string {
    return `<label class="background-range" for="${id}"><span class="visually-hidden">${label}</span><input id="${id}" type="range" min="${min}" max="${max}" step="1" value="${value}" ${disabled ? 'disabled' : ''}><span class="range-endpoints"><i>${start}</i><i>${end}</i></span>${suffix ? `<output id="${id}-value" class="visually-hidden">${value}${suffix}</output>` : ''}</label>`
  }

  function reflectBackgroundPreview(settings: BackgroundMediaSettings): void {
    const preview = content.querySelector<HTMLElement>('#background-media-preview')
    if (!preview) return
    preview.style.setProperty('--preview-fit', settings.fit)
    preview.style.setProperty('--preview-scale', String(settings.scale))
    preview.style.setProperty('--preview-position-x', `${settings.positionX}%`)
    preview.style.setProperty('--preview-position-y', `${settings.positionY}%`)
    preview.style.setProperty('--preview-dark-filter-brightness', String(backgroundBrightnessMultiplier(settings, 'dark')))
    preview.style.setProperty('--preview-light-filter-brightness', String(backgroundBrightnessMultiplier(settings, 'light')))
    preview.style.setProperty('--preview-blur', `${settings.blur}px`)
    const video = preview.querySelector<HTMLVideoElement>('video')
    if (video) video.playbackRate = settings.playbackRate
  }

  function remoteDeviceDate(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp)
  }

  function remoteTime(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp)
  }

  function remoteCapabilityLabel(capability: string): string {
    return ({
      'session.read': '查看任务与进度',
      'session.create': '新建任务',
      'session.submit': '发送指令',
      'session.steer': '运行中纠偏',
      'session.control': '切换、暂停与停止任务',
      'approval.resolve': '处理审批与输入请求',
      'artifact.list': '查看产物列表',
      'artifact.read': '下载产物内容',
      'terminal.observe': '查看终端',
      'terminal.write': '操作终端',
      'computer.control': '操控电脑',
      'adapter.manage': '管理 Agent 适配器',
    } as Record<string, string>)[capability] ?? capability
  }

  function remoteCapabilities(capabilities: readonly string[]): string {
    return capabilities.length > 0 ? capabilities.map(remoteCapabilityLabel).join('、') : '无额外能力'
  }

  function renderRemote(): void {
    if (!remoteStatus) {
      content.innerHTML = '<div class="settings-loading">正在读取远程访问状态…</div>'
      void loadRemoteStatus()
      return
    }
    const status = remoteStatus
    const pendingPairings = status.pendingPairings ?? []
    const pendingRows = pendingPairings.map(request => `
      <div class="remote-device-row remote-pending-row">
        <span class="remote-device-icon" aria-hidden="true">?</span>
        <div><strong>${escapeHtml(request.displayName)}</strong><small>设备指纹 ${escapeHtml(request.fingerprint)} · 当前工作区</small><small>申请能力：${escapeHtml(remoteCapabilities(request.capabilities))}</small></div>
        <div class="remote-pending-actions"><button class="settings-secondary" data-remote-approve="${escapeHtml(request.requestId)}">允许</button><button class="settings-secondary danger" data-remote-reject="${escapeHtml(request.requestId)}">拒绝</button></div>
      </div>`).join('')
    const deviceRows = status.pairedDevices.map(device => `
      <div class="remote-device-row">
        <span class="remote-device-icon" aria-hidden="true">▯</span>
        <div><strong>${escapeHtml(device.displayName)}</strong><small>配对于 ${remoteDeviceDate(device.pairedAt)} · ${device.workspaceIds.length || '全部'} 个工作区 · ${remoteTime(device.expiresAt)} 前有效</small><small>已授权：${escapeHtml(remoteCapabilities(device.capabilities))}</small></div>
        <button class="settings-secondary danger" data-remote-revoke="${escapeHtml(device.deviceId)}">撤销</button>
      </div>`).join('')
    content.innerHTML = `
      <div class="settings-page-intro"><div><h3>手机远程</h3><p>通过受信任的 HTTPS 入口连接手机，设备配对与所有控制命令均使用端到端加密。</p></div></div>
      ${status.controlSession ? `<div class="settings-inline-note remote-active-note"><strong>${escapeHtml(status.controlSession.displayName)}</strong> 正在控制这台电脑 · 最近活动 ${remoteTime(status.controlSession.lastSeenAt)}</div>` : ''}
      ${status.error ? `<div class="settings-inline-note remote-warning"><span>${escapeHtml(status.error)}</span>${status.recoveryRequired ? '<button class="settings-secondary danger" id="remote-reset-identity">重置远程身份</button>' : ''}</div>` : ''}
      <section class="settings-group-block">
        ${settingsRow('允许手机远程访问', '默认关闭；服务只监听本机回环地址，需要由受信任的 HTTPS 反向代理公开。', `<label class="settings-switch settings-row-switch"><input id="remote-enabled" type="checkbox" ${status.enabled ? 'checked' : ''} ${remoteLoading || !status.available || status.recoveryRequired ? 'disabled' : ''}><span aria-hidden="true"></span><b>${!status.available ? '安全存储不可用' : status.recoveryRequired ? '需要重置身份' : status.active ? '运行中' : status.enabled ? '等待运行时' : '已关闭'}</b></label>`)}
        ${settingsRow('当前工作区', '新配对设备默认只获得这里显示的工作区权限。', `<span class="settings-row-value">${escapeHtml(status.workspaceName || '尚未载入')}</span>`)}
        ${settingsRow('HTTPS 公开端点', '反向代理到下方本机调试地址，例如 https://remote.example.com。', `<div class="remote-endpoint-editor"><input id="remote-public-endpoint" value="${escapeHtml(remotePublicEndpointDraft ?? status.publicEndpoint ?? '')}" placeholder="https://remote.example.com" spellcheck="false"><button class="settings-secondary" id="remote-save-public-endpoint">保存</button></div>`)}
        ${settingsRow('Web 控制页 URL', '可选；留空时使用公开端点自带的控制页。独立部署时填写完整 HTTPS 地址。', `<div class="remote-endpoint-editor"><input id="remote-client-url" value="${escapeHtml(remoteClientUrlDraft ?? status.clientUrl ?? '')}" placeholder="https://remote.example.com" spellcheck="false"><button class="settings-secondary" id="remote-save-client-url">保存</button></div>`)}
        ${settingsRow('本机调试地址', '仅供这台电脑上的开发与诊断使用，不能作为手机入口。', status.localEndpointUrl ? `<div class="remote-endpoints"><code>${escapeHtml(status.localEndpointUrl)}</code></div>` : '<span class="settings-row-value muted">启用后显示</span>')}
      </section>
      <section class="settings-card remote-pairing-card">
        <div class="settings-card-title"><strong>安全配对</strong><span>${remotePairing && remotePairing.expiresAt > Date.now() ? `${remoteTime(remotePairing.expiresAt)} 前有效` : '一次性邀请'}</span></div>
        ${remotePairing && remotePairing.expiresAt > Date.now() ? `<div class="remote-pairing-grid"><img src="${escapeHtml(remotePairing.qrDataUrl)}" alt="手机远程配对二维码"><div><strong>用手机相机扫描</strong><p>扫描后在此核对设备名称和指纹，再点击“允许”。二维码会绑定当前工作区并在五分钟后失效。</p><textarea readonly aria-label="配对链接">${escapeHtml(remotePairing.url ?? remotePairing.code)}</textarea><div class="remote-pairing-actions"><button class="settings-secondary" id="remote-copy-pairing">复制配对链接</button><button class="settings-secondary" id="remote-refresh-pairing">刷新二维码</button></div></div></div>` : `<div class="remote-pairing-empty"><p>${status.publicEndpoint ? '生成一个仅供当前工作区使用的五分钟配对二维码。' : '先配置 HTTPS 公开端点，再生成手机可扫描的配对二维码。'}</p><button class="settings-primary" id="remote-create-pairing" ${!status.active || !status.publicEndpoint || remoteLoading ? 'disabled' : ''}>生成二维码</button></div>`}
      </section>
      ${pendingRows ? `<section class="settings-card"><div class="settings-card-title"><strong>等待确认</strong><span>${pendingPairings.length} 台</span></div><div class="remote-device-list">${pendingRows}</div></section>` : ''}
      <section class="settings-card">
        <div class="settings-card-title"><strong>已允许设备</strong><span>${status.pairedDevices.length} 台</span></div>
        <div class="remote-device-list">${deviceRows || '<div class="settings-empty compact"><strong>还没有允许任何手机</strong><p>生成二维码并用手机扫描后，连接申请会显示在这里。</p></div>'}</div>
      </section>
      ${(status.pairedDevices.length || pendingPairings.length || status.controlSession) ? '<div class="remote-stop-row"><button class="settings-secondary danger" id="remote-stop-control">停止本次远控</button><span>立即撤销所有设备授权和待确认请求。</span></div>' : ''}
      <div class="settings-footnote"><span aria-hidden="true">${settingsInlineIcon('info')}</span><p>不要直接把本机端口暴露到公网。HTTPS 代理只负责传输，配对身份、能力授权和控制内容仍由设备端到端加密。</p></div>`

    content.querySelector<HTMLInputElement>('#remote-enabled')?.addEventListener('change', event => void setRemoteEnabled((event.target as HTMLInputElement).checked))
    content.querySelector('#remote-reset-identity')?.addEventListener('click', () => void resetRemoteIdentity())
    content.querySelector<HTMLInputElement>('#remote-public-endpoint')?.addEventListener('input', event => { remotePublicEndpointDraft = (event.target as HTMLInputElement).value })
    content.querySelector<HTMLInputElement>('#remote-client-url')?.addEventListener('input', event => { remoteClientUrlDraft = (event.target as HTMLInputElement).value })
    content.querySelector('#remote-save-public-endpoint')?.addEventListener('click', () => void saveRemoteEndpoint('public'))
    content.querySelector('#remote-save-client-url')?.addEventListener('click', () => void saveRemoteEndpoint('client'))
    content.querySelector('#remote-create-pairing')?.addEventListener('click', () => void createRemotePairing())
    content.querySelector('#remote-refresh-pairing')?.addEventListener('click', () => void createRemotePairing())
    content.querySelector('#remote-copy-pairing')?.addEventListener('click', () => void copyRemoteUrl(remotePairing?.url ?? remotePairing?.code ?? ''))
    content.querySelector('#remote-stop-control')?.addEventListener('click', () => void stopRemoteControl())
    content.querySelectorAll<HTMLButtonElement>('[data-remote-approve]').forEach(button => button.addEventListener('click', () => void decideRemotePairing(button.dataset.remoteApprove || '', true)))
    content.querySelectorAll<HTMLButtonElement>('[data-remote-reject]').forEach(button => button.addEventListener('click', () => void decideRemotePairing(button.dataset.remoteReject || '', false)))
    content.querySelectorAll<HTMLButtonElement>('[data-remote-revoke]').forEach(button => button.addEventListener('click', () => void revokeRemoteDevice(button.dataset.remoteRevoke || '')))
    scheduleRemoteRefresh()
  }

  function scheduleRemoteRefresh(): void {
    if (remoteRefreshTimer || !isOpen() || section !== 'remote') return
    remoteRefreshTimer = setTimeout(() => {
      remoteRefreshTimer = null
      if (isOpen() && section === 'remote') void loadRemoteStatus()
    }, 1_500)
  }

  async function loadRemoteStatus(): Promise<void> {
    if (remoteLoading) return
    remoteLoading = true
    try {
      remoteStatus = await bridge.getRemoteStatus()
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      remoteLoading = false
      if (isOpen() && section === 'remote') renderRemote()
    }
  }

  async function setRemoteEnabled(enabled: boolean): Promise<void> {
    remoteLoading = true
    renderRemote()
    try {
      remoteStatus = await bridge.setRemoteEnabled(enabled)
      options.showToast(enabled ? '手机远程已启用' : '手机远程已关闭')
    } catch (error) {
      options.showToast(presentDesktopError(error))
      remoteStatus = await bridge.getRemoteStatus().catch(() => remoteStatus)
    } finally {
      remoteLoading = false
      renderRemote()
    }
  }

  async function resetRemoteIdentity(): Promise<void> {
    if (remoteLoading || !window.confirm('重置后，原有手机需要重新配对。旧身份文件会保留为本机备份，继续吗？')) return
    remoteLoading = true
    renderRemote()
    try {
      remoteStatus = await bridge.resetRemoteIdentity()
      remotePairing = null
      options.showToast('远程身份已重置，可以重新启用并配对')
    } catch (error) {
      options.showToast(presentDesktopError(error))
      remoteStatus = await bridge.getRemoteStatus().catch(() => remoteStatus)
    } finally {
      remoteLoading = false
      renderRemote()
    }
  }

  async function copyRemoteUrl(url: string): Promise<void> {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      options.showToast('配对链接已复制')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function saveRemoteEndpoint(kind: 'public' | 'client'): Promise<void> {
    if (remoteLoading) return
    remoteLoading = true
    try {
      remoteStatus = kind === 'public'
        ? await bridge.setRemotePublicEndpoint(remotePublicEndpointDraft?.trim() || undefined)
        : await bridge.setRemoteClientUrl(remoteClientUrlDraft?.trim() || undefined)
      remotePublicEndpointDraft = remoteStatus.publicEndpoint ?? ''
      remoteClientUrlDraft = remoteStatus.clientUrl ?? ''
      remotePairing = null
      options.showToast(kind === 'public' ? 'HTTPS 公开端点已保存' : 'Web 控制页地址已保存')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      remoteLoading = false
      renderRemote()
    }
  }

  async function createRemotePairing(): Promise<void> {
    if (remoteLoading || !remoteStatus?.active || !remoteStatus.publicEndpoint) return
    remoteLoading = true
    try {
      remotePairing = await bridge.createRemotePairing(5 * 60_000)
      options.showToast('安全配对二维码已生成')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    } finally {
      remoteLoading = false
      renderRemote()
    }
  }

  async function revokeRemoteDevice(deviceId: string): Promise<void> {
    const device = remoteStatus?.pairedDevices.find(item => item.deviceId === deviceId)
    if (!device || !window.confirm(`撤销“${device.displayName}”的远程访问？这台设备将立即失去授权。`)) return
    try {
      remoteStatus = await bridge.revokeRemoteDevice(deviceId)
      renderRemote()
      options.showToast('设备授权已撤销')
    } catch (error) {
      options.showToast(presentDesktopError(error))
    }
  }

  async function stopRemoteControl(): Promise<void> {
    if (remoteLoading || !window.confirm('停止本次手机远控？所有已连接设备和待确认请求都会立即失效。')) return
    remoteLoading = true
    try {
      remoteStatus = await bridge.stopRemoteControl()
      options.showToast('本次手机远控已停止')
    } catch (error) {
      options.showToast(presentDesktopError(error))
      remoteStatus = await bridge.getRemoteStatus().catch(() => remoteStatus)
    } finally {
      remoteLoading = false
      renderRemote()
    }
  }

  async function decideRemotePairing(requestId: string, approve: boolean): Promise<void> {
    if (!requestId || remoteLoading) return
    remoteLoading = true
    renderRemote()
    try {
      remoteStatus = approve
        ? await bridge.approveRemotePairing(requestId)
        : await bridge.rejectRemotePairing(requestId)
      options.showToast(approve ? '已允许这台设备' : '已拒绝配对请求')
    } catch (error) {
      options.showToast(presentDesktopError(error))
      remoteStatus = await bridge.getRemoteStatus().catch(() => remoteStatus)
    } finally {
      remoteLoading = false
      renderRemote()
    }
  }

  function renderSection(): void {
    const changed = content.dataset.section !== section || content.firstElementChild?.classList.contains('settings-loading')
    overlay.dataset.section = section
    content.dataset.section = section
    settingsWindow.setAttribute('role', 'dialog')
    settingsWindow.setAttribute('aria-label', 'TurboFlux 设置')
    settingsWindow.setAttribute('aria-modal', 'true')
    overlay.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach(button => button.classList.toggle('active', button.dataset.settingsSection === section))
    const label = sectionLabels.find(item => item.id === section)!
    overlay.querySelector('#settings-title')!.textContent = label.title
    if (section === 'appearance') {
      renderAppearance()
      if (changed) animateSectionChange()
      return
    }
    if (!settings || !draft) return
    if (section === 'api') renderApi()
    if (section === 'mcp') renderMcp()
    if (section === 'computer') options.computerControls?.renderSettings(content)
    if (section === 'remote') renderRemote()
    if (section === 'workpacks') renderWorkPacks()
    if (section === 'memory') renderMemory()
    if (section === 'persona') renderPersona()
    if (section === 'permissions') renderPermissions()
    if (section === 'data') renderData()
    if (section === 'advanced') renderAdvanced()
    updateDirtyState()
    if (changed) animateSectionChange()
  }

  function animateSectionChange(): void {
    content.getAnimations().forEach(animation => animation.cancel())
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    content.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
  }

  async function save(): Promise<boolean> {
    if (!draft) return false
    if (section === 'api' && !apiSettings.validate()) return false
    saveButton.disabled = true
    saveButton.textContent = '保存中…'
    try {
      const result = await bridge.saveSettings(draft)
      settings = result.settings
      draft = createSettingsUpdate(result.settings)
      baseline = serializedDraft()
      options.onSnapshot(result.snapshot)
      renderSection()
      options.showToast('设置已保存并应用')
      return true
    } catch (error) {
      options.showToast(presentDesktopError(error))
      updateDirtyState()
      return false
    } finally {
      saveButton.textContent = '保存更改'
    }
  }

  async function open(nextSection: SettingsSection = 'api'): Promise<void> {
    section = nextSection
    if (!isOpen()) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await options.onOpen?.()
    }
    searchInput.value = ''
    filterNavigation('')
    overlay.classList.add('visible')
    overlay.setAttribute('aria-hidden', 'false')
    content.innerHTML = '<div class="settings-loading">正在读取设置…</div>'
    desktopShell?.setAttribute('inert', '')
    if (section === 'appearance') {
      renderSection()
      requestAnimationFrame(() => backButton.focus({ preventScroll: true }))
      return
    }
    try {
      await ensureSettings(false)
      renderSection()
      requestAnimationFrame(() => backButton.focus({ preventScroll: true }))
    } catch (error) {
      content.innerHTML = `<div class="settings-empty"><strong>设置读取失败</strong><p>${escapeHtml(presentDesktopError(error))}</p></div>`
    }
  }

  async function openProfiles(mode: 'library' | 'create' | 'import' = 'library'): Promise<void> {
    await open('data')
    if (mode === 'create') profileCenter?.showCreate()
    if (mode === 'import') await profileImportWizard.open()
  }

  function close(): void {
    if (!isOpen()) return
    apiSettings.reset()
    if (settings) {
      draft = createSettingsUpdate(settings)
      baseline = serializedDraft()
      updateDirtyState()
    }
    overlay.classList.remove('visible')
    overlay.setAttribute('aria-hidden', 'true')
    desktopShell?.removeAttribute('inert')
    popover.classList.remove('visible')
    popover.setAttribute('aria-hidden', 'true')
    activePickerAnchor = null
    if (remoteRefreshTimer) clearTimeout(remoteRefreshTimer)
    remoteRefreshTimer = null
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(anchor => anchor.setAttribute('aria-expanded', 'false'))
    options.onClose?.()
    const focusTarget = previousFocus
    previousFocus = null
    if (focusTarget?.isConnected && overlay.contains(document.activeElement)) {
      requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }))
    }
  }

  function isOpen(): boolean {
    return overlay.classList.contains('visible')
  }

  function positionModelPicker(anchor: HTMLElement, mainWidth = 252): void {
    const rect = anchor.getBoundingClientRect()
    const position = anchoredComposerPopoverPosition(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      mainWidth,
      options.getComposerPopoverPlacement?.() || 'above',
    )
    activePickerAnchor = anchor
    activePickerWidth = mainWidth
    popover.classList.remove('submenu-left')
    popover.dataset.placement = position.placement
    popover.style.left = `${position.left}px`
    popover.style.width = `${position.width}px`
    popover.style.right = 'auto'
    popover.style.top = position.top === null ? 'auto' : `${position.top}px`
    popover.style.bottom = position.bottom === null ? 'auto' : `${position.bottom}px`
    popover.style.maxHeight = `${position.maxHeight}px`
    popover.style.transformOrigin = position.transformOrigin
  }

  function repositionComposerPicker(): void {
    if (!popover.classList.contains('visible') || !activePickerAnchor?.isConnected) return
    positionModelPicker(activePickerAnchor, activePickerWidth)
  }

  function hidePicker(): void {
    popover.classList.remove('visible')
    popover.setAttribute('aria-hidden', 'true')
    activePickerAnchor = null
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(item => item.setAttribute('aria-expanded', 'false'))
  }

  function applySettingsModelSelection(profile: WorkbenchApiConfigInput, model: WorkbenchModelOption): void {
    applyApiModel(profile, model.model, model)
    if (settings && draft) {
      const selected = selectedProfile(draft)
      if (selected?.id === profile.id) selected.reasoning = profile.reasoning ? { ...profile.reasoning } : undefined
    }
  }

  async function persistQuickChange(behavior: { keepPickerOpen?: boolean; applySnapshot?: boolean } = {}): Promise<WorkbenchSnapshot | null> {
    if (!draft) return null
    updateDirtyState()
    try {
      const result = await bridge.saveSettings({ ...draft, mcpServers: undefined })
      settings = result.settings
      draft = createSettingsUpdate(result.settings)
      baseline = serializedDraft()
      if (behavior.applySnapshot !== false) options.onSnapshot(result.snapshot)
      if (!behavior.keepPickerOpen) hidePicker()
      return result.snapshot
    } catch (error) {
      options.showToast(presentDesktopError(error))
      return null
    }
  }

  async function openModelPicker(anchor: HTMLElement): Promise<void> {
    if (popover.classList.contains('visible') && activePickerAnchor === anchor) {
      hidePicker()
      return
    }
    positionModelPicker(anchor, 276)
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(item => item.setAttribute('aria-expanded', String(item === anchor)))
    popover.className = 'model-popover model-only-popover'
    popover.innerHTML = '<div class="model-quick-menu model-picker-loading" role="status" aria-live="polite"><span class="model-picker-spinner"></span><span>正在读取模型…</span></div>'
    popover.classList.add('visible')
    popover.setAttribute('aria-hidden', 'false')
    try {
      await ensureSettings(false)
    } catch (error) {
      if (!popover.classList.contains('visible')) return
      const message = presentDesktopError(error)
      popover.innerHTML = `<div class="model-quick-menu model-picker-error"><strong>模型读取失败</strong><span>${escapeHtml(message)}</span></div>`
      return
    }
    if (!popover.classList.contains('visible')) return
    if (!settings || !draft) return
    const profile = selectedProfile(draft)
    if (!profile) return void open('api')
    const currentModel = modelFor(settings, profile.model)
    const candidates = settings.models.filter(item => profile.provider === 'custom' || profile.provider === 'openrouter' || item.provider === profile.provider)
    const current = candidates.find(item => item.model === profile.model)
    const ordered = current ? [current, ...candidates.filter(item => item !== current)] : candidates
    const modelIdentity = (item: WorkbenchModelOption) => {
      const provider = item.provider
      return `<span class="model-selection-icon" data-provider="${escapeHtml(normalizedModelProvider(provider, item.model))}">${modelProviderMark(provider, item.model)}</span><span class="model-selection-copy"><strong>${escapeHtml(item.name)}</strong>${item.name !== item.model ? `<small>${escapeHtml(item.model)}</small>` : ''}</span>`
    }
    popover.innerHTML = `
      <div class="model-only-menu">
        <header><span>模型</span><strong>${escapeHtml(currentModel?.name || profile.model || '未配置')}</strong></header>
        <div class="model-submenu-list model-selection-list ${ordered.length > 6 ? 'scrollable' : ''}">${ordered.map(item => `<button data-quick-model="${escapeHtml(item.model)}" class="${item.model === profile.model ? 'selected' : ''}">${modelIdentity(item)}<i aria-hidden="true">${item.model === profile.model ? settingsInlineIcon('check') : ''}</i></button>`).join('') || '<div class="model-submenu-empty">没有发现可用模型</div>'}</div>
        <button class="model-popover-footer" data-model-settings>模型与 API 设置 <i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></i></button>
      </div>`
    popover.querySelectorAll<HTMLButtonElement>('[data-quick-model]').forEach(button => button.addEventListener('click', async () => {
      const chosen = modelFor(settings!, button.dataset.quickModel || '')
      if (!chosen) return
      if (chosen.model === profile.model) {
        hidePicker()
        return
      }
      applySettingsModelSelection(profile, chosen)
      await persistQuickChange()
    }))
    popover.querySelector('[data-model-settings]')?.addEventListener('click', () => {
      hidePicker()
      void open('api')
    })
  }

  async function openReasoningPicker(anchor: HTMLElement): Promise<void> {
    if (popover.classList.contains('visible') && activePickerAnchor === anchor) {
      hidePicker()
      return
    }
    positionModelPicker(anchor, 340)
    app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(item => item.setAttribute('aria-expanded', String(item === anchor)))
    popover.className = 'model-popover reasoning-popover'
    popover.innerHTML = '<div class="reasoning-choice-card model-picker-loading" role="status" aria-live="polite"><span class="model-picker-spinner"></span><span>正在读取推理能力…</span></div>'
    popover.classList.add('visible')
    popover.setAttribute('aria-hidden', 'false')
    try {
      await ensureSettings()
    } catch (error) {
      if (!popover.classList.contains('visible')) return
      const message = presentDesktopError(error)
      popover.innerHTML = `<div class="reasoning-choice-card model-picker-error"><strong>推理设置读取失败</strong><span>${escapeHtml(message)}</span></div>`
      return
    }
    if (!popover.classList.contains('visible') || !settings || !draft) return
    const profile = selectedProfile(draft)
    if (!profile) return void open('api')
    const model = modelFor(settings, profile.model)
    const capability = model?.reasoningCapabilities
    if (!capability) {
      popover.innerHTML = '<div class="reasoning-choice-card reasoning-unavailable"><strong>当前模型没有可调整的推理强度</strong><span>模型仍会使用服务商默认行为。</span></div>'
      return
    }
    const effectiveReasoning = effectiveReasoningConfig(profile.reasoning, model?.reasoning, capability)
    const reasoningOptions = buildReasoningOptions(capability, effectiveReasoning)
    const activeIndex = reasoningOptionIndex(reasoningOptions, effectiveReasoning)
    const active = reasoningOptions[activeIndex]
    if (!active) {
      popover.innerHTML = '<div class="reasoning-choice-card reasoning-unavailable"><strong>该模型的推理强度固定</strong><span>无需手动调整。</span></div>'
      return
    }
    const defaultReasoning = effectiveReasoningConfig(undefined, model?.reasoning, capability)
    const defaultIndex = reasoningOptionIndex(reasoningOptions, defaultReasoning)
    const activeProgress = reasoningSliderProgress(activeIndex, reasoningOptions.length) / 100
    const lastReasoningIndex = reasoningOptions.length - 1
    const matrixColumns = 72
    const matrixRows = 5
    const matrixCells = Array.from({ length: matrixColumns * matrixRows }, (_, index) => {
      const column = index % matrixColumns
      const row = Math.floor(index / matrixColumns)
      const horizontalProgress = column / (matrixColumns - 1)
      const rowTaper = 0.78 + (1 - Math.abs(2 - row) / 2) * 0.22
      const noise = ((((column * 7) + (row * 11)) % 9) - 4) * 0.018
      const opacity = Math.max(0.16, Math.min(0.94, (0.2 + horizontalProgress * 0.7 + noise) * rowTaper))
      const tint = Math.round(18 + horizontalProgress * 78)
      return `<i class="reasoning-slider-matrix-cell" style="--matrix-opacity:${opacity.toFixed(2)};--matrix-tint:${tint}%;--matrix-delay:${matrixColumns - column + Math.abs(2 - row)}"></i>`
    }).join('')
    popover.innerHTML = `
      <div class="reasoning-choice-card${active.tone === 'max' ? ' is-peak' : ''}" data-reasoning-tone="${active.tone}" style="--reasoning-progress:${activeProgress};--reasoning-particle-clip:${(1 - activeProgress) * 100}%;--reasoning-particle-start:${activeProgress * 100}%;--reasoning-count:${reasoningOptions.length}">
        <header><strong>推理强度 <span id="reasoning-choice-name">${escapeHtml(active.label)}</span></strong><span aria-hidden="true">更快 <i></i> 更深入</span></header>
        <div class="reasoning-slider-shell">
          <div class="reasoning-slider-rail" aria-hidden="true">
            <div class="reasoning-slider-track">
              <span class="reasoning-slider-fill"></span>
              <span class="reasoning-slider-matrix">${matrixCells}</span>
              <span class="reasoning-slider-flow"></span>
            </div>
            <div class="reasoning-slider-marks">${reasoningOptions.map((_, index) => `<i class="reasoning-slider-mark${index <= activeIndex ? ' filled' : ''}${index === activeIndex ? ' current' : ''}${index === lastReasoningIndex ? ' peak' : ''}"></i>`).join('')}</div>
            <span class="reasoning-slider-thumb"></span>
          </div>
          <input id="reasoning-slider" type="range" min="0" max="${lastReasoningIndex}" step="0.001" value="${activeIndex}" aria-label="推理强度" aria-valuetext="${escapeHtml(active.label)}">
        </div>
        <div class="reasoning-choice-caption" aria-live="polite"><span id="reasoning-choice-detail">${escapeHtml(active.detail)}</span><small id="reasoning-choice-default" ${activeIndex === defaultIndex ? '' : 'hidden'}>模型默认</small></div>
      </div>`
    const card = popover.querySelector<HTMLElement>('.reasoning-choice-card')!
    const slider = popover.querySelector<HTMLInputElement>('#reasoning-slider')!
    const value = popover.querySelector<HTMLElement>('#reasoning-choice-name')!
    const detail = popover.querySelector<HTMLElement>('#reasoning-choice-detail')!
    const defaultLabel = popover.querySelector<HTMLElement>('#reasoning-choice-default')!
    const reasoningTab = app.querySelector<HTMLElement>('#reasoning-tab')
    if (reasoningTab) reasoningTab.dataset.reasoningTone = active.tone
    let displayedReasoningIndex = activeIndex
    let notchAnimationTimer: number | null = null
    let particleSweepTimer: number | null = null
    const preview = (rawValue: number, selectNearest = false) => {
      const index = selectNearest
        ? reasoningSliderIndex(rawValue, reasoningOptions.length)
        : reasoningSliderDetentIndex(rawValue, reasoningOptions.length, displayedReasoningIndex)
      const option = reasoningOptions[index]
      if (!option) return
      const detentValue = reasoningSliderDetentValue(rawValue, reasoningOptions.length, index)
      const detentProgress = reasoningSliderProgress(detentValue, reasoningOptions.length) / 100
      card.style.setProperty('--reasoning-progress', String(detentProgress))
      card.style.setProperty('--reasoning-particle-clip', `${(1 - detentProgress) * 100}%`)
      card.style.setProperty('--reasoning-particle-start', `${detentProgress * 100}%`)
      card.dataset.reasoningTone = option.tone
      card.classList.toggle('is-peak', option.tone === 'max')
      if (index !== displayedReasoningIndex) {
        card.classList.remove('is-shifting')
        void card.offsetWidth
        card.classList.add('is-shifting')
        value.textContent = option.label
        detail.textContent = option.detail
        defaultLabel.hidden = index !== defaultIndex
        displayedReasoningIndex = index
        if (notchAnimationTimer !== null) window.clearTimeout(notchAnimationTimer)
        if (particleSweepTimer !== null) window.clearTimeout(particleSweepTimer)
        card.classList.remove('is-notching', 'is-particle-sweeping')
        void card.offsetWidth
        card.classList.add('is-notching', 'is-particle-sweeping')
        notchAnimationTimer = window.setTimeout(() => {
          card.classList.remove('is-notching')
          notchAnimationTimer = null
        }, 190)
        particleSweepTimer = window.setTimeout(() => {
          card.classList.remove('is-particle-sweeping')
          particleSweepTimer = null
        }, 460)
      }
      slider.setAttribute('aria-valuenow', String(index))
      slider.setAttribute('aria-valuetext', `${option.label}，${option.detail}${index === defaultIndex ? '，模型默认' : ''}`)
      const reasoningName = app.querySelector<HTMLElement>('#reasoning-name')
      if (reasoningName) reasoningName.textContent = option.label
      if (reasoningTab) reasoningTab.dataset.reasoningTone = option.tone
      popover.querySelectorAll<HTMLElement>('.reasoning-slider-mark').forEach((mark, markIndex) => {
        mark.classList.toggle('filled', markIndex <= index)
        mark.classList.toggle('current', markIndex === index)
      })
    }
    let latestReasoningIndex = activeIndex
    let reasoningRevision = 0
    let persistedReasoningRevision = 0
    let reasoningPersistTimer: number | null = null
    let reasoningPersisting = false
    const persistLatestReasoning = async () => {
      if (reasoningPersisting) return
      reasoningPersisting = true
      let latestSnapshot: WorkbenchSnapshot | null = null
      let persistFailed = false
      try {
        while (persistedReasoningRevision < reasoningRevision) {
          const targetRevision = reasoningRevision
          const index = latestReasoningIndex
          const option = reasoningOptions[index]
          const currentProfile = draft ? selectedProfile(draft) : undefined
          if (!option || !currentProfile) {
            persistedReasoningRevision = targetRevision
            continue
          }
          currentProfile.reasoning = { ...option.config }
          applyApiModelCapabilities(currentProfile, model)
          const snapshot = await persistQuickChange({ keepPickerOpen: true, applySnapshot: false })
          if (!snapshot) {
            persistFailed = true
            return
          }
          latestSnapshot = snapshot
          persistedReasoningRevision = targetRevision
          if (reasoningRevision > persistedReasoningRevision && draft) {
            const pendingProfile = selectedProfile(draft)
            const pendingOption = reasoningOptions[latestReasoningIndex]
            if (pendingProfile && pendingOption) pendingProfile.reasoning = { ...pendingOption.config }
          }
        }
      } finally {
        reasoningPersisting = false
        if (!persistFailed && persistedReasoningRevision < reasoningRevision) {
          void persistLatestReasoning()
        } else if (latestSnapshot) {
          options.onSnapshot(latestSnapshot)
        }
      }
    }
    const commit = (index: number) => {
      if (index === latestReasoningIndex) return
      const option = reasoningOptions[index]
      const currentProfile = draft ? selectedProfile(draft) : undefined
      if (!option || !currentProfile) return
      currentProfile.reasoning = { ...option.config }
      applyApiModelCapabilities(currentProfile, model)
      latestReasoningIndex = index
      reasoningRevision += 1
      if (reasoningPersistTimer !== null) window.clearTimeout(reasoningPersistTimer)
      reasoningPersistTimer = window.setTimeout(() => {
        reasoningPersistTimer = null
        void persistLatestReasoning()
      }, 80)
    }
    const settleAt = (index: number) => {
      slider.value = String(index)
      if (notchAnimationTimer !== null) window.clearTimeout(notchAnimationTimer)
      notchAnimationTimer = null
      card.classList.remove('is-dragging')
      card.classList.remove('is-notching')
      card.classList.add('is-settling')
      preview(index, true)
      window.setTimeout(() => card.classList.remove('is-settling'), 420)
    }
    const finishDragging = () => {
      if (!card.classList.contains('is-dragging')) return
      const index = displayedReasoningIndex
      settleAt(index)
      void commit(index)
    }
    let selectNearestOnInput = false
    slider.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return
      const bounds = slider.getBoundingClientRect()
      const progress = reasoningSliderProgress(Number(slider.value), reasoningOptions.length) / 100
      const thumbCenter = bounds.left + 16 + (bounds.width - 32) * progress
      selectNearestOnInput = Math.abs(event.clientX - thumbCenter) > 16
      card.classList.remove('is-settling')
      card.classList.add('is-dragging')
    })
    slider.addEventListener('input', () => {
      const dragging = card.classList.contains('is-dragging')
      preview(Number(slider.value), selectNearestOnInput || !dragging)
      selectNearestOnInput = false
      if (!dragging) {
        settleAt(displayedReasoningIndex)
        void commit(displayedReasoningIndex)
      }
    })
    slider.addEventListener('change', finishDragging)
    slider.addEventListener('pointerup', finishDragging)
    slider.addEventListener('lostpointercapture', finishDragging)
    slider.addEventListener('pointercancel', () => settleAt(latestReasoningIndex))
    slider.addEventListener('keydown', event => {
      const index = reasoningSliderIndex(Number(slider.value), reasoningOptions.length)
      let nextIndex = index
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1)
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = Math.min(reasoningOptions.length - 1, index + 1)
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = reasoningOptions.length - 1
      else return
      event.preventDefault()
      settleAt(nextIndex)
      void commit(nextIndex)
    })
  }

  overlay.querySelector('#settings-back')?.addEventListener('click', close)
  overlay.querySelector('#settings-cancel')?.addEventListener('click', close)
  saveButton.addEventListener('click', () => void save())
  overlay.querySelectorAll<HTMLButtonElement>('[data-settings-section]').forEach(button => button.addEventListener('click', async () => {
    section = button.dataset.settingsSection as SettingsSection
    content.scrollTop = 0
    if (section === 'appearance' || (settings && draft)) {
      renderSection()
      return
    }
    content.innerHTML = '<div class="settings-loading">正在读取设置…</div>'
    try {
      await ensureSettings(false)
      renderSection()
    } catch (error) {
      content.innerHTML = `<div class="settings-empty"><strong>设置读取失败</strong><p>${escapeHtml(presentDesktopError(error))}</p></div>`
    }
  }))
  searchInput.addEventListener('input', () => filterNavigation(searchInput.value))
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      overlay.querySelector<HTMLButtonElement>('[data-settings-section]:not([hidden])')?.click()
      return
    }
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault()
      event.stopPropagation()
      searchInput.value = ''
      filterNavigation('')
    }
  })
  overlay.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && !element.closest('[inert]') && element.checkVisibility({ checkVisibilityCSS: true }))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })
  document.addEventListener('keydown', event => {
    if (!isOpen() || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  })
  document.addEventListener('pointerdown', event => {
    if (!popover.classList.contains('visible')) return
    const target = event.target as Node
    if (!popover.contains(target) && !(target instanceof Element && target.closest('#model-pill, #reasoning-tab'))) {
      popover.classList.remove('visible')
      popover.setAttribute('aria-hidden', 'true')
      activePickerAnchor = null
      app.querySelectorAll<HTMLElement>('#model-pill, #reasoning-tab').forEach(anchor => anchor.setAttribute('aria-expanded', 'false'))
    }
  })
  window.addEventListener('resize', repositionComposerPicker)
  window.addEventListener('turboflux:background-media-change', () => {
    if (isOpen() && section === 'appearance') renderAppearance()
  })
  window.addEventListener('turboflux:workbench-mode-change', () => {
    if (isOpen() && section === 'appearance') renderAppearance()
  })



  return { open, openProfiles, openModelPicker, openReasoningPicker, repositionComposerPicker, close, isOpen, handleSettingsUpdate }
}
