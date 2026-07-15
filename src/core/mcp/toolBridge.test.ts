import { describe, expect, it, vi } from 'vitest'
import type { McpClient } from './client'
import type { McpToolInfo } from './types'
import { executeMcpTool, mcpToolToAgentTool, validateMcpToolArgs } from './toolBridge'

const nestedTool: McpToolInfo = {
  name: 'files__replace',
  serverName: 'files',
  description: 'Replace structured content',
  inputSchema: {
    type: 'object',
    properties: {
      edit: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    required: ['edit'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}

describe('MCP tool bridge', () => {
  it('preserves nested schemas and defaults unannotated tools to unsafe', () => {
    const mapped = mcpToolToAgentTool(nestedTool)
    const unknown = mcpToolToAgentTool({ ...nestedTool, name: 'files__unknown', annotations: undefined })

    expect(mapped.inputSchema).toEqual(nestedTool.inputSchema)
    expect(mapped.isReadOnly).toBe(false)
    expect(mapped.isDestructive).toBe(true)
    expect(unknown.isReadOnly).toBe(false)
    expect(unknown.isDestructive).toBe(true)
  })

  it('validates required and unexpected top-level arguments', () => {
    expect(validateMcpToolArgs(nestedTool.inputSchema, {})).toMatchObject({ valid: false })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: {}, surprise: true })).toMatchObject({ valid: false, error: 'Unexpected parameter: surprise' })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: {} })).toEqual({ valid: true })
  })

  it('dispatches namespaced tools to the selected MCP server', async () => {
    const callTool = vi.fn(async () => ({ content: 'done', isError: false }))
    const client = { callTool } as unknown as McpClient

    await expect(executeMcpTool(client, 'files__replace', { edit: { path: 'a.ts' } })).resolves.toEqual({ output: 'done', isError: false })
    expect(callTool).toHaveBeenCalledWith('files', 'replace', { edit: { path: 'a.ts' } })
  })
})
