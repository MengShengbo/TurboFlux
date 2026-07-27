import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { createFastContextUiSummary } from './fastContextUi'
import { SessionSidebar } from './SessionSidebar'

describe('SessionSidebar', () => {
  it('renders session, context, work, and runtime information in a narrow rail', () => {
    const output = renderToString(
      <ThemeProvider>
        <SessionSidebar
          width={30}
          workspacePath="C:/workspace/turboflux"
          model="gpt-5.5"
          mode="vibe"
          reasoning="high"
          approvalPolicy="agent"
          securityProfile={{ mode: 'blue', active: true, engagementId: 'sec-test', targets: ['prod-web-01'] }}
          contextWindow={200_000}
          tokenUsage={{ source: 'provider', input: 40_000, output: 512, cached: 30_000 }}
          isRunning
          runState={{ phase: 'tool_running', startedAt: Date.now() - 1200, updatedAt: Date.now() }}
          tools={[{ id: 'tool-1', name: 'read_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }) }]}
          draft={null}
          fastContextSummary={createFastContextUiSummary()}
          fastContextActive={false}
          subagents={[]}
          queuedCount={0}
          terminals={[]}
          mcpCount={2}
          task={null}
          objective="Fix the terminal workspace layout"
          gitEnabled
          gitSnapshot={null}
        />
      </ThemeProvider>,
      { columns: 140 },
    )

    expect(output).toContain('TurboFlux')
    expect(output).toContain('STATUS')
    expect(output).toContain('SESSION')
    expect(output).toContain('CONTEXT')
    expect(output).toContain('WORK')
    expect(output).toContain('RUNTIME')
    expect(output).toContain('gpt-5.5')
    expect(output).toContain('40.0k / 200.0k')
    expect(output).toContain('Read src/App.tsx')
    expect(output).toContain('BLUE')
  })

  it('keeps every rendered row inside the requested width', () => {
    const output = renderToString(
      <ThemeProvider>
        <SessionSidebar
          width={28}
          workspacePath="C:/workspace/a-very-long-workspace-name"
          model="a-very-long-provider-model-name"
          mode="plan"
          approvalPolicy="full"
          contextWindow={200_000}
          tokenUsage={{ source: 'unknown' }}
          isRunning={false}
          runState={{ phase: 'idle', updatedAt: 1 }}
          tools={[]}
          draft={null}
          fastContextSummary={createFastContextUiSummary()}
          fastContextActive={false}
          subagents={[]}
          queuedCount={0}
          terminals={[]}
          mcpCount={0}
          task={null}
          gitEnabled={false}
          gitSnapshot={null}
        />
      </ThemeProvider>,
      { columns: 120 },
    )

    expect(output.split('\n').every(line => line.length <= 28)).toBe(true)
  })
})
