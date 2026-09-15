import { normalizeWorkbenchMode, resolveWorkbenchTheme, resolveWorkbenchThemeColor } from './workbenchMode'

try {
  const stored = localStorage.getItem('turboflux.appearance.theme')
  const preference = stored === 'light' || stored === 'dark' ? stored : 'system'
  const theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference
  const workbenchMode = normalizeWorkbenchMode(localStorage.getItem('turboflux.appearance.workbench-mode'))
  document.documentElement.dataset.themePreference = preference
  document.documentElement.dataset.baseTheme = theme
  document.documentElement.dataset.workbenchMode = workbenchMode
  document.documentElement.dataset.theme = resolveWorkbenchTheme(workbenchMode, theme)
  document.documentElement.style.colorScheme = resolveWorkbenchTheme(workbenchMode, theme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolveWorkbenchThemeColor(workbenchMode, theme))
} catch {}
