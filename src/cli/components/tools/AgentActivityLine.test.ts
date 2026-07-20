import { describe, expect, it } from 'vitest'
import { buildAgentActivityLineFrame } from './AgentActivityLine'

describe('AgentActivityLine', () => {
  it('uses caller-provided theme colors while preserving line width', () => {
    const segments = buildAgentActivityLineFrame(48, 9, {
      base: '#base',
      sweep: ['#one', '#two', '#three', '#core', '#five', '#six', '#seven'],
    })

    expect(segments.map(segment => segment.text).join('')).toHaveLength(48)
    expect(segments.some(segment => segment.color === '#base')).toBe(true)
    expect(segments.some(segment => segment.color === '#core' && segment.bold)).toBe(true)
  })
})
