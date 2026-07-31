import React, { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react'
import { render, Box, Static, Text, useInput, useApp, useBoxMetrics, type DOMElement } from 'ink'
import { ThemeProvider, resolveBackground, useTheme } from '../theme/index'
import { Header } from './header/Header'
import { StatusLine } from './header/StatusLine'
import type { ToolStatus } from './tools/ToolCallTree'
import { ActiveWorkPanel } from './tools/ActiveWorkPanel'
import { ConversationHistory, type ConversationEntry } from './ConversationHistory'
import { RewindSelector } from './input/RewindSelector'
import { ModelPicker } from './input/ModelPicker'
import { EffortPicker, type EffortSelection } from './input/EffortPicker'
import { PermissionDialog, type PermissionDecision } from './permissions/PermissionDialog'
import { MessageList } from './messages/MessageList'
import { WindowedMessageList } from './messages/WindowedMessageList'
import { useOverlayStack } from '../hooks/useOverlayStack'
import { useMessageCursor } from '../hooks/useMessageCursor'
import type { SubAgentEvent } from '../../shared/subAgentTypes'
import type { AgentAttachment, AgentTurn, ApprovalPolicy, CapabilityProfile, ChangeSummary, TokenUsage } from '../../shared/agentTypes'
import type { TerminalSessionInfo } from '../../shared/terminalTypes'
import type { ContextReservoirEntry, ContextSegment } from '../../state/types'
import { type Message } from './messages/Messages'
import { PromptInput } from './input/PromptInput'
import { formatMarkdown, getMarkdownCacheStats } from './markdown/index'
import type { AgentEventType } from '../../core/agentEngine'
import type { GitIntegrationState } from '../../core/gitService'
import { createAgentRuntime } from '../../core/runtime/agentRuntime'
import type { ActiveTaskContext } from '../../core/taskManager'
import { applyPreset, saveConfig, setConfigValue, type ModelPreset, type TurboFluxConfig } from '../../core/config'
import { loadProfile } from '../../core/profile'
import { discoverModelPresets, readCachedModelDiscovery } from '../../core/modelDiscovery'
import { formatNativeReasoningSetting, getModelReasoningCapabilities } from '../../core/modelRegistry'
import { commandRegistry } from '../commands/index'
import type { CommandContext } from '../commands/types'
import { ConversationManager } from '../conversations/manager'
import type { ConversationInteractionState } from '../conversations/types'
import { AgentFlowController } from '../state/agentFlowController'
import { ApprovalPresentationScheduler } from '../state/approvalPresentationScheduler'
import { AdaptiveStreamScheduler } from '../state/adaptiveStreamScheduler'
import {
  selectInputReceipt,
  selectAgentRunState,
  selectAgentMode,
  selectActiveTask,
  selectIsForegroundBusy,
  selectPendingSteeringInputs,
  selectPrimaryActivity,
  selectQueueCount,
  selectQueuedInputs,
  selectRunningBackgroundCount,
  selectTokenUsage,
  selectToolDraft,
  type FlowInputReceipt,
} from '../state/flowSelectors'
import { LocalFlowTelemetry } from '../telemetry/localFlowTelemetry'
import { TerminalLatencyTracker } from '../telemetry/terminalLatencyTracker'
import { TerminalAttentionAdapter } from '../platform/terminalAttention'
import {
  isPersistenceRecoveryCommand,
  resolveFlowFeatureFlags,
} from '../state/flowFeatureFlags'
import {
  NotificationCoordinator,
  sanitizeTerminalTitle,
  type NotificationSnapshot,
} from '../state/notificationCoordinator'
import { globalConfigurationFingerprint, watchGlobalConfiguration, type GlobalConfigurationSnapshot } from '../globalConfiguration'
import { createTranslator, I18nProvider, useI18n, type Translator } from '../i18n/index'
import type { MascotMood } from './header/Mascot'
import { stripTextToolCallMarkup } from '../../shared/toolCallMarkup'
import { useTerminalSize } from '../hooks/useTerminalSize'
import { getSafeViewportWidth } from '../terminalLayout'
import { TerminalSessionsFooter } from './tools/TerminalSessionsFooter'
import { AgentActivityLine } from './tools/AgentActivityLine'
import { QueuedPromptList } from './tools/QueuedPromptList'
import { beginToolCall, settleToolCall } from './tools/toolLifecycleModel'
import { resolveCockpitLayout } from './layout/CockpitRails'
import { SessionSidebar } from './layout/SessionSidebar'
import { LandingView } from './layout/LandingView'
import { getStartupAnimationFrame, shouldAnimateStartup, STARTUP_ANIMATION_MS } from './layout/StartupAnimation'
import type { DeveloperSubAgentActivity } from './developerFlowModel'
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
import {
  createThinkingTrace,
  estimateOutputTokensForDisplay,
  formatElapsed,
  formatTaskProgressLabel,
  formatTaskToolName,
  formatTaskToolSummary,
  getEngineUserOrdinalForUiMessage,
  isProvisionalAssistantTurn,
  isThinkingToggleShortcut,
  resolveAssistantStreamDisplay,
  resolveLandingFrameWidth,
  serializeToolArgsForUi,
  selectAutoMountedModel,
  shouldUseFlowUi,
  shouldUseNoFlicker,
  shouldShowLandingView,
  sliceTurnsBeforeNthUserTurn,
  turnsToMessages,
} from './appHelpers'

export {
  createThinkingTrace,
  formatTaskProgressLabel,
  formatTaskToolSummary,
  getEngineUserOrdinalForUiMessage,
  isProvisionalAssistantTurn,
  isThinkingToggleShortcut,
  resolveAssistantStreamDisplay,
  resolveLandingFrameWidth,
  selectAutoMountedModel,
  shouldUseFlowUi,
  shouldShowLandingView,
  shouldUseNoFlicker,
  sliceTurnsBeforeNthUserTurn,
  turnsToMessages,
} from './appHelpers'

interface AppProps {
  workspacePath: string
  workspaceName: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker: boolean
  approvalPolicy?: ApprovalPolicy
  capabilityProfile?: CapabilityProfile
  mcpServers?: string[]
  startupAnimation?: boolean
  transparentBackground?: boolean
  flowTelemetry?: LocalFlowTelemetry
  terminalLatencyTracker?: TerminalLatencyTracker
}

type StaticTranscriptItem =
  | { kind: 'header'; id: string }
  | { kind: 'message'; id: string; message: Message }

type PendingAsk = {
  id: string
  question: string
  options?: string[]
  reason?: string
  command?: string
  toolName?: string
  path?: string
}

function describeFlowInputReceipt(receipt: FlowInputReceipt, t: Translator): string {
  switch (receipt.kind) {
    case 'pending':
      return receipt.intent === 'steer'
        ? t('ui.flow.input.steeringPending')
        : t('ui.flow.input.pending')
    case 'steering':
      return t('ui.flow.input.steering')
    case 'queued':
      return t('ui.flow.input.queued', { count: receipt.queueCount })
    case 'committed':
      return receipt.intent === 'steer'
        ? t('ui.flow.input.steered')
        : t('ui.flow.input.committed')
    case 'restored':
      return t('ui.flow.input.restored')
  }
}

function describeSubAgentEvent(event: SubAgentEvent, t: Translator): string {
  if (event.type === 'turn_start') return t('ui.subagent.turn', { turn: event.turn, maxTurns: event.maxTurns })
  if (event.type === 'model_wait') return t('ui.subagent.waitingModel', { seconds: Math.floor(event.elapsedMs / 1000) })
  if (event.type === 'model_retry') return t('ui.subagent.retry', { attempt: event.attempt, reason: event.reason.slice(0, 72) })
  if (event.type === 'tool_call') return event.tool
  if (event.type === 'tool_result') return event.summary.slice(0, 90)
  if (event.type === 'evidence') return event.evidence.path
  if (event.type === 'final') return t('ui.subagent.finalizing')
  if (event.type === 'error') return event.message.slice(0, 90)
  return t('ui.subagent.turnComplete', { turn: event.turn })
}

function SubAgentProgressLine({ activities }: { activities: DeveloperSubAgentActivity[] }) {
  const theme = useTheme()
  const { t } = useI18n()
  if (activities.length === 0) return null
  return (
    <Box flexDirection="column">
      {activities.slice(-3).map(activity => (
        <Box key={activity.id}>
          <Text color={activity.status === 'failed' ? theme.error : activity.status === 'completed' ? theme.success : theme.brand}>
            {activity.status === 'failed' ? '! ' : activity.status === 'completed' ? '✓ ' : '● '}
          </Text>
          <Text>{activity.label}</Text>
          <Text dimColor>{activity.status === 'running'
            ? ` · ${activity.detail || activity.objective} · ${formatElapsed(Date.now() - activity.startedAt)}`
            : activity.status === 'completed' ? ` · ${t('ui.subagent.resultReady')}` : ` · ${t('common.failed')}`}</Text>
        </Box>
      ))}
    </Box>
  )
}

function TaskProgressLine({ task }: { task: ActiveTaskContext }) {
  const { t } = useI18n()
  const completed = task.toolCalls.filter(call =>
    call.status === 'completed' || call.status === 'error' || call.status === 'cancelled'
  ).length
  const total = task.toolCalls.length
  const errored = task.toolCalls.filter(call => call.status === 'error').length
  const running = task.toolCalls.filter(call => call.status === 'running').length
  const latest = [...task.toolCalls].reverse().find(call => call.status === 'running') ?? task.toolCalls[task.toolCalls.length - 1]
  const toolSummary = formatTaskToolSummary(completed, total, running, errored, t)
  const elapsed = formatElapsed(Date.now() - task.startedAt)
  const progress = formatTaskProgressLabel(task.progress, t)
  return (
    <Box>
      <Text dimColor>{t('ui.task.label')} </Text>
      <Text>{task.title}</Text>
      <Text dimColor>{` - ${toolSummary}`}</Text>
      {latest && <Text dimColor>{` - ${formatTaskToolName(latest.toolName, t)}`}</Text>}
      <Text dimColor>{` - ${elapsed}`}</Text>
      {progress && <Text dimColor>{` - ${progress}`}</Text>}
    </Box>
  )
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
      backgroundColor={resolveBackground(theme, 'background')}
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
      backgroundColor={resolveBackground(theme, 'background')}
      overflow="hidden"
    >
      {visible && <Box flexShrink={0} backgroundColor={resolveBackground(theme, 'panelRaised')} paddingX={1} justifyContent="space-between">
        <Text color={theme.brand} bold>{visible ? 'SESSION' : ' '}</Text>
        <Text color={running ? theme.brandShimmer : theme.success} bold>{visible ? running ? '● RUNNING' : '● READY' : ' '}</Text>
      </Box>}
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

function App({ workspacePath, workspaceName, config: initialConfig, singleShot, verbose, noFlicker, approvalPolicy, capabilityProfile, mcpServers, startupAnimation = true, transparentBackground = false, flowTelemetry: providedFlowTelemetry, terminalLatencyTracker: providedTerminalLatencyTracker }: AppProps) {
  const { exit } = useApp()
  const layoutBackground = transparentBackground ? undefined : '#000000'
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const terminal = useTerminalSize()
  const noFlickerActive = noFlicker && isInteractive && !singleShot
  const [flowFeatures] = useState(() => resolveFlowFeatureFlags())
  const flowUiEnabled = flowFeatures.flowUi
  const startupAnimationEnabled = shouldAnimateStartup(isInteractive, singleShot, startupAnimation && noFlickerActive)
  const startupStartedAtRef = useRef(Date.now())
  const [startupElapsed, setStartupElapsed] = useState(startupAnimationEnabled ? 0 : STARTUP_ANIMATION_MS)
  const startupFrame = getStartupAnimationFrame(startupElapsed)
  const [config, setConfig] = useState(initialConfig)
  const [profile, setProfile] = useState(loadProfile)
  const t = useMemo(() => createTranslator(profile.interfaceLanguage), [profile.interfaceLanguage])
  const [messages, setMessages] = useState<Message[]>([])
  const [staticTranscriptRevision, setStaticTranscriptRevision] = useState(0)
  const [input, setInput] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<AgentAttachment[]>([])
  const [streamText, setStreamText] = useState('')
  const [streamThinkingText, setStreamThinkingText] = useState('')
  const [streamThinkingStartedAt, setStreamThinkingStartedAt] = useState<number | undefined>()
  const [showThinking, setShowThinking] = useState(false)
  const [showToolDetails, setShowToolDetails] = useState(verbose)
  const [currentTurnOutputTokens, setCurrentTurnOutputTokens] = useState(0)
  const [currentTools, setCurrentTools] = useState<ToolStatus[]>([])
  const [mood, setMood] = useState<MascotMood>('idle')
  const [gitState, setGitState] = useState<GitIntegrationState>(() => ({
    enabled: initialConfig.gitEnabled !== false,
    phase: initialConfig.gitEnabled === false ? 'disabled' : 'detecting',
    snapshot: null,
    updatedAt: Date.now(),
  }))
  const [modelPresets, setModelPresets] = useState<ModelPreset[]>([])
  const [modelDiscoveryStatus, setModelDiscoveryStatus] = useState({
    isRefreshing: false,
    stale: false,
    error: undefined as string | undefined,
  })
  const modelDiscoveryRequestRef = useRef(0)
  const [lastActivity, setLastActivity] = useState<number>(Date.now())
  const [convListRevision, setConvListRevision] = useState(0)
  const [subAgentActivities, setSubAgentActivities] = useState<DeveloperSubAgentActivity[]>([])
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([])
  const [, setChangeSummaries] = useState<ChangeSummary[]>([])
  const [interruptHint, setInterruptHint] = useState<string | null>(null)
  const [exitHint, setExitHint] = useState<string | null>(null)
  const [runControlHint, setRunControlHint] = useState<string | null>(null)
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null)
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null)
  const [askModalVisible, setAskModalVisible] = useState(false)
  const [askInput, setAskInput] = useState('')
  const [approvalPresentationScheduler] = useState(() => new ApprovalPresentationScheduler())
  const [notificationCoordinator] = useState(() => new NotificationCoordinator(Date.now, flowFeatures.notifications))
  const [terminalAttention] = useState(() => new TerminalAttentionAdapter({
    enabled: flowFeatures.notifications,
    interactive: isInteractive,
  }))
  const [flowTelemetry] = useState(() => providedFlowTelemetry ?? new LocalFlowTelemetry(workspacePath))
  const [terminalLatencyTracker] = useState(() => providedTerminalLatencyTracker ?? new TerminalLatencyTracker(
    (metric, value) => flowTelemetry.observe(metric, value),
  ))
  const [notificationSnapshot, setNotificationSnapshot] = useState<NotificationSnapshot>(() =>
    notificationCoordinator.getSnapshot(),
  )
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
  const streamThinkingBufferRef = useRef('')
  const streamThinkingStartedAtRef = useRef<number | undefined>(undefined)
  const streamTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAssistantTurnInterruptedRef = useRef(false)
  const lastActivityPaintRef = useRef(0)
  const inputRef = useRef('')
  const draftAttachmentsRef = useRef<AgentAttachment[]>([])
  const pendingAskRef = useRef<PendingAsk | null>(null)
  const activePromptRef = useRef<{ prompt: string; messageId: string; responseStarted: boolean; attachments?: AgentAttachment[]; priorTurns: AgentTurn[] } | null>(null)
  const abortingRef = useRef(false)
  const abortRestoredPromptRef = useRef(false)
  const runPromptRef = useRef<((prompt: string, attachments?: AgentAttachment[], messageId?: string) => Promise<void>) | null>(null)
  const exitPressRef = useRef(0)
  const lastCtrlCEventAtRef = useRef(0)
  const runControlHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleInterruptRef = useRef<() => void>(() => {})
  const lastClipboardImageRef = useRef<{ fingerprint: string; at: number } | null>(null)
  const globalConfigurationFingerprintRef = useRef(globalConfigurationFingerprint({ config: initialConfig, profile }))
  const pendingGlobalConfigurationRef = useRef<GlobalConfigurationSnapshot | null>(null)
  const promptHistoryRef = useRef<string[]>([])
  const [streamScheduler] = useState(() => new AdaptiveStreamScheduler(batch => {
    setStreamText(streamBufferRef.current)
    setStreamThinkingText(streamThinkingBufferRef.current)
    setCurrentTurnOutputTokens(previous => Math.max(
      previous,
      estimateOutputTokensForDisplay(streamBufferRef.current),
    ))
    flowTelemetry.count('ui.stream_flush')
    flowTelemetry.observe('ui.stream_batch_depth', batch.depth)
    flowTelemetry.observe('ui.stream_oldest_age_ms', batch.oldestAgeMs)
  }))
  const genMsgId = useCallback(() => {
    messageIdRef.current += 1
    return `msg-${messageIdRef.current}`
  }, [])

  // Refs to avoid stale closures in the engine event subscription (effect runs once)
  const currentToolsRef = useRef<ToolStatus[]>([])
  const changeSummariesRef = useRef<ChangeSummary[]>([])
  const updateCurrentTools = useCallback((update: (current: ToolStatus[]) => ToolStatus[]) => {
    const next = update(currentToolsRef.current)
    currentToolsRef.current = next
    setCurrentTools(next)
  }, [])
  const updateChangeSummaries = useCallback((update: (current: ChangeSummary[]) => ChangeSummary[]) => {
    const next = update(changeSummariesRef.current)
    changeSummariesRef.current = next
    setChangeSummaries(next)
  }, [])
  useEffect(() => { draftAttachmentsRef.current = draftAttachments }, [draftAttachments])

  const [runtime] = useState(() => createAgentRuntime({
    workspacePath,
    workspaceName,
    config: initialConfig,
    profile,
    conversationPrefix: 'cli',
    approvalPolicy,
    capabilityProfile,
    connectMcp: Boolean(mcpServers?.length),
    mcpServers,
    registerSkills: skillRuntime => commandRegistry.registerSkills(skillRuntime),
  }))
  const { engine, stateProvider, skillRuntime, mcpClient } = runtime
  const terminalPollingActive = terminalSessions.some(session => session.status === 'running' || session.status === 'starting')
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const result = await runtime.toolExecutor.ptyList?.()
      if (!cancelled && result?.success) {
        setTerminalSessions((result.sessions || result.data || []) as TerminalSessionInfo[])
      }
    }
    void refresh()
    if (!terminalPollingActive) return () => { cancelled = true }
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [runtime.toolExecutor, terminalPollingActive])
  const [flowBridge] = useState(() => new AgentFlowController(runtime.sessionRegistry.getCurrentId()))
  const [convManager] = useState(() => new ConversationManager(engine, config, workspacePath, error => {
    setPersistenceWarning(error ? t('ui.app.persistenceUnavailable', { message: error.message }) : null)
    flowBridge.setPersistenceStatus(error)
  }, runtime.sessionRegistry, { batchJournalStreaming: flowFeatures.journalBatching }))
  const flowSnapshot = useSyncExternalStore(
    flowBridge.store.subscribe,
    flowBridge.store.getSnapshot,
    flowBridge.store.getSnapshot,
  )
  const [flowPresentationNow, setFlowPresentationNow] = useState(Date.now)
  const activeFlowState = flowSnapshot.activeThreadId
    ? flowSnapshot.threads[flowSnapshot.activeThreadId]
    : undefined
  const isRunning = activeFlowState ? selectIsForegroundBusy(activeFlowState) : false
  const runState = activeFlowState
    ? selectAgentRunState(activeFlowState)
    : { phase: 'idle' as const, updatedAt: 0 }
  const currentMode = activeFlowState ? selectAgentMode(activeFlowState) : 'vibe'
  const tokenUsage = activeFlowState ? selectTokenUsage(activeFlowState) : { source: 'unknown' as const }
  const activeTask = activeFlowState ? selectActiveTask(activeFlowState) : null
  const streamingToolDraft = activeFlowState ? selectToolDraft(activeFlowState) : null
  const activeObjective = activeFlowState?.run.objective && activeFlowState.run.startedAt
    ? { prompt: activeFlowState.run.objective, startedAt: activeFlowState.run.startedAt }
    : null
  const queuedPrompts = useMemo(
    () => activeFlowState ? selectQueuedInputs(activeFlowState) : [],
    [activeFlowState?.inputQueue, activeFlowState?.inputs],
  )
  const pendingSteeringPrompts = useMemo(
    () => activeFlowState ? selectPendingSteeringInputs(activeFlowState) : [],
    [activeFlowState?.inputs],
  )
  const primaryFlowActivity = flowUiEnabled && activeFlowState ? selectPrimaryActivity(activeFlowState) : undefined
  const flowIsRunning = isRunning
  const flowQueueCount = activeFlowState ? selectQueueCount(activeFlowState) : 0
  const flowBackgroundCount = flowUiEnabled && activeFlowState ? selectRunningBackgroundCount(activeFlowState) : 0
  const flowInputReceipt = flowUiEnabled && activeFlowState
    ? selectInputReceipt(activeFlowState, flowPresentationNow)
    : null

  useEffect(() => {
    if (!flowInputReceipt?.expiresAt) return
    const remaining = flowInputReceipt.expiresAt - Date.now()
    if (remaining <= 0) {
      setFlowPresentationNow(Date.now())
      return
    }
    const timer = setTimeout(() => setFlowPresentationNow(Date.now()), remaining + 1)
    return () => clearTimeout(timer)
  }, [flowInputReceipt?.expiresAt, flowSnapshot.revision])

  useEffect(() => {
    convManager.recordQueueState(queuedPrompts)
  }, [convManager, queuedPrompts])

  useEffect(() => {
    convManager.recordDraftState({ text: input, attachments: draftAttachments })
    flowBridge.draftChanged(input, draftAttachments.map(attachment => attachment.id))
  }, [convManager, flowBridge, input, draftAttachments])

  useEffect(() => runtime.sessionRegistry.subscribe(({ currentId }) => {
    flowBridge.activateThread(currentId)
  }), [runtime.sessionRegistry, flowBridge])

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

  const persistConfig = useCallback((nextConfig: TurboFluxConfig) => {
    const savedConfig = saveConfig(nextConfig)
    runtime.applyConfiguration(savedConfig, { profile, approvalPolicy, capabilityProfile })
    convManager.updateConfig(savedConfig)
    setConfig(savedConfig)
    globalConfigurationFingerprintRef.current = globalConfigurationFingerprint({ config: savedConfig, profile })
  }, [runtime, profile, approvalPolicy, capabilityProfile, convManager])

  const clearStreamFlushTimer = useCallback(() => {
    streamScheduler.cancel()
    if (streamTransitionTimerRef.current) {
      clearTimeout(streamTransitionTimerRef.current)
      streamTransitionTimerRef.current = null
    }
  }, [streamScheduler])

  const markActivity = useCallback((timestamp = Date.now()) => {
    if (timestamp - lastActivityPaintRef.current < 80) return
    lastActivityPaintRef.current = timestamp
    setLastActivity(timestamp)
  }, [])

  const showRunControlHint = useCallback((message: string) => {
    if (runControlHintTimerRef.current) clearTimeout(runControlHintTimerRef.current)
    setRunControlHint(message)
    runControlHintTimerRef.current = setTimeout(() => {
      runControlHintTimerRef.current = null
      setRunControlHint(null)
    }, 1800)
  }, [])

  const syncNotificationSnapshot = useCallback(() => {
    setNotificationSnapshot(notificationCoordinator.getSnapshot())
  }, [notificationCoordinator])

  const dismissPendingAsk = useCallback((requestId?: string) => {
    const current = pendingAskRef.current
    approvalPresentationScheduler.cancel(requestId)
    if (!current || (requestId !== undefined && current.id !== requestId)) return false
    pendingAskRef.current = null
    setPendingAsk(null)
    setAskModalVisible(false)
    setAskInput('')
    notificationCoordinator.acknowledgeSource('action-required', current.id)
    syncNotificationSnapshot()
    return true
  }, [approvalPresentationScheduler, notificationCoordinator, syncNotificationSnapshot])

  const schedulePendingAsk = useCallback((ask: PendingAsk) => {
    const requestedAt = Date.now()
    pendingAskRef.current = ask
    setPendingAsk(ask)
    setAskModalVisible(false)
    setAskInput('')
    notificationCoordinator.raise({
      id: `approval:${ask.id}`,
      category: 'action-required',
      title: ask.options?.includes('allow-once') ? t('ui.app.reviewRequired') : t('ui.app.inputRequired'),
      detail: ask.toolName || ask.reason,
      sourceId: ask.id,
    })
    flowTelemetry.count('ui.approval_requested')
    syncNotificationSnapshot()
    approvalPresentationScheduler.request(ask.id, () => {
      if (pendingAskRef.current?.id === ask.id) {
        flowBridge.presentApproval(ask.id)
        flowTelemetry.observe('ui.approval_presented_ms', Date.now() - requestedAt)
        setAskModalVisible(true)
      }
    }, requestedAt)
  }, [approvalPresentationScheduler, flowBridge, flowTelemetry, notificationCoordinator, syncNotificationSnapshot, t])

  const noteComposerActivity = useCallback(() => {
    flowTelemetry.count('ui.key_received')
    terminalAttention.noteUserActivity()
    approvalPresentationScheduler.noteComposerActivity()
    streamScheduler.noteInput()
  }, [approvalPresentationScheduler, flowTelemetry, streamScheduler, terminalAttention])

  const noteInputMutation = useCallback(() => {
    terminalLatencyTracker.noteKeyReceived()
  }, [terminalLatencyTracker])

  const clearResultInbox = useCallback(() => {
    const cleared = notificationCoordinator.acknowledgeCategory('result-ready')
    if (cleared > 0) {
      setSubAgentActivities(current => current.filter(activity => activity.status === 'running'))
      syncNotificationSnapshot()
    }
    return cleared
  }, [notificationCoordinator, syncNotificationSnapshot])

  useEffect(() => {
    if (!isInteractive || !flowFeatures.notifications) return
    const title = sanitizeTerminalTitle(notificationSnapshot.terminalTitle)
    process.stdout.write(`\u001b]0;${title}\u0007`)
  }, [isInteractive, notificationSnapshot.terminalTitle, flowFeatures.notifications])

  useEffect(() => {
    terminalAttention.start()
    return () => terminalAttention.stop()
  }, [terminalAttention])

  useEffect(() => {
    if (notificationSnapshot.active) terminalAttention.notify(notificationSnapshot.active)
  }, [notificationSnapshot.active, terminalAttention])

  useEffect(() => () => {
    approvalPresentationScheduler.destroy()
    const markdownStats = getMarkdownCacheStats()
    flowTelemetry.observe('ui.markdown_cache_hit_rate', markdownStats.hitRate * 100)
    const journalStats = convManager.getJournalStats()
    flowTelemetry.count('journal.physical_writes', journalStats.physicalWrites)
    flowTelemetry.count('journal.streaming_batches', journalStats.streamingBatchesWritten)
    const reducerViolations = Object.values(flowBridge.store.getSnapshot().threads)
      .reduce((count, thread) => count + thread.violations.length, 0)
    if (reducerViolations > 0) flowTelemetry.count('flow.reducer_violation', reducerViolations)
    flowTelemetry.destroy()
    if (isInteractive) process.stdout.write('\u001b]0;\u0007')
  }, [approvalPresentationScheduler, convManager, flowBridge, flowTelemetry, isInteractive])

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
    flowBridge.updateUsage(engine.getContextUsage())
    setGitState(engine.getGitState())
    updateCurrentTools(() => [])
    updateChangeSummaries(() => [])
    setCurrentTurnOutputTokens(0)
    streamBufferRef.current = ''
    streamThinkingBufferRef.current = ''
    streamThinkingStartedAtRef.current = undefined
    setStreamThinkingStartedAt(undefined)
    clearStreamFlushTimer()
    setStreamText('')
    setStreamThinkingText('')
    setTerminalSessions([])
    dismissPendingAsk()
    flowBridge.replaceQueue([])
    activePromptRef.current = null
    abortingRef.current = false
    setInterruptHint(null)
    setExitHint(null)
    setRunControlHint(null)
    setCursorMode(false)
    clear()
    setMood('idle')
  }, [engine, stateProvider, clearStreamFlushTimer, clear, replaceMessages, dismissPendingAsk, flowBridge])

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
    runtime.applyConfiguration(config, { profile, approvalPolicy, capabilityProfile })
    convManager.updateConfig(config)
  }, [runtime, convManager, config, profile, approvalPolicy, capabilityProfile])

  const applyGlobalConfiguration = useCallback((snapshot: GlobalConfigurationSnapshot) => {
    const fingerprint = globalConfigurationFingerprint(snapshot)
    if (fingerprint === globalConfigurationFingerprintRef.current) return
    globalConfigurationFingerprintRef.current = fingerprint
    pendingGlobalConfigurationRef.current = null
    runtime.applyConfiguration(snapshot.config, { profile: snapshot.profile, approvalPolicy, capabilityProfile })
    convManager.updateConfig(snapshot.config)
    setConfig(snapshot.config)
    setProfile(snapshot.profile)
    setGitState(engine.getGitState())
    const nextT = createTranslator(snapshot.profile.interfaceLanguage)
    appendMessages([{
      id: genMsgId(),
      role: 'system',
      content: nextT('ui.app.globalReloaded', {
        provider: snapshot.config.provider,
        model: snapshot.config.model || nextT('common.notSet'),
        persona: snapshot.profile.defaultPersonaId,
      }),
    }], { forceLatest: true })
  }, [runtime, approvalPolicy, capabilityProfile, convManager, engine, appendMessages, genMsgId])

  useEffect(() => {
    const accept = (snapshot: GlobalConfigurationSnapshot) => {
      const fingerprint = globalConfigurationFingerprint(snapshot)
      if (fingerprint === globalConfigurationFingerprintRef.current) return
      if (engine.isRunning()) {
        pendingGlobalConfigurationRef.current = snapshot
        showRunControlHint(t('ui.app.globalPending'))
        return
      }
      applyGlobalConfiguration(snapshot)
    }
    const stopWatching = watchGlobalConfiguration(accept, {
      onError: error => showRunControlHint(t('ui.app.globalReloadFailed', { message: error.message })),
    })
    const pendingTimer = setInterval(() => {
      const pending = pendingGlobalConfigurationRef.current
      if (pending && !engine.isRunning()) applyGlobalConfiguration(pending)
    }, 250)
    return () => {
      stopWatching()
      clearInterval(pendingTimer)
    }
  }, [engine, applyGlobalConfiguration, showRunControlHint, t])

  const loadModelPresets = useCallback(async (targetConfig: TurboFluxConfig, force = false) => {
    const requestId = ++modelDiscoveryRequestRef.current
    setModelDiscoveryStatus(current => ({ ...current, isRefreshing: true, error: force ? undefined : current.error }))
    const result = await discoverModelPresets(targetConfig, { force })
    if (requestId !== modelDiscoveryRequestRef.current) return
    setModelPresets(result.models)
    setModelDiscoveryStatus({ isRefreshing: false, stale: result.stale, error: result.error })
    const firstDiscovered = selectAutoMountedModel(targetConfig.model, result.source, result.models)
    if (!targetConfig.model && firstDiscovered) {
      persistConfig(applyPreset(targetConfig, firstDiscovered))
      showRunControlHint(t('ui.app.modelMounted', { model: firstDiscovered.model }))
    }
  }, [persistConfig, showRunControlHint, t])

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
    engine.setEventRecorder(event => convManager.recordEvent(event))
    const unsub = engine.subscribe((event: AgentEventType) => {
      flowBridge.handle(event)
      switch (event.type) {
        case 'run:state':
          setLastActivity(event.state.updatedAt)
          if (event.state.phase === 'awaiting_approval' || event.state.phase === 'awaiting_input') setMood('thinking')
          break
        case 'input:state':
          if (event.state === 'committed') {
            appendMessages([{ id: event.inputId, role: 'user', content: event.text }], { forceLatest: true })
            setLastActivity(Date.now())
          } else if (event.state === 'rejected') {
            replaceMessages(previous => previous.filter(message => message.id !== event.inputId))
            setComposedInput(current => current.trim()
              ? `${current}\n\n${event.text}`
              : event.text)
            showRunControlHint(event.reason || t('ui.app.guidanceRestored'))
          }
          break
        case 'turn:complete': {
          if (event.turn.role !== 'assistant') break
          const interrupted = event.turn.metadata?.interrupted === true
          lastAssistantTurnInterruptedRef.current = interrupted
          if (isProvisionalAssistantTurn(event.turn)) {
            clearStreamFlushTimer()
            setStreamText('')
            setStreamThinkingText('')
            setMood('thinking')
            break
          }
          const toolsSnapshot = currentToolsRef.current
          const changesSnapshot = changeSummariesRef.current
          const visibleText = stripTextToolCallMarkup(event.turn.content, { stripIncomplete: true })
          const thinking = event.turn.metadata?.thinking
            ? {
                ...event.turn.metadata.thinking,
                ...(event.turn.metadata.reasoningEffort ? { effort: event.turn.metadata.reasoningEffort } : {}),
              }
            : undefined
          if (visibleText || toolsSnapshot.length > 0 || changesSnapshot.length > 0 || thinking) {
            appendMessages([{
              id: event.turn.id,
              role: 'assistant',
              content: visibleText,
              tools: [...toolsSnapshot],
              changes: [...changesSnapshot],
              interrupted,
              thinking,
            }], { forceLatest: true })
          }
          updateCurrentTools(() => [])
          updateChangeSummaries(() => [])
          setMood(interrupted ? 'idle' : 'thinking')
          break
        }
        case 'stream:start': {
          const streamStartedAt = Date.now()
          setCurrentTurnOutputTokens(0)
          streamBufferRef.current = ''
          streamThinkingBufferRef.current = ''
          streamThinkingStartedAtRef.current = streamStartedAt
          setStreamThinkingStartedAt(streamStartedAt)
          setStreamThinkingText('')
          setStreamText('')
          clearStreamFlushTimer()
          break
        }
        case 'stream:delta':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          streamBufferRef.current += event.text
          terminalLatencyTracker.noteDeltaReceived()
          if (flowFeatures.streamScheduler) {
            streamScheduler.enqueue(Buffer.byteLength(event.text, 'utf8'))
          } else {
            setStreamText(streamBufferRef.current)
            setCurrentTurnOutputTokens(previous => Math.max(
              previous,
              estimateOutputTokensForDisplay(streamBufferRef.current),
            ))
          }
          markActivity()
          break
        case 'stream:thinking_delta':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          if (!streamThinkingStartedAtRef.current) {
            const thinkingStartedAt = Date.now()
            streamThinkingStartedAtRef.current = thinkingStartedAt
            setStreamThinkingStartedAt(thinkingStartedAt)
          }
          streamThinkingBufferRef.current += event.text
          terminalLatencyTracker.noteDeltaReceived()
          if (flowFeatures.streamScheduler) {
            streamScheduler.enqueue(Buffer.byteLength(event.text, 'utf8'))
          } else {
            setStreamThinkingText(streamThinkingBufferRef.current)
          }
          markActivity()
          break
        case 'stream:usage':
          if (typeof event.usage.output === 'number') {
            setCurrentTurnOutputTokens(previous => Math.max(previous, event.usage.output ?? 0))
          }
          break
        case 'stream:end': {
          clearStreamFlushTimer()
          const bufferedStreamText = streamBufferRef.current
          const bufferedThinkingText = streamThinkingBufferRef.current
          const thinkingStartedAt = streamThinkingStartedAtRef.current
          streamBufferRef.current = ''
          streamThinkingBufferRef.current = ''
          streamThinkingStartedAtRef.current = undefined
          setStreamThinkingStartedAt(undefined)
          const display = resolveAssistantStreamDisplay(
            stripTextToolCallMarkup(bufferedStreamText, { stripIncomplete: true }),
            bufferedThinkingText,
            currentToolsRef.current.length > 0 || changeSummariesRef.current.length > 0,
            event.interrupted === true,
          )
          void thinkingStartedAt
          if (display.visibleText || display.thinkingText) {
            setStreamText(display.visibleText)
            setStreamThinkingText(display.thinkingText)
          }
          if (noFlickerActive) {
            setStreamText('')
            setStreamThinkingText('')
          } else {
            streamTransitionTimerRef.current = setTimeout(() => {
              streamTransitionTimerRef.current = null
              setStreamText('')
              setStreamThinkingText('')
            }, 120)
          }
          setCurrentTurnOutputTokens(0)
          setMood(event.interrupted ? 'idle' : 'thinking')
          flowBridge.updateUsage(engine.getContextUsage())
          break
        }
        case 'session:complete': {
          const interrupted = lastAssistantTurnInterruptedRef.current || abortingRef.current
          setMood(interrupted ? 'idle' : 'happy')
          if (!interrupted) {
            notificationCoordinator.acknowledgeCategory('turn-complete')
            notificationCoordinator.raise({
              id: `turn-complete:${Date.now()}`,
              category: 'turn-complete',
              title: t('ui.app.agentTurnComplete'),
              sourceId: 'foreground-run',
            })
            syncNotificationSnapshot()
            setTimeout(() => setMood('idle'), 3000)
          }
          break
        }
        case 'tool:call':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          updateCurrentTools(previous => beginToolCall(previous, {
            id: event.toolCall.id,
            name: event.toolCall.name,
            args: serializeToolArgsForUi(event.toolCall.arguments),
            startedAt: Date.now(),
          }))
          markActivity()
          break
        case 'stream:tool_call_delta':
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          markActivity()
          break
        case 'tool:result':
          updateCurrentTools(previous => settleToolCall(previous, {
            id: event.toolResult.toolCallId,
            name: event.toolResult.name,
            status: event.toolResult.isError ? 'error' : 'done',
            output: event.toolResult.output?.slice(0, 200),
            settledAt: Date.now(),
          }))
          if (event.toolResult.changeSummary) {
            updateChangeSummaries(previous => [...previous, event.toolResult.changeSummary!])
          }
          markActivity()
          break
        case 'subagent:start':
          setSubAgentActivities(current => [
            ...current.filter(activity => activity.id !== event.agentId),
            {
              id: event.agentId,
              label: event.label,
              objective: event.objective,
              detail: t('ui.subagent.starting'),
              startedAt: Date.now(),
              status: 'running',
            },
          ])
          break
        case 'subagent:progress':
          setSubAgentActivities(current => current.map(activity => activity.id === event.agentId
            ? { ...activity, detail: describeSubAgentEvent(event.event, t), status: 'running' }
            : activity))
          break
        case 'subagent:end':
          setSubAgentActivities(current => current.map(activity => activity.id === event.agentId
            ? {
                ...activity,
                status: event.ok ? 'completed' : 'failed',
                completedAt: Date.now(),
                detail: event.ok ? t('ui.subagent.resultReady') : t('common.failed'),
              }
            : activity))
          notificationCoordinator.raise({
            id: `subagent-result:${event.agentId}`,
            category: event.ok ? 'result-ready' : 'error',
            title: event.ok
              ? t('ui.app.subagentResultReady', { agent: event.agentType })
              : t('ui.app.subagentFailed', { agent: event.agentType }),
            sourceId: event.agentId,
          })
          syncNotificationSnapshot()
          break
        case 'active:task':
          break
        case 'terminal:sessions':
          setTerminalSessions(event.sessions)
          break
        case 'git:state':
          setGitState(event.state)
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
            const durationMs = (event.task.endedAt || event.task.updatedAt) - event.task.startedAt
            const duration = formatElapsed(durationMs)
            const exit = typeof event.task.exitCode === 'number' ? t('ui.app.exitCode', { code: event.task.exitCode }) : ''
            const log = event.task.logPath ? t('ui.app.logPath', { path: event.task.logPath }) : ''
            appendMessages([{
              id: genMsgId(),
              role: 'system',
              content: t('ui.app.backgroundFinished', {
                session: sessionId,
                status: event.task.status,
                duration,
                exit,
                command: event.task.command || t('ui.app.shellSession'),
                log,
              }),
            }], { forceLatest: true })
            notificationCoordinator.raise({
              id: `terminal-result:${sessionId}`,
              category: event.task.status === 'failed' ? 'error' : 'result-ready',
              title: t('ui.app.backgroundTerminalStatus', { status: event.task.status }),
              detail: sessionId,
              sourceId: sessionId,
            })
            syncNotificationSnapshot()
          }
          markActivity()
          break
        }
        case 'approval:state':
          if (event.state === 'resolved' || event.state === 'cancelled') {
            dismissPendingAsk(event.requestId)
          }
          break
        case 'ask:user':
          schedulePendingAsk({
            id: event.requestId || `ask-${Date.now()}`,
            question: event.question,
            options: event.options,
            reason: event.reason,
            command: event.command,
            toolName: event.toolName,
            path: event.path,
          })
          setMood('thinking')
          break
        case 'context:segment_created':
          convManager.scheduleSave()
          markActivity()
          break
        case 'notification':
          notificationCoordinator.raise({
            id: `engine:${event.level}:${event.message}`,
            category: event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : event.level === 'success' ? 'turn-complete' : 'info',
            title: event.message,
            sourceId: `${event.level}:${event.message}`,
          })
          syncNotificationSnapshot()
          if (event.level === 'warning' || event.level === 'error') {
            appendMessages([{ id: genMsgId(), role: 'system', content: event.message }])
          } else {
            showRunControlHint(event.message)
          }
          break
        case 'model:protocol':
          if (event.phase === 'fallback') {
            appendMessages([{
              id: genMsgId(),
              role: 'system',
              content: t('ui.app.protocolFallback', {
                message: event.message || t('ui.app.protocolMismatch'),
                url: event.url,
              }),
            }], { forceLatest: true })
          }
          break
        case 'error':
          streamBufferRef.current = ''
          streamThinkingBufferRef.current = ''
          streamThinkingStartedAtRef.current = undefined
          setStreamThinkingStartedAt(undefined)
          clearStreamFlushTimer()
      setStreamText('')
      setStreamThinkingText('')
      appendMessages([{ id: genMsgId(), role: 'system', content: t('common.error', { message: event.error }) }])
          notificationCoordinator.raise({
            id: `run-error:${Date.now()}`,
            category: 'error',
            title: t('ui.app.runFailed'),
            detail: event.error,
            sourceId: 'foreground-run',
          })
          syncNotificationSnapshot()
          setMood('error')
          setTimeout(() => setMood('idle'), 4000)
          break
        case 'mode:change':
          setGitState(engine.getGitState())
          break
      }
    })
    return () => {
      clearStreamFlushTimer()
      if (runControlHintTimerRef.current) clearTimeout(runControlHintTimerRef.current)
      unsub()
      void runtime.destroy().catch(() => {}).finally(() => {
        engine.setEventRecorder(null)
        convManager.destroy()
      })
    }
  }, [engine, runtime, convManager, flowBridge, clearStreamFlushTimer, appendMessages, replaceMessages, setComposedInput, markActivity, showRunControlHint, genMsgId, noFlickerActive, t, dismissPendingAsk, schedulePendingAsk, notificationCoordinator, syncNotificationSnapshot, streamScheduler, terminalLatencyTracker, flowFeatures.streamScheduler])

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

  const restoreInteractionState = useCallback((state?: ConversationInteractionState) => {
    const recoveredSteering = (state?.pendingSteering || []).map(pending => ({
      id: pending.id,
      prompt: pending.text,
    }))
    const recoveredQueue = [...recoveredSteering, ...(state?.queuedInputs || [])]
    flowBridge.replaceQueue(recoveredQueue)

    const draftText = state?.draft?.text ?? ''
    const draftStateAttachments = state?.draft?.attachments ?? []
    inputRef.current = draftText
    setInput(draftText)
    draftAttachmentsRef.current = draftStateAttachments
    setDraftAttachments(draftStateAttachments)

    const recoveredApprovalCount = state?.pendingApprovals?.length ?? 0
    if (recoveredApprovalCount > 0) {
      appendMessages([{
        id: genMsgId(),
        role: 'system',
        content: t('ui.app.recoveredApprovals', { count: recoveredApprovalCount }),
      }], { forceLatest: true })
    }
  }, [appendMessages, flowBridge, genMsgId, t])

  useEffect(() => {
    if (singleShot) runPrompt(singleShot)
  }, [])

  const transcriptRowBudget = useMemo(() => {
    if (!noFlickerActive) return Number.MAX_SAFE_INTEGER
    return Math.max(4, terminal.rows - 5)
  }, [noFlickerActive, terminal.rows])
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

  const recordTranscriptWindowMetrics = useCallback((metrics: { mountedCells: number; totalCells: number }) => {
    flowTelemetry.observe('ui.transcript_mounted_cells', metrics.mountedCells)
    flowTelemetry.observe('ui.transcript_total_cells', metrics.totalCells)
  }, [flowTelemetry])

  const scrollTranscriptBy = useCallback((delta: number) => {
    setScrollRowsFromBottom(rows => clampTranscriptScroll(
      rows + delta,
      transcriptMetricsRef.current.maxScrollRows,
    ))
  }, [])

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
    if (flowBridge.isForegroundBusy() || engine.isRunning() || runPromptRef.current === null) return
    if (!convManager.isPersistenceHealthy()) {
      showRunControlHint(t('ui.app.persistenceBlocked'))
      return
    }
    const next = flowBridge.takeNextQueuedInput()
    if (!next) return
    void runPromptRef.current(next.prompt, next.attachments, next.id)
  }, [convManager, engine, flowBridge, showRunControlHint, t])

  const runPrompt = useCallback(async (prompt: string, attachments?: AgentAttachment[], queuedMessageId?: string) => {
    if (!convManager.isPersistenceHealthy()) {
      showRunControlHint(t('ui.app.persistenceBlocked'))
      return
    }
    if (flowBridge.isForegroundBusy() || engine.isRunning()) {
      flowBridge.enqueueInput({ id: queuedMessageId ?? genMsgId(), prompt, attachments })
      showRunControlHint(t('ui.flow.input.queued', { count: flowBridge.getQueuedInputs().length }))
      return
    }

    const userMessageId = queuedMessageId ?? genMsgId()
    lastAssistantTurnInterruptedRef.current = false
    activePromptRef.current = { prompt, attachments, messageId: userMessageId, responseStarted: false, priorTurns: [...engine.getSession().turns] }
    abortingRef.current = false
    abortRestoredPromptRef.current = false
    appendMessages([{ id: userMessageId, role: 'user', content: prompt }], { forceLatest: true })
    if (!config.apiKey) {
      activePromptRef.current = null
      appendMessages([{ id: genMsgId(), role: 'system', content: t('ui.app.noProvider') }])
      if (singleShot) exit()
      return
    }
    if (!config.model) {
      activePromptRef.current = null
      appendMessages([{
        id: genMsgId(),
        role: 'system',
        content: modelDiscoveryStatus.isRefreshing
          ? t('ui.app.modelDiscoveryRunning')
          : t('ui.app.noModelMounted'),
      }])
      return
    }
    flowBridge.startRun(prompt)
    setMood('thinking')
    streamBufferRef.current = ''
    streamThinkingBufferRef.current = ''
    streamThinkingStartedAtRef.current = undefined
    setStreamThinkingStartedAt(undefined)
    clearStreamFlushTimer()
    setStreamText('')
    setStreamThinkingText('')
    updateCurrentTools(() => [])
    updateChangeSummaries(() => [])
    dismissPendingAsk()
    notificationCoordinator.acknowledgeCategory('turn-complete')
    notificationCoordinator.acknowledgeSource('error', 'foreground-run')
    syncNotificationSnapshot()
    setInterruptHint(null)
    setExitHint(null)
    setLastActivity(Date.now())
    let runOutcome: 'succeeded' | 'failed' | 'interrupted' = 'failed'
    let runError: string | undefined
    try {
      const turns = await engine.run(prompt, { attachments, userTurnId: userMessageId })
      runOutcome = 'succeeded'
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
      const bufferedThinkingText = streamThinkingBufferRef.current
      const thinkingStartedAt = streamThinkingStartedAtRef.current
      const visibleInterruptedText = stripTextToolCallMarkup(bufferedStreamText, { stripIncomplete: true })
      const toolsSnapshot = currentToolsRef.current
      const changesSnapshot = changeSummariesRef.current
      const interrupted = abortingRef.current || e?.aborted === true || /aborted/i.test(String(e?.message || ''))
      runOutcome = interrupted ? 'interrupted' : 'failed'
      runError = interrupted ? undefined : String(e?.message || e)
      streamBufferRef.current = ''
      streamThinkingBufferRef.current = ''
      streamThinkingStartedAtRef.current = undefined
      setStreamThinkingStartedAt(undefined)
      clearStreamFlushTimer()
      setStreamText('')
      setStreamThinkingText('')
      if (abortRestoredPromptRef.current) {
        // The prompt is already back in the editor; avoid adding a synthetic transcript row.
      } else if (interrupted && (visibleInterruptedText || bufferedThinkingText || toolsSnapshot.length > 0 || changesSnapshot.length > 0)) {
        appendMessages([{
          id: genMsgId(),
          role: 'assistant',
          content: visibleInterruptedText,
          tools: [...toolsSnapshot],
          changes: [...changesSnapshot],
          interrupted: true,
          thinking: createThinkingTrace(bufferedThinkingText, thinkingStartedAt, true),
        }])
      } else if (interrupted) {
        appendMessages([{ id: genMsgId(), role: 'system', content: t('common.interrupted') }])
      } else {
        appendMessages([{ id: genMsgId(), role: 'system', content: t('common.error', { message: e.message }) }])
      }
      updateCurrentTools(() => [])
      updateChangeSummaries(() => [])
      setMood(abortingRef.current ? 'idle' : 'error')
      if (!abortingRef.current) setTimeout(() => setMood('idle'), 4000)
    } finally {
      activePromptRef.current = null
      flowBridge.finishRun(runOutcome, runError)
      abortingRef.current = false
      abortRestoredPromptRef.current = false
      if (flowBridge.getQueuedInputs().length > 0) setTimeout(runNextQueuedPrompt, 0)
    }
    if (singleShot) exit()
  }, [appendMessages, engine, singleShot, config, clearStreamFlushTimer, exit, runNextQueuedPrompt, genMsgId, showRunControlHint, modelDiscoveryStatus.isRefreshing, t, dismissPendingAsk, notificationCoordinator, syncNotificationSnapshot, convManager, flowBridge])

  useEffect(() => {
    runPromptRef.current = runPrompt
  }, [runPrompt])

  useEffect(() => {
    if (isRunning || queuedPrompts.length === 0 || !convManager.isPersistenceHealthy()) return
    const timer = setTimeout(runNextQueuedPrompt, 0)
    return () => clearTimeout(timer)
  }, [convManager, isRunning, persistenceWarning, queuedPrompts.length, runNextQueuedPrompt])

  const submitAskResponse = useCallback((response: string) => {
    const trimmed = response.trim()
    if (!trimmed) return
    appendMessages([{ id: genMsgId(), role: 'user', content: trimmed }], { forceLatest: true })
    const requestId = pendingAskRef.current?.id
    engine.submitAskUserResponse(trimmed, requestId)
    dismissPendingAsk(requestId)
    setMood('thinking')
    setLastActivity(Date.now())
  }, [appendMessages, engine, genMsgId, dismissPendingAsk])

  const submitPermissionDecision = useCallback((requestId: string, decision: PermissionDecision) => {
    engine.submitAskUserResponse(decision, requestId)
    dismissPendingAsk(requestId)
    setMood('thinking')
    setLastActivity(Date.now())
  }, [engine, dismissPendingAsk])

  const isPermissionAsk = pendingAsk?.options?.includes('allow-once') ?? false

  const attachClipboardImage = useCallback((options?: { silentNoImage?: boolean }) => {
    const nextIndex = draftAttachmentsRef.current.length + 1
    const warnings: string[] = []
    const attachment = captureClipboardImageAttachment(nextIndex, warnings, workspacePath, t)
    if (!attachment) {
      if (!options?.silentNoImage) {
        const visibleWarnings = warnings.length > 0 ? warnings : [t('ui.app.clipboardImageMissing')]
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
  }, [appendMessages, genMsgId, setComposedInput, t, workspacePath])

  const handlePasteImage = useCallback(() => {
    const attached = attachClipboardImage()
    if (attached) terminalLatencyTracker.noteKeyReceived()
    return attached
  }, [attachClipboardImage, terminalLatencyTracker])

  const handlePasteText = useCallback((pastedText: string, nextValue: string) => {
    if (!hasImageReference(pastedText)) return null
    const resolved = resolveImagePrompt(nextValue, workspacePath, { existingAttachments: draftAttachmentsRef.current, t })
    if (resolved.attachments.length === draftAttachmentsRef.current.length) return null

    for (const warning of resolved.warnings) {
      appendMessages([{ id: genMsgId(), role: 'system', content: warning }])
    }
    draftAttachmentsRef.current = resolved.attachments
    setDraftAttachments(resolved.attachments)
    return { value: resolved.prompt, cursorOffset: resolved.prompt.length }
  }, [appendMessages, genMsgId, t, workspacePath])

  const handleInterrupt = useCallback(() => {
    const pressedAt = Date.now()
    if (pressedAt - lastCtrlCEventAtRef.current < 120) return
    lastCtrlCEventAtRef.current = pressedAt

    if (flowBridge.isForegroundBusy() || engine.isRunning()) {
      const activePrompt = activePromptRef.current
      abortingRef.current = true
      if (activePrompt && !activePrompt.responseStarted) {
        inputRef.current = activePrompt.prompt
        setInput(activePrompt.prompt)
        draftAttachmentsRef.current = activePrompt.attachments ?? []
        setDraftAttachments(activePrompt.attachments ?? [])
      }
      engine.abort()
      dismissPendingAsk()
      setInterruptHint(t('ui.app.runInterrupted'))
      setTimeout(() => setInterruptHint(null), 2500)

      if (activePrompt && !activePrompt.responseStarted) {
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
    setExitHint(t('ui.app.exitHint'))
    setTimeout(() => {
      if (Date.now() - exitPressRef.current >= 1800) setExitHint(null)
    }, 1800)
  }, [engine, exit, replaceMessages, dismissPendingAsk, flowBridge])

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
    terminalLatencyTracker.noteSubmit()
    const isCommand = commandRegistry.isCommand(trimmed)
    const recoveryCommand = isPersistenceRecoveryCommand(trimmed)
    if (!convManager.isPersistenceHealthy() && !recoveryCommand) {
      showRunControlHint(t('ui.app.persistenceBlocked'))
      return
    }
    const pendingDraftAttachments = draftAttachmentsRef.current
    inputRef.current = ''
    setInput('')
    draftAttachmentsRef.current = []
    setDraftAttachments([])

    if (isCommand && (flowBridge.isForegroundBusy() || engine.isRunning()) && !recoveryCommand) {
      runPrompt(trimmed, pendingDraftAttachments)
      return
    }

    if (flowBridge.isForegroundBusy() || engine.isRunning()) {
      const steeringMessageId = genMsgId()
      if (pendingDraftAttachments.length === 0 && engine.submitSteeringMessage(trimmed, steeringMessageId)) {
        setLastActivity(Date.now())
        return
      }
      runPrompt(trimmed, pendingDraftAttachments)
      return
    }

    if (isCommand) {
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
        runtimeTaskManager: runtime.runtimeTaskManager,
        flowFeatures,
        notificationInbox: {
          snapshot: () => notificationCoordinator.getSnapshot(),
          clearResults: clearResultInbox,
        },
        t,
      }
      const result = commandRegistry.execute(trimmed, ctx)
      flowBridge.updateUsage(engine.getContextUsage())
      setGitState(engine.getGitState())
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
    const resolved = resolveImagePrompt(trimmed, workspacePath, { existingAttachments: pendingDraftAttachments, t })
    for (const warning of resolved.warnings) {
      appendMessages([{ id: genMsgId(), role: 'system', content: warning }])
    }
    runPrompt(resolved.prompt, resolved.attachments)
  }, [appendMessages, config, convManager, engine, exit, mcpClient, modelPresets, persistConfig, push, restoreCliStateFromTurns, runPrompt, runtime.runtimeTaskManager, skillRuntime, t, workspacePath, genMsgId, notificationCoordinator, clearResultInbox, terminalLatencyTracker, showRunControlHint, flowFeatures, flowBridge])

  const handleAlternateSubmit = useCallback((value: string) => {
    if (!flowBridge.isForegroundBusy() && !engine.isRunning()) {
      handleSubmit(value)
      return
    }
    const trimmed = value.trim()
    if (!trimmed) return
    terminalLatencyTracker.noteSubmit()
    if (!convManager.isPersistenceHealthy()) {
      showRunControlHint(t('ui.app.persistenceBlocked'))
      return
    }
    const attachments = draftAttachmentsRef.current
    inputRef.current = ''
    setInput('')
    draftAttachmentsRef.current = []
    setDraftAttachments([])
    runPrompt(trimmed, attachments)
  }, [handleSubmit, runPrompt, terminalLatencyTracker, convManager, showRunControlHint, t, engine, flowBridge])

  useInput((ch, key) => {
    if (terminalAttention.handleInput(ch)) {
      const activeNotification = notificationCoordinator.getSnapshot().active
      if (activeNotification) terminalAttention.notify(activeNotification)
      return
    }
    if (!startupFrame.complete) {
      skipStartupAnimation()
      return
    }
    if (key.ctrl && ch === 'c') {
      handleInterrupt()
      return
    }
    if (activeOverlay !== null) return // overlays handle their own keys

    if (isThinkingToggleShortcut(ch, key.ctrl)) {
      setShowThinking(current => !current)
      return
    }

    if (key.ctrl && ch.toLowerCase() === 'e') {
      setShowToolDetails(current => !current)
      return
    }

    if (noFlickerActive && !cursorMode && !pendingAsk) {
      const mouseEvents = parseTerminalMouseWheel(ch)
      if (mouseEvents.length > 0) {
        const transcriptTop = 1
        const transcriptBottom = terminal.rows - 5
        const transcriptLeft = 1
        const transcriptRight = cockpit.contentWidth
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
  const reasoningLabel = formatNativeReasoningSetting(config.model, config.reasoning, config.provider, config.modelCapabilities)
  const reasoningActive = Boolean(reasoningLabel && reasoningLabel !== 'off' && isRunning && runState.phase === 'thinking')
  const conversationFrameWidth = Math.max(24, cockpit.contentWidth - 2)

  const runningNode = (isRunning || subAgentActivities.length > 0 || queuedPrompts.length > 0) ? (
    <Box flexDirection="column" marginBottom={1}>
      {!noFlickerActive && <SubAgentProgressLine activities={subAgentActivities} />}
      {!noFlickerActive && activeTask && <TaskProgressLine task={activeTask} />}
      <ActiveWorkPanel
        tools={currentTools}
        draft={streamingToolDraft}
        streamText={streamTextForDisplay}
        outputTokens={currentTurnOutputTokens}
        lastActivity={lastActivity}
        runState={runState}
        queuedCount={queuedPrompts.length}
        thinkingText={streamThinkingText}
        thinkingStartedAt={streamThinkingStartedAt}
        reasoningEffort={config.reasoning?.effort}
        reasoningActive={reasoningActive}
        showThinking={showThinking}
        verbose={verbose}
        idleLabel={isRunning && !visibleStreamText && currentTools.length === 0 && !pendingAsk ? t('ui.activity.phase.thinking') : null}
        availableWidth={noFlickerActive
          ? cockpit.contentWidth - 4
          : terminal.columns - 4}
      />
      <QueuedPromptList
        width={noFlickerActive ? cockpit.contentWidth - 4 : terminal.columns - 4}
        prompts={[
          ...pendingSteeringPrompts.map(pending => ({
            id: pending.id,
            prompt: pending.prompt,
            attachmentCount: pending.attachments?.length,
            kind: 'steering' as const,
          })),
          ...queuedPrompts.map(queued => ({
            id: queued.id,
            prompt: queued.prompt,
            attachmentCount: queued.attachments?.length,
            kind: 'queued' as const,
          })),
        ]}
      />
    </Box>
  ) : null

  const pendingAskNode = pendingAsk && askModalVisible ? (
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
          <Text bold>{t('ui.app.confirmationNeeded')}</Text>
          <Text>{pendingAsk.question}</Text>
          {pendingAsk.reason && <Text dimColor>{pendingAsk.reason}</Text>}
          {pendingAsk.command && <Text>{pendingAsk.command}</Text>}
          {pendingAsk.options?.length ? <Text dimColor>{pendingAsk.options.join(' / ')}</Text> : null}
          <PromptInput
            value={askInput}
            onChange={setAskInput}
            onSubmit={submitAskResponse}
            mode={currentMode}
            width={conversationFrameWidth}
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
          restoreInteractionState(conv.interactionState)
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
        appendMessages([{ id: genMsgId(), role: 'system', content: t('ui.app.modelSwitched', { model: preset.model }) }])
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
        appendMessages([{ id: genMsgId(), role: 'system', content: t('ui.app.reasoningSet', { value: value || t('common.providerDefault') }) }])
      }}
      onCancel={() => pop()}
    />
  ) : null

  const overlayNode = historyOverlay ?? rewindOverlay ?? modelOverlay ?? effortOverlay
  const showPrompt = !singleShot && activeOverlay === null && !cursorMode && !askModalVisible
  const cursorPreviewMessage = cursorMode && !noFlickerActive && cursor ? messages[cursor.index] : undefined
  const cursorHint = cursorMode ? (
    <Box marginTop={1}>
      <Text dimColor>{t('ui.app.cursorHint')}</Text>
    </Box>
  ) : null
  const cursorPreviewNode = cursorPreviewMessage ? (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{t('ui.app.selectedMessage', { current: cursor!.index + 1, total: messages.length })}</Text>
      <MessageList
        messages={[cursorPreviewMessage]}
        verbose={verbose}
        availableWidth={conversationFrameWidth}
        selectedIndex={0}
      />
    </Box>
  ) : null
  const flowInputHint = flowInputReceipt ? describeFlowInputReceipt(flowInputReceipt, t) : null
  const flowResultHint = notificationSnapshot.resultCount > 0
    ? t('ui.flow.resultsReady', { count: notificationSnapshot.resultCount })
    : null
  const semanticFlowHint = flowInputHint ?? flowResultHint
  const promptNode = showPrompt ? (
    <Box flexDirection="column">
      {(flowIsRunning || flowQueueCount > 0 || semanticFlowHint || interruptHint || exitHint || runControlHint || persistenceWarning) && (
        <Box paddingLeft={1}>
          <Text dimColor={!persistenceWarning}>
            {persistenceWarning || interruptHint || exitHint || runControlHint || semanticFlowHint || (flowIsRunning
              ? t('ui.flow.controls.running', { count: flowQueueCount })
              : t('ui.flow.controls.queued', { count: flowQueueCount }))}
          </Text>
        </Box>
      )}
      {pendingAsk && !askModalVisible && (
        <Box paddingLeft={1}>
          <Text color="yellow" bold>
            {isPermissionAsk ? t('ui.app.actionReviewDelayed') : t('ui.app.actionInputDelayed')}
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
        onUserActivity={noteComposerActivity}
        onInputMutation={noteInputMutation}
        mode={currentMode}
        width={conversationFrameWidth}
        historyRef={promptHistoryRef}
      />
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
      <TranscriptViewport
        scrollRowsFromBottom={normalizedScrollRows}
        onScrollRowsChange={setScrollRowsFromBottom}
        onMetricsChange={handleTranscriptMetrics}
      >
        {flowFeatures.transcriptWindowing ? (
          <WindowedMessageList
            messages={messages}
            verbose={verbose}
            viewportRows={transcriptMetrics.viewportRows > 1 ? transcriptMetrics.viewportRows : transcriptRowBudget}
            scrollRowsFromBottom={normalizedScrollRows}
            showToolDetails={showToolDetails}
            availableWidth={conversationFrameWidth}
            selectedMessageId={selectedMessageId}
            selectedMessageRef={cursorMode ? selectedMessageRef : undefined}
            showThinking={showThinking}
            onWindowMetrics={recordTranscriptWindowMetrics}
          />
        ) : (
          <MessageList
            messages={messages}
            verbose={verbose}
            showToolDetails={showToolDetails}
            availableWidth={conversationFrameWidth}
            selectedMessageId={selectedMessageId}
            selectedMessageRef={cursorMode ? selectedMessageRef : undefined}
            showThinking={showThinking}
          />
        )}
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
  const landingFrameWidth = resolveLandingFrameWidth(terminal.columns)
  const showLandingView = shouldShowLandingView({
    messageCount: messages.length,
    isRunning,
    hasPendingAsk: Boolean(pendingAsk),
    cursorMode,
    hasOverlay: overlayNode !== null,
    queuedCount: queuedPrompts.length,
  })
  if (noFlickerActive) {
    return (
      <I18nProvider locale={profile.interfaceLanguage}>
        <ThemeProvider transparentBackground={transparentBackground}>
        <CockpitRoot width={getSafeViewportWidth(terminal.columns)} height={terminal.rows}>
          {showLandingView ? (
            <LandingView
              frameWidth={landingFrameWidth}
              workspacePath={workspacePath}
              mood={mood}
              hasApiKey={!!config.apiKey}
              logoReveal={startupFrame.logoReveal}
              showVersion={startupFrame.showVersion}
              showWorkspace={startupFrame.showWorkspace}
              showPrompt={startupFrame.showPrompt && showPrompt}
              flowEnabled={flowUiEnabled}
              prompt={(
                <PromptInput
                  value={input}
                  onChange={setComposedInput}
                  onSubmit={handleSubmit}
                  onAlternateSubmit={handleAlternateSubmit}
                  onPasteImage={handlePasteImage}
                  onPasteText={handlePasteText}
                  onUserActivity={noteComposerActivity}
                  mode={currentMode}
                  width={landingFrameWidth}
                  placeholder=""
                  appearance="landing"
                  historyRef={promptHistoryRef}
                />
              )}
            />
          ) : (
            <Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" backgroundColor={layoutBackground}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0} overflow="hidden">
                <SessionPane running={isRunning} visible={false}>
                  {overlayNode ?? (
                    <Box flexDirection="column" flexBasis={0} flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
                      {transcriptNode}
                      {pendingAskNode}
                    </Box>
                  )}
                </SessionPane>
                <Box flexDirection="column" flexShrink={0} backgroundColor={layoutBackground} paddingX={1}>
                  {cursorHint}
                  <AgentActivityLine active={flowIsRunning} persistent width={conversationFrameWidth} />
                  {promptNode}
                  {!cockpit.showSidebar && (
                    <StatusLine
                      config={config}
                      tokenUsage={tokenUsage}
                      mode={currentMode}
                      viewingHistory={isViewingHistory}
                      gitState={gitState}
                      mcpCount={mcpCount}
                      terminalCount={activeTerminalCount}
                      attentionLabel={(!flowUiEnabled || !flowFeatures.notifications) && pendingAsk ? (isPermissionAsk ? t('ui.app.reviewRequired') : t('ui.app.inputRequired')) : undefined}
                      activity={primaryFlowActivity}
                      backgroundCount={flowBackgroundCount}
                      queueCount={flowQueueCount}
                      resultCount={notificationSnapshot.resultCount}
                      width={conversationFrameWidth}
                    />
                  )}
                </Box>
              </Box>
              {cockpit.showSidebar && (
                <SessionSidebar
                  width={cockpit.sidebarWidth}
                  workspacePath={workspacePath}
                  model={config.model}
                  mode={currentMode}
                  reasoning={reasoningLabel || undefined}
                  contextWindow={config.contextWindow}
                  tokenUsage={tokenUsage}
                  isRunning={isRunning}
                  runState={runState}
                  tools={currentTools}
                  draft={streamingToolDraft}
                  streamText={streamTextForDisplay}
                  thinkingText={streamThinkingText}
                  subagents={subAgentActivities}
                  queuedCount={queuedPrompts.length}
                  terminals={terminalSessions}
                  mcpCount={mcpCount}
                  task={activeTask}
                  objective={activeObjective?.prompt}
                  gitState={gitState}
                />
              )}
            </Box>
          )}
        </CockpitRoot>
        </ThemeProvider>
      </I18nProvider>
    )
  }

  return (
    <I18nProvider locale={profile.interfaceLanguage}>
      <ThemeProvider transparentBackground={transparentBackground}>
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
                  availableWidth={Math.max(24, terminal.columns - 4)}
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
        <StatusLine
          config={config}
          tokenUsage={tokenUsage}
          mode={currentMode}
          viewingHistory={isViewingHistory}
          gitState={gitState}
          attentionLabel={(!flowUiEnabled || !flowFeatures.notifications) && pendingAsk ? (isPermissionAsk ? t('ui.app.reviewRequired') : t('ui.app.inputRequired')) : undefined}
          activity={primaryFlowActivity}
          backgroundCount={flowBackgroundCount}
          queueCount={flowQueueCount}
          resultCount={notificationSnapshot.resultCount}
        />
        <AgentActivityLine active={flowIsRunning} />
      </Box>
      </ThemeProvider>
    </I18nProvider>
  )
}

export function startInkApp(options: {
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
}) {
  const workspaceName = options.workspacePath.split(/[\\/]/).pop() || 'workspace'
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const noFlicker = shouldUseNoFlicker(interactive, options.singleShot, options.noFlicker === true)
  const flowTelemetry = new LocalFlowTelemetry(options.workspacePath)
  const terminalLatencyTracker = new TerminalLatencyTracker((metric, value) => flowTelemetry.observe(metric, value))
  render(
    <App
      workspacePath={options.workspacePath}
      workspaceName={workspaceName}
      config={options.config}
      singleShot={options.singleShot}
      verbose={options.verbose}
      noFlicker={noFlicker}
      approvalPolicy={options.approvalPolicy}
      capabilityProfile={options.capabilityProfile}
      mcpServers={options.mcpServers}
      startupAnimation={options.startupAnimation}
      transparentBackground={options.transparentBackground}
      flowTelemetry={flowTelemetry}
      terminalLatencyTracker={terminalLatencyTracker}
    />,
    {
      maxFps: noFlicker ? 24 : 18,
      incrementalRendering: noFlicker,
      interactive,
      alternateScreen: noFlicker,
      exitOnCtrlC: false,
      onRender: ({ renderTime }) => {
        if (!interactive) return
        flowTelemetry.observe('ui.frame_render_ms', renderTime)
        if (!terminalLatencyTracker.beginTerminalFlush()) return
        setImmediate(() => {
          if (process.stdout.destroyed || process.stdout.writableEnded) {
            terminalLatencyTracker.cancelTerminalFlush()
            return
          }
          process.stdout.write('', () => terminalLatencyTracker.completeTerminalFlush())
        })
      },
    }
  )
}
