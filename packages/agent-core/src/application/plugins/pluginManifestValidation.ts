import { PLUGIN_PERMISSIONS, type PluginManifest, type PluginPermission } from '../../shared/pluginTypes'

const ALLOWED_PERMISSIONS = new Set<PluginPermission>(PLUGIN_PERMISSIONS)

function safeRelativePath(value: string, label: string): string {
  if (!value || value.startsWith('/') || /^[a-z]:[\\/]/i.test(value)) throw new Error(`${label} must be a relative path`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe path`)
  return normalized
}

function optionalArray(value: unknown, label: string, maximum: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > maximum) throw new Error(`${label} exceeds the ${maximum} item limit`)
  return value
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][\w.-]*$/i.test(value) || value.length > 160) throw new Error(`${label} is invalid`)
  return value
}

function requireNonEmptyText(value: unknown, label: string, maximum = 1_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid`)
  return value
}

function requireUniqueIds(items: unknown[], label: string): void {
  const ids = new Set<string>()
  for (const item of items) {
    const id = requireIdentifier(requireObject(item, label).id, `${label} id`)
    if (ids.has(id)) throw new Error(`${label} contains duplicate id: ${id}`)
    ids.add(id)
  }
}

function validateChoices(value: unknown, label: string): void {
  const choices = optionalArray(value, label, 40)
  requireUniqueIds(choices, label)
  for (const candidate of choices) {
    const choice = requireObject(candidate, label)
    requireNonEmptyText(choice.label, `${label} label`, 240)
    if (choice.detail !== undefined && (typeof choice.detail !== 'string' || choice.detail.length > 2_000)) throw new Error(`${label} detail is invalid`)
  }
}

function validateWorkflowInput(value: unknown, label: string): void {
  if (value === undefined) return
  const input = requireObject(value, label)
  if (!['number', 'text'].includes(String(input.type))) throw new Error(`${label} type is invalid`)
  for (const field of ['min', 'max'] as const) {
    if (input[field] !== undefined && (typeof input[field] !== 'number' || !Number.isFinite(input[field]))) throw new Error(`${label} ${field} is invalid`)
  }
  if (typeof input.min === 'number' && typeof input.max === 'number' && input.min > input.max) throw new Error(`${label} range is invalid`)
  for (const field of ['label', 'placeholder'] as const) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 240)) throw new Error(`${label} ${field} is invalid`)
  }
}

export function validatePluginManifest(value: unknown): PluginManifest {
  const manifest = requireObject(value, 'plugin.json') as unknown as PluginManifest
  if (typeof manifest.id !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(manifest.id) || manifest.id.length > 120) throw new Error('Invalid plugin id')
  requireNonEmptyText(manifest.name, 'Plugin name', 120)
  if (typeof manifest.description !== 'string' || manifest.description.length > 1_000) throw new Error('Invalid plugin description')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Plugin version must use SemVer')
  const author = requireObject(manifest.author, 'Plugin author')
  requireNonEmptyText(author.name, 'Plugin author name', 160)
  if (manifest.main !== undefined) safeRelativePath(requireNonEmptyText(manifest.main, 'Plugin main entry', 500), 'Plugin main entry')

  const permissions = optionalArray(manifest.permissions, 'Plugin permissions', ALLOWED_PERMISSIONS.size) as PluginPermission[]
  if (permissions.some(permission => !ALLOWED_PERMISSIONS.has(permission))) throw new Error('Plugin requests an unknown permission')
  if (new Set(permissions).size !== permissions.length) throw new Error('Plugin contains duplicate permissions')

  const contributes = manifest.contributes === undefined ? {} : requireObject(manifest.contributes, 'Plugin contributes')
  const commands = optionalArray(contributes.commands, 'Plugin commands', 128)
  const tools = optionalArray(contributes.tools, 'Plugin tools', 64)
  const agents = optionalArray(contributes.agents, 'Plugin agents', 16)
  const skills = optionalArray(contributes.skills, 'Plugin skills', 128)
  const workflows = optionalArray(contributes.workflows, 'Plugin workflows', 32)
  requireUniqueIds(commands, 'Plugin commands')
  requireUniqueIds(tools, 'Plugin tools')
  requireUniqueIds(agents, 'Plugin agents')
  requireUniqueIds(skills, 'Plugin skills')
  requireUniqueIds(workflows, 'Plugin workflows')

  for (const candidate of commands) {
    const command = requireObject(candidate, 'Plugin command')
    requireNonEmptyText(command.title, `Plugin command ${String(command.id)} title`, 240)
  }

  for (const candidate of tools) {
    const tool = requireObject(candidate, 'Plugin tool')
    requireNonEmptyText(tool.name, `Plugin tool ${String(tool.id)} name`, 160)
    requireNonEmptyText(tool.description, `Plugin tool ${String(tool.id)} description`, 2_000)
    if (!/^[\w.-]+$/.test(requireNonEmptyText(tool.handler, `Plugin tool ${String(tool.id)} handler`, 160))) throw new Error(`Invalid plugin tool handler: ${String(tool.id)}`)
    const parameters = optionalArray(tool.parameters, `Plugin tool ${String(tool.id)} parameters`, 64)
    requireUniqueIds(parameters.map(parameter => {
      const object = requireObject(parameter, `Plugin tool ${String(tool.id)} parameter`)
      return { ...object, id: object.name }
    }), `Plugin tool ${String(tool.id)} parameters`)
  }

  for (const candidate of agents) {
    const agent = requireObject(candidate, 'Plugin agent')
    const id = String(agent.id)
    requireNonEmptyText(agent.name, `Plugin agent ${id} name`, 160)
    requireNonEmptyText(agent.description, `Plugin agent ${id} description`, 2_000)
    requireNonEmptyText(agent.systemPrompt, `Plugin agent ${id} system prompt`, 50_000)
    const agentTools = optionalArray(agent.tools, `Plugin agent ${id} tools`, 128)
    if (agentTools.some(tool => typeof tool !== 'string' || !/^[\w.-]+$/.test(tool))) throw new Error(`Plugin agent tools are invalid: ${id}`)
    if (agent.requestTimeoutMs !== undefined && (!Number.isInteger(agent.requestTimeoutMs) || Number(agent.requestTimeoutMs) < 1_000 || Number(agent.requestTimeoutMs) > 600_000)) throw new Error(`Plugin agent request timeout is invalid: ${id}`)
    if (agent.requiredToolCalls !== undefined) {
      const requirements = Object.entries(requireObject(agent.requiredToolCalls, `Plugin agent ${id} completion gate`))
      if (requirements.length === 0 || requirements.length > 16 || requirements.some(([tool, count]) => !/^[\w.-]+$/.test(tool) || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 20)) throw new Error(`Plugin agent completion gate is invalid: ${id}`)
      if (requirements.some(([tool]) => agentTools.length > 0 && !agentTools.includes(tool))) throw new Error(`Plugin agent completion gate references an unavailable tool: ${id}`)
    }
  }

  for (const candidate of skills) {
    const skill = requireObject(candidate, 'Plugin skill')
    const id = String(skill.id)
    requireNonEmptyText(skill.name, `Plugin skill ${id} name`, 160)
    requireNonEmptyText(skill.command, `Plugin skill ${id} command`, 160)
    requireNonEmptyText(skill.description, `Plugin skill ${id} description`, 2_000)
    requireNonEmptyText(skill.category, `Plugin skill ${id} category`, 80)
    if (skill.promptPath !== undefined) safeRelativePath(requireNonEmptyText(skill.promptPath, `Skill ${id} promptPath`, 500), `Skill ${id} promptPath`)
  }

  const skillIds = new Set(skills.map(skill => String((skill as Record<string, unknown>).id)))
  for (const candidate of workflows) {
    const workflow = requireObject(candidate, 'Plugin workflow')
    const id = String(workflow.id)
    requireNonEmptyText(workflow.name, `Plugin workflow ${id} name`, 160)
    requireNonEmptyText(workflow.description, `Plugin workflow ${id} description`, 2_000)
    if (workflow.skillId !== undefined && (typeof workflow.skillId !== 'string' || !skillIds.has(workflow.skillId))) throw new Error(`Plugin workflow references an unknown skill: ${String(workflow.skillId)}`)
    const stages = optionalArray(workflow.stages, `Plugin workflow ${id} stages`, 64)
    if (stages.some(stage => typeof stage !== 'string' || !stage.trim() || stage.length > 160) || new Set(stages).size !== stages.length) throw new Error(`Plugin workflow stages are invalid: ${id}`)
    if (workflow.renderer !== undefined || workflow.entry !== undefined) throw new Error(`Plugin workflow ${id} uses unsupported top-level presentation fields`)
    const checkpoints = optionalArray(workflow.checkpoints, `Plugin workflow ${id} checkpoints`, 32)
    const checkpointStages = new Set<string>()
    for (const candidateCheckpoint of checkpoints) {
      const checkpoint = requireObject(candidateCheckpoint, `Plugin workflow ${id} checkpoint`)
      if (checkpoint.previewUrl !== undefined) throw new Error(`Plugin workflow checkpoint remote previews are not supported: ${String(checkpoint.stage || 'unknown')}`)
      const stage = requireNonEmptyText(checkpoint.stage, `Plugin workflow ${id} checkpoint stage`, 160)
      requireNonEmptyText(checkpoint.title, `Plugin workflow ${id} checkpoint title`, 240)
      requireNonEmptyText(checkpoint.question, `Plugin workflow ${id} checkpoint question`, 2_000)
      if (checkpointStages.has(stage)) throw new Error(`Plugin workflow checkpoint is duplicated: ${stage}`)
      checkpointStages.add(stage)
      if (stages.length > 0 && !stages.includes(stage)) throw new Error(`Plugin workflow checkpoint stage is undeclared: ${stage}`)
      if (checkpoint.renderer !== undefined && !['choice', 'count', 'gallery'].includes(String(checkpoint.renderer))) throw new Error(`Plugin workflow checkpoint renderer is unsupported: ${stage}`)
      validateChoices(checkpoint.choices, `Plugin workflow ${id} checkpoint ${stage} choices`)
      validateWorkflowInput(checkpoint.input, `Plugin workflow ${id} checkpoint ${stage} input`)
      const trigger = requireObject(checkpoint.trigger, `Plugin workflow ${id} checkpoint ${stage} trigger`)
      const triggerTools = [trigger.tool, ...optionalArray(trigger.tools, `Plugin workflow ${id} checkpoint ${stage} trigger tools`, 32)].filter(tool => tool !== undefined)
      if (triggerTools.length === 0 || triggerTools.some(tool => typeof tool !== 'string' || !/^[\w.-]+$/.test(tool))) throw new Error(`Plugin workflow checkpoint trigger is invalid: ${stage}`)
      if (trigger.argument !== undefined && (typeof trigger.argument !== 'string' || !/^[\w.-]+$/.test(trigger.argument))) throw new Error(`Plugin workflow checkpoint trigger argument is invalid: ${stage}`)
      for (const matcher of [trigger.equals, trigger.includes, trigger.endsWith]) {
        if (matcher !== undefined && (typeof matcher !== 'string' || !matcher || matcher.length > 500)) throw new Error(`Plugin workflow checkpoint trigger matcher is invalid: ${stage}`)
      }
      const blocked = optionalArray(checkpoint.blockBeforeTrigger, `Plugin workflow ${id} checkpoint ${stage} guards`, 32)
      if (blocked.some(tool => typeof tool !== 'string' || !/^[\w.-]+$/.test(tool))) throw new Error(`Plugin workflow checkpoint guard is invalid: ${stage}`)
    }
  }

  for (const unsupported of ['views', 'viewsContainers', 'themes'] as const) {
    if (optionalArray(contributes[unsupported], `Plugin ${unsupported}`, 128).length > 0) throw new Error('Renderer views and themes are not supported by the sandboxed plugin platform')
  }
  const engine = manifest.engines?.turboflux || manifest.engines?.turboforge
  if (engine && !['*', '>=1.0.0', '^1.0.0', '1.x'].includes(engine)) throw new Error(`Unsupported TurboFlux engine range: ${engine}`)
  return JSON.parse(JSON.stringify(manifest)) as PluginManifest
}
