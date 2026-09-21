import type { AgentTurn } from './agentTypes'

export const MODEL_SURFACE_SCHEMA_VERSION = 1 as const

export type ModelSurfaceSnapshotSource =
  | 'work_execution'
  | 'compaction_files'
  | 'runtime'
  | 'permission'
  | 'workspace'
  | (string & {})

export type ModelSurfaceReplacementReason =
  | 'restore'
  | 'turn_divergence'
  | 'context_compaction'
  | 'tool_result_pruning'
  | 'image_budget'
  | 'manual'

export interface ModelSurfaceTurnEvent {
  kind: 'turn'
  sequence: number
  fingerprint: string
  turn: AgentTurn
}

export interface ModelSurfaceSnapshotEvent {
  kind: 'snapshot'
  sequence: number
  source: ModelSurfaceSnapshotSource
  revision: number
  fingerprint: string
  content: string
  cleared: boolean
  createdAt: number
}

export interface ModelSurfaceReplacementEvent {
  kind: 'replacement'
  sequence: number
  generation: number
  reason: ModelSurfaceReplacementReason
  previousFingerprint: string
  nextFingerprint: string
  turns: AgentTurn[]
  createdAt: number
}

export type ModelSurfaceReplacementRecord = Omit<ModelSurfaceReplacementEvent, 'kind' | 'turns'>

export type ModelSurfaceEvent =
  | ModelSurfaceTurnEvent
  | ModelSurfaceSnapshotEvent
  | ModelSurfaceReplacementEvent

export interface ModelSurfaceSnapshotHead {
  fingerprint: string
  revision: number
  cleared: boolean
}

export interface ModelSurfaceState {
  schemaVersion: typeof MODEL_SURFACE_SCHEMA_VERSION
  generation: number
  nextSequence: number
  events: ModelSurfaceEvent[]
  snapshotHeads: Record<string, ModelSurfaceSnapshotHead>
  replacementHistory: ModelSurfaceReplacementRecord[]
  sourceTurnIds: string[]
  sourceTurnFingerprints: string[]
}

export interface ModelSurfaceDifference {
  index: number
  previousFingerprint?: string
  nextFingerprint?: string
  previousTurnId?: string
  nextTurnId?: string
}
