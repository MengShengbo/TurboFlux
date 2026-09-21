import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { McpSettings } from './types'
import { getActiveProfilePaths } from '@turboflux/platform/profilePaths'

export function loadMcpSettings(workspacePath: string): McpSettings {
  const projectSettings = join(workspacePath, '.turboflux', 'settings.json')
  const globalSettings = getActiveProfilePaths().globalMcpSettingsPath

  let merged: McpSettings = { mcpServers: {} }

  // Global settings (lower priority)
  if (existsSync(globalSettings)) {
    try {
      const raw = JSON.parse(readFileSync(globalSettings, 'utf-8'))
      if (raw.mcpServers) merged.mcpServers = { ...merged.mcpServers, ...raw.mcpServers }
    } catch {}
  }

  // Project settings (higher priority, overrides global)
  if (existsSync(projectSettings)) {
    try {
      const raw = JSON.parse(readFileSync(projectSettings, 'utf-8'))
      if (raw.mcpServers) merged.mcpServers = { ...merged.mcpServers, ...raw.mcpServers }
    } catch {}
  }

  return merged
}

export function saveProjectMcpSettings(workspacePath: string, settings: McpSettings): void {
  const settingsDirectory = join(workspacePath, '.turboflux')
  const settingsPath = join(settingsDirectory, 'settings.json')
  mkdirSync(settingsDirectory, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    } catch {}
  }
  const next = { ...existing, mcpServers: settings.mcpServers }
  const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  renameSync(temporaryPath, settingsPath)
}
