import React from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import {
  getNextPermissionIndex,
  getPermissionDecision,
  PermissionDialog,
} from './PermissionDialog'

describe('PermissionDialog', () => {
  it('wraps selection and resolves the highlighted decision', () => {
    expect(getNextPermissionIndex(0, -1)).toBe(2)
    expect(getNextPermissionIndex(2, 1)).toBe(0)
    expect(getPermissionDecision(0)).toBe('allow-once')
    expect(getPermissionDecision(1)).toBe('allow-session')
    expect(getPermissionDecision(2)).toBe('deny')
  })

  it('renders request context and a selectable decision list', () => {
    const output = renderToString(
      <PermissionDialog
        toolName="run_command"
        description="Workspace command execution requires approval"
        command="npm test"
        path={'C:\\workspace'}
        onDecision={() => {}}
      />,
      { columns: 88 },
    )

    expect(output).toContain('Permission request')
    expect(output).toContain('run_command')
    expect(output).toContain('C:\\workspace')
    expect(output).toContain('npm test')
    expect(output).toContain('Allow once')
    expect(output).toContain('Allow for this session')
    expect(output).toContain('Deny')
    expect(output).toContain('Enter confirm')
  })

  it('keeps all choices visible in a narrow session pane', () => {
    const output = renderToString(
      <PermissionDialog
        toolName="edit_file"
        description="Write access requires approval"
        path={'C:\\workspace\\src\\app.ts'}
        onDecision={() => {}}
      />,
      { columns: 48 },
    )

    expect(output).toContain('Allow once')
    expect(output).toContain('Allow for this session')
    expect(output).toContain('Deny')
    expect(output).toContain('Tab choose')
  })
})
