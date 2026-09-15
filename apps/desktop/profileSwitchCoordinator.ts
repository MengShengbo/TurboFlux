export interface SwitchableProfileContext<TProfile> {
  profile: TProfile & { id: string; state: string }
}

export interface DesktopProfileSwitchOptions<TProfile, TContext extends SwitchableProfileContext<TProfile>, TSnapshot> {
  previous: TContext
  target: TContext
  transitionBlocker(): string | null
  beforeSwitch(): Promise<void>
  resetRuntime(): Promise<void>
  destroyTerminal(): void
  closeRemote(): Promise<void>
  activate(profileId: string): TContext
  applyContext(context: TContext): void
  startRuntime(): Promise<{ getSnapshot(): TSnapshot }>
  startRemote(): Promise<void>
  broadcast(snapshot: TSnapshot): void
}

export async function switchDesktopProfile<TProfile, TContext extends SwitchableProfileContext<TProfile>, TSnapshot>(
  options: DesktopProfileSwitchOptions<TProfile, TContext, TSnapshot>,
): Promise<{ profile: TProfile; snapshot: TSnapshot }> {
  if (options.target.profile.id === options.previous.profile.id) {
    const host = await options.startRuntime()
    return { profile: options.target.profile, snapshot: host.getSnapshot() }
  }
  if (!['ready', 'degraded'].includes(options.target.profile.state)) throw new Error('目标资料当前不可切换')
  const blocker = options.transitionBlocker()
  if (blocker) throw new Error(blocker)

  await options.beforeSwitch()
  try {
    await options.resetRuntime()
    options.destroyTerminal()
    await options.closeRemote()
    const activated = options.activate(options.target.profile.id)
    options.applyContext(activated)
    const host = await options.startRuntime()
    await options.startRemote()
    const snapshot = host.getSnapshot()
    options.broadcast(snapshot)
    return { profile: activated.profile, snapshot }
  } catch (error) {
    const recoveryErrors: unknown[] = []
    for (const cleanup of [
      () => options.resetRuntime(),
      () => options.destroyTerminal(),
      () => options.closeRemote(),
    ]) {
      try { await cleanup() } catch (cleanupError) { recoveryErrors.push(cleanupError) }
    }
    // Do not change profile paths while resources from the target may still be live.
    if (recoveryErrors.length === 0) {
      try {
        const restored = options.activate(options.previous.profile.id)
        options.applyContext(restored)
        const restoredHost = await options.startRuntime()
        options.broadcast(restoredHost.getSnapshot())
        await options.startRemote()
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError)
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError([error, ...recoveryErrors], '本地资料切换失败，且无法完整恢复原资料', { cause: error })
    }
    throw error
  }
}
