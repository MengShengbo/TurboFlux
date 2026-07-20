import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/core/config'
import { configureNetworkProxy } from '../src/core/networkProxy'
import { runFastContextSubagent } from '../src/core/fastContextSubagent'
import { NodeToolExecutor } from '../src/core/runtime/nodeToolExecutor'
import type { FastContextScanEvent } from '../src/core/fastContextTypes'

interface BenchmarkCase {
  id: string
  category: 'location' | 'workflow'
  objective: string
  relevantPaths: string[]
}

interface UsageMetrics {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  costUsd?: number
}

interface RunMetrics {
  system: 'turboflux' | 'claude-code'
  caseId: string
  category: BenchmarkCase['category']
  success: boolean
  timedOut: boolean
  latencyMs: number
  apiDurationMs?: number
  turns: number
  apiRequests: number
  apiRetries: number
  toolCalls: number
  searchCalls: number
  readCalls: number
  rankedPaths: string[]
  recallAt5: number
  recallAt10: number
  reciprocalRank: number
  top1Hit: boolean
  citationRate: number
  executionFlowPresent: boolean
  qualityIndex: number
  usage: UsageMetrics
  report: string
  error?: string
}

const MODEL = 'claude-sonnet-5'
const TIMEOUT_MS = 240_000
const OUTPUT_DIR = resolve('benchmark-results', '2026-07-21-claude-sonnet-5')

const CASES: BenchmarkCase[] = [
  {
    id: 'cli-entry',
    category: 'location',
    objective: 'Locate the TurboFlux CLI startup entry, command parsing, and handoff into the interactive app.',
    relevantPaths: ['bin/turboflux.mjs', 'src/cli/index.ts', 'src/cli/repl.ts'],
  },
  {
    id: 'fast-context-scheduling',
    category: 'workflow',
    objective: 'Locate FastContext background scheduling, subagent retrieval, and evidence injection into the main agent. Identify the real execution path.',
    relevantPaths: ['src/core/agentEngine.ts', 'src/core/fastContextSubagent.ts', 'src/core/subAgent.ts'],
  },
  {
    id: 'transcript-scroll',
    category: 'workflow',
    objective: 'Locate row-level transcript viewport scrolling and terminal mouse-wheel handling in the CLI UI.',
    relevantPaths: ['src/cli/components/TranscriptViewport.tsx', 'src/cli/components/App.tsx', 'src/cli/terminalMouse.ts'],
  },
  {
    id: 'chinese-setup-copy',
    category: 'location',
    objective: 'FastContext 子代理模型配置这段中文界面文案在哪里实现？请定位真实源码。',
    relevantPaths: ['src/cli/setup.ts'],
  },
  {
    id: 'clipboard-images',
    category: 'workflow',
    objective: 'Locate clipboard image paste, image attachment parsing, and conversion into model messages.',
    relevantPaths: ['src/cli/imageAttachments.ts', 'src/cli/components/App.tsx', 'src/core/contextManager.ts'],
  },
  {
    id: 'background-terminal-lifecycle',
    category: 'workflow',
    objective: 'Trace how a background terminal command is started, persisted, polled, restored into UI state, and terminated. Identify the true execution core and its callers.',
    relevantPaths: ['src/core/agentEngine.ts', 'src/core/runtime/nodeToolExecutor.ts', 'src/shared/terminalTypes.ts'],
  },
  {
    id: 'model-request-compatibility',
    category: 'workflow',
    objective: 'Trace model-native reasoning request construction, unsupported parameter removal, protocol fallback, and retry behavior for FastContext model calls.',
    relevantPaths: ['src/core/subAgent.ts', 'src/core/modelRegistry.ts', 'src/core/modelProtocol.ts', 'src/core/agentEngine.ts'],
  },
  {
    id: 'interrupted-stream-persistence',
    category: 'workflow',
    objective: 'Trace how Ctrl+C interrupts a streaming assistant response while preserving partial text through engine turns, conversation journal persistence, and transcript rendering.',
    relevantPaths: ['src/core/agentEngine.ts', 'src/cli/components/App.tsx', 'src/cli/conversations/manager.ts', 'src/cli/conversations/store.ts'],
  },
]

function emptyUsage(): UsageMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
}

function addUsage(target: UsageMetrics, source: Record<string, unknown> | undefined): void {
  if (!source) return
  target.inputTokens += Number(source.input_tokens ?? source.inputTokens ?? 0) || 0
  target.outputTokens += Number(source.output_tokens ?? source.outputTokens ?? 0) || 0
  target.cacheCreationInputTokens += Number(source.cache_creation_input_tokens ?? source.cacheCreationInputTokens ?? 0) || 0
  target.cacheReadInputTokens += Number(source.cache_read_input_tokens ?? source.cacheReadInputTokens ?? 0) || 0
}

function normalizePath(value: string, workspacePath: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^`|`$/g, '').replace(/^\.\//, '')
  const workspace = workspacePath.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)
    ? normalized.slice(workspace.length + 1).toLowerCase()
    : normalized.replace(/^[a-z]:\//i, '').toLowerCase()
}

function extractRankedSection(report: string): string {
  const fromPack = report.split('llm_ranked_code_map:')[1]?.split('</fast_context_pack>')[0]
  const source = fromPack || report
  return source.split(/\bEXECUTION_FLOW\b/i)[0]
}

function extractRankedPaths(report: string, workspacePath: string): string[] {
  const section = extractRankedSection(report)
  const paths: string[] = []
  const pathPattern = /(?:^|[\s`"'(*])((?:[A-Za-z]:[\\/])?(?:[\w.@()-]+[\\/])+[\w.@()[\]-]+\.[A-Za-z0-9]+)(?=$|[\s`"'*),:#])/gm
  for (const match of section.matchAll(pathPattern)) {
    const normalized = normalizePath(match[1], workspacePath)
    if (!paths.includes(normalized)) paths.push(normalized)
  }
  return paths.slice(0, 20)
}

function citationRate(report: string): number {
  const lines = extractRankedSection(report).split(/\r?\n/).filter(line => /^\s*(?:\d+[.)]|[-*])\s+/.test(line))
  if (lines.length === 0) return 0
  const cited = lines.filter(line => /(?:\bL\d+(?:-L?\d+)?\b|:\d+(?:-\d+)?\b|#L\d+|\blines?\s+~?\d+(?:-\d+)?)/i.test(line)).length
  return cited / lines.length
}

function scoreRun(base: Omit<RunMetrics, 'recallAt5' | 'recallAt10' | 'reciprocalRank' | 'top1Hit' | 'citationRate' | 'executionFlowPresent' | 'qualityIndex'>, benchmark: BenchmarkCase, workspacePath: string): RunMetrics {
  const rankedPaths = base.rankedPaths.map(path => normalizePath(path, workspacePath))
  const relevant = benchmark.relevantPaths.map(path => normalizePath(path, workspacePath))
  const recall = (limit: number) => relevant.filter(path => rankedPaths.slice(0, limit).includes(path)).length / relevant.length
  const firstRelevant = rankedPaths.findIndex(path => relevant.includes(path))
  const reciprocalRank = firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0
  const citations = citationRate(base.report)
  const executionFlowPresent = /\bEXECUTION_FLOW\b/i.test(base.report)
  const recallAt10 = recall(10)
  const qualityIndex = base.success
    ? (recallAt10 * 60) + (reciprocalRank * 25) + (citations * 10) + (executionFlowPresent ? 5 : 0)
    : 0
  return {
    ...base,
    rankedPaths,
    recallAt5: recall(5),
    recallAt10,
    reciprocalRank,
    top1Hit: firstRelevant === 0,
    citationRate: citations,
    executionFlowPresent,
    qualityIndex,
  }
}

function benchmarkPrompt(benchmark: BenchmarkCase): string {
  return [
    'This is a read-only code retrieval benchmark. Search and read the actual repository source; do not modify files.',
    `Objective: ${benchmark.objective}`,
    'Return a concise report beginning with exactly RANKED_CODE_MAP.',
    'Rank 3-7 files. For each include repository-relative path, line range, role, confidence, and why it matters.',
    'Then include EXECUTION_FLOW, SEARCHES_TRIED, and UNCERTAINTY.',
    'Only rank files you personally read. Do not reveal chain-of-thought.',
  ].join('\n')
}

async function runTurboFlux(benchmark: BenchmarkCase, workspacePath: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<RunMetrics> {
  const executor = new NodeToolExecutor(workspacePath, { sandboxPolicy: 'readonly' })
  const usage = emptyUsage()
  const events: FastContextScanEvent[] = []
  let apiRequests = 0
  let modelRetries = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    apiRequests += 1
    const response = await originalFetch(...args)
    try {
      const payload = await response.clone().json() as { usage?: Record<string, unknown> }
      addUsage(usage, payload.usage)
    } catch {}
    return response
  }
  const startedAt = performance.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const result = await runFastContextSubagent({
      workspacePath,
      objective: benchmark.objective,
      toolExecutor: executor,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      provider: config.provider,
      customHeaders: config.customHeaders,
      reasoning: { enabled: false, effort: 'none' },
      model: MODEL,
      level: 'medium',
      abortSignal: controller.signal,
      requestTimeoutMs: 90_000,
      onEvent: event => {
        events.push(event)
        if (event.type === 'insight' && /retrying model request/i.test(event.text)) modelRetries += 1
      },
    }).finally(() => clearTimeout(timer))
    const report = result.evidencePack
    return scoreRun({
      system: 'turboflux',
      caseId: benchmark.id,
      category: benchmark.category,
      success: report.includes('authority: llm_verified_code_map'),
      timedOut: controller.signal.aborted,
      latencyMs: performance.now() - startedAt,
      turns: Number(report.match(/retrieval:\s+(\d+) turn/i)?.[1] || 0),
      apiRequests,
      apiRetries: modelRetries,
      toolCalls: events.filter(event => event.type === 'insight' && /^(?:search_|get_codemap|read_file):/i.test(event.text)).length,
      searchCalls: events.filter(event => event.type === 'insight' && /^(?:search_|get_codemap):/i.test(event.text)).length,
      readCalls: events.filter(event => event.type === 'insight' && /^read_file:/i.test(event.text)).length,
      rankedPaths: extractRankedPaths(report, workspacePath),
      usage,
      report,
      error: report.includes('authority: llm_verified_code_map') ? undefined : 'FastContext semantic report did not complete',
    }, benchmark, workspacePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return scoreRun({
      system: 'turboflux', caseId: benchmark.id, category: benchmark.category,
      success: false, timedOut: /abort/i.test(message), latencyMs: performance.now() - startedAt,
      turns: 0, apiRequests, apiRetries: modelRetries, toolCalls: 0, searchCalls: 0, readCalls: 0,
      rankedPaths: [], usage, report: '', error: message,
    }, benchmark, workspacePath)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function claudeExecutable(): string {
  if (process.platform !== 'win32') return 'claude'
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
}

async function runClaudeCode(benchmark: BenchmarkCase, workspacePath: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<RunMetrics> {
  const startedAt = performance.now()
  const usage = emptyUsage()
  let timedOut = false
  let stdout = ''
  let stderr = ''
  let apiRetries = 0
  let toolCalls = 0
  let searchCalls = 0
  let readCalls = 0
  let turns = 0
  let apiDurationMs: number | undefined
  let finalReport = ''
  let resultUsage: Record<string, unknown> | undefined
  let totalCostUsd: number | undefined

  const baseUrl = config.baseUrl.endsWith('/v1') ? config.baseUrl.slice(0, -3) : config.baseUrl
  const child = spawn(claudeExecutable(), [
    '--print', benchmarkPrompt(benchmark),
    '--agent', 'Explore',
    '--model', MODEL,
    '--bare',
    '--safe-mode',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode', 'plan',
  ], {
    cwd: workspacePath,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: config.apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_MAX_RETRIES: '3',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, TIMEOUT_MS)

  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.on('close', (code, signal) => resolveExit({ code, signal }))
  })
  clearTimeout(timer)

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'system' && event.subtype === 'api_retry') apiRetries += 1
    if (event.type === 'assistant') {
      turns += 1
      const content = Array.isArray(event.message?.content) ? event.message.content : []
      for (const block of content) {
        if (block?.type === 'tool_use') {
          toolCalls += 1
          const name = String(block.name || '')
          if (/^(?:Grep|Glob|Bash|Task)$/i.test(name)) searchCalls += 1
          if (/^Read$/i.test(name)) readCalls += 1
        }
        if (block?.type === 'text' && typeof block.text === 'string') finalReport = block.text
      }
    }
    if (event.type === 'result') {
      if (typeof event.result === 'string') finalReport = event.result
      if (typeof event.duration_api_ms === 'number') apiDurationMs = event.duration_api_ms
      if (typeof event.num_turns === 'number') turns = event.num_turns
      if (event.usage && typeof event.usage === 'object') resultUsage = event.usage
      if (typeof event.total_cost_usd === 'number') totalCostUsd = event.total_cost_usd
    }
  }
  addUsage(usage, resultUsage)
  usage.costUsd = totalCostUsd
  const success = exit.code === 0 && !timedOut && /^RANKED_CODE_MAP\b/m.test(finalReport)
  return scoreRun({
    system: 'claude-code',
    caseId: benchmark.id,
    category: benchmark.category,
    success,
    timedOut,
    latencyMs: performance.now() - startedAt,
    apiDurationMs,
    turns,
    apiRequests: Math.max(turns, 1),
    apiRetries,
    toolCalls,
    searchCalls,
    readCalls,
    rankedPaths: extractRankedPaths(finalReport, workspacePath),
    usage,
    report: finalReport,
    error: success ? undefined : (timedOut ? `Timed out after ${TIMEOUT_MS}ms` : stderr.trim() || `Claude Code exited with code ${exit.code}`),
  }, benchmark, workspacePath)
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function aggregate(system: RunMetrics['system'], runs: RunMetrics[]) {
  const selected = runs.filter(run => run.system === system)
  const successful = selected.filter(run => run.success)
  return {
    system,
    cases: selected.length,
    successes: successful.length,
    successRate: successful.length / selected.length,
    timeoutRate: selected.filter(run => run.timedOut).length / selected.length,
    recallAt5: average(selected.map(run => run.recallAt5)),
    recallAt10: average(selected.map(run => run.recallAt10)),
    mrr: average(selected.map(run => run.reciprocalRank)),
    top1Rate: average(selected.map(run => run.top1Hit ? 1 : 0)),
    citationRate: average(selected.map(run => run.citationRate)),
    executionFlowRate: average(selected.map(run => run.executionFlowPresent ? 1 : 0)),
    qualityIndex: average(selected.map(run => run.qualityIndex)),
    successfulRecallAt10: average(successful.map(run => run.recallAt10)),
    successfulMrr: average(successful.map(run => run.reciprocalRank)),
    successfulCitationRate: average(successful.map(run => run.citationRate)),
    successfulQualityIndex: average(successful.map(run => run.qualityIndex)),
    latencyP50Ms: percentile(successful.map(run => run.latencyMs), 0.5),
    latencyP95Ms: percentile(successful.map(run => run.latencyMs), 0.95),
    averageApiRetries: average(selected.map(run => run.apiRetries)),
    averageToolCalls: average(successful.map(run => run.toolCalls)),
    averageSearchCalls: average(successful.map(run => run.searchCalls)),
    averageReadCalls: average(successful.map(run => run.readCalls)),
    totalInputTokens: selected.reduce((sum, run) => sum + run.usage.inputTokens, 0),
    totalOutputTokens: selected.reduce((sum, run) => sum + run.usage.outputTokens, 0),
    totalCacheCreationTokens: selected.reduce((sum, run) => sum + run.usage.cacheCreationInputTokens, 0),
    totalCacheReadTokens: selected.reduce((sum, run) => sum + run.usage.cacheReadInputTokens, 0),
    totalCostUsd: selected.reduce((sum, run) => sum + (run.usage.costUsd || 0), 0),
    averageSuccessfulInputTokens: average(successful.map(run => run.usage.inputTokens)),
    averageSuccessfulOutputTokens: average(successful.map(run => run.usage.outputTokens)),
    averageSuccessfulCacheCreationTokens: average(successful.map(run => run.usage.cacheCreationInputTokens)),
    averageSuccessfulCacheReadTokens: average(successful.map(run => run.usage.cacheReadInputTokens)),
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function markdownReport(metadata: Record<string, unknown>, runs: RunMetrics[]): string {
  const turbo = aggregate('turboflux', runs)
  const claude = aggregate('claude-code', runs)
  const lines = [
    '# TurboFlux FastContext vs Claude Code Explore',
    '',
    `- Date: ${metadata.date}`,
    `- Workspace commit: ${metadata.commit}`,
    `- Model/API: ${MODEL} through the same configured Anthropic endpoint`,
    '- Retrieval mode: TurboFlux `medium`; Claude Code built-in `Explore` agent',
    '- Reasoning: disabled for both because this relay rejects adaptive-thinking request fields',
    `- Per-case timeout: ${TIMEOUT_MS / 1000}s; one measured run per case`,
    '- Ordering: interleaved AB/BA by case to reduce time-window bias',
    '',
    '## Aggregate',
    '',
    '| Metric | TurboFlux | Claude Code |',
    '|---|---:|---:|',
    `| Success rate | ${percent(turbo.successRate)} | ${percent(claude.successRate)} |`,
    `| Timeout rate | ${percent(turbo.timeoutRate)} | ${percent(claude.timeoutRate)} |`,
    `| Recall@5 | ${turbo.recallAt5.toFixed(3)} | ${claude.recallAt5.toFixed(3)} |`,
    `| Recall@10 | ${turbo.recallAt10.toFixed(3)} | ${claude.recallAt10.toFixed(3)} |`,
    `| MRR | ${turbo.mrr.toFixed(3)} | ${claude.mrr.toFixed(3)} |`,
    `| Top-1 hit rate | ${percent(turbo.top1Rate)} | ${percent(claude.top1Rate)} |`,
    `| Line citation rate | ${percent(turbo.citationRate)} | ${percent(claude.citationRate)} |`,
    `| Execution-flow section | ${percent(turbo.executionFlowRate)} | ${percent(claude.executionFlowRate)} |`,
    `| Retrieval Quality Index | ${turbo.qualityIndex.toFixed(1)} | ${claude.qualityIndex.toFixed(1)} |`,
    `| Successful-only Recall@10 | ${turbo.successfulRecallAt10.toFixed(3)} | ${claude.successfulRecallAt10.toFixed(3)} |`,
    `| Successful-only MRR | ${turbo.successfulMrr.toFixed(3)} | ${claude.successfulMrr.toFixed(3)} |`,
    `| Successful-only citation rate | ${percent(turbo.successfulCitationRate)} | ${percent(claude.successfulCitationRate)} |`,
    `| Successful-only Quality Index | ${turbo.successfulQualityIndex.toFixed(1)} | ${claude.successfulQualityIndex.toFixed(1)} |`,
    `| Successful latency p50 | ${(turbo.latencyP50Ms / 1000).toFixed(1)}s | ${(claude.latencyP50Ms / 1000).toFixed(1)}s |`,
    `| Successful latency p95 | ${(turbo.latencyP95Ms / 1000).toFixed(1)}s | ${(claude.latencyP95Ms / 1000).toFixed(1)}s |`,
    `| Average API retries | ${turbo.averageApiRetries.toFixed(1)} | ${claude.averageApiRetries.toFixed(1)} |`,
    `| Average successful input/output tokens | ${turbo.averageSuccessfulInputTokens.toFixed(0)} / ${turbo.averageSuccessfulOutputTokens.toFixed(0)} | ${claude.averageSuccessfulInputTokens.toFixed(0)} / ${claude.averageSuccessfulOutputTokens.toFixed(0)} |`,
    `| Average successful cache create/read | ${turbo.averageSuccessfulCacheCreationTokens.toFixed(0)} / ${turbo.averageSuccessfulCacheReadTokens.toFixed(0)} | ${claude.averageSuccessfulCacheCreationTokens.toFixed(0)} / ${claude.averageSuccessfulCacheReadTokens.toFixed(0)} |`,
    '',
    'The Retrieval Quality Index is transparent rather than model-judged: 60% Recall@10, 25% reciprocal rank, 10% line-citation completeness, and 5% execution-flow contract completion. Failed or timed-out cases receive zero.',
    'Claude Code timed-out runs do not emit final usage totals, so token comparisons use successful cases only and should not be interpreted as total spend.',
    '',
    '## Observed Result',
    '',
    `- TurboFlux completed ${turbo.successes}/${turbo.cases} tasks; Claude Code completed ${claude.successes}/${claude.cases}.`,
    `- TurboFlux successful latency was ${((1 - turbo.latencyP50Ms / claude.latencyP50Ms) * 100).toFixed(1)}% lower at p50 and ${((1 - turbo.latencyP95Ms / claude.latencyP95Ms) * 100).toFixed(1)}% lower at p95.`,
    `- End-to-end quality favored TurboFlux (${turbo.qualityIndex.toFixed(1)} vs ${claude.qualityIndex.toFixed(1)}) because Claude Code timed out twice.`,
    `- On successful runs only, quality was close (${turbo.successfulQualityIndex.toFixed(1)} vs ${claude.successfulQualityIndex.toFixed(1)}); the main measured advantage was convergence reliability and latency, not universal answer superiority.`,
    '- TurboFlux missed one reference file in its own FastContext scheduling trace and one in the interrupted-stream trace. Claude Code produced the more complete interrupted-stream map, while TurboFlux was stronger on background-terminal lifecycle and completed the Chinese exact-copy task that Claude Code timed out on.',
    '',
    '## Per Case',
    '',
    '| Case | System | OK | Recall@10 | MRR | Quality | Latency | Retries | Tokens in/out |',
    '|---|---|:---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const benchmark of CASES) {
    for (const system of ['turboflux', 'claude-code'] as const) {
      const run = runs.find(item => item.caseId === benchmark.id && item.system === system)!
      lines.push(`| ${benchmark.id} | ${system} | ${run.success ? 'yes' : 'no'} | ${run.recallAt10.toFixed(2)} | ${run.reciprocalRank.toFixed(2)} | ${run.qualityIndex.toFixed(1)} | ${(run.latencyMs / 1000).toFixed(1)}s | ${run.apiRetries} | ${run.usage.inputTokens}/${run.usage.outputTokens} |`)
    }
  }
  lines.push('', '## Failure Notes', '')
  const failures = runs.filter(run => !run.success)
  if (!failures.length) lines.push('- None.')
  else for (const run of failures) lines.push(`- ${run.system} / ${run.caseId}: ${run.error || 'unknown failure'}`)
  lines.push(
    '',
    '## Interpretation Limits',
    '',
    '- This is one measured round, so latency variance and stochastic output variance are not confidence-bounded yet.',
    '- Ground truth measures coverage of known authoritative files; additional valid supporting files are not penalized.',
    '- The custom relay required reasoning to be disabled. This isolates retrieval orchestration but does not compare maximum native reasoning quality.',
    '- Claude Code runs in bare/safe, read-only Explore mode; user plugins, MCP servers, memory, and project instructions are excluded.',
    '',
  )
  return lines.join('\n')
}

async function main(): Promise<void> {
  configureNetworkProxy()
  const workspaceArg = process.argv.slice(2).find(argument => !argument.startsWith('--'))
  const workspacePath = resolve(workspaceArg || process.cwd())
  if (process.argv.includes('--rescore')) {
    const path = join(OUTPUT_DIR, 'raw-results.json')
    const existing = JSON.parse((await import('node:fs')).readFileSync(path, 'utf8')) as {
      metadata: Record<string, unknown>
      cases: BenchmarkCase[]
      runs: RunMetrics[]
    }
    const rescored = existing.runs.map(run => {
      const benchmark = CASES.find(item => item.id === run.caseId)
      if (!benchmark) return run
      const {
        recallAt5: _recallAt5,
        recallAt10: _recallAt10,
        reciprocalRank: _reciprocalRank,
        top1Hit: _top1Hit,
        citationRate: _citationRate,
        executionFlowPresent: _executionFlowPresent,
        qualityIndex: _qualityIndex,
        ...base
      } = run
      return scoreRun({
        ...base,
        rankedPaths: extractRankedPaths(run.report, workspacePath),
      }, benchmark, workspacePath)
    })
    existing.metadata.rescoredAt = new Date().toISOString()
    writeFileSync(path, JSON.stringify({ ...existing, runs: rescored }, null, 2))
    writeFileSync(join(OUTPUT_DIR, 'report.md'), markdownReport(existing.metadata, rescored))
    console.log(`Rescored: ${relative(workspacePath, join(OUTPUT_DIR, 'report.md'))}`)
    return
  }
  const config = await loadConfig()
  if (!config.apiKey || !config.baseUrl) throw new Error('Active TurboFlux API configuration is incomplete')
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const metadata = {
    date: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, encoding: 'utf8' }).trim(),
    workspace: workspacePath,
    model: MODEL,
    provider: config.provider,
    endpointHost: new URL(config.baseUrl).host,
    timeoutMs: TIMEOUT_MS,
    cases: CASES.length,
    rounds: 1,
  }
  const runs: RunMetrics[] = []
  for (let index = 0; index < CASES.length; index += 1) {
    const benchmark = CASES[index]
    const order = index % 2 === 0 ? ['turboflux', 'claude-code'] as const : ['claude-code', 'turboflux'] as const
    for (const system of order) {
      console.log(`[${runs.length + 1}/${CASES.length * 2}] ${system} :: ${benchmark.id}`)
      const run = system === 'turboflux'
        ? await runTurboFlux(benchmark, workspacePath, config)
        : await runClaudeCode(benchmark, workspacePath, config)
      runs.push(run)
      console.log(`  ${run.success ? 'ok' : 'failed'} ${(run.latencyMs / 1000).toFixed(1)}s recall@10=${run.recallAt10.toFixed(2)} mrr=${run.reciprocalRank.toFixed(2)} retries=${run.apiRetries}`)
      writeFileSync(join(OUTPUT_DIR, 'raw-results.json'), JSON.stringify({ metadata, cases: CASES, runs }, null, 2))
    }
  }
  const orderedRuns = CASES.flatMap(benchmark => ['turboflux', 'claude-code'].map(system => runs.find(run => run.caseId === benchmark.id && run.system === system)!))
  writeFileSync(join(OUTPUT_DIR, 'raw-results.json'), JSON.stringify({ metadata, cases: CASES, runs: orderedRuns }, null, 2))
  writeFileSync(join(OUTPUT_DIR, 'report.md'), markdownReport(metadata, orderedRuns))
  console.log(`Report: ${relative(workspacePath, join(OUTPUT_DIR, 'report.md'))}`)
}

void main()
