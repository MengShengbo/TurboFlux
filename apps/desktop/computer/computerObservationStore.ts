import type { ComputerControlMode, ComputerObservation } from '@turboflux/agent-core/extensions'
import { assertFreshObservation } from './computerPolicy'

export class ComputerObservationStore {
  private readonly observations = new Map<string, ComputerObservation>()

  clear(): void {
    this.observations.clear()
  }

  remember(observation: ComputerObservation): void {
    this.observations.clear()
    this.observations.set(observation.frameId, observation)
  }

  requireFresh(observationId: string): ComputerObservation {
    return assertFreshObservation(this.observations.get(observationId))
  }

  delete(observationId: string): void {
    this.observations.delete(observationId)
  }

  latest(): ComputerObservation {
    const observation = [...this.observations.values()].at(-1)
    if (!observation) throw new Error('No fresh computer observation is available')
    return observation
  }

  latestOrUndefined(): ComputerObservation | undefined {
    return [...this.observations.values()].at(-1)
  }

  latestControlMode(): Exclude<ComputerControlMode, 'takeover'> {
    return this.latestOrUndefined()?.controlMode || 'foreground-visual'
  }
}
