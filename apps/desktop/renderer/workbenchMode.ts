export type WorkbenchMode = 'standard'
export type WorkbenchBaseTheme = 'light' | 'dark'

export const WORKBENCH_MODE_STORAGE_KEY = 'turboflux.appearance.workbench-mode'

export const WORKBENCH_MODES: ReadonlyArray<{ id: WorkbenchMode; title: string; shortTitle: string; description: string }> = [
  { id: 'standard', title: '标准模式', shortTitle: '标准', description: '简洁中性，跟随下方的浅色与深色主题。' },
]

const BASE_THEME_COLORS: Record<WorkbenchBaseTheme, string> = {
  light: '#f5f5f3',
  dark: '#171717',
}

interface NativeViewTransition {
  ready: Promise<void>
  finished: Promise<void>
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => NativeViewTransition
}

export function normalizeWorkbenchMode(value: unknown): WorkbenchMode {
  return 'standard'
}

export function resolveWorkbenchTheme(mode: WorkbenchMode, baseTheme: WorkbenchBaseTheme): WorkbenchBaseTheme {
  return baseTheme
}

export function resolveWorkbenchThemeColor(mode: WorkbenchMode, baseTheme: WorkbenchBaseTheme): string {
  return BASE_THEME_COLORS[baseTheme]
}

export function workbenchTransitionRadius(originX: number, originY: number, width: number, height: number): number {
  return Math.hypot(Math.max(originX, width - originX), Math.max(originY, height - originY))
}

function currentBaseTheme(): WorkbenchBaseTheme {
  return document.documentElement.dataset.baseTheme === 'dark' ? 'dark' : 'light'
}

export function currentWorkbenchMode(): WorkbenchMode {
  const datasetMode = document.documentElement.dataset.workbenchMode
  if (datasetMode) return normalizeWorkbenchMode(datasetMode)
  try {
    return normalizeWorkbenchMode(window.localStorage.getItem(WORKBENCH_MODE_STORAGE_KEY))
  } catch {
    return 'standard'
  }
}

function applyWorkbenchMode(mode: WorkbenchMode): void {
  const root = document.documentElement
  const baseTheme = currentBaseTheme()
  const resolvedTheme = resolveWorkbenchTheme(mode, baseTheme)
  root.dataset.workbenchMode = mode
  root.dataset.theme = resolvedTheme
  root.style.colorScheme = resolvedTheme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    'content',
    resolveWorkbenchThemeColor(mode, baseTheme),
  )
  window.dispatchEvent(new CustomEvent('turboflux:workbench-mode-change', { detail: { mode } }))
}

export function setWorkbenchMode(mode: WorkbenchMode): void {
  try {
    window.localStorage.setItem(WORKBENCH_MODE_STORAGE_KEY, mode)
  } catch {}
  applyWorkbenchMode(mode)
}

let modeTransition: Promise<WorkbenchMode> | null = null

export function setWorkbenchModeFrom(trigger: HTMLElement, nextMode: WorkbenchMode): Promise<WorkbenchMode> {
  if (modeTransition) return modeTransition
  modeTransition = revealWorkbenchMode(trigger, nextMode).finally(() => { modeTransition = null })
  return modeTransition
}

async function revealWorkbenchMode(trigger: HTMLElement, nextMode: WorkbenchMode): Promise<WorkbenchMode> {
  if (nextMode === currentWorkbenchMode()) return nextMode
  const transitionDocument = document as ViewTransitionDocument
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !transitionDocument.startViewTransition) {
    setWorkbenchMode(nextMode)
    return nextMode
  }

  const bounds = trigger.getBoundingClientRect()
  const originX = bounds.left + bounds.width / 2
  const originY = bounds.top + bounds.height / 2
  const radius = workbenchTransitionRadius(originX, originY, window.innerWidth, window.innerHeight)
  document.documentElement.dataset.workbenchModeTransition = nextMode
  try {
    const transition = transitionDocument.startViewTransition(() => setWorkbenchMode(nextMode))
    // A skipped native transition can reject even though the theme update succeeds.
    void transition.finished.catch(() => undefined)
    await transition.ready
    const reveal = document.documentElement.animate(
      { clipPath: [`circle(0px at ${originX}px ${originY}px)`, `circle(${radius}px at ${originX}px ${originY}px)`] },
      {
        duration: 620,
        easing: 'cubic-bezier(.16, 1, .3, 1)',
        fill: 'both',
        pseudoElement: '::view-transition-new(root)',
      } as KeyframeAnimationOptions,
    )
    await Promise.allSettled([reveal.finished, transition.finished])
  } catch {
    if (currentWorkbenchMode() !== nextMode) setWorkbenchMode(nextMode)
  } finally {
    delete document.documentElement.dataset.workbenchModeTransition
  }
  return nextMode
}

export function initializeWorkbenchMode(): () => void {
  applyWorkbenchMode(currentWorkbenchMode())
  const handleStorage = (event: StorageEvent) => {
    if (event.key === WORKBENCH_MODE_STORAGE_KEY) applyWorkbenchMode(normalizeWorkbenchMode(event.newValue))
  }
  window.addEventListener('storage', handleStorage)
  return () => window.removeEventListener('storage', handleStorage)
}
