import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { QueuedPromptList } from './QueuedPromptList'

describe('QueuedPromptList', () => {
  it('shows queued prompt content and its position', () => {
    const output = renderToString(
      <ThemeProvider>
        <QueuedPromptList
          width={80}
          prompts={[
            { id: 'queued-1', prompt: 'Review the current API implementation' },
            { id: 'queued-2', prompt: 'Then update the tests', attachmentCount: 1 },
          ]}
        />
      </ThemeProvider>,
      { columns: 80 },
    )

    expect(output).toContain('queued 1')
    expect(output).toContain('Review the current API implementation')
    expect(output).toContain('queued 2')
    expect(output).toContain('Then update the tests +1 image')
  })
})
