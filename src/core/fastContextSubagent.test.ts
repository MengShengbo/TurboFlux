import { describe, expect, it } from 'vitest'
import type { FastContextScanHit } from './fastContextTypes'
import type { ToolExecutor } from '../tools/executor'
import {
  __testBuildEvidencePack,
  __testObjectiveTokens,
  __testSelectPrefetchTokens,
  runFastContextSubagent,
} from './fastContextSubagent'

describe('FastContext objective tokenization', () => {
  it('keeps Chinese UI wording and mixed code identifiers searchable', () => {
    const tokens = __testObjectiveTokens('\u627e\u5230\u540d\u7247\u6837\u5f0f tier-card-color-schemes \u4ee5\u53ca HeaderTitle')

    expect(tokens).toContain('\u540d\u7247\u6837\u5f0f')
    expect(tokens).toContain('\u540d\u7247')
    expect(tokens).toContain('\u6837\u5f0f')
    expect(tokens).toContain('tier-card-color-schemes')
    expect(tokens).toContain('header')
    expect(tokens).toContain('title')
  })

  it('keeps a compact mix of symbol and Chinese terms for deterministic prefetch', () => {
    const tokens = __testSelectPrefetchTokens('定位 FastContext 调度链，以及“输入框左右渲染”')

    expect(tokens).toContain('fastcontext')
    expect(tokens.some(token => token.includes('输入框'))).toBe(true)
    expect(tokens.length).toBeLessThanOrEqual(6)
  })

  it('prefers complete identifiers and compound terms over noisy fragments', () => {
    const fastContextTokens = __testSelectPrefetchTokens('Locate FastContext background scheduling and subagent retrieval')
    const scrollTokens = __testSelectPrefetchTokens('Locate row-level transcript viewport scrolling and terminal mouse-wheel handling')

    expect(fastContextTokens).toEqual(expect.arrayContaining(['fastcontext', 'background', 'scheduling', 'subagent']))
    expect(fastContextTokens).not.toContain('fast')
    expect(fastContextTokens).not.toContain('context')
    expect(scrollTokens).toEqual(expect.arrayContaining(['row-level', 'transcript', 'viewport', 'mouse-wheel']))
    expect(scrollTokens).not.toContain('row')
    expect(scrollTokens).not.toContain('wheel')
  })

  it('treats the LLM final report as the primary ranked code map', () => {
    const candidates = new Map<string, FastContextScanHit[]>()
    candidates.set('src/fallback.ts', [{
      path: 'src/fallback.ts',
      line: 10,
      startLine: 10,
      endLine: 14,
      preview: 'fallback evidence',
      kind: 'implementation',
      confidence: 'medium',
      reason: 'grep: fallback',
    }])

    const pack = __testBuildEvidencePack(
      'find card styles',
      candidates,
      123,
      2,
      false,
      'RANKED_CODE_MAP\n1. src/llm.ts L20-L40 role=entry confidence=high why=read and confirmed',
    )

    expect(pack).toContain('authority: llm_subagent_report_first')
    expect(pack).toContain('llm_ranked_code_map:')
    expect(pack).toContain('src/llm.ts L20-L40')
    expect(pack).toContain('fallback_candidates:')
    expect(pack).toContain('src/fallback.ts')
  })

  it('returns read-confirmed deterministic evidence when model ranking is unavailable', async () => {
    const executor = {
      searchFiles: async () => ({
        success: true,
        data: { matches: ['C:/repo/package.json', 'C:/repo/src/index.ts'] },
      }),
      searchContent: async () => ({
        success: true,
        data: [{ file: 'C:/repo/src/fastContext.ts', line: 3, text: 'export function runFastContext() {' }],
      }),
      searchCodeSymbols: async () => ({
        success: true,
        data: [{
          path: 'src/fastContext.ts',
          line: 3,
          startLine: 3,
          endLine: 8,
          title: 'runFastContext',
          preview: 'export function runFastContext() {',
        }],
      }),
      readFile: async () => ({
        success: true,
        data: ['import { search } from "./search"', '', 'export function runFastContext() {', '  return search()', '}'].join('\n'),
      }),
      getCodeMap: async () => ({ success: true, data: { map: [] } }),
    } as unknown as ToolExecutor

    const result = await runFastContextSubagent({
      workspacePath: 'C:/repo',
      objective: 'locate FastContext scheduling',
      toolExecutor: executor,
      apiKey: '',
      baseUrl: 'http://example.test',
    })

    expect(result.filesScanned).toBeGreaterThan(0)
    expect(result.hits.some(hit => hit.reason === 'prefetch read confirmation')).toBe(true)
    expect(result.evidencePack).toContain('quality:')
    expect(result.evidencePack).toContain('read-confirmed evidence range')
    expect(result.evidencePack).toContain('llm_ranked_code_map:\n- missing')
    expect(result.truncated).toBe(true)
  })
})
