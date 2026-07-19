import type { AgentConfig, AgentMode, ApprovalPolicy, SandboxPolicy } from '../../shared/agentTypes'
import { AgentEngine } from '../agentEngine'
import { McpClient } from '../mcp/client'
import { loadMcpSettings } from '../mcp/settings'
import { SkillRuntime } from '../skills/runtime'
import { syncAgentSkills } from '../subAgent'
import { NodeToolExecutor } from './nodeToolExecutor'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { SubAgentTaskManager } from './subAgentTaskManager'
import { DefaultAgentStateProvider, type AgentRuntimeConfig } from './stateProvider'
import { buildProfileSystemPromptSection, loadProfile } from '../profile'

export interface CreateAgentRuntimeOptions {
  workspacePath: string
  workspaceName: string
  config: AgentRuntimeConfig
  conversationId?: string
  conversationPrefix?: string
  mode?: AgentMode
  approvalPolicy?: ApprovalPolicy
  sandboxPolicy?: SandboxPolicy
  shell?: string
  connectMcp?: boolean
  mcpServers?: string[]
  registerSkills?: (skillRuntime: SkillRuntime) => void
}

export interface AgentRuntime {
  engine: AgentEngine
  stateProvider: DefaultAgentStateProvider
  toolExecutor: NodeToolExecutor
  runtimeTaskManager: RuntimeTaskManager
  subAgentTaskManager: SubAgentTaskManager
  skillRuntime: SkillRuntime
  mcpClient: McpClient
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
    sandboxPolicy: options.sandboxPolicy || ((options.approvalPolicy || options.config.approvalPolicy) === 'full' ? 'full' : 'workspace'),
    temperature: 0.7,
    maxTurns: 25,
    workspacePath: options.workspacePath,
    workspaceName: options.workspaceName,
    profileSystemPrompt: buildProfileSystemPromptSection(loadProfile()),
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
  const effectiveApprovalPolicy = options.approvalPolicy || options.config.approvalPolicy || 'ask'
  const runtimeTaskManager = new RuntimeTaskManager({ defaultOwnerSessionId: conversationId })
  const subAgentTaskManager = new SubAgentTaskManager({
    workspacePath: options.workspacePath,
    runtimeTaskManager,
    ownerSessionId: conversationId,
  })
  const toolExecutor = new NodeToolExecutor(options.workspacePath, {
    sandboxPolicy: options.sandboxPolicy || (effectiveApprovalPolicy === 'full' ? 'full' : 'workspace'),
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

  return {
    engine,
    stateProvider,
    toolExecutor,
    runtimeTaskManager,
    subAgentTaskManager,
    skillRuntime,
    mcpClient,
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
