import { describe, expect, it } from 'vitest'
import type { FastContextScanEvent } from '../../../core/fastContextTypes'
import { createFastContextUiSummary, reduceFastContextUiSummary } from './fastContextUi'
import { projectFastContextStage } from './fastContextStageModel'

describe('FastContext sidebar stage projection', () => {
  it('turns every FastContext event family into a readable flow trace', () => {
    const events: FastContextScanEvent[] = [
      { type: 'phase', phase: 'mapping', wave: 1, maxWaves: 4, insight: 'mapping owners' },
      { type: 'worker', id: 'worker-1', label: 'controller', status: 'running', currentPath: 'src/core/gitService.ts' },
      { type: 'file', path: 'src/core/gitService.ts', status: 'reading' },
      { type: 'file', path: 'src/core/gitService.ts', status: 'absorbed', kind: 'implementation' },
      { type: 'hit', hit: { path: 'src/core/gitService.ts', line: 120, startLine: 120, endLine: 180, preview: 'code', kind: 'root_cause' } },
      { type: 'progress', files: 4, absorbed: 1, hits: 1, latest: 'src/core/gitService.ts' },
      { type: 'insight', text: 'expanding callers before ranking', tone: 'info' },
      { type: 'wave_metrics', turn: 1, calls: 5, modelElapsedMs: 2000, toolElapsedMs: 2200, totalElapsedMs: 4200, inputTokens: 1200, outputTokens: 310, cacheReadTokens: 0 },
    ]
    const summary = reduceFastContextUiSummary(createFastContextUiSummary(), events)
    const model = projectFastContextStage(events, summary, 20)

    expect(model.trace.map(entry => entry.label)).toEqual([
      'PHASE',
      'WORKER',
      'READ',
      'ABSORB',
      'EVIDENCE',
      'PROGRESS',
      'INSIGHT',
      'TURN 1',
    ])
    expect(model.trace.at(-1)?.detail).toBe('5 calls - 4.2s - 310 out')
    expect(model.currentTarget).toBe('src/core/gitService.ts')
    expect(model.stageIndex).toBe(1)
    expect(model.activeWorkers).toHaveLength(1)
  })

  it('updates workers and maps completion to the synthesis stage', () => {
    const events: FastContextScanEvent[] = [
      { type: 'worker', id: 'worker-1', label: 'controller', status: 'running', currentPath: 'src/a.ts', hitCount: 1 },
      { type: 'worker', id: 'worker-1', label: 'controller', status: 'completed', scannedCount: 3, hitCount: 2 },
      { type: 'phase', phase: 'completed', wave: 2, maxWaves: 4 },
    ]
    const summary = reduceFastContextUiSummary(createFastContextUiSummary(), events)
    const model = projectFastContextStage(events, summary)

    expect(model.activeWorkers).toEqual([])
    expect(model.stageIndex).toBe(3)
    expect(model.phaseLabel).toBe('COMPLETE')
  })

  it('keeps only the configured recent trace window', () => {
    const events: FastContextScanEvent[] = Array.from({ length: 12 }, (_, index) => ({
      type: 'insight',
      text: `step ${index}`,
      tone: 'info',
    }))
    const summary = reduceFastContextUiSummary(createFastContextUiSummary(), events)
    const model = projectFastContextStage(events, summary, 4)

    expect(model.trace).toHaveLength(4)
    expect(model.trace.map(entry => entry.detail)).toEqual(['step 8', 'step 9', 'step 10', 'step 11'])
  })
})
