import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpToolInfo } from './types'

const INHERITED_ENV_ALLOWLIST = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
])

export function buildMcpEnvironment(
  config: McpServerConfig,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (typeof value === 'string' && INHERITED_ENV_ALLOWLIST.has(name.toUpperCase())) {
      environment[name] = value
    }
  }
  return { ...environment, ...(config.env || {}) }
}

export interface McpConnection {
  name: string
  client: Client
  transport?: Transport
  tools: McpToolInfo[]
  status: 'connecting' | 'connected' | 'error' | 'closed'
  error?: string
  instructions?: string
  toolTimeoutMs: number
}

export class McpClient {
  private connections: Map<string, McpConnection> = new Map()

  private buildEnvironment(config: McpServerConfig): Record<string, string> {
    return buildMcpEnvironment(config)
  }

  async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    if (!config.command && !config.url) {
      throw new Error(`MCP server "${name}" has no command or URL configured`)
    }
    if (this.connections.has(name)) await this.disconnect(name)

    const client = new Client(
      { name: 'turboflux', version: '1.0.0' },
      { capabilities: {} },
    )
    const conn: McpConnection = {
      name,
      client,
      tools: [],
      status: 'connecting',
      toolTimeoutMs: normalizeTimeout(config.toolTimeoutMs, 60_000),
    }
    this.connections.set(name, conn)

    try {
      const environment = this.buildEnvironment(config)
      const transport: Transport = config.url
        ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.httpHeaders ? { headers: config.httpHeaders } : undefined,
        })
        : new StdioClientTransport({
          command: config.command!,
          args: config.args || [],
          env: environment,
          cwd: config.cwd,
          stderr: 'pipe',
        })
      conn.transport = transport
      if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
      await withTimeout(client.connect(transport), normalizeTimeout(config.startupTimeoutMs, 10_000), `MCP server "${name}" startup timed out`)
      conn.status = 'connected'
      conn.instructions = client.getInstructions()
      conn.tools = await this.discoverTools(name, client, config, conn.instructions)
    } catch (err: any) {
      try {
        await conn.transport?.close()
      } catch {}
      conn.status = 'error'
      conn.error = err.message
    }

    return conn
  }

  private async discoverTools(serverName: string, client: Client, config: McpServerConfig, instructions?: string): Promise<McpToolInfo[]> {
    try {
      const result = await client.listTools()
      const enabled = config.enabledTools?.length ? new Set(config.enabledTools) : null
      const disabled = new Set(config.disabledTools || [])
      return (result.tools || [])
        .filter(tool => (!enabled || enabled.has(tool.name)) && !disabled.has(tool.name))
        .map(tool => ({
          name: `${serverName}__${tool.name}`,
          description: tool.description || '',
          inputSchema: (tool.inputSchema as Record<string, unknown>) || {},
          serverName,
          instructions,
          annotations: tool.annotations,
        }))
    } catch {
      return []
    }
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ content: string; isError: boolean }> {
    const conn = this.connections.get(serverName)
    if (!conn || conn.status !== 'connected') {
      return { content: `MCP server "${serverName}" is not connected`, isError: true }
    }

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: conn.toolTimeoutMs, signal: options?.signal })
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

  searchTools(query: string, limit = 8): McpToolInfo[] {
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
    const cap = Math.max(1, Math.min(20, Math.floor(limit)))
    return this.getAllTools()
      .map((tool, index) => {
        const haystack = `${tool.name} ${tool.description} ${tool.instructions || ''}`.toLowerCase()
        const score = terms.length === 0
          ? 0
          : terms.reduce((total, term) => total + (haystack.includes(term) ? (tool.name.toLowerCase().includes(term) ? 3 : 1) : 0), 0)
        return { tool, score, index }
      })
      .filter(entry => terms.length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, cap)
      .map(entry => entry.tool)
  }
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(250, Math.min(10 * 60_000, Math.floor(value!)))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
