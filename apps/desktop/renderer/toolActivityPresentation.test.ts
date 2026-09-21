import { describe, expect, it } from 'vitest'
import { getAllTools } from '@turboflux/tools/toolRegistry'
import { TOOL_ACTIVITIES, toolActivityDefinition, toolActivityStatus, toolActivitySummary } from '@turboflux/renderer/toolActivityPresentation'
import type { TaskFlowNode, ToolResult } from '@turboflux/presentation'

describe('tool activities', () => {
  it('provides an explicit title and semantic icon for every built-in tool', () => {
    for (const tool of getAllTools()) {
      expect(TOOL_ACTIVITIES[tool.name], tool.name).toBeDefined()
      expect(TOOL_ACTIVITIES[tool.name]?.icon).not.toBe('tool')
    }
    expect(toolActivityDefinition('list_tasks').icon).toBe('tasks')
    expect(toolActivityDefinition('add_task_dependency').icon).toBe('tasks')
    expect(toolActivityDefinition('vendor__unfamiliar').icon).toBe('tool')
    expect(toolActivityDefinition('git_status').title).not.toContain('版本')
  })

  it('shows the query before an uninformative root path', () => {
    const call = { id: '1', name: 'search_content', arguments: { path: '.', pattern: 'startRuntime' } }
    expect(toolActivitySummary(call)).toBe('startRuntime')
    const result: ToolResult = {
      toolCallId: '1', name: call.name, output: 'model text', isError: false,
      retrieval: { operation: 'search_content', scope: '.', query: 'startRuntime', outputMode: 'content',
        resources: [{ path: 'src/main.ts', kind: 'file', state: 'matched', line: 4 }], totalIsExact: false, truncated: true },
    }
    expect(toolActivitySummary(call, result)).toBe('“startRuntime” · 扫描未完成')
    expect(toolActivitySummary(call, { ...result, retrieval: { ...result.retrieval!, truncated: false } })).toBe('“startRuntime”')
  })

  it('does not claim recovery or successful completion after failure', () => {
    const call = { id: '1', name: 'read_file', arguments: { path: 'missing.ts' } }
    const result: ToolResult = { toolCallId: '1', name: call.name, output: 'Error: missing', isError: true }
    expect(toolActivitySummary(call, result)).toBe('执行失败')
    expect(toolActivitySummary(call, { ...result, errorKind: 'abort' })).toBe('已停止')
  })

  it.each(['read_file', 'run_command', 'browser__press', 'computer__click', 'vendor__operation', 'create_tasks'])(
    'settles %s from its returned result even before the projection catches up', name => {
      const call = { id: '1', name, arguments: {} }
      const node = { status: 'running' as const, settled: false }
      const result: ToolResult = { toolCallId: call.id, name, output: 'failed', isError: true }
      expect(toolActivityStatus(node, result, 'running')).toBe('failed')
      expect(toolActivitySummary(call, result, toolActivityStatus(node, result))).toBe('执行失败')
      expect(toolActivityStatus(node, { ...result, errorKind: 'timeout' })).toBe('failed')
      expect(toolActivitySummary(call, { ...result, errorKind: 'timeout' })).toBe('执行超时')
      expect(toolActivityStatus(node, { ...result, errorKind: 'abort' })).toBe('cancelled')
      expect(toolActivityStatus(node, { ...result, errorKind: 'abort', interruption: { kind: 'pause', resumable: true } })).toBe('interrupted')
      expect(toolActivityStatus(node, { ...result, isError: false })).toBe('completed')
    },
  )

  it.each(['completed', 'partial', 'failed', 'cancelled'] as const)(
    'stops orphaned tool activity after a %s run while preserving known outcomes', runStatus => {
      const status = toolActivityStatus({ status: 'running', settled: false }, undefined, runStatus)
      expect(status).toBe(runStatus === 'failed' ? 'failed' : runStatus === 'cancelled' ? 'cancelled' : 'interrupted')
      expect(toolActivityStatus({ status: 'failed', settled: true }, undefined, runStatus)).toBe('failed')
      expect(toolActivityStatus({ status: 'completed', settled: true }, undefined, runStatus)).toBe('completed')
    },
  )

  it('keeps unfinished tools live and separates a background process from its completed launch call', () => {
    for (const status of ['running', 'waiting', 'paused'] as const) {
      expect(toolActivityStatus({ status, settled: false }, undefined, 'running')).toBe(status)
    }
    expect(toolActivityStatus({ status: 'running', settled: true })).toBe('interrupted')
    expect(toolActivityStatus({ status: 'running', settled: false }, {
      toolCallId: '1', name: 'run_command', output: 'started', isError: false,
      data: { kind: 'command', status: 'running', stdout: '' },
    })).toBe('completed')
  })

  it.each<[TaskFlowNode['status'], string]>([
    ['failed', '执行失败'], ['completed', '已完成'], ['cancelled', '已停止'],
    ['interrupted', '已停止'], ['paused', '已暂停'], ['waiting', '等待中'],
  ])('does not invent running text when a %s call has no result details', (status, summary) => {
    expect(toolActivitySummary({ id: '1', name: 'vendor__operation', arguments: {} }, undefined, status)).toBe(summary)
  })
})
