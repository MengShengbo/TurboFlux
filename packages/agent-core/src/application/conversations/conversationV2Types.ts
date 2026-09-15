import type { AgentMode, ApprovalPolicy, ToolResult } from '../../shared/agentTypes'
import type { ResponseMode, WorkExecutionSegment } from '../../shared/workExecutionTypes'

export const CONVERSATION_DATA_SCHEMA_VERSION = 2 as const
export const CONVERSATION_ITEM_SCHEMA_VERSION = 1 as const

export type ConversationV2Status = 'active' | 'idle' | 'needs_workspace' | 'archived'
export type ConversationV2Source = 'user' | 'agent' | 'flow' | 'runtime' | 'migration' | 'recovery'
export type ConversationV2Provenance = 'live' | 'restored' | 'migrated' | 'imported'
export type ConversationV2RunStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type ConversationV2ItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'redacted'

export interface ConversationRecordV2 {
  schemaVersion: typeof CONVERSATION_DATA_SCHEMA_VERSION
  id: string
  profileId: string
  workspaceId: string | null
  title: string
  titleSource: 'generated' | 'custom'
  mode: AgentMode
  provider: string
  model: string
  status: ConversationV2Status
  createdAt: number
  updatedAt: number
  archivedAt?: number
  lastEventSeq: number
  turnCount: number
  runCount: number
  tags: string[]
}

export interface ConversationRunV2 {
  id: string
  conversationId: string
  workspaceId: string | null
  objective: string
  status: ConversationV2RunStatus
  provider?: string
  model?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  outcome?: string
  recoveredFromPersistence?: boolean
  responseMode?: ResponseMode
  executionSegments?: WorkExecutionSegment[]
}

export interface ConversationTimelineEntryV2 {
  eventId: string
  seq: number
  at: number
  type: ConversationEventTypeV2
  runId?: string
  turnId?: string
  itemId?: string
}

export interface ConversationArtifactProjectionV2 {
  artifactId: string
  itemIds: string[]
  status: 'available' | 'missing'
  reason?: string
  updatedAt: number
}

export interface ConversationWorkspaceProjectionV2 {
  workspaceId: string
  bindingState: 'bound' | 'unbound' | 'missing' | 'mismatch'
  verificationState: 'verifying' | 'bound' | 'missing' | 'mismatch'
  updatedAt: number
}

export interface ConversationTurnV2 {
  id: string
  conversationId: string
  runId?: string
  role: 'user' | 'assistant' | 'system'
  status: 'started' | 'completed' | 'interrupted'
  createdAt: number
  completedAt?: number
}

export type PortablePathRef =
  | { scheme: 'workspace'; workspaceId: string; relativePath: string }
  | { scheme: 'artifact'; artifactId: string }
  | { scheme: 'profile'; relativePath: string }
  | { scheme: 'external'; displayPath: string; portability: 'redacted' | 'unavailable' }

interface ConversationItemBase<Kind extends string, Payload> {
  schemaVersion: typeof CONVERSATION_ITEM_SCHEMA_VERSION
  id: string
  conversationId: string
  runId?: string
  turnId?: string
  kind: Kind
  status: ConversationV2ItemStatus
  createdAt: number
  updatedAt: number
  payload: Payload
}

export type ConversationItemV2 =
  | ConversationItemBase<'user_message', { text: string; attachmentIds: string[] }>
  | ConversationItemBase<'assistant_message', { text: string; citations?: string[] }>
  | ConversationItemBase<'reasoning', { text?: string; omitted: boolean; summary?: string }>
  | ConversationItemBase<'tool_call', { toolCallId: string; toolName: string; arguments: Record<string, unknown>; pathRefs?: PortablePathRef[]; requiresReview?: boolean }>
  | ConversationItemBase<'tool_result', { toolCallId: string; toolName: string; output: string; isError: boolean; pathRefs?: PortablePathRef[] } & Pick<ToolResult, 'retrieval' | 'data' | 'errorKind' | 'interruption' | 'changeSummary' | 'attachments'>>
  | ConversationItemBase<'approval', { requestId: string; requestKind: 'permission' | 'input'; question: string; decision?: string; policy?: ApprovalPolicy }>
  | ConversationItemBase<'file_change', { path: PortablePathRef; change: 'created' | 'modified' | 'deleted' | 'renamed'; previousPath?: PortablePathRef }>
  | ConversationItemBase<'command_execution', { command: string; cwd?: PortablePathRef; exitCode?: number; output?: string; requiresReview: boolean }>
  | ConversationItemBase<'browser_activity', { action: string; url?: string; title?: string; result?: string }>
  | ConversationItemBase<'computer_activity', { action: string; application?: string; result?: string }>
  | ConversationItemBase<'subagent', { agentId: string; task: string; result?: string }>
  | ConversationItemBase<'artifact', { artifactId: string; name: string; mime?: string; path?: PortablePathRef; digest?: string; size?: number }>
  | ConversationItemBase<'plan', { steps: Array<{ id: string; title: string; status: string }> }>
  | ConversationItemBase<'context_compaction', { sourceItemIds: string[]; summary?: string; model?: string; error?: string }>
  | ConversationItemBase<'notification', { level: 'info' | 'success' | 'warning' | 'error'; message: string }>
  | ConversationItemBase<'recovery', { reason: string; repairedThroughSeq: number; preservedCorruptCopy?: string }>

export interface ConversationEventPayloadMapV2 {
  'conversation.created': { record: ConversationRecordV2 }
  'conversation.renamed': { title: string; titleSource: 'generated' | 'custom' }
  'conversation.configuration_changed': { mode: AgentMode; provider: string; model: string }
  'conversation.rewritten': { retainedTurnIds: string[]; rewrittenAt: number }
  'conversation.archived': { archivedAt: number }
  'conversation.restored': Record<string, never>
  'conversation.workspace_changed': { workspaceId: string | null; status: ConversationV2Status }
  'run.started': { run: ConversationRunV2 }
  'run.state_changed': { status: ConversationV2RunStatus; updatedAt: number; outcome?: string; responseMode?: ResponseMode; executionSegments?: WorkExecutionSegment[] }
  'run.completed': { status: Extract<ConversationV2RunStatus, 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'>; completedAt: number; outcome?: string; responseMode?: ResponseMode; executionSegments?: WorkExecutionSegment[] }
  'run.recovered': { reason: string; recoveredAt: number }
  'turn.started': { turn: ConversationTurnV2 }
  'turn.completed': { completedAt: number; interrupted?: boolean }
  'item.created': { item: ConversationItemV2 }
  'item.updated': { status?: ConversationV2ItemStatus; updatedAt: number; payload?: ConversationItemV2['payload'] }
  'item.completed': { status: Extract<ConversationV2ItemStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>; completedAt: number }
  'item.redacted': { reason: string; redactedAt: number }
  'input.queued': { inputId: string; text: string }
  'input.committed': { inputId: string }
  'input.removed': { inputId: string; reason: string }
  'approval.requested': { requestId: string; requestKind: 'permission' | 'input'; question: string }
  'approval.resolved': { requestId: string; decision?: string }
  'approval.cancelled': { requestId: string; reason: string }
  'context.compaction_started': { compactionId: string; sourceItemIds: string[] }
  'context.compaction_committed': { compactionId: string; itemId: string; summary?: string; model?: string }
  'context.compaction_failed': { compactionId: string; error: string }
  'artifact.registered': { artifactId: string; itemId: string }
  'artifact.linked': { artifactId: string; itemId: string }
  'artifact.missing': { artifactId: string; reason: string }
  'workspace.binding_changed': { workspaceId: string; state: 'bound' | 'unbound' | 'missing' | 'mismatch'; at: number }
  'workspace.verification_changed': { workspaceId: string; state: 'verifying' | 'bound' | 'missing' | 'mismatch'; at: number }
  'recovery.detected': { reason: string; throughSeq: number; preservedCorruptCopy?: string }
  'recovery.applied': { reason: string; throughSeq: number }
}

export type ConversationEventTypeV2 = keyof ConversationEventPayloadMapV2

export interface ConversationEventV2<Type extends ConversationEventTypeV2 = ConversationEventTypeV2> {
  schemaVersion: typeof CONVERSATION_DATA_SCHEMA_VERSION
  eventId: string
  profileId: string
  conversationId: string
  workspaceId?: string
  runId?: string
  turnId?: string
  itemId?: string
  seq: number
  at: number
  source: ConversationV2Source
  provenance: ConversationV2Provenance
  legacyEventId?: string
  type: Type
  payload: ConversationEventPayloadMapV2[Type]
}

export type AnyConversationEventV2 = {
  [Type in ConversationEventTypeV2]: ConversationEventV2<Type>
}[ConversationEventTypeV2]

export type AppendConversationEventV2Input<Type extends ConversationEventTypeV2 = ConversationEventTypeV2> =
  Omit<ConversationEventV2<Type>, 'schemaVersion' | 'eventId' | 'seq' | 'at'> & {
    eventId?: string
    at?: number
  }

export type AnyAppendConversationEventV2Input = {
  [Type in ConversationEventTypeV2]: AppendConversationEventV2Input<Type>
}[ConversationEventTypeV2]

export interface ConversationEventPageV2 {
  events: AnyConversationEventV2[]
  nextSeq: number | null
}

export interface ConversationTranscriptProjectionV2 {
  conversation: ConversationRecordV2 | null
  runs: ConversationRunV2[]
  turns: ConversationTurnV2[]
  items: ConversationItemV2[]
  timeline: ConversationTimelineEntryV2[]
  artifacts: ConversationArtifactProjectionV2[]
  workspace: ConversationWorkspaceProjectionV2 | null
  queuedInputIds: string[]
  throughSeq: number
}
