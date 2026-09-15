import type {
  ComputerAccessibilityElement,
  ComputerObservation,
  ComputerPoint,
} from '@turboflux/agent-core/extensions'
import type { ComputerExpectedTarget } from './computerDriver'
import { boundsContainPoint } from './computerPolicy'

export function assertObservationIdentity(
  observation: ComputerObservation,
  appName: string,
  bundleId: string,
): void {
  if (observation.activeApp?.name !== appName || observation.activeApp.bundleId !== bundleId) {
    throw new Error('Application identity does not match the observation; observe again')
  }
}

export function requireObservationElement(
  observation: ComputerObservation,
  ref: string,
): ComputerAccessibilityElement {
  const element = observation.elements.find(item => item.ref === ref)
  if (!element) throw new Error('Accessibility reference is stale; observe the application again')
  if (!element.enabled) throw new Error('The selected control is disabled')
  return element
}

export function expectedObservationTarget(observation: ComputerObservation): ComputerExpectedTarget {
  if (!observation.activeApp?.bundleId || !observation.activeWindow) {
    throw new Error('The observation has no stable application target; observe the application again')
  }
  return {
    pid: observation.activeApp.pid,
    bundleId: observation.activeApp.bundleId,
    windowId: observation.activeWindow.id,
    bounds: { ...observation.activeWindow.bounds },
  }
}

export function assertPointOutsideProtectedRegions(observation: ComputerObservation, point: ComputerPoint): void {
  if (observation.protectedRegions.some(region => boundsContainPoint(region, point))) {
    throw new Error('The target overlaps a protected TurboFlux region')
  }
}
