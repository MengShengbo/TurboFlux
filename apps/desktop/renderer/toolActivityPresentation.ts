import {
  Bell, BookOpen, Boxes, CircleHelp, FilePenLine, FileSearch, FileText, FolderOpen, GitBranch,
  Globe, ListChecks, Monitor, Puzzle, Search, Terminal, Wrench, createElement, type IconNode,
} from 'lucide'
import type { RetrievalResult, ToolCall, ToolResult } from '@turboflux/agent-core/renderer'

export type ToolActivityIconKind = 'file' | 'folder' | 'search' | 'file-search' | 'edit' | 'git' | 'terminal' | 'tasks' | 'question' | 'bell' | 'memory' | 'plugin' | 'agent' | 'web' | 'computer' | 'tool'

const ICONS: Record<ToolActivityIconKind, IconNode> = {
  file: FileText, folder: FolderOpen, search: Search, 'file-search': FileSearch, edit: FilePenLine,
  git: GitBranch, terminal: Terminal, tasks: ListChecks, question: CircleHelp, bell: Bell,
  memory: BookOpen, plugin: Puzzle, agent: Boxes, web: Globe, computer: Monitor, tool: Wrench,
}

export const TOOL_ACTIVITIES: Record<string, { title: string; icon: ToolActivityIconKind }> = {
  set_response_mode: { title: '选择处理方式', icon: 'tasks' },
  read_file: { title: '读取文件', icon: 'file' },
  read_file_full: { title: '读取文件', icon: 'file' },
  list_directory: { title: '查看目录', icon: 'folder' },
  search_files: { title: '查找文件', icon: 'file-search' },
  search_content: { title: '搜索内容', icon: 'search' },
  write_file: { title: '写入文件', icon: 'edit' },
  replace_file: { title: '替换文件内容', icon: 'edit' },
  edit_file: { title: '修改文件', icon: 'edit' },
  multi_edit: { title: '修改文件', icon: 'edit' },
  apply_patch: { title: '应用文件修改', icon: 'edit' },
  delete_file: { title: '删除文件', icon: 'edit' },
  web_search: { title: '搜索网页', icon: 'web' },
  web_fetch: { title: '阅读网页', icon: 'web' },
  tool_search: { title: '查找可用工具', icon: 'plugin' },
  list_memories: { title: '查阅记忆', icon: 'memory' },
  remember: { title: '保存记忆', icon: 'memory' },
  forget: { title: '移除记忆', icon: 'memory' },
  git_status: { title: '检查代码仓库', icon: 'git' },
  git_diff: { title: '查看代码差异', icon: 'git' },
  git_log: { title: '查看提交历史', icon: 'git' },
  git_show: { title: '查看提交内容', icon: 'git' },
  git_stage: { title: '暂存文件修改', icon: 'git' },
  git_commit: { title: '提交代码修改', icon: 'git' },
  git_restore: { title: '恢复文件内容', icon: 'git' },
  git_revert: { title: '撤销提交', icon: 'git' },
  git_create_branch: { title: '创建代码分支', icon: 'git' },
  git_switch_branch: { title: '切换代码分支', icon: 'git' },
  git_stash: { title: '管理暂存的工作', icon: 'git' },
  git_push: { title: '推送代码提交', icon: 'git' },
  run_command: { title: '运行命令', icon: 'terminal' },
  read_terminal: { title: '查看运行输出', icon: 'terminal' },
  write_terminal: { title: '向进程输入', icon: 'terminal' },
  kill_terminal: { title: '停止进程', icon: 'terminal' },
  list_terminals: { title: '查看运行中的进程', icon: 'terminal' },
  create_task: { title: '加入任务计划', icon: 'tasks' },
  create_tasks: { title: '建立任务计划', icon: 'tasks' },
  update_task: { title: '更新任务进度', icon: 'tasks' },
  add_task_dependency: { title: '关联任务顺序', icon: 'tasks' },
  remove_task_dependency: { title: '解除任务关联', icon: 'tasks' },
  list_tasks: { title: '查看任务计划', icon: 'tasks' },
  ask_user: { title: '等待你的答复', icon: 'question' },
  notify_user: { title: '发送通知', icon: 'bell' },
  use_skill: { title: '使用技能', icon: 'plugin' },
  present_workflow: { title: '等待方案选择', icon: 'question' },
  spawn_agent: { title: '分派任务', icon: 'agent' },
  list_agents: { title: '查看协作进度', icon: 'agent' },
  read_agent: { title: '查看协作结果', icon: 'agent' },
  cancel_agent: { title: '停止协作任务', icon: 'agent' },
  // Historical conversations can still contain retired operations.
  get_codemap: { title: '旧版目录扫描', icon: 'folder' },
  search_symbols: { title: '旧版声明检索', icon: 'search' },
}

export function toolActivityDefinition(name: string): { title: string; icon: ToolActivityIconKind } {
  if (TOOL_ACTIVITIES[name]) return TOOL_ACTIVITIES[name]
  if (name.startsWith('browser__')) return { title: '浏览网页', icon: 'web' }
  if (name.startsWith('computer__')) return { title: '操作电脑', icon: 'computer' }
  return { title: '执行扩展操作', icon: 'tool' }
}

export function toolActivityIcon(name: string): string {
  return createElement(ICONS[toolActivityDefinition(name).icon], { width: 16, height: 16, 'stroke-width': 1.7, 'aria-hidden': 'true' }).outerHTML
}

function compact(value: unknown, limit = 100): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

export function retrievalSummary(result: RetrievalResult): string {
  const resources = result.resources
  const scope = result.scope === '.' || !result.scope ? '当前工作区' : result.scope
  if (result.operation === 'read_file') {
    const file = resources[0]
    const range = file?.line ? ` · 第 ${file.line}${file.endLine && file.endLine !== file.line ? `-${file.endLine}` : ''} 行` : ' · 空读取结果'
    return `${scope}${range}${file?.textTruncated ? ' · 文本不完整' : ''}`
  }
  const partial = result.truncated ? result.totalIsExact === false || result.nextOffset === undefined ? ' · 扫描未完成' : ' · 还有结果' : ''
  if (result.operation === 'list_directory') {
    const files = resources.filter(resource => resource.kind === 'file').length
    return `${scope} · ${resources.length - files} 个目录、${files} 个文件${partial}`
  }
  const query = compact(result.query, 64)
  const fileCount = new Set(resources.map(resource => resource.path)).size
  const outcome = resources.length === 0
    ? result.truncated ? '当前未返回匹配' : '当前页无匹配'
    : result.outputMode === 'content' ? `${resources.length} 处匹配，涉及 ${fileCount} 个文件` : `${fileCount} 个文件`
  return `${query ? `“${query}” · ` : ''}${outcome}${partial}`
}

export function toolActivitySummary(call: ToolCall, result?: ToolResult): string {
  if (result?.isError) {
    if (result.errorKind === 'abort') return '已停止'
    if (call.name === 'git_status' && /not a .*Git repository|not a git repository|Git.*unavailable/i.test(result.output)) return '当前工作区不是可用的 Git 仓库'
    const label = { validation: '参数有误', permission: '访问未获允许', environment: '运行条件不满足', execution: '执行失败', timeout: '执行超时', abort: '已停止' }[result.errorKind || 'execution']
    return label
  }
  if (result?.retrieval) return retrievalSummary(result.retrieval)
  if (result?.data?.kind === 'command') {
    const command = compact(result.data.command || call.arguments.command, 72)
    const state = result.data.timedOut ? '执行超时' : result.data.exitCode !== undefined ? `退出码 ${result.data.exitCode}`
      : result.data.status === 'running' ? '运行中' : result.data.status === 'completed' ? '已完成' : ''
    return [command, state].filter(Boolean).join(' · ')
  }
  if (result?.data?.kind === 'repository') {
    const snapshot = result.data.snapshot
    return `${snapshot.branch || '分离的 HEAD'} · ${snapshot.clean ? '没有未提交的修改' : `${snapshot.files.length} 个文件有改动`}`
  }
  if (result?.data?.kind === 'web_search') return `${compact(call.arguments.query, 64)} · ${result.data.response.results.length} 个来源${result.data.response.partial ? ' · 部分搜索未完成' : ''}`
  if (result?.data?.kind === 'web_fetch') return `${result.data.response.pages.length} 个网页${result.data.response.failures.length ? ` · ${result.data.response.failures.length} 个未能读取` : ''}`
  if (result?.data?.kind === 'items') return `${result.data.items.length} 项${call.arguments.query ? ` · ${compact(call.arguments.query)}` : ''}`
  if (result?.changeSummary) return `${result.changeSummary.path} · +${result.changeSummary.addedLines ?? 0} / -${result.changeSummary.removedLines ?? 0}`
  const query = compact(call.arguments.pattern || call.arguments.query)
  const path = compact(call.arguments.path || call.arguments.file_path)
  if (query) return `${query}${path && path !== '.' ? ` · ${path}` : ''}`
  return compact(call.arguments.command || call.arguments.display_detail) || path || compact(call.arguments.url || call.arguments.title) || (result ? '已完成' : '执行中')
}
