import { describe, expect, it } from 'vitest'
import { browserTools } from './browserTools'

describe('browser tool surface', () => {
  const tools = browserTools()

  it('advertises capability discovery and explicit tab lifecycle tools', () => {
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'capabilities',
      'mark_deliverable',
      'mark_handoff',
    ]))
    expect(tools.find(tool => tool.name === 'capabilities')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find(tool => tool.name === 'mark_deliverable')?.annotations?.openWorldHint).toBe(false)
  })

  it('keeps layout selection independent from browser navigation', () => {
    const layout = tools.find(tool => tool.name === 'set_layout')
    expect(layout?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false })
    expect(layout?.inputSchema.properties?.mode).toMatchObject({ enum: ['portrait', 'landscape'] })
  })
})
