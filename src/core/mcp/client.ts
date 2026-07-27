import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpToolInfo } from './types'
import type { ProcessSandbox } from '../sandbox/processSandbox'
import type { SandboxSpawnPlan } from '../sandbox/types'

export interface McpConnection {
  name: string
  client: Client
  transport?: StdioClientTransport
  tools: McpToolInfo[]
  status: 'connecting' | 'connected' | 'error' | 'closed'
  error?: string
}

export class McpClient {
  private connections: Map<string, McpConnection> = new Map()
  private spawnPlans: Map<string, SandboxSpawnPlan> = new Map()

  constructor(
    private readonly processSandbox?: ProcessSandbox,
    private readonly workspacePath: string = process.cwd(),
  ) {}

  private buildEnvironment(config: McpServerConfig): Record<string, string> {
    const defaultNames = process.platform === 'win32'
      ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
      : ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']
    const environment: Record<string, string> = {}
    for (const name of new Set([...defaultNames, ...(config.inheritEnv || [])])) {
      const value = process.env[name]
      if (typeof value === 'string') environment[name] = value
    }
    return { ...environment, ...(config.env || {}) }
  }

  async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    if (!config.command) {
      throw new Error(`MCP server "${name}" has no command configured`)
    }
    if (this.connections.has(name)) await this.disconnect(name)

    const client = new Client(
      { name: 'turboflux', version: '0.1.5' },
      { capabilities: {} },
    )
    const conn: McpConnection = {
      name,
      client,
      tools: [],
      status: 'connecting',
    }
    this.connections.set(name, conn)

    try {
      const environment = this.buildEnvironment(config)
      const plan = this.processSandbox?.prepare({
        command: config.command,
        args: config.args || [],
        cwd: this.workspacePath,
        env: environment,
        trustedEnvironment: true,
      })
      const transport = new StdioClientTransport(plan ? {
        command: plan.command,
        args: plan.args,
        env: plan.env as Record<string, string>,
        cwd: plan.cwd,
        stderr: 'pipe',
      } : {
        command: config.command,
        args: config.args || [],
        env: environment,
        cwd: this.workspacePath,
        stderr: 'pipe',
      })
      conn.transport = transport
      if (plan) this.spawnPlans.set(name, plan)
      transport.stderr?.on('data', () => {})
      await client.connect(transport)
      conn.status = 'connected'
      conn.tools = await this.discoverTools(name, client)
    } catch (err: any) {
      try {
        await conn.transport?.close()
      } catch {}
      this.cleanupConnection(name, true)
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
        annotations: tool.annotations,
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
      await conn.transport?.close()
    } catch {}
    this.cleanupConnection(name, true)
    conn.status = 'closed'
    this.connections.delete(name)
  }

  private cleanupConnection(name: string, force: boolean): void {
    const plan = this.spawnPlans.get(name)
    this.spawnPlans.delete(name)
    this.processSandbox?.cleanupProcess(plan, force)
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
