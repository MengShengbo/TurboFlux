import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AutomationCoordinator } from './automationCoordinator'
import type { AutomationRepository } from './automationRepository'
import {
  type AutomationCreateInput,
  type AutomationRecord,
  type AutomationRunRecord,
  type AutomationService,
  type AutomationUpdateInput,
} from './automationService'
import type {
  AutomationDefinition,
  AutomationDefinitionRevision,
  AutomationRun,
  AutomationRunCheckpoint,
  AutomationValidationIssue,
} from './automationTypes'
import { matchesAutomationTriggerFilters } from './automationRouting'
import { automationDefinitionFromV2Record } from './automationMigration'

export interface AutomationDefinitionSummary {
  id: string
  revision: number
  status: AutomationDefinition['status']
  name: string
  workspacePath: string
  mode: AutomationDefinition['context']['mode']
  triggerKind: AutomationDefinition['triggers'][number]['kind']
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: AutomationRunRecord['status']
  activeRunId?: string
  approvalPolicy: AutomationDefinition['capabilities']['approvalPolicy']
  riskLevel: 'low' | 'medium' | 'high'
  updatedAt: number
}

export interface AutomationDefinitionPage {
  items: AutomationDefinitionSummary[]
  total: number
  offset: number
  limit: number
}

export interface AutomationValidationReport {
  definitionId: string
  revision: number
  valid: boolean
  issues: AutomationValidationIssue[]
  riskSummary: string[]
  riskLevel: 'low' | 'medium' | 'high'
}

export interface AutomationDefinitionDetail {
  definition: AutomationDefinition
  compatibility: AutomationRecord
  revisions: AutomationDefinitionRevision[]
  validation: AutomationValidationReport
  recentRuns: AutomationRun[]
}

export interface AutomationDraftInput extends Omit<AutomationCreateInput, 'enabled' | 'lifecycleStatus'> {
  id?: string
  expectedRevision?: number
}

export interface AutomationRunTimelineItem {
  id: string
  at: number
  kind: 'trigger' | 'queued' | 'lease' | 'started' | 'approval' | 'checkpoint' | 'tool' | 'artifact' | 'delivery' | 'recovery' | 'completed' | 'failed' | 'retry'
  title: string
  detail?: string
}

export interface AutomationRunDetail {
  run: AutomationRun
  definition: AutomationDefinition
  currentDefinition: AutomationDefinition
  permissionSnapshot: ReturnType<AutomationRepository['getPermissionSnapshot']>
  contextSnapshot: ReturnType<AutomationRepository['getContextSnapshot']>
  triggerEvent: ReturnType<AutomationRepository['getEvent']>
  approvals: ReturnType<AutomationService['listApprovals']>
  checkpoints: AutomationRunCheckpoint[]
  recoveryOptions: ReturnType<AutomationCoordinator['recoveryOptions']>
  timeline: AutomationRunTimelineItem[]
}

export interface AutomationDefinitionArchiveResult {
  detail: AutomationDefinitionDetail
  deletedRuns: number
  deletedMemory: boolean
  conversationIds: string[]
}

export interface AutomationApplicationServiceOptions {
  onDefinitionsChanged?: () => void
  hasSecretRef?: (id: string) => boolean
  hasSkill?: (id: string) => boolean
  hasPlugin?: (id: string) => boolean
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child) && !child.startsWith(`..${sep}`))
}

function riskLevel(record: AutomationRecord): 'low' | 'medium' | 'high' {
  if (record.approvalPolicy === 'full' || record.capabilityPolicy.allowBackgroundComputerUse || record.capabilityPolicy.secretRefs.length > 0) return 'high'
  if (record.capabilityPolicy.allowComputerUse || record.capabilityPolicy.networkDomains.length > 0 || record.capabilityPolicy.paths.some(path => path.access === 'write')) return 'medium'
  return 'low'
}

function riskSummary(record: AutomationRecord): string[] {
  const risks: string[] = []
  const writable = record.capabilityPolicy.paths.filter(path => path.access === 'write')
  if (writable.length > 0) risks.push(`可写入 ${writable.length} 个已授权路径。`)
  if (record.capabilityPolicy.networkDomains.length > 0) risks.push(`可访问 ${record.capabilityPolicy.networkDomains.length} 个网络域名。`)
  if (record.capabilityPolicy.secretRefs.length > 0) risks.push(`可使用 ${record.capabilityPolicy.secretRefs.length} 个本地秘密引用。`)
  if (record.capabilityPolicy.allowComputerUse) risks.push(record.capabilityPolicy.allowBackgroundComputerUse ? '允许在后台控制电脑。' : '电脑操作仍要求前台或逐次审批。')
  if (record.approvalPolicy === 'full') risks.push('高风险操作可在发布范围内直接执行。')
  if (risks.length === 0) risks.push('当前范围仅包含低风险、受限访问。')
  return risks
}

export class AutomationApplicationService {
  constructor(
    readonly service: AutomationService,
    readonly repository: AutomationRepository,
    readonly coordinator: AutomationCoordinator,
    private readonly options: AutomationApplicationServiceOptions = {},
  ) {}

  listDefinitions(query: {
    workspacePath?: string
    status?: AutomationDefinition['status']
    offset?: number
    limit?: number
  } = {}): AutomationDefinitionPage {
    this.coordinator.syncDefinitions()
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 50)))
    const records = new Map(this.service.list().automations.map(record => [record.id, record]))
    const all = this.repository.listDefinitions()
      .filter(definition => !query.workspacePath || resolve(definition.workspaceRef.path) === resolve(query.workspacePath))
      .filter(definition => !query.status || definition.status === query.status)
      .map(definition => {
        const record = records.get(definition.id)
        return {
          id: definition.id,
          revision: definition.revision,
          status: definition.status,
          name: definition.name,
          workspacePath: definition.workspaceRef.path,
          mode: definition.context.mode,
          triggerKind: definition.triggers[0]?.kind ?? 'schedule',
          nextRunAt: record?.nextRunAt,
          lastRunAt: record?.lastRunAt,
          lastStatus: record?.lastStatus,
          activeRunId: record?.activeRunId,
          approvalPolicy: definition.capabilities.approvalPolicy,
          riskLevel: record ? riskLevel(record) : 'medium',
          updatedAt: definition.updatedAt,
        } satisfies AutomationDefinitionSummary
      })
      .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt - left.updatedAt)
    return { items: all.slice(offset, offset + limit), total: all.length, offset, limit }
  }

  getDefinition(id: string): AutomationDefinitionDetail {
    this.coordinator.syncDefinitions()
    const definition = this.repository.getDefinition(id)
    const compatibility = this.service.get(id)
    if (!definition || !compatibility) throw new Error(`Automation definition not found: ${id}`)
    const revisions: AutomationDefinitionRevision[] = []
    for (let revision = definition.revision; revision >= Math.max(1, definition.revision - 19); revision -= 1) {
      const item = this.repository.getRevision(id, revision)
      if (item) revisions.push(item)
    }
    return {
      definition,
      compatibility,
      revisions,
      validation: this.validateDefinition(id, false),
      recentRuns: this.repository.listRuns({ definitionId: id, limit: 20 }),
    }
  }

  saveDraft(input: AutomationDraftInput): AutomationDefinitionDetail {
    const prepared = input
    if (prepared.id) {
      const existing = this.service.get(prepared.id)
      if (!existing) throw new Error(`Automation definition not found: ${input.id}`)
      if (prepared.expectedRevision !== undefined && existing.revision !== prepared.expectedRevision) {
        throw new Error(`Automation revision conflict: expected ${prepared.expectedRevision}, current ${existing.revision}`)
      }
      const { id: _id, expectedRevision: _expectedRevision, workspacePath: _workspacePath, ...patch } = prepared
      this.service.update(existing.id, { ...patch, lifecycleStatus: 'draft', enabled: false } as AutomationUpdateInput)
    } else {
      const { id: _id, expectedRevision: _expectedRevision, ...createInput } = prepared
      this.service.create({ ...createInput, lifecycleStatus: 'draft', enabled: false })
    }
    this.changed()
    const saved = prepared.id
      ? this.service.get(prepared.id)!
      : this.service.list(prepared.workspacePath).automations.sort((left, right) => right.createdAt - left.createdAt)[0]!
    this.validateDefinition(saved.id, true)
    this.changed()
    return this.getDefinition(saved.id)
  }

  validateDefinition(id: string, persist = true): AutomationValidationReport {
    const record = this.service.get(id)
    if (!record) throw new Error(`Automation definition not found: ${id}`)
    const issues: AutomationValidationIssue[] = []
    const issue = (code: string, severity: AutomationValidationIssue['severity'], path: string, message: string) => {
      issues.push({ code, severity, path, message })
    }
    if (!record.name.trim()) issue('name_required', 'error', 'name', '名称不能为空。')
    if (!record.objective.goal.trim()) issue('goal_required', 'error', 'objective.goal', '工作目标不能为空。')
    if (record.objective.successCriteria.length === 0) issue('success_criteria_recommended', 'warning', 'objective.successCriteria', '建议至少填写一条可验证的成功标准。')
    let workspaceAvailable = false
    try {
      workspaceAvailable = existsSync(record.workspacePath) && statSync(record.workspacePath).isDirectory()
    } catch {}
    if (!workspaceAvailable) {
      issue('workspace_missing', 'error', 'workspacePath', '工作区不存在或不是文件夹。')
    }
    for (const [index, skillId] of record.contextPolicy.skillIds.entries()) {
      if (this.options.hasSkill && !this.options.hasSkill(skillId)) {
        issue('skill_missing', 'error', `contextPolicy.skillIds.${index}`, `Skill 未安装或不可用：${skillId}`)
      }
    }
    for (const [index, pathPolicy] of record.capabilityPolicy.paths.entries()) {
      if (!pathInside(record.workspacePath, pathPolicy.path)) {
        issue('path_outside_workspace', 'error', `capabilityPolicy.paths.${index}`, '授权路径必须位于工作区内。')
      }
    }
    const overlap = record.capabilityPolicy.allowedTools.filter(tool => record.capabilityPolicy.deniedTools.includes(tool))
    if (overlap.length > 0) issue('tool_policy_conflict', 'error', 'capabilityPolicy', `工具同时出现在允许和禁止列表：${overlap.join(', ')}`)
    for (const [index, domain] of record.capabilityPolicy.networkDomains.entries()) {
      if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) {
        issue('invalid_network_domain', 'error', `capabilityPolicy.networkDomains.${index}`, `无效网络域名：${domain}`)
      }
    }
    const normalizedDomains = record.capabilityPolicy.networkDomains.map(domain => domain.toLowerCase())
    for (const [index, domain] of normalizedDomains.entries()) {
      const base = domain.startsWith('*.') ? domain.slice(2) : domain
      const conflict = normalizedDomains.findIndex((candidate, candidateIndex) => candidateIndex !== index
        && (candidate === base || candidate === `*.${base}`))
      if (conflict >= 0 && index < conflict) {
        issue('network_domain_overlap', 'error', `capabilityPolicy.networkDomains.${index}`, `网络域名范围重叠：${domain} 与 ${normalizedDomains[conflict]}`)
      }
    }
    if (record.capabilityPolicy.allowBackgroundComputerUse && !record.capabilityPolicy.allowComputerUse) {
      issue('background_computer_requires_computer', 'error', 'capabilityPolicy.allowBackgroundComputerUse', '允许后台控制前必须先允许 Computer。')
    }
    for (const [index, secretRef] of record.capabilityPolicy.secretRefs.entries()) {
      if (this.options.hasSecretRef && !this.options.hasSecretRef(secretRef)) {
        issue('secret_ref_missing', 'error', `capabilityPolicy.secretRefs.${index}`, `Secret 引用不可用：${secretRef}`)
      }
    }
    for (const [index, pluginId] of record.capabilityPolicy.pluginIds.entries()) {
      if (this.options.hasPlugin && !this.options.hasPlugin(pluginId)) {
        issue('plugin_missing', 'error', `capabilityPolicy.pluginIds.${index}`, `Plugin 未安装或未启用：${pluginId}`)
      }
    }
    if (record.schedule.kind === 'once' && Date.parse(record.schedule.at) <= Date.now()) {
      issue('once_schedule_in_past', 'error', 'schedule.at', '单次运行时间必须在未来。')
    }
    if (record.triggers.length === 0) issue('trigger_required', 'error', 'triggers', '至少需要一个触发器。')
    for (const [index, trigger] of record.triggers.entries()) {
      if (!['manual', 'schedule', 'cron'].includes(trigger.kind)) {
        issue('unsupported_trigger', 'error', `triggers.${index}`, '此触发方式已停用，请编辑计划并选择定时或手动运行。')
      }
    }
    const group = record.reliabilityPolicy.concurrencyGroup
    if (group && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(group.id)) {
      issue('concurrency_group_invalid', 'error', 'reliabilityPolicy.concurrencyGroup.id', '并发组 ID 只能使用字母、数字、点、冒号、下划线和短横线。')
    }
    const lockModes = new Map<string, string>()
    for (const [index, lock] of (record.reliabilityPolicy.resourceLocks ?? []).entries()) {
      const previous = lockModes.get(lock.key)
      if (previous) issue('resource_lock_duplicate', 'error', `reliabilityPolicy.resourceLocks.${index}`, `资源锁重复：${lock.key}`)
      lockModes.set(lock.key, lock.mode)
    }
    const strategyIds = new Set(record.agentPolicy?.strategies.map(strategy => strategy.id) ?? [])
    if (record.agentPolicy?.enabled && strategyIds.size === 0) issue('agent_strategy_required', 'error', 'agentPolicy.strategies', '启用多 Agent 前至少需要一个受限策略。')
    if (record.agentPolicy?.enabled && !record.agentPolicy.defaultStrategyId) issue('agent_default_strategy_required', 'error', 'agentPolicy.defaultStrategyId', '启用多 Agent 后需要选择默认策略。')
    if (record.agentPolicy?.defaultStrategyId && !strategyIds.has(record.agentPolicy.defaultStrategyId)) issue('agent_default_strategy_missing', 'error', 'agentPolicy.defaultStrategyId', '默认多 Agent 策略不存在。')
    for (const [index, strategy] of (record.agentPolicy?.strategies ?? []).entries()) {
      if (strategy.allowedAgentTypes.length === 0) issue('agent_types_required', 'error', `agentPolicy.strategies.${index}.allowedAgentTypes`, '多 Agent 策略必须明确允许的子 Agent 类型。')
    }
    const routing = record.routingPolicy
    if (routing?.defaultAgentStrategyId && !strategyIds.has(routing.defaultAgentStrategyId)) issue('route_agent_strategy_missing', 'error', 'routingPolicy.defaultAgentStrategyId', '默认路由引用了不存在的多 Agent 策略。')
    for (const [ruleIndex, rule] of (routing?.rules ?? []).entries()) {
      if (rule.agentStrategyId && !strategyIds.has(rule.agentStrategyId)) issue('route_agent_strategy_missing', 'error', `routingPolicy.rules.${ruleIndex}.agentStrategyId`, `路由引用了不存在的多 Agent 策略：${rule.agentStrategyId}`)
      for (const [filterIndex, filter] of rule.filters.entries()) {
        if (filter.operator !== 'matches') continue
        try {
          matchesAutomationTriggerFilters({ value: 'probe' }, [{ ...filter, field: 'value' }])
        } catch (error) {
          issue('route_regex_unsafe', 'error', `routingPolicy.rules.${ruleIndex}.filters.${filterIndex}`, error instanceof Error ? error.message : String(error))
        }
      }
    }
    if (record.approvalPolicy === 'full') issue('full_approval_risk', 'warning', 'approvalPolicy', '完全访问会在已发布范围内跳过逐次确认。')
    const risks = riskSummary(record)
    if (persist) this.service.recordValidation(id, issues, risks)
    return {
      definitionId: id,
      revision: record.revision,
      valid: !issues.some(item => item.severity === 'error'),
      issues,
      riskSummary: risks,
      riskLevel: riskLevel(record),
    }
  }

  publishDefinition(id: string, expectedRevision: number): AutomationDefinitionDetail {
    const record = this.service.get(id)
    if (!record) throw new Error(`Automation definition not found: ${id}`)
    if (record.revision !== expectedRevision) throw new Error(`Automation revision conflict: expected ${expectedRevision}, current ${record.revision}`)
    const report = this.validateDefinition(id, true)
    if (!report.valid) throw new Error('Automation definition has validation errors and cannot be published')
    this.service.update(id, { lifecycleStatus: 'active', enabled: true })
    this.changed()
    return this.getDefinition(id)
  }

  setDefinitionStatus(id: string, status: Extract<AutomationDefinition['status'], 'draft' | 'testing' | 'paused' | 'archived'>): AutomationDefinitionDetail {
    this.service.update(id, { lifecycleStatus: status, enabled: false })
    this.changed()
    return this.getDefinition(id)
  }

  rollbackDefinition(id: string, targetRevision: number, expectedRevision: number): AutomationDefinitionDetail {
    const current = this.service.get(id)
    const currentDefinition = this.repository.getDefinition(id)
    const target = this.repository.getRevision(id, targetRevision)
    if (!current || !currentDefinition) throw new Error(`Automation definition not found: ${id}`)
    if (current.revision !== expectedRevision || currentDefinition.revision !== expectedRevision) {
      throw new Error(`Automation revision conflict: expected ${expectedRevision}, current ${current.revision}`)
    }
    if (!target) throw new Error(`Automation definition revision not found: ${id}@${targetRevision}`)
    const definition = target.definition
    const scheduleTrigger = definition.triggers.find(trigger => trigger.kind === 'schedule' || trigger.kind === 'cron')
    this.service.update(id, {
      name: definition.name,
      description: definition.description,
      prompt: definition.objective.originalPrompt,
      objective: definition.objective,
      mode: definition.context.mode,
      contextPolicy: definition.context,
      capabilityPolicy: definition.capabilities,
      reliabilityPolicy: definition.reliability,
      routingPolicy: definition.routing,
      agentPolicy: definition.agents,
      deliveryPolicy: definition.delivery,
      triggers: definition.triggers,
      schedule: scheduleTrigger?.kind === 'schedule'
        ? scheduleTrigger.schedule
        : scheduleTrigger?.kind === 'cron' ? { kind: 'cron', expression: scheduleTrigger.expression } : { kind: 'manual' },
      timezone: scheduleTrigger?.timezone ?? current.timezone,
      lifecycleStatus: 'draft',
      enabled: false,
    })
    const updated = this.service.get(id)!
    this.repository.saveDefinition(automationDefinitionFromV2Record(updated, updated.revision), {
      source: 'rollback',
      parentRevision: currentDefinition.revision,
      changeSummary: `Rolled back from revision ${currentDefinition.revision} to revision ${targetRevision} as a new draft.`,
    })
    this.validateDefinition(id, true)
    this.changed()
    return this.getDefinition(id)
  }

  resetContinuationConversation(id: string, expectedRevision: number): AutomationDefinitionDetail {
    const current = this.service.get(id)
    const currentDefinition = this.repository.getDefinition(id)
    if (!current || !currentDefinition) throw new Error(`Automation definition not found: ${id}`)
    if (current.revision !== expectedRevision || currentDefinition.revision !== expectedRevision) {
      throw new Error(`Automation revision conflict: expected ${expectedRevision}, current ${current.revision}`)
    }
    this.service.resetContinuationConversation(id)
    const updated = this.service.get(id)!
    this.repository.saveDefinition(automationDefinitionFromV2Record(updated, updated.revision), {
      source: 'user',
      parentRevision: currentDefinition.revision,
      changeSummary: 'Reset the dedicated continuation conversation for the next Run.',
    })
    this.validateDefinition(id, true)
    this.changed()
    return this.getDefinition(id)
  }

  archiveDefinition(id: string, options: { deleteRuns?: boolean; deleteMemory?: boolean } = {}): AutomationDefinitionArchiveResult {
    const current = this.service.get(id)
    if (!current) throw new Error(`Automation definition not found: ${id}`)
    if (current.activeRunId) throw new Error('Stop the active automation run before archiving it')
    const conversationIds = this.allRuns(id).map(run => run.conversationId).filter((value): value is string => Boolean(value))
    if (current.lifecycleStatus !== 'archived') this.setDefinitionStatus(id, 'archived')
    const deleted = this.repository.deleteDefinitionData(id, { runs: options.deleteRuns, memory: options.deleteMemory })
    if (options.deleteRuns) this.service.clearRunData(id)
    this.changed()
    return {
      detail: this.getDefinition(id),
      deletedRuns: deleted.deletedRuns,
      deletedMemory: deleted.deletedMemory,
      conversationIds: [...new Set(conversationIds)],
    }
  }

  listRuns(query: { definitionId?: string; offset?: number; limit?: number } = {}) {
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 50)))
    const items = this.repository.listRuns({ definitionId: query.definitionId, offset, limit })
    const total = this.repository.countRuns(query.definitionId)
    return { items, total, offset, limit }
  }

  private allRuns(definitionId: string): AutomationRun[] {
    const total = this.repository.countRuns(definitionId)
    const runs: AutomationRun[] = []
    for (let offset = 0; offset < total; offset += 500) runs.push(...this.repository.listRuns({ definitionId, offset, limit: 500 }))
    return runs
  }

  getRun(runId: string): AutomationRunDetail {
    const run = this.repository.getRun(runId)
    if (!run) throw new Error(`Automation run not found: ${runId}`)
    const definition = this.repository.getRevision(run.definitionId, run.definitionRevision)?.definition
      ?? this.repository.getDefinition(run.definitionId)
    if (!definition) throw new Error(`Automation definition not found for run: ${run.definitionId}`)
    const triggerEvent = this.repository.getEvent(run.triggerEventId)
    const timeline: AutomationRunTimelineItem[] = []
    if (triggerEvent) timeline.push({ id: `${run.id}-trigger`, at: triggerEvent.receivedAt, kind: 'trigger', title: '触发事件已接受', detail: triggerEvent.source })
    timeline.push({ id: `${run.id}-queued`, at: run.timestamps.queuedAt, kind: 'queued', title: '已进入持久队列' })
    if (run.timestamps.preparingAt) timeline.push({ id: `${run.id}-lease`, at: run.timestamps.preparingAt, kind: 'lease', title: '已获取执行租约', detail: run.lease?.ownerId })
    if (run.timestamps.startedAt) timeline.push({ id: `${run.id}-started`, at: run.timestamps.startedAt, kind: 'started', title: 'Agent 开始执行', detail: run.conversationId })
    const approvals = this.service.listApprovals(run.id)
    for (const approval of approvals) {
      timeline.push({ id: `${approval.id}-requested`, at: approval.requestedAt, kind: 'approval', title: '请求审批', detail: approval.targetSummary ?? approval.question })
      if (approval.resolvedAt) timeline.push({
        id: `${approval.id}-resolved`,
        at: approval.resolvedAt,
        kind: 'approval',
        title: approval.status === 'approved' ? '审批已允许' : approval.status === 'expired' ? '审批已过期并拒绝' : approval.status === 'canceled' ? '审批已取消' : '审批已拒绝',
        detail: approval.responseChannel ? `响应渠道：${approval.responseChannel}` : undefined,
      })
    }
    const checkpoints = this.repository.listCheckpoints(run.id)
    for (const checkpoint of checkpoints) {
      timeline.push({
        id: checkpoint.id,
        at: checkpoint.createdAt,
        kind: 'checkpoint',
        title: `检查点：${checkpoint.reason}`,
        detail: checkpoint.nonResumableReason ?? `Canonical Event #${checkpoint.canonicalEventSequence}`,
      })
      if (checkpoint.inFlightToolEffect) timeline.push({
        id: `${checkpoint.id}-tool`,
        at: checkpoint.inFlightToolEffect.startedAt,
        kind: 'tool',
        title: `工具待确认：${checkpoint.inFlightToolEffect.toolName}`,
        detail: `${checkpoint.inFlightToolEffect.classification}${checkpoint.inFlightToolEffect.targetSummary ? ` · ${checkpoint.inFlightToolEffect.targetSummary}` : ''}`,
      })
      if (checkpoint.reason === 'artifact' && checkpoint.artifactIds.length > 0) timeline.push({
        id: `${checkpoint.id}-artifact`,
        at: checkpoint.createdAt,
        kind: 'artifact',
        title: `已保存 ${checkpoint.artifactIds.length} 个 Artifact`,
        detail: checkpoint.artifactIds.join(', '),
      })
    }
    if (run.recovery) timeline.push({
      id: `${run.id}-recovery-${run.recovery.requestedAt}`,
      at: run.recovery.requestedAt,
      kind: 'recovery',
      title: run.recovery.action === 'retry_idempotent' ? '从检查点安全重试' : '从检查点继续且跳过不可重放动作',
      detail: run.recovery.warnings.join(' ') || run.recovery.checkpointId,
    })
    if (run.timestamps.retryAt) timeline.push({ id: `${run.id}-retry`, at: run.timestamps.retryAt, kind: 'retry', title: '计划重试' })
    if (run.timestamps.completedAt) timeline.push({
      id: `${run.id}-terminal`,
      at: run.timestamps.completedAt,
      kind: run.status === 'completed' ? 'completed' : 'failed',
      title: run.status === 'completed' ? '运行完成' : `运行结束：${run.status}`,
      detail: run.result?.summary ?? run.error?.message,
    })
    return {
      run,
      definition,
      currentDefinition: this.repository.getDefinition(run.definitionId) ?? definition,
      permissionSnapshot: this.repository.getPermissionSnapshot(run.permissionSnapshotId),
      contextSnapshot: this.repository.getContextSnapshot(run.contextSnapshotId),
      triggerEvent,
      approvals,
      checkpoints,
      recoveryOptions: this.coordinator.recoveryOptions(run.id),
      timeline: timeline.sort((left, right) => left.at - right.at),
    }
  }

  setRunPinned(runId: string, pinned: boolean): AutomationRunDetail {
    this.repository.setRunPinned(runId, pinned)
    this.changed()
    return this.getRun(runId)
  }

  abandonRunRecovery(runId: string): AutomationRunDetail {
    this.coordinator.abandonRecovery(runId)
    this.changed()
    return this.getRun(runId)
  }

  reconcileExternalDependencies(): string[] {
    const invalidated: string[] = []
    for (const record of this.service.list().automations.filter(item => item.lifecycleStatus === 'active')) {
      const report = this.validateDefinition(record.id, false)
      const externalIssues = report.issues.filter(issue => [
        'secret_ref_missing',
        'skill_missing',
        'plugin_missing',
      ].includes(issue.code))
      if (externalIssues.length === 0) continue
      this.service.update(record.id, { lifecycleStatus: 'invalid', enabled: false })
      this.service.recordValidation(record.id, report.issues, report.riskSummary)
      invalidated.push(record.id)
    }
    if (invalidated.length > 0) this.changed()
    return invalidated
  }

  private changed(): void {
    this.options.onDefinitionsChanged?.()
  }
}
