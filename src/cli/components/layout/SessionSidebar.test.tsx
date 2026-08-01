import React from 'react'
import { Box, renderToString } from 'ink'
import stripAnsi from 'strip-ansi'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../../theme/index'
import { SessionSidebar } from './SessionSidebar'

describe('SessionSidebar', () => {
  it('renders a compact session rail', () => {
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
          queuedCount={0}
          terminals={[]}
          mcpCount={2}
          gitState={{ enabled: true, phase: 'detecting', snapshot: null, updatedAt: 1 }}
        />
      </ThemeProvider>,
      { columns: 140 },
    )

    expect(output).toContain('TurboFlux')
    expect(output).toContain('SESSION')
    expect(output).toContain('CONTEXT')
    expect(output).toContain('REPO')
    expect(output).toContain('RUNTIME')
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
          queuedCount={0}
          terminals={[]}
          mcpCount={0}
          gitState={{ enabled: true, phase: 'unavailable', snapshot: null, updatedAt: 1 }}
        />
      </ThemeProvider>,
      { columns: 120 },
    )

    expect(output.split('\n').every(line => line.length <= 28)).toBe(true)
    expect(output).not.toContain('RUNTIME')
    expect(output).not.toContain('REPO')
  })

  it('removes the generic ready and working marker when content is clipped', () => {
    const output = renderToString(
      <ThemeProvider>
        <Box height={18}>
          <SessionSidebar
            width={30}
            workspacePath="C:/workspace/turboflux"
            model="gpt-5.5"
            mode="vibe"
            reasoning="high"
            contextWindow={200_000}
            tokenUsage={{ source: 'provider', input: 40_000, output: 512, cached: 30_000 }}
            queuedCount={2}
            terminals={[{ id: 'terminal-1', title: 'Tests', command: 'npm test', status: 'running', createdAt: Date.now() - 1200, outputBytes: 1024 }]}
            mcpCount={2}
            gitState={{ enabled: true, phase: 'detecting', snapshot: null, updatedAt: 1 }}
          />
        </Box>
      </ThemeProvider>,
      { columns: 140 },
    )
    const lines = stripAnsi(output).split('\n')

    expect(lines).toHaveLength(18)
    expect(output).not.toContain('● working')
    expect(output).not.toContain('● ready')
  })
})
