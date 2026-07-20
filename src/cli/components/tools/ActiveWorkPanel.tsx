import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import cliTruncate from 'cli-truncate'
import { useTheme } from '../../theme/index'
import { useTerminalSize } from '../../hooks/useTerminalSize'
import { formatMarkdown } from '../markdown/index'
import { SpinnerGlyph } from '../spinner/SpinnerGlyph'
import { StatusIcon } from '../design-system/StatusIcon'
import type { ToolStatus } from './ToolCallTree'
import type { AgentRunState } from '../../../shared/agentTypes'

export type StreamingToolDraft = {
  id: string
  name: string
  partialJson: string
  startedAt: number
  updatedAt: number
}

type WorkGroupKind = 'explore' | 'file' | 'run' | 'other'

interface ActiveWorkPanelProps {
  tools: ToolStatus[]
  draft: StreamingToolDraft | null
  streamText: string
  outputTokens?: number
  lastActivity: number
  runState?: AgentRunState
  queuedCount?: number
  verbose: boolean
  idleLabel?: string | null
}

interface WorkGroup {
  kind: WorkGroupKind
  title: string
  tools: ToolStatus[]
}

const FILE_TOOLS = new Set(['write_file', 'replace_file', 'edit_file', 'multi_edit', 'delete_file'])
const EXPLORE_TOOLS = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'search_symbols',
  'search_semantic',
  'get_codemap',
  'explore_code',
  'web_search',
])
const RUN_TOOLS = new Set(['run_command'])

export function ActiveWorkPanel({
  tools,
  draft,
  streamText,
  outputTokens = 0,
  lastActivity,
  runState,
  queuedCount = 0,
  verbose,
  idleLabel = 'Thinking...',
}: ActiveWorkPanelProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!runState || runState.phase === 'idle' || runState.phase === 'completed') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runState?.phase])
  const activeTools = tools.filter(tool => tool.status === 'running')
  const groups = buildWorkGroups(tools, verbose)
  const primary = getPrimaryWorkLabel(activeTools, draft)
  const primaryKind = getPrimaryWorkKind(activeTools, draft)
  const secondaryGroups = groups.filter(group => {
    if (verbose) return true
    if (group.kind !== primaryKind) return true
    return !group.tools.some(tool => tool.status === 'running')
  })
  const hasWork = Boolean(primary) || groups.length > 0

  if (!hasWork && !streamText && !idleLabel) return null

  const labelWidth = Math.max(24, columns - 14)

  return (
    <Box flexDirection="column" marginBottom={1}>
      {runState && runState.phase !== 'idle' && (
        <RunStateLine state={runState} now={now} queuedCount={queuedCount} />
      )}
      {primary ? (
        <Box>
          <Text color={theme.inactive}>Work </Text>
          <SpinnerGlyph lastActivity={getPrimaryActivity(activeTools, draft, lastActivity)} label={cliTruncate(primary, labelWidth, { position: 'middle' })} />
          <TurnTokenCounter tokens={outputTokens} />
        </Box>
      ) : idleLabel && !streamText ? (
        <Box>
          <Text color={theme.inactive}>Work </Text>
          <SpinnerGlyph lastActivity={lastActivity} label={idleLabel} />
          <TurnTokenCounter tokens={outputTokens} />
        </Box>
      ) : null}

      {secondaryGroups.map(group => (
        <WorkGroupLine key={group.kind} group={group} columns={columns} />
      ))}

      {streamText && (
        <Box marginTop={hasWork ? 1 : 0}>
          <Text>{formatMarkdown(streamText)}</Text>
        </Box>
      )}
    </Box>
  )
}

function RunStateLine({ state, now, queuedCount }: { state: AgentRunState; now: number; queuedCount: number }) {
  const theme = useTheme()
  const labels: Record<AgentRunState['phase'], { label: string; color: string }> = {
    idle: { label: 'READY', color: theme.inactive },
    thinking: { label: 'THINKING', color: theme.brandShimmer },
    tool_running: { label: 'RUNNING', color: theme.brand },
    awaiting_approval: { label: 'REVIEW', color: theme.warning },
    awaiting_input: { label: 'WAITING', color: theme.warning },
    paused: { label: 'PAUSED', color: theme.warning },
    aborting: { label: 'STOPPING', color: theme.error },
    recoverable_error: { label: 'RECOVERABLE', color: theme.error },
    completed: { label: 'DONE', color: theme.success },
  }
  const current = labels[state.phase]
  const elapsed = state.startedAt ? formatElapsed(Math.max(0, now - state.startedAt)) : ''
  const detail = state.detail || ''
  return (
    <Box>
      <Text color={current.color} bold>{`● ${current.label}`}</Text>
      {elapsed && <Text color={theme.inactive}>{`  ${elapsed}`}</Text>}
      {detail && <Text color={theme.text}>{`  ${cliTruncate(detail, 58, { position: 'end' })}`}</Text>}
      {queuedCount > 0 && <Text color={theme.inactive}>{`  · ${queuedCount} queued`}</Text>}
    </Box>
  )
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function TurnTokenCounter({ tokens }: { tokens: number }) {
  const theme = useTheme()
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  return (
    <Text color={theme.success}>
      {` +token${formatTokenCount(tokens)}`}
    </Text>
  )
}

function formatTokenCount(value: number): string {
  const rounded = Math.max(0, Math.floor(value))
  return rounded.toLocaleString()
}

function WorkGroupLine({ group, columns }: { group: WorkGroup; columns: number }) {
  const theme = useTheme()
  const running = group.tools.filter(tool => tool.status === 'running')
  const failed = group.tools.filter(tool => tool.status === 'error')
  const latest = [...group.tools].reverse().find(tool => tool.status === 'running') ?? group.tools[group.tools.length - 1]
  const label = latest ? formatToolLabel(latest.name, latest.args) : group.title
  const summary = summarizeGroup(group, running.length, failed.length)
  const display = cliTruncate(`${summary} - ${label}`, Math.max(20, columns - 14), { position: 'middle' })

  return (
    <Box>
      <Text color={theme.inactive}>{group.title.padEnd(7, ' ')} </Text>
      {running.length > 0 ? (
        <SpinnerGlyph lastActivity={latest?.startTime} label={display} />
      ) : (
        <Text>
          <StatusIcon status={failed.length > 0 ? 'error' : 'success'} />
          <Text>{display}</Text>
        </Text>
      )}
    </Box>
  )
}

function buildWorkGroups(tools: ToolStatus[], verbose: boolean): WorkGroup[] {
  const groups: WorkGroup[] = []
  const explore = tools.filter(tool => EXPLORE_TOOLS.has(tool.name) && shouldKeepToolInActiveGroup(tool, verbose))
  const file = tools.filter(tool => FILE_TOOLS.has(tool.name) && shouldKeepToolInActiveGroup(tool, verbose))
  const run = tools.filter(tool => RUN_TOOLS.has(tool.name) && shouldKeepToolInActiveGroup(tool, verbose))
  const other = tools.filter(tool =>
    !EXPLORE_TOOLS.has(tool.name) &&
    !FILE_TOOLS.has(tool.name) &&
    !RUN_TOOLS.has(tool.name) &&
    shouldKeepToolInActiveGroup(tool, verbose)
  )

  if (explore.length > 0) groups.push({ kind: 'explore', title: 'Explore', tools: explore })
  if (file.length > 0) groups.push({ kind: 'file', title: 'Files', tools: file })
  if (run.length > 0) groups.push({ kind: 'run', title: 'Shell', tools: run })
  if (other.length > 0) groups.push({ kind: 'other', title: 'Tools', tools: other })
  return groups
}

function shouldKeepToolInActiveGroup(tool: ToolStatus, verbose: boolean): boolean {
  if (verbose) return true
  if (tool.status === 'running' || tool.status === 'error') return true
  if (EXPLORE_TOOLS.has(tool.name)) return true
  return FILE_TOOLS.has(tool.name) || RUN_TOOLS.has(tool.name)
}

function getPrimaryWorkLabel(activeTools: ToolStatus[], draft: StreamingToolDraft | null): string {
  if (draft) return formatDraftLabel(draft)

  const activeFile = [...activeTools].reverse().find(tool => FILE_TOOLS.has(tool.name))
  if (activeFile) return formatRunningLabel(activeFile)

  const activeRun = [...activeTools].reverse().find(tool => RUN_TOOLS.has(tool.name))
  if (activeRun) return formatRunningLabel(activeRun)

  const activeExplore = [...activeTools].reverse().find(tool => EXPLORE_TOOLS.has(tool.name))
  if (activeExplore) return formatRunningLabel(activeExplore)

  const activeOther = activeTools[activeTools.length - 1]
  return activeOther ? formatRunningLabel(activeOther) : ''
}

function getPrimaryWorkKind(activeTools: ToolStatus[], draft: StreamingToolDraft | null): WorkGroupKind | null {
  if (draft) {
    if (FILE_TOOLS.has(draft.name)) return 'file'
    if (RUN_TOOLS.has(draft.name)) return 'run'
    if (EXPLORE_TOOLS.has(draft.name)) return 'explore'
    return 'other'
  }
  const active = [...activeTools].reverse().find(tool => FILE_TOOLS.has(tool.name))
    ?? [...activeTools].reverse().find(tool => RUN_TOOLS.has(tool.name))
    ?? [...activeTools].reverse().find(tool => EXPLORE_TOOLS.has(tool.name))
    ?? activeTools[activeTools.length - 1]
  if (!active) return null
  if (FILE_TOOLS.has(active.name)) return 'file'
  if (RUN_TOOLS.has(active.name)) return 'run'
  if (EXPLORE_TOOLS.has(active.name)) return 'explore'
  return 'other'
}

function getPrimaryActivity(activeTools: ToolStatus[], draft: StreamingToolDraft | null, fallback: number): number {
  if (draft) return draft.updatedAt
  const active = activeTools[activeTools.length - 1]
  return active?.startTime ?? fallback
}

function formatDraftLabel(draft: StreamingToolDraft): string {
  const path = getPathFromPartialJson(draft.partialJson)
  const noun = formatToolName(draft.name)
  const generated = formatBytes(draft.partialJson.length)
  if (FILE_TOOLS.has(draft.name)) {
    return path ? `Preparing ${noun} ${path} - ${generated} args` : `Preparing ${noun} - ${generated} args`
  }
  return `Preparing ${noun} - ${generated} args`
}

function formatRunningLabel(tool: ToolStatus): string {
  const label = formatToolLabel(tool.name, tool.args)
  const prefix = getRunningPrefix(tool.name)
  if (prefix) {
    const subject = label.replace(/^(Read full|Read|List|Write|Replace|Edit|Delete|Search|Find|Symbol|Semantic|CodeMap|Explore|Web|Run)\s*/, '')
    return subject ? `${prefix} ${subject}` : prefix
  }
  if (FILE_TOOLS.has(tool.name)) return label.replace(/^(Write|Replace|Edit|Delete)/, match => getRunningVerb(match))
  if (RUN_TOOLS.has(tool.name)) return label.replace(/^Run /, 'Running ')
  if (EXPLORE_TOOLS.has(tool.name)) return label.replace(/^(Read|Search|Find|Symbol|Semantic|CodeMap|List)/, match => `${match}ing`)
  return `Using ${label}`
}

function getRunningPrefix(name: string): string {
  switch (name) {
    case 'read_file': return 'Reading'
    case 'read_file_full': return 'Reading full'
    case 'list_directory': return 'Listing'
    case 'search_content': return 'Searching'
    case 'search_files': return 'Finding'
    case 'search_symbols': return 'Indexing symbols'
    case 'search_semantic': return 'Searching semantically'
    case 'get_codemap': return 'Mapping code'
    case 'explore_code': return 'Exploring'
    case 'web_search': return 'Searching web'
    case 'write_file': return 'Writing'
    case 'replace_file': return 'Replacing'
    case 'edit_file': return 'Editing'
    case 'multi_edit': return 'Applying edits to'
    case 'delete_file': return 'Deleting'
    case 'run_command': return 'Running'
    default: return ''
  }
}

function getRunningVerb(base: string): string {
  switch (base) {
    case 'Write': return 'Writing'
    case 'Replace': return 'Replacing'
    case 'Delete': return 'Deleting'
    default: return `${base}ing`
  }
}

function summarizeGroup(group: WorkGroup, running: number, failed: number): string {
  const total = group.tools.length
  const done = group.tools.filter(tool => tool.status === 'done').length
  if (failed > 0) return `${done}/${total} done, ${failed} failed`
  if (running > 0) return `${running} running, ${done}/${total} done`
  return `${total} complete`
}

function formatToolLabel(name: string, argsJson?: string): string {
  const args = parseArgs(argsJson)
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
    case 'run_command': return `Run ${str('command').slice(0, 80)}`
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
    case 'web_search': return 'web search'
    case 'run_command': return 'run'
    default: return name
  }
}

function parseArgs(argsJson?: string): Record<string, unknown> {
  if (!argsJson) return {}
  try {
    return JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === 'number' ? args.offset : 0
  const limit = typeof args.limit === 'number' ? args.limit : undefined
  if (!limit) return ''
  return `:${offset + 1}-${offset + limit}`
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
