import { describe, expect, it, vi } from 'vitest'
import type { FastContextScanHit } from './fastContextTypes'
import type { ToolExecutor } from '../tools/executor'
import { buildFastContextRetrievalPrimer, __testFirstPartyImportPatterns, __testImplementationStem, __testSelectPrimerContentPatterns } from './fastContextRetrieval'
import {
  __testBuildEvidencePack,
  __testBuildRerankContext,
  __testMergeCodeMaps,
  __testRetrievalPrimerQueries,
  __testEnsureFeatureFrontierCandidates,
  __testSelectFrontierAuditPaths,
  __testShouldRequestSemanticFeedback,
  __testShouldAcceptSpeculativeJudge,
  __testShouldStartSpeculativeJudge,
  __testHasTaskSurfaceEvidence,
  __testIsActionableCensusPlanner,
  runFastContextSubagent,
} from './fastContextSubagent'

describe('FastContext retrieval', () => {
  it('lets only a high-confidence LLM census contract end dual planning early', () => {
    const result = (confidence: number, role: 'anchor' | 'example') => ({
      ok: true,
      elapsedMs: 10,
      plan: {
        taskShape: 'repository-census' as const,
        confidence,
        needsFeedback: false,
        symbols: [],
        semanticQueries: [],
        filenameGlobs: [],
        subsystemHints: [],
        frontierRoles: [],
        frontierSearches: [],
        censusSearches: [{ role, mode: 'literal' as const, query: 'legacyClient' }],
        editableExtensions: ['ts'],
        rationale: 'Repeated API migration.',
      },
    })

    expect(__testIsActionableCensusPlanner(result(0.82, 'anchor'))).toBe(true)
    expect(__testIsActionableCensusPlanner(result(0.7, 'anchor'))).toBe(false)
    expect(__testIsActionableCensusPlanner(result(0.9, 'example'))).toBe(false)
  })

  it('starts speculative judgment only for compact high-confidence direct defects', () => {
    expect(__testShouldStartSpeculativeJudge({
      objective: 'Crash when parseConfig receives an empty value',
      primerConfidence: 0.9,
      evidenceCount: 2,
    })).toBe(true)
    expect(__testShouldStartSpeculativeJudge({
      objective: 'Add a user management page',
      primerConfidence: 0.95,
      evidenceCount: 2,
    })).toBe(false)
    expect(__testShouldStartSpeculativeJudge({
      objective: 'Fix format for every @Description value',
      primerConfidence: 0.95,
      evidenceCount: 2,
    })).toBe(false)
  })

  it('recognizes when a requested UI surface is already read-confirmed', () => {
    const evidence = [
      'web/user-manage.html',
      'web/UserController.js',
      'src/UserController.java',
      'src/UserService.java',
      'src/UserPO.java',
      'web/i18n/en.json',
    ].map(path => ({ path, startLine: 1, endLine: 20, preview: path, reason: 'file read' }))

    expect(__testHasTaskSurfaceEvidence('Add a user management page with an Edit button', evidence)).toBe(true)
    expect(__testHasTaskSurfaceEvidence('Fix database transaction retries', evidence)).toBe(false)
  })

  it('requests serial semantic feedback only when first-pass evidence is scarce', () => {
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 0,
      plannedEvidenceCount: 0,
      plannedConfidence: 0.8,
      needsFeedback: false,
    })).toBe(true)
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 0,
      plannedEvidenceCount: 1,
      plannedConfidence: 0.4,
      needsFeedback: true,
    })).toBe(true)
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 1,
      plannedEvidenceCount: 1,
      plannedConfidence: 0.3,
      needsFeedback: true,
    })).toBe(false)
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 0,
      plannedEvidenceCount: 1,
      plannedConfidence: 0.7,
      needsFeedback: true,
    })).toBe(false)
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 2,
      plannedEvidenceCount: 8,
      plannedConfidence: 0.8,
      needsFeedback: true,
      taskShape: 'cross-boundary',
      frontierExpected: 4,
      frontierCoverage: 0.5,
    })).toBe(false)
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 2,
      plannedEvidenceCount: 8,
      plannedConfidence: 0.8,
      needsFeedback: true,
      taskShape: 'cross-boundary',
      frontierExpected: 4,
      frontierCoverage: 0.25,
    })).toBe(true)
    expect(__testShouldRequestSemanticFeedback({
      exactEvidenceCount: 2,
      plannedEvidenceCount: 8,
      plannedConfidence: 0.8,
      needsFeedback: true,
      taskShape: 'cross-boundary',
      frontierExpected: 4,
      frontierCoverage: 0.75,
    })).toBe(false)
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
      'repository census inspected 18/40 candidate file(s)',
    )

    expect(pack).toContain('authority: llm_verified_code_map')
    expect(pack).toContain('llm_ranked_code_map:')
    expect(pack).toContain('src/llm.ts L20-L40')
    expect(pack).toContain('coverage: repository census inspected 18/40 candidate file(s)')
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

  it('accepts speculative judgment only for a proven direct owner', () => {
    const codeMap = {
      candidates: [
        { path: 'src/owner.ts', startLine: 4, endLine: 18, role: 'runtime owner', editKind: 'owner' as const, confidence: 'high' as const, why: 'directly mutates the state' },
        { path: 'src/wrapper.ts', startLine: 1, endLine: 3, role: 'caller', editKind: 'consumer' as const, confidence: 'medium' as const, why: 'forwards the request' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['exact symbol'],
      uncertainty: ['none'],
    }

    expect(__testShouldAcceptSpeculativeJudge({
      primerConfidence: 0.9,
      plan: { taskShape: 'direct-owner', confidence: 0.86, needsFeedback: false },
      codeMap,
      readPaths: ['src/owner.ts', 'src/wrapper.ts'],
    })).toBe(true)
    expect(__testShouldAcceptSpeculativeJudge({
      primerConfidence: 0.9,
      codeMap,
      readPaths: ['src/owner.ts', 'src/wrapper.ts'],
    })).toBe(true)
    expect(__testShouldAcceptSpeculativeJudge({
      primerConfidence: 0.7,
      codeMap,
      readPaths: ['src/owner.ts'],
    })).toBe(true)
    expect(__testShouldAcceptSpeculativeJudge({
      primerConfidence: 0.9,
      codeMap: {
        ...codeMap,
        candidates: [{ ...codeMap.candidates[0], confidence: 'medium' as const }],
      },
      readPaths: ['src/owner.ts'],
    })).toBe(true)
    expect(__testShouldAcceptSpeculativeJudge({
      primerConfidence: 0.7,
      codeMap: {
        ...codeMap,
        candidates: [{ ...codeMap.candidates[0], confidence: 'medium' as const }],
      },
      readPaths: ['src/owner.ts'],
    })).toBe(false)
  })

  it('continues semantic retrieval when ownership or frontier remains uncertain', () => {
    const codeMap = {
      candidates: [
        { path: 'src/consumer.ts', startLine: 4, endLine: 18, role: 'symptom consumer', editKind: 'consumer' as const, confidence: 'high' as const, why: 'shows stale state' },
      ],
      relationships: [],
      rejectedHypotheses: [],
      searchesTried: ['state read'],
      uncertainty: ['state writer has not been traced'],
    }

    expect(__testShouldAcceptSpeculativeJudge({
      primerConfidence: 0.9,
      plan: { taskShape: 'indirect-owner', confidence: 0.9, needsFeedback: true },
      codeMap,
      readPaths: ['src/consumer.ts'],
    })).toBe(false)
  })

  it('derives exact symbol and compact filename variants for the local primer', () => {
    const queries = __testRetrievalPrimerQueries('Cursor groups + Word wrap\nCheckboxInput calls get_context')

    expect(queries.symbols).toContain('CheckboxInput')
    expect(queries.symbols).toContain('get_context')
    expect(queries.filePatterns).toContain('**/*cursor*group*.*')
    expect(queries.contentPatterns).toContain('cursor[\\s_.-]*group')
  })

  it('prioritizes title entities and case-flexible architecture-role filenames', () => {
    const queries = __testRetrievalPrimerQueries('Add the starts_with function to determine whether a string starts with a pattern\nposition(path) = 1')

    expect(queries.symbols.slice(0, 2)).toEqual(['startsWith', 'starts_with'])
    expect(queries.filePatterns).toContain('**/*[sS]tring*[fF]unction*.*')
    expect(__testSelectPrimerContentPatterns(queries).slice(0, 2)).toEqual(['startsWith', 'starts_with'])
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

  it('resolves relative Python imports from newly read pipeline files', () => {
    const patterns = __testFirstPartyImportPatterns([{
      path: 'src/transformers/pipelines/zero_shot_object_detection.py',
      startLine: 1,
      endLine: 40,
      preview: 'from .pt_utils import PipelineIterator',
      content: 'from .pt_utils import PipelineIterator\nPipelineIterator(items)',
      reason: 'file read',
    }], [
      'src/transformers/pipelines/zero_shot_object_detection.py',
      'src/transformers/pipelines/pt_utils.py',
    ])

    expect(patterns).toContain('src/transformers/pipelines/pt_utils.py')
  })

  it('resolves Java imports into repository source paths', () => {
    const patterns = __testFirstPartyImportPatterns([{
      path: 'apollo-portal/src/main/java/com/example/UserController.java',
      startLine: 1,
      endLine: 40,
      preview: 'import com.example.repository.UserRepository;',
      content: 'import com.example.repository.UserRepository;\nprivate UserRepository repository;',
      reason: 'file read',
    }], [
      'apollo-portal/src/main/java/com/example/UserController.java',
      'apollo-portal/src/main/java/com/example/repository/UserRepository.java',
    ])

    expect(patterns).toContain('apollo-portal/src/main/java/com/example/repository/UserRepository.java')
  })

  it('includes HTML and JSON surfaces in the deterministic source primer', async () => {
    let sourceGlob = ''
    const executor = {
      searchContentPage: vi.fn(async (_pattern: string, _path: string, filePattern: string) => {
        sourceGlob = filePattern
        return {
          success: true,
          data: { hits: [
            { file: 'C:/repo/web/user-manage.html', line: 8, text: 'user management' },
            { file: 'C:/repo/web/i18n/en.json', line: 4, text: '"users": "Users"' },
          ] },
        }
      }),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: { content: `content for ${path}`, startLine: 1, endLine: 20, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const primer = await buildFastContextRetrievalPrimer({
      workspacePath: 'C:/repo',
      objective: 'Add a user management page and translated labels',
      toolExecutor: executor,
      budget: 'lean',
    })

    expect(sourceGlob).toContain('html')
    expect(sourceGlob).toContain('json')
    expect(primer.seedEvidence.map(item => item.path)).toEqual(expect.arrayContaining([
      'web/user-manage.html',
      'web/i18n/en.json',
    ]))
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
