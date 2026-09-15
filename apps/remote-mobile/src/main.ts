import {
  HttpRemoteTransport,
  RemoteBrowserClient,
  RemoteCommandError,
  decodePairingInviteBrowser,
  httpEndpointFromHints,
  type RemoteAdapterDescriptor,
  type RemoteAgentSnapshot,
  type RemoteApprovalRequest,
  type RemoteArtifactManifest,
  type RemoteMessage,
  type RemoteCommand,
  type RemoteSessionSummary,
} from '@turboflux/remote-protocol/browser'
import { clearConnection, loadConnection, saveConnection } from './vault'
import { pairingCodeFromUrl } from './pairingLocation'
import { shouldInvalidateSavedPairing, terminalAuthorizationFailure } from './recoveryPolicy'
import './styles.css'

interface SnapshotPayload {
  capturedAt: number
  adapters: RemoteAdapterDescriptor[]
  snapshots: RemoteAgentSnapshot[]
}

interface ArtifactChunk {
  offset: number
  nextOffset: number
  eof: boolean
  encoding: 'base64url'
  data: string
}

const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id)
  if (!value) throw new Error(`Missing interface element: ${id}`)
  return value as T
}

const pairView = element<HTMLElement>('pair-view')
const takeoverView = element<HTMLElement>('takeover-view')
const shellView = element<HTMLElement>('shell-view')
const pairStatus = element<HTMLElement>('pair-status')
const pairButton = element<HTMLButtonElement>('pair-button')
const pairError = element<HTMLElement>('pair-error')
const takeoverMessage = element<HTMLElement>('takeover-message')
const takeoverButton = element<HTMLButtonElement>('takeover-button')
const hostName = element<HTMLElement>('host-name')
const connectionDot = element<HTMLElement>('connection-dot')
const connectionLabel = element<HTMLElement>('connection-label')
const sessionList = element<HTMLElement>('session-list')
const sessionCount = element<HTMLElement>('session-count')
const sessionPanel = element<HTMLElement>('session-panel')
const sessionScrim = element<HTMLElement>('session-scrim')
const emptyState = element<HTMLElement>('empty-state')
const conversationView = element<HTMLElement>('conversation-view')
const sessionTitle = element<HTMLElement>('session-title')
const sessionMeta = element<HTMLElement>('session-meta')
const messageList = element<HTMLElement>('message-list')
const approvalList = element<HTMLElement>('approval-list')
const artifactSection = element<HTMLElement>('artifact-section')
const artifactList = element<HTMLElement>('artifact-list')
const artifactCount = element<HTMLElement>('artifact-count')
const composer = element<HTMLFormElement>('composer')
const promptInput = element<HTMLTextAreaElement>('prompt-input')
const steerMode = element<HTMLInputElement>('steer-mode')
const sendButton = element<HTMLButtonElement>('send-button')
const toast = element<HTMLElement>('toast')

let client: RemoteBrowserClient | undefined
let endpoint = ''
let payload: SnapshotPayload | undefined
let adapter: RemoteAdapterDescriptor | undefined
let snapshot: RemoteAgentSnapshot | undefined
let selectedSessionId: string | undefined
let lastEventSeq = 0
let pollTimer: number | undefined
let syncInFlight = false
let consecutiveFailures = 0
let toastTimer: number | undefined
let pendingSubmit: {
  fingerprint: string
  command: Extract<RemoteCommand, { type: 'session.submit' }>
} | undefined
let pendingPairingCode: string | undefined

function assertSecureBrowserRuntime(): void {
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error('当前页面不是安全连接。请使用受信任的 HTTPS 地址，或仅在同一设备上使用 localhost 调试。')
  }
}

function controlSessionConflict(error: unknown): boolean {
  return error instanceof RemoteCommandError && ['control_session_in_use', 'control_session_replaced', 'control_session_required'].includes(error.code)
}

function controlSessionNeedsClaim(error: unknown): boolean {
  return error instanceof RemoteCommandError && error.code === 'control_session_required'
}

function pairingCodeFromLocation(): string | undefined {
  const result = pairingCodeFromUrl(window.location.href)
  window.history.replaceState(null, '', result.sanitizedPath)
  if (result.queryPairingRejected) pairError.textContent = '已拒绝地址查询参数中的配对码。请重新扫描电脑生成的安全二维码。'
  return result.code
}

function showTakeover(error: unknown): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = undefined
  pairView.hidden = true
  shellView.hidden = true
  takeoverView.hidden = false
  takeoverMessage.textContent = error instanceof RemoteCommandError && error.code === 'control_session_replaced'
    ? '此页面已被另一手机页面接管。你可以重新接管，原页面会立即失去控制。'
    : '同一时间只允许一个手机页面控制这台电脑。确认接管后，原页面会立即失去控制。'
}

async function openControlSession(takeover = false): Promise<boolean> {
  if (!client) return false
  try {
    takeoverButton.disabled = true
    await client.claimControl(takeover)
    takeoverView.hidden = true
    pairView.hidden = true
    shellView.hidden = false
    await sync(true)
    startPolling()
    return true
  } catch (error) {
    if (controlSessionConflict(error)) {
      showTakeover(error)
      return false
    }
    throw error
  } finally {
    takeoverButton.disabled = false
  }
}

async function recoverControlSession(error: unknown, retry: () => void): Promise<boolean> {
  if (!controlSessionConflict(error)) return false
  if (!controlSessionNeedsClaim(error) || !client) {
    showTakeover(error)
    return true
  }
  try {
    await client.claimControl()
    window.setTimeout(retry, 0)
  } catch (claimError) {
    if (controlSessionConflict(claimError)) showTakeover(claimError)
    else setConnection('offline', '无法恢复控制连接')
  }
  return true
}

async function invalidateSavedPairing(message: string): Promise<void> {
  await client?.close()
  client = undefined
  endpoint = ''
  payload = undefined
  adapter = undefined
  snapshot = undefined
  selectedSessionId = undefined
  pendingSubmit = undefined
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = undefined
  await clearConnection()
  shellView.hidden = true
  takeoverView.hidden = true
  pairView.hidden = false
  pairError.textContent = message
}

function setConnection(state: 'online' | 'syncing' | 'offline', label: string): void {
  connectionDot.className = state
  connectionLabel.textContent = label
}

function notify(message: string): void {
  toast.textContent = message
  toast.classList.add('visible')
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2_500)
}

function button(label: string, className = ''): HTMLButtonElement {
  const value = document.createElement('button')
  value.type = 'button'
  value.textContent = label
  value.className = className
  return value
}

function statusLabel(status: RemoteSessionSummary['status']): string {
  return ({ ready: '准备就绪', running: '正在运行', paused: '已暂停', 'awaiting-action': '等待确认', error: '发生错误', offline: '离线' })[status]
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

function renderSessions(): void {
  sessionList.replaceChildren()
  const sessions = snapshot?.sessions ?? []
  sessionCount.textContent = String(sessions.length)
  for (const session of sessions) {
    const item = button('', `session-item${session.id === selectedSessionId ? ' active' : ''}`)
    const top = document.createElement('span')
    top.className = 'session-item-top'
    const title = document.createElement('strong')
    title.textContent = session.title || '未命名任务'
    const dot = document.createElement('i')
    dot.className = `status-${session.status}`
    top.append(title, dot)
    const meta = document.createElement('span')
    meta.className = 'session-item-meta'
    meta.textContent = `${statusLabel(session.status)} · ${session.workspaceName || '工作区'}`
    item.append(top, meta)
    item.addEventListener('click', () => void activateSession(session.id))
    sessionList.append(item)
  }
}

function renderMessages(messages: RemoteMessage[]): void {
  messageList.replaceChildren()
  if (messages.length === 0) {
    const placeholder = document.createElement('p')
    placeholder.className = 'message-placeholder'
    placeholder.textContent = '这个任务还没有可同步的对话。'
    messageList.append(placeholder)
    return
  }
  for (const message of messages) {
    const row = document.createElement('article')
    row.className = `message-row ${message.role}`
    const heading = document.createElement('div')
    heading.className = 'message-heading'
    const author = document.createElement('strong')
    author.textContent = message.role === 'user' ? '你' : message.role === 'tool' ? '工具结果' : 'TurboFlux'
    const time = document.createElement('span')
    time.textContent = formatTime(message.createdAt)
    heading.append(author, time)
    const content = document.createElement('p')
    content.textContent = message.text
    row.append(heading, content)
    messageList.append(row)
  }
  requestAnimationFrame(() => messageList.lastElementChild?.scrollIntoView({ block: 'nearest' }))
}

function approvalOptionValues(request: RemoteApprovalRequest): Array<{ label: string; value: string }> {
  if (request.options?.length) return request.options.map(option => ({
    label: ({ 'allow-once': '仅这次允许', 'allow-run': '本次运行允许', 'allow-session': '专用会话允许', deny: '拒绝' } as Record<string, string>)[option] || option,
    value: option,
  }))
  return request.kind === 'permission'
    ? [{ label: '允许', value: 'allow' }, { label: '拒绝', value: 'deny' }]
    : [{ label: '填写回复', value: '' }]
}

function renderApprovals(): void {
  approvalList.replaceChildren()
  const requests = (snapshot?.pendingApprovals ?? []).filter(request => request.sessionId === selectedSessionId)
  for (const request of requests) {
    const card = document.createElement('article')
    card.className = 'approval-card'
    const eyebrow = document.createElement('span')
    eyebrow.textContent = request.automation
      ? `${request.automation.name} · ${request.automation.riskCategory}`
      : request.kind === 'permission' ? '需要你的确认' : 'Agent 正在等待回复'
    const question = document.createElement('h2')
    question.textContent = request.question
    card.append(eyebrow, question)
    if (request.automation) {
      const scope = document.createElement('p')
      scope.className = 'approval-scope'
      scope.textContent = `${request.automation.targetSummary || request.toolName || '受限操作'} · ${new Date(request.automation.expiresAt).toLocaleString()} 到期，逾期自动拒绝`
      card.append(scope)
    }
    if (request.reason) {
      const reason = document.createElement('p')
      reason.textContent = request.reason
      card.append(reason)
    }
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    for (const option of approvalOptionValues(request)) {
      const action = button(option.label, option.value === 'deny' ? 'approval-deny' : '')
      action.addEventListener('click', () => void resolveApproval(request, option.value))
      actions.append(action)
    }
    card.append(actions)
    approvalList.append(card)
  }
}

function artifactIcon(kind: string): string {
  if (kind === 'image') return '▧'
  if (kind === 'pdf' || kind === 'document') return '▤'
  if (kind === 'presentation') return '▣'
  if (kind === 'spreadsheet') return '▦'
  return '◇'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function renderArtifacts(): void {
  artifactList.replaceChildren()
  const artifacts = (snapshot?.artifacts ?? []).filter(item => !item.sessionId || item.sessionId === selectedSessionId)
  artifactSection.hidden = artifacts.length === 0
  artifactCount.textContent = String(artifacts.length)
  for (const artifact of artifacts) {
    const card = button('', 'artifact-card')
    const icon = document.createElement('span')
    icon.className = 'artifact-icon'
    icon.textContent = artifactIcon(artifact.kind)
    const copy = document.createElement('span')
    copy.className = 'artifact-copy'
    const name = document.createElement('strong')
    name.textContent = artifact.name
    const size = document.createElement('small')
    size.textContent = `${artifact.kind} · ${formatBytes(artifact.size)}`
    copy.append(name, size)
    const download = document.createElement('span')
    download.className = 'artifact-download'
    download.textContent = '↓'
    card.append(icon, copy, download)
    card.disabled = !artifact.available
    card.addEventListener('click', () => void downloadArtifact(artifact))
    artifactList.append(card)
  }
}

function render(): void {
  const sessions = snapshot?.sessions ?? []
  if (!selectedSessionId || !sessions.some(session => session.id === selectedSessionId)) selectedSessionId = snapshot?.activeSessionId ?? sessions[0]?.id
  renderSessions()
  const selected = sessions.find(session => session.id === selectedSessionId)
  emptyState.hidden = Boolean(selected)
  conversationView.hidden = !selected
  composer.hidden = !selected
  if (!selected) return
  sessionTitle.textContent = selected.title || '远程任务'
  sessionMeta.textContent = `${statusLabel(selected.status)} · ${selected.workspaceName || '工作区'} · ${formatTime(selected.updatedAt)}`
  renderMessages((snapshot?.messages ?? []).filter(message => message.sessionId === selected.id))
  renderApprovals()
  renderArtifacts()
}

function parseSnapshot(value: unknown): SnapshotPayload {
  if (!value || typeof value !== 'object') throw new Error('主机返回了无效快照')
  const candidate = value as SnapshotPayload
  if (!Array.isArray(candidate.adapters) || !Array.isArray(candidate.snapshots)) throw new Error('主机快照格式不受支持')
  return candidate
}

async function sync(showActivity = false): Promise<void> {
  if (!client || syncInFlight) return
  syncInFlight = true
  if (showActivity) setConnection('syncing', '正在同步')
  try {
    payload = parseSnapshot(await client.snapshot())
    snapshot = payload.snapshots[0]
    adapter = payload.adapters.find(item => item.id === snapshot?.adapterId) ?? payload.adapters[0]
    consecutiveFailures = 0
    setConnection('online', '端到端已连接')
    render()
  } catch (error) {
    consecutiveFailures += 1
    if (terminalAuthorizationFailure(error)) {
      await invalidateSavedPairing('这台设备的授权已撤销或过期，请在电脑端重新配对。')
      return
    }
    if (await recoverControlSession(error, () => void sync())) return
    if (consecutiveFailures >= 2) setConnection('offline', '连接中断，正在重试')
    if (showActivity) notify(error instanceof Error ? error.message : String(error))
  } finally {
    syncInFlight = false
  }
}

async function pollEvents(): Promise<void> {
  if (!client || document.hidden || syncInFlight) return
  try {
    const eventWindow = await client.events(lastEventSeq)
    for (const envelope of eventWindow.events) {
      if (envelope.event.type === 'notification' && envelope.event.message) notify(envelope.event.message)
    }
    if (eventWindow.hasGap || eventWindow.events.length > 0) await sync()
    lastEventSeq = eventWindow.lastSeq
    consecutiveFailures = 0
  } catch (error) {
    consecutiveFailures += 1
    if (terminalAuthorizationFailure(error)) {
      await invalidateSavedPairing('这台设备的授权已撤销或过期，请在电脑端重新配对。')
      return
    }
    if (await recoverControlSession(error, () => void pollEvents())) return
    if (consecutiveFailures >= 2) setConnection('offline', '连接中断，正在重试')
  }
}

function startPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => void pollEvents(), 2_500)
}

async function activateSession(sessionId: string): Promise<void> {
  closeSessionDrawer()
  if (!client || !adapter || sessionId === snapshot?.activeSessionId) {
    selectedSessionId = sessionId
    render()
    return
  }
  try {
    setConnection('syncing', '正在切换任务')
    await client.activateSession(adapter.id, sessionId)
    selectedSessionId = sessionId
    await sync()
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

async function resolveApproval(request: RemoteApprovalRequest, suggested: string): Promise<void> {
  if (!client || !adapter) return
  const response = suggested || window.prompt(request.question) || ''
  if (!response) return
  try {
    await client.resolveApproval(adapter.id, request.sessionId, request.id, response)
    notify('已发送确认')
    await sync()
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function downloadArtifact(artifact: RemoteArtifactManifest): Promise<void> {
  if (!client || !adapter || !artifact.available) return
  if (artifact.size > 100 * 1024 * 1024 && !window.confirm(`文件大小为 ${formatBytes(artifact.size)}，仍要下载到手机吗？`)) return
  const chunks: Uint8Array[] = []
  let offset = 0
  try {
    notify('正在安全下载产物…')
    while (offset < artifact.size) {
      const result = await client.readArtifact(adapter.id, artifact.id, offset, 512 * 1024) as unknown as ArtifactChunk
      chunks.push(decodeBase64Url(result.data))
      if (result.nextOffset <= offset || result.eof) break
      offset = result.nextOffset
    }
    const blob = new Blob(chunks.map(chunk => {
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      return copy.buffer
    }), { type: artifact.mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = artifact.name.replace(/[\\/:*?"<>|]/g, '-')
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000)
    notify('产物已下载')
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

async function pairSecure(code: string): Promise<void> {
  pendingPairingCode = code
  pairError.textContent = ''
  pairStatus.textContent = '正在验证配对邀请并建立设备密钥。'
  pairButton.hidden = false
  pairButton.disabled = true
  pairButton.textContent = '正在建立密钥…'
  try {
    assertSecureBrowserRuntime()
    const invite = await decodePairingInviteBrowser(code)
    const remoteEndpoint = httpEndpointFromHints(invite.payload.endpointHints)
    if (!remoteEndpoint) throw new Error('配对码里没有当前移动壳支持的端点')
    const nextClient = await RemoteBrowserClient.pair(code, new HttpRemoteTransport(remoteEndpoint, undefined, {
      onStatus: status => {
        pairButton.textContent = status.status === 'pending' ? '请在电脑上确认…' : status.status === 'approved' ? '电脑已确认' : '配对未完成'
      },
    }), { displayName: navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Mobile browser' })
    client = nextClient
    endpoint = remoteEndpoint
    await saveConnection({ state: nextClient.state, endpoint })
    hostName.textContent = nextClient.state.host.displayName
    await openControlSession()
  } catch (error) {
    pairError.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    pairButton.disabled = false
    pairButton.textContent = '安全连接'
  }
}

async function restoreSecure(): Promise<boolean> {
  try {
    assertSecureBrowserRuntime()
    const saved = await loadConnection()
    if (!saved) return false
    client = await RemoteBrowserClient.restore(saved.state, new HttpRemoteTransport(saved.endpoint))
    endpoint = saved.endpoint
    hostName.textContent = saved.state.host.displayName
    await openControlSession()
    return true
  } catch (error) {
    if (shouldInvalidateSavedPairing(error)) {
      await clearConnection().catch(() => undefined)
      pairError.textContent = '已保存的授权已经失效，请在电脑端重新连接。'
    } else {
      pairError.textContent = '暂时无法连接电脑，已保留这台设备的安全配对；网络恢复后可直接重试。'
    }
    return false
  }
}

async function disconnect(): Promise<void> {
  if (!window.confirm('要断开这台电脑的临时远控会话吗？')) return
  await client?.releaseControl().catch(() => undefined)
  await clearLocalConnection()
}

async function clearLocalConnection(): Promise<void> {
  await client?.close()
  client = undefined
  endpoint = ''
  payload = undefined
  adapter = undefined
  snapshot = undefined
  selectedSessionId = undefined
  pendingSubmit = undefined
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = undefined
  lastEventSeq = 0
  consecutiveFailures = 0
  await clearConnection().catch(() => undefined)
  shellView.hidden = true
  takeoverView.hidden = true
  pairView.hidden = false
  pairStatus.textContent = '连接已断开。请在电脑端重新生成并扫描配对二维码。'
  pairButton.hidden = true
}

async function submitPrompt(): Promise<void> {
  const prompt = promptInput.value.trim()
  if (!prompt || !client || !adapter || !selectedSessionId) return
  const mode = steerMode.checked ? 'steer' : 'turn'
  const fingerprint = JSON.stringify([adapter.id, selectedSessionId, prompt, mode])
  if (pendingSubmit?.fingerprint !== fingerprint) {
    pendingSubmit = {
      fingerprint,
      command: client.prepareSubmit(adapter.id, selectedSessionId, prompt, mode),
    }
  }
  sendButton.disabled = true
  try {
    await client.submitPrepared(pendingSubmit.command)
    pendingSubmit = undefined
    promptInput.value = ''
    promptInput.style.height = ''
    notify(steerMode.checked ? '纠偏已发送' : '指令已发送')
    await sync()
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  } finally {
    sendButton.disabled = false
  }
}

async function control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
  if (!client || !adapter || !selectedSessionId) return
  try {
    await client.control(adapter.id, selectedSessionId, action)
    notify(action === 'pause' ? '已请求暂停' : action === 'resume' ? '已请求继续' : '已请求停止')
    await sync()
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

function openSessionDrawer(): void {
  sessionPanel.classList.add('open')
  sessionScrim.hidden = false
}

function closeSessionDrawer(): void {
  sessionPanel.classList.remove('open')
  sessionScrim.hidden = true
}

pairButton.addEventListener('click', () => { if (pendingPairingCode) void pairSecure(pendingPairingCode) })
element('sync-button').addEventListener('click', () => void sync(true))
element('disconnect-button').addEventListener('click', () => void disconnect())
takeoverButton.addEventListener('click', () => void openControlSession(true))
element('takeover-cancel').addEventListener('click', () => void clearLocalConnection())
element('sessions-toggle').addEventListener('click', openSessionDrawer)
sessionScrim.addEventListener('click', closeSessionDrawer)
element('pause-button').addEventListener('click', () => void control('pause'))
element('resume-button').addEventListener('click', () => void control('resume'))
element('stop-button').addEventListener('click', () => void control('stop'))
composer.addEventListener('submit', event => { event.preventDefault(); void submitPrompt() })
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto'
  promptInput.style.height = `${Math.min(160, promptInput.scrollHeight)}px`
})
promptInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submitPrompt()
  }
})
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync() })

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js')
sessionStorage.removeItem('turboflux-lan-pending')
sessionStorage.removeItem('turboflux-lan-session')
const initialPairingCode = pairingCodeFromLocation()
if (initialPairingCode) {
  void pairSecure(initialPairingCode)
} else {
  void restoreSecure().then(restored => {
    if (restored) return
    if (pairError.textContent) return
    pairStatus.textContent = '请在电脑端生成安全配对二维码，再用手机扫描打开。'
    pairButton.hidden = true
  })
}
