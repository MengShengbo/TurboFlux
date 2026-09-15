import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpClient } from '../../core/mcp/client'
import type { McpLocalToolDefinition } from '../../core/mcp/types'
import type { PluginManifest, PluginPermission, PluginTool } from '../../shared/pluginTypes'
import { AtomicJsonStore } from '../platform/atomicJsonStore'
import { BUNDLED_PLUGINS, type BundledPlugin } from './bundledPlugins'
import { codePluginHostUnavailableReason, PluginHostProcess, unsupportedCodePermissions } from './pluginHost'
import { validatePluginManifest } from './pluginManifestValidation'

export interface PluginRecord {
  id: string
  manifest: PluginManifest
  path: string
  source: 'local' | 'bundled'
  enabled: boolean
  state: 'installed' | 'enabled' | 'disabled' | 'error' | 'blocked'
  approvedPermissions: PluginPermission[]
  installedAt: number
  updatedAt: number
  error?: string
  diagnostics: string[]
  serverName?: string
}

export interface PluginSnapshot {
  schemaVersion: 1
  warnings: string[]
  plugins: PluginRecord[]
}

interface PluginStoreRecord {
  id: string
  path: string
  source: PluginRecord['source']
  enabled: boolean
  approvedPermissions: PluginPermission[]
  installedAt: number
  updatedAt: number
  error?: string
}

interface PluginStoreFile {
  schemaVersion: 1
  plugins: PluginStoreRecord[]
}

type PluginContributionKind = 'commands' | 'tools' | 'agents' | 'skills' | 'workflows'

function contributionIds(manifest: PluginManifest): Map<PluginContributionKind, Set<string>> {
  return new Map<PluginContributionKind, Set<string>>([
    ['commands', new Set((manifest.contributes?.commands || []).map(item => item.id))],
    ['tools', new Set((manifest.contributes?.tools || []).map(item => item.id))],
    ['agents', new Set((manifest.contributes?.agents || []).map(item => item.id))],
    ['skills', new Set((manifest.contributes?.skills || []).map(item => item.id))],
    ['workflows', new Set((manifest.contributes?.workflows || []).map(item => item.id))],
  ])
}

function validStore(value: unknown): value is PluginStoreFile {
  return Boolean(value && typeof value === 'object' && (value as PluginStoreFile).schemaVersion === 1 && Array.isArray((value as PluginStoreFile).plugins))
}

function safeRelativePath(value: string, label: string): string {
  if (!value || isAbsolute(value)) throw new Error(`${label} must be a relative path`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe path`)
  return normalized
}

async function inspectTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`Plugin packages cannot contain symbolic links: ${relative(root, path)}`)
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) {
        files += 1
        bytes += info.size
        if (files > 1_000 || bytes > 50 * 1024 * 1024) throw new Error('Plugin package exceeds the 1,000 file or 50 MB limit')
      } else throw new Error(`Unsupported plugin package entry: ${relative(root, path)}`)
    }
  }
  await visit(root)
}

function serverNameFor(id: string): string {
  return `plugin-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

function toolSchema(tool: PluginTool): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries((tool.parameters || []).map(parameter => [parameter.name, {
      type: parameter.type,
      description: parameter.description,
      ...(parameter.default === undefined ? {} : { default: parameter.default }),
    }])),
    required: (tool.parameters || []).filter(parameter => parameter.required).map(parameter => parameter.name),
    additionalProperties: false,
  }
}

export class PluginService {
  private readonly store: AtomicJsonStore<PluginStoreFile>
  private data: PluginStoreFile
  private warnings: string[]
  private readonly hosts = new Map<string, Map<McpClient, PluginHostProcess>>()
  private readonly mcpClients = new Map<McpClient, { conversationId: string }>()
  private bundledInitialization: Promise<void> | null = null

  constructor(
    storePath: string,
    private readonly pluginsRoot: string,
    private workspacePath: string,
    private readonly onChanged?: () => void,
  ) {
    this.store = new AtomicJsonStore(storePath, () => ({ schemaVersion: 1, plugins: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.data.plugins = this.data.plugins.map(plugin => ({ ...plugin, source: plugin.source === 'bundled' ? 'bundled' : 'local' }))
    this.warnings = loaded.warnings
  }

  setWorkspacePath(workspacePath: string): void {
    this.workspacePath = resolve(workspacePath)
  }


  async initialize(mcpClient: McpClient, context: { conversationId: string } = { conversationId: 'plugin-service-default' }): Promise<void> {
    this.mcpClients.set(mcpClient, { conversationId: context.conversationId })
    await mkdir(this.pluginsRoot, { recursive: true, mode: 0o700 })
    if (!this.bundledInitialization) this.bundledInitialization = this.ensureBundledPlugins()
    await this.bundledInitialization
    for (const record of this.data.plugins.filter(plugin => plugin.enabled)) {
      try { await this.activate(record.id) } catch (error) { this.setError(record.id, error) }
    }
  }

  async detachMcpClient(mcpClient: McpClient): Promise<void> {
    if (!this.mcpClients.delete(mcpClient)) return
    await Promise.all(this.data.plugins.map(async plugin => {
      const serverName = serverNameFor(plugin.id)
      if (mcpClient.getConnection(serverName)) await mcpClient.disconnect(serverName)
      const hosts = this.hosts.get(plugin.id)
      const host = hosts?.get(mcpClient)
      hosts?.delete(mcpClient)
      await host?.stop()
      if (hosts?.size === 0) this.hosts.delete(plugin.id)
    }))
  }

  async inspectDirectory(sourcePath: string): Promise<{ manifest: PluginManifest; path: string }> {
    const path = resolve(sourcePath)
    if (!(await stat(path)).isDirectory()) throw new Error('Choose a plugin folder')
    await inspectTree(path)
    const manifest = validatePluginManifest(JSON.parse(await readFile(join(path, 'plugin.json'), 'utf8')) as unknown)
    if (manifest.main) {
      const mainPath = resolve(path, safeRelativePath(manifest.main, 'Plugin main entry'))
      const child = relative(path, mainPath)
      if (child === '..' || child.startsWith(`..${sep}`) || !(await stat(mainPath)).isFile()) throw new Error('Plugin main entry is missing or outside the package')
    }
    for (const skill of manifest.contributes?.skills || []) {
      if (!skill.promptPath) continue
      const promptPath = resolve(path, safeRelativePath(skill.promptPath, `Skill ${skill.id} promptPath`))
      if (!(await stat(promptPath)).isFile()) throw new Error(`Skill prompt is missing: ${skill.promptPath}`)
    }
    return { manifest, path }
  }

  async installFromDirectory(sourcePath: string, approvedPermissions: PluginPermission[] = []): Promise<PluginSnapshot> {
    const inspected = await this.inspectDirectory(sourcePath)
    return this.installInspected(inspected.path, inspected.manifest, 'local', approvedPermissions)
  }



  private async installBundledPlugin(
    entry: BundledPlugin,
    enabled: boolean,
  ): Promise<PluginSnapshot> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'turboflux-plugin-'))
    try {
      await writeFile(join(temporaryDirectory, 'plugin.json'), `${JSON.stringify(entry.manifest, null, 2)}\n`, { mode: 0o600 })
      for (const [path, content] of Object.entries(entry.promptFiles || {})) {
        const target = resolve(temporaryDirectory, safeRelativePath(path, 'Bundled plugin file'))
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, content, { mode: 0o600 })
      }
      const inspected = await this.inspectDirectory(temporaryDirectory)
      const snapshot = await this.installInspected(inspected.path, inspected.manifest, 'bundled', [])
      if (!enabled) return snapshot
      const record = this.requireRecord(entry.manifest.id)
      record.enabled = true
      record.updatedAt = Date.now()
      this.persist()
      return this.list()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  private async ensureBundledPlugins(): Promise<void> {
    for (const entry of BUNDLED_PLUGINS) {
      const existing = this.data.plugins.find(plugin => plugin.id === entry.manifest.id)
      if (existing) {
        if (existing.source !== 'bundled') continue
        try {
          const installed = await this.inspectDirectory(existing.path)
          if (installed.manifest.version === entry.manifest.version) {
            continue
          }
        } catch {}
        const managedRoot = resolve(this.pluginsRoot)
        const managedPath = resolve(existing.path)
        const child = relative(managedRoot, managedPath)
        if (child && child !== '..' && !child.startsWith(`..${sep}`)) await rm(managedPath, { recursive: true, force: true })
        const enabled = existing.enabled
        this.data.plugins = this.data.plugins.filter(plugin => plugin.id !== existing.id)
        this.persist()
        await this.installBundledPlugin(entry, enabled)
        continue
      }
      await this.installBundledPlugin(entry, entry.enabledByDefault)
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginSnapshot> {
    const record = this.requireRecord(id)
    if (enabled) {
      record.enabled = true
      record.error = undefined
      record.updatedAt = Date.now()
      this.persist()
      try { await this.activate(id) } catch (error) { this.setError(id, error); throw error }
    } else {
      await this.deactivate(id)
      record.enabled = false
      record.error = undefined
      record.updatedAt = Date.now()
      this.persist()
    }
    return this.list()
  }

  async uninstall(id: string): Promise<PluginSnapshot> {
    const record = this.requireRecord(id)
    if (record.source === 'bundled') throw new Error('Bundled plugins cannot be uninstalled')
    await this.deactivate(id)
    const managedRoot = resolve(this.pluginsRoot)
    const managedPath = resolve(record.path)
    const child = relative(managedRoot, managedPath)
    if (!child || child === '..' || child.startsWith(`..${sep}`)) throw new Error('Refusing to remove a plugin outside the managed directory')
    await rm(managedPath, { recursive: true, force: true })
    this.data.plugins = this.data.plugins.filter(plugin => plugin.id !== id)
    this.persist()
    return this.list()
  }

  list(): PluginSnapshot {
    const records: PluginRecord[] = []
    for (const stored of this.data.plugins) {
      try {
        const manifest = validatePluginManifest(JSON.parse(readFileSync(join(stored.path, 'plugin.json'), 'utf8')) as unknown)
        const unsupported = manifest.main ? unsupportedCodePermissions(manifest.permissions) : []
        const unavailableReason = manifest.main ? codePluginHostUnavailableReason() : undefined
        const error = stored.error
          || (unsupported.length ? `Unsupported code permissions: ${unsupported.join(', ')}` : undefined)
          || unavailableReason
        records.push({
          ...stored,
          manifest,
          approvedPermissions: [...stored.approvedPermissions],
          state: error ? (stored.enabled ? 'error' : 'blocked') : stored.enabled ? 'enabled' : 'disabled',
          error,
          diagnostics: [
            manifest.main
              ? unavailableReason
                ? `Code host unavailable: ${unavailableReason}`
                : 'Code host: macOS sandbox with Node permission enforcement'
              : 'Declarative plugin; no code execution',
            ...(manifest.permissions?.length ? [`Declared permissions: ${manifest.permissions.join(', ')}`] : ['No additional permissions']),
          ],
          serverName: manifest.contributes?.tools?.length ? serverNameFor(stored.id) : undefined,
        })
      } catch (error) {
        records.push({
          ...stored,
          manifest: { id: stored.id, name: stored.id, description: '', version: '0.0.0', author: { name: 'Unknown' } },
          approvedPermissions: [...stored.approvedPermissions],
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          diagnostics: ['Plugin manifest could not be read or validated'],
        })
      }
    }
    return {
      schemaVersion: 1,
      warnings: [...this.warnings],
      plugins: records.sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.updatedAt - left.updatedAt),
    }
  }

  getByServerName(name: string): PluginRecord | undefined {
    return this.list().plugins.find(plugin => plugin.serverName === name)
  }

  async destroy(): Promise<void> {
    for (const record of this.data.plugins.filter(plugin => plugin.enabled)) await this.deactivate(record.id)
    this.mcpClients.clear()
  }

  listCommands(): Array<{ id: string; title: string; detail: string; pluginId: string }> {
    return this.list().plugins
      .filter(plugin => plugin.enabled && plugin.state === 'enabled' && plugin.manifest.main)
      .flatMap(plugin => (plugin.manifest.contributes?.commands || []).map(command => ({
        id: command.id,
        title: command.title,
        detail: plugin.manifest.name,
        pluginId: plugin.id,
      })))
  }

  async executeCommand(pluginId: string, commandId: string, conversationId?: string): Promise<unknown> {
    const plugin = this.list().plugins.find(item => item.id === pluginId)
    if (!plugin?.enabled || plugin.state !== 'enabled') throw new Error(`Plugin is not enabled: ${pluginId}`)
    const command = plugin.manifest.contributes?.commands?.find(item => item.id === commandId)
    if (!command) throw new Error(`Plugin command not found: ${commandId}`)
    const hosts = this.hosts.get(pluginId)
    const client = conversationId
      ? [...this.mcpClients].find(([, context]) => context.conversationId === conversationId)?.[0]
      : this.mcpClients.keys().next().value as McpClient | undefined
    const host = client ? hosts?.get(client) : undefined
    if (!host) throw new Error('Plugin command requires a running sandbox host')
    return host.invoke(commandId, {})
  }

  private async installInspected(sourcePath: string, manifest: PluginManifest, source: PluginRecord['source'], approvedPermissions: PluginPermission[]): Promise<PluginSnapshot> {
    if (this.data.plugins.some(plugin => plugin.id === manifest.id)) throw new Error(`Plugin is already installed: ${manifest.id}`)
    this.assertContributionIdsAvailable(manifest)
    const requested = new Set(manifest.permissions || [])
    if (approvedPermissions.some(permission => !requested.has(permission))) throw new Error('Approved permissions do not match the plugin manifest')
    if ([...requested].some(permission => !approvedPermissions.includes(permission))) throw new Error('All requested plugin permissions must be approved before installation')
    await mkdir(this.pluginsRoot, { recursive: true, mode: 0o700 })
    const directoryName = `${manifest.id.replace(/[^a-z0-9._-]+/gi, '-')}-${createHash('sha256').update(`${manifest.id}@${manifest.version}`).digest('hex').slice(0, 8)}`
    const finalPath = resolve(this.pluginsRoot, directoryName)
    const temporaryPath = `${finalPath}.installing-${Date.now()}`
    await cp(sourcePath, temporaryPath, { recursive: true, errorOnExist: true })
    try { await rename(temporaryPath, finalPath) } catch (error) { await rm(temporaryPath, { recursive: true, force: true }); throw error }
    const now = Date.now()
    this.data.plugins.push({ id: manifest.id, path: finalPath, source, enabled: false, approvedPermissions: [...approvedPermissions], installedAt: now, updatedAt: now })
    this.persist()
    return this.list()
  }

  private async activate(id: string): Promise<void> {
    const record = this.requireRecord(id)
    const inspected = await this.inspectDirectory(record.path)
    const manifest = inspected.manifest
    let hosts = this.hosts.get(id)
    if (manifest.main) {
      if (!hosts) {
        hosts = new Map()
        this.hosts.set(id, hosts)
      }
      for (const [client, context] of this.mcpClients) {
        if (hosts.has(client)) continue
        let host: PluginHostProcess
        host = new PluginHostProcess({
          manifest,
          conversationId: context.conversationId,
          pluginDirectory: record.path,
          workspacePath: this.workspacePath,
          storagePath: join(
            this.pluginsRoot,
            '.storage',
            createHash('sha256').update(id).digest('hex').slice(0, 16),
            createHash('sha256').update(context.conversationId).digest('hex').slice(0, 16),
          ),
          approvedPermissions: record.approvedPermissions,
          onCrash: message => { void this.handleHostCrash(id, client, host, message) },
        })
        await host.start()
        hosts.set(client, host)
      }
    }
    const tools = manifest.contributes?.tools || []
    if (tools.length > 0) {
      if (!manifest.main) throw new Error('Plugin tools require a sandboxed main entry')
      const definitions: McpLocalToolDefinition[] = tools.map(tool => ({ name: tool.id, description: tool.description, inputSchema: toolSchema(tool) }))
      for (const client of this.mcpClients.keys()) {
        const host = hosts?.get(client)
        if (!host) throw new Error('Plugin tools require a conversation-scoped sandbox host')
        client.registerLocalServer({
          name: serverNameFor(id),
          instructions: `${manifest.name}: ${manifest.description}`,
          tools: definitions,
          handler: async (toolName, args) => host.invoke(tools.find(tool => tool.id === toolName)?.handler || toolName, args),
        })
      }
    }
    await this.projectSkills(manifest, record.path)
    await this.projectAgents(manifest)
    record.enabled = true
    record.error = undefined
    record.updatedAt = Date.now()
    this.persist()
  }

  private async deactivate(id: string): Promise<void> {
    const record = this.data.plugins.find(plugin => plugin.id === id)
    if (!record) return
    const serverName = serverNameFor(id)
    await Promise.all([...this.mcpClients.keys()].map(async client => {
      if (client.getConnection(serverName)) await client.disconnect(serverName)
    }))
    const hosts = this.hosts.get(id)
    this.hosts.delete(id)
    await Promise.all([...(hosts?.values() || [])].map(host => host.stop()))
    await this.removeProjectedSkills(id)
    await this.removeProjectedAgents(id)
  }

  private async handleHostCrash(id: string, client: McpClient, host: PluginHostProcess, message: string): Promise<void> {
    const hosts = this.hosts.get(id)
    if (hosts?.get(client) !== host) return
    this.hosts.delete(id)
    this.setError(id, message)
    const serverName = serverNameFor(id)
    await Promise.all([...this.mcpClients.keys()].map(async registeredClient => {
      if (registeredClient.getConnection(serverName)) await registeredClient.disconnect(serverName)
    }))
    await Promise.all([...hosts.values()].filter(candidate => candidate !== host).map(candidate => candidate.stop()))
    await Promise.all([
      this.removeProjectedSkills(id),
      this.removeProjectedAgents(id),
    ])
  }

  private async projectSkills(manifest: PluginManifest, pluginPath: string): Promise<void> {
    const skills = manifest.contributes?.skills || []
    if (skills.length === 0) return
    const skillsRoot = join(this.workspacePath, '.turboflux', 'skills')
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
    for (const skill of skills) {
      const body = skill.promptPath
        ? await readFile(resolve(pluginPath, safeRelativePath(skill.promptPath, `Skill ${skill.id} promptPath`)), 'utf8')
        : skill.systemPrompt || ''
      if (!body.trim()) continue
      const directory = join(skillsRoot, `plugin-${createHash('sha256').update(manifest.id).digest('hex').slice(0, 10)}-${skill.id.replace(/[^a-z0-9._-]+/gi, '-')}`)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const description = JSON.stringify(skill.description.replace(/[\r\n]+/g, ' ').slice(0, 300))
      const content = `---\nname: ${skill.id}\ndescription: ${description}\n---\n${body.trim()}\n`
      await writeFile(join(directory, 'SKILL.md'), content, { mode: 0o600 })
    }
  }

  private async removeProjectedSkills(pluginId: string): Promise<void> {
    const skillsRoot = join(this.workspacePath, '.turboflux', 'skills')
    const prefix = `plugin-${createHash('sha256').update(pluginId).digest('hex').slice(0, 10)}-`
    let entries: string[] = []
    try { entries = await readdir(skillsRoot) } catch { return }
    await Promise.all(entries.filter(entry => entry.startsWith(prefix)).map(entry => rm(join(skillsRoot, entry), { recursive: true, force: true })))
  }

  private async projectAgents(manifest: PluginManifest): Promise<void> {
    const agents = manifest.contributes?.agents || []
    if (agents.length === 0) return
    const agentsRoot = join(this.workspacePath, '.turboflux', 'agents')
    await mkdir(agentsRoot, { recursive: true, mode: 0o700 })
    const prefix = `plugin-${createHash('sha256').update(manifest.id).digest('hex').slice(0, 10)}-`
    for (const agent of agents) {
      const path = join(agentsRoot, `${prefix}${agent.id.replace(/[^a-z0-9._-]+/gi, '-')}.md`)
      const content = [
        '---',
        `name: ${agent.id}`,
        `description: ${JSON.stringify(agent.description.replace(/[\r\n]+/g, ' ').slice(0, 500))}`,
        `maxTurns: ${agent.maxTurns ?? 5}`,
        `maxParallel: ${agent.maxParallel ?? 4}`,
        `maxOutputTokens: ${agent.maxOutputTokens ?? 4096}`,
        ...(agent.requestTimeoutMs ? [`requestTimeoutMs: ${agent.requestTimeoutMs}`] : []),
        ...(agent.requiredToolCalls ? [`requiredToolCalls: ${JSON.stringify(agent.requiredToolCalls)}`] : []),
        `temperature: ${agent.temperature ?? 0}`,
        `thinking: ${agent.thinking || 'disabled'}`,
        ...(agent.tools?.length ? [`tools: ${JSON.stringify(agent.tools)}`] : []),
        '---',
        agent.systemPrompt!.trim(),
        '',
      ].join('\n')
      await writeFile(path, content, { mode: 0o600 })
    }
  }

  private async removeProjectedAgents(pluginId: string): Promise<void> {
    const agentsRoot = join(this.workspacePath, '.turboflux', 'agents')
    const prefix = `plugin-${createHash('sha256').update(pluginId).digest('hex').slice(0, 10)}-`
    let entries: string[] = []
    try { entries = await readdir(agentsRoot) } catch { return }
    await Promise.all(entries.filter(entry => entry.startsWith(prefix)).map(entry => rm(join(agentsRoot, entry), { force: true })))
  }

  private requireRecord(id: string): PluginStoreRecord {
    const record = this.data.plugins.find(plugin => plugin.id === id)
    if (!record) throw new Error(`Plugin not found: ${id}`)
    return record
  }

  private assertContributionIdsAvailable(manifest: PluginManifest): void {
    const incoming = contributionIds(manifest)
    for (const stored of this.data.plugins) {
      let installed: PluginManifest
      try {
        installed = validatePluginManifest(JSON.parse(readFileSync(join(stored.path, 'plugin.json'), 'utf8')) as unknown)
      } catch {
        continue
      }
      const existing = contributionIds(installed)
      for (const [kind, ids] of incoming) {
        for (const id of ids) {
          if (existing.get(kind)?.has(id)) throw new Error(`Plugin ${kind} id conflicts with ${installed.id}: ${id}`)
        }
      }
    }
  }

  private setError(id: string, error: unknown): void {
    const record = this.data.plugins.find(plugin => plugin.id === id)
    if (!record) return
    record.error = (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
    record.updatedAt = Date.now()
    this.persist()
    this.onChanged?.()
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
