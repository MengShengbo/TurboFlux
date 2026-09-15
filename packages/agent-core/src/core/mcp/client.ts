import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { AgentAttachment } from '../../shared/agentTypes'
import type { McpLocalServerDefinition, McpLocalToolResult, McpServerConfig, McpToolCallOptions, McpToolInfo } from './types'

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
  client?: Client
  transport?: Transport
  tools: McpToolInfo[]
  status: 'connecting' | 'connected' | 'error' | 'closed'
  error?: string
  instructions?: string
  toolTimeoutMs: number
  system?: boolean
  requiresSelection?: boolean
  enabledForRun?: boolean
  localHandler?: McpLocalServerDefinition['handler']
}

export class McpClient {
  private connections: Map<string, McpConnection> = new Map()

  private buildEnvironment(config: McpServerConfig): Record<string, string> {
    return buildMcpEnvironment(config)
  }

  registerLocalServer(definition: McpLocalServerDefinition): McpConnection {
    const name = definition.name.trim()
    if (!name || !/^[\w.-]+$/.test(name)) throw new Error(`Invalid local MCP server name: ${definition.name}`)
    const existing = this.connections.get(name)
    const preserveRunSelection = definition.requiresSelection === true
      && isSystemConnection(existing)
      && existing.requiresSelection === true
    if (existing?.transport) void existing.transport.close().catch(() => {})
    if (existing) existing.status = 'closed'
    const connection: McpConnection = {
      name,
      tools: definition.tools.map(tool => ({
        name: `${name}__${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        serverName: name,
        instructions: definition.instructions,
        annotations: tool.annotations,
      })),
      status: 'connected',
      instructions: definition.instructions,
      toolTimeoutMs: 60_000,
      system: true,
      requiresSelection: definition.requiresSelection === true,
      enabledForRun: preserveRunSelection
        ? existing.enabledForRun === true
        : definition.requiresSelection !== true,
      localHandler: definition.handler,
    }
    this.connections.set(name, connection)
    return connection
  }

  setLocalServerEnabledForRun(name: string, enabled: boolean): void {
    const connection = this.connections.get(name)
    if (!connection?.localHandler) return
    connection.enabledForRun = enabled
  }

  clearLocalServerRunSelections(): void {
    for (const connection of this.connections.values()) {
      if (connection.localHandler && connection.requiresSelection) connection.enabledForRun = false
    }
  }

  async connect(name: string, config: McpServerConfig): Promise<McpConnection> {
    const existing = this.connections.get(name)
    if (isSystemConnection(existing)) return existing
    if (!config.command && !config.url) {
      throw new Error(`MCP server "${name}" has no command or URL configured`)
    }
    if (existing) await this.disconnect(name)

    const client = new Client(
      { name: 'turboflux', version: '1.0.1' },
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

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>, options?: McpToolCallOptions): Promise<{ content: string; isError: boolean; attachments?: AgentAttachment[] }> {
    const conn = this.connections.get(serverName)
    if (!conn || conn.status !== 'connected') {
      return { content: `MCP server "${serverName}" is not connected`, isError: true }
    }

    if (conn.localHandler) {
      if (conn.requiresSelection && !conn.enabledForRun) {
        return { content: `System plugin "${serverName}" is not selected for this run`, isError: true }
      }
      try {
        const result = await conn.localHandler(toolName, args, options)
        if (isLocalToolResult(result)) {
          return {
            content: result.content,
            isError: false,
            attachments: result.attachments?.map(attachment => ({ ...attachment })),
          }
        }
        return {
          content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          isError: false,
        }
      } catch (error) {
        return { content: `System plugin error: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    }

    try {
      const result = await conn.client!.callTool({ name: toolName, arguments: args }, undefined, { timeout: conn.toolTimeoutMs, signal: options?.signal })
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

  async disconnectAll(options: { preserveSystem?: boolean } = {}): Promise<void> {
    for (const [name, connection] of [...this.connections.entries()]) {
      if (options.preserveSystem && connection.system) continue
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
      if (conn.status === 'connected' && (!conn.requiresSelection || conn.enabledForRun)) {
        tools.push(...conn.tools)
      }
    }
    return tools
  }

  searchTools(query: string, limit = 8): McpToolInfo[] {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    const tokenize = (text: string) => [...segmenter.segment(text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').normalize('NFKC').toLowerCase())]
      .filter(segment => segment.isWordLike).map(segment => segment.segment)
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []
    const cap = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 8
    const documents = this.getAllTools().map(tool => ({
      tool,
      name: new Set(tokenize(`${tool.serverName} ${tool.name}`)),
      body: new Set(tokenize(`${tool.description} ${tool.instructions || ''} ${JSON.stringify(tool.inputSchema || {})}`)),
    }))
    const weights = new Map(terms.map(term => {
      const frequency = documents.filter(document => document.name.has(term) || document.body.has(term)).length
      return [term, Math.log(1 + (documents.length + 0.5) / (frequency + 0.5))]
    }))
    return documents
      .map((tool, index) => {
        const score = terms.reduce((total, term) => total + (tool.name.has(term) ? 3 : tool.body.has(term) ? 1 : 0) * weights.get(term)!, 0)
        return { tool: tool.tool, score, index }
      })
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, cap)
      .map(entry => entry.tool)
  }
}

function isLocalToolResult(value: unknown): value is McpLocalToolResult {
  return Boolean(value)
    && typeof value === 'object'
    && (value as McpLocalToolResult).kind === 'local_tool_result'
    && typeof (value as McpLocalToolResult).content === 'string'
}

function isSystemConnection(connection: McpConnection | undefined): connection is McpConnection {
  return connection?.system === true || typeof connection?.localHandler === 'function'
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
