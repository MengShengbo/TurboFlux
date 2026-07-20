import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { render, Box, Static, Text, useInput, useApp, useBoxMetrics, type DOMElement } from 'ink'
import { ThemeProvider, useTheme } from '../theme/index'
import { Header } from './header/Header'
import { StatusLine } from './header/StatusLine'
import type { ToolStatus } from './tools/ToolCallTree'
import { ActiveWorkPanel, type StreamingToolDraft } from './tools/ActiveWorkPanel'
import { FastContextBanner } from './tools/FastContextBanner'
import { ConversationHistory, type ConversationEntry } from './ConversationHistory'
import { RewindSelector } from './input/RewindSelector'
import { ModelPicker } from './input/ModelPicker'
import { EffortPicker, type EffortSelection } from './input/EffortPicker'
import { PermissionDialog, type PermissionDecision } from './permissions/PermissionDialog'
import { MessageList } from './messages/MessageList'
import { useOverlayStack } from '../hooks/useOverlayStack'
import { useMessageCursor } from '../hooks/useMessageCursor'
import type { FastContextScanEvent } from '../../core/fastContextTypes'
import type { AgentAttachment, AgentRunState, AgentTurn, ApprovalPolicy, ChangeSummary, TokenUsage } from '../../shared/agentTypes'
import type { TerminalSessionInfo } from '../../shared/terminalTypes'
import type { ContextReservoirEntry, ContextSegment } from '../../state/types'
import { type Message } from './messages/Messages'
import { PromptInput } from './input/PromptInput'
import { formatMarkdown } from './markdown/index'
import type { AgentEventType } from '../../core/agentEngine'
import { createAgentRuntime } from '../../core/runtime/agentRuntime'
import type { ActiveTaskContext } from '../../core/taskManager'
import { applyPreset, saveConfig, setConfigValue, type ModelPreset, type TurboFluxConfig } from '../../core/config'
import { discoverModelPresets, readCachedModelDiscovery } from '../../core/modelDiscovery'
import { formatNativeReasoningSetting, getModelReasoningCapabilities } from '../../core/modelRegistry'
import { commandRegistry } from '../commands/index'
import type { CommandContext } from '../commands/types'
import { ConversationManager } from '../conversations/manager'
import type { MascotMood } from './header/Mascot'
import { stripTextToolCallMarkup } from '../../shared/toolCallMarkup'
import { useTerminalSize } from '../hooks/useTerminalSize'
import { MAX_INLINE_DIFF_RENDER_ROWS } from './diff/DiffCard'
import { getSafeFrameWidth, getSafeViewportWidth } from '../terminalLayout'
import { TerminalSessionsFooter } from './tools/TerminalSessionsFooter'
import { AgentActivityLine } from './tools/AgentActivityLine'
import { resolveCockpitLayout, TaskRail, WorkRail } from './layout/CockpitRails'
import { getStartupAnimationFrame, shouldAnimateStartup, STARTUP_ANIMATION_MS } from './layout/StartupAnimation'
import { appendFastContextUiEvents, createFastContextUiSummary, reduceFastContextUiSummary } from './layout/fastContextUi'
import { shouldUseCompactWordmark } from '../brand'
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, parseTerminalMouseWheel, shouldEnableMouseTracking } from '../terminalMouse'
import { captureClipboardImageAttachment, hasImageReference, imageAttachmentFingerprint, imagePlaceholderForIndex, reconcileDraftImagePrompt, resolveImagePrompt } from '../imageAttachments'
import {
  DEFAULT_MOUSE_WHEEL_ROWS,
  TranscriptViewport,
  clampTranscriptScroll,
  getTranscriptPageRows,
  revealTranscriptRange,
  type TranscriptViewportMetrics,
} from './TranscriptViewport'

interface AppProps {
  workspacePath: string
  workspaceName: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker: boolean
  approvalPolicy?: ApprovalPolicy
  mcpServers?: string[]
  startupAnimation?: boolean
}

type StaticTranscriptItem =
  | { kind: 'header'; id: string }
  | { kind: 'message'; id: string; message: Message }

type QueuedPrompt = {
  prompt: string
  attachments?: AgentAttachment[]
}

function isMessageRole(role: string): role is Message['role'] {
  return role === 'user' || role === 'assistant' || role === 'system'
}

function TaskProgressLine({ task }: { task: ActiveTaskContext }) {
  const completed = task.toolCalls.filter(call =>
    call.status === 'completed' || call.status === 'error' || call.status === 'cancelled'
  ).length
  const total = task.toolCalls.length
  const errored = task.toolCalls.filter(call => call.status === 'error').length
  const running = task.toolCalls.filter(call => call.status === 'running').length
  const latest = [...task.toolCalls].reverse().find(call => call.status === 'running') ?? task.toolCalls[task.toolCalls.length - 1]
  const toolSummary = formatTaskToolSummary(completed, total, running, errored)
  const elapsed = formatElapsed(Date.now() - task.startedAt)
  const progress = formatTaskProgressLabel(task.progress)
  return (
    <Box>
      <Text dimColor>Task </Text>
      <Text>{task.title}</Text>
      <Text dimColor>{` - ${toolSummary}`}</Text>
      {latest && <Text dimColor>{` - ${formatTaskToolName(latest.toolName)}`}</Text>}
      <Text dimColor>{` - ${elapsed}`}</Text>
      {progress && <Text dimColor>{` - ${progress}`}</Text>}
    </Box>
  )
}

export function formatTaskToolSummary(completed: number, total: number, running: number, errored: number): string {
  if (total === 0) return 'planning'
  const parts = [`tools ${completed}/${total}`]
  if (running > 0) parts.push(`${running} running`)
  if (errored > 0) parts.push(`${errored} failed`)
  return parts.join(', ')
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '0s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m${rest.toString().padStart(2, '0')}s`
}

export function formatTaskProgressLabel(progress: number): string {
  if (progress >= 95 && progress < 100) return 'finishing'
  if (progress > 0 && progress < 95) return `${Math.round(progress)}%`
  return ''
}

function formatTaskToolName(name: string): string {
  switch (name) {
    case 'read_file': return 'read'
    case 'read_file_full': return 'read full'
    case 'search_content': return 'search'
    case 'search_files': return 'find files'
    case 'search_symbols': return 'symbols'
    case 'get_codemap': return 'codemap'
    case 'explore_code': return 'explore'
    case 'write_file': return 'write'
    case 'replace_file': return 'replace'
    case 'edit_file': return 'edit'
    case 'multi_edit': return 'multi-edit'
    case 'run_command': return 'shell'
    case 'read_terminal': return 'read terminal'
    case 'write_terminal': return 'write terminal'
    case 'list_terminals': return 'list terminals'
    case 'kill_terminal': return 'stop terminal'
    default: return name
  }
}

function serializeToolArgsForUi(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  const clone: Record<string, unknown> = { ...args }
  for (const key of ['content', 'data', 'old_content', 'new_content', 'old_string', 'new_string']) {
    if (typeof clone[key] === 'string') {
      clone[key] = `<${(clone[key] as string).length} chars>`
    }
  }
  if (Array.isArray(clone.edits)) {
    clone.edits = clone.edits.map((edit) => {
      if (!edit || typeof edit !== 'object') return edit
      const next: Record<string, unknown> = { ...(edit as Record<string, unknown>) }
      for (const key of ['old_string', 'new_string']) {
        if (typeof next[key] === 'string') next[key] = `<${(next[key] as string).length} chars>`
      }
      return next
    })
  }
  return JSON.stringify(clone)
}

export function turnsToMessages(turns: AgentTurn[]): Message[] {
  const resultByToolCallId = new Map<string, NonNullable<AgentTurn['toolResults']>[number]>()
  for (const turn of turns) {
    if (turn.role !== 'tool_result' || !turn.toolResults) continue
    for (const result of turn.toolResults) resultByToolCallId.set(result.toolCallId, result)
  }

  return turns.flatMap(turn => {
    if (!isMessageRole(turn.role)) return []
    const tools = turn.toolCalls?.map(toolCall => {
      const result = resultByToolCallId.get(toolCall.id)
      return {
        id: toolCall.id,
        name: toolCall.name,
        status: result?.isError ? 'error' as const : 'done' as const,
        args: serializeToolArgsForUi(toolCall.arguments),
        output: result?.output?.slice(0, 200),
        startTime: turn.timestamp,
        endTime: result ? turn.timestamp + 1 : undefined,
      }
    })
    const changes = turn.toolCalls?.flatMap(toolCall => {
      const summary = resultByToolCallId.get(toolCall.id)?.changeSummary
      return summary ? [summary] : []
    })
    return [{
      id: turn.id,
      role: turn.role,
      content: turn.content,
      tools: tools && tools.length > 0 ? tools : undefined,
      changes: changes && changes.length > 0 ? changes : undefined,
      interrupted: turn.metadata?.interrupted === true,
    }]
  })
}

function normalizeEnvFlag(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase()
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = normalizeEnvFlag(value)
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function isFalsyEnv(value: string | undefined): boolean {
  const normalized = normalizeEnvFlag(value)
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}

export function shouldUseNoFlicker(
  interactive: boolean,
  singleShot?: string,
  requested = true,
): boolean {
  if (!interactive || singleShot) return false
  const forced = normalizeEnvFlag(process.env.TURBOFLUX_NO_FLICKER)
  if (isFalsyEnv(forced)) return false
  if (isTruthyEnv(forced)) return true
  return requested
}

export function sliceTurnsBeforeNthUserTurn(turns: AgentTurn[], userTurnOrdinal: number): AgentTurn[] {
  if (userTurnOrdinal < 0) return turns

  let seenUsers = 0
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]?.role !== 'user') continue
    if (seenUsers === userTurnOrdinal) {
      return turns.slice(0, i)
    }
    seenUsers += 1
  }

  return turns
}

export function getEngineUserOrdinalForUiMessage(messages: Message[], turns: AgentTurn[], targetMessageIndex: number): number {
  const engineUserTurns = turns.filter(turn => turn.role === 'user')
  let engineUserOrdinal = 0

  for (let i = 0; i <= targetMessageIndex; i++) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue

    const nextEngineTurn = engineUserTurns[engineUserOrdinal]
    const matchesEngineTurn = nextEngineTurn?.content === message.content
    if (i === targetMessageIndex) return engineUserOrdinal
    if (matchesEngineTurn) engineUserOrdinal += 1
  }

  return engineUserOrdinal
}

function estimateOutputTokensForDisplay(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

function CockpitRoot({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
  const theme = useTheme()
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      {children}
    </Box>
  )
}

function SessionPane({ running, visible, children }: { running: boolean; visible: boolean; children: React.ReactNode }) {
  const theme = useTheme()
  return (
    <Box
      flexDirection="column"
      flexBasis={0}
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      minWidth={0}
      backgroundColor={theme.background}
      overflow="hidden"
    >
      <Box flexShrink={0} paddingX={1} backgroundColor={theme.panelRaised} justifyContent="space-between">
        <Text color={theme.brand} bold>{visible ? 'SESSION' : ' '}</Text>
        <Text color={running ? theme.brandShimmer : theme.success} bold>{visible ? running ? '● RUNNING' : '● READY' : ' '}</Text>
      </Box>
      <Box
        flexDirection="column"
        flexBasis={0}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        paddingX={1}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  )
}

function PromptPlaceholder() {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  return (
    <Box
      height={3}
      width={getSafeFrameWidth(columns, 3)}
      backgroundColor={theme.promptBackground}
    />
  )
}

function StatusPlaceholder() {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  return <Box height={1} width={getSafeFrameWidth(columns, 3)} backgroundColor={theme.panelRaised} />
}

function App({ workspacePath, workspaceName, config: initialConfig, singleShot, verbose, noFlicker, approvalPolicy, mcpServers, startupAnimation = true }: AppProps) {
  const { exit } = useApp()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const terminal = useTerminalSize()
  const noFlickerActive = noFlicker && isInteractive && !singleShot
  const startupAnimationEnabled = shouldAnimateStartup(isInteractive, singleShot, startupAnimation && noFlickerActive)
  const startupStartedAtRef = useRef(Date.now())
  const [startupElapsed, setStartupElapsed] = useState(startupAnimationEnabled ? 0 : STARTUP_ANIMATION_MS)
  const startupFrame = getStartupAnimationFrame(startupElapsed)
  const [config, setConfig] = useState(initialConfig)
  const [messages, setMessages] = useState<Message[]>([])
  const [staticTranscriptRevision, setStaticTranscriptRevision] = useState(0)
  const [input, setInput] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<AgentAttachment[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [currentTurnOutputTokens, setCurrentTurnOutputTokens] = useState(0)
  const [currentTools, setCurrentTools] = useState<ToolStatus[]>([])
  const [streamingToolDraft, setStreamingToolDraft] = useState<StreamingToolDraft | null>(null)
  const [mood, setMood] = useState<MascotMood>('idle')
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({ source: 'unknown' })
  const [currentMode, setCurrentMode] = useState<'vibe' | 'plan'>('vibe')
  const [gitEnabled, setGitEnabled] = useState(false)
  const [modelPresets, setModelPresets] = useState<ModelPreset[]>([])
  const [modelDiscoveryStatus, setModelDiscoveryStatus] = useState({
    isRefreshing: false,
    stale: false,
    error: undefined as string | undefined,
  })
  const modelDiscoveryRequestRef = useRef(0)
  const [lastActivity, setLastActivity] = useState<number>(Date.now())
  const [runState, setRunState] = useState<AgentRunState>({ phase: 'idle', updatedAt: Date.now() })
  const [convListRevision, setConvListRevision] = useState(0)
  const [fcEvents, setFcEvents] = useState<FastContextScanEvent[]>([])
  const [fcSummary, setFcSummary] = useState(createFastContextUiSummary)
  const [fcActive, setFcActive] = useState(false)
  const [activeTask, setActiveTask] = useState<ActiveTaskContext | null>(null)
  const [activeObjective, setActiveObjective] = useState<{ prompt: string; startedAt: number } | null>(null)
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([])
  const [changeSummaries, setChangeSummaries] = useState<ChangeSummary[]>([])
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
  const [interruptHint, setInterruptHint] = useState<string | null>(null)
  const [exitHint, setExitHint] = useState<string | null>(null)
  const [pendingAsk, setPendingAsk] = useState<{
    id: string
    question: string
    options?: string[]
    reason?: string
    command?: string
    toolName?: string
    path?: string
  } | null>(null)
  const [askInput, setAskInput] = useState('')
  const { active: activeOverlay, push, pop } = useOverlayStack()
  const { cursor, enter, navigatePrev, navigateNext, clear } = useMessageCursor(messages)
  const [cursorMode, setCursorMode] = useState(false)
  const [scrollRowsFromBottom, setScrollRowsFromBottom] = useState(0)
  const [transcriptMetrics, setTranscriptMetrics] = useState<TranscriptViewportMetrics>({
    contentRows: 0,
    viewportRows: 1,
    maxScrollRows: 0,
  })
  const transcriptMetricsRef = useRef(transcriptMetrics)
  const selectedMessageRef = useRef<DOMElement>(null)
  const selectedMessageMetrics = useBoxMetrics(selectedMessageRef)
  const messageIdRef = useRef(0)
  const streamBufferRef = useRef('')
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fcEventBufferRef = useRef<FastContextScanEvent[]>([])
  const fcFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fcActiveRef = useRef(false)
  const inputRef = useRef('')
  const draftAttachmentsRef = useRef<AgentAttachment[]>([])
  const isRunningRef = useRef(false)
  const queuedPromptsRef = useRef<QueuedPrompt[]>([])
  const activePromptRef = useRef<{ prompt: string; messageId: string; responseStarted: boolean; attachments?: AgentAttachment[]; priorTurns: AgentTurn[] } | null>(null)
  const abortingRef = useRef(false)
  const abortRestoredPromptRef = useRef(false)
  const runPromptRef = useRef<((prompt: string, attachments?: AgentAttachment[]) => Promise<void>) | null>(null)
  const exitPressRef = useRef(0)
  const lastCtrlCEventAtRef = useRef(0)
  const handleInterruptRef = useRef<() => void>(() => {})
  const lastClipboardImageRef = useRef<{ fingerprint: string; at: number } | null>(null)
  const genMsgId = useCallback(() => {
    messageIdRef.current += 1
    return `msg-${messageIdRef.current}`
  }, [])

  // Refs to avoid stale closures in the engine event subscription (effect runs once)
  const currentToolsRef = useRef<ToolStatus[]>([])
  const changeSummariesRef = useRef<ChangeSummary[]>([])
  useEffect(() => { currentToolsRef.current = currentTools }, [currentTools])
  useEffect(() => { changeSummariesRef.current = changeSummaries }, [changeSummaries])
  useEffect(() => { draftAttachmentsRef.current = draftAttachments }, [draftAttachments])

  const [runtime] = useState(() => createAgentRuntime({
    workspacePath,
    workspaceName,
    config: initialConfig,
    conversationPrefix: 'cli',
    approvalPolicy,
    connectMcp: Boolean(mcpServers?.length),
    mcpServers,
    registerSkills: skillRuntime => commandRegistry.registerSkills(skillRuntime),
  }))
  const { engine, stateProvider, skillRuntime, mcpClient } = runtime
  const [convManager] = useState(() => new ConversationManager(engine, config, workspacePath))

  useEffect(() => {
    if (!startupAnimationEnabled) {
      setStartupElapsed(STARTUP_ANIMATION_MS)
      return
    }

    startupStartedAtRef.current = Date.now()
    setStartupElapsed(0)
    const timer = setInterval(() => {
      const elapsed = Date.now() - startupStartedAtRef.current
      setStartupElapsed(Math.min(STARTUP_ANIMATION_MS, elapsed))
      if (elapsed >= STARTUP_ANIMATION_MS) clearInterval(timer)
    }, 40)

    return () => clearInterval(timer)
  }, [startupAnimationEnabled])

  const skipStartupAnimation = useCallback(() => {
    setStartupElapsed(STARTUP_ANIMATION_MS)
  }, [])

  useEffect(() => {
    if (!shouldEnableMouseTracking(isInteractive, noFlickerActive)) return
    process.stdout.write(ENABLE_MOUSE_TRACKING)
    return () => {
      process.stdout.write(DISABLE_MOUSE_TRACKING)
    }
  }, [isInteractive, noFlickerActive])

  useEffect(() => { isRunningRef.current = isRunning }, [isRunning])
  useEffect(() => { queuedPromptsRef.current = queuedPrompts }, [queuedPrompts])

  const persistConfig = useCallback((nextConfig: TurboFluxConfig) => {
    stateProvider.updateConfig(nextConfig)
    convManager.updateConfig(nextConfig)
    setConfig(nextConfig)
    saveConfig(nextConfig)
  }, [stateProvider, convManager])

  const clearStreamFlushTimer = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
  }, [])

  const flushFastContextUi = useCallback(() => {
    if (fcFlushTimerRef.current) {
      clearTimeout(fcFlushTimerRef.current)
      fcFlushTimerRef.current = null
    }
    const events = fcEventBufferRef.current
    if (events.length === 0) return
    fcEventBufferRef.current = []
    setFcEvents(current => appendFastContextUiEvents(current, events))
    setFcSummary(current => reduceFastContextUiSummary(current, events))
    setLastActivity(Date.now())
  }, [])

  const queueFastContextUiEvent = useCallback((event: FastContextScanEvent) => {
    fcEventBufferRef.current.push(event)
    if (!fcFlushTimerRef.current) {
      fcFlushTimerRef.current = setTimeout(flushFastContextUi, 80)
    }
  }, [flushFastContextUi])

  const discardFastContextUiBuffer = useCallback(() => {
    if (fcFlushTimerRef.current) {
      clearTimeout(fcFlushTimerRef.current)
      fcFlushTimerRef.current = null
    }
    fcEventBufferRef.current = []
  }, [])

  const resetFastContextUi = useCallback(() => {
    discardFastContextUiBuffer()
    fcActiveRef.current = false
    setFcEvents([])
    setFcSummary(createFastContextUiSummary())
    setFcActive(false)
  }, [discardFastContextUiBuffer])

  const appendMessages = useCallback((nextMessages: Message[], options?: { forceLatest?: boolean }) => {
    if (nextMessages.length === 0) return

    setMessages(msgs => [...msgs, ...nextMessages])
    if (noFlickerActive && options?.forceLatest === true) setScrollRowsFromBottom(0)
  }, [noFlickerActive])

  const replaceMessages = useCallback((nextMessages: React.SetStateAction<Message[]>) => {
    setStaticTranscriptRevision(revision => revision + 1)
    setMessages(nextMessages)
  }, [])

  const restoreCliStateFromTurns = useCallback((
    activeTurns: AgentTurn[],
    nextInput = '',
    contextSegments: ContextSegment[] = [],
    contextReservoir: ContextReservoirEntry[] = [],
    transcriptTurns: AgentTurn[] = activeTurns,
  ) => {
    engine.restoreFromTurns(activeTurns)
    engine.setContextSegments(contextSegments)
    engine.setContextReservoir(contextReservoir)
    replaceMessages(turnsToMessages(transcriptTurns))
    inputRef.current = nextInput
    setInput(nextInput)
    draftAttachmentsRef.current = []
    setDraftAttachments([])
    setScrollRowsFromBottom(0)
    setTokenUsage(engine.getContextUsage())
    setGitEnabled(engine.isGitEnabled())
    setCurrentTools([])
    setStreamingToolDraft(null)
    setChangeSummaries([])
    setCurrentTurnOutputTokens(0)
    streamBufferRef.current = ''
    clearStreamFlushTimer()
    setStreamText('')
    resetFastContextUi()
    setFcActive(false)
    setActiveTask(null)
    setActiveObjective(null)
    setTerminalSessions([])
    setPendingAsk(null)
    setAskInput('')
    queuedPromptsRef.current = []
    setQueuedPrompts([])
    activePromptRef.current = null
    abortingRef.current = false
    setInterruptHint(null)
    setExitHint(null)
    setCursorMode(false)
    clear()
    setIsRunning(false)
    setMood('idle')
  }, [engine, stateProvider, clearStreamFlushTimer, clear, replaceMessages, resetFastContextUi])

  const getRewindContextSegments = useCallback((turns: AgentTurn[]) => {
    const boundaryTime = turns.reduce((max, turn) => Math.max(max, turn.timestamp), 0)
    return stateProvider.getContextSegments().filter(segment => {
      if (typeof segment.createdAt !== 'number') return true
      return segment.createdAt <= boundaryTime
    })
  }, [stateProvider])

  const setComposedInput = useCallback((nextValue: string | ((current: string) => string)) => {
    const rawValue = typeof nextValue === 'function' ? nextValue(inputRef.current) : nextValue
    const reconciled = reconcileDraftImagePrompt(rawValue, draftAttachmentsRef.current)
    inputRef.current = reconciled.prompt
    draftAttachmentsRef.current = reconciled.attachments
    setDraftAttachments(reconciled.attachments)
    setInput(reconciled.prompt)
  }, [])

  useEffect(() => {
    stateProvider.updateConfig(config)
    convManager.updateConfig(config)
  }, [stateProvider, convManager, config])

  const loadModelPresets = useCallback(async (targetConfig: TurboFluxConfig, force = false) => {
    const requestId = ++modelDiscoveryRequestRef.current
    setModelDiscoveryStatus(current => ({ ...current, isRefreshing: true, error: force ? undefined : current.error }))
    const result = await discoverModelPresets(targetConfig, { force })
    if (requestId !== modelDiscoveryRequestRef.current) return
    setModelPresets(result.models)
    setModelDiscoveryStatus({ isRefreshing: false, stale: result.stale, error: result.error })
  }, [])

  useEffect(() => {
    const cached = readCachedModelDiscovery(config, true)
    if (cached) {
      setModelPresets(cached.models)
      setModelDiscoveryStatus({ isRefreshing: cached.stale, stale: cached.stale, error: undefined })
    }
    void loadModelPresets(config)
    return () => { modelDiscoveryRequestRef.current += 1 }
  }, [config.activeApiConfigId, config.apiKey, config.baseUrl, config.provider, loadModelPresets])

  useEffect(() => {
    const unsub = engine.subscribe((event: AgentEventType) => {
      convManager.recordEvent(event)
      switch (event.type) {
        case 'run:state':
          setRunState(event.state)
          setLastActivity(event.state.updatedAt)
          if (event.state.phase === 'awaiting_approval' || event.state.phase === 'awaiting_input') setMood('thinking')
          break
        case 'stream:start':
          setIsRunning(true)
          setCurrentTurnOutputTokens(0)
          setStreamingToolDraft(null)
          streamBufferRef.current = ''
          clearStreamFlushTimer()
          break
        case 'stream:delta':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          streamBufferRef.current += event.text
          setCurrentTurnOutputTokens(previous => Math.max(previous, estimateOutputTokensForDisplay(streamBufferRef.current)))
          if (!streamFlushTimerRef.current) {
            streamFlushTimerRef.current = setTimeout(() => {
              streamFlushTimerRef.current = null
              setStreamText(streamBufferRef.current)
            }, 80)
          }
          setLastActivity(Date.now())
          break
        case 'stream:usage':
          setTokenUsage(event.usage)
          if (typeof event.usage.output === 'number') {
            setCurrentTurnOutputTokens(previous => Math.max(previous, event.usage.output ?? 0))
          }
          break
        case 'stream:end': {
          clearStreamFlushTimer()
          const bufferedStreamText = streamBufferRef.current
          streamBufferRef.current = ''
          const toolsSnapshot = currentToolsRef.current
          const changesSnapshot = changeSummariesRef.current
          const visibleText = stripTextToolCallMarkup(bufferedStreamText, { stripIncomplete: true })
          if (visibleText || toolsSnapshot.length > 0 || changesSnapshot.length > 0) {
            appendMessages([{
              id: genMsgId(),
              role: 'assistant',
              content: visibleText,
              tools: [...toolsSnapshot],
              changes: [...changesSnapshot],
              interrupted: event.interrupted === true,
            }])
          }
          setStreamText('')
          setCurrentTurnOutputTokens(0)
          setCurrentTools([])
          setChangeSummaries([])
          setStreamingToolDraft(null)
          setIsRunning(engine.isRunning())
          setMood(event.interrupted ? 'idle' : 'happy')
          setTokenUsage(engine.getContextUsage())
          convManager.scheduleSave()
          if (!event.interrupted) setTimeout(() => setMood('idle'), 3000)
          break
        }
        case 'session:complete':
          convManager.scheduleSave()
          break
        case 'tool:call':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          setIsRunning(true)
          setStreamingToolDraft(prev => prev?.id === event.toolCall.id ? null : prev)
          setCurrentTools(prev => [...prev, {
            id: event.toolCall.id,
            name: event.toolCall.name,
            status: 'running',
            args: serializeToolArgsForUi(event.toolCall.arguments),
            startTime: Date.now(),
          }])
          setLastActivity(Date.now())
          break
        case 'stream:tool_call_delta':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          setIsRunning(true)
          setStreamingToolDraft(prev => ({
            id: event.toolCallId,
            name: event.toolName || prev?.name || 'tool',
            partialJson: event.partialJson,
            startedAt: prev?.id === event.toolCallId ? prev.startedAt : Date.now(),
            updatedAt: Date.now(),
          }))
          setLastActivity(Date.now())
          break
        case 'tool:result':
          setIsRunning(true)
          setStreamingToolDraft(prev => {
            if (!prev) return null
            return prev.id === event.toolResult.toolCallId ? null : prev
          })
          setCurrentTools(prev =>
            prev.map(t => t.id === event.toolResult.toolCallId
              ? { ...t, status: event.toolResult.isError ? 'error' : 'done', output: event.toolResult.output?.slice(0, 200), endTime: Date.now() }
              : t
            )
          )
          if (event.toolResult.changeSummary) {
            setChangeSummaries(prev => [...prev, event.toolResult.changeSummary!])
          }
          setLastActivity(Date.now())
          break
        case 'fast_context:event':
          queueFastContextUiEvent(event.event)
          if (!fcActiveRef.current) {
            fcActiveRef.current = true
            setFcActive(true)
          }
          break
        case 'fast_context:complete':
          flushFastContextUi()
          fcActiveRef.current = false
          setFcActive(false)
          break
        case 'active:task':
          setActiveTask(event.context)
          break
        case 'terminal:sessions':
          setTerminalSessions(event.sessions)
          break
        case 'runtime-task:finished': {
          const sessionId = event.task.metadata?.sessionId
          if (event.task.kind === 'terminal' && typeof sessionId === 'string') {
            setTerminalSessions(current => current.map(session => session.id === sessionId
              ? {
                  ...session,
                  status: event.task.status === 'failed' ? 'error' : 'exited',
                  exitCode: event.task.exitCode,
                  error: event.task.error,
                  updatedAt: event.task.updatedAt,
                }
              : session))
          }
          setLastActivity(Date.now())
          break
        }
        case 'ask:user':
          setPendingAsk({
            id: event.requestId || `ask-${Date.now()}`,
            question: event.question,
            options: event.options,
            reason: event.reason,
            command: event.command,
            toolName: event.toolName,
            path: event.path,
          })
          setAskInput('')
          setMood('thinking')
          break
        case 'context:segment_created':
          convManager.scheduleSave()
          setLastActivity(Date.now())
          break
        case 'model:protocol':
          if (event.phase === 'fallback') {
            appendMessages([{
              id: genMsgId(),
              role: 'system',
              content: `Protocol fallback: ${event.message || 'request format mismatch'} → ${event.url}`,
            }], { forceLatest: true })
          }
          break
        case 'error':
          streamBufferRef.current = ''
          clearStreamFlushTimer()
      setStreamText('')
      appendMessages([{ id: genMsgId(), role: 'system', content: `Error: ${event.error}` }])
      setStreamingToolDraft(null)
      setIsRunning(false)
          setMood('error')
          setTimeout(() => setMood('idle'), 4000)
          break
        case 'mode:change':
          setCurrentMode(event.to)
          setGitEnabled(engine.isGitEnabled())
          break
      }
    })
    return () => {
      clearStreamFlushTimer()
      discardFastContextUiBuffer()
      unsub()
      convManager.destroy()
      runtime.destroy().catch(() => {})
    }
  }, [engine, runtime, clearStreamFlushTimer, appendMessages, queueFastContextUiEvent, flushFastContextUi, discardFastContextUiBuffer])

  const getConversationEntries = useCallback((): ConversationEntry[] => {
    const convs = convManager.list()
    const currentId = convManager.getCurrentId()
    return convs.map(c => ({
      id: c.id,
      title: c.title || c.id.slice(0, 12),
      turnCount: c.turnCount,
      updatedAt: c.updatedAt,
      isCurrent: c.id === currentId,
    }))
  }, [convManager])

  useEffect(() => {
    if (singleShot) runPrompt(singleShot)
  }, [])

  const transcriptRowBudget = useMemo(() => {
    if (!noFlickerActive) return Number.MAX_SAFE_INTEGER
    const headerRows = (shouldUseCompactWordmark(terminal.columns, terminal.rows) ? 5 : 9) + (config.apiKey ? 0 : 1)
    const bottomRows = 5
    return Math.max(4, terminal.rows - headerRows - bottomRows)
  }, [noFlickerActive, terminal.rows, terminal.columns, config.apiKey])
  const normalizedScrollRows = noFlickerActive
    ? clampTranscriptScroll(scrollRowsFromBottom, transcriptMetrics.maxScrollRows)
    : 0
  const pageStep = getTranscriptPageRows(
    transcriptMetrics.viewportRows > 1 ? transcriptMetrics.viewportRows : transcriptRowBudget,
  )
  const isViewingHistory = normalizedScrollRows > 0
  const selectedMessageId = cursorMode && cursor ? messages[cursor.index]?.id : undefined
  const cockpit = resolveCockpitLayout(terminal.columns)

  const handleTranscriptMetrics = useCallback((metrics: TranscriptViewportMetrics) => {
    transcriptMetricsRef.current = metrics
    setTranscriptMetrics(previous => {
      if (previous.contentRows === metrics.contentRows &&
        previous.viewportRows === metrics.viewportRows &&
        previous.maxScrollRows === metrics.maxScrollRows) {
        return previous
      }
      return metrics
    })
  }, [])

  const scrollTranscriptBy = useCallback((delta: number) => {
    setScrollRowsFromBottom(rows => clampTranscriptScroll(
      rows + delta,
      transcriptMetricsRef.current.maxScrollRows,
    ))
  }, [])

  useEffect(() => {
    setScrollRowsFromBottom(rows => clampTranscriptScroll(rows, transcriptMetrics.maxScrollRows))
  }, [transcriptMetrics.maxScrollRows])

  useEffect(() => {
    if (!noFlickerActive || !cursorMode || !cursor || !selectedMessageMetrics.hasMeasured) return
    setScrollRowsFromBottom(rows => revealTranscriptRange(
      rows,
      transcriptMetrics.maxScrollRows,
      transcriptMetrics.viewportRows,
      selectedMessageMetrics.top,
      selectedMessageMetrics.height,
    ))
  }, [
    noFlickerActive,
    cursorMode,
    cursor?.index,
    selectedMessageMetrics.hasMeasured,
    selectedMessageMetrics.top,
    selectedMessageMetrics.height,
    transcriptMetrics.maxScrollRows,
    transcriptMetrics.viewportRows,
  ])

  const runNextQueuedPrompt = useCallback(() => {
    const next = queuedPromptsRef.current[0]
    if (!next || isRunningRef.current || runPromptRef.current === null) return
    const rest = queuedPromptsRef.current.slice(1)
    queuedPromptsRef.current = rest
    setQueuedPrompts(rest)
    void runPromptRef.current(next.prompt, next.attachments)
  }, [])

  const runPrompt = useCallback(async (prompt: string, attachments?: AgentAttachment[]) => {
    if (isRunningRef.current) {
      const nextQueue = [...queuedPromptsRef.current, { prompt, attachments }]
      queuedPromptsRef.current = nextQueue
      setQueuedPrompts(nextQueue)
      appendMessages([{ id: genMsgId(), role: 'system', content: `Queued message #${nextQueue.length}: ${prompt.slice(0, 80)}` }], { forceLatest: true })
      return
    }

    const userMessageId = genMsgId()
    setActiveObjective({ prompt, startedAt: Date.now() })
    activePromptRef.current = { prompt, attachments, messageId: userMessageId, responseStarted: false, priorTurns: [...engine.getSession().turns] }
    abortingRef.current = false
    abortRestoredPromptRef.current = false
    appendMessages([{ id: userMessageId, role: 'user', content: prompt }])
    if (!config.apiKey) {
      activePromptRef.current = null
      setActiveObjective(null)
      appendMessages([{ id: genMsgId(), role: 'system', content: 'No model provider is configured yet. Exit and run `turboflux setup`, or set `/config apiKey <key>` manually.' }])
      if (singleShot) exit()
      return
    }
    setIsRunning(true)
    isRunningRef.current = true
    setMood('thinking')
    streamBufferRef.current = ''
    clearStreamFlushTimer()
    setStreamText('')
    setCurrentTools([])
    setStreamingToolDraft(null)
    resetFastContextUi()
    setFcActive(false)
    setActiveTask(null)
    setChangeSummaries([])
    setPendingAsk(null)
    setAskInput('')
    setInterruptHint(null)
    setExitHint(null)
    setLastActivity(Date.now())
    try {
      const turns = await engine.run(prompt, { attachments })
      if (singleShot) {
        const finalAssistantTurn = [...turns].reverse().find(turn => turn.role === 'assistant' && turn.content.trim())
        const finalText = finalAssistantTurn
          ? stripTextToolCallMarkup(finalAssistantTurn.content, { stripIncomplete: true }).trim()
          : ''
        if (finalText) {
          process.stdout.write(`\n${formatMarkdown(finalText)}\n`)
        }
      }
    } catch (e: any) {
      const bufferedStreamText = streamBufferRef.current
      const visibleInterruptedText = stripTextToolCallMarkup(bufferedStreamText, { stripIncomplete: true })
      const toolsSnapshot = currentToolsRef.current
      const changesSnapshot = changeSummariesRef.current
      const interrupted = abortingRef.current || e?.aborted === true || /aborted/i.test(String(e?.message || ''))
      streamBufferRef.current = ''
      clearStreamFlushTimer()
      setStreamText('')
      setStreamingToolDraft(null)
      if (abortRestoredPromptRef.current) {
        // The prompt is already back in the editor; avoid adding a synthetic transcript row.
      } else if (interrupted && (visibleInterruptedText || toolsSnapshot.length > 0 || changesSnapshot.length > 0)) {
        appendMessages([{
          id: genMsgId(),
          role: 'assistant',
          content: visibleInterruptedText,
          tools: [...toolsSnapshot],
          changes: [...changesSnapshot],
          interrupted: true,
        }])
      } else if (interrupted) {
        appendMessages([{ id: genMsgId(), role: 'system', content: 'Interrupted.' }])
      } else {
        appendMessages([{ id: genMsgId(), role: 'system', content: `Error: ${e.message}` }])
      }
      setCurrentTools([])
      setChangeSummaries([])
      setIsRunning(false)
      setMood(abortingRef.current ? 'idle' : 'error')
      if (!abortingRef.current) setTimeout(() => setMood('idle'), 4000)
    } finally {
      activePromptRef.current = null
      setActiveObjective(null)
      abortingRef.current = false
      abortRestoredPromptRef.current = false
      isRunningRef.current = false
      setIsRunning(false)
      setTimeout(runNextQueuedPrompt, 0)
    }
    if (singleShot) exit()
  }, [appendMessages, engine, singleShot, config, clearStreamFlushTimer, exit, runNextQueuedPrompt, genMsgId, resetFastContextUi])

  useEffect(() => {
    runPromptRef.current = runPrompt
  }, [runPrompt])

  const submitAskResponse = useCallback((response: string) => {
    const trimmed = response.trim()
    if (!trimmed) return
    appendMessages([{ id: genMsgId(), role: 'user', content: trimmed }], { forceLatest: true })
    engine.submitAskUserResponse(trimmed)
    setPendingAsk(null)
    setAskInput('')
    setIsRunning(true)
    setMood('thinking')
    setLastActivity(Date.now())
  }, [appendMessages, engine, genMsgId])

  const submitPermissionDecision = useCallback((requestId: string, decision: PermissionDecision) => {
    engine.submitAskUserResponse(decision)
    setPendingAsk(current => current?.id === requestId ? null : current)
    setAskInput('')
    setIsRunning(true)
    setMood('thinking')
    setLastActivity(Date.now())
  }, [engine])

  const isPermissionAsk = pendingAsk?.options?.includes('allow-once') ?? false

  const attachClipboardImage = useCallback((options?: { silentNoImage?: boolean }) => {
    const nextIndex = draftAttachmentsRef.current.length + 1
    const warnings: string[] = []
    const attachment = captureClipboardImageAttachment(nextIndex, warnings, workspacePath)
    if (!attachment) {
      if (!options?.silentNoImage) {
        const visibleWarnings = warnings.length > 0 ? warnings : ['No image was found in the clipboard. Copy an image or paste an image file path.']
        for (const warning of visibleWarnings) {
          appendMessages([{ id: genMsgId(), role: 'system', content: warning }])
        }
      }
      return false
    }

    const fingerprint = imageAttachmentFingerprint(attachment)
    const lastClipboardImage = lastClipboardImageRef.current
    if (fingerprint && lastClipboardImage?.fingerprint === fingerprint && Date.now() - lastClipboardImage.at < 1500) return false
    if (fingerprint) lastClipboardImageRef.current = { fingerprint, at: Date.now() }

    const placeholder = imagePlaceholderForIndex(nextIndex)
    const nextAttachments = [...draftAttachmentsRef.current, { ...attachment, id: `image${nextIndex}` }]
    draftAttachmentsRef.current = nextAttachments
    setDraftAttachments(nextAttachments)
    setComposedInput(current => {
      const spacer = current && !/\s$/.test(current) ? ' ' : ''
      return `${current}${spacer}${placeholder} `
    })
    return true
  }, [appendMessages, genMsgId, setComposedInput, workspacePath])

  const handlePasteImage = useCallback(() => {
    return attachClipboardImage()
  }, [attachClipboardImage])

  const handlePasteText = useCallback((pastedText: string, nextValue: string) => {
    if (!hasImageReference(pastedText)) return null
    const resolved = resolveImagePrompt(nextValue, workspacePath, { existingAttachments: draftAttachmentsRef.current })
    if (resolved.attachments.length === draftAttachmentsRef.current.length) return null

    for (const warning of resolved.warnings) {
      appendMessages([{ id: genMsgId(), role: 'system', content: warning }])
    }
    draftAttachmentsRef.current = resolved.attachments
    setDraftAttachments(resolved.attachments)
    return { value: resolved.prompt, cursorOffset: resolved.prompt.length }
  }, [appendMessages, genMsgId, workspacePath])

  const handleInterrupt = useCallback(() => {
    const pressedAt = Date.now()
    if (pressedAt - lastCtrlCEventAtRef.current < 120) return
    lastCtrlCEventAtRef.current = pressedAt

    if (isRunningRef.current || engine.isRunning() || engine.isFastContextRunning()) {
      const activePrompt = activePromptRef.current
      abortingRef.current = true
      engine.abort()
      setPendingAsk(null)
      setAskInput('')
      queuedPromptsRef.current = []
      setQueuedPrompts([])
      setInterruptHint('Interrupted current agent run.')
      setTimeout(() => setInterruptHint(null), 2500)

      if (activePrompt && !activePrompt.responseStarted) {
        inputRef.current = activePrompt.prompt
        setInput(activePrompt.prompt)
        draftAttachmentsRef.current = activePrompt.attachments ?? []
        setDraftAttachments(activePrompt.attachments ?? [])
        engine.restoreFromTurns(activePrompt.priorTurns)
        replaceMessages(prev => prev.filter(message => message.id !== activePrompt.messageId))
        abortRestoredPromptRef.current = true
      }
      return
    }

    if (pressedAt - exitPressRef.current < 1800) {
      exit()
      return
    }
    exitPressRef.current = pressedAt
    setExitHint('Press Ctrl+C again to exit.')
    setTimeout(() => {
      if (Date.now() - exitPressRef.current >= 1800) setExitHint(null)
    }, 1800)
  }, [engine, exit, replaceMessages])

  useEffect(() => {
    handleInterruptRef.current = handleInterrupt
  }, [handleInterrupt])

  useEffect(() => {
    if (!isInteractive || singleShot) return

    const onSigint = () => {
      handleInterruptRef.current()
    }

    process.on('SIGINT', onSigint)
    return () => {
      process.off('SIGINT', onSigint)
    }
  }, [isInteractive, singleShot])

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const pendingDraftAttachments = draftAttachmentsRef.current
    inputRef.current = ''
    setInput('')
    draftAttachmentsRef.current = []
    setDraftAttachments([])

    if (commandRegistry.isCommand(trimmed) && isRunningRef.current) {
      runPrompt(trimmed, pendingDraftAttachments)
      return
    }

    if (isRunningRef.current) {
      if (engine.submitSteeringMessage(trimmed)) {
        appendMessages([{ id: genMsgId(), role: 'user', content: trimmed }], { forceLatest: true })
        setLastActivity(Date.now())
        return
      }
      runPrompt(trimmed, pendingDraftAttachments)
      return
    }

    if (commandRegistry.isCommand(trimmed)) {
      if (trimmed === '/model') {
        push('modelPicker')
        return
      }
      if (trimmed === '/effort') {
        const capability = getModelReasoningCapabilities(config.model, config.provider, config.modelCapabilities)
        const adjustable = capability && capability.control !== 'fixed'
          && (capability.efforts.length > 0 || capability.supportsToggle || capability.control === 'budget')
        if (adjustable) {
          push('effortPicker')
          return
        }
      }
      if (trimmed === '/resume') {
        push('history')
        return
      }
      const ctx: CommandContext = {
        engine,
        config,
        modelPresets,
        workspacePath,
        setConfig: persistConfig,
        setMessages: replaceMessages,
        restoreConversation: (turns, nextInput) => restoreCliStateFromTurns(turns, nextInput),
        exit,
        conversationManager: convManager,
        skillRuntime,
        mcpClient,
      }
      const result = commandRegistry.execute(trimmed, ctx)
      setTokenUsage(engine.getContextUsage())
      setGitEnabled(engine.isGitEnabled())
      switch (result.type) {
        case 'text':
          appendMessages([{ id: genMsgId(), role: 'system', content: result.text! }])
          break
        case 'prompt':
          runPrompt(result.prompt!)
          break
        case 'none':
          break
      }
      return
    }
    const resolved = resolveImagePrompt(trimmed, workspacePath, { existingAttachments: pendingDraftAttachments })
    for (const warning of resolved.warnings) {
      appendMessages([{ id: genMsgId(), role: 'system', content: warning }])
    }
    runPrompt(resolved.prompt, resolved.attachments)
  }, [appendMessages, config, convManager, engine, exit, mcpClient, modelPresets, persistConfig, push, restoreCliStateFromTurns, runPrompt, skillRuntime, workspacePath, genMsgId])

  const handleAlternateSubmit = useCallback((value: string) => {
    if (!isRunningRef.current) {
      handleSubmit(value)
      return
    }
    const trimmed = value.trim()
    if (!trimmed) return
    const attachments = draftAttachmentsRef.current
    inputRef.current = ''
    setInput('')
    draftAttachmentsRef.current = []
    setDraftAttachments([])
    runPrompt(trimmed, attachments)
  }, [handleSubmit, runPrompt])

  useInput((ch, key) => {
    if (!startupFrame.complete) {
      skipStartupAnimation()
      return
    }
    if (key.ctrl && ch === 'c') {
      handleInterrupt()
      return
    }
    if (activeOverlay !== null) return // overlays handle their own keys

    if (noFlickerActive && !cursorMode && !pendingAsk) {
      const mouseEvents = parseTerminalMouseWheel(ch)
      if (mouseEvents.length > 0) {
        const compactHeader = shouldUseCompactWordmark(terminal.columns, terminal.rows)
        const transcriptTop = compactHeader ? 5 : 9
        const transcriptBottom = terminal.rows - 5
        const transcriptLeft = cockpit.showWorkRail ? cockpit.workWidth + 1 : 1
        const transcriptRight = terminal.columns - (cockpit.showTaskRail ? cockpit.taskWidth : 0) - 1
        const delta = mouseEvents.reduce((total, event) => {
          const insideTranscript = event.x >= transcriptLeft
            && event.x <= transcriptRight
            && event.y >= transcriptTop
            && event.y <= transcriptBottom
          if (!insideTranscript) return total
          return total + (event.direction === 'up' ? DEFAULT_MOUSE_WHEEL_ROWS : -DEFAULT_MOUSE_WHEEL_ROWS)
        }, 0)
        if (delta !== 0) scrollTranscriptBy(delta)
        return
      }
    }

    if (noFlickerActive && !cursorMode) {
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        scrollTranscriptBy(pageStep)
        return
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        scrollTranscriptBy(-pageStep)
        return
      }
      if (key.shift && key.upArrow) {
        scrollTranscriptBy(1)
        return
      }
      if (key.shift && key.downArrow) {
        scrollTranscriptBy(-1)
        return
      }
      if (key.ctrl && ch.toLowerCase() === 'u') {
        scrollTranscriptBy(pageStep)
        return
      }
      if (key.ctrl && ch.toLowerCase() === 'd') {
        scrollTranscriptBy(-pageStep)
        return
      }
    }

    if (key.ctrl && ch === 'h') {
      push('history')
      return
    }

    if (cursorMode) {
      if (key.upArrow) { navigatePrev(); return }
      if (key.downArrow) { navigateNext(); return }
      if (key.escape || key.return) {
        setCursorMode(false)
        clear()
        return
      }
    }

    if (key.ctrl && ch === 'm' && messages.length > 0) {
      setCursorMode(true)
      enter()
    }
  }, { isActive: isInteractive })

  const visibleStreamText = stripTextToolCallMarkup(streamText, { stripIncomplete: true })
  const streamTextForDisplay = visibleStreamText

  const runningNode = isRunning ? (
    <Box flexDirection="column" marginBottom={1}>
      {!noFlickerActive && (fcActive || fcEvents.length > 0) && <FastContextBanner events={fcEvents} summary={fcSummary} isActive={fcActive} />}
      {!noFlickerActive && activeTask && <TaskProgressLine task={activeTask} />}
      <ActiveWorkPanel
        tools={noFlickerActive ? [] : currentTools}
        draft={noFlickerActive ? null : streamingToolDraft}
        streamText={streamTextForDisplay}
        outputTokens={currentTurnOutputTokens}
        lastActivity={lastActivity}
        runState={runState}
        queuedCount={queuedPrompts.length}
        verbose={verbose}
        idleLabel={!noFlickerActive && !visibleStreamText && currentTools.length === 0 && !fcActive && !pendingAsk ? 'Thinking...' : null}
      />
    </Box>
  ) : null

  const pendingAskNode = pendingAsk ? (
    <Box flexDirection="column" marginBottom={1}>
      {isPermissionAsk ? (
        <PermissionDialog
          key={pendingAsk.id}
          toolName={pendingAsk.toolName || (pendingAsk.command ? 'run_command' : 'tool')}
          description={pendingAsk.reason || pendingAsk.question}
          command={pendingAsk.command}
          path={pendingAsk.path}
          onDecision={(decision: PermissionDecision) => submitPermissionDecision(pendingAsk.id, decision)}
        />
      ) : (
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginY={1}>
          <Text bold>Confirmation needed</Text>
          <Text>{pendingAsk.question}</Text>
          {pendingAsk.reason && <Text dimColor>{pendingAsk.reason}</Text>}
          {pendingAsk.command && <Text>{pendingAsk.command}</Text>}
          {pendingAsk.options?.length ? <Text dimColor>{pendingAsk.options.join(' / ')}</Text> : null}
          <PromptInput
            value={askInput}
            onChange={setAskInput}
            onSubmit={submitAskResponse}
            mode={currentMode}
          />
        </Box>
      )}
    </Box>
  ) : null

  const handleRewind = useCallback((messageIndex: number) => {
    const targetMessage = messages[messageIndex]
    if (!targetMessage || targetMessage.role !== 'user') return

    const currentTurns = engine.getFullConversationTurns()
    const engineUserOrdinal = getEngineUserOrdinalForUiMessage(messages, currentTurns, messageIndex)
    const truncatedTurns = sliceTurnsBeforeNthUserTurn(currentTurns, engineUserOrdinal)

    pop()
    restoreCliStateFromTurns(truncatedTurns, targetMessage.content, getRewindContextSegments(truncatedTurns), [], truncatedTurns)
    convManager.scheduleSave()
  }, [messages, engine, pop, restoreCliStateFromTurns, getRewindContextSegments, convManager])

  const historyOverlay = activeOverlay === 'history' ? (
    <ConversationHistory
      key={convListRevision}
      conversations={getConversationEntries()}
      onSelect={(id) => {
        pop()
        const conv = convManager.switchTo(id)
        if (conv) {
          restoreCliStateFromTurns(
            conv.activeTurns ?? conv.turns,
            '',
            conv.contextSegments ?? [],
            conv.contextReservoir ?? [],
            conv.turns,
          )
        }
      }}
      onDelete={(id) => {
        convManager.delete(id)
        setConvListRevision(r => r + 1)
      }}
      onCancel={() => pop()}
    />
  ) : null

  const rewindOverlay = activeOverlay === 'rewind' ? (
    <RewindSelector
      messages={messages}
      onRewind={handleRewind}
      onCancel={() => pop()}
    />
  ) : null

  const modelOverlay = activeOverlay === 'modelPicker' ? (
    <ModelPicker
      currentModel={config.model}
      models={modelPresets}
      isRefreshing={modelDiscoveryStatus.isRefreshing}
      stale={modelDiscoveryStatus.stale}
      error={modelDiscoveryStatus.error}
      onRefresh={() => { void loadModelPresets(config, true) }}
      onSelect={(preset) => {
        pop()
        const newConfig = applyPreset(config, preset)
        persistConfig(newConfig)
        appendMessages([{ id: genMsgId(), role: 'system', content: `Model switched to ${preset.model}` }])
      }}
      onCancel={() => pop()}
    />
  ) : null

  const effortCapability = getModelReasoningCapabilities(config.model, config.provider, config.modelCapabilities)
  const effortOverlay = activeOverlay === 'effortPicker' && effortCapability ? (
    <EffortPicker
      model={config.model}
      capability={effortCapability}
      current={config.reasoning}
      onSelect={(selection: EffortSelection) => {
        pop()
        let newConfig = config
        if (selection.type === 'effort') {
          newConfig = setConfigValue(newConfig, 'reasoningEnabled', 'on')
          newConfig = setConfigValue(newConfig, 'reasoningEffort', selection.effort)
        } else if (selection.type === 'toggle') {
          newConfig = setConfigValue(newConfig, 'reasoningEnabled', selection.enabled ? 'on' : 'off')
        } else {
          newConfig = setConfigValue(newConfig, 'reasoningEnabled', 'on')
          newConfig = setConfigValue(newConfig, 'reasoningBudgetTokens', String(selection.budgetTokens))
        }
        persistConfig(newConfig)
        const value = formatNativeReasoningSetting(
          newConfig.model,
          newConfig.reasoning,
          newConfig.provider,
          newConfig.modelCapabilities,
        )
        appendMessages([{ id: genMsgId(), role: 'system', content: `Reasoning effort set to ${value || 'provider default'}` }])
      }}
      onCancel={() => pop()}
    />
  ) : null

  const overlayNode = historyOverlay ?? rewindOverlay ?? modelOverlay ?? effortOverlay
  const showPrompt = !singleShot && activeOverlay === null && !cursorMode && !pendingAsk
  const cursorPreviewMessage = cursorMode && !noFlickerActive && cursor ? messages[cursor.index] : undefined
  const cursorHint = cursorMode ? (
    <Box marginTop={1}>
      <Text dimColor>Message cursor: Up/Down navigate - Enter/Esc exit</Text>
    </Box>
  ) : null
  const cursorPreviewNode = cursorPreviewMessage ? (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`Selected message ${cursor!.index + 1}/${messages.length}`}</Text>
      <MessageList
        messages={[cursorPreviewMessage]}
        verbose={verbose}
        diffMaxRows={0}
        selectedIndex={0}
      />
    </Box>
  ) : null
  const promptNode = showPrompt ? (
    <Box flexDirection="column">
      {(isRunning || queuedPrompts.length > 0 || interruptHint || exitHint) && (
        <Box paddingLeft={1}>
          <Text dimColor>
            {interruptHint || exitHint || (isRunning
              ? `Enter guide current run · Ctrl/⌘+Enter queue next${queuedPrompts.length > 0 ? ` · ${queuedPrompts.length} queued` : ''}`
              : `${queuedPrompts.length} queued - will run after current agent turn`)}
          </Text>
        </Box>
      )}
      <PromptInput
        value={input}
        onChange={setComposedInput}
        onSubmit={handleSubmit}
        onAlternateSubmit={handleAlternateSubmit}
        onDoubleEsc={() => {
          if (messages.length > 0) push('rewind')
        }}
        onPasteImage={handlePasteImage}
        onPasteText={handlePasteText}
        mode={currentMode}
      />
    </Box>
  ) : null
  const transcriptHint = noFlickerActive && activeOverlay === null && isViewingHistory ? (
    <Box flexShrink={0}>
      <Text dimColor>
        {`HISTORY  ${normalizedScrollRows} rows below  PgDn: latest`}
      </Text>
    </Box>
  ) : null
  const transcriptNode = (
    <Box
      flexDirection="column"
      flexBasis={0}
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
    >
      {transcriptHint}
      <TranscriptViewport
        scrollRowsFromBottom={normalizedScrollRows}
        onScrollRowsChange={setScrollRowsFromBottom}
        onMetricsChange={handleTranscriptMetrics}
      >
        <MessageList
          messages={messages}
          verbose={verbose}
          diffMaxRows={0}
          selectedMessageId={selectedMessageId}
          selectedMessageRef={cursorMode ? selectedMessageRef : undefined}
        />
        {runningNode}
      </TranscriptViewport>
    </Box>
  )
  const staticTranscriptItems = useMemo<StaticTranscriptItem[]>(() => [
    { kind: 'header', id: 'startup-header' },
    ...messages.map(message => ({ kind: 'message' as const, id: message.id, message })),
  ], [messages])
  const mcpCount = mcpClient.getAllConnections().filter(connection => connection.status === 'connected').length
  const activeTerminalCount = terminalSessions.filter(session => session.status === 'running' || session.status === 'starting').length

  if (noFlickerActive) {
    return (
      <ThemeProvider>
        <CockpitRoot width={getSafeViewportWidth(terminal.columns)} height={terminal.rows}>
          <Box flexShrink={0}>
            <Header
              workspacePath={workspacePath}
              mood={mood}
              hasApiKey={!!config.apiKey}
              logoReveal={startupFrame.logoReveal}
              showVersion={startupFrame.showVersion}
              showWorkspace={startupFrame.showWorkspace}
            />
          </Box>

          <Box flexDirection="column" flexBasis={0} flexGrow={1} minHeight={0} overflow="hidden">
            <Box flexDirection="row" flexBasis={0} flexShrink={1} flexGrow={1} minHeight={0} overflow="hidden">
              {cockpit.showWorkRail && (
                <WorkRail
                  width={cockpit.workWidth}
                  isRunning={isRunning}
                  tools={currentTools}
                  draft={streamingToolDraft}
                  fastContextSummary={fcSummary}
                  fastContextActive={fcActive}
                  terminals={terminalSessions}
                  mcpCount={mcpCount}
                  visible={startupFrame.showRails}
                />
              )}
              <SessionPane running={isRunning} visible={startupFrame.showSession}>
                {overlayNode ?? (
                  <Box flexDirection="column" flexBasis={0} flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
                    {transcriptNode}
                    {pendingAskNode}
                  </Box>
                )}
              </SessionPane>
              {cockpit.showTaskRail && (
                <TaskRail
                  width={cockpit.taskWidth}
                  task={activeTask}
                  objective={activeObjective?.prompt}
                  objectiveStartedAt={activeObjective?.startedAt}
                  isRunning={isRunning}
                  visible={startupFrame.showRails}
                />
              )}
            </Box>
            <Box flexDirection="column" flexShrink={0}>
              {cursorHint}
              <AgentActivityLine active={isRunning || startupFrame.shimmerActive} persistent />
              {startupFrame.showPrompt ? promptNode : showPrompt ? <PromptPlaceholder /> : null}
              {startupFrame.showStatus ? (
                <StatusLine
                  config={config}
                  tokenUsage={tokenUsage}
                  mode={currentMode}
                  viewingHistory={isViewingHistory}
                  gitEnabled={gitEnabled}
                  mcpCount={mcpCount}
                  terminalCount={activeTerminalCount}
                />
              ) : <StatusPlaceholder />}
            </Box>
          </Box>
        </CockpitRoot>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <Static key={staticTranscriptRevision} items={staticTranscriptItems}>
        {item => (
          item.kind === 'header'
            ? (
              <Box key={item.id} flexDirection="column" paddingX={1}>
                <Header
                  workspacePath={workspacePath}
                  mood="idle"
                  hasApiKey={!!config.apiKey}
                />
              </Box>
            )
            : (
              <Box key={item.id} flexDirection="column" paddingX={1}>
                <MessageList
                  messages={[item.message]}
                  verbose={verbose}
                  diffMaxRows={MAX_INLINE_DIFF_RENDER_ROWS}
                />
              </Box>
            )
        )}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {/* Streaming / loading area */}
        {runningNode}

        {pendingAskNode}

        {/* Conversation history overlay */}
        {historyOverlay}

        {/* Rewind overlay */}
        {rewindOverlay}

        {/* Model picker overlay */}
        {modelOverlay}

        {/* Effort picker overlay */}
        {effortOverlay}

        {/* Input area */}
        {cursorHint}
        {cursorPreviewNode}
        {promptNode}
        <TerminalSessionsFooter sessions={terminalSessions} />
        {/* Status line at bottom */}
        <StatusLine config={config} tokenUsage={tokenUsage} mode={currentMode} viewingHistory={isViewingHistory} gitEnabled={gitEnabled} />
        <AgentActivityLine active={isRunning} />
      </Box>
    </ThemeProvider>
  )
}

export function startInkApp(options: {
  workspacePath: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker?: boolean
  approvalPolicy?: ApprovalPolicy
  mcpServers?: string[]
  startupAnimation?: boolean
}) {
  const workspaceName = options.workspacePath.split(/[\\/]/).pop() || 'workspace'
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const noFlicker = shouldUseNoFlicker(interactive, options.singleShot, options.noFlicker === true)
  render(
    <App
      workspacePath={options.workspacePath}
      workspaceName={workspaceName}
      config={options.config}
      singleShot={options.singleShot}
      verbose={options.verbose}
      noFlicker={noFlicker}
      approvalPolicy={options.approvalPolicy}
      mcpServers={options.mcpServers}
      startupAnimation={options.startupAnimation}
    />,
    {
      maxFps: noFlicker ? 24 : 18,
      incrementalRendering: noFlicker,
      interactive,
      alternateScreen: noFlicker,
      exitOnCtrlC: false,
    }
  )
}
