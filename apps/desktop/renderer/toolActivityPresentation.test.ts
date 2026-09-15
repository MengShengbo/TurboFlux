import { describe, expect, it } from 'vitest'
import { getAllTools } from '../../../packages/agent-core/src/core/toolRegistry'
import { TOOL_ACTIVITIES, toolActivityDefinition, toolActivitySummary } from './toolActivityPresentation'
import type { ToolResult } from '@turboflux/agent-core/renderer'

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
    expect(toolActivitySummary(call, result)).toContain('1 处匹配')
    expect(toolActivitySummary(call, result)).toContain('扫描未完成')
    expect(toolActivitySummary(call, result)).not.toContain('已读取')
  })

  it('does not claim recovery or successful completion after failure', () => {
    const call = { id: '1', name: 'read_file', arguments: { path: 'missing.ts' } }
    const result: ToolResult = { toolCallId: '1', name: call.name, output: 'Error: missing', isError: true }
    expect(toolActivitySummary(call, result)).toBe('执行失败')
    expect(toolActivitySummary(call, { ...result, errorKind: 'abort' })).toBe('已停止')
  })
})
