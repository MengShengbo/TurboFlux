export interface TerminalMouseWheelEvent {
  direction: 'up' | 'down'
  x: number
  y: number
}

export const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1006h'
export const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1000l'

export function parseTerminalMouseWheel(input: string): TerminalMouseWheelEvent[] {
  const events: TerminalMouseWheelEvent[] = []
  const pattern = /(?:\u001b)?\[<(\d+);(\d+);(\d+)[mM]/g

  for (const match of input.matchAll(pattern)) {
    const button = Number(match[1])
    if ((button & 64) !== 64) continue
    events.push({
      direction: (button & 1) === 0 ? 'up' : 'down',
      x: Number(match[2]),
      y: Number(match[3]),
    })
  }

  return events
}

export function isTerminalMouseInput(input: string): boolean {
  return /(?:\u001b)?\[<\d+;\d+;\d+[mM]/.test(input)
}

export function shouldEnableMouseTracking(
  interactive: boolean,
  fixedViewport: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!interactive || !fixedViewport) return false
  if (environment.TERM?.trim().toLowerCase() === 'dumb') return false
  const preference = environment.TURBOFLUX_MOUSE?.trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(preference || '')
}
