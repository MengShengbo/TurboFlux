import {
  resolveCapabilityProfileForApproval,
  type AgentConfig,
  type AgentMode,
  type ApprovalPolicy,
  type CapabilityProfile,
} from '@turboflux/contracts/agentTypes'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AgentEngine } from '../agentEngine'
import { McpClient } from '@turboflux/extensions/mcp/client'
import { loadMcpSettings } from '@turboflux/extensions/mcp/settings'
import { SkillRuntime } from '@turboflux/extensions/skills/runtime'
import { syncAgentSkills } from '../subAgent'
import { NodeToolExecutor } from '@turboflux/tools/nodeToolExecutor'
import { RuntimeTaskManager } from '@turboflux/tools/runtimeTaskManager'
import { SubAgentTaskManager } from './subAgentTaskManager'
import { DefaultAgentStateProvider, type AgentRuntimeConfig } from './stateProvider'
import { buildProfileSystemPromptSection, loadProfile, type TurboFluxProfile } from '@turboflux/models/profile'
import { createSessionId, SessionRegistry } from './sessionRegistry'

export interface CreateAgentRuntimeOptions {
  workspacePath: string
  workspaceName: string
  config: AgentRuntimeConfig
  runtimeStoragePath?: string
  userSkillsRoot?: string
  memoryRoot?: string
  runtimeLogsRoot?: string
  conversationId?: string
  conversationPrefix?: string
  mode?: AgentMode
  approvalPolicy?: ApprovalPolicy
  capabilityProfile?: CapabilityProfile
  shell?: string
  connectMcp?: boolean
  mcpServers?: string[]
  registerSkills?: (skillRuntime: SkillRuntime) => void
  profile?: TurboFluxProfile
  surfaceSystemPrompt?: string
}

export interface AgentRuntime {
  engine: AgentEngine
  stateProvider: DefaultAgentStateProvider
  toolExecutor: NodeToolExecutor
  runtimeTaskManager: RuntimeTaskManager
  subAgentTaskManager: SubAgentTaskManager
  skillRuntime: SkillRuntime
  mcpClient: McpClient
  sessionRegistry: SessionRegistry
  applyConfiguration: (config: AgentRuntimeConfig, options?: {
    profile?: TurboFluxProfile
    approvalPolicy?: ApprovalPolicy
    capabilityProfile?: CapabilityProfile
  }) => void
  disconnect: () => Promise<void>
  destroy: () => Promise<void>
}

function getDefaultShell(): string {
  return process.platform === 'win32' ? 'powershell' : 'bash'
}

export function composeRuntimeProfileSystemPrompt(
  profile: TurboFluxProfile,
  surfaceSystemPrompt?: string,
): string {
  return [buildProfileSystemPromptSection(profile), surfaceSystemPrompt?.trim()]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
}

function toEngineConfig(options: CreateAgentRuntimeOptions, conversationId: string): AgentConfig {
  const approvalPolicy = options.approvalPolicy || options.config.approvalPolicy || 'ask'
  const capabilityProfile = resolveCapabilityProfileForApproval(
    approvalPolicy,
    options.capabilityProfile || options.config.capabilityProfile,
  )
  return {
    mode: options.mode || 'vibe',
    approvalPolicy,
    capabilityProfile,
    gitEnabled: options.config.gitEnabled !== false,
    temperature: 0.7,
    workspacePath: options.workspacePath,
    workspaceName: options.workspaceName,
    profileSystemPrompt: composeRuntimeProfileSystemPrompt(
      options.profile ?? loadProfile(),
      options.surfaceSystemPrompt,
    ),
    conversationId,
    contextWindow: options.config.contextWindow,
    contextPolicy: 'normal',
    maxTokens: options.config.maxTokens,
    shell: options.shell || getDefaultShell(),
  }
}

function conversationRuntimeStorage(rootPath: string, conversationId: string): {
  journalPath: string
  subAgentStorageDir: string
} {
  const sessionKey = createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
  const sessionRoot = join(rootPath, 'sessions', sessionKey)
  return {
    journalPath: join(sessionRoot, 'runtime', 'journal.jsonl'),
    subAgentStorageDir: join(sessionRoot, 'runtime-agents'),
  }
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  let destroyPromise: Promise<void> | null = null
  const conversationId = options.conversationId || createSessionId(options.conversationPrefix || 'agent')
  const runtimeStorageRoot = options.runtimeStoragePath || join(options.workspacePath, '.turboflux')
  const initialStorage = conversationRuntimeStorage(runtimeStorageRoot, conversationId)
  const engineConfig = toEngineConfig(options, conversationId)
  const sessionRegistry = new SessionRegistry(conversationId)
  const stateProvider = new DefaultAgentStateProvider({
    ...options.config,
    approvalPolicy: engineConfig.approvalPolicy,
    capabilityProfile: engineConfig.capabilityProfile,
  }, options.workspacePath, { conversationId })
  const runtimeTaskManager = new RuntimeTaskManager({
    defaultOwnerSessionId: conversationId,
    journalPath: initialStorage.journalPath,
  })
  const subAgentTaskManager = new SubAgentTaskManager({
    workspacePath: options.workspacePath,
    runtimeTaskManager,
    ownerSessionId: conversationId,
    storageDir: initialStorage.subAgentStorageDir,
  })
  const toolExecutor = new NodeToolExecutor(options.workspacePath, {
    runtimeTaskManager,
    capabilityProfile: engineConfig.capabilityProfile,
    memoryRoot: options.memoryRoot,
    runtimeLogsRoot: options.runtimeLogsRoot,
  })
  const engine = new AgentEngine(
    {
      ...engineConfig,
      conversationId,
    },
    toolExecutor,
    stateProvider,
    subAgentTaskManager,
  )
  const unsubscribeRuntimeTasks = runtimeTaskManager.subscribe(event => {
    engine.publishRuntimeTaskEvent(event)
  })
  const removeSessionGuard = sessionRegistry.addGuard(() => {
    if (destroyPromise) throw new Error('Agent runtime is shutting down')
    if (engine.isRunning()) throw new Error('Cannot switch conversations while the agent is running')
    if (runtimeTaskManager.hasActiveTasks()) {
      throw new Error('Cannot switch conversations while runtime tasks are active')
    }
  })
  const unsubscribeSessionIdentity = sessionRegistry.subscribe(({ currentId }) => {
    const storage = conversationRuntimeStorage(runtimeStorageRoot, currentId)
    engine.setConversationId(currentId)
    stateProvider.setConversationId(currentId)
    runtimeTaskManager.switchSession(currentId, storage.journalPath)
    subAgentTaskManager.switchSession(currentId, storage.subAgentStorageDir)
  })

  const skillRuntime = new SkillRuntime(options.workspacePath, options.userSkillsRoot)
  options.registerSkills?.(skillRuntime)
  syncAgentSkills(skillRuntime, engine.getAgentDefinitions())
  engine.setEnabledSkills(
    skillRuntime.getAll().map(skill => ({
      id: skill.id,
      name: skill.name,
      command: skill.command,
      description: skill.description,
      systemPrompt: skill.systemPrompt,
      capabilities: (skill as any).capabilities,
      principles: (skill as any).principles,
    })),
  )

  const mcpClient = new McpClient()
  engine.setMcpClient(mcpClient)

  if (options.connectMcp === true) {
    const mcpSettings = loadMcpSettings(options.workspacePath)
    const selected = new Set(options.mcpServers || ['all'])
    const servers = Object.entries(mcpSettings.mcpServers).filter(([name, config]) =>
      config.enabled && (selected.has('all') || selected.has(name))
    )
    for (const [name, config] of servers) {
      mcpClient.connect(name, config).catch(() => {})
    }
  }

  const disconnect = async () => {
    await mcpClient.disconnectAll()
  }

  const applyConfiguration: AgentRuntime['applyConfiguration'] = (config, updateOptions = {}) => {
    if (destroyPromise) throw new Error('Agent runtime is shutting down')
    const approvalPolicy = updateOptions.approvalPolicy ?? config.approvalPolicy ?? 'ask'
    const capabilityProfile = resolveCapabilityProfileForApproval(
      approvalPolicy,
      updateOptions.capabilityProfile ?? config.capabilityProfile,
    )
    stateProvider.updateConfig({ ...config, approvalPolicy, capabilityProfile })
    toolExecutor.setCapabilityProfile(capabilityProfile)
    engine.updateRuntimeConfiguration({
      approvalPolicy,
      capabilityProfile,
      gitEnabled: config.gitEnabled !== false,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      profileSystemPrompt: composeRuntimeProfileSystemPrompt(
        updateOptions.profile ?? loadProfile(),
        options.surfaceSystemPrompt,
      ),
    })
  }

  return {
    engine,
    stateProvider,
    toolExecutor,
    runtimeTaskManager,
    subAgentTaskManager,
    skillRuntime,
    mcpClient,
    sessionRegistry,
    applyConfiguration,
    disconnect,
    destroy: () => {
      if (destroyPromise) return destroyPromise
      const engineShutdown = engine.shutdown()
      destroyPromise = Promise.resolve().then(async () => {
        // Independent resources must all be released, even if one cleanup fails.
        const results = await Promise.allSettled([
          engineShutdown,
          Promise.resolve().then(disconnect),
          Promise.resolve().then(async () => {
            const errors = await runtimeTaskManager.stopAll('Agent runtime destroyed')
            if (errors.length) {
              throw new AggregateError(errors.map(({ taskId, error }) => new Error(`${taskId}: ${error}`)), 'Runtime task shutdown failed')
            }
          }),
          Promise.resolve().then(async () => {
            const result = await toolExecutor.ptyKillAll()
            if (!result.success) throw new Error(result.error || 'Terminal shutdown failed')
          }),
        ])
        unsubscribeSessionIdentity()
        removeSessionGuard()
        unsubscribeRuntimeTasks()
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Agent runtime shutdown failed')
      })
      return destroyPromise
    },
  }
}
