import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { StatusLine } from './StatusLine'

describe('StatusLine', () => {
  it('shows native reasoning and approval settings without a TurboFlux thinking mode', () => {
    const output = renderToString(
      <StatusLine
        config={{
          provider: 'openai',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.6',
          contextWindow: 1_050_000,
          maxTokens: 16_384,
          reasoning: { effort: 'xhigh' },
          approvalPolicy: 'agent',
        }}
        tokenUsage={{ source: 'unknown' }}
      />,
      { columns: 120 },
    )

    expect(output).toContain('reason:xhigh')
    expect(output).toContain('approval:agent')
    expect(output).not.toContain('think:')
  })
})
