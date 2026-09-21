import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type ListToolsResult, type ServerCapabilities, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { McpClient } from './client'

const mocks = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor() { return mocks.transport() }
  },
}))

const clients: McpClient[] = []
const servers: Server[] = []
const config = { enabled: true, url: 'https://mcp.test' }
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, inputSchema: { type: 'object' }, ...extra })

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(list: (cursor?: string) => ListToolsResult | Promise<ListToolsResult>, client = new McpClient(), capabilities: ServerCapabilities = { tools: {} }) {
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
  const closed = vi.fn()
  serverTransport.onclose = closed
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities, instructions: 'Server instructions' })
  const requests = vi.fn(list)
  const calls = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], structuredContent: { value: 'invalid' } }))
  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, request => requests(request.params?.cursor))
    server.setRequestHandler(CallToolRequestSchema, calls)
  }
  await server.connect(serverTransport)
  mocks.transport.mockReturnValueOnce(transport)
  clients.push(client)
  servers.push(server)
  return { client, requests, calls, closed }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnectAll()
  for (const server of servers.splice(0)) await server.close()
  mocks.transport.mockReset()
  vi.useRealTimers()
})

describe('MCP tool discovery', () => {
  it('accepts a server that does not advertise tools', async () => {
    const { client, requests } = await fixture(() => ({ tools: [] }), undefined, { resources: {} })
    expect(await client.connect('remote', config)).toMatchObject({ status: 'connected', tools: [] })
    expect(requests).not.toHaveBeenCalled()
  })

  it('follows opaque cursors through empty pages and filters the complete deduplicated list', async () => {
    const original = tool('first', { inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } })
    const duplicate = tool('first', { inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } })
    const pages: Record<string, ListToolsResult> = {
      start: { tools: [original, tool('disabled')], nextCursor: '' },
      '': { tools: [], nextCursor: 'next/+ opaque=' },
      'next/+ opaque=': { tools: [duplicate, tool('last'), tool('not-enabled')] },
    }
    const { client, requests } = await fixture(cursor => pages[cursor ?? 'start'])
    const connection = await client.connect('remote', { ...config, enabledTools: ['first', 'last', 'disabled'], disabledTools: ['disabled'] })
    expect(connection.status).toBe('connected')
    expect(requests.mock.calls).toEqual([[undefined], [''], ['next/+ opaque=']])
    expect(client.getAllTools().map(value => value.name)).toEqual(['remote__first', 'remote__last'])
    expect(client.getAllTools().every(value => value.instructions === 'Server instructions')).toBe(true)
  })

  it('keeps the connection unavailable until every page has arrived', async () => {
    const pending = deferred<ListToolsResult>()
    const arrived = deferred<void>()
    const { client } = await fixture(cursor => {
      if (cursor === undefined) return { tools: [tool('first')], nextCursor: 'later' }
      arrived.resolve()
      return pending.promise
    })
    const connecting = client.connect('remote', config)
    await arrived.promise
    expect(client.getConnection('remote')?.status).toBe('connecting')
    expect(client.getAllTools()).toEqual([])
    expect((await client.callTool('remote', 'first', {})).isError).toBe(true)
    pending.resolve({ tools: [tool('last')] })
    expect((await connecting).tools.map(value => value.name)).toEqual(['remote__first', 'remote__last'])
  })

  it('surfaces later-page failures, closes the transport and can reconnect', async () => {
    const { client, closed } = await fixture(cursor => {
      if (cursor === undefined) return { tools: [tool('partial')], nextCursor: 'fail' }
      throw new Error('page two failed')
    })
    expect(await client.connect('remote', config)).toMatchObject({ status: 'error', tools: [], error: expect.stringContaining('page two failed') })
    expect(closed).toHaveBeenCalled()
    expect(client.getAllTools()).toEqual([])
    await fixture(() => ({ tools: [tool('recovered')] }), client)
    expect(await client.connect('remote', config)).toMatchObject({ status: 'connected' })
    expect(client.getAllTools().map(value => value.name)).toEqual(['remote__recovered'])
  })

  it('validates every page using the SDK response schema', async () => {
    const { client, closed } = await fixture(cursor => cursor === undefined
      ? { tools: [tool('first')], nextCursor: 'invalid' }
      : { tools: [tool('bad', { inputSchema: { type: 'string' } as unknown as Tool['inputSchema'] })] })
    expect(await client.connect('remote', config)).toMatchObject({ status: 'error', tools: [], error: expect.any(String) })
    expect(closed).toHaveBeenCalled()
  })

  it.each([
    { description: 'changed' },
    { inputSchema: { type: 'object' as const, required: ['value'] } },
    { outputSchema: { type: 'object' as const } },
    { annotations: { destructiveHint: true } },
    { execution: { taskSupport: 'required' as const } },
  ])('rejects conflicting definitions before applying filters: %j', async change => {
    const { client } = await fixture(cursor => cursor === undefined
      ? { tools: [tool('conflict')], nextCursor: 'next' }
      : { tools: [tool('conflict', change)] })
    expect(await client.connect('remote', { ...config, disabledTools: ['conflict'] })).toMatchObject({
      status: 'error', tools: [], error: expect.stringContaining('Conflicting MCP tool definition: conflict'),
    })
  })

  it.each([['repeat', 'repeat'], ['a', 'b', 'a']])('rejects cursor cycles %j', async (...cursors) => {
    let page = 0
    const { client, requests } = await fixture(() => ({ tools: [], nextCursor: cursors[page++] }))
    expect(await client.connect('remote', config)).toMatchObject({ status: 'error', tools: [], error: expect.stringContaining('repeated cursor') })
    expect(requests).toHaveBeenCalledTimes(cursors.length)
  })

  it.each([false, true])('bounds discovery at 100 pages (over limit: %s)', async overLimit => {
    let page = 0
    const { client, requests } = await fixture(() => ({ tools: [], nextCursor: ++page === 100 && !overLimit ? undefined : String(page) }))
    const connection = await client.connect('remote', config)
    expect(requests).toHaveBeenCalledTimes(100)
    expect(connection.status).toBe(overLimit ? 'error' : 'connected')
    if (overLimit) expect(connection.error).toContain('100 pages')
  })

  it.each([false, true])('bounds the raw tool count before deduplication and filtering (over limit: %s)', async overLimit => {
    const repeated = Array.from({ length: 5_000 }, () => tool('same'))
    const { client } = await fixture(cursor => cursor === undefined
      ? { tools: repeated, nextCursor: 'next' }
      : { tools: overLimit ? [...repeated, tool('extra')] : repeated })
    const connection = await client.connect('remote', { ...config, disabledTools: ['same', 'extra'] })
    expect(connection.status).toBe(overLimit ? 'error' : 'connected')
    expect(connection.tools).toEqual([])
    if (overLimit) expect(connection.error).toContain('10000 tools')
  })

  it('preserves SDK output validators and required-task guards for tools from every page', async () => {
    const schema = { type: 'object' as const, properties: { value: { type: 'number' } }, required: ['value'] }
    const { client, calls } = await fixture(cursor => cursor === undefined
      ? { tools: [tool('first', { outputSchema: schema }), tool('task', { execution: { taskSupport: 'required' } })], nextCursor: 'next' }
      : { tools: [tool('last', { outputSchema: schema })] })
    expect((await client.connect('remote', config)).status).toBe('connected')
    for (const name of ['first', 'last']) {
      expect(await client.callTool('remote', name, {})).toMatchObject({ isError: true, content: expect.stringContaining('output schema') })
    }
    expect(await client.callTool('remote', 'task', {})).toMatchObject({ isError: true, content: expect.stringContaining('requires task-based execution') })
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('bounds the entire startup and discovery and cancels a stalled page', async () => {
    vi.useFakeTimers()
    const pending = deferred<ListToolsResult>()
    const { client, closed, requests } = await fixture(cursor => {
      if (cursor === undefined) return new Promise(resolve => {
        setTimeout(() => resolve({ tools: [tool('partial')], nextCursor: 'stalled' }), 150)
      })
      return pending.promise
    })
    const connecting = client.connect('remote', { ...config, startupTimeoutMs: 250 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(await connecting).toMatchObject({ status: 'error', tools: [], error: expect.stringContaining('startup timed out') })
    expect(requests).toHaveBeenCalledTimes(2)
    expect(closed).toHaveBeenCalled()
    pending.resolve({ tools: [tool('late')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.getAllTools()).toEqual([])
    expect(client.getConnection('remote')?.status).toBe('error')
  })
})
