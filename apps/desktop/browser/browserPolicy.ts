export function normalizeBrowserAddress(value: string): string {
  const input = value.trim()
  if (!input) return 'about:blank'
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) return `http://${input}`
  if (input.toLowerCase() === 'about:blank') return 'about:blank'
  if (/^https?:/i.test(input)) return input
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return input
  if (/^(?:javascript|data|file|vbscript):/i.test(input)) return input
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(input)) return `https://${input}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`
}

export function validateBrowserNavigation(value: string): URL {
  const normalized = normalizeBrowserAddress(value)
  if (normalized === 'about:blank') return new URL(normalized)
  const parsed = new URL(normalized)
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`Blocked browser protocol: ${parsed.protocol}`)
  if (parsed.username || parsed.password) throw new Error('URLs containing embedded credentials are not allowed')
  return parsed
}
