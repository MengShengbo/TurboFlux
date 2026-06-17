import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './systemPrompt'

describe('buildSystemPrompt', () => {
  it('injects the TurboFlux profile section when provided', () => {
    const prompt = buildSystemPrompt('vibe', {
      profileSystemPrompt: '<turboflux_profile>profile rules</turboflux_profile>',
    })

    expect(prompt).toContain('<turboflux_profile>profile rules</turboflux_profile>')
    expect(prompt).toContain('<identity>')
  })
})
