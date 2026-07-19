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

  it('guides broad code location through explore_code without fixed triggers', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('explore_code')
    expect(prompt).toContain('Do not rely on fixed trigger words')
    expect(prompt).toContain('for simple directed searches, use search_content/search_files/search_symbols directly')
  })

  it('guides current and external facts through web_search', () => {
    const prompt = buildSystemPrompt('vibe')

    expect(prompt).toContain('web_search')
    expect(prompt).toContain('current or external facts')
  })

  it('treats the configured workspace as authoritative', () => {
    const prompt = buildSystemPrompt('vibe', {
      workspacePath: 'C:\\Users\\Administrator',
      workspaceName: 'Administrator',
    })

    expect(prompt).toContain('This path is the authoritative current workspace')
    expect(prompt).toContain('Historical mentions of other projects do not change it')
    expect(prompt).toContain('without supporting tool output')
  })
})
