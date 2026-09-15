import { describe, expect, it } from 'vitest'
import { fallbackTaskTitle, taskDisplayTitle } from './conversationPolicy'

describe('desktop conversation title policy', () => {
  const prompt = '<automation_objective>\nGoal: Review the release evidence\nSuccess criteria:\n- Record it\n</automation_objective>'

  it('keeps internal automation markup out of list titles', () => {
    expect(taskDisplayTitle({ title: prompt, titleSource: 'generated', turnCount: 1 })).toBe('Review the release evidence')
    expect(fallbackTaskTitle(prompt)).toBe('Review the release evidence')
  })

  it('does not reinterpret an explicit custom title', () => {
    expect(taskDisplayTitle({ title: 'Custom <automation_objective> title', titleSource: 'custom', turnCount: 1 }))
      .toBe('Custom <automation_objective> title')
  })
})
