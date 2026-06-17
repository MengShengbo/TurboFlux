import type { Command, CommandContext } from './types'
import { commandRegistry } from './registry'
import { type TurboFluxConfig, getPresetByIdOrModelFrom, applyPreset, setConfigValue } from '../../core/config'
import { existsSync, writeFileSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

// /exit
commandRegistry.register({
  name: 'exit',
  description: 'Exit TurboFlux',
  aliases: ['quit', 'q'],
  type: 'local',
  execute: (_args, ctx) => { ctx.exit() },
})

// /clear
commandRegistry.register({
  name: 'clear',
  description: 'Clear conversation history',
  type: 'local',
  execute: (_args, ctx) => {
    ctx.conversationManager?.startNew()
    ctx.engine.resetSession()
    ctx.setMessages([])
    return 'Conversation cleared.'
  },
})

// /help
commandRegistry.register({
  name: 'help',
  description: 'Show available commands',
  aliases: ['?'],
  type: 'local',
  execute: () => {
    const commands = commandRegistry.listAll()
    const lines = commands.map(c => {
      const hint = c.argumentHint ? ` ${c.argumentHint}` : ''
      const aliases = c.aliases?.length ? ` (${c.aliases.map(a => '/' + a).join(', ')})` : ''
      return `  /${c.name}${hint}${aliases} - ${c.description}`
    })
    return 'Available commands:\n' + lines.join('\n')
  },
})

// /config
commandRegistry.register({
  name: 'config',
  description: 'View or set configuration',
  argumentHint: '[key] [value]',
  type: 'local',
  execute: (args, ctx) => {
    if (!args) {
      const safe = { ...ctx.config, apiKey: ctx.config.apiKey ? '***' : '(not set)' }
      return 'Current config:\n' + Object.entries(safe).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    }
    const parts = args.split(/\s+/)
    if (parts.length < 2) {
      const key = parts[0] as keyof TurboFluxConfig
      const val = ctx.config[key]
      return `${key} = ${key === 'apiKey' ? '***' : val}`
    }
    const [key, ...rest] = parts
    const val = rest.join(' ')
    try {
      const updated = setConfigValue(ctx.config, key, val)
      ctx.setConfig(updated)
      return `Set ${key} = ${key === 'apiKey' ? '***' : String((updated as any)[key])}`
    } catch (error) {
      return `Config error: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

// /setup
commandRegistry.register({
  name: 'setup',
  description: 'Show setup command for provider, language, and persona configuration',
  type: 'local',
  execute: () => {
    return [
      'Run this outside the TurboFlux session:',
      '',
      '  turboflux setup',
      '  turboflux setup init',
      '  turboflux setup api',
      '  turboflux setup language',
      '  turboflux setup persona',
      '  turboflux setup show',
      '',
      'Examples:',
      '  turboflux setup init --provider openai --api-key <key> --model gpt-5.5 --yes',
      '  turboflux setup api --provider deepseek --api-key <key>',
      '  turboflux setup language --all-lang zh-CN --yes',
      '  turboflux setup persona --output-style all --default-output-style engineer-professional --yes',
      '  turboflux setup --provider local-proxy --yes',
    ].join('\n')
  },
})

// /model
commandRegistry.register({
  name: 'model',
  description: 'Switch model (flash/pro or custom model name)',
  argumentHint: '[flash|pro|model-name]',
  type: 'local',
  execute: (args, ctx) => {
    if (!args) {
      const presetLines = ctx.modelPresets.map(p => {
        const active = ctx.config.model === p.model ? ' *' : ''
        return `  ${p.id.padEnd(8)} ${p.name.padEnd(20)} ${p.description}${active}`
      })
      return `Current: ${ctx.config.model}\n\nAvailable presets:\n${presetLines.join('\n')}\n\nUsage: /model <flash|pro|custom-model-name>`
    }
    const input = args.trim()
    const preset = getPresetByIdOrModelFrom(ctx.modelPresets, input)
    if (preset) {
      const updated = applyPreset(ctx.config, preset)
      ctx.setConfig(updated)
      return `Switched to ${preset.name} (${preset.model})`
    }
    const updated = { ...ctx.config, model: input }
    ctx.setConfig(updated)
    return `Model switched to: ${input}`
  },
})

// /plan
commandRegistry.register({
  name: 'plan',
  description: 'Switch to plan mode (read-only -> plan -> approve -> execute)',
  type: 'local',
  execute: (_args, ctx) => {
    ctx.engine.setMode('plan')
    return 'Switched to plan mode.'
  },
})

// /vibe
commandRegistry.register({
  name: 'vibe',
  description: 'Switch to vibe mode (full autonomous execution)',
  aliases: ['code'],
  type: 'local',
  execute: (_args, ctx) => {
    ctx.engine.setMode('vibe')
    return 'Switched to vibe mode.'
  },
})

// /git
commandRegistry.register({
  name: 'git',
  description: 'Toggle Git integration (on/off). Enables git-based checkpoints and injects git status into context.',
  type: 'local',
  execute: (args, ctx) => {
    const sub = args.trim().toLowerCase()
    if (sub === 'off' || sub === 'disable') {
      ctx.engine.setGitEnabled(false)
      return 'Git integration disabled. Checkpoints will use internal snapshots.'
    }
    if (sub === 'on' || sub === 'enable') {
      ctx.engine.setGitEnabled(true)
      return 'Git integration enabled. Checkpoints will use git commits.'
    }
    const current = ctx.engine.isGitEnabled()
    const next = !current
    ctx.engine.setGitEnabled(next)
    return `Git integration ${next ? 'enabled' : 'disabled'}.`
  },
})

// /compact
commandRegistry.register({
  name: 'compact',
  description: 'Compress conversation context to free up token budget',
  type: 'local',
  execute: (_args, ctx) => {
    ctx.engine.compactContext().catch(() => {})
    return 'Context compaction triggered.'
  },
})

// /fastcontext
commandRegistry.register({
  name: 'fastcontext',
  description: 'Run the FastContext subagent for quick broad code discovery',
  argumentHint: '<objective>',
  aliases: ['fc'],
  type: 'local',
  execute: (args, ctx) => {
    const objective = args.trim()
    if (!objective) return 'Usage: /fastcontext <what to find>'
    ctx.engine.runFastContextObjective(objective).catch(() => {})
    return `FastContext subagent started: ${objective}`
  },
})

// /context
commandRegistry.register({
  name: 'context',
  description: 'Show context window usage',
  type: 'local',
  execute: (_args, ctx) => {
    const tokens = ctx.engine.getContextUsage()
    const window = ctx.config.contextWindow
    if (tokens.source !== 'provider' || typeof tokens.input !== 'number') {
      return [
        `Context usage: unknown / ${window.toLocaleString()} tokens`,
        '  Waiting for provider-reported usage from the next model response.',
        '  Local character/token estimates are intentionally not used for this number.',
      ].join('\n')
    }
    const used = tokens.input
    const pct = Math.round((used / window) * 100)
    const bar = renderBar(pct, 30)
    return [
      `Context usage: ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${pct}%)`,
      bar,
      `  Last provider prompt_tokens: ${tokens.input.toLocaleString()}`,
      `  Last provider completion_tokens: ${(tokens.output ?? 0).toLocaleString()}`,
    ].join('\n')
  },
})

// /theme
commandRegistry.register({
  name: 'theme',
  description: 'Switch color theme',
  argumentHint: '[dark|light]',
  type: 'local',
  execute: (args) => {
    if (!args || !['dark', 'light'].includes(args.trim())) {
      return 'Usage: /theme <dark|light>'
    }
    return `Theme switched to: ${args.trim()} (will apply on next render)`
  },
})

// /thinking
commandRegistry.register({
  name: 'thinking',
  description: 'Set thinking mode',
  argumentHint: '[auto|off|standard|max]',
  type: 'local',
  execute: (args, ctx) => {
    const modes = ['auto', 'off', 'standard', 'max'] as const
    const mode = args.trim() as typeof modes[number]
    if (!modes.includes(mode)) {
      return `Usage: /thinking <${modes.join('|')}>\nCurrent: ${ctx.engine.getThinkingMode()}`
    }
    ctx.engine.setThinkingMode(mode)
    return `Thinking mode set to: ${mode}`
  },
})

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  const bar = '#'.repeat(filled) + '-'.repeat(empty)
  return `  [${bar}]`
}

// /mcp
commandRegistry.register({
  name: 'mcp',
  description: 'Show MCP server status and tools',
  argumentHint: '[status|tools]',
  type: 'local',
  execute: (args, ctx) => {
    if (!ctx.mcpClient) return 'MCP not initialized. Configure servers in .turboflux/settings.json'
    const connections = ctx.mcpClient.getAllConnections()
    if (connections.length === 0) return 'No MCP servers configured.'

    if (args === 'tools') {
      const tools = ctx.mcpClient.getAllTools()
      if (tools.length === 0) return 'No MCP tools available.'
      const lines = tools.map(t => `  ${t.name} - ${t.description.slice(0, 60)}`)
      return `MCP tools (${tools.length}):\n${lines.join('\n')}`
    }

    const lines = connections.map(c => {
      const status = c.status === 'connected' ? 'ok' : c.status === 'error' ? 'error' : 'pending'
      const toolCount = c.tools.length
      const err = c.error ? ` (${c.error})` : ''
      return `  ${status} ${c.name} - ${c.status}, ${toolCount} tools${err}`
    })
    return `MCP servers (${connections.length}):\n${lines.join('\n')}\n\nUse /mcp tools to list all available tools.`
  },
})

// /skills
commandRegistry.register({
  name: 'skills',
  description: 'List available skills',
  type: 'local',
  execute: (_args, ctx) => {
    if (!ctx.skillRuntime) return 'Skill runtime not available.'
    const skills = ctx.skillRuntime.getAll()
    if (skills.length === 0) return 'No skills found.\nPlace SKILL.md files in .turboflux/skills/<name>/ or ~/.turboflux/skills/<name>/'
    const active = ctx.skillRuntime.getActiveSkillId()
    const lines = skills.map(s => {
      const marker = s.id === active ? ' * active' : ''
      return `  ${s.command} - ${s.description}${marker}`
    })
    return `Available skills (${skills.length}):\n${lines.join('\n')}`
  },
})

// /new
commandRegistry.register({
  name: 'new',
  description: 'Start a new conversation',
  type: 'local',
  execute: (_args, ctx) => {
    if (!ctx.conversationManager) return 'Conversation manager not available.'
    ctx.conversationManager.startNew()
    ctx.engine.resetSession()
    ctx.setMessages([])
    return 'Started new conversation.'
  },
})

// /list
commandRegistry.register({
  name: 'list',
  description: 'List saved conversations',
  aliases: ['conversations'],
  type: 'local',
  execute: (_args, ctx) => {
    if (!ctx.conversationManager) return 'Conversation manager not available.'
    const convs = ctx.conversationManager.list()
    if (convs.length === 0) return 'No saved conversations.'
    const lines = convs.slice(0, 20).map((c, i) => {
      const date = new Date(c.updatedAt).toLocaleString()
      const current = c.id === ctx.conversationManager!.getCurrentId() ? ' *' : ''
      return `  ${i + 1}. ${c.title} (${c.turnCount} turns, ${date})${current}\n     ID: ${c.id}`
    })
    return `Conversations (${convs.length} total):\n${lines.join('\n')}`
  },
})

// /resume
commandRegistry.register({
  name: 'resume',
  description: 'Open saved conversations and resume one',
  type: 'local',
  execute: () => {
    return ''
  },
})

// /init
commandRegistry.register({
  name: 'init',
  description: 'Show TURBOFLUX.md project instruction status',
  isHidden: true,
  type: 'local',
  execute: (_args, ctx) => {
    const wsPath = ctx.workspacePath || process.cwd()
    const targetPath = join(wsPath, 'TURBOFLUX.md')

    if (existsSync(targetPath)) {
      return `TURBOFLUX.md is already active at ${targetPath}. TurboFlux loads it automatically.`
    }

    ensureProjectInstructions(wsPath)
    return `Created TURBOFLUX.md at ${targetPath}. TurboFlux will load it automatically.`
  },
})

export function ensureProjectInstructions(wsPath: string): string | null {
  const targetPath = join(wsPath, 'TURBOFLUX.md')
  if (existsSync(targetPath)) return null

  const projectName = wsPath.split(/[\\/]/).pop() || 'my-project'
  const techStack = detectTechStack(wsPath)
  const structure = scanTopLevel(wsPath)

  const template = `# ${projectName}

## Project Overview

<!-- Describe what this project does -->

## Tech Stack

${techStack}

## Directory Structure

${structure}

## Coding Rules

- <!-- Add coding conventions here -->

## Architecture Decisions

- <!-- Document key design decisions -->

## Known Pitfalls

- <!-- Things to watch out for -->
`
  writeFileSync(targetPath, template, 'utf-8')
  return targetPath
}

function detectTechStack(wsPath: string): string {
  const indicators: string[] = []
  const has = (f: string) => existsSync(join(wsPath, f))

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(wsPath, 'package.json'), 'utf-8'))
      if (pkg.dependencies?.react || pkg.devDependencies?.react) indicators.push('React')
      if (pkg.dependencies?.vue || pkg.devDependencies?.vue) indicators.push('Vue')
      if (pkg.dependencies?.next) indicators.push('Next.js')
      if (pkg.dependencies?.express || pkg.dependencies?.hono) indicators.push('Node.js Server')
      if (pkg.devDependencies?.typescript) indicators.push('TypeScript')
      if (pkg.devDependencies?.vitest) indicators.push('Vitest')
      if (pkg.devDependencies?.tsx) indicators.push('TSX')
    } catch {}
  }
  if (has('Cargo.toml')) indicators.push('Rust')
  if (has('go.mod')) indicators.push('Go')
  if (has('pom.xml') || has('build.gradle')) indicators.push('Java')
  if (has('requirements.txt') || has('pyproject.toml')) indicators.push('Python')
  if (has('tsconfig.json')) indicators.push('TypeScript')

  if (indicators.length === 0) return '- <!-- Detected: unknown -->'
  return indicators.map(t => `- ${t}`).join('\n')
}

function scanTopLevel(wsPath: string): string {
  try {
    const entries = readdirSync(wsPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
      .slice(0, 15)
    const lines = entries.map(e => {
      const suffix = e.isDirectory() ? '/' : ''
      return `- ${e.name}${suffix}`
    })
    return lines.join('\n') || '- <!-- empty -->'
  } catch {
    return '- <!-- could not scan -->'
  }
}

export { commandRegistry }
