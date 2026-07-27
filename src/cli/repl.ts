import chalk from 'chalk'
import { startInkApp } from './components/App'
import type { TurboFluxConfig } from '../core/config'
import type { ApprovalPolicy } from '../shared/agentTypes'
import { loadMcpSettings } from '../core/mcp/settings'
import { runSingleShot } from './singleShot'
import type { SandboxOptions } from '../core/sandbox/types'

export interface ReplOptions {
  workspacePath: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker?: boolean
  approvalPolicy?: ApprovalPolicy
  sandbox?: SandboxOptions
  mcpServers?: string[]
  startupAnimation?: boolean
  transparentBackground?: boolean
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const { workspacePath, config, singleShot, verbose, noFlicker, approvalPolicy, sandbox, mcpServers, startupAnimation, transparentBackground } = options

  if (singleShot) {
    try {
      await runSingleShot({ workspacePath, config, prompt: singleShot, verbose, approvalPolicy, sandbox, mcpServers })
    } catch (error) {
      process.stderr.write(`TurboFlux command failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
    return
  }

  if (!config.apiKey) {
    console.log(chalk.hex('#bdbdbd')('\n  No API key configured. Run "turboflux setup" to connect a model provider.\n'))
  }

  if (transparentBackground) {
    console.log(chalk.hex('#8f8f8f')('  Transparent terminal background enabled. Use "turboflux --opaque" to force solid backgrounds.\n'))
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

  startInkApp({ workspacePath, config, singleShot, verbose, noFlicker, approvalPolicy, sandbox, mcpServers, startupAnimation, transparentBackground })
}
