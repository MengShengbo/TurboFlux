import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToString } from 'ink'
import { ThemeProvider } from '../../theme/index'
import { ActiveWorkPanel } from './ActiveWorkPanel'

describe('ActiveWorkPanel', () => {
  it('replaces the transient run label once live output starts', () => {
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText="Answer token"
          thinkingText="Reasoning token"
          lastActivity={Date.now()}
          runState={{ phase: 'thinking', updatedAt: Date.now(), detail: 'Planning next step' }}
          verbose={false}
          showThinking
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('Reasoning token')
    expect(output).toContain('Answer token')
    expect(output).not.toContain('Planning next step')
    expect(output).not.toContain('THINKING')
  })
})
