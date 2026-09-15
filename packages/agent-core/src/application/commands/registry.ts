export interface SharedCommandDescriptor {
  name: string
  aliases?: string[]
  isHidden?: boolean
}

export interface ParsedSharedCommand {
  name: string
  args: string
}

export class SharedCommandRegistry<TCommand extends SharedCommandDescriptor> {
  protected readonly commands = new Map<string, TCommand>()
  protected readonly aliases = new Map<string, string>()

  register(command: TCommand): void {
    this.commands.set(command.name, command)
    for (const alias of command.aliases || []) this.aliases.set(alias, command.name)
  }

  get(name: string): TCommand | undefined {
    return this.commands.get(name) || this.commands.get(this.aliases.get(name) || '')
  }

  has(name: string): boolean {
    return this.commands.has(name)
  }

  isCommand(input: string): boolean {
    return input.startsWith('/')
  }

  parse(input: string): ParsedSharedCommand | null {
    if (!this.isCommand(input)) return null
    const trimmed = input.slice(1)
    const spaceIndex = trimmed.indexOf(' ')
    if (spaceIndex === -1) return { name: trimmed, args: '' }
    return { name: trimmed.slice(0, spaceIndex), args: trimmed.slice(spaceIndex + 1).trim() }
  }

  getCompletions(partial: string): TCommand[] {
    if (!partial.startsWith('/')) return []
    const query = partial.slice(1).toLowerCase()
    const results: TCommand[] = []
    for (const command of this.commands.values()) {
      if (!command.isHidden && command.name.startsWith(query)) results.push(command)
    }
    for (const [alias, name] of this.aliases) {
      if (!alias.startsWith(query)) continue
      const command = this.commands.get(name)
      if (command && !command.isHidden && !results.includes(command)) results.push(command)
    }
    return results.sort((left, right) => left.name.localeCompare(right.name))
  }

  listAll(): TCommand[] {
    return [...this.commands.values()]
      .filter(command => !command.isHidden)
      .sort((left, right) => left.name.localeCompare(right.name))
  }
}
