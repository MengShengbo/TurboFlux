import type {
  WorkbenchCommandDefinition,
  WorkbenchCommandId,
  WorkbenchCommandResult,
  WorkbenchDraftSnapshot,
  WorkbenchFileReference,
  WorkbenchGitActionResult,
  WorkbenchGitDiffResult,
  WorkbenchMemoryCreateInput,
  WorkbenchMemoryFilters,
  WorkbenchMemorySnapshot,
  WorkbenchMemoryUpdateInput,
  WorkbenchWorkPackSnapshot,
  WorkbenchSettingsSnapshot,
  WorkbenchSettingsUpdate,
  WorkbenchWorkStepActionResult,
  WorkbenchSubmitResult,
  ProjectSnapshot,
  AutomationSnapshot,
  AutomationSchedule,
  AutomationRetentionPolicy,
  AutomationUpdateInput,
  AutomationApplicationService,
  AutomationDefinition,
  AutomationDraftInput,
  AutomationApprovalRequest,
  ArtifactSnapshot,
  WorkbenchArtifactPreview,
  PluginSnapshot,
  ConversationPersistenceHealth,
  AgentAttachment,
  AgentCapabilitySelection,
  BrowserBounds,
  BrowserSystemEvent,
  BrowserSystemSnapshot,
  ComputerPermissionKind,
  ComputerPermissionRequestResult,
  ComputerSystemEvent,
  ComputerSystemSnapshot,
  ArchiveComponentId,
  ArchiveOperationRef,
  ArchiveOperationSnapshot,
  PersistedConversation,
  ProfileArchivePreview,
  ProfileExportEstimate,
  ProfileImportPlan,
} from '@turboflux/agent-core/workbench'
import type {
  DesktopWorkbenchConversationResult,
  DesktopWorkbenchEvent,
  DesktopWorkbenchSettingsSaveResult,
  DesktopWorkbenchSnapshot,
} from '../desktopTypes'
import type {
  DesktopTerminalBuffer,
  DesktopTerminalEvent,
  DesktopTerminalSession,
} from '../terminal/terminalTypes'
import type { DesktopRuntimeHost } from '../runtimeHost'
import type { AutomationNotificationNavigationIntent } from '../automationNotificationNavigation'

declare global {
  interface DesktopLocalProfileSummary {
    id: string
    displayName: string
    avatar?: { kind: 'color' | 'image'; value: string }
    state: 'ready' | 'migrating' | 'importing' | 'degraded' | 'trashed'
    active: boolean
    createdAt: number
    updatedAt: number
    lastActivatedAt?: number
    imported: boolean
    locked: boolean
    conversationCount: number
    boundWorkspaceCount: number
    unboundWorkspaceCount: number
    workspaces: Array<{
      id: string
      displayName: string
      state: 'unbound' | 'candidate' | 'bound' | 'mismatch' | 'unavailable'
      locationName?: string
      conversationCount: number
      updatedAt?: number
    }>
    recentConversations: Array<{
      id: string
      title: string
      updatedAt: number
      turnCount: number
      status: 'active' | 'idle' | 'needs_workspace'
      workspaceId?: string
      workspaceName?: string
    }>
    storageBytes: number
    deviceStateCount: number
  }

  interface DesktopLocalProfilesSnapshot {
    activeProfileId: string
    profiles: DesktopLocalProfileSummary[]
    transitionBlocker: string | null
  }

  interface DesktopLocalProfileMutationResult {
    profile: { id: string; displayName: string }
    profiles: DesktopLocalProfileSummary[]
    snapshot?: DesktopWorkbenchSnapshot
  }

  interface DesktopBackgroundMediaSnapshot {
    kind: 'image' | 'video'
    url: string
    filename: string
    mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'video/mp4' | 'video/webm' | 'video/quicktime'
    size: number
    updatedAt: number
  }

  interface DesktopHostPreferences {
    schemaVersion: 1
    closeWindowBehavior: 'platform-default' | 'keep-running' | 'quit'
    activeRunQuitBehavior: 'ask' | 'wait' | 'interrupt'
  }

  interface DesktopBackgroundMediaSelectionResult {
    canceled: boolean
    media: DesktopBackgroundMediaSnapshot | null
  }

  interface DesktopRemotePairedDevice {
    deviceId: string
    displayName: string
    connectionKind: 'encrypted-device'
    capabilities: string[]
    workspaceIds: string[]
    pairedAt: number
    expiresAt: number
  }

  interface DesktopRemotePendingPairing {
    requestId: string
    deviceId: string
    displayName: string
    connectionKind: 'encrypted-device'
    fingerprint: string
    capabilities: string[]
    workspaceIds: string[]
    requestedAt: number
    expiresAt: number
  }

  interface DesktopRemoteControlSession {
    clientInstanceId: string
    deviceId: string
    displayName: string
    connectedAt: number
    lastSeenAt: number
    expiresAt: number
  }

  interface DesktopRemoteHostStatus {
    available: boolean
    enabled: boolean
    active: boolean
    port: number
    deviceId?: string
    displayName?: string
    workspaceId?: string
    workspaceName?: string
    endpointUrls: string[]
    localEndpointUrl?: string
    publicEndpoint?: string
    clientUrl?: string
    controlSession?: DesktopRemoteControlSession
    pendingPairings: DesktopRemotePendingPairing[]
    pairedDevices: DesktopRemotePairedDevice[]
    recoveryRequired: boolean
    error?: string
  }

  interface DesktopRemotePairingCode {
    code: string
    url?: string
    qrDataUrl: string
    expiresAt: number
    endpointUrls: string[]
    workspaceId: string
    capabilities: string[]
  }

  interface TurboFluxDesktopBridge {
    getSnapshot(): Promise<DesktopWorkbenchSnapshot>
    listLocalProfiles(): Promise<DesktopLocalProfilesSnapshot>
    createLocalProfile(input: { displayName: string; avatar?: { kind: 'color'; value: string }; copyCurrentSettings: boolean; switchToNew: boolean }): Promise<DesktopLocalProfileMutationResult>
    renameLocalProfile(profileId: string, displayName: string): Promise<DesktopLocalProfileMutationResult>
    switchLocalProfile(profileId: string): Promise<DesktopLocalProfileMutationResult & { snapshot: DesktopWorkbenchSnapshot }>
    trashLocalProfile(profileId: string): Promise<DesktopLocalProfileMutationResult>
    restoreLocalProfile(profileId: string): Promise<DesktopLocalProfileMutationResult>
    getProfileExportOptions(): Promise<{
      profile: { id: string; displayName: string }
      components: Array<{ id: ArchiveComponentId; defaultSelected: boolean; sensitivity: 'normal' | 'private' | 'secret' | 'executable'; description: string; requiresEncryption: boolean }>
      format: { extension: '.turboflux-profile'; encryptedByDefault: boolean }
    }>
    estimateProfileExport(input: { components: ArchiveComponentId[]; conversationIds?: string[]; includeBlobs?: boolean; encrypted: boolean }): Promise<ProfileExportEstimate>
    chooseProfileExportTarget(): Promise<{ canceled: true } | { canceled: false; token: string; expiresAt: number; displayName: string }>
    startProfileExport(input: { planId: string; pathToken: string; password?: string }): Promise<ArchiveOperationRef>
    getProfileArchiveOperation(operationId: string): Promise<ArchiveOperationSnapshot>
    cancelProfileArchiveOperation(operationId: string): Promise<boolean>
    chooseProfileImportSource(): Promise<{ canceled: true } | { canceled: false; token: string; expiresAt: number; displayName: string; encrypted: boolean; physicalBytes: number }>
    inspectProfileImport(input: { pathToken: string; password?: string }): Promise<ProfileArchivePreview>
    planProfileImport(input: { pathToken: string; archiveId: string; selectedComponents: ArchiveComponentId[]; displayName: string }): Promise<ProfileImportPlan>
    startProfileImport(input: { planId: string; password?: string }): Promise<ArchiveOperationRef>
    getProfileImportRebindState(profileId: string): Promise<{
      profile: { id: string; displayName: string }
      workspaces: Array<{ id: string; displayName: string; sourceHint?: { platform: string; folderName?: string }; state: 'unbound' | 'candidate' | 'bound' | 'mismatch' | 'unavailable'; boundFolderName?: string; conversationCount: number }>
      conversations: Array<{ id: string; title: string; createdAt: number; updatedAt: number; turnCount: number; workspaceId?: string }>
      receipt?: { archiveId: string; importedAt: number; selectedComponents: ArchiveComponentId[]; skippedComponents: ArchiveComponentId[]; disabled: { automations: number; skills: number; plugins: number; mcpServers: number }; warnings: Array<{ code: string; message: string }> }
    }>
    getProfileImportedConversation(profileId: string, conversationId: string): Promise<PersistedConversation>
    chooseProfileRebindFolder(profileId: string, workspaceId: string): Promise<{ canceled: true } | { canceled: false; token: string; expiresAt: number; displayName: string; mismatch: boolean }>
    confirmProfileRebind(input: { profileId: string; workspaceId: string; pathToken: string; acceptMismatch: boolean }): Promise<{
      workspace: { id: string; displayName: string; state: 'unbound' | 'candidate' | 'bound' | 'mismatch' | 'unavailable'; boundFolderName?: string }
      requiresMismatchConfirmation: boolean
      updated: { conversations: number; projects: number; artifacts: number; automations: number }
      automationsRemainDisabled: true
    }>
    getRemoteStatus(): Promise<DesktopRemoteHostStatus>
    setRemoteEnabled(enabled: boolean): Promise<DesktopRemoteHostStatus>
    resetRemoteIdentity(): Promise<DesktopRemoteHostStatus>
    setRemotePublicEndpoint(endpoint?: string): Promise<DesktopRemoteHostStatus>
    setRemoteClientUrl(url?: string): Promise<DesktopRemoteHostStatus>
    createRemotePairing(ttlMs?: number): Promise<DesktopRemotePairingCode>
    stopRemoteControl(): Promise<DesktopRemoteHostStatus>
    approveRemotePairing(requestId: string): Promise<DesktopRemoteHostStatus>
    rejectRemotePairing(requestId: string): Promise<DesktopRemoteHostStatus>
    revokeRemoteDevice(deviceId: string): Promise<DesktopRemoteHostStatus>
    getSettings(forceModels?: boolean): Promise<WorkbenchSettingsSnapshot>
    previewSettingsModels(update: WorkbenchSettingsUpdate): Promise<WorkbenchSettingsSnapshot>
      saveSettings(update: WorkbenchSettingsUpdate): Promise<DesktopWorkbenchSettingsSaveResult>
      getHostPreferences(): Promise<DesktopHostPreferences>
      saveHostPreferences(preferences: DesktopHostPreferences): Promise<DesktopHostPreferences>
    getBackgroundMedia(): Promise<DesktopBackgroundMediaSnapshot | null>
    chooseBackgroundMedia(): Promise<DesktopBackgroundMediaSelectionResult>
    removeBackgroundMedia(): Promise<null>
    getWindowOpacity(): Promise<number>
    setWindowOpacity(opacity: number): Promise<number>
    listCommands(): Promise<WorkbenchCommandDefinition[]>
    executeCommand(command: WorkbenchCommandId): Promise<WorkbenchCommandResult>
    submitPrompt(prompt: string, attachments?: AgentAttachment[], capabilities?: AgentCapabilitySelection): Promise<WorkbenchSubmitResult>
    resendFromTurn(turnId: string, prompt: string): Promise<WorkbenchSubmitResult>
    recordDraft(draft: WorkbenchDraftSnapshot | string): Promise<boolean>
    openExternal(url: string): Promise<boolean>
    browserGetState(): Promise<BrowserSystemSnapshot>
    browserShow(): Promise<BrowserSystemSnapshot>
    browserHide(): Promise<BrowserSystemSnapshot>
    browserNewTab(url?: string): Promise<BrowserSystemSnapshot>
    browserActivateTab(tabId: string): Promise<BrowserSystemSnapshot>
    browserCloseTab(tabId?: string): Promise<BrowserSystemSnapshot>
    browserNavigate(url: string, tabId?: string): Promise<BrowserSystemSnapshot>
    browserBack(tabId?: string): Promise<BrowserSystemSnapshot>
    browserForward(tabId?: string): Promise<BrowserSystemSnapshot>
    browserReload(tabId?: string): Promise<BrowserSystemSnapshot>
    browserSetBounds(bounds: BrowserBounds): Promise<BrowserSystemSnapshot>
    terminalList(): Promise<DesktopTerminalSession[]>
    terminalCreate(dimensions?: { cols?: number; rows?: number }): Promise<DesktopTerminalSession>
    terminalRead(sessionId: string, sinceSeq?: number): Promise<DesktopTerminalBuffer>
    terminalWrite(sessionId: string, data: string): Promise<DesktopTerminalSession>
    terminalResize(sessionId: string, cols: number, rows: number): Promise<DesktopTerminalSession>
    terminalClose(sessionId: string): Promise<boolean>
    computerGetState(): Promise<ComputerSystemSnapshot>
    computerRefresh(): Promise<ComputerSystemSnapshot>
    computerRequestPermission(kind: ComputerPermissionKind): Promise<ComputerPermissionRequestResult>
    computerOpenPermissionSettings(kind: ComputerPermissionKind): Promise<boolean>
    computerRelaunch(): Promise<boolean>
    computerTakeControl(): Promise<ComputerSystemSnapshot>
    computerResumeControl(): Promise<ComputerSystemSnapshot>
    computerEmergencyStop(): Promise<ComputerSystemSnapshot>
    stop(): Promise<boolean>
    pause(): Promise<boolean>
    resume(): Promise<boolean>
    controlWorkStep(taskId: string, action: 'retry' | 'skip' | 'cancel' | 'resume'): Promise<WorkbenchWorkStepActionResult>
    resolveRequest(requestId: string, response: string): Promise<boolean>
    newConversation(): Promise<DesktopWorkbenchConversationResult>
    newConversationInProject(id: string): Promise<DesktopWorkbenchConversationResult>
    switchConversation(id: string): Promise<DesktopWorkbenchConversationResult>
    deleteConversation(id: string): Promise<boolean>
    renameConversation(id: string, title: string): Promise<boolean>
    gitStage(paths: string[]): Promise<WorkbenchGitActionResult>
    gitUnstage(paths: string[]): Promise<WorkbenchGitActionResult>
    gitCommit(message: string, paths?: string[]): Promise<WorkbenchGitActionResult>
    gitCreateBranch(name: string, startPoint?: string): Promise<WorkbenchGitActionResult>
    gitSwitchBranch(name: string): Promise<WorkbenchGitActionResult>
    gitRestore(paths: string[], source?: string): Promise<WorkbenchGitActionResult>
    gitPush(remote?: string, branch?: string, setUpstream?: boolean): Promise<WorkbenchGitActionResult>
    gitDiff(path?: string, scope?: 'working' | 'staged' | 'all'): Promise<WorkbenchGitDiffResult>
    addProject(): Promise<ProjectSnapshot | null>
    createAutomation(input: {
      name: string
      prompt: string
      objective?: Partial<import('@turboflux/agent-core/workbench').AutomationObjective>
      schedule: AutomationSchedule
      mode?: import('@turboflux/agent-core/workbench').AutomationRunMode
      capabilityPolicy?: Partial<import('@turboflux/agent-core/workbench').AutomationCapabilityPolicy>
      timezone?: string
      enabled?: boolean
      approvalPolicy?: ApprovalPolicy
      misfirePolicy?: 'run-once' | 'skip'
      overlapPolicy?: 'skip' | 'queue-one'
      retryPolicy?: { maxRetries?: number; backoffMinutes?: number }
      maxRuntimeMinutes?: number
    }): Promise<AutomationSnapshot>
    previewAutomationSchedule(schedule: AutomationSchedule, timezone: string, count?: number): Promise<number[]>
    listAutomationDefinitions(query?: { workspacePath?: string; status?: AutomationDefinition['status']; offset?: number; limit?: number }): Promise<ReturnType<AutomationApplicationService['listDefinitions']>>
    getAutomationDefinition(id: string): Promise<ReturnType<AutomationApplicationService['getDefinition']>>
    saveAutomationDraft(input: AutomationDraftInput): Promise<ReturnType<AutomationApplicationService['saveDraft']>>
    validateAutomationDefinition(id: string): Promise<ReturnType<AutomationApplicationService['validateDefinition']>>
    publishAutomationDefinition(id: string, expectedRevision: number): Promise<ReturnType<AutomationApplicationService['publishDefinition']>>
    setAutomationDefinitionStatus(id: string, status: Extract<AutomationDefinition['status'], 'draft' | 'testing' | 'paused' | 'archived'>): Promise<ReturnType<AutomationApplicationService['setDefinitionStatus']>>
    rollbackAutomationDefinition(id: string, targetRevision: number, expectedRevision: number): Promise<ReturnType<AutomationApplicationService['rollbackDefinition']>>
    resetAutomationContinuationConversation(id: string, expectedRevision: number): Promise<ReturnType<AutomationApplicationService['resetContinuationConversation']>>
    listAutomationRuns(query?: { definitionId?: string; offset?: number; limit?: number }): Promise<ReturnType<AutomationApplicationService['listRuns']>>
    getAutomationRun(runId: string): Promise<ReturnType<AutomationApplicationService['getRun']>>
    setAutomationRunPinned(runId: string, pinned: boolean): Promise<ReturnType<AutomationApplicationService['setRunPinned']>>
    resolveAutomationApproval(approvalId: string, response: string): Promise<AutomationApprovalRequest>
    updateAutomation(id: string, patch: AutomationUpdateInput): Promise<AutomationSnapshot>
    removeAutomation(id: string): Promise<AutomationSnapshot>
    archiveAutomationDefinition(id: string, options: { deleteRuns: boolean; deleteConversations: boolean; deleteMemory: boolean }): Promise<Awaited<ReturnType<DesktopRuntimeHost['archiveAutomationDefinition']>>>
    duplicateAutomation(id: string): Promise<AutomationSnapshot>
    runAutomation(id: string): Promise<WorkbenchSubmitResult & { automationId: string; automationRunId: string; conversationId: string; snapshot: WorkbenchSnapshot }>
    testAutomation(id: string): Promise<WorkbenchSubmitResult & { automationId: string; automationRunId: string; conversationId: string; snapshot: WorkbenchSnapshot }>
    retryAutomationRun(id: string, runId: string): Promise<WorkbenchSubmitResult & { automationId: string; automationRunId: string; conversationId: string; snapshot: WorkbenchSnapshot }>
    recoverAutomationRun(runId: string, action: 'resume_without_replay' | 'retry_idempotent'): Promise<WorkbenchSubmitResult & { automationId: string; automationRunId: string; conversationId: string; snapshot: WorkbenchSnapshot }>
    abandonAutomationRunRecovery(runId: string): Promise<ReturnType<AutomationApplicationService['getRun']>>
    cancelAutomationRun(id: string): Promise<AutomationSnapshot>
    takeOverAutomationRun(id: string): Promise<DesktopWorkbenchConversationResult & { automationRunId: string }>
    previewArtifact(id: string, purpose?: 'thumbnail' | 'full'): Promise<WorkbenchArtifactPreview>
    previewImageAttachment(path: string, purpose?: 'thumbnail' | 'full'): Promise<{ mode: 'image'; dataUrl: string; path: string; filename: string; mime: string; size: number }>
    openArtifact(id: string): Promise<boolean>
    revealArtifact(id: string): Promise<boolean>
    exportArtifact(id: string): Promise<string | null>
    exportImageAttachment(path: string): Promise<string | null>
    removeArtifact(id: string): Promise<ArtifactSnapshot>
    listPlugins(): Promise<PluginSnapshot>
    refreshWorkPacks(): Promise<WorkbenchWorkPackSnapshot>
    retryPersistence(): Promise<ConversationPersistenceHealth>
    exportRecovery(): Promise<string | null>
    listWorkPacks(): Promise<WorkbenchWorkPackSnapshot>
    installLocalPlugin(): Promise<WorkbenchWorkPackSnapshot | null>
    setWorkPackEnabled(workPackId: string, enabled: boolean): Promise<WorkbenchWorkPackSnapshot>
    uninstallWorkPack(workPackId: string): Promise<WorkbenchWorkPackSnapshot>
    reconnectMcp(name: string): Promise<WorkbenchSettingsSnapshot>
    acknowledgeNotification(id: string): Promise<boolean>
    listMemories(filters?: WorkbenchMemoryFilters, forceReload?: boolean): Promise<WorkbenchMemorySnapshot>
    rememberMemory(input: WorkbenchMemoryCreateInput): Promise<WorkbenchMemorySnapshot>
    updateMemory(id: string, update: WorkbenchMemoryUpdateInput): Promise<WorkbenchMemorySnapshot>
    forgetMemory(id: string, reason?: string): Promise<WorkbenchMemorySnapshot>
    chooseFiles(): Promise<WorkbenchFileReference[]>
    importFiles(paths: string[]): Promise<WorkbenchFileReference[]>
    importClipboardImage(base64: string, mime: string, filename?: string): Promise<WorkbenchFileReference>
    pathForFile(file: File): string
    chooseWorkspace(): Promise<DesktopWorkbenchSnapshot | null>
    chooseAutomationWorkspace(): Promise<string | null>
    onRuntimeEvent(listener: (event: DesktopWorkbenchEvent) => void): void
    onNavigationIntent(listener: (intent: AutomationNotificationNavigationIntent) => void): void
    onBrowserEvent(listener: (event: BrowserSystemEvent) => void): void
    onTerminalEvent(listener: (event: DesktopTerminalEvent) => void): void
    onComputerEvent(listener: (event: ComputerSystemEvent) => void): void
  }

  interface Window {
    turbofluxDesktop?: TurboFluxDesktopBridge
  }
}

export {}
