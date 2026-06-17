import { DefaultAgentStateProvider } from '../core/runtime/stateProvider'
import type { TurboFluxConfig } from '../core/config'

export class CliStateProvider extends DefaultAgentStateProvider {
  constructor(config: TurboFluxConfig, workspacePath: string) {
    super(config, workspacePath, { conversationPrefix: 'cli' })
  }
}
