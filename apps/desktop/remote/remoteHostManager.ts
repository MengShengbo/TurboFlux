import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode/lib/browser.js'
import {
  isSecureBrowserHttpEndpoint,
  NodeRemoteStateStore,
  RemoteHostStateUnreadableError,
  RemoteHostService,
  RemoteHttpGateway,
  turboFluxWorkspaceId,
  type NodeRemoteStateStoreOptions,
  type RemoteCapability,
  type RemoteControlSessionSummary,
  type RemotePairedDeviceSummary,
  type RemotePendingPairingSummary,
  type TurboFluxRemoteRuntime,
} from '@turboflux/remote-protocol'

const DEFAULT_REMOTE_PORT = 48_173
const DEFAULT_REMOTE_CONTROL_GRANT_TTL_MS = 12 * 60 * 60_000
const REMOTE_STORAGE_UNAVAILABLE_ERROR = '系统安全存储不可用，无法安全保存远程设备身份和重启幂等状态'
const REMOTE_IDENTITY_UNREADABLE_ERROR = '远程身份无法解密，可能来自其他系统钥匙串。请重置远程身份后重新配对。'
const DEFAULT_CAPABILITIES: RemoteCapability[] = [
  'session.read',
  'session.create',
  'session.submit',
  'session.steer',
  'session.control',
  'approval.resolve',
  'artifact.list',
  'artifact.read',
]

interface RemotePreferences {
  schemaVersion: 1
  enabled: boolean
  port: number
  publicEndpoint?: string
  clientUrl?: string
}

export interface DesktopRemoteHostStatus {
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
  controlSession?: RemoteControlSessionSummary
  pendingPairings: RemotePendingPairingSummary[]
  pairedDevices: RemotePairedDeviceSummary[]
  recoveryRequired: boolean
  error?: string
}

export interface DesktopRemotePairingCode {
  code: string
  url?: string
  qrDataUrl: string
  expiresAt: number
  endpointUrls: string[]
  workspaceId: string
  capabilities: RemoteCapability[]
}

export interface DesktopRemoteHostManagerOptions {
  userDataPath: string
  displayName: string
  stateProtection?: NodeRemoteStateStoreOptions
  port?: number
  publicEndpoint?: string
  clientUrl?: string
  mobileWebRoot?: string
  now?: () => number
}

function validPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : DEFAULT_REMOTE_PORT
}

function normalizedPublicEndpoint(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (!isSecureBrowserHttpEndpoint(trimmed)) {
    throw new Error('手机浏览器公开入口必须使用 HTTPS；HTTP 只允许 localhost 调试')
  }
  return new URL(trimmed).href.replace(/\/+$/u, '')
}

function normalizedClientUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (!isSecureBrowserHttpEndpoint(trimmed)) {
    throw new Error('Web 控制页必须使用 HTTPS；HTTP 只允许 localhost 调试')
  }
  const url = new URL(trimmed)
  url.hash = ''
  return url.href
}

function pairingUrl(clientUrl: string | undefined, code: string): string | undefined {
  if (!clientUrl) return undefined
  const url = new URL(clientUrl)
  url.hash = new URLSearchParams({ pair: code }).toString()
  return url.href
}

async function pairingQrDataUrl(value: string): Promise<string> {
  const svg = await QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 320 })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export class DesktopRemoteHostManager<TEvent = unknown> {
  private runtime: TurboFluxRemoteRuntime<TEvent> | undefined
  private service: RemoteHostService<TEvent> | undefined
  private gateway: RemoteHttpGateway<TEvent> | undefined
  private preferences: RemotePreferences
  private endpointUrls: string[] = []
  private localEndpointUrl: string | undefined
  private readonly allowedHosts: string[] = []
  private readonly allowedOrigins: string[] = []
  private error: string | undefined
  private recoveryRequired = false
  private transition: Promise<void> = Promise.resolve()
  private readonly preferencesPath: string
  private readonly statePath: string
  private readonly now: () => number
  private publicEndpoint: string | undefined
  private clientUrl: string | undefined

  constructor(private readonly options: DesktopRemoteHostManagerOptions) {
    this.preferencesPath = join(options.userDataPath, 'remote', 'preferences.json')
    this.statePath = join(options.userDataPath, 'remote', 'host-state.json')
    this.now = options.now ?? Date.now
    this.publicEndpoint = normalizedPublicEndpoint(options.publicEndpoint)
    this.clientUrl = normalizedClientUrl(options.clientUrl)
    this.error = options.stateProtection ? undefined : REMOTE_STORAGE_UNAVAILABLE_ERROR
    this.refreshGatewayAccessRules()
    this.preferences = { schemaVersion: 1, enabled: false, port: validPort(options.port), publicEndpoint: this.publicEndpoint, clientUrl: this.clientUrl }
  }

  async initialize(): Promise<DesktopRemoteHostStatus> {
    try {
      const parsed = JSON.parse(await readFile(this.preferencesPath, 'utf8')) as Partial<RemotePreferences>
      if (parsed.schemaVersion === 1) {
        this.publicEndpoint = normalizedPublicEndpoint(parsed.publicEndpoint) ?? this.publicEndpoint
        this.clientUrl = normalizedClientUrl(parsed.clientUrl) ?? this.clientUrl
        this.refreshGatewayAccessRules()
        const disableForUnavailableStorage = parsed.enabled === true && !this.options.stateProtection
        this.preferences = { schemaVersion: 1, enabled: parsed.enabled === true && !disableForUnavailableStorage, port: validPort(parsed.port), publicEndpoint: this.publicEndpoint, clientUrl: this.clientUrl }
        if (disableForUnavailableStorage) await this.savePreferences()
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        this.error = error instanceof Error ? error.message : String(error)
      }
    }
    return this.status()
  }

  async attachRuntime(runtime: TurboFluxRemoteRuntime<TEvent>): Promise<DesktopRemoteHostStatus> {
    await this.enqueue(async () => {
      await this.stopActive()
      this.runtime = runtime
      if (this.preferences.enabled) {
        try {
          await this.startActive()
        } catch (error) {
          if (!(error instanceof RemoteHostStateUnreadableError)) throw error
          await this.enterIdentityRecovery()
        }
      }
    })
    return this.status()
  }

  async detachRuntime(): Promise<void> {
    await this.enqueue(async () => {
      await this.stopActive()
      this.runtime = undefined
    })
  }

  async setEnabled(enabled: boolean): Promise<DesktopRemoteHostStatus> {
    await this.enqueue(async () => {
      if (enabled) {
        if (!this.options.stateProtection) throw new Error(REMOTE_STORAGE_UNAVAILABLE_ERROR)
        this.preferences.enabled = true
        try {
          await this.savePreferences()
          await this.startActive()
        } catch (error) {
          if (error instanceof RemoteHostStateUnreadableError) {
            await this.enterIdentityRecovery()
            throw new Error(REMOTE_IDENTITY_UNREADABLE_ERROR)
          }
          this.preferences.enabled = false
          await this.stopActive().catch(() => undefined)
          await this.savePreferences().catch(() => undefined)
          throw error
        }
        return
      }
      this.preferences.enabled = false
      const errors: unknown[] = []
      await this.savePreferences().catch(error => errors.push(error))
      if (this.service) {
        await this.service.stopRemoteControlSession('Remote access was disabled on the desktop').catch(error => errors.push(error))
      }
      await this.stopActive().catch(error => errors.push(error))
      if (errors.length > 0) throw errors[0]
      this.error = undefined
    })
    return this.status()
  }

  status(): DesktopRemoteHostStatus {
    const snapshot = this.runtime?.getSnapshot()
    return {
      available: Boolean(this.options.stateProtection),
      enabled: this.preferences.enabled,
      active: Boolean(this.service && this.gateway),
      port: this.preferences.port,
      deviceId: this.service?.identity.publicIdentity.deviceId,
      displayName: this.service?.identity.publicIdentity.displayName,
      workspaceId: snapshot ? turboFluxWorkspaceId(snapshot.workspace.path) : undefined,
      workspaceName: snapshot?.workspace.name,
      endpointUrls: [...this.endpointUrls],
      localEndpointUrl: this.localEndpointUrl,
      publicEndpoint: this.publicEndpoint,
      clientUrl: this.clientUrl,
      controlSession: this.service?.controller.activeControlSession(),
      pendingPairings: this.service?.listPendingPairings() ?? [],
      pairedDevices: this.service?.listPairedDevices() ?? [],
      recoveryRequired: this.recoveryRequired,
      error: this.error,
    }
  }

  async resetRemoteIdentity(): Promise<DesktopRemoteHostStatus> {
    await this.enqueue(async () => {
      if (!this.recoveryRequired) throw new Error('远程身份当前无需重置')
      this.preferences.enabled = false
      await this.savePreferences()
      await this.stopActive()
      const backupPath = join(dirname(this.statePath), `host-state.unreadable-${this.now()}.json`)
      try {
        await rename(this.statePath, backupPath)
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      }
      this.recoveryRequired = false
      this.error = this.options.stateProtection ? undefined : REMOTE_STORAGE_UNAVAILABLE_ERROR
    })
    return this.status()
  }

  async createPairingCode(ttlMs = 5 * 60_000): Promise<DesktopRemotePairingCode> {
    if (!this.service || !this.gateway || !this.runtime) throw new Error('远程访问尚未启用')
    const snapshot = this.runtime.getSnapshot()
    const workspaceId = turboFluxWorkspaceId(snapshot.workspace.path)
    const endpointHints = this.endpointUrls.map(value => ({ kind: 'custom' as const, value }))
    this.service.refreshPairingInvites()
    const invite = this.service.createPairingInvite(DEFAULT_CAPABILITIES, endpointHints, ttlMs, {
      workspaceIds: [workspaceId],
      ttlMs: DEFAULT_REMOTE_CONTROL_GRANT_TTL_MS,
    })
    const code = this.service.createPairingCodeFromInvite(invite)
    const url = pairingUrl(this.clientUrl ?? this.publicEndpoint, code)
    return {
      code,
      url,
      qrDataUrl: await pairingQrDataUrl(url ?? code),
      expiresAt: invite.payload.expiresAt,
      endpointUrls: [...this.endpointUrls],
      workspaceId,
      capabilities: [...DEFAULT_CAPABILITIES],
    }
  }

  async revokeDevice(deviceId: string): Promise<DesktopRemoteHostStatus> {
    if (!this.service) throw new Error('远程访问尚未启用')
    await this.service.revokeDevice(deviceId)
    return this.status()
  }

  async stopRemoteControlSession(): Promise<DesktopRemoteHostStatus> {
    if (!this.service) throw new Error('远程访问尚未启用')
    await this.service.stopRemoteControlSession()
    return this.status()
  }

  async setPublicEndpoint(value: string | undefined): Promise<DesktopRemoteHostStatus> {
    await this.enqueue(async () => {
      this.publicEndpoint = normalizedPublicEndpoint(value)
      this.refreshGatewayAccessRules()
      this.preferences.publicEndpoint = this.publicEndpoint
      await this.savePreferences()
      if (this.service && this.gateway) {
        this.service.refreshPairingInvites('Remote endpoint changed on the desktop')
        this.refreshEndpointUrls(this.preferences.port)
      }
    })
    return this.status()
  }

  async setClientUrl(value: string | undefined): Promise<DesktopRemoteHostStatus> {
    await this.enqueue(async () => {
      this.clientUrl = normalizedClientUrl(value)
      this.refreshGatewayAccessRules()
      this.preferences.clientUrl = this.clientUrl
      await this.savePreferences()
      this.service?.refreshPairingInvites('Web control page changed on the desktop')
    })
    return this.status()
  }

  async approvePairing(requestId: string): Promise<DesktopRemoteHostStatus> {
    if (!this.service || !this.runtime) throw new Error('远程访问尚未启用')
    const pending = this.service.listPendingPairings().find(request => request.requestId === requestId)
    if (!pending) throw new Error('配对请求已失效或不再等待确认')
    const currentWorkspaceId = turboFluxWorkspaceId(this.runtime.getSnapshot().workspace.path)
    if (pending.workspaceIds.length > 0 && !pending.workspaceIds.includes(currentWorkspaceId)) {
      throw new Error('配对请求的工作区已经变化，请重新生成二维码')
    }
    await this.service.approvePairing(requestId, { workspaceIds: [currentWorkspaceId] })
    return this.status()
  }

  async rejectPairing(requestId: string): Promise<DesktopRemoteHostStatus> {
    if (!this.service) throw new Error('远程访问尚未启用')
    if (!await this.service.rejectPairing(requestId)) throw new Error('配对请求已失效或不再等待确认')
    return this.status()
  }

  async close(): Promise<void> {
    await this.detachRuntime()
  }

  private async startActive(): Promise<void> {
    if (this.service || !this.preferences.enabled) return
    if (!this.runtime) return
    if (!this.options.stateProtection) throw new Error(REMOTE_STORAGE_UNAVAILABLE_ERROR)
    const stateStore = new NodeRemoteStateStore(this.statePath, this.options.stateProtection)
    const service = await RemoteHostService.create({
      displayName: this.options.displayName,
      runtime: this.runtime,
      stateStore,
      now: this.now,
    })
    const gateway = new RemoteHttpGateway(service, {
      host: '127.0.0.1',
      port: this.preferences.port,
      webRoot: this.options.mobileWebRoot,
      allowedHosts: this.allowedHosts,
      allowedOrigins: this.allowedOrigins,
      pairing: {
        capabilities: DEFAULT_CAPABILITIES,
        ttlMs: DEFAULT_REMOTE_CONTROL_GRANT_TTL_MS,
      },
    })
    let gatewayStarted = false
    try {
      const endpoint = await gateway.start()
      gatewayStarted = true
      this.preferences.port = endpoint.port
      await this.savePreferences()
      this.refreshEndpointUrls(endpoint.port)
      this.service = service
      this.gateway = gateway
      this.error = undefined
    } catch (error) {
      if (gatewayStarted) await gateway.close().catch(() => undefined)
      service.close()
      this.endpointUrls = []
      this.localEndpointUrl = undefined
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async stopActive(): Promise<void> {
    const gateway = this.gateway
    const service = this.service
    this.gateway = undefined
    this.service = undefined
    this.endpointUrls = []
    this.localEndpointUrl = undefined
    try {
      await gateway?.close()
    } finally {
      service?.close()
    }
  }

  private async enterIdentityRecovery(): Promise<void> {
    this.preferences.enabled = false
    this.recoveryRequired = true
    this.error = REMOTE_IDENTITY_UNREADABLE_ERROR
    await this.stopActive().catch(() => undefined)
    await this.savePreferences().catch(() => undefined)
  }

  private refreshEndpointUrls(port: number): void {
    this.localEndpointUrl = `http://127.0.0.1:${port}`
    this.endpointUrls = [this.publicEndpoint ?? this.localEndpointUrl]
  }

  private refreshGatewayAccessRules(): void {
    const urls = [this.publicEndpoint, this.clientUrl].filter((value): value is string => Boolean(value)).map(value => new URL(value))
    this.allowedHosts.splice(0, this.allowedHosts.length, ...new Set(urls.map(url => url.hostname.toLowerCase())))
    this.allowedOrigins.splice(0, this.allowedOrigins.length, ...new Set(urls.map(url => url.origin)))
  }

  private async savePreferences(): Promise<void> {
    await mkdir(dirname(this.preferencesPath), { recursive: true, mode: 0o700 })
    await writeFile(this.preferencesPath, JSON.stringify(this.preferences), { encoding: 'utf8', mode: 0o600 })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => undefined).then(operation)
    this.transition = next.catch(error => {
      this.error = error instanceof Error ? error.message : String(error)
    })
    return next
  }
}
