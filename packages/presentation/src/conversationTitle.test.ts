import { describe, expect, it } from 'vitest'
import { generatedConversationTitle, normalizeConversationTitleText } from './conversationTitle'

describe('conversation title generation', () => {
  it('extracts a user-facing goal from an automation execution prompt', () => {
    expect(generatedConversationTitle([
      '<automation_objective>',
      'Goal: Review the latest release evidence',
      'Success criteria:',
      '- Record a review result',
      '</automation_objective>',
    ].join('\n'))).toBe('Review the latest release evidence')
  })

  it('cleans legacy single-line automation titles', () => {
    expect(generatedConversationTitle(
      '<automation_objective> Goal: Publish daily summary Success criteria: - Delivered </automation_objective>',
    )).toBe('Publish daily summary')
  })

  it('does not expose malformed internal prompt envelopes', () => {
    expect(generatedConversationTitle('<automation_recovery> Continue checkpoint 4')).toBe('')
  })

  it('preserves ordinary and custom title normalization', () => {
    expect(generatedConversationTitle('  Plan\nnext release  ')).toBe('Plan next release')
    expect(normalizeConversationTitleText('  Custom <automation_objective> title  ')).toBe('Custom <automation_objective> title')
  })
})
