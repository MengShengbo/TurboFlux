import { describe, expect, it } from 'vitest'
import { buildAgentActivityLineFrame } from './AgentActivityLine'

describe('AgentActivityLine', () => {
  it('renders the July cockpit blue-cyan activity sweep', () => {
    const segments = buildAgentActivityLineFrame(80, 10)
    const colors = segments.map(segment => segment.color)

    expect(segments.map(segment => segment.text).join('')).toHaveLength(80)
    expect(colors).toContain('#075985')
    expect(colors).toContain('#67e8f9')
    expect(segments.some(segment => segment.bold)).toBe(true)
  })
})
