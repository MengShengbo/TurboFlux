import { describe, expect, it, vi } from 'vitest'
import type { SubAgentDefinition } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import { runSubAgent } from './subAgent'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('runSubAgent', () => {
  it('executes independent tool calls in parallel and returns results in request order', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ at: number; path: string }> = []
    const startedAt = Date.now()

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [
            { id: 'a', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) } },
            { id: 'b', function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.ts' }) } },
          ],
        },
      }],
    }), { status: 200 })) as unknown as typeof fetch

    const executor = {
      readFile: async (path: string) => {
        calls.push({ at: Date.now() - startedAt, path })
        await delay(80)
        return { success: true, data: `content for ${path}` }
      },
      searchFiles: async () => ({ success: true, data: { matches: [] } }),
      searchContent: async () => ({ success: true, data: [] }),
      searchCodeSymbols: async () => ({ success: true, data: [] }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    const definition: SubAgentDefinition = {
      id: 'fast_context',
      label: 'FastContext',
      description: 'test',
      driver: 'deepseek-flash',
      systemPrompt: 'test',
      maxTurns: 1,
      maxParallel: 2,
      temperature: 0,
    }

    const result = await runSubAgent({
      definition,
      objective: 'read two files',
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      apiKey: 'test',
      baseUrl: 'http://example.test',
    })

    globalThis.fetch = originalFetch

    expect(result.ok).toBe(true)
    expect(calls.map(call => call.path.replace(/\\/g, '/'))).toEqual(['C:/repo/a.ts', 'C:/repo/b.ts'])
    expect(Math.abs(calls[1].at - calls[0].at)).toBeLessThan(40)
  })
})
