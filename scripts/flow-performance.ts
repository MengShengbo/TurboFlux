import { performance } from 'node:perf_hooks'
import { AdaptiveStreamScheduler } from '../src/cli/state/adaptiveStreamScheduler'
import { FlowEventFactory, type AnyFlowEvent } from '../src/shared/flowEvents'
import { createThreadFlowState, reduceFlowEvent } from '../src/cli/state/flowReducer'
import { projectTranscriptCellWindow, describeTranscriptCells } from '../src/cli/components/transcriptWindowing'
import { formatMarkdown, getMarkdownCacheStats, resetMarkdownCache } from '../src/cli/components/markdown/index'
import { coalesceStreamingEntries } from '../src/cli/conversations/journalWriter'
import type { ConversationJournalEntry } from '../src/cli/conversations/types'
import type { Message } from '../src/cli/components/messages/Messages'

interface Distribution {
  p50: number
  p95: number
  p99: number
  max: number
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
}

function sample(iterations: number, operation: () => void): Distribution {
  for (let index = 0; index < 5; index += 1) operation()
  const durations: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    operation()
    durations.push(performance.now() - startedAt)
  }
  durations.sort((left, right) => left - right)
  return {
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    max: durations[durations.length - 1] ?? 0,
  }
}

function rounded(distribution: Distribution): Distribution {
  return Object.fromEntries(
    Object.entries(distribution).map(([key, value]) => [key, Number(value.toFixed(3))]),
  ) as unknown as Distribution
}

const transcriptResults: Record<string, Distribution & { mountedCells: number }> = {}
for (const cellCount of [1_000, 5_000, 10_000]) {
  const cells = Array.from({ length: cellCount }, (_, index) => ({ id: `cell-${index}`, estimatedRows: 2 }))
  const projected = projectTranscriptCellWindow(cells, {}, 50, 0, 12)
  transcriptResults[String(cellCount)] = {
    ...rounded(sample(100, () => {
      projectTranscriptCellWindow(cells, {}, 50, 0, 12)
    })),
    mountedCells: projected.endIndex - projected.startIndex,
  }
}

const resizeMessages: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `message-${index}`,
  role: 'assistant',
  content: `row ${index} ${'value '.repeat(12)}`,
}))
const resizeDistribution = rounded(sample(20, () => {
  describeTranscriptCells(resizeMessages, 80)
  describeTranscriptCells(resizeMessages, 160)
}))

let reducerState = createThreadFlowState('perf-thread', 'perf-thread')
let sequence = 0
const eventFactory = new FlowEventFactory(() => ++sequence, () => `event-${sequence}`)
const reducerStartedAt = performance.now()
for (let index = 0; index < 10_000; index += 1) {
  reducerState = reduceFlowEvent(reducerState, eventFactory.create({
    sessionId: 'perf-thread',
    threadId: 'perf-thread',
    type: 'input.draft_changed',
    payload: { text: '', attachmentIds: [] },
  }) as AnyFlowEvent)
}
const reducerTenThousandMs = performance.now() - reducerStartedAt

resetMarkdownCache()
const markdownSources = Array.from({ length: 100 }, (_, index) =>
  `## Result ${index}\n\n- ${'cached markdown '.repeat(20)}\n\n\`code-${index}\``,
)
for (const source of markdownSources) formatMarkdown(source)
for (let repeat = 0; repeat < 9; repeat += 1) {
  for (const source of markdownSources) formatMarkdown(source)
}
const markdownStats = getMarkdownCacheStats()

let flushedDepth = 0
const scheduler = new AdaptiveStreamScheduler(batch => {
  flushedDepth = batch.depth
})
const schedulerStartedAt = performance.now()
for (let index = 0; index < 1_000; index += 1) scheduler.enqueue(8)
scheduler.flushNow()
const schedulerBurstMs = performance.now() - schedulerStartedAt

const journalEntries: ConversationJournalEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
  version: 1,
  type: 'stream_delta',
  timestamp: index,
  text: 'x'.repeat(100),
}))
const journalDistribution = rounded(sample(100, () => {
  coalesceStreamingEntries(journalEntries)
}))

const results = {
  schemaVersion: 1,
  platform: process.platform,
  node: process.version,
  transcriptProjectionMs: transcriptResults,
  resize80To160Ms: resizeDistribution,
  reducerTenThousandMs: Number(reducerTenThousandMs.toFixed(3)),
  markdownCache: markdownStats,
  streamBurst: {
    enqueueAndFlushMs: Number(schedulerBurstMs.toFixed(3)),
    coalescedDepth: flushedDepth,
    frameCoalescingRatio: flushedDepth,
  },
  journalCoalescingMs: journalDistribution,
}

const failures: string[] = []
if (transcriptResults['10000']!.p95 > 50) failures.push('10k transcript projection p95 exceeds 50ms')
if (transcriptResults['10000']!.mountedCells > 100) failures.push('10k transcript mounts more than 100 cells')
if (resizeDistribution.p95 > 500) failures.push('80/160 column resize projection p95 exceeds 500ms')
if (reducerTenThousandMs > 1_000) failures.push('10k reducer events exceed 1000ms')
if (markdownStats.hitRate < 0.85) failures.push('Markdown cache hit rate is below 85%')
if (schedulerBurstMs > 250 || flushedDepth !== 1_000) failures.push('stream burst coalescing gate failed')
if (journalDistribution.p95 > 50) failures.push('100KB journal coalescing p95 exceeds 50ms')

console.log(JSON.stringify({ ...results, gate: { passed: failures.length === 0, failures } }, null, 2))
if (failures.length > 0) process.exitCode = 1
