import type { AgentTool, ToolParameter } from '../../shared/agentTypes'
import type { McpClient } from './client'
import type { McpToolInfo } from './types'

export function mcpToolToAgentTool(tool: McpToolInfo): AgentTool {
  const params = extractParameters(tool.inputSchema)
  const isReadOnly = tool.annotations?.readOnlyHint === true
  const isDestructive = isReadOnly ? false : tool.annotations?.destructiveHint !== false
  return {
    name: tool.name,
    description: `[MCP:${tool.serverName}] ${tool.description}`,
    category: isReadOnly ? 'read' : 'execute',
    parameters: params,
    isReadOnly,
    isDestructive,
    isConcurrencySafe: isReadOnly && tool.annotations?.openWorldHint !== true,
    inputSchema: tool.inputSchema,
  }
}

export function validateMcpToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): { valid: boolean; error?: string } {
  return validateSchemaValue(schema, args, '')
}

function validateSchemaValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): { valid: boolean; error?: string } {
  const location = path || 'arguments'
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null
  if (alternatives) {
    const accepted = alternatives.some(candidate =>
      candidate && typeof candidate === 'object'
      && validateSchemaValue(candidate as Record<string, unknown>, value, path).valid
    )
    return accepted
      ? { valid: true }
      : { valid: false, error: `Invalid value for ${location}: no schema alternative matched` }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
    return { valid: false, error: `Invalid value for ${location}: expected one of ${schema.enum.map(String).join(', ')}` }
  }

  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (declaredTypes.length > 0 && !declaredTypes.some(type => schemaTypeMatches(String(type), value))) {
    return { valid: false, error: `Invalid type for ${location}: expected ${declaredTypes.join(' or ')}` }
  }

  const isObjectSchema = declaredTypes.includes('object') || (!schema.type && schema.properties && typeof schema.properties === 'object')
  if (isObjectSchema && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, unknown>
      : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
    for (const name of required) {
      if (record[name] === undefined || record[name] === null) {
        return { valid: false, error: `Missing required parameter: ${path ? `${path}.` : ''}${name}` }
      }
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(record).find(name => !(name in properties))
      if (unexpected) return { valid: false, error: `Unexpected parameter: ${path ? `${path}.` : ''}${unexpected}` }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (record[name] === undefined || !propertySchema || typeof propertySchema !== 'object') continue
      const result = validateSchemaValue(propertySchema as Record<string, unknown>, record[name], path ? `${path}.${name}` : name)
      if (!result.valid) return result
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    for (let index = 0; index < value.length; index += 1) {
      const result = validateSchemaValue(schema.items as Record<string, unknown>, value[index], `${location}[${index}]`)
      if (!result.valid) return result
    }
  }

  return { valid: true }
}

function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null': return value === null
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    default: return true
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
