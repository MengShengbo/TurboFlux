import type { PluginRecord, PluginSnapshot } from '../plugins/pluginService'
import type { WorkPackEntry, WorkPackKind } from '@turboflux/contracts/workPackTypes'

export interface WorkPackCatalogSnapshot {
  schemaVersion: 1
  entries: WorkPackEntry[]
  installed: WorkPackEntry[]
  warnings: string[]
}

export interface WorkPackCatalogInput {
  installedSkills: Array<{ id: string; name: string; description: string; category: string }>
  plugins: PluginSnapshot
}

function pluginKind(plugin: PluginRecord): WorkPackKind {
  const skills = plugin.manifest.contributes?.skills?.length || 0
  const tools = plugin.manifest.contributes?.tools?.length || 0
  const commands = plugin.manifest.contributes?.commands?.length || 0
  if (skills > 1 || (skills > 0 && (tools > 0 || commands > 0))) return 'bundle'
  return tools > 0 || commands > 0 || Boolean(plugin.manifest.main) ? 'integration' : 'workflow'
}

function pluginEmphases(plugin: PluginRecord) {
  if (!plugin.enabled || plugin.state !== 'enabled') return []
  const skills = (plugin.manifest.contributes?.skills || []).map(skill => ({ type: 'skill' as const, id: skill.id, name: skill.name }))
  if (skills.length) return skills
  return plugin.serverName ? [{ type: 'mcp' as const, id: plugin.serverName, name: plugin.manifest.name }] : []
}

export function buildWorkPackCatalog(input: WorkPackCatalogInput): WorkPackCatalogSnapshot {
  const pluginSkillIds = new Set(input.plugins.plugins.flatMap(plugin => (plugin.manifest.contributes?.skills || []).map(skill => skill.id)))
  const entries: WorkPackEntry[] = input.installedSkills.filter(skill => !pluginSkillIds.has(skill.id)).map(skill => ({
    id: `local-skill:${skill.id}`,
    name: skill.name,
    description: skill.description,
    version: 'local',
    publisher: '本地',
    category: skill.category,
    icon: 'workflow',
    kind: 'workflow',
    trust: 'local',
    sourceId: 'local',
    sourceName: '本地目录',
    tags: [],
    capabilities: [skill.name],
    installed: true,
    enabled: true,
    installState: 'local',
    permissions: [],
    contributions: { skills: 1, tools: 0, commands: 0 },
    backend: { type: 'local-skill', skillId: skill.id },
    emphasis: { type: 'skill', id: skill.id, name: skill.name },
    emphases: [{ type: 'skill', id: skill.id, name: skill.name }],
    canUninstall: false,
    supportsToggle: false,
    diagnostics: [],
  }))
  for (const plugin of input.plugins.plugins) {
    const contributions = plugin.manifest.contributes
    const emphases = pluginEmphases(plugin)
    entries.push({
      id: `local-plugin:${plugin.id}`,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      publisher: plugin.manifest.author.name,
      category: plugin.manifest.categories?.[0] || 'integration',
      icon: plugin.manifest.icon || 'integration',
      kind: pluginKind(plugin),
      trust: plugin.source === 'bundled' ? 'bundled' : 'local',
      sourceId: plugin.source,
      sourceName: plugin.source === 'bundled' ? '内置插件' : '本地导入',
      sourceUrl: plugin.manifest.repository || plugin.manifest.homepage,
      license: plugin.manifest.license,
      tags: [...(plugin.manifest.keywords || [])],
      capabilities: [...new Set([
        ...(contributions?.skills || []).map(item => item.name),
        ...(contributions?.agents || []).map(item => item.name),
        ...(contributions?.tools || []).map(item => item.name),
        ...(contributions?.commands || []).map(item => item.title),
      ].filter((value): value is string => Boolean(value)))],
      installed: true,
      enabled: plugin.enabled,
      installState: plugin.state,
      installedAt: new Date(plugin.installedAt).toISOString(),
      updatedAt: new Date(plugin.updatedAt).toISOString(),
      permissions: [...(plugin.manifest.permissions || [])],
      contributions: { skills: contributions?.skills?.length || 0, tools: contributions?.tools?.length || 0, commands: contributions?.commands?.length || 0 },
      backend: { type: 'local-plugin', pluginId: plugin.id },
      emphasis: emphases[0],
      emphases,
      canUninstall: plugin.source !== 'bundled',
      supportsToggle: true,
      diagnostics: [...plugin.diagnostics],
      error: plugin.error,
    })
  }
  entries.sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name, 'zh-CN'))
  return { schemaVersion: 1, entries, installed: entries, warnings: [...input.plugins.warnings] }
}
