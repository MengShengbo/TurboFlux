import chalk from 'chalk'
import type { TurboFluxConfig } from '../core/config'
import type { ApprovalPolicy, CapabilityProfile } from '../shared/agentTypes'
import { loadProfile } from '../core/profile'
import { createTranslator } from './i18n/translator'

export interface ReplOptions {
  workspacePath: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker?: boolean
  approvalPolicy?: ApprovalPolicy
  capabilityProfile?: CapabilityProfile
  mcpServers?: string[]
  startupAnimation?: boolean
  transparentBackground?: boolean
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { workspacePath, config, singleShot, verbose, noFlicker, approvalPolicy, capabilityProfile, mcpServers, startupAnimation, transparentBackground } = options
  const t = createTranslator(loadProfile().interfaceLanguage)

  if (singleShot) {
    try {
      const { runSingleShot } = await import('./singleShot')
      await runSingleShot({ workspacePath, config, prompt: singleShot, verbose, approvalPolicy, capabilityProfile, mcpServers })
    } catch (error) {
      process.stderr.write(`${t('repl.commandFailed', { message: error instanceof Error ? error.message : String(error) })}\n`)
      process.exitCode = 1
    }
    return
  }

  if (!config.apiKey) {
    console.log(chalk.hex('#bdbdbd')(t('repl.noApiKey')))
  }

  if (transparentBackground) {
    console.log(chalk.hex('#8f8f8f')(t('repl.transparent')))
  }

  if (mcpServers?.length) {
    const { loadMcpSettings } = await import('../core/mcp/settings')
    const selected = new Set(mcpServers)
    const settings = loadMcpSettings(workspacePath)
    const launchCommands = Object.entries(settings.mcpServers)
      .filter(([name, server]) => server.enabled && (selected.has('all') || selected.has(name)))
      .map(([name, server]) => `${name}: ${[server.command, ...(server.args || [])].filter(Boolean).join(' ')}`)
    if (launchCommands.length > 0) {
      console.log(chalk.yellow(t('repl.mcpEnabled', { commands: launchCommands.join('\n  ') })))
    }
  }

  const { startInkApp } = await import('./components/App')
  startInkApp({ workspacePath, config, singleShot, verbose, noFlicker, approvalPolicy, capabilityProfile, mcpServers, startupAnimation, transparentBackground })
}
