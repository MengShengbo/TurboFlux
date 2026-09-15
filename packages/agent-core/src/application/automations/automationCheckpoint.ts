import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AutomationContextSnapshot,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationRunCheckpoint,
  AutomationToolEffectRecord,
} from './automationTypes'

export interface AutomationCheckpointState {
  canonicalEventSequence: number
  completedToolCallIds: string[]
  nonReplayableToolCallIds: string[]
  toolEffects: AutomationToolEffectRecord[]
  inFlightToolEffect?: AutomationToolEffectRecord
  pendingApprovalId?: string
  artifactIds: string[]
  contextSummary?: string
}

export interface AutomationWorkspaceIdentity {
  fingerprint: string
  gitHead?: string
  complete: boolean
}

export function automationPermissionDigest(snapshot: AutomationPermissionSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    definitionRevision: snapshot.definitionRevision,
    allowedTools: snapshot.allowedTools,
    deniedTools: snapshot.deniedTools,
    paths: snapshot.paths,
    networkDomains: snapshot.networkDomains,
    secretRefs: snapshot.secretRefs,
    pluginIds: snapshot.pluginIds,
    pluginVersions: snapshot.pluginVersions ?? {},
  })).digest('hex')
}

function fileIdentity(path: string): string {
  if (!existsSync(path)) return 'missing'
  const stat = statSync(path)
  return `${stat.size}:${Math.floor(stat.mtimeMs)}:${stat.mode}`
}

export function captureAutomationWorkspaceIdentity(workspacePath: string): AutomationWorkspaceIdentity {
  const normalized = realpathSync(workspacePath)
  let gitHead: string | undefined
  let gitStatus: string | undefined
  try {
    gitHead = execFileSync('git', ['-C', normalized, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
    gitStatus = execFileSync('git', ['-C', normalized, 'status', '--porcelain=v2', '-z', '--untracked-files=all'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {}
  const identity = gitStatus !== undefined
    ? `git\0${normalized}\0${gitHead ?? 'unborn'}\0${gitStatus}`
    : `filesystem\0${normalized}\0${fileIdentity(normalized)}\0${fileIdentity(join(normalized, '.git', 'HEAD'))}\0${fileIdentity(join(normalized, '.git', 'index'))}`
  return {
    fingerprint: createHash('sha256').update(identity).digest('hex'),
    gitHead,
    complete: gitStatus !== undefined,
  }
}

export function createAutomationCheckpoint(input: {
  run: AutomationRun
  permissionSnapshot: AutomationPermissionSnapshot
  contextSnapshot: AutomationContextSnapshot
  state: AutomationCheckpointState
  reason: AutomationRunCheckpoint['reason']
  workspaceIdentity: AutomationWorkspaceIdentity
  now?: number
}): AutomationRunCheckpoint {
  const now = input.now ?? Date.now()
  const uncertain = input.state.inFlightToolEffect
  const replaySafe = !uncertain || uncertain.classification === 'read_only' || uncertain.classification === 'idempotent_write'
  const permissionIdentity = automationPermissionDigest(input.permissionSnapshot)
  return {
    id: `checkpoint-${randomUUID()}`,
    runId: input.run.id,
    definitionId: input.run.definitionId,
    definitionRevision: input.run.definitionRevision,
    conversationId: input.run.conversationId,
    canonicalEventSequence: input.state.canonicalEventSequence,
    completedToolCallIds: [...input.state.completedToolCallIds],
    nonReplayableToolCallIds: [...input.state.nonReplayableToolCallIds],
    toolEffects: input.state.toolEffects.map(effect => structuredClone(effect)),
    inFlightToolEffect: uncertain ? structuredClone(uncertain) : undefined,
    pendingApprovalId: input.state.pendingApprovalId,
    artifactIds: [...input.state.artifactIds],
    workspaceFingerprint: input.workspaceIdentity.fingerprint,
    gitHead: input.workspaceIdentity.gitHead,
    contextSummary: input.state.contextSummary,
    resumable: replaySafe && input.workspaceIdentity.complete,
    nonResumableReason: replaySafe
      ? input.workspaceIdentity.complete ? undefined : 'Workspace state could not be fully fingerprinted.'
      : `Tool ${uncertain?.toolName ?? 'unknown'} may have produced a non-replayable external effect.`,
    reason: input.reason,
    createdAt: now,
    permissionDigest: permissionIdentity,
    contextSnapshotId: input.contextSnapshot.id,
  }
}
