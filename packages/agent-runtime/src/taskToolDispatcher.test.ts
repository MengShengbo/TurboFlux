import { describe, expect, it, vi } from 'vitest'
import { TaskManager } from './taskManager'
import { dispatchTaskTool, type TaskSystemCreationEvent } from './taskToolDispatcher'

function createContext() {
  const taskManager = new TaskManager()
  const creations: Array<TaskSystemCreationEvent | null | undefined> = []
  const emitActiveTask = vi.fn()
  return {
    taskManager,
    creations,
    emitActiveTask,
    emitTaskSystem: (creation?: TaskSystemCreationEvent | null) => creations.push(creation),
  }
}

describe('task tool dispatcher', () => {
  it('creates a dependency-aware task tree and reports lifecycle events', () => {
    const context = createContext()
    const root = JSON.parse(dispatchTaskTool('create_task', {
      title: 'Root',
      description: 'Root task',
      priority: 'major',
    }, context)!) as { id: string }

    const result = JSON.parse(dispatchTaskTool('create_tasks', {
      tasks: [{
        ref: 'child',
        title: 'Child',
        description: 'Child task',
        priority: 'medium',
        parent_id: root.id,
      }],
    }, context)!) as { created: Array<{ id: string }> }

    expect(result.created[0]?.id).toBeTruthy()
    expect(context.taskManager.getChildTasks(root.id)).toHaveLength(1)
    expect(context.creations.map(event => event?.status)).toEqual([
      'creating',
      'completed',
      'planning',
      'creating',
      'completed',
    ])
    expect(context.emitActiveTask).toHaveBeenCalledTimes(2)
  })

  it('keeps task guards and returns undefined for non-task tools', () => {
    const context = createContext()
    const root = JSON.parse(dispatchTaskTool('create_task', {
      title: 'Root',
      description: 'Root task',
      priority: 'major',
    }, context)!) as { id: string }
    const child = JSON.parse(dispatchTaskTool('create_task', {
      title: 'Child',
      description: 'Child task',
      priority: 'medium',
      parent_id: root.id,
    }, context)!) as { id: string }

    expect(dispatchTaskTool('update_task', {
      task_id: root.id,
      status: 'completed',
    }, context)).toContain('child task(s) remain unfinished')
    expect(dispatchTaskTool('update_task', {
      task_id: child.id,
      status: 'completed',
    }, context)).toContain('"status":"completed"')
    expect(dispatchTaskTool('unknown_tool', {}, context)).toBeUndefined()
  })
})
