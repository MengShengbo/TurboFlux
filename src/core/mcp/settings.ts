import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { McpSettings } from './types'

export function loadMcpSettings(workspacePath: string): McpSettings {
  const projectSettings = join(workspacePath, '.turboflux', 'settings.json')
  const globalSettings = join(homedir(), '.turboflux', 'settings.json')

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
