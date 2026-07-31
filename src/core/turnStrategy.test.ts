import { describe, expect, it } from 'vitest'
import { toolsToOpenAIFormat } from './toolRegistry'
import { TurnStrategyPlanner } from './turnStrategy'
import type { AgentMode, AgentSession, AgentTurn, ToolResult } from '../shared/agentTypes'

function sessionFor(content: string, mode: AgentMode = 'vibe', extraTurns: AgentTurn[] = []): AgentSession {
  const turns: AgentTurn[] = [
    ...extraTurns,
    { id: 'user-1', role: 'user', content, timestamp: 1 },
  ]
  return {
    id: 'session-1',
    mode,
    turns,
    currentTaskId: null,
    createdAt: 1,
    updatedAt: 1,
    totalTokens: { input: 0, output: 0 },
  }
}

function openAiToolNames(mode: AgentMode): string[] {
  return toolsToOpenAIFormat(mode).map(tool => {
    const fn = (tool as { function?: { name?: string } }).function
    return fn?.name || ''
  }).filter(Boolean)
}

interface OpenAIToolShape {
  function?: {
    name?: string
    description?: string
    parameters?: { properties?: Record<string, unknown> }
  }
}

function openAiTool(mode: AgentMode, name: string): OpenAIToolShape | undefined {
  return toolsToOpenAIFormat(mode).find(tool => (
    (tool as { function?: { name?: string } }).function?.name === name
  )) as OpenAIToolShape | undefined
}

describe('TurnStrategyPlanner', () => {
  it('does not classify natural-language intent', () => {
    const planner = new TurnStrategyPlanner()
    const a = planner.plan(sessionFor('hi'), 'vibe')
    const b = planner.plan(sessionFor('看看项目的整体结构'), 'vibe')

    expect(a?.intent).toBe('model_decides')
    expect(b?.intent).toBe('model_decides')
    expect(a?.scope).toBe('model_decides')
    expect(b?.scope).toBe('model_decides')
  })

  it('uses structured runtime signals for evidence guidance', () => {
    const planner = new TurnStrategyPlanner()
    const strategy = planner.plan(sessionFor('anything'), 'vibe')

    expect(strategy?.requiresEvidence).toBe(false)
    expect(strategy?.needsWorkspaceContext).toBe(true)
    expect(strategy?.allowWrites).toBe(true)
  })

  it('recognizes recent read/search evidence without reading user text', () => {
    const planner = new TurnStrategyPlanner()
    const strategy = planner.plan(sessionFor('anything', 'vibe', [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: { path: 'src/index.ts' } }],
      },
    ]), 'vibe')

    expect(strategy?.requiresEvidence).toBe(false)
  })

  it('keeps tool-error recovery model-directed', () => {
    const planner = new TurnStrategyPlanner()
    const errorResult: ToolResult = {
      toolCallId: 'tc-1',
      name: 'read_file',
      output: 'Error: not found',
      isError: true,
    }
    const strategy = planner.plan(sessionFor('anything', 'vibe', [
      { id: 'tool-1', role: 'tool_result', content: '', timestamp: 1, toolResults: [errorResult] },
    ]), 'vibe')

    expect(strategy?.needsWorkspaceContext).toBe(true)
    expect(strategy?.reasons).toContain('recent tool errors=1')
    expect(strategy?.verificationPlan).toContain('If a tool failed, recover from the failure with a different read/search path before concluding.')
  })

  it('does not let strategy hide read tools', () => {
    const names = openAiToolNames('vibe')

    expect(names).toContain('read_file')
    expect(names).toContain('read_file_full')
    expect(names).toContain('list_directory')
    expect(names).toContain('search_content')
    expect(names).toContain('get_codemap')
  })

  it('keeps read output canonical for direct editing', () => {
    const readTool = openAiTool('vibe', 'read_file')
    const properties = readTool?.function?.parameters?.properties || {}

    expect(properties).not.toHaveProperty('with_line_numbers')
    expect(readTool?.function?.description).toContain('pasted directly')
  })

  it('does not expose a redundant change-summary tool', () => {
    expect(openAiToolNames('vibe')).not.toContain('generate_change_summary')
  })

  it('keeps plan mode read-only while vibe mode can write', () => {
    expect(openAiToolNames('vibe')).toContain('edit_file')
    expect(openAiToolNames('plan')).not.toContain('edit_file')
    expect(openAiToolNames('vibe')).toContain('replace_file')
    expect(openAiToolNames('plan')).not.toContain('replace_file')
    expect(openAiToolNames('vibe')).toContain('read_file')
    expect(openAiToolNames('plan')).toContain('read_file')
  })
})
