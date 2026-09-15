import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '@turboflux/agent-core/workbench'
import { projectWorkspaceConversationGroups, UNGROUPED_WORKSPACE_KEY } from './workspaceConversationProjection'

type Conversation = WorkbenchSnapshot['conversationCatalog'][number]
type Project = WorkbenchSnapshot['projects']['projects'][number]

function conversation(id: string, workspacePath: string, updatedAt: number): Conversation {
  return {
    id,
    title: id,
    workspacePath,
    createdAt: updatedAt,
    updatedAt,
    mode: 'vibe',
    model: 'model',
    provider: 'provider',
    turnCount: 2,
  }
}

function project(id: string, path: string, name = id): Project {
  return {
    id,
    name,
    path,
    pinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    available: true,
  }
}

describe('workspace conversation projection', () => {
  it('uses registered projects as stable groups and sorts tasks by recency', () => {
    const groups = projectWorkspaceConversationGroups({
      conversations: [
        conversation('older', '/work/alpha', 1),
        conversation('newer', '/work/alpha/', 3),
        conversation('beta-task', '/work/beta', 2),
      ],
      projects: [project('alpha-id', '/work/alpha', 'Alpha'), project('beta-id', '/work/beta', 'Beta')],
      currentConversationId: 'newer',
      platform: 'darwin',
    })

    expect(groups.map(group => group.key)).toEqual(['alpha-id', 'beta-id'])
    expect(groups[0]?.conversations.map(item => item.id)).toEqual(['newer', 'older'])
    expect(groups[0]?.containsCurrent).toBe(true)
  })

  it('places conversations outside registered projects into Ungrouped', () => {
    const groups = projectWorkspaceConversationGroups({
      conversations: [conversation('loose', '/removed/workspace', 2)],
      projects: [project('alpha-id', '/work/alpha', 'Alpha')],
      currentConversationId: 'loose',
      platform: 'darwin',
    })

    expect(groups.map(group => group.key)).toEqual([UNGROUPED_WORKSPACE_KEY])
    expect(groups[0]).toMatchObject({ name: '未分组', containsCurrent: true })
  })

  it('matches Windows paths case-insensitively and removes duplicate registrations', () => {
    const groups = projectWorkspaceConversationGroups({
      conversations: [conversation('task', 'C:\\Work\\Alpha', 1)],
      projects: [project('first', 'c:/work/alpha'), project('duplicate', 'C:\\Work\\Alpha\\')],
      currentConversationId: 'task',
      platform: 'win32',
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.conversations.map(item => item.id)).toEqual(['task'])
  })

  it('searches workspace names and task titles without flattening groups', () => {
    const task = conversation('task', '/work/alpha', 1)
    task.title = 'Fix streaming'
    const groups = projectWorkspaceConversationGroups({
      conversations: [task, conversation('other', '/work/beta', 2)],
      projects: [project('alpha', '/work/alpha', 'Desktop'), project('beta', '/work/beta', 'Website')],
      currentConversationId: 'task',
      platform: 'darwin',
      query: 'stream',
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Desktop')
    expect(groups[0]?.conversations.map(item => item.id)).toEqual(['task'])
  })

  it('keeps empty tasks and workspaces out of the navigation tree', () => {
    const empty = conversation('empty', '/work/empty', 4)
    empty.turnCount = 0
    const groups = projectWorkspaceConversationGroups({
      conversations: [empty, conversation('active', '/work/active', 3)],
      projects: [project('empty-project', '/work/empty', 'Empty'), project('active-project', '/work/active', 'Active')],
      currentConversationId: 'empty',
      platform: 'darwin',
    })

    expect(groups.map(group => group.name)).toEqual(['Active'])
  })

  it('places the current workspace first and Ungrouped last', () => {
    const groups = projectWorkspaceConversationGroups({
      conversations: [
        conversation('older-current', '/work/current', 1),
        conversation('newer', '/work/newer', 5),
        conversation('loose', '/work/loose', 9),
      ],
      projects: [project('current', '/work/current', 'Current'), project('newer', '/work/newer', 'Newer')],
      currentConversationId: 'older-current',
      platform: 'darwin',
    })

    expect(groups.map(group => group.name)).toEqual(['Current', 'Newer', '未分组'])
  })
})
