import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TurboFluxRemoteAdapter, turboFluxWorkspaceId, type TurboFluxArtifactLike, type TurboFluxAutomationApprovalLike, type TurboFluxRemoteSnapshotLike } from './turbofluxAdapter'
import { REMOTE_PROTOCOL_VERSION, type RemoteAgentEvent, type RemoteCommand } from './types'

class FakeTurboFluxRuntime {
  readonly events = new Set<(event: unknown) => void>()
  readonly actions: string[] = []
  artifact: TurboFluxArtifactLike | null = null
  automationApprovals: TurboFluxAutomationApprovalLike[] = []

  constructor(readonly snapshot: TurboFluxRemoteSnapshotLike) {}

  getSnapshot() { return this.snapshot }
  subscribe(listener: (event: unknown) => void) { this.events.add(listener); return () => this.events.delete(listener) }
  submitPromptToConversation(id: string, prompt: string) { this.actions.push(`submit:${id}:${prompt}`); return { status: 'steering' } }
  async newConversation() { this.actions.push('new') }
  async switchConversation(id: string) { this.actions.push(`switch:${id}`); this.snapshot.conversation.id = id }
  async activateRemoteSession(id: string) { this.actions.push(`activate:${id}`); this.snapshot.conversation.id = id }
  async controlConversation(id: string, action: 'pause' | 'resume' | 'stop') { this.actions.push(`${action}:${id}`); return true }
  resolveRequestForConversation(sessionId: string, id: string, response: string) { this.actions.push(`resolve:${sessionId}:${id}:${response}`); return true }
  listRemoteAutomationApprovals() { return this.automationApprovals }
  resolveAutomationApproval(id: string, response: string, channel: 'remote', deviceId?: string) { this.actions.push(`resolve-automation:${id}:${response}:${channel}:${deviceId}`) }
  getArtifact(id: string) { return this.artifact?.id === id ? this.artifact : null }
  emit(event: unknown) { for (const listener of this.events) listener(event) }
}

function command(value: Omit<RemoteCommand, 'protocolVersion' | 'commandId' | 'createdAt'>): RemoteCommand {
  return { ...value, protocolVersion: REMOTE_PROTOCOL_VERSION, commandId: 'command-1', clientInstanceId: 'client-1', createdAt: Date.now() } as RemoteCommand
}

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('TurboFlux remote adapter', () => {
  it('projects sessions without exposing local paths and controls the selected session', async () => {
    const workspacePath = '/Users/local/private-project'
    const snapshot: TurboFluxRemoteSnapshotLike = {
      workspace: { path: workspacePath, name: 'Private Project' },
      runtime: { status: 'running', pendingRequests: [{ id: 'approval-1', kind: 'permission', question: 'Allow write?', reason: 'Needed', toolName: 'write_file' }] },
      conversation: { id: 'session-1', turns: [{ id: 'turn-1', role: 'assistant', content: 'Working', timestamp: 100 }, { id: 'hidden', role: 'system', content: 'secret system prompt', timestamp: 101 }] },
      conversationCatalog: [
        { id: 'session-1', title: 'First task', workspacePath, updatedAt: 100 },
        { id: 'session-2', title: 'Second task', workspacePath, updatedAt: 90 },
      ],
      conversationRuntimes: [{ conversationId: 'session-1', status: 'running', updatedAt: 100 }],
      artifacts: { artifacts: [] },
    }
    const runtime = new FakeTurboFluxRuntime(snapshot)
    const adapter = new TurboFluxRemoteAdapter(runtime, { now: () => 200 })
    const projected = adapter.getSnapshot()

    expect(projected.sessions[0]).toMatchObject({ workspaceId: turboFluxWorkspaceId(workspacePath), workspaceName: 'Private Project' })
    expect(projected.messages).toEqual([{ id: 'turn-1', sessionId: 'session-1', role: 'assistant', text: 'Working', createdAt: 100 }])
    expect(JSON.stringify(projected)).not.toContain(workspacePath)
    expect(JSON.stringify(projected)).not.toContain('secret system prompt')

    await adapter.execute(command({ type: 'session.submit', adapterId: adapter.descriptor.id, sessionId: 'session-2', prompt: 'Adjust it', mode: 'steer' }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>)
    await adapter.execute(command({ type: 'session.control', adapterId: adapter.descriptor.id, sessionId: 'session-2', action: 'pause' }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>)
    expect(runtime.actions).toEqual(['submit:session-2:Adjust it', 'pause:session-2'])
  })

  it('reads bounded artifact chunks and emits normalized events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turboflux-remote-'))
    temporaryDirectories.push(root)
    const artifactPath = join(root, 'report.txt')
    await writeFile(artifactPath, 'remote artifact')
    const snapshot: TurboFluxRemoteSnapshotLike = {
      workspace: { path: root, name: 'Workspace' },
      runtime: { status: 'ready', pendingRequests: [] },
      conversation: { id: 'session-1', turns: [] },
      conversationCatalog: [{ id: 'session-1', title: 'Task', workspacePath: root, updatedAt: 100 }],
      conversationRuntimes: [{ conversationId: 'session-1', status: 'ready', updatedAt: 100 }],
      artifacts: { artifacts: [] },
    }
    const runtime = new FakeTurboFluxRuntime(snapshot)
    runtime.artifact = { id: 'artifact-1', name: 'report.txt', path: artifactPath, workspacePath: root, kind: 'document', mime: 'text/plain', size: 15, updatedAt: 100, available: true, conversationId: 'session-1' }
    snapshot.artifacts.artifacts.push(runtime.artifact)
    const adapter = new TurboFluxRemoteAdapter(runtime)
    const events: RemoteAgentEvent[] = []
    const unsubscribe = adapter.subscribe(event => events.push(event))

    const result = await adapter.execute(command({ type: 'artifact.read', adapterId: adapter.descriptor.id, artifactId: 'artifact-1', offset: 7, length: 8 }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>)
    expect(result).toMatchObject({ offset: 7, nextOffset: 15, eof: true, data: Buffer.from('artifact').toString('base64url') })

    runtime.emit({ type: 'conversation-event', conversationId: 'session-1', event: { type: 'stream.delta', itemId: 'message-1', payload: { channel: 'answer', text: 'Hello' } } })
    expect(events).toEqual([{ type: 'message.delta', sessionId: 'session-1', messageId: 'message-1', channel: 'answer', delta: 'Hello' }])
    runtime.emit({ type: 'conversation-event', conversationId: 'session-1', event: { type: 'run.state_changed', payload: { state: { phase: 'paused', updatedAt: 200 } } } })
    expect(events.at(-1)).toMatchObject({ type: 'run.state', sessionId: 'session-1', status: 'paused' })
    runtime.emit({ type: 'conversation-run', conversationId: 'session-1', status: 'partial' })
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', sessionId: 'session-1', outcome: 'partial' })
    runtime.emit({ type: 'automation-notification', conversationId: 'session-1', level: 'success', message: 'Daily report completed.' })
    expect(events.at(-1)).toEqual({ type: 'notification', sessionId: 'session-1', level: 'success', message: 'Daily report completed.' })
    unsubscribe()
  })

  it('projects and resolves background automation approvals without exposing local paths or prompts', async () => {
    const workspacePath = '/Users/local/private-automation'
    const snapshot: TurboFluxRemoteSnapshotLike = {
      workspace: { path: workspacePath, name: 'Private Automation' },
      runtime: { status: 'ready', pendingRequests: [] },
      conversation: { id: 'session-1', turns: [] },
      conversationCatalog: [{ id: 'session-automation', title: 'Automation run', workspacePath, updatedAt: 100 }],
      conversationRuntimes: [{ conversationId: 'session-automation', status: 'awaiting-action', updatedAt: 100 }],
      artifacts: { artifacts: [] },
    }
    const runtime = new FakeTurboFluxRuntime(snapshot)
    runtime.automationApprovals = [{
      id: 'automation-approval-1',
      sessionId: 'session-automation',
      automationName: 'Daily report',
      runId: 'automation-run-1',
      workspacePath,
      kind: 'permission',
      question: 'Daily report requests a high-risk operation',
      options: ['allow-once', 'deny'],
      toolName: 'write_file',
      riskCategory: 'filesystem',
      targetSummary: '工具：write_file',
      requestedAt: 100,
      expiresAt: 1_000,
    }]
    const adapter = new TurboFluxRemoteAdapter(runtime, { now: () => 200 })

    const projected = adapter.getSnapshot()
    expect(projected.pendingApprovals).toEqual([
      expect.objectContaining({
        id: 'automation-approval-1',
        workspaceId: turboFluxWorkspaceId(workspacePath),
        automation: expect.objectContaining({ name: 'Daily report', riskCategory: 'filesystem', expiresAt: 1_000 }),
      }),
    ])
    expect(JSON.stringify(projected)).not.toContain(workspacePath)
    expect(JSON.stringify(projected)).not.toContain('private-automation')

    await adapter.execute(command({
      type: 'approval.resolve',
      adapterId: adapter.descriptor.id,
      sessionId: 'session-automation',
      requestId: 'automation-approval-1',
      response: 'allow-once',
    }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>, { deviceId: 'device-1', clientInstanceId: 'client-1' })
    expect(runtime.actions).toContain('resolve-automation:automation-approval-1:allow-once:remote:device-1')

    await expect(adapter.execute(command({
      type: 'approval.resolve',
      adapterId: adapter.descriptor.id,
      sessionId: 'session-automation',
      requestId: 'automation-approval-1',
      response: 'allow-once',
    }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>)).rejects.toThrow('Authenticated remote device context is unavailable')

    await expect(adapter.execute(command({
      type: 'approval.resolve',
      adapterId: adapter.descriptor.id,
      sessionId: 'session-automation',
      requestId: 'automation-approval-1',
      response: 'allow-once',
    }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>, { deviceId: 'device-1', clientInstanceId: 'different-page' })).rejects.toThrow('Authenticated remote device context is unavailable')

    runtime.automationApprovals[0]!.options = ['deny']
    await expect(adapter.execute(command({
      type: 'approval.resolve',
      adapterId: adapter.descriptor.id,
      sessionId: 'session-automation',
      requestId: 'automation-approval-1',
      response: 'allow-once',
    }) as Exclude<RemoteCommand, { type: 'sync.snapshot' | 'sync.events' }>, { deviceId: 'device-1', clientInstanceId: 'client-1' })).rejects.toThrow('not available to this remote client')
    expect(runtime.actions.filter(action => action.includes('resolve-automation:automation-approval-1'))).toHaveLength(1)
  })
})
