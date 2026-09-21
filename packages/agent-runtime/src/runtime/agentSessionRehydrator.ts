import type {
  AgentRunInterruption,
  AgentTurn,
  TaskPriority,
  TaskStatus,
  TokenUsage,
  ToolResult,
} from '@turboflux/contracts/agentTypes'
import { generateTurnId } from '@turboflux/contracts/agentTypes'
import { TaskManager } from '../taskManager'
import { interruptionMetadata } from './runControl'

export interface PersistedAgentMessage {
  id?: string
  role: string
  content: string
  timestamp?: number
  metadata?: {
    model?: string
    tokens?: number | TokenUsage
    duration?: number
    reasoningEnabled?: boolean
    reasoningEffort?: NonNullable<AgentTurn['metadata']>['reasoningEffort']
    thinking?: NonNullable<AgentTurn['metadata']>['thinking']
    rawReasoningPayload?: NonNullable<AgentTurn['metadata']>['rawReasoningPayload']
    attachments?: NonNullable<AgentTurn['metadata']>['attachments']
    capabilities?: NonNullable<AgentTurn['metadata']>['capabilities']
    runtimeContext?: string
    toolCalls?: PersistedToolCall[]
    detectedSkills?: string[]
    isStreaming?: boolean
    workRunId?: string
    interrupted?: boolean
    interruption?: AgentRunInterruption
  }
}

export interface PersistedToolCall {
  id?: string
  name: string
  arguments: Record<string, unknown>
  result?: string
  isError?: boolean
  status?: string
  interruption?: AgentRunInterruption
  changeSummary?: {
    path: string
    operation: 'write' | 'edit' | 'delete'
    addedLines?: number
    removedLines?: number
    totalLines?: number
    preview?: string
    oldPreview?: string
    before?: string
    after?: string
  }
}

interface RehydrateMessagesOptions {
  systemTurns: AgentTurn[]
  taskManager: TaskManager
  isToolOutputFailure: (name: string, output: string) => boolean
  now?: () => number
}

export class AgentSessionRehydrator {
  messagesFromTurns(turns: AgentTurn[]): PersistedAgentMessage[] {
    const resultByToolCallId = new Map<string, ToolResult>()
    for (const turn of turns) {
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) resultByToolCallId.set(result.toolCallId, result)
    }

    return turns.map(turn => {
      const toolCalls = turn.toolCalls?.map(toolCall => {
        const result = resultByToolCallId.get(toolCall.id)
        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          result: result?.output,
          isError: result?.isError,
          status: result ? (result.isError ? 'error' : 'completed') : undefined,
          interruption: result?.interruption,
          changeSummary: result?.changeSummary,
        }
      })

      return {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        metadata: {
          ...(turn.metadata ?? {}),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        },
      }
    })
  }

  rehydrateMessages(messages: PersistedAgentMessage[], options: RehydrateMessagesOptions): AgentTurn[] {
    const turns = [...options.systemTurns]
    let restoredTimestampFallback = (options.now ?? Date.now)()
    for (const message of messages) {
      if (message.role === 'system') continue
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : restoredTimestampFallback++
      const metadata = message.metadata

      if (message.role === 'user') {
        const userMetadata: AgentTurn['metadata'] = {}
        if (metadata?.attachments?.length) {
          userMetadata.attachments = metadata.attachments.map(attachment => ({ ...attachment }))
        }
        if (metadata?.capabilities?.items.length) {
          userMetadata.capabilities = { items: metadata.capabilities.items.map(item => ({ ...item })) }
        }
        if (typeof metadata?.runtimeContext === 'string') userMetadata.runtimeContext = metadata.runtimeContext
        if (typeof metadata?.workRunId === 'string') userMetadata.workRunId = metadata.workRunId
        turns.push({
          id: message.id || generateTurnId(),
          role: 'user',
          content: message.content,
          timestamp,
          metadata: Object.keys(userMetadata).length > 0 ? userMetadata : undefined,
        })
        continue
      }

      if (message.role !== 'assistant') continue
      const restoredIds = metadata?.toolCalls?.map((toolCall, index) => (
        toolCall.id || `restored_tc_${index}_${timestamp}`
      )) ?? []
      const toolCalls = metadata?.toolCalls?.map((toolCall, index) => ({
        id: restoredIds[index]!,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }))
      const toolResults = this.restoreToolResults(metadata?.toolCalls, restoredIds)
      const turnMetadata = this.restoreAssistantMetadata(metadata)
      const assistantTurn: AgentTurn = {
        id: message.id || generateTurnId(),
        role: 'assistant',
        content: message.content,
        timestamp,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        metadata: Object.keys(turnMetadata).length > 0 ? turnMetadata : undefined,
      }
      turns.push(assistantTurn)

      if (toolResults.length > 0) {
        turns.push({
          id: `${assistantTurn.id}:tool_results`,
          role: 'tool_result',
          content: toolResults.map(result => (
            `${result.name}: ${result.isError ? 'error' : 'ok'} ${(result.output || '').slice(0, 500)}`
          )).join('\n\n'),
          timestamp: timestamp + 1,
          toolResults,
        })
      }

      if (metadata?.toolCalls?.length) {
        options.taskManager.setCurrentWorkRunId(metadata.workRunId || null)
        this.restoreTasksFromToolCalls(
          metadata.toolCalls,
          timestamp,
          options.taskManager,
          options.isToolOutputFailure,
        )
      }
    }
    return turns
  }

  private restoreToolResults(toolCalls: PersistedToolCall[] | undefined, restoredIds: string[]): ToolResult[] {
    if (!toolCalls?.length) return []
    const results: ToolResult[] = []
    toolCalls.forEach((toolCall, index) => {
      const hasResult = toolCall.result !== undefined
      const hasTerminalStatus = ['completed', 'error', 'cancelled'].includes(toolCall.status ?? '')
      if (!hasResult && !hasTerminalStatus) return
      const result: ToolResult = {
        toolCallId: restoredIds[index]!,
        name: toolCall.name,
        output: toolCall.result ?? '',
        isError: toolCall.isError ?? (toolCall.status === 'error' || toolCall.status === 'cancelled'),
      }
      if (toolCall.interruption) {
        result.interruption = { ...toolCall.interruption }
        result.errorKind = 'abort'
      } else if (toolCall.status === 'cancelled') {
        result.interruption = /paused by user/i.test(result.output)
          ? interruptionMetadata('pause')
          : interruptionMetadata('stop')
        result.errorKind = 'abort'
      }
      if (toolCall.changeSummary) result.changeSummary = toolCall.changeSummary
      results.push(result)
    })
    return results
  }

  private restoreAssistantMetadata(metadata: PersistedAgentMessage['metadata']): NonNullable<AgentTurn['metadata']> {
    const turnMetadata: NonNullable<AgentTurn['metadata']> = {}
    if (metadata?.model) turnMetadata.model = metadata.model
    if (typeof metadata?.tokens === 'number') turnMetadata.tokens = { input: metadata.tokens, output: 0 }
    else if (metadata?.tokens) turnMetadata.tokens = metadata.tokens
    if (metadata?.duration) turnMetadata.duration = metadata.duration
    if (typeof metadata?.reasoningEnabled === 'boolean') turnMetadata.reasoningEnabled = metadata.reasoningEnabled
    if (metadata?.reasoningEffort) turnMetadata.reasoningEffort = metadata.reasoningEffort
    if (metadata?.thinking) turnMetadata.thinking = { ...metadata.thinking, isStreaming: false }
    if (typeof metadata?.workRunId === 'string') turnMetadata.workRunId = metadata.workRunId
    if (metadata?.interrupted === true) turnMetadata.interrupted = true
    if (metadata?.interruption) turnMetadata.interruption = { ...metadata.interruption }
    if (metadata?.rawReasoningPayload) {
      turnMetadata.rawReasoningPayload = {
        provider: metadata.rawReasoningPayload.provider,
        blocks: metadata.rawReasoningPayload.blocks.map(block => ({ ...block })),
        ...(metadata.rawReasoningPayload.reasoningContent
          ? { reasoningContent: metadata.rawReasoningPayload.reasoningContent }
          : {}),
      }
    }
    return turnMetadata
  }

  private restoreTasksFromToolCalls(
    toolCalls: PersistedToolCall[],
    timestamp: number,
    taskManager: TaskManager,
    isToolOutputFailure: (name: string, output: string) => boolean,
  ): void {
    for (const toolCall of toolCalls) {
      if (toolCall.name === 'create_task') {
        if (!this.isRestorableTaskToolCall(toolCall, isToolOutputFailure)) continue
        const args = toolCall.arguments || {}
        let parsedResult: Record<string, unknown> | null = null
        if (toolCall.result) {
          try {
            parsedResult = JSON.parse(toolCall.result) as Record<string, unknown>
          } catch {
            parsedResult = null
          }
        }
        const restoredId = typeof parsedResult?.id === 'string'
          ? parsedResult.id
          : `restored-task-${timestamp}-${String(args.title || 'task')}`
        taskManager.restoreTask({
          id: restoredId,
          title: String(args.title || parsedResult?.title || 'Task'),
          description: String(args.description || ''),
          priority: ((args.priority as TaskPriority | undefined) || (parsedResult?.priority as TaskPriority | undefined) || 'medium'),
          status: (parsedResult?.status as TaskStatus | undefined) || 'pending',
          parentId: (args.parent_id as string | undefined) || null,
          progress: (parsedResult?.status as TaskStatus | undefined) === 'completed' ? 100 : 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        const dependencies = args.dependencies as string[] | undefined
        for (const dependencyId of dependencies ?? []) taskManager.addDependency(restoredId, dependencyId)
      }

      if (toolCall.name === 'create_tasks') {
        if (!this.isRestorableTaskToolCall(toolCall, isToolOutputFailure)) continue
        const items = toolCall.arguments.tasks as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(items)) continue
        let createdById: Record<string, unknown> | null = null
        if (toolCall.result) {
          try {
            const parsed = JSON.parse(toolCall.result) as { created?: Array<Record<string, unknown>> }
            if (parsed?.created) {
              createdById = {}
              parsed.created.forEach((created, index) => {
                if (!createdById || typeof created.id !== 'string') return
                createdById[String(index)] = created
                if (typeof created.ref === 'string') createdById[created.ref] = created
              })
            }
          } catch {
            createdById = null
          }
        }
        const refToId = new Map<string, string>()
        items.forEach((raw, index) => {
          const recovered = createdById?.[String(index)] || (typeof raw.ref === 'string' ? createdById?.[raw.ref] : null)
          const restoredId = typeof (recovered as Record<string, unknown>)?.id === 'string'
            ? String((recovered as Record<string, unknown>).id)
            : `restored-task-${timestamp}-${index}-${String(raw.title || 'task')}`
          if (typeof raw.ref === 'string') refToId.set(raw.ref, restoredId)
          const resolveRef = (value: unknown): string | undefined => {
            if (typeof value !== 'string' || !value) return undefined
            return refToId.get(value) ?? value
          }
          taskManager.restoreTask({
            id: restoredId,
            title: String(raw.title || 'Task'),
            description: String(raw.description || ''),
            priority: ((raw.priority as TaskPriority | undefined) || 'medium'),
            status: 'pending',
            parentId: resolveRef(raw.parent_id) || null,
            progress: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          const dependencies = raw.dependencies as unknown[] | undefined
          for (const dependencyRef of dependencies ?? []) {
            const dependencyId = resolveRef(dependencyRef)
            if (dependencyId) taskManager.addDependency(restoredId, dependencyId)
          }
        })
      }

      if (toolCall.name === 'update_task') {
        if (!this.isRestorableTaskToolCall(toolCall, isToolOutputFailure)) continue
        const taskId = toolCall.arguments.task_id as string | undefined
        if (!taskId) continue
        taskManager.updateTask(taskId, {
          status: toolCall.arguments.status as TaskStatus | undefined,
          progress: toolCall.arguments.progress as number | undefined,
          error: toolCall.arguments.error as string | undefined,
        })
      }
    }
  }

  private isRestorableTaskToolCall(
    toolCall: Pick<PersistedToolCall, 'name' | 'result' | 'isError' | 'status'>,
    isToolOutputFailure: (name: string, output: string) => boolean,
  ): boolean {
    if (toolCall.isError) return false
    if (['error', 'cancelled', 'pending', 'running'].includes(toolCall.status ?? '')) return false
    if (toolCall.status === 'completed') return true
    if (!toolCall.result) return false
    if (/^(Cancelled|Aborted):/i.test(toolCall.result.trim())) return false
    return !isToolOutputFailure(toolCall.name, toolCall.result)
  }
}
