export interface DesktopPowerEventSource {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown
}

export interface DesktopPowerLifecycleCallbacks {
  onSuspend(): void | Promise<void>
  onResume(): void | Promise<void>
  onError?(error: unknown): void
}

export function installDesktopPowerLifecycle(
  source: DesktopPowerEventSource,
  callbacks: DesktopPowerLifecycleCallbacks,
): () => void {
  let active = true
  const report = (error: unknown) => callbacks.onError?.(error)
  const invoke = (operation: () => void | Promise<void>) => {
    if (!active) return
    try {
      const result = operation()
      if (result && typeof result.then === 'function') void result.catch(report)
    } catch (error) {
      report(error)
    }
  }
  const handleSuspend = () => invoke(callbacks.onSuspend)
  const handleResume = () => invoke(callbacks.onResume)
  source.on('suspend', handleSuspend)
  source.on('resume', handleResume)
  return () => {
    if (!active) return
    active = false
    source.removeListener('suspend', handleSuspend)
    source.removeListener('resume', handleResume)
  }
}
