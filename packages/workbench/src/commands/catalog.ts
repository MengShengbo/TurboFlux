export type SharedCommandName = 'plan' | 'vibe' | 'git' | 'compact' | 'context' | 'mcp' | 'skills' | 'flow'
export type SharedDesktopCommandId = 'mode.vibe' | 'mode.plan' | 'context.open' | 'context.compact' | 'git.open' | 'mcp.open' | 'skills.open' | 'activity.open'

export interface SharedCommandCatalogItem {
  name: SharedCommandName
  aliases?: string[]
  argumentHint?: string
  showsProgress?: boolean | ((args: string) => boolean)
  desktopId: SharedDesktopCommandId
  desktopTitle: string
  desktopDetail: string
  desktopGroup: 'Run' | 'Workspace' | 'Capabilities' | 'Tools' | 'Conversation'
  keywords: string[]
}

export const SHARED_COMMAND_CATALOG: readonly SharedCommandCatalogItem[] = [
  { name: 'vibe', aliases: ['code'], showsProgress: true, desktopId: 'mode.vibe', desktopTitle: '切换到执行模式', desktopDetail: '直接执行并持续推进', desktopGroup: 'Run', keywords: ['execute', '执行'] },
  { name: 'plan', showsProgress: true, desktopId: 'mode.plan', desktopTitle: '切换到规划模式', desktopDetail: '先分析任务并制定计划', desktopGroup: 'Run', keywords: ['planning', '规划', '计划'] },
  { name: 'context', desktopId: 'context.open', desktopTitle: '查看上下文', desktopDetail: '检查用量、上下文片段和压缩状态', desktopGroup: 'Workspace', keywords: ['context', '上下文'] },
  { name: 'compact', showsProgress: true, desktopId: 'context.compact', desktopTitle: '压缩上下文', desktopDetail: '手动生成连续的工作摘要', desktopGroup: 'Workspace', keywords: ['compact', '压缩'] },
  { name: 'git', argumentHint: '[on|off|refresh]', showsProgress: args => Boolean(args.trim()), desktopId: 'git.open', desktopTitle: '查看 Git 状态', desktopDetail: '检查分支、变更、冲突和同步状态', desktopGroup: 'Workspace', keywords: ['branch', 'changes', '分支', '变更'] },
  { name: 'mcp', argumentHint: '[status|tools]', desktopId: 'mcp.open', desktopTitle: '管理 MCP', desktopDetail: '查看连接、工具和错误状态', desktopGroup: 'Capabilities', keywords: ['connector', 'tools', '连接器', '工具'] },
  { name: 'skills', desktopId: 'skills.open', desktopTitle: '管理插件', desktopDetail: '安装工作流、工具和集成', desktopGroup: 'Capabilities', keywords: ['work pack', 'skill', 'plugin', '技能', '插件'] },
  { name: 'flow', argumentHint: '[status|retry|export [path]]', showsProgress: args => /^(retry|export)(?:\s|$)/i.test(args.trim()), desktopId: 'activity.open', desktopTitle: '查看任务流状态', desktopDetail: '检查队列、后台任务、结果和恢复状态', desktopGroup: 'Workspace', keywords: ['queue', 'background', 'results', '队列', '后台', '结果'] },
]

export function getSharedCommand(name: SharedCommandName): SharedCommandCatalogItem {
  const command = SHARED_COMMAND_CATALOG.find(item => item.name === name)
  if (!command) throw new Error(`Shared command is not registered: ${name}`)
  return command
}

export function sharedCommandRegistration(name: SharedCommandName) {
  const command = getSharedCommand(name)
  return {
    name: command.name,
    aliases: command.aliases ? [...command.aliases] : undefined,
    argumentHint: command.argumentHint,
    showsProgress: command.showsProgress,
  }
}
