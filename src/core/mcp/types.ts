export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  inheritEnv?: string[]
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
}
