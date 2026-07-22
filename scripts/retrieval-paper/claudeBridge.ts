import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { TurboFluxConfig } from '../../src/core/config'
import type { UsageMetrics } from './types'

interface BridgeStats {
  requests: number
  upstreamRetries: number
  usage: UsageMetrics
  receivedPaths: string[]
}

interface ClaudeBridge {
  baseUrl: string
  stats: BridgeStats
  close: () => Promise<void>
}

function emptyUsage(): UsageMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.filter(block => block && typeof block === 'object' && (block as any).type === 'text').map(block => String((block as any).text || '')).join('\n')
}

function convertMessages(messages: any[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role = message?.role
    const content = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content || '') }]
    const text = content.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text || '')).join('\n')
    if (text) input.push({ role, content: text })
    for (const block of content) {
      if (role === 'assistant' && block?.type === 'tool_use' && block.id && block.name) {
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        })
      }
      if (role === 'user' && block?.type === 'tool_result' && block.tool_use_id) {
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''),
        })
      }
    }
  }
  return input
}

function convertTools(tools: any[]): Array<Record<string, unknown>> {
  return tools.filter(tool => tool?.name).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || { type: 'object', properties: {} },
  }))
}

function usageFromResponse(response: any): UsageMetrics {
  const usage = response?.usage || {}
  return {
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cacheReadTokens: Number(usage.input_tokens_details?.cached_tokens) || 0,
    cacheWriteTokens: 0,
    reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens) || 0,
  }
}

function addUsage(target: UsageMetrics, source: UsageMetrics): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.reasoningTokens += source.reasoningTokens
}

function responseBlocks(response: any): any[] {
  const blocks: any[] = []
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === 'message') {
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('')
      if (text) blocks.push({ type: 'text', text })
    }
    if (item?.type === 'function_call' && item.name) {
      let input: unknown = {}
      try { input = JSON.parse(item.arguments || '{}') } catch { input = {} }
      blocks.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input })
    }
  }
  return blocks
}

function writeEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function writeAnthropicStream(response: ServerResponse, model: string, upstream: any): void {
  const id = `msg_benchmark_${String(upstream?.id || Date.now()).replace(/[^A-Za-z0-9_-]/g, '')}`
  const usage = usageFromResponse(upstream)
  const blocks = responseBlocks(upstream)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  writeEvent(response, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.inputTokens, output_tokens: 0 } },
  })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      writeEvent(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      writeEvent(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else {
      writeEvent(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      writeEvent(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } })
    }
    writeEvent(response, 'content_block_stop', { type: 'content_block_stop', index })
  })
  writeEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.outputTokens },
  })
  writeEvent(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startClaudeProtocolBridge(config: TurboFluxConfig, model: string): Promise<ClaudeBridge> {
  const stats: BridgeStats = { requests: 0, upstreamRetries: 0, usage: emptyUsage(), receivedPaths: [] }
  const server = createServer(async (request, response) => {
    const requestPath = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : ''
    stats.receivedPaths.push(`${request.method || 'UNKNOWN'} ${requestPath}`)
    if (request.method !== 'POST' || !requestPath.replace(/\/$/, '').endsWith('/messages')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Benchmark bridge only exposes Messages.' } }))
      return
    }
    try {
      const body = await readJson(request)
      stats.requests += 1
      const upstreamBody: Record<string, unknown> = {
        model,
        instructions: textContent(body.system),
        input: convertMessages(Array.isArray(body.messages) ? body.messages : []),
        tools: convertTools(Array.isArray(body.tools) ? body.tools : []),
        max_output_tokens: Math.min(Number(body.max_tokens) || 4096, 16_384),
        parallel_tool_calls: true,
        reasoning: { effort: 'none' },
        store: false,
      }
      const upstream = await fetch(`${config.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          'User-Agent': 'turboflux-retrieval-benchmark/1.0',
          ...config.customHeaders,
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(120_000),
      })
      if (!upstream.ok) {
        const detail = await upstream.text()
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Upstream Responses HTTP ${upstream.status}: ${detail}` } }))
        return
      }
      const payload = await upstream.json()
      addUsage(stats.usage, usageFromResponse(payload))
      writeAnthropicStream(response, model, payload)
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : String(error) } }))
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Claude benchmark bridge failed to bind a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats,
    close: () => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}
