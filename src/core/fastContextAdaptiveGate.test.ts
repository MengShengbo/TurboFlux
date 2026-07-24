import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import { runFastContextSubagent } from './fastContextSubagent'

describe('FastContext adaptive submission gate', () => {
  it('reopens retrieval once only after an explicit rescue request', async () => {
    const originalFetch = globalThis.fetch
    const requestTools: string[][] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestTools.push((body.tools || []).map((tool: any) => tool.function?.name || tool.name))
      const toolCall = requestCount === 1
        ? call('read-owner', 'read_file', { path: 'src/owner.ts', offset: 1, limit: 10 })
        : requestCount === 2
          ? call('search-owner', 'search_content', { pattern: 'owner' })
          : requestCount === 3
            ? call('search-files', 'search_files', { pattern: '**/*Owner*' })
            : requestCount === 4
              ? call('request-rescue', 'request_more_search', {
                  reason: 'public contract may need synchronization',
                  next_queries: ['OwnerContract'],
                })
              : requestCount === 5
                ? call('read-contract', 'read_file', { path: 'src/contract.ts', offset: 1, limit: 10 })
                : call('submit-map', 'submit_code_map', {
                    candidates: [
                      candidate('src/owner.ts', 'runtime owner', 'owner', 'owns behavior'),
                      candidate('src/contract.ts', 'public contract', 'supporting', 'must remain synchronized'),
                    ],
                    relationships: [],
                    rejected_hypotheses: [],
                    searches_tried: [],
                    uncertainty: [],
                  })
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [toolCall] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: {
          content: path.endsWith('contract.ts')
            ? 'export interface OwnerContract {}\nexport type Owner = OwnerContract'
            : 'export function owner() {}\nowner()',
          startLine: 1,
          endLine: 2,
          truncated: false,
        },
      })),
      readFile: vi.fn(),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      searchContent: vi.fn(async () => ({ success: true, data: [] })),
      searchCodeSymbols: vi.fn(),
      getCodeMap: vi.fn(),
    } as unknown as ToolExecutor

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'locate owner and synchronized contract',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://adaptive-gate-fastcontext.test',
        provider: 'openai-compatible',
        model: 'test-model',
      })

      expect(result.evidencePack).toContain('src/contract.ts')
      expect(requestCount).toBe(6)
      expect(requestTools[3]).toEqual(expect.arrayContaining(['submit_code_map', 'request_more_search']))
      expect(requestTools[3]).toHaveLength(2)
      expect(requestTools[4]).toContain('read_file')
      expect(requestTools[4]).not.toContain('request_more_search')
      expect(requestTools[5]).toEqual(['submit_code_map'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, function: { name, arguments: JSON.stringify(args) } }
}

function candidate(path: string, role: string, editKind: string, why: string) {
  return {
    path,
    start_line: 1,
    end_line: 2,
    role,
    edit_kind: editKind,
    confidence: 'high',
    why,
  }
}
