import type { Command, CommandContext } from './types'
import { commandRegistry } from './registry'
import { type TurboFluxConfig, getPresetByIdOrModelFrom, applyPreset, redactConfig, setConfigValue } from '../../core/config'
import { existsSync, writeFileSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { formatNativeReasoningSetting, getModelReasoningCapabilities } from '../../core/modelRegistry'
import {
  APPROVAL_POLICY_LABELS,
  CAPABILITY_PROFILE_LABELS,
  normalizeApprovalPolicy,
  normalizeCapabilityProfile,
  type CapabilityProfile,
  type ReasoningEffort,
} from '../../shared/agentTypes'
import { createTranslator, type Translator } from '../i18n/index'
import { describeFlowFeatureFlags } from '../state/flowFeatureFlags'

const DEFAULT_TRANSLATOR = createTranslator('en')

// /exit
commandRegistry.register({
  name: 'exit',
  descriptionKey: 'command.exit.description',
  aliases: ['quit', 'q'],
  type: 'local',
  execute: (_args, ctx) => { ctx.exit() },
})

// /clear
commandRegistry.register({
  name: 'clear',
  descriptionKey: 'command.clear.description',
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    try {
      ctx.conversationManager?.startNew()
    } catch {
      return ctx.t('command.conversation.persistenceBlocked')
    }
    ctx.engine.resetSession()
    ctx.setMessages([])
    return ctx.t('command.clear.done')
  },
})

// /help
commandRegistry.register({
  name: 'help',
  descriptionKey: 'command.help.description',
  aliases: ['?'],
  type: 'local',
  execute: (_args, ctx) => {
    const commands = commandRegistry.listAll()
    const lines = commands.map(c => {
      const hint = c.argumentHint ? ` ${c.argumentHint}` : ''
      const aliases = c.aliases?.length ? ` (${c.aliases.map(a => '/' + a).join(', ')})` : ''
      const description = c.descriptionKey ? ctx.t(c.descriptionKey) : c.description ?? ''
      return `  /${c.name}${hint}${aliases} - ${description}`
    })
    return `${ctx.t('command.available')}\n${lines.join('\n')}`
  },
})

// /config
commandRegistry.register({
  name: 'config',
  descriptionKey: 'command.config.description',
  argumentHint: '[key] [value]',
  showsProgress: args => args.trim().split(/\s+/).filter(Boolean).length >= 2,
  type: 'local',
  execute: (args, ctx) => {
    if (!args) {
      const safe = redactConfig(ctx.config)
      return `${ctx.t('command.config.current')}\n${Object.entries(safe).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`
    }
    const parts = args.split(/\s+/)
    if (parts.length < 2) {
      const key = parts[0] as keyof TurboFluxConfig
      const val = ctx.config[key]
      return `${key} = ${key === 'apiKey' ? '***' : val}`
    }
    const [key, ...rest] = parts
    const val = rest.join(' ')
    try {
      const updated = setConfigValue(ctx.config, key, val)
      ctx.setConfig(updated)
      return ctx.t('command.config.set', { key, value: key === 'apiKey' ? '***' : String((updated as any)[key]) })
    } catch (error) {
      return ctx.t('command.config.error', { message: error instanceof Error ? error.message : String(error) })
    }
  },
})

// /setup
commandRegistry.register({
  name: 'setup',
  descriptionKey: 'command.setup.description',
  type: 'local',
  execute: (_args, ctx) => ctx.t('command.setup.instructions'),
})

// /model
commandRegistry.register({
  name: 'model',
  descriptionKey: 'command.model.description',
  argumentHint: '[add <model-id>|<model-id>]',
  showsProgress: args => Boolean(args.trim()),
  type: 'local',
  execute: (args, ctx) => {
    if (!args) {
      const presetLines = ctx.modelPresets.map(p => {
        const active = ctx.config.model === p.model ? ' *' : ''
        return `  ${p.id.padEnd(8)} ${p.name.padEnd(20)} ${p.description}${active}`
      })
      return `${ctx.t('command.model.current', { model: ctx.config.model || ctx.t('command.model.none') })}\n\n${ctx.t('command.model.available')}\n${presetLines.join('\n')}\n\n${ctx.t('command.model.usage')}`
    }
    const input = args.trim()
    const addMatch = input.match(/^add(?:\s+(.+))?$/i)
    if (addMatch) {
      const modelId = addMatch[1]?.trim()
      if (!modelId) return ctx.t('command.model.usage')
      const preset = getPresetByIdOrModelFrom(ctx.modelPresets, modelId)
      const updated = preset
        ? applyPreset(ctx.config, preset)
        : setConfigValue(ctx.config, 'model', modelId)
      ctx.setConfig(updated)
      return ctx.t('command.model.mounted', { model: updated.model })
    }
    const preset = getPresetByIdOrModelFrom(ctx.modelPresets, input)
    if (preset) {
      const updated = applyPreset(ctx.config, preset)
      ctx.setConfig(updated)
      return ctx.t('command.model.switchedPreset', { name: preset.name, model: preset.model })
    }
    const updated = setConfigValue(ctx.config, 'model', input)
    ctx.setConfig(updated)
    return ctx.t('command.model.switched', { model: input })
  },
})

// /plan
commandRegistry.register({
  name: 'plan',
  descriptionKey: 'command.plan.description',
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    ctx.engine.setMode('plan')
    return ctx.t('command.plan.done')
  },
})

// /vibe
commandRegistry.register({
  name: 'vibe',
  descriptionKey: 'command.vibe.description',
  aliases: ['code'],
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    ctx.engine.setMode('vibe')
    return ctx.t('command.vibe.done')
  },
})

// /git
commandRegistry.register({
  name: 'git',
  descriptionKey: 'command.git.description',
  argumentHint: '[on|off|refresh]',
  showsProgress: args => Boolean(args.trim()),
  type: 'local',
  execute: (args, ctx) => {
    const sub = args.trim().toLowerCase()
    if (sub === 'off' || sub === 'disable') {
      const nextConfig = setConfigValue(ctx.config, 'gitEnabled', 'off')
      ctx.setConfig(nextConfig)
      return ctx.t('command.git.disabled')
    }
    if (sub === 'on' || sub === 'enable') {
      const nextConfig = setConfigValue(ctx.config, 'gitEnabled', 'on')
      ctx.setConfig(nextConfig)
      return ctx.t('command.git.enabled')
    }
    if (sub === 'refresh') {
      void ctx.engine.initializeGit(true)
      return ctx.t('command.git.refreshing')
    }
    if (sub) return ctx.t('command.git.usage')

    const state = ctx.engine.getGitState()
    const snapshot = state.snapshot
    const lines = [
      ctx.t('command.git.phase', { phase: state.phase }),
      snapshot ? ctx.t('command.git.branch', { branch: `${snapshot.branch}${snapshot.head ? ` @ ${snapshot.head.slice(0, 8)}` : ''}` }) : '',
      snapshot ? ctx.t('command.git.changes', { staged: snapshot.stagedCount, unstaged: snapshot.unstagedCount, untracked: snapshot.untrackedCount, conflicted: snapshot.conflictedCount }) : '',
      snapshot && (snapshot.ahead > 0 || snapshot.behind > 0) ? ctx.t('command.git.tracking', { ahead: snapshot.ahead, behind: snapshot.behind }) : '',
      state.operation ? ctx.t('command.git.operation', { name: state.operation.name, status: state.operation.status, hash: state.operation.hash ? ` ${state.operation.hash.slice(0, 8)}` : '' }) : '',
      state.error ? ctx.t('common.error', { message: state.error }) : '',
    ].filter(Boolean)
    return lines.join('\n')
  },
  executeAsync: async (args, ctx) => {
    if (args.trim().toLowerCase() === 'refresh') {
      await ctx.engine.initializeGit(true)
      return ctx.t('command.git.refreshing')
    }
    const result = commandRegistry.execute(`/git${args ? ` ${args}` : ''}`, ctx)
    return result.text
  },
})

commandRegistry.register({
  name: 'ps',
  descriptionKey: 'command.ps.description',
  type: 'local',
  execute: (_args, ctx) => {
    const tasks = ctx.runtimeTaskManager?.listTasks({ kind: 'terminal' }) || []
    if (tasks.length === 0) return ctx.t('command.ps.none')
    const now = Date.now()
    const lines = tasks.map(task => {
      const sessionId = typeof task.metadata?.sessionId === 'string' ? task.metadata.sessionId : task.id
      const elapsed = formatRuntimeDuration((task.endedAt || now) - task.startedAt)
      const exit = typeof task.exitCode === 'number' ? ctx.t('command.ps.exit', { code: task.exitCode }) : ''
      const pid = task.pid ? ctx.t('command.ps.pid', { pid: task.pid }) : ''
      const output = typeof task.outputBytes === 'number' ? ` · ${formatRuntimeBytes(task.outputBytes)}` : ''
      const recovered = task.metadata?.recovered === true ? ctx.t('command.ps.recovered') : ''
      return `- ${sessionId} · ${task.status}${exit}${pid} · ${elapsed}${output}${recovered}\n  ${task.command || ctx.t('ui.app.shellSession')}`
    })
    return `${ctx.t('command.ps.title', { count: tasks.length })}\n${lines.join('\n')}`
  },
})

commandRegistry.register({
  name: 'inbox',
  descriptionKey: 'command.inbox.description',
  argumentHint: '[clear]',
  type: 'local',
  execute: (args, ctx) => {
    const inbox = ctx.notificationInbox
    if (!inbox) return ctx.t('command.inbox.unavailable')
    if (args.trim().toLowerCase() === 'clear') {
      const cleared = inbox.clearResults()
      return cleared > 0
        ? ctx.t('command.inbox.cleared', { count: cleared })
        : ctx.t('command.inbox.alreadyClear')
    }
    if (args.trim()) return ctx.t('command.inbox.usage')
    const snapshot = inbox.snapshot()
    const results = snapshot.inbox.filter(item => item.category === 'result-ready')
    if (results.length === 0) return ctx.t('command.inbox.none')
    return [
      ctx.t('command.inbox.title', { count: snapshot.resultCount }),
      ...results.map(item => `- ${item.title}${item.count > 1 ? ` x${item.count}` : ''}${item.detail ? ` - ${item.detail}` : ''}`),
      ctx.t('command.inbox.reviewHint'),
    ].join('\n')
  },
})

commandRegistry.register({
  name: 'flow',
  descriptionKey: 'command.flow.description',
  argumentHint: '[status|retry|export [path]]',
  showsProgress: args => /^(retry|export)(?:\s|$)/i.test(args.trim()),
  type: 'local',
  execute: (args, ctx) => {
    const manager = ctx.conversationManager
    if (!manager) return ctx.t('command.flow.unavailable')
    const [action = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
    if (action === 'status') {
      const health = manager.getPersistenceHealth()
      return [
        ctx.t('command.flow.status', {
          status: health.status === 'healthy' ? ctx.t('command.flow.healthy') : ctx.t('command.flow.degraded'),
        }),
        ctx.t('command.flow.pending', {
          recovery: health.pendingRecoveryEntries,
          streaming: health.pendingStreamingEntries,
        }),
        ctx.t('command.flow.features', {
          features: ctx.flowFeatures ? describeFlowFeatureFlags(ctx.flowFeatures) : ctx.t('command.flow.featuresUnknown'),
        }),
        health.error ? ctx.t('command.flow.error', { message: health.error }) : '',
      ].filter(Boolean).join('\n')
    }
    if (action === 'retry') {
      const health = manager.retryPersistence()
      return health.status === 'healthy'
        ? ctx.t('command.flow.retrySucceeded')
        : ctx.t('command.flow.retryFailed', { message: health.error ?? ctx.t('command.flow.unknownError') })
    }
    if (action === 'export') {
      try {
        const target = manager.exportRecoveryBundle(rest.join(' ') || undefined)
        return ctx.t('command.flow.exported', { path: target })
      } catch (error) {
        return ctx.t('command.flow.exportFailed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    return ctx.t('command.flow.usage')
  },
})

commandRegistry.register({
  name: 'stop',
  descriptionKey: 'command.stop.description',
  argumentHint: '[session-id|all]',
  showsProgress: true,
  type: 'local',
  execute: (args, ctx) => executeStopCommand(args, ctx),
  executeAsync: (args, ctx) => executeStopCommand(args, ctx, true),
})

// /compact
commandRegistry.register({
  name: 'compact',
  descriptionKey: 'command.compact.description',
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    ctx.engine.compactContext().catch(() => {})
    return ctx.t('command.compact.triggered')
  },
  executeAsync: async (_args, ctx) => {
    await ctx.engine.compactContext()
    return ctx.t('command.compact.triggered')
  },
})

// /context
commandRegistry.register({
  name: 'context',
  descriptionKey: 'command.context.description',
  type: 'local',
  execute: (_args, ctx) => {
    const tokens = ctx.engine.getContextUsage()
    const window = ctx.config.contextWindow
    if (tokens.source !== 'provider' || typeof tokens.input !== 'number') {
      return [
        ctx.t('command.context.unknown', { window: window.toLocaleString() }),
        ctx.t('command.context.waiting'),
        ctx.t('command.context.noEstimate'),
      ].join('\n')
    }
    const used = tokens.input
    const pct = Math.round((used / window) * 100)
    const bar = renderBar(pct, 30)
    return [
      ctx.t('command.context.usage', { used: used.toLocaleString(), window: window.toLocaleString(), percent: pct }),
      bar,
      ctx.t('command.context.input', { tokens: tokens.input.toLocaleString() }),
      ctx.t('command.context.output', { tokens: (tokens.output ?? 0).toLocaleString() }),
    ].join('\n')
  },
})

// /theme
commandRegistry.register({
  name: 'theme',
  descriptionKey: 'command.theme.description',
  argumentHint: '[dark|light]',
  type: 'local',
  execute: (args, ctx) => {
    if (!args || !['dark', 'light'].includes(args.trim())) {
      return ctx.t('command.theme.usage')
    }
    return ctx.t('command.theme.switched', { theme: args.trim() })
  },
})

// /effort
commandRegistry.register({
  name: 'effort',
  descriptionKey: 'command.effort.description',
  argumentHint: '[level]',
  showsProgress: args => Boolean(args.trim()),
  type: 'local',
  execute: (args, ctx) => {
    const capability = getModelReasoningCapabilities(ctx.config.model, ctx.config.provider, ctx.config.modelCapabilities)
    if (!capability) return ctx.t('command.effort.unsupported', { model: ctx.config.model || ctx.t('command.effort.thisModel') })

    const input = args.trim().toLowerCase()
    const current = formatNativeReasoningSetting(ctx.config.model, ctx.config.reasoning, ctx.config.provider, ctx.config.modelCapabilities)
    if (!input) {
      const available = [
        capability.efforts.length > 0 ? capability.efforts.join('/') : null,
        capability.supportsToggle ? 'on/off' : null,
        capability.control === 'budget' ? ctx.t('command.effort.budget') : null,
      ].filter(Boolean).join(', ')
      return ctx.t('command.effort.summary', { current: current || ctx.t('common.providerDefault'), available: available || ctx.t('command.effort.fixed') })
    }

    let next: TurboFluxConfig
    if (input === 'on' || input === 'off') {
      if (!capability.supportsToggle) return ctx.t('command.effort.noToggle')
      next = setConfigValue(ctx.config, 'reasoningEnabled', input)
    } else if (capability.efforts.includes(input as ReasoningEffort)) {
      next = setConfigValue(ctx.config, 'reasoningEffort', input)
    } else if (capability.control === 'budget' && /^\d+$/.test(input)) {
      next = setConfigValue(ctx.config, 'reasoningBudgetTokens', input)
    } else {
      const available = capability.control === 'budget'
        ? ctx.t('command.effort.budgetOptions')
        : [...capability.efforts, ...(capability.supportsToggle ? ['on', 'off'] : [])].join(', ') || ctx.t('command.effort.fixed')
      return ctx.t('command.effort.available', { available })
    }
    ctx.setConfig(next)
    return ctx.t('command.effort.set', { effort: formatNativeReasoningSetting(next.model, next.reasoning, next.provider, next.modelCapabilities) })
  },
})

// /approval
commandRegistry.register({
  name: 'approval',
  descriptionKey: 'command.approval.description',
  argumentHint: '[ask|agent|full]',
  showsProgress: args => Boolean(args.trim()),
  type: 'local',
  execute: (args, ctx) => {
    const input = args.trim().toLowerCase()
    if (!input) {
      return ctx.t('command.approval.current', { label: approvalLabel(ctx.config.approvalPolicy, ctx), policy: ctx.config.approvalPolicy })
    }
    if (!['ask', 'agent', 'full', 'request', 'auto'].includes(input)) {
      return ctx.t('command.approval.usage')
    }
    const policy = normalizeApprovalPolicy(input, ctx.config.approvalPolicy)
    const next = setConfigValue(ctx.config, 'approvalPolicy', policy)
    ctx.setConfig(next)
    return `${approvalLabel(policy, ctx)}.`
  },
})

commandRegistry.register({
  name: 'capability',
  descriptionKey: 'command.capability.description',
  argumentHint: '[read-only|workspace-write|danger-full-access]',
  showsProgress: args => Boolean(args.trim()),
  type: 'local',
  execute: (args, ctx) => {
    const input = args.trim().toLowerCase()
    const current = ctx.config.capabilityProfile || 'workspace-write'
    if (!input) {
      return ctx.t('command.capability.current', { label: capabilityLabel(current), profile: current })
    }
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(input)) {
      return ctx.t('command.capability.usage')
    }
    const profile = normalizeCapabilityProfile(input, current)
    const next = setConfigValue(ctx.config, 'capabilityProfile', profile)
    ctx.setConfig(next)
    return ctx.t('command.capability.set', { label: capabilityLabel(profile), profile })
  },
})

function approvalLabel(policy: keyof typeof APPROVAL_POLICY_LABELS, ctx: CommandContext): string {
  if (policy === 'ask') return ctx.t('command.approval.ask')
  if (policy === 'agent') return ctx.t('command.approval.agent')
  return ctx.t('command.approval.full')
}

function executeStopCommand(args: string, ctx: CommandContext): string
function executeStopCommand(args: string, ctx: CommandContext, wait: true): Promise<string>
function executeStopCommand(args: string, ctx: CommandContext, wait = false): string | Promise<string> {
  const manager = ctx.runtimeTaskManager
  if (!manager) return wait ? Promise.resolve(ctx.t('command.stop.unavailable')) : ctx.t('command.stop.unavailable')
  const requested = args.trim()
  const active = manager.listTasks({ kind: 'terminal' }).filter(task =>
    task.status === 'starting' || task.status === 'running' || task.status === 'stopping'
  )
  const targets = !requested || requested === 'all'
    ? active
    : active.filter(task => task.id === requested || task.metadata?.sessionId === requested)
  const response = targets.length === 0
    ? (requested ? ctx.t('command.stop.noMatch', { session: requested }) : ctx.t('command.stop.none'))
    : targets.some(task => task.metadata?.recovered === true && task.metadata?.controlAvailable === false)
      ? ctx.t('command.stop.readOnly', {
          count: targets.filter(task => task.metadata?.recovered === true && task.metadata?.controlAvailable === false).length,
        })
      : null
  if (response) return wait ? Promise.resolve(response) : response

  const stopping = Promise.all(targets.map(task =>
    manager.stopTask(task.id, ctx.t('command.stop.reason')).catch(() => undefined)
  ))
  const message = ctx.t(targets.length === 1 ? 'command.stop.stoppingOne' : 'command.stop.stopping', { count: targets.length })
  if (!wait) {
    void stopping
    return message
  }
  return stopping.then(() => message)
}

function capabilityLabel(profile: CapabilityProfile): string {
  return CAPABILITY_PROFILE_LABELS[profile]
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  const bar = '#'.repeat(filled) + '-'.repeat(empty)
  return `  [${bar}]`
}

function formatRuntimeDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatRuntimeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

// /mcp
commandRegistry.register({
  name: 'mcp',
  descriptionKey: 'command.mcp.description',
  argumentHint: '[status|tools]',
  type: 'local',
  execute: (args, ctx) => {
    if (!ctx.mcpClient) return ctx.t('command.mcp.uninitialized')
    const connections = ctx.mcpClient.getAllConnections()
    if (connections.length === 0) return ctx.t('command.mcp.none')

    if (args === 'tools') {
      const tools = ctx.mcpClient.getAllTools()
      if (tools.length === 0) return ctx.t('command.mcp.noTools')
      const lines = tools.map(t => `  ${t.name} - ${t.description.slice(0, 60)}`)
      return `${ctx.t('command.mcp.tools', { count: tools.length })}\n${lines.join('\n')}`
    }

    const lines = connections.map(c => {
      const status = c.status === 'connected' ? 'ok' : c.status === 'error' ? 'error' : 'pending'
      const toolCount = c.tools.length
      const err = c.error ? ` (${c.error})` : ''
      return `  ${status} ${c.name} - ${c.status}, ${ctx.t('command.mcp.toolCount', { count: toolCount })}${err}`
    })
    return `${ctx.t('command.mcp.servers', { count: connections.length })}\n${lines.join('\n')}\n\n${ctx.t('command.mcp.hint')}`
  },
})

// /skills
commandRegistry.register({
  name: 'skills',
  descriptionKey: 'command.skills.description',
  type: 'local',
  execute: (_args, ctx) => {
    if (!ctx.skillRuntime) return ctx.t('command.skills.unavailable')
    const skills = ctx.skillRuntime.getAll()
    if (skills.length === 0) return ctx.t('command.skills.none')
    const active = ctx.skillRuntime.getActiveSkillId()
    const lines = skills.map(s => {
      const marker = s.id === active ? ctx.t('command.skills.active') : ''
      return `  ${s.command} - ${s.description}${marker}`
    })
    return `${ctx.t('command.skills.available', { count: skills.length })}\n${lines.join('\n')}`
  },
})

// /new
commandRegistry.register({
  name: 'new',
  descriptionKey: 'command.new.description',
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    if (!ctx.conversationManager) return ctx.t('command.conversation.unavailable')
    try {
      ctx.conversationManager.startNew()
    } catch {
      return ctx.t('command.conversation.persistenceBlocked')
    }
    ctx.engine.resetSession()
    ctx.setMessages([])
    return ctx.t('command.conversation.started')
  },
})

// /list
commandRegistry.register({
  name: 'list',
  descriptionKey: 'command.list.description',
  aliases: ['conversations'],
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    if (!ctx.conversationManager) return ctx.t('command.conversation.unavailable')
    const convs = ctx.conversationManager.list()
    if (convs.length === 0) return ctx.t('command.conversation.none')
    const lines = convs.slice(0, 20).map((c, i) => {
      const date = new Date(c.updatedAt).toLocaleString()
      const current = c.id === ctx.conversationManager!.getCurrentId() ? ' *' : ''
      return `  ${i + 1}. ${c.title} (${ctx.t('command.conversation.turns', { count: c.turnCount })}, ${date})${current}\n     ${ctx.t('command.conversation.id', { id: c.id })}`
    })
    return `${ctx.t('command.conversation.total', { count: convs.length })}\n${lines.join('\n')}`
  },
  executeAsync: async (_args, ctx) => {
    if (!ctx.conversationManager) return ctx.t('command.conversation.unavailable')
    const convs = await ctx.conversationManager.listAsync()
    if (convs.length === 0) return ctx.t('command.conversation.none')
    const lines = convs.slice(0, 20).map((c, i) => {
      const date = new Date(c.updatedAt).toLocaleString()
      const current = c.id === ctx.conversationManager!.getCurrentId() ? ' *' : ''
      return `  ${i + 1}. ${c.title} (${ctx.t('command.conversation.turns', { count: c.turnCount })}, ${date})${current}\n     ${ctx.t('command.conversation.id', { id: c.id })}`
    })
    return `${ctx.t('command.conversation.total', { count: convs.length })}\n${lines.join('\n')}`
  },
})

// /resume
commandRegistry.register({
  name: 'resume',
  descriptionKey: 'command.resume.description',
  showsProgress: true,
  type: 'local',
  execute: () => {
    return ''
  },
})

// /init
commandRegistry.register({
  name: 'init',
  descriptionKey: 'command.init.description',
  isHidden: true,
  showsProgress: true,
  type: 'local',
  execute: (_args, ctx) => {
    const wsPath = ctx.workspacePath || process.cwd()
    const targetPath = join(wsPath, 'TURBOFLUX.md')

    if (existsSync(targetPath)) {
      return ctx.t('command.init.active', { path: targetPath })
    }

    ensureProjectInstructions(wsPath, ctx.t)
    return ctx.t('command.init.created', { path: targetPath })
  },
})

export function ensureProjectInstructions(wsPath: string, t: Translator = DEFAULT_TRANSLATOR): string | null {
  const targetPath = join(wsPath, 'TURBOFLUX.md')
  if (existsSync(targetPath)) return null

  const projectName = wsPath.split(/[\\/]/).pop() || 'my-project'
  const techStack = detectTechStack(wsPath, t)
  const structure = scanTopLevel(wsPath, t)
  const template = t('command.init.template', { projectName, techStack, structure })
  writeFileSync(targetPath, template, 'utf-8')
  return targetPath
}

function detectTechStack(wsPath: string, t: Translator): string {
  const indicators: string[] = []
  const has = (f: string) => existsSync(join(wsPath, f))

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(wsPath, 'package.json'), 'utf-8'))
      if (pkg.dependencies?.react || pkg.devDependencies?.react) indicators.push('React')
      if (pkg.dependencies?.vue || pkg.devDependencies?.vue) indicators.push('Vue')
      if (pkg.dependencies?.next) indicators.push('Next.js')
      if (pkg.dependencies?.express || pkg.dependencies?.hono) indicators.push('Node.js Server')
      if (pkg.devDependencies?.typescript) indicators.push('TypeScript')
      if (pkg.devDependencies?.vitest) indicators.push('Vitest')
      if (pkg.devDependencies?.tsx) indicators.push('TSX')
    } catch {}
  }
  if (has('Cargo.toml')) indicators.push('Rust')
  if (has('go.mod')) indicators.push('Go')
  if (has('pom.xml') || has('build.gradle')) indicators.push('Java')
  if (has('requirements.txt') || has('pyproject.toml')) indicators.push('Python')
  if (has('tsconfig.json')) indicators.push('TypeScript')

  if (indicators.length === 0) return t('command.init.unknownStack')
  return indicators.map(t => `- ${t}`).join('\n')
}

function scanTopLevel(wsPath: string, t: Translator): string {
  try {
    const entries = readdirSync(wsPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .slice(0, 15)
    const lines = entries.map(e => {
      const suffix = e.isDirectory() ? '/' : ''
      return `- ${e.name}${suffix}`
    })
    return lines.join('\n') || t('command.init.empty')
  } catch {
    return t('command.init.scanFailed')
  }
}

export { commandRegistry }
