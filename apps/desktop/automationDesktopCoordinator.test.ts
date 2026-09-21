import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationCoordinator,
  AutomationRepository,
  AutomationService,
  WorkbenchRuntime,
  type TurboFluxConfig,
} from '@turboflux/workbench'
import { WorkspaceRuntimePool } from './workspaceRuntimePool'
import { DesktopRuntimeHost } from './runtimeHost'

vi.mock('electron', () => ({ nativeImage: {}, safeStorage: {} }))

const directories: string[] = []

function config(): TurboFluxConfig {
  return {
    provider: 'custom',
    apiKey: 'desktop-coordinator-test',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    contextWindow: 200_000,
    maxTokens: 16_384,
    approvalPolicy: 'ask',
    capabilityProfile: 'workspace-write',
    gitEnabled: false,
    apiConfigs: [],
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.TURBOFLUX_CONVERSATIONS_DIR
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Desktop settings during execution', () => {
  it.each(['running', 'paused', 'awaiting-action', 'error'] as const)('saves preferences while a conversation is %s', async status => {
    const snapshot = {
      workspace: { path: '/workspace' },
      conversationRuntimes: [{ conversationId: 'conversation-1', status }],
    }
    const saveSettings = vi.fn(async () => ({ settings: {}, snapshot }))
    const invalidateConfiguration = vi.fn(async () => undefined)
    const host: DesktopRuntimeHost = Object.assign(Object.create(DesktopRuntimeHost.prototype), {
      runtime: { getSnapshot: () => snapshot, saveSettings },
      runtimeTransitioning: false,
      workspaceRuntimePool: {
        snapshot: () => ({ activeWorkspaces: ['/workspace'] }),
        invalidateConfiguration,
      },
      decorateSnapshot: (value: unknown) => value,
    })
    const update = { apiProfiles: [], profile: {}, approvalPolicy: 'ask' as const, capabilityProfile: 'workspace-write' as const, gitEnabled: false }
    await expect(host.saveSettings(update)).resolves.toMatchObject({ snapshot })
    expect(saveSettings).toHaveBeenCalledWith(update)
    expect(invalidateConfiguration).toHaveBeenCalledOnce()
    Object.assign(host, { runtimeTransitioning: true })
    await expect(host.saveSettings(update)).rejects.toThrow('更新工作环境')
    expect(saveSettings).toHaveBeenCalledOnce()
  })
})

describe('Desktop runtime host shutdown', () => {
  function harness() {
    const stages = {
      coordinatorStop: vi.fn(async () => undefined),
      poolDestroy: vi.fn(async () => undefined),
      coordinatorIdle: vi.fn(async () => undefined),
      foregroundDestroy: vi.fn(async () => undefined),
    }
    const listeners = new Set([vi.fn()])
    const host: DesktopRuntimeHost = Object.assign(Object.create(DesktopRuntimeHost.prototype), {
      workPackUpdateTimer: null,
      taskTitleApplyGates: new Map(),
      unsubscribeRuntime: vi.fn(),
      automationCoordinator: { stop: stages.coordinatorStop, waitForIdle: stages.coordinatorIdle },
      workspaceRuntimePool: { destroy: stages.poolDestroy },
      runtime: { destroy: stages.foregroundDestroy },
      listeners,
    })
    return { host, stages, listeners }
  }

  it.each(['coordinatorStop', 'poolDestroy', 'foregroundDestroy'] as const)(
    'attempts every cleanup stage and reports failure when %s throws', async stage => {
      const { host, stages, listeners } = harness()
      const failure = new Error(`${stage} failed`)
      stages[stage].mockImplementationOnce(() => { throw failure })

      const result = await host.destroy().catch(error => error)

      for (const cleanup of Object.values(stages)) expect(cleanup).toHaveBeenCalledTimes(1)
      expect(listeners.size).toBe(0)
      expect(result).toBeInstanceOf(AggregateError)
      expect(result.errors).toContain(failure)
    },
  )

  it('shares the shutdown barrier across concurrent callers', async () => {
    const { host, stages } = harness()
    const first = host.destroy()
    const second = host.destroy()
    await Promise.all([first, second])
    for (const cleanup of Object.values(stages)) expect(cleanup).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })
})

describe('Desktop global automation execution', () => {
  it('runs two due workspaces in background runtimes without navigating the foreground workbench', async () => {
    let now = Date.now()
    const root = mkdtempSync(join(tmpdir(), 'turboflux-desktop-coordinator-'))
    const storagePath = join(root, 'platform')
    const workspaceA = join(root, 'workspace-a')
    const workspaceB = join(root, 'workspace-b')
    const conversationsPath = join(root, 'conversations')
    directories.push(root)
    mkdirSync(workspaceA, { recursive: true })
    mkdirSync(workspaceB, { recursive: true })
    process.env.TURBOFLUX_CONVERSATIONS_DIR = conversationsPath
    const service = new AutomationService(join(storagePath, 'automations.json'))
    const foreground = new WorkbenchRuntime({
      workspacePath: workspaceA,
      storagePath,
      config: config(),
      automationService: service,
      automationScheduling: 'external',
    })
    await foreground.initializePlatform()
    const foregroundConversationId = foreground.getSnapshot().conversation.id
    let enginePrototype: { run: (...args: unknown[]) => Promise<unknown> } | undefined
    const backgroundRuntimes: WorkbenchRuntime[] = []
    const repository = new AutomationRepository(join(storagePath, 'automations-v3'), { now: () => now })
    const pool = new WorkspaceRuntimePool({
      automationService: service,
      automationRepository: repository,
      foregroundState: () => ({
        workspacePath: foreground.getSnapshot().workspace.path,
        busy: foreground.getSnapshot().conversationRuntimes.some(runtime => runtime.status !== 'ready'),
      }),
      createRuntime: async workspacePath => {
        const runtime = new WorkbenchRuntime({
          workspacePath,
          storagePath,
          config: config(),
          automationService: service,
          automationScheduling: 'external',
        })
        enginePrototype ??= Object.getPrototypeOf(runtime.runtime.engine) as typeof enginePrototype
        if (!vi.isMockFunction(enginePrototype!.run)) {
          vi.spyOn(enginePrototype!, 'run').mockResolvedValue([{
            id: `assistant-${workspacePath}`,
            role: 'assistant',
            content: `Completed ${workspacePath}`,
            timestamp: Date.now(),
          }])
        }
        await runtime.initializePlatform()
        backgroundRuntimes.push(runtime)
        return runtime
      },
    })
    const coordinator = new AutomationCoordinator(service, repository, pool, {
      ownerId: 'desktop-integration-host',
      now: () => now,
      leaseMs: 30_000,
      maxConcurrentRuns: 2,
    })
    coordinator.initialize()
    service.create({ name: 'Workspace A', prompt: 'Run A', workspacePath: workspaceA, schedule: { kind: 'interval', everyMinutes: 1 } })
    service.create({ name: 'Workspace B', prompt: 'Run B', workspacePath: workspaceB, schedule: { kind: 'interval', everyMinutes: 1 } })

    try {
      now = Date.now()
      now += 61_000
      const started = await coordinator.tick(now)
      await coordinator.waitForIdle()

      expect(started, JSON.stringify(coordinator.snapshot())).toHaveLength(2)
      expect(backgroundRuntimes).toHaveLength(2)
      expect(repository.listRuns()).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'completed', workspaceRef: { path: workspaceA } }),
        expect.objectContaining({ status: 'completed', workspaceRef: { path: workspaceB } }),
      ]))
      expect(foreground.getSnapshot()).toMatchObject({
        workspace: { path: workspaceA },
        conversation: { id: foregroundConversationId, turns: [] },
      })
    } finally {
      await coordinator.stop()
      await pool.destroy()
      await coordinator.waitForIdle()
      await foreground.destroy()
    }
  })
})
