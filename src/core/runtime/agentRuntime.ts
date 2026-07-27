import type { AgentConfig, AgentMode, ApprovalPolicy } from '../../shared/agentTypes'
import { join } from 'node:path'
import { AgentEngine } from '../agentEngine'
import { McpClient } from '../mcp/client'
import { loadMcpSettings } from '../mcp/settings'
import { SkillRuntime } from '../skills/runtime'
import { syncAgentSkills } from '../subAgent'
import { NodeToolExecutor } from './nodeToolExecutor'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { SubAgentTaskManager } from './subAgentTaskManager'
import { DefaultAgentStateProvider, type AgentRuntimeConfig } from './stateProvider'
import { buildProfileSystemPromptSection, loadProfile, type TurboFluxProfile } from '../profile'

export interface CreateAgentRuntimeOptions {
  workspacePath: string
  workspaceName: string
  config: AgentRuntimeConfig
  conversationId?: string
  conversationPrefix?: string
  mode?: AgentMode
  approvalPolicy?: ApprovalPolicy
  shell?: string
  connectMcp?: boolean
  mcpServers?: string[]
  registerSkills?: (skillRuntime: SkillRuntime) => void
  profile?: TurboFluxProfile
}

export interface AgentRuntime {
  engine: AgentEngine
  stateProvider: DefaultAgentStateProvider
  toolExecutor: NodeToolExecutor
  runtimeTaskManager: RuntimeTaskManager
  subAgentTaskManager: SubAgentTaskManager
  skillRuntime: SkillRuntime
  mcpClient: McpClient
  applyConfiguration: (config: AgentRuntimeConfig, options?: {
    profile?: TurboFluxProfile
    approvalPolicy?: ApprovalPolicy
  }) => void
  disconnect: () => Promise<void>
  destroy: () => Promise<void>
}

function getDefaultShell(): string {
  return process.platform === 'win32' ? 'powershell' : 'bash'
}

function toEngineConfig(options: CreateAgentRuntimeOptions): AgentConfig {
  return {
    mode: options.mode || 'vibe',
    approvalPolicy: options.approvalPolicy || options.config.approvalPolicy || 'ask',
    gitEnabled: options.config.gitEnabled !== false,
    temperature: 0.7,
    workspacePath: options.workspacePath,
    workspaceName: options.workspaceName,
    profileSystemPrompt: buildProfileSystemPromptSection(options.profile ?? loadProfile()),
    conversationId: options.conversationId || `${options.conversationPrefix || 'agent'}-${Date.now()}`,
    contextWindow: options.config.contextWindow,
    contextPolicy: 'normal',
    maxTokens: options.config.maxTokens,
    shell: options.shell || getDefaultShell(),
  }
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const conversationId = options.conversationId || `${options.conversationPrefix || 'agent'}-${Date.now()}`
  const stateProvider = new DefaultAgentStateProvider(options.config, options.workspacePath, { conversationId })
  const runtimeTaskManager = new RuntimeTaskManager({
    defaultOwnerSessionId: conversationId,
    journalPath: join(options.workspacePath, '.turboflux', 'runtime', 'journal.jsonl'),
  })
  const subAgentTaskManager = new SubAgentTaskManager({
    workspacePath: options.workspacePath,
    runtimeTaskManager,
    ownerSessionId: conversationId,
  })
  const toolExecutor = new NodeToolExecutor(options.workspacePath, {
    runtimeTaskManager,
  })
  const engine = new AgentEngine(
    {
      ...toEngineConfig(options),
      conversationId,
    },
    toolExecutor,
    stateProvider,
    subAgentTaskManager,
  )
  const unsubscribeRuntimeTasks = runtimeTaskManager.subscribe(event => {
    if (event.type === 'runtime-task:finished') engine.publishRuntimeTaskFinished(event.task)
  })

  const skillRuntime = new SkillRuntime(options.workspacePath)
  options.registerSkills?.(skillRuntime)
  syncAgentSkills(skillRuntime)
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
    stateProvider.updateConfig(config)
    engine.updateRuntimeConfiguration({
      approvalPolicy: updateOptions.approvalPolicy ?? config.approvalPolicy,
      gitEnabled: config.gitEnabled !== false,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      profileSystemPrompt: buildProfileSystemPromptSection(updateOptions.profile ?? loadProfile()),
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
    applyConfiguration,
    disconnect,
    destroy: async () => {
      await disconnect()
      await runtimeTaskManager.stopAll('Agent runtime destroyed')
      await toolExecutor.ptyKillAll?.()
      unsubscribeRuntimeTasks()
      engine.destroy()
    },
  }
}
