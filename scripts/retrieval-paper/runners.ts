import { spawn, spawnSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { TurboFluxConfig } from '../../src/core/config'
import { runFastContextSubagent } from '../../src/core/fastContextSubagent'
import { runSubAgent } from '../../src/core/subAgent'
import { NodeToolExecutor } from '../../src/core/runtime/nodeToolExecutor'
import type { FastContextScanEvent } from '../../src/core/fastContextTypes'
import type { SubAgentDefinition, SubAgentEvent } from '../../src/shared/subAgentTypes'
import { scoreRanking, normalizePath } from './metrics'
import { startClaudeProtocolBridge } from './claudeBridge'
import type {
  BenchmarkCase,
  RepositoryStats,
  RetrievalSystemId,
  RunFailureKind,
  RunRecord,
  UsageMetrics,
} from './types'

export const MODEL = 'gpt-5.5'

interface RunContext {
  experimentId: string
  item: BenchmarkCase
  workspacePath: string
  repositoryStats: RepositoryStats
  config: TurboFluxConfig
  repeat: number
  order: number
  timeoutMs: number
}

interface RunnerOutput {
  success: boolean
  timedOut: boolean
  latencyMs: number
  apiDurationMs?: number
  apiRequests: number
  apiRetries: number
  toolCalls: number
  searchCalls: number
  readCalls: number
  rankedPaths: string[]
  readPaths: string[]
  usage: UsageMetrics
  protocol: string
  rawOutput: string
  error?: string
  cliVersion?: string
}

interface FetchObservation {
  requests: number
  retries: number
  protocol: string
  usage: UsageMetrics
}

const fetchObservationContext = new AsyncLocalStorage<FetchObservation>()
let fetchObserverInstalled = false

function emptyUsage(): UsageMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return 0
}

function addUsage(target: UsageMetrics, usage: Record<string, any> | undefined): void {
  if (!usage) return
  target.inputTokens += numberValue(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.input)
  target.outputTokens += numberValue(usage.output_tokens, usage.completion_tokens, usage.outputTokens, usage.output)
  target.cacheReadTokens += numberValue(usage.cache_read_input_tokens, usage.cache_read_tokens, usage.cacheReadTokens, usage.cache?.read)
  target.cacheWriteTokens += numberValue(usage.cache_creation_input_tokens, usage.cache_write_tokens, usage.cacheWriteTokens, usage.cache?.write)
  target.reasoningTokens += numberValue(
    usage.reasoning_tokens,
    usage.reasoning,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  )
  const cost = numberValue(usage.cost, usage.cost_usd, usage.total_cost_usd)
  if (cost > 0) target.costUsd = (target.costUsd || 0) + cost
}

function protocolFromUrl(value: string): string {
  try {
    const path = new URL(value).pathname.toLowerCase()
    if (path.endsWith('/responses')) return 'openai-responses'
    if (path.endsWith('/chat/completions')) return 'openai-chat'
    if (path.endsWith('/messages')) return 'anthropic-messages'
  } catch {}
  return 'unknown'
}

async function observeFetch<T>(run: (observation: FetchObservation) => Promise<T>): Promise<{ value: T; observation: FetchObservation }> {
  const observation: FetchObservation = { requests: 0, retries: 0, protocol: 'unknown', usage: emptyUsage() }
  if (!fetchObserverInstalled) {
    const originalFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (...args) => {
      const current = fetchObservationContext.getStore()
      if (current) {
        current.requests += 1
        const input = args[0]
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        current.protocol = protocolFromUrl(url)
      }
      const response = await originalFetch(...args)
      if (current) {
        try {
          const payload = await response.clone().json() as Record<string, any>
          addUsage(current.usage, payload.usage)
        } catch {}
      }
      return response
    }
    fetchObserverInstalled = true
  }
  const value = await fetchObservationContext.run(observation, () => run(observation))
  return { value, observation }
}

function uniquePaths(paths: string[], workspacePath: string): string[] {
  const workspace = normalizePath(workspacePath).replace(/\/$/, '')
  const values: string[] = []
  for (const value of paths) {
    let normalized = normalizePath(value).replace(/^['"`({[]+|['"`)}\],.;]+$/g, '')
    if (normalized.startsWith(`${workspace}/`)) normalized = normalized.slice(workspace.length + 1)
    normalized = normalized.replace(/^[a-z]:\//i, '')
    if (!normalized || values.includes(normalized)) continue
    values.push(normalized)
  }
  return values
}

function extractPaths(text: string | undefined, workspacePath: string): string[] {
  if (!text) return []
  const paths: string[] = []
  const rankedSection = text.split(/\bRANKED_CODE_MAP\b/i)[1]?.split(/\b(?:EXECUTION_FLOW|SEARCHES_TRIED|UNCERTAINTY|REJECTED_HYPOTHESES)\b/i)[0] || text
  const pattern = /(?:^|[\s`'"(*])((?:[A-Za-z]:[\\/])?(?:[\w.@()+-]+[\\/])+[\w.@()[\]{}+-]+\.[A-Za-z0-9]+)(?=$|[\s`'"*),:#])/gm
  for (const match of rankedSection.matchAll(pattern)) paths.push(match[1])
  return uniquePaths(paths, workspacePath).slice(0, 20)
}

function benchmarkPrompt(item: BenchmarkCase): string {
  return [
    'Read-only repository localization benchmark. Search and read the checked-out source. Do not modify files, use git history, access the network, or run tests.',
    'Identify the implementation files that would need editing to resolve the issue below.',
    '',
    'ISSUE',
    item.objective,
    '',
    'OUTPUT CONTRACT',
    'Begin with exactly RANKED_CODE_MAP.',
    'Rank at most 10 repository-relative implementation files. Each entry must include path, line range, role, confidence, and one-sentence evidence.',
    'Only rank files you personally read. Then provide EXECUTION_FLOW, SEARCHES_TRIED, and UNCERTAINTY.',
    'Do not reveal hidden chain-of-thought.',
  ].join('\n')
}

function classifyFailure(error: string | undefined, timedOut: boolean, success: boolean): RunFailureKind {
  if (success) return 'none'
  if (timedOut) return 'timeout'
  const value = (error || '').toLowerCase()
  if (/401|403|authentication|api key|unauthor/.test(value)) return 'authentication'
  if (/429|rate.?limit|quota/.test(value)) return 'rate_limit'
  if (/protocol|endpoint|response shape|messages|chat\/completions|\/responses/.test(value)) return 'protocol'
  if (/tool|read_file|grep|glob|permission/.test(value)) return 'tool'
  if (/ranked_code_map|output contract|structured/.test(value)) return 'output_contract'
  if (/clone|repository|commit|checkout|git /.test(value)) return 'repository'
  if (/model|request|api|http 5/.test(value)) return 'model'
  return 'unknown'
}

function finishRecord(context: RunContext, system: RetrievalSystemId, output: RunnerOutput): RunRecord {
  const completedAt = new Date()
  const goldPaths = context.item.sourceGoldPaths
  const success = output.success && output.rankedPaths.length > 0
  const error = success ? undefined : output.error || 'Output did not contain a valid ranked code map'
  return {
    runId: `${context.experimentId}:${context.item.id}:${system}:${context.repeat}`,
    experimentId: context.experimentId,
    startedAt: new Date(completedAt.getTime() - output.latencyMs).toISOString(),
    completedAt: completedAt.toISOString(),
    caseId: context.item.id,
    dataset: context.item.dataset,
    repository: context.item.repository,
    language: context.item.language,
    category: context.item.category,
    system,
    repeat: context.repeat,
    order: context.order,
    model: system === 'bm25' ? null : MODEL,
    reasoning: 'disabled',
    protocol: output.protocol,
    success,
    failureKind: classifyFailure(error, output.timedOut, success),
    timedOut: output.timedOut,
    latencyMs: output.latencyMs,
    apiDurationMs: output.apiDurationMs,
    apiRequests: output.apiRequests,
    apiRetries: output.apiRetries,
    toolCalls: output.toolCalls,
    searchCalls: output.searchCalls,
    readCalls: output.readCalls,
    rankedPaths: output.rankedPaths,
    readPaths: output.readPaths,
    goldPaths,
    metrics: scoreRanking(output.rankedPaths, goldPaths),
    usage: output.usage,
    repositoryFiles: context.repositoryStats.files,
    repositoryBytes: context.repositoryStats.bytes,
    rawOutput: output.rawOutput,
    error,
    cliVersion: output.cliVersion,
  }
}

function errorOutput(startedAt: number, error: unknown, observation?: FetchObservation): RunnerOutput {
  const message = error instanceof Error ? error.message : String(error)
  return {
    success: false,
    timedOut: /abort|timeout|timed out/i.test(message),
    latencyMs: performance.now() - startedAt,
    apiRequests: observation?.requests || 0,
    apiRetries: observation?.retries || 0,
    toolCalls: 0,
    searchCalls: 0,
    readCalls: 0,
    rankedPaths: [],
    readPaths: [],
    usage: observation?.usage || emptyUsage(),
    protocol: observation?.protocol || 'unknown',
    rawOutput: '',
    error: message,
  }
}

async function runFastContext(context: RunContext): Promise<RunnerOutput> {
  const startedAt = performance.now()
  const events: FastContextScanEvent[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), context.timeoutMs)
  let observation: FetchObservation | undefined
  try {
    const observed = await observeFetch(async current => {
      observation = current
      return runFastContextSubagent({
        workspacePath: context.workspacePath,
        objective: context.item.objective,
        toolExecutor: new NodeToolExecutor(context.workspacePath, { sandboxPolicy: 'readonly' }),
        apiKey: context.config.apiKey,
        baseUrl: context.config.baseUrl,
        provider: context.config.provider,
        customHeaders: context.config.customHeaders,
        model: MODEL,
        modelCapabilities: context.config.modelCapabilities,
        reasoning: { enabled: false, effort: 'none' },
        abortSignal: controller.signal,
        requestTimeoutMs: Math.min(120_000, context.timeoutMs),
        onEvent: event => {
          events.push(event)
          if (event.type === 'insight' && /retrying model request/i.test(event.text)) current.retries += 1
        },
      })
    })
    observation = observed.observation
    const report = observed.value.evidencePack
    const telemetry = observed.value.telemetry
    const readPaths = events
      .filter((event): event is Extract<FastContextScanEvent, { type: 'hit' }> => event.type === 'hit' && event.hit.reason === 'file read')
      .map(event => event.hit.path)
    return {
      success: /authority:\s*llm_verified_code_map/i.test(report),
      timedOut: controller.signal.aborted,
      latencyMs: performance.now() - startedAt,
      apiRequests: observation.requests,
      apiRetries: observation.retries,
      toolCalls: telemetry?.toolCalls || 0,
      searchCalls: telemetry?.searchCalls || 0,
      readCalls: telemetry?.readCalls || 0,
      rankedPaths: extractPaths(report, context.workspacePath),
      readPaths: uniquePaths(readPaths, context.workspacePath),
      usage: observation.usage,
      protocol: observation.protocol,
      rawOutput: report,
    }
  } catch (error) {
    const base = errorOutput(startedAt, error, observation)
    const toolCallText = events.filter(event => event.type === 'insight').map(event => event.text)
    return {
      ...base,
      toolCalls: toolCallText.filter(text => /^(?:search_|trace_symbol|get_codemap|read_file):/i.test(text)).length,
      searchCalls: toolCallText.filter(text => /^(?:search_|trace_symbol|get_codemap):/i.test(text)).length,
      readCalls: toolCallText.filter(text => /^read_file:/i.test(text)).length,
      readPaths: uniquePaths(events
        .filter((event): event is Extract<FastContextScanEvent, { type: 'hit' }> => event.type === 'hit' && event.hit.reason === 'file read')
        .map(event => event.hit.path), context.workspacePath),
    }
  } finally {
    clearTimeout(timer)
  }
}

const NEUTRAL_DEFINITION: SubAgentDefinition = {
  id: 'fast_context',
  label: 'Neutral Repository Locator',
  description: 'Neutral tool-using repository localization baseline',
  driver: 'main-model',
  maxTurns: 8,
  maxParallel: 6,
  maxOutputTokens: 4096,
  temperature: 0,
  thinking: 'disabled',
  systemPrompt: `You are a read-only repository search assistant. Find the implementation files relevant to the issue using the available search and read tools. Read evidence before ranking. Finish with submit_code_map. Do not edit files, inspect git history, run tests, or access the network.`,
}

async function runNeutralToolAgent(context: RunContext): Promise<RunnerOutput> {
  const startedAt = performance.now()
  const events: SubAgentEvent[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), context.timeoutMs)
  let observation: FetchObservation | undefined
  try {
    const observed = await observeFetch(async current => {
      observation = current
      return runSubAgent({
        definition: NEUTRAL_DEFINITION,
        objective: context.item.objective,
        workspacePath: context.workspacePath,
        toolExecutor: new NodeToolExecutor(context.workspacePath, { sandboxPolicy: 'readonly' }),
        apiKey: context.config.apiKey,
        baseUrl: context.config.baseUrl,
        provider: context.config.provider,
        customHeaders: context.config.customHeaders,
        model: MODEL,
        modelCapabilities: context.config.modelCapabilities,
        reasoning: { enabled: false, effort: 'none' },
        abortSignal: controller.signal,
        requestTimeoutMs: Math.min(120_000, context.timeoutMs),
        requireGroundedReport: true,
        onEvent: event => {
          events.push(event)
          if (event.type === 'model_retry') current.retries += 1
        },
      })
    })
    observation = observed.observation
    const result = observed.value
    const finalText = result.finalText || ''
    const toolEvents = events.filter((event): event is Extract<SubAgentEvent, { type: 'tool_call' }> => event.type === 'tool_call')
    return {
      success: result.ok && /^RANKED_CODE_MAP\b/m.test(finalText),
      timedOut: controller.signal.aborted,
      latencyMs: performance.now() - startedAt,
      apiRequests: observation.requests,
      apiRetries: observation.retries,
      toolCalls: toolEvents.length,
      searchCalls: toolEvents.filter(event => /^(?:search_|trace_symbol|get_codemap)/i.test(event.tool)).length,
      readCalls: toolEvents.filter(event => event.tool === 'read_file').length,
      rankedPaths: extractPaths(finalText, context.workspacePath),
      readPaths: uniquePaths(result.evidence.filter(item => item.reason === 'file read').map(item => item.path), context.workspacePath),
      usage: observation.usage,
      protocol: observation.protocol,
      rawOutput: finalText,
      error: result.error,
    }
  } catch (error) {
    return errorOutput(startedAt, error, observation)
  } finally {
    clearTimeout(timer)
  }
}

function executable(name: 'claude' | 'opencode'): string {
  if (process.platform !== 'win32') return name
  if (name === 'claude') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
}

function cliVersion(name: 'claude' | 'opencode'): string {
  const result = spawnSync(executable(name), ['--version'], { encoding: 'utf8', windowsHide: true })
  return String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || 'unknown'
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  await new Promise<void>(resolveTermination => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', () => {
      child.kill('SIGKILL')
      resolveTermination()
    })
    killer.once('close', () => resolveTermination())
  })
}

export function spawnCaptured(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceSettleTimer) clearTimeout(forceSettleTimer)
      resolveRun({ code, stdout, stderr, timedOut })
    }
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      timedOut = true
      void terminateProcessTree(child).finally(() => {
        forceSettleTimer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          finish(null)
        }, 2_000)
      })
    }, options.timeoutMs)
    child.on('error', error => {
      if (timedOut) finish(null)
      else if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })
    child.on('close', finish)
  })
}

async function runClaudeCode(context: RunContext): Promise<RunnerOutput> {
  const startedAt = performance.now()
  let bridge: Awaited<ReturnType<typeof startClaudeProtocolBridge>> | undefined
  try {
    bridge = await startClaudeProtocolBridge(context.config, MODEL)
    const result = await spawnCaptured(executable('claude'), [
      '--print', benchmarkPrompt(context.item),
      '--model', MODEL,
      '--bare',
      '--safe-mode',
      '--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: bridge.baseUrl, CLAUDE_CODE_API_BASE_URL: bridge.baseUrl } }),
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode', 'plan',
      '--allowedTools', 'Glob,Grep,Read',
      '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task',
    ], {
      cwd: context.workspacePath,
      timeoutMs: context.timeoutMs,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: context.config.apiKey,
        ANTHROPIC_BASE_URL: bridge.baseUrl,
        CLAUDE_CODE_API_BASE_URL: bridge.baseUrl,
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
        CLAUDE_CODE_DISABLE_THINKING: '1',
        CLAUDE_CODE_MAX_RETRIES: '3',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
    })
    const usage = bridge.stats.usage
    let finalText = ''
    let retries = 0
    let toolCalls = 0
    let searchCalls = 0
    let readCalls = 0
    let apiDurationMs: number | undefined
    let turns = 0
    const readPaths: string[] = []
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'system' && event.subtype === 'api_retry') retries += 1
      if (event.type === 'assistant') {
        turns += 1
        for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (block?.type === 'text' && typeof block.text === 'string') finalText = block.text
          if (block?.type === 'tool_use') {
            toolCalls += 1
            const name = String(block.name || '')
            if (/^(?:Grep|Glob)$/i.test(name)) searchCalls += 1
            if (/^Read$/i.test(name)) {
              readCalls += 1
              if (typeof block.input?.file_path === 'string') readPaths.push(block.input.file_path)
            }
          }
        }
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') finalText = event.result
        if (typeof event.duration_api_ms === 'number') apiDurationMs = event.duration_api_ms
        if (typeof event.num_turns === 'number') turns = event.num_turns
      }
    }
    const success = result.code === 0 && !result.timedOut && /\bRANKED_CODE_MAP\b/m.test(finalText)
    return {
      success,
      timedOut: result.timedOut,
      latencyMs: performance.now() - startedAt,
      apiDurationMs,
      apiRequests: bridge.stats.requests,
      apiRetries: retries,
      toolCalls,
      searchCalls,
      readCalls,
      rankedPaths: extractPaths(finalText, context.workspacePath),
      readPaths: uniquePaths(readPaths, context.workspacePath),
      usage,
      protocol: 'anthropic-messages->openai-responses',
      rawOutput: finalText,
      error: success ? undefined : result.timedOut
        ? `Timed out after ${context.timeoutMs}ms`
        : `${finalText.trim() || result.stderr.trim() || `Claude Code exited with code ${result.code}`} [bridge received: ${bridge.stats.receivedPaths.join(', ') || 'none'}]`,
      cliVersion: cliVersion('claude'),
    }
  } catch (error) {
    return { ...errorOutput(startedAt, error), protocol: 'anthropic-messages->openai-responses', cliVersion: cliVersion('claude') }
  } finally {
    await bridge?.close().catch(() => {})
  }
}

function openCodeConfig(config: TurboFluxConfig): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: `benchmark/${MODEL}`,
    share: 'disabled',
    autoupdate: false,
    provider: {
      benchmark: {
        name: 'Paper Benchmark',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: config.baseUrl, apiKey: config.apiKey, headers: config.customHeaders || {} },
        models: {
          [MODEL]: {
            name: MODEL,
            reasoning: false,
            limit: { context: config.contextWindow || 200_000, output: Math.min(config.maxOutputTokens || config.maxTokens || 16_384, 16_384) },
            variants: { none: { reasoningEffort: 'none' } },
          },
        },
      },
    },
    agent: {
      benchmark: {
        mode: 'primary',
        description: 'Read-only issue localization benchmark agent',
        prompt: 'Search and read repository source to locate implementation files relevant to the issue. Do not modify files, inspect git history, run tests, or access the network.',
        permission: {
          edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny',
          read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', question: 'deny',
        },
      },
    },
  })
}

async function runOpenCode(context: RunContext): Promise<RunnerOutput> {
  const startedAt = performance.now()
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'turboflux-opencode-'))
  try {
    const result = await spawnCaptured(executable('opencode'), [
      'run', benchmarkPrompt(context.item),
      '--pure',
      '--model', `benchmark/${MODEL}`,
      '--variant', 'none',
      '--agent', 'benchmark',
      '--format', 'json',
      '--dir', context.workspacePath,
    ], {
      cwd: context.workspacePath,
      timeoutMs: context.timeoutMs,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: openCodeConfig(context.config),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        XDG_DATA_HOME: join(runtimeRoot, 'data'),
        XDG_STATE_HOME: join(runtimeRoot, 'state'),
      },
    })
    const usage = emptyUsage()
    let finalText = ''
    let toolCalls = 0
    let searchCalls = 0
    let readCalls = 0
    let turns = 0
    const readPaths: string[] = []
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      const part = event.part || event
      if (part.type === 'text' && typeof part.text === 'string') finalText += part.text
      if (part.type === 'tool') {
        toolCalls += 1
        const tool = String(part.tool || part.name || '')
        if (/^(?:grep|glob|list)$/i.test(tool)) searchCalls += 1
        if (/^read$/i.test(tool)) {
          readCalls += 1
          const input = part.state?.input || part.input || {}
          const path = input.filePath || input.file_path || input.path
          if (typeof path === 'string') readPaths.push(path)
        }
      }
      if (part.type === 'step-finish' || part.type === 'step_finish') {
        turns += 1
        addUsage(usage, part.tokens || part.usage)
        if (part.cost) usage.costUsd = (usage.costUsd || 0) + Number(part.cost)
      }
    }
    const success = result.code === 0 && !result.timedOut && /\bRANKED_CODE_MAP\b/m.test(finalText)
    return {
      success,
      timedOut: result.timedOut,
      latencyMs: performance.now() - startedAt,
      apiRequests: Math.max(turns, success ? 1 : 0),
      apiRetries: 0,
      toolCalls,
      searchCalls,
      readCalls,
      rankedPaths: extractPaths(finalText, context.workspacePath),
      readPaths: uniquePaths(readPaths, context.workspacePath),
      usage,
      protocol: 'openai-chat',
      rawOutput: finalText,
      error: success ? undefined : result.timedOut ? `Timed out after ${context.timeoutMs}ms` : result.stderr.trim() || `OpenCode exited with code ${result.code}`,
      cliVersion: cliVersion('opencode'),
    }
  } catch (error) {
    return { ...errorOutput(startedAt, error), protocol: 'openai-chat', cliVersion: cliVersion('opencode') }
  } finally {
    try { rmSync(runtimeRoot, { recursive: true, force: true }) } catch {}
  }
}

const STOPWORDS = new Set('a an and are as at be been but by can could do does for from had has have how if in into is issue it may not of on or should that the their then this to was were what when where which with would'.split(' '))
const SOURCE_FILE = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|kts|m|mm|php|py|rb|rs|scala|swift|ts|tsx|vue)$/i
const EXCLUDED_FILE = /(?:^|[\\/])(?:\.git|node_modules|vendor|dist|build|target|coverage|__pycache__)(?:[\\/]|$)/i

function tokenize(value: string): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_./\\:-]+/g, ' ')
  return expanded.toLowerCase().match(/[a-z][a-z0-9]{1,}|[\u4e00-\u9fff]{2,}/g)?.filter(token => !STOPWORDS.has(token)) || []
}

function listFiles(workspacePath: string): string[] {
  const result = spawnSync('rg', ['--files', '-g', '!node_modules', '-g', '!.git', '-g', '!dist', '-g', '!build', '-g', '!target'], {
    cwd: workspacePath,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0 && !result.stdout) throw new Error(String(result.stderr || 'rg --files failed'))
  return String(result.stdout).split(/\r?\n/).filter(path => SOURCE_FILE.test(path) && !EXCLUDED_FILE.test(path))
}

async function runBm25(context: RunContext): Promise<RunnerOutput> {
  const startedAt = performance.now()
  try {
    const files = listFiles(context.workspacePath)
    const documents: Array<{ path: string; length: number; frequencies: Map<string, number> }> = []
    const documentFrequency = new Map<string, number>()
    for (const path of files) {
      const absolute = join(context.workspacePath, path)
      const stat = statSync(absolute)
      if (stat.size > 2_000_000) continue
      const content = readFileSync(absolute, 'utf8').slice(0, 256_000)
      const tokens = tokenize(`${path} ${path} ${path} ${content}`)
      const frequencies = new Map<string, number>()
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1)
      for (const token of frequencies.keys()) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)
      documents.push({ path, length: tokens.length, frequencies })
    }
    const query = [...new Set(tokenize(context.item.objective))]
    const averageLength = documents.reduce((sum, item) => sum + item.length, 0) / Math.max(documents.length, 1)
    const k1 = 1.2
    const b = 0.75
    const ranked = documents.map(document => {
      let score = 0
      for (const token of query) {
        const frequency = document.frequencies.get(token) || 0
        if (frequency === 0) continue
        const df = documentFrequency.get(token) || 0
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
        score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * document.length / Math.max(averageLength, 1)))
      }
      return { path: document.path, score }
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    const rankedPaths = ranked.filter(item => item.score > 0).slice(0, 20).map(item => normalizePath(item.path))
    return {
      success: rankedPaths.length > 0,
      timedOut: false,
      latencyMs: performance.now() - startedAt,
      apiRequests: 0,
      apiRetries: 0,
      toolCalls: 1,
      searchCalls: 1,
      readCalls: documents.length,
      rankedPaths,
      readPaths: [],
      usage: emptyUsage(),
      protocol: 'local-bm25',
      rawOutput: ranked.slice(0, 20).map((item, index) => `${index + 1}. ${item.path} ${item.score.toFixed(6)}`).join('\n'),
    }
  } catch (error) {
    return { ...errorOutput(startedAt, error), protocol: 'local-bm25' }
  }
}

export async function runRetrievalSystem(system: RetrievalSystemId, context: RunContext): Promise<RunRecord> {
  let output: RunnerOutput
  if (system === 'fastcontext') output = await runFastContext(context)
  else if (system === 'claude-code-readonly') output = await runClaudeCode(context)
  else if (system === 'opencode-explore') output = await runOpenCode(context)
  else if (system === 'neutral-tool-agent') output = await runNeutralToolAgent(context)
  else output = await runBm25(context)
  return finishRecord(context, system, output)
}

export function installedCliVersions(): Record<string, string> {
  return { claudeCode: cliVersion('claude'), openCode: cliVersion('opencode') }
}
