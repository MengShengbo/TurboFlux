#!/usr/bin/env node
import { resolve } from 'path'
import { Command } from 'commander'
import { startRepl } from './repl'
import { loadConfig, redactConfig, saveConfig, setConfigValue } from '../core/config'
import { runSetup } from './setup'
import {
  normalizeApprovalPolicy,
  normalizeCapabilityProfile,
  resolveCapabilityProfileForApproval,
  type ApprovalPolicy,
  type CapabilityProfile,
} from '../shared/agentTypes'
import { configureNetworkProxy } from '../core/networkProxy'
import { loadProfile } from '../core/profile'
import { createTranslator } from './i18n/index'
import { resolveTransparentBackground } from './platform/terminalTransparency'

configureNetworkProxy()

const t = createTranslator(loadProfile().interfaceLanguage)
const program = new Command()

program
  .name('turboflux')
  .description(t('cli.description'))
  .version('1.0.1')
  .argument('[workspace]', t('cli.workspace'), '.')
  .option('--model-override <model>', t('cli.modelOverride'))
  .option('--provider-override <provider>', t('cli.providerOverride'))
  .option('-c, --command <prompt>', t('cli.command'))
  .option('-v, --verbose', t('cli.verbose'))
  .option('--no-flicker', t('cli.noFlicker'))
  .option('--scrollback', t('cli.scrollback'))
  .option('--no-animation', t('cli.noAnimation'))
  .option('--no-color', t('cli.noColor'))
  .option('--transparent', t('cli.transparent'))
  .option('--opaque', t('cli.opaque'))
  .option('--approval-policy <policy>', t('cli.approvalPolicy'))
  .option('--capability-profile <profile>', t('cli.capabilityProfile'))
  .option('--mcp <servers>', t('cli.mcp'))
  .action(async (workspace: string, opts) => {
    const workspacePath = resolve(workspace)
    const config = await loadConfig()

    if (opts.modelOverride) config.model = opts.modelOverride
    if (opts.providerOverride) config.provider = opts.providerOverride

    const rawApprovalPolicy = opts.approvalPolicy ? String(opts.approvalPolicy).toLowerCase() : undefined
    if (rawApprovalPolicy && !['ask', 'agent', 'full', 'request', 'auto'].includes(rawApprovalPolicy)) {
      throw new Error(t('cli.invalidApproval', { policy: rawApprovalPolicy }))
    }
    const approvalPolicy: ApprovalPolicy | undefined = rawApprovalPolicy
      ? normalizeApprovalPolicy(rawApprovalPolicy)
      : undefined
    const rawCapabilityProfile = opts.capabilityProfile ? String(opts.capabilityProfile).toLowerCase() : undefined
    if (rawCapabilityProfile && !['read-only', 'workspace-write', 'danger-full-access'].includes(rawCapabilityProfile)) {
      throw new Error(t('cli.invalidCapability', { profile: rawCapabilityProfile }))
    }
    const capabilityProfile: CapabilityProfile | undefined = rawCapabilityProfile
      ? normalizeCapabilityProfile(rawCapabilityProfile)
      : undefined
    if (approvalPolicy) config.approvalPolicy = approvalPolicy
    if (capabilityProfile) config.capabilityProfile = capabilityProfile
    config.capabilityProfile = resolveCapabilityProfileForApproval(
      config.approvalPolicy,
      config.capabilityProfile,
    )
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
      capabilityProfile,
      mcpServers,
      startupAnimation: opts.animation !== false,
      transparentBackground: resolveTransparentBackground({
        opaque: Boolean(opts.opaque),
        transparent: Boolean(opts.transparent),
      }),
    })
  })

// Config subcommand
program
  .command('config')
  .description(t('cli.config.description'))
  .argument('<action>', t('cli.config.action'))
  .argument('[key]', t('cli.config.key'))
  .argument('[value]', t('cli.config.value'))
  .action(async (action: string, key?: string, value?: string) => {
    const config = await loadConfig()
    if (action === 'show') {
      const display = redactConfig(config)
      console.log(JSON.stringify(display, null, 2))
    } else if (action === 'set' && key && value) {
      try {
        const updated = setConfigValue(config, key, value)
        saveConfig(updated)
        console.log(t('command.config.set', { key, value: key === 'apiKey' ? '***' : String((updated as any)[key]) }))
      } catch (error) {
        console.error(t('command.config.error', { message: error instanceof Error ? error.message : String(error) }))
        process.exitCode = 1
      }
    } else {
      console.log(t('cli.config.usage'))
    }
  })

program
  .command('setup [action]')
  .description(t('cli.setup.description'))
  .option('-p, --provider <provider>', t('cli.setup.provider'))
  .option('-k, --api-key <key>', t('cli.setup.apiKey'))
  .option('-b, --base-url <url>', t('cli.setup.baseUrl'))
  .option('-m, --model <model>', t('cli.setup.model'))
  .option('--lang <lang>', t('cli.setup.sharedLanguage'))
  .option('--all-lang <lang>', t('cli.setup.sharedLanguage'))
  .option('--config-lang <lang>', t('cli.setup.interfaceLanguage'))
  .option('--ai-output-lang <lang>', t('cli.setup.aiLanguage'))
  .option('-o, --output-style <styles>', t('cli.setup.personas'))
  .option('-d, --default-output-style <style>', t('cli.setup.defaultPersona'))
  .option('--custom-instructions <text>', t('cli.setup.instructions'))
  .option('--approval-policy <policy>', t('cli.setup.approval'))
  .option('-y, --yes', t('cli.setup.yes'))
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
      console.error(t('cli.setup.error', { message: error instanceof Error ? error.message : String(error) }))
      process.exitCode = 1
    }
  })

program.parse(process.argv)
