import chalk from 'chalk'
import { startInkApp } from './components/App'
import type { TurboFluxConfig } from '../core/config'
import type { ApprovalPolicy } from '../shared/agentTypes'
import { loadMcpSettings } from '../core/mcp/settings'

export interface ReplOptions {
  workspacePath: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker?: boolean
  approvalPolicy?: ApprovalPolicy
  mcpServers?: string[]
  startupAnimation?: boolean
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { workspacePath, config, singleShot, verbose, noFlicker, approvalPolicy, mcpServers, startupAnimation } = options

  if (!config.apiKey) {
    console.log(chalk.hex('#bdbdbd')('\n  No API key configured. Run "turboflux setup" to connect a model provider.\n'))
  }

  if (mcpServers?.length) {
    const selected = new Set(mcpServers)
    const settings = loadMcpSettings(workspacePath)
    const launchCommands = Object.entries(settings.mcpServers)
      .filter(([name, server]) => server.enabled && (selected.has('all') || selected.has(name)))
      .map(([name, server]) => `${name}: ${[server.command, ...(server.args || [])].filter(Boolean).join(' ')}`)
    if (launchCommands.length > 0) {
      console.log(chalk.yellow(`\n  MCP explicitly enabled:\n  ${launchCommands.join('\n  ')}\n`))
    }
  }

  startInkApp({ workspacePath, config, singleShot, verbose, noFlicker, approvalPolicy, mcpServers, startupAnimation })
}
