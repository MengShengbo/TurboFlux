import React, { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react'
import { render, Box, Static, Text, useInput, useApp, useBoxMetrics, type DOMElement } from 'ink'
import { ThemeProvider, resolveBackground, useTheme } from '../theme/index'
import { Header } from './header/Header'
import { StatusLine } from './header/StatusLine'
import type { ToolStatus } from './tools/ToolCallTree'
import { ActiveWorkPanel, type ModelRequestPresentation } from './tools/ActiveWorkPanel'
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
import type { ContextCompactionState, ContextReservoirEntry, ContextSegment } from '../../state/types'
import { type Message } from './messages/Messages'
import { PromptInput } from './input/PromptInput'
import { formatMarkdown, getMarkdownCacheStats } from './markdown/index'
import type { AgentEventType } from '../../core/agentEngine'
import type { GitIntegrationState } from '../../core/gitService'
import { createAgentRuntime } from '../../core/runtime/agentRuntime'
import { applyPreset, saveConfig, setConfigValue, type ModelPreset, type TurboFluxConfig } from '../../core/config'
import { loadProfile } from '../../core/profile'
import { discoverModelPresets, readCachedModelDiscovery } from '../../core/modelDiscovery'
import { formatNativeReasoningSetting, getModelReasoningCapabilities } from '../../core/modelRegistry'
import { commandRegistry } from '../commands/index'
import type { CommandContext } from '../commands/types'
import { ConversationManager } from '../conversations/manager'
import type { ConversationInteractionState } from '../conversations/types'
import type { ConversationPendingPaste } from '../conversations/types'
import {
  LARGE_PASTE_CHAR_THRESHOLD,
  createPendingPastePlaceholder,
  expandPendingPastes,
  replacePastedText,
  retainPendingPastes,
} from './input/pasteState'
import { AgentFlowController } from '../state/agentFlowController'
import { GlobalCommandActivityController } from '../state/globalCommandActivity'
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
import { TaskFlowHud } from './tools/TaskFlowHud'
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
  appendLiveReasoningTail,
  appendLiveStreamTail,
  createMessageIdFactory,
  createThinkingTrace,
  formatElapsed,
  formatTaskProgressLabel,
  formatTaskToolSummary,
  getProvisionalAssistantText,
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
  StreamTextAccumulator,
} from './appHelpers'

export {
  appendLiveReasoningTail,
  appendLiveStreamTail,
  createMessageIdFactory,
  createThinkingTrace,
  formatTaskProgressLabel,
  formatTaskToolSummary,
  getProvisionalAssistantText,
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
  StreamTextAccumulator,
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

export interface TranscriptBufferState {
  messages: Message[]
  staticRevision: number
  staticItemOffset: number
}

const MAX_TRANSCRIPT_MESSAGES = 1_000
const MAX_TRANSCRIPT_CHARS = 8 * 1024 * 1024
const MODEL_REQUEST_RESULT_VISIBLE_MS = 3_000

function transcriptMessageChars(message: Message): number {
  let chars = message.content.length + (message.thinking?.content.length ?? 0)
  for (const change of message.changes ?? []) {
    chars += (change.before?.length ?? 0) + (change.after?.length ?? 0)
    chars += (change.preview?.length ?? 0) + (change.oldPreview?.length ?? 0)
  }
  return chars
}

function retainTranscriptTail(messages: Message[]): Message[] {
  if (messages.length <= MAX_TRANSCRIPT_MESSAGES) {
    let chars = 0
    for (const message of messages) chars += transcriptMessageChars(message)
    if (chars <= MAX_TRANSCRIPT_CHARS) return messages
  }

  let start = messages.length
  let chars = 0
  while (start > 0) {
    const next = messages[start - 1]!
    const nextChars = transcriptMessageChars(next)
    if (start < messages.length && (start <= messages.length - MAX_TRANSCRIPT_MESSAGES || chars + nextChars > MAX_TRANSCRIPT_CHARS)) break
    chars += nextChars
    start -= 1
  }

  const retained = messages.slice(start)
  return [
    {
      id: `transcript-trim-${retained[0]?.id || Date.now()}`,
      role: 'system',
      content: 'Older transcript entries were trimmed from the live UI buffer; the saved conversation remains available.',
    },
    ...retained,
  ]
}

function isTranscriptTrimNotice(message: Message): boolean {
  return message.id.startsWith('transcript-trim-')
}

function countStaticTranscriptMessages(messages: Message[]): number {
  return messages.reduce((count, message) => count + (isTranscriptTrimNotice(message) ? 0 : 1), 0)
}

export function appendTranscriptBuffer(
  state: TranscriptBufferState,
  nextMessages: Message[],
  options?: { dedupeTail?: boolean },
): TranscriptBufferState {
  if (nextMessages.length === 0) return state

  const combined = [...state.messages]
  let appendedCount = 0
  for (const message of nextMessages) {
    const previous = combined.at(-1)
    if (
      options?.dedupeTail
      && previous?.role === message.role
      && previous.content.trim() === message.content.trim()
    ) continue
    combined.push(message)
    appendedCount += 1
  }
  if (appendedCount === 0) return state

  const retained = retainTranscriptTail(combined)
  const previousStaticCount = countStaticTranscriptMessages(state.messages)
  const retainedStaticCount = countStaticTranscriptMessages(retained)
  return {
    messages: retained,
    staticRevision: state.staticRevision,
    staticItemOffset: state.staticItemOffset + previousStaticCount + appendedCount - retainedStaticCount,
  }
}

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

function SessionPane({ children }: { children: React.ReactNode }) {
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
  const tRef = useRef(t)
  tRef.current = t
  const [globalCommandActivityController] = useState(() => new GlobalCommandActivityController())
  const globalCommandActivity = useSyncExternalStore(
    globalCommandActivityController.subscribe,
    globalCommandActivityController.getSnapshot,
    globalCommandActivityController.getSnapshot,
  )
  const [transcriptBuffer, setTranscriptBuffer] = useState<TranscriptBufferState>({
    messages: [],
    staticRevision: 0,
    staticItemOffset: 0,
  })
  const { messages, staticRevision: staticTranscriptRevision, staticItemOffset } = transcriptBuffer
  const [input, setInput] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<AgentAttachment[]>([])
  const [streamText, setStreamText] = useState('')
  const [streamThinkingText, setStreamThinkingText] = useState('')
  const [streamThinkingStartedAt, setStreamThinkingStartedAt] = useState<number | undefined>()
  const [modelRequestStatus, setModelRequestStatus] = useState<ModelRequestPresentation | null>(null)
  const [contextCompaction, setContextCompaction] = useState<ContextCompactionState | null>(null)
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
  const [conversationEntries, setConversationEntries] = useState<ConversationEntry[]>([])
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
  const streamBufferRef = useRef(new StreamTextAccumulator())
  const streamDisplayBufferRef = useRef('')
  const streamThinkingBufferRef = useRef('')
  const streamThinkingStartedAtRef = useRef<number | undefined>(undefined)
  const modelRequestStartedAtRef = useRef<number | undefined>(undefined)
  const modelRequestStatusRef = useRef<ModelRequestPresentation | null>(null)
  const modelRequestResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextCompactionClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streamTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAssistantTurnInterruptedRef = useRef(false)
  const lastActivityPaintRef = useRef(0)
  const inputRef = useRef('')
  const draftAttachmentsRef = useRef<AgentAttachment[]>([])
  const pendingPastesRef = useRef<ConversationPendingPaste[]>([])
  const pendingAskRef = useRef<PendingAsk | null>(null)
  const activePromptRef = useRef<{ prompt: string; messageId: string; responseStarted: boolean; attachments?: AgentAttachment[]; priorTurns: AgentTurn[] } | null>(null)
  const engineErrorMessageRef = useRef<string | null>(null)
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
    setStreamText(streamDisplayBufferRef.current)
    setStreamThinkingText(streamThinkingBufferRef.current)
    setCurrentTurnOutputTokens(previous => Math.max(
      previous,
      streamBufferRef.current.length > 0 ? Math.ceil(streamBufferRef.current.length / 4) : 0,
    ))
    flowTelemetry.count('ui.stream_flush')
    flowTelemetry.observe('ui.stream_batch_depth', batch.depth)
    flowTelemetry.observe('ui.stream_oldest_age_ms', batch.oldestAgeMs)
  }))
  const [genMsgId] = useState(() => createMessageIdFactory())

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
  const developerFlowActive = flowIsRunning || globalCommandActivity !== null
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
    convManager.recordDraftState({ text: input, attachments: draftAttachments, pendingPastes: pendingPastesRef.current })
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

  const clearModelRequestResultTimer = useCallback(() => {
    if (!modelRequestResultTimerRef.current) return
    clearTimeout(modelRequestResultTimerRef.current)
    modelRequestResultTimerRef.current = null
  }, [])

  const publishModelRequestStatus = useCallback((status: ModelRequestPresentation | null) => {
    modelRequestStatusRef.current = status
    setModelRequestStatus(status)
  }, [])

  const beginModelRequest = useCallback((startedAt = Date.now()) => {
    if (modelRequestStartedAtRef.current !== undefined) return
    clearModelRequestResultTimer()
    modelRequestStartedAtRef.current = startedAt
    publishModelRequestStatus({ phase: 'requesting', startedAt })
  }, [clearModelRequestResultTimer, publishModelRequestStatus])

  const markModelResponseStarted = useCallback((timestamp = Date.now()) => {
    const startedAt = modelRequestStartedAtRef.current
    if (startedAt === undefined || modelRequestStatusRef.current?.phase === 'responding') return
    publishModelRequestStatus({
      phase: 'responding',
      startedAt,
      elapsedMs: Math.max(0, timestamp - startedAt),
    })
  }, [publishModelRequestStatus])

  const finishModelRequest = useCallback((timestamp = Date.now(), interrupted = false) => {
    const startedAt = modelRequestStartedAtRef.current
    modelRequestStartedAtRef.current = undefined
    clearModelRequestResultTimer()
    if (startedAt === undefined || interrupted) {
      publishModelRequestStatus(null)
      return
    }
    const completed: ModelRequestPresentation = {
      phase: 'completed',
      startedAt,
      elapsedMs: Math.max(0, timestamp - startedAt),
    }
    publishModelRequestStatus(completed)
    modelRequestResultTimerRef.current = setTimeout(() => {
      modelRequestResultTimerRef.current = null
      if (modelRequestStatusRef.current !== completed) return
      publishModelRequestStatus(null)
    }, MODEL_REQUEST_RESULT_VISIBLE_MS)
  }, [clearModelRequestResultTimer, publishModelRequestStatus])

  const clearModelRequest = useCallback(() => {
    modelRequestStartedAtRef.current = undefined
    clearModelRequestResultTimer()
    publishModelRequestStatus(null)
  }, [clearModelRequestResultTimer, publishModelRequestStatus])

  const clearTerminalCompactionForRequest = useCallback(() => {
    if (contextCompactionClearTimerRef.current) {
      clearTimeout(contextCompactionClearTimerRef.current)
      contextCompactionClearTimerRef.current = null
    }
    setContextCompaction(current => current && ['completed', 'interrupted', 'failed'].includes(current.phase)
      ? null
      : current)
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
      title: ask.options?.includes('allow-once') ? tRef.current('ui.app.reviewRequired') : tRef.current('ui.app.inputRequired'),
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
  }, [approvalPresentationScheduler, flowBridge, flowTelemetry, notificationCoordinator, syncNotificationSnapshot])

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

  useEffect(() => () => {
    globalCommandActivityController.destroy()
  }, [globalCommandActivityController])

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

  const appendMessages = useCallback((nextMessages: Message[], options?: { forceLatest?: boolean; dedupeTail?: boolean }) => {
    if (nextMessages.length === 0) return
    setTranscriptBuffer(current => appendTranscriptBuffer(current, nextMessages, options))
    if (noFlickerActive && options?.forceLatest === true) setScrollRowsFromBottom(0)
  }, [noFlickerActive])

  const replaceMessages = useCallback((nextMessages: React.SetStateAction<Message[]>) => {
    setTranscriptBuffer(previous => ({
      messages: retainTranscriptTail(
        typeof nextMessages === 'function' ? nextMessages(previous.messages) : nextMessages,
      ),
      staticRevision: previous.staticRevision + 1,
      staticItemOffset: 0,
    }))
  }, [])

  const restoreCliStateFromTurns = useCallback((
    activeTurns: AgentTurn[],
    nextInput = '',
    contextSegments: ContextSegment[] = [],
    contextReservoir: ContextReservoirEntry[] = [],
    transcriptTurns: AgentTurn[] = activeTurns,
    options: { restoreEngine?: boolean; contextCompactionState?: ContextCompactionState | null } = {},
  ) => {
    if (options.restoreEngine !== false) {
      engine.restoreFromTurns(activeTurns)
      engine.setContextSegments(contextSegments)
      engine.setContextReservoir(contextReservoir)
      engine.setContextCompactionState(options.contextCompactionState ?? null)
    }
    if (contextCompactionClearTimerRef.current) {
      clearTimeout(contextCompactionClearTimerRef.current)
      contextCompactionClearTimerRef.current = null
    }
    setContextCompaction(options.contextCompactionState ?? null)
    replaceMessages(turnsToMessages(transcriptTurns))
    inputRef.current = nextInput
    pendingPastesRef.current = []
    setInput(nextInput)
    draftAttachmentsRef.current = []
    setDraftAttachments([])
    setScrollRowsFromBottom(0)
    flowBridge.updateUsage(engine.getContextUsage())
    setGitState(engine.getGitState())
    updateCurrentTools(() => [])
    updateChangeSummaries(() => [])
    setCurrentTurnOutputTokens(0)
    streamBufferRef.current.reset()
    streamDisplayBufferRef.current = ''
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
    pendingPastesRef.current = retainPendingPastes(reconciled.prompt, pendingPastesRef.current)
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
          if (event.state.phase === 'thinking') {
            clearTerminalCompactionForRequest()
            beginModelRequest(event.state.updatedAt)
          }
          if (event.state.phase === 'aborting') clearModelRequest()
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
            showRunControlHint(event.reason || tRef.current('ui.app.guidanceRestored'))
          }
          break
        case 'turn:complete': {
          if (event.turn.role !== 'assistant') break
          const interrupted = event.turn.metadata?.interrupted === true
          lastAssistantTurnInterruptedRef.current = interrupted
          if (isProvisionalAssistantTurn(event.turn)) {
            const visibleText = stripTextToolCallMarkup(getProvisionalAssistantText(event.turn), { stripIncomplete: true })
            if (visibleText) {
              appendMessages([{
                id: event.turn.id,
                role: 'assistant',
                content: visibleText,
                progress: true,
              }], { forceLatest: true })
            }
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
          clearTerminalCompactionForRequest()
          beginModelRequest()
          setCurrentTurnOutputTokens(0)
          streamBufferRef.current.reset()
          streamDisplayBufferRef.current = ''
          streamThinkingBufferRef.current = ''
          streamThinkingStartedAtRef.current = undefined
          setStreamThinkingStartedAt(undefined)
          setStreamThinkingText('')
          setStreamText('')
          clearStreamFlushTimer()
          break
        }
        case 'stream:delta':
          markModelResponseStarted()
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          const acceptedText = streamBufferRef.current.append(event.text)
          streamDisplayBufferRef.current = appendLiveStreamTail(
            streamDisplayBufferRef.current,
            acceptedText,
          )
          terminalLatencyTracker.noteDeltaReceived()
          if (flowFeatures.streamScheduler) {
            streamScheduler.enqueue(Buffer.byteLength(event.text, 'utf8'))
          } else {
            setStreamText(streamDisplayBufferRef.current)
            setCurrentTurnOutputTokens(previous => Math.max(
              previous,
              streamBufferRef.current.length > 0 ? Math.ceil(streamBufferRef.current.length / 4) : 0,
            ))
          }
          markActivity()
          break
        case 'stream:thinking_delta':
          markModelResponseStarted()
          if (activePromptRef.current) activePromptRef.current.responseStarted = true
          if (!streamThinkingStartedAtRef.current) {
            const thinkingStartedAt = Date.now()
            streamThinkingStartedAtRef.current = thinkingStartedAt
            setStreamThinkingStartedAt(thinkingStartedAt)
          }
          streamThinkingBufferRef.current = appendLiveReasoningTail(
            streamThinkingBufferRef.current,
            event.text,
          )
          terminalLatencyTracker.noteDeltaReceived()
          if (flowFeatures.streamScheduler) {
            streamScheduler.enqueue(Buffer.byteLength(event.text, 'utf8'))
          } else {
            setStreamThinkingText(streamThinkingBufferRef.current)
          }
          markActivity()
          break
        case 'stream:usage':
          markModelResponseStarted()
          if (typeof event.usage.output === 'number') {
            setCurrentTurnOutputTokens(previous => Math.max(previous, event.usage.output ?? 0))
          }
          break
        case 'stream:end': {
          finishModelRequest(Date.now(), event.interrupted === true)
          clearStreamFlushTimer()
          const bufferedStreamText = streamBufferRef.current.toString()
          const bufferedThinkingText = streamThinkingBufferRef.current
          const thinkingStartedAt = streamThinkingStartedAtRef.current
          streamBufferRef.current.reset()
          streamDisplayBufferRef.current = ''
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
              title: tRef.current('ui.app.agentTurnComplete'),
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
          markModelResponseStarted()
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
              detail: tRef.current('ui.subagent.starting'),
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
                detail: event.ok ? tRef.current('ui.subagent.resultReady') : tRef.current('common.failed'),
              }
            : activity))
          notificationCoordinator.raise({
            id: `subagent-result:${event.agentId}`,
            category: event.ok ? 'result-ready' : 'error',
            title: event.ok
              ? tRef.current('ui.app.subagentResultReady', { agent: event.agentType })
              : tRef.current('ui.app.subagentFailed', { agent: event.agentType }),
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
            const exit = typeof event.task.exitCode === 'number' ? tRef.current('ui.app.exitCode', { code: event.task.exitCode }) : ''
            const log = event.task.logPath ? tRef.current('ui.app.logPath', { path: event.task.logPath }) : ''
            appendMessages([{
              id: genMsgId(),
              role: 'system',
              content: tRef.current('ui.app.backgroundFinished', {
                session: sessionId,
                status: event.task.status,
                duration,
                exit,
                command: event.task.command || tRef.current('ui.app.shellSession'),
                log,
              }),
            }], { forceLatest: true })
            notificationCoordinator.raise({
              id: `terminal-result:${sessionId}`,
              category: event.task.status === 'failed' ? 'error' : 'result-ready',
              title: tRef.current('ui.app.backgroundTerminalStatus', { status: event.task.status }),
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
        case 'context:compaction_started':
        case 'context:compaction_summarizing':
        case 'context:compaction_fallback':
        case 'context:compaction_committing':
        case 'context:compaction_progress':
        case 'context:compaction_interrupted':
        case 'context:compaction_failed':
        case 'context:compaction_completed': {
          const state = event.state
          if (contextCompactionClearTimerRef.current) {
            clearTimeout(contextCompactionClearTimerRef.current)
            contextCompactionClearTimerRef.current = null
          }
          if (state.phase !== 'completed' && state.phase !== 'interrupted' && state.phase !== 'failed') {
            clearModelRequest()
          }
          setContextCompaction(state)
          if (state.phase === 'completed') {
            contextCompactionClearTimerRef.current = setTimeout(() => {
              contextCompactionClearTimerRef.current = null
              setContextCompaction(current => current?.id === state.id ? null : current)
            }, 3500)
          }
          if (state.phase === 'interrupted' || state.phase === 'failed') {
            showRunControlHint(state.error || tRef.current('ui.compaction.detail'))
          }
          convManager.scheduleSave()
          markActivity(state.updatedAt)
          break
        }
        case 'notification':
          notificationCoordinator.raise({
            id: `engine:${event.level}:${event.message}`,
            category: event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : event.level === 'success' ? 'turn-complete' : 'info',
            title: event.message,
            sourceId: `${event.level}:${event.message}`,
          })
          syncNotificationSnapshot()
          if (event.level === 'warning' || event.level === 'error') {
            appendMessages([{ id: genMsgId(), role: 'system', content: event.message }], { forceLatest: true, dedupeTail: true })
          } else {
            appendMessages([{ id: genMsgId(), role: 'assistant', content: event.message, progress: true }], { forceLatest: true, dedupeTail: true })
            showRunControlHint(event.message)
          }
          break
        case 'model:protocol':
          if (event.phase === 'fallback') {
            appendMessages([{
              id: genMsgId(),
              role: 'system',
              content: tRef.current('ui.app.protocolFallback', {
                message: event.message || tRef.current('ui.app.protocolMismatch'),
                url: event.url,
              }),
            }], { forceLatest: true })
          }
          break
        case 'error':
          engineErrorMessageRef.current = event.error
          clearModelRequest()
          streamBufferRef.current.reset()
          streamDisplayBufferRef.current = ''
          streamThinkingBufferRef.current = ''
          streamThinkingStartedAtRef.current = undefined
          setStreamThinkingStartedAt(undefined)
          clearStreamFlushTimer()
      setStreamText('')
      setStreamThinkingText('')
      appendMessages([{ id: genMsgId(), role: 'system', content: tRef.current('common.error', { message: event.error }) }])
          notificationCoordinator.raise({
            id: `run-error:${Date.now()}`,
            category: 'error',
            title: tRef.current('ui.app.runFailed'),
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
      unsub()
    }
  }, [engine, convManager, flowBridge, beginModelRequest, markModelResponseStarted, finishModelRequest, clearModelRequest, clearTerminalCompactionForRequest, appendMessages, replaceMessages, setComposedInput, markActivity, showRunControlHint, genMsgId, noFlickerActive, dismissPendingAsk, schedulePendingAsk, notificationCoordinator, syncNotificationSnapshot, streamScheduler, terminalLatencyTracker, flowFeatures.streamScheduler])

  useEffect(() => () => {
    clearStreamFlushTimer()
    clearModelRequestResultTimer()
    if (contextCompactionClearTimerRef.current) clearTimeout(contextCompactionClearTimerRef.current)
    if (runControlHintTimerRef.current) clearTimeout(runControlHintTimerRef.current)
    void runtime.destroy().catch(() => {}).finally(() => {
      engine.setEventRecorder(null)
      convManager.destroy()
    })
  }, [runtime, engine, convManager, clearStreamFlushTimer, clearModelRequestResultTimer])

  const loadConversationEntries = useCallback(async (): Promise<ConversationEntry[]> => {
    const convs = await convManager.listAsync()
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
    pendingPastesRef.current = retainPendingPastes(draftText, state?.draft?.pendingPastes ?? [])
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

  const reportGlobalCommandError = useCallback((command: string, error: unknown) => {
    showRunControlHint(t('ui.app.commandFailed', {
      command,
      message: error instanceof Error ? error.message : String(error),
    }))
  }, [showRunControlHint, t])

  const openConversationHistory = useCallback(async (): Promise<void> => {
    try {
      await globalCommandActivityController.run(
        '/resume',
        t('ui.app.loadingConversations'),
        async () => {
          setConversationEntries(await loadConversationEntries())
          setConvListRevision(revision => revision + 1)
          push('history')
        },
      )
    } catch (error) {
      reportGlobalCommandError('/resume', error)
    }
  }, [globalCommandActivityController, loadConversationEntries, push, reportGlobalCommandError, t])

  const selectConversation = useCallback(async (id: string): Promise<void> => {
    pop()
    try {
      await globalCommandActivityController.run(
        '/resume',
        t('ui.app.restoringConversation'),
        async () => {
          const conv = await convManager.switchToAsync(id)
          if (!conv) throw new Error(t('ui.app.conversationUnavailable'))
          restoreCliStateFromTurns(
            conv.activeTurns ?? conv.turns,
            '',
            conv.contextSegments ?? [],
            conv.contextReservoir ?? [],
            conv.turns,
            { restoreEngine: false },
          )
          setContextCompaction(conv.contextCompactionState ?? null)
          restoreInteractionState(conv.interactionState)
        },
      )
    } catch (error) {
      reportGlobalCommandError('/resume', error)
    }
  }, [convManager, globalCommandActivityController, pop, reportGlobalCommandError, restoreCliStateFromTurns, restoreInteractionState, t])

  const deleteSavedConversation = useCallback(async (id: string): Promise<void> => {
    try {
      await globalCommandActivityController.run(
        '/resume',
        t('ui.app.deletingConversation'),
        async () => {
          if (!await convManager.deleteAsync(id)) throw new Error(t('ui.app.conversationUnavailable'))
          setConversationEntries(await loadConversationEntries())
          setConvListRevision(revision => revision + 1)
        },
      )
    } catch (error) {
      reportGlobalCommandError('/resume', error)
    }
  }, [convManager, globalCommandActivityController, loadConversationEntries, reportGlobalCommandError, t])

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
    if (flowBridge.isForegroundBusy() || engine.isRunning() || engine.isContextCompacting() || runPromptRef.current === null) return
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
    if (flowBridge.isForegroundBusy() || engine.isRunning() || engine.isContextCompacting()) {
      flowBridge.enqueueInput({ id: queuedMessageId ?? genMsgId(), prompt, attachments })
      showRunControlHint(t('ui.flow.input.queued', { count: flowBridge.getQueuedInputs().length }))
      return
    }

    const userMessageId = queuedMessageId ?? genMsgId()
    lastAssistantTurnInterruptedRef.current = false
    engineErrorMessageRef.current = null
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
    clearTerminalCompactionForRequest()
    beginModelRequest()
    flowBridge.startRun(prompt)
    setMood('thinking')
    streamBufferRef.current.reset()
    streamDisplayBufferRef.current = ''
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
      clearModelRequest()
      const bufferedStreamText = streamBufferRef.current.toString()
      const bufferedThinkingText = streamThinkingBufferRef.current
      const thinkingStartedAt = streamThinkingStartedAtRef.current
      const visibleInterruptedText = stripTextToolCallMarkup(bufferedStreamText, { stripIncomplete: true })
      const toolsSnapshot = currentToolsRef.current
      const changesSnapshot = changeSummariesRef.current
      const interrupted = abortingRef.current || e?.aborted === true || /aborted/i.test(String(e?.message || ''))
      const errorMessage = String(e?.message || e)
      const engineAlreadyReportedError = engineErrorMessageRef.current === errorMessage
      runOutcome = interrupted ? 'interrupted' : 'failed'
      runError = interrupted ? undefined : errorMessage
      streamBufferRef.current.reset()
      streamDisplayBufferRef.current = ''
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
      } else if (!engineAlreadyReportedError) {
        appendMessages([{ id: genMsgId(), role: 'system', content: t('common.error', { message: errorMessage }) }])
      }
      updateCurrentTools(() => [])
      updateChangeSummaries(() => [])
      setMood(abortingRef.current ? 'idle' : 'error')
      if (!abortingRef.current) setTimeout(() => setMood('idle'), 4000)
    } finally {
      activePromptRef.current = null
      engineErrorMessageRef.current = null
      flowBridge.finishRun(runOutcome, runError)
      abortingRef.current = false
      abortRestoredPromptRef.current = false
      if (flowBridge.getQueuedInputs().length > 0) setTimeout(runNextQueuedPrompt, 0)
    }
    if (singleShot) exit()
  }, [appendMessages, engine, singleShot, config, beginModelRequest, clearTerminalCompactionForRequest, clearModelRequest, clearStreamFlushTimer, exit, runNextQueuedPrompt, genMsgId, showRunControlHint, modelDiscoveryStatus.isRefreshing, t, dismissPendingAsk, notificationCoordinator, syncNotificationSnapshot, convManager, flowBridge])

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

  const handlePasteText = useCallback((pastedText: string, nextValue: string, insertionStart: number) => {
    if (Array.from(pastedText).length > LARGE_PASTE_CHAR_THRESHOLD) {
      const placeholder = createPendingPastePlaceholder(pastedText, pendingPastesRef.current)
      const replacedValue = replacePastedText(nextValue, pastedText, insertionStart, placeholder)
      if (replacedValue !== nextValue) {
        pendingPastesRef.current = [...pendingPastesRef.current, { placeholder, text: pastedText }]
        return { value: replacedValue, cursorOffset: insertionStart + placeholder.length }
      }
    }
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

    if (flowBridge.isForegroundBusy() || engine.isRunning() || engine.isContextCompacting()) {
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

  const executeRegisteredCommand = useCallback(async (input: string, ctx: CommandContext): Promise<void> => {
    const progress = commandRegistry.getProgress(input)
    const command = `/${progress?.name ?? commandRegistry.parse(input)?.name ?? input.replace(/^\//, '')}`
    try {
      const execute = () => commandRegistry.executeAsync(input, ctx)
      const result = progress
        ? await globalCommandActivityController.run(command, t('ui.app.executingCommand'), execute)
        : await execute()
      flowBridge.updateUsage(engine.getContextUsage())
      setGitState(engine.getGitState())
      switch (result.type) {
        case 'text':
          appendMessages([{ id: genMsgId(), role: 'system', content: result.text! }])
          break
        case 'prompt':
          void runPrompt(result.prompt!)
          break
        case 'jsx':
        case 'none':
          break
      }
    } catch (error) {
      reportGlobalCommandError(command, error)
    }
  }, [appendMessages, engine, flowBridge, genMsgId, globalCommandActivityController, reportGlobalCommandError, runPrompt, t])

  const handleSubmit = useCallback((value: string) => {
    const submittedValue = expandPendingPastes(value, pendingPastesRef.current)
    const trimmed = submittedValue.trim()
    if (!trimmed) return submittedValue
    terminalLatencyTracker.noteSubmit()
    const isCommand = commandRegistry.isCommand(trimmed)
    const recoveryCommand = isPersistenceRecoveryCommand(trimmed)
    if (!convManager.isPersistenceHealthy() && !recoveryCommand) {
      showRunControlHint(t('ui.app.persistenceBlocked'))
      return submittedValue
    }
    const pendingDraftAttachments = draftAttachmentsRef.current
    pendingPastesRef.current = []
    inputRef.current = ''
    setInput('')
    draftAttachmentsRef.current = []
    setDraftAttachments([])

    if (isCommand && (flowBridge.isForegroundBusy() || engine.isRunning()) && !recoveryCommand) {
      runPrompt(trimmed, pendingDraftAttachments)
      return submittedValue
    }

    if (flowBridge.isForegroundBusy() || engine.isRunning()) {
      const steeringMessageId = genMsgId()
      if (pendingDraftAttachments.length === 0 && engine.submitSteeringMessage(trimmed, steeringMessageId)) {
        setLastActivity(Date.now())
        return submittedValue
      }
      runPrompt(trimmed, pendingDraftAttachments)
      return submittedValue
    }

    if (isCommand) {
      if (trimmed === '/model') {
        push('modelPicker')
        return submittedValue
      }
      if (trimmed === '/effort') {
        const capability = getModelReasoningCapabilities(config.model, config.provider, config.modelCapabilities)
        const adjustable = capability && capability.control !== 'fixed'
          && (capability.efforts.length > 0 || capability.supportsToggle || capability.control === 'budget')
        if (adjustable) {
          push('effortPicker')
          return submittedValue
        }
      }
      if (trimmed === '/resume') {
        void openConversationHistory()
        return submittedValue
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
      void executeRegisteredCommand(trimmed, ctx)
      return submittedValue
    }
    const resolved = resolveImagePrompt(trimmed, workspacePath, { existingAttachments: pendingDraftAttachments, t })
    for (const warning of resolved.warnings) {
      appendMessages([{ id: genMsgId(), role: 'system', content: warning }])
    }
    runPrompt(resolved.prompt, resolved.attachments)
    return submittedValue
  }, [appendMessages, config, convManager, engine, executeRegisteredCommand, exit, mcpClient, modelPresets, openConversationHistory, persistConfig, push, restoreCliStateFromTurns, runPrompt, runtime.runtimeTaskManager, skillRuntime, t, workspacePath, genMsgId, notificationCoordinator, clearResultInbox, terminalLatencyTracker, showRunControlHint, flowFeatures, flowBridge])

  const handleAlternateSubmit = useCallback((value: string) => {
    if (!flowBridge.isForegroundBusy() && !engine.isRunning()) {
      return handleSubmit(value)
    }
    const submittedValue = expandPendingPastes(value, pendingPastesRef.current)
    const trimmed = submittedValue.trim()
    if (!trimmed) return submittedValue
    terminalLatencyTracker.noteSubmit()
    if (!convManager.isPersistenceHealthy()) {
      showRunControlHint(t('ui.app.persistenceBlocked'))
      return submittedValue
    }
    const attachments = draftAttachmentsRef.current
    pendingPastesRef.current = []
    inputRef.current = ''
    setInput('')
    draftAttachmentsRef.current = []
    setDraftAttachments([])
    runPrompt(trimmed, attachments)
    return submittedValue
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
      void openConversationHistory()
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
  const reasoningActive = Boolean(reasoningLabel && reasoningLabel !== 'off' && isRunning && runState.phase === 'thinking' && streamThinkingStartedAt !== undefined)
  const conversationFrameWidth = Math.max(24, cockpit.contentWidth - 2)

  const runningNode = (isRunning || modelRequestStatus || contextCompaction || subAgentActivities.length > 0 || queuedPrompts.length > 0) ? (
    <Box flexDirection="column" marginBottom={1}>
      {!noFlickerActive && <SubAgentProgressLine activities={subAgentActivities} />}
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
        idleLabel={isRunning && runState.phase === 'thinking' && !visibleStreamText && currentTools.length === 0 && !pendingAsk ? t('ui.activity.phase.waitingOutput') : null}
        requestStatus={modelRequestStatus}
        compaction={contextCompaction}
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
      conversations={conversationEntries}
      onSelect={(id) => { void selectConversation(id) }}
      onDelete={(id) => { void deleteSavedConversation(id) }}
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
      onRefresh={() => {
        void globalCommandActivityController.run(
          '/model',
          t('ui.app.refreshingModels'),
          () => loadModelPresets(config, true),
        ).catch(error => reportGlobalCommandError('/model', error))
      }}
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
  const showPrompt = !singleShot && activeOverlay === null && !cursorMode && !askModalVisible && !globalCommandActivity
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
  const globalActivityNode = globalCommandActivity ? (
    <Box paddingLeft={1} flexShrink={0}>
      <Text color="cyan">{t('ui.app.commandActivity', {
        detail: globalCommandActivity.detail,
      })}</Text>
    </Box>
  ) : null
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
  const staticTranscriptItems = useMemo<StaticTranscriptItem[]>(() => {
    const items: StaticTranscriptItem[] = [{ kind: 'header', id: 'startup-header' }]
    items.length += staticItemOffset
    for (const message of messages) {
      if (!isTranscriptTrimNotice(message)) items.push({ kind: 'message', id: message.id, message })
    }
    return items
  }, [messages, staticItemOffset])
  const taskFlowNode = (
    <TaskFlowHud
      task={isRunning ? activeTask : null}
      objective={isRunning ? activeObjective?.prompt : null}
      isRunning={isRunning}
      runState={runState}
      tools={currentTools}
      draft={streamingToolDraft}
      queuedCount={queuedPrompts.length}
      width={conversationFrameWidth}
    />
  )
  const mcpCount = mcpClient.getAllConnections().filter(connection => connection.status === 'connected').length
  const activeTerminalCount = terminalSessions.filter(session => session.status === 'running' || session.status === 'starting').length
  const landingFrameWidth = resolveLandingFrameWidth(terminal.columns)
  const showLandingView = shouldShowLandingView({
    messageCount: messages.length,
    isRunning: developerFlowActive,
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
                <SessionPane>
                  {overlayNode ?? (
                    <Box flexDirection="column" flexBasis={0} flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
                      {transcriptNode}
                      {pendingAskNode}
                    </Box>
                  )}
                </SessionPane>
                <Box flexDirection="column" flexShrink={0} backgroundColor={layoutBackground} paddingX={1}>
                  {cursorHint}
                  {globalActivityNode}
                  <AgentActivityLine active={developerFlowActive} persistent width={conversationFrameWidth} />
                  {promptNode}
                  {taskFlowNode}
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
                  queuedCount={queuedPrompts.length}
                  terminals={terminalSessions}
                  mcpCount={mcpCount}
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
        {globalActivityNode}
        {promptNode}
        {taskFlowNode}
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
        <AgentActivityLine active={developerFlowActive} />
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
