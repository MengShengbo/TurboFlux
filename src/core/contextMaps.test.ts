import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import { buildContextMapsPrimer, compactContextMapQuery, scoreContextMap } from './contextMaps'

const graphMap = [{
  id: 'run',
  kind: 'symbol' as const,
  title: 'runWorkflow',
  summary: 'function runWorkflow()',
  path: 'src/workflow.ts',
  line: 10,
  startLine: 10,
  endLine: 20,
  score: 1,
  children: [{
    id: 'load',
    kind: 'symbol' as const,
    title: 'loadWorkspace',
    summary: '[callee] function loadWorkspace()',
    path: 'src/workspace.ts',
    line: 4,
    startLine: 4,
    endLine: 8,
    score: 0,
    children: [],
  }],
}]

describe('ContextMaps', () => {
  it('keeps graph queries bounded to title entities', () => {
    const query = compactContextMapQuery(`BooleanOutputParser expected output error
${'long reproduction log '.repeat(200)}`)

    expect(query).toContain('BooleanOutputParser')
    expect(query).not.toContain('reproduction')
    expect(query.split(' ').length).toBeLessThanOrEqual(12)
  })

  it('scores symbol anchors and call relationships without repository-specific rules', () => {
    const score = scoreContextMap(graphMap, 'trace runWorkflow into loadWorkspace')

    expect(score.nodes).toBe(2)
    expect(score.relationships).toBe(1)
    expect(score.paths).toBe(2)
    expect(score.confidence).toBeGreaterThanOrEqual(0.55)
  })

  it('does not enable a single lexical graph anchor without a relationship', async () => {
    const result = await buildContextMapsPrimer({
      workspacePath: 'C:/repo',
      objective: 'trace runWorkflow',
      query: 'runWorkflow',
      toolExecutor: {
        getCodeMap: vi.fn(async () => ({
          success: true,
          data: {
            map: [{ ...graphMap[0], children: [] }],
            source: 'graph',
          },
        })),
      } as unknown as ToolExecutor,
    })

    expect(result.status).toBe('unavailable')
  })

  it('accepts only graph-backed maps and labels them as hypotheses', async () => {
    const getCodeMap = vi.fn(async () => ({ success: true, data: { map: graphMap, source: 'graph' } }))
    const result = await buildContextMapsPrimer({
      workspacePath: 'C:/repo',
      objective: 'trace runWorkflow into loadWorkspace',
      query: 'runWorkflow loadWorkspace',
      toolExecutor: { getCodeMap } as unknown as ToolExecutor,
    })

    expect(result.status).toBe('on')
    expect(result.primer?.text).toContain('authority="static_graph_hypotheses"')
    expect(result.primer?.text).toContain('src/workflow.ts:10')
    expect(result.primer?.candidates).toEqual([
      { path: 'src/workflow.ts', startLine: 10, endLine: 20 },
      { path: 'src/workspace.ts', startLine: 4, endLine: 8 },
    ])
    expect(getCodeMap).toHaveBeenCalledWith(expect.objectContaining({
      query: 'runWorkflow loadWorkspace',
      depth: 2,
      maxPaths: 8,
      graphOnly: true,
      preferGraph: true,
    }))
  })

  it('does not enable for filesystem fallback maps', async () => {
    const result = await buildContextMapsPrimer({
      workspacePath: 'C:/repo',
      objective: 'trace workflow',
      toolExecutor: {
        getCodeMap: vi.fn(async () => ({ success: true, data: { map: graphMap, source: 'filesystem' } })),
      } as unknown as ToolExecutor,
    })

    expect(result.status).toBe('unavailable')
    expect(result.primer).toBeUndefined()
  })
})
