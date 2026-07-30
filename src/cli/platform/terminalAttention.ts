import { spawn } from 'node:child_process'
import type { NotificationCategory } from '../state/notificationCoordinator'

export const ENABLE_TERMINAL_FOCUS_REPORTING = '\u001b[?1004h'
export const DISABLE_TERMINAL_FOCUS_REPORTING = '\u001b[?1004l'
export const TERMINAL_FOCUS_IN = '\u001b[I'
export const TERMINAL_FOCUS_OUT = '\u001b[O'
const TERMINAL_FOCUS_IN_FRAGMENT = '[I'
const TERMINAL_FOCUS_OUT_FRAGMENT = '[O'

export type TerminalFocusState = 'foreground' | 'background' | 'unknown'

export interface TerminalAttentionNotification {
  id: string
  category: NotificationCategory
}

export function stripTerminalFocusSequences(input: string): string {
  return input
    .replaceAll(TERMINAL_FOCUS_IN, '')
    .replaceAll(TERMINAL_FOCUS_OUT, '')
    .replaceAll(TERMINAL_FOCUS_IN_FRAGMENT, '')
    .replaceAll(TERMINAL_FOCUS_OUT_FRAGMENT, '')
}

export interface TerminalAttentionAdapterOptions {
  enabled?: boolean
  interactive?: boolean
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  writeControl?: (sequence: string) => void
  spawnDetached?: (command: string, args: string[]) => void
  maxDedupeEntries?: number
}

const DESKTOP_COPY: Partial<Record<NotificationCategory, { title: string; body: string }>> = {
  'action-required': { title: 'TurboFlux', body: 'Action required' },
  error: { title: 'TurboFlux', body: 'A run needs attention' },
  'result-ready': { title: 'TurboFlux', body: 'A background result is ready' },
}

export class TerminalAttentionAdapter {
  private readonly enabled: boolean
  private readonly interactive: boolean
  private readonly platform: NodeJS.Platform
  private readonly environment: NodeJS.ProcessEnv
  private readonly writeControl: (sequence: string) => void
  private readonly spawnDetached: (command: string, args: string[]) => void
  private readonly maxDedupeEntries: number
  private readonly notifiedIds = new Set<string>()
  private focusState: TerminalFocusState = 'unknown'
  private started = false

  constructor(options: TerminalAttentionAdapterOptions = {}) {
    this.environment = options.environment ?? process.env
    this.enabled = (options.enabled ?? true) && desktopNotificationsEnabled(this.environment)
    this.interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    this.platform = options.platform ?? process.platform
    this.writeControl = options.writeControl ?? (sequence => { process.stdout.write(sequence) })
    this.spawnDetached = options.spawnDetached ?? spawnDetached
    this.maxDedupeEntries = Math.max(1, options.maxDedupeEntries ?? 256)
  }

  start(): boolean {
    if (this.started || !this.canTrackFocus()) return false
    this.started = true
    this.writeControl(ENABLE_TERMINAL_FOCUS_REPORTING)
    return true
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.writeControl(DISABLE_TERMINAL_FOCUS_REPORTING)
    this.focusState = 'unknown'
  }

  handleInput(input: string): boolean {
    const focusInAt = Math.max(
      input.lastIndexOf(TERMINAL_FOCUS_IN),
      input.lastIndexOf(TERMINAL_FOCUS_IN_FRAGMENT),
    )
    const focusOutAt = Math.max(
      input.lastIndexOf(TERMINAL_FOCUS_OUT),
      input.lastIndexOf(TERMINAL_FOCUS_OUT_FRAGMENT),
    )
    if (focusInAt < 0 && focusOutAt < 0) return false
    this.focusState = focusOutAt > focusInAt ? 'background' : 'foreground'
    return stripTerminalFocusSequences(input).length === 0
  }

  noteUserActivity(): void {
    if (this.interactive) this.focusState = 'foreground'
  }

  getFocusState(): TerminalFocusState {
    return this.focusState
  }

  notify(notification: TerminalAttentionNotification): boolean {
    const copy = DESKTOP_COPY[notification.category]
    if (!this.enabled || this.focusState !== 'background' || !copy || this.notifiedIds.has(notification.id)) {
      return false
    }
    const invocation = desktopNotificationInvocation(this.platform, copy.title, copy.body)
    if (!invocation) return false
    this.spawnDetached(invocation.command, invocation.args)
    this.notifiedIds.add(notification.id)
    while (this.notifiedIds.size > this.maxDedupeEntries) {
      const oldest = this.notifiedIds.values().next().value as string | undefined
      if (!oldest) break
      this.notifiedIds.delete(oldest)
    }
    return true
  }

  private canTrackFocus(): boolean {
    return this.enabled
      && this.interactive
      && !isTruthy(this.environment.CI)
      && this.environment.TERM?.trim().toLowerCase() !== 'dumb'
  }
}

export function prefersReducedMotion(environment: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(environment.TURBOFLUX_REDUCED_MOTION)
    || isTruthy(environment.PREFERS_REDUCED_MOTION)
    || isTruthy(environment.REDUCED_MOTION)
    || isTruthy(environment.TURBOFLUX_NO_ANIMATION)
    || isTruthy(environment.CI)
}

export function desktopNotificationsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !isFalsey(environment.TURBOFLUX_DESKTOP_NOTIFICATIONS)
}

export function desktopNotificationInvocation(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    const script = [
      'param([string]$title,[string]$body)',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$safeTitle = [System.Security.SecurityElement]::Escape($title)',
      '$safeBody = [System.Security.SecurityElement]::Escape($body)',
      "$xml.LoadXml(('<toast><visual><binding template=\"ToastGeneric\"><text>{0}</text><text>{1}</text></binding></visual></toast>') -f $safeTitle, $safeBody)",
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("TurboFlux").Show($toast)',
    ].join('; ')
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script, title, body],
    }
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e', 'end run',
        title,
        body,
      ],
    }
  }
  if (platform === 'linux') {
    return { command: 'notify-send', args: ['--app-name=TurboFlux', title, body] }
  }
  return null
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', () => {})
  child.unref()
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function isFalsey(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}
