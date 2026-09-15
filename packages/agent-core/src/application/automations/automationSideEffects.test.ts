import { describe, expect, it } from 'vitest'
import { automationToolEffectNeedsReview, classifyAutomationToolEffect, summarizeAutomationToolTarget } from './automationSideEffects'

describe('automation tool side-effect declarations', () => {
  it('classifies read, idempotent, reversible, non-idempotent and unknown tools', () => {
    expect(classifyAutomationToolEffect('read_file', { path: 'a' })).toEqual({ classification: 'read_only' })
    expect(classifyAutomationToolEffect('write_file', { path: 'a', content: 'b' })).toMatchObject({
      classification: 'idempotent_write',
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(classifyAutomationToolEffect('git_stash', {})).toMatchObject({ classification: 'reversible_write' })
    expect(classifyAutomationToolEffect('git_commit', { message: 'ship' })).toEqual({ classification: 'non_idempotent_write' })
    expect(classifyAutomationToolEffect('mcp__send_payment', { amount: 1 })).toEqual({ classification: 'unknown_external_effect' })
  })

  it('uses explicit MCP hints and identifies uncertain effects that require review', () => {
    expect(classifyAutomationToolEffect('mcp__lookup', {}, { readOnlyHint: true })).toEqual({ classification: 'read_only' })
    expect(classifyAutomationToolEffect('mcp__upsert', { id: 1 }, { idempotentHint: true })).toMatchObject({ classification: 'idempotent_write' })
    expect(automationToolEffectNeedsReview('idempotent_write')).toBe(false)
    expect(automationToolEffectNeedsReview('non_idempotent_write')).toBe(true)
    expect(automationToolEffectNeedsReview('unknown_external_effect')).toBe(true)
  })

  it('summarizes targets without retaining URL credentials or query secrets', () => {
    expect(summarizeAutomationToolTarget({ path: '/workspace/report.md' })).toBe('/workspace/report.md')
    expect(summarizeAutomationToolTarget({ url: 'https://user:password@example.test/report?token=secret#private' }))
      .toBe('https://example.test/report')
    expect(summarizeAutomationToolTarget({ content: 'secret document body' })).toBeUndefined()
  })
})
