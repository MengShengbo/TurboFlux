import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToString } from 'ink'
import { ThemeProvider } from '../../theme/index'
import { ActiveWorkPanel } from './ActiveWorkPanel'

describe('ActiveWorkPanel', () => {
  it('shows request latency instead of claiming reasoning before the first response', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText=""
          thinkingText=""
          lastActivity={now}
          runState={{ phase: 'thinking', updatedAt: now, detail: 'Planning next step' }}
          requestStatus={{ phase: 'requesting', startedAt: now - 1200 }}
          reasoningActive
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('REQUESTING')
    expect(output).toContain('waiting for first response')
    expect(output).toContain('1.2s')
    expect(output).not.toContain('Reasoning')
    expect(output).not.toContain('PLANNING')
  })

  it('keeps the completed request duration visible after the run becomes idle', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText=""
          lastActivity={now}
          runState={{ phase: 'completed', updatedAt: now }}
          requestStatus={{ phase: 'completed', startedAt: now - 1350, elapsedMs: 1350 }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('REQUEST COMPLETE')
    expect(output).toContain('1.4s')
  })

  it('shows response streaming without claiming reasoning before a reasoning delta', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText="Answer token"
          thinkingText=""
          lastActivity={now}
          runState={{ phase: 'thinking', updatedAt: now }}
          requestStatus={{ phase: 'responding', startedAt: now - 900, elapsedMs: 900 }}
          reasoningActive
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('RESPONDING')
    expect(output).toContain('first response 900ms')
    expect(output).toContain('Answer token')
    expect(output).not.toContain('Reasoning')
  })

  it('makes a long request visibly explicit instead of looking frozen', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText=""
          thinkingText=""
          lastActivity={now}
          runState={{ phase: 'thinking', updatedAt: now }}
          requestStatus={{ phase: 'requesting', startedAt: now - 31_000 }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('REQUESTING')
    expect(output).toContain('slow request, still waiting')
    expect(output).toContain('31s')
  })

  it('shows compaction phase and progress instead of a generic request spinner', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText=""
          thinkingText=""
          lastActivity={now}
          runState={{ phase: 'compacting', updatedAt: now, startedAt: now - 2200 }}
          requestStatus={{ phase: 'requesting', startedAt: now - 2200 }}
          compaction={{
            id: 'compact-ui-1',
            phase: 'summarizing',
            source: 'compact',
            startedAt: now - 2200,
            updatedAt: now,
            elapsedMs: 2200,
            progress: 0.42,
            detail: 'Summarizing older turns',
            recoverable: true,
          }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('SUMMARIZING CONTEXT')
    expect(output).toContain('42%')
    expect(output).toContain('Summarizing older turns')
    expect(output).not.toContain('REQUESTING')
  })

  it('keeps a recovered terminal compaction state visible while idle', () => {
    const now = Date.now()
    const output = renderToString(
      <ThemeProvider>
        <ActiveWorkPanel
          tools={[]}
          draft={null}
          streamText=""
          thinkingText=""
          lastActivity={now}
          runState={{ phase: 'idle', updatedAt: now }}
          compaction={{
            id: 'compact-ui-interrupted',
            phase: 'interrupted',
            source: 'compact',
            startedAt: now - 3200,
            updatedAt: now,
            elapsedMs: 3200,
            detail: 'Original turns were preserved',
            recoverable: true,
          }}
          verbose={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('COMPACTION INTERRUPTED')
    expect(output).toContain('Original turns were preserved')
  })

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
