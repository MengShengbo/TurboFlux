import type React from 'react'
import type { AgentEngine } from '../../core/agentEngine'
import type { AgentTurn } from '../../shared/agentTypes'
import type { ModelPreset, TurboFluxConfig } from '../../core/config'
import type { ConversationManager } from '../conversations/manager'
import type { SkillRuntime } from '../../core/skills/runtime'
import type { McpClient } from '../../core/mcp/client'
import type { RuntimeTaskManager } from '../../core/runtime/runtimeTaskManager'
import type { MessageKey, Translator } from '../i18n/index'
import type { FlowFeatureFlags } from '../state/flowFeatureFlags'

export type CommandType = 'local' | 'local-jsx' | 'prompt'

export interface CommandContext {
  engine: AgentEngine
  config: TurboFluxConfig
  modelPresets: ModelPreset[]
  workspacePath: string
  setConfig: (config: TurboFluxConfig) => void
  setMessages: React.Dispatch<React.SetStateAction<any[]>>
  restoreConversation?: (turns: AgentTurn[], nextInput?: string) => void
  exit: () => void
  conversationManager?: ConversationManager
  skillRuntime?: SkillRuntime
  mcpClient?: McpClient
  runtimeTaskManager?: RuntimeTaskManager
  flowFeatures?: FlowFeatureFlags
  notificationInbox?: {
    snapshot: () => {
      inbox: Array<{ id: string; title: string; detail?: string; count: number; category: string }>
      resultCount: number
    }
    clearResults: () => number
  }
  t: Translator
}

export interface CommandMeta {
  name: string
  description?: string
  descriptionKey?: MessageKey
  aliases?: string[]
  argumentHint?: string
  isHidden?: boolean
}

export interface LocalCommand extends CommandMeta {
  type: 'local'
  execute: (args: string, ctx: CommandContext) => string | void
}

export interface LocalJSXCommand extends CommandMeta {
  type: 'local-jsx'
  execute: (args: string, ctx: CommandContext) => React.ReactNode
}

export interface PromptCommand extends CommandMeta {
  type: 'prompt'
  getPrompt: (args: string, ctx: CommandContext) => string
}

export type Command = LocalCommand | LocalJSXCommand | PromptCommand

export interface CommandResult {
  type: 'text' | 'jsx' | 'prompt' | 'none'
  text?: string
  jsx?: React.ReactNode
  prompt?: string
}
