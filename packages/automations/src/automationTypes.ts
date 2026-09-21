import type { ApprovalPolicy } from '@turboflux/contracts/agentTypes'
import type { AutomationSchedule } from './automationService'
import type { AutomationToolSideEffectClass } from './automationSideEffects'

export const AUTOMATION_SCHEMA_VERSION = 3 as const

export type AutomationDefinitionStatus = 'draft' | 'testing' | 'active' | 'paused' | 'archived' | 'invalid'
export type AutomationRunMode = 'isolated' | 'continuation'
export type AutomationTrust = 'local_user' | 'system' | 'verified_connector' | 'untrusted_external'
export type AutomationTriggerSource = 'manual' | 'schedule' | 'webhook' | 'git' | 'plugin' | 'recovery'
export type AutomationRunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_for_approval'
  | 'checkpointed'
  | 'retry_scheduled'
  | 'needs_review'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped'
  | 'expired'
  | 'invalid'

export type AutomationRecoveryAction = 'resume_without_replay' | 'retry_idempotent'

export interface AutomationWorkspaceRef {
  path: string
  identity?: string
}

export interface AutomationObjective {
  originalPrompt: string
  goal: string
  successCriteria: string[]
  deliverables: string[]
  constraints: string[]
  noChangeBehavior?: string
  failureBehavior?: string
}

export interface AutomationTriggerFilter {
  field: string
  operator: 'equals' | 'not_equals' | 'in' | 'contains' | 'prefix' | 'suffix' | 'matches'
  value: string | number | boolean | string[]
}

export type AutomationTriggerDefinition =
  | { id: string; kind: 'schedule'; schedule: AutomationSchedule; timezone: string }
  | { id: string; kind: 'cron'; expression: string; timezone: string }
  | { id: string; kind: 'webhook'; sourceInstanceId: string; secretRef: string; signature: 'hmac-sha256'; maxPayloadBytes: number; rateLimitPerMinute?: number; filters?: AutomationTriggerFilter[] }
  | { id: string; kind: 'git'; events: Array<'head' | 'worktree' | 'remote'>; pathFilters: string[]; debounceMs?: number; filters?: AutomationTriggerFilter[] }
  | { id: string; kind: 'plugin'; pluginId: string; providerId: string; providerVersion?: string; config: Record<string, unknown>; trust?: Extract<AutomationTrust, 'verified_connector' | 'untrusted_external'>; filters?: AutomationTriggerFilter[] }

export interface AutomationContextPolicy {
  mode: AutomationRunMode
  continuationConversationId?: string
  includeAutomationMemory: boolean
  includePreviousRunSummary: boolean
  fileRefs: string[]
  skillIds: string[]
}

export interface AutomationPathPolicy {
  path: string
  access: 'read' | 'write'
}

export interface AutomationCapabilityPolicy {
  approvalPolicy: ApprovalPolicy
  allowedTools: string[]
  deniedTools: string[]
  paths: AutomationPathPolicy[]
  networkDomains: string[]
  secretRefs: string[]
  mcpServerIds: string[]
  pluginIds: string[]
  allowComputerUse: boolean
  allowBackgroundComputerUse: boolean
}

export interface AutomationRetryPolicyV3 {
  maxRetries: number
  backoffMinutes: number
  maxBackoffMinutes: number
  jitter: number
}

export interface AutomationReliabilityPolicy {
  misfirePolicy: 'run-once' | 'skip'
  overlapPolicy: 'skip' | 'queue-one' | 'queue-all' | 'parallel'
  maxParallel: number
  maxQueuedRuns: number
  maxRuntimeMinutes: number
  maxToolCalls: number
  maxInputTokens?: number
  maxOutputTokens?: number
  retry: AutomationRetryPolicyV3
  concurrencyGroup?: {
    id: string
    maxParallel: number
  }
  resourceLocks?: Array<{
    key: string
    mode: 'shared' | 'exclusive'
  }>
}

export interface AutomationRouteRule {
  id: string
  label: string
  filters: AutomationTriggerFilter[]
  action: 'run' | 'skip'
  objectiveSuffix?: string
  agentStrategyId?: string
}

export interface AutomationRoutingPolicy {
  rules: AutomationRouteRule[]
  defaultAction: 'run' | 'skip'
  defaultAgentStrategyId?: string
}

export interface AutomationAgentStrategy {
  id: string
  label: string
  allowedAgentTypes: string[]
  maxSubtasks: number
  maxParallel: number
}

export interface AutomationAgentPolicy {
  enabled: boolean
  defaultStrategyId?: string
  strategies: AutomationAgentStrategy[]
}

export interface AutomationAgentPolicySnapshot {
  strategyId?: string
  allowedAgentTypes: string[]
  maxSubtasks: number
  maxParallel: number
}

export interface AutomationRouteDecision {
  ruleId?: string
  label: string
  action: 'run' | 'skip'
  objectiveSuffix?: string
  agentStrategyId?: string
  evaluatedAt: number
}

export interface AutomationDeliveryPolicy {
  eventPolicyVersion: 2
  desktop: AutomationDeliveryEventType[]
  remoteMobile: AutomationDeliveryEventType[]
  digest: 'immediate' | 'hourly' | 'daily'
  failureCooldownMinutes?: number
  providerRefs: string[]
  providerEvents?: AutomationDeliveryEventType[]
  providerVersions?: Record<string, string>
}

export interface AutomationDefinition {
  id: string
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  revision: number
  status: AutomationDefinitionStatus
  name: string
  description?: string
  workspaceRef: AutomationWorkspaceRef
  objective: AutomationObjective
  triggers: AutomationTriggerDefinition[]
  context: AutomationContextPolicy
  capabilities: AutomationCapabilityPolicy
  reliability: AutomationReliabilityPolicy
  routing?: AutomationRoutingPolicy
  agents?: AutomationAgentPolicy
  delivery: AutomationDeliveryPolicy
  createdAt: number
  updatedAt: number
  publishedAt?: number
}

export interface AutomationValidationIssue {
  code: string
  severity: 'warning' | 'error'
  path: string
  message: string
}

export interface AutomationDefinitionRevision {
  definitionId: string
  revision: number
  specDigest: string
  source: 'user' | 'import' | 'migration' | 'rollback'
  changeSummary: string
  parentRevision?: number
  validationIssues: AutomationValidationIssue[]
  definition: AutomationDefinition
  createdAt: number
}

export interface AutomationTriggerEvent {
  id: string
  source: AutomationTriggerSource
  sourceInstanceId: string
  deduplicationKey: string
  trust: AutomationTrust
  occurredAt: number
  receivedAt: number
  definitionId: string
  definitionRevision: number
  payloadRef?: string
  payloadDigest?: string
  status: 'accepted' | 'deduplicated' | 'rejected' | 'expired' | 'routed'
  rejectionReason?: string
}

export interface AutomationTriggerPayload {
  id: string
  digest: string
  trust: AutomationTrust
  source: Extract<AutomationTriggerSource, 'webhook' | 'git' | 'plugin'>
  contentType: string
  normalizedData: unknown
  summary: string
  redactedHeaders: Record<string, string>
  receivedAt: number
  expiresAt: number
  rawStored: false
}

export interface AutomationPermissionSnapshot {
  id: string
  definitionId: string
  definitionRevision: number
  approvalPolicy: ApprovalPolicy
  allowedTools: string[]
  deniedTools: string[]
  paths: AutomationPathPolicy[]
  networkDomains: string[]
  secretRefs: string[]
  mcpServerIds: string[]
  pluginIds: string[]
  pluginVersions?: Record<string, string>
  allowComputerUse: boolean
  allowBackgroundComputerUse: boolean
  maxRuntimeMinutes: number
  maxToolCalls: number
  maxInputTokens?: number
  maxOutputTokens?: number
  riskSummary: string[]
  createdAt: number
}

export interface AutomationContextSnapshot {
  id: string
  definitionId: string
  definitionRevision: number
  mode: AutomationRunMode
  conversationId?: string
  memoryRevision?: number
  automationMemory?: AutomationMemorySnapshot
  previousRunSummary?: {
    runId: string
    summary: string
    outcome?: AutomationRunResult['outcome']
    completedAt?: number
  }
  agentPolicy?: AutomationAgentPolicySnapshot
  routeDecision?: AutomationRouteDecision
  fileRefs: string[]
  skillIds: string[]
  triggerPayloadRef?: string
  estimatedInputTokens?: number
  createdAt: number
}

export interface AutomationRunLease {
  ownerId: string
  acquiredAt: number
  expiresAt: number
  heartbeatAt: number
}

export interface AutomationExecutionLock {
  id: string
  runId: string
  ownerId: string
  kind: 'concurrency_group' | 'resource'
  key: string
  mode: 'slot' | 'shared' | 'exclusive'
  limit?: number
  acquiredAt: number
  expiresAt: number
}

export interface AutomationRunTimestamps {
  createdAt: number
  queuedAt: number
  preparingAt?: number
  startedAt?: number
  updatedAt: number
  completedAt?: number
  retryAt?: number
}

export interface AutomationRunError {
  code: string
  category: 'configuration' | 'transient' | 'approval' | 'timeout' | 'budget' | 'security' | 'side_effect_unknown' | 'host_interrupted'
  message: string
  retryable: boolean
  userAction?: string
}

export interface AutomationApprovalRequest {
  id: string
  automationId: string
  automationName: string
  runId: string
  definitionRevision: number
  permissionSnapshotId: string
  conversationId: string
  workspacePath: string
  kind: 'permission' | 'input'
  riskCategory: 'permission' | 'filesystem' | 'network' | 'computer' | 'secret' | 'input'
  question: string
  options?: string[]
  reason?: string
  toolName?: string
  path?: string
  targetSummary?: string
  triggerSource?: AutomationTriggerSource
  priorSideEffects?: string[]
  requestedAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'canceled'
  decision?: string
  responseChannel?: 'desktop' | 'remote' | 'system'
  responseDeviceId?: string
  resolvedAt?: number
}

export interface AutomationRunResult {
  outcome: 'success' | 'no_change' | 'partial' | 'failed' | 'canceled'
  summary: string
  successCriteria: Array<{ criterion: string; status: 'met' | 'not_met' | 'unknown'; evidence?: string }>
  artifactIds: string[]
  sideEffectSummary: string[]
  durationMs: number
  inputTokens?: number
  outputTokens?: number
}

export type AutomationDeliveryEventType = 'success' | 'no_change' | 'partial' | 'failed' | 'timeout' | 'budget' | 'approval' | 'invalid' | 'recovered'
export type AutomationDeliveryChannel = 'desktop' | 'remote_mobile' | `plugin:${string}`

export interface AutomationDeliveryRecord {
  id: string
  key: string
  runId: string
  definitionId: string
  channel: AutomationDeliveryChannel
  eventType: AutomationDeliveryEventType
  providerRef?: string
  idempotencyKey: string
  providerSupportsIdempotency: boolean
  status: 'queued' | 'sending' | 'delivered' | 'suppressed' | 'failed' | 'delivery_unknown'
  attempts: number
  createdAt: number
  updatedAt: number
  summary?: string
  suppressionReason?: string
  acknowledgedAt?: number
  deliveredAt?: number
  externalId?: string
  lastError?: string
}

export interface AutomationRun {
  id: string
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  definitionId: string
  definitionRevision: number
  triggerEventId: string
  occurrenceKey: string
  mode: AutomationRunMode
  workspaceRef: AutomationWorkspaceRef
  conversationId?: string
  dryRun?: boolean
  status: AutomationRunStatus
  attempt: number
  permissionSnapshotId: string
  contextSnapshotId: string
  lease?: AutomationRunLease
  checkpointId?: string
  concurrencyGroupId?: string
  resourceLockKeys?: string[]
  budgetUsage?: {
    toolCalls: number
    inputTokens: number
    outputTokens: number
    subtasks?: number
    updatedAt: number
  }
  execution?: {
    provider: string
    model: string
    recordedAt: number
  }
  timestamps: AutomationRunTimestamps
  result?: AutomationRunResult
  error?: AutomationRunError
  pinned?: boolean
  pinnedAt?: number
  detailsPrunedAt?: number
  recovery?: {
    action: AutomationRecoveryAction
    checkpointId: string
    requestedAt: number
    verifiedAt: number
    workspaceFingerprint: string
    warnings: string[]
    skipToolCallIds: string[]
    unresolvedTool?: {
      toolCallId: string
      toolName: string
      classification: AutomationToolSideEffectClass
      targetSummary?: string
    }
  }
  migration?: {
    schemaVersion: 2
    legacyRunId: string
    legacyInputId?: string
  }
}

export interface AutomationRunCheckpoint {
  id: string
  runId: string
  definitionId: string
  definitionRevision: number
  conversationId?: string
  canonicalEventSequence: number
  completedToolCallIds: string[]
  nonReplayableToolCallIds: string[]
  toolEffects: AutomationToolEffectRecord[]
  inFlightToolEffect?: AutomationToolEffectRecord
  pendingApprovalId?: string
  artifactIds: string[]
  workspaceFingerprint: string
  gitHead?: string
  permissionDigest: string
  contextSnapshotId: string
  contextSummary?: string
  resumable: boolean
  nonResumableReason?: string
  reason: 'before_tool' | 'after_tool' | 'approval' | 'compaction' | 'artifact' | 'host_exit' | 'manual'
  createdAt: number
}

export interface AutomationToolEffectRecord {
  toolCallId: string
  toolName: string
  classification: AutomationToolSideEffectClass
  idempotencyKey?: string
  targetSummary?: string
  status: 'proposed' | 'completed' | 'failed' | 'uncertain'
  recoveryHint?: string
  startedAt: number
  completedAt?: number
  error?: string
}

export interface AutomationMemoryEntry {
  id: string
  definitionId: string
  revision: number
  source: 'run_summary' | 'user'
  sourceRunId?: string
  text: string
  evidence: Array<{
    kind: 'run' | 'artifact' | 'user_note'
    ref: string
  }>
  confidence: number
  status: 'suggested' | 'approved' | 'rejected' | 'stale'
  pinned: boolean
  createdAt: number
  updatedAt: number
  reviewedAt?: number
  reviewNote?: string
}

export interface AutomationMemorySnapshot {
  definitionId: string
  revision: number
  entries: Array<Pick<AutomationMemoryEntry, 'id' | 'text' | 'evidence' | 'confidence' | 'pinned'>>
  createdAt: number
}
