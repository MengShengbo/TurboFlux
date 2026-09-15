import type {
  ComputerActionSafetyClass,
  ComputerAppSnapshot,
  ComputerBounds,
  ComputerObservation,
  ComputerPoint,
} from '@turboflux/agent-core/contracts'

const PROTECTED_BUNDLE_IDS = new Map<string, string>([
  ['com.apple.Terminal', 'Terminal cannot be controlled through Computer Use'],
  ['com.googlecode.iterm2', 'iTerm cannot be controlled through Computer Use'],
  ['dev.warp.Warp-Stable', 'Warp cannot be controlled through Computer Use'],
  ['com.github.wez.wezterm', 'WezTerm cannot be controlled through Computer Use'],
  ['com.apple.keychainaccess', 'Keychain Access requires user takeover'],
  ['com.apple.Passwords', 'Passwords requires user takeover'],
  ['com.1password.1password', 'Password managers require user takeover'],
  ['com.bitwarden.desktop', 'Password managers require user takeover'],
  ['com.lastpass.LastPass', 'Password managers require user takeover'],
  ['com.apple.systempreferences', 'System privacy and security settings require user takeover'],
  ['com.apple.SystemSettings', 'System privacy and security settings require user takeover'],
])

export const COMPUTER_OBSERVATION_TTL_MS = 20_000

export function protectedComputerAppReason(app: Pick<ComputerAppSnapshot, 'pid' | 'bundleId' | 'name'>, ownPid: number): string | undefined {
  if (app.pid === ownPid) return 'TurboFlux cannot operate its own window'
  if (app.bundleId) {
    const exact = PROTECTED_BUNDLE_IDS.get(app.bundleId)
    if (exact) return exact
    if (app.bundleId.startsWith('com.1password.')) return 'Password managers require user takeover'
  }
  if (/\b(?:terminal|iterm2?|warp|wezterm|passwords?|keychain|system settings|1password|bitwarden|lastpass)\b/i.test(app.name)
    || /(?:终端|系统设置|密码|钥匙串)/u.test(app.name)) {
    return 'This protected application requires user takeover'
  }
  return undefined
}

export function sanitizeComputerPurpose(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/(?:password|passcode|one[- ]?time|\botp\b|api[- ]?key|access[- ]?token|secret|captcha|密码|验证码|密钥|令牌)/iu.test(compact)) return fallback
  if (/(?:coordinates?|坐标|\b[xy]\s*[:=]\s*-?\d+(?:\.\d+)?|\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\))/iu.test(compact)) return fallback
  if (/\b(?:cmd|command|ctrl|control|alt|option|shift|meta)\s*\+\s*[\w]/iu.test(compact)) return fallback
  const summary = compact.slice(0, 80)
  return summary || fallback
}

export function normalizeSafetyClass(value: unknown): ComputerActionSafetyClass {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['external', 'sensitive', 'destructive', 'payment', 'system', 'credential'].includes(normalized)) {
    return normalized as ComputerActionSafetyClass
  }
  return 'routine'
}

export function assertSafeComputerText(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) throw new Error('Text input is required')
  if (text.length > 8_000) throw new Error('Text input exceeds the 8,000 character limit')
  return text
}

export function assertFreshObservation(observation: ComputerObservation | undefined, now = Date.now()): ComputerObservation {
  if (!observation) throw new Error('Computer observation not found; observe the application again')
  if (now > observation.expiresAt || now - observation.capturedAt > COMPUTER_OBSERVATION_TTL_MS) {
    throw new Error('Computer observation is stale; observe the application again')
  }
  return observation
}

export function observationPoint(observation: ComputerObservation, point: ComputerPoint): ComputerPoint {
  if (!observation.image || observation.controlMode !== 'foreground-visual') {
    throw new Error('This action needs a visible foreground observation; focus the application and observe it again')
  }
  const { width, height } = observation.image
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Computer coordinates must be finite numbers')
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
    throw new Error(`Computer coordinates are outside the ${width}x${height} observation`)
  }
  const logical = observation.coordinateSpace.logicalBounds
  return {
    x: logical.x + (point.x / width) * logical.width,
    y: logical.y + (point.y / height) * logical.height,
  }
}

export function boundsContainPoint(bounds: ComputerBounds, point: ComputerPoint): boolean {
  return point.x >= bounds.x
    && point.y >= bounds.y
    && point.x < bounds.x + bounds.width
    && point.y < bounds.y + bounds.height
}

export function computerDisplayFingerprint(displays: Array<{ id: string; bounds: ComputerBounds; scaleFactor: number }>): string {
  return displays
    .map(display => `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}@${display.scaleFactor}`)
    .sort()
    .join('|')
}

export function normalizeComputerKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) throw new Error('Press requires one bounded key combination')
  const keys = value.map(item => String(item).trim()).filter(Boolean)
  if (keys.length === 0 || keys.some(key => key.length > 24)) throw new Error('Invalid key combination')
  const normalized = keys.map(key => key.toLowerCase())
  const modifiers = new Set(['meta', 'command', 'cmd', 'control', 'ctrl', 'option', 'alt', 'shift'])
  if (normalized.filter(key => !modifiers.has(key)).length !== 1) throw new Error('Press supports one key plus optional modifiers')
  return keys
}

export function keyCombinationRequiresEscalation(keys: string[]): boolean {
  const normalized = new Set(keys.map(key => key.toLowerCase()))
  const meta = normalized.has('meta') || normalized.has('command') || normalized.has('cmd')
  return meta && ['q', 'w', 'delete', 'backspace'].some(key => normalized.has(key))
}
