import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { LocalFlowTelemetrySnapshot } from '../src/cli/telemetry/localFlowTelemetry'
import {
  buildTerminalBaselineReport,
  type ExternalPaintEvidence,
  type TerminalTransport,
} from '../src/cli/telemetry/terminalBaseline'

interface CliOptions {
  telemetryPath: string
  outputPath?: string
  paintEvidencePath?: string
  label?: string
  transport?: TerminalTransport
  minimumSamples: number
  probeAckSamples: number
  strict: boolean
  help: boolean
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
} else {
  await run(options)
}

async function run(cliOptions: CliOptions): Promise<void> {
  if (!existsSync(cliOptions.telemetryPath)) {
    throw new Error(`Flow telemetry not found: ${cliOptions.telemetryPath}. Run an interactive TurboFlux session first.`)
  }
  const snapshot = JSON.parse(readFileSync(cliOptions.telemetryPath, 'utf8')) as LocalFlowTelemetrySnapshot
  if (snapshot.version !== 1) throw new Error('Unsupported flow telemetry schema')
  const physicalPaint = cliOptions.paintEvidencePath
    ? readPaintEvidence(cliOptions.paintEvidencePath)
    : undefined
  const terminalAckSamples = cliOptions.probeAckSamples > 0
    ? await probeTerminalAcknowledgement(cliOptions.probeAckSamples)
    : undefined
  const report = buildTerminalBaselineReport(snapshot, {
    label: cliOptions.label,
    transport: cliOptions.transport,
    minimumSamples: cliOptions.minimumSamples,
    terminalAckSamples,
    physicalPaint,
  })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (cliOptions.outputPath) writeReport(cliOptions.outputPath, serialized)
  process.stdout.write(serialized)
  if (cliOptions.strict && !report.gate.releaseReady) process.exitCode = 1
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {
    telemetryPath: resolve('.turboflux', 'telemetry', 'flow-metrics-v1.json'),
    minimumSamples: 20,
    probeAckSamples: 0,
    strict: false,
    help: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const next = args[index + 1]
    if (argument === '--help' || argument === '-h') parsed.help = true
    else if (argument === '--strict') parsed.strict = true
    else if (argument === '--telemetry') {
      parsed.telemetryPath = resolve(requireValue(argument, next))
      index += 1
    } else if (argument === '--output') {
      parsed.outputPath = resolve(requireValue(argument, next))
      index += 1
    } else if (argument === '--paint-evidence') {
      parsed.paintEvidencePath = resolve(requireValue(argument, next))
      index += 1
    } else if (argument === '--label') {
      parsed.label = requireValue(argument, next)
      index += 1
    } else if (argument === '--transport') {
      const value = requireValue(argument, next) as TerminalTransport
      if (!['local', 'conpty', 'ssh', 'container', 'unknown'].includes(value)) {
        throw new Error(`Invalid transport: ${value}`)
      }
      parsed.transport = value
      index += 1
    } else if (argument === '--minimum-samples') {
      parsed.minimumSamples = positiveInteger(argument, requireValue(argument, next))
      index += 1
    } else if (argument === '--probe-ack') {
      if (next && /^\d+$/.test(next)) {
        parsed.probeAckSamples = positiveInteger(argument, next)
        index += 1
      } else {
        parsed.probeAckSamples = 30
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return parsed
}

async function probeTerminalAcknowledgement(iterations: number): Promise<number[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('--probe-ack requires an interactive TTY')
  }
  const wasRaw = process.stdin.isRaw === true
  const wasPaused = process.stdin.isPaused()
  const samples: number[] = []
  process.stdin.setRawMode(true)
  process.stdin.resume()
  try {
    for (let index = 0; index < iterations; index += 1) {
      samples.push(await queryCursorRoundTrip())
    }
  } finally {
    process.stdin.setRawMode(wasRaw)
    if (wasPaused) process.stdin.pause()
  }
  return samples
}

function queryCursorRoundTrip(): Promise<number> {
  return new Promise((resolveSample, rejectSample) => {
    const startedAt = performance.now()
    let received = ''
    const onData = (chunk: Buffer | string) => {
      received += chunk.toString()
      if (!/\u001b\[\d+;\d+R/.test(received)) return
      cleanup()
      resolveSample(performance.now() - startedAt)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectSample(new Error('Terminal did not answer ANSI DSR within 1500ms'))
    }, 1_500)
    const cleanup = () => {
      clearTimeout(timer)
      process.stdin.off('data', onData)
    }
    process.stdin.on('data', onData)
    process.stdout.write('\u001b[6n')
  })
}

function readPaintEvidence(filePath: string): ExternalPaintEvidence {
  if (!existsSync(filePath)) throw new Error(`Physical paint evidence not found: ${filePath}`)
  const evidence = JSON.parse(readFileSync(filePath, 'utf8')) as ExternalPaintEvidence
  if (!evidence || evidence.schemaVersion !== 1 || typeof evidence.method !== 'string') {
    throw new Error('Invalid physical paint evidence schema')
  }
  return evidence
}

function writeReport(filePath: string, serialized: string): void {
  if (existsSync(filePath)) throw new Error(`Baseline report already exists: ${filePath}`)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function printHelp(): void {
  process.stdout.write([
    'TurboFlux terminal flow baseline',
    '',
    'Usage:',
    '  npm run baseline:terminal -- [options]',
    '',
    'Options:',
    '  --telemetry <path>       Flow telemetry JSON (default .turboflux/telemetry/flow-metrics-v1.json)',
    '  --label <name>           Matrix cell label, for example "Windows Terminal / ConPTY"',
    '  --transport <kind>       local|conpty|ssh|container|unknown',
    '  --probe-ack [count]      Measure ANSI DSR terminal acknowledgement (not physical paint)',
    '  --paint-evidence <path>  External physical-paint evidence JSON',
    '  --minimum-samples <n>    Required samples per metric (default 20)',
    '  --output <path>          Also write the report as JSON',
    '  --strict                 Exit non-zero unless proxy and physical-paint gates pass',
    '  --help                   Show this help',
    '',
  ].join('\n'))
}
