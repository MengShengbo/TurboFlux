import type { Command, CommandContext, CommandResult } from './types'
import type { SkillRuntime } from '../../core/skills/runtime'

class CommandRegistry {
  private commands: Map<string, Command> = new Map()
  private aliases: Map<string, string> = new Map()

  register(command: Command): void {
    this.commands.set(command.name, command)
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.set(alias, command.name)
      }
    }
  }

  get(name: string): Command | undefined {
    return this.commands.get(name) || this.commands.get(this.aliases.get(name) || '')
  }

  isCommand(input: string): boolean {
    return input.startsWith('/')
  }

  parse(input: string): { name: string; args: string } | null {
    if (!this.isCommand(input)) return null
    const trimmed = input.slice(1)
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) return { name: trimmed, args: '' }
    return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }
  }

  execute(input: string, ctx: CommandContext): CommandResult {
    const parsed = this.parse(input)
    if (!parsed) return { type: 'none' }

    const command = this.get(parsed.name)
    if (!command) {
      return { type: 'text', text: `Unknown command: /${parsed.name}. Type /help for available commands.` }
    }

    switch (command.type) {
      case 'local': {
        const result = command.execute(parsed.args, ctx)
        if (result) return { type: 'text', text: result }
        return { type: 'none' }
      }
      case 'local-jsx': {
        const jsx = command.execute(parsed.args, ctx)
        return { type: 'jsx', jsx }
      }
      case 'prompt': {
        const prompt = command.getPrompt(parsed.args, ctx)
        return { type: 'prompt', prompt }
      }
    }
  }

  getCompletions(partial: string): Command[] {
    if (!partial.startsWith('/')) return []
    const query = partial.slice(1).toLowerCase()
    const results: Command[] = []
    for (const cmd of this.commands.values()) {
      if (cmd.isHidden) continue
      if (cmd.name.startsWith(query)) results.push(cmd)
    }
    for (const [alias, name] of this.aliases) {
      if (alias.startsWith(query)) {
        const cmd = this.commands.get(name)
        if (cmd && !cmd.isHidden && !results.includes(cmd)) results.push(cmd)
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  listAll(): Command[] {
    return [...this.commands.values()]
      .filter(c => !c.isHidden)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  registerSkills(skillRuntime: SkillRuntime): void {
    for (const skill of skillRuntime.getAll()) {
      const cmdName = skill.command.replace(/^\//, '')
      if (this.commands.has(cmdName)) continue
      this.register({
        name: cmdName,
        description: skill.description || `Skill: ${skill.name}`,
        type: 'prompt',
        getPrompt: (args, ctx) => {
          const prompt = ctx.skillRuntime?.getSkillPrompt(skill.id) || `Run skill: ${skill.name}`
          return args ? `${prompt}\n\nArguments: ${args}` : prompt
        },
      })
    }
  }
}

export const commandRegistry = new CommandRegistry()
