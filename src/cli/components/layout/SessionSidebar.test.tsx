import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { createFastContextUiSummary } from './fastContextUi'
import { SessionSidebar } from './SessionSidebar'

describe('SessionSidebar', () => {
  it('renders a compact session rail with a live FastContext stage', () => {
    const fastContextEvents = [
      { type: 'phase' as const, phase: 'mapping' as const, wave: 1, maxWaves: 4, insight: 'mapping owners' },
      { type: 'insight' as const, text: 'search_symbol: SessionSidebar', tone: 'info' as const },
    ]
    const output = renderToString(
      <ThemeProvider>
        <SessionSidebar
          width={30}
          workspacePath="C:/workspace/turboflux"
          model="gpt-5.5"
          mode="vibe"
          reasoning="high"
          contextWindow={200_000}
          tokenUsage={{ source: 'provider', input: 40_000, output: 512, cached: 30_000 }}
          isRunning
          runState={{ phase: 'tool_running', startedAt: Date.now() - 1200, updatedAt: Date.now() }}
          tools={[{ id: 'tool-1', name: 'read_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }) }]}
          draft={null}
          fastContextEvents={fastContextEvents}
          fastContextSummary={createFastContextUiSummary()}
          fastContextActive
          subagents={[]}
          queuedCount={0}
          terminals={[]}
          mcpCount={2}
          task={null}
          objective="Fix the terminal workspace layout"
          gitState={{ enabled: true, phase: 'detecting', snapshot: null, updatedAt: 1 }}
        />
      </ThemeProvider>,
      { columns: 140 },
    )

    expect(output).toContain('TurboFlux')
    expect(output).toContain('STATUS')
    expect(output).toContain('SESSION')
    expect(output).toContain('CONTEXT')
    expect(output).toContain('REPO')
    expect(output).toContain('RUNTIME')
    expect(output).toContain('MAPPING')
    expect(output).toContain('MAP > READ > RANK > SYNTH')
    expect(output).toContain('FLOW TRACE')
    expect(output).toContain('SEARCH')
    expect(output).toContain('Sidebar')
    expect(output).toContain('gpt-5.5')
    expect(output).toContain('40.0k / 200.0k')
    expect(output).not.toContain('WORK')
    expect(output).not.toContain('Approval')
  })

  it('keeps every rendered row inside the requested width', () => {
    const output = renderToString(
      <ThemeProvider>
        <SessionSidebar
          width={28}
          workspacePath="C:/workspace/a-very-long-workspace-name"
          model="a-very-long-provider-model-name"
          mode="plan"
          contextWindow={200_000}
          tokenUsage={{ source: 'unknown' }}
          isRunning={false}
          runState={{ phase: 'idle', updatedAt: 1 }}
          tools={[]}
          draft={null}
          fastContextEvents={[]}
          fastContextSummary={createFastContextUiSummary()}
          fastContextActive={false}
          subagents={[]}
          queuedCount={0}
          terminals={[]}
          mcpCount={0}
          task={null}
          gitState={{ enabled: false, phase: 'disabled', snapshot: null, updatedAt: 1 }}
        />
      </ThemeProvider>,
      { columns: 120 },
    )

    expect(output.split('\n').every(line => line.length <= 28)).toBe(true)
    expect(output).not.toContain('RUNTIME')
  })

  it('keeps the completed FastContext handoff visible', () => {
    const events = [
      { type: 'phase' as const, phase: 'completed' as const, wave: 2, maxWaves: 4 },
      { type: 'progress' as const, files: 5, absorbed: 3, hits: 4 },
    ]
    const summary = { ...createFastContextUiSummary(), phase: 'completed' as const, files: 5, absorbed: 3, hits: 4 }
    const output = renderToString(
      <ThemeProvider>
        <SessionSidebar
          width={30}
          workspacePath="C:/workspace/turboflux"
          model="gpt-5.5"
          mode="vibe"
          contextWindow={200_000}
          tokenUsage={{ source: 'provider', input: 40_000 }}
          isRunning={false}
          runState={{ phase: 'idle', updatedAt: 1 }}
          tools={[]}
          draft={null}
          fastContextEvents={events}
          fastContextSummary={summary}
          fastContextActive={false}
          subagents={[]}
          queuedCount={0}
          terminals={[]}
          mcpCount={0}
          task={null}
          gitState={{ enabled: false, phase: 'disabled', snapshot: null, updatedAt: 1 }}
        />
      </ThemeProvider>,
      { columns: 120 },
    )

    expect(output).toContain('FASTCONTEXT ONLINE')
    expect(output).toContain('Evidence handed to MAIN')
    expect(output).toContain('3 files / 4 ranges ready')
  })
})
