import { basename } from 'node:path'
import type { AgentEventType } from '../core/agentEngine'
import type { TurboFluxConfig } from '../core/config'
import { createAgentRuntime } from '../core/runtime/agentRuntime'
import type { AgentTurn, ApprovalPolicy, CapabilityProfile, ToolCall } from '../shared/agentTypes'
import { stripTextToolCallMarkup } from '../shared/toolCallMarkup'
import { commandRegistry } from './commands/index'
import { ConversationManager } from './conversations/manager'
import { loadProfile } from '../core/profile'
import { createTranslator, type Translator } from './i18n/index'

const DEFAULT_TRANSLATOR = createTranslator('en')

export interface SingleShotOptions {
  workspacePath: string
  config: TurboFluxConfig
  prompt: string
  verbose: boolean
  approvalPolicy?: ApprovalPolicy
  capabilityProfile?: CapabilityProfile
  mcpServers?: string[]
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
}

type OutputWriter = (text: string) => void

export class SingleShotProgressReporter {
  private readonly startedTools = new Map<string, number>()
  private lastPhase = ''
  private lastThinkingUpdate = 0

  constructor(
    private readonly write: OutputWriter,
    private readonly verbose = false,
    private readonly now: () => number = Date.now,
    private readonly t: Translator = DEFAULT_TRANSLATOR,
  ) {}

  start(model: string, workspacePath: string): void {
    this.write(`[TurboFlux] ${model} · ${workspacePath}\n`)
  }

  handle(event: AgentEventType): void {
    switch (event.type) {
      case 'run:state':
        if (event.state.phase !== this.lastPhase && event.state.phase !== 'idle') {
          this.lastPhase = event.state.phase
          this.write(`[${formatRunPhase(event.state.phase, this.t)}]\n`)
        }
        break
      case 'stream:thinking_delta': {
        const timestamp = this.now()
        if (timestamp - this.lastThinkingUpdate >= 5_000) {
          this.lastThinkingUpdate = timestamp
          this.write(`[${this.t('single.thinking')}]\n`)
        }
        break
      }
      case 'tool:call':
        this.startedTools.set(event.toolCall.id, this.now())
        this.write(`→ ${event.toolCall.name}${summarizeToolCall(event.toolCall, this.verbose)}\n`)
        break
      case 'tool:result': {
        const startedAt = this.startedTools.get(event.toolResult.toolCallId)
        this.startedTools.delete(event.toolResult.toolCallId)
        const elapsed = startedAt === undefined ? '' : ` · ${formatElapsed(this.now() - startedAt)}`
        const failure = event.toolResult.isError ? ` · ${singleLine(event.toolResult.output, 160)}` : ''
        this.write(`${event.toolResult.isError ? '✗' : '✓'} ${event.toolResult.name}${elapsed}${failure}\n`)
        break
      }
      case 'model:protocol':
        if (event.phase === 'fallback') this.write(`[${this.t('single.protocolFallback')}] ${event.message || event.url}\n`)
        break
      case 'subagent:start':
        this.write(`[${this.t('single.agent')}] ${this.t('single.agentStarted', { agent: event.label })}\n`)
        break
      case 'subagent:end':
        this.write(`[${this.t('single.agent')}] ${this.t('single.agentFinished', { agent: event.agentType, status: this.t(event.ok ? 'single.completed' : 'single.failed'), elapsed: formatElapsed(event.elapsedMs) })}\n`)
        break
      case 'notification':
        if (event.level === 'warning' || event.level === 'error') {
          this.write(`[${this.t(event.level === 'warning' ? 'single.warning' : 'single.error')}] ${singleLine(event.message, 240)}\n`)
        }
        break
      case 'ask:user':
        this.write(`[${this.t('single.inputRequired')}] ${singleLine(event.question, 240)}\n`)
        break
      case 'error':
        this.write(`[${this.t('single.error')}] ${singleLine(event.error, 240)}\n`)
        break
    }
  }
}

export async function runSingleShot(options: SingleShotOptions): Promise<void> {
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const writeProgress = (text: string) => { stderr.write(text) }
  const t = createTranslator(loadProfile().interfaceLanguage)

  if (!options.config.apiKey) throw new Error(t('single.noApiKey'))
  if (!options.config.model) throw new Error(t('single.noModel'))

  const workspaceName = basename(options.workspacePath) || 'workspace'
  const runtime = createAgentRuntime({
    workspacePath: options.workspacePath,
    workspaceName,
    config: options.config,
    conversationPrefix: 'cli-command',
    approvalPolicy: options.approvalPolicy,
    capabilityProfile: options.capabilityProfile,
    connectMcp: Boolean(options.mcpServers?.length),
    mcpServers: options.mcpServers,
    registerSkills: skillRuntime => commandRegistry.registerSkills(skillRuntime),
  })
  const reporter = new SingleShotProgressReporter(writeProgress, options.verbose, Date.now, t)
  const conversations = new ConversationManager(runtime.engine, options.config, options.workspacePath, error => {
    if (error) writeProgress(`[${t('single.warning')}] ${t('single.historyUnavailable', { message: singleLine(error.message, 240) })}\n`)
  }, runtime.sessionRegistry)
  runtime.engine.setEventRecorder(event => conversations.recordEvent(event))
  const unsubscribe = runtime.engine.subscribe(event => {
    reporter.handle(event)
  })

  reporter.start(options.config.model, options.workspacePath)
  try {
    const turns = await runtime.engine.run(options.prompt)
    const finalText = finalAssistantText(turns)
    if (finalText) stdout.write(`${finalText}\n`)
  } finally {
    unsubscribe()
    await runtime.destroy()
    runtime.engine.setEventRecorder(null)
    conversations.destroy()
  }
}

function finalAssistantText(turns: AgentTurn[]): string {
  const finalTurn = [...turns].reverse().find(turn => turn.role === 'assistant' && turn.content.trim())
  return finalTurn
    ? stripTextToolCallMarkup(finalTurn.content, { stripIncomplete: true }).trim()
    : ''
}

function formatRunPhase(phase: string, t: Translator): string {
  if (phase === 'idle') return t('single.phase.idle')
  if (phase === 'thinking') return t('single.phase.thinking')
  if (phase === 'tool_running') return t('single.phase.toolRunning')
  if (phase === 'awaiting_approval') return t('single.phase.awaitingApproval')
  if (phase === 'awaiting_input') return t('single.phase.awaitingInput')
  if (phase === 'paused') return t('single.phase.paused')
  if (phase === 'aborting') return t('single.phase.aborting')
  if (phase === 'recoverable_error') return t('single.phase.recoverableError')
  if (phase === 'completed') return t('single.phase.completed')
  return phase
}

function summarizeToolCall(toolCall: ToolCall, verbose: boolean): string {
  if (verbose) return ` ${singleLine(JSON.stringify(toolCall.arguments), 320)}`
  const args = toolCall.arguments
  const value = args.path ?? args.command ?? args.query ?? args.pattern ?? args.title ?? args.message
  return typeof value === 'string' && value.trim()
    ? ` · ${singleLine(value, 120)}`
    : ''
}

function singleLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, milliseconds)}ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
}
