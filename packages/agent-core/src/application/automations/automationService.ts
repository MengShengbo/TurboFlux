import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ApprovalPolicy } from '../../shared/agentTypes'
import { AtomicJsonStore } from '../platform/atomicJsonStore'
import type {
  AutomationCapabilityPolicy,
  AutomationContextPolicy,
  AutomationDeliveryPolicy,
  AutomationContextSnapshot,
  AutomationObjective,
  AutomationPermissionSnapshot,
  AutomationReliabilityPolicy,
  AutomationRunMode,
  AutomationRecoveryAction,
  AutomationRoutingPolicy,
  AutomationAgentPolicy,
  AutomationRunResult,
  AutomationDefinitionStatus,
  AutomationApprovalRequest,
  AutomationValidationIssue,
  AutomationTriggerDefinition,
} from './automationTypes'
import { freezeAutomationAgentPolicy } from './automationRouting'

export type AutomationSchedule =
  | { kind: 'manual' }
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'cron'; expression: string }

export type AutomationMisfirePolicy = 'run-once' | 'skip'
export type AutomationOverlapPolicy = 'skip' | 'queue-one'
export type AutomationRunTrigger = 'manual' | 'scheduled' | 'retry' | 'recovery'
export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_workspace'
  | 'waiting_for_approval'
  | 'needs_review'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'invalid'
  | 'skipped'
  | 'missed'

export interface AutomationRetryPolicy {
  maxRetries: number
  backoffMinutes: number
}

export interface AutomationRunRecord {
  id: string
  definitionRevision: number
  inputId?: string
  conversationId?: string
  trigger: AutomationRunTrigger
  status: AutomationRunStatus
  scheduledFor?: number
  attempt: number
  startedAt: number
  updatedAt: number
  completedAt?: number
  retryAt?: number
  durationMs?: number
  resultSummary?: string
  result?: AutomationRunResult
  error?: string
  dryRun?: boolean
  permissionSnapshot: AutomationPermissionSnapshot
  contextSnapshot: AutomationContextSnapshot
  recovery?: {
    action: AutomationRecoveryAction
    checkpointId: string
    warnings: string[]
    skipToolCallIds: string[]
    unresolvedTool?: {
      toolCallId: string
      toolName: string
      classification: import('./automationSideEffects').AutomationToolSideEffectClass
      targetSummary?: string
    }
  }
  triggerData?: {
    source: 'webhook' | 'git' | 'plugin'
    trust: 'system' | 'verified_connector' | 'untrusted_external'
    summary: string
    serializedData: string
  }
}

export interface AutomationRecord {
  id: string
  revision: number
  name: string
  description?: string
  prompt: string
  objective: AutomationObjective
  workspacePath: string
  mode: AutomationRunMode
  capabilityPolicy: AutomationCapabilityPolicy
  contextPolicy: AutomationContextPolicy
  reliabilityPolicy: AutomationReliabilityPolicy
  routingPolicy?: AutomationRoutingPolicy
  agentPolicy?: AutomationAgentPolicy
  deliveryPolicy: AutomationDeliveryPolicy
  triggers: AutomationTriggerDefinition[]
  schedule: AutomationSchedule
  timezone: string
  enabled: boolean
  lifecycleStatus: AutomationDefinitionStatus
  validationIssues: AutomationValidationIssue[]
  riskSummary: string[]
  approvalPolicy: ApprovalPolicy
  misfirePolicy: AutomationMisfirePolicy
  overlapPolicy: AutomationOverlapPolicy
  retryPolicy: AutomationRetryPolicy
  maxRuntimeMinutes: number
  createdAt: number
  updatedAt: number
  nextRunAt?: number
  pendingRunAt?: number
  activeRunId?: string
  conversationId?: string
  lastRunAt?: number
  lastSuccessAt?: number
  lastDurationMs?: number
  lastStatus?: AutomationRunStatus
  lastError?: string
  lastInputId?: string
  history: AutomationRunRecord[]
}

export interface AutomationSchedulerHealth {
  status: 'idle' | 'watching' | 'running' | 'degraded'
  lastTickAt?: number
  nextWakeAt?: number
  activeRuns: number
  error?: string
}

export interface AutomationSnapshot {
  schemaVersion: 2
  warnings: string[]
  scheduler: AutomationSchedulerHealth
  automations: AutomationRecord[]
  pendingApprovals: AutomationApprovalRequest[]
}

export interface AutomationClaim {
  automation: AutomationRecord
  run: AutomationRunRecord
}

export type AutomationBeforePersistClaims = (claims: AutomationClaim[]) => void

interface AutomationStoreFile {
  schemaVersion: 1 | 2
  automations: AutomationRecord[]
  approvals?: AutomationApprovalRequest[]
}

export interface AutomationCreateInput {
  name: string
  description?: string
  prompt: string
  objective?: Partial<AutomationObjective>
  workspacePath: string
  mode?: AutomationRunMode
  capabilityPolicy?: Partial<AutomationCapabilityPolicy>
  contextPolicy?: Partial<AutomationContextPolicy>
  reliabilityPolicy?: Partial<AutomationReliabilityPolicy>
  routingPolicy?: Partial<AutomationRoutingPolicy>
  agentPolicy?: Partial<AutomationAgentPolicy>
  deliveryPolicy?: Partial<AutomationDeliveryPolicy>
  triggers?: AutomationTriggerDefinition[]
  schedule: AutomationSchedule
  timezone?: string
  enabled?: boolean
  lifecycleStatus?: AutomationDefinitionStatus
  approvalPolicy?: ApprovalPolicy
  misfirePolicy?: AutomationMisfirePolicy
  overlapPolicy?: AutomationOverlapPolicy
  retryPolicy?: Partial<AutomationRetryPolicy>
  maxRuntimeMinutes?: number
}

export type AutomationUpdateInput = Partial<Pick<AutomationRecord,
  'name' | 'description' | 'prompt' | 'objective' | 'mode' | 'capabilityPolicy' | 'contextPolicy' | 'reliabilityPolicy' | 'routingPolicy' | 'agentPolicy' | 'deliveryPolicy' | 'triggers' | 'enabled' | 'lifecycleStatus' | 'approvalPolicy' | 'timezone' | 'misfirePolicy' | 'overlapPolicy' | 'maxRuntimeMinutes'>> & {
    schedule?: AutomationSchedule
    retryPolicy?: Partial<AutomationRetryPolicy>
  }

const HISTORY_LIMIT = 100
const MISFIRE_GRACE_MS = 60_000
const AUTOMATION_PERMISSION_DECISIONS = new Set(['allow-once', 'allow-run', 'allow-session', 'deny'])

function normalizeApprovalOptions(kind: AutomationApprovalRequest['kind'], options?: string[]): string[] | undefined {
  const normalized = options?.map(option => option.trim().slice(0, 120)).filter(Boolean).slice(0, 12)
  if (kind === 'input') return normalized
  const declared = normalized === undefined ? ['allow-once'] : normalized.filter(option => AUTOMATION_PERMISSION_DECISIONS.has(option))
  return [...new Set([...declared, 'deny'])]
}

function validStore(value: unknown): value is AutomationStoreFile {
  if (!value || typeof value !== 'object') return false
  const store = value as Partial<AutomationStoreFile>
  return (store.schemaVersion === 1 || store.schemaVersion === 2)
    && Array.isArray(store.automations)
    && (store.approvals === undefined || Array.isArray(store.approvals))
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function normalizeTimezone(value: unknown): string {
  const timezone = typeof value === 'string' && value.trim() ? value.trim() : defaultTimezone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
  } catch {
    throw new Error(`Invalid automation timezone: ${timezone}`)
  }
  return timezone
}

function normalizeSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === 'once') {
    const timestamp = Date.parse(schedule.at)
    if (!Number.isFinite(timestamp)) throw new Error('One-time automation must use a valid date and time')
    return { kind: 'once', at: new Date(timestamp).toISOString() }
  }
  if (schedule.kind === 'interval') {
    const everyMinutes = Math.floor(Number(schedule.everyMinutes))
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) throw new Error('Automation interval must be at least one minute')
    return { kind: 'interval', everyMinutes: Math.min(525_600, everyMinutes) }
  }
  if (schedule.kind === 'daily' || schedule.kind === 'weekly') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('Scheduled automation time must use HH:mm')
    if (schedule.kind === 'weekly') {
      if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) throw new Error('Weekly automation weekday must be between 0 and 6')
      return { kind: 'weekly', weekday: schedule.weekday, time: schedule.time }
    }
    return { kind: 'daily', time: schedule.time }
  }
  if (schedule.kind === 'cron') {
    const expression = schedule.expression.trim().replace(/\s+/g, ' ')
    parseCronExpression(expression)
    return { kind: 'cron', expression }
  }
  return { kind: 'manual' }
}

function normalizeTriggers(
  value: AutomationTriggerDefinition[] | undefined,
  schedule: AutomationSchedule,
  timezone: string,
): AutomationTriggerDefinition[] {
  const fallback: AutomationTriggerDefinition[] = schedule.kind === 'cron'
    ? [{ id: 'schedule-primary', kind: 'cron', expression: schedule.expression, timezone }]
    : [{ id: 'schedule-primary', kind: 'schedule', schedule, timezone }]
  const triggers = value?.length ? value : fallback
  if (triggers.length > 16) throw new Error('Automation definitions support at most 16 triggers')
  const ids = new Set<string>()
  return triggers.map((trigger, index) => {
    const id = trigger.id.trim().slice(0, 120)
    if (!id || ids.has(id)) throw new Error(`Automation trigger ${index + 1} needs a unique id`)
    ids.add(id)
    if (trigger.kind === 'schedule') {
      const normalizedSchedule = normalizeSchedule(trigger.schedule)
      return normalizedSchedule.kind === 'cron'
        ? { id, kind: 'cron', expression: normalizedSchedule.expression, timezone: normalizeTimezone(trigger.timezone) }
        : { ...trigger, id, schedule: normalizedSchedule, timezone: normalizeTimezone(trigger.timezone) }
    }
    if (trigger.kind === 'cron') {
      const expression = trigger.expression.trim().slice(0, 180)
      parseCronExpression(expression)
      return { ...trigger, id, expression, timezone: normalizeTimezone(trigger.timezone) }
    }
    if (trigger.kind === 'webhook') {
      const sourceInstanceId = trigger.sourceInstanceId.trim().slice(0, 180)
      const secretRef = trigger.secretRef.trim().slice(0, 180)
      if (!sourceInstanceId || !secretRef) throw new Error('Webhook triggers require a source instance and secret reference')
      return {
        ...trigger,
        id,
        sourceInstanceId,
        secretRef,
        signature: 'hmac-sha256',
        maxPayloadBytes: Math.max(1, Math.min(1024 * 1024, Math.floor(trigger.maxPayloadBytes || 256 * 1024))),
        rateLimitPerMinute: Math.max(1, Math.min(10_000, Math.floor(trigger.rateLimitPerMinute ?? 60))),
        filters: trigger.filters?.slice(0, 32).map(filter => ({ ...filter, field: filter.field.trim().slice(0, 240) })),
      }
    }
    if (trigger.kind === 'git') {
      if (trigger.events.length === 0) throw new Error('Git triggers require at least one event type')
      return {
        ...trigger,
        id,
        events: [...new Set(trigger.events)],
        pathFilters: trigger.pathFilters.slice(0, 100).map(path => path.trim().slice(0, 500)).filter(Boolean),
        debounceMs: Math.max(250, Math.min(60_000, Math.floor(trigger.debounceMs ?? 1_500))),
        filters: trigger.filters?.slice(0, 32).map(filter => ({ ...filter, field: filter.field.trim().slice(0, 240) })),
      }
    }
    const pluginId = trigger.pluginId.trim().slice(0, 180)
    const providerId = trigger.providerId.trim().slice(0, 180)
    if (!pluginId || !providerId) throw new Error('Plugin triggers require plugin and provider ids')
    return {
      ...trigger,
      id,
      pluginId,
      providerId,
      providerVersion: trigger.providerVersion?.trim().slice(0, 120) || undefined,
      trust: trigger.trust === 'verified_connector' ? 'verified_connector' : 'untrusted_external',
      filters: trigger.filters?.slice(0, 32).map(filter => ({ ...filter, field: filter.field.trim().slice(0, 240) })),
    }
  })
}

interface ZonedDateParts {
  year: number
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
}

interface ParsedCronExpression {
  minutes: number[]
  hours: number[]
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  dayOfMonthWildcard: boolean
  dayOfWeekWildcard: boolean
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>()

function zonedParts(timestamp: number, timezone: string): ZonedDateParts {
  let formatter = zonedFormatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    zonedFormatterCache.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(timestamp)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday),
    hour: Number(value.hour),
    minute: Number(value.minute),
  }
}

function cronValue(value: string, names?: Record<string, number>): number {
  const normalized = names?.[value.toUpperCase()] ?? Number(value)
  if (!Number.isInteger(normalized)) throw new Error(`Invalid Cron value: ${value}`)
  return normalized
}

function cronField(source: string, minimum: number, maximum: number, names?: Record<string, number>, sunday = false): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>()
  const wildcard = source === '*' || source.startsWith('*/')
  for (const item of source.split(',')) {
    const [rangeSource, stepSource] = item.split('/')
    const step = stepSource === undefined ? 1 : Number(stepSource)
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) throw new Error(`Invalid Cron step: ${item}`)
    let start = minimum
    let end = maximum
    if (rangeSource !== '*') {
      const range = rangeSource!.split('-')
      start = cronValue(range[0]!, names)
      end = range.length === 1 ? start : cronValue(range[1]!, names)
      if (range.length > 2 || start > end) throw new Error(`Invalid Cron range: ${item}`)
    }
    const acceptedMaximum = sunday ? maximum + 1 : maximum
    if (start < minimum || start > acceptedMaximum || end < minimum || end > acceptedMaximum) throw new Error(`Cron value is out of range: ${item}`)
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value)
  }
  if (values.size === 0) throw new Error(`Cron field is empty: ${source}`)
  return { values, wildcard }
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron must contain exactly five fields: minute hour day month weekday')
  const minutes = cronField(fields[0]!, 0, 59)
  const hours = cronField(fields[1]!, 0, 23)
  const days = cronField(fields[2]!, 1, 31)
  const months = cronField(fields[3]!, 1, 12, { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 })
  const weekdays = cronField(fields[4]!, 0, 6, { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }, true)
  return {
    minutes: [...minutes.values].sort((left, right) => left - right),
    hours: [...hours.values].sort((left, right) => left - right),
    daysOfMonth: days.values,
    months: months.values,
    daysOfWeek: weekdays.values,
    dayOfMonthWildcard: days.wildcard,
    dayOfWeekWildcard: weekdays.wildcard,
  }
}

function sameZonedMinute(left: ZonedDateParts, right: ZonedDateParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute
}

function resolveZonedMinute(parts: Omit<ZonedDateParts, 'weekday'>, timezone: string): number[] {
  const utcTarget = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  const offsets = new Set<number>()
  for (const probe of [utcTarget - 24 * 60 * 60_000, utcTarget - 12 * 60 * 60_000, utcTarget, utcTarget + 12 * 60 * 60_000, utcTarget + 24 * 60 * 60_000]) {
    const local = zonedParts(probe, timezone)
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(probe / 60_000) * 60_000)
  }
  const results: number[] = []
  for (const offset of offsets) {
    const candidate = utcTarget - offset
    const local = zonedParts(candidate, timezone)
    if (local.year === parts.year && local.month === parts.month && local.day === parts.day && local.hour === parts.hour && local.minute === parts.minute) results.push(candidate)
  }
  return [...new Set(results)].sort((left, right) => left - right)
}

function cronDayMatches(cron: ParsedCronExpression, year: number, month: number, day: number): boolean {
  if (!cron.months.has(month)) return false
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const dayOfMonth = cron.daysOfMonth.has(day)
  const dayOfWeek = cron.daysOfWeek.has(weekday)
  if (cron.dayOfMonthWildcard) return cron.dayOfWeekWildcard || dayOfWeek
  if (cron.dayOfWeekWildcard) return dayOfMonth
  return dayOfMonth || dayOfWeek
}

function nextCalendarRunAt(schedule: Extract<AutomationSchedule, { kind: 'daily' | 'weekly' | 'cron' }>, timezone: string, after: number): number {
  const afterParts = zonedParts(after, timezone)
  const cron = schedule.kind === 'cron' ? parseCronExpression(schedule.expression) : undefined
  const [dailyHour, dailyMinute] = schedule.kind === 'cron' ? [0, 0] : schedule.time.split(':').map(Number)
  const startDate = Date.UTC(afterParts.year, afterParts.month - 1, afterParts.day)
  for (let dayOffset = 0; dayOffset <= 5 * 366; dayOffset += 1) {
    const date = new Date(startDate + dayOffset * 24 * 60 * 60_000)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (schedule.kind === 'weekly' && date.getUTCDay() !== schedule.weekday) continue
    if (cron && !cronDayMatches(cron, year, month, day)) continue
    const hours = cron?.hours ?? [dailyHour]
    const minutes = cron?.minutes ?? [dailyMinute]
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const candidate of resolveZonedMinute({ year, month, day, hour, minute }, timezone)) {
          if (candidate <= after) continue
          if (sameZonedMinute(zonedParts(candidate, timezone), afterParts)) continue
          return candidate
        }
      }
    }
  }
  throw new Error(`Unable to resolve the next automation time in ${timezone}`)
}

export function nextAutomationRunAt(schedule: AutomationSchedule, timezone: string, after = Date.now()): number | undefined {
  if (schedule.kind === 'manual') return undefined
  if (schedule.kind === 'once') {
    const timestamp = Date.parse(schedule.at)
    return timestamp > after ? timestamp : undefined
  }
  if (schedule.kind === 'interval') return after + schedule.everyMinutes * 60_000
  return nextCalendarRunAt(schedule, timezone, after)
}

export function nextAutomationRunTimes(schedule: AutomationSchedule, timezone: string, count = 5, after = Date.now()): number[] {
  const times: number[] = []
  let cursor = after
  for (let index = 0; index < Math.max(0, Math.min(20, Math.floor(count))); index += 1) {
    const next = nextAutomationRunAt(schedule, timezone, cursor)
    if (next === undefined) break
    times.push(next)
    cursor = next
    if (schedule.kind === 'once') break
  }
  return times
}

function nextFutureRunAt(schedule: AutomationSchedule, timezone: string, scheduledFor: number, now: number): number | undefined {
  if (schedule.kind === 'once' || schedule.kind === 'manual') return undefined
  if (schedule.kind === 'interval') {
    const intervalMs = schedule.everyMinutes * 60_000
    const elapsedIntervals = Math.floor(Math.max(0, now - scheduledFor) / intervalMs) + 1
    return scheduledFor + elapsedIntervals * intervalMs
  }
  let next = nextAutomationRunAt(schedule, timezone, scheduledFor)
  let guard = 0
  while (next !== undefined && next <= now && guard < 400) {
    next = nextAutomationRunAt(schedule, timezone, next)
    guard += 1
  }
  return next
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
  return value === 'agent' || value === 'full' ? value : 'ask'
}

function normalizeMisfirePolicy(value: unknown): AutomationMisfirePolicy {
  return value === 'skip' ? 'skip' : 'run-once'
}

function normalizeOverlapPolicy(value: unknown): AutomationOverlapPolicy {
  return value === 'queue-one' ? 'queue-one' : 'skip'
}

function normalizeRetryPolicy(value: Partial<AutomationRetryPolicy> | undefined): AutomationRetryPolicy {
  return {
    maxRetries: Math.max(0, Math.min(10, Math.floor(Number(value?.maxRetries ?? 2)))),
    backoffMinutes: Math.max(1, Math.min(1_440, Math.floor(Number(value?.backoffMinutes ?? 2)))),
  }
}

function normalizeMaxRuntime(value: unknown): number {
  const minutes = Math.floor(Number(value ?? 60))
  return Math.max(1, Math.min(24 * 60, Number.isFinite(minutes) ? minutes : 60))
}

function cloneRun(run: AutomationRunRecord): AutomationRunRecord {
  return {
    ...run,
    result: run.result ? JSON.parse(JSON.stringify(run.result)) as AutomationRunResult : undefined,
    permissionSnapshot: JSON.parse(JSON.stringify(run.permissionSnapshot)) as AutomationPermissionSnapshot,
    contextSnapshot: JSON.parse(JSON.stringify(run.contextSnapshot)) as AutomationContextSnapshot,
  }
}

function cloneAutomation(automation: AutomationRecord): AutomationRecord {
  return {
    ...automation,
    triggers: JSON.parse(JSON.stringify(automation.triggers)) as AutomationTriggerDefinition[],
    objective: JSON.parse(JSON.stringify(automation.objective)) as AutomationObjective,
    capabilityPolicy: JSON.parse(JSON.stringify(automation.capabilityPolicy)) as AutomationCapabilityPolicy,
    contextPolicy: JSON.parse(JSON.stringify(automation.contextPolicy)) as AutomationContextPolicy,
    reliabilityPolicy: JSON.parse(JSON.stringify(automation.reliabilityPolicy)) as AutomationReliabilityPolicy,
    routingPolicy: automation.routingPolicy ? JSON.parse(JSON.stringify(automation.routingPolicy)) as AutomationRoutingPolicy : undefined,
    agentPolicy: automation.agentPolicy ? JSON.parse(JSON.stringify(automation.agentPolicy)) as AutomationAgentPolicy : undefined,
    deliveryPolicy: JSON.parse(JSON.stringify(automation.deliveryPolicy)) as AutomationDeliveryPolicy,
    schedule: { ...automation.schedule },
    retryPolicy: { ...automation.retryPolicy },
    history: automation.history.map(cloneRun),
  }
}

function normalizeRunMode(value: unknown, fallback: AutomationRunMode): AutomationRunMode {
  return value === 'isolated' || value === 'continuation' ? value : fallback
}

function normalizeLifecycleStatus(value: unknown, fallback: AutomationDefinitionStatus): AutomationDefinitionStatus {
  return ['draft', 'testing', 'active', 'paused', 'archived', 'invalid'].includes(String(value))
    ? value as AutomationDefinitionStatus
    : fallback
}

function boundedStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item).trim()).filter(Boolean).slice(0, limit).map(item => item.slice(0, 2_000))
}

function normalizeContextPolicy(
  mode: AutomationRunMode,
  value?: Partial<AutomationContextPolicy>,
  continuationConversationId?: string,
): AutomationContextPolicy {
  const normalizedMode = normalizeRunMode(value?.mode, mode)
  return {
    mode: normalizedMode,
    continuationConversationId: normalizedMode === 'continuation'
      ? value?.continuationConversationId?.trim().slice(0, 180) || continuationConversationId
      : undefined,
    includeAutomationMemory: value?.includeAutomationMemory === true,
    includePreviousRunSummary: value?.includePreviousRunSummary === true,
    fileRefs: boundedStrings(value?.fileRefs, 200),
    skillIds: boundedStrings(value?.skillIds, 100),
  }
}

function normalizeReliabilityPolicy(
  value: Partial<AutomationReliabilityPolicy> | undefined,
  legacy: {
    misfirePolicy?: AutomationMisfirePolicy
    overlapPolicy?: AutomationOverlapPolicy
    retryPolicy?: Partial<AutomationRetryPolicy>
    maxRuntimeMinutes?: number
  } = {},
): AutomationReliabilityPolicy {
  const retry = normalizeRetryPolicy({ ...legacy.retryPolicy, ...value?.retry })
  return {
    misfirePolicy: normalizeMisfirePolicy(value?.misfirePolicy ?? legacy.misfirePolicy),
    overlapPolicy: normalizeOverlapPolicy(value?.overlapPolicy ?? legacy.overlapPolicy),
    maxParallel: Math.max(1, Math.min(8, Math.floor(Number(value?.maxParallel ?? 1)))),
    maxQueuedRuns: Math.max(1, Math.min(100, Math.floor(Number(value?.maxQueuedRuns ?? 1)))),
    maxRuntimeMinutes: normalizeMaxRuntime(value?.maxRuntimeMinutes ?? legacy.maxRuntimeMinutes),
    maxToolCalls: Math.max(1, Math.min(10_000, Math.floor(Number(value?.maxToolCalls ?? 100)))),
    maxInputTokens: value?.maxInputTokens === undefined ? undefined : Math.max(1, Math.floor(Number(value.maxInputTokens))),
    maxOutputTokens: value?.maxOutputTokens === undefined ? undefined : Math.max(1, Math.floor(Number(value.maxOutputTokens))),
    retry: {
      ...retry,
      maxBackoffMinutes: Math.max(retry.backoffMinutes, Math.min(10_080, Math.floor(Number(value?.retry?.maxBackoffMinutes ?? 1_440)))),
      jitter: Math.max(0, Math.min(1, Number(value?.retry?.jitter ?? 0.1))),
    },
    concurrencyGroup: value?.concurrencyGroup?.id?.trim() ? {
      id: value.concurrencyGroup.id.trim().slice(0, 180),
      maxParallel: Math.max(1, Math.min(32, Math.floor(Number(value.concurrencyGroup.maxParallel ?? 1)))),
    } : undefined,
    resourceLocks: (value?.resourceLocks ?? []).slice(0, 32).map(lock => ({
      key: String(lock.key).trim().slice(0, 240),
      mode: lock.mode === 'shared' ? 'shared' as const : 'exclusive' as const,
    })).filter(lock => Boolean(lock.key)),
  }
}

function normalizeRoutingPolicy(value?: Partial<AutomationRoutingPolicy>): AutomationRoutingPolicy {
  const ids = new Set<string>()
  return {
    rules: (value?.rules ?? []).slice(0, 64).map((rule, index) => {
      const id = String(rule.id || `route-${index + 1}`).trim().slice(0, 120)
      if (!id || ids.has(id)) throw new Error('Automation route rules require unique ids')
      ids.add(id)
      return {
        id,
        label: String(rule.label || id).trim().slice(0, 180),
        filters: (rule.filters ?? []).slice(0, 20).map(filter => JSON.parse(JSON.stringify(filter))),
        action: rule.action === 'skip' ? 'skip' as const : 'run' as const,
        objectiveSuffix: rule.objectiveSuffix?.trim().slice(0, 4_000),
        agentStrategyId: rule.agentStrategyId?.trim().slice(0, 180),
      }
    }),
    defaultAction: value?.defaultAction === 'skip' ? 'skip' : 'run',
    defaultAgentStrategyId: value?.defaultAgentStrategyId?.trim().slice(0, 180),
  }
}

function normalizeAgentPolicy(value?: Partial<AutomationAgentPolicy>): AutomationAgentPolicy {
  const ids = new Set<string>()
  const strategies = (value?.strategies ?? []).slice(0, 16).map((strategy, index) => {
    const id = String(strategy.id || `strategy-${index + 1}`).trim().slice(0, 120)
    if (!id || ids.has(id)) throw new Error('Automation agent strategies require unique ids')
    ids.add(id)
    return {
      id,
      label: String(strategy.label || id).trim().slice(0, 180),
      allowedAgentTypes: boundedStrings(strategy.allowedAgentTypes, 32).map(item => item.slice(0, 120)),
      maxSubtasks: Math.max(1, Math.min(100, Math.floor(Number(strategy.maxSubtasks ?? 4)))),
      maxParallel: Math.max(1, Math.min(8, Math.floor(Number(strategy.maxParallel ?? 2)))),
    }
  })
  const defaultStrategyId = value?.defaultStrategyId?.trim().slice(0, 120)
  if (defaultStrategyId && !ids.has(defaultStrategyId)) throw new Error(`Automation default agent strategy is missing: ${defaultStrategyId}`)
  return { enabled: value?.enabled === true, defaultStrategyId, strategies }
}

function normalizeDeliveryPolicy(value?: Partial<AutomationDeliveryPolicy>): AutomationDeliveryPolicy {
  const validEvents = new Set(['success', 'no_change', 'partial', 'failed', 'timeout', 'budget', 'approval', 'invalid', 'recovered'])
  const events = (candidate: unknown, fallback: AutomationDeliveryPolicy['desktop']) => Array.isArray(candidate)
    ? candidate.filter((item): item is AutomationDeliveryPolicy['desktop'][number] => validEvents.has(String(item))).slice(0, 9)
    : fallback
  const migrateFailureEvents = (candidate: AutomationDeliveryPolicy['desktop']) => value?.eventPolicyVersion === 2 || !candidate.includes('failed')
    ? candidate
    : [...new Set([...candidate, 'timeout' as const, 'budget' as const, 'recovered' as const])]
  return {
    eventPolicyVersion: 2,
    desktop: migrateFailureEvents(events(value?.desktop, ['failed', 'timeout', 'budget', 'approval', 'invalid', 'recovered'])),
    remoteMobile: migrateFailureEvents(events(value?.remoteMobile, ['approval'])),
    digest: value?.digest === 'hourly' || value?.digest === 'daily' ? value.digest : 'immediate',
    failureCooldownMinutes: Math.max(0, Math.min(7 * 24 * 60, Math.floor(Number(value?.failureCooldownMinutes ?? 30)))),
    providerRefs: boundedStrings(value?.providerRefs, 50),
    providerEvents: migrateFailureEvents(events(value?.providerEvents, ['success', 'no_change', 'partial', 'failed', 'timeout', 'budget', 'invalid', 'recovered'])),
    providerVersions: Object.fromEntries(Object.entries(value?.providerVersions ?? {}).slice(0, 50).map(([key, version]) => [
      key.trim().slice(0, 300),
      String(version).trim().slice(0, 120),
    ]).filter(([key, version]) => Boolean(key && version))),
  }
}

function normalizeObjective(prompt: string, value?: Partial<AutomationObjective>): AutomationObjective {
  const originalPrompt = value?.originalPrompt?.trim().slice(0, 40_000) || prompt
  return {
    originalPrompt,
    goal: value?.goal?.trim().slice(0, 40_000) || prompt,
    successCriteria: boundedStrings(value?.successCriteria, 50),
    deliverables: boundedStrings(value?.deliverables, 50),
    constraints: boundedStrings(value?.constraints, 50),
    noChangeBehavior: value?.noChangeBehavior?.trim().slice(0, 4_000) || undefined,
    failureBehavior: value?.failureBehavior?.trim().slice(0, 4_000) || undefined,
  }
}

function normalizeCapabilityPolicy(
  workspacePath: string,
  approvalPolicy: ApprovalPolicy,
  value?: Partial<AutomationCapabilityPolicy>,
): AutomationCapabilityPolicy {
  const paths = Array.isArray(value?.paths)
    ? value.paths.slice(0, 50).map(item => ({ path: resolve(item.path), access: item.access === 'read' ? 'read' as const : 'write' as const }))
    : [{ path: resolve(workspacePath), access: 'write' as const }]
  return {
    approvalPolicy: normalizeApprovalPolicy(value?.approvalPolicy ?? approvalPolicy),
    allowedTools: boundedStrings(value?.allowedTools, 200),
    deniedTools: boundedStrings(value?.deniedTools, 200),
    paths,
    networkDomains: boundedStrings(value?.networkDomains, 200).map(domain => domain.toLowerCase()),
    secretRefs: boundedStrings(value?.secretRefs, 100),
    mcpServerIds: boundedStrings(value?.mcpServerIds, 100),
    pluginIds: boundedStrings(value?.pluginIds, 100),
    allowComputerUse: value?.allowComputerUse === true,
    allowBackgroundComputerUse: value?.allowBackgroundComputerUse === true && value?.allowComputerUse === true,
  }
}

function terminalStatus(status: AutomationRunStatus): boolean {
  return ['completed', 'failed', 'canceled', 'interrupted', 'invalid', 'skipped', 'missed', 'retry_scheduled'].includes(status)
}

export class AutomationService {
  private readonly store: AtomicJsonStore<AutomationStoreFile>
  private data: AutomationStoreFile
  private warnings: string[]
  private scheduler: AutomationSchedulerHealth = { status: 'idle', activeRuns: 0 }

  constructor(storePath: string) {
    this.store = new AtomicJsonStore(storePath, () => ({ schemaVersion: 2, automations: [], approvals: [] }), validStore)
    const loaded = this.store.load()
    this.data = loaded.value
    this.warnings = loaded.warnings
    if (this.normalizeLoadedRecords()) this.persist()
  }

  list(workspacePath?: string): AutomationSnapshot {
    const normalizedWorkspace = workspacePath ? resolve(workspacePath) : undefined
    return {
      schemaVersion: 2,
      warnings: [...this.warnings],
      scheduler: { ...this.scheduler },
      pendingApprovals: (this.data.approvals ?? [])
        .filter(approval => approval.status === 'pending' && (!normalizedWorkspace || approval.workspacePath === normalizedWorkspace))
        .map(approval => JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest)
        .sort((left, right) => left.expiresAt - right.expiresAt),
      automations: this.data.automations
        .filter(automation => !normalizedWorkspace || automation.workspacePath === normalizedWorkspace)
        .map(cloneAutomation)
        .sort((left, right) => Number(right.enabled) - Number(left.enabled) || right.updatedAt - left.updatedAt),
    }
  }

  recordSchedulerHealth(update: Partial<AutomationSchedulerHealth>): void {
    this.scheduler = { ...this.scheduler, ...update }
  }

  recordValidation(id: string, validationIssues: AutomationValidationIssue[], riskSummary: string[]): AutomationRecord {
    const automation = this.requireAutomation(id)
    automation.validationIssues = JSON.parse(JSON.stringify(validationIssues)) as AutomationValidationIssue[]
    automation.riskSummary = riskSummary.map(item => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20)
    automation.updatedAt = Date.now()
    this.persist()
    return cloneAutomation(automation)
  }

  recordApproval(request: AutomationApprovalRequest): AutomationApprovalRequest {
    const requestId = request.id.trim().slice(0, 180)
    if (!requestId) throw new Error('Automation approval ID is required')
    const automation = this.requireAutomation(request.automationId)
    const run = automation.history.find(item => item.id === request.runId)
    if (!run) throw new Error(`Automation run not found for approval: ${request.runId}`)
    this.data.approvals ??= []
    const existing = this.data.approvals.find(approval => approval.id === requestId)
    if (existing) {
      if (existing.automationId !== request.automationId || existing.runId !== request.runId || existing.conversationId !== request.conversationId) {
        throw new Error(`Automation approval ID was replayed across runs: ${requestId}`)
      }
      if (existing.status !== 'pending') throw new Error(`Automation approval is already ${existing.status}`)
      return JSON.parse(JSON.stringify(existing)) as AutomationApprovalRequest
    }
    const requestTime = Number.isFinite(request.requestedAt) ? Math.floor(request.requestedAt) : Date.now()
    const requestedAt = Math.max(run.startedAt, requestTime)
    const requestedExpiry = Number.isFinite(request.expiresAt) ? Math.floor(request.expiresAt) : requestedAt + 24 * 60 * 60_000
    const normalized: AutomationApprovalRequest = {
      ...JSON.parse(JSON.stringify(request)) as AutomationApprovalRequest,
      id: requestId,
      automationName: automation.name,
      workspacePath: automation.workspacePath,
      definitionRevision: run.definitionRevision,
      permissionSnapshotId: run.permissionSnapshot.id,
      question: request.question.trim().slice(0, 2_000),
      options: normalizeApprovalOptions(request.kind, request.options),
      reason: request.reason?.trim().slice(0, 2_000),
      toolName: request.toolName?.trim().slice(0, 180),
      path: request.path?.trim().slice(0, 2_000),
      targetSummary: request.targetSummary?.trim().slice(0, 2_000),
      priorSideEffects: request.priorSideEffects?.map(item => item.trim().slice(0, 500)).filter(Boolean).slice(0, 50),
      requestedAt,
      expiresAt: Math.max(requestedAt + 5 * 60_000, Math.min(requestedAt + 7 * 24 * 60 * 60_000, requestedExpiry)),
      status: 'pending',
    }
    this.data.approvals.unshift(normalized)
    this.data.approvals = this.data.approvals.slice(0, 1_000)
    this.persist()
    return JSON.parse(JSON.stringify(normalized)) as AutomationApprovalRequest
  }

  getApproval(id: string): AutomationApprovalRequest | null {
    const approval = (this.data.approvals ?? []).find(item => item.id === id)
    return approval ? JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest : null
  }

  listApprovals(runId?: string): AutomationApprovalRequest[] {
    return (this.data.approvals ?? [])
      .filter(approval => !runId || approval.runId === runId)
      .map(approval => JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest)
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  expireApprovals(now = Date.now()): AutomationApprovalRequest[] {
    const expired: AutomationApprovalRequest[] = []
    for (const approval of this.data.approvals ?? []) {
      if (approval.status !== 'pending' || approval.expiresAt > now) continue
      approval.status = 'expired'
      approval.decision = 'deny'
      approval.responseChannel = 'system'
      approval.resolvedAt = now
      expired.push(JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest)
    }
    if (expired.length > 0) this.persist()
    return expired
  }

  cancelApproval(id: string, now = Date.now()): AutomationApprovalRequest {
    const approval = (this.data.approvals ?? []).find(item => item.id === id)
    if (!approval) throw new Error(`Automation approval not found: ${id}`)
    if (approval.status !== 'pending') return JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest
    approval.status = 'canceled'
    approval.decision = 'deny'
    approval.responseChannel = 'system'
    approval.resolvedAt = now
    this.persist()
    return JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest
  }

  resolveApproval(
    id: string,
    decision: string,
    channel: AutomationApprovalRequest['responseChannel'],
    now = Date.now(),
    deviceId?: string,
  ): AutomationApprovalRequest {
    const approval = (this.data.approvals ?? []).find(item => item.id === id)
    if (!approval) throw new Error(`Automation approval not found: ${id}`)
    if (approval.status !== 'pending') throw new Error(`Automation approval is already ${approval.status}`)
    const normalizedDecision = decision.trim().slice(0, 120)
    const allowedDecision = approval.kind === 'input'
      || normalizedDecision === 'deny'
      || (approval.options?.length
        ? approval.options.includes(normalizedDecision)
        : ['allow-once', 'allow-run', 'allow-session'].includes(normalizedDecision))
    if (!normalizedDecision || !allowedDecision) throw new Error('Automation approval response is not allowed')
    const expired = approval.expiresAt <= now
    approval.status = expired ? 'expired' : normalizedDecision === 'deny' || normalizedDecision === 'cancelled' ? 'denied' : 'approved'
    approval.decision = expired ? 'deny' : normalizedDecision
    approval.responseChannel = expired ? 'system' : channel
    approval.responseDeviceId = expired ? undefined : deviceId?.trim().slice(0, 180) || undefined
    approval.resolvedAt = now
    this.persist()
    return JSON.parse(JSON.stringify(approval)) as AutomationApprovalRequest
  }

  create(input: AutomationCreateInput): AutomationSnapshot {
    const name = input.name.trim().slice(0, 120)
    const prompt = input.prompt.trim().slice(0, 40_000)
    if (!name || !prompt) throw new Error('Automation name and prompt are required')
    const schedule = normalizeSchedule(input.schedule)
    const timezone = normalizeTimezone(input.timezone)
    const now = Date.now()
    const enabled = input.enabled !== false
    const lifecycleStatus = normalizeLifecycleStatus(input.lifecycleStatus, enabled ? 'active' : 'paused')
    const schedulingEnabled = lifecycleStatus === 'active' && enabled
    const approvalPolicy = normalizeApprovalPolicy(input.capabilityPolicy?.approvalPolicy ?? input.approvalPolicy)
    const mode = normalizeRunMode(input.contextPolicy?.mode ?? input.mode, 'isolated')
    const contextPolicy = normalizeContextPolicy(mode, input.contextPolicy)
    const reliabilityPolicy = normalizeReliabilityPolicy(input.reliabilityPolicy, input)
    const routingPolicy = normalizeRoutingPolicy(input.routingPolicy)
    const agentPolicy = normalizeAgentPolicy(input.agentPolicy)
    const deliveryPolicy = normalizeDeliveryPolicy(input.deliveryPolicy)
    const triggers = normalizeTriggers(input.triggers, schedule, timezone)
    const scheduledAt = schedulingEnabled ? nextAutomationRunAt(schedule, timezone, now) : undefined
    if (schedulingEnabled && schedule.kind === 'once' && scheduledAt === undefined) throw new Error('One-time automation must be scheduled in the future')
    this.data.automations.push({
      id: `automation-${randomUUID()}`,
      revision: 1,
      name,
      description: input.description?.trim().slice(0, 2_000) || undefined,
      prompt,
      objective: normalizeObjective(prompt, input.objective),
      workspacePath: resolve(input.workspacePath),
      mode,
      capabilityPolicy: normalizeCapabilityPolicy(input.workspacePath, approvalPolicy, input.capabilityPolicy),
      contextPolicy,
      reliabilityPolicy,
      routingPolicy,
      agentPolicy,
      deliveryPolicy,
      triggers,
      schedule,
      timezone,
      enabled: schedulingEnabled,
      lifecycleStatus,
      validationIssues: [],
      riskSummary: [],
      approvalPolicy,
      misfirePolicy: reliabilityPolicy.misfirePolicy,
      overlapPolicy: normalizeOverlapPolicy(reliabilityPolicy.overlapPolicy),
      retryPolicy: { maxRetries: reliabilityPolicy.retry.maxRetries, backoffMinutes: reliabilityPolicy.retry.backoffMinutes },
      maxRuntimeMinutes: reliabilityPolicy.maxRuntimeMinutes,
      createdAt: now,
      updatedAt: now,
      nextRunAt: scheduledAt,
      history: [],
    })
    this.persist()
    return this.list(input.workspacePath)
  }

  update(id: string, patch: AutomationUpdateInput): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    const behaviorChanged = [
      'name',
      'description',
      'prompt',
      'objective',
      'mode',
      'capabilityPolicy',
      'contextPolicy',
      'reliabilityPolicy',
      'routingPolicy',
      'agentPolicy',
      'deliveryPolicy',
      'triggers',
      'schedule',
      'timezone',
      'approvalPolicy',
      'misfirePolicy',
      'overlapPolicy',
      'retryPolicy',
      'maxRuntimeMinutes',
      'enabled',
      'lifecycleStatus',
    ].some(key => Object.prototype.hasOwnProperty.call(patch, key))
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 120)
      if (!name) throw new Error('Automation name cannot be empty')
      automation.name = name
    }
    if (patch.description !== undefined) automation.description = patch.description.trim().slice(0, 2_000) || undefined
    if (patch.prompt !== undefined) {
      const prompt = patch.prompt.trim().slice(0, 40_000)
      if (!prompt) throw new Error('Automation prompt cannot be empty')
      automation.prompt = prompt
      if (patch.objective === undefined) automation.objective = normalizeObjective(prompt, { ...automation.objective, originalPrompt: prompt, goal: prompt })
    }
    if (patch.objective !== undefined) automation.objective = normalizeObjective(automation.prompt, patch.objective)
    if (patch.mode !== undefined) {
      const mode = normalizeRunMode(patch.mode, automation.mode)
      if (mode !== automation.mode) automation.conversationId = undefined
      automation.mode = mode
    }
    if (patch.contextPolicy !== undefined) {
      automation.contextPolicy = normalizeContextPolicy(automation.mode, { ...automation.contextPolicy, ...patch.contextPolicy }, automation.conversationId)
      automation.mode = automation.contextPolicy.mode
    } else if (patch.mode !== undefined) {
      automation.contextPolicy = normalizeContextPolicy(automation.mode, automation.contextPolicy, automation.conversationId)
    }
    const schedule = patch.schedule ? normalizeSchedule(patch.schedule) : automation.schedule
    const timezone = patch.timezone !== undefined ? normalizeTimezone(patch.timezone) : automation.timezone
    const lifecycleStatus = patch.lifecycleStatus !== undefined
      ? normalizeLifecycleStatus(patch.lifecycleStatus, automation.lifecycleStatus)
      : patch.enabled === undefined ? automation.lifecycleStatus : patch.enabled ? 'active' : 'paused'
    const requestedEnabled = patch.enabled ?? automation.enabled
    const enabled = lifecycleStatus === 'active' && (requestedEnabled || patch.lifecycleStatus === 'active')
    const updatedAt = Date.now()
    const scheduleChanged = patch.schedule !== undefined || patch.timezone !== undefined || patch.enabled !== undefined || patch.lifecycleStatus !== undefined
    const scheduledAt = enabled
      ? scheduleChanged ? nextAutomationRunAt(schedule, timezone, updatedAt) : automation.nextRunAt
      : undefined
    if (enabled && schedule.kind === 'once' && scheduledAt === undefined && !automation.activeRunId) throw new Error('One-time automation must be scheduled in the future')
    automation.schedule = schedule
    automation.timezone = timezone
    automation.enabled = enabled
    automation.lifecycleStatus = lifecycleStatus
    if (patch.approvalPolicy !== undefined) {
      automation.approvalPolicy = normalizeApprovalPolicy(patch.approvalPolicy)
      automation.capabilityPolicy = normalizeCapabilityPolicy(automation.workspacePath, automation.approvalPolicy, {
        ...automation.capabilityPolicy,
        approvalPolicy: automation.approvalPolicy,
      })
    }
    if (patch.capabilityPolicy !== undefined) {
      automation.capabilityPolicy = normalizeCapabilityPolicy(automation.workspacePath, automation.approvalPolicy, patch.capabilityPolicy)
      automation.approvalPolicy = automation.capabilityPolicy.approvalPolicy
    }
    if (patch.misfirePolicy !== undefined) automation.misfirePolicy = normalizeMisfirePolicy(patch.misfirePolicy)
    if (patch.overlapPolicy !== undefined) automation.overlapPolicy = normalizeOverlapPolicy(patch.overlapPolicy)
    if (patch.retryPolicy !== undefined) automation.retryPolicy = normalizeRetryPolicy({ ...automation.retryPolicy, ...patch.retryPolicy })
    if (patch.maxRuntimeMinutes !== undefined) automation.maxRuntimeMinutes = normalizeMaxRuntime(patch.maxRuntimeMinutes)
    if (patch.reliabilityPolicy !== undefined
      || patch.misfirePolicy !== undefined
      || patch.overlapPolicy !== undefined
      || patch.retryPolicy !== undefined
      || patch.maxRuntimeMinutes !== undefined) {
      automation.reliabilityPolicy = normalizeReliabilityPolicy(
        patch.reliabilityPolicy ? { ...automation.reliabilityPolicy, ...patch.reliabilityPolicy } : automation.reliabilityPolicy,
        {
          misfirePolicy: patch.misfirePolicy ?? automation.misfirePolicy,
          overlapPolicy: patch.overlapPolicy ?? automation.overlapPolicy,
          retryPolicy: patch.retryPolicy ? { ...automation.retryPolicy, ...patch.retryPolicy } : automation.retryPolicy,
          maxRuntimeMinutes: patch.maxRuntimeMinutes ?? automation.maxRuntimeMinutes,
        },
      )
      automation.misfirePolicy = automation.reliabilityPolicy.misfirePolicy
      automation.overlapPolicy = normalizeOverlapPolicy(automation.reliabilityPolicy.overlapPolicy)
      automation.retryPolicy = {
        maxRetries: automation.reliabilityPolicy.retry.maxRetries,
        backoffMinutes: automation.reliabilityPolicy.retry.backoffMinutes,
      }
      automation.maxRuntimeMinutes = automation.reliabilityPolicy.maxRuntimeMinutes
    }
    if (patch.routingPolicy !== undefined) automation.routingPolicy = normalizeRoutingPolicy(patch.routingPolicy)
    if (patch.agentPolicy !== undefined) automation.agentPolicy = normalizeAgentPolicy(patch.agentPolicy)
    if (patch.deliveryPolicy !== undefined) automation.deliveryPolicy = normalizeDeliveryPolicy({ ...automation.deliveryPolicy, ...patch.deliveryPolicy })
    if (patch.triggers !== undefined) automation.triggers = normalizeTriggers(patch.triggers, schedule, timezone)
    else if ((patch.schedule !== undefined || patch.timezone !== undefined)
      && automation.triggers.every(trigger => ['schedule', 'cron'].includes(trigger.kind))) {
      automation.triggers = normalizeTriggers(undefined, schedule, timezone)
    }
    if (behaviorChanged) automation.revision += 1
    automation.updatedAt = updatedAt
    automation.nextRunAt = scheduledAt
    this.persist()
    return this.list(automation.workspacePath)
  }

  duplicate(id: string): AutomationSnapshot {
    const source = this.requireAutomation(id)
    return this.create({
      name: `${source.name} 副本`,
      prompt: source.prompt,
      objective: source.objective,
      workspacePath: source.workspacePath,
      mode: source.mode,
      capabilityPolicy: source.capabilityPolicy,
      contextPolicy: source.contextPolicy,
      reliabilityPolicy: source.reliabilityPolicy,
      routingPolicy: source.routingPolicy,
      agentPolicy: source.agentPolicy,
      deliveryPolicy: source.deliveryPolicy,
      triggers: source.triggers,
      schedule: source.schedule,
      timezone: source.timezone,
      enabled: false,
      lifecycleStatus: 'paused',
      approvalPolicy: source.approvalPolicy,
      misfirePolicy: source.misfirePolicy,
      overlapPolicy: source.overlapPolicy,
      retryPolicy: source.retryPolicy,
      maxRuntimeMinutes: source.maxRuntimeMinutes,
    })
  }

  remove(id: string): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('Stop the active automation run before deleting it')
    this.data.automations = this.data.automations.filter(item => item.id !== id)
    this.persist()
    return this.list(automation.workspacePath)
  }

  clearRunData(id: string): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('Stop the active automation run before deleting run data')
    automation.history = []
    automation.pendingRunAt = undefined
    automation.lastRunAt = undefined
    automation.lastStatus = undefined
    automation.lastError = undefined
    this.data.approvals = (this.data.approvals ?? []).filter(approval => approval.automationId !== id)
    automation.updatedAt = Date.now()
    this.persist()
    return this.list(automation.workspacePath)
  }

  due(workspacePath: string, now = Date.now()): AutomationRecord[] {
    const normalizedWorkspace = resolve(workspacePath)
    return this.data.automations
      .filter(automation => automation.enabled
        && automation.workspacePath === normalizedWorkspace
        && !automation.activeRunId
        && (automation.pendingRunAt !== undefined || automation.nextRunAt !== undefined && automation.nextRunAt <= now || this.retryDue(automation, now)))
      .map(cloneAutomation)
  }

  nextWakeAt(workspacePath: string, now = Date.now()): number | undefined {
    const normalizedWorkspace = resolve(workspacePath)
    const times: number[] = []
    for (const automation of this.data.automations) {
      if (automation.workspacePath !== normalizedWorkspace || automation.activeRunId) continue
      if (automation.pendingRunAt !== undefined) times.push(now)
      if (automation.enabled && automation.nextRunAt !== undefined) times.push(automation.nextRunAt)
      for (const run of automation.history) if (run.status === 'retry_scheduled' && run.retryAt !== undefined) times.push(run.retryAt)
    }
    return times.length > 0 ? Math.min(...times) : undefined
  }

  claimDue(workspacePath: string, options: { now?: number; limit?: number; beforePersist?: AutomationBeforePersistClaims } = {}): AutomationClaim[] {
    const normalizedWorkspace = resolve(workspacePath)
    const now = options.now ?? Date.now()
    const claims: AutomationClaim[] = []
    const limit = Math.max(1, Math.min(8, options.limit ?? 2))
    const before = JSON.parse(JSON.stringify(this.data)) as AutomationStoreFile
    try {
      let changed = false
      for (const automation of this.data.automations) {
        if (claims.length >= limit || automation.workspacePath !== normalizedWorkspace || automation.activeRunId) continue
        const retry = automation.history.find(run => run.status === 'retry_scheduled' && run.retryAt !== undefined && run.retryAt <= now)
        if (retry) {
          retry.status = 'failed'
          retry.updatedAt = now
          const run = this.createRun(automation, 'retry', now, retry.scheduledFor, retry.attempt + 1, false, retry)
          claims.push({ automation: cloneAutomation(automation), run: cloneRun(run) })
          changed = true
          continue
        }
        if (automation.pendingRunAt !== undefined) {
          const scheduledFor = automation.pendingRunAt
          automation.pendingRunAt = undefined
          const run = this.createRun(automation, 'scheduled', now, scheduledFor, 1)
          claims.push({ automation: cloneAutomation(automation), run: cloneRun(run) })
          changed = true
          continue
        }
        if (!automation.enabled || automation.nextRunAt === undefined || automation.nextRunAt > now) continue
        const scheduledFor = automation.nextRunAt
        automation.nextRunAt = nextFutureRunAt(automation.schedule, automation.timezone, scheduledFor, now)
        if (automation.schedule.kind === 'once') {
          automation.enabled = false
        }
        const late = now - scheduledFor > MISFIRE_GRACE_MS
        if (late && automation.misfirePolicy === 'skip') {
          this.createTerminalRun(automation, 'skipped', 'scheduled', now, scheduledFor, 'Scheduled time passed while TurboFlux was unavailable.')
          changed = true
          continue
        }
        const run = this.createRun(automation, late ? 'recovery' : 'scheduled', now, scheduledFor, 1)
        claims.push({ automation: cloneAutomation(automation), run: cloneRun(run) })
        changed = true
      }
      if (claims.length > 0) {
        options.beforePersist?.(claims)
        this.applyClaimReplacements(claims)
      }
      if (changed) this.persist()
      return claims
    } catch (error) {
      this.data = before
      throw error
    }
  }

  claimManual(id: string, now = Date.now(), dryRun = false, beforePersist?: AutomationBeforePersistClaims): AutomationClaim {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('This automation is already running')
    const before = JSON.parse(JSON.stringify(this.data)) as AutomationStoreFile
    try {
      const run = this.createRun(automation, 'manual', now, undefined, 1, dryRun)
      const claims = [{ automation: cloneAutomation(automation), run: cloneRun(run) }]
      beforePersist?.(claims)
      this.applyClaimReplacements(claims)
      this.persist()
      return claims[0]!
    } catch (error) {
      this.data = before
      throw error
    }
  }

  retryNow(id: string, runId: string, now = Date.now(), beforePersist?: AutomationBeforePersistClaims): AutomationClaim {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId) throw new Error('This automation is already running')
    const previous = automation.history.find(run => run.id === runId)
    if (!previous || !['failed', 'interrupted', 'canceled', 'retry_scheduled'].includes(previous.status)) {
      throw new Error('Only failed, interrupted, canceled, or pending retry runs can be retried')
    }
    const before = JSON.parse(JSON.stringify(this.data)) as AutomationStoreFile
    try {
      if (previous.status === 'retry_scheduled') {
        previous.status = 'failed'
        previous.retryAt = undefined
        previous.updatedAt = now
      }
      const run = this.createRun(automation, 'retry', now, previous.scheduledFor, previous.attempt + 1, false, previous)
      const claims = [{ automation: cloneAutomation(automation), run: cloneRun(run) }]
      beforePersist?.(claims)
      this.applyClaimReplacements(claims)
      this.persist()
      return claims[0]!
    } catch (error) {
      this.data = before
      throw error
    }
  }

  restoreQueuedRun(id: string, run: AutomationRunRecord): AutomationClaim {
    const automation = this.requireAutomation(id)
    if (automation.activeRunId && automation.activeRunId !== run.id) throw new Error('This automation is already running')
    const restored = cloneRun({ ...run, status: 'queued', updatedAt: Date.now(), completedAt: undefined, durationMs: undefined, error: undefined })
    const index = automation.history.findIndex(item => item.id === restored.id)
    if (index >= 0) automation.history[index] = restored
    else automation.history.unshift(restored)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    automation.activeRunId = restored.id
    if (restored.trigger !== 'manual' && restored.scheduledFor !== undefined && automation.nextRunAt !== undefined && automation.nextRunAt <= restored.scheduledFor) {
      automation.nextRunAt = nextFutureRunAt(automation.schedule, automation.timezone, restored.scheduledFor, Date.now())
      if (automation.schedule.kind === 'once') automation.enabled = false
    }
    automation.lastStatus = 'queued'
    automation.lastError = undefined
    automation.updatedAt = Date.now()
    this.persist()
    return { automation: cloneAutomation(automation), run: cloneRun(restored) }
  }

  attachConversation(id: string, conversationId: string): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    if (automation.mode === 'continuation') automation.conversationId = conversationId
    const active = automation.activeRunId ? automation.history.find(run => run.id === automation.activeRunId) : undefined
    if (active) {
      active.conversationId = conversationId
      active.contextSnapshot.conversationId = conversationId
    }
    automation.updatedAt = Date.now()
    this.persist()
    return this.list(automation.workspacePath)
  }

  resetContinuationConversation(id: string): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    if (automation.mode !== 'continuation') throw new Error('Only continuation automations have a dedicated conversation')
    automation.conversationId = undefined
    automation.contextPolicy = { ...automation.contextPolicy, continuationConversationId: undefined }
    automation.revision += 1
    automation.updatedAt = Date.now()
    this.persist()
    return this.list(automation.workspacePath)
  }

  markRunStatus(
    id: string,
    runId: string,
    status: AutomationRunStatus,
    options: {
      inputId?: string
      conversationId?: string
      error?: string
      resultSummary?: string
      result?: AutomationRunResult
      now?: number
      suppressRetry?: boolean
    } = {},
  ): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    const run = automation.history.find(item => item.id === runId)
    if (!run) throw new Error(`Automation run not found: ${runId}`)
    const now = options.now ?? Date.now()
    run.status = status
    run.updatedAt = now
    run.inputId = options.inputId || run.inputId
    run.conversationId = options.conversationId || run.conversationId
    run.error = options.error?.slice(0, 2_000)
    run.resultSummary = options.resultSummary?.trim().slice(0, 4_000)
    if (options.result !== undefined) run.result = JSON.parse(JSON.stringify(options.result)) as AutomationRunResult
    if (status === 'needs_review') {
      run.retryAt = undefined
      automation.activeRunId = run.id
    }
    if (terminalStatus(status)) {
      run.completedAt = now
      run.durationMs = Math.max(0, now - run.startedAt)
    }
    automation.lastRunAt = run.startedAt
    automation.lastStatus = status
    automation.lastInputId = run.inputId || automation.lastInputId
    automation.lastError = run.error
    automation.lastDurationMs = run.durationMs || automation.lastDurationMs
    if (status === 'completed') automation.lastSuccessAt = now
    if (automation.activeRunId === run.id && terminalStatus(status)) automation.activeRunId = undefined
    if (options.suppressRetry) run.retryAt = undefined
    if ((status === 'failed' || status === 'interrupted') && !options.suppressRetry) this.scheduleRetry(automation, run, now)
    if (terminalStatus(status) && status !== 'retry_scheduled') this.reconcileOverlappingSchedule(automation, run, now)
    automation.updatedAt = now
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    this.persist()
    return this.list(automation.workspacePath)
  }

  markRun(id: string, status: AutomationRunStatus, options: { inputId?: string; error?: string; now?: number } = {}): AutomationSnapshot {
    const automation = this.requireAutomation(id)
    let run = options.inputId ? automation.history.find(item => item.inputId === options.inputId) : undefined
    if (!run && automation.activeRunId) run = automation.history.find(item => item.id === automation.activeRunId)
    if (!run) {
      const claim = this.claimManual(id, options.now ?? Date.now())
      run = this.requireAutomation(id).history.find(item => item.id === claim.run.id)!
    }
    return this.markRunStatus(id, run.id, status, options)
  }

  cancelActiveRun(id: string, now = Date.now()): AutomationRunRecord | null {
    const automation = this.requireAutomation(id)
    if (!automation.activeRunId) return null
    const run = automation.history.find(item => item.id === automation.activeRunId)
    if (!run) return null
    this.markRunStatus(id, run.id, 'canceled', { now, error: 'Canceled by the user.' })
    return cloneRun(run)
  }

  get(id: string): AutomationRecord | null {
    const automation = this.data.automations.find(item => item.id === id)
    return automation ? cloneAutomation(automation) : null
  }

  getRun(id: string, runId: string): AutomationRunRecord | null {
    const automation = this.data.automations.find(item => item.id === id)
    const run = automation?.history.find(item => item.id === runId)
    return run ? cloneRun(run) : null
  }

  markInactiveDueWaiting(activeWorkspacePath: string, now = Date.now()): boolean {
    const activeWorkspace = resolve(activeWorkspacePath)
    let changed = false
    for (const automation of this.data.automations) {
      if (!automation.enabled || automation.workspacePath === activeWorkspace || automation.nextRunAt === undefined || automation.nextRunAt > now) continue
      if (automation.lastStatus === 'waiting_for_workspace') continue
      automation.lastStatus = 'waiting_for_workspace'
      automation.lastError = 'Open this workspace to run the automation.'
      automation.updatedAt = now
      changed = true
    }
    if (changed) this.persist()
    return changed
  }

  private createRun(
    automation: AutomationRecord,
    trigger: AutomationRunTrigger,
    now: number,
    scheduledFor: number | undefined,
    attempt: number,
    dryRun = false,
    previousRun?: AutomationRunRecord,
  ): AutomationRunRecord {
    const id = `automation-run-${randomUUID()}`
    const run: AutomationRunRecord = {
      id,
      definitionRevision: previousRun?.definitionRevision ?? automation.revision,
      conversationId: previousRun?.contextSnapshot.mode === 'continuation'
        ? previousRun.contextSnapshot.conversationId ?? automation.conversationId
        : automation.mode === 'continuation' ? automation.conversationId : undefined,
      trigger,
      status: 'queued',
      scheduledFor,
      attempt,
      startedAt: now,
      updatedAt: now,
      dryRun,
      permissionSnapshot: previousRun
        ? JSON.parse(JSON.stringify(previousRun.permissionSnapshot)) as AutomationPermissionSnapshot
        : this.createPermissionSnapshot(automation, id, now, dryRun),
      contextSnapshot: previousRun
        ? JSON.parse(JSON.stringify(previousRun.contextSnapshot)) as AutomationContextSnapshot
        : this.createContextSnapshot(automation, id, now),
    }
    automation.history.unshift(run)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    automation.activeRunId = run.id
    automation.lastRunAt = now
    automation.lastStatus = 'queued'
    automation.lastError = undefined
    automation.updatedAt = now
    return run
  }

  private createPermissionSnapshot(automation: AutomationRecord, runId: string, now: number, dryRun: boolean): AutomationPermissionSnapshot {
    const policy = automation.capabilityPolicy
    return {
      id: `permission-${runId}`,
      definitionId: automation.id,
      definitionRevision: automation.revision,
      approvalPolicy: dryRun ? 'ask' : policy.approvalPolicy,
      allowedTools: [...policy.allowedTools],
      deniedTools: [...policy.deniedTools],
      paths: policy.paths.map(path => ({ ...path })),
      networkDomains: [...policy.networkDomains],
      secretRefs: [...policy.secretRefs],
      mcpServerIds: [...policy.mcpServerIds],
      pluginIds: [...policy.pluginIds],
      allowComputerUse: policy.allowComputerUse,
      allowBackgroundComputerUse: policy.allowBackgroundComputerUse,
      maxRuntimeMinutes: automation.reliabilityPolicy.maxRuntimeMinutes,
      maxToolCalls: automation.reliabilityPolicy.maxToolCalls,
      maxInputTokens: automation.reliabilityPolicy.maxInputTokens,
      maxOutputTokens: automation.reliabilityPolicy.maxOutputTokens,
      riskSummary: dryRun ? ['Dry runs require approval for write operations.'] : [...automation.riskSummary],
      createdAt: now,
    }
  }

  private createContextSnapshot(automation: AutomationRecord, runId: string, now: number): AutomationContextSnapshot {
    const previousRun = automation.contextPolicy.includePreviousRunSummary
      ? automation.history.find(run => Boolean(run.result?.summary?.trim() || run.resultSummary?.trim()))
      : undefined
    const previousRunSummary = previousRun ? {
      runId: previousRun.id,
      summary: (previousRun.result?.summary || previousRun.resultSummary || '').trim().slice(0, 4_000),
      outcome: previousRun.result?.outcome,
      completedAt: previousRun.completedAt,
    } : undefined
    return {
      id: `context-${runId}`,
      definitionId: automation.id,
      definitionRevision: automation.revision,
      mode: automation.contextPolicy.mode,
      conversationId: automation.contextPolicy.mode === 'continuation'
        ? automation.contextPolicy.continuationConversationId ?? automation.conversationId
        : undefined,
      previousRunSummary,
      agentPolicy: freezeAutomationAgentPolicy(
        automation.agentPolicy,
        automation.routingPolicy?.defaultAgentStrategyId,
      ),
      fileRefs: [...automation.contextPolicy.fileRefs],
      skillIds: [...automation.contextPolicy.skillIds],
      createdAt: now,
    }
  }

  private createTerminalRun(
    automation: AutomationRecord,
    status: Extract<AutomationRunStatus, 'skipped' | 'missed'>,
    trigger: AutomationRunTrigger,
    now: number,
    scheduledFor: number | undefined,
    error: string,
  ): void {
    const id = `automation-run-${randomUUID()}`
    const run: AutomationRunRecord = {
      id,
      definitionRevision: automation.revision,
      trigger,
      status,
      scheduledFor,
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      durationMs: 0,
      error,
      permissionSnapshot: this.createPermissionSnapshot(automation, id, now, false),
      contextSnapshot: this.createContextSnapshot(automation, id, now),
    }
    automation.history.unshift(run)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
    automation.lastRunAt = now
    automation.lastStatus = status
    automation.lastError = error
    automation.updatedAt = now
  }

  private scheduleRetry(automation: AutomationRecord, run: AutomationRunRecord, now: number): void {
    if (run.attempt > automation.retryPolicy.maxRetries) return
    const retryAt = now + automation.retryPolicy.backoffMinutes * 60_000 * (2 ** Math.max(0, run.attempt - 1))
    run.status = 'retry_scheduled'
    run.retryAt = retryAt
    run.completedAt = now
    run.durationMs = Math.max(0, now - run.startedAt)
    automation.lastStatus = 'retry_scheduled'
  }

  private retryDue(automation: AutomationRecord, now: number): boolean {
    return automation.history.some(run => run.status === 'retry_scheduled' && run.retryAt !== undefined && run.retryAt <= now)
  }

  private reconcileOverlappingSchedule(automation: AutomationRecord, completedRun: AutomationRunRecord, now: number): void {
    if (!automation.enabled || automation.nextRunAt === undefined || automation.nextRunAt > now) return
    const scheduledFor = automation.nextRunAt
    automation.nextRunAt = nextFutureRunAt(automation.schedule, automation.timezone, scheduledFor, now)
    if (automation.schedule.kind === 'once') {
      automation.enabled = false
      automation.revision += 1
    }
    if (automation.overlapPolicy === 'queue-one' && completedRun.status !== 'canceled') {
      automation.pendingRunAt = scheduledFor
      return
    }
    const skippedId = `automation-run-${randomUUID()}`
    const skipped: AutomationRunRecord = {
      id: skippedId,
      definitionRevision: automation.revision,
      trigger: 'scheduled',
      status: 'skipped',
      scheduledFor,
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      durationMs: 0,
      error: completedRun.status === 'canceled'
        ? 'Skipped because the previous run was canceled.'
        : 'Skipped because the previous run was still active.',
      permissionSnapshot: this.createPermissionSnapshot(automation, skippedId, now, false),
      contextSnapshot: this.createContextSnapshot(automation, skippedId, now),
    }
    const completedIndex = automation.history.findIndex(item => item.id === completedRun.id)
    automation.history.splice(completedIndex < 0 ? 0 : completedIndex + 1, 0, skipped)
    automation.history = automation.history.slice(0, HISTORY_LIMIT)
  }

  private normalizeLoadedRecords(): boolean {
    let changed = this.data.schemaVersion !== 2
    this.data.schemaVersion = 2
    const now = Date.now()
    if (!Array.isArray(this.data.approvals)) {
      this.data.approvals = []
      changed = true
    }
    for (const approval of this.data.approvals) {
      const automation = this.data.automations.find(item => item.id === approval.automationId)
      const run = automation?.history.find(item => item.id === approval.runId)
      if (!Number.isInteger(approval.definitionRevision) || approval.definitionRevision < 1) {
        approval.definitionRevision = run?.definitionRevision ?? automation?.revision ?? 1
        changed = true
      }
      if (!approval.permissionSnapshotId) {
        approval.permissionSnapshotId = run?.permissionSnapshot.id ?? `permission-${approval.runId}`
        changed = true
      }
      if (!['permission', 'filesystem', 'network', 'computer', 'secret', 'input'].includes(approval.riskCategory)) {
        approval.riskCategory = approval.kind === 'input' ? 'input' : approval.path ? 'filesystem' : 'permission'
        changed = true
      }
      if (automation && approval.automationName !== automation.name) {
        approval.automationName = automation.name
        changed = true
      }
      if (automation && approval.workspacePath !== automation.workspacePath) {
        approval.workspacePath = automation.workspacePath
        changed = true
      }
      if (approval.status === 'pending') {
        approval.status = 'canceled'
        approval.decision = 'cancelled'
        approval.responseChannel = 'system'
        approval.resolvedAt = now
        changed = true
      }
    }
    for (const automation of this.data.automations) {
      if (!Array.isArray(automation.history)) {
        automation.history = []
        changed = true
      }
      try {
        automation.schedule = normalizeSchedule(automation.schedule)
        automation.timezone = normalizeTimezone(automation.timezone)
      } catch (error) {
        automation.schedule = { kind: 'manual' }
        automation.enabled = false
        automation.nextRunAt = undefined
        this.warnings.push(`Automation ${automation.name || automation.id} was disabled: ${error instanceof Error ? error.message : String(error)}`)
        changed = true
      }
      automation.approvalPolicy = normalizeApprovalPolicy(automation.approvalPolicy)
      if (!Number.isInteger(automation.revision) || automation.revision < 1) {
        automation.revision = 1
        changed = true
      }
      const mode = normalizeRunMode(automation.mode, 'continuation')
      if (automation.mode !== mode) {
        automation.mode = mode
        changed = true
      }
      const lifecycleStatus = normalizeLifecycleStatus(automation.lifecycleStatus, automation.enabled ? 'active' : 'paused')
      if (automation.lifecycleStatus !== lifecycleStatus) {
        automation.lifecycleStatus = lifecycleStatus
        changed = true
      }
      if (automation.lifecycleStatus !== 'active' && automation.enabled) {
        automation.enabled = false
        automation.nextRunAt = undefined
        changed = true
      }
      if (!Array.isArray(automation.validationIssues)) {
        automation.validationIssues = []
        changed = true
      }
      if (!Array.isArray(automation.riskSummary)) {
        automation.riskSummary = []
        changed = true
      }
      if (!automation.objective) {
        automation.objective = normalizeObjective(automation.prompt)
        changed = true
      } else {
        automation.objective = normalizeObjective(automation.prompt, automation.objective)
      }
      if (!automation.capabilityPolicy) changed = true
      automation.capabilityPolicy = normalizeCapabilityPolicy(
        automation.workspacePath,
        automation.approvalPolicy,
        automation.capabilityPolicy,
      )
      automation.approvalPolicy = automation.capabilityPolicy.approvalPolicy
      automation.misfirePolicy = normalizeMisfirePolicy(automation.misfirePolicy)
      automation.overlapPolicy = normalizeOverlapPolicy(automation.overlapPolicy)
      automation.retryPolicy = normalizeRetryPolicy(automation.retryPolicy)
      automation.maxRuntimeMinutes = normalizeMaxRuntime(automation.maxRuntimeMinutes)
      if (!automation.contextPolicy) changed = true
      automation.contextPolicy = normalizeContextPolicy(automation.mode, automation.contextPolicy, automation.conversationId)
      automation.mode = automation.contextPolicy.mode
      if (!automation.reliabilityPolicy) changed = true
      automation.reliabilityPolicy = normalizeReliabilityPolicy(automation.reliabilityPolicy, automation)
      if (!automation.routingPolicy) changed = true
      automation.routingPolicy = normalizeRoutingPolicy(automation.routingPolicy)
      if (!automation.agentPolicy) changed = true
      automation.agentPolicy = normalizeAgentPolicy(automation.agentPolicy)
      automation.misfirePolicy = automation.reliabilityPolicy.misfirePolicy
      automation.overlapPolicy = normalizeOverlapPolicy(automation.reliabilityPolicy.overlapPolicy)
      automation.retryPolicy = {
        maxRetries: automation.reliabilityPolicy.retry.maxRetries,
        backoffMinutes: automation.reliabilityPolicy.retry.backoffMinutes,
      }
      automation.maxRuntimeMinutes = automation.reliabilityPolicy.maxRuntimeMinutes
      const deliveryPolicyNeedsMigration = automation.deliveryPolicy?.eventPolicyVersion !== 2
      if (!automation.deliveryPolicy) changed = true
      automation.deliveryPolicy = normalizeDeliveryPolicy(automation.deliveryPolicy)
      if (deliveryPolicyNeedsMigration) {
        automation.revision += 1
        automation.updatedAt = now
        changed = true
      }
      if (!Array.isArray(automation.triggers)) changed = true
      automation.triggers = normalizeTriggers(automation.triggers, automation.schedule, automation.timezone)
      automation.workspacePath = resolve(automation.workspacePath)
      if (automation.enabled && automation.nextRunAt === undefined) {
        automation.nextRunAt = nextAutomationRunAt(automation.schedule, automation.timezone, now)
        changed = true
      }
      for (const run of automation.history) {
        run.trigger = run.trigger || 'scheduled'
        run.attempt = Math.max(1, run.attempt || 1)
        if (!Number.isInteger(run.definitionRevision) || run.definitionRevision < 1) {
          run.definitionRevision = 1
          changed = true
        }
        if (!run.permissionSnapshot) {
          run.permissionSnapshot = this.createPermissionSnapshot(automation, run.id, run.startedAt, run.dryRun === true)
          run.permissionSnapshot.definitionRevision = run.definitionRevision
          changed = true
        }
        if (!run.contextSnapshot) {
          run.contextSnapshot = this.createContextSnapshot(automation, run.id, run.startedAt)
          run.contextSnapshot.definitionRevision = run.definitionRevision
          run.contextSnapshot.conversationId = run.conversationId
          changed = true
        }
        if (run.status === 'completed' && !run.result) {
          run.result = {
            outcome: 'success',
            summary: run.resultSummary || 'Automation completed without a saved summary.',
            successCriteria: automation.objective.successCriteria.map(criterion => ({ criterion, status: 'unknown' })),
            artifactIds: [],
            sideEffectSummary: [],
            durationMs: run.durationMs ?? Math.max(0, (run.completedAt ?? run.updatedAt) - run.startedAt),
          }
          changed = true
        }
        if (['queued', 'running', 'waiting_for_approval', 'waiting_for_workspace'].includes(run.status)) {
          run.status = 'interrupted'
          run.updatedAt = now
          run.completedAt = now
          run.durationMs = Math.max(0, now - run.startedAt)
          run.error = 'TurboFlux exited before this run completed.'
          automation.activeRunId = undefined
          automation.lastStatus = 'interrupted'
          automation.lastError = run.error
          this.scheduleRetry(automation, run, now)
          changed = true
        }
      }
      automation.history = automation.history.slice(0, HISTORY_LIMIT)
    }
    return changed
  }

  private requireAutomation(id: string): AutomationRecord {
    const automation = this.data.automations.find(item => item.id === id)
    if (!automation) throw new Error(`Automation not found: ${id}`)
    return automation
  }

  private applyClaimReplacements(claims: AutomationClaim[]): void {
    for (const claim of claims) {
      const automation = this.requireAutomation(claim.automation.id)
      const activeIndex = automation.history.findIndex(run => run.id === automation.activeRunId)
      if (activeIndex < 0) throw new Error(`Automation active run disappeared before persistence: ${automation.id}`)
      automation.history[activeIndex] = cloneRun(claim.run)
      automation.activeRunId = claim.run.id
      automation.lastRunAt = claim.run.startedAt
      automation.lastStatus = claim.run.status
      claim.automation = cloneAutomation(automation)
    }
  }

  private persist(): void {
    this.store.save(this.data)
    this.warnings = []
  }
}
