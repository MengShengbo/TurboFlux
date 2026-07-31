import type { StreamingToolDraft, ToolStatus } from './toolTypes'
import { createTranslator, type Translator } from '../../i18n/index'

export type ToolActivityKind = 'read' | 'edit' | 'run' | 'git' | 'tool'

const READ_TOOLS = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'search_symbols',
  'search_symbol',
  'search_semantic',
  'get_codemap',
  'web_search',
])

const EDIT_TOOLS = new Set(['write_file', 'replace_file', 'edit_file', 'multi_edit', 'delete_file'])
const DEFAULT_TRANSLATOR = createTranslator('en')

export function getToolActivityKind(name: string): ToolActivityKind {
  if (READ_TOOLS.has(name)) return 'read'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (name === 'run_command') return 'run'
  if (name.startsWith('git_')) return 'git'
  return 'tool'
}

export function formatToolLabel(name: string, argsJson?: string, t: Translator = DEFAULT_TRANSLATOR): string {
  const args = parseToolArgs(argsJson)
  const str = (key: string) => typeof args[key] === 'string' ? String(args[key]) : ''
  switch (name) {
    case 'read_file': return t('ui.tool.read', { target: `${str('path')}${formatRange(args)}` })
    case 'read_file_full': return t('ui.tool.readFull', { target: str('path') })
    case 'list_directory': return t('ui.tool.list', { target: `${str('path')}${args.recursive ? '/' : ''}` })
    case 'write_file': return t('ui.tool.write', { target: str('path') })
    case 'replace_file': return t('ui.tool.replace', { target: str('path') })
    case 'edit_file':
    case 'multi_edit': return t('ui.tool.edit', { target: str('path') })
    case 'delete_file': return t('ui.tool.delete', { target: str('path') })
    case 'search_content': return t('ui.tool.search', { target: (str('pattern') || str('query')).slice(0, 80) })
    case 'search_files': return t('ui.tool.find', { target: str('pattern') || str('glob') })
    case 'search_symbols': return t('ui.tool.symbol', { target: str('query') })
    case 'search_semantic': return t('ui.tool.semantic', { target: str('query') })
    case 'get_codemap': return t('ui.tool.codemap', { target: str('path') ? ` ${str('path')}` : '' })
    case 'web_search': return t('ui.tool.web', { target: str('query').slice(0, 80) })
    case 'run_command': return t('ui.tool.run', { target: str('command') })
    case 'git_status': return t('ui.tool.gitStatus')
    case 'git_diff': return t('ui.tool.gitDiff', { target: `${str('scope') ? ` (${str('scope')})` : ''}${str('path') ? ` ${str('path')}` : ''}` })
    case 'git_log': return t('ui.tool.gitLog', { target: str('path') ? ` ${str('path')}` : '' })
    case 'git_show': return t('ui.tool.gitShow', { target: str('revision') })
    case 'git_stage': return t('ui.tool.gitStage')
    case 'git_commit': return t('ui.tool.gitCommit', { target: str('message') })
    case 'git_restore': return t('ui.tool.gitRestore', { target: str('source') || 'HEAD' })
    case 'git_revert': return t('ui.tool.gitRevert', { target: str('revision') })
    case 'git_create_branch': return t('ui.tool.gitBranch', { target: str('name') })
    case 'git_switch_branch': return t('ui.tool.gitSwitch', { target: str('name') })
    case 'git_stash': return t('ui.tool.gitStash', { target: str('action') })
    case 'git_push': return t('ui.tool.gitPush', { target: `${str('remote') || 'origin'}${str('branch') ? `/${str('branch')}` : ''}` })
    case 'create_task': return t('ui.tool.task', { target: str('title') })
    case 'create_tasks': return t('ui.tool.createTasks')
    case 'update_task': return t('ui.tool.updateTask')
    case 'list_tasks': return t('ui.tool.listTasks')
    case 'ask_user': return t('ui.tool.ask', { target: str('question') })
    case 'notify_user': return t('ui.tool.notify', { target: str('message') })
    case 'spawn_agent': return t('ui.tool.subagent', { target: str('agent_type') })
    default: return humanizeToolName(name)
  }
}

export function formatRunningToolLabel(tool: Pick<ToolStatus, 'name' | 'args'>, t: Translator = DEFAULT_TRANSLATOR): string {
  const args = parseToolArgs(tool.args)
  const str = (key: string) => typeof args[key] === 'string' ? String(args[key]) : ''
  switch (tool.name) {
    case 'read_file': return t('ui.tool.running.read', { target: `${str('path')}${formatRange(args)}` })
    case 'read_file_full': return t('ui.tool.running.readFull', { target: str('path') })
    case 'list_directory': return t('ui.tool.running.list', { target: `${str('path')}${args.recursive ? '/' : ''}` })
    case 'write_file': return t('ui.tool.running.write', { target: str('path') })
    case 'replace_file': return t('ui.tool.running.replace', { target: str('path') })
    case 'edit_file':
    case 'multi_edit': return t('ui.tool.running.edit', { target: str('path') })
    case 'delete_file': return t('ui.tool.running.delete', { target: str('path') })
    case 'search_content': return t('ui.tool.running.search', { target: str('pattern') || str('query') })
    case 'search_files': return t('ui.tool.running.find', { target: str('pattern') || str('glob') })
    case 'search_symbols': return t('ui.tool.running.symbol', { target: str('query') })
    case 'search_semantic': return t('ui.tool.running.semantic', { target: str('query') })
    case 'get_codemap': return t('ui.tool.running.codemap', { target: str('path') ? ` ${str('path')}` : '' })
    case 'web_search': return t('ui.tool.running.web', { target: str('query') })
    case 'run_command': return t('ui.tool.running.run', { target: str('command') })
    default: return t('ui.tool.running.default', { target: formatToolLabel(tool.name, tool.args, t) })
  }
}

export function formatDraftToolLabel(draft: StreamingToolDraft, t: Translator = DEFAULT_TRANSLATOR): string {
  const args = parsePartialToolArgs(draft.partialJson)
  const path = typeof args.path === 'string' ? args.path : ''
  const base = formatDraftToolName(draft.name, t)
  return path ? t('ui.tool.preparingPath', { tool: base, path }) : t('ui.tool.preparing', { tool: base })
}

function formatDraftToolName(name: string, t: Translator): string {
  if (name === 'read_file') return t('ui.tool.name.readFile')
  if (name === 'read_file_full') return t('ui.tool.name.readFull')
  if (name === 'list_directory') return t('ui.tool.name.listDirectory')
  if (name === 'write_file') return t('ui.tool.name.writeFile')
  if (name === 'replace_file') return t('ui.tool.name.replaceFile')
  if (name === 'edit_file') return t('ui.tool.name.editFile')
  if (name === 'multi_edit') return t('ui.tool.name.multiEdit')
  if (name === 'delete_file') return t('ui.tool.name.deleteFile')
  if (name === 'search_content') return t('ui.tool.name.searchContent')
  if (name === 'search_files') return t('ui.tool.name.searchFiles')
  if (name === 'search_symbols') return t('ui.tool.name.searchSymbols')
  if (name === 'search_semantic') return t('ui.tool.name.searchSemantic')
  if (name === 'get_codemap') return t('ui.tool.name.codemap')
  if (name === 'web_search') return t('ui.tool.name.webSearch')
  if (name === 'run_command') return t('ui.tool.name.runCommand')
  return humanizeToolName(name)
}

export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

export function parseToolArgs(value?: string): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parsePartialToolArgs(value: string): Record<string, unknown> {
  const parsed = parseToolArgs(value)
  if (Object.keys(parsed).length > 0) return parsed
  const match = value.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (!match) return {}
  try {
    return { path: JSON.parse(`"${match[1]}"`) }
  } catch {
    return { path: match[1] || '' }
  }
}

function formatRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === 'number' ? args.offset : 0
  const limit = typeof args.limit === 'number' ? args.limit : undefined
  return limit ? `:${offset + 1}-${offset + limit}` : ''
}

function humanizeToolName(name: string): string {
  return name.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase())
}
