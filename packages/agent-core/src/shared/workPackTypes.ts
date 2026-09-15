import type { PluginPermission } from './pluginTypes'

export type WorkPackKind = 'workflow' | 'integration' | 'bundle'

export type WorkPackInstallState =
  | 'installed'
  | 'local'
  | 'disabled'
  | 'enabled'
  | 'blocked'
  | 'error'

export type WorkPackBackend =
  | { type: 'local-skill'; skillId: string }
  | { type: 'local-plugin'; pluginId: string }

export interface WorkPackContributionSummary {
  skills: number
  tools: number
  commands: number
}

export interface WorkPackEmphasis {
  type: 'skill' | 'mcp'
  id: string
  name: string
}

export interface WorkPackEntry {
  id: string
  name: string
  description: string
  version: string
  publisher: string
  category: string
  icon: string
  kind: WorkPackKind
  trust: 'bundled' | 'local'
  sourceId: string
  sourceName: string
  sourceUrl?: string
  license?: string
  requirement?: string
  tags: string[]
  capabilities: string[]
  promptTemplate?: string
  installed: boolean
  enabled: boolean
  installState: WorkPackInstallState
  installedAt?: string
  updatedAt?: string
  sizeBytes?: number
  permissions: PluginPermission[]
  contributions: WorkPackContributionSummary
  backend: WorkPackBackend
  emphasis?: WorkPackEmphasis
  emphases?: WorkPackEmphasis[]
  canUninstall: boolean
  supportsToggle: boolean
  diagnostics: string[]
  error?: string
}
