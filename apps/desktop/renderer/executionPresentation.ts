import {
  describeComputerToolActivity,
  type AgentTurn,
  type ToolCall,
  type ToolResult,
} from '@turboflux/agent-core/renderer'

export type ExecutionStepCategory = 'browse' | 'computer' | 'read' | 'change' | 'verify' | 'external'
export type ExecutionOutcome = 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type ExecutionPhase = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export interface ExecutionGroupPresentation {
  summary: string
  meta: string
  totalSteps: number
  completedSteps: number
  failedSteps: number
  outputCount: number
  visibleStepIds: string[]
  hiddenSteps: number
  phase: ExecutionPhase
  categories: ExecutionStepCategory[]
  stages: ExecutionStagePresentation[]
}

export interface ExecutionStagePresentation {
  category: ExecutionStepCategory
  label: string
  totalSteps: number
  completedSteps: number
  failedSteps: number
  state: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
}

export interface ExecutionPresentationOptions {
  finalized?: boolean
  outcome?: ExecutionOutcome
  durationMs?: number
  outputCount?: number
}

export function isFinalAssistantTurnInTask(turns: AgentTurn[], turnIndex: number): boolean {
  if (turns[turnIndex]?.role !== 'assistant') return false
  for (let index = turnIndex + 1; index < turns.length; index += 1) {
    if (turns[index]?.role === 'user') break
    if (turns[index]?.role === 'assistant') return false
  }
  return true
}

export function shouldFinalizeAssistantTurnInTask(
  turns: AgentTurn[],
  turnIndex: number,
  activeWorkRunId?: string,
): boolean {
  const turn = turns[turnIndex]
  if (activeWorkRunId && turn?.metadata?.workRunId === activeWorkRunId) return false
  return isFinalAssistantTurnInTask(turns, turnIndex)
}

export function shouldFinalizeExecutionGroup(
  runId: string,
  activeWorkRunId: string,
  allStepsSettled: boolean,
  outcome?: ExecutionOutcome,
): boolean {
  if (outcome) return true
  if (runId && activeWorkRunId && runId === activeWorkRunId) return false
  return allStepsSettled
}

export function shouldSplitExecutionGroup(currentRunId: string, nextRunId: string): boolean {
  return Boolean(currentRunId && nextRunId && currentRunId !== nextRunId)
}

export function executionOutcomeFromWorkRunStatus(status: string | undefined): ExecutionOutcome | undefined {
  if (status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled') return status
  return undefined
}

const READ_TOOL_PATTERN = /(^|__)(read|get|list|search|find|query|inspect|observe|snapshot|fetch)(_|$)/
const CHANGE_TOOL_PATTERN = /(^|__)(write|edit|create|delete|remove|patch|replace|update|save|move|copy|rename|import|install)(_|$)/
const VERIFY_TOOL_PATTERN = /(^|__)(test|check|verify|assert|lint|diagnostic|validate|build)(_|$)/

export function classifyExecutionStep(call: ToolCall): ExecutionStepCategory {
  const name = call.name.toLowerCase()
  if (name === 'browser__assert' || name === 'browser__diagnostics') return 'verify'
  if (name.startsWith('browser__')) return 'browse'
  if (name === 'computer__assert') return 'verify'
  if (name.startsWith('computer__')) return 'computer'
  if (name === 'run_command') {
    const kind = typeof call.arguments.display_kind === 'string' ? call.arguments.display_kind : ''
    if (kind === 'check' || kind === 'build') return 'verify'
    if (kind === 'export') return 'change'
    return 'external'
  }
  if (VERIFY_TOOL_PATTERN.test(name)) return 'verify'
  if (CHANGE_TOOL_PATTERN.test(name)) return 'change'
  if (READ_TOOL_PATTERN.test(name)) return 'read'
  return 'external'
}

export function presentExecutionGroup(
  calls: ToolCall[],
  results: ToolResult[],
  options: ExecutionPresentationOptions = {},
): ExecutionGroupPresentation {
  const resultMap = new Map(results.map(result => [result.toolCallId, result]))
  const completedSteps = calls.filter(call => resultMap.has(call.id)).length
  const failedSteps = calls.filter(call => resultMap.get(call.id)?.isError).length
  const unfinishedSteps = failedSteps + Math.max(0, calls.length - completedSteps)
  const categories = [...new Set(calls.map(classifyExecutionStep))]
  const outputCount = options.outputCount ?? countChangedOutputs(results)
  const visibleStepIds = visibleExecutionStepIds(calls, resultMap)
  const phase: ExecutionPhase = options.outcome === 'interrupted'
    ? 'cancelled'
    : options.outcome
      ? options.outcome
      : options.finalized === false || completedSteps < calls.length
        ? 'running'
        : 'completed'

  return {
    summary: summarizeExecution(calls, resultMap, phase, completedSteps, unfinishedSteps, outputCount),
    meta: summarizeExecutionMeta(calls.length, options.durationMs),
    totalSteps: calls.length,
    completedSteps,
    failedSteps,
    outputCount,
    visibleStepIds,
    hiddenSteps: Math.max(0, calls.length - visibleStepIds.length),
    phase,
    categories,
    stages: presentStages(calls, resultMap, phase),
  }
}

function summarizeExecution(
  calls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  phase: ExecutionGroupPresentation['phase'],
  completedSteps: number,
  unfinishedSteps: number,
  outputCount: number,
): string {
  const totalSteps = calls.length
  if (totalSteps === 0) {
    if (phase === 'running') return '正在处理'
    if (phase === 'failed') return '工作未完成'
    if (phase === 'partial') return '部分工作已完成'
    if (phase === 'cancelled') return '工作已中断'
    return '已完成工作'
  }

  if (phase === 'running') {
    const activeCall = calls.find(call => !resultMap.has(call.id)) || calls.at(-1)!
    return `正在${stageLabel(classifyExecutionStep(activeCall))}`
  }

  if (phase === 'failed') {
    if (completedSteps === 0) return '工作未完成'
    if (unfinishedSteps > 0) return `已完成部分工作，${unfinishedSteps} 项未完成`
    return '工作未完成，已保留当前结果'
  }

  if (phase === 'partial') {
    return unfinishedSteps > 0
      ? `部分工作已完成，${unfinishedSteps} 项未完成`
      : '部分工作已完成'
  }

  if (phase === 'cancelled') {
    return completedSteps > 0 || outputCount > 0 ? '工作已中断，已保留当前结果' : '工作已中断'
  }

  const singleTitle = totalSteps === 1 ? semanticTitle(calls[0]!) : undefined
  if (singleTitle) return `已完成 ${singleTitle}`
  if (outputCount > 0) return `已整理 ${outputCount} 项交付内容`
  const categories = [...new Set(calls.map(classifyExecutionStep))]
  if (categories.includes('change') && categories.includes('verify')) return '已完成内容处理与检查'
  if (categories.includes('browse') && categories.includes('computer')) return '已完成网页与应用操作'
  if (categories.length === 1) return completedStageLabel(categories[0]!)
  return '已完成本轮工作'
}

function summarizeExecutionMeta(totalSteps: number, durationMs: number | undefined): string {
  return [formatExecutionDuration(durationMs), totalSteps > 0 ? `${totalSteps} 项操作` : '']
    .filter(Boolean)
    .join(' · ')
}

function countChangedOutputs(results: ToolResult[]): number {
  return new Set(results.flatMap(result => result.changeSummary?.path ? [result.changeSummary.path] : [])).size
}

function visibleExecutionStepIds(calls: ToolCall[], resultMap: Map<string, ToolResult>): string[] {
  if (calls.length <= 4) return calls.map(call => call.id)
  const visible = new Set<string>()
  for (const category of [...new Set(calls.map(classifyExecutionStep))]) {
    const stageCalls = calls.filter(call => classifyExecutionStep(call) === category)
    const incomplete = stageCalls.filter(call => !resultMap.has(call.id))
    const failed = stageCalls.filter(call => resultMap.get(call.id)?.isError)
    const recentCompleted = stageCalls.filter(call => resultMap.has(call.id)).slice(-3)
    for (const call of [...failed, ...recentCompleted, ...incomplete.slice(-1)]) visible.add(call.id)
  }
  return calls.filter(call => visible.has(call.id)).map(call => call.id)
}

function presentStages(
  calls: ToolCall[],
  resultMap: Map<string, ToolResult>,
  phase: ExecutionPhase,
): ExecutionStagePresentation[] {
  const categories = [...new Set(calls.map(classifyExecutionStep))]
  const currentCall = calls.find(call => !resultMap.has(call.id))
  const currentCategory = currentCall ? classifyExecutionStep(currentCall) : undefined
  return categories.map(category => {
    const stageCalls = calls.filter(call => classifyExecutionStep(call) === category)
    const stageResults = stageCalls.flatMap(call => {
      const result = resultMap.get(call.id)
      return result ? [result] : []
    })
    const failedSteps = stageResults.filter(result => result.isError).length
    const completedSteps = stageResults.length
    const state = failedSteps > 0
      ? 'failed'
      : completedSteps === stageCalls.length
        ? 'completed'
        : phase === 'cancelled'
          ? 'cancelled'
          : phase === 'partial'
            ? 'partial'
            : phase === 'failed'
              ? 'failed'
              : phase === 'completed'
                ? 'completed'
        : currentCategory === category
          ? 'running'
          : 'pending'
    return {
      category,
      label: stageLabel(category),
      totalSteps: stageCalls.length,
      completedSteps,
      failedSteps,
      state,
    }
  })
}

function stageLabel(category: ExecutionStepCategory): string {
  return ({
    browse: '浏览与操作网页',
    computer: '操作电脑应用',
    read: '查找与阅读资料',
    change: '完成内容处理',
    verify: '检查结果',
    external: '执行后台工作',
  } as const)[category]
}

function completedStageLabel(category: ExecutionStepCategory): string {
  return ({
    browse: '已完成网页工作',
    computer: '已完成应用操作',
    read: '已完成资料整理',
    change: '已完成内容处理',
    verify: '已完成结果检查',
    external: '已完成后台工作',
  } as const)[category]
}

export function formatExecutionDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs) || durationMs === undefined || durationMs < 0) return ''
  if (durationMs < 1_000) return '不到 1 秒'
  const seconds = Math.round(durationMs / 1_000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`
}

function semanticTitle(call: ToolCall): string | undefined {
  const computerPresentation = describeComputerToolActivity(call.name, call.arguments, 'completed')
  if (computerPresentation) return computerPresentation.title
  if (call.name !== 'run_command') return undefined
  const title = typeof call.arguments.display_title === 'string' ? call.arguments.display_title.trim() : ''
  return title ? title.slice(0, 80) : undefined
}
