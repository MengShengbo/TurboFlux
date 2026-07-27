import type { AgentConfig, AgentMode, ApprovalPolicy, SandboxPolicy } from '../../shared/agentTypes'
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
import { buildProfileSystemPromptSection, loadProfile } from '../profile'
import type { SandboxOptions } from '../sandbox/types'

export interface CreateAgentRuntimeOptions {
  workspacePath: string
  workspaceName: string
  config: AgentRuntimeConfig
  conversationId?: string
  conversationPrefix?: string
  mode?: AgentMode
  approvalPolicy?: ApprovalPolicy
  sandboxPolicy?: SandboxPolicy
  sandbox?: SandboxOptions
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
  const sandbox = getSandboxOptions(options)
  return {
    mode: options.mode || 'vibe',
    approvalPolicy: options.approvalPolicy || options.config.approvalPolicy || 'ask',
    sandboxPolicy: sandbox.policy,
    sandboxEnforcement: sandbox.enforcement,
    sandboxNetwork: sandbox.network,
    sandboxBackend: sandbox.backend,
    sandboxDockerImage: sandbox.dockerImage,
    temperature: 0.7,
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

function getSandboxOptions(options: CreateAgentRuntimeOptions): SandboxOptions {
  return {
    policy: options.sandbox?.policy || options.sandboxPolicy || options.config.sandboxPolicy || 'workspace',
    enforcement: options.sandbox?.enforcement || options.config.sandboxEnforcement || 'guarded',
    network: options.sandbox?.network || options.config.sandboxNetwork || 'allow',
    backend: options.sandbox?.backend || options.config.sandboxBackend || 'auto',
    dockerImage: options.sandbox?.dockerImage || options.config.sandboxDockerImage,
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
    sandbox: getSandboxOptions(options),
    runtimeTaskManager,
  })
  const engine = new AgentEngine(
    {
      ...toEngineConfig(options),
      conversationId,
      appendSystemPrompt: buildSandboxSystemPrompt(toolExecutor.getSandboxStatus()),
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

  const mcpClient = new McpClient(toolExecutor.getProcessSandbox(), options.workspacePath)
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

function buildSandboxSystemPrompt(status: ReturnType<NodeToolExecutor['getSandboxStatus']>): string {
  const boundary = status.osIsolation ? 'OS-isolated' : 'policy-guarded only'
  const availability = status.available ? 'available' : `unavailable: ${status.reason || 'backend unavailable'}`
  return [
    '<sandbox>',
    `Policy: ${status.policy}; enforcement: ${status.enforcement}; backend: ${status.resolvedBackend} (${boundary}); network: ${status.network}; execution: ${availability}.`,
    'Treat sandbox denials as hard boundaries. Do not retry equivalent path, environment, or network escapes.',
    '</sandbox>',
  ].join('\n')
}
