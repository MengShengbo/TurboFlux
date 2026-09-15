export type BackgroundMediaFit = 'cover' | 'contain' | 'fill' | 'none'

export interface BackgroundMediaSettings {
  fit: BackgroundMediaFit
  scale: number
  positionX: number
  positionY: number
  darkBrightness: number
  lightBrightness: number
  materialOpacity: number
  materialBlur: number
  blur: number
  playbackRate: number
}

export const BACKGROUND_MEDIA_SETTINGS_STORAGE_KEY = 'turboflux.appearance.background-media-settings'
export const DEFAULT_WINDOW_OPACITY = 1
export const DEFAULT_BACKGROUND_MEDIA_SETTINGS: BackgroundMediaSettings = {
  fit: 'cover',
  scale: 1,
  positionX: 50,
  positionY: 50,
  darkBrightness: 50,
  lightBrightness: 50,
  materialOpacity: 0.58,
  materialBlur: 20,
  blur: 0,
  playbackRate: 1,
}

let backgroundMediaSnapshot: DesktopBackgroundMediaSnapshot | null = null
let mediaListenersInstalled = false

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

export function normalizeBackgroundMediaSettings(value: unknown): BackgroundMediaSettings {
  const candidate = value && typeof value === 'object'
    ? value as Partial<BackgroundMediaSettings> & { surfaceOpacity?: number }
    : {}
  const fit = ['cover', 'contain', 'fill', 'none'].includes(candidate.fit || '')
    ? candidate.fit as BackgroundMediaFit
    : DEFAULT_BACKGROUND_MEDIA_SETTINGS.fit
  return {
    fit,
    scale: clamp(candidate.scale, 0.5, 2, DEFAULT_BACKGROUND_MEDIA_SETTINGS.scale),
    positionX: clamp(candidate.positionX, 0, 100, DEFAULT_BACKGROUND_MEDIA_SETTINGS.positionX),
    positionY: clamp(candidate.positionY, 0, 100, DEFAULT_BACKGROUND_MEDIA_SETTINGS.positionY),
    darkBrightness: clamp(candidate.darkBrightness, 0, 50, DEFAULT_BACKGROUND_MEDIA_SETTINGS.darkBrightness),
    lightBrightness: clamp(candidate.lightBrightness, 50, 100, DEFAULT_BACKGROUND_MEDIA_SETTINGS.lightBrightness),
    materialOpacity: clamp(candidate.materialOpacity ?? candidate.surfaceOpacity, 0.32, 0.86, DEFAULT_BACKGROUND_MEDIA_SETTINGS.materialOpacity),
    materialBlur: clamp(candidate.materialBlur, 8, 30, DEFAULT_BACKGROUND_MEDIA_SETTINGS.materialBlur),
    blur: clamp(candidate.blur, 0, 24, DEFAULT_BACKGROUND_MEDIA_SETTINGS.blur),
    playbackRate: clamp(candidate.playbackRate, 0.5, 2, DEFAULT_BACKGROUND_MEDIA_SETTINGS.playbackRate),
  }
}

export function backgroundBrightnessMultiplier(settings: BackgroundMediaSettings, theme: 'light' | 'dark'): number {
  return theme === 'dark'
    ? 0.62 + settings.darkBrightness * 0.0076
    : 1 + (settings.lightBrightness - 50) * 0.007
}

function legacyBackgroundMediaSettings(): BackgroundMediaSettings {
  try {
    const layout = JSON.parse(window.localStorage.getItem('turboflux.appearance.wallpaper-layout') || 'null') || {}
    return normalizeBackgroundMediaSettings({
      fit: layout.fit,
      scale: layout.scale,
      positionX: layout.positionX,
      positionY: layout.positionY,
    })
  } catch {
    return { ...DEFAULT_BACKGROUND_MEDIA_SETTINGS }
  }
}

export function currentBackgroundMediaSettings(): BackgroundMediaSettings {
  try {
    const stored = window.localStorage.getItem(BACKGROUND_MEDIA_SETTINGS_STORAGE_KEY)
    return stored ? normalizeBackgroundMediaSettings(JSON.parse(stored)) : legacyBackgroundMediaSettings()
  } catch {
    return { ...DEFAULT_BACKGROUND_MEDIA_SETTINGS }
  }
}

export function applyBackgroundMediaSettings(settings: BackgroundMediaSettings): BackgroundMediaSettings {
  const normalized = normalizeBackgroundMediaSettings(settings)
  const root = document.documentElement
  root.style.setProperty('--background-media-fit', normalized.fit)
  root.style.setProperty('--background-media-scale', String(normalized.scale))
  root.style.setProperty('--background-media-position-x', `${normalized.positionX}%`)
  root.style.setProperty('--background-media-position-y', `${normalized.positionY}%`)
  root.style.setProperty('--background-dark-filter-brightness', String(backgroundBrightnessMultiplier(normalized, 'dark')))
  root.style.setProperty('--background-light-filter-brightness', String(backgroundBrightnessMultiplier(normalized, 'light')))
  root.style.setProperty('--background-material-opacity', `${Math.round(normalized.materialOpacity * 100)}%`)
  root.style.setProperty('--background-material-blur', `${normalized.materialBlur}px`)
  root.style.setProperty('--background-media-blur', `${normalized.blur}px`)
  root.style.setProperty('--background-video-rate', String(normalized.playbackRate))
  const video = document.querySelector<HTMLVideoElement>('.background-media-video')
  if (video) video.playbackRate = normalized.playbackRate
  return normalized
}

export function setBackgroundMediaSettings(update: Partial<BackgroundMediaSettings>): BackgroundMediaSettings {
  const settings = applyBackgroundMediaSettings({ ...currentBackgroundMediaSettings(), ...update })
  try {
    window.localStorage.setItem(BACKGROUND_MEDIA_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {}
  window.dispatchEvent(new CustomEvent('turboflux:background-media-settings-change', { detail: settings }))
  return settings
}

export function currentBackgroundMediaSnapshot(): DesktopBackgroundMediaSnapshot | null {
  return backgroundMediaSnapshot
}

function synchronizeVideoPlayback(): void {
  const video = document.querySelector<HTMLVideoElement>('.background-media-video')
  if (!video || video.hidden || !video.src) return
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (document.hidden || reducedMotion) {
    video.pause()
  } else {
    void video.play().catch(() => undefined)
  }
}

function installMediaListeners(): void {
  if (mediaListenersInstalled) return
  mediaListenersInstalled = true
  document.addEventListener('visibilitychange', synchronizeVideoPlayback)
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', synchronizeVideoPlayback)
}

export function applyBackgroundMediaSnapshot(snapshot: DesktopBackgroundMediaSnapshot | null): void {
  backgroundMediaSnapshot = snapshot
  const root = document.documentElement
  const image = document.querySelector<HTMLImageElement>('.background-media-image')
  const video = document.querySelector<HTMLVideoElement>('.background-media-video')
  root.toggleAttribute('data-background-media', Boolean(snapshot))
  if (snapshot) root.dataset.backgroundMediaKind = snapshot.kind
  else delete root.dataset.backgroundMediaKind

  if (image) {
    image.hidden = snapshot?.kind !== 'image'
    if (snapshot?.kind === 'image') image.src = snapshot.url
    else image.removeAttribute('src')
  }
  if (video) {
    video.hidden = snapshot?.kind !== 'video'
    if (snapshot?.kind === 'video') {
      video.src = snapshot.url
      video.load()
    } else {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }
  synchronizeVideoPlayback()
  window.dispatchEvent(new CustomEvent('turboflux:background-media-change', { detail: snapshot }))
}

export function normalizeWindowOpacity(value: unknown): number {
  return clamp(value, 0.45, 1, DEFAULT_WINDOW_OPACITY)
}

export async function initializeBackgroundMedia(bridge?: TurboFluxDesktopBridge): Promise<void> {
  installMediaListeners()
  applyBackgroundMediaSettings(currentBackgroundMediaSettings())
  if (!bridge) return
  try {
    applyBackgroundMediaSnapshot(await bridge.getBackgroundMedia())
  } catch {
    applyBackgroundMediaSnapshot(null)
  }
  try {
    document.documentElement.style.setProperty('--window-opacity', String(normalizeWindowOpacity(await bridge.getWindowOpacity())))
  } catch {}
}
