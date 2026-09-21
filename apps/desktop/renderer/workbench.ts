import { workbenchShellMarkup } from './workbenchShell'
import { RenderScheduler, RenderLifetime } from '@turboflux/renderer'
import { TranscriptIndex } from '@turboflux/presentation'
import {
  isBuiltInBrowserTool,
  isBuiltInComputerTool,
  stripTextToolCallMarkup,
  applyConversationViewEvent,
  applyConversationViewSnapshot,
  type ConversationViewState,
  type ThinkingTrace,
} from '@turboflux/presentation'
import type {
  AgentAttachment,
  AgentCapabilityReference,
  AgentCapabilitySelection,
  AgentTurn,
  AnyConversationEvent,
  ApprovalPolicy,
  BrowserSystemEvent,
  BrowserSystemSnapshot,
  BrowserViewportMode,
  ChangeSummary,
  ToolCall,
  ToolResult,
  WorkbenchArtifactPreview,
  WorkbenchCommandResult,
  WorkbenchFileReference,
  WorkbenchPendingPaste,
  WorkbenchSnapshot,
  WorkStepControlAction,
  WorkflowSurfaceSpec,
} from '@turboflux/workbench'
import type { DesktopWorkbenchEvent as WorkbenchEvent, DesktopWorkbenchSnapshot } from '../desktopTypes'
import type { AutomationNotificationNavigationIntent } from '../automationNotificationNavigation'
import { projectHistoryRewrite } from '../historyRewrite'
import {
  createThinkingBlock,
  createToolActivity,
  isInternalRuntimeTool,
  renderDiffPreview,
  renderMarkdown,
} from '@turboflux/renderer/richContent'
import { describeRuntimeTask } from './runtimeTaskPresentation'
import { createSettingsCenter, createSettingsUpdate } from './settingsCenter'
import { createAutomationsView } from './automationsView'
import { createUserProfile } from './userProfile'
import type { DesktopUserProfile } from '../desktopTypes'
import { profileAvatarMarkup, profileColor, profileGreeting } from './profileIdentity'
import { reasoningBudgetLabel, reasoningEffortLabel, reasoningTone } from './reasoningPresentation'
import { createCommandPalette } from './commandPalette'
import { createComputerControls } from './computerControls'
import { playTaskCompletionChime, primeTaskCompletionChime } from './taskCompletionChime'
import { modelProviderMark, normalizedModelProvider } from './modelPresentation'
import { createImageLightbox, type ImageLightbox, type ImageLightboxItem } from './imageLightbox'
import { renderVisualEvidence, visualEvidenceItems } from './visualEvidence'
import {
  conversationRenderSignature,
  hasRenderableTurnPayload,
  isHistoryRewriteUserTurn,
  isLegacyRecoveryPlaceholder,
  isInternalRequestErrorTurn,
  latestConversationFailure,
  presentDesktopError,
} from './conversationRendering'
import {
  executionOutcomeFromWorkRunStatus,
} from '@turboflux/renderer/executionPresentation'
import { completedTaskTurnDuration, presentWorkRun, selectProjectedWorkRun } from './workExecutionPresentation'
import {
  createTaskFlowProjection,
  projectTaskFlowSnapshot,
  taskFlowNodeIdForTool,
  taskFlowNodeIdForTurn,
  type TaskFlowProjectionState,
} from './taskFlowProjection'
import { NEW_TASK_TITLE, taskDisplayTitle, visibleTaskConversations } from '../conversationPolicy'
import { contextUsageTokenCount } from '../contextUsageRecovery'
import {
  INSPECTOR_MINIMUM_WIDTH,
  clampInspectorWidth as clampInspectorWidthValue,
  defaultInspectorWidth as defaultInspectorWidthValue,
  inspectorDismissTriggerX,
  inspectorDragWidthMode,
  inspectorWidthFromKey,
  inspectorWidthFromRatio,
  inspectorWidthRatio,
  maximumInspectorWidth as maximumInspectorWidthValue,
  shouldDismissInspectorAtPointer,
  type InspectorWidthMode,
} from './inspectorResize'
import { shouldPlayTaskCompletionSound } from '../taskCompletionSound'
import {
  adjacentInspectorTabId,
  inspectorTabLayout,
  reorderInspectorTabIds,
} from './inspectorTabs'
import {
  renderActivityPanel,
  renderContextPanel,
  renderGitPanel,
} from './workbenchPanels'
import {
  createTranscriptFollowState,
  forceTranscriptFollow,
  historyRewriteLeadingSpace,
  historyRewriteTailSpace,
  suspendTranscriptFollow,
  transcriptDistanceFromBottom,
  updateTranscriptFollowFromScroll,
} from './transcriptFollow'
import {
  createFallbackLinearMessage,
  createLinearTaskFlowRenderer,
} from '@turboflux/renderer/linearTaskFlow'
import { createWorkPlanDockRenderer } from '@turboflux/renderer/workPlanPresentation'
import { SerializedAsyncQueue, SingleFlightGuard } from './interactionConcurrency'
import { projectWorkspaceConversationGroups, UNGROUPED_WORKSPACE_KEY } from './workspaceConversationProjection'
import { composerPopoverPlacement } from './composerPopoverPlacement'
import { createTerminalPanel } from './terminalPanel'
import { presentComposerRunButton, type ComposerRunButtonPresentation } from './composerRunButton'
import { openWorkspaceDialog } from './workspaceDialog'
import {
  activeConversationNavigatorIndices,
  compactConversationNavigatorText,
  conversationNavigatorMinimumItems,
  conversationNavigatorMarkerVisual,
  pairConversationNavigatorTasks,
} from './conversationNavigator'
import { icon, approvalPolicyIcon } from './workbenchIcons'

type InspectorTab = 'activity' | 'outputs' | 'browser' | 'context' | 'git'
type InspectorPanelTab = {
  id: string
  kind: 'module' | 'browser' | 'artifact' | 'change'
  inspectorTab: InspectorTab
  title: string
  iconName: string
  isPreview?: boolean
  browserTabId?: string
  artifactId?: string
  change?: ChangeSummary
}

const INSPECTOR_PRIMARY_NAVIGATION: ReadonlyArray<{ tab: InspectorTab; label: string; iconName: string }> = [
  { tab: 'browser', label: '浏览器', iconName: 'browser' },
]

const INSPECTOR_UTILITY_NAVIGATION: ReadonlyArray<{ tab: InspectorTab; label: string; iconName: string }> = [
  { tab: 'context', label: '上下文', iconName: 'context' },
  { tab: 'git', label: '版本', iconName: 'git' },
]

const capabilityNameOverrides: Readonly<Record<string, string>> = {
  'office-workagent': '办公任务总控',
}

function capabilityDisplayName(capability: AgentCapabilityReference): string {
  return capabilityNameOverrides[capability.id] || capability.name || capability.id
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

export function mountWorkbench(app: HTMLDivElement): () => void {
  const lifetime = new RenderLifetime()
  const renderer = new RenderScheduler(undefined, error => console.error('Workbench render failed', error))
  lifetime.add(() => renderer.dispose())
  const platform = navigator.platform || navigator.userAgent
  document.documentElement.classList.toggle('platform-macos', /Mac/i.test(platform))
  app.innerHTML = workbenchShellMarkup(INSPECTOR_UTILITY_NAVIGATION)

  const bridge = window.turbofluxDesktop
  const shell = app.querySelector<HTMLDivElement>('.desktop-shell')!
  const sidebarToggle = app.querySelector<HTMLButtonElement>('#sidebar-toggle')!
  const workbenchSurface = app.querySelector<HTMLDivElement>('.workbench-surface')!
  const breadcrumb = app.querySelector<HTMLElement>('#breadcrumb')!
  const breadcrumbTitle = app.querySelector<HTMLElement>('#breadcrumb-title')!
  const mainScroll = app.querySelector<HTMLDivElement>('#main-scroll')!
  const productView = app.querySelector<HTMLElement>('#product-view')!
  const newTaskButton = app.querySelector<HTMLButtonElement>('#new-task')!
  const taskInput = app.querySelector<HTMLTextAreaElement>('#task-input')!
  const transcript = app.querySelector<HTMLElement>('#transcript')!
  const conversationNavigator = app.querySelector<HTMLElement>('#conversation-navigator')!
  const conversationNavigatorMarkers = app.querySelector<HTMLElement>('#conversation-navigator-markers')!
  const conversationNavigatorPopover = app.querySelector<HTMLElement>('#conversation-navigator-popover')!
  const conversationNavigatorPopoverTitle = app.querySelector<HTMLElement>('#conversation-navigator-popover-title')!
  const conversationNavigatorPopoverSummary = app.querySelector<HTMLElement>('#conversation-navigator-popover-summary')!
  const workPlanDock = app.querySelector<HTMLElement>('#work-plan-dock')!
  const workPlanToggle = app.querySelector<HTMLButtonElement>('#work-plan-toggle')!
  const toast = app.querySelector<HTMLDivElement>('#toast')!
  const runButton = app.querySelector<HTMLButtonElement>('#run-button')!
  const recoveryBanner = app.querySelector<HTMLElement>('#recovery-banner')!
  const draftTray = app.querySelector<HTMLElement>('#draft-tray')!
  const capabilityTray = app.querySelector<HTMLElement>('#composer-capability-tray')!
  const composerCard = app.querySelector<HTMLElement>('#composer-card')!
  const composerAddButton = app.querySelector<HTMLButtonElement>('#composer-add')!
  const capabilityMenu = app.querySelector<HTMLElement>('#capability-menu')!
  const reasoningTab = app.querySelector<HTMLButtonElement>('#reasoning-tab')!
  const approvalPill = app.querySelector<HTMLButtonElement>('#approval-pill')!
  const approvalIcon = app.querySelector<HTMLElement>('#approval-icon')!
  const composerMenu = app.querySelector<HTMLElement>('#composer-menu')!
  const approvalMenu = app.querySelector<HTMLElement>('#approval-menu')!
  const inspectorPanel = app.querySelector<HTMLElement>('#inspector-panel')!
  const inspectorResizeHandle = app.querySelector<HTMLElement>('#inspector-resize-handle')!
  const inspectorContent = app.querySelector<HTMLDivElement>('#inspector-content')!
  const inspectorToggle = app.querySelector<HTMLButtonElement>('#inspector-toggle')!
  const terminalToggle = app.querySelector<HTMLButtonElement>('#terminal-toggle')!
  const terminalPanelElement = app.querySelector<HTMLElement>('#terminal-panel')!
  const mainPanel = app.querySelector<HTMLElement>('#main-panel')!
  const inspectorTabs = app.querySelector<HTMLElement>('#inspector-tabs')!
  const inspectorBrowserActivity = app.querySelector<HTMLElement>('#inspector-browser-activity')!
  const inspectorBrowserNewTab = app.querySelector<HTMLButtonElement>('#inspector-browser-new-tab')!
  const inspectorModuleMenuToggle = app.querySelector<HTMLButtonElement>('#inspector-module-menu-toggle')!
  const inspectorModuleMenu = app.querySelector<HTMLElement>('#inspector-module-menu')!
  const inspectorExpand = app.querySelector<HTMLButtonElement>('#inspector-expand')!
  const sidebarCollapsedStorageKey = 'turboflux.sidebar.collapsed:v1'
  const workPlanHiddenStorageKey = 'turboflux.work-plan.hidden:v1'
  const composerActionGuard = new SingleFlightGuard()
  const draftRecordQueue = new SerializedAsyncQueue()
  const conversationNavigationGuard = new SingleFlightGuard()
  let currentSnapshot: WorkbenchSnapshot | null = null
  let pendingSnapshotPaint: { conversationChanged: boolean; firstSnapshot: boolean; renderConversation: boolean } | null = null
  let closeSidebarMenu: ((restoreFocus?: boolean) => void) | null = null
  let workflowSurface: HTMLElement | null = null
  let workflowSurfaceRequestId = ''
  let workflowSurfaceReturnFocus: HTMLElement | null = null
  let currentMainView: 'workbench' | 'automations' = 'workbench'
  let currentInspectorTab: InspectorTab = 'activity'
  let inspectorPanelTabs: InspectorPanelTab[] = []
  let activeInspectorPanelTabId: string | null = null
  let inspectorUserFullWidth = false
  let selectedArtifactId: string | null = null
  let selectedWorkRunId: string | null = null
  const artifactPreviewCache = new Map<string, WorkbenchArtifactPreview>()
  const artifactThumbnailCache = new Map<string, Promise<WorkbenchArtifactPreview>>()
  const attachmentPreviewCache = new Map<string, Promise<{ mode: 'image'; dataUrl: string }>>()
  const attachmentThumbnailCache = new Map<string, Promise<{ mode: 'image'; dataUrl: string }>>()
  const pendingAttachmentThumbnails = new WeakMap<HTMLElement, { image: HTMLImageElement; path: string }>()
  const attachmentThumbnailObserver = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const host = entry.target as HTMLElement
          const pending = pendingAttachmentThumbnails.get(host)
          attachmentThumbnailObserver?.unobserve(host)
          pendingAttachmentThumbnails.delete(host)
          if (pending) void loadAttachmentThumbnailNow(host, pending.image, pending.path)
        }
      }, { root: transcript, rootMargin: '240px 0px' })
  let artifactPreviewLoading = false
  let imageLightbox: ImageLightbox | null = null
  let canonicalTaskFlowForce = false
  let submissionPending = false
  let submissionPauseRequested = false
  let activeTaskStartedAt = 0
  let projectedWorkRunId = ''
  let taskFlowProjection: TaskFlowProjectionState | null = null
  let conversationView: ConversationViewState | null = null
  const transcriptIndex = new TranscriptIndex()
  const liveTurnCache = transcriptIndex.turns
  const workPlanDockRenderer = createWorkPlanDockRenderer(workPlanDock)

  function renderProjectedWorkPlan() {
    const execution = currentSnapshot?.activity.execution
    workPlanDockRenderer.render(execution ? selectProjectedWorkRun(execution, projectedWorkRunId) : undefined)
  }
  const linearTaskFlowRenderer = createLinearTaskFlowRenderer(transcript, {
    createInput: node => {
      const turn = (node.turnId ? liveTurnCache.get(node.turnId) : undefined)
        || currentSnapshot?.conversation.turns.find(candidate => candidate.id === node.turnId)
      if (turn && isInternalRequestErrorTurn(turn)) return null
      return turn
        ? createMessageElement(turn, collectToolResults(currentSnapshot?.conversation.turns || []), false, true, false, false)
          || createFallbackLinearMessage(node, 'user')
        : createFallbackLinearMessage(node, 'user')
    },
    createAnswer: (node, presentation) => {
      const turn = (node.turnId ? liveTurnCache.get(node.turnId) : undefined)
        || currentSnapshot?.conversation.turns.find(candidate => candidate.id === node.turnId)
      if (turn && isInternalRequestErrorTurn(turn)) return null
      return turn
        ? createMessageElement(
            turn,
            collectToolResults(currentSnapshot?.conversation.turns || []),
            false,
            presentation.finalDelivery,
            false,
            false,
            presentation.finalDelivery && currentSnapshot?.activity.execution.runs.find(run => run.id === node.runId)?.responseMode !== 'task',
          )
          || createFallbackLinearMessage(node, 'assistant')
        : createFallbackLinearMessage(node, 'assistant')
    },
    updateAnswer: (row, node, presentation) => {
      const turn = (node.turnId ? liveTurnCache.get(node.turnId) : undefined)
        || currentSnapshot?.conversation.turns.find(candidate => candidate.id === node.turnId)
      if (turn && (isInternalRequestErrorTurn(turn) || turn.metadata?.attachments?.length)) return false
      const content = row.querySelector<HTMLElement>('.message-content')
      const visibleContent = stripTextToolCallMarkup(turn?.content ?? node.content, { stripIncomplete: true }).trim()
      if (!content || !visibleContent) return false
      row.classList.remove('streaming')
      renderMarkdown(content, visibleContent)
      if (!turn) return true
      row.dataset.turnId = turn.id
      row.dataset.timestamp = String(turn.timestamp)
      const previousMeta = row.querySelector('.message-meta')
      if (presentation.finalDelivery) {
        const includeUsage = currentSnapshot?.activity.execution.runs.find(run => run.id === node.runId)?.responseMode !== 'task'
        const meta = createMessageMeta(turn, visibleContent, row, includeUsage)
        if (previousMeta) previousMeta.replaceWith(meta)
        else row.append(meta)
      } else previousMeta?.remove()
      return true
    },
    resolveTool: node => {
      const call = liveToolCalls.get(node.callId || '')
        || {
          id: node.callId || node.id.replace(/^tool:/, ''),
          name: node.toolName || node.content || 'tool',
          arguments: typeof node.detail === 'string' && node.detail.trim().startsWith('{')
            ? (() => { try { return JSON.parse(node.detail) as Record<string, unknown> } catch { return {} } })()
            : {},
        }
      const result = liveToolResults.get(call.id)
      return {
        call,
        result,
        onOpenBrowser: isBuiltInBrowserTool(call.name)
          ? () => void openBrowserExecution(call.id)
          : undefined,
        onPreviewDiff: change => openChangeInspectorTab(change),
        createImagePreview: attachment => createToolImagePreview(attachment),
      }
    },
    resolveTurn: turnId => liveTurnCache.get(turnId)
      || currentSnapshot?.conversation.turns.find(turn => turn.id === turnId),
    resolveRun: runId => currentSnapshot?.activity.execution.runs.find(run => run.id === runId),
    nodeVersion: node => String(node.callId
      ? transcriptIndex.toolVersion(node.callId)
      : node.turnId ? transcriptIndex.turnVersion(node.turnId) : 0),
  })
  let draftTimer: number | null = null
  let draftAttachments: AgentAttachment[] = []
  let draftFiles: WorkbenchFileReference[] = []
  let pendingPastes: WorkbenchPendingPaste[] = []
  let draftCapabilities: AgentCapabilityReference[] = []
  let snapshotRefreshTimer: number | null = null
  let snapshotRefreshInFlight = false
  let snapshotRefreshPending = false
  let renderedConversationSignature = ''
  let renderedConversationListSignature = ''
  const workspaceTaskQuery = ''
  let expandedWorkspaceTaskGroups = new Set<string>()
  let currentWorkspaceTaskGroupKey = ''
  const workspaceGroupExpansionStorageKey = 'turboflux.workspace-groups.expansion'
  let workspaceGroupExpansion: Record<string, boolean> = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(workspaceGroupExpansionStorageKey) || '{}')
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, boolean> : {}
    } catch {
      return {}
    }
  })()
  let browserSnapshot: BrowserSystemSnapshot | null = null
  let lastAutoOpenedBrowserToolCallId = ''
  let browserVisibleBeforeFullScreen = false
  let browserInspectorOpenBeforeFullScreen = false
  let fullScreenSurfaceDepth = 0
  let browserBoundsFrame: number | null = null
  let inspectorChromeResizeFrame: number | null = null
  const liveToolCalls = transcriptIndex.calls
  const liveToolResults = transcriptIndex.results
  let pendingOptimisticUserElement: HTMLElement | null = null
  let pendingOptimisticUserPrompt = ''
  let pendingOptimisticInputId = ''
  let editingTurnId = ''
  let pendingConversationRender = false
  let resendingTurnId = ''
  let historyRewriteRevision = 0
  let historyRewriteOptimisticTurn: AgentTurn | null = null
  let pendingConversationNavigationId = ''
  let conversationTransitionKind: 'switch' | 'new' | null = null
  let conversationTransitionTargetId = ''
  let conversationTransitionSource: HTMLElement | null = null
  let conversationTransitionSequence = 0
  let activeConversationTransitionId = 0
  let conversationTransitionSettleTimer: number | null = null
  let conversationTransitionFrame: number | null = null
  let workbenchDialogSequence = 0
  let activeWorkbenchDialog: { focus(): void } | null = null
  let historyRewriteAnchorTurnId = ''
  let historyRewriteLeadingSpacer: HTMLElement | null = null
  let historyRewriteSpacer: HTMLElement | null = null
  let automationsView: ReturnType<typeof createAutomationsView> | undefined
  let transcriptFollowState = createTranscriptFollowState(transcript)
  let transcriptScrollFrame: number | null = null
  let transcriptPointerScrolling = false
  let transcriptWheelScrolling = false
  let transcriptWheelTimer: number | null = null
  let conversationNavigatorSyncFrame: number | null = null
  let conversationNavigatorActiveIndex = -1
  let conversationNavigatorScrub: { pointerId: number; index: number; moved: boolean } | null = null
  let conversationNavigatorSuppressClick = false
  let conversationNavigatorEntries: Array<{
    marker: HTMLButtonElement
    target: HTMLElement
    offsetTop: number
    title: string
    summary: string
  }> = []
  const expandedTaskRunIds = new Set<string>()
  const taskRunSeenActiveIds = new Set<string>()
  let taskFoldingConversationId = ''
  const inspectorWidthStorageKey = 'turboflux.inspector.right-panel-width:v3'
  let regularInspectorWidthRatio = inspectorWidthRatio(
    defaultInspectorWidthValue(inspectorMainContentWidth(), window.innerHeight),
    inspectorMainContentWidth(),
  )
  let browserLayoutMode: BrowserViewportMode = 'portrait'

  function setSidebarCollapsed(collapsed: boolean, persist = true) {
    shell.classList.toggle('sidebar-collapsed', collapsed)
    sidebarToggle.setAttribute('aria-pressed', String(collapsed))
    sidebarToggle.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏')
    sidebarToggle.title = collapsed ? '展开侧栏' : '折叠侧栏'
    sidebarToggle.innerHTML = icon(collapsed ? 'sidebarExpand' : 'sidebarCollapse')
    if (persist) {
      try { window.localStorage.setItem(sidebarCollapsedStorageKey, String(collapsed)) } catch {}
    }
  }

  let initialSidebarCollapsed = false
  try { initialSidebarCollapsed = window.localStorage.getItem(sidebarCollapsedStorageKey) === 'true' } catch {}
  shell.classList.add('sidebar-state-initializing')
  setSidebarCollapsed(initialSidebarCollapsed, false)
  lifetime.frame(() => shell.classList.remove('sidebar-state-initializing'))

  function updateWorkPlanToggleState() {
    const available = mainPanel.classList.contains('has-conversation')
      && currentMainView === 'workbench'
      && !shell.classList.contains('inspector-open')
    const hidden = shell.classList.contains('work-plan-hidden')
    const visible = available && !hidden
    workPlanToggle.hidden = !available
    workPlanToggle.classList.toggle('active', visible)
    workPlanToggle.setAttribute('aria-pressed', String(visible))
    workPlanToggle.title = hidden ? '显示任务列表' : '收起任务列表'
    workPlanToggle.setAttribute('aria-label', workPlanToggle.title)
    workPlanDock.inert = !visible
    workPlanDock.setAttribute('aria-hidden', String(!visible))
  }

  function setWorkPlanHidden(hidden: boolean, persist = true) {
    shell.classList.toggle('work-plan-hidden', hidden)
    updateWorkPlanToggleState()
    if (persist) {
      try { window.localStorage.setItem(workPlanHiddenStorageKey, String(hidden)) } catch {}
      scrollTranscript()
    }
  }

  let initialWorkPlanHidden = false
  try { initialWorkPlanHidden = window.localStorage.getItem(workPlanHiddenStorageKey) === 'true' } catch {}
  setWorkPlanHidden(initialWorkPlanHidden, false)

  function inspectorWidthModeForTab(tab: InspectorTab): InspectorWidthMode {
    return inspectorUserFullWidth || (tab === 'browser' && browserLayoutMode === 'landscape')
      ? 'full'
      : 'regular'
  }

  function currentInspectorWidthMode(): InspectorWidthMode {
    return inspectorWidthModeForTab(currentInspectorTab)
  }

  function inspectorMainContentWidth(): number {
    return workbenchSurface.clientWidth
  }

  function maximumInspectorWidth(mode: InspectorWidthMode = currentInspectorWidthMode()): number {
    return maximumInspectorWidthValue(inspectorMainContentWidth(), mode)
  }

  function defaultInspectorWidth(): number {
    return defaultInspectorWidthValue(inspectorMainContentWidth(), window.innerHeight)
  }

  function clampInspectorWidth(value: number, mode: InspectorWidthMode = currentInspectorWidthMode()): number {
    return clampInspectorWidthValue(value, inspectorMainContentWidth(), mode)
  }

  function setInspectorWidth(value: number, persist = false, mode: InspectorWidthMode = currentInspectorWidthMode()) {
    const width = clampInspectorWidth(value, mode)
    shell.style.setProperty('--work-panel-width', `${width}px`)
    shell.classList.toggle('inspector-full-width', mode === 'full')
    mainPanel.inert = mode === 'full' && shell.classList.contains('inspector-open')
    inspectorResizeHandle.setAttribute('aria-valuemin', String(INSPECTOR_MINIMUM_WIDTH))
    inspectorResizeHandle.setAttribute('aria-valuemax', String(Math.round(maximumInspectorWidth(mode))))
    inspectorResizeHandle.setAttribute('aria-valuenow', String(width))
    inspectorResizeHandle.setAttribute('aria-valuetext', mode === 'full' ? '全屏，向右拖动可恢复分栏' : `${width} 像素`)
    if (persist && mode === 'regular') {
      regularInspectorWidthRatio = inspectorWidthRatio(width, inspectorMainContentWidth(), mode)
      try { window.localStorage.setItem(inspectorWidthStorageKey, String(regularInspectorWidthRatio)) } catch { /* storage may be unavailable */ }
    }
    scheduleBrowserBoundsSync()
  }

  function applyInspectorWidthForTab(tab: InspectorTab) {
    const mode = inspectorWidthModeForTab(tab)
    setInspectorWidth(
      mode === 'full'
        ? maximumInspectorWidth(mode)
        : inspectorWidthFromRatio(regularInspectorWidthRatio, inspectorMainContentWidth(), mode),
      false,
      mode,
    )
  }

  function applyInspectorWidthForCurrentTab() {
    applyInspectorWidthForTab(currentInspectorTab)
  }

  try {
    const storedInspectorWidth = Number(window.localStorage.getItem(inspectorWidthStorageKey))
    regularInspectorWidthRatio = Number.isFinite(storedInspectorWidth) && storedInspectorWidth >= 0
      ? storedInspectorWidth <= 1
        ? storedInspectorWidth
        : inspectorWidthRatio(storedInspectorWidth, inspectorMainContentWidth())
      : inspectorWidthRatio(defaultInspectorWidth(), inspectorMainContentWidth())
  } catch {
    regularInspectorWidthRatio = inspectorWidthRatio(defaultInspectorWidth(), inspectorMainContentWidth())
  }
  setInspectorWidth(inspectorWidthFromRatio(regularInspectorWidthRatio, inspectorMainContentWidth()), false, 'regular')

  function showToast(message: string) {
    if (lifetime.disposed) return
    toast.textContent = message
    toast.classList.add('visible')
    lifetime.timeout(() => toast.classList.remove('visible'), 2400)
  }

  function cachedValue<K, V>(cache: Map<K, V>, key: K): V | undefined {
    const value = cache.get(key)
    if (value === undefined) return undefined
    cache.delete(key)
    cache.set(key, value)
    return value
  }

  function cacheValue<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
      const oldest = cache.keys().next().value as K | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return value
  }

  async function loadArtifactPreview(artifactId: string, purpose: 'thumbnail' | 'full' = 'full'): Promise<WorkbenchArtifactPreview> {
    if (purpose === 'thumbnail') {
      const cached = cachedValue(artifactThumbnailCache, artifactId)
      if (cached) return cached
      if (!bridge) throw new Error('桌面核心未连接')
      const request = bridge.previewArtifact(artifactId, 'thumbnail')
      cacheValue(artifactThumbnailCache, artifactId, request, 48)
      request.catch(() => artifactThumbnailCache.delete(artifactId))
      return request
    }
    const cached = cachedValue(artifactPreviewCache, artifactId)
    if (cached) return cached
    if (!bridge) throw new Error('桌面核心未连接')
    return cacheValue(artifactPreviewCache, artifactId, await bridge.previewArtifact(artifactId, 'full'), 3)
  }

  function loadAttachmentPreview(path: string, purpose: 'thumbnail' | 'full' = 'full'): Promise<{ mode: 'image'; dataUrl: string }> {
    const cache = purpose === 'thumbnail' ? attachmentThumbnailCache : attachmentPreviewCache
    const cached = cachedValue(cache, path)
    if (cached) return cached
    if (!bridge) return Promise.reject(new Error('桌面核心未连接'))
    const preview = bridge.previewImageAttachment(path, purpose)
    cacheValue(cache, path, preview, purpose === 'thumbnail' ? 48 : 3)
    preview.catch(() => cache.delete(path))
    return preview
  }

  function attachmentLightboxItems(attachments: AgentAttachment[]): ImageLightboxItem[] {
    return attachments.filter(attachment => attachment.type === 'image').map(attachment => ({
      id: attachment.id,
      title: attachment.filename,
      detail: '用户添加的图片',
      source: { kind: 'attachment', path: attachment.path },
    }))
  }

  function createToolImagePreview(attachment: AgentAttachment): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tool-image-preview'
    button.title = `查看 ${attachment.filename}`
    button.setAttribute('aria-label', button.title)
    const image = document.createElement('img')
    image.alt = attachment.filename
    image.decoding = 'async'
    button.append(image)
    hydrateAttachmentThumbnail(button, image, attachment.path)
    button.onclick = () => imageLightbox?.open([{
      id: attachment.id, title: attachment.filename,
      source: { kind: 'attachment', path: attachment.path },
    }])
    return button
  }

  function evidenceLightboxItems(items: ReturnType<typeof visualEvidenceItems>): ImageLightboxItem[] {
    return items.map(item => ({
      id: item.artifactId,
      title: item.title,
      detail: item.detail || (item.source === 'browser' ? '网页截图' : '电脑操作'),
      source: { kind: 'artifact', artifactId: item.artifactId },
    }))
  }

  async function loadAttachmentThumbnailNow(host: HTMLElement, image: HTMLImageElement, path: string): Promise<void> {
    try {
      const preview = await loadAttachmentPreview(path, 'thumbnail')
      if (!host.isConnected || host.dataset.attachmentPath !== path) return
      image.src = preview.dataUrl
      if (typeof image.decode === 'function') await image.decode()
      if (!host.isConnected || host.dataset.attachmentPath !== path) return
      host.classList.remove('loading', 'failed')
    } catch {
      if (host.dataset.attachmentPath === path) host.classList.add('failed')
    }
  }

  function hydrateAttachmentThumbnail(host: HTMLElement, image: HTMLImageElement, path: string, eager = false) {
    host.classList.add('loading')
    host.dataset.attachmentPath = path
    if (eager || !attachmentThumbnailObserver) {
      void loadAttachmentThumbnailNow(host, image, path)
      return
    }
    pendingAttachmentThumbnails.set(host, { image, path })
    attachmentThumbnailObserver.observe(host)
  }

  imageLightbox = createImageLightbox({
    loadPreview: item => item.source.kind === 'artifact'
      ? loadArtifactPreview(item.source.artifactId)
      : loadAttachmentPreview(item.source.path),
    exportImage: item => item.source.kind === 'artifact'
      ? bridge?.exportArtifact(item.source.artifactId) || Promise.resolve(null)
      : bridge?.exportImageAttachment(item.source.path) || Promise.resolve(null),
    notify: showToast,
  })

  function formatCompactValue(value: number): string {
    if (!Number.isFinite(value)) return '0'
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
    return Math.round(value).toLocaleString('zh-CN')
  }

  function renderComposerContext(snapshot: WorkbenchSnapshot) {
    const button = app.querySelector<HTMLButtonElement>('#composer-context')
    if (!button) return
    const usage = snapshot.context.usage
    const used = contextUsageTokenCount(usage)
    const contextWindow = Math.max(1, snapshot.context.contextWindow || 1)
    const ratio = Math.max(0, Math.min(1, used / contextWindow))
    const remaining = Math.max(0, contextWindow - used)
    const detail = `上下文 ${Math.round(ratio * 100)}% · 已用 ${formatCompactValue(used)} / ${formatCompactValue(contextWindow)} · 剩余 ${formatCompactValue(remaining)}`
    button.style.setProperty('--context-progress', `${ratio * 360}deg`)
    button.dataset.tooltip = detail
    button.setAttribute('aria-label', `${detail}，点击查看详情`)
  }

  function renderComposerModelIdentity() {
    const modelId = currentSnapshot?.runtime.model || ''
    const provider = currentSnapshot?.runtime.provider || ''
    const iconElement = app.querySelector<HTMLElement>('#model-icon')
    if (iconElement) {
      iconElement.innerHTML = modelProviderMark(provider, modelId)
      iconElement.dataset.provider = normalizedModelProvider(provider, modelId)
    }
  }



  function activeBrowserTab() {
    const panelTab = activeInspectorPanelTab()
    const browserTabId = panelTab?.kind === 'browser' ? panelTab.browserTabId : browserSnapshot?.activeTabId
    return browserSnapshot?.tabs.find(tab => tab.id === browserTabId) || null
  }

  function browserActivityText(snapshot: BrowserSystemSnapshot): string {
    if (!snapshot.activity) return ''
    return ({
      opening: '正在打开页面',
      navigating: '正在浏览页面',
      observing: '正在检查页面',
      acting: '正在操作页面',
      capturing: '正在记录页面',
      recovering: '正在恢复页面',
    } as const)[snapshot.activity.phase]
  }

  function updateBrowserActivity(element: HTMLElement, snapshot: BrowserSystemSnapshot) {
    const label = browserActivityText(snapshot)
    element.hidden = !label
    element.classList.toggle('active', Boolean(label))
    const copy = element.querySelector<HTMLElement>('span:last-child')
    if (copy) copy.textContent = label
  }

  function setInspectorModuleMenu(open: boolean) {
    inspectorModuleMenu.classList.toggle('visible', open)
    inspectorModuleMenu.setAttribute('aria-hidden', String(!open))
    inspectorModuleMenuToggle.setAttribute('aria-expanded', String(open))
    scheduleBrowserBoundsSync()
  }

  function toggleInspectorModuleMenu() {
    setInspectorModuleMenu(!inspectorModuleMenu.classList.contains('visible'))
  }

  function inspectorModuleDescriptor(tab: InspectorTab): InspectorPanelTab {
    const item = [...INSPECTOR_PRIMARY_NAVIGATION, ...INSPECTOR_UTILITY_NAVIGATION]
      .find(candidate => candidate.tab === tab) || INSPECTOR_PRIMARY_NAVIGATION[0]
    return {
      id: `module:${tab}`,
      kind: 'module',
      inspectorTab: tab,
      title: item.label,
      iconName: item.iconName,
    }
  }

  function activeInspectorPanelTab(): InspectorPanelTab | null {
    return inspectorPanelTabs.find(tab => tab.id === activeInspectorPanelTabId) || null
  }

  function reflectActiveInspectorPanelTab() {
    const tab = activeInspectorPanelTab()
    if (!tab) return
    currentInspectorTab = tab.inspectorTab
    selectedArtifactId = tab.kind === 'artifact' ? tab.artifactId || null : null
  }

  function ensureInspectorPanelTab(tab: InspectorPanelTab): InspectorPanelTab {
    const existing = inspectorPanelTabs.find(candidate => candidate.id === tab.id)
    if (existing) {
      const preservePinnedState = tab.isPreview === true && existing.isPreview === false
      Object.assign(existing, tab)
      if (preservePinnedState) existing.isPreview = false
      return existing
    }
    if (tab.isPreview) {
      const previewIndex = inspectorPanelTabs.findIndex(candidate => candidate.isPreview)
      if (previewIndex !== -1) {
        inspectorPanelTabs.splice(previewIndex, 1, tab)
        return tab
      }
    }
    inspectorPanelTabs.push(tab)
    return tab
  }

  function activateInspectorPanelTab(tabId: string, render = true) {
    const tab = inspectorPanelTabs.find(candidate => candidate.id === tabId)
    if (!tab) return
    activeInspectorPanelTabId = tab.id
    reflectActiveInspectorPanelTab()
    if (tab.inspectorTab !== 'browser') browserLayoutMode = 'portrait'
    if (tab.kind === 'browser' && tab.browserTabId && browserSnapshot?.activeTabId !== tab.browserTabId) {
      void bridge?.browserActivateTab(tab.browserTabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
    }
    if (shell.classList.contains('inspector-open')) applyInspectorWidthForCurrentTab()
    if (render) renderInspector()
  }

  function syncInspectorBrowserTabs(snapshot: BrowserSystemSnapshot) {
    const browserTabIds = new Set(snapshot.tabs.map(tab => `browser:${tab.id}`))
    const previousIds = inspectorPanelTabs.map(tab => tab.id)
    const previousActiveTab = activeInspectorPanelTab()
    inspectorPanelTabs = inspectorPanelTabs.filter(tab => tab.kind !== 'browser' || tab.id === 'browser:new' || browserTabIds.has(tab.id))
    if (snapshot.tabs.length > 0) inspectorPanelTabs = inspectorPanelTabs.filter(tab => tab.id !== 'browser:new')
    for (const browserTab of snapshot.tabs) {
      ensureInspectorPanelTab({
        id: `browser:${browserTab.id}`,
        kind: 'browser',
        inspectorTab: 'browser',
        title: browserTab.crashed ? '页面已停止' : browserTab.title || '新标签页',
        iconName: 'browser',
        browserTabId: browserTab.id,
      })
    }
    if (previousActiveTab?.kind === 'browser') {
      const activeBrowserId = snapshot.activeTabId ? `browser:${snapshot.activeTabId}` : null
      if (activeBrowserId && inspectorPanelTabs.some(tab => tab.id === activeBrowserId)) activeInspectorPanelTabId = activeBrowserId
      else if (!inspectorPanelTabs.some(tab => tab.id === activeInspectorPanelTabId)) {
        activeInspectorPanelTabId = adjacentInspectorTabId(previousIds, previousActiveTab.id)
      }
    }
    if (activeInspectorPanelTabId && !inspectorPanelTabs.some(tab => tab.id === activeInspectorPanelTabId)) {
      activeInspectorPanelTabId = inspectorPanelTabs[0]?.id || null
    }
    reflectActiveInspectorPanelTab()
    if (inspectorPanelTabs.length === 0 && shell.classList.contains('inspector-open')) closeInspector()
  }

  async function closeInspectorPanelTab(tabId: string) {
    const tab = inspectorPanelTabs.find(candidate => candidate.id === tabId)
    if (!tab) return
    if (tab.kind === 'browser' && tab.browserTabId) {
      if (!bridge) {
        showToast('桌面核心连接不可用')
        return
      }
      try {
        renderBrowserSnapshot(await bridge.browserCloseTab(tab.browserTabId))
      } catch (error) {
        showToast(errorMessage(error))
      }
      return
    }
    const tabIds = inspectorPanelTabs.map(candidate => candidate.id)
    const nextActiveTabId = activeInspectorPanelTabId === tabId
      ? adjacentInspectorTabId(tabIds, tabId)
      : activeInspectorPanelTabId
    inspectorPanelTabs = inspectorPanelTabs.filter(candidate => candidate.id !== tabId)
    if (inspectorPanelTabs.length === 0) {
      activeInspectorPanelTabId = null
      closeInspector()
      return
    }
    if (nextActiveTabId) activateInspectorPanelTab(nextActiveTabId)
    else renderInspectorChrome()
    lifetime.frame(() => inspectorTabs.querySelector<HTMLButtonElement>('.inspector-tab-slot.active .inspector-tab')?.focus())
  }

  let inspectorDraggingTabId: string | null = null

  function beginInspectorTabDrag(tabId: string, event: PointerEvent) {
    if (event.button !== 0 || (event.target as Element | null)?.closest('.inspector-tab-close')) return
    const startX = event.clientX
    let moved = false
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      if (!moved && Math.abs(moveEvent.clientX - startX) < 5) return
      moved = true
      inspectorDraggingTabId = tabId
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>('.inspector-tab-slot')
      const targetTabId = target?.dataset.tabId
      if (!targetTabId || targetTabId === tabId) return
      const orderedIds = reorderInspectorTabIds(inspectorPanelTabs.map(tab => tab.id), tabId, targetTabId)
      inspectorPanelTabs = orderedIds.map(id => inspectorPanelTabs.find(tab => tab.id === id)!).filter(Boolean)
      renderInspectorChrome()
    }
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      inspectorDraggingTabId = null
      if (moved) renderInspectorChrome()
    }
    lifetime.listen(window, 'pointermove', move)
    lifetime.listen(window, 'pointerup', finish)
    lifetime.listen(window, 'pointercancel', finish)
  }

  function renderInspectorChrome() {
    const activePanelTab = activeInspectorPanelTab()
    inspectorPanel.classList.toggle('inspector-landing-mode', !activePanelTab)
    const fallbackWidth = Math.max(180, inspectorPanel.getBoundingClientRect().width - 156)
    const layout = inspectorTabLayout(
      inspectorPanelTabs.map(tab => tab.id),
      activeInspectorPanelTabId,
      inspectorTabs.clientWidth || fallbackWidth,
    )
    const layoutById = new Map(layout.map(item => [item.id, item]))
    const fragment = document.createDocumentFragment()
    for (const panelTab of inspectorPanelTabs) {
      const panelTabIndex = inspectorPanelTabs.indexOf(panelTab)
      const item = layoutById.get(panelTab.id)
      const slot = document.createElement('div')
      slot.className = `inspector-tab-slot${panelTab.id === activeInspectorPanelTabId ? ' active' : ''}${panelTab.id === inspectorDraggingTabId ? ' dragging' : ''}`
      slot.dataset.tabId = panelTab.id
      slot.dataset.preview = String(panelTab.isPreview === true)
      slot.dataset.closeAvailable = String(panelTab.id === activeInspectorPanelTabId || (item?.width || 0) >= 100)
      slot.style.width = `${item?.width || 132}px`
      const tab = document.createElement('button')
      tab.className = 'inspector-tab'
      tab.type = 'button'
      tab.title = panelTab.title
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(panelTab.id === activeInspectorPanelTabId))
      tab.setAttribute('aria-label', panelTab.title)
      tab.setAttribute('aria-controls', 'inspector-content')
      const browserState = panelTab.browserTabId
        ? browserSnapshot?.tabs.find(candidate => candidate.id === panelTab.browserTabId)
        : null
      const glyph = document.createElement('span')
      glyph.className = `inspector-tab-icon${browserState?.loading ? ' loading' : ''}`
      glyph.innerHTML = icon(panelTab.iconName)
      const title = document.createElement('span')
      title.className = `inspector-tab-title${item?.showsTitle === false ? ' hidden-title' : ''}`
      title.textContent = panelTab.title
      const close = document.createElement('button')
      close.className = 'inspector-tab-close'
      close.type = 'button'
      close.title = `关闭 ${panelTab.title}`
      close.setAttribute('aria-label', close.title)
      close.innerHTML = icon('close')
      close.addEventListener('pointerdown', closeEvent => closeEvent.stopPropagation())
      close.addEventListener('click', closeEvent => {
        closeEvent.stopPropagation()
        void closeInspectorPanelTab(panelTab.id)
      })
      tab.append(glyph, title)
      tab.addEventListener('click', () => activateInspectorPanelTab(panelTab.id))
      tab.addEventListener('dblclick', () => {
        if (!panelTab.isPreview) return
        panelTab.isPreview = false
        renderInspectorChrome()
      })
      tab.addEventListener('keydown', keyEvent => {
        if (keyEvent.key !== 'ArrowLeft' && keyEvent.key !== 'ArrowRight' && keyEvent.key !== 'Home' && keyEvent.key !== 'End') return
        const direction = keyEvent.key === 'ArrowLeft' ? -1 : keyEvent.key === 'ArrowRight' ? 1 : 0
        const nextIndex = keyEvent.key === 'Home'
          ? 0
          : keyEvent.key === 'End'
            ? inspectorPanelTabs.length - 1
            : (panelTabIndex + direction + inspectorPanelTabs.length) % inspectorPanelTabs.length
        const nextTab = inspectorPanelTabs[nextIndex]
        if (!nextTab) return
        keyEvent.preventDefault()
        activateInspectorPanelTab(nextTab.id)
        lifetime.frame(() => inspectorTabs.querySelector<HTMLButtonElement>(`.inspector-tab-slot[data-tab-id="${CSS.escape(nextTab.id)}"] .inspector-tab`)?.focus())
      })
      tab.addEventListener('auxclick', auxEvent => {
        if (auxEvent.button !== 1) return
        auxEvent.preventDefault()
        void closeInspectorPanelTab(panelTab.id)
      })
      slot.addEventListener('pointerdown', dragEvent => beginInspectorTabDrag(panelTab.id, dragEvent))
      slot.append(tab, close)
      const nextPanelTab = inspectorPanelTabs[panelTabIndex + 1]
      if (nextPanelTab && panelTab.id !== activeInspectorPanelTabId && nextPanelTab.id !== activeInspectorPanelTabId) {
        const separator = document.createElement('span')
        separator.className = 'inspector-tab-separator'
        separator.setAttribute('aria-hidden', 'true')
        slot.append(separator)
      }
      fragment.append(slot)
    }
    inspectorTabs.replaceChildren(fragment)
    lifetime.frame(() => inspectorTabs.querySelector<HTMLElement>('.inspector-tab-slot.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }))

    if (browserSnapshot) updateBrowserActivity(inspectorBrowserActivity, browserSnapshot)
    else inspectorBrowserActivity.hidden = true
    const fullWidth = currentInspectorWidthMode() === 'full'
    inspectorExpand.classList.toggle('active', fullWidth)
    inspectorExpand.setAttribute('aria-pressed', String(fullWidth))
    inspectorExpand.title = fullWidth ? '恢复面板宽度' : '展开面板'
    inspectorExpand.setAttribute('aria-label', inspectorExpand.title)
    inspectorExpand.innerHTML = icon(fullWidth ? 'contract' : 'expand')
    inspectorModuleMenu.querySelectorAll<HTMLButtonElement>('.inspector-module-option[data-tab]').forEach(option => {
      const selected = option.dataset.tab === currentInspectorTab
      option.classList.toggle('active', selected)
      option.setAttribute('aria-checked', String(selected))
    })
  }

  function navigateBrowserAddress(value: string, tabId?: string) {
    const address = value.trim()
    if (!address) return
    void bridge?.browserNavigate(address, tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
  }

  function scheduleBrowserBoundsSync() {
    if (!bridge || !browserSnapshot?.visible) return
    if (browserBoundsFrame !== null) lifetime.cancelFrame(browserBoundsFrame)
    browserBoundsFrame = lifetime.frame(() => {
      browserBoundsFrame = null
      // Native browser views sit above DOM menus, so clear their bounds while the menu is open.
      const surface = currentInspectorTab === 'browser'
        && shell.classList.contains('inspector-open')
        && !inspectorModuleMenu.classList.contains('visible')
        ? inspectorContent.querySelector<HTMLElement>('.inspector-browser-surface')
        : null
      const rect = surface?.getBoundingClientRect()
      const bounds = !rect || rect.width < 2 || rect.height < 2
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      void bridge.browserSetBounds(bounds)
        .catch(error => showToast(errorMessage(error)))
    })
  }

  function updateInspectorBrowser(snapshot: BrowserSystemSnapshot): boolean {
    if (!shell.classList.contains('inspector-open') || currentInspectorTab !== 'browser') return false
    renderInspectorChrome()
    const panel = inspectorContent.querySelector<HTMLElement>('.inspector-browser')
    const active = activeBrowserTab()
    if (!panel || !snapshot.visible || !active) return false
    const back = panel.querySelector<HTMLButtonElement>('[data-browser-command="back"]')
    const forward = panel.querySelector<HTMLButtonElement>('[data-browser-command="forward"]')
    const reload = panel.querySelector<HTMLButtonElement>('[data-browser-command="reload"]')
    const address = panel.querySelector<HTMLInputElement>('.inspector-browser-address')
    const external = panel.querySelector<HTMLButtonElement>('[data-browser-command="external"]')
    if (!back || !forward || !reload || !address || !external) return false
    back.disabled = !active.canGoBack
    forward.disabled = !active.canGoForward
    reload.title = active.loading ? '重新加载' : '刷新'
    reload.classList.toggle('loading', active.loading)
    if (document.activeElement !== address) address.value = active.url === 'about:blank' ? '' : active.url
    external.disabled = active.url === 'about:blank'
    return true
  }

  function renderBrowserSnapshot(snapshot: BrowserSystemSnapshot) {
    if (lifetime.disposed) return
    browserSnapshot = snapshot
    syncInspectorBrowserTabs(snapshot)
    const agentToolCallId = snapshot.activity?.toolCallId || ''
    if (
      snapshot.visible
      && agentToolCallId
      && agentToolCallId !== lastAutoOpenedBrowserToolCallId
      && fullScreenSurfaceDepth === 0
    ) {
      lastAutoOpenedBrowserToolCallId = agentToolCallId
      openInspector('browser')
    }
    if (shell.classList.contains('inspector-open')) {
      if (activeInspectorPanelTab()?.kind !== 'browser' || !updateInspectorBrowser(snapshot)) renderInspector()
    }
    if (snapshot.visible) scheduleBrowserBoundsSync()
  }

  async function refreshConversationSystemSnapshots(): Promise<void> {
    if (!bridge) return
    const [browserResult, computerResult] = await Promise.allSettled([
      bridge.browserGetState(),
      computerControls?.refresh() || Promise.resolve(null),
    ])
    if (browserResult.status === 'fulfilled') renderBrowserSnapshot(browserResult.value)
    else showToast(errorMessage(browserResult.reason))
    if (computerResult.status === 'rejected') showToast(errorMessage(computerResult.reason))
  }

  async function openBrowserInInspector(url: string) {
    if (!bridge) return
    try {
      openInspector('browser')
      let snapshot = await bridge.browserShow()
      const active = snapshot.tabs.find(tab => tab.id === snapshot.activeTabId)
      if (active?.url === 'about:blank' && snapshot.tabs.length === 1) snapshot = await bridge.browserNavigate(url, active.id)
      else if (active?.url !== url) snapshot = await bridge.browserNewTab(url)
      renderBrowserSnapshot(snapshot)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function openBrowserTabInInspector(tabId: string) {
    if (!bridge) return
    try {
      let snapshot = await bridge.browserShow()
      if (snapshot.tabs.some(tab => tab.id === tabId) && snapshot.activeTabId !== tabId) {
        snapshot = await bridge.browserActivateTab(tabId)
      }
      renderBrowserSnapshot(snapshot)
      openInspector('browser')
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function openBrowserExecution(toolCallId: string) {
    if (!bridge) return
    try {
      const latest = await bridge.browserGetState()
      renderBrowserSnapshot(latest)
      const execution = (latest.executions || []).find(candidate => candidate.toolCallId === toolCallId)
      await openBrowserTabInInspector(execution?.tabId || '')
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  function handleBrowserEvent(event: BrowserSystemEvent) {
    if (event.type === 'state') {
      renderBrowserSnapshot(event.snapshot)
      return
    }
    if (event.type === 'layout-request') {
      browserLayoutMode = event.mode
      if (shell.classList.contains('inspector-open') && activeInspectorPanelTab()?.kind === 'browser') {
        applyInspectorWidthForCurrentTab()
        renderInspectorChrome()
      }
      return
    }
    if (event.type === 'blocked-navigation') {
      showToast(`已阻止不安全页面：${event.reason}`)
      return
    }
    if (event.type === 'download') {
      const { download } = event
      const message = download.status === 'started'
        ? `正在下载 ${download.filename}`
        : download.status === 'completed'
          ? `${download.filename} 已保存到产物`
          : `${download.filename} 下载${download.status === 'cancelled' ? '已取消' : '失败'}`
      showToast(message)
    }
  }

  const computerControls = bridge ? createComputerControls(app, bridge, {
    showToast,
    onActivityChange: () => {
      if (shell.classList.contains('inspector-open') && currentInspectorTab === 'activity') renderInspector()
    },
  }) : null

  const terminalPanel = bridge ? createTerminalPanel(
    terminalPanelElement,
    terminalToggle,
    mainPanel,
    bridge,
    showToast,
  ) : null

  async function enterFullScreenSurface() {
    if (!bridge) return
    fullScreenSurfaceDepth += 1
    if (fullScreenSurfaceDepth > 1) return
    browserVisibleBeforeFullScreen = browserSnapshot?.visible === true
    browserInspectorOpenBeforeFullScreen = browserVisibleBeforeFullScreen
      && currentInspectorTab === 'browser'
      && shell.classList.contains('inspector-open')
    closeComposerMenus()
    closeInspector()
    if (!browserVisibleBeforeFullScreen) return
    try {
      renderBrowserSnapshot(await bridge.browserHide())
    } catch (error) {
      browserVisibleBeforeFullScreen = false
      browserInspectorOpenBeforeFullScreen = false
      showToast(errorMessage(error))
    }
  }

  function leaveFullScreenSurface() {
    fullScreenSurfaceDepth = Math.max(0, fullScreenSurfaceDepth - 1)
    if (fullScreenSurfaceDepth > 0) return
    const restoreBrowser = browserVisibleBeforeFullScreen
    const restoreInspector = browserInspectorOpenBeforeFullScreen
    browserVisibleBeforeFullScreen = false
    browserInspectorOpenBeforeFullScreen = false
    if (!restoreBrowser || !bridge) return
    void (async () => {
      try {
        const snapshot = await bridge.browserShow()
        renderBrowserSnapshot(snapshot)
        if (restoreInspector) openInspector('browser')
      } catch (error) {
        showToast(errorMessage(error))
      }
    })()
  }

  const settingsCenter = bridge ? createSettingsCenter(app, bridge, {
    showToast,
    onOpen: enterFullScreenSurface,
    onClose: () => {
      leaveFullScreenSurface()
      void refreshSidebarProfileIdentity()
    },
    computerControls: computerControls || undefined,
    getComposerPopoverPlacement: () => composerPopoverPlacement(mainScroll.classList.contains('conversation-mode')),
    onSnapshot: snapshot => applySnapshot(snapshot),
    onUseCapability: async capability => {
      if (capability.type === 'skill') {
        const skill = currentSnapshot?.skills.find(item => item.id === capability.id)
        if (!skill) throw new Error('插件已安装，但工作流暂时无法读取')
        draftCapabilities = [
          { type: 'skill', id: skill.id, name: skill.name },
          ...draftCapabilities.filter(item => item.type !== 'skill'),
        ]
      } else {
        draftCapabilities = [
          ...draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id)),
          { ...capability },
        ]
      }
      renderCapabilityTray()
      await persistDraftNow()
      taskInput.focus()
    },
  }) : null

  let activeProfileIdentity: DesktopUserProfile | null = null
  const userProfile = bridge ? createUserProfile(app, bridge, {
    showToast,
    onIdentityChanged: renderProfileIdentity,
    onOpen: enterFullScreenSurface,
    onClose: leaveFullScreenSurface,
  }) : null

  function renderWelcomeGreeting(): void {
    const greeting = app.querySelector<HTMLElement>('#welcome-greeting')
    const text = `${activeProfileIdentity?.displayName || '你'}，${profileGreeting()}！`
    if (greeting && greeting.textContent !== text) greeting.textContent = text
  }

  function renderProfileIdentity(active: DesktopUserProfile): void {
    const avatarChanged = !activeProfileIdentity
      || activeProfileIdentity.displayName !== active.displayName
      || activeProfileIdentity.avatarDataUrl !== active.avatarDataUrl
    activeProfileIdentity = active
    const name = app.querySelector<HTMLElement>('#sidebar-profile-name')
    const state = app.querySelector<HTMLElement>('#sidebar-profile-state')
    if (name && name.textContent !== active.displayName) name.textContent = active.displayName
    for (const id of ['sidebar-profile-avatar', 'welcome-profile-avatar']) {
      const avatar = app.querySelector<HTMLElement>(`#${id}`)
      if (!avatar || !avatarChanged) continue
      avatar.innerHTML = profileAvatarMarkup(active)
      avatar.style.setProperty('--profile-color', profileColor(active))
    }
    if (state && state.textContent !== '查看个人资料') state.textContent = '查看个人资料'
    renderWelcomeGreeting()
  }

  async function refreshSidebarProfileIdentity(): Promise<void> {
    if (!bridge) return
    try {
      renderProfileIdentity(await bridge.getUserProfile())
    } catch {
      const state = app.querySelector<HTMLElement>('#sidebar-profile-state')
      if (state) state.textContent = '查看个人资料'
    }
  }
  renderWelcomeGreeting()
  void refreshSidebarProfileIdentity()
  const greetingTimer = window.setInterval(renderWelcomeGreeting, 60_000)
  lifetime.add(() => window.clearInterval(greetingTimer))
  lifetime.listen(document, 'visibilitychange', () => { if (!document.hidden) renderWelcomeGreeting() })

  const commandPalette = bridge ? createCommandPalette(app, bridge, {
    showToast,
    onResult: result => handleCommandResult(result),
  }) : null

  function errorMessage(error: unknown): string {
    return presentDesktopError(error)
  }

  async function handleCommandResult(result: WorkbenchCommandResult): Promise<void> {
    if (result.snapshot) applySnapshot(result.snapshot)
    if (result.open === 'activity' || result.open === 'context' || result.open === 'git') openInspector(result.open)
    if (result.open === 'mcp') await settingsCenter?.open('mcp')
    if (result.open === 'skills') await settingsCenter?.open('workpacks')
  }

  function formatRelativeTime(timestamp: number): string {
    const elapsed = Math.max(0, Date.now() - timestamp)
    if (elapsed < 60_000) return '现在'
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`
    return `${Math.floor(elapsed / 86_400_000)} 天`
  }

  function createMessageTime(timestamp: number): HTMLTimeElement {
    const date = new Date(timestamp)
    const time = document.createElement('time')
    time.className = 'message-time'
    time.dateTime = date.toISOString()
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date)
    time.title = date.toLocaleString([], {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    return time
  }

  function openWorkbenchDialog(options: {
    title: string
    message: string
    confirmLabel: string
    inputValue?: string
    danger?: boolean
  }): Promise<string | boolean | null> {
    if (activeWorkbenchDialog) {
      activeWorkbenchDialog.focus()
      return Promise.resolve(null)
    }
    return new Promise(resolve => {
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const overlay = document.createElement('div')
      overlay.className = 'workbench-dialog-overlay'
      const dialog = document.createElement('section')
      dialog.className = 'workbench-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      workbenchDialogSequence += 1
      const titleId = `workbench-dialog-title-${workbenchDialogSequence}`
      dialog.setAttribute('aria-labelledby', titleId)
      const title = document.createElement('h3')
      title.id = titleId
      title.textContent = options.title
      const message = document.createElement('p')
      message.textContent = options.message
      dialog.append(title, message)
      let input: HTMLInputElement | null = null
      if (options.inputValue !== undefined) {
        input = document.createElement('input')
        input.value = options.inputValue
        input.maxLength = 80
        dialog.append(input)
      }
      const actions = document.createElement('footer')
      const cancel = document.createElement('button')
      cancel.className = 'dialog-secondary'
      cancel.textContent = '取消'
      const confirm = document.createElement('button')
      confirm.className = options.danger ? 'dialog-primary danger' : 'dialog-primary'
      confirm.textContent = options.confirmLabel
      actions.append(cancel, confirm)
      dialog.append(actions)
      overlay.append(dialog)
      app.append(overlay)
      let settled = false
      const focusDialog = () => {
        const target = input || (options.danger ? cancel : confirm)
        target.focus()
        input?.select()
      }
      const controller = { focus: focusDialog }
      activeWorkbenchDialog = controller
      const finish = (value: string | boolean | null) => {
        if (settled) return
        settled = true
        if (activeWorkbenchDialog === controller) activeWorkbenchDialog = null
        overlay.classList.remove('visible')
        overlay.style.pointerEvents = 'none'
        lifetime.timeout(() => {
          overlay.remove()
          if (previousFocus?.isConnected) previousFocus.focus()
        }, 180)
        resolve(value)
      }
      cancel.addEventListener('click', () => finish(null))
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(null) })
      confirm.addEventListener('click', () => finish(input ? input.value.trim() : true))
      input?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        finish(input?.value.trim() || '')
      })
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(null)
          return
        }
        if (event.key !== 'Tab') return
        const focusable = [input, cancel, confirm].filter((element): element is HTMLInputElement | HTMLButtonElement => Boolean(element && !element.disabled))
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      })
      focusDialog()
      lifetime.frame(() => {
        overlay.classList.add('visible')
      })
    })
  }

  function closeWorkflowSurface(requestId?: string) {
    if (!workflowSurface || requestId && requestId !== workflowSurfaceRequestId) return
    const surface = workflowSurface
    const returnFocus = workflowSurfaceReturnFocus
    workflowSurface = null
    workflowSurfaceRequestId = ''
    workflowSurfaceReturnFocus = null
    surface.classList.remove('visible')
    lifetime.timeout(() => {
      surface.remove()
      returnFocus?.focus({ preventScroll: true })
    }, 240)
  }

  function showWorkflowSurface(event: {
    requestId?: string
    question: string
    ui: WorkflowSurfaceSpec
  }) {
    if (!bridge || !event.requestId) return
    closeWorkflowSurface()
    const ui = event.ui
    const overlay = document.createElement('div')
    overlay.className = 'workflow-surface-inline'
    overlay.dataset.workflow = ui.workflow
    overlay.dataset.stage = ui.stage
    overlay.dataset.renderer = ui.renderer
    overlay.setAttribute('aria-label', ui.title)
    const surface = document.createElement('section')
    surface.className = 'workflow-surface'
    surface.dataset.renderer = ui.renderer
    const header = document.createElement('header')
    header.className = 'workflow-surface-header'
    const title = document.createElement('h2')
    title.textContent = ui.title
    const detail = document.createElement('p')
    detail.textContent = ui.detail || event.question
    detail.id = `workflow-surface-detail-${event.requestId}`
    overlay.setAttribute('aria-describedby', detail.id)
    const close = document.createElement('button')
    close.className = 'workflow-surface-close'
    close.type = 'button'
    close.setAttribute('aria-label', '关闭工作流面板')
    close.innerHTML = icon('close')
    close.addEventListener('click', () => void resolveRequest(event.requestId || '', 'cancelled', overlay))
    header.append(title, detail, close)
    surface.append(header)

    const directions = ui.directions || []
    if (directions.length > 0) {
      const grid = document.createElement('div')
      grid.className = 'workflow-surface-gallery'
      for (const [index, direction] of directions.entries()) {
        const card = document.createElement('article')
        card.className = 'workflow-surface-card'
        card.style.setProperty('--workflow-index', String(index))
        const visual = document.createElement('div')
        visual.className = 'workflow-surface-card-visual'
        const image = document.createElement('img')
        image.alt = `${direction.id} ${direction.name} 预览`
        image.loading = 'lazy'
        const placeholder = document.createElement('span')
        placeholder.className = 'workflow-surface-card-placeholder'
        placeholder.textContent = direction.id
        visual.append(placeholder, image)
        if (direction.screenshotPath) {
          void bridge.previewImageAttachment(direction.screenshotPath, 'thumbnail').then(preview => {
            image.src = preview.dataUrl
            image.classList.add('loaded')
            placeholder.remove()
          }).catch(() => {
            placeholder.textContent = '预览暂不可用'
          })
        }
        const copy = document.createElement('div')
        copy.className = 'workflow-surface-card-copy'
        const eyebrow = document.createElement('span')
        eyebrow.className = 'workflow-surface-card-id'
        eyebrow.textContent = direction.id
        const name = document.createElement('h3')
        name.textContent = direction.name
        const thesis = document.createElement('p')
        thesis.textContent = direction.thesis
        copy.append(eyebrow, name, thesis)
        if (direction.tags?.length) {
          const tags = document.createElement('div')
          tags.className = 'workflow-surface-tags'
          for (const tag of direction.tags.slice(0, 4)) {
            const tagElement = document.createElement('span')
            tagElement.textContent = tag
            tags.append(tagElement)
          }
          copy.append(tags)
        }
        const choose = document.createElement('button')
        choose.className = 'workflow-surface-select'
        choose.type = 'button'
        choose.innerHTML = `<span>选择 ${direction.id}</span>${icon('chevron')}`
        choose.addEventListener('click', () => void resolveRequest(event.requestId || '', direction.id, overlay))
        card.append(visual, copy, choose)
        grid.append(card)
      }
      surface.append(grid)
    } else {
      const choices = ui.choices || []
      const choiceGrid = document.createElement('div')
      choiceGrid.className = 'workflow-surface-choices'
      for (const [index, choice] of choices.entries()) {
        const button = document.createElement('button')
        button.className = 'workflow-surface-choice'
        button.type = 'button'
        button.style.setProperty('--workflow-index', String(index))
        const sequence = document.createElement('span')
        sequence.className = 'workflow-surface-choice-index'
        sequence.textContent = String(index + 1).padStart(2, '0')
        const copy = document.createElement('span')
        copy.className = 'workflow-surface-choice-copy'
        const label = document.createElement('strong')
        label.textContent = choice.label
        copy.append(label)
        if (choice.detail) {
          const choiceDetail = document.createElement('span')
          choiceDetail.textContent = choice.detail
          copy.append(choiceDetail)
        }
        const arrow = document.createElement('span')
        arrow.className = 'workflow-surface-choice-arrow'
        arrow.innerHTML = icon('chevron')
        const countMarker = document.createElement('span')
        countMarker.className = 'workflow-surface-count-marker'
        countMarker.setAttribute('aria-hidden', 'true')
        button.append(sequence, copy, countMarker, arrow)
        button.addEventListener('click', () => void resolveRequest(event.requestId || '', choice.id, overlay))
        choiceGrid.append(button)
      }
      surface.append(choiceGrid)
      const countInput = ui.input || (ui.renderer === 'count' || ui.stage.toLowerCase().includes('count')
        ? { type: 'number' as const, min: 1, max: 20, placeholder: '1–20', label: '自定义方向数量' }
        : undefined)
      if (countInput?.type === 'number') {
        const custom = document.createElement('div')
        custom.className = 'workflow-surface-custom-count'
        const customLabel = document.createElement('label')
        customLabel.textContent = countInput.label || '自定义数量'
        const field = document.createElement('span')
        field.className = 'workflow-surface-count-field'
        const input = document.createElement('input')
        input.type = countInput.type
        if (typeof countInput.min === 'number') input.min = String(countInput.min)
        if (typeof countInput.max === 'number') input.max = String(countInput.max)
        input.placeholder = countInput.placeholder || ''
        input.setAttribute('aria-label', countInput.label || '自定义数量')
        const suffix = document.createElement('span')
        suffix.textContent = '个方向'
        field.append(input, suffix)
        const submit = document.createElement('button')
        submit.className = 'workflow-surface-select'
        submit.type = 'button'
        submit.innerHTML = `<span>继续</span>${icon('chevron')}`
        const error = document.createElement('span')
        error.className = 'workflow-surface-input-error'
        error.id = `workflow-surface-count-error-${event.requestId}`
        input.setAttribute('aria-describedby', error.id)
        const submitCount = () => {
          const min = typeof countInput.min === 'number' ? countInput.min : 1
          const max = typeof countInput.max === 'number' ? countInput.max : 20
          const count = Number.parseInt(input.value, 10)
          if (!Number.isInteger(count) || count < min || count > max) {
            error.textContent = `请输入 ${min}–${max} 的整数`
            input.setAttribute('aria-invalid', 'true')
            return
          }
          error.textContent = ''
          input.removeAttribute('aria-invalid')
          void resolveRequest(event.requestId || '', String(count), overlay)
        }
        submit.addEventListener('click', submitCount)
        input.addEventListener('input', () => {
          error.textContent = ''
          input.removeAttribute('aria-invalid')
        })
        input.addEventListener('keydown', keyEvent => {
          if (keyEvent.key !== 'Enter') return
          keyEvent.preventDefault()
          submitCount()
        })
        custom.append(customLabel, field, submit, error)
        surface.append(custom)
      } else if (countInput?.type === 'text') {
        const custom = document.createElement('div')
        custom.className = 'workflow-surface-custom-text'
        const customLabel = document.createElement('label')
        customLabel.textContent = countInput.label || '补充说明'
        const input = document.createElement('textarea')
        input.maxLength = 4_000
        input.rows = 4
        input.placeholder = countInput.placeholder || ''
        input.setAttribute('aria-label', countInput.label || '补充说明')
        const submit = document.createElement('button')
        submit.className = 'workflow-surface-select'
        submit.type = 'button'
        submit.innerHTML = `<span>继续</span>${icon('chevron')}`
        const error = document.createElement('span')
        error.className = 'workflow-surface-input-error'
        error.id = `workflow-surface-text-error-${event.requestId}`
        input.setAttribute('aria-describedby', error.id)
        const submitText = () => {
          const value = input.value.trim()
          if (!value) {
            error.textContent = '请输入内容后继续'
            input.setAttribute('aria-invalid', 'true')
            return
          }
          error.textContent = ''
          input.removeAttribute('aria-invalid')
          void resolveRequest(event.requestId || '', value, overlay)
        }
        submit.addEventListener('click', submitText)
        input.addEventListener('input', () => {
          error.textContent = ''
          input.removeAttribute('aria-invalid')
        })
        input.addEventListener('keydown', keyEvent => {
          if (keyEvent.key !== 'Enter' || (!keyEvent.metaKey && !keyEvent.ctrlKey)) return
          keyEvent.preventDefault()
          submitText()
        })
        custom.append(customLabel, input, submit, error)
        surface.append(custom)
      }
    }
    overlay.append(surface)
    appendTranscriptElement(overlay)
    setConversationMode(true)
    workflowSurfaceReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    workflowSurface = overlay
    workflowSurfaceRequestId = event.requestId
    lifetime.frame(() => overlay.classList.add('visible'))
    const firstControl = surface.querySelector<HTMLElement>('.workflow-surface-choice, .workflow-surface-select, input, .workflow-surface-close')
    firstControl?.focus()
    scrollTranscript()
  }

  function setConversationMode(active: boolean) {
    mainScroll.classList.toggle('conversation-mode', active)
    mainPanel.classList.toggle('has-conversation', active)
    updateWorkPlanToggleState()
    renderProjectedWorkPlan()
    app.querySelector('#composer-start-context')?.setAttribute('aria-hidden', String(active))
    syncComposerMenuPlacement()
    resizeTaskInput()
    scheduleConversationNavigatorSync()
  }

  function refreshConversationTransitionTargets() {
    app.querySelectorAll<HTMLElement>('.navigation-pending').forEach(element => element.classList.remove('navigation-pending'))
    app.querySelectorAll<HTMLElement>('[aria-busy="true"][data-conversation-id], #new-task[aria-busy="true"], .workspace-task-group-create[aria-busy="true"]')
      .forEach(element => element.removeAttribute('aria-busy'))
    if (!activeConversationTransitionId) return
    let source = conversationTransitionSource
    if (conversationTransitionKind === 'switch') {
      source = Array.from(app.querySelectorAll<HTMLButtonElement>('[data-conversation-id]'))
        .find(button => button.dataset.conversationId === conversationTransitionTargetId) || null
    }
    if (!source) return
    source.classList.add('navigation-pending')
    source.setAttribute('aria-busy', 'true')
    source.closest<HTMLElement>('.conversation-row')?.classList.add('navigation-pending')
  }

  function beginConversationTransition(kind: 'switch' | 'new', targetId = '', source: HTMLElement | null = null): number {
    const transitionId = ++conversationTransitionSequence
    activeConversationTransitionId = transitionId
    conversationTransitionKind = kind
    conversationTransitionTargetId = targetId
    conversationTransitionSource = source || (kind === 'new' ? newTaskButton : null)
    if (conversationTransitionSettleTimer !== null) lifetime.clearTimeout(conversationTransitionSettleTimer)
    if (conversationTransitionFrame !== null) lifetime.cancelFrame(conversationTransitionFrame)
    conversationTransitionSettleTimer = null
    conversationTransitionFrame = null
    closeComposerMenus()
    shell.classList.add('conversation-transitioning')
    shell.classList.toggle('conversation-transition-new', kind === 'new')
    mainScroll.classList.remove('conversation-transition-entering', 'conversation-transition-recovering')
    mainScroll.setAttribute('aria-busy', 'true')
    refreshConversationTransitionTargets()
    conversationTransitionFrame = lifetime.frame(() => {
      conversationTransitionFrame = null
      if (activeConversationTransitionId === transitionId) mainScroll.classList.add('conversation-transition-leaving')
    })
    return transitionId
  }

  function finishConversationTransition(transitionId: number, succeeded: boolean) {
    if (activeConversationTransitionId !== transitionId) return
    activeConversationTransitionId = 0
    if (conversationTransitionFrame !== null) lifetime.cancelFrame(conversationTransitionFrame)
    conversationTransitionFrame = null
    shell.classList.remove('conversation-transitioning', 'conversation-transition-new')
    mainScroll.classList.remove('conversation-transition-leaving', 'conversation-transition-entering', 'conversation-transition-recovering')
    mainScroll.removeAttribute('aria-busy')
    conversationTransitionKind = null
    conversationTransitionTargetId = ''
    conversationTransitionSource = null
    refreshConversationTransitionTargets()
    void mainScroll.offsetWidth
    const settleClass = succeeded ? 'conversation-transition-entering' : 'conversation-transition-recovering'
    mainScroll.classList.add(settleClass)
    conversationTransitionSettleTimer = lifetime.timeout(() => {
      mainScroll.classList.remove(settleClass)
      conversationTransitionSettleTimer = null
    }, succeeded ? 320 : 220)
  }

  function resizeTaskInput() {
    const minimumHeight = mainScroll.classList.contains('conversation-mode') ? 38 : 58
    const maximumHeight = 220
    taskInput.style.height = 'auto'
    const nextHeight = Math.min(maximumHeight, Math.max(minimumHeight, taskInput.scrollHeight))
    taskInput.style.height = `${nextHeight}px`
    taskInput.style.overflowY = taskInput.scrollHeight > maximumHeight ? 'auto' : 'hidden'
    syncComposerMenuPlacement()
    settingsCenter?.repositionComposerPicker()
  }

  function cancelTranscriptScroll() {
    if (transcriptScrollFrame !== null) lifetime.cancelFrame(transcriptScrollFrame)
    transcriptScrollFrame = null
  }

  function conversationNavigatorCopy(input: HTMLElement, answer?: HTMLElement): { title: string; summary: string } {
    const request = input.querySelector<HTMLElement>('.message-content')?.textContent || 'This task'
    const delivery = answer?.querySelector<HTMLElement>('.message-content')?.textContent || 'Working on this task'
    return {
      title: compactConversationNavigatorText(request, 64),
      summary: compactConversationNavigatorText(delivery, 168),
    }
  }

  function syncConversationNavigatorActiveState() {
    if (!conversationNavigator.classList.contains('visible')) return
    const transcriptBounds = transcript.getBoundingClientRect()
    for (const entry of conversationNavigatorEntries) {
      entry.offsetTop = transcript.scrollTop + entry.target.getBoundingClientRect().top - transcriptBounds.top
    }
    const activeIndices = activeConversationNavigatorIndices(
      conversationNavigatorEntries.map(entry => entry.offsetTop),
      transcript.scrollTop,
      transcript.clientHeight,
    )
    const activeSet = new Set(activeIndices)
    for (const [index, entry] of conversationNavigatorEntries.entries()) {
      const active = activeSet.has(index)
      entry.marker.classList.toggle('active', active)
      if (active) entry.marker.setAttribute('aria-current', 'true')
      else entry.marker.removeAttribute('aria-current')
    }
    const activeIndex = activeIndices[0] ?? -1
    if (activeIndex !== conversationNavigatorActiveIndex) {
      conversationNavigatorActiveIndex = activeIndex
      const activeMarker = conversationNavigatorEntries[activeIndex]?.marker
      if (activeMarker) {
        const markerTop = activeMarker.offsetTop
        const markerBottom = markerTop + activeMarker.offsetHeight
        const viewportTop = conversationNavigatorMarkers.scrollTop
        const viewportBottom = viewportTop + conversationNavigatorMarkers.clientHeight
        if (markerTop < viewportTop + 4) conversationNavigatorMarkers.scrollTop = Math.max(0, markerTop - 4)
        else if (markerBottom > viewportBottom - 4) {
          conversationNavigatorMarkers.scrollTop = markerBottom - conversationNavigatorMarkers.clientHeight + 4
        }
      }
    }
  }

  function previewConversationNavigatorEntry(previewIndex?: number) {
    conversationNavigatorMarkers.classList.toggle('interacting', previewIndex !== undefined)
    for (const [index, entry] of conversationNavigatorEntries.entries()) {
      const visual = conversationNavigatorMarkerVisual(index, previewIndex)
      entry.marker.classList.toggle('previewing', index === previewIndex)
      entry.marker.dataset.visualTone = visual.tone
      entry.marker.style.setProperty('--conversation-navigator-marker-opacity', String(visual.opacity))
      entry.marker.style.setProperty('--conversation-navigator-marker-scale', String(visual.scaleX))
    }
    const entry = previewIndex === undefined ? undefined : conversationNavigatorEntries[previewIndex]
    if (!entry) {
      conversationNavigatorPopover.classList.remove('visible')
      conversationNavigatorPopover.setAttribute('aria-hidden', 'true')
      return
    }
    conversationNavigatorPopoverTitle.textContent = entry.title
    conversationNavigatorPopoverSummary.textContent = entry.summary
    conversationNavigatorPopover.classList.add('visible')
    conversationNavigatorPopover.setAttribute('aria-hidden', 'false')
    const navigatorBounds = conversationNavigator.getBoundingClientRect()
    const markerBounds = entry.marker.getBoundingClientRect()
    const popoverHalfHeight = conversationNavigatorPopover.offsetHeight / 2
    const markerCenter = markerBounds.top - navigatorBounds.top + (markerBounds.height / 2)
    const popoverTop = Math.min(
      Math.max(popoverHalfHeight + 5, markerCenter),
      Math.max(popoverHalfHeight + 5, conversationNavigator.clientHeight - popoverHalfHeight - 5),
    )
    conversationNavigatorPopover.style.setProperty('--conversation-navigator-popover-top', `${popoverTop}px`)
  }

  function revealConversationNavigatorTarget(target: HTMLElement) {
    const region = target.closest<HTMLElement>('.task-turn-fold-region')
    if (!region || region.classList.contains('expanded')) return
    const content = region.querySelector<HTMLElement>(':scope > .task-turn-fold-content')
    const disclosure = region.previousElementSibling?.querySelector<HTMLButtonElement>(':scope > .task-turn-disclosure')
    const label = disclosure?.querySelector<HTMLElement>('strong')
    if (!content || !disclosure || !label) return
    const runId = region.dataset.runId
    if (runId) expandedTaskRunIds.add(runId)
    const transition = region.style.transition
    region.style.transition = 'none'
    setTaskTurnRegionExpandedFromDisclosure(region, content, disclosure, label, true)
    void region.offsetHeight
    region.style.transition = transition
  }

  function jumpToConversationNavigatorTarget(target: HTMLElement, behavior: ScrollBehavior = 'smooth') {
    cancelTranscriptScroll()
    transcriptFollowState = suspendTranscriptFollow(transcriptFollowState)
    revealConversationNavigatorTarget(target)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const transcriptBounds = transcript.getBoundingClientRect()
    const targetTop = transcript.scrollTop + target.getBoundingClientRect().top - transcriptBounds.top
    transcript.scrollTo({
      top: Math.max(0, targetTop - 12),
      behavior: reduceMotion ? 'auto' : behavior,
    })
    target.classList.remove('conversation-navigator-target')
    lifetime.frame(() => target.classList.add('conversation-navigator-target'))
    lifetime.timeout(() => target.classList.remove('conversation-navigator-target'), reduceMotion ? 80 : 1_400)
  }

  function syncConversationNavigator() {
    conversationNavigatorSyncFrame = null
    const taskItems = Array.from(transcript.querySelectorAll<HTMLElement>('.linear-flow-input, .linear-flow-answer'))
    const pairs = pairConversationNavigatorTasks(taskItems.map(item => ({
      kind: item.classList.contains('linear-flow-input') ? 'input' : 'answer',
      runId: item.dataset.runId || '',
      finalDelivery: item.dataset.finalDelivery === 'true',
    })))
    const conversationActive = mainScroll.classList.contains('conversation-mode')
    const mainBounds = mainScroll.getBoundingClientRect()
    const transcriptBounds = transcript.getBoundingClientRect()
    const hasLeftGutter = transcriptBounds.left - mainBounds.left >= 48
    const visible = conversationActive && pairs.length >= conversationNavigatorMinimumItems && hasLeftGutter
    conversationNavigator.classList.toggle('visible', visible)
    conversationNavigator.setAttribute('aria-hidden', String(!visible))
    if (!visible) {
      conversationNavigatorActiveIndex = -1
      conversationNavigatorEntries = []
      conversationNavigatorMarkers.replaceChildren()
      previewConversationNavigatorEntry()
      return
    }

    conversationNavigator.style.setProperty('--conversation-navigator-top', `${Math.max(0, transcriptBounds.top - mainBounds.top)}px`)
    conversationNavigator.style.setProperty('--conversation-navigator-height', `${Math.max(0, transcriptBounds.height)}px`)

    const fragment = document.createDocumentFragment()
    conversationNavigatorActiveIndex = -1
    conversationNavigatorEntries = []

    for (const [pairIndex, pair] of pairs.entries()) {
      const target = taskItems[pair.inputIndex]
      if (!target) continue
      const answer = pair.answerIndex === undefined ? undefined : taskItems[pair.answerIndex]
      const copy = conversationNavigatorCopy(target, answer)
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.className = 'conversation-navigator-marker'
      marker.dataset.visualTone = 'idle'
      marker.dataset.navigatorIndex = String(pairIndex)
      const visual = conversationNavigatorMarkerVisual(pairIndex)
      marker.style.setProperty('--conversation-navigator-marker-opacity', String(visual.opacity))
      marker.style.setProperty('--conversation-navigator-marker-scale', String(visual.scaleX))
      marker.setAttribute('aria-label', `Jump to task ${pairIndex + 1} ：${copy.title}`)
      marker.setAttribute('aria-posinset', String(pairIndex + 1))
      marker.setAttribute('aria-setsize', String(pairs.length))
      const line = document.createElement('span')
      line.className = 'conversation-navigator-line'
      line.setAttribute('aria-hidden', 'true')
      marker.append(line)
      marker.addEventListener('click', () => {
        if (conversationNavigatorSuppressClick) {
          conversationNavigatorSuppressClick = false
          return
        }
        jumpToConversationNavigatorTarget(target)
      })
      fragment.append(marker)
      conversationNavigatorEntries.push({ marker, target, offsetTop: 0, ...copy })
      marker.addEventListener('pointerenter', () => previewConversationNavigatorEntry(pairIndex))
      marker.addEventListener('pointerleave', () => {
        if (!conversationNavigatorScrub) previewConversationNavigatorEntry()
      })
      marker.addEventListener('focus', () => previewConversationNavigatorEntry(pairIndex))
      marker.addEventListener('blur', () => {
        if (!conversationNavigatorScrub) previewConversationNavigatorEntry()
      })
    }
    conversationNavigatorMarkers.replaceChildren(fragment)
    syncConversationNavigatorActiveState()
  }

  conversationNavigatorMarkers.addEventListener('scroll', () => previewConversationNavigatorEntry(), { passive: true })

  function conversationNavigatorIndexAt(clientY: number): number | undefined {
    const bounds = conversationNavigatorMarkers.getBoundingClientRect()
    if (bounds.height <= 0) return undefined
    const pointY = Math.max(bounds.top, Math.min(clientY, bounds.bottom - 1))
    const element = document.elementFromPoint(bounds.left + (bounds.width / 2), pointY)
    const marker = element?.closest<HTMLButtonElement>('.conversation-navigator-marker')
    if (!marker || !conversationNavigatorMarkers.contains(marker)) return undefined
    const index = Number(marker.dataset.navigatorIndex)
    return Number.isInteger(index) ? index : undefined
  }

  function finishConversationNavigatorScrub(pointerId: number, clientY?: number) {
    const scrub = conversationNavigatorScrub
    if (!scrub || scrub.pointerId !== pointerId) return
    conversationNavigatorScrub = null
    conversationNavigatorMarkers.classList.remove('scrubbing')
    if (conversationNavigatorMarkers.hasPointerCapture?.(pointerId)) {
      conversationNavigatorMarkers.releasePointerCapture(pointerId)
    }
    if (scrub.moved) {
      conversationNavigatorSuppressClick = true
      lifetime.timeout(() => { conversationNavigatorSuppressClick = false }, 0)
    }
    const index = clientY === undefined ? undefined : conversationNavigatorIndexAt(clientY)
    previewConversationNavigatorEntry(index)
  }

  conversationNavigatorMarkers.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    const marker = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.conversation-navigator-marker')
      : null
    if (!marker) return
    const index = Number(marker.dataset.navigatorIndex)
    if (!Number.isInteger(index)) return
    conversationNavigatorScrub = { pointerId: event.pointerId, index, moved: false }
    conversationNavigatorMarkers.classList.add('scrubbing')
    conversationNavigatorMarkers.setPointerCapture?.(event.pointerId)
    previewConversationNavigatorEntry(index)
  })

  conversationNavigatorMarkers.addEventListener('pointermove', event => {
    const scrub = conversationNavigatorScrub
    if (!scrub || scrub.pointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) {
      finishConversationNavigatorScrub(event.pointerId, event.clientY)
      return
    }
    const index = conversationNavigatorIndexAt(event.clientY)
    if (index === undefined || index === scrub.index) return
    scrub.index = index
    scrub.moved = true
    previewConversationNavigatorEntry(index)
    const entry = conversationNavigatorEntries[index]
    if (entry) jumpToConversationNavigatorTarget(entry.target, 'auto')
  })

  conversationNavigatorMarkers.addEventListener('pointerup', event => {
    finishConversationNavigatorScrub(event.pointerId, event.clientY)
  })
  conversationNavigatorMarkers.addEventListener('pointercancel', event => {
    finishConversationNavigatorScrub(event.pointerId)
  })
  conversationNavigatorMarkers.addEventListener('lostpointercapture', event => {
    finishConversationNavigatorScrub(event.pointerId)
  })

  function jumpToAdjacentConversationNavigatorEntry(direction: 'previous' | 'next'): boolean {
    if (!conversationNavigator.classList.contains('visible') || conversationNavigatorEntries.length === 0) return false
    const transcriptTop = transcript.getBoundingClientRect().top
    let targetIndex = -1
    if (direction === 'next') {
      targetIndex = conversationNavigatorEntries.findIndex(entry => (
        entry.target.getBoundingClientRect().top > transcriptTop + 24
      ))
    } else {
      for (let index = conversationNavigatorEntries.length - 1; index >= 0; index -= 1) {
        const itemTop = conversationNavigatorEntries[index].target.getBoundingClientRect().top
        if (Math.abs(itemTop - transcriptTop) <= 24) {
          targetIndex = index - 1
          break
        }
        if (itemTop < transcriptTop) {
          targetIndex = index
          break
        }
      }
      if (targetIndex < 0 && conversationNavigatorEntries[0].target.getBoundingClientRect().top > transcriptTop) {
        targetIndex = 0
      }
    }
    const entry = conversationNavigatorEntries[targetIndex]
    if (!entry) return false
    jumpToConversationNavigatorTarget(entry.target)
    return true
  }

  function scheduleConversationNavigatorSync() {
    if (conversationNavigatorSyncFrame !== null) return
    conversationNavigatorSyncFrame = lifetime.frame(syncConversationNavigator)
  }

  function unwrapTaskTurnFoldRegions() {
    for (const region of transcript.querySelectorAll<HTMLElement>(':scope > .task-turn-fold-region')) {
      const content = region.querySelector<HTMLElement>(':scope > .task-turn-fold-content')
      if (content) {
        for (const child of Array.from(content.children)) transcript.insertBefore(child, region)
      }
      region.remove()
    }
  }

  function setTaskTurnRegionExpanded(
    region: HTMLElement,
    content: HTMLElement,
    disclosure: HTMLButtonElement,
    label: HTMLElement,
    expanded: boolean,
  ) {
    region.classList.toggle('expanded', expanded)
    disclosure.setAttribute('aria-expanded', String(expanded))
    label.textContent = expanded ? '收起过程' : '处理过程'
    content.setAttribute('aria-hidden', String(!expanded))
    if (expanded) content.removeAttribute('inert')
    else content.setAttribute('inert', '')
  }

  function setTaskTurnRegionExpandedFromDisclosure(
    region: HTMLElement,
    content: HTMLElement,
    disclosure: HTMLButtonElement,
    label: HTMLElement,
    expanded: boolean,
  ) {
    cancelTranscriptScroll()
    transcriptFollowState = suspendTranscriptFollow(transcriptFollowState)
    const disclosureViewportTop = disclosure.getBoundingClientRect().top
    setTaskTurnRegionExpanded(region, content, disclosure, label, expanded)
    lifetime.frame(() => {
      if (!disclosure.isConnected) return
      transcript.scrollTop += disclosure.getBoundingClientRect().top - disclosureViewportTop
      transcriptFollowState = {
        following: false,
        lastScrollTop: transcript.scrollTop,
      }
    })
  }

  function applyCompletedTaskFolding() {
    const conversationId = currentSnapshot?.conversation.id || ''
    if (taskFoldingConversationId !== conversationId) {
      expandedTaskRunIds.clear()
      taskRunSeenActiveIds.clear()
      taskFoldingConversationId = conversationId
    }

    unwrapTaskTurnFoldRegions()
    const items = Array.from(transcript.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.classList.contains('linear-flow-item')
    ))
    for (const item of items) {
      item.hidden = false
      item.classList.remove('task-turn-intermediate')
      item.querySelector<HTMLElement>(':scope > .task-turn-disclosure')?.remove()
    }

    const itemsByRun = new Map<string, HTMLElement[]>()
    for (const item of items) {
      const runId = item.dataset.runId
      if (!runId) continue
      const runItems = itemsByRun.get(runId) || []
      runItems.push(item)
      itemsByRun.set(runId, runItems)
    }
    const runsById = new Map((currentSnapshot?.activity.execution.runs || []).map(run => [run.id, run]))

    for (const [runId, runItems] of itemsByRun) {
      const run = runsById.get(runId)
      if (run?.responseMode === 'task') {
        taskRunSeenActiveIds.delete(runId)
        continue
      }
      const foldableStatus = Boolean(executionOutcomeFromWorkRunStatus(run?.status))
      const input = runItems.find(item => item.classList.contains('linear-flow-input'))
      const answers = runItems.filter(item => item.classList.contains('linear-flow-answer'))
      const finalAnswer = [...answers].reverse().find(item => item.dataset.finalDelivery === 'true') || answers.at(-1)
      if (!foldableStatus || !run || !input || !finalAnswer) {
        expandedTaskRunIds.delete(runId)
        if (run && !executionOutcomeFromWorkRunStatus(run.status)) taskRunSeenActiveIds.add(runId)
        else taskRunSeenActiveIds.delete(runId)
        continue
      }

      const intermediateItems = runItems.filter(item => item !== input && item !== finalAnswer)
      if (intermediateItems.length === 0) continue
      const expanded = expandedTaskRunIds.has(runId)
      const animateAutomaticCollapse = taskRunSeenActiveIds.delete(runId) && !expanded

      const region = document.createElement('div')
      region.className = 'task-turn-fold-region'
      region.dataset.runId = runId
      const content = document.createElement('div')
      content.className = 'task-turn-fold-content'
      region.append(content)
      input.insertAdjacentElement('afterend', region)
      for (const item of intermediateItems) {
        item.classList.add('task-turn-intermediate')
        content.append(item)
      }

      const disclosure = document.createElement('button')
      disclosure.type = 'button'
      disclosure.className = 'task-turn-disclosure'
      disclosure.setAttribute('aria-expanded', String(expanded))
      const label = document.createElement('strong')
      label.textContent = expanded ? '收起过程' : '处理过程'
      const chevron = document.createElement('span')
      chevron.className = 'task-turn-disclosure-chevron'
      chevron.innerHTML = icon('chevron')
      disclosure.append(label)
      const startedAt = Number(input.querySelector<HTMLElement>('.message-row.user')?.dataset.timestamp)
      const completedAt = Number(finalAnswer.querySelector<HTMLElement>('.message-row.assistant')?.dataset.timestamp)
      const durationLabel = completedTaskTurnDuration(startedAt, completedAt)
      if (durationLabel) {
        const duration = document.createElement('span')
        duration.textContent = durationLabel
        disclosure.append(duration)
      }
      disclosure.append(chevron)
      disclosure.addEventListener('click', () => {
        const nextExpanded = !expandedTaskRunIds.has(runId)
        if (nextExpanded) expandedTaskRunIds.add(runId)
        else expandedTaskRunIds.delete(runId)
        setTaskTurnRegionExpandedFromDisclosure(region, content, disclosure, label, nextExpanded)
      })
      region.addEventListener('transitionend', event => {
        if (event.target === region && event.propertyName === 'grid-template-rows') scheduleConversationNavigatorSync()
      })
      input.append(disclosure)
      setTaskTurnRegionExpanded(region, content, disclosure, label, expanded || animateAutomaticCollapse)
      if (animateAutomaticCollapse) {
        disclosure.setAttribute('aria-expanded', 'false')
        label.textContent = '处理过程'
        content.setAttribute('aria-hidden', 'true')
        content.setAttribute('inert', '')
        void region.offsetHeight
        lifetime.frame(() => {
          if (region.isConnected) region.classList.remove('expanded')
        })
      }
    }
  }

  function refreshHistoryRewriteViewportSpace() {
    if (!historyRewriteAnchorTurnId || !historyRewriteLeadingSpacer?.isConnected || !historyRewriteSpacer?.isConnected) return
    const anchor = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(historyRewriteAnchorTurnId)}"]`)
    if (!anchor) return
    const contentAfterAnchorHeight = Math.max(
      0,
      historyRewriteSpacer.offsetTop - anchor.offsetTop - anchor.offsetHeight,
    )
    const nextHeight = historyRewriteTailSpace({
      clientHeight: transcript.clientHeight,
      contentAfterAnchorHeight,
    })
    const value = `${nextHeight}px`
    if (historyRewriteSpacer.style.height !== value) historyRewriteSpacer.style.height = value
    const contentBeforeAnchorHeight = Math.max(0, anchor.offsetTop - historyRewriteLeadingSpacer.offsetHeight)
    const nextLeadingHeight = historyRewriteLeadingSpace({
      clientHeight: transcript.clientHeight,
      contentBeforeAnchorHeight,
      anchorHeight: anchor.offsetHeight,
      contentAfterAnchorHeight,
    })
    const leadingValue = `${nextLeadingHeight}px`
    if (historyRewriteLeadingSpacer.style.height !== leadingValue) historyRewriteLeadingSpacer.style.height = leadingValue
  }

  function mountHistoryRewriteViewportSpace() {
    if (!historyRewriteAnchorTurnId) return
    historyRewriteSpacer?.remove()
    historyRewriteLeadingSpacer?.remove()
    const anchor = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(historyRewriteAnchorTurnId)}"]`)
    if (!anchor) return
    const leadingSpacer = document.createElement('div')
    leadingSpacer.className = 'history-rewrite-leading-space'
    leadingSpacer.setAttribute('aria-hidden', 'true')
    historyRewriteLeadingSpacer = leadingSpacer
    transcript.insertBefore(leadingSpacer, anchor)
    const spacer = document.createElement('div')
    spacer.className = 'history-rewrite-viewport-space'
    spacer.setAttribute('aria-hidden', 'true')
    historyRewriteSpacer = spacer
    transcript.append(spacer)
    refreshHistoryRewriteViewportSpace()
  }

  function startHistoryRewriteViewport(turnId: string) {
    historyRewriteAnchorTurnId = turnId
    mountHistoryRewriteViewportSpace()
    scrollTranscript(true)
  }

  function clearHistoryRewriteViewport() {
    transcript.querySelector<HTMLElement>('[data-history-rewrite-optimistic="true"]')?.remove()
    historyRewriteOptimisticTurn = null
    historyRewriteAnchorTurnId = ''
    historyRewriteLeadingSpacer?.remove()
    historyRewriteLeadingSpacer = null
    historyRewriteSpacer?.remove()
    historyRewriteSpacer = null
  }

  function appendTranscriptElement(element: HTMLElement) {
    if (historyRewriteSpacer?.isConnected) transcript.insertBefore(element, historyRewriteSpacer)
    else transcript.append(element)
  }

  function scrollTranscript(force = false) {
    if (force) transcriptFollowState = forceTranscriptFollow(transcriptFollowState, transcript)
    if (!transcriptFollowState.following || transcriptScrollFrame !== null) return
    transcriptScrollFrame = lifetime.frame(() => {
      transcriptScrollFrame = null
      if (!transcriptFollowState.following) return
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'auto' })
      transcriptFollowState = updateTranscriptFollowFromScroll(transcriptFollowState, transcript)
      lifetime.frame(() => {
        if (transcriptFollowState.following && transcriptDistanceFromBottom(transcript) > 2) scrollTranscript()
      })
    })
  }

  function captureTranscriptViewportAnchor(): { turnId: string; offset: number; scrollTop: number } | null {
    const viewport = transcript.getBoundingClientRect()
    const anchor = Array.from(transcript.querySelectorAll<HTMLElement>('[data-turn-id]'))
      .find(element => element.getBoundingClientRect().bottom >= viewport.top)
    const turnId = anchor?.dataset.turnId
    return turnId
      ? { turnId, offset: anchor!.getBoundingClientRect().top - viewport.top, scrollTop: transcript.scrollTop }
      : { turnId: '', offset: 0, scrollTop: transcript.scrollTop }
  }

  function restoreTranscriptViewportAnchor(anchor: { turnId: string; offset: number; scrollTop: number }) {
    cancelTranscriptScroll()
    transcriptFollowState = suspendTranscriptFollow(transcriptFollowState)
    lifetime.frame(() => {
      const element = anchor.turnId
        ? transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.turnId)}"]`)
        : null
      if (element) {
        const viewport = transcript.getBoundingClientRect()
        transcript.scrollTop += element.getBoundingClientRect().top - viewport.top - anchor.offset
      } else {
        transcript.scrollTop = anchor.scrollTop
      }
      transcriptFollowState = {
        following: false,
        lastScrollTop: transcript.scrollTop,
      }
    })
  }

  const observedTranscriptChildren = new Set<Element>()
  const transcriptResizeObserver = new ResizeObserver(() => {
    refreshHistoryRewriteViewportSpace()
    scrollTranscript()
    scheduleConversationNavigatorSync()
  })
  const conversationNavigatorResizeObserver = new ResizeObserver(scheduleConversationNavigatorSync)
  conversationNavigatorResizeObserver.observe(mainScroll)
  conversationNavigatorResizeObserver.observe(transcript)
  const syncTranscriptResizeTargets = () => {
    for (const child of observedTranscriptChildren) {
      if (child.parentElement === transcript) continue
      transcriptResizeObserver.unobserve(child)
      observedTranscriptChildren.delete(child)
    }
    for (const child of transcript.children) {
      if (observedTranscriptChildren.has(child)) continue
      observedTranscriptChildren.add(child)
      transcriptResizeObserver.observe(child)
    }
  }
  const transcriptMutationObserver = new MutationObserver(() => {
    syncTranscriptResizeTargets()
    refreshHistoryRewriteViewportSpace()
    scrollTranscript()
    scheduleConversationNavigatorSync()
  })
  transcriptMutationObserver.observe(transcript, { childList: true })
  syncTranscriptResizeTargets()
  scheduleConversationNavigatorSync()

  function collectToolResults(turns: AgentTurn[]): Map<string, ToolResult> {
    const results = new Map<string, ToolResult>()
    for (const turn of turns) {
      for (const result of turn.toolResults || []) results.set(result.toolCallId, result)
    }
    return results
  }

  function collectChanges(turns: AgentTurn[]): ChangeSummary[] {
    const changes: ChangeSummary[] = []
    const seen = new Set<string>()
    for (const turn of turns) {
      for (const result of turn.toolResults || []) {
        const change = result.changeSummary
        if (!change) continue
        const key = `${result.toolCallId}:${change.path}`
        if (seen.has(key)) continue
        seen.add(key)
        changes.push(change)
      }
    }
    return changes.reverse()
  }

  function visibleToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
    return (calls || []).filter(call => !isInternalRuntimeTool(call.name))
  }

  function prepareForHistoryRewrite(retainedTurns: AgentTurn[]) {
    transcriptIndex.reset(retainedTurns)
    activeTaskStartedAt = 0
    projectedWorkRunId = ''
    expandedTaskRunIds.clear()
    taskRunSeenActiveIds.clear()
    if (currentSnapshot) {
      const retainedRunIds = new Set(retainedTurns
        .filter(turn => turn.role === 'user')
        .map(turn => turn.metadata?.workRunId || turn.id))
      const retainedWorkNodes = Object.fromEntries(Object.entries(currentSnapshot.work.projection.nodes)
        .filter(([, node]) => !node.runId || retainedRunIds.has(node.runId)))
      currentSnapshot.conversation.turns = retainedTurns
      currentSnapshot.activity.execution = {
        ...currentSnapshot.activity.execution,
        currentRunId: null,
        runs: currentSnapshot.activity.execution.runs.filter(run => retainedRunIds.has(run.id)),
      }
      currentSnapshot.work = {
        ...currentSnapshot.work,
        projection: {
          ...currentSnapshot.work.projection,
          revision: currentSnapshot.work.projection.revision + 1,
          activeRunId: undefined,
          nodes: retainedWorkNodes,
          order: currentSnapshot.work.projection.order.filter(key => Boolean(retainedWorkNodes[key])),
        },
      }
    }
    renderProjectedWorkPlan()
    renderTurns(retainedTurns)
  }

  function refreshExecutionVisualEvidence(snapshot: WorkbenchSnapshot) {
    const lastLinearItemByRun = new Map<string, HTMLElement>()
    for (const item of transcript.querySelectorAll<HTMLElement>('.linear-flow-item[data-run-id]')) {
      if (item.dataset.runId) lastLinearItemByRun.set(item.dataset.runId, item)
    }
    for (const item of transcript.querySelectorAll<HTMLElement>('.linear-flow-item[data-run-id]')) {
      if (!item.dataset.runId || lastLinearItemByRun.get(item.dataset.runId) === item) continue
      item.querySelector('.linear-flow-visual-evidence')?.remove()
    }
    const targets = [...lastLinearItemByRun.values()]
    for (const group of targets) {
      let host = group.querySelector<HTMLElement>('.execution-visual-evidence')
      if (!host && group.classList.contains('linear-flow-item')) {
        host = document.createElement('div')
        host.className = 'execution-visual-evidence linear-flow-visual-evidence'
        group.append(host)
      }
      const runId = group.dataset.runId || ''
      const run = runId ? snapshot.activity.execution.runs.find(candidate => candidate.id === runId) : undefined
      if (!host) continue
      const runActive = Boolean(
        runId
        && (
          snapshot.activity.execution.currentRunId === runId
          || (run && !executionOutcomeFromWorkRunStatus(run.status))
        )
      )
      if (runActive) {
        host.hidden = true
        host.replaceChildren()
        delete host.dataset.evidenceSignature
        continue
      }
      const startedAt = Number(group.dataset.startedAt) || run?.startedAt || 0
      if (!Number.isFinite(startedAt) || startedAt <= 0) continue
      const completedAt = Number(group.dataset.completedAt)
      const items = visualEvidenceItems(snapshot.artifacts.artifacts, {
        conversationId: snapshot.conversation.id,
        startedAt,
        completedAt: Number.isFinite(completedAt) && completedAt > 0 ? completedAt : run?.completedAt,
      })
      renderVisualEvidence(host, items, {
        loadPreview: artifactId => loadArtifactPreview(artifactId, 'thumbnail'),
        open: (evidence, initialIndex) => imageLightbox?.open(evidenceLightboxItems(evidence), initialIndex),
        defaultCollapsed: true,
      })
    }
  }

  async function copyMessageText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const fallback = document.createElement('textarea')
      fallback.value = text
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.append(fallback)
      fallback.select()
      document.execCommand('copy')
      fallback.remove()
    }
    showToast('已复制')
  }

  function createMessageActions(turn: AgentTurn, visibleContent: string, row: HTMLElement): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'message-actions'
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'message-action'
    copyButton.title = '复制'
    copyButton.setAttribute('aria-label', '复制消息')
    copyButton.innerHTML = icon('copy')
    copyButton.addEventListener('click', () => void copyMessageText(visibleContent))
    actions.append(copyButton)
    if (turn.role === 'user') {
      const editButton = document.createElement('button')
      editButton.type = 'button'
      editButton.className = 'message-action'
      editButton.title = '编辑并重发'
      editButton.setAttribute('aria-label', '编辑消息并从这里重新发送')
      editButton.innerHTML = icon('edit')
      editButton.addEventListener('click', () => startEditingTurn(turn, row))
      actions.append(editButton)
    }
    return actions
  }

  function formatMessageDuration(durationMs: number | undefined): string {
    const duration = Number.isFinite(durationMs) && durationMs !== undefined && durationMs >= 0
      ? durationMs < 1_000
        ? '不到 1 秒'
        : `${Math.max(1, Math.round(durationMs / 1_000))} 秒`
      : ''
    return duration
  }

  function createMessageMeta(turn: AgentTurn, visibleContent: string, row: HTMLElement, includeUsage = false): HTMLElement {
    const meta = document.createElement('div')
    meta.className = 'message-meta'
    if (turn.role === 'user') meta.append(createMessageTime(turn.timestamp))
    if (turn.role === 'assistant' && includeUsage) {
      const usage = document.createElement('span')
      usage.className = 'message-usage'
      usage.textContent = formatMessageDuration(turn.metadata?.duration)
      usage.hidden = !usage.textContent
      meta.append(usage)
    }
    meta.append(createMessageActions(turn, visibleContent, row))
    return meta
  }

  function startEditingTurn(turn: AgentTurn, row: HTMLElement) {
    if (!bridge) return showToast('桌面核心未连接')
    if (currentSnapshot?.persistence.status === 'degraded') return showToast('会话暂时无法保存，请先恢复保存')
    if (editingTurnId && editingTurnId !== turn.id) renderTurns(currentSnapshot?.conversation.turns || [])
    editingTurnId = turn.id
    row.classList.add('editing')
    const editor = document.createElement('div')
    editor.className = 'message-editor'
    const input = document.createElement('textarea')
    input.value = turn.content
    input.rows = 3
    input.setAttribute('aria-label', '编辑消息')
    const footer = document.createElement('div')
    footer.className = 'message-editor-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'message-editor-cancel'
    cancel.textContent = '取消'
    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'message-editor-send'
    send.title = '重新发送'
    send.setAttribute('aria-label', '重新发送编辑后的消息')
    send.innerHTML = icon('arrow')
    footer.append(cancel, send)
    editor.append(input, footer)
    row.replaceChildren(editor)

    const resendGuard = new SingleFlightGuard()
    const restore = () => {
      if (resendGuard.active) return
      editingTurnId = ''
      if (pendingConversationRender && currentSnapshot) {
        pendingConversationRender = false
        renderTurns(currentSnapshot.conversation.turns)
        renderedConversationSignature = conversationRenderSignature(currentSnapshot.conversation.turns, latestConversationFailure(currentSnapshot))
        return
      }
      const replacement = createMessageElement(turn, collectToolResults(currentSnapshot?.conversation.turns || []), false)
      if (replacement) row.replaceWith(replacement)
    }
    const resend = async () => {
      const text = input.value.trim()
      if (!text) return showToast('消息不能为空')
      const snapshotTurns = currentSnapshot?.conversation.turns || []
      const rewrite = projectHistoryRewrite(snapshotTurns, turn.id, text)
      if (!rewrite) return showToast('这条消息已经不在当前会话中')
      const release = resendGuard.tryAcquire()
      if (!release) return
      const conversationId = currentSnapshot?.conversation.id || ''
      send.disabled = true
      cancel.disabled = true
      input.readOnly = true
      try {
        if (rewrite.abandonedToolCount > 0) {
          const changedFiles = rewrite.abandonedChangedPaths.length > 0
            ? `，其中涉及 ${rewrite.abandonedChangedPaths.length} 个文件`
            : ''
          const confirmed = await openWorkbenchDialog({
            title: '从这里重新开始？',
            message: `这会删除此消息之后的对话和任务记录${changedFiles}。已经执行的文件修改或外部操作不会自动撤销。`,
            confirmLabel: '编辑并重发',
          })
          if (confirmed !== true) return
        }
        editingTurnId = ''
        pendingConversationRender = false
        resendingTurnId = turn.id
        historyRewriteRevision += 1
        clearHistoryRewriteViewport()
        historyRewriteOptimisticTurn = rewrite.optimisticTurn
        beginRequestStatusAttempt()
        prepareForHistoryRewrite(rewrite.retainedTurns)
        projectedWorkRunId = turn.id
        renderProjectedWorkPlan()
        mountHistoryRewriteOptimisticTurn()
        startHistoryRewriteViewport(turn.id)
        await bridge.resendFromTurn(turn.id, text)
        if (resendingTurnId === turn.id && currentSnapshot?.conversation.id === conversationId) {
          resendingTurnId = ''
          const snapshot = await bridge.getSnapshot()
          if (currentSnapshot?.conversation.id === conversationId && snapshot.conversation.id === conversationId) {
            applySnapshot(snapshot, true)
          }
        }
      } catch (error) {
        if (resendingTurnId === turn.id) resendingTurnId = ''
        if (currentSnapshot?.conversation.id === conversationId) {
          clearHistoryRewriteViewport()
          void bridge.getSnapshot().then(snapshot => {
            if (currentSnapshot?.conversation.id === conversationId && snapshot.conversation.id === conversationId) {
              applySnapshot(snapshot, true)
            }
          }).catch(() => undefined)
          showToast(errorMessage(error))
        }
      } finally {
        release()
        if (input.isConnected) {
          input.readOnly = false
          send.disabled = false
          cancel.disabled = false
          input.focus()
        }
      }
    }
    cancel.addEventListener('click', restore)
    send.addEventListener('click', () => void resend())
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        restore()
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void resend()
      }
    })
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }

  function createMessageElement(
    turn: AgentTurn,
    resultMap: Map<string, ToolResult>,
    includeTools = true,
    includeActions = true,
    includeThinking = includeTools,
    includeSignature = true,
    includeUsage = includeSignature,
  ): HTMLElement | null {
    if (turn.role !== 'user' && turn.role !== 'assistant') return null
    if (isLegacyRecoveryPlaceholder(turn)) return null
    if (isInternalRequestErrorTurn(turn)) return null
    const visibleContent = turn.role === 'assistant'
      ? stripTextToolCallMarkup(turn.content, { stripIncomplete: true }).trim()
      : turn.content
    const calls = includeTools ? visibleToolCalls(turn.toolCalls) : []
    if (!hasRenderableTurnPayload({
      visibleContent,
      hasThinking: Boolean(includeThinking && turn.role === 'assistant' && turn.metadata?.thinking?.content),
      attachmentCount: turn.metadata?.attachments?.length || 0,
      capabilityCount: turn.metadata?.capabilities?.items.length || 0,
      visibleToolCount: calls.length,
    })) return null

    const row = document.createElement('article')
    row.className = `message-row ${turn.role}`
    row.dataset.turnId = turn.id
    row.dataset.timestamp = String(turn.timestamp)

    if (includeThinking && turn.role === 'assistant' && turn.metadata?.thinking?.content) {
      row.append(createTaskThinkingBlock(turn.metadata.thinking, flowNodeIdForTurn(turn, 'thinking')))
    }

    if (visibleContent) {
      const content = document.createElement('div')
      content.className = 'message-content'
      if (turn.role === 'assistant') renderMarkdown(content, visibleContent)
      else content.textContent = visibleContent
      row.append(content)
    }

    if (turn.metadata?.attachments?.length) {
      const imageAttachments = turn.metadata.attachments.filter(attachment => attachment.type === 'image')
      const fileAttachments = turn.metadata.attachments.filter(attachment => attachment.type !== 'image')
      if (imageAttachments.length) {
        const gallery = document.createElement('div')
        gallery.className = 'message-image-grid'
        gallery.dataset.count = String(Math.min(4, imageAttachments.length))
        const lightboxItems = attachmentLightboxItems(imageAttachments)
        imageAttachments.forEach((attachment, imageIndex) => {
          const thumbnail = document.createElement('button')
          thumbnail.type = 'button'
          thumbnail.className = 'message-image-thumbnail'
          thumbnail.setAttribute('aria-label', `查看图片 ${imageIndex + 1}`)
          const placeholder = document.createElement('span')
          placeholder.className = 'attachment-image-placeholder'
          const image = document.createElement('img')
          image.alt = attachment.filename
          image.decoding = 'async'
          thumbnail.append(placeholder, image)
          thumbnail.addEventListener('click', () => imageLightbox?.open(lightboxItems, imageIndex))
          hydrateAttachmentThumbnail(thumbnail, image, attachment.path)
          gallery.append(thumbnail)
        })
        if (turn.role === 'user') row.insertBefore(gallery, row.querySelector('.message-content'))
        else row.append(gallery)
      }
      if (fileAttachments.length) {
        const attachments = document.createElement('div')
        attachments.className = 'message-attachments'
        for (const attachment of fileAttachments) {
        const chip = document.createElement('span')
        chip.textContent = attachment.filename
        attachments.append(chip)
        }
        row.append(attachments)
      }
    }

    if (turn.metadata?.capabilities?.items.length) {
      const capabilities = document.createElement('div')
      capabilities.className = 'message-capabilities'
      for (const capability of turn.metadata.capabilities.items) {
        const chip = document.createElement('span')
        chip.className = capability.type
        chip.innerHTML = capability.type === 'skill'
          ? icon('spark')
          : capability.id === 'browser'
            ? icon('globe')
            : capability.id === 'computer'
              ? icon('computer')
              : icon('plug')
        chip.append(document.createTextNode(capabilityDisplayName(capability)))
        capabilities.append(chip)
      }
      row.append(capabilities)
    }

    if (includeActions && visibleContent) row.append(createMessageMeta(turn, visibleContent, row, turn.role === 'assistant' && includeUsage))

    if (includeTools) {
      for (const toolCall of calls) {
        const result = resultMap.get(toolCall.id)
        row.append(createToolCard(toolCall, result, result?.isError ? 'failed' : result ? 'completed' : 'running'))
      }
    }
    return row
  }

  function bindTaskFlowNode(element: HTMLElement, nodeId: string | undefined) {
    if (nodeId) element.dataset.taskFlowNodeId = nodeId
  }

  function flowNodeIdForTurn(turn: AgentTurn, kind: 'thinking' | 'answer' | 'input'): string {
    return taskFlowNodeIdForTurn(taskFlowProjection, turn, kind)
  }

  function createTaskThinkingBlock(
    trace: ThinkingTrace,
    nodeId: string | undefined,
    options: { streaming?: boolean; expanded?: boolean } = {},
  ): HTMLElement {
    const block = createThinkingBlock(trace, options)
    bindTaskFlowNode(block, nodeId)
    return block
  }

  function renderCanonicalTaskFlow(force = false) {
    if (!taskFlowProjection) return
    renderer.cancel('transcript')
    canonicalTaskFlowForce = false
    linearTaskFlowRenderer.render(taskFlowProjection, force)
    reconcileHistoryRewriteProjection()
    if (pendingOptimisticUserElement?.isConnected && pendingOptimisticInputId) {
      const committed = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(pendingOptimisticInputId)}"]:not(.optimistic-user-turn)`)
      if (committed) clearPendingOptimisticUserTurn()
    }
    renderProjectedWorkPlan()
    setConversationMode(taskFlowProjection.order.length > 0 || transcript.childElementCount > 0)
    if (currentSnapshot) refreshExecutionVisualEvidence(currentSnapshot)
    applyCompletedTaskFolding()
    scrollTranscript()
    scheduleConversationNavigatorSync()
  }

  function cancelCanonicalTaskFlowRender() {
    renderer.cancel('transcript')
    canonicalTaskFlowForce = false
  }

  function scheduleCanonicalTaskFlowRender(force = false) {
    canonicalTaskFlowForce ||= force
    renderer.schedule('transcript', () => {
      const shouldForce = canonicalTaskFlowForce
      canonicalTaskFlowForce = false
      renderCanonicalTaskFlow(shouldForce)
    }, 10)
  }

  function reconcileHistoryRewriteUserTurn(turn: AgentTurn): HTMLElement | null {
    historyRewriteOptimisticTurn = turn
    const committed = taskFlowProjection?.order.some(id => {
      const node = taskFlowProjection?.nodes[id]
      return node?.kind === 'input' && node.turnId === turn.id
    })
    if (committed) {
      clearHistoryRewriteViewport()
      return transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"]`)
    }
    const existing = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"][data-history-rewrite-optimistic="true"]`)
    if (!existing) return mountHistoryRewriteOptimisticTurn()
    const replacement = createMessageElement(
      turn,
      collectToolResults(currentSnapshot?.conversation.turns || []),
      true,
      true,
      false,
    )
    if (!replacement) return existing
    replacement.classList.add('optimistic-user-turn')
    replacement.dataset.historyRewriteOptimistic = 'true'
    existing.replaceWith(replacement)
    refreshHistoryRewriteViewportSpace()
    return replacement
  }

  function mountHistoryRewriteOptimisticTurn(): HTMLElement | null {
    const turn = historyRewriteOptimisticTurn
    if (!turn) return null
    const existing = transcript.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn.id)}"][data-history-rewrite-optimistic="true"]`)
    if (existing) return existing
    const element = createMessageElement(
      turn,
      collectToolResults(currentSnapshot?.conversation.turns || []),
      false,
      true,
      false,
      false,
    )
    if (!element) return null
    element.classList.add('optimistic-user-turn')
    element.dataset.historyRewriteOptimistic = 'true'
    appendTranscriptElement(element)
    setConversationMode(true)
    return element
  }

  function reconcileHistoryRewriteProjection() {
    const turn = historyRewriteOptimisticTurn
    if (!turn || !taskFlowProjection) return
    const committed = taskFlowProjection.order.some(id => {
      const node = taskFlowProjection?.nodes[id]
      return node?.kind === 'input' && node.turnId === turn.id
    })
    if (!committed) {
      mountHistoryRewriteOptimisticTurn()
      return
    }
    clearHistoryRewriteViewport()
  }

  const dismissedConversationFailures = new Set<string>()
  let pendingFailureRetry = ''

  function conversationFailureKey(snapshot: WorkbenchSnapshot): string {
    const failure = latestConversationFailure(snapshot)
    const turn = failure && snapshot.conversation.turns.find(candidate => candidate.id === failure.turnId)
    return failure ? `${snapshot.conversation.id}:${failure.runId}:${failure.turnId}:${turn?.timestamp}:${failure.message}:${failure.detail || ''}` : ''
  }

  function reconcileConversationFailure(snapshot: WorkbenchSnapshot) {
    const key = conversationFailureKey(snapshot)
    const existing = transcript.querySelector<HTMLElement>('.conversation-failure')
    if (!key || dismissedConversationFailures.has(key) || pendingFailureRetry === snapshot.conversation.id) {
      existing?.remove()
      return
    }
    if (existing?.dataset.failureKey === key) return
    existing?.remove()
    const row = createConversationFailureElement(snapshot)
    if (row) transcript.append(row)
  }

  function createConversationFailureElement(snapshot: WorkbenchSnapshot): HTMLElement | null {
    const failure = latestConversationFailure(snapshot)
    if (!failure) return null
    const row = document.createElement('article')
    row.className = 'conversation-failure'
    row.dataset.runId = failure.runId
    row.dataset.failureKey = conversationFailureKey(snapshot)
    row.setAttribute('role', 'status')
    const copy = document.createElement('span')
    copy.className = 'conversation-failure-copy'
    const title = document.createElement('strong')
    title.textContent = failure.title
    const detail = document.createElement('small')
    detail.textContent = failure.message
    copy.append(title, detail)
    if (failure.detail) {
      const upstream = document.createElement('span')
      upstream.className = 'conversation-failure-upstream'
      const label = document.createElement('b')
      label.textContent = '上游返回'
      const message = document.createElement('code')
      message.textContent = failure.detail
      upstream.append(label, message)
      copy.append(upstream)
    }
    const actions = document.createElement('span')
    actions.className = 'conversation-failure-actions'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重新尝试'
    retry.disabled = !bridge || snapshot.runtime.status === 'running' || snapshot.persistence.status === 'degraded'
    retry.addEventListener('click', async () => {
      if (!bridge) return
      retry.disabled = true
      pendingFailureRetry = snapshot.conversation.id
      row.remove()
      try {
        beginRequestStatusAttempt()
        await bridge.resendFromTurn(failure.turnId, failure.prompt)
      } catch (error) {
        showToast(errorMessage(error))
      } finally {
        pendingFailureRetry = ''
        if (currentSnapshot?.conversation.id === snapshot.conversation.id) {
          const fresh = await bridge.getSnapshot().catch(() => null)
          if (fresh && currentSnapshot?.conversation.id === fresh.conversation.id) applySnapshot(fresh)
          else if (currentSnapshot) reconcileConversationFailure(currentSnapshot)
        }
      }
    })
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = '关闭'
    dismiss.setAttribute('aria-label', '关闭本次错误提示')
    dismiss.addEventListener('click', () => {
      dismissedConversationFailures.add(conversationFailureKey(snapshot))
      row.remove()
    })
    actions.append(retry, dismiss)
    row.append(copy, actions)
    return row
  }

  function createToolCard(
    call: ToolCall,
    result: ToolResult | undefined,
    status: 'running' | 'completed' | 'failed',
    animate = true,
  ): HTMLElement {
    const activity = createToolActivity(call, result, status, {
      animate,
      createImagePreview: attachment => createToolImagePreview(attachment),
      onOpenBrowser: isBuiltInBrowserTool(call.name) ? () => void openBrowserExecution(call.id) : undefined,
      onPreviewDiff: change => {
        openChangeInspectorTab(change)
      },
    })
    bindTaskFlowNode(activity, taskFlowNodeIdForTool(taskFlowProjection, call.id))
    return activity
  }

  function clearPendingOptimisticUserTurn() {
    pendingOptimisticUserElement?.remove()
    pendingOptimisticUserElement = null
    pendingOptimisticUserPrompt = ''
    pendingOptimisticInputId = ''
  }

  function mountOptimisticUserTurn(
    prompt: string,
    attachments: AgentAttachment[] | undefined,
    capabilities: AgentCapabilitySelection | undefined,
  ): HTMLElement | null {
    clearPendingOptimisticUserTurn()
    const turn: AgentTurn = {
      id: `optimistic-user-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: {
        attachments,
        capabilities,
      },
    }
    const element = createMessageElement(turn, new Map(), false, false, false, false, false)
    if (!element) return null
    element.classList.add('optimistic-user-turn')
    element.dataset.optimisticUserTurn = 'true'
    pendingOptimisticUserElement = element
    pendingOptimisticUserPrompt = prompt
    pendingOptimisticInputId = ''
    setConversationMode(true)
    appendTranscriptElement(element)
    scrollTranscript(true)
    return element
  }

  function reconcileOptimisticUserTurn(turn: AgentTurn) {
    if (
      turn.role !== 'user'
      || !pendingOptimisticUserElement?.isConnected
      || turn.content !== pendingOptimisticUserPrompt
    ) return
    pendingOptimisticInputId = turn.id
    pendingOptimisticUserElement.dataset.optimisticInputId = turn.id
  }

  function renderTurns(turns: AgentTurn[], animate = false) {
    cancelCanonicalTaskFlowRender()
    const activeWorkflowSurface = workflowSurface
    const viewportAnchor = !transcriptFollowState.following && !historyRewriteAnchorTurnId
      ? captureTranscriptViewportAnchor()
      : null
    pendingConversationRender = false
    transcript.classList.toggle('restoring', !animate)
    transcript.replaceChildren()
    historyRewriteLeadingSpacer = null
    historyRewriteSpacer = null
    editingTurnId = ''
    if (!taskFlowProjection && currentSnapshot) taskFlowProjection = projectTaskFlowSnapshot(currentSnapshot)
    if (!taskFlowProjection) throw new Error('规范任务流暂时不可用')
    renderCanonicalTaskFlow(true)
    if (currentSnapshot) {
      reconcileConversationFailure(currentSnapshot)
    }
    if (activeWorkflowSurface) appendTranscriptElement(activeWorkflowSurface)
    activeTaskStartedAt = currentSnapshot?.runtime.runState.startedAt || 0
    if (historyRewriteAnchorTurnId) mountHistoryRewriteViewportSpace()
    if (viewportAnchor) restoreTranscriptViewportAnchor(viewportAnchor)
    else scrollTranscript(true)
    if (!animate) lifetime.frame(() => transcript.classList.remove('restoring'))
  }
  function beginRequestStatusAttempt() {
    transcript.querySelector('.conversation-failure')?.remove()
  }

  function sidebarAction(className: string, glyph: string, label: string, action: () => void | Promise<void>) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `sidebar-action ${className}`
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = icon(glyph)
    let pending = false
    button.addEventListener('click', async event => {
      event.stopPropagation()
      if (pending) return
      pending = true
      button.setAttribute('aria-disabled', 'true')
      try { await action() } catch (error) { showToast(errorMessage(error)) }
      finally { pending = false; button.removeAttribute('aria-disabled') }
    })
    return button
  }

  function showSidebarMenu(trigger: HTMLButtonElement, actions: Array<{ label: string; glyph: string; run: () => void | Promise<void> }>) {
    const wasOpen = trigger.getAttribute('aria-expanded') === 'true'
    closeSidebarMenu?.()
    if (wasOpen) return
    const menu = document.createElement('div')
    menu.className = 'conversation-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', trigger.getAttribute('aria-label') || '更多操作')
    const close = (restoreFocus = false) => {
      menu.remove()
      trigger.setAttribute('aria-expanded', 'false')
      if (closeSidebarMenu === close) closeSidebarMenu = null
      if (restoreFocus && trigger.isConnected) trigger.focus()
    }
    closeSidebarMenu = close
    trigger.setAttribute('aria-expanded', 'true')
    for (const action of actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.innerHTML = `${icon(action.glyph)}<span>${escapeHtml(action.label)}</span>`
      button.addEventListener('click', async event => {
        event.stopPropagation()
        close(true)
        try { await action.run() } catch (error) { showToast(errorMessage(error)) }
      })
      menu.append(button)
    }
    menu.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        close(true)
        return
      }
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length
        : event.key === 'ArrowUp' ? (current + buttons.length - 1) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
    })
    document.body.append(menu)
    const anchor = trigger.getBoundingClientRect()
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button')?.focus()
  }

  function renderConversationList(snapshot: WorkbenchSnapshot) {
    const list = app.querySelector<HTMLDivElement>('#conversation-list')!
    const runtimes = new Map(snapshot.conversationRuntimes.map(runtime => [runtime.conversationId, runtime]))
    const activeConversationIds = new Set(snapshot.conversationRuntimes
      .filter(runtime => ['running', 'paused', 'awaiting-action'].includes(runtime.status))
      .map(runtime => runtime.conversationId))
    const conversations = visibleTaskConversations(
      snapshot.conversationCatalog,
      snapshot.conversation.id,
      activeConversationIds,
      Number.MAX_SAFE_INTEGER,
    )
    const currentHasTurns = snapshot.conversation.turns.some(turn => turn.role === 'user' || turn.role === 'assistant')
    if (!conversations.some(item => item.id === snapshot.conversation.id)) {
      const title = taskDisplayTitle({
        title: snapshot.conversation.turns.find(turn => turn.role === 'user')?.content,
        titleSource: 'generated',
        turnCount: currentHasTurns ? snapshot.conversation.turns.length : 0,
      })
      conversations.unshift({
        id: snapshot.conversation.id,
        title,
        workspacePath: snapshot.workspace.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        mode: snapshot.runtime.mode,
        model: snapshot.runtime.model,
        provider: snapshot.runtime.provider,
        turnCount: currentHasTurns ? snapshot.conversation.turns.length : 0,
      })
    }
    const groups = projectWorkspaceConversationGroups({
      conversations,
      projects: snapshot.projects.projects,
      currentConversationId: snapshot.conversation.id,
      platform: snapshot.platform,
      query: workspaceTaskQuery,
    })
    const preferredWorkspaceTaskGroupKey = groups.find(group => group.containsCurrent)?.key
      || groups.find(group => group.key !== UNGROUPED_WORKSPACE_KEY)?.key
      || groups[0]?.key
      || ''
    if (preferredWorkspaceTaskGroupKey && preferredWorkspaceTaskGroupKey !== currentWorkspaceTaskGroupKey) {
      workspaceGroupExpansion = Object.fromEntries(groups.map(group => [group.key, group.key === preferredWorkspaceTaskGroupKey]))
      expandedWorkspaceTaskGroups.clear()
      currentWorkspaceTaskGroupKey = preferredWorkspaceTaskGroupKey
    }
    const conversationListSignature = () => JSON.stringify({
      current: snapshot.conversation.id,
      query: workspaceTaskQuery,
      groups: groups.map(group => ({
        key: group.key,
        name: group.name,
        expanded: workspaceTaskQuery !== '' || workspaceGroupExpansion[group.key] === true,
        showAll: expandedWorkspaceTaskGroups.has(group.key),
        conversations: group.conversations.map(conversation => ({ id: conversation.id, title: conversation.title, updatedMinute: Math.floor(conversation.updatedAt / 60_000), turnCount: conversation.turnCount })),
      })),
      runtimes: snapshot.conversationRuntimes.map(runtime => ({ conversationId: runtime.conversationId, status: runtime.status })),
    })
    const listSignature = conversationListSignature()
    if (listSignature === renderedConversationListSignature) return
    renderedConversationListSignature = listSignature
    closeSidebarMenu?.()
    list.replaceChildren()

    const appendConversation = (host: HTMLElement, conversation: typeof conversations[number]) => {
      const runtime = runtimes.get(conversation.id)
      const row = document.createElement('div')
      row.className = `conversation-row${conversation.id === snapshot.conversation.id ? ' active' : ''}${runtime && runtime.status !== 'ready' ? ` ${runtime.status}` : ''}`
      const button = document.createElement('button')
      button.className = `conversation${conversation.id === snapshot.conversation.id ? ' active' : ''}${runtime && runtime.status !== 'ready' ? ` ${runtime.status}` : ''}`
      button.dataset.conversationId = conversation.id
      const copy = document.createElement('span')
      copy.className = 'conversation-copy'
      const title = document.createElement('strong')
      const displayTitle = taskDisplayTitle(conversation)
      title.textContent = displayTitle
      button.title = displayTitle
      copy.append(title)
      const time = document.createElement('time')
      time.textContent = runtime?.status === 'running'
          ? '工作中'
          : runtime?.status === 'paused'
            ? '已暂停'
            : runtime?.status === 'awaiting-action'
              ? '待确认'
              : formatRelativeTime(conversation.updatedAt)
      copy.append(time)
      button.append(copy)
      if (conversation.id === snapshot.conversation.id) button.setAttribute('aria-current', 'page')
      button.addEventListener('click', () => void switchConversation(conversation.id))
      const actions = document.createElement('div')
      actions.className = 'conversation-actions'
      actions.append(
        sidebarAction('conversation-rename', 'edit', `重命名 ${displayTitle}`, async () => {
          if (!bridge) return
          const next = await openWorkbenchDialog({
            title: '重命名任务',
            message: '为这段工作选择一个更容易识别的名字。',
            confirmLabel: '保存',
            inputValue: displayTitle,
          })
          if (typeof next !== 'string' || !next) return
          if (!await bridge.renameConversation(conversation.id, next)) throw new Error('无法重命名任务')
          applySnapshot(await bridge.getSnapshot(), false)
        }),
        sidebarAction('conversation-delete danger', 'trash', `删除 ${displayTitle}`, async () => {
          if (!bridge) return
          const confirmed = await openWorkbenchDialog({
            title: '删除任务？',
            message: '会删除这段会话的本地记录，此操作无法撤销。',
            confirmLabel: '删除',
            danger: true,
          })
          if (confirmed !== true) return
          if (!await bridge.deleteConversation(conversation.id)) throw new Error('无法删除任务')
          applySnapshot(await bridge.getSnapshot())
        }),
      )
      if (runtime && ['running', 'paused', 'awaiting-action'].includes(runtime.status)) {
        const remove = actions.querySelector<HTMLButtonElement>('.conversation-delete')!
        remove.disabled = true
        remove.title = '请先停止任务再删除'
      }
      row.append(button, actions)
      host.append(row)
    }

    for (const group of groups) {
      const expanded = workspaceTaskQuery !== '' || workspaceGroupExpansion[group.key] === true
      const section = document.createElement('section')
      section.className = `workspace-task-group${group.containsCurrent ? ' contains-current' : ''}`
      section.dataset.workspaceKey = group.key

      const header = document.createElement('div')
      header.className = 'workspace-task-group-header'
      const toggle = document.createElement('button')
      toggle.className = 'workspace-task-group-toggle'
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', String(expanded))
      toggle.setAttribute('aria-label', `${group.name}，${group.conversations.length} 个任务`)
      toggle.title = group.path || group.name
      toggle.innerHTML = icon('workspace')
      const label = document.createElement('strong')
      label.textContent = group.name
      toggle.append(label)
      header.append(toggle)

      if (group.projectId) {
        const create = document.createElement('button')
        create.className = 'sidebar-action workspace-task-group-create'
        create.type = 'button'
        create.title = `在 ${group.name} 中新建任务`
        create.setAttribute('aria-label', `在 ${group.name} 中新建任务`)
        create.innerHTML = icon('plus')
        create.addEventListener('click', async () => {
          if (!bridge || composerActionGuard.active || conversationNavigationGuard.active) return
          const release = conversationNavigationGuard.tryAcquire()
          if (!release) return
          const transitionId = beginConversationTransition('new', '', create)
          let succeeded = false
          try {
            await persistDraftNow()
            const result = await bridge.newConversationInProject(group.projectId!)
            taskInput.value = ''
            draftAttachments = []
            draftFiles = []
            pendingPastes = []
            renderDraftTray()
            applySnapshot(result.snapshot)
            showMainView('workbench')
            taskInput.focus()
            succeeded = true
          } catch (error) {
            showToast(errorMessage(error))
          } finally {
            finishConversationTransition(transitionId, succeeded)
            finishConversationNavigation(release)
          }
        })

        const more = sidebarAction('workspace-task-group-more', 'more', `${group.name} 更多操作`, () => {
          showSidebarMenu(more, [
            {
              label: '重命名', glyph: 'edit', run: async () => {
                if (!bridge) return
                const name = await openWorkbenchDialog({
                  title: '重命名工作区', message: '更改侧栏中显示的名称。', confirmLabel: '保存', inputValue: group.name,
                })
                if (typeof name !== 'string' || !name) return
                applySnapshot(await bridge.renameProject(group.projectId!, name), false)
              },
            },
            ...(group.path ? [{ label: '复制路径', glyph: 'copy', run: async () => { await copyMessageText(group.path!) } }] : []),
          ])
        })
        more.setAttribute('aria-haspopup', 'menu')
        more.setAttribute('aria-expanded', 'false')

        const remove = sidebarAction('workspace-task-group-remove danger', 'trash', `移除工作区 ${group.name}`, async () => {
          if (!bridge) return
          closeSidebarMenu?.()
          const confirmed = await openWorkbenchDialog({
            title: '移除工作区？',
            message: `将“${group.name}”从侧栏移除。本地文件保留，历史对话归入“未分组”。`,
            confirmLabel: '移除',
            danger: true,
          })
          if (confirmed !== true) return
          const nextSnapshot = await bridge.removeProject(group.projectId!)
          delete workspaceGroupExpansion[group.key]
          expandedWorkspaceTaskGroups.delete(group.key)
          localStorage.setItem(workspaceGroupExpansionStorageKey, JSON.stringify(workspaceGroupExpansion))
          applySnapshot(nextSnapshot, false)
          showToast('已移除工作区')
          app.querySelector<HTMLButtonElement>('#workspace-task-add')?.focus({ preventScroll: true })
        })
        header.append(create, more, remove)
      }
      section.append(header)

      const taskHost = document.createElement('div')
      taskHost.className = 'workspace-task-group-conversations'
      const taskHostInner = document.createElement('div')
      taskHostInner.className = 'workspace-task-group-conversations-inner'
      if (group.projectId && group.conversations.length === 0) {
        section.classList.add('is-empty')
        const empty = document.createElement('p')
        empty.className = 'workspace-task-group-empty'
        empty.textContent = '暂无对话'
        taskHostInner.append(empty)
      }
      const showAll = workspaceTaskQuery !== '' || expandedWorkspaceTaskGroups.has(group.key)
      for (const conversation of group.conversations.slice(0, 5)) appendConversation(taskHostInner, conversation)
      let setOverflowExpanded: ((expanded: boolean) => void) | undefined
      if (group.conversations.length > 5) {
        const overflowItems = document.createElement('div')
        overflowItems.className = 'workspace-task-overflow-items'
        const overflowInner = document.createElement('div')
        overflowInner.className = 'workspace-task-overflow-inner'
        overflowItems.append(overflowInner)
        taskHostInner.append(overflowItems)
        const overflow = workspaceTaskQuery === '' ? document.createElement('button') : null
        let itemsMounted = false
        setOverflowExpanded = nextExpanded => {
          if (nextExpanded && !itemsMounted) {
            for (const conversation of group.conversations.slice(5)) appendConversation(overflowInner, conversation)
            itemsMounted = true
          }
          overflowItems.classList.toggle('expanded', nextExpanded)
          overflowItems.setAttribute('aria-hidden', String(!nextExpanded))
          overflowItems.inert = !nextExpanded
          if (overflow) {
            overflow.setAttribute('aria-expanded', String(nextExpanded))
            overflow.textContent = nextExpanded ? '收起' : '查看更多'
          }
        }
        setOverflowExpanded(showAll)
        if (overflow) {
          overflow.className = 'workspace-task-overflow'
          overflow.type = 'button'
          overflow.addEventListener('click', () => {
            const nextExpanded = overflow.getAttribute('aria-expanded') !== 'true'
            if (nextExpanded) expandedWorkspaceTaskGroups.add(group.key)
            else expandedWorkspaceTaskGroups.delete(group.key)
            setOverflowExpanded!(nextExpanded)
            renderedConversationListSignature = conversationListSignature()
          })
          taskHostInner.append(overflow)
        }
      }
      taskHost.append(taskHostInner)
      section.append(taskHost)

      const applyExpandedState = (nextExpanded: boolean) => {
        toggle.setAttribute('aria-expanded', String(nextExpanded))
        section.classList.toggle('expanded', nextExpanded)
        taskHost.classList.toggle('expanded', nextExpanded)
        taskHost.setAttribute('aria-hidden', String(!nextExpanded))
        taskHost.inert = !nextExpanded
      }
      applyExpandedState(expanded)
      toggle.addEventListener('click', () => {
        if (workspaceTaskQuery !== '') return
        const nextExpanded = toggle.getAttribute('aria-expanded') !== 'true'
        workspaceGroupExpansion = { ...workspaceGroupExpansion, [group.key]: nextExpanded }
        if (!nextExpanded) {
          expandedWorkspaceTaskGroups.delete(group.key)
          setOverflowExpanded?.(false)
        }
        localStorage.setItem(workspaceGroupExpansionStorageKey, JSON.stringify(workspaceGroupExpansion))
        applyExpandedState(nextExpanded)
        renderedConversationListSignature = conversationListSignature()
      })
      list.append(section)
    }

    if (groups.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'workspace-task-empty'
      empty.textContent = workspaceTaskQuery ? '没有匹配的任务' : '还没有工作区任务'
      list.append(empty)
    }
    refreshConversationTransitionTargets()
  }

  function showMainView(view: 'workbench' | 'automations') {
    currentMainView = view
    app.querySelectorAll<HTMLButtonElement>('.sidebar-nav-item[data-view]').forEach(button => {
      const active = button.dataset.view === view
      button.classList.toggle('active', active)
      if (active) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })
    mainScroll.hidden = view !== 'workbench'
    workPlanDock.classList.toggle('view-hidden', view !== 'workbench')
    updateWorkPlanToggleState()
    productView.classList.toggle('visible', view !== 'workbench')
    productView.setAttribute('aria-hidden', String(view === 'workbench'))
    renderBreadcrumb()
    if (view === 'workbench') productView.replaceChildren()
    else renderProductView()
  }

  async function openAutomationConversation(conversationId: string) {
    try {
      if (conversationId !== currentSnapshot?.conversation.id) await switchConversation(conversationId)
      showMainView('workbench')
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function handleNavigationIntent(intent: AutomationNotificationNavigationIntent) {
    if (!bridge) return
    applySnapshot(await bridge.getSnapshot(), false)
    showMainView('automations')
    await automationsView?.navigate(intent)
  }

  function renderAutomationsView(snapshot: WorkbenchSnapshot) {
    if (!bridge) return
    automationsView ??= createAutomationsView(productView, {
      bridge,
      icon,
      refresh: async () => { applySnapshot(await bridge.getSnapshot(), false) },
      openConversation: openAutomationConversation,
      confirm: async name => await openWorkbenchDialog({ title: '删除自动化？', message: name, confirmLabel: '删除', danger: true }) === true,
      onError: error => showToast(errorMessage(error)),
    })
    automationsView.update(snapshot)
  }

  function renderProductView() {
    if (!currentSnapshot) return
    if (currentMainView === 'automations') renderAutomationsView(currentSnapshot)
  }

  function showInspectorPanelTab(panelTab: InspectorPanelTab, workRunId?: string) {
    const wasOpen = shell.classList.contains('inspector-open')
    const ensuredTab = ensureInspectorPanelTab(panelTab)
    activeInspectorPanelTabId = ensuredTab.id
    reflectActiveInspectorPanelTab()
    if (panelTab.inspectorTab !== 'browser') browserLayoutMode = 'portrait'
    if (!wasOpen) applyInspectorWidthForTab(panelTab.inspectorTab)
    if (panelTab.inspectorTab === 'activity') selectedWorkRunId = workRunId || null
    shell.classList.add('inspector-open')
    inspectorPanel.setAttribute('aria-hidden', 'false')
    if (wasOpen) applyInspectorWidthForCurrentTab()
    setInspectorModuleMenu(false)
    renderInspector()
    updateInspectorToggleState()
  }

  function renderInspectorLanding() {
    inspectorContent.classList.remove('browser-content')
    inspectorContent.innerHTML = `<div class="inspector-landing"><div class="inspector-landing-actions"><button class="inspector-landing-entry" type="button" data-inspector-entry="browser"><span class="inspector-landing-entry-icon">${icon('browser')}</span><span>浏览器</span></button></div></div>`
    inspectorContent.querySelector<HTMLButtonElement>('[data-inspector-entry="browser"]')?.addEventListener('click', () => void openBrowserInInspector('about:blank'))
  }

  function showInspectorLanding() {
    activeInspectorPanelTabId = null
    selectedArtifactId = null
    setInspectorWidth(INSPECTOR_MINIMUM_WIDTH, false, 'regular')
    shell.classList.add('inspector-open')
    inspectorPanel.setAttribute('aria-hidden', 'false')
    setInspectorModuleMenu(false)
    renderInspector()
    updateInspectorToggleState()
  }

  function openInspector(tab: InspectorTab, workRunId?: string) {
    if (tab === 'browser') {
      const browserTab = browserSnapshot?.tabs.find(candidate => candidate.id === browserSnapshot?.activeTabId)
      showInspectorPanelTab(browserTab
        ? {
            id: `browser:${browserTab.id}`,
            kind: 'browser',
            inspectorTab: 'browser',
            title: browserTab.crashed ? '页面已停止' : browserTab.title || '新标签页',
            iconName: 'browser',
            browserTabId: browserTab.id,
          }
        : {
            id: 'browser:new',
            kind: 'browser',
            inspectorTab: 'browser',
            title: '新标签页',
            iconName: 'browser',
          })
      return
    }
    showInspectorPanelTab(inspectorModuleDescriptor(tab), workRunId)
  }

  function openArtifactInspectorTab(artifact: WorkbenchSnapshot['artifacts']['artifacts'][number]) {
    showInspectorPanelTab({
      id: `artifact:${artifact.id}`,
      kind: 'artifact',
      inspectorTab: 'outputs',
      title: artifact.name,
      iconName: artifactIconName(artifact.kind),
      isPreview: true,
      artifactId: artifact.id,
    })
  }

  function openChangeInspectorTab(change: ChangeSummary) {
    showInspectorPanelTab({
      id: `change:${change.operation}:${change.path}`,
      kind: 'change',
      inspectorTab: 'outputs',
      title: change.path.split(/[\\/]/).at(-1) || change.path,
      iconName: 'code',
      change,
    })
  }

  function reopenInspector() {
    const activeTab = activeInspectorPanelTab()
    if (activeTab) showInspectorPanelTab(activeTab)
    else showInspectorLanding()
  }

  function closeInspector() {
    shell.classList.remove('inspector-open')
    inspectorPanel.setAttribute('aria-hidden', 'true')
    setInspectorModuleMenu(false)
    browserLayoutMode = 'portrait'
    inspectorUserFullWidth = false
    scheduleBrowserBoundsSync()
    updateInspectorToggleState()
  }

  function updateInspectorToggleState() {
    const open = shell.classList.contains('inspector-open')
    mainPanel.inert = open && currentInspectorWidthMode() === 'full'
    updateWorkPlanToggleState()
    inspectorToggle.classList.toggle('active', open)
    inspectorToggle.setAttribute('aria-pressed', String(open))
    inspectorToggle.title = open ? '关闭工作抽屉' : '打开工作抽屉'
    inspectorToggle.setAttribute('aria-label', inspectorToggle.title)
  }

  function artifactKindLabel(kind: WorkbenchSnapshot['artifacts']['artifacts'][number]['kind']): string {
    return ({
      document: '文档', pdf: 'PDF', presentation: '演示文稿', spreadsheet: '表格', image: '图片', archive: '压缩包', code: '代码', data: '数据', other: '文件',
    } as const)[kind]
  }

  function artifactSourceLabel(source: WorkbenchSnapshot['artifacts']['artifacts'][number]['source']): string {
    return ({ agent: '智能代理', browser: '浏览器', 'browser-download': '浏览器下载', import: '导入', automation: '自动化', plugin: '插件' } as const)[source]
  }

  function artifactIconName(kind: WorkbenchSnapshot['artifacts']['artifacts'][number]['kind']): string {
    if (kind === 'image') return 'image'
    if (kind === 'presentation') return 'slides'
    if (kind === 'spreadsheet' || kind === 'data') return 'table'
    if (kind === 'code') return 'code'
    if (kind === 'archive') return 'archive'
    return 'file'
  }

  function renderArtifactDetail(artifactId: string) {
    if (!currentSnapshot) return
    const artifact = currentSnapshot.artifacts.artifacts.find(item => item.id === artifactId)
    if (!artifact) {
      inspectorContent.innerHTML = '<div class="empty-inspector"><div class="empty-module-icon"></div><h3>产物不可用</h3><p>它可能已被移除，或不属于当前任务。</p></div>'
      return
    }
    const heading = document.createElement('section')
    heading.className = 'artifact-detail-heading'
    const copy = document.createElement('div')
    const name = document.createElement('strong')
    name.textContent = artifact.name
    const meta = document.createElement('small')
    meta.textContent = `${artifactKindLabel(artifact.kind)} · ${artifactSourceLabel(artifact.source)} · ${Math.max(1, Math.round(artifact.size / 1024)).toLocaleString()} KB`
    copy.append(name, meta)
    const actions = document.createElement('div')
    for (const [label, action] of [
      ['打开', () => bridge?.openArtifact(artifact.id)],
      ['定位', () => bridge?.revealArtifact(artifact.id)],
      ['导出', () => bridge?.exportArtifact(artifact.id)],
    ] as const) {
      const button = document.createElement('button')
      button.textContent = label
      button.disabled = !artifact.available
      button.addEventListener('click', () => void Promise.resolve(action()).catch(error => showToast(errorMessage(error))))
      actions.append(button)
    }
    const remove = document.createElement('button')
    remove.className = 'danger'
    const managedFile = artifact.source === 'browser' || artifact.source === 'browser-download' || artifact.metadata?.visualSource === 'computer'
    remove.textContent = managedFile ? '删除产物' : '移除记录'
    remove.addEventListener('click', async () => {
      const confirmed = await openWorkbenchDialog({
        title: managedFile ? '删除这个产物？' : '移除产物记录？',
        message: managedFile ? '将同时删除 TurboFlux 保存的文件，此操作无法撤销。' : '不会删除工作区中的原始文件。',
        confirmLabel: managedFile ? '删除' : '移除',
        danger: true,
      })
      if (confirmed !== true) return
      try {
        await bridge?.removeArtifact(artifact.id)
        artifactPreviewCache.delete(artifact.id)
        artifactThumbnailCache.delete(artifact.id)
        await closeInspectorPanelTab(`artifact:${artifact.id}`)
        if (bridge) applySnapshot(await bridge.getSnapshot(), false)
      } catch (error) { showToast(errorMessage(error)) }
    })
    actions.append(remove)
    heading.append(copy, actions)
    const surface = document.createElement('div')
    surface.className = `artifact-preview artifact-preview-${artifact.kind}`
    if (!artifact.available) {
      surface.innerHTML = '<div class="artifact-preview-message"><strong>文件已不可用</strong><p>它可能被移动或删除，可以移除此记录。</p></div>'
    } else {
      const preview = artifactPreviewCache.get(artifact.id)
      if (preview?.mode === 'image' && preview.dataUrl) {
        const image = document.createElement('img')
        image.src = preview.dataUrl
        image.alt = artifact.name
        surface.append(image)
      } else if (preview?.mode === 'pdf' && preview.dataUrl) {
        const frame = document.createElement('iframe')
        frame.src = preview.dataUrl
        frame.title = artifact.name
        surface.append(frame)
      } else if (preview?.mode === 'text') {
        const pre = document.createElement('pre')
        pre.textContent = preview.text || ''
        surface.append(pre)
        if (preview.message) {
          const note = document.createElement('p')
          note.className = 'artifact-preview-note'
          note.textContent = preview.message
          surface.prepend(note)
        }
      } else if (preview?.mode === 'external') {
        const message = document.createElement('div')
        message.className = 'artifact-preview-message'
        const kind = document.createElement('strong')
        kind.textContent = artifactKindLabel(artifact.kind)
        const detail = document.createElement('p')
        detail.textContent = preview.message || '使用系统应用打开此文件。'
        message.append(kind, detail)
        surface.append(message)
      } else {
        surface.innerHTML = '<div class="artifact-preview-message loading"><span></span><p>正在准备预览…</p></div>'
        if (!artifactPreviewLoading && bridge) {
          artifactPreviewLoading = true
          void loadArtifactPreview(artifact.id).catch(error => showToast(errorMessage(error))).finally(() => {
            artifactPreviewLoading = false
            if (selectedArtifactId === artifact.id) renderInspector()
          })
        }
      }
    }
    inspectorContent.append(heading, surface)
  }

  function prependComputerActivity() {
    const state = computerControls?.getCompanionState()
    if (!state) return
    const section = document.createElement('section')
    section.className = `companion-computer-activity${state.attention ? ' attention' : ''}`
    section.innerHTML = `${icon('computer')}<span><strong></strong><small></small></span><b></b>`
    section.querySelector('strong')!.textContent = state.title
    section.querySelector('small')!.textContent = state.detail
    section.querySelector('b')!.textContent = state.attention ? '需要接管' : '进行中'
    inspectorContent.prepend(section)
  }

  function renderInspector() {
    renderInspectorChrome()
    const activePanelTab = activeInspectorPanelTab()
    if (!activePanelTab) {
      renderInspectorLanding()
      scheduleBrowserBoundsSync()
      return
    }
    const snapshot = currentSnapshot
    if (!snapshot) {
      inspectorContent.innerHTML = '<div class="empty-inspector"><p>核心正在启动…</p></div>'
      return
    }
    if (!activePanelTab) {
      inspectorContent.innerHTML = '<div class="empty-inspector"><p>暂无已打开的面板。</p></div>'
      return
    }
    inspectorContent.replaceChildren()
    inspectorContent.classList.toggle('browser-content', activePanelTab?.kind === 'browser')
    scheduleBrowserBoundsSync()

    const panelActions = {
      compactContext: async () => {
        if (!bridge) return
        try {
          const result = await bridge.executeCommand('context.compact')
          await handleCommandResult(result)
          if (result.message) showToast(result.message)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      refreshGit: async () => {
        if (!bridge) return
        try {
          const result = await bridge.executeCommand('git.refresh')
          await handleCommandResult(result)
          if (result.message) showToast(result.message)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      acknowledgeNotification: async (id: string) => {
        if (!bridge) return
        try {
          await bridge.acknowledgeNotification(id)
          const next = await bridge.getSnapshot()
          applySnapshot(next, false)
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      controlWorkStep: async (id: string, action: WorkStepControlAction) => {
        if (!bridge) return
        try {
          const result = await bridge.controlWorkStep(id, action)
          applySnapshot(result.snapshot, false)
          const messages = { retry: '步骤已准备重试', skip: '步骤已跳过', cancel: '步骤已取消', resume: '步骤已继续' }
          showToast(messages[action])
        } catch (error) {
          showToast(errorMessage(error))
        }
      },
      pauseRun: async () => {
        if (!bridge) return
        await bridge.pause()
        applySnapshot(await bridge.getSnapshot(), false)
      },
      resumeRun: async () => {
        if (!bridge) return
        await bridge.resume()
        applySnapshot(await bridge.getSnapshot(), false)
      },
      stopRun: async () => {
        if (!bridge) return
        await bridge.stop()
        applySnapshot(await bridge.getSnapshot(), false)
      },
      selectWorkRun: (id: string) => {
        selectedWorkRunId = id
        renderInspector()
      },
      stageGit: async (paths: string[]) => {
        if (!bridge) return
        const response = await bridge.gitStage(paths)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '暂存失败'); return }
        showToast('已暂存所选文件')
      },
      unstageGit: async (paths: string[]) => {
        if (!bridge) return
        const response = await bridge.gitUnstage(paths)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '取消暂存失败'); return }
        showToast('已取消暂存')
      },
      commitGit: async (message: string) => {
        if (!bridge) return
        const response = await bridge.gitCommit(message)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '提交失败'); return }
        showToast(response.result.nothingToCommit ? '没有可提交的内容' : `已创建提交${response.result.hash ? ` · ${response.result.hash.slice(0, 8)}` : ''}`)
      },
      createGitBranch: async (name: string) => {
        if (!bridge) return
        const response = await bridge.gitCreateBranch(name)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '创建分支失败'); return }
        showToast(`已切换到 ${name}`)
      },
      switchGitBranch: async (name: string) => {
        if (!bridge) return
        const response = await bridge.gitSwitchBranch(name)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '切换分支失败'); return }
        showToast(`已切换到 ${name}`)
      },
      restoreGit: async (paths: string[]) => {
        if (!bridge) return
        const response = await bridge.gitRestore(paths)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '恢复文件失败'); return }
        showToast('已恢复所选文件')
      },
      pushGit: async (remote?: string, branch?: string, setUpstream?: boolean) => {
        if (!bridge) return
        const response = await bridge.gitPush(remote, branch, setUpstream)
        applySnapshot(response.snapshot, false)
        if (!response.result.ok) { showToast(response.result.error || '推送失败'); return }
        showToast('已推送到远端')
      },
      readGitDiff: async (path: string, scope: 'working' | 'staged' | 'all') => {
        if (!bridge) throw new Error('桌面连接不可用')
        const response = await bridge.gitDiff(path, scope)
        if (!response.result.ok) throw new Error(response.result.error || '无法读取差异')
        return response.result.output || '没有可显示的差异。'
      },
      confirm: async (dialogTitle: string, message: string, danger = false) => (
        await openWorkbenchDialog({ title: dialogTitle, message, confirmLabel: danger ? '继续' : '确认', danger }) === true
      ),
      prompt: async (dialogTitle: string, message: string, initialValue = '') => {
        const value = await openWorkbenchDialog({ title: dialogTitle, message, confirmLabel: '继续', inputValue: initialValue })
        return typeof value === 'string' && value.trim() ? value.trim() : null
      },
      openSettings: (section: 'mcp' | 'workpacks') => void settingsCenter?.open(section),
    }

    if (activePanelTab?.kind === 'browser') {
      const active = activeBrowserTab()
      if (!browserSnapshot?.visible || !active) {
        inspectorContent.innerHTML = `<div class="empty-inspector browser-empty"><div class="empty-module-icon">${icon('browser')}</div><h3>打开浏览器</h3><p>浏览网页、本地应用，或在多个标签页中继续工作。</p><button class="empty-inspector-action">开始浏览</button></div>`
        inspectorContent.querySelector<HTMLButtonElement>('.empty-inspector-action')?.addEventListener('click', () => void openBrowserInInspector(active?.url || 'about:blank'))
        return
      }
      const browserPanel = document.createElement('div')
      browserPanel.className = 'inspector-browser'

      const toolbar = document.createElement('div')
      toolbar.className = 'inspector-browser-toolbar'
      const navigation = document.createElement('div')
      navigation.className = 'inspector-browser-navigation'
      const createNavigationButton = (name: string, label: string, disabled: boolean, action: () => void) => {
        const button = document.createElement('button')
        button.dataset.browserCommand = name
        button.title = label
        button.disabled = disabled
        button.innerHTML = icon(name)
        button.addEventListener('click', action)
        return button
      }
      const back = createNavigationButton('back', '后退', !active.canGoBack, () => {
        const tabId = activeBrowserTab()?.id
        if (tabId) void bridge?.browserBack(tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      const forward = createNavigationButton('forward', '前进', !active.canGoForward, () => {
        const tabId = activeBrowserTab()?.id
        if (tabId) void bridge?.browserForward(tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      const reload = createNavigationButton('reload', active.loading ? '重新加载' : '刷新', false, () => {
        const tabId = activeBrowserTab()?.id
        if (tabId) void bridge?.browserReload(tabId).then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      })
      if (active.loading) reload.classList.add('loading')
      navigation.append(back, forward, reload)

      const addressForm = document.createElement('form')
      addressForm.className = 'inspector-browser-address-form'
      addressForm.innerHTML = icon('globe')
      const address = document.createElement('input')
      address.className = 'inspector-browser-address'
      address.setAttribute('aria-label', '浏览器地址')
      address.placeholder = '搜索或输入网址'
      address.autocomplete = 'off'
      address.spellcheck = false
      address.value = active.url === 'about:blank' ? '' : active.url
      addressForm.append(address)
      addressForm.addEventListener('submit', event => {
        event.preventDefault()
        address.blur()
        navigateBrowserAddress(address.value, activeBrowserTab()?.id)
      })

      const actions = document.createElement('div')
      actions.className = 'inspector-browser-actions'
      const external = document.createElement('button')
      external.dataset.browserCommand = 'external'
      external.title = '在默认浏览器中打开'
      external.innerHTML = icon('external')
      external.disabled = active.url === 'about:blank'
      external.addEventListener('click', () => {
        const url = activeBrowserTab()?.url
        if (url && url !== 'about:blank') void bridge?.openExternal(url).catch(error => showToast(errorMessage(error)))
      })
      actions.append(external)
      toolbar.append(navigation, addressForm, actions)
      const surface = document.createElement('div')
      surface.className = 'inspector-browser-surface'
      surface.innerHTML = `<div>${icon('browser')}<p>页面正在准备</p></div>`
      browserPanel.append(toolbar, surface)
      inspectorContent.append(browserPanel)
      scheduleBrowserBoundsSync()
      return
    }

    if (activePanelTab?.kind === 'module' && activePanelTab.inspectorTab === 'activity') {
      renderActivityPanel(inspectorContent, snapshot, panelActions, selectedWorkRunId)
      prependComputerActivity()
      return
    }

    if (activePanelTab?.kind === 'change' && activePanelTab.change) {
      const preview = document.createElement('div')
      preview.className = 'output-diff-preview'
      inspectorContent.append(preview)
      renderDiffPreview(preview, activePanelTab.change)
      return
    }

    if (activePanelTab?.kind === 'artifact' && activePanelTab.artifactId) {
      renderArtifactDetail(activePanelTab.artifactId)
      return
    }

    if (activePanelTab?.kind === 'module' && activePanelTab.inspectorTab === 'outputs') {
      const changes = collectChanges(snapshot.conversation.turns)
      const artifacts = snapshot.artifacts.artifacts
      const previews = snapshot.activity.runtimeTasks
        .map(task => ({ task, view: describeRuntimeTask(task) }))
        .filter(item => item.view?.category === 'service' && item.view.previewUrl)
        .sort((left, right) => right.task.updatedAt - left.task.updatedAt)
      if (changes.length === 0 && previews.length === 0 && artifacts.length === 0) {
        inspectorContent.innerHTML = `<div class="empty-inspector"><div class="empty-module-icon">${icon('outputs')}</div><h3>暂无产物</h3><p>生成的文件、修改和可预览结果会出现在这里。</p></div>`
        return
      }
      const list = document.createElement('div')
      list.className = 'output-list'
      for (const artifact of artifacts) {
        const button = document.createElement('button')
        button.className = `output-item artifact-item${artifact.available ? '' : ' unavailable'}`
        const glyph = document.createElement('span')
        glyph.innerHTML = icon(artifactIconName(artifact.kind))
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = artifact.name
        const detail = document.createElement('small')
        detail.textContent = artifact.available
          ? `${artifactKindLabel(artifact.kind)} · ${artifactSourceLabel(artifact.source)} · ${formatRelativeTime(artifact.updatedAt)}`
          : `${artifactKindLabel(artifact.kind)} · 文件不可用`
        copy.append(name, detail)
        const arrow = document.createElement('span')
        arrow.className = 'output-item-arrow'
        arrow.innerHTML = icon('chevron')
        button.append(glyph, copy, arrow)
        button.addEventListener('click', () => openArtifactInspectorTab(artifact))
        list.append(button)
      }
      for (const { task, view } of previews) {
        if (!view?.previewUrl) continue
        const button = document.createElement('button')
        button.className = `output-item local-preview-item ${task.status}`
        button.disabled = !view.active
        const glyph = document.createElement('span')
        glyph.innerHTML = icon('preview')
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = '本地预览'
        const detail = document.createElement('small')
        detail.textContent = view.active ? view.title : `${view.title} · ${view.detail}`
        copy.append(name, detail)
        const action = document.createElement('span')
        action.textContent = view.active ? '打开' : '已停止'
        button.append(glyph, copy, action)
        button.addEventListener('click', () => void openBrowserInInspector(view.previewUrl!))
        list.append(button)
      }
      for (const change of changes) {
        const button = document.createElement('button')
        button.className = 'output-item'
        const glyph = document.createElement('span')
        glyph.innerHTML = icon(change.operation === 'write' ? 'changeAdd' : change.operation === 'delete' ? 'changeDelete' : 'changeModify')
        const copy = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = change.path.split(/[\\/]/).at(-1) || change.path
        const path = document.createElement('small')
        path.textContent = `${change.path} · +${change.addedLines ?? 0} −${change.removedLines ?? 0}`
        copy.append(name, path)
        const arrow = document.createElement('span')
        arrow.className = 'output-item-arrow'
        arrow.innerHTML = icon('chevron')
        button.append(glyph, copy, arrow)
        button.addEventListener('click', () => openChangeInspectorTab(change))
        list.append(button)
      }
      inspectorContent.append(list)
      return
    }

    if (activePanelTab?.kind === 'module' && activePanelTab.inspectorTab === 'git') {
      renderGitPanel(inspectorContent, snapshot, panelActions)
      return
    }

    if (activePanelTab.kind !== 'module' || activePanelTab.inspectorTab !== 'context') return
    renderContextPanel(inspectorContent, snapshot, panelActions)
    const group = document.createElement('div')
    group.className = 'inspector-group'
    const label = document.createElement('div')
    label.className = 'group-label'
    label.textContent = '来源'
    group.append(label, createContextItem('folder', snapshot.workspace.name, snapshot.workspace.path, true))
    const attachments = snapshot.conversation.turns.flatMap(turn => turn.metadata?.attachments || [])
    for (const attachment of attachments) group.append(createContextItem('folder', attachment.filename, `${Math.max(1, Math.round(attachment.size / 1024))} KB`))
    for (const file of snapshot.draft.files) group.append(createContextItem('folder', file.filename, '待发送文件'))
    if (attachments.length === 0 && snapshot.draft.files.length === 0) group.append(createMutedNote('添加到任务的文件、图片和工作区会集中显示在这里。'))
    inspectorContent.append(group)
  }

  function createContextItem(iconName: string, itemTitle: string, itemDetail: string, checked = false): HTMLElement {
    const item = document.createElement('div')
    item.className = 'context-item'
    item.innerHTML = icon(iconName)
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = itemTitle
    const detail = document.createElement('small')
    detail.textContent = itemDetail
    copy.append(title, detail)
    item.append(copy)
    if (checked) {
      const mark = document.createElement('span')
      mark.className = 'context-check'
      mark.innerHTML = icon('check')
      item.append(mark)
    }
    return item
  }

  function createMutedNote(text: string): HTMLElement {
    const note = document.createElement('p')
    note.className = 'inspector-note'
    note.textContent = text
    return note
  }

  function currentDraft() {
    return {
      text: taskInput.value,
      attachments: draftAttachments.map(attachment => ({ ...attachment })),
      files: draftFiles.map(file => ({ ...file })),
      pendingPastes: pendingPastes.map(paste => ({ ...paste })),
      capabilities: { items: draftCapabilities.map(capability => ({ ...capability })) },
    }
  }

  function scheduleDraftRecord() {
    if (draftTimer !== null) lifetime.clearTimeout(draftTimer)
    draftTimer = lifetime.timeout(() => {
      draftTimer = null
      const draft = currentDraft()
      if (bridge) void draftRecordQueue.enqueue(() => bridge.recordDraft(draft)).catch(() => undefined)
    }, 350)
  }

  async function persistDraftNow(): Promise<void> {
    if (draftTimer !== null) {
      lifetime.clearTimeout(draftTimer)
      draftTimer = null
    }
    const draft = currentDraft()
    if (bridge) await draftRecordQueue.enqueue(() => bridge.recordDraft(draft))
  }

  function renderDraftTray() {
    draftTray.replaceChildren()
    const items: Array<{ id: string; kind: 'file' | 'paste'; label: string; detail: string }> = [
      ...draftFiles.map(item => ({ id: item.id, kind: 'file' as const, label: item.filename, detail: `${Math.max(1, Math.round(item.size / 1024))} KB`, path: item.path })),
      ...pendingPastes.map(item => ({ id: item.placeholder, kind: 'paste' as const, label: '大段粘贴', detail: `${item.text.length.toLocaleString()} 字符` })),
    ]
    draftTray.classList.toggle('visible', draftAttachments.length + items.length > 0)

    if (draftAttachments.length) {
      const imageStrip = document.createElement('div')
      imageStrip.className = 'draft-image-strip'
      const lightboxItems = attachmentLightboxItems(draftAttachments)
      draftAttachments.forEach((attachment, imageIndex) => {
        const card = document.createElement('article')
        card.className = 'draft-image-card'
        const preview = document.createElement('button')
        preview.type = 'button'
        preview.className = 'draft-image-preview'
        preview.setAttribute('aria-label', `查看图片 ${imageIndex + 1}`)
        const placeholder = document.createElement('span')
        placeholder.className = 'attachment-image-placeholder'
        const image = document.createElement('img')
        image.alt = attachment.filename
        image.decoding = 'async'
        preview.append(placeholder, image)
        preview.addEventListener('click', () => imageLightbox?.open(lightboxItems, imageIndex))
        hydrateAttachmentThumbnail(preview, image, attachment.path, true)
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'draft-image-remove'
        remove.title = '移除图片'
        remove.setAttribute('aria-label', `移除图片 ${imageIndex + 1}`)
        remove.addEventListener('click', () => {
          draftAttachments = draftAttachments.filter(candidate => candidate.id !== attachment.id)
          renderDraftTray()
          scheduleDraftRecord()
          if (currentSnapshot) updateRunButton(currentSnapshot)
        })
        card.append(preview, remove)
        imageStrip.append(card)
      })
      draftTray.append(imageStrip)
    }

    for (const item of items) {
      const chip = document.createElement('article')
      chip.className = `draft-chip ${item.kind}`
      const preview = document.createElement('span')
      preview.className = 'draft-chip-preview'
      preview.innerHTML = icon(item.kind === 'paste' ? 'paste' : 'folder')
      const copy = document.createElement('span')
      const label = document.createElement('strong')
      label.textContent = item.label
      const detail = document.createElement('small')
      detail.textContent = item.detail
      copy.append(label, detail)
      const remove = document.createElement('button')
      remove.title = '移除'
      remove.innerHTML = icon('close')
      remove.addEventListener('click', () => {
        draftAttachments = draftAttachments.filter(attachment => attachment.id !== item.id)
        draftFiles = draftFiles.filter(file => file.id !== item.id)
        const paste = pendingPastes.find(candidate => candidate.placeholder === item.id)
        if (paste) taskInput.value = taskInput.value.replace(paste.placeholder, '').replace(/\n{3,}/g, '\n\n').trimStart()
        pendingPastes = pendingPastes.filter(candidate => candidate.placeholder !== item.id)
        renderDraftTray()
        scheduleDraftRecord()
        if (currentSnapshot) updateRunButton(currentSnapshot)
      })
      chip.append(preview, copy, remove)
      draftTray.append(chip)
    }
  }

  function renderCapabilityTray() {
    capabilityTray.replaceChildren()
    capabilityTray.classList.toggle('visible', draftCapabilities.length > 0)
    for (const capability of draftCapabilities) {
      const chip = document.createElement('span')
      chip.className = `composer-capability ${capability.type}`
      chip.innerHTML = capability.type === 'skill'
        ? icon('spark')
        : capability.id === 'browser'
          ? icon('globe')
          : capability.id === 'computer'
            ? icon('computer')
            : icon('plug')
      const label = document.createElement('strong')
      label.textContent = capabilityDisplayName(capability)
      const remove = document.createElement('button')
      remove.title = `移除 ${capabilityDisplayName(capability)}`
      remove.innerHTML = icon('close')
      remove.addEventListener('click', async () => {
        draftCapabilities = draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id))
        renderCapabilityTray()
        await persistDraftNow()
      })
      chip.append(label, remove)
      capabilityTray.append(chip)
    }
  }

  function loadDraft(snapshot: WorkbenchSnapshot) {
    taskInput.value = snapshot.draft.text || ''
    resizeTaskInput()
    draftAttachments = snapshot.draft.attachments.map(attachment => ({ ...attachment }))
    draftFiles = snapshot.draft.files.map(file => ({ ...file }))
    pendingPastes = snapshot.draft.pendingPastes.map(paste => ({ ...paste }))
    draftCapabilities = snapshot.draft.capabilities.items.map(capability => ({ ...capability }))
    renderDraftTray()
    renderCapabilityTray()
  }

  function renderRecoveryState(snapshot: WorkbenchSnapshot) {
    recoveryBanner.replaceChildren()
    const degraded = snapshot.persistence.status === 'degraded'
    recoveryBanner.classList.toggle('visible', degraded)
    if (!degraded) return
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = '暂时无法保存会话'
    const detail = document.createElement('small')
    detail.textContent = '当前消息仍保留在本机。请先重试保存；诊断数据仅用于排查问题。'
    copy.append(title, detail)
    const actions = document.createElement('div')
    const retry = document.createElement('button')
    retry.textContent = '重试保存'
    retry.addEventListener('click', async () => {
      try {
        const health = await bridge?.retryPersistence()
        if (health?.status === 'healthy' && bridge) applySnapshot(await bridge.getSnapshot(), false)
        showToast(health?.status === 'healthy' ? '会话已恢复保存' : '仍无法保存会话')
      } catch (error) {
        showToast(errorMessage(error))
      }
    })
    actions.append(retry)
    const exportButton = document.createElement('button')
    exportButton.textContent = '导出诊断数据'
    exportButton.addEventListener('click', async () => {
      try {
        const path = await bridge?.exportRecovery()
        if (path) showToast('诊断数据已导出')
      } catch (error) {
        showToast(errorMessage(error))
      }
    })
    actions.append(exportButton)
    recoveryBanner.append(copy, actions)
  }

  function hasCurrentDraftInput(): boolean {
    return Boolean(taskInput.value.trim() || draftAttachments.length || draftFiles.length || pendingPastes.length)
  }

  function currentRunButtonPresentation(snapshot: WorkbenchSnapshot): ComposerRunButtonPresentation {
    return presentComposerRunButton({
      runtimeStatus: snapshot.runtime.status,
      submissionPending,
      hasDraftInput: hasCurrentDraftInput(),
      interactionLocked: submissionPauseRequested || composerActionGuard.active && !submissionPending,
    })
  }

  function updateRunButton(snapshot: WorkbenchSnapshot) {
    const active = submissionPending || snapshot.runtime.status === 'running' || snapshot.runtime.status === 'paused' || snapshot.runtime.status === 'awaiting-action'
    const presentation = currentRunButtonPresentation(snapshot)
    computerControls?.setRuntimeActive(active)
    runButton.classList.toggle('runtime-active', presentation.action !== 'send')
    runButton.disabled = presentation.disabled
    runButton.title = presentation.title
    runButton.setAttribute('aria-label', presentation.title)
    if (runButton.dataset.action !== presentation.action) {
      runButton.dataset.action = presentation.action
      runButton.innerHTML = icon(presentation.icon)
    }
  }

  function reasoningSummary(snapshot: WorkbenchSnapshot): string {
    const reasoning = snapshot.runtime.reasoning
    if (!reasoning || reasoning.enabled === false || reasoning.effort === 'none') return '关闭'
    if (reasoning.budgetTokens) return reasoningBudgetLabel(reasoning.budgetTokens)
    return reasoning.effort ? reasoningEffortLabel(reasoning.effort) : '开启'
  }

  function applySnapshot(snapshot: WorkbenchSnapshot, renderConversation = true) {
    if (lifetime.disposed) return
    const rewriteCommitted = Boolean(resendingTurnId
      && snapshot.conversation.id === currentSnapshot?.conversation.id
      && (snapshot.work.projection.generation ?? 0) > (conversationView?.generation ?? 0))
    if (resendingTurnId && snapshot.conversation.id === currentSnapshot?.conversation.id && !rewriteCommitted) return
    const nextView = applyConversationViewSnapshot(conversationView, {
      generation: snapshot.work.projection.generation,
      flow: projectTaskFlowSnapshot(snapshot),
      execution: snapshot.activity.execution,
      runState: snapshot.runtime.runState,
      status: snapshot.runtime.status,
    })
    if (nextView === conversationView) return
    if (rewriteCommitted) resendingTurnId = ''
    const conversationChanged = currentSnapshot?.conversation.id !== snapshot.conversation.id
    const firstSnapshot = currentSnapshot === null
    if (conversationChanged) {
      closeWorkflowSurface()
      selectedWorkRunId = null
      projectedWorkRunId = ''
      clearHistoryRewriteViewport()
      resendingTurnId = ''
    }
    if (conversationChanged || rewriteCommitted) transcriptIndex.reset()
    for (const turn of snapshot.conversation.turns) transcriptIndex.setTurn(turn)
    currentSnapshot = snapshot
    conversationView = nextView
    taskFlowProjection = nextView.flow
    snapshot.runtime.status = nextView.status
    if (snapshot.activity.execution.runs.some(run => run.responseMode === 'task')) scheduleCanonicalTaskFlowRender()
    const snapshotRunId = snapshot.activity.execution.currentRunId || ''
    if (firstSnapshot || conversationChanged) {
      const latestUserTurn = [...snapshot.conversation.turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)
      projectedWorkRunId = snapshotRunId || latestUserTurn?.metadata?.workRunId || latestUserTurn?.id || ''
    } else if (snapshotRunId) {
      projectedWorkRunId = snapshotRunId
    }
    pendingSnapshotPaint = {
      conversationChanged: conversationChanged || pendingSnapshotPaint?.conversationChanged || false,
      firstSnapshot: firstSnapshot || pendingSnapshotPaint?.firstSnapshot || false,
      renderConversation: renderConversation || pendingSnapshotPaint?.renderConversation || false,
    }
    renderer.schedule('snapshot', () => {
      const pending = pendingSnapshotPaint
      pendingSnapshotPaint = null
      if (pending && currentSnapshot) paintSnapshot(currentSnapshot, pending)
    })
  }

  function paintSnapshot(snapshot: WorkbenchSnapshot, flags: { conversationChanged: boolean; firstSnapshot: boolean; renderConversation: boolean }) {
    const { conversationChanged, firstSnapshot, renderConversation } = flags
    renderProjectedWorkPlan()
    const hasWorkspace = workspaceSpecified(snapshot)
    app.querySelector('#composer-start-workspace-name')!.textContent = hasWorkspace ? snapshot.workspace.name : '选择工作区'
    const welcomePrompt = app.querySelector<HTMLElement>('#welcome-workspace-prompt')!
    const welcomeWorkspace = hasWorkspace ? snapshot.workspace.name : ''
    if (welcomePrompt.dataset.workspace !== welcomeWorkspace) {
      welcomePrompt.innerHTML = hasWorkspace
        ? `在 <strong>${escapeHtml(snapshot.workspace.name)}</strong> 做点什么呢？`
        : '今天想做点什么呢？'
      welcomePrompt.dataset.workspace = welcomeWorkspace
    }
    app.querySelector('#composer-start-workspace-action')!.textContent = hasWorkspace ? '更改' : '选择'
    renderBreadcrumb()
    app.querySelector('#model-name')!.textContent = snapshot.runtime.model || '未配置模型'
    renderComposerModelIdentity()
    renderComposerContext(snapshot)
    app.querySelector('#reasoning-name')!.textContent = reasoningSummary(snapshot)
    reasoningTab.dataset.reasoningTone = reasoningTone(snapshot.runtime.reasoning)
    reasoningTab.classList.toggle('active', Boolean(snapshot.runtime.reasoning && snapshot.runtime.reasoning.enabled !== false && snapshot.runtime.reasoning.effort !== 'none'))
    const approvalLabel = ({ ask: '需要确认', agent: '自动执行', full: '全权执行' } as Record<string, string>)[snapshot.runtime.approvalPolicy] || '按需确认'
    const accessLabel = ({ 'read-only': '只读', 'workspace-write': '工作区访问', 'danger-full-access': '完整访问' } as Record<string, string>)[snapshot.runtime.capabilityProfile || ''] || '默认权限'
    app.querySelector('#runtime-policy')!.textContent = `${approvalLabel} · ${accessLabel}`
    const previousPolicy = approvalPill.dataset.policy
    const approvalName = app.querySelector<HTMLElement>('#approval-name')!
    approvalName.textContent = approvalLabel
    approvalIcon.innerHTML = approvalPolicyIcon(snapshot.runtime.approvalPolicy)
    approvalPill.dataset.policy = snapshot.runtime.approvalPolicy
    approvalPill.setAttribute('aria-label', `更换审批模式，当前${approvalLabel}`)
    if (previousPolicy && previousPolicy !== snapshot.runtime.approvalPolicy && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const element of [approvalIcon, approvalName]) {
        element.getAnimations().forEach(animation => animation.cancel())
        element.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' })
      }
    }
    if (firstSnapshot || conversationChanged) loadDraft(snapshot)
    else {
      renderCapabilityTray()
    }
    renderConversationList(snapshot)
    if (currentMainView !== 'workbench') renderProductView()
    const nextConversationSignature = conversationRenderSignature(snapshot.conversation.turns, latestConversationFailure(snapshot))
    const canRenderConversation = renderConversation || snapshot.runtime.status === 'error'
    if (conversationChanged || canRenderConversation && nextConversationSignature !== renderedConversationSignature) {
      if (editingTurnId && !conversationChanged) {
        pendingConversationRender = true
      } else {
        pendingConversationRender = false
        if (conversationChanged || firstSnapshot) {
          renderTurns(snapshot.conversation.turns, conversationChanged && !firstSnapshot)
        } else {
          renderCanonicalTaskFlow()
        }
        renderedConversationSignature = nextConversationSignature
      }
    }
    reconcileConversationFailure(snapshot)
    refreshExecutionVisualEvidence(snapshot)
    if (shell.classList.contains('inspector-open')) renderInspector()
    updateRunButton(snapshot)
    renderRecoveryState(snapshot)
    const workflowRequest = snapshot.runtime.pendingRequests.find(request => request.ui)
    if (workflowRequest?.ui && (
      workflowSurfaceRequestId !== workflowRequest.id
      || workflowSurface?.dataset.stage !== workflowRequest.ui.stage
    )) {
      showWorkflowSurface({ requestId: workflowRequest.id, question: workflowRequest.question, ui: workflowRequest.ui })
    } else if (!workflowRequest && workflowSurface) {
      closeWorkflowSurface()
    }
    if (conversationChanged && !firstSnapshot) void refreshConversationSystemSnapshots()
  }

  function currentConversationTitle(snapshot: WorkbenchSnapshot): string {
    const indexed = snapshot.conversations.find(conversation => conversation.id === snapshot.conversation.id)
    if (indexed) return taskDisplayTitle(indexed)
    const firstPrompt = snapshot.conversation.turns.find(turn => turn.role === 'user' && turn.metadata?.internal !== true)?.content.trim()
    return firstPrompt ? firstPrompt.replace(/\s+/g, ' ').slice(0, 42) : NEW_TASK_TITLE
  }

  function renderBreadcrumb() {
    const snapshot = currentSnapshot
    const title = currentMainView === 'workbench'
      ? snapshot ? currentConversationTitle(snapshot) : '工作台'
      : '自动化'
    breadcrumbTitle.textContent = title
    breadcrumb.setAttribute('aria-label', title)
  }

  function workspaceSpecified(snapshot: WorkbenchSnapshot): boolean {
    return (snapshot as DesktopWorkbenchSnapshot).workspace.specified !== false
  }

  function scheduleSnapshotRefresh(delay = 80) {
    if (!bridge) return
    snapshotRefreshPending = true
    if (snapshotRefreshTimer !== null || snapshotRefreshInFlight) return
    snapshotRefreshTimer = lifetime.timeout(() => {
      snapshotRefreshTimer = null
      snapshotRefreshPending = false
      snapshotRefreshInFlight = true
      const conversationId = currentSnapshot?.conversation.id
      const rewriteRevision = historyRewriteRevision
      void bridge.getSnapshot()
        .then(snapshot => {
          if (rewriteRevision !== historyRewriteRevision) return
          if (conversationId && (
            currentSnapshot?.conversation.id !== conversationId
            || snapshot.conversation.id !== conversationId
          )) return
          applySnapshot(snapshot, false)
        })
        .catch(() => undefined)
        .finally(() => {
          snapshotRefreshInFlight = false
          if (snapshotRefreshPending) scheduleSnapshotRefresh(120)
        })
    }, Math.max(32, delay))
  }

  function showRequest(event: {
    requestId?: string
    question: string
    options?: string[]
    reason?: string
    toolName?: string
    path?: string
    ui?: WorkflowSurfaceSpec
  }) {
    if (event.ui?.workflow) {
      showWorkflowSurface({ requestId: event.requestId, question: event.question, ui: event.ui })
      return
    }
    transcript.querySelector(`[data-request-id="${CSS.escape(event.requestId || '')}"]`)?.remove()
    const card = document.createElement('section')
    card.className = 'request-card'
    card.dataset.requestId = event.requestId || ''
    if (event.toolName && isBuiltInBrowserTool(event.toolName)) {
      card.classList.add('browser-request')
      const context = document.createElement('span')
      context.className = 'request-context'
      context.innerHTML = `${icon('globe')}<span>网页操作需要确认</span>`
      card.append(context)
    } else if (event.toolName && isBuiltInComputerTool(event.toolName)) {
      card.classList.add('computer-request')
      const context = document.createElement('span')
      context.className = 'request-context'
      context.innerHTML = `${icon('computer')}<span>电脑操作需要确认</span>`
      card.append(context)
    }
    const question = document.createElement('strong')
    question.textContent = event.question
    card.append(question)
    if (event.reason) {
      const reason = document.createElement('p')
      reason.textContent = event.reason
      card.append(reason)
    }
    const actions = document.createElement('div')
    actions.className = 'request-actions'
    const options = event.options?.length ? event.options : ['提交']
    if (event.options?.length) {
      for (const option of options) {
        const button = document.createElement('button')
        button.className = option === 'deny' ? 'request-button danger' : 'request-button'
        button.textContent = ({ 'allow-once': '仅这次允许', 'allow-run': '本次任务自动', 'allow-session': '本会话自动', deny: '不允许' } as Record<string, string>)[option] || option
        button.addEventListener('click', () => void resolveRequest(event.requestId || '', option, card))
        actions.append(button)
      }
    } else {
      const input = document.createElement('input')
      input.className = 'request-input'
      input.placeholder = '输入回复'
      const button = document.createElement('button')
      button.className = 'request-button'
      button.textContent = '提交'
      button.addEventListener('click', () => void resolveRequest(event.requestId || '', input.value, card))
      actions.append(input, button)
    }
    card.append(actions)
    appendTranscriptElement(card)
    setConversationMode(true)
    scrollTranscript()
  }

  async function resolveRequest(requestId: string, response: string, card: HTMLElement) {
    if (!bridge || !requestId || !response.trim()) return
    if (card.dataset.resolving === 'true') return
    card.dataset.resolving = 'true'
    const controls = Array.from(card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
    for (const control of controls) control.disabled = true
    const feedback = document.createElement('span')
    feedback.className = 'request-feedback'
    feedback.textContent = '已收到，正在继续'
    card.append(feedback)
    try {
      beginRequestStatusAttempt()
      const resolved = await bridge.resolveRequest(requestId, response.trim())
      if (resolved) {
        card.remove()
        if (workflowSurfaceRequestId === requestId) closeWorkflowSurface(requestId)
      } else {
        card.dataset.resolving = 'false'
        feedback.remove()
        for (const control of controls) control.disabled = false
        showToast('回答未能提交，请重新选择')
      }
    } catch (error) {
      card.dataset.resolving = 'false'
      feedback.remove()
      for (const control of controls) control.disabled = false
      showToast(errorMessage(error))
    }
  }

  function handleConversationEvent(event: AnyConversationEvent) {
    if (
      submissionPending
      && (event.type === 'turn.started' || event.type === 'stream.started' || event.type === 'run.started' || event.type === 'run.state_changed')
    ) {
      submissionPending = false
      if (currentSnapshot) updateRunButton(currentSnapshot)
    }
    switch (event.type) {
      case 'turn.started':
      case 'turn.completed': {
        const turn = event.payload.turn
        transcriptIndex.setTurn(turn)
        if (event.type === 'turn.started' && turn.role === 'user') {
          reconcileOptimisticUserTurn(turn)
          if (isHistoryRewriteUserTurn({
            resendingTurnId,
            eventType: 'turn.started',
            turnId: turn.id,
            turnRole: turn.role,
          })) {
            beginRequestStatusAttempt()
            historyRewriteOptimisticTurn = turn
            resendingTurnId = ''
            reconcileHistoryRewriteUserTurn(turn)
          }
        }
        if (event.type === 'turn.completed') scheduleSnapshotRefresh(32)
        break
      }
      case 'tool.proposed':
        transcriptIndex.setCall(event.payload.toolCall)
        break
      case 'tool.completed':
        transcriptIndex.setResult(event.payload.toolResult)
        break
      case 'approval.requested':
        showRequest({
          requestId: event.payload.requestId,
          question: event.payload.question,
          options: event.payload.options,
          reason: event.payload.reason,
          toolName: event.payload.toolName,
          path: event.payload.path,
          ui: event.payload.ui,
        })
        break
      case 'approval.resolved':
      case 'approval.cancelled':
        closeWorkflowSurface(event.payload.requestId)
        transcript.querySelector(`[data-request-id="${CSS.escape(event.payload.requestId)}"]`)?.remove()
        break
      case 'run.state_changed':
        if (currentSnapshot) updateRunButton(currentSnapshot)
        break
      case 'usage.updated':
        if (currentSnapshot) {
          currentSnapshot.context.usage = { ...currentSnapshot.context.usage, ...event.payload.usage }
          renderComposerContext(currentSnapshot)
        }
        break
      case 'context.compaction':
        if (currentSnapshot) currentSnapshot.context.compaction = event.payload.state
        break
      case 'notification.raised':
        if (event.payload.level === 'warning' || event.payload.level === 'error') showToast(event.payload.message)
        break
      case 'run.completed':
        activeTaskStartedAt = 0
        if (currentSnapshot) updateRunButton(currentSnapshot)
        scheduleSnapshotRefresh(32)
        break
      case 'runtime.event':
        scheduleSnapshotRefresh()
        break
    }
  }

  function handleRuntimeEvent(event: WorkbenchEvent) {
    if (lifetime.disposed) return
    if (resendingTurnId) {
      if (event.type === 'conversation-event' && event.conversationId === currentSnapshot?.conversation.id) {
        const rewrittenInput = event.event.type === 'turn.started'
          && isHistoryRewriteUserTurn({
            resendingTurnId,
            eventType: event.event.type,
            turnId: event.event.payload.turn.id,
            turnRole: event.event.payload.turn.role,
          })
        if (!rewrittenInput) return
      }
      if (event.type === 'conversation-run' && event.conversationId === currentSnapshot?.conversation.id) return
      if (event.type === 'runtime-error' && (!event.conversationId || event.conversationId === currentSnapshot?.conversation.id)) return
    }
    if (shouldPlayTaskCompletionSound(event)) void playTaskCompletionChime()
    if (event.type === 'conversation-event') {
      if (event.conversationId !== currentSnapshot?.conversation.id) return
      const previousView = conversationView || {
        generation: currentSnapshot.work.projection.generation,
        flow: taskFlowProjection || createTaskFlowProjection(event.conversationId),
        execution: currentSnapshot.activity.execution,
        runState: currentSnapshot.runtime.runState,
        status: currentSnapshot.runtime.status,
      }
      const nextView = applyConversationViewEvent(previousView, event.event)
      if (nextView === previousView) {
        if ((event.event.generation ?? 0) > (previousView.generation ?? 0)
          || (event.event.generation ?? 0) === (previousView.generation ?? 0) && event.event.seq > previousView.flow.lastSeq) scheduleSnapshotRefresh(32)
        return
      }
      conversationView = nextView
      taskFlowProjection = nextView.flow
      currentSnapshot.activity.execution = nextView.execution
      currentSnapshot.runtime.runState = nextView.runState
      currentSnapshot.runtime.status = nextView.status
      if (previousView.status !== nextView.status) {
        const runtime = currentSnapshot.conversationRuntimes.find(candidate => candidate.conversationId === event.conversationId)
        if (runtime) {
          runtime.status = nextView.status
          runtime.runState = nextView.runState
          runtime.updatedAt = event.event.at
          renderConversationList(currentSnapshot)
        }
        updateRunButton(currentSnapshot)
      }
      handleConversationEvent(event.event)
      scheduleCanonicalTaskFlowRender()
      return
    }
    if (event.type === 'snapshot') {
      applySnapshot(event.snapshot, event.snapshot.runtime.status === 'ready')
    }
    if (event.type === 'settings-updated') settingsCenter?.handleSettingsUpdate(event.settings)
    if (event.type === 'persistence' && currentSnapshot) {
      currentSnapshot.persistence = event.health
      renderRecoveryState(currentSnapshot)
      if (event.health.status === 'degraded') showToast(event.health.error || '会话存储暂不可用')
    }
    if (event.type === 'runtime-error') {
      if (resendingTurnId && (!event.conversationId || event.conversationId === currentSnapshot?.conversation.id)) {
        resendingTurnId = ''
        clearHistoryRewriteViewport()
        scheduleSnapshotRefresh(32)
      }
      showToast(event.message)
    }
  }

  function insertPromptText(value: string) {
    const start = taskInput.selectionStart
    const end = taskInput.selectionEnd
    taskInput.setRangeText(value, start, end, 'end')
    taskInput.dispatchEvent(new Event('input'))
  }

  function addDraftFiles(files: WorkbenchFileReference[]) {
    const known = new Set([...draftAttachments.map(item => item.id), ...draftFiles.map(item => item.id)])
    for (const file of files) {
      if (known.has(file.id)) continue
      known.add(file.id)
      if (file.type === 'image') {
        draftAttachments.push({
          id: file.id,
          type: 'image',
          path: file.path,
          mime: file.mime,
          filename: file.filename,
          size: file.size,
        })
      } else {
        draftFiles.push({ ...file })
      }
    }
    renderDraftTray()
    scheduleDraftRecord()
    if (currentSnapshot) updateRunButton(currentSnapshot)
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error || new Error('无法读取剪贴板图片'))
      reader.onload = () => resolve(String(reader.result || '').split(',').at(-1) || '')
      reader.readAsDataURL(file)
    })
  }

  async function importDroppedFiles(files: File[]) {
    if (!bridge || files.length === 0) return
    const paths = files.map(file => bridge.pathForFile(file)).filter(Boolean)
    if (paths.length === 0) return showToast('无法读取这些文件的本地路径')
    const imported = await bridge.importFiles(paths)
    addDraftFiles(imported)
    showToast(`已添加 ${imported.length} 个文件`)
  }

  function closeComposerMenus() {
    composerMenu.classList.remove('visible')
    composerMenu.setAttribute('aria-hidden', 'true')
    composerAddButton.setAttribute('aria-expanded', 'false')
    capabilityMenu.classList.remove('visible')
    capabilityMenu.setAttribute('aria-hidden', 'true')
    approvalMenu.classList.remove('visible')
    approvalMenu.setAttribute('aria-hidden', 'true')
    approvalPill.setAttribute('aria-expanded', 'false')
  }

  function syncComposerMenuPlacement() {
    const placement = composerPopoverPlacement(mainScroll.classList.contains('conversation-mode'))
    const cardRect = composerCard.getBoundingClientRect()
    composerCard.parentElement?.style.setProperty('--composer-menu-anchor-offset', `${composerCard.offsetHeight}px`)
    const availableHeight = cardRect
      ? placement === 'below'
        ? window.innerHeight - cardRect.bottom - 14
        : cardRect.top - 14
      : window.innerHeight - 150
    for (const menu of [composerMenu, capabilityMenu, approvalMenu]) {
      menu.dataset.placement = placement
      menu.style.setProperty('--composer-menu-max-height', `${Math.max(96, availableHeight)}px`)
    }
  }

  function createComposerMenuRow(options: {
    glyph: string
    title: string
    detail?: string
    selected?: boolean
    disabled?: boolean
    onClick(): void
  }): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = `composer-menu-row${options.selected ? ' selected' : ''}`
    button.disabled = options.disabled === true
    const glyph = document.createElement('span')
    glyph.className = 'composer-menu-glyph'
    glyph.innerHTML = options.glyph
    const copy = document.createElement('span')
    copy.className = 'composer-menu-copy'
    const title = document.createElement('strong')
    title.textContent = options.title
    copy.append(title)
    if (options.detail) {
      const detail = document.createElement('small')
      detail.textContent = options.detail
      copy.append(detail)
    }
    const mark = document.createElement('i')
    mark.innerHTML = options.selected ? icon('check') : ''
    button.setAttribute('role', options.selected === undefined ? 'menuitem' : 'menuitemcheckbox')
    if (options.selected !== undefined) button.setAttribute('aria-checked', String(options.selected))
    button.append(glyph, copy, mark)
    button.addEventListener('click', options.onClick)
    return button
  }

  function appendComposerMenuSection(title: string, target = composerMenu): HTMLElement {
    const section = document.createElement('section')
    const label = document.createElement('div')
    label.className = 'composer-menu-label'
    label.textContent = title
    section.append(label)
    target.append(section)
    return section
  }

  async function chooseDraftFiles() {
    try {
      const files = await bridge?.chooseFiles() || []
      addDraftFiles(files)
      if (files.length > 0) showToast(`已添加 ${files.length} 个文件`)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }

  async function chooseTaskWorkspace() {
    if (!bridge) return showToast('桌面核心未连接')
    if (composerActionGuard.active) return
    const release = conversationNavigationGuard.tryAcquire()
    if (!release) return
    try {
      await persistDraftNow()
      const snapshot = await bridge.chooseWorkspace()
      if (snapshot) applySnapshot(snapshot)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      finishConversationNavigation(release)
    }
  }

  function renderComposerMenu() {
    composerMenu.replaceChildren()
    composerMenu.setAttribute('role', 'menu')
    composerMenu.append(
      createComposerMenuRow({
        glyph: icon('paperclip'),
        title: '添加文件',
        onClick: () => {
          closeComposerMenus()
          void chooseDraftFiles()
        },
      }),
      createComposerMenuRow({
        glyph: icon('spark'),
        title: '选择技能',
        onClick: openSkillMenu,
      }),
    )
  }

  let skillMenuRevision = 0
  let skillSelectionPending = false

  function renderSkillMenu() {
    const revision = ++skillMenuRevision
    capabilityMenu.replaceChildren()
    capabilityMenu.setAttribute('role', 'dialog')
    capabilityMenu.setAttribute('aria-label', '选择技能')
    const header = document.createElement('div')
    header.className = 'composer-skill-header'
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'composer-skill-back'
    back.setAttribute('aria-label', '返回添加菜单')
    back.innerHTML = `${icon('chevron')}<span>选择技能</span>`
    back.onclick = toggleComposerMenu
    header.append(back)
    const search = document.createElement('input')
    search.type = 'search'
    search.className = 'composer-skill-search'
    search.placeholder = '搜索技能'
    search.setAttribute('aria-label', '搜索技能')
    const list = document.createElement('div')
    list.className = 'composer-skill-list'
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', '可用技能')
    const loading = document.createElement('p')
    loading.className = 'composer-menu-empty'
    loading.textContent = '正在读取技能…'
    list.append(loading)
    capabilityMenu.append(header, search, list)
    if (!bridge) { loading.textContent = '技能仅在桌面端可用'; return }
    void bridge.getSnapshot().then(snapshot => {
      if (revision !== skillMenuRevision || !capabilityMenu.classList.contains('visible')) return
      const renderRows = () => {
        list.replaceChildren()
        const query = search.value.trim().toLocaleLowerCase()
        const skills = snapshot.skills.filter(skill => `${skill.name} ${skill.command} ${skill.description}`.toLocaleLowerCase().includes(query))
        for (const skill of skills) {
          const selected = draftCapabilities.some(item => item.type === 'skill' && item.id === skill.id)
          const row = createComposerMenuRow({
            glyph: icon('spark'), title: skill.name, selected,
            onClick: () => void (async () => {
              if (skillSelectionPending) return
              skillSelectionPending = true
              const previous = draftCapabilities
              draftCapabilities = selected
                ? draftCapabilities.filter(item => !(item.type === 'skill' && item.id === skill.id))
                : [{ type: 'skill', id: skill.id, name: skill.name }, ...draftCapabilities.filter(item => item.type !== 'skill')]
              renderCapabilityTray()
              list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true })
              try {
                await persistDraftNow()
                closeComposerMenus()
                taskInput.focus()
              } catch (error) {
                draftCapabilities = previous
                renderCapabilityTray()
                renderRows()
                showToast(errorMessage(error))
              } finally { skillSelectionPending = false }
            })(),
          })
          row.dataset.skillId = skill.id
          row.setAttribute('role', 'checkbox')
          row.title = skill.description || skill.name
          list.append(row)
        }
        if (!skills.length) {
          const empty = document.createElement('p')
          empty.className = 'composer-menu-empty'
          empty.textContent = query ? '没有匹配的技能' : '暂无可用技能'
          list.append(empty)
        }
      }
      renderRows()
      search.addEventListener('input', renderRows)
    }).catch(error => { loading.textContent = errorMessage(error) })
    lifetime.frame(() => search.focus())
  }

  function toggleComposerMenu() {
    const opening = !composerMenu.classList.contains('visible')
    closeComposerMenus()
    if (!opening) return
    syncComposerMenuPlacement()
    renderComposerMenu()
    composerMenu.classList.add('visible')
    composerMenu.setAttribute('aria-hidden', 'false')
    composerAddButton.setAttribute('aria-expanded', 'true')
  }

  function openSkillMenu() {
    closeComposerMenus()
    syncComposerMenuPlacement()
    renderSkillMenu()
    capabilityMenu.classList.add('visible')
    capabilityMenu.setAttribute('aria-hidden', 'false')
    composerAddButton.setAttribute('aria-expanded', 'true')
  }

  function approvalDescription(policy: ApprovalPolicy): string {
    if (policy === 'ask') return '执行工具前先征求确认'
    if (policy === 'agent') return '低风险操作自动继续'
    return '允许完整主机能力'
  }

  let approvalSelectionPending = false
  async function selectApprovalPolicy(policy: ApprovalPolicy) {
    if (!bridge || approvalSelectionPending || currentSnapshot?.runtime.approvalPolicy === policy) return
    approvalSelectionPending = true
    approvalPill.setAttribute('aria-busy', 'true')
    try {
      const settings = await bridge.getSettings(false)
      const update = createSettingsUpdate(settings)
      update.approvalPolicy = policy
      if (policy === 'full') update.capabilityProfile = 'danger-full-access'
      const result = await bridge.saveSettings(update)
      applySnapshot(result.snapshot, false)
      closeComposerMenus()
      showToast(`审批模式已切换为${({ ask: '每次询问', agent: '低风险自动', full: '全权执行' } as const)[policy]}`)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      approvalSelectionPending = false
      approvalPill.removeAttribute('aria-busy')
    }
  }

  function toggleApprovalMenu() {
    const opening = !approvalMenu.classList.contains('visible')
    closeComposerMenus()
    if (!opening || !currentSnapshot) return
    approvalMenu.replaceChildren()
    approvalMenu.setAttribute('role', 'menu')
    const label = document.createElement('div')
    label.className = 'composer-menu-label'
    label.textContent = '审批模式'
    approvalMenu.append(label)
    const names: Record<ApprovalPolicy, string> = { ask: '每次询问', agent: '低风险自动', full: '全权执行' }
    for (const policy of ['ask', 'agent', 'full'] as ApprovalPolicy[]) {
      const row = createComposerMenuRow({
        glyph: approvalPolicyIcon(policy),
        title: names[policy],
        detail: approvalDescription(policy),
        selected: currentSnapshot.runtime.approvalPolicy === policy,
        onClick: () => void selectApprovalPolicy(policy),
      })
      row.dataset.policy = policy
      approvalMenu.append(row)
    }
    syncComposerMenuPlacement()
    approvalMenu.classList.add('visible')
    approvalMenu.setAttribute('aria-hidden', 'false')
    approvalPill.setAttribute('aria-expanded', 'true')
  }

  async function submitCurrentPrompt() {
    if (composerActionGuard.active) return
    const release = composerActionGuard.tryAcquire()
    if (!release) return
    if (currentSnapshot) updateRunButton(currentSnapshot)
    else runButton.disabled = true
    try {
      await submitCurrentPromptOnce()
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      release()
      if (currentSnapshot) updateRunButton(currentSnapshot)
      else runButton.disabled = false
      continuePendingConversationNavigation()
    }
  }

  async function submitCurrentPromptOnce() {
    if (!bridge) return showToast('桌面核心未连接')
    clearHistoryRewriteViewport()
    const value = taskInput.value.trim()
    const hasDraftInput = hasCurrentDraftInput()
    if (value.startsWith('/') && draftAttachments.length === 0 && draftFiles.length === 0 && pendingPastes.length === 0) {
      try {
        const normalized = value.toLowerCase().replace(/\s+/g, ' ')
        const command = (await bridge.listCommands()).find(item => item.slash?.toLowerCase() === normalized)
        if (!command) {
          showToast('没有匹配的命令，已打开命令面板')
          await commandPalette?.open()
          return
        }
        const result = await bridge.executeCommand(command.id)
        taskInput.value = ''
        await persistDraftNow()
        if (result.message) showToast(result.message)
        await handleCommandResult(result)
      } catch (error) {
        showToast(errorMessage(error))
      }
      return
    }
    const active = currentSnapshot && ['running', 'paused', 'awaiting-action'].includes(currentSnapshot.runtime.status)
    if (!hasDraftInput) {
      taskInput.focus()
      return
    }
    const submittedDraft = currentDraft()
    try {
      let expandedPrompt = value || '请分析并处理这些附件。'
      for (const paste of pendingPastes) expandedPrompt = expandedPrompt.replaceAll(paste.placeholder, paste.text)
      const submittedAttachments = [
        ...draftAttachments,
        ...draftFiles.map(file => ({ ...file, type: 'file' as const })),
      ]
      const submittedCapabilities = draftCapabilities.length > 0
        ? { items: draftCapabilities.map(capability => ({ ...capability })) }
        : undefined
      beginRequestStatusAttempt()
      const optimisticElement = !active
        ? mountOptimisticUserTurn(
            expandedPrompt,
            submittedAttachments.length > 0 ? submittedAttachments : undefined,
            submittedCapabilities,
          )
        : null
      if (draftTimer !== null) {
        lifetime.clearTimeout(draftTimer)
        draftTimer = null
      }
      submissionPending = !active
      submissionPauseRequested = false
      taskInput.value = ''
      draftAttachments = []
      draftFiles = []
      pendingPastes = []
      renderDraftTray()
      resizeTaskInput()
      if (currentSnapshot) updateRunButton(currentSnapshot)
      void draftRecordQueue.enqueue(() => bridge.recordDraft(currentDraft())).catch(() => undefined)
      const result = await bridge.submitPrompt(
        expandedPrompt,
        submittedAttachments.length > 0 ? submittedAttachments : undefined,
        submittedCapabilities,
      )
      if (optimisticElement?.isConnected) {
        if (result.status === 'started') {
          pendingOptimisticInputId = result.inputId
          optimisticElement.dataset.optimisticInputId = result.inputId
          scheduleCanonicalTaskFlowRender(true)
        } else {
          clearPendingOptimisticUserTurn()
        }
      }
      if (result.status === 'started' && !activeTaskStartedAt) {
        activeTaskStartedAt = Date.now()
      }
      if (result.status !== 'started') {
        submissionPending = false
      }
      if (submissionPauseRequested && result.status === 'started') {
        await bridge.pause()
        applySnapshot(await bridge.getSnapshot(), false)
      }
      submissionPauseRequested = false
      if (currentSnapshot) updateRunButton(currentSnapshot)
      if (result.status === 'queued') showToast('已加入下一轮')
      if (result.status === 'steering') showToast('已补充到当前任务')
    } catch (error) {
      submissionPending = false
      submissionPauseRequested = false
      clearPendingOptimisticUserTurn()
      taskInput.value = [submittedDraft.text, taskInput.value].filter(Boolean).join('\n')
      const attachmentIds = new Set(draftAttachments.map(item => item.id))
      draftAttachments = [
        ...submittedDraft.attachments.filter(item => !attachmentIds.has(item.id)),
        ...draftAttachments,
      ]
      const fileIds = new Set(draftFiles.map(item => item.id))
      draftFiles = [...submittedDraft.files.filter(item => !fileIds.has(item.id)), ...draftFiles]
      const pasteIds = new Set(pendingPastes.map(item => item.placeholder))
      pendingPastes = [...submittedDraft.pendingPastes.filter(item => !pasteIds.has(item.placeholder)), ...pendingPastes]
      draftCapabilities = submittedDraft.capabilities.items.map(item => ({ ...item }))
      renderDraftTray()
      resizeTaskInput()
      void draftRecordQueue.enqueue(() => bridge.recordDraft(currentDraft())).catch(() => undefined)
      if (currentSnapshot) updateRunButton(currentSnapshot)
      showToast(errorMessage(error))
    }
  }

  async function controlRunFromComposer(action: 'pause' | 'resume') {
    if (!bridge || composerActionGuard.active) return
    const release = composerActionGuard.tryAcquire()
    if (!release) return
    if (currentSnapshot) updateRunButton(currentSnapshot)
    try {
      if (action === 'pause') await bridge.pause()
      else await bridge.resume()
      applySnapshot(await bridge.getSnapshot(), false)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      release()
      if (currentSnapshot) updateRunButton(currentSnapshot)
    }
  }

  function activateRunButton() {
    if (!currentSnapshot) return
    const presentation = currentRunButtonPresentation(currentSnapshot)
    if (presentation.disabled) return
    if (presentation.action === 'send') {
      void submitCurrentPrompt()
      return
    }
    if (presentation.action === 'pause' && submissionPending) {
      submissionPauseRequested = true
      updateRunButton(currentSnapshot)
      return
    }
    void controlRunFromComposer(presentation.action)
  }

  async function switchConversation(id: string) {
    if (!bridge) return
    if (id === currentSnapshot?.conversation.id) {
      showMainView('workbench')
      return
    }
    if (composerActionGuard.active || conversationNavigationGuard.active) {
      pendingConversationNavigationId = id
      return
    }
    const release = conversationNavigationGuard.tryAcquire()
    if (!release) return
    const transitionId = beginConversationTransition('switch', id)
    let succeeded = false
    try {
      await persistDraftNow()
      const result = await bridge.switchConversation(id)
      applySnapshot(result.snapshot)
      showMainView('workbench')
      succeeded = true
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      finishConversationTransition(transitionId, succeeded)
      finishConversationNavigation(release)
    }
  }

  function finishConversationNavigation(release: () => void) {
    release()
    continuePendingConversationNavigation()
  }

  function continuePendingConversationNavigation() {
    if (composerActionGuard.active || conversationNavigationGuard.active) return
    const pendingId = pendingConversationNavigationId
    pendingConversationNavigationId = ''
    if (pendingId && pendingId !== currentSnapshot?.conversation.id) void switchConversation(pendingId)
  }

  app.querySelectorAll<HTMLButtonElement>('.sidebar-nav-item[data-view]').forEach(button => {
    button.addEventListener('click', () => {
      const view = button.dataset.view
      if (view === 'skills') {
        void settingsCenter?.open('workpacks')
        return
      }
      if (view === 'automations' || view === 'workbench') showMainView(view)
    })
  })

  app.querySelector('#workspace-task-add')?.addEventListener('click', async () => {
    if (!bridge) return showToast('桌面核心未连接')
    try {
      const project = await openWorkspaceDialog(bridge, () => currentSnapshot?.projects.projects || [])
      if (!project || !currentSnapshot) return
      applySnapshot({
        ...currentSnapshot,
        projects: {
          ...currentSnapshot.projects,
          projects: [project, ...currentSnapshot.projects.projects.filter(item => item.id !== project.id)],
        },
      }, false)
      workspaceGroupExpansion = { ...workspaceGroupExpansion, [project.id]: true }
      localStorage.setItem(workspaceGroupExpansionStorageKey, JSON.stringify(workspaceGroupExpansion))
      renderConversationList(currentSnapshot)
      const group = Array.from(app.querySelectorAll<HTMLElement>('[data-workspace-key]'))
        .find(element => element.dataset.workspaceKey === project.id)
      group?.scrollIntoView({ block: 'nearest' })
      group?.querySelector<HTMLButtonElement>('.workspace-task-group-toggle')?.focus({ preventScroll: true })
      showToast('工作区已就绪')
    } catch (error) {
      showToast(errorMessage(error))
    }
  })

  app.querySelector('#run-button')?.addEventListener('click', activateRunButton)
  sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!shell.classList.contains('sidebar-collapsed')))
  newTaskButton.addEventListener('click', async () => {
    if (!bridge) return
    if (composerActionGuard.active) return
    const release = conversationNavigationGuard.tryAcquire()
    if (!release) return
    const transitionId = beginConversationTransition('new', '', newTaskButton)
    let succeeded = false
    try {
      await persistDraftNow()
      const result = await bridge.newConversation()
      taskInput.value = ''
      draftAttachments = []
      draftFiles = []
      pendingPastes = []
      renderDraftTray()
      applySnapshot(result.snapshot)
      showMainView('workbench')
      taskInput.focus()
      succeeded = true
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      finishConversationTransition(transitionId, succeeded)
      finishConversationNavigation(release)
    }
  })
  app.querySelector('#composer-start-workspace')?.addEventListener('click', () => void chooseTaskWorkspace())
  app.querySelector('#composer-add')?.addEventListener('click', toggleComposerMenu)
  app.querySelector('#approval-pill')?.addEventListener('click', toggleApprovalMenu)
  app.querySelector('#settings-button')?.addEventListener('click', () => void settingsCenter?.open())
  for (const id of ['profile-center-button', 'welcome-profile-avatar']) {
    app.querySelector<HTMLElement>(`#${id}`)?.addEventListener('click', event => void userProfile?.open(event.currentTarget as HTMLElement))
  }
  app.querySelector('#composer-context')?.addEventListener('click', () => openInspector('context'))
  app.querySelector('#model-pill')?.addEventListener('click', event => void settingsCenter?.openModelPicker(event.currentTarget as HTMLElement))
  app.querySelector('#reasoning-tab')?.addEventListener('click', event => void settingsCenter?.openReasoningPicker(event.currentTarget as HTMLElement))
  inspectorToggle.addEventListener('click', () => shell.classList.contains('inspector-open') ? closeInspector() : reopenInspector())
  workPlanToggle.addEventListener('click', () => setWorkPlanHidden(!shell.classList.contains('work-plan-hidden')))
  app.querySelector('#inspector-scrim')?.addEventListener('click', () => closeInspector())
  function setInspectorFullWidth(full: boolean) {
    inspectorUserFullWidth = full
    if (!full) browserLayoutMode = 'portrait'
    applyInspectorWidthForCurrentTab()
    renderInspectorChrome()
  }

  inspectorExpand.addEventListener('click', () => {
    setInspectorFullWidth(currentInspectorWidthMode() !== 'full')
  })
  inspectorResizeHandle.addEventListener('pointerdown', event => {
    if (!shell.classList.contains('inspector-open') || event.button !== 0) return
    event.preventDefault()
    const startRect = inspectorPanel.getBoundingClientRect()
    const grabOffset = event.clientX - startRect.left
    const startWidth = startRect.width
    const startMode = currentInspectorWidthMode()
    const startRatio = regularInspectorWidthRatio
    const startUserFullWidth = inspectorUserFullWidth
    const startBrowserLayout = browserLayoutMode
    const pointerId = event.pointerId
    let mode = startMode
    let snapWidth: number | null = null
    let dragging = true
    inspectorResizeHandle.setPointerCapture(pointerId)
    shell.classList.add('inspector-resizing')
    const cleanup = () => {
      if (!dragging) return
      dragging = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      inspectorResizeHandle.removeEventListener('lostpointercapture', finish)
      if (inspectorResizeHandle.hasPointerCapture(pointerId)) inspectorResizeHandle.releasePointerCapture(pointerId)
      shell.classList.remove('inspector-resizing', 'inspector-snapping')
    }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || !dragging) return
      const contentRect = workbenchSurface.getBoundingClientRect()
      const contentLeft = contentRect.left + workbenchSurface.clientLeft
      const contentWidth = inspectorMainContentWidth()
      const nextMode = inspectorDragWidthMode(moveEvent.clientX, contentLeft, contentWidth, mode)
      if (nextMode !== mode) {
        // A snap changes layout, not the pointer gesture. Keep the same capture until release.
        mode = nextMode
        regularInspectorWidthRatio = 1
        snapWidth = maximumInspectorWidth(mode)
        shell.classList.add('inspector-snapping')
        setInspectorFullWidth(mode === 'full')
        return
      }
      if (mode === 'full') return
      const dismissTriggerX = inspectorDismissTriggerX(contentLeft, contentWidth)
      if (shouldDismissInspectorAtPointer(moveEvent.clientX, dismissTriggerX)) {
        cleanup()
        closeInspector()
        setInspectorWidth(inspectorWidthFromRatio(regularInspectorWidthRatio, contentWidth), false, 'regular')
        return
      }
      const width = clampInspectorWidth(contentLeft + contentWidth - moveEvent.clientX + grabOffset, 'regular')
      // Let the snap settle until the pointer reaches the divider's regular-width range.
      if (snapWidth === width) return
      snapWidth = null
      shell.classList.remove('inspector-snapping')
      setInspectorWidth(width, false, 'regular')
    }
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId || !dragging) return
      const width = Number.parseFloat(shell.style.getPropertyValue('--work-panel-width'))
      cleanup()
      if (upEvent.type === 'pointercancel' || upEvent.type === 'lostpointercapture') {
        regularInspectorWidthRatio = startRatio
        inspectorUserFullWidth = startUserFullWidth
        browserLayoutMode = startBrowserLayout
        setInspectorWidth(startWidth, false, startMode)
        renderInspectorChrome()
        return
      }
      if (mode === 'regular') setInspectorWidth(width, true, 'regular')
      else {
        try { window.localStorage.setItem(inspectorWidthStorageKey, String(regularInspectorWidthRatio)) } catch {}
      }
    }
    lifetime.listen(window, 'pointermove', move)
    lifetime.listen(window, 'pointerup', finish)
    lifetime.listen(window, 'pointercancel', finish)
    inspectorResizeHandle.addEventListener('lostpointercapture', finish)
  })
  inspectorResizeHandle.addEventListener('dblclick', () => {
    setInspectorFullWidth(false)
    setInspectorWidth(defaultInspectorWidth(), true)
  })
  inspectorResizeHandle.addEventListener('keydown', event => {
    if (!shell.classList.contains('inspector-open')) return
    if (event.key === 'End') {
      event.preventDefault()
      setInspectorFullWidth(true)
      return
    }
    if (currentInspectorWidthMode() === 'full') {
      if (event.key === 'ArrowRight' || event.key === 'Home') {
        event.preventDefault()
        setInspectorFullWidth(false)
        if (event.key === 'Home') setInspectorWidth(INSPECTOR_MINIMUM_WIDTH, true)
      }
      return
    }
    const width = inspectorWidthFromKey(
      inspectorPanel.getBoundingClientRect().width,
      event.key,
      event.shiftKey,
      inspectorMainContentWidth(),
      currentInspectorWidthMode(),
    )
    if (width === null) return
    event.preventDefault()
    setInspectorWidth(width, true)
  })
  lifetime.listen(window, 'resize', () => {
    if (shell.classList.contains('inspector-open')) applyInspectorWidthForCurrentTab()
    syncComposerMenuPlacement()
    settingsCenter?.repositionComposerPicker()
  })
  const inspectorObserver = new ResizeObserver(() => {
    scheduleBrowserBoundsSync()
    if (!shell.classList.contains('inspector-open')) return
    if (inspectorChromeResizeFrame !== null) lifetime.cancelFrame(inspectorChromeResizeFrame)
    inspectorChromeResizeFrame = lifetime.frame(() => {
      inspectorChromeResizeFrame = null
      renderInspectorChrome()
    })
  })
  inspectorObserver.observe(inspectorPanel)
  lifetime.add(() => inspectorObserver.disconnect())
  taskInput.addEventListener('input', () => {
    resizeTaskInput()
    if (currentSnapshot) updateRunButton(currentSnapshot)
    scheduleDraftRecord()
  })
  taskInput.addEventListener('keydown', event => {
    if (
      event.key === 'Tab'
      && event.shiftKey
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !event.isComposing
      && currentSnapshot
      && !event.defaultPrevented
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const policies: ApprovalPolicy[] = ['ask', 'agent', 'full']
      const nextPolicy = policies[(policies.indexOf(currentSnapshot.runtime.approvalPolicy) + 1) % policies.length]
      void selectApprovalPolicy(nextPolicy)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submitCurrentPrompt()
    }
  })
  taskInput.addEventListener('paste', event => {
    const clipboardFiles = Array.from(event.clipboardData?.files || [])
    const images = clipboardFiles.filter(file => file.type.startsWith('image/'))
    if (images.length > 0 && bridge) {
      event.preventDefault()
      void Promise.all(images.map(async (file, index) => bridge.importClipboardImage(
        await fileToBase64(file),
        file.type || 'image/png',
        file.name || `clipboard-${index + 1}.png`,
      ))).then(files => {
        addDraftFiles(files)
        showToast(`已粘贴 ${files.length} 张图片`)
      }).catch(error => showToast(errorMessage(error)))
      return
    }
    const text = event.clipboardData?.getData('text/plain') || ''
    if (text.length < 4_000) return
    event.preventDefault()
    const placeholder = `【粘贴文本 ${pendingPastes.length + 1} · ${text.length.toLocaleString()} 字符】`
    pendingPastes.push({ placeholder, text })
    insertPromptText(placeholder)
    renderDraftTray()
    scheduleDraftRecord()
  })
  for (const eventName of ['dragenter', 'dragover']) {
    composerCard.addEventListener(eventName, event => {
      const dragEvent = event as DragEvent
      if (!dragEvent.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      composerCard.classList.add('drop-active')
    })
  }
  for (const eventName of ['dragleave', 'drop']) {
    composerCard.addEventListener(eventName, event => {
      if (eventName === 'drop') event.preventDefault()
      composerCard.classList.remove('drop-active')
    })
  }
  composerCard.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length > 0) void importDroppedFiles(files).catch(error => showToast(errorMessage(error)))
  })
  transcript.addEventListener('wheel', event => {
    transcriptWheelScrolling = true
    if (event.deltaY < 0) cancelTranscriptScroll()
    if (transcriptWheelTimer !== null) lifetime.clearTimeout(transcriptWheelTimer)
    transcriptWheelTimer = lifetime.timeout(() => {
      transcriptWheelTimer = null
      transcriptWheelScrolling = false
    }, 160)
  }, { passive: true })
  transcript.addEventListener('pointerdown', event => {
    if (event.target === transcript) transcriptPointerScrolling = true
  })
  lifetime.listen(window, 'pointerup', () => { transcriptPointerScrolling = false })
  lifetime.listen(window, 'pointercancel', () => { transcriptPointerScrolling = false })
  transcript.addEventListener('scroll', () => {
    transcriptFollowState = updateTranscriptFollowFromScroll(
      transcriptFollowState,
      transcript,
      transcriptPointerScrolling || transcriptWheelScrolling,
    )
    if (!transcriptFollowState.following) cancelTranscriptScroll()
    syncConversationNavigatorActiveState()
  }, { passive: true })
  transcript.addEventListener('click', event => {
    const target = event.target
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
    if (!anchor) return
    event.preventDefault()
    void bridge?.openExternal(anchor.href).catch(error => showToast(errorMessage(error)))
  })

  lifetime.listen(window, 'keydown', event => {
    if (settingsCenter?.isOpen()) {
      if (event.key === 'Escape') settingsCenter.close()
      return
    }
    const keyboardTarget = event.target
    const editingText = keyboardTarget instanceof HTMLElement && (
      keyboardTarget.isContentEditable
      || keyboardTarget.tagName === 'INPUT'
      || keyboardTarget.tagName === 'TEXTAREA'
      || keyboardTarget.tagName === 'SELECT'
    )
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'j') {
      event.preventDefault()
      terminalPanel?.toggle()
      return
    }
    if (
      !event.defaultPrevented
      && !editingText
      && !event.altKey
      && !event.shiftKey
      && (event.metaKey || event.ctrlKey)
      && event.key.toLowerCase() === 'b'
    ) {
      event.preventDefault()
      setSidebarCollapsed(!shell.classList.contains('sidebar-collapsed'))
      return
    }
    if (
      !event.defaultPrevented
      && !editingText
      && event.altKey
      && !event.shiftKey
      && !event.ctrlKey
      && !event.metaKey
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && jumpToAdjacentConversationNavigatorEntry(event.key === 'ArrowUp' ? 'previous' : 'next')
    ) {
      event.preventDefault()
      return
    }
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l' && browserSnapshot?.visible) {
      event.preventDefault()
      openInspector('browser')
      lifetime.frame(() => {
        const address = inspectorContent.querySelector<HTMLInputElement>('.inspector-browser-address')
        address?.focus()
        address?.select()
      })
      return
    }
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't' && browserSnapshot?.visible) {
      event.preventDefault()
      void bridge?.browserNewTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      return
    }
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w' && activeInspectorPanelTab()?.kind === 'browser') {
      event.preventDefault()
      const panelTab = activeInspectorPanelTab()
      if (panelTab) void closeInspectorPanelTab(panelTab.id)
      return
    }
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      void commandPalette?.open()
    }
    if (event.key === 'Escape') {
      if (commandPalette?.isOpen()) commandPalette.close()
      else if (workflowSurface) void resolveRequest(workflowSurfaceRequestId, 'cancelled', workflowSurface)
      else if (composerMenu.classList.contains('visible') || capabilityMenu.classList.contains('visible') || approvalMenu.classList.contains('visible')) closeComposerMenus()
      else if (inspectorModuleMenu.classList.contains('visible')) setInspectorModuleMenu(false)
      else if (terminalPanel?.isOpen()) terminalPanel.close()
      else if (shell.classList.contains('inspector-open')) closeInspector()
    }
  })

  lifetime.listen(document, 'click', event => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.conversation-menu')) closeSidebarMenu?.()
    if (target instanceof Element && !target.closest('#composer-menu, #composer-add, #capability-menu, #approval-menu, #approval-pill')) closeComposerMenus()
    if (target instanceof Element && !target.closest('#inspector-module-menu, #inspector-module-menu-toggle')) setInspectorModuleMenu(false)
  })

  app.querySelector('#conversation-list')?.addEventListener('scroll', () => closeSidebarMenu?.())
  lifetime.listen(window, 'resize', () => closeSidebarMenu?.())

  const primeCompletionSound = () => {
    window.removeEventListener('pointerdown', primeCompletionSound, true)
    window.removeEventListener('keydown', primeCompletionSound, true)
    void primeTaskCompletionChime()
  }
  lifetime.listen(window, 'pointerdown', primeCompletionSound, { capture: true, once: true })
  lifetime.listen(window, 'keydown', primeCompletionSound, { capture: true, once: true })

  inspectorModuleMenuToggle.addEventListener('click', toggleInspectorModuleMenu)
  inspectorBrowserNewTab.addEventListener('click', () => {
    setInspectorModuleMenu(false)
    void bridge?.browserNewTab().then(snapshot => {
      renderBrowserSnapshot(snapshot)
      openInspector('browser')
    }).catch(error => showToast(errorMessage(error)))
  })
  inspectorModuleMenu.querySelectorAll<HTMLButtonElement>('.inspector-module-option[data-tab]').forEach(button => {
    button.addEventListener('click', () => {
      setInspectorModuleMenu(false)
      openInspector(button.dataset.tab as InspectorTab)
    })
  })

  if (bridge) {
    lifetime.add(bridge.onRuntimeEvent(handleRuntimeEvent))
    lifetime.add(bridge.onNavigationIntent(intent => void handleNavigationIntent(intent).catch(error => showToast(errorMessage(error)))))
    lifetime.add(bridge.onBrowserEvent(handleBrowserEvent))
    void bridge.getSnapshot().then(snapshot => applySnapshot(snapshot)).catch(error => showToast(errorMessage(error)))
    void bridge.browserGetState().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
  } else {
    showToast('桌面核心桥接不可用')
  }
  lifetime.add(() => {
    linearTaskFlowRenderer.clear()
    transcriptIndex.reset()
    attachmentThumbnailObserver?.disconnect()
    transcriptResizeObserver.disconnect()
    conversationNavigatorResizeObserver.disconnect()
    settingsCenter?.dispose()
    userProfile?.dispose()
    for (const timer of [snapshotRefreshTimer, draftTimer, conversationTransitionSettleTimer, transcriptWheelTimer]) {
      if (timer !== null) lifetime.clearTimeout(timer)
    }
    for (const frame of [browserBoundsFrame, inspectorChromeResizeFrame, conversationTransitionFrame, conversationNavigatorSyncFrame, transcriptScrollFrame]) {
      if (frame !== null) lifetime.cancelFrame(frame)
    }
    computerControls?.dispose()
    terminalPanel?.dispose()
    closeSidebarMenu?.(false)
    closeWorkflowSurface()
    imageLightbox?.dispose()
  })
  return () => lifetime.dispose()

}
