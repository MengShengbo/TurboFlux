import type { AgentTool, ToolParameter } from '../../shared/agentTypes'
import type { McpClient } from './client'
import type { McpToolInfo } from './types'

export function mcpToolToAgentTool(tool: McpToolInfo): AgentTool {
  const params = extractParameters(tool.inputSchema)
  return {
    name: tool.name,
    description: `[MCP:${tool.serverName}] ${tool.description}`,
    category: 'read',
    parameters: params,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
  }
}

function extractParameters(schema: Record<string, unknown>): ToolParameter[] {
  const properties = (schema.properties || {}) as Record<string, any>
  const required = (schema.required || []) as string[]
  const params: ToolParameter[] = []

  for (const [name, prop] of Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))) {
    params.push({
      name,
      type: mapJsonSchemaType(prop.type),
      description: prop.description || '',
      required: required.includes(name),
      enum: prop.enum,
      default: prop.default,
    })
  }

  return params
}

function mapJsonSchemaType(type: string | undefined): ToolParameter['type'] {
  switch (type) {
    case 'string': return 'string'
    case 'number':
    case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'array'
    case 'object': return 'object'
    default: return 'string'
  }
}

export function getMcpAgentTools(mcpClient: McpClient): AgentTool[] {
  return mcpClient
    .getAllTools()
    .map(mcpToolToAgentTool)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function isMcpTool(toolName: string): boolean {
  return toolName.includes('__')
}

export function parseMcpToolName(toolName: string): { serverName: string; originalName: string } | null {
  const idx = toolName.indexOf('__')
  if (idx === -1) return null
  return {
    serverName: toolName.slice(0, idx),
    originalName: toolName.slice(idx + 2),
  }
}

export async function executeMcpTool(
  mcpClient: McpClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ output: string; isError: boolean }> {
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return { output: `Invalid MCP tool name: ${toolName}`, isError: true }
  const result = await mcpClient.callTool(parsed.serverName, parsed.originalName, args)
  return { output: result.content, isError: result.isError }
}
