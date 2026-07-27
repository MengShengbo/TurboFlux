import React from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import type { ToolStatus } from './ToolCallTree'
import { useI18n, type Translator } from '../../i18n/index'

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
  const { t } = useI18n()
  const { columns } = useTerminalSize()
  const active = [...tools].reverse().find(tool => tool.status === 'running' && FILE_EDIT_TOOLS.has(tool.name))

  if (!active && !(draft && FILE_EDIT_TOOLS.has(draft.name))) return null

  const path = active ? getPathFromArgs(active.args) : getPathFromPartialJson(draft?.partialJson)
  const name = active?.name ?? draft?.name ?? 'edit_file'
  const verb = active ? getVerb(name, t) : getDraftVerb(name, t)
  const size = !active && draft ? t('ui.file.prepared', { size: formatBytes(draft.partialJson.length) }) : ''
  const label = `${path ? `${verb} ${path}` : t('ui.file.target', { verb })}${size}`

  return (
    <Box marginBottom={0}>
      <Text color={theme.inactive}>{t('ui.file.label')} </Text>
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

function getVerb(name: string, t: Translator): string {
  switch (name) {
    case 'write_file': return t('ui.file.writing')
    case 'replace_file': return t('ui.file.replacing')
    case 'edit_file': return t('ui.file.editing')
    case 'multi_edit': return t('ui.file.applying')
    case 'delete_file': return t('ui.file.deleting')
    default: return t('ui.file.editing')
  }
}

function getDraftVerb(name: string, t: Translator): string {
  switch (name) {
    case 'write_file': return t('ui.file.preparingWrite')
    case 'replace_file': return t('ui.file.preparingReplace')
    case 'edit_file': return t('ui.file.preparingEdit')
    case 'multi_edit': return t('ui.file.preparingEdits')
    case 'delete_file': return t('ui.file.preparingDelete')
    default: return t('ui.file.preparingEdit')
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
