import { describe, expect, it } from 'vitest'
import { getSharedCommand, SHARED_COMMAND_CATALOG } from './catalog'
import { SharedCommandRegistry } from './registry'

describe('shared command service', () => {
  it('parses aliases and completions independently from a UI', () => {
    const registry = new SharedCommandRegistry<{ name: string; aliases?: string[]; isHidden?: boolean }>()
    registry.register({ name: 'vibe', aliases: ['code'] })
    registry.register({ name: 'plan' })

    expect(registry.parse('/plan next')).toEqual({ name: 'plan', args: 'next' })
    expect(registry.get('code')?.name).toBe('vibe')
    expect(registry.getCompletions('/c').map(command => command.name)).toEqual(['vibe'])
  })

  it('shares core slash commands with desktop command identifiers', () => {
    expect(SHARED_COMMAND_CATALOG.map(command => command.name)).toEqual(expect.arrayContaining([
      'plan', 'vibe', 'git', 'compact', 'context', 'mcp', 'skills', 'flow',
    ]))
    expect(getSharedCommand('compact')).toMatchObject({ desktopId: 'context.compact' })
  })
})
