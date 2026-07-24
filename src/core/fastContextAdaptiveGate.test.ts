import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import { runFastContextSubagent } from './fastContextSubagent'

describe('FastContext adaptive submission gate', () => {
  it('submits on turn three and ranks by causal judgment instead of discovery order', async () => {
    const originalFetch = globalThis.fetch
    const requestTools: string[][] = []
    const promptCacheKeys: string[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestTools.push((body.tools || []).map((tool: any) => tool.function?.name || tool.name))
      promptCacheKeys.push(body.prompt_cache_key)
      const toolCalls = requestCount === 1
        ? [call('locate-owner', 'search_content', { pattern: 'normalizeUrl' })]
        : requestCount === 2
          ? [
              call('read-adapter', 'read_file', { path: 'src/adapter.ts', offset: 1, limit: 10 }),
              call('read-owner', 'read_file', { path: 'src/url.ts', offset: 1, limit: 10 }),
            ]
          : [call('submit-map', 'submit_code_map', {
              candidates: [
                rankedCandidate('src/adapter.ts', 'runtime caller', 'consumer', 'propagate', 0.55, 1),
                rankedCandidate('src/url.ts', 'normalization owner', 'owner', 'resolve', 0.94, 0),
              ],
              relationships: [],
              rejected_hypotheses: [],
              searches_tried: [],
              uncertainty: [],
            })]
      return new Response(JSON.stringify({
        output: toolCalls.map(toolCall => ({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: {
          content: path.endsWith('url.ts')
            ? 'export function normalizeUrl() {}\nnormalizeUrl()'
            : 'import { normalizeUrl } from "./url"\nnormalizeUrl()',
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
        objective: 'locate URL normalization compatibility behavior',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://three-turn-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(requestCount).toBe(3)
      expect(requestTools[2]).toEqual(expect.arrayContaining(['submit_code_map', 'request_more_search']))
      expect(new Set(promptCacheKeys).size).toBe(1)
      expect(promptCacheKeys[0]).toMatch(/^tf:subagent:gpt-5\.5:/)
      expect(result.evidencePack.indexOf('1. src/url.ts')).toBeGreaterThanOrEqual(0)
      expect(result.evidencePack.indexOf('2. src/adapter.ts')).toBeGreaterThan(result.evidencePack.indexOf('1. src/url.ts'))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

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
          ? call('request-rescue', 'request_more_search', {
              reason: 'public contract may need synchronization',
              next_queries: ['OwnerContract'],
            })
          : requestCount === 4
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
      expect(requestCount).toBe(5)
      expect(requestTools[2]).toEqual(expect.arrayContaining(['submit_code_map', 'request_more_search']))
      expect(requestTools[2]).toHaveLength(2)
      expect(requestTools[3]).toContain('read_file')
      expect(requestTools[3]).not.toContain('request_more_search')
      expect(requestTools[4]).toEqual(['submit_code_map'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects an acknowledged open frontier and grants one bounded sibling read', async () => {
    const originalFetch = globalThis.fetch
    const requestTools: string[][] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestTools.push((body.tools || []).map((tool: any) => tool.function?.name || tool.name))
      const toolCall = requestCount === 1
        ? call('read-owner', 'read_file', { path: 'src/parser.ts', offset: 1, limit: 10 })
        : requestCount === 2
          ? call('search-sibling', 'search_files', { pattern: 'src/*Parser.ts' })
          : requestCount === 3
            ? call('submit-open-frontier', 'submit_code_map', {
                candidates: [candidate('src/parser.ts', 'primary parser owner', 'owner', 'owns parsing behavior')],
                relationships: [],
                frontier_complete: false,
                unresolved_edit_paths: ['src/sharedParser.ts'],
                rejected_hypotheses: [],
                searches_tried: [],
                uncertainty: [],
              })
            : requestCount === 4
              ? call('read-sibling', 'read_file', { path: 'src/sharedParser.ts', offset: 1, limit: 10 })
              : call('submit-closed-frontier', 'submit_code_map', {
                  candidates: [
                    candidate('src/parser.ts', 'primary parser owner', 'owner', 'owns parsing behavior'),
                    candidate('src/sharedParser.ts', 'shared parser implementation', 'implementation', 'carries the same grammar behavior'),
                  ],
                  relationships: [],
                  frontier_complete: true,
                  unresolved_edit_paths: [],
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
          content: path.endsWith('sharedParser.ts')
            ? 'export function parseShared() {}\nparseShared()'
            : 'export function parsePrimary() {}\nparsePrimary()',
          startLine: 1,
          endLine: 2,
          truncated: false,
        },
      })),
      readFile: vi.fn(),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: ['C:/repo/src/sharedParser.ts'] } })),
      searchContent: vi.fn(async () => ({ success: true, data: [] })),
      searchCodeSymbols: vi.fn(),
      getCodeMap: vi.fn(),
    } as unknown as ToolExecutor

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'update parser behavior across shared implementations',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://frontier-closure-fastcontext.test',
        provider: 'openai-compatible',
        model: 'test-model',
      })

      expect(requestCount).toBe(5)
      expect(requestTools[2]).toEqual(expect.arrayContaining(['submit_code_map', 'request_more_search']))
      expect(requestTools[3]).toContain('read_file')
      expect(requestTools[4]).toEqual(['submit_code_map'])
      expect(result.evidencePack).toContain('src/sharedParser.ts')
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

function rankedCandidate(
  path: string,
  role: string,
  editKind: string,
  changeEffect: string,
  patchProbability: number,
  causalDistance: number,
) {
  return {
    ...candidate(path, role, editKind, 'read-grounded candidate'),
    change_effect: changeEffect,
    patch_probability: patchProbability,
    causal_distance: causalDistance,
  }
}
