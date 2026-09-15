import type { WorkbenchSnapshot } from '@turboflux/agent-core/workbench'

type Conversation = WorkbenchSnapshot['conversationCatalog'][number]
type Project = WorkbenchSnapshot['projects']['projects'][number]

export const UNGROUPED_WORKSPACE_KEY = 'ungrouped'

export interface WorkspaceConversationGroup {
  key: string
  projectId?: string
  name: string
  path?: string
  containsCurrent: boolean
  conversations: Conversation[]
}

function normalizedPath(path: string, platform: NodeJS.Platform): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function byRecency(left: Conversation, right: Conversation): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

export function projectWorkspaceConversationGroups(input: {
  conversations: readonly Conversation[]
  projects: readonly Project[]
  currentConversationId: string
  platform: NodeJS.Platform
  query?: string
}): WorkspaceConversationGroup[] {
  const query = input.query?.trim().toLocaleLowerCase() || ''
  const conversationsByPath = new Map<string, Conversation[]>()
  for (const conversation of input.conversations.filter(conversation => conversation.turnCount > 0)) {
    const key = normalizedPath(conversation.workspacePath, input.platform)
    const bucket = conversationsByPath.get(key) || []
    bucket.push(conversation)
    conversationsByPath.set(key, bucket)
  }

  const groups: WorkspaceConversationGroup[] = []
  const registeredPaths = new Set<string>()
  for (const project of input.projects) {
    const pathKey = normalizedPath(project.path, input.platform)
    if (registeredPaths.has(pathKey)) continue
    registeredPaths.add(pathKey)
    const conversations = [...(conversationsByPath.get(pathKey) || [])].sort(byRecency)
    if (conversations.length === 0) continue
    const visible = query === '' || project.name.toLocaleLowerCase().includes(query)
      ? conversations
      : conversations.filter(conversation => conversation.title.toLocaleLowerCase().includes(query))
    if (query !== '' && visible.length === 0 && !project.name.toLocaleLowerCase().includes(query)) continue
    groups.push({
      key: project.id,
      projectId: project.id,
      name: project.name,
      path: project.path,
      containsCurrent: conversations.some(conversation => conversation.id === input.currentConversationId),
      conversations: visible,
    })
  }

  const ungrouped = input.conversations
    .filter(conversation => conversation.turnCount > 0 && !registeredPaths.has(normalizedPath(conversation.workspacePath, input.platform)))
    .sort(byRecency)
  const visibleUngrouped = query === ''
    ? ungrouped
    : ungrouped.filter(conversation => conversation.title.toLocaleLowerCase().includes(query))
  if (visibleUngrouped.length > 0) {
    groups.push({
      key: UNGROUPED_WORKSPACE_KEY,
      name: '未分组',
      containsCurrent: ungrouped.some(conversation => conversation.id === input.currentConversationId),
      conversations: visibleUngrouped,
    })
  }
  return groups.sort((left, right) => {
    if (left.containsCurrent !== right.containsCurrent) return left.containsCurrent ? -1 : 1
    if (left.key === UNGROUPED_WORKSPACE_KEY) return 1
    if (right.key === UNGROUPED_WORKSPACE_KEY) return -1
    return (right.conversations[0]?.updatedAt || 0) - (left.conversations[0]?.updatedAt || 0)
      || left.name.localeCompare(right.name)
  })
}
