import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import {
  executeFastContextQueryPlan,
  mergeFastContextQueryPlans,
  parseFastContextQueryPlan,
  planFastContextQueries,
  __testLiteralPattern,
  __testClearFastContextPlannerCache,
  type FastContextQueryPlan,
} from './fastContextPlanner'

const plan: FastContextQueryPlan = {
  taskShape: 'indirect-owner',
  confidence: 0.72,
  needsFeedback: true,
  symbols: ['MockObject'],
  semanticQueries: ['autodoc mocked base class'],
  filenameGlobs: ['**/*[mM]ock*.*'],
  subsystemHints: ['sphinx/ext/autodoc'],
  frontierRoles: ['mock', 'config'],
  frontierSearches: [],
  editableExtensions: ['py', 'yaml'],
  rationale: 'Trace mocked inheritance metadata into autodoc rendering.',
}

describe('FastContext semantic planner', () => {
  it('keeps Unicode query terms when building local search patterns', () => {
    const pattern = __testLiteralPattern('界面 加载动画')

    expect(pattern).toContain('界面')
    expect(pattern).toContain('加载动画')
  })

  it('parses fenced planner JSON and bounds every field', () => {
    const parsed = parseFastContextQueryPlan(`result:\n\`\`\`json\n${JSON.stringify({
      ...plan,
      semanticQueries: Array.from({ length: 20 }, (_, index) => `query ${index}`),
      confidence: 4,
    })}\n\`\`\``)

    expect(parsed).toMatchObject({ taskShape: 'indirect-owner', confidence: 1, needsFeedback: true })
    expect(parsed?.semanticQueries).toHaveLength(8)
  })

  it('ignores unrelated JSON objects around the planner payload', () => {
    const parsed = parseFastContextQueryPlan(`metadata: {"request":"ok"}\nplan: ${JSON.stringify(plan)}\nend`)

    expect(parsed).toMatchObject({ taskShape: 'indirect-owner', symbols: ['MockObject'] })
  })

  it('parses bounded structured frontier searches', () => {
    const parsed = parseFastContextQueryPlan(JSON.stringify({
      ...plan,
      taskShape: 'cross-boundary',
      frontierSearches: [{
        role: 'server capability',
        query: 'AuthType route',
        symbols: ['AuthType'],
        filenameGlobs: ['src/node/routes/**/*'],
        subsystemHints: ['src/node'],
      }],
    }))

    expect(parsed?.frontierSearches).toEqual([{
      role: 'server capability',
      query: 'AuthType route',
      symbols: ['AuthType'],
      filenameGlobs: ['src/node/routes/**/*'],
      subsystemHints: ['src/node'],
    }])
  })

  it('parses repository-wide census plans without inventing ownership frontiers', () => {
    const parsed = parseFastContextQueryPlan(JSON.stringify({
      ...plan,
      taskShape: 'repository-census',
      symbols: ['Description'],
      semanticQueries: ['@Description'],
      frontierSearches: [],
      censusSearches: [
        { role: 'anchor', mode: 'literal', query: '@Description' },
        { role: 'violation', mode: 'regex', query: '@Description\\s*\\(\\s*"[a-z]', caseSensitive: true, fileGlob: '**/*.java' },
      ],
    }))

    expect(parsed?.taskShape).toBe('repository-census')
    expect(parsed?.semanticQueries).toContain('@Description')
    expect(parsed?.censusSearches).toEqual([
      { role: 'anchor', mode: 'literal', query: '@Description', caseSensitive: false, multiline: false },
      { role: 'violation', mode: 'regex', query: '@Description\\s*\\(\\s*"[a-z]', caseSensitive: true, multiline: false, fileGlob: '**/*.java' },
    ])
  })

  it('runs the planner as a one-shot model task without exposing tools', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(plan) } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const result = await planFastContextQueries({
        objective: 'mocked inherited classes render incorrectly',
        workspacePath: 'C:/repo',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      })

      expect(result.ok).toBe(true)
      expect(result.plan.semanticQueries).toContain('autodoc mocked base class')
      expect(requestBody?.tools).toBeUndefined()
      expect(JSON.stringify(requestBody?.messages)).toContain('Return JSON only')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reuses a successful planner result for the same workspace objective', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      __testClearFastContextPlannerCache()
      const params = {
        objective: 'planner cache unique objective',
        workspacePath: 'C:/cache-test',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://example.test',
        model: 'test-model',
      }
      const first = await planFastContextQueries(params)
      const second = await planFastContextQueries(params)

      expect(first.ok).toBe(true)
      expect(second).toMatchObject({ ok: true, cacheHit: true, elapsedMs: 0 })
      expect(calls).toBe(1)
    } finally {
      __testClearFastContextPlannerCache()
      globalThis.fetch = originalFetch
    }
  })

  it('keeps a shared planner alive until its final subscriber cancels', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    let fetchSignal: AbortSignal | undefined
    let resolveFetch: ((response: Response) => void) | undefined
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      fetchSignal = init?.signal || undefined
      return new Promise<Response>(resolve => { resolveFetch = resolve })
    }) as unknown as typeof fetch

    try {
      __testClearFastContextPlannerCache()
      const firstController = new AbortController()
      const secondController = new AbortController()
      const params = {
        objective: 'shared planner cancellation objective',
        workspacePath: 'C:/shared-planner-test',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://shared-planner.test',
        model: 'test-model',
      }
      const first = planFastContextQueries({ ...params, abortSignal: firstController.signal })
      const firstOutcome = first.catch(error => error)
      const second = planFastContextQueries({ ...params, abortSignal: secondController.signal })

      firstController.abort()
      expect((await firstOutcome).name).toBe('AbortError')
      expect(fetchSignal?.aborted).toBe(false)

      resolveFetch?.(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 }))
      await expect(second).resolves.toMatchObject({ ok: true, cacheHit: true })
      expect(calls).toBe(1)
    } finally {
      __testClearFastContextPlannerCache()
      globalThis.fetch = originalFetch
    }
  })

  it('aborts an in-flight planner when its final subscriber leaves', async () => {
    const originalFetch = globalThis.fetch
    let fetchAborted = false
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        fetchAborted = true
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as unknown as typeof fetch

    try {
      __testClearFastContextPlannerCache()
      const controller = new AbortController()
      const pending = planFastContextQueries({
        objective: 'orphan planner cancellation objective',
        workspacePath: 'C:/orphan-planner-test',
        toolExecutor: {} as ToolExecutor,
        apiKey: 'test',
        baseUrl: 'http://orphan-planner.test',
        model: 'test-model',
        abortSignal: controller.signal,
      })

      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchAborted).toBe(true)
    } finally {
      __testClearFastContextPlannerCache()
      globalThis.fetch = originalFetch
    }
  })

  it('interleaves independent owner and frontier plans without duplicating queries', () => {
    const merged = mergeFastContextQueryPlans(plan, {
      ...plan,
      taskShape: 'cross-boundary',
      confidence: 0.84,
      symbols: ['ConfigLoader', 'MockObject'],
      semanticQueries: ['configuration propagation', 'autodoc mocked base class'],
      filenameGlobs: ['**/*config*.*'],
      subsystemHints: ['sphinx/config'],
      frontierRoles: ['transport', 'renderer'],
      frontierSearches: [{
        role: 'configuration',
        query: 'config propagation',
        symbols: ['ConfigLoader'],
        filenameGlobs: ['**/*config*.*'],
        subsystemHints: ['sphinx/config'],
      }],
      rationale: 'Trace configuration into the runtime consumer.',
    })

    expect(merged.taskShape).toBe('cross-boundary')
    expect(merged.confidence).toBeCloseTo(0.78)
    expect(merged.semanticQueries).toEqual([
      'autodoc mocked base class',
      'configuration propagation',
    ])
    expect(merged.symbols).toEqual(['MockObject', 'ConfigLoader'])
    expect(merged.frontierRoles).toEqual(['mock', 'transport', 'config', 'renderer'])
    expect(merged.frontierSearches).toHaveLength(1)
  })

  it('does not let one planner escalate a direct owner into a multi-frontier cascade', () => {
    const merged = mergeFastContextQueryPlans({ ...plan, taskShape: 'direct-owner' }, {
      ...plan,
      taskShape: 'multi-frontier',
      frontierSearches: Array.from({ length: 6 }, (_, index) => ({
        role: `boundary ${index}`,
        query: `query ${index}`,
        symbols: [],
        filenameGlobs: [],
        subsystemHints: [],
      })),
    })

    expect(merged.taskShape).toBe('cross-boundary')
    expect(merged.frontierSearches).toHaveLength(4)
  })

  it('requires a concrete high-confidence contract before switching one-sided plans to census mode', () => {
    const weak = mergeFastContextQueryPlans(plan, {
      ...plan,
      taskShape: 'repository-census',
      confidence: 0.6,
      censusSearches: [],
    })
    const grounded = mergeFastContextQueryPlans(plan, {
      ...plan,
      taskShape: 'repository-census',
      confidence: 0.84,
      censusSearches: [{ role: 'anchor', mode: 'literal', query: 'legacyClient' }],
    })

    expect(weak.taskShape).toBe('cross-boundary')
    expect(grounded.taskShape).toBe('repository-census')
  })

  it('executes semantic code and configuration lanes with read confirmation', async () => {
    const executor = {
      searchContentPage: vi.fn(async () => ({
        success: true,
        data: {
          hits: [
            { file: 'C:/repo/sphinx/ext/autodoc/mock.py', line: 24, text: 'class _MockObject:' },
            { file: 'C:/repo/.config.yaml', line: 3, text: 'autodoc_mock_imports:' },
          ],
        },
      })),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: ['C:/repo/sphinx/ext/autodoc/mock.py'] } })),
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: { content: `source for ${path}`, startLine: 1, endLine: 20, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({ workspacePath: 'C:/repo', toolExecutor: executor, plan })

    expect(result.seedEvidence.map(item => item.path)).toEqual(expect.arrayContaining([
      'sphinx/ext/autodoc/mock.py',
      '.config.yaml',
    ]))
    expect(result.seedEvidence.every(item => item.reason === 'file read')).toBe(true)
    expect(result.calls).toBeGreaterThan(result.readCalls)
  })

  it('uses model-proposed editable extensions in content search and reads', async () => {
    let filePattern = ''
    const executor = {
      searchContentPage: vi.fn(async (_pattern: string, _path: string, pattern: string) => {
        filePattern = pattern
        return { success: true, data: { hits: [{ file: 'C:/repo/policy/main.rego', line: 12, text: 'allow {' }] } }
      }),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async () => ({
        success: true,
        data: { content: 'allow {}', startLine: 1, endLine: 20, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: { ...plan, editableExtensions: ['rego'] },
    })

    expect(filePattern).toContain('rego')
    expect(result.seedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'policy/main.rego' })]))
  })

  it('reserves read evidence for each structured cross-boundary frontier', async () => {
    const executor = {
      searchContentPage: vi.fn(async (pattern: string) => {
        const hit = pattern.includes('AuthType')
          ? { file: 'C:/repo/src/node/routes/index.ts', line: 40, text: 'const authType = AuthType.None' }
          : pattern.includes('ipc')
            ? { file: 'C:/repo/typings/ipc.d.ts', line: 18, text: 'authType: AuthType' }
            : { file: 'C:/repo/lib/vscode/src/vs/workbench/browser/parts/titlebar/menubarControl.ts', line: 90, text: 'logout menu action' }
        return { success: true, data: { hits: [hit] } }
      }),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async (path: string, offset: number) => ({
        success: true,
        data: { content: `source for ${path}`, startLine: offset + 1, endLine: offset + 20, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: {
        ...plan,
        taskShape: 'cross-boundary',
        symbols: [],
        semanticQueries: [],
        filenameGlobs: [],
        frontierSearches: [
          { role: 'server capability', query: 'AuthType route', symbols: [], filenameGlobs: [], subsystemHints: ['src/node'] },
          { role: 'IPC propagation', query: 'ipc authType', symbols: [], filenameGlobs: [], subsystemHints: ['typings'] },
          { role: 'UI consumer', query: 'logout menu', symbols: [], filenameGlobs: [], subsystemHints: ['workbench'] },
        ],
      },
    })

    expect(result.frontierCoverage).toBe(1)
    expect(result.seedEvidence.map(item => item.path)).toEqual(expect.arrayContaining([
      'src/node/routes/index.ts',
      'typings/ipc.d.ts',
      'lib/vscode/src/vs/workbench/browser/parts/titlebar/menubarControl.ts',
    ]))
  })

  it('counts a read-confirmed frontier query even when a guessed subsystem hint is wrong', async () => {
    const executor = {
      searchContentPage: vi.fn(async () => ({
        success: true,
        data: { hits: [{ file: 'C:/repo/src/runtime/owner.ts', line: 20, text: 'applyBoundaryState()' }] },
      })),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async () => ({
        success: true,
        data: { content: 'applyBoundaryState()', startLine: 1, endLine: 40, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: {
        ...plan,
        taskShape: 'cross-boundary',
        symbols: [],
        semanticQueries: [],
        filenameGlobs: [],
        frontierSearches: [{
          role: 'runtime boundary',
          query: 'applyBoundaryState',
          symbols: [],
          filenameGlobs: [],
          subsystemHints: ['wrong/subsystem'],
        }],
      },
    })

    expect(result.frontierCovered).toBe(1)
    expect(result.frontierCoverage).toBe(1)
  })

  it('caps broad repository census reads after combining all candidate lanes', async () => {
    const executor = {
      searchContentPage: vi.fn(async () => ({
        success: true,
        data: { hits: Array.from({ length: 80 }, (_, index) => ({
          file: `C:/repo/src/Function${index}.java`,
          line: 10,
          text: `@Description("lowercase description ${index}")`,
        })) },
      })),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: { content: `source for ${path}`, startLine: 1, endLine: 40, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: {
        ...plan,
        taskShape: 'repository-census',
        symbols: ['Description'],
        semanticQueries: ['@Description("[a-z]'],
        censusSearches: [{ role: 'violation', mode: 'regex', query: '@Description\\s*\\(\\s*"[a-z]' }],
        filenameGlobs: [],
        frontierSearches: [],
      },
    })

    expect(result.readCalls).toBe(40)
    expect(result.seedEvidence).toHaveLength(40)
    expect(executor.readFileRange).toHaveBeenCalledTimes(40)
    expect(result.census).toMatchObject({ candidateFiles: 80, directViolationFiles: 80, readFiles: 40, truncated: true })
  })

  it('uses a model-authored census contract for generic API migrations', async () => {
    const searched: Array<{ pattern: string; limit?: number }> = []
    const executor = {
      searchContentPage: vi.fn(async (pattern: string, _path: string, _glob: string, insensitive: boolean, options: { limit?: number }) => {
        searched.push({ pattern: `${pattern}:${insensitive}`, limit: options.limit })
        if (pattern === 'legacyClient\\.(?:send|request)\\s*\\(') {
          return { success: true, data: { hits: [
            { file: 'C:/repo/packages/api/client.ts', line: 31, text: 'legacyClient.send(payload)' },
            { file: 'C:/repo/services/worker/job.ts', line: 72, text: 'legacyClient.request(job)' },
          ] } }
        }
        return { success: true, data: { hits: [
          { file: 'C:/repo/docs/migration.md', line: 8, text: 'Use ModernClient instead of legacyClient' },
        ] } }
      }),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: { content: `source for ${path}`, startLine: 1, endLine: 90, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: {
        ...plan,
        taskShape: 'repository-census',
        symbols: [],
        semanticQueries: [],
        filenameGlobs: [],
        frontierSearches: [],
        censusSearches: [
          { role: 'violation', mode: 'regex', query: 'legacyClient\\.(?:send|request)\\s*\\(', caseSensitive: true },
          { role: 'example', mode: 'literal', query: 'ModernClient' },
        ],
      },
    })

    expect(searched[0]).toEqual({ pattern: 'legacyClient\\.(?:send|request)\\s*\\(:false', limit: 500 })
    expect(result.seedEvidence.slice(0, 2).map(item => item.path)).toEqual([
      'packages/api/client.ts',
      'services/worker/job.ts',
    ])
    expect(result.census).toMatchObject({ candidateFiles: 3, directViolationFiles: 2, readFiles: 3, truncated: false })
    expect(result.text).toContain('violation/regex/case-sensitive: legacyClient\\.(?:send|request)\\s*\\(')
  })

  it('does not count one path as several independent frontier boundaries', async () => {
    const executor = {
      searchContentPage: vi.fn(async () => ({
        success: true,
        data: { hits: [{ file: 'C:/repo/src/shared.ts', line: 20, text: 'shared implementation' }] },
      })),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async () => ({
        success: true,
        data: { content: 'shared implementation', startLine: 1, endLine: 40, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: {
        ...plan,
        taskShape: 'cross-boundary',
        symbols: [],
        semanticQueries: [],
        filenameGlobs: [],
        frontierSearches: [
          { role: 'server', query: 'server state', symbols: [], filenameGlobs: [], subsystemHints: [] },
          { role: 'transport', query: 'transport state', symbols: [], filenameGlobs: [], subsystemHints: [] },
          { role: 'client', query: 'client state', symbols: [], filenameGlobs: [], subsystemHints: [] },
        ],
      },
    })

    expect(result.frontierExpected).toBe(3)
    expect(result.frontierCovered).toBe(1)
    expect(result.frontierCoverage).toBeCloseTo(1 / 3)
  })

  it('preserves exact symbol searches alongside a full semantic-query lane', async () => {
    const searchedPatterns: string[] = []
    const searchedGlobs: string[] = []
    const executor = {
      searchContentPage: vi.fn(async (pattern: string) => {
        searchedPatterns.push(pattern)
        return {
          success: true,
          data: {
            hits: pattern === 'PyLinter'
              ? [{ file: 'C:/repo/pylint/lint/pylinter.py', line: 80, text: 'class PyLinter:' }]
              : [],
          },
        }
      }),
      searchFiles: vi.fn(async (glob: string) => {
        searchedGlobs.push(glob)
        return {
          success: true,
          data: { matches: glob.includes('expand_modules') ? ['C:/repo/pylint/lint/expand_modules.py'] : [] },
        }
      }),
      readFileRange: vi.fn(async (path: string) => ({
        success: true,
        data: { content: `source for ${path}`, startLine: 1, endLine: 20, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan: {
        ...plan,
        semanticQueries: ['query one', 'query two', 'query three', 'query four'],
        symbols: ['expand_modules', 'Run', '_expand_files', 'PyLinter', 'ignore_patterns', 'is_ignored'],
      },
    })

    expect(searchedPatterns).toContain('expand_modules')
    expect(searchedPatterns).toContain('is_ignored')
    expect(searchedGlobs).toContain('**/*expand_modules*.*')
    expect(executor.readFileRange).toHaveBeenCalledWith('pylint/lint/expand_modules.py', expect.any(Number), 220, 96_000)
    expect(executor.readFileRange).toHaveBeenCalledWith('pylint/lint/pylinter.py', expect.any(Number), 220, 96_000)
  })

  it('does not reread a range already covered by the exact scout', async () => {
    const executor = {
      searchContentPage: vi.fn(async () => ({
        success: true,
        data: { hits: [{ file: 'C:/repo/sphinx/ext/autodoc/mock.py', line: 24, text: 'class _MockObject:' }] },
      })),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan,
      coveredEvidence: [{
        path: 'sphinx/ext/autodoc/mock.py',
        startLine: 1,
        endLine: 80,
        preview: 'covered',
        reason: 'file read',
      }],
    })

    expect(result.seedEvidence).toHaveLength(0)
    expect(executor.readFileRange).not.toHaveBeenCalled()
  })

  it('rereads a different range in a path covered by the exact scout', async () => {
    const executor = {
      searchContentPage: vi.fn(async () => ({
        success: true,
        data: { hits: [{ file: 'C:/repo/src/large.ts', line: 900, text: 'function trueOwner() {' }] },
      })),
      searchFiles: vi.fn(async () => ({ success: true, data: { matches: [] } })),
      readFileRange: vi.fn(async (_path: string, offset: number) => ({
        success: true,
        data: { content: 'function trueOwner() {}', startLine: offset + 1, endLine: offset + 20, truncated: false },
      })),
      readFile: vi.fn(),
    } as unknown as ToolExecutor

    const result = await executeFastContextQueryPlan({
      workspacePath: 'C:/repo',
      toolExecutor: executor,
      plan,
      coveredEvidence: [{
        path: 'src/large.ts',
        startLine: 1,
        endLine: 220,
        preview: 'header',
        reason: 'file read',
      }],
    })

    expect(result.seedEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/large.ts', startLine: 840 }),
    ]))
  })
})
