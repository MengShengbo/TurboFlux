import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToString } from 'ink'
import { ThemeProvider } from '../../theme/index'
import { ActiveWorkPanel } from './ActiveWorkPanel'

describe('ActiveWorkPanel', () => {
  it('shows every parallel running tool with a live status', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[
            { id: 'read-1', name: 'read_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }), startTime: now },
            { id: 'edit-1', name: 'edit_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }), startTime: now },
          ]}
          draft={null}
          streamText=""
          lastActivity={now}
          runState={{ phase: 'tool_running', updatedAt: now }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('Activity active calls: 2')
    expect(output).toContain('Reading src/App.tsx')
    expect(output).toContain('Editing src/App.tsx')
  })

  it('shows a streamed tool draft before the full call arrives', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={{
            id: 'draft-1',
            name: 'write_file',
            partialJson: '{"path":"src/new-file.ts",',
            startedAt: now,
            updatedAt: now,
          }}
          streamText=""
          lastActivity={now}
          runState={{ phase: 'tool_running', updatedAt: now }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('Activity active calls: 1')
    expect(output).toContain('Preparing Write file: src/new-file.ts')
  })

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
          reasoningActive
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

  it('keeps live provider reasoning collapsed until explicitly expanded', () => {
    const now = Date.now()
    const props = {
      tools: [],
      draft: null,
      streamText: '',
      thinkingText: 'Internal English chain of thought',
      lastActivity: now,
      runState: { phase: 'thinking' as const, updatedAt: now },
      verbose: false,
      reasoningActive: true,
    }
    const collapsed = renderToString(
      <ThemeProvider><ActiveWorkPanel {...props} showThinking={false} /></ThemeProvider>,
      { columns: 88 },
    )
    const expanded = renderToString(
      <ThemeProvider><ActiveWorkPanel {...props} showThinking /></ThemeProvider>,
      { columns: 88 },
    )

    expect(collapsed).toContain('Reasoning')
    expect(collapsed).not.toContain('Internal English chain of thought')
    expect(expanded).toContain('Internal English chain of thought')
  })

  it('labels visible streaming prose as MAIN AGENT output', () => {
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText="我正在核对后台代理返回的证据。"
          thinkingText=""
          lastActivity={Date.now()}
          runState={{ phase: 'thinking', updatedAt: Date.now() }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('MAIN AGENT')
    expect(output).toContain('我正在核对后台代理返回的证据。')
  })

  it('shows live reasoning status before the first reasoning token arrives', () => {
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText=""
          thinkingText=""
          thinkingStartedAt={Date.now() - 1200}
          reasoningEffort="high"
          reasoningActive
          lastActivity={Date.now()}
          runState={{ phase: 'thinking', updatedAt: Date.now(), detail: 'Planning next step' }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('Reasoning · high')
    expect(output).not.toContain('Planning next step')
  })
})
