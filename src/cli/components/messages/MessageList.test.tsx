import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { MAX_DIFF_INPUT_BYTES, MAX_DIFF_INPUT_LINES } from '../../../core/diffCompute'
import { ThemeProvider } from '../../theme/index'
import { MessageList } from './MessageList'

describe('MessageList developer workflow', () => {
  it('renders tool-loop commentary as progress before the tools without an Answer label', () => {
    const output = renderToString(
      <ThemeProvider>
        <MessageList
          messages={[{
            id: 'assistant-progress',
            role: 'assistant',
            content: 'The API route is located; next I am patching validation.',
            progress: true,
            tools: [{ id: 'tool-1', name: 'read_file', status: 'done' }],
          }]}
          verbose={false}
          availableWidth={72}
        />
      </ThemeProvider>,
      { columns: 72 },
    )

    expect(output).toContain('The API route is located')
    expect(output).not.toContain('Answer')
  })

  it('renders every diff row by default', () => {
    const after = Array.from({ length: 140 }, (_, index) => `added-line-${String(index + 1).padStart(3, '0')}`).join('\n')
    const output = renderToString(
      <ThemeProvider>
        <MessageList
          messages={[{
            id: 'assistant-1',
            role: 'assistant',
            content: 'Implemented the generated file.',
            changes: [{ path: 'src/generated.ts', operation: 'write', before: '', after }],
          }]}
          verbose={false}
          availableWidth={72}
        />
      </ThemeProvider>,
      { columns: 72 },
    )

    expect(output).toContain('Changes')
    expect(output).toContain('src/generated.ts')
    expect(output).toContain('added-line-001')
    expect(output).toContain('added-line-140')
    expect(output).not.toContain('diff collapsed')
    expect(output).not.toContain('more diff lines hidden')
    expect(output).toContain('Answer')
  })

  it('wraps long diff content instead of truncating it', () => {
    const tail = 'TAIL_MUST_REMAIN_VISIBLE'
    const after = `${'prefix-'.repeat(20)}${tail}`
    const output = renderToString(
      <ThemeProvider>
        <MessageList
          messages={[{
            id: 'assistant-2',
            role: 'assistant',
            content: '',
            changes: [{ path: 'src/wide.ts', operation: 'write', before: '', after }],
          }]}
          verbose={false}
          availableWidth={40}
        />
      </ThemeProvider>,
      { columns: 40 },
    )

    expect(output.replace(/\s/g, '')).toContain(tail)
    expect(output).not.toContain('…')
  })

  it('explains when a snapshot exceeds the safe diff threshold', () => {
    const output = renderToString(
      <ThemeProvider>
        <MessageList
          messages={[{
            id: 'assistant-3',
            role: 'assistant',
            content: '',
            changes: [{
              path: 'src/large.ts',
              operation: 'edit',
              diffStatus: 'snapshot-too-large',
              beforeBytes: 300 * 1024,
              afterBytes: 320 * 1024,
            }],
          }]}
          verbose={false}
          availableWidth={72}
        />
      </ThemeProvider>,
      { columns: 72 },
    )

    expect(output).toContain('300.0 KB')
    expect(output).toContain('320.0 KB')
    expect(output.replace(/\s+/g, ' ')).toContain(`${(MAX_DIFF_INPUT_BYTES / 1024).toFixed(1)} KB / ${MAX_DIFF_INPUT_LINES}-line inline safety limit`)
    expect(output).not.toContain('no file snapshot captured')
  })
})
