import { describe, expect, it } from 'vitest'
import { buildAgentActivityLineFrame } from './AgentActivityLine'

function flattenFrame(width: number, frame: number): string {
  return buildAgentActivityLineFrame(width, frame).map(segment => segment.text).join('')
}

describe('AgentActivityLine', () => {
  it('fills exactly one terminal row', () => {
    const line = flattenFrame(48, 3)

    expect(line).toHaveLength(48)
  })

  it('keeps the activity line visually quiet while the highlight moves', () => {
    const first = buildAgentActivityLineFrame(32, 1)
    const second = buildAgentActivityLineFrame(32, 5)
    const firstLine = first.map(segment => segment.text).join('')
    const secondLine = second.map(segment => segment.text).join('')

    expect(firstLine).toBe('-'.repeat(32))
    expect(secondLine).toBe('-'.repeat(32))
    expect(first.map(segment => segment.color).join('|')).not.toBe(second.map(segment => segment.color).join('|'))
  })

  it('returns no segments for zero width terminals', () => {
    expect(buildAgentActivityLineFrame(0, 10)).toEqual([])
  })
})
