#!/usr/bin/env node
import { resolve } from 'path'
import { Command } from 'commander'
import { startRepl } from './repl'
import { loadConfig, saveConfig, setConfigValue } from '../core/config'
import { runSetup } from './setup'

const program = new Command()

program
  .name('turboflux')
  .description('TurboFlux - workspace assistant CLI')
  .version('0.1.0')
  .argument('[workspace]', 'workspace directory', '.')
  .option('--model-override <model>', 'temporarily override model for this session')
  .option('--provider-override <provider>', 'temporarily override API provider for this session')
  .option('-c, --command <prompt>', 'single-shot mode: run prompt and exit')
  .option('-v, --verbose', 'show tool call details')
  .option('--no-flicker', 'use a fixed alternate-screen viewport to reduce redraw flicker')
  .option('--no-color', 'disable color output')
  .action(async (workspace: string, opts) => {
    const workspacePath = resolve(workspace)
    const config = await loadConfig()

    if (opts.modelOverride) config.model = opts.modelOverride
    if (opts.providerOverride) config.provider = opts.providerOverride

    await startRepl({
      workspacePath,
      config,
      singleShot: opts.command || undefined,
      verbose: opts.verbose || false,
      noFlicker: opts.flicker === false,
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
      const display = { ...config, apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : '(not set)' }
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
  .command('setup')
  .description('Configure TurboFlux model provider and API key')
  .option('-p, --provider <provider>', 'provider preset (deepseek, openai, anthropic, openrouter, local-proxy)')
  .option('-k, --api-key <key>', 'provider API key')
  .option('-b, --base-url <url>', 'custom base URL')
  .option('-m, --model <model>', 'model name')
  .option('-y, --yes', 'accept defaults for missing options')
  .action(async (opts) => {
    try {
      await runSetup({
        provider: opts.provider,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model: opts.model,
        yes: Boolean(opts.yes),
      })
    } catch (error) {
      console.error(`Setup error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  })

program.parse(process.argv)
