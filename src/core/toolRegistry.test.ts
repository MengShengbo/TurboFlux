import { describe, expect, it } from 'vitest'
import { getToolsForMode } from './toolRegistry'

describe('tool mode boundaries', () => {
  it('exposes only read-only tools in plan mode', () => {
    const tools = getToolsForMode('plan')

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every(tool => tool.isReadOnly)).toBe(true)
    expect(tools.some(tool => tool.name === 'run_command')).toBe(false)
    expect(tools.some(tool => tool.name === 'write_file')).toBe(false)
  })
})
