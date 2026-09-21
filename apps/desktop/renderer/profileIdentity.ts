import type { DesktopUserProfile } from '../desktopTypes'

type Identity = Pick<DesktopUserProfile, 'displayName' | 'avatarDataUrl'>

export function profileColor(_profile: Identity): string { return '#658d77' }

export function profileAvatarMarkup(profile: Identity): string {
  if (profile.avatarDataUrl && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(profile.avatarDataUrl)) {
    return `<img src="${profile.avatarDataUrl}" alt="" draggable="false">`
  }
  const initial = Array.from(profile.displayName.trim())[0]?.toLocaleUpperCase() || '你'
  return initial.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function profileGreeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}
