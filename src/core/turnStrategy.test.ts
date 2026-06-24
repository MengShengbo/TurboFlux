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
    expect(strategy?.needsCodeMap).toBe(true)
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

  it('promotes codemap availability after recent tool errors', () => {
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
    expect(strategy?.needsCodeMap).toBe(true)
  })

  it('does not let strategy hide read tools', () => {
    const names = openAiToolNames('vibe')

    expect(names).toContain('read_file')
    expect(names).toContain('read_file_full')
    expect(names).toContain('list_directory')
    expect(names).toContain('search_content')
    expect(names).toContain('get_codemap')
  })

  it('exposes write tools in both vibe and plan modes', () => {
    expect(openAiToolNames('vibe')).toContain('edit_file')
    expect(openAiToolNames('plan')).toContain('edit_file')
    expect(openAiToolNames('vibe')).toContain('replace_file')
    expect(openAiToolNames('plan')).toContain('replace_file')
    expect(openAiToolNames('vibe')).toContain('read_file')
    expect(openAiToolNames('plan')).toContain('read_file')
  })
})
