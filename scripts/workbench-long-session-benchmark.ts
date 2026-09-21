import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createEmptyConfig } from '@turboflux/models/config'
import type { AgentEventType } from '@turboflux/agent-runtime/agentEngine'
import type { ToolCall } from '@turboflux/contracts/agentTypes'
import { AgentFlowController } from '@turboflux/workbench/flow/agentFlowController'
import { WorkSession } from '@turboflux/workbench/work/workSession'
import { WorkbenchRuntime } from '@turboflux/workbench/workbench/workbenchRuntime'

interface BenchmarkOptions {
  name: string
  deltaCount: number
  toolCount: number
  serializeEvents: boolean
}

interface CapturedEventStats {
  counts: Record<string, number>
  bytes: Record<string, number>
  totalBytes: number
  maxEventBytes: number
}

interface ProjectionInternals {
  responseSequenceByRun: Map<string, number>
  responseTurnIds?: Map<string, string>
  toolPlacements: Map<string, unknown>
  pendingResponseChunks: Map<string, string[]>
}

interface RuntimeInternals {
  handleAgentEvent(event: AgentEventType): void
  activeConversationRuntime: {
    work: {
      log: { getEvents(): readonly unknown[] }
      projection: ProjectionInternals
      getSnapshot(): {
        window: { eventCount: number; hasMore: boolean }
        projection: { nodes: Readonly<Record<string, unknown>>; order: readonly string[] }
      }
    }
    flow: {
      startRun(objective: string, runId?: string): unknown
      store: {
        getSnapshot(): { threads: Record<string, unknown> }
      }
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonnegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function memorySnapshot() {
  const usage = process.memoryUsage()
  return { heapUsed: usage.heapUsed, rss: usage.rss, external: usage.external }
}

function memoryDelta(after: ReturnType<typeof memorySnapshot>, before: ReturnType<typeof memorySnapshot>) {
  return {
    heapUsed: after.heapUsed - before.heapUsed,
    rss: after.rss - before.rss,
    external: after.external - before.external,
  }
}

function forceGarbageCollection(): void {
  globalThis.gc?.()
  globalThis.gc?.()
}

function createCapture(serializeEvents: boolean): {
  stats: CapturedEventStats
  listener(event: { type: string }): void
} {
  const stats: CapturedEventStats = {
    counts: {},
    bytes: {},
    totalBytes: 0,
    maxEventBytes: 0,
  }
  return {
    stats,
    listener(event) {
      stats.counts[event.type] = (stats.counts[event.type] || 0) + 1
      if (!serializeEvents) return
      const byteLength = Buffer.byteLength(JSON.stringify(event))
      stats.bytes[event.type] = (stats.bytes[event.type] || 0) + byteLength
      stats.totalBytes += byteLength
      stats.maxEventBytes = Math.max(stats.maxEventBytes, byteLength)
    },
  }
}

function toolCalls(count: number): ToolCall[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `benchmark-tool-${index}`,
    name: index % 3 === 0 ? 'read_file' : index % 3 === 1 ? 'search_files' : 'run_command',
    arguments: {
      path: `src/benchmark-${index}.ts`,
      query: `benchmark-${index}`,
      command: `printf benchmark-${index}`,
    },
  }))
}

async function runBenchmark(options: BenchmarkOptions) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'turboflux-long-session-'))
  const runtime = new WorkbenchRuntime({
    workspacePath: temporaryRoot,
    storagePath: join(temporaryRoot, 'storage'),
    runtimeStoragePath: join(temporaryRoot, 'runtime'),
    config: {
      ...createEmptyConfig(),
      apiKey: 'benchmark-only',
      baseUrl: 'https://benchmark.invalid',
      model: 'benchmark-model',
    },
    connectMcp: false,
  })
  const internals = runtime as unknown as RuntimeInternals
  const handleAgentEvent = internals.handleAgentEvent.bind(runtime)
  const capture = createCapture(options.serializeEvents)
  const unsubscribe = runtime.subscribe(capture.listener)
  const answerChunks: string[] = []
  const thinkingChunks: string[] = []
  let peakHeapUsed = 0

  forceGarbageCollection()
  const memoryBefore = memorySnapshot()
  peakHeapUsed = memoryBefore.heapUsed
  const startedAt = performance.now()

  internals.activeConversationRuntime.flow.startRun('benchmark long session', 'benchmark-run')
  handleAgentEvent({ type: 'stream:start' })
  for (let index = 0; index < options.deltaCount; index += 1) {
    const text = `${index.toString(36).padStart(5, '0')}:delta;`
    if (index % 2 === 0) {
      thinkingChunks.push(text)
      handleAgentEvent({ type: 'stream:thinking_delta', text })
    } else {
      answerChunks.push(text)
      handleAgentEvent({ type: 'stream:delta', text })
    }
    if (index > 0 && index % 1_000 === 0) {
      peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed)
    }
  }
  handleAgentEvent({ type: 'stream:end' })

  const calls = toolCalls(options.toolCount)
  handleAgentEvent({
    type: 'turn:complete',
    turn: {
      id: 'benchmark-assistant-turn',
      role: 'assistant',
      content: answerChunks.join(''),
      timestamp: Date.now(),
      toolCalls: calls,
      metadata: {
        workRunId: 'benchmark-run',
        thinking: {
          content: thinkingChunks.join(''),
          source: 'provider',
          status: 'complete',
        },
      },
    },
  })

  for (let index = 0; index < calls.length; index += 1) {
    const toolCall = calls[index]!
    handleAgentEvent({ type: 'tool:call', toolCall })
    handleAgentEvent({
      type: 'tool:result',
      toolResult: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `completed:${index}:${'x'.repeat(192)}`,
        isError: false,
      },
    })
    if (index > 0 && index % 100 === 0) {
      peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed)
    }
  }
  handleAgentEvent({ type: 'session:complete', session: runtime.runtime.engine.getSession() })

  const processingMs = performance.now() - startedAt
  const snapshotStartedAt = performance.now()
  const snapshot = runtime.getSnapshot()
  const snapshotJson = JSON.stringify(snapshot)
  const snapshotMs = performance.now() - snapshotStartedAt
  peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed)

  forceGarbageCollection()
  const memoryAfter = memorySnapshot()
  const slot = internals.activeConversationRuntime
  const workSnapshot = slot.work.getSnapshot()
  const projection = slot.work.projection
  const result = {
    name: options.name,
    inputs: {
      deltaCount: options.deltaCount,
      deltaCharacters: answerChunks.join('').length + thinkingChunks.join('').length,
      toolCount: options.toolCount,
      serializeEvents: options.serializeEvents,
    },
    timingMs: {
      processing: Number(processingMs.toFixed(2)),
      finalSnapshot: Number(snapshotMs.toFixed(2)),
    },
    events: capture.stats,
    finalSnapshotBytes: Buffer.byteLength(snapshotJson),
    retainedMemoryBytes: memoryDelta(memoryAfter, memoryBefore),
    observedPeakHeapGrowthBytes: peakHeapUsed - memoryBefore.heapUsed,
    work: {
      nodes: workSnapshot.projection.order.length,
      eventWindowCount: workSnapshot.window.eventCount,
      eventWindowHasMore: workSnapshot.window.hasMore,
      backingEventArrayCount: slot.work.log.getEvents().length,
      responseSequenceEntries: projection.responseSequenceByRun.size,
      responseTurnEntries: projection.responseTurnIds?.size ?? 0,
      toolPlacementEntries: projection.toolPlacements.size,
      pendingResponseChannels: projection.pendingResponseChunks.size,
    },
    flowThreadCount: Object.keys(slot.flow.store.getSnapshot().threads).length,
  }

  unsubscribe()
  await runtime.destroy()
  rmSync(temporaryRoot, { recursive: true, force: true })
  return result
}

function auditProjectionRetention(runCount: number, toolsPerRun: number) {
  const session = new WorkSession('retention-session')
  const flow = new AgentFlowController('retention-session')
  const unsubscribe = flow.subscribe(event => { session.appendFlow(event) })
  const projection = session.projection as unknown as ProjectionInternals
  forceGarbageCollection()
  const memoryBefore = memorySnapshot()
  const startedAt = performance.now()

  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runId = `retention-run-${runIndex}`
    flow.startRun(`retention objective ${runIndex}`, runId)
    session.appendAgent({ type: 'stream:start' }, runIndex * 100 + 1)
    session.appendAgent({ type: 'stream:delta', text: `answer-${runIndex}` }, runIndex * 100 + 2)
    session.appendAgent({ type: 'stream:end' }, runIndex * 100 + 3)
    const calls = Array.from({ length: toolsPerRun }, (_, toolIndex): ToolCall => ({
      id: `retention-tool-${runIndex}-${toolIndex}`,
      name: 'read_file',
      arguments: { path: `src/${runIndex}-${toolIndex}.ts` },
    }))
    session.appendAgent({
      type: 'turn:complete',
      turn: {
        id: `retention-turn-${runIndex}`,
        role: 'assistant',
        content: `answer-${runIndex}`,
        timestamp: runIndex * 100 + 4,
        toolCalls: calls,
        metadata: { workRunId: runId },
      },
    }, runIndex * 100 + 4)
    calls.forEach((toolCall, toolIndex) => {
      session.appendAgent({ type: 'tool:call', toolCall }, runIndex * 100 + 5 + toolIndex * 2)
      session.appendAgent({
        type: 'tool:result',
        toolResult: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: 'ok',
          isError: false,
        },
      }, runIndex * 100 + 6 + toolIndex * 2)
    })
    flow.finishRun('succeeded')
  }

  const elapsedMs = performance.now() - startedAt
  const snapshot = session.getSnapshot()
  forceGarbageCollection()
  const memoryAfter = memorySnapshot()
  unsubscribe()
  return {
    runCount,
    toolsPerRun,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    retainedMemoryBytes: memoryDelta(memoryAfter, memoryBefore),
    nodes: snapshot.projection.order.length,
    eventWindowCount: snapshot.window.eventCount,
    eventWindowHasMore: snapshot.window.hasMore,
    responseSequenceEntries: projection.responseSequenceByRun.size,
    responseTurnEntries: projection.responseTurnIds?.size ?? 0,
    toolPlacementEntries: projection.toolPlacements.size,
    pendingResponseChannels: projection.pendingResponseChunks.size,
  }
}

const deltaCount = positiveInteger(process.env.TURBOFLUX_BENCH_DELTAS, 12_000)
const toolCount = nonnegativeInteger(process.env.TURBOFLUX_BENCH_TOOLS, 400)
const serializeEvents = process.env.TURBOFLUX_BENCH_SERIALIZE !== '0'
const retentionRuns = nonnegativeInteger(process.env.TURBOFLUX_BENCH_RETENTION_RUNS, 0)
const retentionToolsPerRun = nonnegativeInteger(process.env.TURBOFLUX_BENCH_RETENTION_TOOLS, 2)

const runtime = await runBenchmark({
  name: 'workbench-long-session',
  deltaCount,
  toolCount,
  serializeEvents,
})
const projectionRetention = retentionRuns > 0
  ? auditProjectionRetention(retentionRuns, retentionToolsPerRun)
  : undefined
process.stdout.write(`${JSON.stringify({ runtime, projectionRetention }, null, 2)}\n`)
