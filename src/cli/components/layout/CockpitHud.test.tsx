import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { CockpitHud } from './CockpitRails'
import { createFastContextUiSummary } from './fastContextUi'

describe('CockpitHud', () => {
  it('keeps session and work information in two compact rows', () => {
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
          tools={[{ id: 'tool-1', name: 'write_file', status: 'running', args: 'src/App.tsx' }]}
          draft={null}
          fastContextSummary={createFastContextUiSummary()}
          fastContextActive={false}
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
    expect(output).toContain('RUNNING')
    expect(output).toContain('write_file')
    expect(output).toContain('FC READY')
  })
})
