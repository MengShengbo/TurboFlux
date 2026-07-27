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

  it('validates nested required fields, types, and unexpected arguments', () => {
    expect(validateMcpToolArgs(nestedTool.inputSchema, {})).toMatchObject({ valid: false })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: {}, surprise: true })).toMatchObject({ valid: false, error: 'Unexpected parameter: surprise' })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: {} })).toMatchObject({ valid: false, error: 'Missing required parameter: edit.path' })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: { path: 42, content: 'next' } })).toMatchObject({ valid: false, error: 'Invalid type for edit.path: expected string' })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: { path: 'a.ts', content: 'next', extra: true } })).toMatchObject({ valid: false, error: 'Unexpected parameter: edit.extra' })
    expect(validateMcpToolArgs(nestedTool.inputSchema, { edit: { path: 'a.ts', content: 'next' } })).toEqual({ valid: true })
  })

  it('enforces common string, number, and array constraints', () => {
    const schema = {
      type: 'object',
      properties: {
        names: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 2, maxLength: 4 } },
        count: { type: 'integer', minimum: 1, maximum: 3 },
      },
      required: ['names', 'count'],
      additionalProperties: false,
    }

    expect(validateMcpToolArgs(schema, { names: [], count: 1 })).toMatchObject({ valid: false })
    expect(validateMcpToolArgs(schema, { names: ['a'], count: 1 })).toMatchObject({ valid: false })
    expect(validateMcpToolArgs(schema, { names: ['alpha'], count: 1 })).toMatchObject({ valid: false })
    expect(validateMcpToolArgs(schema, { names: ['ok'], count: 4 })).toMatchObject({ valid: false })
    expect(validateMcpToolArgs(schema, { names: ['ok', 'go'], count: 2 })).toEqual({ valid: true })
  })

  it('dispatches namespaced tools to the selected MCP server', async () => {
    const callTool = vi.fn(async () => ({ content: 'done', isError: false }))
    const client = { callTool } as unknown as McpClient

    await expect(executeMcpTool(client, 'files__replace', { edit: { path: 'a.ts' } })).resolves.toEqual({ output: 'done', isError: false })
    expect(callTool).toHaveBeenCalledWith('files', 'replace', { edit: { path: 'a.ts' } })
  })
})
