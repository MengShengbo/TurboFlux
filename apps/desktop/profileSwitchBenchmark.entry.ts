import { app } from 'electron'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  configureActiveProfilePaths,
  InstallationProfileRegistry,
  type ProfileContext,
} from '@turboflux/agent-core/workbench'
import { DesktopRuntimeHost } from './runtimeHost'
import { switchDesktopProfile } from './profileSwitchCoordinator'
import { captureGithubActionsProvenance } from '../../scripts/github-actions-provenance.mjs'
import { writeSourceEvidenceReportAtomically } from '../../scripts/source-evidence-report.mjs'

const SAMPLE_COUNT = 20
const P95_BUDGET_MS = 2_000
const STAGE_TIMEOUT_MS = 15_000

function progress(stage: string): void {
  process.stderr.write(`[profile-switch-benchmark] ${stage}\n`)
}

async function withStageTimeout<T>(stage: string, operation: Promise<T>): Promise<T> {
  progress(`${stage}:start`)
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} exceeded ${STAGE_TIMEOUT_MS}ms`)), STAGE_TIMEOUT_MS)
      }),
    ])
    progress(`${stage}:complete`)
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!
}

function applyProfileContext(context: ProfileContext): void {
  configureActiveProfilePaths({
    configRoot: context.storage.configRoot,
    conversationsRoot: context.storage.conversationsRoot,
    userSkillsRoot: context.storage.userSkillsRoot,
    globalMcpSettingsPath: context.storage.settingsPath,
  })
}

app.commandLine.appendSwitch('disable-gpu')
app.once('ready', () => app.dock?.hide())

void withStageTimeout('electron-ready', app.whenReady()).then(async () => {
const root = await mkdtemp(join(tmpdir(), 'turboflux-profile-switch-benchmark-'))
const workspacePath = join(root, 'workspace')
const reportPath = join(process.cwd(), 'apps', 'desktop', 'generated', 'profile-benchmarks', `profile-switch-stable-${process.platform}-${process.arch}.json`)
let host: DesktopRuntimeHost | null = null
let benchmarkError: unknown
const destroyHost = async (): Promise<void> => {
  const current = host
  host = null
  if (current) await current.destroy()
}
try {
  await mkdir(workspacePath, { recursive: true })
  const registry = new InstallationProfileRegistry(join(root, 'data'), { deviceRoot: join(root, 'device') })
  registry.initialize()
  registry.create({ displayName: 'Benchmark secondary profile' })
  let active = registry.activeContext()
  applyProfileContext(active)

  const startRuntime = async () => {
    host = await withStageTimeout('runtime-start', DesktopRuntimeHost.create(workspacePath, {
      profileStorage: active.storage,
    }))
    return host
  }
  await startRuntime()

  const samples: number[] = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    progress(`switch-${index + 1}:start`)
    const profiles = registry.snapshot().profiles.filter(profile => profile.state !== 'trashed')
    const targetProfile = profiles.find(profile => profile.id !== active.profile.id)!
    const target = registry.context(targetProfile.id)
    const startedAt = performance.now()
    await switchDesktopProfile({
      previous: active,
      target,
      transitionBlocker: () => null,
      beforeSwitch: async () => undefined,
      resetRuntime: destroyHost,
      destroyTerminal: () => undefined,
      closeRemote: async () => undefined,
      activate: profileId => registry.activate(profileId),
      applyContext: context => {
        active = context
        applyProfileContext(context)
      },
      startRuntime,
      startRemote: async () => undefined,
      broadcast: () => undefined,
    })
    samples.push(performance.now() - startedAt)
    progress(`switch-${index + 1}:complete`)
  }

  const p95Ms = percentile95(samples)
  const report = {
    schemaVersion: 2,
    provenance: captureGithubActionsProvenance(),
    qualification: 'stable',
    completedAt: new Date().toISOString(),
    command: 'npm run perf:profile-switch:stable',
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      electron: process.versions.electron,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    },
    samples: samples.map(value => Number(value.toFixed(2))),
    p50Ms: Number([...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    budgetMs: P95_BUDGET_MS,
    passed: p95Ms < P95_BUDGET_MS,
  }
  const sanitizedReport = await writeSourceEvidenceReportAtomically(reportPath, report)
  process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} catch (error) {
  benchmarkError = error
  process.stderr.write('[profile-switch-benchmark] failed\n')
  process.exitCode = 1
} finally {
  await destroyHost().catch(() => undefined)
  configureActiveProfilePaths(undefined)
  await rm(root, { recursive: true, force: true })
  const exitCode = benchmarkError ? 1 : Number(process.exitCode ?? 0)
  app.exit(Number.isFinite(exitCode) ? exitCode : 1)
}
}).catch(error => {
  void error
  process.stderr.write('[profile-switch-benchmark] bootstrap failed\n')
  app.exit(1)
})
