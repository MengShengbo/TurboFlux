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
      expect(requestTools[0]).not.toContain('submit_code_map')
      expect(requestTools[1]).toEqual(expect.arrayContaining(['read_file', 'search_content', 'submit_code_map']))
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

  it('rejects a closed-frontier claim that explicitly admits an unread path', async () => {
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

      expect(requestCount).toBe(4)
      expect(JSON.stringify(requestBodies[2])).toContain('submission uncertainty declares unread path')
      expect(toolNames(requestBodies[2])).toEqual(expect.arrayContaining(['read_file', 'submit_code_map']))
      expect(result.evidencePack).toContain('src/runtime/server.ts')
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
