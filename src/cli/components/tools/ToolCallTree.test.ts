import { describe, expect, it } from 'vitest'
import {
  formatToolLabelForHistory,
  shouldPersistToolForHistory,
  type ToolStatus,
} from './ToolCallTree'

function tool(name: string, status: ToolStatus['status'], args?: Record<string, unknown>): ToolStatus {
  return {
    id: `${name}-${status}`,
    name,
    status,
    args: args ? JSON.stringify(args) : undefined,
  }
}

describe('ToolCallTree history policy', () => {
  it('keeps successful exploration tools as compact committed history', () => {
    expect(shouldPersistToolForHistory(tool('read_file', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('search_content', 'done'))).toBe(true)
    expect(shouldPersistToolForHistory(tool('get_codemap', 'done'))).toBe(true)
  })

  it('keeps failed exploration tools visible', () => {
    expect(shouldPersistToolForHistory(tool('read_file', 'error'))).toBe(true)
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
})
