import { isDeepStrictEqual } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { ListToolsResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'

const MAX_TOOL_PAGES = 100
const MAX_DISCOVERED_TOOLS = 10_000

export class PaginatedMcpSdkClient extends Client {
  override async request<T extends AnySchema>(
    request: Parameters<Client['request']>[0],
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    if (request.method !== 'tools/list' || !Object.is(resultSchema, ListToolsResultSchema)) {
      return super.request(request, resultSchema, options)
    }

    // Aggregate beneath listTools so the SDK caches validators and task metadata for every page at once.
    const tools = new Map<string, Tool>()
    const cursors = new Set<string>()
    let params = request.params
    if (typeof params?.cursor === 'string') cursors.add(params.cursor)
    let toolCount = 0
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await super.request({ ...request, params }, ListToolsResultSchema, options)
      toolCount += result.tools.length
      if (toolCount > MAX_DISCOVERED_TOOLS) throw new Error(`MCP tool discovery exceeded ${MAX_DISCOVERED_TOOLS} tools`)
      for (const tool of result.tools) {
        const previous = tools.get(tool.name)
        if (previous && !isDeepStrictEqual(previous, tool)) throw new Error(`Conflicting MCP tool definition: ${tool.name}`)
        if (!previous) tools.set(tool.name, tool)
      }
      if (result.nextCursor === undefined) {
        // The schema identity check above restricts this branch to ListToolsResult.
        return { ...result, tools: [...tools.values()] } as SchemaOutput<T>
      }
      if (cursors.has(result.nextCursor)) throw new Error('MCP tool discovery returned a repeated cursor')
      cursors.add(result.nextCursor)
      params = { ...request.params, cursor: result.nextCursor }
    }
    throw new Error(`MCP tool discovery exceeded ${MAX_TOOL_PAGES} pages`)
  }
}
