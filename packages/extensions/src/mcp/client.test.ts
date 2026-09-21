import { describe, expect, it } from 'vitest'
import { buildMcpEnvironment, McpClient } from './client'

describe('McpClient environment handling', () => {
  it('passes only a minimal inherited environment plus explicit server env', () => {
    const env = buildMcpEnvironment({
      command: 'node',
      enabled: true,
      env: {
        TURBOFLUX_API_KEY: 'explicit-secret',
        CUSTOM_SETTING: 'enabled',
      },
    }, {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TURBOFLUX_API_KEY: 'parent-secret',
      AWS_SECRET_ACCESS_KEY: 'parent-cloud-secret',
      HOME: 'C:\\Users\\admin',
    })

    expect(env.Path).toBe('C:\\Windows\\System32')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.TURBOFLUX_API_KEY).toBe('explicit-secret')
    expect(env.CUSTOM_SETTING).toBe('enabled')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('HOME')
  })
})

describe('McpClient local system plugins', () => {
  it('keeps selection-gated tools hidden and blocks calls until enabled', async () => {
    const client = new McpClient()
    client.registerLocalServer({
      name: 'browser',
      requiresSelection: true,
      tools: [{
        name: 'observe',
        description: 'Observe a page',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      }],
      handler: async toolName => ({ toolName, ok: true }),
    })

    expect(client.getAllTools()).toEqual([])
    expect((await client.callTool('browser', 'observe', {})).isError).toBe(true)

    client.setLocalServerEnabledForRun('browser', true)
    expect(client.getAllTools().map(tool => tool.name)).toEqual(['browser__observe'])
    const result = await client.callTool('browser', 'observe', {})
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({ toolName: 'observe', ok: true })

    client.setLocalServerEnabledForRun('browser', false)
    expect(client.getAllTools()).toEqual([])
  })

  it('revokes every run-scoped local selection together', () => {
    const client = new McpClient()
    for (const name of ['browser', 'computer']) {
      client.registerLocalServer({
        name,
        requiresSelection: true,
        tools: [{ name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }],
        handler: async () => ({ ok: true }),
      })
      client.setLocalServerEnabledForRun(name, true)
    }

    expect(client.getAllTools()).toHaveLength(2)
    client.clearLocalServerRunSelections()
    expect(client.getAllTools()).toEqual([])
  })

  it('preserves a local assertion failure as an error with structured evidence', async () => {
    const client = new McpClient()
    client.registerLocalServer({
      name: 'browser',
      tools: [{ name: 'assert', description: 'Verify', inputSchema: { type: 'object', properties: {} } }],
      handler: async () => ({ kind: 'local_tool_result', isError: true, content: JSON.stringify({ passed: false, actual: 'pending' }) }),
    })
    const result = await client.callTool('browser', 'assert', {})
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toEqual({ passed: false, actual: 'pending' })
  })

  it('preserves structured image attachments from local tools', async () => {
    const client = new McpClient()
    client.registerLocalServer({
      name: 'browser',
      tools: [{
        name: 'visual_observe',
        description: 'Observe visually',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      }],
      handler: async () => ({
        kind: 'local_tool_result',
        content: '{"viewport":"current"}',
        attachments: [{
          id: 'capture-1',
          type: 'image',
          path: '/tmp/capture.png',
          mime: 'image/png',
          filename: 'capture.png',
          size: 128,
        }],
      }),
    })

    const result = await client.callTool('browser', 'visual_observe', {})

    expect(result).toEqual({
      content: '{"viewport":"current"}',
      isError: false,
      attachments: [{
        id: 'capture-1',
        type: 'image',
        path: '/tmp/capture.png',
        mime: 'image/png',
        filename: 'capture.png',
        size: 128,
      }],
    })
  })

  it('forwards stable Agent execution identity to local system plugins', async () => {
    const client = new McpClient()
    let receivedOptions: unknown
    client.registerLocalServer({
      name: 'browser',
      tools: [{ name: 'open', description: 'Open', inputSchema: { type: 'object', properties: {} } }],
      handler: async (_toolName, _args, options) => {
        receivedOptions = options
        return { ok: true }
      },
    })

    await client.callTool('browser', 'open', {}, {
      execution: {
        conversationId: 'conversation-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        itemId: 'tool-1',
      },
    })

    expect(receivedOptions).toEqual({
      execution: {
        conversationId: 'conversation-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        itemId: 'tool-1',
      },
    })
  })

  it('can reconnect configured servers without removing system plugins', async () => {
    const client = new McpClient()
    client.registerLocalServer({
      name: 'browser',
      tools: [{
        name: 'observe',
        description: 'Observe a page',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      handler: async () => ({ ok: true }),
    })

    await client.disconnectAll({ preserveSystem: true })

    expect(client.getConnection('browser')?.status).toBe('connected')
    expect(client.searchTools('browser').map(tool => tool.name)).toEqual(['browser__observe'])
  })

  it('matches multilingual metadata and never substitutes registration order for an unmatched query', () => {
    const client = new McpClient()
    client.registerLocalServer({
      name: 'tools',
      tools: [
        { name: 'calendar', description: 'Create calendar events', inputSchema: { type: 'object', properties: {} } },
        { name: 'screenshot', description: '浏览器截图 browser screenshot', inputSchema: { type: 'object', properties: {} } },
        { name: 'code', description: '代码搜索 code search', inputSchema: { type: 'object', properties: { repository: { type: 'string' } } } },
      ],
      handler: async () => ({}),
    })
    expect(client.searchTools('浏览器截图', 1)[0].name).toBe('tools__screenshot')
    expect(client.searchTools('代码搜索', 1)[0].name).toBe('tools__code')
    expect(client.searchTools('repository', 1)[0].name).toBe('tools__code')
    expect(client.searchTools('完全不存在的功能')).toEqual([])
    expect(client.searchTools('!!!')).toEqual([])
  })

  it('never lets an external connection replace a registered system plugin', async () => {
    const client = new McpClient()
    const systemConnection = client.registerLocalServer({
      name: 'browser',
      tools: [{
        name: 'observe',
        description: 'Observe a page',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      handler: async () => ({ source: 'system' }),
    })

    const connected = await client.connect('browser', { enabled: true })

    expect(connected).toBe(systemConnection)
    expect(client.getConnection('browser')).toBe(systemConnection)
    expect(client.getConnection('browser')?.system).toBe(true)
    expect(client.getAllTools().map(tool => tool.name)).toEqual(['browser__observe'])
    expect(JSON.parse((await client.callTool('browser', 'observe', {})).content)).toEqual({ source: 'system' })
  })

  it('refreshes a same-name system plugin without losing its run selection', async () => {
    const client = new McpClient()
    const firstConnection = client.registerLocalServer({
      name: 'computer',
      requiresSelection: true,
      tools: [{
        name: 'status',
        description: 'Old status tool',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      handler: async () => ({ version: 1 }),
    })
    client.setLocalServerEnabledForRun('computer', true)

    const refreshedConnection = client.registerLocalServer({
      name: 'computer',
      requiresSelection: true,
      tools: [{
        name: 'observe',
        description: 'Current observe tool',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      handler: async () => ({ version: 2 }),
    })

    expect(firstConnection.status).toBe('closed')
    expect(refreshedConnection).not.toBe(firstConnection)
    expect(refreshedConnection.enabledForRun).toBe(true)
    expect(client.getAllTools().map(tool => tool.name)).toEqual(['computer__observe'])
    expect(JSON.parse((await client.callTool('computer', 'observe', {})).content)).toEqual({ version: 2 })
  })
})
