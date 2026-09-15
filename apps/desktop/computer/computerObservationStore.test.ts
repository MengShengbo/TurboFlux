import { describe, expect, it } from 'vitest'
import type { ComputerObservation } from '@turboflux/agent-core/extensions'
import { ComputerObservationStore } from './computerObservationStore'

function observation(frameId: string, capturedAt = Date.now()): ComputerObservation {
  return {
    frameId,
    capturedAt,
    expiresAt: capturedAt + 15_000,
    scope: 'window',
    controlMode: 'foreground-visual',
    displayId: '1',
    coordinateSpace: {
      frameId,
      displayId: '1',
      capturedAt,
      logicalBounds: { x: 0, y: 0, width: 100, height: 100 },
      pixelSize: { width: 100, height: 100 },
      scaleFactor: 1,
    },
    activeApp: undefined,
    activeWindow: undefined,
    elements: [],
    protectedRegions: [],
  }
}

describe('ComputerObservationStore', () => {
  it('keeps only the newest observation', () => {
    const store = new ComputerObservationStore()
    store.remember(observation('first'))
    store.remember(observation('second'))

    expect(() => store.requireFresh('first')).toThrow('observation not found')
    expect(store.requireFresh('second').frameId).toBe('second')
  })

  it('consumes and clears observations', () => {
    const store = new ComputerObservationStore()
    store.remember(observation('current'))
    store.delete('current')
    expect(() => store.latest()).toThrow('No fresh computer observation')

    store.remember(observation('next'))
    store.clear()
    expect(() => store.latest()).toThrow('No fresh computer observation')
  })
})
