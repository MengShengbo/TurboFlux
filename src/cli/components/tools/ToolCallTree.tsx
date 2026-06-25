import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../theme/index'
import { StatusIcon } from '../design-system/StatusIcon'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import cliTruncate from 'cli-truncate'

export interface ToolStatus {
  id?: string
  name: string
  status: 'running' | 'done' | 'error'
  output?: string
  args?: string
  startTime?: number
  endTime?: number
}

interface ToolCallTreeProps {
  tools: ToolStatus[]
  verbose: boolean
}

export function ToolCallTree({ tools, verbose }: ToolCallTreeProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const visibleTools = verbose ? tools : tools.filter(tool => shouldPersistToolForHistory(tool))
  const collapsedReadSearchTools = verbose ? [] : tools.filter(tool => tool.status === 'done' && isCollapsedReadSearchTool(tool.name))

  if (visibleTools.length === 0) {
    if (collapsedReadSearchTools.length === 0) return null
    return (
      <Box marginBottom={0}>
        <Text color={theme.inactive}>Activity </Text>
        <StatusIcon status="success" />
        <Text>{summarizeReadSearchTools(collapsedReadSearchTools, columns)}</Text>
      </Box>
    )
  }
  const allSettled = visibleTools.every(tool => tool.status !== 'running')

  if (!verbose && allSettled) {
    const failed = visibleTools.filter(tool => tool.status === 'error')
    const summary = summarizeTools(visibleTools, columns)
    return (
      <Box marginBottom={0}>
        <Text color={theme.inactive}>Activity </Text>
        <StatusIcon status={failed.length > 0 ? 'error' : 'success'} />
        <Text>{summary}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={theme.inactive}>Activity</Text>
      {visibleTools.map((tool, i) => {
        const isLast = i === visibleTools.length - 1
        const connector = isLast ? '`-' : '|-'
        return (
          <Box key={tool.id ?? i} flexDirection="column">
            <Box>
              <Text color={theme.subtle}>{connector} </Text>
              <ToolCallStatus tool={tool} columns={columns} />
            </Box>
            {verbose && tool.output && tool.status !== 'running' && (
              <Text color={theme.inactive}>
                {isLast ? '   ' : '|  '} {cliTruncate(tool.output, columns - 8, { position: 'end' })}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export function shouldPersistToolForHistory(tool: ToolStatus): boolean {
  if (tool.status !== 'done') return true
  if (tool.name === 'create_checkpoint') return false
  if (tool.name === 'list_tasks' || tool.name === 'update_task' || tool.name === 'create_task' || tool.name === 'create_tasks') return false
  if (isCollapsedReadSearchTool(tool.name)) return false
  return true
}

function isCollapsedReadSearchTool(name: string): boolean {
  return name === 'read_file'
    || name === 'read_file_full'
    || name === 'list_directory'
    || name === 'search_content'
    || name === 'search_files'
    || name === 'search_symbols'
    || name === 'get_codemap'
}

function summarizeTools(tools: ToolStatus[], columns: number): string {
  const failed = tools.filter(tool => tool.status === 'error')
  const completed = tools.length - failed.length
  const counts = new Map<string, number>()
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  }
  const groups = Array.from(counts.entries())
    .map(([name, count]) => count > 1 ? `${formatToolName(name)} x${count}` : formatToolName(name))
    .join(', ')
  const status = failed.length > 0
    ? `${completed}/${tools.length} complete, ${failed.length} error${failed.length === 1 ? '' : 's'}`
    : `${tools.length} tool${tools.length === 1 ? '' : 's'} complete`
  const text = groups ? `${status}: ${groups}` : status
  return cliTruncate(text, Math.max(20, columns - 16), { position: 'end' })
}

function summarizeReadSearchTools(tools: ToolStatus[], columns: number): string {
  let searches = 0
  let reads = 0
  let maps = 0
  let lists = 0
  for (const tool of tools) {
    if (tool.name === 'read_file' || tool.name === 'read_file_full') reads++
    else if (tool.name === 'get_codemap' || tool.name === 'search_symbols') maps++
    else if (tool.name === 'list_directory') lists++
    else searches++
  }
  const parts = [
    searches > 0 ? `${searches} search${searches === 1 ? '' : 'es'}` : '',
    maps > 0 ? `${maps} map${maps === 1 ? '' : 's'}` : '',
    reads > 0 ? `${reads} read${reads === 1 ? '' : 's'}` : '',
    lists > 0 ? `${lists} list${lists === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  const text = `${tools.length} tool${tools.length === 1 ? '' : 's'} folded: ${parts.join(', ')}`
  return cliTruncate(text, Math.max(20, columns - 16), { position: 'end' })
}

function formatToolName(name: string): string {
  switch (name) {
    case 'read_file': return 'read'
    case 'read_file_full': return 'full read'
    case 'write_file': return 'write'
    case 'replace_file': return 'replace'
    case 'edit_file': return 'edit'
    case 'multi_edit': return 'multi-edit'
    case 'delete_file': return 'delete'
    case 'search_content': return 'search'
    case 'search_files': return 'find files'
    case 'search_symbols': return 'symbols'
    case 'get_codemap': return 'codemap'
    case 'explore_code': return 'explore'
    case 'web_search': return 'web'
    case 'run_command': return 'run'
    case 'create_task': return 'task'
    case 'create_tasks': return 'tasks'
    case 'update_task': return 'task update'
    case 'list_tasks': return 'list tasks'
    case 'create_checkpoint': return 'checkpoint'
    default: return name
  }
}

export function formatToolLabelForHistory(name: string, argsJson?: string): string {
  if (!argsJson) return name
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    const str = (key: string) => typeof args[key] === 'string' ? String(args[key]) : ''
    switch (name) {
      case 'read_file': return `Read ${str('path')}${formatRange(args)}`
      case 'read_file_full': return `Read full ${str('path')}`
      case 'list_directory': return `List ${str('path')}${args['recursive'] ? '/' : ''}`
      case 'write_file': return `Write ${str('path')}`
      case 'replace_file': return `Replace ${str('path')}`
      case 'edit_file': return `Edit ${str('path')}`
      case 'multi_edit': return `Edit ${str('path')}`
      case 'delete_file': return `Delete ${str('path')}`
      case 'search_content': return `Search "${(str('pattern') || str('query')).slice(0, 40)}"`
      case 'search_files': return `Find ${str('pattern') || str('glob')}`
      case 'search_symbols': return `Symbol ${str('query')}`
      case 'search_semantic': return `Semantic ${str('query')}`
      case 'get_codemap': return `CodeMap${str('path') ? ` ${str('path')}` : ''}`
      case 'explore_code': return `Explore "${(str('objective') || str('query')).slice(0, 56)}"`
      case 'web_search': return `Web "${str('query').slice(0, 56)}"`
      case 'run_command': return `Run ${str('command').slice(0, 60)}`
      case 'create_checkpoint': return 'Checkpoint'
      case 'create_task': return `Task: ${str('title')}`
      case 'create_tasks': return 'Create tasks'
      case 'update_task': return 'Update task'
      case 'list_tasks': return 'List tasks'
      case 'ask_user': return `Ask: ${str('question').slice(0, 50)}`
      case 'notify_user': return `Notify: ${str('message').slice(0, 50)}`
      case 'spawn_agent': return `Subagent: ${str('agent_type')}`
      default: return name
    }
  } catch {
    return name
  }
}

function formatRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === 'number' ? args.offset : 0
  const limit = typeof args.limit === 'number' ? args.limit : undefined
  if (!limit) return ''
  return `:${offset + 1}-${offset + limit}`
}

function ToolCallStatus({ tool, columns }: { tool: ToolStatus; columns: number }) {
  const theme = useTheme()
  const label = formatToolLabelForHistory(tool.name, tool.args)

  if (tool.status === 'running') {
    return <SpinnerGlyph lastActivity={tool.startTime} label={cliTruncate(label, columns - 12, { position: 'end' })} />
  }

  const duration = tool.startTime && tool.endTime
    ? formatDuration(tool.endTime - tool.startTime)
    : ''

  const statusType = tool.status === 'error' ? 'error' as const : 'success' as const
  const displayLabel = cliTruncate(label, columns - 16 - duration.length, { position: 'end' })

  return (
    <Text>
      <StatusIcon status={statusType} />
      <Text>{displayLabel}</Text>
      {duration && <Text color={theme.inactive}> {duration}</Text>}
    </Text>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}
