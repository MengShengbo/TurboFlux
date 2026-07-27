import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThinkingBlock } from './ThinkingBlock'

describe('ThinkingBlock', () => {
  const trace = {
    content: 'Inspect architecture, then verify the failing path.',
    status: 'complete' as const,
    durationMs: 4200,
    tokenCount: 128,
    effort: 'high' as const,
  }

  it('keeps completed reasoning private while collapsed', () => {
    const output = renderToString(<ThinkingBlock trace={trace} expanded={false} />, { columns: 88 })

    expect(output).toContain('Thought · high · 4.2s · 128 tokens')
    expect(output).not.toContain('Inspect architecture')
  })

  it('shows complete reasoning content when expanded', () => {
    const output = renderToString(<ThinkingBlock trace={trace} expanded />, { columns: 88 })

    expect(output).toContain('Inspect architecture')
    expect(output).toContain('▾')
  })

  it('bounds the streaming preview to the latest reasoning', () => {
    const longContent = `BEGIN-${'x'.repeat(2200)}-END`
    const expanded = renderToString(
      <ThinkingBlock
        trace={{ ...trace, content: longContent, status: 'streaming' }}
        expanded
        streaming
        lastActivity={Date.now()}
      />,
      { columns: 88 },
    )

    expect(expanded).not.toContain('BEGIN-')
    expect(expanded).toContain('-END')
    expect(expanded.length).toBeLessThan(1600)
  })

  it('shows an active timer before the provider emits reasoning text', () => {
    const output = renderToString(
      <ThinkingBlock
        trace={{ content: '', status: 'streaming', startedAt: Date.now() - 1200, effort: 'high' }}
        expanded
        streaming
      />,
      { columns: 88 },
    )

    expect(output).toContain('Reasoning · high')
    expect(output).not.toContain('▾')
  })
})
