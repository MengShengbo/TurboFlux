import { RemoteHostService, RemoteHttpGateway, turboFluxWorkspaceId, type TurboFluxRemoteSnapshotLike } from '@turboflux/remote-protocol'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

class SmokeRuntime {
  private readonly listeners = new Set<(event: unknown) => void>()
  private readonly snapshot: TurboFluxRemoteSnapshotLike = {
    workspace: { path: '/tmp/turboflux-remote-smoke', name: 'Remote Smoke' },
    runtime: { status: 'ready', pendingRequests: [] },
    conversation: {
      id: 'remote-smoke-session',
      turns: [
        { id: 'turn-user', role: 'user', content: '检查移动远控链路', timestamp: Date.now() - 2_000 },
        { id: 'turn-assistant', role: 'assistant', content: '远程控制页已连接到 Desktop 执行节点。', timestamp: Date.now() - 1_000 },
      ],
    },
    conversationCatalog: [{ id: 'remote-smoke-session', title: '移动远控验收', workspacePath: '/tmp/turboflux-remote-smoke', updatedAt: Date.now() }],
    conversationRuntimes: [{ conversationId: 'remote-smoke-session', status: 'ready', updatedAt: Date.now() }],
    artifacts: { artifacts: [] },
  }

  getSnapshot() { return this.snapshot }
  subscribe(listener: (event: unknown) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  submitPromptToConversation(_sessionId: string, prompt: string) {
    this.snapshot.conversation.turns.push({ id: crypto.randomUUID(), role: 'user', content: prompt, timestamp: Date.now() })
    return { status: 'started' }
  }
  controlConversation() { return true }
  newConversation() {}
  switchConversation() {}
  activateRemoteSession() {}
  resolveRequestForConversation() { return true }
  getArtifact() { return null }
}

const runtime = new SmokeRuntime()
const service = await RemoteHostService.create({ displayName: 'TurboFlux Smoke Desktop', runtime })
const workspaceId = turboFluxWorkspaceId(runtime.getSnapshot().workspace.path)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gateway = new RemoteHttpGateway(service, {
  webRoot: join(repositoryRoot, 'apps', 'remote-mobile', 'dist'),
  pairing: {
    capabilities: ['session.read', 'session.create', 'session.submit', 'session.steer', 'session.control', 'approval.resolve', 'artifact.list', 'artifact.read'],
    workspaceIds: [workspaceId],
    ttlMs: 60 * 60_000,
  },
})
const endpoint = await gateway.start()
const pairingCode = service.createPairingCode(
  ['session.read', 'session.create', 'session.submit', 'session.steer', 'session.control', 'approval.resolve', 'artifact.list', 'artifact.read'],
  [{ kind: 'custom', value: endpoint.url }],
)
const pairingUrl = new URL(endpoint.url)
pairingUrl.hash = new URLSearchParams({ pair: pairingCode }).toString()

let approving = false
let pendingSeenAt = 0
const approvalTimer = setInterval(() => {
  if (approving) return
  const pending = service.listPendingPairings()[0]
  if (!pending) {
    pendingSeenAt = 0
    return
  }
  if (!pendingSeenAt) pendingSeenAt = Date.now()
  if (Date.now() - pendingSeenAt < 5_000) return
  approving = true
  void service.approvePairing(pending.requestId, { workspaceIds: [workspaceId], ttlMs: 60 * 60_000 })
    .finally(() => { approving = false })
}, 50)

console.log(`REMOTE_WEB_SMOKE_URL=${pairingUrl.href}`)
console.log('Open the one-time localhost pairing URL. Signed device pairing approval is automatic in this smoke harness.')

await new Promise<void>(resolve => {
  const stop = () => resolve()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
})

clearInterval(approvalTimer)
await gateway.close()
service.close()
