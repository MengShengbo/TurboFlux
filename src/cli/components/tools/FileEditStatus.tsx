import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import type { ToolStatus } from './ToolCallTree'

const FILE_EDIT_TOOLS = new Set(['write_file', 'replace_file', 'edit_file', 'multi_edit', 'delete_file'])

interface FileEditStatusProps {
  tools: ToolStatus[]
}

export function FileEditStatus({ tools }: FileEditStatusProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const active = [...tools].reverse().find(tool => tool.status === 'running' && FILE_EDIT_TOOLS.has(tool.name))

  if (!active) return null

  const path = getPathFromArgs(active.args)
  const verb = getVerb(active.name)
  const label = path ? `${verb} ${path}` : `${verb} file`

  return (
    <Box marginBottom={0}>
      <Text color={theme.inactive}>File </Text>
      <SpinnerGlyph
        lastActivity={active.startTime}
        label={cliTruncate(label, Math.max(20, columns - 16), { position: 'middle' })}
      />
    </Box>
  )
}

export function isFileEditToolName(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name)
}

function getVerb(name: string): string {
  switch (name) {
    case 'write_file': return 'Writing'
    case 'replace_file': return 'Replacing'
    case 'edit_file': return 'Editing'
    case 'multi_edit': return 'Applying edits to'
    case 'delete_file': return 'Deleting'
    default: return 'Editing'
  }
}

function getPathFromArgs(argsJson?: string): string {
  if (!argsJson) return ''
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    return typeof args.path === 'string' ? args.path : ''
  } catch {
    return ''
  }
}
