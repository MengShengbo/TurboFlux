import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { CockpitHud } from './CockpitRails'
import { createFastContextUiSummary } from './fastContextUi'

describe('CockpitHud', () => {
  it('keeps the current development stage and session context in two compact rows', () => {
    const output = renderToString(
      <ThemeProvider>
        <CockpitHud
          columns={120}
          workspacePath="C:/workspace/chat-demo"
          model="gpt-5.5"
          mode="vibe"
          reasoning="xhigh"
          approvalPolicy="full"
          isRunning
          runState={{ phase: 'tool_running', updatedAt: 1 }}
          tools={[{ id: 'tool-1', name: 'write_file', status: 'running', args: JSON.stringify({ path: 'src/App.tsx' }) }]}
          draft={null}
          fastContextSummary={createFastContextUiSummary()}
          fastContextActive={false}
          subagents={[]}
          queuedCount={0}
          terminals={[]}
          mcpCount={0}
          task={null}
          objective="Build the chat demo"
          showTask={false}
        />
      </ThemeProvider>,
      { columns: 120 },
    )

    expect(output.split('\n')).toHaveLength(2)
    expect(output).toContain('TurboFlux')
    expect(output).toContain('EDITING')
    expect(output).toContain('Writing src/App.tsx')
    expect(output).not.toContain('FC READY')
  })

  it('surfaces user-blocking work and concurrent background activity', () => {
    const output = renderToString(
      <ThemeProvider>
        <CockpitHud
          columns={140}
          workspacePath="C:/workspace/chat-demo"
          model="gpt-5.5"
          mode="vibe"
          approvalPolicy="agent"
          isRunning
          runState={{ phase: 'awaiting_approval', updatedAt: 1, detail: 'Reviewing run_command' }}
          tools={[]}
          draft={null}
          fastContextSummary={{ ...createFastContextUiSummary(), phase: 'ranking', absorbed: 4, events: 8 }}
          fastContextActive
          subagents={[{
            id: 'review-1',
            label: 'Reviewer',
            objective: 'Review changes',
            detail: 'turn 2/5',
            startedAt: 1,
            status: 'running',
          }]}
          queuedCount={1}
          terminals={[]}
          mcpCount={1}
          task={null}
          objective="Ship the current change"
          showTask={false}
        />
      </ThemeProvider>,
      { columns: 140 },
    )

    expect(output.split('\n')).toHaveLength(2)
    expect(output).toContain('REVIEW REQUIRED')
    expect(output).toContain('Reviewing run_command')
    expect(output).toContain('FC ranking')
    expect(output).toContain('Reviewer 2/5')
  })

  it.each([64, 80, 120])('stays within a two-row terminal frame at %i columns', columns => {
    const output = renderToString(
      <ThemeProvider>
        <CockpitHud
          columns={columns}
          workspacePath="C:/workspace/a-long-project-name"
          model="gpt-5.5"
          mode="vibe"
          reasoning="high"
          approvalPolicy="agent"
          isRunning
          runState={{ phase: 'awaiting_approval', updatedAt: 1, detail: 'Reviewing a long shell command before execution' }}
          tools={[]}
          draft={null}
          fastContextSummary={{ ...createFastContextUiSummary(), phase: 'ranking', absorbed: 12, events: 18 }}
          fastContextActive
          subagents={[]}
          queuedCount={2}
          terminals={[]}
          mcpCount={2}
          task={null}
          objective="Complete the current implementation safely"
          showTask={false}
        />
      </ThemeProvider>,
      { columns },
    )

    const lines = output.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.length <= columns)).toBe(true)
    expect(output).toContain('REVIEW REQUIRED')
  })
})
