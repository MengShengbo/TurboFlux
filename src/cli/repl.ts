import chalk from 'chalk'
import { startInkApp } from './components/App'
import type { TurboFluxConfig } from '../core/config'

export interface ReplOptions {
  workspacePath: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker?: boolean
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { workspacePath, config, singleShot, verbose, noFlicker } = options

  if (!config.apiKey) {
    console.log(chalk.hex('#7cffea')('\n  No API key configured. Run "turboflux setup" to connect a model provider.\n'))
  }

  startInkApp({ workspacePath, config, singleShot, verbose, noFlicker })
}
