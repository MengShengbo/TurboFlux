import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { StatusLine } from './StatusLine'

function renderStatus(element: React.ReactElement, columns: number): string {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
  try {
    return renderToString(element, { columns })
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor)
    else delete (process.stdout as { columns?: number }).columns
  }
}

describe('StatusLine', () => {
  it('shows native reasoning and approval settings without a TurboFlux thinking mode', () => {
    const output = renderStatus(
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
          gitEnabled: true,
        }}
        tokenUsage={{ source: 'unknown' }}
      />,
      120,
    )

    expect(output).toContain('reason:xhigh')
    expect(output).toContain('approval:agent')
    expect(output).not.toContain('think:')
  })

  it('keeps primary state on one line in a narrow terminal', () => {
    const output = renderStatus(
      <StatusLine
        config={{
          provider: 'anthropic',
          apiKey: 'test',
          baseUrl: 'https://example.com/v1',
          model: 'claude-sonnet-5-with-a-very-long-provider-alias',
          contextWindow: 200_000,
          maxTokens: 16_384,
          reasoning: { effort: 'high' },
          approvalPolicy: 'agent',
          gitEnabled: true,
        }}
        tokenUsage={{ source: 'unknown' }}
        gitState={{ enabled: true, phase: 'detecting', snapshot: null, updatedAt: 1 }}
        mcpCount={4}
      />,
      72,
    )

    expect(output.split('\n')).toHaveLength(1)
    expect(output).toContain('approval:agent')
    expect(output).not.toContain('mcp:4')
  })

  it('adds secondary runtime state when space is available', () => {
    const output = renderStatus(
      <StatusLine
        config={{
          provider: 'openai',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.6',
          contextWindow: 200_000,
          maxTokens: 16_384,
          approvalPolicy: 'agent',
          gitEnabled: true,
        }}
        tokenUsage={{ source: 'provider', input: 40_000, output: 512, cached: 32_000 }}
        gitState={{ enabled: true, phase: 'ready', updatedAt: 1, snapshot: {
          branch: 'main',
          head: 'abc123',
          upstream: 'origin/main',
          ahead: 2,
          behind: 0,
          detached: false,
          clean: false,
          files: [{ path: 'src/app.ts', indexStatus: '', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false, conflicted: false }],
          stagedCount: 0,
          unstagedCount: 1,
          untrackedCount: 0,
          conflictedCount: 0,
          recentCommits: [],
        }}}
        mcpCount={2}
        terminalCount={1}
      />,
      190,
    )

    expect(output).toContain('ctx 40.0k/200.0k')
    expect(output).toContain('out 512')
    expect(output).toContain('cache 32.0k')
    expect(output).toContain('git:main +2 · 1 changed')
    expect(output).toContain('mcp:2')
    expect(output).toContain('term:1')
  })

  it('keeps flow action, queue, and inbox visible at ordinary widths', () => {
    const output = renderStatus(
      <StatusLine
        config={{
          provider: 'openai',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.6',
          contextWindow: 200_000,
          maxTokens: 16_384,
          approvalPolicy: 'agent',
          gitEnabled: true,
        }}
        tokenUsage={{ source: 'unknown' }}
        activity={{ kind: 'action-required', code: 'review-required', label: 'Review required', detail: 'write_file' }}
        queueCount={2}
        resultCount={1}
      />,
      82,
    )

    expect(output).toContain('ACTION')
    expect(output).toContain('inbox:1')
    expect(output).toContain('queue:2')
    expect(output).toContain('Review required')
  })
})
