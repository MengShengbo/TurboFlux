import { describe, expect, it, vi } from 'vitest'
import type { FastContextScanHit } from './fastContextTypes'
import type { ToolExecutor } from '../tools/executor'
import { __testFirstPartyImportPatterns, __testImplementationStem, __testSelectPrimerContentPatterns } from './fastContextRetrieval'
import {
  __testApplyCausalAnchorRanking,
  __testBuildEvidencePack,
  __testBuildRerankContext,
  __testMergeCodeMaps,
  __testRetrievalPrimerQueries,
  __testApplyResponsibilityRanking,
  __testEnsureFeatureFrontierCandidates,
  __testSelectFrontierAuditPaths,
  runFastContextSubagent,
} from './fastContextSubagent'

describe('FastContext retrieval', () => {
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

  it('treats the LLM final report as the authoritative architecture code map', () => {
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

  it('refuses to manufacture a local semantic fallback', () => {
    expect(() => __testBuildEvidencePack(
      'find card styles',
      new Map(),
      123,
      2,
      true,
    )).toThrow('without a valid model-submitted code map')
  })

  it('promotes branch consensus and appends unique runtime evidence before tests', () => {
    const primary = {
      candidates: [
        { path: 'src/owner.ts', startLine: 1, endLine: 5, role: 'owner', editKind: 'owner' as const, confidence: 'high' as const, why: 'owns behavior' },
        { path: 'src/core.ts', startLine: 8, endLine: 18, role: 'core', editKind: 'implementation' as const, confidence: 'high' as const, why: 'implements behavior' },
        { path: 'tests/core.test.ts', startLine: 3, endLine: 7, role: 'test', editKind: 'test' as const, confidence: 'medium' as const, why: 'verifies behavior' },
      ],
      relationships: [{ from: 'src/core.ts', to: 'src/edge.ts', relationship: 'calls', evidencePath: 'src/edge.ts', startLine: 4, endLine: 8 }],
      rejectedHypotheses: [],
      searchesTried: ['primary search'],
      uncertainty: ['none'],
    }
    const coverage = {
      candidates: [
        { path: 'SRC/CORE.ts', startLine: 8, endLine: 18, role: 'duplicate', editKind: 'implementation' as const, confidence: 'high' as const, why: 'same core' },
        { path: 'src/mirror.ts', startLine: 2, endLine: 9, role: 'mirror', editKind: 'mirror' as const, confidence: 'medium' as const, why: 'coordinated edit' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['coverage search'],
      uncertainty: ['none'],
    }

    const merged = __testMergeCodeMaps(primary, coverage)

    expect(merged?.candidates.map(candidate => candidate.path)).toEqual(['src/owner.ts', 'src/core.ts', 'src/mirror.ts', 'src/edge.ts', 'tests/core.test.ts'])
    expect(merged?.searchesTried).toEqual(['primary search', 'coverage search'])
  })

  it('promotes exact identifiers from an explicit causal clause', () => {
    const report = __testMergeCodeMaps({
      candidates: [
        { path: 'src/wrapper.ts', startLine: 1, endLine: 3, role: 'wrapper', editKind: 'consumer', confidence: 'high', why: 'calls owner' },
        { path: 'src/owner.ts', startLine: 4, endLine: 8, role: 'owner', editKind: 'owner', confidence: 'high', why: 'OwnerThing.update_state mutates shared attrs' },
        { path: 'src/test.ts', startLine: 2, endLine: 5, role: 'test', editKind: 'test', confidence: 'medium', why: 'regression' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['exact search'],
      uncertainty: ['none'],
    })!

    const ranked = __testApplyCausalAnchorRanking(report, 'The leak is caused by OwnerThing.update_state mutating shared attrs.')

    expect(ranked.candidates.map(candidate => candidate.path)).toEqual(['src/owner.ts', 'src/wrapper.ts', 'src/test.ts'])
  })

  it('derives exact symbol and compact filename variants for the local primer', () => {
    const queries = __testRetrievalPrimerQueries('Cursor groups + Word wrap\nCheckboxInput calls get_context')

    expect(queries.symbols).toContain('CheckboxInput')
    expect(queries.symbols).toContain('get_context')
    expect(queries.filePatterns).toContain('**/*cursor*group*.*')
    expect(queries.contentPatterns).toContain('cursor[\\s_.-]*group')
  })

  it('separates structural configuration anchors from behavioral phrases', () => {
    const queries = __testRetrievalPrimerQueries('`--recursive=y` ignores `ignore-paths`\nExpected generated files to be skipped')

    expect(queries.structuralSignals).toContain('--recursive=y')
    expect(queries.structuralSignals).toContain('ignore-paths')
    expect(queries.contentPatterns).toContain('ignore[\\s_.-]*paths')
    expect(queries.behavioralSignals).toContain('recursive ignore')
  })

  it('reserves retrieval budget for behavioral signals when structural identifiers are noisy', () => {
    const selected = __testSelectPrimerContentPatterns({
      structuralSignals: ['main', 'model', 'tensor', 'print', 'array', 'config', 'runtime', 'output'],
      behavioralSignals: ['sliding window', 'pytorch flax', 'window inconsistency'],
    })

    expect(selected).toContain('sliding[\\s_.-]*window')
    expect(selected).toContain('pytorch[\\s_.-]*flax')
    expect(selected.indexOf('sliding[\\s_.-]*window')).toBeLessThan(4)
  })

  it('keeps behavior queries when issue templates contain URLs and image links', () => {
    const queries = __testRetrievalPrimerQueries('Support HTTP Proxy Api Gateway Integration Type\nSee https://forum.serverless.com and ![image](https://cloud.example.com/a.png)')

    expect(queries.contentPatterns).toContain('http[\\s_.-]*proxy')
    expect(queries.contentPatterns).toContain('api[\\s_.-]*gateway')
    expect(queries.contentPatterns).not.toContain('forum[\\s_.-]*serverless[\\s_.-]*com')
  })

  it('preserves repository source paths embedded in GitHub blob links', () => {
    const queries = __testRetrievalPrimerQueries('Warning in IsolationForest\nhttps://github.com/scikit-learn/scikit-learn/blob/9aaed498/sklearn/ensemble/_iforest.py#L337')

    expect(queries.pathHints).toContain('sklearn/ensemble/_iforest.py')
  })

  it('keeps stack-trace paths from the tail of long issue logs', () => {
    const noise = 'listed/file.py '.repeat(300)
    const queries = __testRetrievalPrimerQueries(`Command output overflow\n${noise}\nFile "/workspace/project/memory/summary.py", line 42, in update`)

    expect(queries.pathHints.some(path => path.endsWith('project/memory/summary.py'))).toBe(true)
  })

  it('does not truncate non-source extensions into header path hints', () => {
    const queries = __testRetrievalPrimerQueries("templateUrl: './app.component.html'")

    expect(queries.pathHints).not.toContain('./app.component.h')
  })

  it('expands Python from-import modules into concrete first-party files', () => {
    const patterns = __testFirstPartyImportPatterns([{
      path: 'sphinx/domains/python.py',
      startLine: 1,
      endLine: 40,
      preview: 'from sphinx.pycode import ast',
      content: 'from sphinx.pycode import ast\nfrom sphinx.util import logging as sphinx_logging',
      reason: 'file read',
    }, {
      path: 'sphinx/domains/python.py',
      startLine: 100,
      endLine: 160,
      preview: 'ast.parse(source)',
      content: 'ast.parse(source)\nast.NodeVisitor()\nast_parse(annotation)',
      reason: 'file read',
    }], ['sphinx/domains/python.py'])

    expect(patterns).toContain('sphinx/pycode/ast.py')
    expect(patterns).toContain('sphinx/util/logging.py')
  })

  it('prioritizes imported modules that overlap the issue semantics', () => {
    const imports = Array.from({ length: 14 }, (_, index) => `from project.module_${index} import Helper${index}`).join('\n')
    const content = `${imports}\nfrom project.memory.message_history import MessageHistory\nMessageHistory(agent)`
    const patterns = __testFirstPartyImportPatterns([{
      path: 'project/agent.py',
      startLine: 1,
      endLine: 20,
      preview: content,
      content,
      reason: 'file read',
    }], ['project/agent.py'], 'messages exceed the context window')

    expect(patterns).toContain('project/memory/message_history.py')
  })

  it('matches test modules to implementation modules by normalized stem', () => {
    expect(__testImplementationStem('testing/test_skipping.py')).toBe(__testImplementationStem('src/_pytest/skipping.py'))
    expect(__testImplementationStem('src/parser.spec.ts')).toBe(__testImplementationStem('src/parser.ts'))
  })

  it('builds a bounded listwise rerank pack from branch maps and read evidence', () => {
    const primary = {
      candidates: [{ path: 'src/wrapper.ts', startLine: 1, endLine: 8, role: 'wrapper', editKind: 'consumer' as const, confidence: 'high' as const, why: 'calls owner' }],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['wrapper'],
      uncertainty: [],
    }
    const coverage = {
      candidates: [{ path: 'src/owner.ts', startLine: 10, endLine: 30, role: 'owner', editKind: 'owner' as const, confidence: 'high' as const, why: 'mutates state' }],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['owner'],
      uncertainty: [],
    }
    const context = __testBuildRerankContext({
      primer: 'family[src] src/owner.ts',
      primary,
      coverage,
      evidence: [{ path: 'src/owner.ts', startLine: 10, endLine: 30, preview: 'mutate()', content: 'state.value = next', reason: 'file read' }],
    })

    expect(context).toContain('CAUSAL-OWNER BRANCH')
    expect(context).toContain('CHANGE-FRONTIER BRANCH')
    expect(context).toContain('READ-CONFIRMED SOURCE EXCERPTS')
    expect(context).toContain('state.value = next')
  })

  it('promotes an unambiguous compact title filename match', () => {
    const report = __testMergeCodeMaps({
      candidates: [
        { path: 'src/cursor.ts', startLine: 1, endLine: 3, role: 'cursor core', editKind: 'implementation', confidence: 'high', why: 'moves cursors' },
        { path: 'src/contrib/cursorgroup/cursorgroup.ts', startLine: 4, endLine: 8, role: 'cursor group contribution', editKind: 'owner', confidence: 'high', why: 'owns cursor group command' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['title filename'],
      uncertainty: ['none'],
    })!

    const ranked = __testApplyCausalAnchorRanking(report, 'Cursor group + Word wrap')

    expect(ranked.candidates[0].path).toBe('src/contrib/cursorgroup/cursorgroup.ts')
  })

  it('promotes the semantic predicate over a caller that only forwards configuration', () => {
    const report = __testMergeCodeMaps({
      candidates: [
        { path: 'src/options.ts', startLine: 1, endLine: 20, role: 'configuration schema for ignore paths', editKind: 'supporting', confidence: 'medium', why: 'Defines ignore-paths as regex patterns that match paths. This is supporting configuration, not where recursive filtering fails.' },
        { path: 'src/runner.ts', startLine: 1, endLine: 20, role: 'recursive discovery owner', editKind: 'owner', confidence: 'high', why: 'Walks directories and calls the shared ignore predicate with configured ignore paths.' },
        { path: 'src/matcher.ts', startLine: 4, endLine: 30, role: 'shared ignore predicate and normal expansion entry filtering', editKind: 'implementation', confidence: 'high', why: 'Defines _is_ignored_file. It computes basename and path regex matches. Because recursive discovery calls this helper, semantic mismatch in ignore-paths is centralized here.' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['ignore paths'],
      uncertainty: ['none'],
    })!

    const ranked = __testApplyResponsibilityRanking(report, '--recursive ignores ignore-paths')

    expect(ranked.candidates[0].path).toBe('src/matcher.ts')
  })

  it('selects unread responsibility siblings from an implementation family', () => {
    const report = __testMergeCodeMaps({
      candidates: [
        { path: 'src/pipeline/method/integration.ts', startLine: 1, endLine: 20, role: 'integration stage', editKind: 'implementation', confidence: 'high', why: 'builds integration' },
        { path: 'src/pipeline/validate.ts', startLine: 1, endLine: 20, role: 'validator', editKind: 'implementation', confidence: 'high', why: 'validates config' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['pipeline'],
      uncertainty: ['none'],
    })!

    const selected = __testSelectFrontierAuditPaths([
      'src/pipeline/authorizers.ts',
      'src/pipeline/resources.ts',
      'src/unrelated/validator.ts',
    ], report, ['src/pipeline/validate.ts'])

    expect(selected).toEqual(['src/pipeline/authorizers.ts'])
  })

  it('keeps read-confirmed feature responsibilities ahead of generic support', () => {
    const candidate = (path: string, editKind: 'owner' | 'implementation' | 'supporting') => ({
      path,
      startLine: 1,
      endLine: 20,
      role: path,
      editKind,
      confidence: 'high' as const,
      why: path,
    })
    const report = {
      candidates: [
        candidate('src/pipeline/integration.ts', 'owner'),
        candidate('src/pipeline/index.ts', 'supporting'),
        candidate('src/pipeline/resources.ts', 'supporting'),
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['pipeline'],
      uncertainty: ['none'],
    }
    const preliminary = {
      ...report,
      candidates: [...report.candidates, candidate('src/pipeline/authorization.ts', 'implementation')],
    }

    const completed = __testEnsureFeatureFrontierCandidates(report, preliminary, 'Support a new proxy integration feature')

    expect(completed.candidates.map(item => item.path)).toEqual([
      'src/pipeline/integration.ts',
      'src/pipeline/authorization.ts',
      'src/pipeline/index.ts',
      'src/pipeline/resources.ts',
    ])
  })
})
