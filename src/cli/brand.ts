import stringWidth from 'string-width'

export const TURBOFLUX_WORDMARK_LINES = [
  '  ______           __          ________         ',
  ' /_  __/_  _______/ /_  ____  / ____/ /_  ___  __',
  '  / / / / / / ___/ __ \\/ __ \\/ /_  / / / / / |/_/',
  ' / / / /_/ / /  / /_/ / /_/ / __/ / /_/ />  <  ',
  '/_/  \\__,_/_/  /_.___/\\____/_/ /_/\\__,_/_/|_|  ',
] as const

export const TURBOFLUX_COMPACT_MARK = 'TurboFlux'
export const TURBOFLUX_VERSION = '1.0.1'

export function centerText(text: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - stringWidth(text)) / 2))
  return `${' '.repeat(padding)}${text}`
}

export function centerTextBlock(lines: readonly string[], width: number): string[] {
  const blockWidth = lines.reduce((maximum, line) => Math.max(maximum, stringWidth(line)), 0)
  const padding = Math.max(0, Math.floor((width - blockWidth) / 2))
  const prefix = ' '.repeat(padding)
  return lines.map(line => `${prefix}${line}`)
}

export function revealTextBlock(lines: readonly string[], progress: number): string[] {
  const blockWidth = lines.reduce((maximum, line) => Math.max(maximum, stringWidth(line)), 0)
  const normalizedProgress = Math.max(0, Math.min(1, progress))
  const visibleWidth = Math.round(blockWidth * normalizedProgress)

  return lines.map(line => {
    const visible = line.slice(0, visibleWidth)
    return visible.padEnd(line.length, ' ')
  })
}

export function shouldUseCompactWordmark(columns: number, rows: number): boolean {
  return columns < 88 || rows < 26
}
