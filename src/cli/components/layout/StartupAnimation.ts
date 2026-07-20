export const STARTUP_ANIMATION_MS = 960

export interface StartupAnimationFrame {
  logoReveal: number
  showVersion: boolean
  showWorkspace: boolean
  showSession: boolean
  showRails: boolean
  showPrompt: boolean
  showStatus: boolean
  shimmerActive: boolean
  complete: boolean
}

export function getStartupAnimationFrame(elapsedMs: number): StartupAnimationFrame {
  const progress = clamp(elapsedMs / STARTUP_ANIMATION_MS)

  return {
    logoReveal: easeOutCubic(clamp(progress / 0.38)),
    showVersion: progress >= 0.28,
    showWorkspace: progress >= 0.38,
    showSession: progress >= 0.48,
    showRails: progress >= 0.58,
    showPrompt: progress >= 0.74,
    showStatus: progress >= 0.86,
    shimmerActive: progress >= 0.72 && progress < 1,
    complete: progress >= 1,
  }
}

export function shouldAnimateStartup(
  interactive: boolean,
  singleShot: string | undefined,
  requested = true,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!interactive || singleShot || !requested) return false
  if (isTruthy(environment.TURBOFLUX_NO_ANIMATION) || isTruthy(environment.CI)) return false
  return environment.TERM?.trim().toLowerCase() !== 'dumb'
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3)
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
