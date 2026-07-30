import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import type { FastContextScanHit } from './fastContextTypes'
import {
  __testBuildEvidencePack,
  __testFastContextDefinition,
  FAST_CONTEXT_RACE_TOOLS,
  runFastContextSubagent,
} from './fastContextSubagent'
import { registerAgent } from './subAgent'

describe('FastContext controller', () => {
  it('uses one model-led adaptive controller', () => {
    const definition = __testFastContextDefinition()

    expect(definition.label).toBe('FastContext Controller')
    expect(definition.maxTurns).toBe(6)
    expect(definition.maxParallel).toBe(6)
    expect(definition.systemPrompt).toContain('edit counterfactual')
    expect(definition.systemPrompt).toContain('evidence handles')
    expect(definition.systemPrompt).toContain('search_symbol')
    expect(definition.systemPrompt).toContain('exact repeats are cached')
    expect(definition.systemPrompt).not.toContain('request_more_search')
  })

  it('protects the production FCRace definition from dynamic overrides', () => {
    expect(() => registerAgent({
      id: 'fast_context',
      label: 'Legacy FastContext',
      description: 'override',
      driver: 'main-model',
      systemPrompt: 'legacy',
      maxTurns: 1,
      maxParallel: 1,
    })).toThrow('reserved for the built-in production runtime')

    expect(__testFastContextDefinition()).toMatchObject({
      label: 'FastContext Controller',
      maxTurns: 6,
      maxParallel: 6,
    })
  })

  it('does not touch the workspace without an active model', async () => {
    const executor = {
      searchFiles: vi.fn(),
      searchContent: vi.fn(),
      searchCodeSymbols: vi.fn(),
      readFile: vi.fn(),
      getCodeMap: vi.fn(),
    } as unknown as ToolExecutor

    await expect(runFastContextSubagent({
      workspacePath: 'C:/repo',
      objective: 'locate the behavior owner',
      toolExecutor: executor,
      apiKey: '',
      baseUrl: 'http://example.test',
    })).rejects.toThrow('requires an active model')

    expect(executor.searchFiles).not.toHaveBeenCalled()
    expect(executor.searchContent).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
  })

  it('builds a compact authoritative evidence pack', () => {
    const candidates = new Map<string, FastContextScanHit[]>()
    candidates.set('src/owner.ts', [{
      path: 'src/owner.ts',
      line: 10,
      startLine: 10,
      endLine: 24,
      preview: 'export function owner() {}',
      reason: 'file read',
    }])

    const pack = __testBuildEvidencePack(
      'locate owner',
      candidates,
      420,
      2,
      false,
      'RANKED_CODE_MAP\n1. src/owner.ts L10-L24 kind=owner role=runtime owner confidence=high',
    )

    expect(pack).toContain('authority: llm_verified_code_map')
    expect(pack).toContain('quality: 1 read-confirmed evidence range(s)')
    expect(pack).toContain('src/owner.ts')
    expect(pack).not.toContain('fallback')
  })

  it('rejects non-structured reports', () => {
    expect(() => __testBuildEvidencePack('locate owner', new Map(), 10, 1, false, 'plain prose'))
      .toThrow('valid model-submitted code map')
  })

  it('accepts a grounded candidate without an architecture relationship', async () => {
    const originalFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'locate-owner',
          function: { name: 'search_symbol', arguments: JSON.stringify({ query: 'owner' }) },
        }] } }] }), { status: 200 })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
          id: 'read-owner',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/owner.ts', offset: 1, limit: 20 }) },
        }] } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'submit-owner',
        function: { name: 'submit_code_map', arguments: JSON.stringify({
          candidates: [{
            path: 'src/owner.ts',
            start_line: 1,
            end_line: 2,
            role: 'runtime owner',
            edit_kind: 'owner',
            confidence: 'high',
            why: 'directly owns the behavior',
          }],
          relationships: [],
          rejected_hypotheses: [],
          searches_tried: [],
          uncertainty: [],
        }) },
      }] } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const executor = {
      readFileRange: vi.fn(async () => ({
        success: true,
        data: { content: 'export function owner() {}\nowner()', startLine: 1, endLine: 2, truncated: false },
      })),
      readFile: vi.fn(),
      searchFiles: vi.fn(),
      searchContent: vi.fn(),
      searchCodeSymbols: vi.fn(),
      getCodeMap: vi.fn(),
    } as unknown as ToolExecutor

    try {
      const result = await runFastContextSubagent({
        workspacePath: 'C:/repo',
        objective: 'locate owner',
        toolExecutor: executor,
        apiKey: 'test',
        baseUrl: 'http://relationshipless-fastcontext.test',
        provider: 'openai-compatible',
        model: 'test-model',
      })

      expect(result.evidencePack).toContain('src/owner.ts')
      expect(result.engine).toBe('fcrace-v1')
      expect(FAST_CONTEXT_RACE_TOOLS).toEqual(['search_content', 'search_files', 'search_symbol', 'read_file', 'submit_code_map'])
      expect(result.telemetry).toMatchObject({
        toolCalls: 2,
        readCalls: 1,
        searchCalls: 1,
        internalOperations: 2,
        internalReadOperations: 1,
      })
      expect(result.truncated).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
