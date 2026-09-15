import type { AgentAttachment } from '../../shared/agentTypes'

export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  cwd?: string
  httpHeaders?: Record<string, string>
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  enabledTools?: string[]
  disabledTools?: string[]
  enabled: boolean
}

export interface McpSettings {
  mcpServers: Record<string, McpServerConfig>
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
  instructions?: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface McpLocalToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolInfo['annotations']
}

export interface McpLocalToolResult {
  kind: 'local_tool_result'
  content: string
  attachments?: AgentAttachment[]
}

export interface McpToolExecutionContext {
  conversationId?: string
  runId?: string
  toolCallId: string
  itemId: string
}

export interface McpToolCallOptions {
  signal?: AbortSignal
  execution?: McpToolExecutionContext
}

export interface McpLocalServerDefinition {
  name: string
  instructions?: string
  tools: McpLocalToolDefinition[]
  requiresSelection?: boolean
  handler(toolName: string, args: Record<string, unknown>, options?: McpToolCallOptions): Promise<unknown>
}
