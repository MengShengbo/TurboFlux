import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TurboFluxArtifactLike, TurboFluxAutomationApprovalLike, TurboFluxRemoteSnapshotLike } from '@turboflux/remote-protocol'
import { DesktopRemoteHostManager, type DesktopRemoteHostStatus } from '../apps/desktop/remote/remoteHostManager'
import { verifyRemoteMobileEvidence } from './verify-remote-mobile-evidence.mjs'
import { captureGithubActionsProvenance } from './github-actions-provenance.mjs'
import { discoverPackagedExecutable, verifyPackagedExecutableIdentity } from './desktop-packaged-executable.mjs'
import { projectEvidenceFields, writeSourceEvidenceReportAtomically } from './source-evidence-report.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mobileRoot = join(repositoryRoot, 'apps', 'remote-mobile')
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const mobileWebRoot = join(mobileRoot, 'dist')
const releaseRoot = join(repositoryRoot, 'release')
const defaultPackageReport = join(desktopRoot, 'generated', 'package-verification', 'package-report.json')
const evidenceRoot = join(mobileRoot, 'generated', 'automation-qa', `${process.platform}-${process.arch}`)
const electronEntry = join(repositoryRoot, 'scripts', 'remote-mobile-hidden-qa-electron.mjs')
const desktopRequire = createRequire(join(repositoryRoot, 'apps', 'desktop', 'package.json'))
const electron = desktopRequire('electron') as string

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Remote Mobile hidden QA failed: ${message}`)
}

function parseArguments(argumentsList: string[]) {
  const options: { packageCorrelated: boolean; executable?: string; packageReport: string } = {
    packageCorrelated: false,
    packageReport: defaultPackageReport,
  }
  for (const argument of argumentsList) {
    if (argument === '--package-correlated') options.packageCorrelated = true
    else if (argument.startsWith('--executable=')) {
      options.packageCorrelated = true
      options.executable = resolve(argument.slice('--executable='.length))
    } else if (argument.startsWith('--package-report=')) {
      options.packageReport = resolve(argument.slice('--package-report='.length))
    } else invariant(false, `unknown argument: ${argument}`)
  }
  return options
}

async function packageIdentity(options: ReturnType<typeof parseArguments>) {
  if (!options.packageCorrelated) return null
  const executable = await discoverPackagedExecutable({
    executable: options.executable,
    releaseRoot,
    platform: process.platform,
    arch: process.arch,
  })
  return verifyPackagedExecutableIdentity({
    executable,
    packageReport: options.packageReport,
    repositoryRoot,
    platform: process.platform,
    arch: process.arch,
    remoteMobileRoot: mobileWebRoot,
  })
}

const rendererEvidenceSchema = {
  windowNeverFocused: true,
  workspace: {
    viewport: { width: true, height: true, devicePixelRatio: true },
    document: { width: true, height: true },
    hasFocus: true,
    secureContext: true,
    shell: { x: true, y: true, width: true, height: true },
    header: { x: true, y: true, width: true, height: true },
    conversation: { x: true, y: true, width: true, height: true },
    approval: { x: true, y: true, width: true, height: true },
    artifact: { x: true, y: true, width: true, height: true },
    composer: { x: true, y: true, width: true, height: true },
    approvalVisibility: {
      width: true,
      height: true,
      hitWithinTarget: true,
      ancestors: [{ display: true, visibility: true, opacity: true }],
    },
    text: true,
  },
  drawer: {
    viewport: { width: true, height: true },
    documentWidth: true,
    hasFocus: true,
    rect: { x: true, y: true, width: true, height: true },
  },
  darkReducedMotion: {
    dark: true,
    reducedMotion: true,
    animationDuration: true,
    transitionDuration: true,
    documentWidth: true,
    viewportWidth: true,
    hasFocus: true,
  },
  interaction: {
    artifactClicked: true,
    artifactDownloadPrevented: true,
    artifactDownloadName: true,
    artifactDownloadMime: true,
    approvalClicked: true,
    approvalCardsAfterResolution: true,
  },
  rendererErrors: [true],
  screenshots: [true],
}

class QaRuntime {
  private readonly listeners = new Set<(event: unknown) => void>()
  readonly approvals: TurboFluxAutomationApprovalLike[]
  readonly artifact: TurboFluxArtifactLike
  readonly snapshot: TurboFluxRemoteSnapshotLike
  readonly resolvedApprovals: Array<{
    approvalId: string
    response: string
    channel: 'remote'
    deviceId?: string
  }> = []
  readonly artifactReadIds: string[] = []

  constructor(workspacePath: string, artifactPath: string) {
    const now = Date.now()
    this.snapshot = {
      workspace: { path: workspacePath, name: 'Automation Lab' },
      runtime: { status: 'running', pendingRequests: [] },
      conversation: {
        id: 'remote-qa-session',
        turns: [
          { id: 'turn-user', role: 'user', content: '生成今日自动化验收报告。', timestamp: now - 30_000 },
          { id: 'turn-assistant', role: 'assistant', content: '报告已经生成，正在等待你确认浏览器发布步骤。', timestamp: now - 15_000 },
        ],
      },
      conversationCatalog: [
        { id: 'remote-qa-session', title: '自动化日报', workspacePath, updatedAt: now },
        { id: 'remote-qa-secondary', title: '每周质量复盘', workspacePath, updatedAt: now - 60_000 },
      ],
      conversationRuntimes: [
        { conversationId: 'remote-qa-session', status: 'awaiting-action', updatedAt: now },
        { conversationId: 'remote-qa-secondary', status: 'ready', updatedAt: now - 60_000 },
      ],
      artifacts: { artifacts: [] },
    }
    this.approvals = [{
      id: 'remote-qa-approval',
      sessionId: 'remote-qa-session',
      automationName: '自动化日报',
      runId: 'remote-qa-run',
      workspacePath,
      kind: 'permission',
      question: '自动化日报请求执行受控浏览器发布操作',
      options: ['allow-once', 'deny'],
      toolName: 'browser_publish',
      riskCategory: 'computer',
      targetSummary: '浏览器发布 · 仅当前验收页面',
      requestedAt: now,
      expiresAt: now + 10 * 60_000,
    }]
    this.artifact = {
      id: 'remote-qa-artifact',
      name: '验收报告.pdf',
      path: artifactPath,
      workspacePath,
      kind: 'pdf',
      mime: 'application/pdf',
      size: 24,
      updatedAt: now,
      available: true,
      conversationId: 'remote-qa-session',
      taskId: 'remote-qa-run',
    }
    this.snapshot.artifacts.artifacts.push(this.artifact)
  }

  getSnapshot() { return this.snapshot }
  subscribe(listener: (event: unknown) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  submitPromptToConversation() { return { status: 'started' } }
  controlConversation() { return true }
  newConversation() { return undefined }
  switchConversation() { return undefined }
  activateRemoteSession(id: string) { this.snapshot.conversation.id = id }
  resolveRequestForConversation() { return true }
  listRemoteAutomationApprovals() {
    const resolvedIds = new Set(this.resolvedApprovals.map(item => item.approvalId))
    return this.approvals.filter(approval => !resolvedIds.has(approval.id))
  }
  resolveAutomationApproval(id: string, response: string, channel: 'remote', deviceId?: string) {
    this.resolvedApprovals.push({ approvalId: id, response, channel, deviceId })
  }
  getArtifact(id: string) {
    if (id !== this.artifact.id) return null
    if (!this.artifactReadIds.includes(id)) this.artifactReadIds.push(id)
    return this.artifact
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('hidden Electron verifier timed out'))
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal }) })
  })
}

async function main(options = parseArguments(process.argv.slice(2))) {
  await readFile(join(mobileWebRoot, 'index.html'))
  const verifiedPackage = await packageIdentity(options)
  const qaRoot = await mkdtemp(join(tmpdir(), 'turboflux-remote-mobile-hidden-qa-'))
  await Promise.all([
    'remote-mobile-evidence-report.json',
    'remote-mobile-evidence-report-darwin.json',
    'remote-mobile-evidence-report-win32.json',
  ].map(name => rm(join(dirname(evidenceRoot), name), { force: true })))
  await rm(evidenceRoot, { recursive: true, force: true })
  await mkdir(evidenceRoot, { recursive: true })
  const artifactPath = join(qaRoot, 'workspace', 'acceptance.pdf')
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, '%PDF-1.4 TurboFlux QA\n')
  const runtime = new QaRuntime(dirname(artifactPath), artifactPath)
  const manager = new DesktopRemoteHostManager({
    userDataPath: join(qaRoot, 'desktop-state'),
    displayName: 'TurboFlux QA Mac',
    stateProtection: { protect: value => value, unprotect: value => value },
    port: 0,
    mobileWebRoot,
  })
  const rendererTemporaryRoot = join(qaRoot, 'renderer-evidence')
  const rendererResultPath = join(rendererTemporaryRoot, 'renderer-result.json')
  const diagnosticPath = join(rendererTemporaryRoot, 'diagnostic.json')
  await mkdir(rendererTemporaryRoot, { recursive: true })
  let child: ReturnType<typeof spawn> | undefined
  try {
    await manager.initialize()
    await manager.attachRuntime(runtime)
    await manager.setEnabled(true)
    const status = manager.status()
    invariant(status.active && status.localEndpointUrl, 'Desktop Remote Host did not start')
    const pairing = await manager.createPairingCode()
    const targetUrl = `${status.localEndpointUrl}/#${new URLSearchParams({ pair: pairing.code })}`
    child = spawn(electron, [
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      `--user-data-dir=${join(qaRoot, 'electron')}`,
      electronEntry,
    ], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      env: {
        ...process.env,
        TURBOFLUX_REMOTE_MOBILE_QA_URL: targetUrl,
        TURBOFLUX_REMOTE_MOBILE_QA_EVIDENCE: evidenceRoot,
        TURBOFLUX_REMOTE_MOBILE_QA_TEMP: rendererTemporaryRoot,
      },
    })

    const exitPromise = waitForExit(child, 30_000)
    const approvePendingPairing = async (attempt: number): Promise<DesktopRemoteHostStatus['pendingPairings'][number] | undefined> => {
      if (attempt >= 300 || child!.exitCode !== null || child!.signalCode !== null) return undefined
      const pending = manager.status().pendingPairings[0]
      if (pending) {
        await manager.approvePairing(pending.requestId)
        return pending
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      return approvePendingPairing(attempt + 1)
    }
    const approvedPairing = await approvePendingPairing(0)
    invariant(approvedPairing, 'Desktop never received a pairing approval request')
    const exit = await exitPromise
    invariant(exit.code === 0, 'hidden Electron did not exit cleanly')

    const rendererResult = JSON.parse(await readFile(rendererResultPath, 'utf8')) as Record<string, unknown>
    const finalStatus = manager.status()
    invariant(finalStatus.pairedDevices.length === 1, 'approved device was not persisted')
    invariant(Boolean(finalStatus.controlSession), 'mobile page did not claim the control session')
    invariant(runtime.resolvedApprovals.length === 1, 'mobile page did not resolve exactly one automation approval')
    invariant(runtime.artifactReadIds.length === 1, 'mobile page did not read exactly one artifact identity')
    const pairedDevice = finalStatus.pairedDevices[0]!
    const controlSession = finalStatus.controlSession!
    const approval = runtime.approvals[0]!
    const result = {
      schemaVersion: 3,
      mode: 'hidden-electron-remote-mobile',
      platform: process.platform,
      arch: process.arch,
      provenance: captureGithubActionsProvenance(),
      hostApplicationMode: 'development-electron',
      packageEvidence: verifiedPackage,
      ...projectEvidenceFields(rendererResult, rendererEvidenceSchema),
      pairing: {
        approved: true,
        requestId: approvedPairing.requestId,
        hostDeviceId: finalStatus.deviceId,
        requestedDeviceId: approvedPairing.deviceId,
        pairedDeviceId: pairedDevice.deviceId,
        controlDeviceId: controlSession.deviceId,
        controlClientInstanceId: controlSession.clientInstanceId,
        pairedDeviceCount: finalStatus.pairedDevices.length,
        controlSessionActive: true,
        workspaceId: pairing.workspaceId,
        requestedWorkspaceIds: approvedPairing.workspaceIds,
        grantedWorkspaceIds: pairedDevice.workspaceIds,
        workspaceRestricted: pairing.workspaceId === finalStatus.workspaceId
          && approvedPairing.workspaceIds.length === 1
          && approvedPairing.workspaceIds[0] === pairing.workspaceId
          && pairedDevice.workspaceIds.length === 1
          && pairedDevice.workspaceIds[0] === pairing.workspaceId,
        offeredCapabilities: pairing.capabilities,
        requestedCapabilities: approvedPairing.capabilities,
        grantedCapabilities: pairedDevice.capabilities,
      },
      workflow: {
        sessionId: runtime.snapshot.conversation.id,
        activeSessionId: runtime.snapshot.conversation.id,
        sessionIds: runtime.snapshot.conversationCatalog.map(item => item.id),
        messageIds: runtime.snapshot.conversation.turns.map(item => item.id),
        approval: {
          id: approval.id,
          sessionId: approval.sessionId,
          runId: approval.runId,
        },
        artifact: {
          id: runtime.artifact.id,
          sessionId: runtime.artifact.conversationId,
          runId: runtime.artifact.taskId,
        },
        resolution: runtime.resolvedApprovals[0],
        remainingApprovalIds: runtime.listRemoteAutomationApprovals().map(item => item.id),
        artifactReadIds: runtime.artifactReadIds,
      },
    }
    await writeSourceEvidenceReportAtomically(join(evidenceRoot, 'result.json'), result)
    await rm(rendererResultPath, { force: true })
    await rm(diagnosticPath, { force: true })
    const report = await verifyRemoteMobileEvidence({
      evidenceRoot: join(mobileRoot, 'generated', 'automation-qa'),
      requiredPlatforms: [process.platform],
    })
    invariant(report.status === 'passed', report.errors.join('; '))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child) {
      await waitForExit(child, 5_000).catch(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await waitForExit(child, 2_000).catch(() => undefined)
      })
    }
    await Promise.all([rm(rendererResultPath, { force: true }), rm(diagnosticPath, { force: true })])
    await manager.close().catch(() => undefined)
    await rm(qaRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch {
    process.stderr.write('Remote Mobile hidden QA failed\n')
    process.exitCode = 1
  }
}
