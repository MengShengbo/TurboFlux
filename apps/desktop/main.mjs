import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, Menu, net, Notification, powerMonitor, protocol, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isPathInside } from './pathContainment.js'
import { DesktopRuntimeHost } from './runtimeHost.ts'
import { BrowserSystem } from './browser/browserSystem.ts'
import { ComputerSystem } from './computer/computerSystem.ts'
import { ComputerActivityOverlay, classifyComputerOverlayRuntimeEvent } from './computer/computerActivityOverlay.ts'
import { desktopAppRoot } from './desktopPaths.ts'
import { DesktopTerminalSystem } from './terminal/terminalSystem.ts'
import { DesktopRemoteHostManager } from './remote/remoteHostManager.ts'
import { taskCompletionNotificationDelivery, taskCompletionNotificationPresentation } from './taskCompletionNotification.ts'
import { installDesktopPowerLifecycle } from './desktopPowerLifecycle.ts'
import { automationApprovalNavigationIntent } from './automationNotificationNavigation.ts'
import { AutomationNotifications } from './automationNotifications.ts'
import {
  effectiveCloseWindowBehavior,
  loadDesktopHostPreferences,
  saveDesktopHostPreferences,
} from './desktopHostPreferences.ts'
import { countVisibleProfileConversations, countVisibleProfileWorkspaces, filterVisibleProfileWorkspaces, listVisibleProfileConversations, summarizeProfileDirectory } from './profileSummary.ts'
import { profileQaPathOverride } from './profileQaPathOverrides.ts'
import { switchDesktopProfile } from './profileSwitchCoordinator.ts'
import {
  ARCHIVE_COMPONENT_DEFINITIONS,
  configureActiveProfilePaths,
  InstallationProfileRegistry,
  inspectProfileArchiveEnvelope,
  LegacyProfileMigration,
  ConversationStore,
  ConversationRepositoryV2,
  legacyWorkspaceId,
  loadCredentialSnapshot,
  migrateConversationStoreV1ToV2,
  persistedConversationFromProjectionV2,
  ProfileArchiveApplicationService,
  ProfileArchiveImporter,
  ProfileExportPlanner,
  ProfileLifecycleCoordinator,
  ProfileWorkspaceRebindService,
  resolveProfileFeatureFlags,
  WorkspaceBindingService,
  copyNonSecretProfileSettings,
  reprotectCredentialDocument,
  serializeCredentialSnapshot,
  setCredentialProtection,
} from '@turboflux/agent-core/workbench'

protocol.registerSchemesAsPrivileged([{
  scheme: 'turboflux-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

const devUrl = process.env.TURBOFLUX_DESKTOP_URL
const hiddenQaWindow = process.env.TURBOFLUX_DESKTOP_QA_HIDDEN === '1'
const profileFeatureFlags = resolveProfileFeatureFlags(process.env)
const desktopDirectory = desktopAppRoot
const repositoryRoot = resolve(desktopDirectory, '..', '..')
const rendererEntryPath = app.isPackaged
  ? join(process.resourcesPath, 'renderer', 'index.html')
  : join(repositoryRoot, 'dist-desktop', 'renderer', 'index.html')
const productIconPath = app.isPackaged
  ? join(process.resourcesPath, 'renderer', 'turboflux-app-icon.png')
  : join(desktopAppRoot, 'build', 'turboflux-app-icon.png')
const remoteMobileRoot = app.isPackaged
  ? join(process.resourcesPath, 'remote-mobile')
  : join(repositoryRoot, 'apps', 'remote-mobile', 'dist')

app.setName('TurboFlux')
if (process.platform === 'win32') app.setAppUserModelId('dev.turboflux.desktop')
const ownsSingleInstanceLock = app.requestSingleInstanceLock()
if (!ownsSingleInstanceLock) app.quit()

if (app.isPackaged) {
  const esbuildPackage = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
  const esbuildBinary = process.platform === 'win32'
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', esbuildPackage, 'esbuild.exe')
    : join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', esbuildPackage, 'bin', 'esbuild')
  if (existsSync(esbuildBinary)) process.env.ESBUILD_BINARY_PATH = esbuildBinary
}
let mainWindow
let runtimeHost
let runtimeHostPromise
let runtimeHostGeneration = 0
let runtimeHostResetPromise = Promise.resolve()
let shutdownPromise
let shutdownComplete = false
let desktopPowerSuspended = false
let desktopPowerLifecycleEpoch = 0
let disposeDesktopPowerLifecycle
let desktopHostPreferences = loadDesktopHostPreferences('/nonexistent/turboflux-desktop-host.json')
let unsubscribeRuntime
const browserSystems = new Map()
const computerSystems = new Map()
let activeConversationId = null
let browserSystem
let computerSystem
let computerLeaseOwnerId = null
let computerActivityOverlay
let terminalSystem
let remoteHostManager
let remoteHostManagerPromise

function systemNotificationsAvailable() {
  return !hiddenQaWindow && Notification.isSupported()
}

let profileRegistry
let activeProfileContext
let profileInitializationPromise
let profileArchiveService
let profileArchiveServiceProfileId
let profileSwitchInProgress = false
const profileArchivePathTokens = new Map()
const visibleTaskCompletionNotifications = new Set()
const notifiedAutomationApprovalIds = new Set()
let automationNotifications = new AutomationNotifications()
const BACKGROUND_IMAGE_MAX_BYTES = 32 * 1024 * 1024
const BACKGROUND_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const WINDOW_OPACITY_MIN = 0.45
const COMPUTER_APPROVAL_RESTORE_TOOLS = new Set([
  'computer__click',
  'computer__double_click',
  'computer__move',
  'computer__drag',
  'computer__scroll',
  'computer__type_text',
  'computer__press',
])

function isTrustedWorkbenchUrl(value) {
  try {
    const actual = new URL(value)
    if (devUrl) return actual.origin === new URL(devUrl).origin
    return actual.protocol === 'file:' && fileURLToPath(actual) === rendererEntryPath
  } catch {
    return false
  }
}

function assertTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Rejected IPC request from an untrusted window')
  }
  const frameUrl = event.senderFrame?.url || event.sender.getURL()
  if (!isTrustedWorkbenchUrl(frameUrl)) throw new Error('Rejected IPC request from an untrusted frame')
}

const ipcMain = {
  handle(channel, listener) {
    electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event)
      return listener(event, ...args)
    })
  },
}

electronIpcMain.handle('desktop:computer-overlay-action', async (event, action, payload) => {
  if (!computerActivityOverlay?.ownsWebContents(event.sender)) throw new Error('Rejected Computer overlay action from an untrusted window')
  return handleComputerOverlayAction(action, payload)
})

async function getInstallationId() {
  if (!installationIdPromise) {
    installationIdPromise = (async () => {
      const directory = app.getPath('userData')
      const filePath = join(directory, 'installation-id')
      try {
        const existing = (await readFile(filePath, 'utf8')).trim()
        if (existing) return existing
      } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('Failed to read installation ID:', error)
      }
      const created = randomUUID()
      await mkdir(directory, { recursive: true })
      await writeFile(filePath, `${created}\n`, { encoding: 'utf8', mode: 0o600 })
      return created
    })()
  }
  return installationIdPromise
}

function broadcastRuntimeEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:runtime-event', event)
}

function conversationTitle(conversationId) {
  const snapshot = runtimeHost?.getSnapshot()
  return snapshot?.conversationCatalog?.find(conversation => conversation.id === conversationId)?.title
    || snapshot?.conversations?.find(conversation => conversation.id === conversationId)?.title
}

function requestBackgroundAttention() {
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational')
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true)
}

async function revealWorkbenchWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const workbenchWindow = mainWindow
  if (!workbenchWindow || workbenchWindow.isDestroyed()) return undefined
  if (workbenchWindow.isMinimized()) workbenchWindow.restore()
  workbenchWindow.show()
  workbenchWindow.focus()
  if (workbenchWindow.webContents.isLoadingMainFrame()) {
    await new Promise(resolveReady => {
      const finish = () => {
        workbenchWindow.webContents.removeListener('did-finish-load', finish)
        workbenchWindow.removeListener('closed', finish)
        resolveReady()
      }
      workbenchWindow.webContents.once('did-finish-load', finish)
      workbenchWindow.once('closed', finish)
    })
  }
  return workbenchWindow.isDestroyed() ? undefined : workbenchWindow
}

async function revealCompletedTask(conversationId) {
  const workbenchWindow = await revealWorkbenchWindow()
  if (!workbenchWindow) return
  try {
    const host = await getRuntimeHost()
    const result = await host.switchConversation(conversationId)
    activateConversationSystems(result.id, result.snapshot)
    if (!workbenchWindow.isDestroyed()) workbenchWindow.webContents.send('desktop:runtime-event', { type: 'snapshot', snapshot: result.snapshot })
  } catch (error) {
    console.error('Failed to reveal completed task:', error)
  }
}

async function revealAutomationTarget(intent) {
  const workbenchWindow = await revealWorkbenchWindow()
  if (!workbenchWindow) return
  workbenchWindow.webContents.send('desktop:navigation-intent', intent)
}

function showTaskCompletionNotification(event) {
  const appIsForeground = Boolean(mainWindow
    && !mainWindow.isDestroyed()
    && mainWindow.isFocused())
  const delivery = taskCompletionNotificationDelivery(event, appIsForeground)
  if (!delivery.showSystemNotification) return
  if (!systemNotificationsAvailable()) return
  const presentation = taskCompletionNotificationPresentation(event, conversationTitle(event.conversationId))
  if (!presentation) return
  if (delivery.requestBackgroundAttention) requestBackgroundAttention()
  try {
    const notification = new Notification({
      title: presentation.title,
      body: presentation.body,
      icon: productIconPath,
      silent: true,
      timeoutType: 'default',
      urgency: 'normal',
    })
    visibleTaskCompletionNotifications.add(notification)
    const release = () => visibleTaskCompletionNotifications.delete(notification)
    notification.once('click', () => {
      release()
      if (event.conversationId) void revealCompletedTask(event.conversationId)
    })
    notification.once('close', release)
    notification.once('failed', release)
    notification.show()
  } catch (error) {
    console.error('Failed to show task completion notification:', error)
  }
}

function showAutomationApprovalNotifications(snapshot) {
  const pending = snapshot?.automations?.pendingApprovals || []
  const ids = new Set(pending.map(request => request.id))
  for (const id of notifiedAutomationApprovalIds) if (!ids.has(id)) notifiedAutomationApprovalIds.delete(id)
  for (const request of pending) {
    if (notifiedAutomationApprovalIds.has(request.id)) continue
    notifiedAutomationApprovalIds.add(request.id)
    runtimeHost?.emitAutomationRemoteNotification({ conversationId: request.conversationId, level: 'warning', message: request.automationName + ' · 等待审批' })
    showAutomationNotification(request.automationName + ' · 等待审批', request.question,
      automationApprovalNavigationIntent({ approvalId: request.id, runId: request.runId }))
  }
}



function showAutomationNotification(title, body, intent) {
  if (!systemNotificationsAvailable()) return
  try {
    const notification = new Notification({ title, body: body.slice(0, 1_000), icon: productIconPath, silent: true })
    visibleTaskCompletionNotifications.add(notification)
    const release = () => visibleTaskCompletionNotifications.delete(notification)
    notification.once('click', () => { release(); void revealAutomationTarget(intent) })
    notification.once('close', release)
    notification.once('failed', release)
    notification.show()
  } catch (error) { console.error('Failed to show automation notification:', error) }
}

function showAutomationResultNotifications(snapshot) {
  for (const result of automationNotifications.observe(snapshot.automations.automations)) {
    runtimeHost?.emitAutomationRemoteNotification({ conversationId: result.conversationId, level: result.failed ? 'error' : 'success', message: result.title })
    showAutomationNotification(result.title, result.summary, { kind: 'automation-run', runId: result.runId })
  }
}

function broadcastBrowserEvent(conversationId, event) {
  if (event?.type === 'artifact-ready' && event.path) {
    const source = event.kind === 'download' ? 'browser-download' : 'browser'
    void getRuntimeHost().then(host => host.registerArtifact(event.path, source, {
      name: event.name,
      mime: event.mime,
      conversationId,
      metadata: {
        browserTabId: event.tabId || '',
        browserTitle: event.title || '',
        browserUrl: event.url || '',
      },
    })).catch(error => {
      console.error('Failed to register browser artifact:', error)
    })
  }
  if (conversationId === activeConversationId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:browser-event', event)
  }
}

function broadcastComputerEvent(conversationId, event) {
  if (event?.type === 'artifact-ready' && event.path) {
    void getRuntimeHost().then(host => host.registerArtifact(event.path, 'agent', {
      name: event.name,
      mime: event.mime,
      conversationId,
      metadata: {
        visualSource: 'computer',
        capturedAt: event.capturedAt || Date.now(),
        observationId: event.observationId || '',
        computerAppName: event.appName || '',
        computerWindowTitle: event.windowTitle || '',
      },
    })).catch(error => {
      console.error('Failed to register computer visual evidence:', error)
    })
  }
  const system = computerSystems.get(conversationId)
  if (conversationId !== activeConversationId || !system) return
  if (computerActivityOverlay) computerActivityOverlay.handleEvent(event, system.getSnapshot())
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:computer-event', event)
}

function broadcastTerminalEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:terminal-event', event)
}

function syncComputerActivityOverlay(snapshot = runtimeHost?.getSnapshot()) {
  if (!computerActivityOverlay || !computerSystem) return
  const computerSnapshot = computerSystem.getSnapshot()
  const active = computerSnapshot.sessionActive || computerSnapshot.handoffActive
  const request = active
    ? snapshot?.runtime?.pendingRequests?.find(candidate => candidate.kind === 'permission')
    : undefined
  computerActivityOverlay.sync(computerSnapshot, request ? {
    id: request.id,
    kind: 'permission',
    question: request.question,
    reason: request.reason,
    toolName: request.toolName,
    options: Array.isArray(request.options) ? request.options : [],
  } : null)
}

function handleRuntimeEvent(event) {
  showTaskCompletionNotification(event)
  if (event?.type === 'snapshot') {
    showAutomationApprovalNotifications(event.snapshot)
    showAutomationResultNotifications(event.snapshot)
  }
  const classification = classifyComputerOverlayRuntimeEvent(event, activeConversationId)
  const conversationId = classification.action.conversationId
  const taskFinished = classification.taskFinished
  if (taskFinished && conversationId) {
    const browser = browserSystems.get(conversationId)
    const computer = computerSystems.get(conversationId)
    if (browser) void browser.finishTask().catch(error => console.error('Failed to clear Browser task data:', error))
    if (computer) void computer.finishTask().catch(error => console.error('Failed to clear Computer task data:', error))
  }
  if (classification.action.kind === 'activate') {
    activateConversationSystems(classification.action.conversationId, classification.action.snapshot)
  } else if (classification.action.kind === 'sync') syncComputerActivityOverlay()
  broadcastRuntimeEvent(event)
}

function ensureConversationSystems(conversationId, workspaceOverlayRoot) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Workbench window is not ready')
  let browser = browserSystems.get(conversationId)
  if (!browser) {
    browser = new BrowserSystem(mainWindow, process.cwd(), event => broadcastBrowserEvent(conversationId, event), conversationId)
    browser.setPresentationEnabled(conversationId === activeConversationId)
    browserSystems.set(conversationId, browser)
  }
  if (workspaceOverlayRoot) browser.setStorageRoot(workspaceOverlayRoot)
  let computer = computerSystems.get(conversationId)
  if (!computer) {
    computer = new ComputerSystem(mainWindow, process.cwd(), event => broadcastComputerEvent(conversationId, event), undefined, {
      storageRoot: workspaceOverlayRoot,
      pauseRuntime: () => runtimeHost?.pauseConversation(conversationId),
      requestPermission: kind => requestComputerPermissionForAgent(computer, kind),
      beforeVisualCapture: () => conversationId === activeConversationId ? computerActivityOverlay?.suspendForCapture() : undefined,
      afterVisualCapture: () => conversationId === activeConversationId ? computerActivityOverlay?.resumeAfterCapture() : undefined,
      acquireControl: () => {
        if (computerLeaseOwnerId && computerLeaseOwnerId !== conversationId) return false
        computerLeaseOwnerId = conversationId
        return true
      },
      releaseControl: () => {
        if (computerLeaseOwnerId === conversationId) computerLeaseOwnerId = null
      },
    })
    computerSystems.set(conversationId, computer)
  }
  if (workspaceOverlayRoot) computer.setStorageRoot(workspaceOverlayRoot)
  return { browser, computer }
}

function activateConversationSystems(conversationId, snapshot = runtimeHost?.getSnapshot()) {
  if (!conversationId || !mainWindow || mainWindow.isDestroyed()) return
  if (activeConversationId && activeConversationId !== conversationId) {
    browserSystems.get(activeConversationId)?.setPresentationEnabled(false)
  }
  activeConversationId = conversationId
  const systems = ensureConversationSystems(conversationId)
  browserSystem = systems.browser
  computerSystem = systems.computer
  browserSystem.setPresentationEnabled(true)
  syncComputerActivityOverlay(snapshot)
}

function destroyConversationSystems(conversationId) {
  browserSystems.get(conversationId)?.destroy()
  browserSystems.delete(conversationId)
  computerSystems.get(conversationId)?.destroy()
  computerSystems.delete(conversationId)
  if (computerLeaseOwnerId === conversationId) computerLeaseOwnerId = null
  if (activeConversationId === conversationId) {
    activeConversationId = null
    browserSystem = null
    computerSystem = null
  }
}

function destroyAllConversationSystems() {
  for (const browser of browserSystems.values()) browser.destroy()
  for (const computer of computerSystems.values()) computer.destroy()
  browserSystems.clear()
  computerSystems.clear()
  activeConversationId = null
  browserSystem = null
  computerSystem = null
  computerLeaseOwnerId = null
}

function reconcileConversationSystems(snapshot) {
  const validConversationIds = new Set(snapshot.conversationRuntimes.map(runtime => runtime.conversationId))
  for (const conversationId of new Set([...browserSystems.keys(), ...computerSystems.keys()])) {
    if (!validConversationIds.has(conversationId)) destroyConversationSystems(conversationId)
  }
  for (const conversationId of validConversationIds) {
    const systems = ensureConversationSystems(conversationId)
    systems.browser.setWorkspacePath(snapshot.workspace.path)
    systems.computer.setWorkspacePath(snapshot.workspace.path)
  }
  activateConversationSystems(snapshot.conversation.id, snapshot)
}

function registerSystemPlugins(client, context) {
  const systems = ensureConversationSystems(context.conversationId, context.workspaceOverlayRoot)
  systems.browser.register(client)
  systems.computer.register(client)
}

function unscopedWorkspacePath() {
  return join(app.getPath('userData'), 'workspace', 'unscoped')
}

function conversationMigrationWorkspaceId(bindings, conversation) {
  const workspacePath = resolve(conversation.workspacePath)
  const existing = bindings.list().workspaces.find(workspace => (
    workspace.localPath && resolve(workspace.localPath) === workspacePath
  ))
  if (existing) return existing.id
  if (existsSync(workspacePath)) return bindings.ensureBound(workspacePath, basename(workspacePath) || '工作区').id
  const workspaceId = legacyWorkspaceId(workspacePath)
  const known = bindings.get(workspaceId)
  if (known) return known.id
  return bindings.addUnbound({
    id: workspaceId,
    displayName: basename(workspacePath) || '工作区',
    sourceHint: {
      platform: process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'unknown',
      folderName: basename(workspacePath) || undefined,
    },
  }).id
}

function listImportedProfileConversations(context) {
  const repository = new ConversationRepositoryV2(context.storage.conversationsV2Root)
  const records = []
  let cursor
  do {
    const page = repository.list({ cursor, limit: 200 })
    records.push(...page.conversations)
    cursor = page.nextCursor || undefined
  } while (cursor)
  return records.map(record => persistedConversationFromProjectionV2(
    repository.projection(record.id),
    record.workspaceId ? `turboflux-unbound:${record.workspaceId}` : unscopedWorkspacePath(),
  )).filter(Boolean)
}

function configureDesktopCredentialProtection() {
  if (!safeStorage.isEncryptionAvailable()) return false
  setCredentialProtection({
    protect: plaintext => safeStorage.encryptString(plaintext.toString('base64url')),
    unprotect: ciphertext => Buffer.from(safeStorage.decryptString(ciphertext), 'base64url'),
  })
  return true
}

async function getActiveProfileContext() {
  requireProfileFeature('conversationDataV2', 'Conversation V2 已由发布配置关闭；为保护数据，TurboFlux 不会回退到旧目录写入。')
  if (activeProfileContext) return activeProfileContext
  if (!profileInitializationPromise) {
    profileInitializationPromise = Promise.resolve().then(async () => {
      const legacyConfigRoot = resolve(process.env.TURBOFLUX_CONFIG_DIR || join(homedir(), '.turboflux'))
      const userDataPath = app.getPath('userData')
      const credentialProtectionAvailable = configureDesktopCredentialProtection()
      const registry = new InstallationProfileRegistry(legacyConfigRoot, {
        deviceRoot: join(userDataPath, 'device'),
      })
      registry.initialize()
      await new ProfileArchiveImporter({
        registry,
        protectCredentials: credentialProtectionAvailable
          ? credentials => Buffer.from(serializeCredentialSnapshot(credentials), 'utf8')
          : undefined,
      }).recoverTransactions()
      new ProfileLifecycleCoordinator({ registry }).recoverTransactions()
      const context = registry.activeContext()
      registry.setState(context.profile.id, 'migrating')
      const migration = new LegacyProfileMigration({
        legacyConfigRoot,
        legacyConversationsRoot: process.env.TURBOFLUX_CONVERSATIONS_DIR,
        legacyPlatformRoot: join(userDataPath, 'platform'),
        legacyRemoteRoot: join(userDataPath, 'remote'),
        migrationRoot: join(legacyConfigRoot, 'migration'),
        layout: context.storage,
        credentialTransformer: credentialProtectionAvailable ? reprotectCredentialDocument : undefined,
      })
      const result = migration.migrate()
      if (result.status !== 'completed') {
        registry.setState(context.profile.id, 'degraded')
        const failed = result.steps.find(step => step.status === 'failed')
        throw new Error(`Local profile migration failed${failed ? ` at ${failed.id}: ${failed.error || 'unknown error'}` : ''}`)
      }
      const workspaceBindings = new WorkspaceBindingService(context.storage)
      migrateConversationStoreV1ToV2({
        profileId: context.profile.id,
        conversationsRoot: context.storage.conversationsRoot,
        conversationsV2Root: context.storage.conversationsV2Root,
        interactionRoot: context.storage.interactionRoot,
        workspaceIdForConversation: conversation => conversationMigrationWorkspaceId(workspaceBindings, conversation),
      })
      new ConversationRepositoryV2(context.storage.conversationsV2Root).recoverInterruptedConversations()
      registry.setState(context.profile.id, 'ready')
      const readyContext = registry.activeContext()
      configureActiveProfilePaths({
        configRoot: readyContext.storage.configRoot,
        conversationsRoot: readyContext.storage.conversationsRoot,
        userSkillsRoot: readyContext.storage.userSkillsRoot,
        globalMcpSettingsPath: readyContext.storage.settingsPath,
      })
      profileRegistry = registry
      activeProfileContext = readyContext
      return readyContext
    }).catch(error => {
      profileInitializationPromise = null
      throw error
    })
  }
  return profileInitializationPromise
}

async function getProfileArchiveService() {
  const context = await getActiveProfileContext()
  if (profileArchiveService && profileArchiveServiceProfileId === context.profile.id) return profileArchiveService
  profileArchiveService = new ProfileArchiveApplicationService({
    planner: new ProfileExportPlanner({
      profile: context.profile,
      layout: context.storage,
      conversationDataVersion: profileFeatureFlags.conversationDataV2 ? 2 : 1,
      excludedWorkspacePaths: [unscopedWorkspacePath()],
      appVersion: app.getVersion(),
      coreVersion: app.getVersion(),
      credentialReader: () => loadCredentialSnapshot(),
    }),
    importer: new ProfileArchiveImporter({
      registry: profileRegistry,
      protectCredentials: safeStorage.isEncryptionAvailable()
        ? credentials => Buffer.from(serializeCredentialSnapshot(credentials), 'utf8')
        : undefined,
    }),
  })
  profileArchiveServiceProfileId = context.profile.id
  return profileArchiveService
}

function createProfileArchivePathToken(path, kind) {
  const token = randomUUID()
  const expiresAt = Date.now() + 10 * 60_000
  profileArchivePathTokens.set(token, { path, kind, expiresAt })
  return { token, expiresAt }
}

function consumeProfileArchivePathToken(token, kind) {
  const record = profileArchivePathTokens.get(token)
  profileArchivePathTokens.delete(token)
  if (!record || record.kind !== kind || record.expiresAt < Date.now()) throw new Error('文件选择已过期，请重新选择保存位置')
  return record.path
}

function resolveProfileArchivePathToken(token, kind) {
  const record = profileArchivePathTokens.get(token)
  if (!record || record.kind !== kind || record.expiresAt < Date.now()) {
    profileArchivePathTokens.delete(token)
    throw new Error('文件选择已过期，请重新选择文件')
  }
  return record.path
}

function requireImportedProfileContext(profileId) {
  const context = profileRegistry?.context(requireText(profileId, 'profileId'))
  if (!context?.profile.importedFrom) throw new Error('该资料不是由资料包导入的')
  return context
}

function publicWorkspaceBinding(workspace, conversationCount = 0) {
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    sourceHint: workspace.sourceHint,
    state: workspace.state,
    boundFolderName: workspace.localPath ? basename(workspace.localPath) : undefined,
    conversationCount,
  }
}

function profileArchiveTransitionBlocker() {
  return profileArchiveService?.transitionBlocker() || runtimeHost?.transitionBlocker() || null
}

function profileLifecycleCoordinator() {
  if (!profileRegistry) throw new Error('本地资料注册表尚未初始化')
  return new ProfileLifecycleCoordinator({ registry: profileRegistry })
}

function requireProfileFeature(feature, message) {
  if (!profileFeatureFlags[feature]) throw new Error(message)
}

async function localProfileSummaries() {
  await getActiveProfileContext()
  const snapshot = profileRegistry.snapshot()
  const trashRoot = profileLifecycleCoordinator().trashRoot
  return Promise.all(snapshot.profiles.map(async profile => {
    const context = profileRegistry.context(profile.id)
    const root = profile.state === 'trashed' ? join(trashRoot, profile.id) : context.storage.profileRoot
    const conversationCount = await countVisibleProfileConversations(root)
    const conversations = await listVisibleProfileConversations(root)
    let workspaces = []
    try {
      const bindings = JSON.parse(await readFile(join(root, 'workspaces', 'bindings.json'), 'utf8'))
      workspaces = Array.isArray(bindings.workspaces) ? bindings.workspaces : []
    } catch {}
    const workspaceCounts = countVisibleProfileWorkspaces(workspaces, [unscopedWorkspacePath()])
    const visibleWorkspaces = filterVisibleProfileWorkspaces(workspaces, [unscopedWorkspacePath()])
    const resolveConversationWorkspaceId = conversation => {
      if (conversation.workspaceId) return conversation.workspaceId
      if (typeof conversation.workspacePath !== 'string') return undefined
      if (conversation.workspacePath.startsWith('turboflux-unbound:')) return conversation.workspacePath.slice('turboflux-unbound:'.length)
      return visibleWorkspaces.find(workspace => workspace.localPath && resolve(workspace.localPath) === resolve(conversation.workspacePath))?.id
    }
    const storage = await summarizeProfileDirectory(root)
    const device = profile.state === 'trashed' ? { bytes: 0, files: 0 } : await summarizeProfileDirectory(context.storage.deviceBoundRoot)
    return {
      id: profile.id,
      displayName: profile.displayName,
      avatar: profile.avatar,
      state: profile.state,
      active: profile.id === snapshot.activeProfileId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      lastActivatedAt: profile.lastActivatedAt,
      imported: Boolean(profile.importedFrom),
      locked: profile.lock.kind !== 'none',
      conversationCount,
      boundWorkspaceCount: workspaceCounts.bound,
      unboundWorkspaceCount: workspaceCounts.unbound,
      workspaces: visibleWorkspaces
        .slice()
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || String(left.displayName || '').localeCompare(String(right.displayName || '')))
        .map(workspace => ({
          id: String(workspace.id || ''),
          displayName: String(workspace.displayName || workspace.sourceHint?.folderName || '未命名工作区'),
          state: workspace.state,
          locationName: workspace.localPath ? basename(workspace.localPath) : workspace.sourceHint?.folderName,
          conversationCount: conversations.filter(conversation => resolveConversationWorkspaceId(conversation) === workspace.id).length,
          updatedAt: typeof workspace.updatedAt === 'number' ? workspace.updatedAt : undefined,
        })),
      recentConversations: conversations.slice(0, 5).map(conversation => {
        const workspaceId = resolveConversationWorkspaceId(conversation)
        return {
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          turnCount: conversation.turnCount,
          status: conversation.status,
          workspaceId,
          workspaceName: visibleWorkspaces.find(workspace => workspace.id === workspaceId)?.displayName,
        }
      }),
      storageBytes: storage.bytes,
      deviceStateCount: device.files,
    }
  }))
}

async function getRuntimeHost() {
  while (true) {
    await runtimeHostResetPromise
    if (runtimeHost) return runtimeHost
    if (!runtimeHostPromise) {
      const generation = runtimeHostGeneration
      const pending = Promise.all([
        mkdir(unscopedWorkspacePath(), { recursive: true }),
        getActiveProfileContext(),
      ])
        .then(([, profileContext]) => DesktopRuntimeHost.create(unscopedWorkspacePath(), {
          registerSystemPlugins,
          profileStorage: profileContext.storage,
          unscopedWorkspacePath: unscopedWorkspacePath(),
        }))
        .then(async host => {
          if (generation !== runtimeHostGeneration) {
            await host.destroy()
            throw new Error('Desktop runtime initialization was superseded')
          }
          unsubscribeRuntime = host.subscribe(handleRuntimeEvent)
          const snapshot = host.getSnapshot()
          reconcileConversationSystems(snapshot)
          runtimeHost = host
          if (desktopPowerSuspended) host.suspendForSystemSleep()
          await remoteHostManager?.attachRuntime(host).catch(error => {
            console.error('Failed to attach the remote host runtime:', error)
          })
          return host
        })
        .catch(error => {
          if (runtimeHostPromise === pending) runtimeHostPromise = null
          throw error
        })
      runtimeHostPromise = pending
    }
    const generation = runtimeHostGeneration
    const pending = runtimeHostPromise
    try {
      const host = await pending
      if (generation !== runtimeHostGeneration) continue
      return host
    } catch (error) {
      if (generation !== runtimeHostGeneration) continue
      throw error
    }
  }
}

async function startNewConversation() {
  const host = await getRuntimeHost()
  try {
    return await host.newConversation()
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作区',
    buttonLabel: '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  const workspacePath = result.canceled ? null : result.filePaths[0] || null
  if (!workspacePath) return null
  const host = await getRuntimeHost()
  try {
    return await host.setWorkspace(workspacePath)
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
}

async function chooseAutomationWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择自动化工作区',
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  const selectedPath = result.canceled ? null : result.filePaths[0] || null
  if (!selectedPath) return null
  const canonicalPath = await realpath(selectedPath)
  if (!(await stat(canonicalPath)).isDirectory()) throw new Error('所选自动化工作区不是文件夹')
  return canonicalPath
}

function backgroundMediaPaths() {
  const directory = join(app.getPath('userData'), 'appearance')
  return {
    directory,
    metadata: join(directory, 'background-media.json'),
    legacyAsset: join(directory, 'wallpaper-image'),
    legacyMetadata: join(directory, 'wallpaper.json'),
    windowOpacity: join(directory, 'window-opacity.json'),
  }
}

function normalizeWindowOpacity(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.min(1, Math.max(WINDOW_OPACITY_MIN, parsed))
}

function readPersistedWindowOpacity() {
  try {
    return normalizeWindowOpacity(JSON.parse(readFileSync(backgroundMediaPaths().windowOpacity, 'utf8')))
  } catch {
    return 1
  }
}

function detectBackgroundMedia(buffer, extension = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm'
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return extension === '.mov' ? 'video/quicktime' : 'video/mp4'
  return undefined
}

function backgroundMediaKind(mime) {
  return mime?.startsWith('video/') ? 'video' : mime?.startsWith('image/') ? 'image' : undefined
}

function safeBackgroundAssetName(value, mime) {
  const fallbackExtension = ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
  })[mime] || ''
  const extension = extname(typeof value === 'string' ? value : '').toLowerCase() || fallbackExtension
  return `background-media${extension}`
}

async function readBackgroundMediaSnapshot() {
  const paths = backgroundMediaPaths()
  try {
    const metadataText = await readFile(paths.metadata, 'utf8')
    const metadata = JSON.parse(metadataText)
    const mime = typeof metadata.mime === 'string' ? metadata.mime : undefined
    const kind = backgroundMediaKind(mime)
    if (!kind) return null
    const assetName = safeBackgroundAssetName(metadata.assetName, mime)
    const assetPath = join(paths.directory, assetName)
    const assetStat = await stat(assetPath)
    if (!assetStat.isFile()) return null
    const filename = typeof metadata.filename === 'string' && metadata.filename.trim()
      ? basename(metadata.filename).slice(0, 240)
      : kind === 'video' ? '动态背景' : '背景图片'
    return {
      kind,
      url: `turboflux-media://background/asset?v=${Math.trunc(assetStat.mtimeMs)}`,
      filename,
      mime,
      size: assetStat.size,
      updatedAt: Math.trunc(assetStat.mtimeMs),
    }
  } catch {
    try {
      const [buffer, legacyMetadataText, legacyStat] = await Promise.all([
        readFile(paths.legacyAsset),
        readFile(paths.legacyMetadata, 'utf8'),
        stat(paths.legacyAsset),
      ])
      const legacyMetadata = JSON.parse(legacyMetadataText)
      const mime = detectBackgroundMedia(buffer)
      if (!mime || !backgroundMediaKind(mime)) return null
      const assetName = safeBackgroundAssetName(legacyMetadata.filename, mime)
      await mkdir(paths.directory, { recursive: true })
      await writeFile(join(paths.directory, assetName), buffer)
      await writeFile(paths.metadata, JSON.stringify({ assetName, filename: legacyMetadata.filename, mime }), 'utf8')
      return {
        kind: 'image',
        url: `turboflux-media://background/asset?v=${Math.trunc(legacyStat.mtimeMs)}`,
        filename: basename(legacyMetadata.filename || '背景图片').slice(0, 240),
        mime,
        size: buffer.byteLength,
        updatedAt: Math.trunc(legacyStat.mtimeMs),
      }
    } catch {
      return null
    }
  }
}

async function chooseBackgroundMedia() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作台背景媒体',
    buttonLabel: '设为背景',
    properties: ['openFile'],
    filters: [
      { name: '图片与视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov'] },
      { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
    ],
  })
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, media: await readBackgroundMediaSnapshot() }
  }
  const sourcePath = result.filePaths[0]
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile()) throw new Error('背景媒体必须是文件')
  const buffer = await readFile(sourcePath)
  const mime = detectBackgroundMedia(buffer, extname(sourcePath).toLowerCase())
  const kind = backgroundMediaKind(mime)
  if (!mime || !kind) throw new Error('请选择 JPG、PNG、WebP、GIF、MP4、WebM 或 MOV 文件')
  const maximumBytes = kind === 'video' ? BACKGROUND_VIDEO_MAX_BYTES : BACKGROUND_IMAGE_MAX_BYTES
  if (sourceStat.size > maximumBytes) throw new Error(kind === 'video' ? '背景视频必须小于 512 MB' : '背景图片必须小于 32 MB')
  const paths = backgroundMediaPaths()
  const previous = await readBackgroundMediaSnapshot()
  const assetName = safeBackgroundAssetName(sourcePath, mime)
  await mkdir(paths.directory, { recursive: true })
  await writeFile(join(paths.directory, assetName), buffer)
  await writeFile(paths.metadata, JSON.stringify({ assetName, filename: basename(sourcePath), mime }), 'utf8')
  if (previous) {
    const previousName = safeBackgroundAssetName(previous.filename, previous.mime)
    if (previousName !== assetName) await rm(join(paths.directory, previousName), { force: true })
  }
  await Promise.all([rm(paths.legacyAsset, { force: true }), rm(paths.legacyMetadata, { force: true })])
  return { canceled: false, media: await readBackgroundMediaSnapshot() }
}

async function removeBackgroundMedia() {
  const paths = backgroundMediaPaths()
  const current = await readBackgroundMediaSnapshot()
  if (current) await rm(join(paths.directory, safeBackgroundAssetName(current.filename, current.mime)), { force: true })
  await Promise.all([rm(paths.metadata, { force: true }), rm(paths.legacyAsset, { force: true }), rm(paths.legacyMetadata, { force: true })])
  return null
}

async function installBackgroundMediaProtocol() {
  protocol.handle('turboflux-media', async request => {
    const url = new URL(request.url)
    if (url.hostname !== 'background' || url.pathname !== '/asset') return new Response('Not found', { status: 404 })
    const snapshot = await readBackgroundMediaSnapshot()
    if (!snapshot) return new Response('Not found', { status: 404 })
    const assetPath = join(backgroundMediaPaths().directory, safeBackgroundAssetName(snapshot.filename, snapshot.mime))
    return net.fetch(pathToFileURL(assetPath).href, { headers: request.headers })
  })
}

async function setWindowOpacity(value) {
  const opacity = normalizeWindowOpacity(value)
  if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setOpacity === 'function') mainWindow.setOpacity(opacity)
  const paths = backgroundMediaPaths()
  await mkdir(paths.directory, { recursive: true })
  await writeFile(paths.windowOpacity, JSON.stringify(opacity), 'utf8')
  return opacity
}


function resetRuntimeHost() {
  const reset = runtimeHostResetPromise.catch(() => undefined).then(async () => {
    runtimeHostGeneration += 1
    const current = runtimeHost
    const pending = runtimeHostPromise
    runtimeHost = null
    runtimeHostPromise = null
    unsubscribeRuntime?.()
    unsubscribeRuntime = null
    await remoteHostManager?.detachRuntime()
    if (current) await current.destroy()
    else if (pending) await pending.catch(() => undefined)
    destroyAllConversationSystems()
  })
  runtimeHostResetPromise = reset
  return reset
}

async function closeRemoteHostManager() {
  const current = remoteHostManager
  const pending = remoteHostManagerPromise
  remoteHostManager = null
  remoteHostManagerPromise = null
  if (current) await current.close()
  else if (pending) await pending.then(manager => manager.close(), () => undefined)
  remoteHostManager = null
  remoteHostManagerPromise = null
}

function profileLifecycleTransitionBlocker({ ownsProfileSwitch = false } = {}) {
  if (profileSwitchInProgress && !ownsProfileSwitch) return '本地资料正在切换，请稍后再试'
  const archiveBlocker = profileArchiveService?.transitionBlocker()
  if (archiveBlocker) return archiveBlocker
  const runtimeBlocker = runtimeHost?.transitionBlocker()
  if (runtimeBlocker) return runtimeBlocker
  if (terminalSystem?.list().some(session => session.status === 'running')) return '仍有终端会话在运行，请先关闭终端'
  if (computerLeaseOwnerId) return '电脑操控仍由一个任务占用，请先停止操控'
  if (remoteHostManager?.status().controlSession) return '手机远程控制仍在进行，请先停止远程控制'
  return null
}

function applyActiveProfileContext(context) {
  notifiedAutomationApprovalIds.clear()
  activeProfileContext = context
  configureActiveProfilePaths({
    configRoot: context.storage.configRoot,
    conversationsRoot: context.storage.conversationsRoot,
    userSkillsRoot: context.storage.userSkillsRoot,
    globalMcpSettingsPath: context.storage.settingsPath,
  })
  profileArchiveService = null
  profileArchiveServiceProfileId = null
  profileArchivePathTokens.clear()
  desktopHostPreferences = loadDesktopHostPreferences(join(context.storage.configRoot, 'desktop-host.json'))
  automationNotifications = new AutomationNotifications()
}

async function desktopHostPreferencesPath() {
  return join((await getActiveProfileContext()).storage.configRoot, 'desktop-host.json')
}

async function activateLocalProfile(profileId) {
  if (profileSwitchInProgress) throw new Error('本地资料正在切换，请稍后再试')
  profileSwitchInProgress = true
  try {
    const previous = await getActiveProfileContext()
    const target = profileRegistry.context(requireText(profileId, 'profileId'))
    return await switchDesktopProfile({
      previous,
      target,
      transitionBlocker: () => profileLifecycleTransitionBlocker({ ownsProfileSwitch: true }),
      beforeSwitch: async () => {},
      resetRuntime: resetRuntimeHost,
      destroyTerminal: () => {
        terminalSystem?.destroy()
        terminalSystem = null
      },
      closeRemote: closeRemoteHostManager,
      activate: id => profileRegistry.activate(id),
      applyContext: applyActiveProfileContext,
      startRuntime: getRuntimeHost,
      startRemote: async () => { await getRemoteHostManager() },
      broadcast: snapshot => broadcastRuntimeEvent({ type: 'snapshot', snapshot }),
    })
  } finally {
    profileSwitchInProgress = false
  }
}

async function shutdownDesktopApplication() {
  try {
    disposeDesktopPowerLifecycle?.()
    disposeDesktopPowerLifecycle = undefined
    await resetRuntimeHost()
  } finally {
    terminalSystem?.destroy()
    terminalSystem = null
    destroyAllConversationSystems()
    computerActivityOverlay?.destroy()
    computerActivityOverlay = null
    await remoteHostManager?.close()
  }
}

function remoteStateProtection() {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  return {
    protect: plaintext => safeStorage.encryptString(Buffer.from(plaintext).toString('base64url')),
    unprotect: ciphertext => Buffer.from(safeStorage.decryptString(Buffer.from(ciphertext)), 'base64url'),
  }
}

async function getRemoteHostManager() {
  if (remoteHostManager) return remoteHostManager
  if (!remoteHostManagerPromise) {
    remoteHostManagerPromise = (async () => {
      const profileContext = await getActiveProfileContext()
      const manager = new DesktopRemoteHostManager({
        userDataPath: profileContext.storage.deviceBoundRoot,
        displayName: `TurboFlux · ${hostname()}`,
        stateProtection: remoteStateProtection(),
        port: process.env.TURBOFLUX_REMOTE_PORT,
        publicEndpoint: process.env.TURBOFLUX_REMOTE_PUBLIC_ENDPOINT,
        clientUrl: process.env.TURBOFLUX_REMOTE_CLIENT_URL,
        mobileWebRoot: remoteMobileRoot,
      })
      await manager.initialize()
      if (runtimeHost) await manager.attachRuntime(runtimeHost)
      remoteHostManager = manager
      return manager
    })().catch(error => {
      remoteHostManagerPromise = null
      throw error
    })
  }
  return remoteHostManagerPromise
}

function assertRuntimeResetAllowed() {
  if (!runtimeHost) return
  const blocker = runtimeHost.transitionBlocker()
  if (blocker) throw new Error(blocker)
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function requireTextArray(value, name, max = 200) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`${name} must contain 1-${max} items`)
  return value.map((item, index) => requireText(item, `${name}[${index}]`))
}

function mimeForPath(filePath) {
  const extension = extname(filePath).toLowerCase()
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })[extension] || 'application/octet-stream'
}

async function normalizeAttachments(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const normalized = []
  const host = await getRuntimeHost()
  const attachmentRoot = await realpath(resolve(host.getSnapshot().workspace.path, '.turboflux', 'attachments'))
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') continue
    const attachmentPath = await realpath(resolve(item.path))
    if (!isPathInside(attachmentRoot, attachmentPath)) {
      throw new Error(`Attachment is outside the TurboFlux attachment store: ${item.path}`)
    }
    const info = await stat(attachmentPath)
    if (!info.isFile() || info.size === 0 || info.size > 50 * 1024 * 1024) {
      throw new Error(`Attachment must be a non-empty file up to 50 MB: ${item.path}`)
    }
    const mime = mimeForPath(attachmentPath)
    normalized.push({
      id: typeof item.id === 'string' && item.id ? item.id : `desktop-image-${Date.now()}-${normalized.length}`,
      type: mime.startsWith('image/') ? 'image' : 'file',
      path: attachmentPath,
      filename: attachmentPath.split(/[\\/]/).at(-1) || attachmentPath,
      mime,
      size: info.size,
    })
  }
  return normalized.length > 0 ? normalized : undefined
}

function normalizeCapabilities(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return undefined
  const items = []
  const seen = new Set()
  for (const item of value.items.slice(0, 16)) {
    if (!item || typeof item !== 'object' || !['skill', 'mcp'].includes(item.type)) continue
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : ''
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : ''
    const key = `${item.type}:${id}`
    if (!id || !name || seen.has(key)) continue
    seen.add(key)
    items.push({ type: item.type, id, name })
  }
  return items.length > 0 ? { items } : undefined
}

function createWindow() {
  destroyAllConversationSystems()
  computerActivityOverlay?.destroy()
  mainWindow = new BrowserWindow({
    show: !hiddenQaWindow,
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: 'TurboFlux',
    icon: productIconPath,
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !hiddenQaWindow,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: join(desktopDirectory, 'preload.cjs'),
    },
  })
  if (typeof mainWindow.setOpacity === 'function') mainWindow.setOpacity(readPersistedWindowOpacity())
  const workbenchWindow = mainWindow

  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadURL(pathToFileURL(rendererEntryPath).href)
  }
  computerActivityOverlay = new ComputerActivityOverlay(mainWindow)
  const guardWorkbenchNavigation = (event, url) => {
    if (isTrustedWorkbenchUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardWorkbenchNavigation)
  mainWindow.webContents.on('will-redirect', guardWorkbenchNavigation)
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  mainWindow.on('focus', () => {
    if (process.platform !== 'darwin') mainWindow?.flashFrame(false)
    void computerSystem?.refresh().catch(error => console.error('Failed to refresh Computer permissions:', error))
    syncComputerActivityOverlay()
  })
  mainWindow.on('blur', () => {
    syncComputerActivityOverlay()
  })
  mainWindow.on('close', event => {
    if (shutdownComplete || effectiveCloseWindowBehavior(desktopHostPreferences) === 'quit') return
    event.preventDefault()
    workbenchWindow.hide()
  })
  mainWindow.on('closed', () => {
    if (mainWindow !== workbenchWindow) return
    terminalSystem?.destroy()
    terminalSystem = null
    destroyAllConversationSystems()
    computerActivityOverlay?.destroy()
    computerActivityOverlay = null
    mainWindow = null
  })
  runtimeHost?.setSystemPluginRegistrar(registerSystemPlugins)
}

function requireBrowserSystem() {
  if (!browserSystem) throw new Error('浏览器系统尚未就绪')
  return browserSystem
}

function requireComputerSystem() {
  if (!computerSystem) throw new Error('Computer system is not ready')
  return computerSystem
}

function requireTerminalSystem() {
  if (!terminalSystem) terminalSystem = new DesktopTerminalSystem(broadcastTerminalEvent)
  return terminalSystem
}

const COMPUTER_PERMISSION_GUIDES = {
  'screen-recording': {
    title: '屏幕录制',
    message: '允许 TurboFlux 查看目标应用',
    detail: '接下来 macOS 会申请“屏幕与系统音频录制”权限。TurboFlux 只会在电脑操控任务中读取目标应用窗口，并自动遮挡自身窗口。',
    settingsLabel: '屏幕与系统音频录制',
  },
  accessibility: {
    title: '辅助功能',
    message: '允许 TurboFlux 理解并操作应用控件',
    detail: '接下来 macOS 会申请“辅助功能”权限，用于识别按钮、输入框并优先执行语义操作。密码、验证码和系统授权始终由你接管。',
    settingsLabel: '辅助功能',
  },
  'post-event': {
    title: '输入控制',
    message: '允许 TurboFlux 执行点击与输入',
    detail: '接下来 macOS 会申请本机输入控制权限。TurboFlux 只会对刚刚观察并核验过的目标应用执行动作。',
    settingsLabel: '辅助功能',
  },
}

function computerPermissionStatus(snapshot, kind) {
  if (kind === 'screen-recording') return snapshot.permissions.screenRecording
  if (kind === 'accessibility') return snapshot.permissions.accessibility
  if (kind === 'post-event') return snapshot.permissions.postEvent
  throw new Error(`Unknown computer permission: ${kind}`)
}

function computerPermissionOutcome(snapshot, kind) {
  const status = computerPermissionStatus(snapshot, kind)
  if (status.state === 'granted') return 'granted'
  if (status.restartRequired) return 'restart-required'
  return 'needs-settings'
}

function relaunchDesktopApplication() {
  app.relaunch()
  app.quit()
  return true
}

function computerPermissionGuide(kind) {
  const guide = COMPUTER_PERMISSION_GUIDES[kind]
  if (!guide) throw new Error(`Unknown computer permission: ${kind}`)
  return guide
}

function computerPermissionIdentity(kind) {
  if (kind === 'screen-recording') return app.isPackaged ? 'TurboFlux' : 'Electron'
  return app.isPackaged
    ? 'TurboFlux 电脑辅助程序（系统也可能显示 TurboFluxComputerHelper）'
    : 'TurboFluxComputerHelper'
}

async function requestComputerPermission(system, kind) {
  const guide = computerPermissionGuide(kind)
  const current = system.getSnapshot()
  const currentOutcome = computerPermissionOutcome(current, kind)
  if (currentOutcome !== 'needs-settings') return { kind, outcome: currentOutcome, snapshot: current }
  const identityHint = `在系统列表中允许“${computerPermissionIdentity(kind)}”。`
  const prompt = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `电脑操控 · ${guide.title}`,
    message: guide.message,
    detail: `${guide.detail}\n\n${identityHint}`,
    buttons: ['继续申请', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (prompt.response !== 0) return { kind, outcome: 'cancelled', snapshot: current }
  const snapshot = await system.requestPermission(kind)
  return {
    kind,
    outcome: computerPermissionOutcome(snapshot, kind),
    snapshot,
  }
}

async function openComputerPermissionSettings(system, kind) {
  const guide = computerPermissionGuide(kind)
  const identityHint = `请在列表中开启“${computerPermissionIdentity(kind)}”。`
  const prompt = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `电脑操控 · ${guide.title}`,
    message: `在 macOS“${guide.settingsLabel}”中完成授权`,
    detail: `${identityHint}\n完成后回到 TurboFlux，权限状态会自动重新检查。若 macOS 提示需要重新打开应用，请按系统提示操作。`,
    buttons: ['打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (prompt.response !== 0) return false
  await system.openPermissionSettings(kind)
  return true
}

async function requestComputerPermissionForAgent(system, kind) {
  const first = await requestComputerPermission(system, kind)
  if (first.outcome === 'granted') return true
  if (first.outcome === 'cancelled') return false
  if (first.outcome === 'restart-required') {
    const restart = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '电脑操控权限已经开启',
      message: '需要重新打开 TurboFlux 让原生操控进程继承权限',
      detail: '当前任务和对话会保留。重新打开后再次执行这一步即可，不需要重复前往系统设置授权。',
      buttons: ['重新打开 TurboFlux', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (restart.response === 0) relaunchDesktopApplication()
    return false
  }
  const guide = computerPermissionGuide(kind)
  const prompt = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `电脑操控 · ${guide.title}`,
    message: `请在 macOS 中开启“${guide.settingsLabel}”权限`,
    detail: `${guide.detail}\n\n授权后回到 TurboFlux，点击“已完成，继续”，当前智能代理步骤会自动继续。`,
    buttons: ['打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (prompt.response !== 0) return false
  await system.openPermissionSettings(kind)
  const completed = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '等待权限生效',
    message: '授权完成后返回 TurboFlux',
    detail: '点击“继续”重新检查权限；如果 macOS 要求重新打开应用，请按系统提示处理。',
    buttons: ['已完成，继续', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (completed.response !== 0) return false
  const refreshed = await system.refresh()
  return computerPermissionStatus(refreshed, kind).state === 'granted'
}

ipcMain.handle('desktop:get-snapshot', async () => (await getRuntimeHost()).getSnapshot())
ipcMain.handle('desktop:profiles-list', async () => {
  requireProfileFeature('profileCenterV2', '本地资料管理已由发布配置关闭。')
  return {
    activeProfileId: (await getActiveProfileContext()).profile.id,
    profiles: await localProfileSummaries(),
    transitionBlocker: profileLifecycleTransitionBlocker(),
  }
})
ipcMain.handle('desktop:profile-create', async (_event, input) => {
  requireProfileFeature('profileCenterV2', '本地资料管理已由发布配置关闭。')
  const source = await getActiveProfileContext()
  const avatarColor = typeof input?.avatar?.value === 'string' && /^#[0-9a-f]{6}$/iu.test(input.avatar.value)
    ? input.avatar.value
    : undefined
  const created = profileRegistry.create({
    displayName: requireText(input?.displayName, 'displayName'),
    avatar: avatarColor ? { kind: 'color', value: avatarColor } : undefined,
  })
  try {
    if (input?.copyCurrentSettings === true) await copyNonSecretProfileSettings(source, created)
    if (input?.switchToNew === true) {
      const activated = await activateLocalProfile(created.profile.id)
      return { profile: activated.profile, snapshot: activated.snapshot, profiles: await localProfileSummaries() }
    }
    return { profile: created.profile, profiles: await localProfileSummaries() }
  } catch (error) {
    if (profileRegistry.snapshot().activeProfileId !== created.profile.id) {
      try { profileLifecycleCoordinator().trash(created.profile.id) } catch {}
    }
    throw error
  }
})
ipcMain.handle('desktop:profile-rename', async (_event, profileId, displayName) => {
  requireProfileFeature('profileCenterV2', '本地资料管理已由发布配置关闭。')
  await getActiveProfileContext()
  const profile = profileRegistry.rename(requireText(profileId, 'profileId'), requireText(displayName, 'displayName'))
  if (profile.id === activeProfileContext?.profile.id) activeProfileContext = profileRegistry.context(profile.id)
  return { profile, profiles: await localProfileSummaries() }
})
ipcMain.handle('desktop:profile-switch', async (_event, profileId) => {
  requireProfileFeature('profileCenterV2', '本地资料管理已由发布配置关闭。')
  const result = await activateLocalProfile(requireText(profileId, 'profileId'))
  return { ...result, profiles: await localProfileSummaries() }
})
ipcMain.handle('desktop:profile-trash', async (_event, profileId) => {
  requireProfileFeature('profileCenterV2', '本地资料管理已由发布配置关闭。')
  await getActiveProfileContext()
  const blocker = profileLifecycleTransitionBlocker()
  if (blocker) throw new Error(blocker)
  const profile = profileLifecycleCoordinator().trash(requireText(profileId, 'profileId'))
  return { profile, profiles: await localProfileSummaries() }
})
ipcMain.handle('desktop:profile-restore', async (_event, profileId) => {
  requireProfileFeature('profileCenterV2', '本地资料管理已由发布配置关闭。')
  await getActiveProfileContext()
  const blocker = profileLifecycleTransitionBlocker()
  if (blocker) throw new Error(blocker)
  const profile = profileLifecycleCoordinator().restore(requireText(profileId, 'profileId'))
  return { profile, profiles: await localProfileSummaries() }
})
ipcMain.handle('desktop:profile-export-options', async () => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const context = await getActiveProfileContext()
  return {
    profile: { id: context.profile.id, displayName: context.profile.displayName },
    components: ARCHIVE_COMPONENT_DEFINITIONS.map(component => ({ ...component })),
    format: { extension: '.turboflux-profile', encryptedByDefault: true },
  }
})
ipcMain.handle('desktop:profile-estimate-export', async (_event, input) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const context = await getActiveProfileContext()
  const components = Array.isArray(input?.components) ? input.components.filter(component => typeof component === 'string') : []
  const estimate = await (await getProfileArchiveService()).estimateExport({
    profileId: context.profile.id,
    components,
    conversationIds: Array.isArray(input?.conversationIds) ? input.conversationIds.filter(id => typeof id === 'string') : undefined,
    includeBlobs: input?.includeBlobs === true,
    encrypted: input?.encrypted === true,
  })
  const blocker = profileArchiveTransitionBlocker()
  if (blocker) estimate.blockers.push({ code: 'PROFILE_BUSY', message: blocker, action: '请等待任务完成或停止任务后重试。' })
  return estimate
})
ipcMain.handle('desktop:profile-choose-export-target', async () => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const context = await getActiveProfileContext()
  const safeName = context.profile.displayName.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'TurboFlux-profile'
  const qaPath = profileQaPathOverride(process.env, 'export')
  const result = qaPath ? { canceled: false, filePath: qaPath } : await dialog.showSaveDialog(mainWindow, {
    title: '导出 TurboFlux 用户资料包',
    defaultPath: `${safeName}-${new Date().toISOString().slice(0, 10)}.turboflux-profile`,
    filters: [{ name: 'TurboFlux 用户资料包', extensions: ['turboflux-profile'] }],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const path = result.filePath.endsWith('.turboflux-profile') ? result.filePath : `${result.filePath}.turboflux-profile`
  return { canceled: false, displayName: basename(path), ...createProfileArchivePathToken(path, 'export') }
})
ipcMain.handle('desktop:profile-start-export', async (_event, input) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const blocker = profileArchiveTransitionBlocker()
  if (blocker) throw new Error(`${blocker}。请等待完成或停止任务后再导出。`)
  const planId = requireText(input?.planId, 'planId')
  const targetPath = consumeProfileArchivePathToken(requireText(input?.pathToken, 'pathToken'), 'export')
  const password = typeof input?.password === 'string' && input.password.length > 0
    ? Buffer.from(input.password.slice(0, 1_024), 'utf8')
    : undefined
  try {
    return (await getProfileArchiveService()).startExport({ planId, targetPath, password })
  } finally {
    password?.fill(0)
  }
})
ipcMain.handle('desktop:profile-get-archive-operation', async (_event, operationId) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const operation = (await getProfileArchiveService()).getOperation(requireText(operationId, 'operationId'))
  return operation.result ? { ...operation, result: { ...operation.result, path: undefined } } : operation
})
ipcMain.handle('desktop:profile-cancel-archive-operation', async (_event, operationId) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  return (await getProfileArchiveService()).cancelOperation(requireText(operationId, 'operationId'))
})
ipcMain.handle('desktop:profile-choose-import-source', async () => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  await getActiveProfileContext()
  const qaPath = profileQaPathOverride(process.env, 'import')
  const result = qaPath ? { canceled: false, filePaths: [qaPath] } : await dialog.showOpenDialog(mainWindow, {
    title: '导入 TurboFlux 用户资料包',
    properties: ['openFile'],
    filters: [{ name: 'TurboFlux 用户资料包', extensions: ['turboflux-profile'] }],
  })
  const path = result.filePaths[0]
  if (result.canceled || !path) return { canceled: true }
  const envelope = await inspectProfileArchiveEnvelope(path)
  return { canceled: false, displayName: basename(path), encrypted: envelope.encrypted, physicalBytes: envelope.physicalBytes, ...createProfileArchivePathToken(path, 'import') }
})
ipcMain.handle('desktop:profile-inspect-import', async (_event, input) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const sourcePath = resolveProfileArchivePathToken(requireText(input?.pathToken, 'pathToken'), 'import')
  const password = typeof input?.password === 'string' && input.password.length > 0
    ? Buffer.from(input.password.slice(0, 1_024), 'utf8')
    : undefined
  try {
    return await (await getProfileArchiveService()).inspectArchive(sourcePath, password)
  } finally {
    password?.fill(0)
  }
})
ipcMain.handle('desktop:profile-plan-import', async (_event, input) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const token = requireText(input?.pathToken, 'pathToken')
  const sourcePath = resolveProfileArchivePathToken(token, 'import')
  const plan = (await getProfileArchiveService()).planImport(sourcePath, {
    archiveId: requireText(input?.archiveId, 'archiveId'),
    selectedComponents: Array.isArray(input?.selectedComponents)
      ? input.selectedComponents.filter(component => typeof component === 'string')
      : [],
    displayName: requireText(input?.displayName, 'displayName'),
  })
  consumeProfileArchivePathToken(token, 'import')
  const blocker = profileArchiveTransitionBlocker()
  if (blocker) plan.blockers.push({ code: 'PROFILE_BUSY', message: blocker, action: '请等待任务完成或停止任务后重试。' })
  return plan
})
ipcMain.handle('desktop:profile-start-import', async (_event, input) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  const blocker = profileArchiveTransitionBlocker()
  if (blocker) throw new Error(`${blocker}。请等待完成或停止任务后再导入。`)
  const password = typeof input?.password === 'string' && input.password.length > 0
    ? Buffer.from(input.password.slice(0, 1_024), 'utf8')
    : undefined
  try {
    return (await getProfileArchiveService()).startImport({
      planId: requireText(input?.planId, 'planId'),
      password,
    })
  } finally {
    password?.fill(0)
  }
})
ipcMain.handle('desktop:profile-import-rebind-state', async (_event, profileId) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  await getActiveProfileContext()
  const context = requireImportedProfileContext(profileId)
  const bindings = new WorkspaceBindingService(context.storage).list().workspaces
  const conversations = listImportedProfileConversations(context)
  const receiptPath = join(context.storage.profileRoot, 'import-receipt.json')
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : undefined
  return {
    profile: { id: context.profile.id, displayName: context.profile.displayName },
    workspaces: bindings.map(workspace => publicWorkspaceBinding(workspace, conversations.filter(conversation => (
      conversation.workspacePath === `turboflux-unbound:${workspace.id}`
      || Boolean(workspace.localPath && resolve(conversation.workspacePath) === resolve(workspace.localPath))
    )).length)),
    conversations: conversations.map(conversation => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      turnCount: conversation.turnCount,
      workspaceId: conversation.workspacePath.startsWith('turboflux-unbound:')
        ? conversation.workspacePath.slice('turboflux-unbound:'.length)
        : bindings.find(workspace => workspace.localPath && resolve(workspace.localPath) === resolve(conversation.workspacePath))?.id,
    })),
    receipt: receipt ? {
      archiveId: receipt.archiveId,
      importedAt: receipt.importedAt,
      selectedComponents: receipt.selectedComponents,
      skippedComponents: receipt.skippedComponents,
      disabled: receipt.disabled,
      warnings: receipt.warnings,
    } : undefined,
  }
})
ipcMain.handle('desktop:profile-import-conversation', async (_event, profileId, conversationId) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  await getActiveProfileContext()
  const context = requireImportedProfileContext(profileId)
  const id = requireText(conversationId, 'conversationId')
  const repository = new ConversationRepositoryV2(context.storage.conversationsV2Root)
  const projection = repository.projection(id)
  const workspaceId = projection.conversation?.workspaceId
  const conversation = persistedConversationFromProjectionV2(
    projection,
    workspaceId ? `turboflux-unbound:${workspaceId}` : unscopedWorkspacePath(),
  )
  if (!conversation) throw new Error('导入的历史会话不存在')
  return conversation
})
ipcMain.handle('desktop:profile-choose-rebind-folder', async (_event, profileId, workspaceId) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  await getActiveProfileContext()
  const context = requireImportedProfileContext(profileId)
  const workspace = new WorkspaceBindingService(context.storage).get(requireText(workspaceId, 'workspaceId'))
  if (!workspace) throw new Error('导入的工作区不存在')
  const qaPath = profileQaPathOverride(process.env, 'rebind')
  const result = qaPath ? { canceled: false, filePaths: [qaPath] } : await dialog.showOpenDialog(mainWindow, { title: `为“${workspace.displayName}”选择本机文件夹`, properties: ['openDirectory'] })
  const path = result.filePaths[0]
  if (result.canceled || !path) return { canceled: true }
  const kind = `rebind:${context.profile.id}:${workspace.id}`
  return {
    canceled: false,
    displayName: basename(path),
    mismatch: Boolean(workspace.sourceHint?.folderName && workspace.sourceHint.folderName !== basename(path)),
    ...createProfileArchivePathToken(path, kind),
  }
})
ipcMain.handle('desktop:profile-confirm-rebind', async (_event, input) => {
  requireProfileFeature('profileArchiveV2', '资料包 V2 已由发布配置关闭。')
  await getActiveProfileContext()
  const context = requireImportedProfileContext(input?.profileId)
  const workspaceId = requireText(input?.workspaceId, 'workspaceId')
  const localPath = consumeProfileArchivePathToken(requireText(input?.pathToken, 'pathToken'), `rebind:${context.profile.id}:${workspaceId}`)
  const result = new ProfileWorkspaceRebindService(context.storage).rebind({
    workspaceId,
    localPath,
    acceptMismatch: input?.acceptMismatch === true,
  })
  return {
    ...result,
    workspace: publicWorkspaceBinding(result.workspace),
  }
})
ipcMain.handle('desktop:remote-status', async () => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).status()
})
ipcMain.handle('desktop:remote-set-enabled', async (_event, enabled) => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).setEnabled(enabled === true)
})
ipcMain.handle('desktop:remote-reset-identity', async () => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).resetRemoteIdentity()
})
ipcMain.handle('desktop:remote-set-public-endpoint', async (_event, endpoint) => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).setPublicEndpoint(typeof endpoint === 'string' ? endpoint : undefined)
})
ipcMain.handle('desktop:remote-set-client-url', async (_event, url) => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).setClientUrl(typeof url === 'string' ? url : undefined)
})
ipcMain.handle('desktop:remote-create-pairing', async (_event, ttlMs) => {
  await getRuntimeHost()
  const ttl = Number.isFinite(ttlMs) ? Math.max(60_000, Math.min(15 * 60_000, Math.floor(ttlMs))) : undefined
  return (await getRemoteHostManager()).createPairingCode(ttl)
})
ipcMain.handle('desktop:remote-stop-control', async () => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).stopRemoteControlSession()
})
ipcMain.handle('desktop:remote-approve-pairing', async (_event, requestId) => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).approvePairing(requireText(requestId, 'requestId'))
})
ipcMain.handle('desktop:remote-reject-pairing', async (_event, requestId) => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).rejectPairing(requireText(requestId, 'requestId'))
})
ipcMain.handle('desktop:remote-revoke-device', async (_event, deviceId) => {
  await getRuntimeHost()
  return (await getRemoteHostManager()).revokeDevice(requireText(deviceId, 'deviceId'))
})
ipcMain.handle('desktop:get-settings', async (_event, forceModels) => (
  (await getRuntimeHost()).getSettings(forceModels === true)
))
ipcMain.handle('desktop:preview-settings-models', async (_event, update) => (
  (await getRuntimeHost()).previewSettingsModels(update)
))
ipcMain.handle('desktop:save-settings', async (_event, update) => (
  (async () => {
    try {
      return await (await getRuntimeHost()).saveSettings(update)
    } finally {
      if (runtimeHost) reconcileConversationSystems(runtimeHost.getSnapshot())
    }
  })()
))
ipcMain.handle('desktop:get-host-preferences', async () => desktopHostPreferences)
ipcMain.handle('desktop:save-host-preferences', async (_event, preferences) => {
  desktopHostPreferences = saveDesktopHostPreferences(await desktopHostPreferencesPath(), preferences)
  return desktopHostPreferences
})
ipcMain.handle('desktop:get-background-media', () => readBackgroundMediaSnapshot())
ipcMain.handle('desktop:choose-background-media', () => chooseBackgroundMedia())
ipcMain.handle('desktop:remove-background-media', () => removeBackgroundMedia())
ipcMain.handle('desktop:get-window-opacity', () => (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.getOpacity === 'function' ? mainWindow.getOpacity() : readPersistedWindowOpacity()))
ipcMain.handle('desktop:set-window-opacity', (_event, opacity) => setWindowOpacity(opacity))
ipcMain.handle('desktop:list-commands', async () => (await getRuntimeHost()).listCommands())
ipcMain.handle('desktop:execute-command', async (_event, command) => {
  const commandId = requireText(command, 'command')
  if (commandId === 'flow.export') {
    const result = await dialog.showSaveDialog({
      title: '导出 TurboFlux 恢复包',
      defaultPath: `turboflux-recovery-${Date.now()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { message: '已取消导出' }
    const path = (await getRuntimeHost()).exportRecoveryBundle(result.filePath)
    return { message: `恢复包已导出：${path}` }
  }
  return (await getRuntimeHost()).executeCommand(commandId)
})
ipcMain.handle('desktop:submit-prompt', async (_event, prompt, attachments, capabilities) => (
  (await getRuntimeHost()).submitPrompt(requireText(prompt, 'prompt'), await normalizeAttachments(attachments), normalizeCapabilities(capabilities))
))
ipcMain.handle('desktop:resend-from-turn', async (_event, turnId, prompt) => (
  (await getRuntimeHost()).resendFromTurn(requireText(turnId, 'turnId'), requireText(prompt, 'prompt'))
))
ipcMain.handle('desktop:record-draft', async (_event, draft) => (await getRuntimeHost()).recordDraft(draft && typeof draft === 'object' ? draft : typeof draft === 'string' ? draft : ''))
ipcMain.handle('desktop:open-external', async (_event, value) => {
  const target = requireText(value, 'url')
  const parsed = new URL(target)
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
  await shell.openExternal(parsed.href)
  return true
})
ipcMain.handle('desktop:browser-get-state', async () => {
  await getRuntimeHost()
  return requireBrowserSystem().getSnapshot()
})
ipcMain.handle('desktop:browser-show', () => requireBrowserSystem().show())
ipcMain.handle('desktop:browser-hide', () => requireBrowserSystem().hide())
ipcMain.handle('desktop:browser-new-tab', async (_event, url) => requireBrowserSystem().createTab(typeof url === 'string' ? url : 'about:blank'))
ipcMain.handle('desktop:browser-activate-tab', (_event, tabId) => requireBrowserSystem().activateTab(requireText(tabId, 'tabId')))
ipcMain.handle('desktop:browser-close-tab', async (_event, tabId) => requireBrowserSystem().closeTab(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-navigate', async (_event, url, tabId) => requireBrowserSystem().navigate(requireText(url, 'url'), typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-back', (_event, tabId) => requireBrowserSystem().goBack(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-forward', (_event, tabId) => requireBrowserSystem().goForward(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-reload', (_event, tabId) => requireBrowserSystem().reload(typeof tabId === 'string' ? tabId : undefined))
ipcMain.handle('desktop:browser-set-bounds', (_event, bounds) => {
  if (!bounds || typeof bounds !== 'object') throw new Error('Invalid browser bounds')
  return requireBrowserSystem().setBounds({
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Number(bounds.width) || 0,
    height: Number(bounds.height) || 0,
  })
})
ipcMain.handle('desktop:terminal-list', () => requireTerminalSystem().list())
ipcMain.handle('desktop:terminal-create', async (_event, dimensions) => {
  const snapshot = (await getRuntimeHost()).getSnapshot()
  return requireTerminalSystem().create({
    cwd: snapshot.workspace.path,
    cols: dimensions?.cols,
    rows: dimensions?.rows,
  })
})
ipcMain.handle('desktop:terminal-read', (_event, sessionId, sinceSeq) => (
  requireTerminalSystem().read(requireText(sessionId, 'sessionId'), sinceSeq)
))
ipcMain.handle('desktop:terminal-write', (_event, sessionId, data) => (
  requireTerminalSystem().write(requireText(sessionId, 'sessionId'), typeof data === 'string' ? data : '')
))
ipcMain.handle('desktop:terminal-resize', (_event, sessionId, cols, rows) => (
  requireTerminalSystem().resize(requireText(sessionId, 'sessionId'), cols, rows)
))
ipcMain.handle('desktop:terminal-close', (_event, sessionId) => (
  requireTerminalSystem().close(requireText(sessionId, 'sessionId'))
))

async function takeComputerControl() {
  const conversationId = computerLeaseOwnerId || activeConversationId
  const system = conversationId ? computerSystems.get(conversationId) || requireComputerSystem() : requireComputerSystem()
  const snapshot = system.takeControl()
  if (conversationId) {
    browserSystems.get(conversationId)?.pauseForRuntime()
    await (await getRuntimeHost()).pauseConversation(conversationId)
  }
  syncComputerActivityOverlay()
  return snapshot
}

async function resumeComputerControl() {
  const conversationId = computerLeaseOwnerId || activeConversationId
  const system = conversationId ? computerSystems.get(conversationId) || requireComputerSystem() : requireComputerSystem()
  const snapshot = system.resumeControl()
  if (conversationId) {
    browserSystems.get(conversationId)?.resumeForRuntime()
    await (await getRuntimeHost()).resumeConversation(conversationId)
  }
  syncComputerActivityOverlay()
  return snapshot
}

async function emergencyStopComputerControl() {
  const host = await getRuntimeHost()
  const browsers = [...browserSystems.values()]
  const systems = [...computerSystems.values()]
  for (const browser of browsers) browser.pauseForRuntime()
  for (const system of systems) system.emergencyStop()
  for (const runtime of host.getSnapshot().conversationRuntimes) host.stopConversation(runtime.conversationId)
  await Promise.all([
    ...browsers.map(browser => browser.finishTask()),
    ...systems.map(system => system.finishTask()),
  ])
  syncComputerActivityOverlay()
  return requireComputerSystem().getSnapshot()
}

async function resolveRuntimeRequest(requestId, response) {
  const host = await getRuntimeHost()
  const request = host.getSnapshot().runtime.pendingRequests.find(candidate => candidate.id === requestId)
  if (!request) return false
  if (request.kind === 'permission' && COMPUTER_APPROVAL_RESTORE_TOOLS.has(request.toolName || '') && response !== 'deny') {
    await requireComputerSystem().restoreObservedTargetAfterApproval()
  }
  const resolved = host.resolveRequest(requestId, response)
  syncComputerActivityOverlay(host.getSnapshot())
  return resolved
}

async function handleComputerOverlayAction(action, payload) {
  if (action === 'take-control') return takeComputerControl()
  if (action === 'resume-control') return resumeComputerControl()
  if (action === 'stop-control') return emergencyStopComputerControl()
  if (action === 'resolve-approval') {
    const requestId = requireText(payload?.requestId, 'requestId')
    const response = requireText(payload?.response, 'response')
    return resolveRuntimeRequest(requestId, response)
  }
  throw new Error(`Unsupported Computer overlay action: ${String(action)}`)
}

ipcMain.handle('desktop:computer-get-state', async () => {
  await getRuntimeHost()
  return requireComputerSystem().getSnapshot()
})
ipcMain.handle('desktop:computer-refresh', async () => {
  await getRuntimeHost()
  return requireComputerSystem().refresh()
})
ipcMain.handle('desktop:computer-request-permission', (_event, kind) => requestComputerPermission(requireComputerSystem(), requireText(kind, 'permission')))
ipcMain.handle('desktop:computer-open-permission-settings', (_event, kind) => openComputerPermissionSettings(requireComputerSystem(), requireText(kind, 'permission')))
ipcMain.handle('desktop:computer-relaunch', () => relaunchDesktopApplication())
ipcMain.handle('desktop:computer-take-control', () => takeComputerControl())
ipcMain.handle('desktop:computer-resume-control', () => resumeComputerControl())
ipcMain.handle('desktop:computer-emergency-stop', () => emergencyStopComputerControl())
ipcMain.handle('desktop:stop', async () => {
  const host = await getRuntimeHost()
  const conversationId = activeConversationId || host.getSnapshot().conversation.id
  const stopped = host.stopConversation(conversationId)
  if (browserSystem) await browserSystem.finishTask()
  if (computerSystem) await computerSystem.finishTask()
  return stopped
})
ipcMain.handle('desktop:pause', async () => {
  const host = await getRuntimeHost()
  const conversationId = activeConversationId || host.getSnapshot().conversation.id
  const paused = host.pauseConversation(conversationId)
  browserSystems.get(conversationId)?.pauseForRuntime()
  computerSystems.get(conversationId)?.pauseForRuntime()
  return paused
})
ipcMain.handle('desktop:resume', async () => {
  const host = await getRuntimeHost()
  const conversationId = activeConversationId || host.getSnapshot().conversation.id
  const resumed = host.resumeConversation(conversationId)
  if (resumed) {
    browserSystems.get(conversationId)?.resumeForRuntime()
    computerSystems.get(conversationId)?.resumeForRuntime()
  }
  return resumed
})
ipcMain.handle('desktop:control-work-step', async (_event, taskId, action) => {
  const allowed = new Set(['retry', 'skip', 'cancel', 'resume'])
  if (!allowed.has(action)) throw new Error(`Unsupported work step action: ${String(action)}`)
  return (await getRuntimeHost()).controlWorkStep(requireText(taskId, 'taskId'), action)
})
ipcMain.handle('desktop:resolve-request', async (_event, requestId, response) => (
  resolveRuntimeRequest(requireText(requestId, 'requestId'), requireText(response, 'response'))
))
ipcMain.handle('desktop:new-conversation', async () => {
  return startNewConversation()
})
ipcMain.handle('desktop:new-project-conversation', async (_event, id) => {
  const host = await getRuntimeHost()
  try {
    const result = await host.newConversationInProject(requireText(id, 'projectId'))
    activateConversationSystems(result.id)
    return result
  } finally {
    reconcileConversationSystems(host.getSnapshot())
  }
})
ipcMain.handle('desktop:switch-conversation', async (_event, id) => {
  const result = await (await getRuntimeHost()).switchConversation(requireText(id, 'conversationId'))
  activateConversationSystems(result.id)
  return result
})
ipcMain.handle('desktop:delete-conversation', async (_event, id) => {
  const conversationId = requireText(id, 'conversationId')
  const host = await getRuntimeHost()
  const deleted = await host.deleteConversation(conversationId)
  if (deleted) destroyConversationSystems(conversationId)
  const snapshot = host.getSnapshot()
  activateConversationSystems(snapshot.conversation.id)
  return deleted
})
ipcMain.handle('desktop:rename-conversation', async (_event, id, title) => (
  (await getRuntimeHost()).renameConversation(requireText(id, 'conversationId'), requireText(title, 'title'))
))
ipcMain.handle('desktop:git-stage', async (_event, paths) => (
  (await getRuntimeHost()).stageGit(requireTextArray(paths, 'paths'))
))
ipcMain.handle('desktop:git-unstage', async (_event, paths) => (
  (await getRuntimeHost()).unstageGit(requireTextArray(paths, 'paths'))
))
ipcMain.handle('desktop:git-commit', async (_event, message, paths) => (
  (await getRuntimeHost()).commitGit(requireText(message, 'message'), paths === undefined ? undefined : requireTextArray(paths, 'paths'))
))
ipcMain.handle('desktop:git-create-branch', async (_event, name, startPoint) => (
  (await getRuntimeHost()).createGitBranch(requireText(name, 'name'), typeof startPoint === 'string' && startPoint.trim() ? startPoint.trim() : undefined)
))
ipcMain.handle('desktop:git-switch-branch', async (_event, name) => (
  (await getRuntimeHost()).switchGitBranch(requireText(name, 'name'))
))
ipcMain.handle('desktop:git-restore', async (_event, paths, source) => (
  (await getRuntimeHost()).restoreGit(requireTextArray(paths, 'paths'), typeof source === 'string' && source.trim() ? source.trim() : undefined)
))
ipcMain.handle('desktop:git-push', async (_event, remote, branch, setUpstream) => (
  (await getRuntimeHost()).pushGit(
    typeof remote === 'string' && remote.trim() ? remote.trim() : undefined,
    typeof branch === 'string' && branch.trim() ? branch.trim() : undefined,
    setUpstream === true,
  )
))
ipcMain.handle('desktop:git-diff', async (_event, path, scope) => (
  (await getRuntimeHost()).readGitDiff(
    typeof path === 'string' && path.trim() ? path.trim() : undefined,
    ['working', 'staged', 'all'].includes(scope) ? scope : 'working',
  )
))
ipcMain.handle('desktop:add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '添加项目文件夹', properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  return (await getRuntimeHost()).addProject(result.filePaths[0])
})
ipcMain.handle('desktop:create-automation', async (_event, input) => {
  if (!input || typeof input !== 'object') throw new Error('Invalid automation input')
  return (await getRuntimeHost()).createAutomation(input)
})
ipcMain.handle('desktop:preview-automation-schedule', async (_event, schedule, timezone, count) => {
  if (!schedule || typeof schedule !== 'object') throw new Error('Invalid automation schedule')
  const normalizedCount = count === undefined ? 5 : Math.max(1, Math.min(20, Math.floor(Number(count))))
  return (await getRuntimeHost()).previewAutomationSchedule(schedule, requireText(timezone, 'timezone'), normalizedCount)
})
ipcMain.handle('desktop:list-automation-definitions', async (_event, query) => (
  (await getRuntimeHost()).listAutomationDefinitions(query && typeof query === 'object' ? query : undefined)
))
ipcMain.handle('desktop:get-automation-definition', async (_event, id) => (
  (await getRuntimeHost()).getAutomationDefinition(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:save-automation-draft', async (_event, input) => {
  if (!input || typeof input !== 'object') throw new Error('Invalid automation draft')
  return (await getRuntimeHost()).saveAutomationDraft(input)
})
ipcMain.handle('desktop:validate-automation-definition', async (_event, id) => (
  (await getRuntimeHost()).validateAutomationDefinition(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:publish-automation-definition', async (_event, id, expectedRevision) => {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer')
  return (await getRuntimeHost()).publishAutomationDefinition(requireText(id, 'automationId'), expectedRevision)
})
ipcMain.handle('desktop:set-automation-definition-status', async (_event, id, status) => {
  if (!['draft', 'testing', 'paused', 'archived'].includes(status)) throw new Error('Invalid automation definition status')
  return (await getRuntimeHost()).setAutomationDefinitionStatus(requireText(id, 'automationId'), status)
})
ipcMain.handle('desktop:rollback-automation-definition', async (_event, id, targetRevision, expectedRevision) => {
  if (!Number.isInteger(targetRevision) || targetRevision < 1) throw new Error('targetRevision must be a positive integer')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer')
  return (await getRuntimeHost()).rollbackAutomationDefinition(requireText(id, 'automationId'), targetRevision, expectedRevision)
})
ipcMain.handle('desktop:reset-automation-continuation-conversation', async (_event, id, expectedRevision) => {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer')
  return (await getRuntimeHost()).resetAutomationContinuationConversation(requireText(id, 'automationId'), expectedRevision)
})
ipcMain.handle('desktop:list-automation-runs', async (_event, query) => (
  (await getRuntimeHost()).listAutomationRuns(query && typeof query === 'object' ? query : undefined)
))
ipcMain.handle('desktop:get-automation-run', async (_event, runId) => (
  (await getRuntimeHost()).getAutomationRun(requireText(runId, 'automationRunId'))
))
ipcMain.handle('desktop:set-automation-run-pinned', async (_event, runId, pinned) => {
  if (typeof pinned !== 'boolean') throw new Error('Invalid automation run pin state')
  return (await getRuntimeHost()).setAutomationRunPinned(requireText(runId, 'automationRunId'), pinned)
})
ipcMain.handle('desktop:resolve-automation-approval', async (_event, approvalId, response) => (
  (await getRuntimeHost()).resolveAutomationApproval(
    requireText(approvalId, 'approvalId'),
    requireText(response, 'response'),
    'desktop',
  )
))
ipcMain.handle('desktop:update-automation', async (_event, id, patch) => (
  (await getRuntimeHost()).updateAutomation(requireText(id, 'automationId'), patch && typeof patch === 'object' ? patch : {})
))
ipcMain.handle('desktop:remove-automation', async (_event, id) => (
  (await getRuntimeHost()).removeAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:archive-automation-definition', async (_event, id, options) => {
  if (!options || typeof options !== 'object') throw new Error('Invalid automation archive options')
  return (await getRuntimeHost()).archiveAutomationDefinition(requireText(id, 'automationId'), {
    deleteRuns: options.deleteRuns === true,
    deleteConversations: options.deleteConversations === true,
    deleteMemory: options.deleteMemory === true,
  })
})
ipcMain.handle('desktop:duplicate-automation', async (_event, id) => (
  (await getRuntimeHost()).duplicateAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:run-automation', async (_event, id) => (
  (await getRuntimeHost()).runAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:test-automation', async (_event, id) => (
  (await getRuntimeHost()).testAutomation(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:retry-automation-run', async (_event, id, runId) => (
  (await getRuntimeHost()).retryAutomationRun(requireText(id, 'automationId'), requireText(runId, 'automationRunId'))
))
ipcMain.handle('desktop:recover-automation-run', async (_event, runId, action) => {
  if (!['resume_without_replay', 'retry_idempotent'].includes(action)) throw new Error('Invalid automation recovery action')
  return (await getRuntimeHost()).recoverAutomationRun(requireText(runId, 'automationRunId'), action)
})
ipcMain.handle('desktop:abandon-automation-run-recovery', async (_event, runId) => (
  (await getRuntimeHost()).abandonAutomationRunRecovery(requireText(runId, 'automationRunId'))
))
ipcMain.handle('desktop:cancel-automation-run', async (_event, id) => (
  (await getRuntimeHost()).cancelAutomationRun(requireText(id, 'automationId'))
))
ipcMain.handle('desktop:take-over-automation-run', async (_event, id) => {
  const result = await (await getRuntimeHost()).takeOverAutomationRun(requireText(id, 'automationId'))
  activateConversationSystems(result.id, result.snapshot)
  return result
})
ipcMain.handle('desktop:preview-artifact', async (_event, id, purpose) => (
  (await getRuntimeHost()).previewArtifact(requireText(id, 'artifactId'), purpose === 'thumbnail' ? 'thumbnail' : 'full')
))
ipcMain.handle('desktop:preview-image-attachment', async (_event, filePath, purpose) => (
  (await getRuntimeHost()).previewImageAttachment(requireText(filePath, 'attachmentPath'), purpose === 'thumbnail' ? 'thumbnail' : 'full')
))
ipcMain.handle('desktop:open-artifact', async (_event, id) => {
  const artifact = (await getRuntimeHost()).getArtifact(requireText(id, 'artifactId'))
  if (!artifact?.available) throw new Error('Artifact is unavailable')
  const error = await shell.openPath(artifact.path)
  if (error) throw new Error(error)
  return true
})
ipcMain.handle('desktop:reveal-artifact', async (_event, id) => {
  const artifact = (await getRuntimeHost()).getArtifact(requireText(id, 'artifactId'))
  if (!artifact?.available) throw new Error('Artifact is unavailable')
  shell.showItemInFolder(artifact.path)
  return true
})
ipcMain.handle('desktop:export-artifact', async (_event, id) => {
  const artifact = (await getRuntimeHost()).getArtifact(requireText(id, 'artifactId'))
  if (!artifact?.available) throw new Error('Artifact is unavailable')
  const result = await dialog.showSaveDialog(mainWindow, { title: '导出产物', defaultPath: basename(artifact.path) })
  if (result.canceled || !result.filePath) return null
  await copyFile(artifact.path, result.filePath)
  return result.filePath
})
ipcMain.handle('desktop:export-image-attachment', async (_event, filePath) => {
  const attachment = await (await getRuntimeHost()).resolveImageAttachment(requireText(filePath, 'attachmentPath'))
  const result = await dialog.showSaveDialog(mainWindow, { title: '导出图片', defaultPath: attachment.filename })
  if (result.canceled || !result.filePath) return null
  await copyFile(attachment.path, result.filePath)
  return result.filePath
})
ipcMain.handle('desktop:remove-artifact', async (_event, id) => (
  (await getRuntimeHost()).removeArtifact(requireText(id, 'artifactId'))
))
ipcMain.handle('desktop:list-plugins', async () => (await getRuntimeHost()).listPlugins())
ipcMain.handle('desktop:retry-persistence', async () => (await getRuntimeHost()).retryPersistence())
ipcMain.handle('desktop:export-recovery', async () => {
  const result = await dialog.showSaveDialog({
    title: '导出 TurboFlux 恢复包',
    defaultPath: `turboflux-recovery-${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return null
  return (await getRuntimeHost()).exportRecoveryBundle(result.filePath)
})
ipcMain.handle('desktop:list-work-packs', async () => (await getRuntimeHost()).listWorkPacks())
ipcMain.handle('desktop:refresh-work-packs', async () => (await getRuntimeHost()).refreshWorkPacks())
ipcMain.handle('desktop:install-local-plugin', async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '选择 TurboFlux 插件文件夹',
    properties: ['openDirectory'],
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  const host = await getRuntimeHost()
  const inspected = await host.inspectPlugin(selection.filePaths[0])
  const permissions = inspected.manifest.permissions || []
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: inspected.manifest.main || permissions.length ? 'warning' : 'info',
    title: `安装 ${inspected.manifest.name}`,
    message: inspected.manifest.main ? '此插件包含会在独立沙箱中运行的代码' : '此插件只包含声明式能力',
    detail: [
      `发布方：${inspected.manifest.author.name}`,
      `版本：${inspected.manifest.version}`,
      `来源：${inspected.path}`,
      permissions.length ? `请求权限：\n${permissions.join('\n')}` : '无需额外权限',
    ].join('\n\n'),
    buttons: ['取消', permissions.length ? '安装并授权' : '安装'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (confirmation.response !== 1) return null
  return host.installLocalPlugin(inspected.path, permissions)
})
ipcMain.handle('desktop:set-work-pack-enabled', async (_event, workPackId, enabled) => (
  (await getRuntimeHost()).setWorkPackEnabled(requireText(workPackId, 'workPackId'), enabled === true)
))
ipcMain.handle('desktop:uninstall-work-pack', async (_event, workPackId) => (
  (await getRuntimeHost()).uninstallWorkPack(requireText(workPackId, 'workPackId'))
))
ipcMain.handle('desktop:reconnect-mcp', async (_event, name) => (
  (await getRuntimeHost()).reconnectMcp(requireText(name, 'serverName'))
))
ipcMain.handle('desktop:acknowledge-notification', async (_event, id) => (
  (await getRuntimeHost()).acknowledgeNotification(requireText(id, 'notificationId'))
))
ipcMain.handle('desktop:list-memories', async (_event, filters, forceReload) => (
  (await getRuntimeHost()).listMemories(filters && typeof filters === 'object' ? filters : undefined, forceReload === true)
))
ipcMain.handle('desktop:remember-memory', async (_event, input) => {
  if (!input || typeof input !== 'object') throw new Error('memory input must be an object')
  return (await getRuntimeHost()).rememberMemory({ ...input, text: requireText(input.text, 'memory text') })
})
ipcMain.handle('desktop:update-memory', async (_event, id, update) => {
  if (!update || typeof update !== 'object') throw new Error('memory update must be an object')
  return (await getRuntimeHost()).updateMemory(requireText(id, 'memory id'), update)
})
ipcMain.handle('desktop:forget-memory', async (_event, id, reason) => (
  (await getRuntimeHost()).forgetMemory(requireText(id, 'memory id'), typeof reason === 'string' ? reason.slice(0, 240) : undefined)
))
ipcMain.handle('desktop:choose-files', async () => {
  const result = await dialog.showOpenDialog({
    title: '向当前任务添加文件',
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled) return []
  return (await getRuntimeHost()).importFiles(result.filePaths)
})
ipcMain.handle('desktop:import-files', async (_event, paths) => {
  if (!Array.isArray(paths)) return []
  return (await getRuntimeHost()).importFiles(paths.filter(path => typeof path === 'string'))
})
ipcMain.handle('desktop:import-clipboard-image', async (_event, base64, mime, filename) => (
  (await getRuntimeHost()).importClipboardImage(
    requireText(base64, 'imageData'),
    requireText(mime, 'mime'),
    typeof filename === 'string' && filename ? filename : 'clipboard.png',
  )
))
ipcMain.handle('desktop:choose-workspace', async () => {
  return chooseWorkspace()
})
ipcMain.handle('desktop:choose-automation-workspace', async () => {
  return chooseAutomationWorkspace()
})

app.setName('TurboFlux')

function installProductMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'TurboFlux',
      submenu: [
        { role: 'about', label: '关于 TurboFlux' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 TurboFlux' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 TurboFlux' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => void startNewConversation() },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => void chooseWorkspace() },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'togglefullscreen', label: '进入全屏幕' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] : [])] },
    { label: '帮助', submenu: [{ label: 'TurboFlux 官网', click: () => void shell.openExternal('https://turbofluxai.com') }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function applyProductDockIcon() {
  if (process.platform !== 'darwin') return
  if (hiddenQaWindow) {
    app.dock.hide()
    return
  }
  app.dock.setIcon(productIconPath)
  void app.dock.show()
}

if (ownsSingleInstanceLock) app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

if (ownsSingleInstanceLock) app.whenReady().then(async () => {
  applyActiveProfileContext(await getActiveProfileContext())
  app.setAboutPanelOptions({ applicationName: 'TurboFlux', applicationVersion: app.getVersion(), copyright: 'TurboFlux' })
  if (app.isPackaged) await getRemoteHostManager()
  installProductMenu()
  applyProductDockIcon()
  await installBackgroundMediaProtocol()
  disposeDesktopPowerLifecycle = installDesktopPowerLifecycle(powerMonitor, {
    onSuspend: () => {
      desktopPowerLifecycleEpoch += 1
      desktopPowerSuspended = true
      runtimeHost?.suspendForSystemSleep()
    },
    onResume: async () => {
      const resumeEpoch = ++desktopPowerLifecycleEpoch
      desktopPowerSuspended = false
      const host = runtimeHost ?? (runtimeHostPromise ? await runtimeHostPromise.catch(() => undefined) : undefined)
      if (desktopPowerSuspended || desktopPowerLifecycleEpoch !== resumeEpoch) return
      await host?.resumeAfterSystemSleep()
    },
    onError: error => console.error('Failed to coordinate the Desktop power lifecycle:', error),
  })
  createWindow()
  app.on('activate', () => {
    applyProductDockIcon()
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (effectiveCloseWindowBehavior(desktopHostPreferences) === 'quit') app.quit()
})

app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = (async () => {
    const host = runtimeHost ?? (runtimeHostPromise ? await runtimeHostPromise.catch(() => undefined) : undefined)
    const activeRuns = host ? host.getSnapshot().automations.scheduler.activeRuns : 0
    let behavior = desktopHostPreferences.activeRunQuitBehavior
    if (activeRuns > 0 && behavior === 'ask') {
      const quitDialogOptions = {
        type: 'warning',
        title: '仍有自动化正在运行',
        message: `${activeRuns} 个自动化 Run 尚未结束`,
        detail: '可以等待它们完成，或保存检查点并中断；取消退出不会改变当前运行。',
        buttons: ['等待完成后退出', '保存并中断', '取消退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, quitDialogOptions)
        : await dialog.showMessageBox(quitDialogOptions)
      if (result.response === 2) return false
      behavior = result.response === 0 ? 'wait' : 'interrupt'
    }
    if (host && activeRuns > 0) await host.prepareForApplicationQuit(behavior === 'wait' ? 'wait' : 'interrupt')
    await shutdownDesktopApplication()
    return true
  })().then(completed => {
    if (!completed) {
      shutdownPromise = undefined
      return
    }
    shutdownComplete = true
    app.quit()
  }).catch(error => {
    console.error('Failed to shut down the desktop runtime cleanly:', error)
    shutdownPromise = undefined
  })
})
