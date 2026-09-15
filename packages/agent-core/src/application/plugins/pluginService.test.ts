import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClient } from '../../core/mcp/client'
import { getSubAgentDefinition, loadDynamicAgents } from '../../core/subAgent'
import { PluginService } from './pluginService'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(root: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const directory = join(root, 'fixture')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest))
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return directory
}

describe('PluginService', () => {
  it('installs, enables, projects Skills, disables, and persists metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const source = fixture(root, {
      id: 'example.workflow', name: 'Example', description: 'Example plugin', version: '1.0.0', author: { name: 'Test' }, permissions: [],
      contributes: {
        skills: [{ id: 'review', name: 'Review', command: '/review', description: 'Review work', category: 'custom', promptPath: 'skills/review/SKILL.md' }],
        agents: [{
          id: 'example_plugin_researcher', name: 'Researcher', description: 'Research public evidence', systemPrompt: 'Research and write an indexed report.',
          tools: ['web_search', 'web_fetch', 'write_research_report'], maxTurns: 12, maxParallel: 3, requestTimeoutMs: 300_000,
          requiredToolCalls: { write_research_report: 2 }, thinking: 'high',
        }],
      },
    }, { 'skills/review/SKILL.md': '# Review\nCheck the result.' })
    const store = join(root, 'plugins.json')
    const pluginsRoot = join(root, 'plugins')
    const service = new PluginService(store, pluginsRoot, workspace)
    await service.initialize(new McpClient())
    await service.installFromDirectory(source, [])
    await service.setEnabled('example.workflow', true)
    const projected = service.list().plugins[0]
    expect(projected.state).toBe('enabled')
    const pluginHash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update('example.workflow').digest('hex').slice(0, 10))
    const skillPath = join(workspace, '.turboflux', 'skills', `plugin-${pluginHash}-review`, 'SKILL.md')
    const agentPath = join(workspace, '.turboflux', 'agents', `plugin-${pluginHash}-example_plugin_researcher.md`)
    expect(readFileSync(skillPath, 'utf8')).toContain('name: review')
    expect(readFileSync(agentPath, 'utf8')).toContain('tools: ["web_search","web_fetch","write_research_report"]')
    expect(readFileSync(agentPath, 'utf8')).toContain('requestTimeoutMs: 300000')
    expect(readFileSync(agentPath, 'utf8')).toContain('requiredToolCalls: {"write_research_report":2}')
    expect(readFileSync(agentPath, 'utf8')).toContain('thinking: high')
    expect(readFileSync(agentPath, 'utf8')).not.toContain('model:')
    loadDynamicAgents(workspace)
    expect(getSubAgentDefinition('example_plugin_researcher')?.allowedTools).toEqual(['web_search', 'web_fetch', 'write_research_report'])
    expect(getSubAgentDefinition('example_plugin_researcher')).toMatchObject({
      maxTurns: 12,
      requestTimeoutMs: 300_000,
      requiredToolCalls: { write_research_report: 2 },
    })
    await service.setEnabled('example.workflow', false)
    expect(() => readFileSync(skillPath, 'utf8')).toThrow()
    expect(() => readFileSync(agentPath, 'utf8')).toThrow()
    loadDynamicAgents(workspace)
    expect(getSubAgentDefinition('example_plugin_researcher')).toBeUndefined()
    expect(new PluginService(store, pluginsRoot, workspace).list().plugins.find(plugin => plugin.id === 'example.workflow')?.enabled).toBe(false)
  })

  it('rejects traversal entries and unapproved permissions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const source = fixture(root, { id: 'bad.plugin', name: 'Bad', description: '', version: '1.0.0', author: { name: 'Test' }, main: '../escape.mjs', permissions: ['network'] })
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await expect(service.inspectDirectory(source)).rejects.toThrow('unsafe path')
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'permission.plugin', name: 'Permission', description: '', version: '1.0.0', author: { name: 'Test' }, permissions: ['network'] }))
    await expect(service.installFromDirectory(source, [])).rejects.toThrow('must be approved')
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'unsupported.permission', name: 'Unsupported', description: '', version: '1.0.0', author: { name: 'Test' }, permissions: ['clipboard'] }))
    await expect(service.inspectDirectory(source)).rejects.toThrow('unknown permission')
  })

  it('rejects duplicate contribution ids across installed plugins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-conflict-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const first = fixture(root, {
      id: 'first.plugin', name: 'First', description: '', version: '1.0.0', author: { name: 'Test' }, permissions: [],
      contributes: { skills: [{ id: 'shared-skill', name: 'Shared', command: '/shared', description: 'First owner', category: 'custom', systemPrompt: 'First' }] },
    })
    const secondRoot = join(root, 'second-source')
    mkdirSync(secondRoot)
    writeFileSync(join(secondRoot, 'plugin.json'), JSON.stringify({
      id: 'second.plugin', name: 'Second', description: '', version: '1.0.0', author: { name: 'Test' }, permissions: [],
      contributes: { skills: [{ id: 'shared-skill', name: 'Shared', command: '/shared', description: 'Second owner', category: 'custom', systemPrompt: 'Second' }] },
    }))
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await service.initialize(new McpClient())

    await service.installFromDirectory(first, [])
    await expect(service.installFromDirectory(secondRoot, [])).rejects.toThrow('Plugin skills id conflicts with first.plugin: shared-skill')
  })

  it.skipIf(process.platform !== 'darwin')('recreates a crashed code host when the plugin is enabled again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-crash-recovery-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const source = fixture(root, {
      id: 'crash.recovery', name: 'Crash recovery', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [],
      contributes: {
        commands: [
          { id: 'crash', title: 'Crash' },
          { id: 'echo', title: 'Echo' },
        ],
      },
    }, { 'main.mjs': 'export function crash() { process.exit(17) }\nexport function echo() { return "recovered" }\n' })
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await service.initialize(new McpClient())
    await service.installFromDirectory(source, [])
    await service.setEnabled('crash.recovery', true)

    await expect(service.executeCommand('crash.recovery', 'crash')).rejects.toThrow('Plugin host exited')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(service.list().plugins.find(plugin => plugin.id === 'crash.recovery')).toMatchObject({ state: 'error' })

    await service.setEnabled('crash.recovery', true)
    await expect(service.executeCommand('crash.recovery', 'echo')).resolves.toBe('recovered')
    await service.destroy()
  })

  it.skipIf(process.platform !== 'darwin')('isolates code host state and storage by conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-conversation-isolation-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const source = fixture(root, {
      id: 'conversation.isolation',
      name: 'Conversation isolation',
      description: '',
      version: '1.0.0',
      author: { name: 'Test' },
      main: 'main.mjs',
      permissions: ['storage'],
      contributes: { commands: [{ id: 'increment', title: 'Increment' }] },
    }, { 'main.mjs': `export function activate(context) {
      return {
        async increment() {
          const count = (await context.api.storage.get('count') || 0) + 1
          await context.api.storage.set('count', count)
          return { conversationId: context.conversationId, count }
        },
      }
    }\n` })
    const firstClient = new McpClient()
    const secondClient = new McpClient()
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await service.initialize(firstClient, { conversationId: 'conversation-a' })
    await service.initialize(secondClient, { conversationId: 'conversation-b' })
    await service.installFromDirectory(source, ['storage'])
    await service.setEnabled('conversation.isolation', true)

    await expect(service.executeCommand('conversation.isolation', 'increment', 'conversation-a')).resolves.toEqual({ conversationId: 'conversation-a', count: 1 })
    await expect(service.executeCommand('conversation.isolation', 'increment', 'conversation-a')).resolves.toEqual({ conversationId: 'conversation-a', count: 2 })
    await expect(service.executeCommand('conversation.isolation', 'increment', 'conversation-b')).resolves.toEqual({ conversationId: 'conversation-b', count: 1 })

    await service.detachMcpClient(firstClient)
    await expect(service.executeCommand('conversation.isolation', 'increment', 'conversation-a')).rejects.toThrow('running sandbox host')
    await expect(service.executeCommand('conversation.isolation', 'increment', 'conversation-b')).resolves.toEqual({ conversationId: 'conversation-b', count: 2 })
    await service.destroy()
  })

  it('installs and enables the bundled local office plugin on first initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await service.initialize(new McpClient())

    const plugin = service.list().plugins.find(candidate => candidate.id === 'turboflux.office-workagent')
    expect(plugin).toMatchObject({ source: 'bundled', enabled: true, state: 'enabled' })
    expect(plugin?.manifest.contributes?.skills).toHaveLength(7)
    expect(readFileSync(join(workspace, '.turboflux', 'skills', 'plugin-20b9f19062-office-workagent', 'SKILL.md'), 'utf8')).toContain('办公任务总控')
    await expect(service.uninstall('turboflux.office-workagent')).rejects.toThrow('Bundled plugins cannot be uninstalled')
  })

  it('adopts an existing office installation without overriding its disabled state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const store = join(root, 'plugins.json')
    const pluginsRoot = join(root, 'plugins')
    const service = new PluginService(store, pluginsRoot, workspace)
    await service.initialize(new McpClient())
    await service.setEnabled('turboflux.office-workagent', false)

    const restored = new PluginService(store, pluginsRoot, workspace)
    await restored.initialize(new McpClient())

    expect(restored.list().plugins.find(candidate => candidate.id === 'turboflux.office-workagent')).toMatchObject({
      source: 'bundled',
      enabled: false,
      state: 'disabled',
    })
  })

  it('keeps earlier imported plugins locally without replacing their files or enabled state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-migration-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const path = fixture(root, { id: 'turboflux.design-atlas', name: 'Customized Atlas', description: 'Local copy', version: '0.9.0', author: { name: 'User' } })
    const store = join(root, 'plugins.json')
    writeFileSync(store, JSON.stringify({ schemaVersion: 1, plugins: [{
      id: 'turboflux.design-atlas', path, source: 'marketplace', enabled: false,
      approvedPermissions: [], installedAt: 10, updatedAt: 10,
    }] }))
    const service = new PluginService(store, join(root, 'plugins'), workspace)
    await service.initialize(new McpClient())
    expect(service.list().plugins.find(plugin => plugin.id === 'turboflux.design-atlas')).toMatchObject({
      source: 'local', enabled: false, manifest: { name: 'Customized Atlas', version: '0.9.0' },
    })
    expect(JSON.parse(readFileSync(join(path, 'plugin.json'), 'utf8')).version).toBe('0.9.0')
  })

  it('detaches destroyed conversation MCP clients from future plugin registrations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-client-lifecycle-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const client = new McpClient()
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await service.initialize(client)

    await service.detachMcpClient(client)

    expect((service as unknown as { mcpClients: Set<McpClient> }).mcpClients.has(client)).toBe(false)
  })

  it('keeps the optional design plugin disabled until explicitly enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-plugin-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const service = new PluginService(join(root, 'plugins.json'), join(root, 'plugins'), workspace)
    await service.initialize(new McpClient())
    expect(service.list().plugins.find(plugin => plugin.id === 'turboflux.design-atlas')).toMatchObject({ enabled: false, source: 'bundled' })
    await service.setEnabled('turboflux.design-atlas', true)

    const updated = service.list()
    const atlas = updated.plugins.find(plugin => plugin.id === 'turboflux.design-atlas')
    expect(atlas).toMatchObject({ enabled: true, state: 'enabled', source: 'bundled', manifest: { version: '1.3.2' } })
    expect(readFileSync(join(workspace, '.turboflux', 'skills', 'plugin-17c2c4276b-design-atlas', 'SKILL.md'), 'utf8')).toContain('宿主不会替插件自动弹出入口')
  })
})
