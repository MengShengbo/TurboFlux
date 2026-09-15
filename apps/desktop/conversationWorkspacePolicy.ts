import { isUnboundWorkspacePath } from '@turboflux/agent-core/workbench'

export function assertExecutableConversationWorkspace(workspacePath: string): void {
  if (isUnboundWorkspacePath(workspacePath)) {
    throw new Error('此历史会话的工作区尚未绑定。请先在资料中心选择本机文件夹并确认绑定，再继续执行。')
  }
}
