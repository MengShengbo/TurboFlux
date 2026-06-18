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
  draft?: {
    id: string
    name: string
    partialJson: string
    startedAt: number
    updatedAt: number
  } | null
}

export function FileEditStatus({ tools, draft }: FileEditStatusProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const active = [...tools].reverse().find(tool => tool.status === 'running' && FILE_EDIT_TOOLS.has(tool.name))

  if (!active && !(draft && FILE_EDIT_TOOLS.has(draft.name))) return null

  const path = active ? getPathFromArgs(active.args) : getPathFromPartialJson(draft?.partialJson)
  const name = active?.name ?? draft?.name ?? 'edit_file'
  const verb = active ? getVerb(name) : getDraftVerb(name)
  const size = !active && draft ? ` - ${formatBytes(draft.partialJson.length)} prepared` : ''
  const label = `${path ? `${verb} ${path}` : `${verb} file`}${size}`

  return (
    <Box marginBottom={0}>
      <Text color={theme.inactive}>File </Text>
      <SpinnerGlyph
        lastActivity={active?.startTime ?? draft?.updatedAt}
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

function getDraftVerb(name: string): string {
  switch (name) {
    case 'write_file': return 'Preparing write for'
    case 'replace_file': return 'Preparing replacement for'
    case 'edit_file': return 'Preparing edit for'
    case 'multi_edit': return 'Preparing edits for'
    case 'delete_file': return 'Preparing delete for'
    default: return 'Preparing edit for'
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

function getPathFromPartialJson(partialJson?: string): string {
  if (!partialJson) return ''
  try {
    const args = JSON.parse(partialJson) as Record<string, unknown>
    return typeof args.path === 'string' ? args.path : ''
  } catch {
    const match = partialJson.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/)
    if (!match) return ''
    try {
      return JSON.parse(`"${match[1]}"`)
    } catch {
      return match[1] || ''
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
