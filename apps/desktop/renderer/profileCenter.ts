import type { DesktopWorkbenchSnapshot } from '../desktopTypes'
import { presentDesktopError } from './conversationRendering'
import { profileColor } from './profileSwitcher'

interface ProfileCenterOptions {
  showToast(message: string): void
  onSnapshot(snapshot: DesktopWorkbenchSnapshot): void
  onProfileSwitched(): Promise<void>
  openExport(): Promise<void>
  openImport(): Promise<void>
  openRebind(profileId: string): Promise<void>
  openConversation(conversationId: string): Promise<void>
  close(): void
}

export interface ProfileCenterController {
  render(container: HTMLElement): void
  refresh(): Promise<void>
  showCreate(): void
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
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function formatDate(value?: number): string {
  if (!value) return '尚未使用'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(value)
}

function formatRelativeDate(value?: number): string {
  if (!value) return '尚未使用'
  const current = new Date()
  const target = new Date(value)
  const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime()
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const days = Math.round((currentDay - targetDay) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDate(value)
}

function workspaceStateLabel(state: DesktopLocalProfileSummary['workspaces'][number]['state']): string {
  if (state === 'bound') return '已绑定'
  if (state === 'candidate') return '待确认'
  if (state === 'mismatch') return '需要确认'
  if (state === 'unavailable') return '位置不可用'
  return '待定位'
}

function stateLabel(profile: DesktopLocalProfileSummary): string {
  if (profile.state === 'degraded') return '需要检查'
  if (profile.state === 'importing') return '正在导入'
  if (profile.state === 'migrating') return '正在迁移'
  if (profile.state === 'trashed') return '回收区'
  return profile.active ? '当前资料' : '可切换'
}

function profileInitial(profile: DesktopLocalProfileSummary): string {
  return profile.displayName.trim().slice(0, 1).toLocaleUpperCase() || '用'
}

function profileIcon(name: 'arrow' | 'back' | 'check' | 'close' | 'conversation' | 'device' | 'folder' | 'import' | 'more' | 'plus' | 'search' | 'storage' | 'warning'): string {
  const paths = {
    arrow: '<path d="m9 18 6-6-6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    check: '<path d="m5 12 4.2 4.2L19 7"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    conversation: '<path d="M5 6.5h14v9H10l-4.5 3v-3H5Z"/>',
    device: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M9 20h6M12 16v4"/>',
    folder: '<path d="M3.5 7.5h6l1.6 2H20.5v8.5h-17Z"/>',
    import: '<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 18.5h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
    storage: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    warning: '<path d="M12 4 21 20H3L12 4Z"/><path d="M12 9v5M12 17h.01"/>',
  } as const
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}

const PROFILE_IDENTITY_COLORS = ['#7c6ee6', '#3f82c4', '#2f8c77', '#9a7137', '#b05f72', '#66758f', '#8a67a5', '#537f4f']

export function createProfileCenter(
  bridge: TurboFluxDesktopBridge,
  options: ProfileCenterOptions,
): ProfileCenterController {
  let container: HTMLElement | null = null
  let snapshot: DesktopLocalProfilesSnapshot | null = null
  let selectedId = ''
  let loading = false
  let busyId = ''
  let view: 'detail' | 'create' | 'trash' = 'detail'
  let detailTab: 'overview' | 'workspaces' | 'transfer' = 'overview'
  let search = ''
  let renameVisible = false
  let createColor = PROFILE_IDENTITY_COLORS[0]
  let mobileView: 'list' | 'detail' = 'list'

  function selectedProfile(): DesktopLocalProfileSummary | undefined {
    return snapshot?.profiles.find(profile => profile.id === selectedId)
      ?? snapshot?.profiles.find(profile => profile.active)
      ?? snapshot?.profiles[0]
  }

  function profileRow(profile: DesktopLocalProfileSummary): string {
    const selected = profile.id === selectedProfile()?.id
    const issue = profile.unboundWorkspaceCount > 0
      ? `${profile.unboundWorkspaceCount} 个工作区待定位`
      : `${profile.conversationCount} 个会话`
    return `<button type="button" class="profile-manager-row${selected ? ' selected' : ''}${profile.active ? ' active' : ''}" data-profile-select="${escapeHtml(profile.id)}" aria-current="${selected ? 'true' : 'false'}" aria-label="${escapeHtml(profile.displayName)}${profile.active ? '，当前用户' : ''}，${escapeHtml(issue)}">
      <span class="profile-manager-avatar" style="--profile-color:${profileColor(profile)}" aria-hidden="true">${escapeHtml(profileInitial(profile))}</span>
      <span class="profile-manager-row-copy"><strong>${escapeHtml(profile.displayName)}</strong><small>${escapeHtml(issue)}</small></span>
      <span class="profile-manager-row-status">${profile.unboundWorkspaceCount ? profileIcon('warning') : ''}${profile.active ? `<b>当前</b>${profileIcon('check')}` : ''}</span>
    </button>`
  }

  function detailMarkup(profile: DesktopLocalProfileSummary): string {
    const workspaceCount = profile.boundWorkspaceCount + profile.unboundWorkspaceCount
    const workspaces = profile.workspaces ?? []
    const recentConversations = profile.recentConversations ?? []
    const available = profile.state === 'ready' || profile.state === 'degraded'
    const facts = `${profile.conversationCount} 个会话 · ${workspaceCount} 个工作区 · ${formatBytes(profile.storageBytes)}`
    const identity = renameVisible
      ? `<form class="profile-manager-rename" data-profile-rename-form="${escapeHtml(profile.id)}"><label><span>用户资料名称</span><input value="${escapeHtml(profile.displayName)}" maxlength="80" aria-label="用户资料名称"></label><button class="settings-primary" type="submit">保存</button><button class="settings-secondary" type="button" data-profile-cancel-rename>取消</button></form>`
      : `<div class="profile-manager-identity" style="--profile-color:${profileColor(profile)}"><span class="profile-manager-hero-avatar" aria-hidden="true">${escapeHtml(profileInitial(profile))}</span><div class="profile-manager-identity-copy"><div><h3 id="profile-manager-detail-title">${escapeHtml(profile.displayName)}</h3>${profile.active ? `<span class="profile-manager-current-user">${profileIcon('check')}当前用户</span>` : ''}</div><p>${profile.imported ? '从资料包导入' : '本机创建'}${profile.locked ? ' · 只读' : ''} · ${profile.lastActivatedAt ? `${formatRelativeDate(profile.lastActivatedAt)}使用` : '尚未使用'}</p><span class="profile-manager-identity-facts">${facts}</span></div><div class="profile-manager-identity-actions">${profile.active ? '' : `<button class="settings-primary" data-profile-switch="${escapeHtml(profile.id)}" ${!available || busyId ? 'disabled' : ''}>${busyId === profile.id ? '正在切换…' : '切换到此用户'}</button>`}<button class="profile-manager-icon-action" data-profile-rename="${escapeHtml(profile.id)}" aria-label="更多用户资料操作">${profileIcon('more')}</button></div></div>`

    const recentConversationRows = recentConversations.map(conversation => {
      const content = `${profileIcon('conversation')}<div><strong>${escapeHtml(conversation.title || '未命名任务')}</strong><small>${escapeHtml(conversation.workspaceName || (conversation.status === 'needs_workspace' ? '工作区待定位' : '未关联工作区'))}<span>·</span>${conversation.turnCount} 个回合</small></div><span class="profile-manager-row-result${conversation.status === 'needs_workspace' ? ' warning' : ''}">${conversation.status === 'needs_workspace' ? '待定位' : formatRelativeDate(conversation.updatedAt)}</span>${profile.active ? profileIcon('arrow') : ''}`
      return profile.active
        ? `<button type="button" class="profile-manager-object-row profile-manager-conversation-row" data-profile-conversation="${escapeHtml(conversation.id)}">${content}</button>`
        : `<div class="profile-manager-object-row profile-manager-conversation-row" aria-disabled="true">${content}</div>`
    }).join('')
    const recentWorkspaceRows = workspaces.slice(0, 4).map(workspace => `<button type="button" class="profile-manager-object-row" data-profile-tab="workspaces">
      ${profileIcon('folder')}<div><strong>${escapeHtml(workspace.displayName)}</strong><small>${escapeHtml(workspace.locationName || '此设备尚未定位')}<span>·</span>${workspace.conversationCount} 个会话</small></div><span class="profile-manager-row-result${workspace.state === 'bound' ? '' : ' warning'}">${workspaceStateLabel(workspace.state)}</span>${profileIcon('arrow')}
    </button>`).join('')
    const overview = `<div class="profile-manager-tab-panel" role="tabpanel" id="profile-tab-overview" aria-labelledby="profile-tab-button-overview">
      <div class="profile-manager-overview-grid"><div class="profile-manager-overview-main">
        ${profile.unboundWorkspaceCount > 0 ? `<div class="profile-manager-attention">${profileIcon('warning')}<div><strong>${profile.unboundWorkspaceCount} 个工作区需要重新定位</strong><p>历史仍可阅读；继续运行前需要选择这台设备上的项目文件夹。</p></div><button class="settings-primary" data-profile-rebind="${escapeHtml(profile.id)}">现在定位</button></div>` : ''}
        <section class="profile-manager-list-section"><header><div><h4>继续工作</h4><p>最近打开的会话</p></div><span>${profile.conversationCount} 个</span></header><div class="profile-manager-object-list">${recentConversationRows || '<p class="profile-manager-zero-state">还没有会话。切换到这份资料后开始一项任务。</p>'}</div></section>
        <section class="profile-manager-list-section"><header><div><h4>工作区</h4><p>此设备上的项目位置</p></div>${workspaces.length > 4 ? '<button data-profile-tab="workspaces">查看全部</button>' : `<span>${workspaceCount} 个</span>`}</header><div class="profile-manager-object-list">${recentWorkspaceRows || '<p class="profile-manager-zero-state">尚未关联工作区。开始任务时可以选择项目文件夹。</p>'}</div></section>
      </div><aside class="profile-manager-inspector" aria-label="此设备上的用户状态">
        <section class="profile-manager-inspector-state"><header>${profileIcon('device')}<div><h4>此设备</h4><p>${profile.unboundWorkspaceCount > 0 ? `${profile.unboundWorkspaceCount} 个工作区需要定位` : '可以继续全部工作'}</p></div></header>
          <div class="profile-manager-device-status"><span class="${profile.unboundWorkspaceCount > 0 ? 'warning' : 'ready'}" aria-hidden="true"></span><div><strong>${profile.unboundWorkspaceCount > 0 ? '需要处理工作区位置' : '资料已就绪'}</strong><p>${profile.unboundWorkspaceCount > 0 ? '历史可以阅读，执行前需要重新选择项目文件夹。' : '会话和工作区均可在这台设备上继续。'}</p></div></div>
        </section>
        <section><h4>用户数据</h4><dl><div><dt>本地数据</dt><dd>${formatBytes(profile.storageBytes)}</dd></div><div><dt>本机授权</dt><dd>${profile.deviceStateCount} 项</dd></div><div><dt>最近使用</dt><dd>${formatRelativeDate(profile.lastActivatedAt)}</dd></div></dl></section>
        <section><h4>迁移</h4><button type="button" class="profile-manager-inspector-action" data-profile-export ${profile.active ? '' : 'disabled'}>${profileIcon('storage')}<span><strong>导出此用户</strong><small>${profile.active ? '选择会话、设置与文件' : '切换到此用户后导出'}</small></span>${profileIcon('arrow')}</button><p>本机授权与登录状态不会进入资料包。</p></section>
      </aside></div>
    </div>`

    const workspaceRows = workspaces.map(workspace => `<div class="profile-manager-table-row" role="row"><span role="cell" class="${workspace.state === 'bound' ? 'ok' : 'warning'}">${workspaceStateLabel(workspace.state)}</span><span role="cell"><strong>${escapeHtml(workspace.displayName)}</strong><small>${workspace.conversationCount} 个关联会话</small></span><span role="cell">${escapeHtml(workspace.locationName || '尚未选择文件夹')}</span><span role="cell">${workspace.state === 'bound' ? '—' : `<button class="settings-primary" data-profile-rebind="${escapeHtml(profile.id)}">定位</button>`}</span></div>`).join('')
    const workspacesPanel = `<div class="profile-manager-tab-panel" role="tabpanel" id="profile-tab-workspaces" aria-labelledby="profile-tab-button-workspaces">
      <div class="profile-manager-panel-heading"><div><h4>工作区绑定</h4><p>绝对路径只保存在这台设备；迁移后必须重新确认位置。</p></div><span>${profile.boundWorkspaceCount} 已绑定 · ${profile.unboundWorkspaceCount} 待定位</span></div>
      <div class="profile-manager-table" role="table" aria-label="工作区绑定"><div class="profile-manager-table-head" role="row"><span role="columnheader">状态</span><span role="columnheader">工作区</span><span role="columnheader">此设备</span><span role="columnheader">操作</span></div>${workspaceRows || '<p class="profile-manager-table-empty">尚未添加工作区。</p>'}</div>
      <p class="profile-manager-panel-note">重绑定只更新这台设备的路径映射，不会改写既有会话事件或历史记录。</p>
    </div>`

    const transfer = `<div class="profile-manager-tab-panel" role="tabpanel" id="profile-tab-transfer" aria-labelledby="profile-tab-button-transfer">
      <div class="profile-manager-panel-heading"><div><h4>数据与迁移</h4><p>导出当前用户资料，或检查只属于这台设备的授权。</p></div></div>
      <div class="profile-manager-setting-list"><div><span><strong>本地存储</strong><small>${formatBytes(profile.storageBytes)} · ${profile.conversationCount} 个会话</small></span><b>仅此设备</b></div><button data-profile-export ${profile.active ? '' : 'disabled'}><span><strong>导出此用户资料</strong><small>${profile.active ? '选择会话、设置、附件和产物，可使用密码保护' : '切换到此用户后可导出完整资料'}</small></span><b>导出</b></button><div><span><strong>本机授权</strong><small>Remote 配对、临时许可和运行进程永不进入资料包</small></span><b>${profile.deviceStateCount} 项</b></div></div>
      <div class="profile-manager-privacy-note"><strong>迁移边界</strong><p>资料包包含你选择的历史与设置；凭据秘密、浏览器登录态、设备身份和旧绝对路径不会被带走。</p></div>
      <button class="profile-manager-danger profile-manager-danger-row" data-profile-trash="${escapeHtml(profile.id)}" ${profile.active || busyId ? 'disabled' : ''}>将此用户资料移到回收区</button>
    </div>`

    const panel = detailTab === 'workspaces' ? workspacesPanel : detailTab === 'transfer' ? transfer : overview
    return `<section class="profile-manager-detail" aria-labelledby="profile-manager-detail-title">
      <div class="profile-manager-mobile-toolbar"><button type="button" data-profile-mobile-list>${profileIcon('back')}<span>所有用户</span></button></div>
      ${identity}
      ${snapshot?.transitionBlocker ? `<div class="profile-manager-warning">${profileIcon('warning')}<div><strong>暂时不能切换用户</strong><span>${escapeHtml(snapshot.transitionBlocker)}</span></div></div>` : ''}
      <div class="profile-manager-tabs" role="tablist" aria-label="用户资料内容"><button id="profile-tab-button-overview" role="tab" aria-selected="${detailTab === 'overview'}" data-profile-tab="overview">概览</button><button id="profile-tab-button-workspaces" role="tab" aria-selected="${detailTab === 'workspaces'}" data-profile-tab="workspaces">工作区${profile.unboundWorkspaceCount ? `<b>${profile.unboundWorkspaceCount}</b>` : ''}</button><button id="profile-tab-button-transfer" role="tab" aria-selected="${detailTab === 'transfer'}" data-profile-tab="transfer">数据与迁移</button></div>
      ${panel}
    </section>`
  }

  function createMarkup(): string {
    return `<section class="profile-manager-detail profile-manager-create-view" aria-labelledby="profile-create-title">
      <div class="profile-manager-page-heading"><div><h3 id="profile-create-title">新建用户资料</h3><p>创建一个完全独立的本地用户。会话、设置和工作区不会与其他用户混合。</p></div><button class="profile-manager-inline-back" data-profile-cancel-create aria-label="关闭新建用户资料">${profileIcon('close')}</button></div>
      <form id="local-profile-create-form" class="profile-manager-create-form">
        <label><span>用户名称</span><input id="local-profile-create-name" maxlength="80" placeholder="例如：个人、学习、实验" autocomplete="off"></label>
        <fieldset class="profile-manager-color-field"><legend>身份颜色</legend><div>${PROFILE_IDENTITY_COLORS.map((color, index) => `<label style="--profile-color:${color}" title="身份颜色 ${index + 1}"><input name="profile-color" type="radio" value="${color}" aria-label="身份颜色 ${index + 1}" ${color === createColor ? 'checked' : ''}><span aria-hidden="true"></span></label>`).join('')}</div><p>颜色只用于头像和窗口身份提示，不会改变工作台主题。</p></fieldset>
        <fieldset><legend>初始内容</legend><label class="profile-manager-radio"><input name="profile-template" type="radio" value="blank"><span><strong>空白用户</strong><small>从默认设置开始，不包含当前用户的任何内容。</small></span></label><label class="profile-manager-radio"><input name="profile-template" type="radio" value="settings" checked><span><strong>复制当前用户的非秘密设置</strong><small>不复制密钥、会话、记忆、附件或自动化。</small></span></label></fieldset>
        <label class="settings-switch"><input id="local-profile-switch-new" type="checkbox"><span></span><b>创建后立即切换</b></label>
      </form>
      <div class="profile-manager-footer-actions"><span>用户数据只保存在这台电脑</span><div><button class="settings-secondary" data-profile-cancel-create>取消</button><button class="settings-primary" type="submit" form="local-profile-create-form" ${busyId ? 'disabled' : ''}>${busyId === 'create' ? '正在创建…' : '创建用户资料'}</button></div></div>
    </section>`
  }

  function trashMarkup(profiles: DesktopLocalProfileSummary[]): string {
    return `<section class="profile-manager-detail" aria-labelledby="profile-trash-title"><div class="profile-manager-page-heading"><button class="profile-manager-inline-back" data-profile-trash-close aria-label="返回用户资料">${profileIcon('back')}</button><div><h3 id="profile-trash-title">回收区</h3><p>恢复用户资料不会恢复已经撤销的 Remote 配对和本机临时授权。</p></div></div><div class="profile-manager-trash-list">${profiles.map(profile => `<div><span class="profile-manager-avatar" style="--profile-color:${profileColor(profile)}">${escapeHtml(profileInitial(profile))}</span><div><strong>${escapeHtml(profile.displayName)}</strong><small>${formatBytes(profile.storageBytes)} · ${formatDate(profile.updatedAt)}</small></div><button class="settings-secondary" data-profile-restore="${escapeHtml(profile.id)}" ${busyId ? 'disabled' : ''}>恢复</button></div>`).join('') || '<p>回收区为空。</p>'}</div></section>`
  }

  function render(): void {
    if (!container) return
    if (loading && !snapshot) {
      container.innerHTML = '<div class="profile-manager-loading">正在读取用户资料…</div>'
      return
    }
    if (!snapshot) {
      container.innerHTML = '<div class="profile-manager-empty"><strong>用户资料暂时无法读取</strong><p>现有数据不会被修改。</p><button class="settings-primary" data-profile-refresh>重新读取</button><button class="settings-secondary" data-profile-close>返回工作台</button></div>'
      bind()
      return
    }
    const available = snapshot.profiles.filter(profile => profile.state !== 'trashed')
    const trashed = snapshot.profiles.filter(profile => profile.state === 'trashed')
    const query = search.trim().toLocaleLowerCase()
    const visible = available.filter(profile => !query || profile.displayName.toLocaleLowerCase().includes(query))
    const profile = selectedProfile()
    const showSearch = available.length > 7 || search.length > 0
    container.innerHTML = `<section class="profile-manager-shell" role="region" aria-labelledby="profile-manager-title" data-mobile-view="${mobileView}">
      <div class="profile-manager-toolbar"><div><h3 id="profile-manager-title">本机用户资料</h3><p>管理本机用户、工作区绑定与资料迁移。</p></div><div class="profile-manager-toolbar-actions"><button class="settings-secondary" data-profile-import>${profileIcon('import')}<span>导入资料包</span></button><button class="settings-primary" data-profile-show-create>${profileIcon('plus')}<span>新建用户资料</span></button></div></div>
      <div class="profile-manager-body"${view === 'create' ? ' inert aria-hidden="true"' : ''}>
        <aside class="profile-manager-nav" aria-label="用户资料列表">
          ${showSearch ? `<label class="profile-manager-search"><span aria-hidden="true">${profileIcon('search')}</span><input type="search" value="${escapeHtml(search)}" placeholder="搜索本地用户" aria-label="搜索本地用户"></label>` : `<div class="profile-manager-nav-heading"><span>此设备</span><b>${available.length}</b></div>`}
          <div class="profile-manager-list">${visible.map(profileRow).join('') || '<p>没有匹配的资料</p>'}</div>
          <button class="profile-manager-trash-link${view === 'trash' ? ' selected' : ''}" data-profile-open-trash><span>回收区</span><b>${trashed.length}</b></button>
          <p class="profile-manager-local-note">用户之间的数据彼此隔离</p>
        </aside>
        <main class="profile-manager-content">${view === 'trash' ? trashMarkup(trashed) : profile ? detailMarkup(profile) : '<div class="profile-manager-empty"><strong>没有可用的用户资料</strong><p>新建一个本地用户开始使用。</p></div>'}</main>
      </div>
      ${view === 'create' ? `<div class="profile-manager-create-overlay" role="dialog" aria-modal="true" aria-labelledby="profile-create-title">${createMarkup()}</div>` : ''}
    </section>`
    bind()
  }

  async function refresh(): Promise<void> {
    loading = true
    render()
    try {
      snapshot = await bridge.listLocalProfiles()
      if (!selectedId || !snapshot.profiles.some(profile => profile.id === selectedId && profile.state !== 'trashed')) selectedId = snapshot.activeProfileId
    } catch (error) {
      snapshot = null
      options.showToast(presentDesktopError(error))
    } finally {
      loading = false
      render()
    }
  }

  async function mutate(profileId: string, operation: () => Promise<DesktopLocalProfileMutationResult>, message: string): Promise<boolean> {
    busyId = profileId
    render()
    try {
      const result = await operation()
      snapshot = snapshot ? { ...snapshot, profiles: result.profiles, activeProfileId: result.profiles.find(profile => profile.active)?.id || snapshot.activeProfileId, transitionBlocker: null } : snapshot
      if (result.snapshot) options.onSnapshot(result.snapshot)
      renameVisible = false
      options.showToast(message)
      return true
    } catch (error) {
      options.showToast(presentDesktopError(error))
      return false
    } finally {
      busyId = ''
      await refresh()
    }
  }

  function bind(): void {
    if (!container) return
    container.querySelectorAll('[data-profile-close]').forEach(button => button.addEventListener('click', options.close))
    container.querySelector('[data-profile-refresh]')?.addEventListener('click', () => void refresh())
    container.querySelector<HTMLInputElement>('.profile-manager-search input')?.addEventListener('input', event => { search = (event.target as HTMLInputElement).value; render(); container?.querySelector<HTMLInputElement>('.profile-manager-search input')?.focus() })
    container.querySelectorAll<HTMLButtonElement>('[data-profile-select]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.profileSelect || ''; view = 'detail'; mobileView = 'detail'; detailTab = 'overview'; renameVisible = false; render() }))
    container.querySelector('[data-profile-mobile-list]')?.addEventListener('click', () => { mobileView = 'list'; render(); requestAnimationFrame(() => container?.querySelector<HTMLButtonElement>(`[data-profile-select="${CSS.escape(selectedId)}"]`)?.focus({ preventScroll: true })) })
    container.querySelector('[data-profile-show-create]')?.addEventListener('click', () => { view = 'create'; mobileView = 'detail'; renameVisible = false; render(); container?.querySelector<HTMLInputElement>('#local-profile-create-name')?.focus() })
    const closeCreate = () => { view = 'detail'; mobileView = 'list'; render(); requestAnimationFrame(() => container?.querySelector<HTMLButtonElement>('[data-profile-show-create]')?.focus({ preventScroll: true })) }
    container.querySelectorAll('[data-profile-cancel-create]').forEach(button => button.addEventListener('click', closeCreate))
    container.querySelector<HTMLElement>('.profile-manager-create-overlay')?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeCreate()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(element => !element.hidden)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    })
    container.querySelector('[data-profile-open-trash]')?.addEventListener('click', () => { view = 'trash'; mobileView = 'detail'; render() })
    container.querySelector('[data-profile-trash-close]')?.addEventListener('click', () => { view = 'detail'; mobileView = 'list'; render() })
    container.querySelector<HTMLFormElement>('#local-profile-create-form')?.addEventListener('submit', event => {
      event.preventDefault()
      const displayName = container?.querySelector<HTMLInputElement>('#local-profile-create-name')?.value.trim() || ''
      if (!displayName) return options.showToast('请输入资料名称')
      const copyCurrentSettings = container?.querySelector<HTMLInputElement>('input[name="profile-template"]:checked')?.value === 'settings'
      const switchToNew = Boolean(container?.querySelector<HTMLInputElement>('#local-profile-switch-new')?.checked)
      void mutate('create', () => bridge.createLocalProfile({ displayName, avatar: { kind: 'color', value: createColor }, copyCurrentSettings, switchToNew }), '用户资料已创建').then(async succeeded => {
        if (!succeeded) return
        view = 'detail'
        if (switchToNew) await options.onProfileSwitched()
      })
    })
    container.querySelectorAll<HTMLInputElement>('input[name="profile-color"]').forEach(input => input.addEventListener('change', () => { createColor = input.value }))
    container.querySelectorAll<HTMLButtonElement>('[data-profile-tab]').forEach(button => button.addEventListener('click', () => {
      const tab = button.dataset.profileTab
      if (tab === 'overview' || tab === 'workspaces' || tab === 'transfer') {
        detailTab = tab
        render()
        container?.querySelector<HTMLButtonElement>(`#profile-tab-button-${tab}`)?.focus({ preventScroll: true })
      }
    }))
    container.querySelector<HTMLButtonElement>('[data-profile-rename]')?.addEventListener('click', () => { renameVisible = true; render(); container?.querySelector<HTMLInputElement>('[data-profile-rename-form] input')?.select() })
    container.querySelector('[data-profile-cancel-rename]')?.addEventListener('click', () => { renameVisible = false; render() })
    container.querySelector<HTMLFormElement>('[data-profile-rename-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const profileId = form.dataset.profileRenameForm || ''
      const displayName = form.querySelector<HTMLInputElement>('input')?.value.trim() || ''
      if (!displayName) return options.showToast('资料名称不能为空')
      void mutate(profileId, () => bridge.renameLocalProfile(profileId, displayName), '资料名称已更新')
    })
    container.querySelector<HTMLButtonElement>('[data-profile-switch]')?.addEventListener('click', () => {
      const profileId = container?.querySelector<HTMLButtonElement>('[data-profile-switch]')?.dataset.profileSwitch || ''
      const profile = snapshot?.profiles.find(item => item.id === profileId)
      if (!profile) return
      if (snapshot?.transitionBlocker) return options.showToast(snapshot.transitionBlocker)
      void mutate(profileId, () => bridge.switchLocalProfile(profileId), `已切换到“${profile.displayName}”`).then(async succeeded => {
        if (succeeded) await options.onProfileSwitched()
      })
    })
    container.querySelectorAll<HTMLButtonElement>('[data-profile-conversation]').forEach(button => button.addEventListener('click', () => {
      const conversationId = button.dataset.profileConversation || ''
      if (conversationId) void options.openConversation(conversationId)
    }))
    container.querySelector<HTMLButtonElement>('[data-profile-trash]')?.addEventListener('click', () => {
      const profileId = container?.querySelector<HTMLButtonElement>('[data-profile-trash]')?.dataset.profileTrash || ''
      const profile = snapshot?.profiles.find(item => item.id === profileId)
      if (!profile || !window.confirm(`将“${profile.displayName}”移到回收区？本机远程设备授权会被永久撤销。`)) return
      void mutate(profileId, () => bridge.trashLocalProfile(profileId), '资料已移到回收区')
    })
    container.querySelectorAll<HTMLButtonElement>('[data-profile-restore]').forEach(button => button.addEventListener('click', () => {
      const profileId = button.dataset.profileRestore || ''
      void mutate(profileId, () => bridge.restoreLocalProfile(profileId), '资料已恢复；远程设备需要重新配对')
    }))
    container.querySelector('[data-profile-export]')?.addEventListener('click', () => void options.openExport())
    container.querySelector('[data-profile-import]')?.addEventListener('click', () => void options.openImport())
    container.querySelector<HTMLButtonElement>('[data-profile-rebind]')?.addEventListener('click', event => void options.openRebind((event.currentTarget as HTMLButtonElement).dataset.profileRebind || ''))
  }

  return {
    render(nextContainer) {
      container = nextContainer
      view = 'detail'
      mobileView = 'list'
      render()
      void refresh()
    },
    refresh,
    showCreate() {
      view = 'create'
      mobileView = 'detail'
      renameVisible = false
      render()
      requestAnimationFrame(() => container?.querySelector<HTMLInputElement>('#local-profile-create-name')?.focus({ preventScroll: true }))
    },
  }
}
