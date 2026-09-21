import type { WorkbenchApiConfigInput, WorkbenchModelOption, WorkbenchSettingsSnapshot, WorkbenchSettingsUpdate } from '@turboflux/workbench'
import { maskedApiKey } from '@turboflux/presentation'
import { Check, ChevronDown, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Search, Server, Trash2, X, createElement, type IconNode } from 'lucide'
import { presentDesktopError } from './conversationRendering'
import { modelProviderMark, normalizedModelProvider } from './modelPresentation'
import { buildReasoningOptions, effectiveReasoningConfig, reasoningOptionIndex } from './reasoningPresentation'
import { apiConnectionFingerprint, apiModelsForProfile, apiProviderPreset, applyApiModel, applyApiModelCapabilities, normalizedApiUrl, reconcileDiscoveredProfileModel } from './apiSettingsModel'

interface ApiSettingsOptions {
  onChange(): void
  showToast(message: string): void
}

interface ModelCatalog {
  fingerprint: string
  models: WorkbenchModelOption[]
  discovery: WorkbenchSettingsSnapshot['modelDiscovery']
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

function icon(node: IconNode): string {
  return createElement(node, { width: 16, height: 16, 'stroke-width': 1.7, 'aria-hidden': 'true' }).outerHTML
}

function field(label: string, control: string): string {
  return `<label class="api-field"><span>${label}</span>${control}</label>`
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function createApiSettingsPage(bridge: Pick<TurboFluxDesktopBridge, 'previewSettingsModels'>, options: ApiSettingsOptions) {
  let host: HTMLElement
  let settings: WorkbenchSettingsSnapshot
  let draft: WorkbenchSettingsUpdate
  let selectedId = ''
  let editingKeyId = ''
  let previousKey = ''
  let advancedOpen = false
  let deletePending = false
  let pickerOpen = false
  let query = ''
  let highlighted = 0
  let revision = 0
  const catalogs = new Map<string, ModelCatalog>()
  const requests = new Map<string, number>()

  function selectedProfile(): WorkbenchApiConfigInput | undefined {
    return draft.apiProfiles.find(item => item.id === selectedId)
      ?? draft.apiProfiles.find(item => item.id === draft.activeApiConfigId)
      ?? draft.apiProfiles[0]
  }

  function catalogFor(profile: WorkbenchApiConfigInput): ModelCatalog | undefined {
    const fingerprint = apiConnectionFingerprint(profile)
    const cached = catalogs.get(profile.id)
    if (cached?.fingerprint === fingerprint) return cached
    return settingsCatalogFor(profile)
  }

  function settingsCatalogFor(profile: WorkbenchApiConfigInput): ModelCatalog | undefined {
    const fingerprint = apiConnectionFingerprint(profile)
    const saved = settings.apiProfiles.find(item => item.id === settings.activeApiConfigId) ?? settings.apiProfiles[0]
    if (saved && apiConnectionFingerprint({ ...saved, apiKey: '' }) === fingerprint) {
      return { fingerprint, models: settings.models, discovery: settings.modelDiscovery }
    }
    return undefined
  }

  function modelsFor(profile: WorkbenchApiConfigInput): WorkbenchModelOption[] {
    return apiModelsForProfile(catalogFor(profile)?.models ?? settings.models.filter(item => item.availability === 'builtin'), profile)
  }

  function modelFor(profile: WorkbenchApiConfigInput): WorkbenchModelOption | undefined {
    return modelsFor(profile).find(item => item.model === profile.model || item.id === profile.model)
  }

  function modelsLoading(profile: WorkbenchApiConfigInput): boolean {
    return requests.has(profile.id) || Boolean(settingsCatalogFor(profile)?.discovery.refreshing)
  }

  function catalogStatus(profile: WorkbenchApiConfigInput): string {
    const catalog = catalogFor(profile)
    if (modelsLoading(profile)) return '正在获取模型'
    return catalog?.discovery.error ? '获取失败' : !catalog ? '尚未获取' : catalog.discovery.stale ? '缓存已过期'
      : catalog.discovery.source === 'network' ? '已从 API 获取' : catalog.discovery.source === 'cache' ? '本地缓存' : '内置列表'
  }

  function profileOptionLabel(profile: WorkbenchApiConfigInput): string {
    return `${profile.name || '未命名连接'}${profile.id === draft.activeApiConfigId ? ' · 当前连接' : ''}`
  }

  function modelTriggerMarkup(profile: WorkbenchApiConfigInput): string {
    const model = modelFor(profile)
    const loading = modelsLoading(profile)
    const name = model?.name || profile.model || (loading ? '正在获取模型' : '选择模型')
    return `<span class="api-provider-mark" data-provider="${normalizedModelProvider(model?.provider || profile.provider, profile.model)}">${modelProviderMark(model?.provider || profile.provider, profile.model)}</span>
      <span class="api-model-copy"><strong>${escapeHtml(name)}</strong>${profile.model && profile.model !== name ? `<code>${escapeHtml(profile.model)}</code>` : ''}</span>${loading ? `<span class="api-trigger-status"><span class="api-loading-icon">${icon(LoaderCircle)}</span>${profile.model ? '<span>获取中</span>' : ''}</span>` : ''}${icon(ChevronDown)}`
  }

  function modelMarkup(profile: WorkbenchApiConfigInput): string {
    const model = modelFor(profile)
    const models = modelsFor(profile)
    return `<section class="api-section" aria-labelledby="api-model-heading">
      <header class="api-section-heading"><h4 id="api-model-heading">模型</h4><button type="button" class="api-text-action" id="refresh-models">${icon(RefreshCw)}<span>刷新模型</span></button></header>
      <div class="api-model-picker">
        <button type="button" id="profile-model" class="api-model-trigger" title="${escapeHtml(profile.model)}" aria-label="选择模型" aria-expanded="${pickerOpen}" aria-controls="api-model-menu" aria-haspopup="listbox">
          ${modelTriggerMarkup(profile)}
        </button>
        <div id="api-model-menu" class="api-model-menu" popover="manual">
          <div class="api-model-search">${icon(Search)}<input id="api-model-search" type="search" role="combobox" aria-label="搜索模型或输入模型 ID" aria-autocomplete="list" aria-expanded="true" aria-controls="api-model-results" autocomplete="off" spellcheck="false" placeholder="搜索模型或输入模型 ID" value="${escapeHtml(query)}"><button type="button" class="api-icon-action" id="api-model-close" aria-label="关闭模型列表" title="关闭模型列表">${icon(X)}</button></div>
          <div id="api-menu-loading" class="api-menu-loading" role="status" hidden><span class="api-loading-icon">${icon(LoaderCircle)}</span><span>正在获取模型</span></div>
          <div class="api-model-results" id="api-model-results" role="listbox" tabindex="-1" aria-label="可选模型"></div>
          <div class="api-model-result-count" id="api-model-result-count" role="status"></div>
        </div>
      </div>
      <div class="api-model-meta"><span class="api-catalog-state" role="status"></span><span id="api-model-context">${models.length} 个模型${model ? ` · ${tokenCount(profile.contextWindow)} 上下文` : ''}</span></div>
      <div id="api-model-error"></div>
      <div id="api-reasoning-controls">${reasoningMarkup(profile, model)}</div>
    </section>`
  }

  function reasoningMarkup(profile: WorkbenchApiConfigInput, model?: WorkbenchModelOption): string {
    const capability = model?.reasoningCapabilities
    if (!capability) return ''
    const config = effectiveReasoningConfig(profile.reasoning, model?.reasoning, capability)
    const choices = buildReasoningOptions(capability, config)
    const selected = choices[reasoningOptionIndex(choices, config)]
    const enabled = config.enabled !== false && config.effort !== 'none'
    const toggle = capability.supportsToggle
      ? `<label class="settings-switch"><input id="reasoning-enabled" type="checkbox" ${enabled ? 'checked' : ''}><span></span><b>启用推理</b></label>`
      : '<span class="api-fixed-value">始终开启</span>'
    const control = choices.length
      ? field('推理强度', `<select id="reasoning-effort" ${enabled ? '' : 'disabled'}>${choices.map(choice => `<option value="${choice.config.effort || choice.id}" ${choice.id === selected?.id ? 'selected' : ''}>${choice.label}</option>`).join('')}</select>`)
      : ''
    return `<div class="api-reasoning"><div class="api-reasoning-label"><strong>推理</strong>${toggle}</div>${control}</div>`
  }

  function keyMarkup(profile: WorkbenchApiConfigInput): string {
    const saved = settings.apiProfiles.find(item => item.id === profile.id)
    const preview = maskedApiKey(profile.apiKey || '') || saved?.apiKeyPreview || (saved?.hasApiKey ? '********' : '')
    const editing = editingKeyId === profile.id || !preview
    return `<div class="api-field api-key-field">${editing ? '<label for="profile-api-key">API 密钥</label>' : '<span>API 密钥</span>'}${editing
      ? `<div class="api-key-editor"><input id="profile-api-key" type="password" value="${escapeHtml(profile.apiKey || '')}" placeholder="输入 API Key" autocomplete="new-password" spellcheck="false" aria-label="API 密钥"><button type="button" class="api-icon-action" id="api-key-done" title="完成密钥输入" aria-label="完成密钥输入">${icon(Check)}</button>${preview ? `<button type="button" class="api-icon-action" id="api-key-cancel" title="取消更换密钥" aria-label="取消更换密钥">${icon(X)}</button>` : ''}</div>`
      : `<div class="api-key-preview">${icon(KeyRound)}<code aria-label="API 密钥摘要">${escapeHtml(preview)}</code><span>${profile.apiKey?.trim() ? '待保存' : '已保存'}</span><button type="button" class="api-icon-action" id="api-key-edit" title="更换密钥" aria-label="更换密钥">${icon(Pencil)}</button></div>`}</div>`
  }

  function renderView(focusId?: string): void {
    if (!host || host.dataset.section !== 'api') return
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null
    const restoreId = focusId ?? focused?.id
    const selection = focused instanceof HTMLInputElement && ['text', 'password', 'search', 'url'].includes(focused.type) ? [focused.selectionStart, focused.selectionEnd] : null
    const profile = selectedProfile()
    if (profile) selectedId = profile.id
    host.innerHTML = `<div class="api-workspace">
      ${profile ? `<header class="api-connection-toolbar">
        <div class="api-field api-connection-selector"><label for="api-profile-select">API 连接</label><select id="api-profile-select" title="${escapeHtml(profile.name || '未命名连接')}">${draft.apiProfiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(profileOptionLabel(item))}</option>`).join('')}</select></div>
        <div class="api-detail-actions">${profile.id === draft.activeApiConfigId ? `<span class="api-active-label">${icon(Check)}当前连接</span>` : '<button type="button" class="api-text-action" id="profile-activate">设为当前连接</button>'}<button type="button" class="api-icon-action" id="profile-add" title="新建连接" aria-label="新建连接">${icon(Plus)}</button><button type="button" class="api-icon-action danger" id="profile-delete" title="删除连接" aria-label="删除连接">${icon(Trash2)}</button></div>
      </header>` : ''}
      <div class="api-detail">${profile ? `
        ${deletePending ? `<div class="api-delete-confirm" role="alert"><span>删除「${escapeHtml(profile.name || '未命名连接')}」？</span><button type="button" class="api-text-action" id="profile-delete-cancel">取消</button><button type="button" class="api-text-action danger" id="profile-delete-confirm">删除</button></div>` : ''}
        <section class="api-section" aria-labelledby="api-connection-heading"><header class="api-section-heading"><h4 id="api-connection-heading">连接配置</h4></header><div class="api-field-grid">
          ${field('连接名称', `<input id="profile-name" value="${escapeHtml(profile.name)}" autocomplete="off" placeholder="为连接命名" required>`)}
          ${field('服务商', `<select id="profile-provider">${settings.providerPresets.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === apiProviderPreset(settings, profile)?.id ? 'selected' : ''}>${escapeHtml(item.id === 'custom' ? '自定义 / OpenAI 兼容' : item.name)}</option>`).join('')}</select>`)}
          ${field('API 地址', `<input id="profile-base-url" type="url" value="${escapeHtml(profile.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false">`)}
          ${keyMarkup(profile)}
        </div></section>
        ${modelMarkup(profile)}
        <details class="api-advanced" ${advancedOpen ? 'open' : ''}><summary>${icon(ChevronDown)}<span>高级参数</span><small>上下文与输出长度</small></summary><div class="api-token-fields">
          ${field('上下文窗口', `<input id="profile-context" type="number" min="1024" step="1" value="${profile.contextWindow}" required>`)}
          ${field('单次输出上限', `<input id="profile-max-tokens" type="number" min="1" step="1" value="${profile.maxTokens}" required>`)}
          ${field('模型最大输出', `<input id="profile-max-output" type="number" min="1" step="1" value="${profile.maxOutputTokens || ''}" placeholder="自动">`)}
        </div></details>
      ` : `<div class="api-empty">${icon(Server)}<h3>尚无 API 连接</h3><button type="button" class="settings-primary" id="profile-add-empty">${icon(Plus)}新建连接</button></div>`}</div>
    </div>`
    bindEvents(profile)
    if (profile) updateDiscoveryState(profile)
    if (pickerOpen && profile) showPicker(profile)
    const restore = restoreId ? host.querySelector<HTMLElement>(`#${restoreId}`) : null
    restore?.focus({ preventScroll: true })
    if (restore instanceof HTMLInputElement && selection?.[0] != null) restore.setSelectionRange(selection[0], selection[1])
  }

  function renderResults(profile: WorkbenchApiConfigInput): void {
    const loading = modelsLoading(profile)
    const models = apiModelsForProfile(modelsFor(profile), profile, query)
    const custom = query.trim() && !models.some(item => item.model.toLowerCase() === query.trim().toLowerCase())
    const count = models.length + (custom ? 1 : 0)
    highlighted = Math.max(0, Math.min(highlighted, count - 1))
    host.querySelector('#api-model-results')!.innerHTML = models.map((item, index) => `<button type="button" role="option" tabindex="-1" id="api-model-option-${index}" data-api-model="${escapeHtml(item.model)}" title="${escapeHtml(`${item.name}\n${item.model}`)}" aria-selected="${item.model === profile.model}" class="api-model-option ${index === highlighted ? 'highlighted' : ''}"><span class="api-provider-mark" data-provider="${normalizedModelProvider(item.provider, item.model)}">${modelProviderMark(item.provider, item.model)}</span><span class="api-model-copy"><strong>${escapeHtml(item.name)}</strong><code>${escapeHtml(item.model)}</code></span><span class="api-option-context">${tokenCount(item.contextWindow)}</span><span class="api-option-check">${item.model === profile.model ? icon(Check) : ''}</span></button>`).join('')
      + (custom ? `<button type="button" role="option" tabindex="-1" id="api-model-option-${models.length}" data-api-model="${escapeHtml(query.trim())}" title="${escapeHtml(query.trim())}" aria-selected="false" class="api-model-option api-custom-option ${highlighted === models.length ? 'highlighted' : ''}">${icon(Plus)}<span class="api-model-copy"><strong>使用自定义模型</strong><code>${escapeHtml(query.trim())}</code></span></button>` : '')
      + (!count && !loading ? '<div class="api-model-empty">没有匹配的模型</div>' : '')
    host.querySelector('#api-model-results')!.setAttribute('aria-busy', String(loading))
    host.querySelector<HTMLElement>('#api-menu-loading')!.hidden = !loading
    host.querySelector('#api-model-result-count')!.textContent = loading ? models.length ? `已显示 ${models.length} 个模型` : '等待 API 响应' : `${models.length} 个${query.trim() ? '匹配' : '可选'}模型`
    const search = host.querySelector<HTMLInputElement>('#api-model-search')!
    if (count) search.setAttribute('aria-activedescendant', `api-model-option-${highlighted}`)
    else search.removeAttribute('aria-activedescendant')
    host.querySelectorAll<HTMLButtonElement>('[data-api-model]').forEach(button => {
      button.addEventListener('pointerdown', event => event.preventDefault())
      button.addEventListener('click', () => {
        const id = button.dataset.apiModel!
        if (id !== profile.model) {
          applyApiModel(profile, id, modelsFor(profile).find(item => item.model === id))
          options.onChange()
          updateModelControls(profile)
        }
        closePicker()
      })
    })
    positionPicker()
  }

  function updateModelControls(profile: WorkbenchApiConfigInput): void {
    const trigger = host.querySelector<HTMLButtonElement>('#profile-model')!
    trigger.innerHTML = modelTriggerMarkup(profile)
    trigger.title = profile.model
    host.querySelector('#api-model-context')!.textContent = `${modelsFor(profile).length} 个模型 · ${tokenCount(profile.contextWindow)} 上下文`
    host.querySelector('#api-reasoning-controls')!.innerHTML = reasoningMarkup(profile, modelFor(profile))
    bindReasoningEvents(profile)
    for (const [id, value] of [['profile-context', profile.contextWindow], ['profile-max-tokens', profile.maxTokens], ['profile-max-output', profile.maxOutputTokens]] as const) {
      const input = host.querySelector<HTMLInputElement>(`#${id}`)
      if (input) input.value = value == null ? '' : String(value)
    }
  }

  function updateDiscoveryState(profile: WorkbenchApiConfigInput): void {
    if (!host || host.dataset.section !== 'api' || selectedId !== profile.id) return
    const loading = modelsLoading(profile)
    const catalog = catalogFor(profile)
    const button = host.querySelector<HTMLButtonElement>('#refresh-models')!
    button.disabled = loading
    button.setAttribute('aria-busy', String(loading))
    button.querySelector('span')!.textContent = loading ? '请求中' : '刷新模型'
    const status = host.querySelector<HTMLElement>('.api-catalog-state')!
    status.classList.toggle('loading', loading)
    status.classList.toggle('error', !loading && Boolean(catalog?.discovery.error))
    status.innerHTML = `${loading ? `<span class="api-loading-icon">${icon(LoaderCircle)}</span>` : '<i></i>'}${catalogStatus(profile)}`
    host.querySelector('#api-model-error')!.innerHTML = !loading && catalog?.discovery.error ? `<p class="api-inline-error" role="alert">${escapeHtml(catalog.discovery.error)}</p>` : ''
    host.querySelector('#profile-model')!.innerHTML = modelTriggerMarkup(profile)
    if (pickerOpen) renderResults(profile)
  }

  function scrollHighlightedOption(): void {
    const results = host.querySelector<HTMLElement>('#api-model-results')!
    const option = host.querySelector<HTMLElement>(`#api-model-option-${highlighted}`)
    if (!option) return
    const list = results.getBoundingClientRect()
    const row = option.getBoundingClientRect()
    if (row.top < list.top) results.scrollTop -= list.top - row.top
    else if (row.bottom > list.bottom) results.scrollTop += row.bottom - list.bottom
  }

  function positionPicker(): void {
    const menu = host?.querySelector<HTMLElement>('#api-model-menu')
    const trigger = host?.querySelector<HTMLElement>('#profile-model')
    if (!pickerOpen || !menu?.matches(':popover-open') || !trigger) return
    const anchor = trigger.getBoundingClientRect()
    const bounds = host.getBoundingClientRect()
    const top = Math.max(8, bounds.top)
    const bottom = Math.min(window.innerHeight - 8, bounds.bottom)
    if (anchor.bottom < top || anchor.top > bottom) { dismissPicker(); return }
    const below = bottom - anchor.bottom - 6
    const above = anchor.top - top - 6
    const side = below >= 240 || below >= above ? 'bottom' : 'top'
    menu.dataset.side = side
    menu.style.width = `${Math.min(anchor.width, window.innerWidth - 16)}px`
    menu.style.maxHeight = `${Math.max(100, Math.min(286, side === 'bottom' ? below : above))}px`
    menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${side === 'bottom' ? anchor.bottom + 6 : anchor.top - menu.offsetHeight - 6}px`
  }

  function showPicker(profile: WorkbenchApiConfigInput): void {
    pickerOpen = true
    const menu = host.querySelector<HTMLElement>('#api-model-menu')!
    menu.inert = false
    host.querySelector('#profile-model')!.setAttribute('aria-expanded', 'true')
    const search = host.querySelector<HTMLInputElement>('#api-model-search')!
    search.value = query
    search.setAttribute('aria-expanded', 'true')
    renderResults(profile)
    menu.showPopover()
    positionPicker()
    search.focus({ preventScroll: true })
    scrollHighlightedOption()
  }

  function closePicker(restoreFocus = true): void {
    pickerOpen = false
    query = ''
    const menu = host.querySelector<HTMLElement>('#api-model-menu')
    if (menu) { menu.inert = true; menu.hidePopover() }
    host.querySelector('#profile-model')?.setAttribute('aria-expanded', 'false')
    host.querySelector('#api-model-search')?.setAttribute('aria-expanded', 'false')
    if (restoreFocus) host.querySelector<HTMLElement>('#profile-model')?.focus({ preventScroll: true })
  }

  function dismissPicker(): void {
    closePicker(false)
  }

  function bindEvents(profile?: WorkbenchApiConfigInput): void {
    host.querySelector('#profile-add')?.addEventListener('click', addProfile)
    host.querySelector('#profile-add-empty')?.addEventListener('click', addProfile)
    host.querySelector<HTMLSelectElement>('#api-profile-select')?.addEventListener('change', event => {
      selectedId = (event.target as HTMLSelectElement).value
      editingKeyId = ''
      deletePending = pickerOpen = advancedOpen = false
      query = ''
      renderView('api-profile-select')
      const selected = selectedProfile()
      if (selected && !catalogFor(selected)) void refreshModels(false)
    })
    if (!profile) return
    host.querySelector('#profile-activate')?.addEventListener('click', () => {
      draft.activeApiConfigId = profile.id
      options.onChange()
      renderView()
    })
    host.querySelector('#profile-delete')?.addEventListener('click', () => { deletePending = !deletePending; renderView() })
    host.querySelector('#profile-delete-cancel')?.addEventListener('click', () => { deletePending = false; renderView('profile-delete') })
    host.querySelector('#profile-delete-confirm')?.addEventListener('click', () => {
      draft.apiProfiles = draft.apiProfiles.filter(item => item.id !== profile.id)
      if (draft.activeApiConfigId === profile.id) draft.activeApiConfigId = draft.apiProfiles[0]?.id
      catalogs.delete(profile.id)
      requests.delete(profile.id)
      selectedId = draft.activeApiConfigId || ''
      deletePending = pickerOpen = false
      options.onChange()
      renderView()
    })
    host.querySelector('#refresh-models')?.addEventListener('click', () => void refreshModels(true))
    host.querySelector<HTMLInputElement>('#profile-name')?.addEventListener('input', event => {
      profile.name = (event.target as HTMLInputElement).value
      const select = host.querySelector<HTMLSelectElement>('#api-profile-select')!
      select.selectedOptions[0].textContent = profileOptionLabel(profile)
      select.title = profile.name || '未命名连接'
      options.onChange()
    })
    host.querySelector<HTMLInputElement>('#profile-base-url')?.addEventListener('input', event => {
      profile.baseUrl = (event.target as HTMLInputElement).value
      const state = host.querySelector('.api-catalog-state')
      if (state) state.textContent = '连接已修改'
      options.onChange()
    })
    host.querySelector<HTMLSelectElement>('#profile-provider')?.addEventListener('change', event => {
      const previous = apiProviderPreset(settings, profile)
      const next = settings.providerPresets.find(item => item.id === (event.target as HTMLSelectElement).value)
      if (!next) return
      profile.provider = next.provider
      if (!profile.baseUrl.trim() || normalizedApiUrl(profile.baseUrl) === normalizedApiUrl(previous?.baseUrl || '')) profile.baseUrl = next.baseUrl
      applyApiModel(profile, next.defaultModel, settings.models.find(item => item.model === next.defaultModel))
      pickerOpen = false
      options.onChange()
      renderView('profile-provider')
    })
    host.querySelector('#api-key-edit')?.addEventListener('click', () => { editingKeyId = profile.id; previousKey = profile.apiKey || ''; renderView('profile-api-key') })
    host.querySelector<HTMLInputElement>('#profile-api-key')?.addEventListener('input', event => {
      if (editingKeyId !== profile.id) previousKey = profile.apiKey || ''
      editingKeyId = profile.id
      profile.apiKey = (event.target as HTMLInputElement).value
      options.onChange()
    })
    host.querySelector('#api-key-done')?.addEventListener('click', () => { editingKeyId = ''; renderView('api-key-edit') })
    host.querySelector('#api-key-cancel')?.addEventListener('click', () => { profile.apiKey = previousKey; editingKeyId = ''; options.onChange(); renderView('api-key-edit') })
    host.querySelector<HTMLInputElement>('#profile-api-key')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); host.querySelector<HTMLButtonElement>('#api-key-done')?.click() }
      if (event.key === 'Escape') { event.stopPropagation(); host.querySelector<HTMLButtonElement>('#api-key-cancel')?.click() }
    })
    host.querySelector('#profile-model')?.addEventListener('click', () => {
      if (pickerOpen) { closePicker(); return }
      query = ''
      highlighted = Math.max(0, modelsFor(profile).findIndex(item => item.model === profile.model))
      showPicker(profile)
    })
    host.querySelector('#profile-model')?.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key !== 'ArrowDown') return
      event.preventDefault()
      query = ''
      highlighted = 0
      showPicker(profile)
    })
    host.querySelector('#api-model-close')?.addEventListener('click', () => closePicker())
    host.querySelector<HTMLInputElement>('#api-model-search')?.addEventListener('input', event => { query = (event.target as HTMLInputElement).value; highlighted = 0; renderResults(profile) })
    host.querySelector<HTMLInputElement>('#api-model-search')?.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); return }
      if (event.key === 'Enter') { event.preventDefault(); host.querySelector<HTMLButtonElement>(`#api-model-option-${highlighted}`)?.click(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const count = host.querySelectorAll('[data-api-model]').length
        highlighted = Math.max(0, Math.min(count - 1, highlighted + (event.key === 'ArrowDown' ? 1 : -1)))
        renderResults(profile)
        scrollHighlightedOption()
      }
    })
    host.querySelector<HTMLDetailsElement>('.api-advanced')?.addEventListener('toggle', event => { advancedOpen = (event.target as HTMLDetailsElement).open })
    for (const [id, key] of [['profile-context', 'contextWindow'], ['profile-max-tokens', 'maxTokens'], ['profile-max-output', 'maxOutputTokens']] as const) {
      host.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('input', event => {
        const input = event.target as HTMLInputElement
        if (key === 'maxOutputTokens' && !input.value) profile.maxOutputTokens = undefined
        else profile[key] = Number(input.value)
        options.onChange()
      })
    }
    bindReasoningEvents(profile)
  }

  function bindReasoningEvents(profile: WorkbenchApiConfigInput): void {
    const model = modelFor(profile)
    const capability = model?.reasoningCapabilities
    if (!capability) return
    const reflect = () => {
      const config = effectiveReasoningConfig(profile.reasoning, model?.reasoning, capability)
      const toggle = host.querySelector<HTMLInputElement>('#reasoning-enabled')
      const effort = host.querySelector<HTMLSelectElement>('#reasoning-effort')
      const budget = host.querySelector<HTMLInputElement>('#reasoning-budget')
      if (toggle) toggle.checked = config.enabled !== false
      if (effort) {
        const choices = buildReasoningOptions(capability, config)
        const selected = choices[reasoningOptionIndex(choices, config)]
        effort.value = selected?.config.effort || selected?.id || ''
        effort.disabled = config.enabled === false
      }
      if (budget) budget.disabled = config.enabled === false
    }
    host.querySelector<HTMLInputElement>('#reasoning-enabled')?.addEventListener('change', event => {
      const enabled = (event.target as HTMLInputElement).checked
      let config = effectiveReasoningConfig(profile.reasoning, model?.reasoning, capability)
      if (enabled && config.effort === 'none') {
        const choices = buildReasoningOptions(capability, config).filter(choice => choice.config.enabled !== false)
        config = (choices.find(choice => choice.config.effort === capability.defaultEffort) ?? choices[0])?.config || config
      }
      profile.reasoning = { ...config, enabled }
      applyApiModelCapabilities(profile, model)
      options.onChange()
      reflect()
    })
    host.querySelector<HTMLSelectElement>('#reasoning-effort')?.addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value
      const choice = buildReasoningOptions(capability, effectiveReasoningConfig(profile.reasoning, model?.reasoning, capability)).find(option => (option.config.effort || option.id) === value)
      if (!choice) return
      profile.reasoning = effectiveReasoningConfig({ ...profile.reasoning, ...choice.config }, model?.reasoning, capability)
      applyApiModelCapabilities(profile, model)
      options.onChange()
      reflect()
    })
    host.querySelector<HTMLInputElement>('#reasoning-budget')?.addEventListener('input', event => {
      const input = event.target as HTMLInputElement
      if (!input.validity.valid) return
      profile.reasoning = { ...profile.reasoning, enabled: true, budgetTokens: Number(input.value) }
      applyApiModelCapabilities(profile, model)
      options.onChange()
    })
  }

  function addProfile(): void {
    const profile: WorkbenchApiConfigInput = { id: `api_${crypto.randomUUID()}`, name: '新连接', provider: 'custom', apiKey: '', baseUrl: '', model: '', contextWindow: 200_000, maxTokens: 16_384 }
    draft.apiProfiles.push(profile)
    if (!draft.activeApiConfigId) draft.activeApiConfigId = profile.id
    selectedId = profile.id
    editingKeyId = ''
    deletePending = pickerOpen = advancedOpen = false
    options.onChange()
    renderView('profile-name')
    host.querySelector<HTMLInputElement>('#profile-name')?.select()
  }

  async function refreshModels(announce: boolean): Promise<void> {
    const profile = selectedProfile()
    if (!profile || modelsLoading(profile)) return
    const requestId = ++revision
    const currentDraft = draft
    const fingerprint = apiConnectionFingerprint(profile)
    const modelState = (item: WorkbenchApiConfigInput) => JSON.stringify([item.model, item.contextWindow, item.maxTokens, item.maxOutputTokens, item.reasoning])
    const previousModelState = modelState(profile)
    const previousModel = JSON.stringify(modelFor(profile))
    requests.set(profile.id, requestId)
    updateDiscoveryState(profile)
    try {
      const result = await bridge.previewSettingsModels(structuredClone({ ...draft, activeApiConfigId: profile.id }))
      if (draft !== currentDraft || requests.get(profile.id) !== requestId || apiConnectionFingerprint(profile) !== fingerprint) return
      catalogs.set(profile.id, { fingerprint, models: result.models, discovery: result.modelDiscovery })
      if (modelState(profile) === previousModelState && !result.modelDiscovery.error) {
        const reconciled = reconcileDiscoveredProfileModel(profile, settings.apiProfiles.find(item => item.id === profile.id), result.models)
        if (reconciled) options.onChange()
      }
      if (announce && !result.modelDiscovery.error) options.showToast(`已获取 ${result.models.filter(item => item.availability === 'api').length} 个 API 模型`)
    } catch (error) {
      if (draft !== currentDraft || requests.get(profile.id) !== requestId || apiConnectionFingerprint(profile) !== fingerprint) return
      const previous = catalogFor(profile)
      catalogs.set(profile.id, { fingerprint, models: previous?.models || modelsFor(profile), discovery: { source: previous?.discovery.source || 'fallback', stale: true, fetchedAt: previous?.discovery.fetchedAt || 0, error: presentDesktopError(error) } })
    } finally {
      if (requests.get(profile.id) === requestId) {
        requests.delete(profile.id)
        if (selectedId === profile.id && host.dataset.section === 'api') {
          if (modelState(profile) !== previousModelState || JSON.stringify(modelFor(profile)) !== previousModel) updateModelControls(profile)
          host.querySelector('#api-model-context')!.textContent = `${modelsFor(profile).length} 个模型 · ${tokenCount(profile.contextWindow)} 上下文`
          updateDiscoveryState(profile)
          if (pickerOpen) positionPicker()
        }
      }
    }
  }

  return {
    render(container: HTMLElement, snapshot: WorkbenchSettingsSnapshot, update: WorkbenchSettingsUpdate): void {
      const replaced = Boolean(draft && draft !== update)
      if (replaced) { catalogs.clear(); requests.clear(); editingKeyId = ''; pickerOpen = false }
      if (host !== container) {
        const surface = container.closest('.settings-overlay') || container
        surface.addEventListener('pointerdown', event => {
          if (pickerOpen && !(event.target as Element).closest('.api-model-picker')) dismissPicker()
        })
        container.addEventListener('focusout', event => {
          if (pickerOpen && event.relatedTarget instanceof Element && !event.relatedTarget.closest('.api-model-picker')) dismissPicker()
        })
        container.addEventListener('scroll', positionPicker, { passive: true })
        window.addEventListener('resize', positionPicker)
      }
      host = container
      settings = snapshot
      draft = update
      renderView()
      const profile = selectedProfile()
      if (replaced && profile?.baseUrl && !catalogFor(profile)) void refreshModels(false)
    },
    validate(): boolean {
      const invalid = host?.querySelector<HTMLInputElement>('input:invalid')
      if (!invalid) return true
      const details = invalid.closest('details')
      if (details) details.open = true
      invalid.reportValidity()
      invalid.focus()
      return false
    },
    reset(): void {
      if (pickerOpen) dismissPicker()
      catalogs.clear()
      requests.clear()
      selectedId = editingKeyId = query = ''
      pickerOpen = deletePending = advancedOpen = false
    },
  }
}
