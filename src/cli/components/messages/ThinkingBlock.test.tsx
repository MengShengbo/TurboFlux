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

  it('keeps completed reasoning folded by default', () => {
    const output = renderToString(<ThinkingBlock trace={trace} expanded={false} />, { columns: 88 })

    expect(output).toContain('Thought · high · 4.2s · 128 tokens')
    expect(output).not.toContain('Inspect architecture')
  })

  it('shows reasoning content when expanded', () => {
    const output = renderToString(<ThinkingBlock trace={trace} expanded />, { columns: 88 })

    expect(output).toContain('Inspect architecture')
    expect(output).toContain('▾')
  })
})
