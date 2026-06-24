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

  it('moves the diagonal shimmer between frames', () => {
    const first = flattenFrame(32, 1)
    const second = flattenFrame(32, 5)

    expect(first).not.toBe(second)
    expect(second).toContain('/')
  })

  it('returns no segments for zero width terminals', () => {
    expect(buildAgentActivityLineFrame(0, 10)).toEqual([])
  })
})
