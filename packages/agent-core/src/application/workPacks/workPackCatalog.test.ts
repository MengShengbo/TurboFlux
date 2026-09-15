import { describe, expect, it } from 'vitest'
import { buildWorkPackCatalog } from './workPackCatalog'
import type { PluginRecord } from '../plugins/pluginService'

const plugin: PluginRecord = {
  id: 'local.tools', path: '/tmp/local-tools', source: 'local',
  enabled: true, state: 'enabled', approvedPermissions: [], installedAt: 100, updatedAt: 100,
  diagnostics: [], serverName: 'plugin-local-tools',
  manifest: {
    id: 'local.tools', name: 'Local Tools', description: 'Local integration', version: '1.0.0', author: { name: 'Local' },
    contributes: {
      skills: [{ id: 'plugin-workflow', name: 'Plugin Workflow', command: '/plugin-workflow', description: 'Packaged workflow', category: 'custom' }],
      tools: [{ id: 'inspect', name: 'Inspect', description: 'Inspect files', handler: 'inspect' }],
    },
  },
}

describe('local Work Pack catalog', () => {
  it('deduplicates projected skills and keeps local directory skills out of uninstall actions', () => {
    const snapshot = buildWorkPackCatalog({
      installedSkills: [
        { id: 'local-writing', name: 'Local Writing', description: 'Local workflow', category: 'custom' },
        { id: 'plugin-workflow', name: 'Plugin Workflow', description: 'Projected workflow', category: 'custom' },
      ],
      plugins: { schemaVersion: 1, warnings: [], plugins: [plugin] },
    })
    expect(snapshot.entries.map(entry => entry.id)).toEqual(['local-plugin:local.tools', 'local-skill:local-writing'])
    expect(snapshot.entries[0]).toMatchObject({ emphasis: { type: 'skill', id: 'plugin-workflow', name: 'Plugin Workflow' }, supportsToggle: true, canUninstall: true })
    expect(snapshot.entries[1]).toMatchObject({ canUninstall: false, supportsToggle: false })
  })

  it('does not offer disabled bundled capabilities for mounting or uninstalling', () => {
    const snapshot = buildWorkPackCatalog({
      installedSkills: [],
      plugins: { schemaVersion: 1, warnings: [], plugins: [{ ...plugin, source: 'bundled', enabled: false, state: 'disabled' }] },
    })
    expect(snapshot.entries[0]).toMatchObject({ enabled: false, installState: 'disabled', trust: 'bundled', canUninstall: false, emphases: [] })
    expect(snapshot.entries[0]?.emphasis).toBeUndefined()
  })
})
