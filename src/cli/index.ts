#!/usr/bin/env node
import { resolve } from 'path'
import { Command } from 'commander'
import { startRepl } from './repl'
import { loadConfig, redactConfig, saveConfig, setConfigValue } from '../core/config'
import { runSetup } from './setup'
import { normalizeApprovalPolicy, type ApprovalPolicy } from '../shared/agentTypes'
import { configureNetworkProxy } from '../core/networkProxy'

configureNetworkProxy()

const program = new Command()

program
  .name('turboflux')
  .description('TurboFlux - workspace assistant CLI')
  .version('0.1.5')
  .argument('[workspace]', 'workspace directory', '.')
  .option('--model-override <model>', 'temporarily override model for this session')
  .option('--provider-override <provider>', 'temporarily override API provider for this session')
  .option('-c, --command <prompt>', 'single-shot mode: run prompt and exit')
  .option('-v, --verbose', 'show tool call details')
  .option('--no-flicker', 'keep the fixed alternate-screen viewport')
  .option('--scrollback', 'use classic terminal scrollback instead of the fixed cockpit')
  .option('--no-animation', 'skip the startup reveal animation')
  .option('--no-color', 'disable color output')
  .option('--approval-policy <policy>', 'tool approval policy: ask, agent, or full')
  .option('--mcp <servers>', 'explicitly start configured MCP servers (comma-separated names or all)')
  .action(async (workspace: string, opts) => {
    const workspacePath = resolve(workspace)
    const config = await loadConfig()

    if (opts.modelOverride) config.model = opts.modelOverride
    if (opts.providerOverride) config.provider = opts.providerOverride

    const rawApprovalPolicy = opts.approvalPolicy ? String(opts.approvalPolicy).toLowerCase() : undefined
    if (rawApprovalPolicy && !['ask', 'agent', 'full', 'request', 'auto'].includes(rawApprovalPolicy)) {
      throw new Error(`Invalid approval policy: ${rawApprovalPolicy}`)
    }
    const approvalPolicy: ApprovalPolicy | undefined = rawApprovalPolicy
      ? normalizeApprovalPolicy(rawApprovalPolicy)
      : undefined
    const mcpServers = typeof opts.mcp === 'string'
      ? opts.mcp.split(',').map((name: string) => name.trim()).filter(Boolean)
      : undefined

    await startRepl({
      workspacePath,
      config,
      singleShot: opts.command || undefined,
      verbose: opts.verbose || false,
      noFlicker: opts.scrollback !== true,
      approvalPolicy,
      mcpServers,
      startupAnimation: opts.animation !== false,
    })
  })

// Config subcommand
program
  .command('config')
  .description('Manage configuration')
  .argument('<action>', 'set or show')
  .argument('[key]', 'config key')
  .argument('[value]', 'config value')
  .action(async (action: string, key?: string, value?: string) => {
    const config = await loadConfig()
    if (action === 'show') {
      const display = redactConfig(config)
      console.log(JSON.stringify(display, null, 2))
    } else if (action === 'set' && key && value) {
      try {
        const updated = setConfigValue(config, key, value)
        saveConfig(updated)
        console.log(`Set ${key} = ${key === 'apiKey' ? '***' : String((updated as any)[key])}`)
      } catch (error) {
        console.error(`Config error: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    } else {
      console.log('Usage: turboflux config set <key> <value>')
      console.log('       turboflux config show')
    }
  })

program
  .command('setup [action]')
  .description('Configure TurboFlux provider, language, persona, and custom behavior')
  .option('-p, --provider <provider>', 'provider preset (openai, anthropic, deepseek, kimi, glm, openrouter, custom)')
  .option('-k, --api-key <key>', 'provider API key')
  .option('-b, --base-url <url>', 'custom base URL')
  .option('-m, --model <model>', 'model name')
  .option('--lang <lang>', 'set both setup UI and AI output language when possible')
  .option('--all-lang <lang>', 'set both setup UI and AI output language when possible')
  .option('--config-lang <lang>', 'setup UI/config language (zh-CN, en)')
  .option('--ai-output-lang <lang>', 'AI output language (follow-user, zh-CN, en, ja, ko, or custom text)')
  .option('-o, --output-style <styles>', 'comma-separated available personas, "all", or "skip"')
  .option('-d, --default-output-style <style>', 'default persona/output style')
  .option('--custom-instructions <text>', 'global custom instructions injected into TurboFlux')
  .option('--approval-policy <policy>', 'approval policy (ask, agent, or full)')
  .option('-y, --yes', 'accept defaults for missing options')
  .action(async (action: string | undefined, opts) => {
    try {
      await runSetup({
        action,
        provider: opts.provider,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model: opts.model,
        lang: opts.lang,
        allLang: opts.allLang,
        configLang: opts.configLang,
        aiOutputLang: opts.aiOutputLang,
        outputStyle: opts.outputStyle,
        defaultOutputStyle: opts.defaultOutputStyle,
        customInstructions: opts.customInstructions,
        approvalPolicy: opts.approvalPolicy,
        yes: Boolean(opts.yes),
      })
    } catch (error) {
      console.error(`Setup error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

program.parse(process.argv)
