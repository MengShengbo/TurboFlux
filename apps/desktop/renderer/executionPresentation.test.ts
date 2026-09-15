import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolCall, ToolResult } from '@turboflux/agent-core/contracts'
import {
  classifyExecutionStep,
  executionOutcomeFromWorkRunStatus,
  isFinalAssistantTurnInTask,
  presentExecutionGroup,
  shouldFinalizeAssistantTurnInTask,
  shouldFinalizeExecutionGroup,
  shouldSplitExecutionGroup,
} from './executionPresentation'

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: args })
const result = (toolCallId: string, overrides: Partial<ToolResult> = {}): ToolResult => ({
  toolCallId,
  name: overrides.name || 'tool',
  output: '',
  isError: false,
  ...overrides,
})

describe('execution presentation', () => {
  it('classifies user-facing work by intent', () => {
    expect(classifyExecutionStep(call('1', 'browser__click'))).toBe('browse')
    expect(classifyExecutionStep(call('2', 'computer__click'))).toBe('computer')
    expect(classifyExecutionStep(call('3', 'computer__assert'))).toBe('verify')
    expect(classifyExecutionStep(call('4', 'read_file'))).toBe('read')
    expect(classifyExecutionStep(call('5', 'edit_file'))).toBe('change')
    expect(classifyExecutionStep(call('6', 'run_command', { display_kind: 'check' }))).toBe('verify')
    expect(classifyExecutionStep(call('7', 'run_command', { display_kind: 'service' }))).toBe('external')
  })

  it('summarizes an active group around the current intent', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'search_content'), call('2', 'edit_file')],
      [result('1')],
    )

    expect(presentation).toMatchObject({
      summary: '正在完成内容处理',
      meta: '2 项操作',
      phase: 'running',
      completedSteps: 1,
      failedSteps: 0,
      stages: [
        expect.objectContaining({ label: '查找与阅读资料', state: 'completed' }),
        expect.objectContaining({ label: '完成内容处理', state: 'running' }),
      ],
    })
  })

  it('collapses completed work into a quiet step summary', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'edit_file'), call('2', 'run_command', { display_kind: 'check' })],
      [
        result('1', { changeSummary: { path: 'src/app.ts', operation: 'edit' } }),
        result('2'),
      ],
    )

    expect(presentation.summary).toBe('已整理 1 项交付内容')
    expect(presentation.meta).toBe('2 项操作')
    expect(presentation.outputCount).toBe(1)
    expect(presentation.phase).toBe('completed')
    expect(presentation.stages).toEqual([
      expect.objectContaining({ label: '完成内容处理', state: 'completed' }),
      expect.objectContaining({ label: '检查结果', state: 'completed' }),
    ])
  })

  it('keeps failed attempts in details without declaring the task unfinished', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'browser__observe'), call('2', 'browser__assert')],
      [result('1'), result('2', { isError: true })],
    )

    expect(presentation.summary).toBe('已完成本轮工作')
    expect(presentation.phase).toBe('completed')
    expect(presentation.failedSteps).toBe(1)
    expect(presentation.stages.at(-1)).toMatchObject({ label: '检查结果', state: 'failed' })
  })

  it('only reports unfinished work from an explicit task outcome', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'browser__observe'), call('2', 'browser__assert')],
      [result('1'), result('2', { isError: true })],
      { outcome: 'failed' },
    )

    expect(presentation.summary).toBe('已完成部分工作，1 项未完成')
    expect(presentation.phase).toBe('failed')
  })

  it('settles an interrupted active operation as failed', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'read_file'), call('2', 'edit_file')],
      [result('1')],
      { outcome: 'failed' },
    )

    expect(presentation.phase).toBe('failed')
    expect(presentation.summary).toBe('已完成部分工作，1 项未完成')
  })

  it('maps terminal work-run states without treating session completion as success', () => {
    expect(executionOutcomeFromWorkRunStatus('completed')).toBe('completed')
    expect(executionOutcomeFromWorkRunStatus('partial')).toBe('partial')
    expect(executionOutcomeFromWorkRunStatus('failed')).toBe('failed')
    expect(executionOutcomeFromWorkRunStatus('cancelled')).toBe('cancelled')
    expect(executionOutcomeFromWorkRunStatus('running')).toBeUndefined()
  })

  it('presents partial and interrupted work as distinct terminal outcomes', () => {
    const calls = [call('1', 'read_file'), call('2', 'edit_file')]
    const partial = presentExecutionGroup(calls, [result('1')], { outcome: 'partial' })
    const interrupted = presentExecutionGroup(calls, [result('1')], { outcome: 'cancelled' })

    expect(partial).toMatchObject({ phase: 'partial', summary: '部分工作已完成，1 项未完成' })
    expect(partial.stages.at(-1)).toMatchObject({ state: 'partial' })
    expect(interrupted).toMatchObject({ phase: 'cancelled', summary: '工作已中断，已保留当前结果' })
    expect(interrupted.stages.at(-1)).toMatchObject({ state: 'cancelled' })
  })

  it('lets a terminal run override delayed tool-result events', () => {
    const completed = presentExecutionGroup(
      [call('1', 'read_file'), call('2', 'edit_file')],
      [result('1')],
      { outcome: 'completed' },
    )

    expect(completed.phase).toBe('completed')
    expect(completed.stages.at(-1)).toMatchObject({ state: 'completed' })
  })

  it('does not report zero unfinished operations after a failed final response', () => {
    const failed = presentExecutionGroup(
      [call('1', 'read_file')],
      [result('1')],
      { outcome: 'failed' },
    )

    expect(failed.summary).toBe('工作未完成，已保留当前结果')
  })

  it('uses the model-provided semantic title for one background task', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'run_command', { display_kind: 'build', display_title: '生成发布版本' })],
      [result('1')],
    )

    expect(presentation.summary).toBe('已完成 生成发布版本')
  })

  it('keeps a live execution running between model rounds', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'read_file')],
      [result('1')],
      { finalized: false },
    )

    expect(presentation.phase).toBe('running')
    expect(presentation.summary).toBe('正在查找与阅读资料')
  })

  it('uses semantic computer activity in active and completed summaries', () => {
    const active = presentExecutionGroup(
      [call('1', 'computer__click', { app_name: 'Keynote' })],
      [],
    )
    const completed = presentExecutionGroup(
      [call('1', 'computer__click', { app_name: 'Keynote' })],
      [result('1')],
    )

    expect(active.summary).toBe('正在操作电脑应用')
    expect(completed.summary).toBe('已完成 操作应用')
  })

  it('keeps progress reports inside one task and exposes one final duration', () => {
    const firstCalls = [call('read', 'read_file')]
    const secondCalls = [call('verify', 'run_command', { display_kind: 'check' })]
    const turns: AgentTurn[] = [
      { id: 'user', role: 'user', content: 'test', timestamp: 0 },
      { id: 'call-1', role: 'assistant', content: '', timestamp: 10_000, toolCalls: firstCalls },
      { id: 'progress', role: 'assistant', content: '已完成第一阶段', timestamp: 20_000 },
      { id: 'call-2', role: 'assistant', content: '', timestamp: 25_000, toolCalls: secondCalls },
      { id: 'final', role: 'assistant', content: 'done', timestamp: 31_000 },
    ]

    expect(isFinalAssistantTurnInTask(turns, 1)).toBe(false)
    expect(isFinalAssistantTurnInTask(turns, 2)).toBe(false)
    expect(isFinalAssistantTurnInTask(turns, 3)).toBe(false)
    expect(isFinalAssistantTurnInTask(turns, 4)).toBe(true)
    const completed = presentExecutionGroup(
      [...firstCalls, ...secondCalls],
      [result('read'), result('verify')],
      { durationMs: turns[4]!.timestamp - turns[0]!.timestamp },
    )
    expect(completed.summary).toBe('已完成本轮工作')
    expect(completed.meta).toBe('31 秒 · 2 项操作')
  })

  it('does not finalize the latest persisted turn while its work run is still active', () => {
    const turns: AgentTurn[] = [
      { id: 'user', role: 'user', content: '完成长任务', timestamp: 0, metadata: { workRunId: 'run-1' } },
      { id: 'tool', role: 'assistant', content: '继续处理', timestamp: 1, metadata: { workRunId: 'run-1' } },
    ]

    expect(isFinalAssistantTurnInTask(turns, 1)).toBe(true)
    expect(shouldFinalizeAssistantTurnInTask(turns, 1, 'run-1')).toBe(false)
    expect(shouldFinalizeAssistantTurnInTask(turns, 1)).toBe(true)
  })

  it('keeps one execution group open across hot reloads while the run remains active', () => {
    expect(shouldFinalizeExecutionGroup('run-1', 'run-1', true)).toBe(false)
    expect(shouldFinalizeExecutionGroup('run-1', '', true)).toBe(true)
    expect(shouldFinalizeExecutionGroup('run-1', 'run-1', true, 'completed')).toBe(true)
  })

  it('splits execution groups only when two explicit work-run ids differ', () => {
    expect(shouldSplitExecutionGroup('run-1', 'run-2')).toBe(true)
    expect(shouldSplitExecutionGroup('run-1', 'run-1')).toBe(false)
    expect(shouldSplitExecutionGroup('run-1', '')).toBe(false)
    expect(shouldSplitExecutionGroup('', 'run-2')).toBe(false)
  })

  it('keeps a bounded recent preview inside each execution stage', () => {
    const calls = Array.from({ length: 8 }, (_, index) => call(String(index + 1), index === 7 ? 'edit_file' : 'read_file'))
    const results = calls.slice(0, 7).map(item => result(item.id, item.id === '3' ? { isError: true } : {}))
    const presentation = presentExecutionGroup(calls, results, { finalized: false })

    expect(presentation.visibleStepIds).toEqual(['3', '5', '6', '7', '8'])
    expect(presentation.hiddenSteps).toBe(3)
  })

  it('does not let a later stage hide the useful preview of an earlier stage', () => {
    const calls = [
      ...Array.from({ length: 6 }, (_, index) => call(`read-${index + 1}`, 'read_file')),
      ...Array.from({ length: 5 }, (_, index) => call(`edit-${index + 1}`, 'edit_file')),
    ]
    const presentation = presentExecutionGroup(calls, calls.map(item => result(item.id)))

    expect(presentation.visibleStepIds).toEqual([
      'read-4', 'read-5', 'read-6',
      'edit-3', 'edit-4', 'edit-5',
    ])
  })

  it('integrates duration and outputs into the completed presentation', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'edit_file'), call('2', 'run_command', { display_kind: 'check' })],
      [result('1', { changeSummary: { path: 'src/app.ts', operation: 'edit' } }), result('2')],
      { durationMs: 91_000, outputCount: 3 },
    )

    expect(presentation.summary).toBe('已整理 3 项交付内容')
    expect(presentation.meta).toBe('1 分 31 秒 · 2 项操作')
  })

  it('shows the single final task duration', () => {
    const presentation = presentExecutionGroup(
      [call('1', 'edit_file')],
      [result('1')],
      { durationMs: 12_400 },
    )

    expect(presentation.meta).toBe('12 秒 · 1 项操作')
  })

})
