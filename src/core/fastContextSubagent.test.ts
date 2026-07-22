import { describe, expect, it, vi } from 'vitest'
import type { FastContextScanHit } from './fastContextTypes'
import type { ToolExecutor } from '../tools/executor'
import {
  __testBuildEvidencePack,
  __testObjectiveTokens,
  runFastContextSubagent,
} from './fastContextSubagent'

describe('FastContext retrieval', () => {
  it('keeps Chinese UI wording and mixed code identifiers searchable', () => {
    const tokens = __testObjectiveTokens('\u627e\u5230\u540d\u7247\u6837\u5f0f tier-card-color-schemes \u4ee5\u53ca HeaderTitle')

    expect(tokens).toContain('\u540d\u7247\u6837\u5f0f')
    expect(tokens).toContain('\u540d\u7247')
    expect(tokens).toContain('\u6837\u5f0f')
    expect(tokens).toContain('tier-card-color-schemes')
    expect(tokens).toContain('header')
    expect(tokens).toContain('title')
  })

  it('starts with the model instead of eagerly scanning the workspace', async () => {
    const executor = {
      searchFiles: vi.fn(),
      searchContent: vi.fn(),
      searchCodeSymbols: vi.fn(),
      readFile: vi.fn(),
      getCodeMap: vi.fn(),
    } as unknown as ToolExecutor

    await expect(runFastContextSubagent({
      workspacePath: 'C:/repo',
      objective: 'locate FastContext scheduling',
      toolExecutor: executor,
      apiKey: '',
      baseUrl: 'http://example.test',
    })).rejects.toThrow('requires an active model')

    expect(executor.searchFiles).not.toHaveBeenCalled()
    expect(executor.searchContent).not.toHaveBeenCalled()
    expect(executor.searchCodeSymbols).not.toHaveBeenCalled()
    expect(executor.readFile).not.toHaveBeenCalled()
    expect(executor.getCodeMap).not.toHaveBeenCalled()
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

    expect(pack).toContain('authority: llm_verified_code_map')
    expect(pack).toContain('llm_ranked_code_map:')
    expect(pack).toContain('src/llm.ts L20-L40')
    expect(pack).not.toContain('local_recall_candidates:')
    expect(pack).not.toContain('src/fallback.ts')
  })
})
