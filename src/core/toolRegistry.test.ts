import { describe, expect, it } from 'vitest'
import { getToolsForMode, toolsToAnthropicFormat, toolsToOpenAIFormat, validateToolArgs } from './toolRegistry'

describe('tool mode boundaries', () => {
  it('exposes only read-only tools in plan mode', () => {
    const tools = getToolsForMode('plan')

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every(tool => tool.isReadOnly)).toBe(true)
    expect(tools.some(tool => tool.name === 'run_command')).toBe(false)
    expect(tools.some(tool => tool.name === 'write_file')).toBe(false)
  })

  it('emits closed schemas and strict nullable optionals for OpenAI', () => {
    const tools = toolsToOpenAIFormat('vibe', { strict: true }) as any[]
    const readFile = tools.find(tool => tool.function.name === 'read_file')
    const multiEdit = tools.find(tool => tool.function.name === 'multi_edit')

    expect(readFile.function.strict).toBe(true)
    expect(readFile.function.parameters.additionalProperties).toBe(false)
    expect(readFile.function.parameters.required).toContain('offset')
    expect(readFile.function.parameters.properties.offset.anyOf).toContainEqual({ type: 'null' })
    expect(multiEdit.function.parameters.properties.edits.items.additionalProperties).toBe(false)
  })

  it('includes array item schemas for Anthropic and rejects extra arguments', () => {
    const tools = toolsToAnthropicFormat('vibe') as any[]
    const webSearch = tools.find(tool => tool.name === 'web_search')

    expect(webSearch.input_schema.properties.domains.items).toEqual({ type: 'string' })
    expect(validateToolArgs('read_file', { path: 'a.ts', surprise: true })).toEqual({ valid: false, error: 'Unexpected parameter: surprise' })
  })

  it('exposes validated terminal stdin writes only in vibe mode', () => {
    expect(getToolsForMode('vibe').some(tool => tool.name === 'write_terminal')).toBe(true)
    expect(getToolsForMode('plan').some(tool => tool.name === 'write_terminal')).toBe(false)
    expect(validateToolArgs('write_terminal', { session_id: 'term-1', data: 'yes\n' })).toEqual({ valid: true })
  })

  it('exposes background subagent lifecycle tools with mode-safe cancellation', () => {
    const vibeTools = getToolsForMode('vibe')
    const planTools = getToolsForMode('plan')

    expect(vibeTools.some(tool => tool.name === 'list_agents')).toBe(true)
    expect(vibeTools.some(tool => tool.name === 'read_agent')).toBe(true)
    expect(vibeTools.some(tool => tool.name === 'cancel_agent')).toBe(true)
    expect(planTools.some(tool => tool.name === 'read_agent')).toBe(true)
    expect(planTools.some(tool => tool.name === 'cancel_agent')).toBe(false)
    expect(validateToolArgs('read_agent', { agent_id: 'runtime_agent_1', offset: 0, limit: 25 })).toEqual({ valid: true })
  })
})
