import { getSharedCommand, type SharedCommandName } from '../commands/catalog'
import type { WorkbenchCommandDefinition } from './types'

function desktopCommand(name: SharedCommandName): WorkbenchCommandDefinition {
  const command = getSharedCommand(name)
  return {
    id: command.desktopId,
    slash: `/${command.name}`,
    title: command.desktopTitle,
    detail: command.desktopDetail,
    group: command.desktopGroup,
    keywords: [command.name, `/${command.name}`, ...(command.aliases || []), ...command.keywords],
  }
}

export const WORKBENCH_COMMANDS: WorkbenchCommandDefinition[] = [
  desktopCommand('vibe'),
  desktopCommand('plan'),
  { id: 'run.pause', title: '暂停当前任务', detail: '保留当前状态，稍后继续', group: 'Run', keywords: ['pause', '暂停'] },
  { id: 'run.resume', title: '继续当前任务', detail: '从暂停状态继续执行', group: 'Run', keywords: ['resume', '继续'] },
  { id: 'run.stop', title: '停止当前任务', detail: '停止当前智能代理运行', group: 'Run', keywords: ['stop', '停止'] },
  desktopCommand('context'),
  desktopCommand('compact'),
  desktopCommand('git'),
  { id: 'git.refresh', slash: '/git refresh', title: '刷新 Git 状态', detail: '重新读取当前仓库状态', group: 'Workspace', keywords: ['git refresh', '刷新'] },
  { id: 'activity.open', title: '查看任务活动', detail: '查看任务步骤、并行工作、队列和结果', group: 'Workspace', keywords: ['task', 'ps', 'flow', 'subagent', '任务'] },
  desktopCommand('mcp'),
  desktopCommand('skills'),
  { id: 'conversation.new', title: '新建任务', detail: '创建一个新的工作对话', group: 'Conversation', keywords: ['new', '新建'], shortcut: '⌘ N' },
  desktopCommand('flow'),
  { id: 'flow.retry', slash: '/flow retry', title: '重试保存对话', detail: '恢复持久化并再次保存当前状态', group: 'Conversation', keywords: ['flow retry', '恢复', '重试'] },
  { id: 'flow.export', slash: '/flow export', title: '导出恢复包', detail: '导出当前对话和未保存的数据', group: 'Conversation', keywords: ['flow export', '导出恢复'] },
]

export function listWorkbenchCommands(): WorkbenchCommandDefinition[] {
  return WORKBENCH_COMMANDS.map(command => ({ ...command, keywords: [...command.keywords] }))
}
