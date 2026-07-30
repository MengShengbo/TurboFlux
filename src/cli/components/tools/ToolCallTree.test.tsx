import { describe, expect, it } from 'vitest'
import {
  formatToolLabelForHistory,
  shouldPersistToolForHistory,
  type ToolStatus,
} from './ToolCallTree'
import { renderToString } from 'ink'
import React from 'react'
import { ToolCallTree } from './ToolCallTree'
import { ThemeProvider } from '../../theme/index'

function tool(name: string, status: ToolStatus['status'], args?: Record<string, unknown>): ToolStatus {
  return {
    id: `${name}-${status}`,
    name,
    status,
    args: args ? JSON.stringify(args) : undefined,
  }
}

describe('ToolCallTree history policy', () => {
  it('keeps each settled tool visible in compact history', () => {
    const tools = [tool('read_file', 'done', { path: 'src/App.tsx' }), tool('run_command', 'done', { command: 'npm test' })]
    const compact = renderToString(<ThemeProvider><ToolCallTree tools={tools} verbose={false} expanded={false} /></ThemeProvider>, { columns: 88 })
    const expanded = renderToString(<ThemeProvider><ToolCallTree tools={tools} verbose={false} expanded /></ThemeProvider>, { columns: 88 })

    expect(compact).toContain('Activity completed calls: 2')
    expect(compact).toContain('Read src/App.tsx')
    expect(compact).toContain('Run npm test')
    expect(expanded).toContain('Read src/App.tsx')
    expect(expanded).toContain('Run npm test')
  })

  it('persists successful exploration tools for auditability', () => {
    expect(shouldPersistToolForHistory(tool('read_file', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('search_content', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('get_codemap', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('explore_code', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('web_search', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('read_agent', 'done'))).toBe(false)
  })

  it('keeps failed exploration tools available to the internal history policy', () => {
    expect(shouldPersistToolForHistory(tool('read_file', 'error'))).toBe(true)
  })

  it('keeps failed tool details visible in compact history', () => {
    const output = renderToString(
      <ThemeProvider>
        <ToolCallTree
          tools={[tool('read_file', 'error', { path: 'missing.ts' })]}
          verbose={false}
          expanded={false}
        />
      </ThemeProvider>,
      { columns: 88 },
    )

    expect(output).toContain('incomplete calls: 1')
    expect(output).toContain('missing.ts')
  })

  it('keeps user-visible write and shell tools visible', () => {
    expect(shouldPersistToolForHistory(tool('replace_file', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('run_command', 'done'))).toBe(true)
  })

  it('formats paged reads with line ranges', () => {
    expect(formatToolLabelForHistory('read_file', JSON.stringify({
      path: 'src/App.tsx',
      offset: 180,
      limit: 60,
    }))).toBe('Read src/App.tsx:181-240')
  })

  it('formats broad code exploration as an Explore activity', () => {
    expect(formatToolLabelForHistory('explore_code', JSON.stringify({
      objective: 'find the terminal paste image handling flow',
    }))).toBe('Explore "find the terminal paste image handling flow"')
  })

  it('formats web search as a Web activity', () => {
    expect(formatToolLabelForHistory('web_search', JSON.stringify({
      query: 'latest Node.js fetch docs',
    }))).toBe('Web "latest Node.js fetch docs"')
  })
})
