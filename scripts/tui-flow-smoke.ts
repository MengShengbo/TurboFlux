import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as pty from 'node-pty'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import stripAnsi from 'strip-ansi'
import type { LocalFlowTelemetrySnapshot } from '../src/cli/telemetry/localFlowTelemetry'
import { buildTerminalBaselineReport } from '../src/cli/telemetry/terminalBaseline'

const { Terminal: HeadlessTerminalConstructor } = createRequire(import.meta.url)('@xterm/headless') as {
  Terminal: typeof HeadlessTerminal
}

const TIMEOUT_MS = 45_000
const INITIAL_PROMPT = 'FLOW_INITIAL_REQUEST'
const STEERING_PROMPT = 'FLOW_STEER_ONE'
const FIRST_QUEUED_PROMPT = 'FLOW_QUEUE_ONE'
const SECOND_QUEUED_PROMPT = 'FLOW_QUEUE_TWO'
const RESPONSE_BY_REQUEST = [
  'FIRST_RESPONSE_COMPLETE',
  'STEER_RESPONSE_COMPLETE',
  'QUEUE_ONE_RESPONSE_COMPLETE',
  'QUEUE_TWO_RESPONSE_COMPLETE',
]

interface PtyExit {
  exitCode: number
  signal?: number
}

interface MockModelServer {
  server: Server
  getRequestCount: () => number
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'turboflux-tui-smoke-'))
const workspacePath = join(temporaryRoot, 'workspace')
const configPath = join(temporaryRoot, 'config')
const conversationsPath = join(temporaryRoot, 'conversations')
let mock: MockModelServer | undefined
let terminal: pty.IPty | undefined
let headless: HeadlessTerminal | undefined
const rawOutput: string[] = []
const stages: string[] = []
let failure: unknown

try {
  await withTimeout(runSmoke(), TIMEOUT_MS, 'TUI smoke exceeded its global timeout')
} catch (error) {
  failure = error
  const diagnostic = {
    error: error instanceof Error ? error.message : String(error),
    stages,
    screen: headless ? readHeadlessScreen(headless).slice(-4_000) : '',
    outputTail: normalizeTerminalOutput(rawOutput.join('')).slice(-4_000),
    requestCount: mock?.getRequestCount() ?? 0,
    journalFiles: describeJournalFiles(conversationsPath),
  }
  process.stderr.write(`${JSON.stringify(diagnostic, null, 2)}\n`)
} finally {
  if (terminal) {
    try {
      process.kill(terminal.pid)
    } catch {}
  }
  headless?.dispose()
  await closeServer(mock?.server)
  try {
    rmSync(temporaryRoot, { recursive: true, force: true })
  } catch {}
}

if (failure) {
  process.stderr.write(`${failure instanceof Error ? failure.stack || failure.message : String(failure)}\n`)
  process.exit(1)
}
process.exit(0)

async function runSmoke(): Promise<void> {
  stage('prepare isolated workspace')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(configPath, { recursive: true })
  mkdirSync(conversationsPath, { recursive: true })
  mock = await createMockModelServer()
  const address = mock.server.address()
  if (!address || typeof address === 'string') throw new Error('Mock model server did not expose a TCP port')
  writeIsolatedConfiguration(configPath, `http://127.0.0.1:${address.port}/v1`)

  stage('spawn real PTY')
  headless = new HeadlessTerminalConstructor({ cols: 110, rows: 34, scrollback: 2_000, allowProposedApi: true })
  const exit = deferred<PtyExit>()
  terminal = spawnTurboFlux(workspacePath, configPath, conversationsPath)
  terminal.onData(data => {
    rawOutput.push(data)
    if (rawOutput.length > 8_000) rawOutput.splice(0, rawOutput.length - 8_000)
    headless?.write(data)
  })
  terminal.onExit(event => exit.resolve(event))

  stage('wait for landing')
  await waitForVisibleText('Flow v2 ready', 'landing Flow identity')
  terminal.write('\u001b[I\u001b[O')
  await typeSlowly(terminal, INITIAL_PROMPT)
  await delay(150)
  terminal.write('\r')
  await waitFor(() => (mock?.getRequestCount() ?? 0) >= 1, 'first model request')

  stage('submit steering while running')
  await typeSlowly(terminal, STEERING_PROMPT)
  await delay(150)
  terminal.write('\r')
  const steeringScreen = await waitForVisibleTexts(['steering 1', STEERING_PROMPT], 'visible steering input')

  stage('queue two future turns')
  await typeSlowly(terminal, FIRST_QUEUED_PROMPT)
  await delay(150)
  terminal.write('\u001b\r')
  const firstQueueScreen = await waitForVisibleTexts(['queued 1', FIRST_QUEUED_PROMPT], 'first queued input')
  await typeSlowly(terminal, SECOND_QUEUED_PROMPT)
  await delay(150)
  terminal.write('\u001b\r')
  const secondQueueScreen = await waitForVisibleTexts(['queued 2', SECOND_QUEUED_PROMPT], 'second queued input')

  stage('wait for steering and queue drain')
  await waitFor(() => (mock?.getRequestCount() ?? 0) >= 4, 'four model requests')
  await waitForVisibleText('QUEUE_TWO_RESPONSE_COMPLETE', 'final queued response')
  await waitFor(() => {
    const screen = headless ? readHeadlessScreen(headless) : ''
    return screen.includes('● ready') && !screen.includes('queued') && !screen.includes('steering')
  }, 'Flow idle after queue drain')

  const expectedUserTurns = [
    INITIAL_PROMPT,
    STEERING_PROMPT,
    FIRST_QUEUED_PROMPT,
    SECOND_QUEUED_PROMPT,
  ]
  stage('verify committed user rows')
  let committedScreen = ''
  await waitFor(() => {
    committedScreen = headless ? readHeadlessScreen(headless) : ''
    return hasOrderedText(committedScreen, expectedUserTurns.map(prompt => `> ${prompt}`))
  }, 'ordered committed user rows')
  const screenUserTurns = extractSmokeUserTurns(committedScreen)

  stage('exercise resize and flow status')
  terminal.resize(72, 22)
  headless.resize(72, 22)
  await delay(100)
  terminal.resize(132, 40)
  headless.resize(132, 40)
  await delay(100)
  await typeSlowly(terminal, '/flow status')
  await delay(150)
  terminal.write('\r')
  await waitForVisibleText('flowUi=on', '/flow status feature report')

  stage('exit deterministically')
  await typeSlowly(terminal, '/exit')
  await delay(150)
  terminal.write('\r')
  const exitResult = await withTimeout(exit.promise, 10_000, 'TurboFlux did not exit after /exit')
  if (exitResult.exitCode !== 0) throw new Error(`TurboFlux exited with code ${exitResult.exitCode}`)

  stage('verify committed journal order')
  const userTurns = await waitForUserTurns(conversationsPath, expectedUserTurns)

  stage('verify telemetry and terminal output')
  const telemetryPath = join(workspacePath, '.turboflux', 'telemetry', 'flow-metrics-v1.json')
  await waitForFile(telemetryPath)
  const snapshot = JSON.parse(readFileSync(telemetryPath, 'utf8')) as LocalFlowTelemetrySnapshot
  const report = buildTerminalBaselineReport(snapshot, {
    label: `${process.platform}-pty-smoke`,
    transport: process.platform === 'win32' ? 'conpty' : 'local',
    interactive: true,
    columns: 132,
    rows: 40,
    minimumSamples: 1,
  })
  const plainOutput = normalizeTerminalOutput(rawOutput.join(''))
  const finalScreen = readHeadlessScreen(headless)
  const assertions = {
    flowIdentity: plainOutput.includes('Flow v2 ready'),
    steeringVisible: steeringScreen.includes(STEERING_PROMPT),
    firstQueueVisible: firstQueueScreen.includes(FIRST_QUEUED_PROMPT),
    secondQueueVisible: secondQueueScreen.includes(SECOND_QUEUED_PROMPT),
    allResponses: RESPONSE_BY_REQUEST.every(response => plainOutput.includes(response)),
    finalResponseOnScreen: finalScreen.includes('QUEUE_TWO_RESPONSE_COMPLETE') || plainOutput.includes('QUEUE_TWO_RESPONSE_COMPLETE'),
    committedScreenOrder: screenUserTurns.join('|') === expectedUserTurns.join('|'),
    committedJournalOrder: userTurns.join('|') === expectedUserTurns.join('|'),
    focusSequencesFiltered: userTurns.every(turn => !turn.includes('[I') && !turn.includes('[O')),
    flowStatus: plainOutput.includes('flowUi=on'),
    boundedOutput: Buffer.byteLength(rawOutput.join(''), 'utf8') < 8 * 1024 * 1024,
    noListenerWarnings: !plainOutput.includes('MaxListenersExceededWarning'),
    telemetrySamples: Object.values(report.proxyMetrics).every(summary => (summary?.count ?? 0) > 0),
    safetyGate: report.gate.safetyStatus === 'passed',
  }
  const failures = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name)
  if (failures.length > 0) {
    throw new Error(`TUI smoke assertions failed: ${failures.join(', ')}; blockers: ${report.gate.blockers.join('; ')}`)
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    platform: process.platform,
    transport: report.environment.transport,
    stages,
    requestCount: mock.getRequestCount(),
    screenUserTurns,
    userTurns,
    assertions,
    samples: Object.fromEntries(Object.entries(report.proxyMetrics).map(([metric, summary]) => [metric, summary?.count ?? 0])),
    p95UpperBoundsMs: Object.fromEntries(Object.entries(report.proxyMetrics).map(([metric, summary]) => [metric, summary?.p95UpperBound ?? null])),
    evidenceBoundary: 'PTY output and headless terminal screen; not compositor physical paint',
  }, null, 2)}\n`)
}

function stage(label: string): void {
  stages.push(label)
  process.stderr.write(`[tui-smoke] ${label}\n`)
}

function spawnTurboFlux(workspace: string, config: string, conversations: string): pty.IPty {
  const require = createRequire(import.meta.url)
  const tsxLoader = pathToFileURL(require.resolve('tsx')).href
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  Object.assign(environment, {
    TURBOFLUX_CONFIG_DIR: config,
    TURBOFLUX_CONVERSATIONS_DIR: conversations,
    TURBOFLUX_API_KEY: 'turboflux-smoke-key',
    TURBOFLUX_FLOW: '1',
    TURBOFLUX_DESKTOP_NOTIFICATIONS: '0',
    TURBOFLUX_REDUCED_MOTION: '1',
    TURBOFLUX_TELEMETRY: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'xterm-256color',
  })
  return pty.spawn(process.execPath, ['--import', tsxLoader, resolve('src/cli/index.ts'), workspace, '--no-animation'], {
    name: 'xterm-256color',
    cols: 110,
    rows: 34,
    cwd: process.cwd(),
    env: environment,
    useConpty: process.platform === 'win32',
  })
}

function writeIsolatedConfiguration(directory: string, baseUrl: string): void {
  const now = Date.now()
  writeFileSync(join(directory, 'config.json'), `${JSON.stringify({
    provider: 'custom',
    apiKey: '',
    baseUrl,
    model: 'turboflux-smoke-model',
    contextWindow: 200_000,
    maxTokens: 2_048,
    approvalPolicy: 'full',
    capabilityProfile: 'read-only',
    gitEnabled: false,
    apiConfigs: [{
      id: 'smoke',
      name: 'Smoke',
      provider: 'custom',
      apiKey: '',
      baseUrl,
      model: 'turboflux-smoke-model',
      contextWindow: 200_000,
      maxTokens: 2_048,
      createdAt: now,
      updatedAt: now,
    }],
    activeApiConfigId: 'smoke',
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(directory, 'profile.json'), `${JSON.stringify({
    version: 3,
    interfaceLanguage: 'en',
    aiOutputLanguage: 'en',
    enabledPersonaIds: ['engineer-professional'],
    defaultPersonaId: 'engineer-professional',
    customPersonaName: '',
    customPersonaPrompt: '',
    customInstructions: '',
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
}

async function createMockModelServer(): Promise<MockModelServer> {
  let requestCount = 0
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'turboflux-smoke-model', context_window: 200_000 }] }))
      return
    }
    request.on('data', () => {})
    request.on('end', () => {
      const requestIndex = requestCount++
      const responseText = RESPONSE_BY_REQUEST[requestIndex] ?? `EXTRA_RESPONSE_${requestIndex + 1}`
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const fragments = requestIndex === 0
        ? Array.from({ length: 24 }, (_, index) => index === 23 ? responseText : `FIRST_${index}_`)
        : [responseText]
      let fragmentIndex = 0
      const timer = setInterval(() => {
        const content = fragments[fragmentIndex]
        if (content !== undefined) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
          fragmentIndex += 1
          return
        }
        clearInterval(timer)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, requestIndex === 0 ? 45 : 18)
      response.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  return { server, getRequestCount: () => requestCount }
}

function normalizeTerminalOutput(value: string): string {
  return stripAnsi(value).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function readHeadlessScreen(value: HeadlessTerminal): string {
  const buffer = value.buffer.active
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}

function hasOrderedText(value: string, expected: string[]): boolean {
  let cursor = 0
  for (const text of expected) {
    const index = value.indexOf(text, cursor)
    if (index < 0) return false
    cursor = index + text.length
  }
  return true
}

function extractSmokeUserTurns(value: string): string[] {
  const expected = new Set([INITIAL_PROMPT, STEERING_PROMPT, FIRST_QUEUED_PROMPT, SECOND_QUEUED_PROMPT])
  return value
    .split(/\r?\n/)
    .map(line => line.match(/^\s*>\s+(FLOW_[A-Z_]+)/)?.[1])
    .filter((turn): turn is string => typeof turn === 'string' && expected.has(turn))
}

async function waitForVisibleText(expected: string, label: string): Promise<string> {
  return waitForVisibleTexts([expected], label)
}

async function waitForVisibleTexts(expected: string[], label: string): Promise<string> {
  let visible = ''
  await waitFor(() => {
    visible = headless ? readHeadlessScreen(headless) : ''
    const output = normalizeTerminalOutput(rawOutput.join(''))
    return expected.every(text => visible.includes(text) || output.includes(text))
  }, label)
  return visible || normalizeTerminalOutput(rawOutput.join(''))
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await delay(25)
  }
}

async function waitForUserTurns(directory: string, expected: string[]): Promise<string[]> {
  let turns: string[] = []
  await waitFor(() => {
    turns = readUserTurns(directory).filter(turn => expected.includes(turn))
    return expected.every(prompt => turns.includes(prompt))
  }, 'committed user turns', 10_000)
  return turns
}

function readUserTurns(directory: string): string[] {
  const files = collectFiles(directory).filter(file => file.endsWith('.jsonl'))
  const turns: Array<{ id: string; content: string }> = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          turn?: { id?: string; role?: string; content?: string }
          conversation?: { turns?: Array<{ id?: string; role?: string; content?: string }> }
        }
        if (entry.type === 'turn' && entry.turn?.role === 'user' && typeof entry.turn.content === 'string') {
          upsertUserTurn(turns, entry.turn)
        }
        if (entry.type === 'snapshot' && Array.isArray(entry.conversation?.turns)) {
          turns.length = 0
          for (const turn of entry.conversation.turns) {
            if (turn.role === 'user' && typeof turn.content === 'string') upsertUserTurn(turns, turn)
          }
        }
      } catch {}
    }
  }
  return turns.map(turn => turn.content)
}

function upsertUserTurn(
  turns: Array<{ id: string; content: string }>,
  turn: { id?: string; content: string },
): void {
  const id = turn.id || `content:${turn.content}`
  const index = turns.findIndex(existing => existing.id === id)
  if (index >= 0) turns[index] = { id, content: turn.content }
  else turns.push({ id, content: turn.content })
}

function describeJournalFiles(directory: string): Array<{ file: string; entries: string[] }> {
  try {
    return collectFiles(directory)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => ({
        file,
        entries: readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .map(line => {
            try {
              const entry = JSON.parse(line) as { type?: unknown }
              return typeof entry.type === 'string' ? entry.type : 'unknown'
            } catch {
              return 'invalid-json'
            }
          }),
      }))
  } catch (error) {
    return [{ file: directory, entries: [`unreadable: ${error instanceof Error ? error.message : String(error)}`] }]
  }
}

function collectFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(path))
    else files.push(path)
  }
  return files
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      readFileSync(filePath)
      return
    } catch {
      if (Date.now() >= deadline) throw new Error('TUI telemetry was not flushed on exit')
      await delay(25)
    }
  }
}

async function typeSlowly(child: pty.IPty, value: string, intervalMs = 2): Promise<void> {
  for (const character of value) {
    child.write(character)
    await delay(intervalMs)
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred
    rejectPromise = rejectDeferred
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function closeServer(value: Server | undefined): Promise<void> {
  if (!value?.listening) return
  value.closeAllConnections?.()
  await Promise.race([
    new Promise<void>(resolveClose => value.close(() => resolveClose())),
    delay(1_000),
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}
