import stringWidth from 'string-width'

export const TURBOFLUX_WORDMARK_LINES = [
  '  ______          __        ________          ',
  ' /_  __/_  ______/ /_  ____/ ____/ /_  ___  __',
  '  / / / / / / __  / / / / /_  / / / / / / |/_/',
  ' / / / /_/ / /_/ / /_/ / __/ / /_/ / /_>  <  ',
  '/_/  \\__,_/\\__,_/\\__,_/_/    \\____/\\__/_/|_|  ',
] as const

export const TURBOFLUX_COMPACT_MARK = 'TurboFlux'
export const TURBOFLUX_VERSION = '0.1.5'

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
