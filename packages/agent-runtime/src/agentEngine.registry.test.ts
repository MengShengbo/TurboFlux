import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { SubAgentDefinition } from '@turboflux/contracts/subAgentTypes'
import type { ToolExecutor } from '@turboflux/contracts/toolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import { registerAgent, syncAgentSkills } from './subAgent'
import { SkillRuntime } from '@turboflux/extensions/skills/runtime'

it('offers spawn only to the engine whose workspace has definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-agent-availability-'))
  const first = join(root, 'first'), second = join(root, 'second')
  mkdirSync(join(first, '.turboflux', 'agents'), { recursive: true })
  mkdirSync(second)
  writeFileSync(join(first, '.turboflux', 'agents', 'only-here.md'), '---\nname: only_here\ndescription: local only\n---\nLocal instructions')
  const engines = [first, second].map(workspace => new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace, gitEnabled: false }, {} as ToolExecutor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: '', baseUrl: '', model: '' }, workspace)))
  try {
    const disabled = engines.map(engine => (engine as unknown as { modelDisabledToolNames(): string[] }).modelDisabledToolNames())
    expect(disabled[0]).not.toContain('spawn_agent')
    expect(disabled[1]).toContain('spawn_agent')
  } finally {
    for (const engine of engines) engine.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps definition lookup, refresh, spawn, retry and skills scoped to each live engine', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-scoped-agents-'))
  const workspaces = ['a', 'b'].map(name => join(root, name))
  const writeAgent = (workspace: string, prompt: string, skill: string) => {
    mkdirSync(join(workspace, '.turboflux', 'agents'), { recursive: true })
    writeFileSync(join(workspace, '.turboflux', 'agents', 'reviewer.md'), [
      '---', 'name: scoped_reviewer', 'description: Workspace reviewer', `skills: [${skill}]`, '---', prompt,
    ].join('\n'))
  }
  registerAgent({ id: 'scoped_reviewer', label: 'Shared reviewer', description: 'Shared fallback', systemPrompt: 'Shared', maxTurns: 1, maxParallel: 1 })
  writeAgent(workspaces[0], 'Workspace A', 'skill_a')
  writeAgent(workspaces[1], 'Workspace B', 'skill_b')
  const engines = workspaces.map(workspace => new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace, gitEnabled: false }, {} as ToolExecutor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: '', baseUrl: '', model: '' }, workspace)))
  const internals = engines.map(engine => engine as unknown as {
    dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown>
    startSubAgentTask(definition: SubAgentDefinition, objective: string, enrichedObjective: string, retryOf?: string): { id: string }
    subAgentTaskManager: { getTask(id: string): unknown }
  })
  const seen: string[][] = [[], []]
  try {
    internals.forEach((engine, index) => {
      vi.spyOn(engine, 'startSubAgentTask').mockImplementation(definition => { seen[index].push(definition.systemPrompt); return { id: `task-${index}` } })
      vi.spyOn(engine.subAgentTaskManager, 'getTask').mockReturnValue({ agentType: 'scoped_reviewer', objective: 'Review', runtimeTask: { status: 'failed' } })
    })
    const spawn = (index: number) => internals[index].dispatchTool('spawn_agent', { agent_type: 'scoped_reviewer', objective: 'Review' })
    await spawn(0)
    await spawn(1)
    engines[0].retrySubAgentTask('previous-a')
    engines[1].retrySubAgentTask('previous-b')
    expect(seen).toEqual([['Workspace A', 'Workspace A'], ['Workspace B', 'Workspace B']])

    writeAgent(workspaces[1], 'Workspace B refreshed', 'skill_b_new')
    engines[1].reloadAgents()
    await spawn(0)
    engines[1].retrySubAgentTask('previous-b')
    expect(seen[0].at(-1)).toBe('Workspace A')
    expect(seen[1].at(-1)).toBe('Workspace B refreshed')

    const skills = new SkillRuntime(workspaces[0], join(root, 'user-skills'))
    syncAgentSkills(skills, engines[0].getAgentDefinitions())
    expect(skills.getAll().map(skill => skill.id)).toContain('skill_a')
    expect(skills.getAll().map(skill => skill.id)).not.toContain('skill_b_new')

    rmSync(join(workspaces[0], '.turboflux', 'agents', 'reviewer.md'))
    engines[0].reloadAgents()
    engines[0].retrySubAgentTask('previous-a')
    await spawn(1)
    expect(seen[0].at(-1)).toBe('Shared')
    expect(seen[1].at(-1)).toBe('Workspace B refreshed')
  } finally {
    vi.restoreAllMocks()
    for (const engine of engines) engine.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})
