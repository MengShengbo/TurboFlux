import type { DesktopWorkbenchSnapshot } from '../desktopTypes'
import { presentDesktopError } from './conversationRendering'

interface ProfileSwitcherOptions {
  showToast(message: string): void
  onSnapshot(snapshot: DesktopWorkbenchSnapshot): void
  onProfileSwitched(): Promise<void> | void
  openLibrary(): Promise<void> | void
  openCreate(): Promise<void> | void
  openImport(): Promise<void> | void
}

export interface ProfileSwitcherController {
  toggle(anchor: HTMLElement): Promise<void>
  close(): void
  refresh(): Promise<void>
  isOpen(): boolean
}

const PROFILE_COLORS = ['#7c6ee6', '#3f82c4', '#2f8c77', '#9a7137', '#b05f72', '#66758f', '#8a67a5', '#537f4f']

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function icon(name: 'check' | 'plus' | 'import' | 'manage' | 'warning' | 'chevron'): string {
  const paths = {
    check: '<path d="m5 12 4.2 4.2L19 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    import: '<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 18.5h14"/>',
    manage: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/>',
    warning: '<path d="M12 4 21 20H3L12 4Z"/><path d="M12 9v5M12 17h.01"/>',
    chevron: '<path d="m9 7 5 5-5 5"/>',
  } as const
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}

function profileInitial(profile: DesktopLocalProfileSummary): string {
  return profile.displayName.trim().slice(0, 1).toLocaleUpperCase() || '用'
}

export function profileColor(profile: DesktopLocalProfileSummary): string {
  if (profile.avatar?.kind === 'color' && /^#[0-9a-f]{6}$/iu.test(profile.avatar.value)) return profile.avatar.value
  let hash = 0
  for (const character of profile.id) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0
  return PROFILE_COLORS[hash % PROFILE_COLORS.length]
}

function profileStatus(profile: DesktopLocalProfileSummary): string {
  if (profile.unboundWorkspaceCount > 0) return `${profile.unboundWorkspaceCount} 个工作区待定位`
  if (profile.state === 'degraded') return '需要检查'
  if (profile.state === 'importing') return '正在导入'
  if (profile.state === 'migrating') return '正在迁移'
  if (profile.conversationCount === 0) return '暂无会话'
  const workspaces = profile.boundWorkspaceCount + profile.unboundWorkspaceCount
  return `${profile.conversationCount} 个会话${workspaces > 0 ? ` · ${workspaces} 个工作区` : ''}`
}

function profileRow(profile: DesktopLocalProfileSummary, busyId: string): string {
  const busy = busyId === profile.id
  const disabled = Boolean(busyId) || !['ready', 'degraded'].includes(profile.state)
  return `<button class="profile-switcher-user${profile.active ? ' active' : ''}${profile.unboundWorkspaceCount ? ' needs-attention' : ''}" type="button" role="menuitemradio" aria-checked="${profile.active}" data-profile-switcher-user="${escapeHtml(profile.id)}" ${disabled ? 'disabled' : ''}>
    <span class="profile-switcher-avatar" style="--profile-color:${profileColor(profile)}" aria-hidden="true">${escapeHtml(profileInitial(profile))}</span>
    <span class="profile-switcher-user-copy"><strong>${escapeHtml(profile.displayName)}</strong><small>${escapeHtml(busy ? '正在切换用户资料…' : profileStatus(profile))}</small></span>
    <span class="profile-switcher-user-state">${profile.unboundWorkspaceCount ? icon('warning') : ''}${profile.active ? `<b>当前</b>${icon('check')}` : '<b>切换</b>'}</span>
  </button>`
}

export function profileSwitcherMarkup(snapshot: DesktopLocalProfilesSnapshot, busyId = ''): string {
  const profiles = snapshot.profiles.filter(profile => profile.state !== 'trashed')
  const active = profiles.find(profile => profile.active || profile.id === snapshot.activeProfileId)
  const others = profiles.filter(profile => profile.id !== active?.id)
  return `<div class="profile-switcher-surface" role="menu" aria-label="切换用户资料"${active ? ` style="--active-profile-color:${profileColor(active)}"` : ''}>
    <div class="profile-switcher-section-label">正在使用</div>
    <div class="profile-switcher-current">${active ? profileRow(active, busyId) : '<p class="profile-switcher-empty">没有可用的用户资料</p>'}</div>
    ${others.length > 0 ? `<div class="profile-switcher-separator"></div><div class="profile-switcher-section-label">其他用户</div><div class="profile-switcher-users">${others.map(profile => profileRow(profile, busyId)).join('')}</div>` : ''}
    ${snapshot.transitionBlocker ? `<div class="profile-switcher-blocker" role="status">${icon('warning')}<span>${escapeHtml(snapshot.transitionBlocker)}</span></div>` : ''}
    <div class="profile-switcher-separator"></div>
    <div class="profile-switcher-actions">
      <button type="button" role="menuitem" data-profile-switcher-create>${icon('plus')}<span>新建用户资料</span></button>
      <button type="button" role="menuitem" data-profile-switcher-import>${icon('import')}<span>导入 TurboFlux 资料包</span></button>
      <button type="button" role="menuitem" data-profile-switcher-manage>${icon('manage')}<span>管理用户资料…</span>${icon('chevron')}</button>
    </div>
  </div>`
}

export function createProfileSwitcher(
  app: HTMLElement,
  bridge: TurboFluxDesktopBridge,
  options: ProfileSwitcherOptions,
): ProfileSwitcherController {
  const popover = document.createElement('section')
  popover.className = 'profile-switcher'
  popover.setAttribute('aria-hidden', 'true')
  app.append(popover)
  let anchor: HTMLElement | null = null
  let snapshot: DesktopLocalProfilesSnapshot | null = null
  let busyId = ''
  let loading = false

  function isOpen(): boolean {
    return popover.classList.contains('visible')
  }

  function position(): void {
    if (!anchor || !isOpen()) return
    const rect = anchor.getBoundingClientRect()
    const margin = 12
    const width = Math.min(304, window.innerWidth - (margin * 2))
    popover.style.width = `${width}px`
    const measured = popover.getBoundingClientRect()
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))
    const preferredTop = rect.top - measured.height - 8
    const top = preferredTop >= margin ? preferredTop : Math.min(window.innerHeight - measured.height - margin, rect.bottom + 8)
    popover.style.left = `${left}px`
    popover.style.top = `${Math.max(margin, top)}px`
  }

  function close(): void {
    if (!isOpen()) return
    popover.classList.remove('visible')
    popover.setAttribute('aria-hidden', 'true')
    anchor?.setAttribute('aria-expanded', 'false')
  }

  function render(): void {
    if (loading && !snapshot) {
      popover.innerHTML = '<div class="profile-switcher-loading">正在读取用户资料…</div>'
    } else if (!snapshot) {
      popover.innerHTML = '<div class="profile-switcher-error"><strong>用户资料暂时无法读取</strong><button type="button" data-profile-switcher-retry>重新读取</button></div>'
    } else {
      popover.innerHTML = profileSwitcherMarkup(snapshot, busyId)
    }
    bind()
    requestAnimationFrame(position)
  }

  async function refresh(): Promise<void> {
    loading = true
    render()
    try {
      snapshot = await bridge.listLocalProfiles()
    } catch (error) {
      snapshot = null
      options.showToast(presentDesktopError(error))
    } finally {
      loading = false
      render()
    }
  }

  async function switchProfile(profileId: string): Promise<void> {
    const profile = snapshot?.profiles.find(candidate => candidate.id === profileId)
    if (!profile || profile.active || busyId) return
    if (snapshot?.transitionBlocker) {
      options.showToast(snapshot.transitionBlocker)
      return
    }
    busyId = profileId
    render()
    try {
      const result = await bridge.switchLocalProfile(profileId)
      snapshot = { activeProfileId: profileId, profiles: result.profiles, transitionBlocker: null }
      options.onSnapshot(result.snapshot)
      await options.onProfileSwitched()
      options.showToast(`已切换到“${profile.displayName}”`)
      render()
      window.setTimeout(close, 180)
    } catch (error) {
      options.showToast(presentDesktopError(error))
      await refresh()
    } finally {
      busyId = ''
    }
  }

  function bind(): void {
    popover.querySelector('[data-profile-switcher-retry]')?.addEventListener('click', () => void refresh())
    popover.querySelectorAll<HTMLButtonElement>('[data-profile-switcher-user]').forEach(button => button.addEventListener('click', () => void switchProfile(button.dataset.profileSwitcherUser || '')))
    popover.querySelector('[data-profile-switcher-create]')?.addEventListener('click', () => { close(); void options.openCreate() })
    popover.querySelector('[data-profile-switcher-import]')?.addEventListener('click', () => { close(); void options.openImport() })
    popover.querySelector('[data-profile-switcher-manage]')?.addEventListener('click', () => { close(); void options.openLibrary() })
  }

  document.addEventListener('pointerdown', event => {
    if (!isOpen() || popover.contains(event.target as Node) || anchor?.contains(event.target as Node)) return
    close()
  })
  document.addEventListener('keydown', event => {
    if (!isOpen()) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      anchor?.focus({ preventScroll: true })
      return
    }
    const items = [...popover.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')].filter(item => !item.disabled)
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus({ preventScroll: true })
  })
  window.addEventListener('resize', position)

  return {
    async toggle(nextAnchor) {
      if (isOpen()) {
        close()
        return
      }
      anchor = nextAnchor
      anchor.setAttribute('aria-expanded', 'true')
      popover.classList.add('visible')
      popover.setAttribute('aria-hidden', 'false')
      await refresh()
      popover.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus({ preventScroll: true })
    },
    close,
    refresh,
    isOpen,
  }
}
