import type { SubAgentEvent, SubAgentEvidence, SubAgentDefinition } from '../shared/subAgentTypes'
import type { ToolExecutor } from '../tools/executor'
import { loadAgentsFromDir, type LoadedAgent } from './agents/loader'
import type { SkillRuntime } from './skills/runtime'
import type { LoadedSkill } from './skills/loader'

export { type SubAgentDefinition }

// ── 动态代理注册表 ────────────────────────────────────────────────

const dynamicAgents = new Map<string, LoadedAgent>()

/**
 * 从 .turboflux/agents/ 加载动态代理定义，合并到注册表
 */
export function loadDynamicAgents(workspacePath: string): void {
  const loaded = loadAgentsFromDir(workspacePath)
  for (const agent of loaded) {
    dynamicAgents.set(agent.id, agent)
  }
}

/**
 * 运行时注册一个新代理（agent 自注册的基础）
 * 如果代理有关联的 skills，会自动注册到 SkillRuntime
 */
export function registerAgent(def: SubAgentDefinition, skillRuntime?: SkillRuntime): void {
  const loaded = def as LoadedAgent
  dynamicAgents.set(def.id, loaded)

  // 自动注册代理关联的 skills
  if (loaded.skills && loaded.skills.length > 0 && skillRuntime) {
    const agentSkills: LoadedSkill[] = loaded.skills.map(skillId => ({
      id: skillId,
      name: skillId,
      command: `/${skillId}`,
      description: `Skill registered by agent: ${def.id}`,
      category: 'custom' as const,
      systemPrompt: '',
      source: 'system' as const,
      filePath: `[agent:${def.id}]`,
      rawContent: '',
    }))
    skillRuntime.registerSkills(agentSkills)
  }
}

/**
 * 获取单个代理定义 — 先查动态，再查硬编码
 */
export function getSubAgentDefinition(type: string): SubAgentDefinition | undefined {
  return dynamicAgents.get(type) ?? DEFINITIONS[type]
}

/**
 * 获取所有代理定义（动态 + 硬编码），动态优先
 */
export function getAllAgentDefinitions(): SubAgentDefinition[] {
  const map = new Map<string, SubAgentDefinition>()
  for (const def of Object.values(DEFINITIONS)) {
    map.set(def.id, def)
  }
  for (const [id, def] of dynamicAgents) {
    map.set(id, def)
  }
  return [...map.values()]
}

/**
 * 获取所有可用的 agent type ID 列表
 */
export function getAvailableAgentTypes(): string[] {
  return getAllAgentDefinitions().map(d => d.id)
}

/**
 * 将所有动态代理关联的 skills 同步到 SkillRuntime
 * 在 SkillRuntime 初始化后调用一次即可
 */
export function syncAgentSkills(skillRuntime: SkillRuntime): void {
  for (const [, agent] of dynamicAgents) {
    const loaded = agent as LoadedAgent
    if (!loaded.skills || loaded.skills.length === 0) continue

    const agentSkills: LoadedSkill[] = loaded.skills.map(skillId => ({
      id: skillId,
      name: skillId,
      command: `/${skillId}`,
      description: `Skill registered by agent: ${agent.id}`,
      category: 'custom' as const,
      systemPrompt: '',
      source: 'system' as const,
      filePath: `[agent:${agent.id}]`,
      rawContent: '',
    }))
    skillRuntime.registerSkills(agentSkills)
  }
}

// ── 内置代理定义 ──────────────────────────────────────────────────

const DEFINITIONS: Record<string, SubAgentDefinition> = {
  fast_context: {
    id: 'fast_context',
    label: 'Fast Context',
    description: 'Fast issue-localization code map for large repositories. Use when you need ranked candidate files, roles, and evidence before deciding what to read.',
    driver: 'deepseek-flash',
    systemPrompt: FAST_CONTEXT_SYSTEM_PROMPT(),
    maxTurns: 3,
    maxParallel: 6,
    temperature: 0,
    thinking: 'disabled',
  },
  explorer: {
    id: 'explorer',
    label: 'Explorer',
    description: 'Deep multi-file investigation. Use for tracing call chains, understanding a feature end-to-end, or auditing a complex subsystem.',
    driver: 'deepseek-flash',
    systemPrompt: `You are a deep-dive code investigator. Trace call chains, read implementations, follow imports, and produce a grounded report with file:line citations.

Tools available: search_content, read_file, search_files.
Strategy:
1. Identify entry points via search_content.
2. Read implementations — follow function calls and imports across files.
3. Parallelize independent reads in the same turn.
4. Report findings as concrete file:line references with brief code excerpts.
Do NOT summarize from filenames alone. Every claim must come from code you read.`,
    maxTurns: 6,
    maxParallel: 6,
    thinking: 'disabled',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Code review for bugs, security issues, and design problems.',
    driver: 'deepseek-flash',
    systemPrompt: `You are a code reviewer. Read the relevant source files and identify bugs, security vulnerabilities, performance issues, and design problems.

Tools available: search_content, read_file, search_files.
For each finding, cite the exact file:line and quote the problematic code. Categorize as: bug / security / performance / design. Suggest a concrete fix.`,
    maxTurns: 5,
    maxParallel: 6,
    thinking: 'disabled',
  },
  git_inspector: {
    id: 'git_inspector',
    label: 'Git Inspector',
    description: 'Analyze recent git changes: what was modified, why, and what the diff shows.',
    driver: 'deepseek-flash',
    systemPrompt: `You analyze git history and diffs to explain recent changes.

Tools available: search_content, read_file, search_files.
Focus on: what changed, which files were affected, likely intent. Return a concise summary with file:line citations.`,
    maxTurns: 4,
    maxParallel: 4,
    thinking: 'disabled',
  },
}

function FAST_CONTEXT_SYSTEM_PROMPT(): string {
  return `You are FastContext, a code-map locator for large repositories. Your job is not to read broadly. Your job is to identify the smallest ranked set of files and line ranges that are likely to locate the issue, entry point, or root cause.

Tools: search_content(pattern, path?), read_file(path, offset?, limit?), search_files(pattern)

Strategy:
1. Extract identifiers, error text, feature names, file hints, and UI/API labels from the objective.
2. Map likely entry points first: routes, IPC handlers, commands, components, server endpoints, model/config boundaries.
3. Search multiple high-signal patterns in parallel. Prefer exact strings and symbols over generic words.
4. Read only the top candidate slices to confirm role and exact line ranges.
5. Return evidence that can become a ranked code map: entry, implementation, caller, config, schema, test, or suspected root_cause.

Rules:
- Never describe files you have not read.
- Prioritize source, entry, schema/config, and failing-path files over README-style context.
- Prefer narrow, targeted reads (offset+limit) over full-file reads.
- Avoid dumping many related files. Five strong candidates beat twenty weak ones.
- Do NOT expose hidden reasoning. Call tools and return concise, evidence-backed findings.`
}

export interface RunSubAgentOptions {
  definition: SubAgentDefinition
  objective: string
  workspacePath: string
  toolExecutor: ToolExecutor
  apiKey: string
  baseUrl: string
  model?: string
  codemap?: string | null
  abortSignal?: AbortSignal
  onEvent?: (event: SubAgentEvent) => void
}

export interface SubAgentResult {
  ok: boolean
  turns: number
  elapsedMs: number
  finalText?: string
  error?: string
  truncated?: boolean
}

interface ToolCallRequest {
  id: string
  function: { name: string; arguments: string }
}

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { definition, objective, workspacePath, toolExecutor, apiKey, baseUrl, model, codemap, abortSignal, onEvent } = options
  const startedAt = Date.now()
  const emit = (event: SubAgentEvent) => onEvent?.(event)

  const messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string }> = []

  messages.push({ role: 'system', content: definition.systemPrompt })

  if (codemap) {
    messages.push({ role: 'user', content: `Workspace structure:\n${codemap}` })
    messages.push({ role: 'assistant', content: 'READY' })
  }

  messages.push({ role: 'user', content: `Objective: ${objective}\n\nBuild a ranked code map: likely entry points, implementations, callers/config/schema, and suspected root-cause evidence. Be fast and precise.` })

  const tools = [
    {
      type: 'function',
      function: {
        name: 'search_content',
        description: 'Grep for a regex pattern across the codebase',
        parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file or a slice of it',
        parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Find files by glob pattern',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      },
    },
  ]

  const modelId = model || 'deepseek-v4-flash'
  let turn = 0

  while (turn < definition.maxTurns) {
    if (abortSignal?.aborted) break
    turn++
    emit({ type: 'turn_start', turn, maxTurns: definition.maxTurns })

    let response: any
    try {
      const body = JSON.stringify({
        model: modelId,
        messages,
        tools,
        temperature: definition.temperature ?? 0,
        max_tokens: definition.maxOutputTokens || 4096,
        stream: false,
      })

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body,
        signal: abortSignal,
      })

      if (!res.ok) {
        const errText = await res.text()
        emit({ type: 'error', message: `API ${res.status}: ${errText.slice(0, 200)}` })
        return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: `API error: ${res.status}` }
      }

      response = await res.json()
    } catch (e: any) {
      if (e.name === 'AbortError') return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: 'Aborted' }
      emit({ type: 'error', message: e.message })
      return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: e.message }
    }

    const choice = response.choices?.[0]
    if (!choice) {
      return { ok: false, turns: turn, elapsedMs: Date.now() - startedAt, error: 'No response choice' }
    }

    const msg = choice.message
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      emit({ type: 'final', text: msg.content || '' })
      emit({ type: 'turn_complete', turn, calls: 0 })
      return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, finalText: msg.content }
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })

    const toolCalls = msg.tool_calls as ToolCallRequest[]
    let callCount = 0

    for (const tc of toolCalls.slice(0, definition.maxParallel)) {
      if (abortSignal?.aborted) break
      callCount++

      let args: Record<string, any> = {}
      try { args = JSON.parse(tc.function.arguments) } catch {}

      emit({ type: 'tool_call', tool: tc.function.name, args, turn })

      const result = await executeSubAgentTool(tc.function.name, args, workspacePath, toolExecutor)

      emit({ type: 'tool_result', tool: tc.function.name, ok: result.ok, summary: result.summary, turn })

      for (const ev of result.evidence) {
        emit({ type: 'evidence', evidence: ev })
      }

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result.output })
    }

    emit({ type: 'turn_complete', turn, calls: callCount })
  }

  return { ok: true, turns: turn, elapsedMs: Date.now() - startedAt, truncated: turn >= definition.maxTurns }
}

interface ToolExecResult {
  ok: boolean
  output: string
  summary: string
  evidence: SubAgentEvidence[]
}

async function executeSubAgentTool(name: string, args: Record<string, any>, workspacePath: string, executor: ToolExecutor): Promise<ToolExecResult> {
  const evidence: SubAgentEvidence[] = []

  switch (name) {
    case 'search_content': {
      const pattern = args.pattern || ''
      const basePath = args.path ? `${workspacePath}/${args.path}` : workspacePath
      const res = await executor.searchContent(pattern, basePath, undefined, true)
      if (!res.success || !res.data || res.data.length === 0) {
        return { ok: true, output: 'No matches found.', summary: `grep "${pattern}" → 0 hits`, evidence }
      }
      const hits = res.data.slice(0, 15)
      const lines: string[] = []
      for (const hit of hits) {
        const relPath = hit.file.replace(workspacePath, '').replace(/^[\\/]/, '').replace(/\\/g, '/')
        lines.push(`${relPath}:${hit.line}: ${hit.text}`)
        evidence.push({
          path: relPath,
          startLine: Math.max(1, hit.line - 2),
          endLine: hit.line + 2,
          preview: hit.text,
          reason: `grep: ${pattern}`,
        })
      }
      return { ok: true, output: lines.join('\n'), summary: `grep "${pattern}" → ${hits.length} hits`, evidence }
    }

    case 'read_file': {
      const filePath = `${workspacePath}/${args.path}`
      const res = await executor.readFile(filePath)
      if (!res.success || !res.data) {
        return { ok: false, output: `File not found: ${args.path}`, summary: `read ${args.path} → not found`, evidence }
      }
      const allLines = res.data.split('\n')
      const offset = (args.offset || 1) - 1
      const limit = args.limit || 60
      const slice = allLines.slice(offset, offset + limit)
      const preview = slice.slice(0, 10).join('\n')
      evidence.push({
        path: args.path,
        startLine: offset + 1,
        endLine: offset + slice.length,
        preview,
        reason: 'file read',
      })
      return { ok: true, output: slice.map((l, i) => `${offset + i + 1} | ${l}`).join('\n'), summary: `read ${args.path}:${offset + 1}-${offset + slice.length}`, evidence }
    }

    case 'search_files': {
      const pattern = args.pattern || '**/*.ts'
      const res = await executor.searchFiles(pattern, workspacePath)
      if (!res.success || !res.data?.matches?.length) {
        return { ok: true, output: 'No files found.', summary: `glob "${pattern}" → 0 files`, evidence }
      }
      const matches = res.data.matches.slice(0, 20)
      const relPaths = matches.map(m => m.replace(workspacePath, '').replace(/^[\\/]/, '').replace(/\\/g, '/'))
      return { ok: true, output: relPaths.join('\n'), summary: `glob "${pattern}" → ${matches.length} files`, evidence }
    }

    default:
      return { ok: false, output: `Unknown tool: ${name}`, summary: `unknown tool ${name}`, evidence }
  }
}
