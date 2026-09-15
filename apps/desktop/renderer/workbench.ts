import {
  isBuiltInBrowserTool,
  isBuiltInComputerTool,
  stripTextToolCallMarkup,
  type ThinkingTrace,
} from '@turboflux/agent-core/renderer'
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
} from '@turboflux/agent-core/workbench'
import type { DesktopWorkbenchEvent as WorkbenchEvent, DesktopWorkbenchSnapshot } from '../desktopTypes'
import type { AutomationNotificationNavigationIntent } from '../automationNotificationNavigation'
import { projectHistoryRewrite } from '../historyRewrite'
import {
  createThinkingBlock,
  createToolActivity,
  isInternalRuntimeTool,
  renderDiffPreview,
  renderMarkdown,
} from './richContent'
import { describeRuntimeTask } from './runtimeTaskPresentation'
import { createSettingsCenter, createSettingsUpdate } from './settingsCenter'
import { createAutomationsView } from './automationsView'
import { createProfileSwitcher, profileColor } from './profileSwitcher'
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
  latestUserTurnId,
  latestConversationFailure,
  presentDesktopError,
  requestStatusTerminalFenceApplies,
  shouldIgnoreSnapshotAfterRequestTerminal,
  type RequestStatusTerminalFence,
} from './conversationRendering'
import {
  executionOutcomeFromWorkRunStatus,
} from './executionPresentation'
import { completedTaskTurnDuration, presentWorkRun, selectProjectedWorkRun } from './workExecutionPresentation'
import {
  applyTaskFlowEvent,
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
import { presentTaskCompanion, type TaskCompanionItemKind } from './taskCompanion'
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
} from './linearTaskFlow'
import { createWorkPlanDockRenderer } from './workPlanPresentation'
import { SerializedAsyncQueue, SingleFlightGuard } from './interactionConcurrency'
import { projectWorkspaceConversationGroups, UNGROUPED_WORKSPACE_KEY } from './workspaceConversationProjection'
import { composerPopoverPlacement } from './composerPopoverPlacement'
import { createTerminalPanel } from './terminalPanel'
import { presentComposerRunButton, type ComposerRunButtonPresentation } from './composerRunButton'
import {
  activeConversationNavigatorIndices,
  compactConversationNavigatorText,
  conversationNavigatorMinimumItems,
  conversationNavigatorMarkerVisual,
  pairConversationNavigatorTasks,
} from './conversationNavigator'
import { createElement as createLucideElement, Ellipsis, Folder, FolderClosed, FolderOpen, Monitor, PanelLeftClose, PanelLeftOpen, Plus, Puzzle, Settings2, SquarePen, Workflow, type IconNode } from 'lucide'

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
type ProductTitlePhase = 'typing' | 'holding' | 'deleting' | 'switching'

const INSPECTOR_PRIMARY_NAVIGATION: ReadonlyArray<{ tab: InspectorTab; label: string; iconName: string }> = [
  { tab: 'browser', label: '浏览器', iconName: 'browser' },
]

const INSPECTOR_UTILITY_NAVIGATION: ReadonlyArray<{ tab: InspectorTab; label: string; iconName: string }> = [
  { tab: 'context', label: '上下文', iconName: 'context' },
  { tab: 'git', label: '版本', iconName: 'git' },
]

const productTitleVariants = [
  { word: '工作', className: 'is-work' },
  { word: '开发', className: 'is-code' },
] as const

const capabilityNameOverrides: Readonly<Record<string, string>> = {
  'office-workagent': '办公任务总控',
}

function capabilityDisplayName(capability: AgentCapabilityReference): string {
  return capabilityNameOverrides[capability.id] || capability.name || capability.id
}
const PRODUCT_TITLE_TYPE_DELAY = 120
const PRODUCT_TITLE_DELETE_DELAY = 78
const PRODUCT_TITLE_HOLD_DELAY = 1550
const PRODUCT_TITLE_SWITCH_DELAY = 260

const navigationIconNodes: Record<string, IconNode> = {
  newConversation: SquarePen,
  parallel: Workflow,
  pluginNav: Puzzle,
  settings: Settings2,
  sidebarCollapse: PanelLeftClose,
  sidebarExpand: PanelLeftOpen,
  folder: Folder,
  computer: Monitor,
  plus: Plus,
  more: Ellipsis,
}
const navigationIconMarkup = new Map<string, string>()

function lucideSvg(node: IconNode, className = ''): string {
  return createLucideElement(node, {
    class: `lucide-icon ${className}`.trim(),
    'aria-hidden': 'true',
    focusable: 'false',
    'stroke-width': 1.75,
  }).outerHTML
}

const icon = (name: string) => {
  const cached = navigationIconMarkup.get(name)
  if (cached) return cached
  const node = navigationIconNodes[name]
  if (node || name === 'workspace') {
    const svg = name === 'workspace'
      ? lucideSvg(FolderClosed, 'workspace-folder-closed') + lucideSvg(FolderOpen, 'workspace-folder-open')
      : lucideSvg(node)
    const markup = `<span class="icon icon-${name}" aria-hidden="true">${svg}</span>`
    navigationIconMarkup.set(name, markup)
    return markup
  }
  const icons: Record<string, string> = {
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4H7.5A2.5 2.5 0 0 1 5 12.5z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M4 7v5h5"/><path d="M5.5 17.5A8 8 0 1 0 4 12"/><path d="M12 8v4l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    forward: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    reload: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></svg>',
    external: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    paperclip: '<svg viewBox="0 0 24 24"><path d="m8.5 12.5 6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.2-8.2"/></svg>',
    paste: '<svg viewBox="0 0 24 24"><rect x="5" y="5.5" width="14" height="15" rx="2.5"/><path d="M9 5.5V4.2A1.7 1.7 0 0 1 10.7 2.5h2.6A1.7 1.7 0 0 1 15 4.2v1.3M8.5 10h7M8.5 13.5h7M8.5 17h4.5"/></svg>',
    plug: '<svg viewBox="0 0 24 24"><path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-6 6v5m-3 0h6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    changeAdd: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="8.5" opacity=".18"/></svg>',
    changeDelete: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/><circle cx="12" cy="12" r="8.5" opacity=".18"/></svg>',
    changeModify: '<svg viewBox="0 0 24 24"><path d="m5 17.8 9.9-9.9 3.2 3.2-9.9 9.9H5z"/><path d="m13.8 8.9 1.7-1.7a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8l-1.7 1.7"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M21 3 10.6 13.4"/><path d="m21 3-6.7 18-3.7-7.6L3 9.7Z"/></svg>',
    sendUp: '<svg viewBox="0 0 24 24"><path d="m6.5 10.5 5.5-5.5 5.5 5.5M12 5v14"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24"><path d="m6.5 9 5.5 5.5L17.5 9"/></svg>',
    command: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m9 9 2.5 3L9 15m4.5 0H16"/></svg>',
    terminal: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.5 9 3 3-3 3M13 15h3.5"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M15 4v16"/></svg>',
    overview: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="4" rx="1.5"/><rect x="13.5" y="11" width="7" height="9" rx="1.5"/><rect x="3.5" y="14" width="7" height="6" rx="1.5"/></svg>',
    activity: '<svg viewBox="0 0 24 24"><path d="M3.5 12h4l2.2-5.5 4.1 11 2.3-5.5h4.4"/><path d="M4 5.5h16M4 18.5h16" opacity=".35"/></svg>',
    browser: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/><circle cx="7" cy="6.75" r=".65"/><circle cx="10" cy="6.75" r=".65"/></svg>',
    outputs: '<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5V8h4M9.5 12h5M9.5 15.5h5"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5V8h4"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.5"/><path d="m5.5 17 4.2-4 2.8 2.4 2.7-2.7 3.3 3.3"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 4l-4 16"/></svg>',
    archive: '<svg viewBox="0 0 24 24"><path d="M5 8h14v11H5zM4 4h16v4H4z"/><path d="M10 12h4"/></svg>',
    table: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M10 4.5v15"/></svg>',
    slides: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="13" rx="2.5"/><path d="M12 17v3M8.5 20h7M8 8h8M8 12h5"/></svg>',
    context: '<svg viewBox="0 0 24 24"><path d="m12 3.5 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16.5l8 4 8-4"/></svg>',
    git: '<svg viewBox="0 0 24 24"><circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 12h3a5 5 0 0 0 5-5"/></svg>',
    preview: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="12" rx="2.5"/><path d="M8 20h8M12 16.5V20"/><path d="m10 8.5 5 2.5-5 2.5z"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M8 4H4v4M16 20h4v-4M4 8l5-5M20 16l-5 5"/></svg>',
    contract: '<svg viewBox="0 0 24 24"><path d="M9 9H4V4M15 15h5v5M4 4l6 6M20 20l-6-6"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
    pauseBlock: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2m-8 0 1 12h8l1-12M10 10v6m4-6v6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    account: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>',
    approvalAsk: '<svg viewBox="0 0 24 24"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-.5A2.5 2.5 0 0 1 5 12.5z"/><path d="M10 9a2 2 0 1 1 3.3 1.5c-.8.6-1.3 1-1.3 2"/><path d="M12 15h.01"/></svg>',
    approvalAgent: '<svg viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.2c0 4.1-2.5 7.6-7 9.3-4.5-1.7-7-5.2-7-9.3V6z"/><path d="m8.8 11.8 2.1 2.1 4.5-4.6"/></svg>',
    approvalFull: '<svg viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.2c0 4.1-2.5 7.6-7 9.3-4.5-1.7-7-5.2-7-9.3V6z"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>',
  }
  return `<span class="icon icon-${name}">${icons[name] || icons.grid}</span>`
}

function approvalPolicyIcon(policy: ApprovalPolicy): string {
  const icons: Record<ApprovalPolicy, string> = {
    ask: icon('approvalAsk'),
    agent: icon('approvalAgent'),
    full: icon('approvalFull'),
  }
  return icons[policy]
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

export function mountWorkbench(app: HTMLDivElement): void {
  const platform = navigator.platform || navigator.userAgent
  document.documentElement.classList.toggle('platform-macos', /Mac/i.test(platform))
  app.innerHTML = `
    <div class="background-media-layer" aria-hidden="true">
      <img class="background-media-visual background-media-image" alt="" hidden>
      <video class="background-media-visual background-media-video" autoplay loop muted playsinline hidden></video>
      <div class="background-media-veil"></div>
    </div>
    <div class="desktop-shell">
      <div class="window-sidebar-control">
        <button class="icon-button window-sidebar-toggle" id="sidebar-toggle" type="button" title="折叠侧栏" aria-label="折叠侧栏" aria-pressed="false">${icon('sidebarCollapse')}</button>
      </div>
      <aside class="sidebar">
        <div class="sidebar-titlebar-drag-region" aria-hidden="true"></div>
        <button class="new-task" id="new-task">${icon('newConversation')}<span>新建任务</span></button>

        <nav class="sidebar-nav" aria-label="工作区导航">
          <button class="sidebar-nav-item automation-entry" data-view="automations">${icon('parallel')}<span>自动化</span></button>
          <button class="sidebar-nav-item work-packs-entry" data-view="skills">${icon('pluginNav')}<span>插件</span></button>
        </nav>

        <div class="sidebar-section sidebar-history">
          <div class="workspace-task-header">
            <span>工作区</span>
            <span class="workspace-task-actions">
              <button class="tiny-button" id="workspace-task-add" title="添加工作区" aria-label="添加工作区">${icon('plus')}</button>
            </span>
          </div>
          <div id="conversation-list"></div>
        </div>

        <div class="sidebar-footer">
          <button class="sidebar-profile-identity" id="profile-center-button" type="button" title="切换用户资料" aria-label="切换用户资料" aria-haspopup="menu" aria-expanded="false">
            <span class="sidebar-profile-avatar" id="sidebar-profile-avatar" aria-hidden="true">资</span>
            <span class="sidebar-profile-copy"><strong id="sidebar-profile-name">用户资料</strong><small id="sidebar-profile-state">正在读取…</small></span>
            <span class="sidebar-profile-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m7 14 5-5 5 5"/></svg></span>
          </button>
          <div class="sidebar-utilities">
            <button class="sidebar-nav-item sidebar-settings" id="settings-button" title="设置">${icon('settings')}<span>设置</span></button>
          </div>
        </div>
      </aside>

      <div class="workbench-surface">
        <main class="main-panel" id="main-panel">
        <header class="topbar">
          <div class="breadcrumb" id="breadcrumb"><strong id="breadcrumb-title">工作台</strong></div>
          <section class="task-companion" id="task-companion" aria-live="polite" aria-hidden="true"></section>
          <button class="icon-button conversation-plugins-toggle" id="conversation-plugins-toggle" title="本对话插件" aria-label="本对话插件" aria-haspopup="menu" aria-expanded="false">${icon('pluginNav')}<b id="conversation-plugins-count" aria-hidden="true"></b></button>
          <div class="conversation-plugins-menu" id="conversation-plugins-menu" role="menu" aria-hidden="true"></div>
        </header>

        <section class="work-plan-dock" id="work-plan-dock" aria-live="polite" hidden></section>

        <div class="main-scroll" id="main-scroll">
          <section class="recovery-banner" id="recovery-banner"></section>
          <section class="welcome-block" id="welcome-block">
            <h1 class="workbench-prompt-title" aria-label="TurboFlux 工作与开发"><span class="workbench-title-brand">TurboFlux</span><span class="workbench-title-product is-work" id="workbench-title-product" aria-hidden="true"><span id="workbench-title-text"></span><span class="workbench-title-caret" id="workbench-title-caret"></span></span></h1>
          </section>
          <nav class="conversation-navigator" id="conversation-navigator" aria-label="对话导航" aria-hidden="true">
            <div class="conversation-navigator-markers" id="conversation-navigator-markers"></div>
            <div class="conversation-navigator-popover" id="conversation-navigator-popover" aria-hidden="true">
              <strong id="conversation-navigator-popover-title"></strong>
              <small id="conversation-navigator-popover-summary"></small>
            </div>
          </nav>
          <section class="transcript" id="transcript" aria-live="polite"></section>

          <div class="composer-stack">
            <section class="composer-card" id="composer-card">
              <div class="draft-tray" id="draft-tray"></div>
              <div class="composer-capability-tray" id="composer-capability-tray"></div>
              <textarea id="task-input" placeholder="交代一项工作，或粘贴需要处理的内容" rows="1"></textarea>
              <div class="composer-bottom">
                <div class="composer-tools"><button class="composer-add-button" id="composer-add" title="添加文件" aria-haspopup="menu" aria-expanded="false">${icon('plus')}</button><button class="composer-slant-tab capability-tab" id="capability-tab" title="选择插件" aria-haspopup="menu" aria-expanded="false">${icon('pluginNav')}<span id="capability-name">插件</span><b id="capability-count" aria-hidden="true"></b>${icon('chevronDown')}</button><button class="approval-pill" id="approval-pill" aria-haspopup="menu" aria-expanded="false"><span class="approval-policy-icon" id="approval-icon" aria-hidden="true">${approvalPolicyIcon('ask')}</span><span id="approval-name">审批策略</span>${icon('chevronDown')}</button></div>
                <div class="composer-submit"><button class="composer-context" id="composer-context" type="button" aria-label="查看上下文使用情况"><span class="composer-context-ring" aria-hidden="true"></span></button><button class="composer-slant-tab reasoning-tab" id="reasoning-tab" title="选择推理强度" aria-haspopup="menu" aria-expanded="false"><span>推理</span><strong id="reasoning-name">加载中</strong>${icon('chevronDown')}</button><button class="model-pill" id="model-pill" aria-haspopup="menu" aria-expanded="false"><span class="model-pill-icon" id="model-icon" aria-hidden="true"></span><span id="model-name">加载中</span>${icon('chevronDown')}</button><button class="run-button" id="run-button" type="button" data-action="send" title="输入内容后发送" aria-label="输入内容后发送" disabled>${icon('sendUp')}</button></div>
              </div>
            </section>
            <div class="composer-start-context" id="composer-start-context" aria-hidden="false">
              <span class="composer-start-runtime">${icon('computer')}<span>本机执行</span></span>
              <button class="composer-start-workspace" id="composer-start-workspace" title="选择工作区">${icon('folder')}<span id="composer-start-workspace-name">选择工作区</span><small id="composer-start-workspace-action">选择</small>${icon('chevronDown')}</button>
            </div>
            <div class="composer-menu" id="composer-menu" aria-hidden="true"></div>
            <div class="capability-menu" id="capability-menu" aria-hidden="true"></div>
            <div class="approval-menu" id="approval-menu" aria-hidden="true"></div>
          </div>

        </div>

        <section class="product-view" id="product-view" aria-hidden="true"></section>

        <section class="terminal-panel" id="terminal-panel" aria-label="终端" aria-hidden="true"></section>

        </main>

        <button class="icon-button terminal-toggle" id="terminal-toggle" title="打开终端" aria-label="打开终端" aria-controls="terminal-panel" aria-pressed="false">${icon('terminal')}</button>
        <button class="icon-button work-drawer-toggle" id="inspector-toggle" title="打开工作抽屉" aria-label="打开工作抽屉" aria-pressed="false">${icon('panel')}</button>
        <button class="inspector-scrim" id="inspector-scrim" aria-label="关闭侧栏"></button>
        <aside class="inspector" id="inspector-panel" aria-hidden="true">
          <span class="inspector-edge-shadow" aria-hidden="true"></span>
          <div class="inspector-resize-handle" id="inspector-resize-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整右侧面板宽度" aria-describedby="inspector-resize-help" aria-keyshortcuts="ArrowLeft ArrowRight Home End" title="拖动调整宽度；方向键可微调，Home/End 跳到边界，双击恢复默认宽度"></div>
          <span class="visually-hidden" id="inspector-resize-help">拖动调整宽度。方向键每次调整 10 像素，Home/End 移到最小或最大宽度，双击恢复默认宽度。</span>
          <div class="inspector-viewport">
            <div class="inspector-frame">
              <div class="inspector-header">
                <nav class="inspector-nav" aria-label="工作抽屉">
                  <div class="inspector-tabs" id="inspector-tabs" role="tablist"></div>
                  <span class="browser-activity-pill compact inspector-browser-activity" id="inspector-browser-activity" hidden>${icon('spark')}<span>浏览器运行中</span></span>
                  <button class="inspector-header-action" id="inspector-browser-new-tab" type="button" title="新建浏览器标签页" aria-label="新建浏览器标签页" hidden>${icon('plus')}</button>
                  <button class="inspector-header-action" id="inspector-module-menu-toggle" type="button" title="打开其他面板" aria-label="打开其他面板" aria-haspopup="menu" aria-expanded="false">${icon('plus')}</button>
                  <button class="inspector-header-action" id="inspector-expand" type="button" title="展开面板" aria-label="展开面板" aria-pressed="false">${icon('expand')}</button>
                </nav>
                <div class="inspector-module-menu" id="inspector-module-menu" role="menu" aria-hidden="true">${[...INSPECTOR_PRIMARY_NAVIGATION, ...INSPECTOR_UTILITY_NAVIGATION].map(item => `<button class="inspector-module-option" type="button" role="menuitemradio" aria-checked="false" data-tab="${item.tab}">${icon(item.iconName)}<span>${item.label}</span><span class="inspector-module-check" aria-hidden="true">${icon('check')}</span></button>`).join('')}</div>
              </div>
              <div class="inspector-content" id="inspector-content"></div>
              <span class="visually-hidden" id="runtime-policy">正在准备</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
    <div class="toast" id="toast" role="status"></div>
  `

  const bridge = window.turbofluxDesktop
  const shell = app.querySelector<HTMLDivElement>('.desktop-shell')!
  const sidebarToggle = app.querySelector<HTMLButtonElement>('#sidebar-toggle')!
  const workbenchSurface = app.querySelector<HTMLDivElement>('.workbench-surface')!
  const breadcrumb = app.querySelector<HTMLElement>('#breadcrumb')!
  const breadcrumbTitle = app.querySelector<HTMLElement>('#breadcrumb-title')!
  const conversationPluginsToggle = app.querySelector<HTMLButtonElement>('#conversation-plugins-toggle')!
  const conversationPluginsMenu = app.querySelector<HTMLElement>('#conversation-plugins-menu')!
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
  const toast = app.querySelector<HTMLDivElement>('#toast')!
  const runButton = app.querySelector<HTMLButtonElement>('#run-button')!
  const recoveryBanner = app.querySelector<HTMLElement>('#recovery-banner')!
  const draftTray = app.querySelector<HTMLElement>('#draft-tray')!
  const capabilityTray = app.querySelector<HTMLElement>('#composer-capability-tray')!
  const composerCard = app.querySelector<HTMLElement>('#composer-card')!
  const composerAddButton = app.querySelector<HTMLButtonElement>('#composer-add')!
  const capabilityTab = app.querySelector<HTMLButtonElement>('#capability-tab')!
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
  const taskCompanion = app.querySelector<HTMLElement>('#task-companion')!
  const productTitle = app.querySelector<HTMLElement>('#workbench-title-product')!
  const productTitleText = app.querySelector<HTMLElement>('#workbench-title-text')!
  const productTitleCaret = app.querySelector<HTMLElement>('#workbench-title-caret')!
  const sidebarCollapsedStorageKey = 'turboflux.sidebar.collapsed:v1'
  const composerActionGuard = new SingleFlightGuard()
  const draftRecordQueue = new SerializedAsyncQueue()
  const conversationNavigationGuard = new SingleFlightGuard()
  let currentSnapshot: WorkbenchSnapshot | null = null
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
  let canonicalTaskFlowFrame: number | null = null
  let canonicalTaskFlowForce = false
  let submissionPending = false
  let submissionPauseRequested = false
  let requestStatusTerminalFence: RequestStatusTerminalFence | null = null
  let requestStatusAttemptTurnId = ''
  let activeTaskStartedAt = 0
  let projectedWorkRunId = ''
  let taskFlowProjection: TaskFlowProjectionState | null = null
  const liveTurnCache = new Map<string, AgentTurn>()
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
    resolveTool: node => {
      const turns = [...(currentSnapshot?.conversation.turns || []), ...liveTurnCache.values()]
      const call = turns
        .flatMap(turn => turn.toolCalls || [])
        .find(candidate => candidate.id === node.callId)
        || liveToolCalls.get(node.callId || '')
        || {
          id: node.callId || node.id.replace(/^tool:/, ''),
          name: node.toolName || node.content || 'tool',
          arguments: typeof node.detail === 'string' && node.detail.trim().startsWith('{')
            ? (() => { try { return JSON.parse(node.detail) as Record<string, unknown> } catch { return {} } })()
            : {},
        }
      const result = collectToolResults(turns).get(call.id) || liveToolResults.get(call.id)
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
    nodeVersion: node => {
      if ((node.kind === 'input' || node.kind === 'answer') && node.turnId) {
        const turn = liveTurnCache.get(node.turnId)
        if (!turn) return ''
        return [
          turn.timestamp,
          turn.content.length,
          turn.metadata?.attachments?.length || 0,
          turn.metadata?.capabilities?.items.length || 0,
          turn.metadata?.duration || 0,
        ].join(':')
      }
      if (node.kind !== 'tool' || !node.callId) return ''
      const call = liveToolCalls.get(node.callId)
      const result = collectToolResults([
        ...(currentSnapshot?.conversation.turns || []),
        ...liveTurnCache.values(),
      ]).get(node.callId) || liveToolResults.get(node.callId)
      return [
        call ? JSON.stringify(call.arguments).length : 0,
        result ? result.isError ? 1 : 0 : '',
        result?.output.length || 0,
        result?.attachments?.length || 0,
      ].join(':')
    },
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
  const liveToolCalls = new Map<string, ToolCall>()
  const liveToolResults = new Map<string, ToolResult>()
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
  let renderedTaskCompanionSignature = ''
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
  window.requestAnimationFrame(() => shell.classList.remove('sidebar-state-initializing'))

  function startProductTitleTypewriter() {
    let variantIndex = 0
    let visibleText = ''
    let phase: ProductTitlePhase = 'typing'

    const render = () => {
      const variant = productTitleVariants[variantIndex]
      productTitleText.textContent = visibleText
      productTitle.classList.toggle('is-work', variant.className === 'is-work')
      productTitle.classList.toggle('is-code', variant.className === 'is-code')
      productTitleCaret.classList.toggle('is-holding', phase === 'holding')
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      visibleText = productTitleVariants[variantIndex].word
      phase = 'holding'
      render()
      return
    }

    const schedule = () => {
      const variant = productTitleVariants[variantIndex]
      let delay = PRODUCT_TITLE_TYPE_DELAY
      if (phase === 'holding') delay = PRODUCT_TITLE_HOLD_DELAY
      if (phase === 'deleting') delay = PRODUCT_TITLE_DELETE_DELAY
      if (phase === 'switching') delay = PRODUCT_TITLE_SWITCH_DELAY

      window.setTimeout(() => {
        if (phase === 'typing') {
          visibleText = variant.word.slice(0, visibleText.length + 1)
          if (visibleText === variant.word) phase = 'holding'
        } else if (phase === 'holding') {
          phase = 'deleting'
        } else if (phase === 'deleting') {
          visibleText = visibleText.slice(0, -1)
          if (!visibleText) phase = 'switching'
        } else {
          variantIndex = (variantIndex + 1) % productTitleVariants.length
          phase = 'typing'
        }
        render()
        schedule()
      }, delay)
    }

    render()
    schedule()
  }

  startProductTitleTypewriter()

  function inspectorWidthModeForTab(tab: InspectorTab): InspectorWidthMode {
    return inspectorUserFullWidth || (tab === 'browser' && browserLayoutMode === 'landscape')
      ? 'full'
      : 'regular'
  }

  function currentInspectorWidthMode(): InspectorWidthMode {
    return inspectorWidthModeForTab(currentInspectorTab)
  }

  function inspectorMainContentWidth(): number {
    return workbenchSurface.getBoundingClientRect().width
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
    inspectorResizeHandle.setAttribute('aria-valuemin', String(INSPECTOR_MINIMUM_WIDTH))
    inspectorResizeHandle.setAttribute('aria-valuemax', String(Math.round(maximumInspectorWidth(mode))))
    inspectorResizeHandle.setAttribute('aria-valuenow', String(width))
    inspectorResizeHandle.setAttribute('aria-valuetext', `${width} 像素`)
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
    toast.textContent = message
    toast.classList.add('visible')
    window.setTimeout(() => toast.classList.remove('visible'), 2400)
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
    requestAnimationFrame(() => inspectorTabs.querySelector<HTMLButtonElement>('.inspector-tab-slot.active .inspector-tab')?.focus())
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
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
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
        requestAnimationFrame(() => inspectorTabs.querySelector<HTMLButtonElement>(`.inspector-tab-slot[data-tab-id="${CSS.escape(nextTab.id)}"] .inspector-tab`)?.focus())
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
    requestAnimationFrame(() => inspectorTabs.querySelector<HTMLElement>('.inspector-tab-slot.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }))

    const browserTabActive = activePanelTab?.kind === 'browser'
    inspectorBrowserNewTab.hidden = !browserTabActive
    if (browserSnapshot) updateBrowserActivity(inspectorBrowserActivity, browserSnapshot)
    else inspectorBrowserActivity.hidden = true
    const fullWidth = currentInspectorWidthMode() === 'full'
    inspectorExpand.classList.toggle('active', fullWidth)
    inspectorExpand.setAttribute('aria-pressed', String(fullWidth))
    inspectorExpand.title = fullWidth ? '恢复面板宽度' : '展开面板'
    inspectorExpand.setAttribute('aria-label', inspectorExpand.title)
    inspectorExpand.innerHTML = icon(fullWidth ? 'contract' : 'expand')
    inspectorModuleMenu.querySelectorAll<HTMLButtonElement>('.inspector-module-option').forEach(option => {
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
    if (browserBoundsFrame !== null) cancelAnimationFrame(browserBoundsFrame)
    browserBoundsFrame = requestAnimationFrame(() => {
      browserBoundsFrame = null
      const surface = currentInspectorTab === 'browser' && shell.classList.contains('inspector-open')
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
    renderTaskCompanion()
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

  function taskCompanionPreview(snapshot: WorkbenchSnapshot): { title: string; detail: string; url: string } | undefined {
    const service = snapshot.activity.runtimeTasks
      .map(task => ({ task, view: describeRuntimeTask(task) }))
      .filter(item => item.view?.category === 'service' && item.view.active && item.view.previewUrl)
      .sort((left, right) => right.task.updatedAt - left.task.updatedAt)[0]
    if (service?.view?.previewUrl) return { title: '本地预览', detail: service.view.title, url: service.view.previewUrl }
    return undefined
  }

  function browserSiteLabel(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '') || url
    } catch {
      return url
    }
  }

  function browserResearchTabs() {
    return (browserSnapshot?.tabs || []).filter(tab => tab.url && tab.url !== 'about:blank')
  }

  function taskCompanionBrowser(): { title: string; detail: string; tabId: string } | undefined {
    const tabs = browserResearchTabs()
    if (tabs.length === 0) return undefined
    const active = tabs.find(tab => tab.id === browserSnapshot?.activeTabId) || tabs.at(-1)!
    const site = browserSiteLabel(active.url)
    const title = browserSnapshot?.activity ? browserActivityText(browserSnapshot) : '浏览现场'
    const detail = active.loading
      ? `${site} · 正在加载`
      : tabs.length > 1
        ? `${active.title || site} · ${tabs.length} 个页面`
        : active.title || site
    return { title, detail, tabId: active.id }
  }

  function renderTaskCompanion() {
    const snapshot = currentSnapshot
    const active = Boolean(snapshot && currentMainView === 'workbench' && ['running', 'paused', 'awaiting-action'].includes(snapshot.runtime.status))
    const preview = snapshot ? taskCompanionPreview(snapshot) : undefined
    const browser = taskCompanionBrowser()
    const startedAt = snapshot?.runtime.runState.startedAt || activeTaskStartedAt
    const subagents = (snapshot?.activity.subagents || []).filter(agent => !startedAt || agent.startedAt >= startedAt - 1_000)
    const computer = computerControls?.getCompanionState()
    const execution = snapshot?.activity.execution
    const currentRun = execution?.currentRunId
      ? execution.runs.find(run => run.id === execution.currentRunId && run.presentation === 'work')
      : undefined
    const work = currentRun?.presentation === 'work' ? presentWorkRun(currentRun) : undefined
    const presentation = presentTaskCompanion({
      active,
      work: work && !work.terminal ? {
        title: work.title,
        detail: work.detail,
        attention: work.attention,
      } : undefined,
      preview: preview ? { title: preview.title, detail: preview.detail } : undefined,
      browser: browser ? { title: browser.title, detail: browser.detail, attention: Boolean(browserSnapshot?.lastError) } : undefined,
      subagents: subagents.length > 0 ? {
        total: subagents.length,
        running: subagents.filter(agent => ['starting', 'running'].includes(agent.status)).length,
        completed: subagents.filter(agent => agent.status === 'completed').length,
      } : undefined,
      computer: computer ? { title: computer.title, detail: computer.detail, attention: computer.attention } : undefined,
    })
    const running = Boolean(submissionPending || snapshot?.runtime.status === 'running')
    const signature = JSON.stringify({ presentation, running, previewUrl: preview?.url || '', browserTabId: browser?.tabId || '' })
    if (signature === renderedTaskCompanionSignature) return
    renderedTaskCompanionSignature = signature
    taskCompanion.replaceChildren()
    taskCompanion.classList.toggle('visible', presentation.visible)
    taskCompanion.classList.toggle('running', presentation.visible && running)
    taskCompanion.setAttribute('aria-hidden', String(!presentation.visible))
    if (!presentation.visible) return

    const icons: Record<TaskCompanionItemKind, string> = {
      work: 'activity', preview: 'preview', browser: 'browser', subagents: 'parallel', computer: 'computer',
    }
    for (const item of presentation.items) {
      const button = document.createElement('button')
      button.className = `task-companion-item kind-${item.kind}${item.attention ? ' attention' : ''}`
      button.innerHTML = `${icon(icons[item.kind])}<span><strong></strong><small></small></span>`
      button.querySelector('strong')!.textContent = item.title
      button.querySelector('small')!.textContent = item.detail
      button.title = `${item.title} · ${item.detail}`
      button.addEventListener('click', () => {
        if (item.kind === 'work') openInspector('activity')
        else if (item.kind === 'preview' && preview?.url) void openBrowserInInspector(preview.url)
        else if (item.kind === 'browser' && browser?.tabId) void openBrowserTabInInspector(browser.tabId)
        else if (item.kind === 'subagents' || item.kind === 'computer') openInspector('activity')
      })
      taskCompanion.append(button)
    }
  }

  const computerControls = bridge ? createComputerControls(app, bridge, {
    showToast,
    onActivityChange: () => {
      renderTaskCompanion()
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
    onOpenConversation: conversationId => switchConversation(conversationId),
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

  const profileSwitcher = bridge ? createProfileSwitcher(app, bridge, {
    showToast,
    onSnapshot: snapshot => applySnapshot(snapshot),
    async onProfileSwitched() {
      await refreshSidebarProfileIdentity()
    },
    openLibrary: () => settingsCenter?.openProfiles('library'),
    openCreate: () => settingsCenter?.openProfiles('create'),
    openImport: () => settingsCenter?.openProfiles('import'),
  }) : null

  async function refreshSidebarProfileIdentity(): Promise<void> {
    if (!bridge) return
    try {
      const profiles = await bridge.listLocalProfiles()
      const active = profiles.profiles.find(profile => profile.id === profiles.activeProfileId || profile.active)
      if (!active) return
      const name = app.querySelector<HTMLElement>('#sidebar-profile-name')
      const state = app.querySelector<HTMLElement>('#sidebar-profile-state')
      const avatar = app.querySelector<HTMLElement>('#sidebar-profile-avatar')
      if (name) name.textContent = active.displayName
      if (avatar) {
        avatar.textContent = active.displayName.trim().slice(0, 1).toLocaleUpperCase() || '用'
        avatar.style.setProperty('--profile-color', profileColor(active))
      }
      if (state) state.textContent = active.unboundWorkspaceCount > 0 ? `${active.unboundWorkspaceCount} 个工作区待定位` : `本机用户 · ${active.conversationCount} 个会话`
    } catch {
      const state = app.querySelector<HTMLElement>('#sidebar-profile-state')
      if (state) state.textContent = '点击切换用户资料'
    }
  }
  void refreshSidebarProfileIdentity()

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
        window.setTimeout(() => {
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
      window.requestAnimationFrame(() => {
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
    window.setTimeout(() => {
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
    window.requestAnimationFrame(() => overlay.classList.add('visible'))
    const firstControl = surface.querySelector<HTMLElement>('.workflow-surface-choice, .workflow-surface-select, input, .workflow-surface-close')
    firstControl?.focus()
    scrollTranscript()
  }

  function setConversationMode(active: boolean) {
    mainScroll.classList.toggle('conversation-mode', active)
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
    if (conversationTransitionSettleTimer !== null) window.clearTimeout(conversationTransitionSettleTimer)
    if (conversationTransitionFrame !== null) window.cancelAnimationFrame(conversationTransitionFrame)
    conversationTransitionSettleTimer = null
    conversationTransitionFrame = null
    closeComposerMenus()
    shell.classList.add('conversation-transitioning')
    shell.classList.toggle('conversation-transition-new', kind === 'new')
    mainScroll.classList.remove('conversation-transition-entering', 'conversation-transition-recovering')
    mainScroll.setAttribute('aria-busy', 'true')
    refreshConversationTransitionTargets()
    conversationTransitionFrame = window.requestAnimationFrame(() => {
      conversationTransitionFrame = null
      if (activeConversationTransitionId === transitionId) mainScroll.classList.add('conversation-transition-leaving')
    })
    return transitionId
  }

  function finishConversationTransition(transitionId: number, succeeded: boolean) {
    if (activeConversationTransitionId !== transitionId) return
    activeConversationTransitionId = 0
    if (conversationTransitionFrame !== null) window.cancelAnimationFrame(conversationTransitionFrame)
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
    conversationTransitionSettleTimer = window.setTimeout(() => {
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
    if (transcriptScrollFrame !== null) window.cancelAnimationFrame(transcriptScrollFrame)
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
    window.requestAnimationFrame(() => target.classList.add('conversation-navigator-target'))
    window.setTimeout(() => target.classList.remove('conversation-navigator-target'), reduceMotion ? 80 : 1_400)
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
      window.setTimeout(() => { conversationNavigatorSuppressClick = false }, 0)
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
    conversationNavigatorSyncFrame = window.requestAnimationFrame(syncConversationNavigator)
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
    window.requestAnimationFrame(() => {
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
        window.requestAnimationFrame(() => {
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
    transcriptScrollFrame = window.requestAnimationFrame(() => {
      transcriptScrollFrame = null
      if (!transcriptFollowState.following) return
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'auto' })
      transcriptFollowState = updateTranscriptFollowFromScroll(transcriptFollowState, transcript)
      window.requestAnimationFrame(() => {
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
    window.requestAnimationFrame(() => {
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
    liveToolCalls.clear()
    liveToolResults.clear()
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
        beginRequestStatusAttempt(turn.id)
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
    if (canonicalTaskFlowFrame !== null) window.cancelAnimationFrame(canonicalTaskFlowFrame)
    canonicalTaskFlowFrame = null
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
    if (canonicalTaskFlowFrame !== null) window.cancelAnimationFrame(canonicalTaskFlowFrame)
    canonicalTaskFlowFrame = null
    canonicalTaskFlowForce = false
  }

  function scheduleCanonicalTaskFlowRender(force = false) {
    canonicalTaskFlowForce ||= force
    if (canonicalTaskFlowFrame !== null) return
    canonicalTaskFlowFrame = window.requestAnimationFrame(() => {
      canonicalTaskFlowFrame = null
      const shouldForce = canonicalTaskFlowForce
      canonicalTaskFlowForce = false
      renderCanonicalTaskFlow(shouldForce)
    })
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
        beginRequestStatusAttempt(failure.turnId)
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
    liveToolCalls.clear()
    liveToolResults.clear()
    liveTurnCache.clear()
    for (const turn of turns) liveTurnCache.set(turn.id, turn)
    if (currentSnapshot) taskFlowProjection = projectTaskFlowSnapshot(currentSnapshot)
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
    if (!animate) requestAnimationFrame(() => transcript.classList.remove('restoring'))
  }
  function beginRequestStatusAttempt(turnId = requestStatusAttemptTurnId) {
    transcript.querySelector('.conversation-failure')?.remove()
    requestStatusTerminalFence = null
    requestStatusAttemptTurnId = turnId
  }

  function markRequestStatusTerminal() {
    const conversationId = currentSnapshot?.conversation.id
    if (conversationId) {
      requestStatusTerminalFence = {
        conversationId,
        latestUserTurnId: requestStatusAttemptTurnId || historyRewriteOptimisticTurn?.id || latestUserTurnId(currentSnapshot?.conversation.turns || []),
      }
    }
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
      row.addEventListener('contextmenu', event => {
        event.preventDefault()
        event.stopPropagation()
        document.querySelectorAll('.conversation-menu').forEach(menu => menu.remove())
        const menu = document.createElement('div')
        menu.className = 'conversation-menu'
        menu.style.left = `${event.clientX}px`
        menu.style.top = `${event.clientY}px`
        const rename = document.createElement('button')
        rename.textContent = '重命名'
        rename.addEventListener('click', async () => {
          menu.remove()
          const next = await openWorkbenchDialog({
            title: '重命名任务',
            message: '为这段工作选择一个更容易识别的名字。',
            confirmLabel: '保存',
            inputValue: displayTitle,
          })
          if (typeof next !== 'string' || !next) return
          try {
            if (!await bridge?.renameConversation(conversation.id, next)) throw new Error('无法重命名任务')
            if (bridge) applySnapshot(await bridge.getSnapshot(), false)
          } catch (error) {
            showToast(errorMessage(error))
          }
        })
        const remove = document.createElement('button')
        remove.className = 'danger'
        remove.innerHTML = `${icon('trash')} 删除`
        remove.addEventListener('click', async () => {
          menu.remove()
          const confirmed = await openWorkbenchDialog({
            title: '删除任务？',
            message: '会删除这段会话的本地记录，此操作无法撤销。',
            confirmLabel: '删除',
            danger: true,
          })
          if (confirmed !== true) return
          try {
            if (!await bridge?.deleteConversation(conversation.id)) throw new Error('无法删除任务')
            if (bridge) applySnapshot(await bridge.getSnapshot())
          } catch (error) {
            showToast(errorMessage(error))
          }
        })
        menu.append(rename, remove)
        document.body.append(menu)
        const bounds = menu.getBoundingClientRect()
        menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`
        menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`
      })
      row.append(button)
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
        create.className = 'workspace-task-group-create'
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

        const more = document.createElement('button')
        more.className = 'workspace-task-group-more'
        more.type = 'button'
        more.title = `${group.name} 更多操作`
        more.setAttribute('aria-label', `${group.name} 更多操作`)
        more.setAttribute('aria-haspopup', 'menu')
        more.innerHTML = icon('more')
        let openMenu: HTMLElement | null = null
        more.addEventListener('click', event => {
          event.stopPropagation()
          const wasOpen = openMenu?.isConnected === true
          document.querySelectorAll('.conversation-menu').forEach(menu => menu.remove())
          openMenu = null
          if (wasOpen) return
          const menu = document.createElement('div')
          menu.className = 'conversation-menu'
          const addTask = document.createElement('button')
          addTask.innerHTML = `${icon('plus')} 新建任务`
          addTask.addEventListener('click', () => {
            menu.remove()
            create.click()
          })
          menu.append(addTask)
          if (group.path) {
            const copyPath = document.createElement('button')
            copyPath.innerHTML = `${icon('copy')} 复制工作区路径`
            copyPath.addEventListener('click', () => {
              menu.remove()
              void copyMessageText(group.path!)
            })
            menu.append(copyPath)
          }
          const anchor = more.getBoundingClientRect()
          menu.style.left = `${anchor.right}px`
          menu.style.top = `${anchor.bottom + 4}px`
          document.body.append(menu)
          const bounds = menu.getBoundingClientRect()
          menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`
          menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`
          openMenu = menu
        })

        header.append(more, create)
      }
      section.append(header)

      const taskHost = document.createElement('div')
      taskHost.className = 'workspace-task-group-conversations'
      const taskHostInner = document.createElement('div')
      taskHostInner.className = 'workspace-task-group-conversations-inner'
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
    productView.classList.toggle('visible', view !== 'workbench')
    productView.setAttribute('aria-hidden', String(view === 'workbench'))
    renderBreadcrumb()
    if (view === 'workbench') productView.replaceChildren()
    else renderProductView()
    renderTaskCompanion()
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
    if (draftTimer !== null) window.clearTimeout(draftTimer)
    draftTimer = window.setTimeout(() => {
      draftTimer = null
      const draft = currentDraft()
      if (bridge) void draftRecordQueue.enqueue(() => bridge.recordDraft(draft)).catch(() => undefined)
    }, 350)
  }

  async function persistDraftNow(): Promise<void> {
    if (draftTimer !== null) {
      window.clearTimeout(draftTimer)
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
    capabilityTab.classList.toggle('active', draftCapabilities.length > 0)
    const preferredCapability = draftCapabilities.find(capability => capability.type === 'mcp' && capability.id === 'computer')
      || draftCapabilities[0]
    const capabilityLabel = app.querySelector<HTMLElement>('#capability-name')!
    capabilityLabel.textContent = preferredCapability ? capabilityDisplayName(preferredCapability) : '插件'
    const capabilityNames = draftCapabilities.map(capabilityDisplayName).join('、')
    const capabilityTitle = draftCapabilities.length > 0
      ? `${capabilityNames} · 已挂载到本对话，点击管理`
      : '选择要挂载到本对话的插件；未挂载的能力不会被移除'
    capabilityTab.title = capabilityTitle
    capabilityTab.setAttribute('aria-label', capabilityTitle)
    const capabilityCount = app.querySelector<HTMLElement>('#capability-count')!
    capabilityCount.textContent = draftCapabilities.length > 1 ? String(draftCapabilities.length) : ''
    capabilityCount.classList.toggle('visible', draftCapabilities.length > 1)
    const mountedCount = app.querySelector<HTMLElement>('#conversation-plugins-count')!
    mountedCount.textContent = draftCapabilities.length ? String(draftCapabilities.length) : ''
    mountedCount.classList.toggle('visible', draftCapabilities.length > 0)
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
        if (conversationPluginsMenu.classList.contains('visible')) renderConversationPluginsMenu()
        await persistDraftNow()
      })
      chip.append(label, remove)
      capabilityTray.append(chip)
    }
  }

  function closeConversationPluginsMenu() {
    conversationPluginsMenu.classList.remove('visible')
    conversationPluginsMenu.setAttribute('aria-hidden', 'true')
    conversationPluginsToggle.setAttribute('aria-expanded', 'false')
  }

  function renderConversationPluginsMenu() {
    conversationPluginsMenu.replaceChildren()
    const heading = document.createElement('header')
    const title = document.createElement('strong')
    title.textContent = '本对话插件'
    const detail = document.createElement('small')
    detail.textContent = draftCapabilities.length ? '已挂载，可随时取消' : '还没有挂载插件'
    heading.append(title, detail)
    conversationPluginsMenu.append(heading)
    if (draftCapabilities.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'conversation-plugins-empty'
      empty.textContent = '从输入框的“插件”菜单挂载能力。'
      conversationPluginsMenu.append(empty)
      return
    }
    const pluginRecords = currentSnapshot?.plugins.plugins || []
    for (const capability of draftCapabilities) {
      const row = document.createElement('div')
      row.className = 'conversation-plugin-row'
      const glyph = document.createElement('span')
      glyph.className = 'conversation-plugin-glyph'
      glyph.innerHTML = capability.type === 'skill' ? icon('spark') : icon('plug')
      const copy = document.createElement('span')
      const label = document.createElement('strong')
      label.textContent = capabilityDisplayName(capability)
      const plugin = pluginRecords.find(candidate => (
        candidate.manifest.contributes?.skills?.some(skill => skill.id === capability.id)
          || candidate.serverName === capability.id
      ))
      const pluginName = document.createElement('small')
      pluginName.textContent = plugin?.manifest.name || (capability.type === 'skill' ? 'Skill' : '工具连接')
      copy.append(label, pluginName)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'conversation-plugin-remove'
      remove.title = `取消挂载 ${capabilityDisplayName(capability)}`
      remove.setAttribute('aria-label', `取消挂载 ${capabilityDisplayName(capability)}`)
      remove.innerHTML = icon('close')
      remove.addEventListener('click', async () => {
        draftCapabilities = draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id))
        renderCapabilityTray()
        renderConversationPluginsMenu()
        await persistDraftNow()
      })
      row.append(glyph, copy, remove)
      conversationPluginsMenu.append(row)
    }
  }

  function toggleConversationPluginsMenu() {
    const opening = !conversationPluginsMenu.classList.contains('visible')
    closeComposerMenus()
    closeConversationPluginsMenu()
    if (!opening) return
    renderConversationPluginsMenu()
    conversationPluginsMenu.classList.add('visible')
    conversationPluginsMenu.setAttribute('aria-hidden', 'false')
    conversationPluginsToggle.setAttribute('aria-expanded', 'true')
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
    const mountedCount = app.querySelector<HTMLElement>('#conversation-plugins-count')!
    mountedCount.textContent = draftCapabilities.length ? String(draftCapabilities.length) : ''
    mountedCount.classList.toggle('visible', draftCapabilities.length > 0)
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
    if (resendingTurnId && snapshot.conversation.id === currentSnapshot?.conversation.id) return
    const snapshotLatestUserTurnId = latestUserTurnId(snapshot.conversation.turns)
    if (shouldIgnoreSnapshotAfterRequestTerminal({
      fence: requestStatusTerminalFence,
      conversationId: snapshot.conversation.id,
      latestUserTurnId: snapshotLatestUserTurnId,
      runtimeStatus: snapshot.runtime.status,
      runPhase: snapshot.runtime.runState.phase,
      activeRunId: snapshot.activity.execution.currentRunId || snapshot.work.projection.activeRunId,
    })) return
    if (requestStatusTerminalFence && !requestStatusTerminalFenceApplies({
      fence: requestStatusTerminalFence,
      conversationId: snapshot.conversation.id,
      latestUserTurnId: snapshotLatestUserTurnId,
    })) {
      requestStatusTerminalFence = null
      requestStatusAttemptTurnId = snapshotLatestUserTurnId || ''
    }
    const conversationChanged = currentSnapshot?.conversation.id !== snapshot.conversation.id
    const firstSnapshot = currentSnapshot === null
    if (conversationChanged) {
      closeWorkflowSurface()
      selectedWorkRunId = null
      projectedWorkRunId = ''
      clearHistoryRewriteViewport()
      resendingTurnId = ''
      requestStatusTerminalFence = null
      requestStatusAttemptTurnId = ''
    }
    currentSnapshot = snapshot
    taskFlowProjection = projectTaskFlowSnapshot(snapshot)
    if (snapshot.activity.execution.runs.some(run => run.responseMode === 'task')) scheduleCanonicalTaskFlowRender()
    const snapshotRunId = snapshot.activity.execution.currentRunId || ''
    if (firstSnapshot || conversationChanged) {
      const latestUserTurn = [...snapshot.conversation.turns].reverse().find(turn => turn.role === 'user' && turn.metadata?.internal !== true)
      projectedWorkRunId = snapshotRunId || latestUserTurn?.metadata?.workRunId || latestUserTurn?.id || ''
    } else if (snapshotRunId) {
      projectedWorkRunId = snapshotRunId
    }
    renderProjectedWorkPlan()
    const hasWorkspace = workspaceSpecified(snapshot)
    app.querySelector('#composer-start-workspace-name')!.textContent = hasWorkspace ? snapshot.workspace.name : '选择工作区'
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
    app.querySelector('#approval-name')!.textContent = approvalLabel
    approvalIcon.innerHTML = approvalPolicyIcon(snapshot.runtime.approvalPolicy)
    app.querySelector('#approval-pill')!.setAttribute('data-policy', snapshot.runtime.approvalPolicy)
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
        renderTurns(snapshot.conversation.turns, conversationChanged && !firstSnapshot)
        renderedConversationSignature = nextConversationSignature
      }
    }
    reconcileConversationFailure(snapshot)
    refreshExecutionVisualEvidence(snapshot)
    if (shell.classList.contains('inspector-open')) renderInspector()
    updateRunButton(snapshot)
    renderTaskCompanion()
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
    snapshotRefreshTimer = window.setTimeout(() => {
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
        liveTurnCache.set(turn.id, turn)
        if (event.type === 'turn.started' && turn.role === 'user') {
          requestStatusAttemptTurnId = turn.id
          reconcileOptimisticUserTurn(turn)
          if (isHistoryRewriteUserTurn({
            resendingTurnId,
            eventType: 'turn.started',
            turnId: turn.id,
            turnRole: turn.role,
          })) {
            beginRequestStatusAttempt(turn.id)
            historyRewriteOptimisticTurn = turn
            resendingTurnId = ''
            reconcileHistoryRewriteUserTurn(turn)
          }
        }
        if (event.type === 'turn.completed') scheduleSnapshotRefresh(32)
        break
      }
      case 'tool.proposed':
        liveToolCalls.set(event.payload.toolCall.id, event.payload.toolCall)
        break
      case 'tool.completed':
        liveToolResults.set(event.payload.toolResult.toolCallId, event.payload.toolResult)
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
        if (currentSnapshot) {
          currentSnapshot.runtime.runState = event.payload.state
          const phase = event.payload.state.phase
          currentSnapshot.runtime.status = phase === 'paused'
            ? 'paused'
            : phase === 'awaiting_approval' || phase === 'awaiting_input'
              ? 'awaiting-action'
              : ['thinking', 'compacting', 'tool_running', 'aborting'].includes(phase)
                ? 'running'
                : phase === 'recoverable_error'
                  ? 'error'
                  : 'ready'
          updateRunButton(currentSnapshot)
        }
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
        markRequestStatusTerminal()
        scheduleSnapshotRefresh(32)
        break
      case 'runtime.event':
        scheduleSnapshotRefresh()
        break
    }
  }

  function handleRuntimeEvent(event: WorkbenchEvent) {
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
      if (!taskFlowProjection || taskFlowProjection.conversationId !== event.conversationId) {
        taskFlowProjection = createTaskFlowProjection(event.conversationId)
      }
      taskFlowProjection = applyTaskFlowEvent(taskFlowProjection, event.event)
      handleConversationEvent(event.event)
      scheduleCanonicalTaskFlowRender()
      return
    }
    if (event.type === 'conversation-run' && event.conversationId === currentSnapshot?.conversation.id) {
      markRequestStatusTerminal()
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
      if (!event.conversationId || event.conversationId === currentSnapshot?.conversation.id) markRequestStatusTerminal()
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
    capabilityTab.setAttribute('aria-expanded', 'false')
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
    const addSection = appendComposerMenuSection('添加')
    addSection.append(
      createComposerMenuRow({
        glyph: icon('paperclip'),
        title: '文件和文件夹',
        detail: '图片、文档或项目资料',
        onClick: () => {
          closeComposerMenus()
          void chooseDraftFiles()
        },
      }),
      createComposerMenuRow({
        glyph: icon('folder'),
        title: currentSnapshot && workspaceSpecified(currentSnapshot) ? currentSnapshot.workspace.name : '选择工作区',
        detail: currentSnapshot && workspaceSpecified(currentSnapshot) ? currentSnapshot.workspace.path : '为这项任务指定一个文件夹',
        selected: currentSnapshot ? workspaceSpecified(currentSnapshot) : false,
        onClick: () => {
          closeComposerMenus()
          void chooseTaskWorkspace()
        },
      }),
    )
  }

  function renderCapabilityMenu() {
    capabilityMenu.replaceChildren()
    capabilityMenu.setAttribute('role', 'menu')
    const pluginSection = appendComposerMenuSection('插件', capabilityMenu)
    const loading = document.createElement('p')
    loading.className = 'composer-menu-empty'
    loading.textContent = '正在读取插件…'
    pluginSection.append(loading)

    if (!bridge) {
      loading.textContent = '插件仅在桌面端可用'
      return
    }

    void Promise.all([bridge.listPlugins(), bridge.getSettings(false)]).then(([registry, settings]) => {
      if (!capabilityMenu.classList.contains('visible')) return
      loading.remove()
      let rowCount = 0
      const projectedCapabilityKeys = new Set<string>()
      const appendCapability = (capability: AgentCapabilityReference, title: string, detail: string, glyph: string, disabled = false) => {
        const selected = draftCapabilities.some(item => item.type === capability.type && item.id === capability.id)
        pluginSection.append(createComposerMenuRow({
          glyph,
          title,
          detail: selected ? '已挂载到本对话，点击取消挂载' : detail,
          selected,
          disabled,
          onClick: () => void (async () => {
            draftCapabilities = selected
              ? draftCapabilities.filter(item => !(item.type === capability.type && item.id === capability.id))
              : capability.type === 'skill'
                ? [capability, ...draftCapabilities.filter(item => item.type !== 'skill')]
                : [...draftCapabilities, capability]
            renderCapabilityTray()
            await persistDraftNow()
            renderCapabilityMenu()
          })(),
        }))
        rowCount += 1
      }

      for (const plugin of registry.plugins) {
        if (!plugin.enabled || plugin.state !== 'enabled') continue
        const skill = plugin.manifest.contributes?.skills?.[0]
        const capability: AgentCapabilityReference | undefined = skill
          ? { type: 'skill', id: skill.id, name: plugin.manifest.name }
          : plugin.serverName
            ? { type: 'mcp', id: plugin.serverName, name: plugin.manifest.name }
            : undefined
        if (!capability) continue
        projectedCapabilityKeys.add(`${capability.type}:${capability.id}`)
        const included = [
          plugin.manifest.contributes?.skills?.length ? `${plugin.manifest.contributes.skills.length} 个技能` : '',
          plugin.manifest.contributes?.tools?.length ? `${plugin.manifest.contributes.tools.length} 个工具` : '',
          plugin.manifest.contributes?.commands?.length ? `${plugin.manifest.contributes.commands.length} 个命令` : '',
        ].filter(Boolean).join(' · ')
        appendCapability(
          capability,
          capabilityDisplayName(capability),
          `插件${included ? ` · ${included}` : ''} · 始终可用`,
          capability.type === 'skill' ? icon('spark') : icon('plug'),
        )
      }

      for (const server of settings.mcpServers) {
        if (projectedCapabilityKeys.has(`mcp:${server.name}`)) continue
        const ready = server.enabled && server.status === 'connected'
        const displayName = server.displayName || server.name
        appendCapability(
          { type: 'mcp', id: server.name, name: displayName },
          displayName,
          ready ? `${server.description || `${server.tools.length} 个可用工具`} · 始终可用` : server.enabled ? '等待连接' : '尚未启用',
          server.name === 'browser' ? icon('globe') : server.name === 'computer' ? icon('computer') : icon('plug'),
          !ready,
        )
      }

      if (rowCount === 0) {
        const empty = document.createElement('p')
        empty.className = 'composer-menu-empty'
        empty.textContent = '还没有可用的插件'
        pluginSection.append(empty)
      }
    }).catch(error => {
      loading.textContent = errorMessage(error)
    })

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

  function toggleCapabilityMenu() {
    const opening = !capabilityMenu.classList.contains('visible')
    closeComposerMenus()
    if (!opening) return
    syncComposerMenuPlacement()
    renderCapabilityMenu()
    capabilityMenu.classList.add('visible')
    capabilityMenu.setAttribute('aria-hidden', 'false')
    capabilityTab.setAttribute('aria-expanded', 'true')
  }

  function approvalDescription(policy: ApprovalPolicy): string {
    if (policy === 'ask') return '执行工具前先征求确认'
    if (policy === 'agent') return '低风险操作自动继续'
    return '允许完整主机能力'
  }

  async function selectApprovalPolicy(policy: ApprovalPolicy) {
    if (!bridge) return
    try {
      const settings = await bridge.getSettings(false)
      const update = createSettingsUpdate(settings)
      update.approvalPolicy = policy
      if (policy === 'full') update.capabilityProfile = 'danger-full-access'
      const result = await bridge.saveSettings(update)
      applySnapshot(result.snapshot, false)
      closeComposerMenus()
      showToast(`审批策略已切换为${({ ask: '每次询问', agent: '低风险自动', full: '全权执行' } as const)[policy]}`)
    } catch (error) {
      showToast(errorMessage(error))
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
    label.textContent = '审批策略'
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
      beginRequestStatusAttempt('')
      const optimisticElement = !active
        ? mountOptimisticUserTurn(
            expandedPrompt,
            submittedAttachments.length > 0 ? submittedAttachments : undefined,
            submittedCapabilities,
          )
        : null
      if (draftTimer !== null) {
        window.clearTimeout(draftTimer)
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
      if (result.status === 'started') requestStatusAttemptTurnId = result.inputId
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
    if (!bridge) return
    try {
      const added = await bridge.addProject()
      if (!added) return
      applySnapshot(await bridge.getSnapshot(), false)
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
  app.querySelector('#capability-tab')?.addEventListener('click', toggleCapabilityMenu)
  conversationPluginsToggle.addEventListener('click', toggleConversationPluginsMenu)
  app.querySelector('#approval-pill')?.addEventListener('click', toggleApprovalMenu)
  app.querySelector('#settings-button')?.addEventListener('click', () => void settingsCenter?.open())
  app.querySelector<HTMLElement>('#profile-center-button')?.addEventListener('click', event => void profileSwitcher?.toggle(event.currentTarget as HTMLElement))
  app.querySelector('#composer-context')?.addEventListener('click', () => openInspector('context'))
  app.querySelector('#model-pill')?.addEventListener('click', event => void settingsCenter?.openModelPicker(event.currentTarget as HTMLElement))
  app.querySelector('#reasoning-tab')?.addEventListener('click', event => void settingsCenter?.openReasoningPicker(event.currentTarget as HTMLElement))
  inspectorToggle.addEventListener('click', () => shell.classList.contains('inspector-open') ? closeInspector() : reopenInspector())
  app.querySelector('#inspector-scrim')?.addEventListener('click', () => closeInspector())
  inspectorExpand.addEventListener('click', () => {
    const restoring = currentInspectorWidthMode() === 'full'
    if (restoring) {
      inspectorUserFullWidth = false
      if (activeInspectorPanelTab()?.kind === 'browser') browserLayoutMode = 'portrait'
    } else {
      inspectorUserFullWidth = true
    }
    applyInspectorWidthForCurrentTab()
    renderInspectorChrome()
  })
  inspectorResizeHandle.addEventListener('pointerdown', event => {
    if (!shell.classList.contains('inspector-open') || currentInspectorWidthMode() === 'full') return
    event.preventDefault()
    const startX = event.clientX
    const startRect = inspectorPanel.getBoundingClientRect()
    const startWidth = startRect.width
    const dismissTriggerX = inspectorDismissTriggerX(startRect.left, startWidth)
    const pointerId = event.pointerId
    let dragging = true
    inspectorResizeHandle.setPointerCapture(event.pointerId)
    shell.classList.add('inspector-resizing')
    const cleanup = () => {
      if (!dragging) return
      dragging = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (inspectorResizeHandle.hasPointerCapture(pointerId)) inspectorResizeHandle.releasePointerCapture(pointerId)
      shell.classList.remove('inspector-resizing')
    }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || !dragging) return
      if (shouldDismissInspectorAtPointer(moveEvent.clientX, dismissTriggerX)) {
        cleanup()
        closeInspector()
        setInspectorWidth(startWidth)
        return
      }
      setInspectorWidth(startWidth + startX - moveEvent.clientX)
    }
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId || !dragging) return
      cleanup()
      if (upEvent.type === 'pointercancel') {
        setInspectorWidth(startWidth)
        return
      }
      setInspectorWidth(inspectorPanel.getBoundingClientRect().width, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  })
  inspectorResizeHandle.addEventListener('dblclick', () => setInspectorWidth(defaultInspectorWidth(), true))
  inspectorResizeHandle.addEventListener('keydown', event => {
    if (!shell.classList.contains('inspector-open')) return
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
  window.addEventListener('resize', () => {
    if (shell.classList.contains('inspector-open')) applyInspectorWidthForCurrentTab()
    syncComposerMenuPlacement()
    settingsCenter?.repositionComposerPicker()
  })
  new ResizeObserver(() => {
    scheduleBrowserBoundsSync()
    if (!shell.classList.contains('inspector-open')) return
    if (inspectorChromeResizeFrame !== null) cancelAnimationFrame(inspectorChromeResizeFrame)
    inspectorChromeResizeFrame = requestAnimationFrame(() => {
      inspectorChromeResizeFrame = null
      renderInspectorChrome()
    })
  }).observe(inspectorPanel)
  taskInput.addEventListener('input', () => {
    resizeTaskInput()
    if (currentSnapshot) updateRunButton(currentSnapshot)
    scheduleDraftRecord()
  })
  taskInput.addEventListener('keydown', event => {
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
    if (transcriptWheelTimer !== null) window.clearTimeout(transcriptWheelTimer)
    transcriptWheelTimer = window.setTimeout(() => {
      transcriptWheelTimer = null
      transcriptWheelScrolling = false
    }, 160)
  }, { passive: true })
  transcript.addEventListener('pointerdown', event => {
    if (event.target === transcript) transcriptPointerScrolling = true
  })
  window.addEventListener('pointerup', () => { transcriptPointerScrolling = false })
  window.addEventListener('pointercancel', () => { transcriptPointerScrolling = false })
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

  window.addEventListener('keydown', event => {
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
    if (event.metaKey && event.key.toLowerCase() === 'l' && browserSnapshot?.visible) {
      event.preventDefault()
      openInspector('browser')
      window.requestAnimationFrame(() => {
        const address = inspectorContent.querySelector<HTMLInputElement>('.inspector-browser-address')
        address?.focus()
        address?.select()
      })
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 't' && browserSnapshot?.visible) {
      event.preventDefault()
      void bridge?.browserNewTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 'w' && activeInspectorPanelTab()?.kind === 'browser') {
      event.preventDefault()
      const panelTab = activeInspectorPanelTab()
      if (panelTab) void closeInspectorPanelTab(panelTab.id)
      return
    }
    if (event.metaKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      void commandPalette?.open()
    }
    if (event.key === 'Escape') {
      if (commandPalette?.isOpen()) commandPalette.close()
      else if (workflowSurface) void resolveRequest(workflowSurfaceRequestId, 'cancelled', workflowSurface)
      else if (conversationPluginsMenu.classList.contains('visible')) closeConversationPluginsMenu()
      else if (composerMenu.classList.contains('visible') || capabilityMenu.classList.contains('visible') || approvalMenu.classList.contains('visible')) closeComposerMenus()
      else if (inspectorModuleMenu.classList.contains('visible')) setInspectorModuleMenu(false)
      else if (terminalPanel?.isOpen()) terminalPanel.close()
      else if (shell.classList.contains('inspector-open')) closeInspector()
    }
  })

  document.addEventListener('click', event => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.conversation-menu')) document.querySelectorAll('.conversation-menu').forEach(menu => menu.remove())
    if (target instanceof Element && !target.closest('#composer-menu, #composer-add, #capability-menu, #capability-tab, #approval-menu, #approval-pill')) closeComposerMenus()
    if (target instanceof Element && !target.closest('#conversation-plugins-menu, #conversation-plugins-toggle')) closeConversationPluginsMenu()
    if (target instanceof Element && !target.closest('#inspector-module-menu, #inspector-module-menu-toggle')) setInspectorModuleMenu(false)
  })

  const primeCompletionSound = () => {
    window.removeEventListener('pointerdown', primeCompletionSound, true)
    window.removeEventListener('keydown', primeCompletionSound, true)
    void primeTaskCompletionChime()
  }
  window.addEventListener('pointerdown', primeCompletionSound, { capture: true, once: true })
  window.addEventListener('keydown', primeCompletionSound, { capture: true, once: true })

  inspectorModuleMenuToggle.addEventListener('click', toggleInspectorModuleMenu)
  inspectorBrowserNewTab.addEventListener('click', () => {
    void bridge?.browserNewTab().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
  })
  inspectorModuleMenu.querySelectorAll<HTMLButtonElement>('.inspector-module-option').forEach(button => {
    button.addEventListener('click', () => {
      setInspectorModuleMenu(false)
      openInspector(button.dataset.tab as InspectorTab)
    })
  })

  if (bridge) {
    bridge.onRuntimeEvent(handleRuntimeEvent)
    bridge.onNavigationIntent(intent => void handleNavigationIntent(intent).catch(error => showToast(errorMessage(error))))
    bridge.onBrowserEvent(handleBrowserEvent)
    void bridge.getSnapshot().then(snapshot => applySnapshot(snapshot)).catch(error => showToast(errorMessage(error)))
    void bridge.browserGetState().then(renderBrowserSnapshot).catch(error => showToast(errorMessage(error)))
  } else {
    showToast('桌面核心桥接不可用')
  }
}
