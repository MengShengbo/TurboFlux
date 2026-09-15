import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  configureActiveProfilePaths,
  ConversationInteractionStoreV2,
  getActiveProfilePaths,
  InstallationProfileRegistry,
  loadConfig,
  saveConfig,
  WorkspaceBindingService,
  type ProfileContext,
} from '@turboflux/agent-core/workbench'
import { describe, expect, it, vi } from 'vitest'
import { switchDesktopProfile } from './profileSwitchCoordinator'

interface Context {
  profile: { id: string; state: 'ready'; displayName: string }
}

function context(id: string): Context {
  return { profile: { id, state: 'ready', displayName: id } }
}

function applyProfilePaths(context: ProfileContext): void {
  configureActiveProfilePaths({
    configRoot: context.storage.configRoot,
    conversationsRoot: context.storage.conversationsRoot,
    userSkillsRoot: context.storage.userSkillsRoot,
    globalMcpSettingsPath: context.storage.settingsPath,
  })
}

function desktopSwitchHarness() {
  let active = context('profile-a')
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
  // Execute the production entrypoints while replacing Electron-owned resources.
  const functions = ['profileLifecycleTransitionBlocker', 'activateLocalProfile'].map(name => {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'))
    expect(start).toBeGreaterThanOrEqual(0)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  })
  const bindings = {
    profileSwitchInProgress: false,
    profileArchiveService: null,
    runtimeHost: { transitionBlocker: () => null as string | null },
    terminalSystem: null,
    computerLeaseOwnerId: null,
    remoteHostManager: null,
    getActiveProfileContext: vi.fn(async () => active),
    profileRegistry: { context, activate: context },
    requireText: (value: string) => value,
    switchDesktopProfile,
    persistAutomationNotificationState: vi.fn(async () => undefined),
    resetRuntimeHost: vi.fn(async () => undefined),
    closeRemoteHostManager: vi.fn(async () => undefined),
    applyActiveProfileContext: (next: Context) => { active = next },
    getRuntimeHost: vi.fn(async () => ({ getSnapshot: () => ({ profileId: active.profile.id }) })),
    getRemoteHostManager: vi.fn(async () => undefined),
    broadcastRuntimeEvent: vi.fn(),
  }
  const entrypoints = runInNewContext(
    `${functions.join('\n')}\n({ activateLocalProfile, profileLifecycleTransitionBlocker })`,
    bindings,
  ) as {
    activateLocalProfile(id: string): Promise<{ snapshot: { profileId: string } }>
    profileLifecycleTransitionBlocker(): string | null
  }
  return { ...entrypoints, bindings }
}

describe('desktop profile switch entrypoint', () => {
  it('allows the switch that owns the transition lock to reach the coordinator', async () => {
    const harness = desktopSwitchHarness()
    await expect(harness.activateLocalProfile('profile-b')).resolves.toMatchObject({
      snapshot: { profileId: 'profile-b' },
    })
    expect(harness.profileLifecycleTransitionBlocker()).toBeNull()
  })

  it('rejects a competing switch before it reads the active profile and keeps the owner locked', async () => {
    const harness = desktopSwitchHarness()
    let release!: (value: Context) => void
    harness.bindings.getActiveProfileContext.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = harness.activateLocalProfile('profile-b')
    const firstResult = first.catch(error => error)
    try {
      await expect(harness.activateLocalProfile('profile-c')).rejects.toThrow()
      expect(harness.bindings.getActiveProfileContext).toHaveBeenCalledTimes(1)
      expect(harness.profileLifecycleTransitionBlocker()).not.toBeNull()
    } finally {
      release(context('profile-a'))
      await firstResult
    }
    await expect(first).resolves.toMatchObject({ snapshot: { profileId: 'profile-b' } })
    expect(harness.profileLifecycleTransitionBlocker()).toBeNull()
  })

  it('still blocks switching when foreground work is active', async () => {
    const harness = desktopSwitchHarness()
    harness.bindings.runtimeHost.transitionBlocker = () => 'foreground work is active'
    await expect(harness.activateLocalProfile('profile-b')).rejects.toThrow('foreground work is active')
    expect(harness.bindings.resetRuntimeHost).not.toHaveBeenCalled()
    expect(harness.bindings.profileSwitchInProgress).toBe(false)
  })

  it('releases the transition lock when reading the profile fails', async () => {
    const harness = desktopSwitchHarness()
    harness.bindings.getActiveProfileContext.mockRejectedValueOnce(new Error('profile unavailable'))
    await expect(harness.activateLocalProfile('profile-b')).rejects.toThrow('profile unavailable')
    expect(harness.profileLifecycleTransitionBlocker()).toBeNull()
    await expect(harness.activateLocalProfile('profile-b')).resolves.toMatchObject({
      snapshot: { profileId: 'profile-b' },
    })
  })
})

describe('desktop profile switch coordinator', () => {
  it.each(['resetRuntime', 'destroyTerminal', 'closeRemote', 'activate', 'applyContext'] as const)(
    'restores the previous profile when %s fails during the transition', async stage => {
      const previous = context('profile-a')
      const target = context('profile-b')
      let active = previous
      const failure = new Error(`${stage} failed`)
      const options = {
        previous, target,
        transitionBlocker: () => null,
        beforeSwitch: vi.fn(async () => undefined),
        resetRuntime: vi.fn(async () => undefined),
        destroyTerminal: vi.fn(() => undefined),
        closeRemote: vi.fn(async () => undefined),
        activate: vi.fn((id: string) => id === previous.profile.id ? previous : target),
        applyContext: vi.fn((next: Context) => { active = next }),
        startRuntime: vi.fn(async () => ({ getSnapshot: () => ({ profileId: active.profile.id }) })),
        startRemote: vi.fn(async () => undefined),
        broadcast: vi.fn(),
      }
      options[stage].mockImplementationOnce(() => { throw failure })

      await expect(switchDesktopProfile(options)).rejects.toBe(failure)

      expect(active.profile.id).toBe(previous.profile.id)
      expect(options.activate).toHaveBeenLastCalledWith(previous.profile.id)
      expect(options.startRuntime).toHaveBeenCalledTimes(1)
      expect(options.startRemote).toHaveBeenCalledTimes(1)
      expect(options.broadcast).toHaveBeenCalledWith({ profileId: previous.profile.id })
    },
  )

  it('reports failed recovery and closes remote access even when runtime cleanup fails', async () => {
    const previous = context('profile-a')
    const target = context('profile-b')
    const startupFailure = new Error('target startup failed')
    const cleanupFailure = new Error('target teardown failed')
    const resetRuntime = vi.fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cleanupFailure)
    const closeRemote = vi.fn(async () => undefined)
    const activate = vi.fn((id: string) => id === previous.profile.id ? previous : target)
    const result = await switchDesktopProfile({
      previous, target,
      transitionBlocker: () => null,
      beforeSwitch: async () => undefined,
      resetRuntime,
      destroyTerminal: () => undefined,
      closeRemote,
      activate,
      applyContext: () => undefined,
      startRuntime: async () => { throw startupFailure },
      startRemote: async () => undefined,
      broadcast: () => undefined,
    }).catch(error => error)

    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toEqual([startupFailure, cleanupFailure])
    expect(closeRemote).toHaveBeenCalledTimes(2)
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('releases every runtime and remote boundary during 100 repeated switches', async () => {
    const contexts = new Map([['profile-a', context('profile-a')], ['profile-b', context('profile-b')]])
    let active = contexts.get('profile-a')!
    let runtimeGeneration = 0
    let liveRuntime = false
    let liveRemote = false
    let liveTerminal = true
    const beforeSwitch = vi.fn(async () => undefined)
    const resetRuntime = vi.fn(async () => { liveRuntime = false })
    const closeRemote = vi.fn(async () => { liveRemote = false })
    const destroyTerminal = vi.fn(() => { liveTerminal = false })
    const startRuntime = vi.fn(async () => {
      if (liveRuntime) throw new Error('runtime leaked across profile switch')
      liveRuntime = true
      runtimeGeneration += 1
      return { getSnapshot: () => ({ profileId: active.profile.id, runtimeGeneration }) }
    })
    const startRemote = vi.fn(async () => {
      if (liveRemote) throw new Error('remote host leaked across profile switch')
      liveRemote = true
    })

    for (let index = 0; index < 100; index += 1) {
      liveTerminal = true
      const target = contexts.get(index % 2 === 0 ? 'profile-b' : 'profile-a')!
      const result = await switchDesktopProfile({
        previous: active,
        target,
        transitionBlocker: () => null,
        beforeSwitch,
        resetRuntime,
        destroyTerminal,
        closeRemote,
        activate: profileId => contexts.get(profileId)!,
        applyContext: next => { active = next },
        startRuntime,
        startRemote,
        broadcast: snapshot => expect(snapshot.profileId).toBe(active.profile.id),
      })
      expect(result.profile.id).toBe(target.profile.id)
      expect(liveRuntime).toBe(true)
      expect(liveRemote).toBe(true)
      expect(liveTerminal).toBe(false)
    }

    expect(beforeSwitch).toHaveBeenCalledTimes(100)
    expect(resetRuntime).toHaveBeenCalledTimes(100)
    expect(closeRemote).toHaveBeenCalledTimes(100)
    expect(destroyTerminal).toHaveBeenCalledTimes(100)
    expect(startRuntime).toHaveBeenCalledTimes(100)
    expect(startRemote).toHaveBeenCalledTimes(100)
  })

  it('restores the previous profile when the new runtime fails to start', async () => {
    const previous = context('profile-a')
    const target = context('profile-b')
    let active = previous
    let attempts = 0
    const startRemote = vi.fn(async () => undefined)
    const broadcast = vi.fn()
    await expect(switchDesktopProfile({
      previous,
      target,
      transitionBlocker: () => null,
      beforeSwitch: async () => undefined,
      resetRuntime: async () => undefined,
      destroyTerminal: () => undefined,
      closeRemote: async () => undefined,
      activate: profileId => profileId === previous.profile.id ? previous : target,
      applyContext: next => { active = next },
      startRuntime: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('startup failed')
        return { getSnapshot: () => ({ profileId: active.profile.id }) }
      },
      startRemote,
      broadcast,
    })).rejects.toThrow('startup failed')
    expect(active.profile.id).toBe(previous.profile.id)
    expect(attempts).toBe(2)
    expect(startRemote).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith({ profileId: previous.profile.id })
  })

  it('restores the previous runtime, remote host, and snapshot when target remote startup fails', async () => {
    const previous = context('profile-a')
    const target = context('profile-b')
    let active = previous
    let runtimeGeneration = 0
    const startRemote = vi.fn(async () => {
      if (startRemote.mock.calls.length === 1) throw new Error('remote startup failed')
    })
    const broadcast = vi.fn()

    await expect(switchDesktopProfile({
      previous,
      target,
      transitionBlocker: () => null,
      beforeSwitch: async () => undefined,
      resetRuntime: async () => undefined,
      destroyTerminal: () => undefined,
      closeRemote: async () => undefined,
      activate: profileId => profileId === previous.profile.id ? previous : target,
      applyContext: next => { active = next },
      startRuntime: async () => {
        runtimeGeneration += 1
        return { getSnapshot: () => ({ profileId: active.profile.id, runtimeGeneration }) }
      },
      startRemote,
      broadcast,
    })).rejects.toThrow('remote startup failed')

    expect(active.profile.id).toBe(previous.profile.id)
    expect(runtimeGeneration).toBe(2)
    expect(startRemote).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith({ profileId: previous.profile.id, runtimeGeneration: 2 })
  })

  it('restores each profile settings, drafts, and workspace bindings instead of only changing identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-profile-switch-data-'))
    const profileIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]
    try {
      const registry = new InstallationProfileRegistry(join(root, 'data'), {
        deviceRoot: join(root, 'device'),
        createId: () => profileIds.shift()!,
        installationId: () => '33333333-3333-4333-8333-333333333333',
      })
      registry.initialize()
      const primary = registry.activeContext()
      const secondary = registry.create({ displayName: '副资料' })
      const primaryWorkspace = join(root, 'primary-workspace')
      const secondaryWorkspace = join(root, 'secondary-workspace')
      mkdirSync(primaryWorkspace, { recursive: true })
      mkdirSync(secondaryWorkspace, { recursive: true })

      for (const [profileContext, model, draft, workspace] of [
        [primary, 'primary-model', '默认资料草稿', primaryWorkspace],
        [secondary, 'secondary-model', '副资料草稿', secondaryWorkspace],
      ] as const) {
        applyProfilePaths(profileContext)
        saveConfig({ ...await loadConfig(), provider: 'custom', model })
        new ConversationInteractionStoreV2(profileContext.storage.interactionRoot, profileContext.profile.id).save('shared-conversation', {
          queuedInputs: [],
          draft: { text: draft },
          pendingSteering: [],
          pendingApprovals: [],
        })
        new WorkspaceBindingService(profileContext.storage).ensureBound(workspace)
      }

      let active = registry.activate(primary.profile.id)
      applyProfilePaths(active)
      const startRuntime = async () => {
        const config = await loadConfig()
        const interaction = new ConversationInteractionStoreV2(active.storage.interactionRoot, active.profile.id)
          .load('shared-conversation')
        const workspaces = new WorkspaceBindingService(active.storage).list().workspaces
        return {
          getSnapshot: () => ({
            profileId: active.profile.id,
            configRoot: getActiveProfilePaths().configRoot,
            model: config.model,
            draft: interaction.draft.text,
            workspacePath: workspaces[0]?.localPath,
          }),
        }
      }
      const switchTo = async (target: ProfileContext) => {
        const previous = active
        return switchDesktopProfile({
          previous,
          target,
          transitionBlocker: () => null,
          beforeSwitch: async () => undefined,
          resetRuntime: async () => undefined,
          destroyTerminal: () => undefined,
          closeRemote: async () => undefined,
          activate: profileId => registry.activate(profileId),
          applyContext: context => {
            active = context
            applyProfilePaths(context)
          },
          startRuntime,
          startRemote: async () => undefined,
          broadcast: () => undefined,
        })
      }

      expect((await switchTo(secondary)).snapshot).toMatchObject({
        profileId: secondary.profile.id,
        configRoot: secondary.storage.configRoot,
        model: 'secondary-model',
        draft: '副资料草稿',
        workspacePath: secondaryWorkspace,
      })
      expect((await switchTo(primary)).snapshot).toMatchObject({
        profileId: primary.profile.id,
        configRoot: primary.storage.configRoot,
        model: 'primary-model',
        draft: '默认资料草稿',
        workspacePath: primaryWorkspace,
      })
    } finally {
      configureActiveProfilePaths(undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
