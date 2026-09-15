import type { TaskNode, TaskPriority, TaskStatus } from '../shared/agentTypes'
import { TaskManager } from './taskManager'

export type TaskSystemCreationEvent = {
  status: 'planning' | 'creating' | 'completed' | 'error'
  toolName?: string
  expectedCount?: number
  createdCount?: number
  title?: string
  startedAt?: number
  updatedAt: number
  error?: string
}

export interface TaskToolDispatchContext {
  taskManager: TaskManager
  emitTaskSystem(creation?: TaskSystemCreationEvent | null): void
  emitActiveTask(): void
}

export function dispatchTaskTool(
  name: string,
  args: Record<string, unknown>,
  context: TaskToolDispatchContext,
): string | undefined {
  if (name === 'create_task') {
    const creationStartedAt = Date.now()
    context.emitTaskSystem({
      status: 'creating',
      toolName: 'create_task',
      expectedCount: 1,
      createdCount: 0,
      title: args.title as string | undefined,
      startedAt: creationStartedAt,
      updatedAt: creationStartedAt,
    })
    const task = context.taskManager.createTask({
      title: args.title as string,
      description: args.description as string,
      priority: args.priority as TaskPriority,
      parentId: args.parent_id as string | undefined,
      order: args.order as number | undefined,
      metadata: args.metadata as TaskNode['metadata'] | undefined,
    })
    const dependencies = args.dependencies as string[] | undefined
    if (dependencies && dependencies.length > 0) {
      const failed: string[] = []
      for (const dependencyId of dependencies) {
        if (!context.taskManager.addDependency(task.id, dependencyId)) failed.push(dependencyId)
      }
      if (failed.length > 0) {
        context.emitTaskSystem({
          status: 'error',
          toolName: 'create_task',
          expectedCount: 1,
          createdCount: 1,
          title: task.title,
          startedAt: creationStartedAt,
          updatedAt: Date.now(),
          error: `Some dependencies could not be added: ${failed.join(', ')}`,
        })
        context.emitActiveTask()
        return JSON.stringify({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dependencies: task.dependencies,
          warning: `Some dependencies could not be added (tasks not found or would create cycle): ${failed.join(', ')}`,
        })
      }
    }
    context.emitTaskSystem({
      status: 'completed',
      toolName: 'create_task',
      expectedCount: 1,
      createdCount: 1,
      title: task.title,
      startedAt: creationStartedAt,
      updatedAt: Date.now(),
    })
    context.emitActiveTask()
    return JSON.stringify({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dependencies: task.dependencies,
    })
  }

  if (name === 'create_tasks') {
    const items = args.tasks as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(items) || items.length === 0) return "Error: 'tasks' must be a non-empty array"

    const creationStartedAt = Date.now()
    context.emitTaskSystem({
      status: 'planning',
      toolName: 'create_tasks',
      expectedCount: items.length,
      createdCount: 0,
      title: items.length === 1 ? String(items[0]?.title || 'Task') : `${items.length} tasks`,
      startedAt: creationStartedAt,
      updatedAt: creationStartedAt,
    })
    const refToId = new Map<string, string>()
    const resolveReference = (value: unknown): string | undefined => {
      if (typeof value !== 'string' || !value) return undefined
      return refToId.get(value) ?? value
    }
    const created: Array<{ id: string; ref?: string; title: string; status: TaskStatus; priority: TaskPriority }> = []
    const warnings: string[] = []

    for (let index = 0; index < items.length; index += 1) {
      const raw = items[index] || {}
      const title = raw.title as string | undefined
      const description = raw.description as string | undefined
      const priority = raw.priority as TaskPriority | undefined
      if (!title || !description || !priority) {
        warnings.push(`tasks[${index}]: missing required field (title/description/priority)`)
        continue
      }

      let task: TaskNode
      try {
        task = context.taskManager.createTask({
          title,
          description,
          priority,
          parentId: resolveReference(raw.parent_id),
          order: raw.order as number | undefined,
          metadata: raw.metadata as TaskNode['metadata'] | undefined,
        })
      } catch (error) {
        warnings.push(`tasks[${index}] (${title}): ${(error as Error).message}`)
        continue
      }

      const localReference = typeof raw.ref === 'string' ? raw.ref : undefined
      if (localReference) refToId.set(localReference, task.id)
      const dependencies = raw.dependencies as unknown[] | undefined
      if (Array.isArray(dependencies)) {
        for (const dependencyReference of dependencies) {
          const dependencyId = resolveReference(dependencyReference)
          if (!dependencyId || !context.taskManager.addDependency(task.id, dependencyId)) {
            warnings.push(`tasks[${index}] (${title}): dependency '${String(dependencyReference)}' not added`)
          }
        }
      }
      created.push({ id: task.id, ref: localReference, title: task.title, status: task.status, priority: task.priority })
      context.emitTaskSystem({
        status: 'creating',
        toolName: 'create_tasks',
        expectedCount: items.length,
        createdCount: created.length,
        title: task.title,
        startedAt: creationStartedAt,
        updatedAt: Date.now(),
      })
    }

    context.emitTaskSystem({
      status: warnings.length > 0 && created.length === 0 ? 'error' : 'completed',
      toolName: 'create_tasks',
      expectedCount: items.length,
      createdCount: created.length,
      title: created.at(-1)?.title || `${items.length} tasks`,
      startedAt: creationStartedAt,
      updatedAt: Date.now(),
      error: warnings.length > 0 ? warnings.slice(0, 2).join('; ') : undefined,
    })
    context.emitActiveTask()
    return JSON.stringify(warnings.length > 0 ? { created, warnings } : { created })
  }

  if (name === 'update_task') {
    const taskId = args.task_id as string
    if (args.status === 'in_progress') {
      const existing = context.taskManager.getTask(taskId)
      if (existing && !context.taskManager.areDependenciesMet(taskId)) {
        const blocked = existing.dependencies.filter(dependencyId => {
          const dependency = context.taskManager.getTask(dependencyId)
          return dependency && dependency.status !== 'completed'
        })
        if (blocked.length > 0) return `Error: cannot start task ${taskId} — dependencies not met: ${blocked.join(', ')}`
      }
    }
    if (args.status === 'completed') {
      const existing = context.taskManager.getTask(taskId)
      if (existing && existing.children.length > 0) {
        const pending = context.taskManager.getChildTasks(taskId).filter(task => task.status !== 'completed')
        if (pending.length > 0) {
          const titles = pending.slice(0, 4).map(task => `${task.id} (${task.status})`).join(', ')
          return `Error: cannot mark parent task ${taskId} as completed while ${pending.length} child task(s) remain unfinished: ${titles}${pending.length > 4 ? ', ...' : ''}. Complete or fail the children first.`
        }
      }
    }
    const task = context.taskManager.updateTask(taskId, {
      status: args.status as TaskStatus,
      progress: args.progress as number | undefined,
      error: args.error as string | undefined,
    })
    if (!task) return `Error: task ${taskId} not found`
    context.emitActiveTask()
    return JSON.stringify({ id: task.id, title: task.title, status: task.status, progress: task.progress })
  }

  if (name === 'add_task_dependency') {
    const ok = context.taskManager.addDependency(args.task_id as string, args.dependency_id as string)
    if (!ok) return 'Error: failed to add dependency. Check that both tasks exist, the dependency is not a self-reference, and no cycle would be created.'
    context.emitActiveTask()
    return `Dependency added: ${args.task_id} now depends on ${args.dependency_id}`
  }

  if (name === 'remove_task_dependency') {
    const ok = context.taskManager.removeDependency(args.task_id as string, args.dependency_id as string)
    if (!ok) return 'Error: failed to remove dependency'
    context.emitActiveTask()
    return `Dependency removed: ${args.task_id} no longer depends on ${args.dependency_id}`
  }

  if (name === 'list_tasks') {
    const tasks = (args.parent_id
      ? context.taskManager.getChildTasks(args.parent_id as string)
      : context.taskManager.getAllTasks())
      .filter(task => !args.status || task.status === args.status)
    return JSON.stringify(tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      progress: task.progress,
      children: task.children.length,
    })))
  }

  return undefined
}
