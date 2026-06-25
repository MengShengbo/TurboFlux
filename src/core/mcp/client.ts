import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpToolInfo } from './types'

export interface McpConnection {
  name: string
  client: Client
  transport: StdioClientTransport
  tools: McpToolInfo[]
  status: 'connecting' | 'connected' | 'error' | 'closed'
  error?: string
}

export class McpClient {
  private connections: Map<string, McpConnection> = new Map()

  async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    if (!config.command) {
      throw new Error(`MCP server "${name}" has no command configured`)
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    })

    const client = new Client(
      { name: 'turboflux', version: '0.1.5' },
      { capabilities: {} },
    )

    const conn: McpConnection = {
      name,
      client,
      transport,
      tools: [],
      status: 'connecting',
    }
    this.connections.set(name, conn)

    try {
      await client.connect(transport)
      conn.status = 'connected'
      conn.tools = await this.discoverTools(name, client)
    } catch (err: any) {
      conn.status = 'error'
      conn.error = err.message
    }

    return conn
  }

  private async discoverTools(serverName: string, client: Client): Promise<McpToolInfo[]> {
    try {
      const result = await client.listTools()
      return (result.tools || []).map(tool => ({
        name: `${serverName}__${tool.name}`,
        description: tool.description || '',
        inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
        serverName,
      }))
    } catch {
      return []
    }
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const conn = this.connections.get(serverName)
    if (!conn || conn.status !== 'connected') {
      return { content: `MCP server "${serverName}" is not connected`, isError: true }
    }

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args })
      const text = (result.content as any[])
        ?.map((c: any) => c.type === 'text' ? c.text : JSON.stringify(c))
        .join('\n') || ''
      return { content: text, isError: !!result.isError }
    } catch (err: any) {
      return { content: `MCP tool error: ${err.message}`, isError: true }
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return
    try {
      await conn.transport.close()
    } catch {}
    conn.status = 'closed'
    this.connections.delete(name)
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.connections.keys()) {
      await this.disconnect(name)
    }
  }

  getConnection(name: string): McpConnection | undefined {
    return this.connections.get(name)
  }

  getAllConnections(): McpConnection[] {
    return [...this.connections.values()]
  }

  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = []
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') {
        tools.push(...conn.tools)
      }
    }
    return tools
  }
}
