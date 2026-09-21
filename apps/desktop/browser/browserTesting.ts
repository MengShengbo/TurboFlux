const BROWSER_KEYS = new Map([
  ['enter', 'Enter'],
  ['tab', 'Tab'],
  ['escape', 'Escape'],
  ['esc', 'Escape'],
  ['space', 'Space'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
])

export function normalizeBrowserKey(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '')
  const key = BROWSER_KEYS.get(normalized)
  if (!key) throw new Error(`Unsupported browser key: ${value}`)
  return key
}

export function normalizeBrowserTimeout(value: unknown, fallback = 5_000): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(100, Math.min(15_000, Math.floor(parsed)))
}

export function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}${url.pathname}`
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 500)
  }
}

export function sanitizeBrowserRef(value: string): string {
  const ref = value.trim()
  if (!ref || !/^[a-zA-Z0-9_-]{1,160}$/.test(ref)) throw new Error('Invalid element ref; observe the page again')
  return ref
}
