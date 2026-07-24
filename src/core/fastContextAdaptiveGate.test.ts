import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import { runFastContextSubagent } from './fastContextSubagent'

describe('FastContext adaptive controller', () => {
  it('finishes a simple grounded owner task in two provider turns', async () => {
    const originalFetch = globalThis.fetch
    const requestTools: string[][] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestTools.push(toolNames(body))
      const toolCall = requestCount === 1
        ? call('read-owner', 'read_file', { path: 'src/owner.ts', offset: 1, limit: 10 })
        : call('submit-owner', 'submit_code_map', {
            candidates: [candidate('src/owner.ts', 'runtime owner', 'owner', 'resolve', 0.96, 0)],
            relationships: [],
            frontier_complete: true,
            unresolved_edit_paths: [],
            rejected_hypotheses: [],
            searches_tried: [],
            uncertainty: [],
          })
      return response(toolCall)
    }) as unknown as typeof fetch

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'locate the exact runtime owner',
        toolExecutor: executor(),
        apiKey: 'test',
        baseUrl: 'http://adaptive-simple-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(requestCount).toBe(2)
      expect(requestTools[0]).toEqual(expect.arrayContaining(['read_file', 'search_content', 'submit_code_map']))
      expect(requestTools[1]).toEqual(expect.arrayContaining(['read_file', 'search_content', 'submit_code_map']))
      expect(requestTools[1]).toEqual(requestTools[0])
      expect(requestTools.flat()).not.toContain('request_more_search')
      expect(result.evidencePack).toContain('1. src/owner.ts')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lets the model continue several targeted waves before submitting a complex frontier', async () => {
    const originalFetch = globalThis.fetch
    const requestTools: string[][] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestTools.push(toolNames(body))
      const toolCall = requestCount === 1
        ? call('search-owner', 'search_content', { pattern: 'RuntimeOwner' })
        : requestCount === 2
          ? call('read-owner', 'read_file', { path: 'src/owner.ts', offset: 1, limit: 10 })
          : requestCount === 3
            ? call('search-contract', 'search_content', { pattern: 'OwnerContract' })
            : requestCount === 4
              ? call('read-contract', 'read_file', { path: 'src/contract.ts', offset: 1, limit: 10 })
              : call('submit-complete', 'submit_code_map', {
                  candidates: [
                    candidate('src/owner.ts', 'runtime owner', 'owner', 'resolve', 0.94, 0),
                    candidate('src/contract.ts', 'public contract propagation', 'consumer', 'propagate', 0.78, 1),
                  ],
                  relationships: [],
                  frontier_complete: true,
                  unresolved_edit_paths: [],
                  rejected_hypotheses: [],
                  searches_tried: ['RuntimeOwner', 'OwnerContract'],
                  uncertainty: [],
                })
      return response(toolCall)
    }) as unknown as typeof fetch

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'trace runtime ownership and its public contract propagation',
        toolExecutor: executor(),
        apiKey: 'test',
        baseUrl: 'http://adaptive-complex-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(requestCount).toBe(5)
      expect(requestTools[2]).toEqual(expect.arrayContaining(['search_content', 'read_file', 'submit_code_map']))
      expect(requestTools[3]).toEqual(expect.arrayContaining(['search_content', 'read_file', 'submit_code_map']))
      expect(result.evidencePack).toContain('src/owner.ts')
      expect(result.evidencePack).toContain('src/contract.ts')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('accepts a grounded ranking with unresolved uncertainty without a repair round trip', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      const toolCall = requestCount === 1
        ? call('read-symptom', 'read_file', { path: 'src/symptom.ts', offset: 1, limit: 10 })
        : requestCount === 2
          ? call('submit-incomplete', 'submit_code_map', {
              candidates: [candidate('src/symptom.ts', 'symptom owner', 'owner', 'resolve', 0.82, 0)],
              relationships: [],
              frontier_complete: true,
              unresolved_edit_paths: [],
              rejected_hypotheses: [],
              searches_tried: ['RuntimeServer'],
              uncertainty: ['src/runtime/server.ts contains RuntimeServer according to search results, but it was not read and may own cleanup.'],
            })
          : requestCount === 3
            ? call('read-runtime', 'read_file', { path: 'src/runtime/server.ts', offset: 1, limit: 10 })
            : call('submit-closed', 'submit_code_map', {
                candidates: [
                  candidate('src/runtime/server.ts', 'runtime lifecycle owner', 'owner', 'resolve', 0.95, 0),
                  candidate('src/symptom.ts', 'symptom integration', 'consumer', 'propagate', 0.72, 1),
                ],
                relationships: [],
                frontier_complete: true,
                unresolved_edit_paths: [],
                rejected_hypotheses: [],
                searches_tried: ['RuntimeServer'],
                uncertainty: [],
              })
      return response(toolCall)
    }) as unknown as typeof fetch

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'trace shutdown cleanup from the visible symptom to the runtime server',
        toolExecutor: executor(),
        apiKey: 'test',
        baseUrl: 'http://adaptive-contradiction-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(requestCount).toBe(2)
      expect(result.evidencePack).toContain('src/symptom.ts')
      expect(result.evidencePack).toContain('src/runtime/server.ts contains RuntimeServer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('lets the model stop after an empty wave without forcing an alternate search', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      const toolCall = requestCount === 1
        ? call('read-owner', 'read_file', { path: 'src/owner.ts', offset: 1, limit: 10 })
        : requestCount === 2
          ? call('search-missing', 'search_content', { pattern: 'DefinitelyMissingSymbol' })
          : call('submit-owner', 'submit_code_map', {
              candidates: [candidate('src/owner.ts', 'runtime owner', 'owner', 'resolve', 0.96, 0)],
              relationships: [],
              frontier_complete: true,
              unresolved_edit_paths: [],
              rejected_hypotheses: ['DefinitelyMissingSymbol has no repository matches'],
              searches_tried: ['DefinitelyMissingSymbol'],
              uncertainty: [],
            })
      return response(toolCall)
    }) as unknown as typeof fetch

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'locate the runtime owner and reject a named alternate owner when absent',
        toolExecutor: executor(),
        apiKey: 'test',
        baseUrl: 'http://adaptive-empty-wave-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(requestCount).toBe(3)
      expect(JSON.stringify(requestBodies[2])).toContain('empty_results: 1')
      expect(JSON.stringify(requestBodies[2])).not.toContain('do not conclude until one alternate search has run')
      expect(result.evidencePack).toContain('src/owner.ts')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reuses an exact repeated read and reports zero novelty to the model', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: any[] = []
    const toolExecutor = executor()
    let requestCount = 0
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      const toolCall = requestCount <= 2
        ? call(`read-owner-${requestCount}`, 'read_file', { path: 'src/owner.ts', offset: 1, limit: 10 })
        : call('submit-owner', 'submit_code_map', {
            candidates: [candidate('src/owner.ts', 'runtime owner', 'owner', 'resolve', 0.96, 0)],
            relationships: [],
            frontier_complete: true,
            unresolved_edit_paths: [],
            rejected_hypotheses: [],
            searches_tried: [],
            uncertainty: [],
          })
      return response(toolCall)
    }) as unknown as typeof fetch

    try {
      await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'locate the exact runtime owner',
        toolExecutor,
        apiKey: 'test',
        baseUrl: 'http://adaptive-repeat-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(toolExecutor.readFileRange).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(requestBodies[2])).toContain('exact_repeated_calls: 1')
      expect(JSON.stringify(requestBodies[2])).toContain('new_evidence_ranges: 0')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('traces several concrete next-hop symbols concurrently in one wave', async () => {
    const originalFetch = globalThis.fetch
    let activeSymbolSearches = 0
    let maxActiveSymbolSearches = 0
    const toolExecutor = executor()
    toolExecutor.searchCodeSymbols = vi.fn(async ({ query }: { query: string }) => {
      activeSymbolSearches += 1
      maxActiveSymbolSearches = Math.max(maxActiveSymbolSearches, activeSymbolSearches)
      await new Promise(resolve => setTimeout(resolve, 10))
      activeSymbolSearches -= 1
      return {
        success: true,
        data: [{
          path: `C:/repo/src/${query}.ts`,
          line: 1,
          startLine: 1,
          endLine: 2,
          title: query,
          symbolName: query,
          symbolKind: 'function',
          source: 'index',
          preview: `export function ${query}() {}`,
        }],
      }
    }) as ToolExecutor['searchCodeSymbols']
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      const toolCall = requestCount === 1
        ? call('read-entry', 'read_file', { path: 'src/entry.ts', offset: 1, limit: 10 })
        : requestCount === 2
          ? call('trace-next-hops', 'trace_symbols', { queries: ['FirstOwner', 'SecondOwner'] })
          : call('submit-chain', 'submit_code_map', {
              candidates: [
                candidate('src/FirstOwner.ts', 'first causal owner', 'owner', 'resolve', 0.92, 0),
                candidate('src/SecondOwner.ts', 'second causal owner', 'implementation', 'propagate', 0.78, 1),
              ],
              relationships: [],
              frontier_complete: true,
              unresolved_edit_paths: [],
              rejected_hypotheses: [],
              searches_tried: ['FirstOwner', 'SecondOwner'],
              uncertainty: [],
            })
      return response(toolCall)
    }) as unknown as typeof fetch

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'trace the entry through FirstOwner and SecondOwner',
        toolExecutor,
        apiKey: 'test',
        baseUrl: 'http://adaptive-batch-trace-fastcontext.test',
        provider: 'openai-compatible',
        model: 'gpt-5.5',
      })

      expect(requestCount).toBe(3)
      expect(maxActiveSymbolSearches).toBe(2)
      expect(result.evidencePack).toContain('src/FirstOwner.ts')
      expect(result.evidencePack).toContain('src/SecondOwner.ts')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

function toolNames(body: any): string[] {
  return (body.tools || []).map((tool: any) => tool.function?.name || tool.name)
}

function response(toolCall: ReturnType<typeof call>): Response {
  return new Response(JSON.stringify({
    output: [{
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    }],
    choices: [{ message: { content: '', tool_calls: [toolCall] } }],
  }), { status: 200 })
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, function: { name, arguments: JSON.stringify(args) } }
}

function candidate(
  path: string,
  role: string,
  editKind: string,
  changeEffect: string,
  patchProbability: number,
  causalDistance: number,
) {
  return {
    path,
    start_line: 1,
    end_line: 2,
    role,
    edit_kind: editKind,
    confidence: 'high',
    patch_probability: patchProbability,
    causal_distance: causalDistance,
    change_effect: changeEffect,
    why: 'read-grounded candidate',
  }
}

function executor(): ToolExecutor {
  return {
    readFileRange: vi.fn(async (path: string) => ({
      success: true,
      data: {
        content: path.includes('contract')
          ? 'export interface OwnerContract {}\nexport type PublicOwner = OwnerContract'
          : path.includes('runtime')
            ? 'export class RuntimeServer {}\nnew RuntimeServer()'
            : 'export function RuntimeOwner() {}\nRuntimeOwner()',
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
}
