import { RenderLifetime } from '@turboflux/renderer'
import type { DesktopUserActivity, DesktopUserProfile } from '../desktopTypes'
import { presentDesktopError } from './conversationRendering'
import { profileAvatarMarkup, profileColor } from './profileIdentity'
import { activityDayLabel, profileActivityMarkup } from './profileActivityView'

interface UserProfileOptions {
  showToast(message: string): void
  onIdentityChanged(profile: DesktopUserProfile): void
  onOpen(): Promise<void> | void
  onClose(): void
}

export interface UserProfileController {
  dispose(): void
  open(anchor?: HTMLElement): Promise<void>
  close(): void
  refreshActivity(): Promise<void>
  isOpen(): boolean
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

const camera = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 1.5-2h5L16 5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><circle cx="12" cy="12" r="4"/></svg>'

export function createUserProfile(app: HTMLElement, bridge: TurboFluxDesktopBridge, options: UserProfileOptions): UserProfileController {
  const lifetime = new RenderLifetime()
  const overlay = document.createElement('div')
  overlay.className = 'user-profile-overlay'
  overlay.hidden = true
  overlay.innerHTML = `<section class="user-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="user-profile-title" tabindex="-1"><header class="user-profile-header"><span id="user-profile-title">用户资料</span><button class="user-profile-close" type="button" aria-label="关闭用户资料"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="user-profile-body"></div></section><div class="profile-activity-tooltip" id="profile-activity-tooltip" role="tooltip" hidden></div>`
  app.append(overlay)
  const dialog = overlay.querySelector<HTMLElement>('.user-profile-dialog')!
  const body = overlay.querySelector<HTMLElement>('.user-profile-body')!
  const tooltip = overlay.querySelector<HTMLElement>('.profile-activity-tooltip')!
  const shell = app.querySelector<HTMLElement>('.desktop-shell')
  let previousFocus: HTMLElement | null = null
  let profile: DesktopUserProfile | null = null
  let activity: DesktopUserActivity | null = null
  let year = new Date().getFullYear()
  let busy = false
  let generation = 0
  let poll: number | undefined
  let refreshing = false
  let renderedDay = ''
  let opening = false

  function isOpen(): boolean { return !overlay.hidden }

  function setBusy(value: boolean): void {
    busy = value
    dialog.setAttribute('aria-busy', String(value))
    body.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-identity-control]').forEach(control => { control.disabled = value })
  }

  function renderActivity(): void {
    const grid = body.querySelector<HTMLElement>('[data-profile-activity]')
    if (!grid || !activity) return
    renderedDay = new Date().toDateString()
    const years = body.querySelector<HTMLSelectElement>('[data-profile-year]')
    if (years) {
      const currentYear = new Date().getFullYear()
      years.innerHTML = Array.from({ length: Math.max(1, currentYear - new Date(activity.recordedSince).getFullYear() + 1) }, (_, index) => currentYear - index)
        .map(value => `<option value="${value}"${value === year ? ' selected' : ''}>${value}</option>`).join('')
    }
    const focusedDate = (document.activeElement as HTMLElement | null)?.dataset.day
    grid.innerHTML = profileActivityMarkup(activity, year)
    if (focusedDate) grid.querySelector<HTMLElement>(`[data-day="${focusedDate}"]`)?.focus({ preventScroll: true })
  }

  function render(): void {
    if (!profile) return
    body.innerHTML = `<div class="user-profile-identity" style="--profile-color:${profileColor(profile)}"><button class="user-profile-avatar" type="button" data-profile-upload data-identity-control aria-label="上传头像"><span data-profile-avatar>${profileAvatarMarkup(profile)}</span><i>${camera}</i></button><h2 data-profile-name>${escapeHtml(profile.displayName)}</h2></div><form class="user-profile-name-form"><label for="user-profile-name">名称</label><div><input id="user-profile-name" name="displayName" value="${escapeHtml(profile.displayName)}" maxlength="80" required autocomplete="nickname" data-identity-control><button type="submit" data-profile-save data-identity-control disabled>保存</button></div><p class="user-profile-feedback" role="status" aria-live="polite"></p></form><section class="user-profile-activity" aria-labelledby="user-profile-activity-title"><header><div><span class="profile-activity-mark" aria-hidden="true"></span><h3 id="user-profile-activity-title">工作足迹</h3></div><label><span class="visually-hidden">活动年份</span><select data-profile-year>${Array.from({ length: Math.max(1, new Date().getFullYear() - new Date(activity?.recordedSince || Date.now()).getFullYear() + 1) }, (_, i) => new Date().getFullYear() - i).map(value => `<option value="${value}"${value === year ? ' selected' : ''}>${value}</option>`).join('')}</select></label></header><div data-profile-activity><p class="user-profile-activity-status">正在读取 Token 活动…</p></div></section>`
    const input = body.querySelector<HTMLInputElement>('#user-profile-name')!
    const save = body.querySelector<HTMLButtonElement>('[data-profile-save]')!
    const feedback = body.querySelector<HTMLElement>('.user-profile-feedback')!
    input.addEventListener('input', () => {
      save.disabled = busy || !input.value.trim() || input.value.trim() === profile?.displayName
      feedback.textContent = ''
    })
    body.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault()
      if (!profile || busy || !input.value.trim()) return
      const requestGeneration = generation
      setBusy(true)
      feedback.textContent = ''
      try {
        const result = await bridge.saveUserProfileName(input.value.trim())
        if (generation !== requestGeneration) return
        const updated = result
        if (!updated) throw new Error('无法读取更新后的用户资料')
        profile = updated
        options.onIdentityChanged(updated)
        input.value = updated.displayName
        body.querySelector<HTMLElement>('[data-profile-name]')!.textContent = updated.displayName
        body.querySelector<HTMLElement>('[data-profile-avatar]')!.innerHTML = profileAvatarMarkup(updated)
        feedback.textContent = '名称已保存'
      } catch (error) { feedback.textContent = presentDesktopError(error) }
      finally { setBusy(false); save.disabled = input.value.trim() === profile?.displayName; input.focus() }
    })
    body.querySelector('[data-profile-upload]')!.addEventListener('click', async () => {
      if (!profile || busy) return
      setBusy(true)
      try {
        const result = await bridge.chooseUserAvatar()
        if (!result) return
        const updated = result
        if (!updated) throw new Error('无法读取更新后的头像')
        profile = updated
        body.querySelector<HTMLElement>('[data-profile-avatar]')!.innerHTML = profileAvatarMarkup(updated)
        options.onIdentityChanged(updated)
        feedback.textContent = '头像已更新'
      } catch (error) { feedback.textContent = presentDesktopError(error) }
      finally { setBusy(false); save.disabled = !input.value.trim() || input.value.trim() === profile?.displayName }
    })
    body.querySelector<HTMLSelectElement>('[data-profile-year]')!.addEventListener('change', event => {
      year = Number((event.target as HTMLSelectElement).value)
      tooltip.hidden = true
      renderActivity()
    })
    renderActivity()
  }

  async function refreshActivity(): Promise<void> {
    if (!isOpen() || !profile || refreshing) return
    refreshing = true
    const requestGeneration = generation
    try {
      const next = await bridge.getUserActivity()
      if (requestGeneration !== generation) return
      if (JSON.stringify(next) !== JSON.stringify(activity) || renderedDay !== new Date().toDateString()) { activity = next; renderActivity() }
    } catch (error) {
      if (requestGeneration === generation && !activity) {
        const grid = body.querySelector<HTMLElement>('[data-profile-activity]')
        if (grid) grid.innerHTML = `<p class="user-profile-activity-status">${escapeHtml(presentDesktopError(error))}</p><button type="button" data-activity-retry>重新读取</button>`
        grid?.querySelector('[data-activity-retry]')?.addEventListener('click', () => void refreshActivity())
      }
    } finally { refreshing = false }
  }

  function close(): void {
    if (!isOpen() || busy) return
    generation += 1
    overlay.hidden = true
    tooltip.hidden = true
    window.clearInterval(poll)
    shell?.removeAttribute('inert')
    previousFocus?.setAttribute('aria-expanded', 'false')
    options.onClose()
    previousFocus?.focus({ preventScroll: true })
  }

  async function open(anchor?: HTMLElement): Promise<void> {
    if (isOpen() || opening) return
    opening = true
    previousFocus = anchor || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    try { await options.onOpen() } finally { opening = false }
    overlay.hidden = false
    shell?.setAttribute('inert', '')
    previousFocus?.setAttribute('aria-expanded', 'true')
    dialog.focus({ preventScroll: true })
    body.innerHTML = '<p class="user-profile-loading" role="status">正在读取用户资料…</p>'
    profile = null
    activity = null
    year = new Date().getFullYear()
    const requestGeneration = ++generation
    try {
      const identity = await bridge.getUserProfile()
      if (requestGeneration !== generation) return
      profile = identity
      if (!profile) throw new Error('未找到当前用户资料')
      render()
      await refreshActivity()
      if (requestGeneration !== generation) return
      poll = window.setInterval(() => void refreshActivity(), 5_000)
    } catch (error) {
      if (requestGeneration !== generation) return
      body.innerHTML = `<p class="user-profile-loading" role="status">${escapeHtml(presentDesktopError(error))}</p>`
    }
  }

  function showDay(target: EventTarget | null): void {
    const day = target instanceof Element ? target.closest<HTMLElement>('.profile-activity-day:not(:disabled)') : null
    if (!day?.dataset.day) { tooltip.hidden = true; return }
    tooltip.textContent = activityDayLabel(day.dataset.day, Number(day.dataset.tokens || 0))
    tooltip.hidden = false
    const rect = day.getBoundingClientRect()
    tooltip.style.left = `${Math.max(12, Math.min(window.innerWidth - tooltip.offsetWidth - 12, rect.left + rect.width / 2 - tooltip.offsetWidth / 2))}px`
    tooltip.style.top = `${Math.max(8, rect.top - tooltip.offsetHeight - 9)}px`
  }
  overlay.querySelector('.user-profile-close')!.addEventListener('click', close)
  overlay.addEventListener('click', event => { if (event.target === overlay) close() })
  body.addEventListener('pointerover', event => showDay(event.target))
  body.addEventListener('pointerout', event => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.profile-activity-day')) tooltip.hidden = true })
  body.addEventListener('focusin', event => showDay(event.target))
  body.addEventListener('focusout', () => { tooltip.hidden = true })
  dialog.addEventListener('scroll', () => { tooltip.hidden = true })
  lifetime.listen(window, 'resize', () => { tooltip.hidden = true })
  overlay.addEventListener('keydown', event => {
    if (!isOpen()) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
        .filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0)
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus()
      }
    }
    const target = event.target as HTMLElement
    const offset = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[event.key]
    if (offset && target.dataset.day) {
      event.preventDefault()
      const date = new Date(`${target.dataset.day}T12:00:00`)
      date.setDate(date.getDate() + offset)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const next = body.querySelector<HTMLButtonElement>(`[data-day="${key}"]:not(:disabled)`)
      if (next) { target.tabIndex = -1; next.tabIndex = 0; next.focus({ preventScroll: true }) }
    }
  })
  return { open, close, isOpen, refreshActivity, dispose: () => { lifetime.dispose(); close(); generation++; window.clearInterval(poll); overlay.remove() } }
}
