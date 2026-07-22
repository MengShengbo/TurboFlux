import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/core/config'
import { configureNetworkProxy } from '../src/core/networkProxy'
import { fileSha256, prepareManifest, readManifest, writeManifest } from './retrieval-paper/datasets'
import { generateReport } from './retrieval-paper/report'
import { installedCliVersions, MODEL, runRetrievalSystem } from './retrieval-paper/runners'
import { BenchmarkWorkspaceCache } from './retrieval-paper/workspace'
import type { ExperimentMetadata, RetrievalSystemId, RunRecord } from './retrieval-paper/types'

const DEFAULT_MANIFEST = resolve('benchmark-data', 'retrieval-paper-v1', 'manifest.json')
const DEFAULT_OUTPUT = resolve('benchmark-results', '2026-07-22-gpt-5.5-paper')
const ALL_SYSTEMS: RetrievalSystemId[] = [
  'fastcontext-low',
  'fastcontext-medium',
  'fastcontext-max',
  'claude-code-readonly',
  'opencode-explore',
  'neutral-tool-agent',
  'bm25',
]

interface Args {
  command: 'prepare' | 'calibrate' | 'run' | 'report'
  manifest: string
  output: string
  perDataset: number
  limit?: number
  repeats: number
  seed: number
  timeoutMs: number
  systems: RetrievalSystemId[]
  retryTransient: boolean
}

function option(name: string): string | undefined {
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function parseSystems(value: string | undefined): RetrievalSystemId[] {
  if (!value || value === 'all') return [...ALL_SYSTEMS]
  const systems = value.split(',').map(item => item.trim()).filter(Boolean) as RetrievalSystemId[]
  for (const system of systems) {
    if (!ALL_SYSTEMS.includes(system)) throw new Error(`Unknown system ${system}. Valid systems: ${ALL_SYSTEMS.join(', ')}`)
  }
  return [...new Set(systems)]
}

function parseArgs(): Args {
  const candidate = process.argv[2]
  const command = candidate === 'prepare' || candidate === 'calibrate' || candidate === 'run' || candidate === 'report' ? candidate : 'calibrate'
  const calibration = command === 'calibrate'
  const defaultOutput = calibration ? `${DEFAULT_OUTPUT}-calibration` : DEFAULT_OUTPUT
  return {
    command,
    manifest: resolve(option('--manifest') || DEFAULT_MANIFEST),
    output: resolve(option('--output') || defaultOutput),
    perDataset: numberOption('--per-dataset', 100),
    limit: option('--limit') ? numberOption('--limit', 6) : calibration ? 6 : undefined,
    repeats: numberOption('--repeats', calibration ? 1 : 3),
    seed: numberOption('--seed', 20260722),
    timeoutMs: numberOption('--timeout-seconds', calibration ? 240 : 600) * 1000,
    systems: parseSystems(option('--systems')),
    retryTransient: process.argv.includes('--retry-transient'),
  }
}

function readJournal(path: string): RunRecord[] {
  if (!existsSync(path)) return []
  const runs: RunRecord[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try { runs.push(JSON.parse(line) as RunRecord) } catch {}
  }
  return runs
}

function redact(value: string | undefined, secret: string): string | undefined {
  return value && secret ? value.split(secret).join('***') : value
}

function safeRecord(record: RunRecord, apiKey: string): RunRecord {
  return { ...record, rawOutput: redact(record.rawOutput, apiKey) || '', error: redact(record.error, apiKey) }
}

function rotate<T>(items: T[], offset: number): T[] {
  if (items.length === 0) return []
  const normalized = ((offset % items.length) + items.length) % items.length
  return [...items.slice(normalized), ...items.slice(0, normalized)]
}

function balancedCases<T extends { dataset: string; language: string }>(items: T[], limit: number | undefined): T[] {
  if (!limit || limit >= items.length) return [...items]
  const datasets = new Map<string, T[]>()
  for (const item of items) {
    const group = datasets.get(item.dataset) || []
    group.push(item)
    datasets.set(item.dataset, group)
  }
  const datasetQueues = [...datasets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, datasetItems]) => {
    const languages = new Map<string, T[]>()
    for (const item of datasetItems) {
      const group = languages.get(item.language) || []
      group.push(item)
      languages.set(item.language, group)
    }
    const languageQueues = [...languages.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => group)
    const ordered: T[] = []
    while (languageQueues.some(queue => queue.length > 0)) {
      for (const queue of languageQueues) {
        const next = queue.shift()
        if (next) ordered.push(next)
      }
    }
    return ordered
  })
  const selected: T[] = []
  while (selected.length < limit && datasetQueues.some(queue => queue.length > 0)) {
    for (const queue of datasetQueues) {
      const next = queue.shift()
      if (next) selected.push(next)
      if (selected.length >= limit) break
    }
  }
  return selected
}

function experimentMetadata(args: Args, manifestPath: string, caseIds: string[]): ExperimentMetadata {
  const createdAt = new Date().toISOString()
  const suffix = args.command === 'calibrate' ? 'calibration' : 'formal'
  return {
    schemaVersion: 1,
    experimentId: `${createdAt.slice(0, 10)}-gpt-5.5-no-reasoning-${suffix}`,
    createdAt,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    model: MODEL,
    reasoning: 'disabled',
    endpointHost: '',
    manifestPath: relative(process.cwd(), manifestPath).replace(/\\/g, '/'),
    manifestSha256: fileSha256(manifestPath),
    systems: args.systems,
    caseIds,
    repeats: args.repeats,
    timeoutMs: args.timeoutMs,
    seed: args.seed,
    cliVersions: installedCliVersions(),
    notes: [
      'All LLM systems use the active TurboFlux endpoint and gpt-5.5.',
      'Native reasoning is disabled; protocol differences are recorded per run.',
      args.command === 'calibrate' ? 'Calibration run; not a final comparative result.' : 'Formal repeated experiment.',
    ],
  }
}

async function ensureManifest(args: Args): Promise<void> {
  if (existsSync(args.manifest)) return
  mkdirSync(resolve(args.manifest, '..'), { recursive: true })
  console.log(`Preparing ${args.perDataset} cases per dataset...`)
  writeManifest(args.manifest, await prepareManifest({ perDataset: args.perDataset, seed: args.seed }))
}

async function runExperiment(args: Args): Promise<void> {
  await ensureManifest(args)
  mkdirSync(args.output, { recursive: true })
  const manifest = readManifest(args.manifest)
  const selectedCases = balancedCases(manifest.cases, args.limit)
  const config = await loadConfig()
  if (!config.apiKey || !config.baseUrl) throw new Error('Active TurboFlux API configuration is incomplete')
  const metadataPath = join(args.output, 'metadata.json')
  const journalPath = join(args.output, 'runs.jsonl')
  let metadata: ExperimentMetadata
  if (existsSync(metadataPath) && existsSync(journalPath)) {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as ExperimentMetadata
    if (!Array.isArray(metadata.caseIds)) {
      metadata.caseIds = selectedCases.map(item => item.id)
      writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    }
    const currentCliVersions = installedCliVersions()
    const incompatible = metadata.model !== MODEL
      || metadata.manifestSha256 !== fileSha256(args.manifest)
      || metadata.endpointHost !== new URL(config.baseUrl).host
      || metadata.repeats !== args.repeats
      || metadata.timeoutMs !== args.timeoutMs
      || metadata.seed !== args.seed
      || JSON.stringify(metadata.systems) !== JSON.stringify(args.systems)
      || JSON.stringify(metadata.caseIds) !== JSON.stringify(selectedCases.map(item => item.id))
      || JSON.stringify(metadata.cliVersions) !== JSON.stringify(currentCliVersions)
    if (incompatible) {
      throw new Error('Existing output directory uses a different model, endpoint, manifest, case set, system matrix, timeout, seed, repeat count, or CLI version')
    }
  } else {
    metadata = experimentMetadata(args, args.manifest, selectedCases.map(item => item.id))
    metadata.endpointHost = new URL(config.baseUrl).host
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  }
  const selectedManifestPath = join(args.output, 'selected-manifest.json')
  const selectedManifest = { ...manifest, cases: selectedCases }
  writeManifest(selectedManifestPath, selectedManifest)
  const existingRuns = readJournal(journalPath)
  const latestRuns = new Map(existingRuns.map(run => [run.runId, run]))
  const transientFailures = new Set(['timeout', 'protocol', 'authentication', 'rate_limit', 'model'])
  const completed = new Set([...latestRuns.values()]
    .filter(run => !args.retryTransient
      || run.success
      || (!transientFailures.has(run.failureKind) && !(run.system === 'neutral-tool-agent' && run.failureKind === 'unknown')))
    .map(run => run.runId))
  const cache = new BenchmarkWorkspaceCache()
  const total = selectedCases.length * args.systems.reduce((sum, system) => sum + (system === 'bm25' ? 1 : args.repeats), 0)
  let position = 0

  for (let caseIndex = 0; caseIndex < selectedCases.length; caseIndex += 1) {
    const item = selectedCases[caseIndex]
    console.log(`Workspace ${caseIndex + 1}/${selectedCases.length}: ${item.id} (${item.repository}@${item.baseCommit.slice(0, 10)})`)
    const workspace = await cache.prepare(item)
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      const systems = rotate(args.systems, caseIndex + repeat - 1)
      for (let order = 0; order < systems.length; order += 1) {
        const system = systems[order]
        if (system === 'bm25' && repeat > 1) continue
        const runId = `${metadata.experimentId}:${item.id}:${system}:${repeat}`
        position += 1
        if (completed.has(runId)) {
          console.log(`[${position}/${total}] resume skip ${system} :: ${item.id} #${repeat}`)
          continue
        }
        console.log(`[${position}/${total}] ${system} :: ${item.id} #${repeat}`)
        const record = safeRecord(await runRetrievalSystem(system, {
          experimentId: metadata.experimentId,
          item,
          workspacePath: workspace.path,
          repositoryStats: workspace.stats,
          config,
          repeat,
          order,
          timeoutMs: args.timeoutMs,
        }), config.apiKey)
        appendFileSync(journalPath, `${JSON.stringify(record)}\n`)
        completed.add(record.runId)
        console.log(`  ${record.success ? 'ok' : record.failureKind} ${(record.latencyMs / 1000).toFixed(1)}s R@10=${record.metrics.recallAt10.toFixed(2)} MRR=${record.metrics.reciprocalRank.toFixed(2)} req=${record.apiRequests}`)
      }
    }
  }
  generateReport({ outputDir: args.output, metadata, manifest: selectedManifest, runs: readJournal(journalPath) })
  console.log(`Report: ${relative(process.cwd(), join(args.output, 'report.md'))}`)
}

async function main(): Promise<void> {
  configureNetworkProxy()
  const args = parseArgs()
  if (args.command === 'prepare') {
    mkdirSync(resolve(args.manifest, '..'), { recursive: true })
    const manifest = await prepareManifest({ perDataset: args.perDataset, seed: args.seed })
    writeManifest(args.manifest, manifest)
    console.log(`Manifest: ${relative(process.cwd(), args.manifest)} (${manifest.cases.length} cases)`)
    return
  }
  if (args.command === 'report') {
    const metadata = JSON.parse(readFileSync(join(args.output, 'metadata.json'), 'utf8')) as ExperimentMetadata
    const selectedManifest = join(args.output, 'selected-manifest.json')
    const manifest = readManifest(existsSync(selectedManifest) ? selectedManifest : args.manifest)
    if (!Array.isArray(metadata.caseIds)) {
      metadata.caseIds = manifest.cases.map(item => item.id)
      writeFileSync(join(args.output, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    }
    generateReport({ outputDir: args.output, metadata, manifest, runs: readJournal(join(args.output, 'runs.jsonl')) })
    console.log(`Report: ${relative(process.cwd(), join(args.output, 'report.md'))}`)
    return
  }
  await runExperiment(args)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
