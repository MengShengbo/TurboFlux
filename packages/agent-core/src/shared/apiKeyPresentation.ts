export function maskedApiKey(value: string): string {
  const key = value.trim()
  if (!key) return ''
  if (key.length <= 4) return '********'
  const prefixLength = key.length > 16 ? 7 : key.length >= 10 ? 3 : 1
  const suffixLength = key.length > 16 ? 4 : key.length >= 10 ? 3 : 1
  return `${key.slice(0, prefixLength)}********${key.slice(-suffixLength)}`
}
