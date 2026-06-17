import { describe, expect, it } from 'vitest'
import {
  buildProfileSystemPromptSection,
  normalizeProfile,
} from './profile'

describe('TurboFlux profile', () => {
  it('normalizes invalid persona selections to a usable default', () => {
    const profile = normalizeProfile({
      interfaceLanguage: 'zh-CN',
      aiOutputLanguage: 'zh-CN',
      enabledPersonaIds: ['unknown'],
      defaultPersonaId: 'missing-style',
    })

    expect(profile.enabledPersonaIds).toContain('engineer-professional')
    expect(profile.defaultPersonaId).toBe('engineer-professional')
  })

  it('builds an effective prompt section from output language and persona', () => {
    const section = buildProfileSystemPromptSection({
      aiOutputLanguage: 'zh-CN',
      defaultPersonaId: 'architect',
      enabledPersonaIds: ['architect'],
      customInstructions: 'Prefer release-ready answers.',
    })

    expect(section).toContain('<turboflux_profile>')
    expect(section).toContain('Respond in Simplified Chinese')
    expect(section).toContain('id="architect"')
    expect(section).toContain('Prefer release-ready answers.')
  })

  it('uses custom persona text only when configured', () => {
    const section = buildProfileSystemPromptSection({
      defaultPersonaId: 'custom',
      customPersonaName: 'Strict Reviewer',
      customPersonaPrompt: 'Review every claim carefully.',
    })

    expect(section).toContain('name="Strict Reviewer"')
    expect(section).toContain('Review every claim carefully.')
  })
})
