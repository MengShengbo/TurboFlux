import { describe, expect, it } from 'vitest'
import { getToolsForMode, toolsToAnthropicFormat, toolsToOpenAIFormat, validateToolArgs } from './toolRegistry'

describe('tool mode boundaries', () => {
  it('exposes only read-only tools in plan mode', () => {
    const tools = getToolsForMode('plan')

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every(tool => tool.isReadOnly)).toBe(true)
    expect(tools.some(tool => tool.name === 'run_command')).toBe(false)
    expect(tools.some(tool => tool.name === 'write_file')).toBe(false)
    expect(tools.some(tool => tool.name === 'apply_patch')).toBe(false)
  })

  it('emits closed schemas and strict nullable optionals for OpenAI', () => {
    const tools = toolsToOpenAIFormat('vibe', { strict: true }) as any[]
    const readFile = tools.find(tool => tool.function.name === 'read_file')
    const multiEdit = tools.find(tool => tool.function.name === 'multi_edit')
    const createTasks = tools.find(tool => tool.function.name === 'create_tasks')
    const runCommand = tools.find(tool => tool.function.name === 'run_command')

    expect(readFile.function.strict).toBe(true)
    expect(readFile.function.parameters.additionalProperties).toBe(false)
    expect(readFile.function.parameters.required).toContain('offset')
    expect(readFile.function.parameters.properties.offset.anyOf).toContainEqual({ type: 'null' })
    expect(multiEdit.function.parameters.properties.edits.items.additionalProperties).toBe(false)
    expect(createTasks.function.parameters.properties.tasks.items.required).toContain('parent_id')
    expect(runCommand.function.parameters.required).toEqual(expect.arrayContaining(['display_kind', 'display_title']))
  })

  it('includes array item schemas for Anthropic and rejects extra arguments', () => {
    const tools = toolsToAnthropicFormat('vibe') as any[]
    const webSearch = tools.find(tool => tool.name === 'web_search')

    expect(webSearch.input_schema.properties.domains.items).toEqual({ type: 'string' })
    expect(webSearch.description).toContain('Do not use it as a substitute for source code missing from the active workspace')
    expect(validateToolArgs('read_file', { path: 'a.ts', surprise: true })).toEqual({ valid: false, error: 'Unexpected parameter: surprise' })
  })

  it('enforces nested array schemas before a tool reaches its executor', () => {
    expect(validateToolArgs('git_commit', { message: 'commit changes', paths: [] })).toMatchObject({ valid: false })
    expect(validateToolArgs('git_commit', { message: 'commit changes', paths: [42] })).toMatchObject({
      valid: false,
      error: 'Invalid type for paths[0]: expected string',
    })
    expect(validateToolArgs('git_commit', { message: 'commit changes', paths: ['x'.repeat(1_025)] })).toMatchObject({ valid: false })
    expect(validateToolArgs('git_commit', { message: 'commit changes', paths: ['src/app.ts'] })).toEqual({ valid: true })
    expect(validateToolArgs('git_restore', { paths: ['src/app.ts'], source: 'HEAD~1' })).toEqual({ valid: true })
    expect(validateToolArgs('git_revert', { revision: 'abc1234' })).toEqual({ valid: true })
  })

  it('allows compatible providers to omit nullable nested fields', () => {
    const tools = toolsToOpenAIFormat('vibe') as any[]
    const createTasks = tools.find(tool => tool.function.name === 'create_tasks')
    const taskItem = createTasks.function.parameters.properties.tasks.items

    expect(taskItem.required).toEqual(['title', 'description', 'priority'])
    expect(validateToolArgs('create_tasks', {
      tasks: [{ title: 'Build project', description: 'Run the build', priority: 'major' }],
    })).toEqual({ valid: true })
    expect(validateToolArgs('create_tasks', {
      tasks: [{ title: 'Build project', description: 'Run the build', priority: 'major', parent_id: 42 }],
    })).toMatchObject({ valid: false, error: 'Invalid type for tasks[0].parent_id: expected string or null' })
    expect(validateToolArgs('multi_edit', {
      path: 'src/app.ts',
      edits: [{ old_string: 'old', new_string: 'new' }],
    })).toEqual({ valid: true })
    expect(validateToolArgs('apply_patch', {
      patch: '*** Begin Patch\n*** End Patch',
    })).toEqual({ valid: true })
  })

  it('exposes validated terminal stdin writes only in vibe mode', () => {
    expect(getToolsForMode('vibe').some(tool => tool.name === 'write_terminal')).toBe(true)
    expect(getToolsForMode('plan').some(tool => tool.name === 'write_terminal')).toBe(false)
    expect(validateToolArgs('write_terminal', { session_id: 'term-1', data: 'yes\n' })).toEqual({ valid: true })
  })

  it('requires model-provided display semantics for commands', () => {
    expect(validateToolArgs('run_command', { command: 'npm test' })).toMatchObject({
      valid: false,
      error: 'Missing required parameter: display_kind',
    })
    expect(validateToolArgs('run_command', {
      command: 'npm test',
      display_kind: 'check',
      display_title: '验证项目质量',
    })).toEqual({ valid: true })
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

  it('marks interactive and background lifecycle tools as serialized side effects', () => {
    const vibeTools = getToolsForMode('vibe')
    const askUser = vibeTools.find(tool => tool.name === 'ask_user')
    const spawnAgent = vibeTools.find(tool => tool.name === 'spawn_agent')

    expect(vibeTools.some(tool => tool.name === 'use_skill')).toBe(true)
    expect(askUser).toMatchObject({ isConcurrencySafe: false })
    expect(spawnAgent).toMatchObject({ isReadOnly: false, isConcurrencySafe: false })
  })

  it('exposes a plugin-neutral workflow surface contract', () => {
    const workflow = getToolsForMode('vibe').find(tool => tool.name === 'present_workflow') as any
    expect(workflow).toMatchObject({ name: 'present_workflow', isConcurrencySafe: false })
    expect(workflow.parameters.map((parameter: any) => parameter.name)).toEqual(expect.arrayContaining([
      'workflow', 'stage', 'renderer', 'choices', 'directions', 'input',
    ]))
    expect(validateToolArgs('present_workflow', {
      workflow: 'design-atlas',
      stage: 'research-gate',
      renderer: 'choice',
      title: '选择研究深度',
      question: '要不要深度调研？',
      choices: [{ id: 'deep-research', label: '深度调研' }],
    })).toEqual({ valid: true })
    expect(validateToolArgs('present_workflow', {
      workflow: 'design-atlas',
      stage: 'research-gate',
      renderer: 'custom',
      title: 'Unsupported',
      question: 'Continue?',
    })).toMatchObject({ valid: false })
    expect(validateToolArgs('present_workflow', {
      workflow: 'design-atlas',
      stage: 'direction-gallery',
      renderer: 'gallery',
      title: 'Directions',
      question: 'Choose one',
      directions: [{ id: '01', name: 'One', thesis: 'First', previewUrl: 'http://127.0.0.1/private' }],
    })).toMatchObject({ valid: false })
  })
})
