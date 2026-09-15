import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type DesktopCloseWindowBehavior = 'platform-default' | 'keep-running' | 'quit'
export type DesktopActiveRunQuitBehavior = 'ask' | 'wait' | 'interrupt'

export interface DesktopHostPreferences {
  schemaVersion: 1
  closeWindowBehavior: DesktopCloseWindowBehavior
  activeRunQuitBehavior: DesktopActiveRunQuitBehavior
}

export const DEFAULT_DESKTOP_HOST_PREFERENCES: DesktopHostPreferences = {
  schemaVersion: 1,
  closeWindowBehavior: 'platform-default',
  activeRunQuitBehavior: 'ask',
}

export function normalizeDesktopHostPreferences(value: unknown): DesktopHostPreferences {
  const candidate = value && typeof value === 'object' ? value as Partial<DesktopHostPreferences> : {}
  return {
    schemaVersion: 1,
    closeWindowBehavior: ['platform-default', 'keep-running', 'quit'].includes(String(candidate.closeWindowBehavior))
      ? candidate.closeWindowBehavior as DesktopCloseWindowBehavior
      : DEFAULT_DESKTOP_HOST_PREFERENCES.closeWindowBehavior,
    activeRunQuitBehavior: ['ask', 'wait', 'interrupt'].includes(String(candidate.activeRunQuitBehavior))
      ? candidate.activeRunQuitBehavior as DesktopActiveRunQuitBehavior
      : DEFAULT_DESKTOP_HOST_PREFERENCES.activeRunQuitBehavior,
  }
}

export function loadDesktopHostPreferences(path: string): DesktopHostPreferences {
  try {
    return normalizeDesktopHostPreferences(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { ...DEFAULT_DESKTOP_HOST_PREFERENCES }
  }
}

export function saveDesktopHostPreferences(path: string, value: unknown): DesktopHostPreferences {
  const preferences = normalizeDesktopHostPreferences(value)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const descriptor = openSync(temporaryPath, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporaryPath, path)
  return preferences
}

export function effectiveCloseWindowBehavior(
  preferences: DesktopHostPreferences,
  platform: NodeJS.Platform = process.platform,
): Exclude<DesktopCloseWindowBehavior, 'platform-default'> {
  if (preferences.closeWindowBehavior !== 'platform-default') return preferences.closeWindowBehavior
  return platform === 'darwin' ? 'keep-running' : 'quit'
}
