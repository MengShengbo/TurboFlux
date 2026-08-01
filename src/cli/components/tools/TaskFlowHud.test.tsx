import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { TaskFlowHud } from './TaskFlowHud'

describe('TaskFlowHud', () => {
  it('keeps the task flow anchored to the right with useful progress detail', () => {
    const output = renderToString(
      <ThemeProvider>
        <TaskFlowHud
          task={{
            taskId: 'task-1',
            title: 'Build task dashboard',
            priority: 'major',
            progress: 42,
            toolCalls: [
              { toolCallId: 'tool-1', toolName: 'read_file', status: 'completed' },
              { toolCallId: 'tool-2', toolName: 'write_file', status: 'running' },
            ],
            startedAt: Date.now() - 5_000,
          }}
          objective="Build task dashboard"
          isRunning
          runState={{ phase: 'tool_running', activeTool: 'write_file', startedAt: Date.now() - 5_000, updatedAt: Date.now() }}
          tools={[]}
          draft={null}
          width={70}
        />
      </ThemeProvider>,
      { columns: 100 },
    )

    expect(output).toContain('◆ TASK')
    expect(output).toContain('Build task dashboard')
    expect(output).toContain('tools 1/2, 1 running')
    expect(output).toContain('42%')
    expect(output).toContain('write')
    expect(output).not.toContain('READY')
    expect(output).not.toContain('working')
  })

  it('shows the active objective while the task tree is still empty', () => {
    const output = renderToString(
      <ThemeProvider>
        <TaskFlowHud
          task={null}
          objective="Inspect the workspace"
          isRunning
          runState={{ phase: 'thinking', detail: 'Planning the next step', startedAt: 1, updatedAt: 2 }}
          tools={[]}
          draft={null}
          width={50}
        />
      </ThemeProvider>,
      { columns: 80 },
    )

    expect(output).toContain('◆ FLOW')
    expect(output).toContain('Inspect the workspace')
  })

  it('does not keep a settled objective in the live HUD', () => {
    const output = renderToString(
      <ThemeProvider>
        <TaskFlowHud
          task={null}
          objective="Finished workspace inspection"
          isRunning={false}
          runState={{ phase: 'completed', updatedAt: Date.now() }}
          tools={[]}
          draft={null}
          width={50}
        />
      </ThemeProvider>,
      { columns: 80 },
    )

    expect(output).toBe('')
  })
})
