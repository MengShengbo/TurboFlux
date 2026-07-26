import { describe, expect, it } from 'vitest'
import { buildAgentActivityLineFrame } from './AgentActivityLine'
import { TURBOFLUX_ACCENTS } from '../../theme/palette'

describe('AgentActivityLine', () => {
  it('renders the green-cyan brand activity sweep', () => {
    const segments = buildAgentActivityLineFrame(80, 10)
    const colors = segments.map(segment => segment.color)

    expect(segments.map(segment => segment.text).join('')).toHaveLength(80)
    expect(colors).toContain(TURBOFLUX_ACCENTS.cyanDeep)
    expect(colors).toContain(TURBOFLUX_ACCENTS.neonGreen)
    expect(segments.some(segment => segment.bold)).toBe(true)
  })
})
