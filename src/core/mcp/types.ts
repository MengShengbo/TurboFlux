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
