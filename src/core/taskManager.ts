import type {
  TaskNode,
  TaskPriority,
  TaskStatus,
} from '../shared/agentTypes'
import {
  generateTaskId,
} from '../shared/agentTypes'

export interface TaskToolCall {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  path?: string
  result?: string
}

export interface ActiveTaskContext {
  taskId: string
  title: string
  priority: TaskPriority
  progress: number
  toolCalls: TaskToolCall[]
  startedAt: number
}

export class TaskManager {
  private tasks: Map<string, TaskNode> = new Map()
  private rootIds: string[] = []
  private listeners: Set<(event: TaskEvent) => void> = new Set()
  private activeTaskId: string | null = null
  private taskToolCalls: Map<string, TaskToolCall[]> = new Map() // taskId -> toolCalls

  createTask(params: {
    title: string
    description: string
    priority: TaskPriority
    parentId?: string
    order?: number
    metadata?: TaskNode['metadata']
  }): TaskNode {
    const now = Date.now()
    const requestedParentId = params.parentId?.trim()
    const parentId = this.resolveTaskId(requestedParentId ?? null)
    if (requestedParentId && !parentId) {
      throw new Error(`Parent task not found: ${requestedParentId}`)
    }
    const normalizedPriority = this.normalizePriorityForParent(parentId, params.priority)
    const id = generateTaskId(normalizedPriority)

    const task: TaskNode = {
      id,
      title: params.title,
      description: params.description,
      priority: normalizedPriority,
      status: 'pending',
      parentId,
      children: [],
      dependencies: [],
      order: params.order ?? 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata,
    }

    if (parentId) {
      const parent = this.tasks.get(parentId)
      if (parent && !parent.children.includes(id)) {
        parent.children.push(id)
        parent.updatedAt = now
      }
    } else {
      this.rootIds.push(id)
    }

    this.tasks.set(id, task)
    if (parentId) {
      this.recalculateTaskFromChildren(parentId, now)
      this.recalculateParentProgress(parentId)
    }
    this.emit({ type: 'task:created', task })

    return task
  }

  restoreTask(params: {
    id: string
    title: string
    description: string
    priority: TaskPriority
    status?: TaskStatus
    parentId?: string | null
    dependencies?: string[]
    order?: number
    progress?: number
    createdAt?: number
    updatedAt?: number
    startedAt?: number
    completedAt?: number
    error?: string
    metadata?: TaskNode['metadata']
  }): TaskNode {
    const existing = this.tasks.get(params.id)
    if (existing) {
      return existing
    }

    const now = Date.now()
    // Resolve parent — may be null if parent hasn't been restored yet.
    // We still record the *requested* parentId so linkOrphanedChildren()
    // can wire things up once the parent arrives.
    const resolvedParentId = this.resolveTaskId(params.parentId ?? null)
    const requestedParentId = params.parentId?.trim() || null
    const parentId = resolvedParentId
    const normalizedPriority = this.normalizePriorityForParent(parentId, params.priority)
    const task: TaskNode = {
      id: params.id,
      title: params.title,
      description: params.description,
      priority: normalizedPriority,
      status: params.status ?? 'pending',
      // Keep the requested parentId even if parent isn't restored yet —
      // this allows linkOrphanedChildren to fix the relationship later.
      parentId: parentId ?? requestedParentId,
      children: [],
      dependencies: params.dependencies ?? [],
      order: params.order ?? 0,
      progress: this.normalizeStoredProgress(params.progress ?? 0, params.status ?? 'pending'),
      createdAt: params.createdAt ?? now,
      updatedAt: params.updatedAt ?? params.createdAt ?? now,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      error: params.error,
      metadata: params.metadata,
    }

    if (parentId) {
      const parent = this.tasks.get(parentId)
      if (parent && !parent.children.includes(task.id)) {
        parent.children.push(task.id)
        parent.updatedAt = now
      }
    } else if (!requestedParentId) {
      // Only add to rootIds if there's genuinely no parent (not just
      // a parent that hasn't been restored yet).
      if (!this.rootIds.includes(task.id)) {
        this.rootIds.push(task.id)
      }
    }
    // If requestedParentId is set but unresolved, we do NOT add to rootIds.
    // The task is an orphan waiting for its parent.

    this.tasks.set(task.id, task)

    // Check if any previously-restored orphans are children of this task.
    this.linkOrphanedChildren(task.id, now)

    if (parentId) {
      this.recalculateTaskFromChildren(parentId, now)
      this.recalculateParentProgress(parentId)
    }

    if (task.status === 'in_progress') {
      this.activeTaskId = task.id
    }

    this.emit({ type: 'task:created', task })
    return task
  }

  /**
   * After restoring a task, check if any existing tasks reference this task
   * as their parent but weren't linked because this task didn't exist yet.
   * Wire them up now.
   */
  private linkOrphanedChildren(parentId: string, now: number): void {
    const parent = this.tasks.get(parentId)
    if (!parent) return

    for (const task of this.tasks.values()) {
      if (task.id === parentId) continue
      if (task.parentId !== parentId) continue
      if (parent.children.includes(task.id)) continue

      // This task claims parentId as its parent but wasn't linked yet.
      parent.children.push(task.id)
      parent.updatedAt = now

      // Remove from rootIds if it was mistakenly placed there.
      const rootIdx = this.rootIds.indexOf(task.id)
      if (rootIdx !== -1) {
        this.rootIds.splice(rootIdx, 1)
      }
    }
  }

  updateTask(
    taskId: string,
    updates: {
      status?: TaskStatus
      progress?: number
      error?: string
    }
  ): TaskNode | null {
    const resolvedTaskId = this.resolveTaskId(taskId)
    if (!resolvedTaskId) return null
    const task = this.tasks.get(resolvedTaskId)
    if (!task) return null

    const now = Date.now()
    const hasChildren = task.children.length > 0

    if (updates.status) {
      if (updates.status === 'pending') {
        task.status = 'pending'
        if (!hasChildren) task.progress = 0
        task.startedAt = undefined
        task.completedAt = undefined
        task.error = undefined
        if (this.activeTaskId === task.id) {
          this.activeTaskId = null
        }
      } else if (updates.status === 'in_progress') {
        task.status = 'in_progress'
        task.startedAt = task.startedAt ?? now
        task.completedAt = undefined
        task.error = undefined
        if (task.progress >= 100) {
          task.progress = 99
        }
        this.activeTaskId = task.id
      } else if (updates.status === 'completed') {
        if (!hasChildren || this.areAllChildrenCompleted(task.id)) {
          task.status = 'completed'
          task.completedAt = now
          task.error = undefined
          task.progress = 100
          if (this.activeTaskId === task.id) {
            this.activeTaskId = null
          }
        }
      } else if (updates.status === 'failed') {
        task.status = 'failed'
        task.completedAt = now
        task.error = updates.error
        if (this.activeTaskId === task.id) {
          this.activeTaskId = null
        }
      }
    }

    const explicitProgress = updates.progress !== undefined

    if (explicitProgress && task.status === 'in_progress') {
      const requested = Math.min(100, Math.max(0, updates.progress!))
      task.progress = this.normalizeOpenProgress(requested)
    }

    if (hasChildren && task.status !== 'failed' && !explicitProgress) {
      this.recalculateTaskFromChildren(task.id, now)
    }
    task.updatedAt = now
    this.recalculateParentProgress(task.id)
    this.emit({ type: 'task:updated', task })

    return task
  }

  // Auto-link a tool call to the current active in_progress task
  addToolCallToActiveTask(toolCall: TaskToolCall): string | null {
    const targetTaskId = this.activeTaskId || this.findMostRecentInProgressTask()
    if (!targetTaskId) return null

    const task = this.tasks.get(targetTaskId)
    if (!task || task.status !== 'in_progress') return null

    const existing = this.taskToolCalls.get(targetTaskId) || []
    const existingIdx = existing.findIndex(call => call.toolCallId === toolCall.toolCallId)
    if (existingIdx >= 0) {
      existing[existingIdx] = {
        ...existing[existingIdx],
        ...toolCall,
      }
    } else {
      existing.push(toolCall)
    }
    this.taskToolCalls.set(targetTaskId, existing)

    // Auto-update progress based on tool call completion ratio
    this.autoUpdateProgressFromToolCalls(targetTaskId)

    this.emit({ type: 'task:updated', task })
    return targetTaskId
  }

  updateToolCallStatus(taskId: string, toolCallId: string, status: TaskToolCall['status'], result?: string): void {
    const calls = this.taskToolCalls.get(taskId)
    if (!calls) return

    const call = calls.find(c => c.toolCallId === toolCallId)
    if (call) {
      call.status = status
      if (result !== undefined) call.result = result
    }

    this.autoUpdateProgressFromToolCalls(taskId)
    const task = this.tasks.get(taskId)
    if (task) {
      this.emit({ type: 'task:updated', task })
    }
  }

  getTaskToolCalls(taskId: string): TaskToolCall[] {
    return this.taskToolCalls.get(taskId) || []
  }

  getActiveTaskContext(): ActiveTaskContext | null {
    const taskId = this.activeTaskId || this.findMostRecentInProgressTask()
    if (!taskId) return null

    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'in_progress') return null

    return {
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      progress: task.progress,
      toolCalls: this.taskToolCalls.get(taskId) || [],
      startedAt: task.startedAt || task.updatedAt,
    }
  }

  private findMostRecentInProgressTask(): string | null {
    let mostRecent: TaskNode | null = null
    let mostRecentTime = -1
    for (const task of this.tasks.values()) {
      if (task.status === 'in_progress') {
        const taskTime = task.startedAt ?? task.updatedAt
        if (!mostRecent || taskTime > mostRecentTime) {
          mostRecent = task
          mostRecentTime = taskTime
        }
      }
    }
    return mostRecent?.id ?? null
  }

  private autoUpdateProgressFromToolCalls(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'in_progress') return
    if (task.children.length > 0) return

    const calls = this.taskToolCalls.get(taskId) || []
    if (calls.length === 0) return

    // A failed or cancelled tool call is still "done" — the work didn't
    // succeed, but the step is no longer pending. The UI banner already
    // counts terminal states for its progress pill (ChatView.tsx). Counting
    // only `completed` here meant a task with one failed read_file would
    // freeze at (n-1)/n forever even after the model moved on.
    const terminal = calls.filter(c =>
      c.status === 'completed' || c.status === 'error' || c.status === 'cancelled'
    ).length
    const newProgress = this.normalizeOpenProgress(Math.round((terminal / calls.length) * 100))

    if (newProgress > task.progress) {
      task.progress = newProgress
      this.recalculateParentProgress(taskId)
    }
  }

  getTask(taskId: string): TaskNode | null {
    return this.tasks.get(taskId) ?? null
  }

  getRootTasks(): TaskNode[] {
    return this.rootIds.map(id => this.tasks.get(id)).filter((t): t is TaskNode => t !== undefined)
  }

  getChildTasks(parentId: string): TaskNode[] {
    const parent = this.tasks.get(parentId)
    if (!parent) return []
    return parent.children
      .map(id => this.tasks.get(id))
      .filter((t): t is TaskNode => t !== undefined)
  }

  getAllTasks(): TaskNode[] {
    return Array.from(this.tasks.values())
  }

  getTasksByStatus(status: TaskStatus): TaskNode[] {
    return this.getAllTasks().filter(t => t.status === status)
  }

  /**
   * Resolve in_progress LEAF tasks whose tool calls are all in a terminal
   * state (completed/error/cancelled). The model frequently moves on without
   * explicitly calling update_task(status=completed), which leaves the task
   * frozen at 99% forever and drags the parent's averaged progress down.
   *
   * A leaf is finalized as:
   *   - 'completed' if every tool call succeeded
   *   - 'failed'    if any tool call ended in error
   *   - 'completed' if there were zero tool calls (best-effort: the task ran
   *     without recording activity, but the run is over)
   *
   * Returns the list of tasks that were transitioned.
   */
  finalizeOrphanedLeaves(): TaskNode[] {
    const transitioned: TaskNode[] = []
    const candidates = this.getAllTasks().filter(
      t => t.status === 'in_progress' && t.children.length === 0
    )
    for (const task of candidates) {
      const calls = this.taskToolCalls.get(task.id) || []
      const hasNonTerminal = calls.some(c => c.status === 'running')
      if (hasNonTerminal) continue

      const hasError = calls.some(c => c.status === 'error')
      const nextStatus: TaskStatus = hasError ? 'failed' : 'completed'
      const updated = this.updateTask(task.id, {
        status: nextStatus,
        error: hasError ? 'One or more tool calls failed' : undefined,
      })
      if (updated) transitioned.push(updated)
    }
    return transitioned
  }

  getCurrentTask(): TaskNode | null {
    const taskId = this.findMostRecentInProgressTask()
    return taskId ? this.tasks.get(taskId) ?? null : null
  }

  getFirstPendingLeafTask(): TaskNode | null {
    const visit = (taskId: string): TaskNode | null => {
      const task = this.tasks.get(taskId)
      if (!task) return null

      if (task.children.length === 0) {
        if (task.status !== 'pending') return null
        if (!this.areDependenciesMet(task.id)) return null
        return task
      }

      const sortedChildren = task.children
        .map(id => this.tasks.get(id))
        .filter((t): t is TaskNode => t !== undefined)
        .sort((a, b) => a.order - b.order)

      for (const child of sortedChildren) {
        const match = visit(child.id)
        if (match) return match
      }

      return null
    }

    const sortedRoots = this.rootIds
      .map(id => this.tasks.get(id))
      .filter((t): t is TaskNode => t !== undefined)
      .sort((a, b) => a.order - b.order)

    for (const root of sortedRoots) {
      const match = visit(root.id)
      if (match) return match
    }

    return null
  }

  getTaskTree(taskId: string): TaskTreeNode | null {
    const task = this.tasks.get(taskId)
    if (!task) return null

    return {
      ...task,
      children: task.children
        .map(id => this.getTaskTree(id))
        .filter((t): t is TaskTreeNode => t !== null),
    }
  }

  getFullTree(): TaskTreeNode[] {
    return this.rootIds
      .map(id => this.getTaskTree(id))
      .filter((t): t is TaskTreeNode => t !== null)
  }

  addDependency(taskId: string, dependencyId: string): boolean {
    const task = this.tasks.get(taskId)
    const dep = this.resolveTaskId(dependencyId)
    if (!task || !dep) return false
    if (task.id === dep) return false
    if (task.dependencies.includes(dep)) return false
    if (this.wouldCreateDependencyCycle(task.id, dep)) return false
    task.dependencies.push(dep)
    task.updatedAt = Date.now()
    this.emit({ type: 'task:updated', task })
    return true
  }

  removeDependency(taskId: string, dependencyId: string): boolean {
    const task = this.tasks.get(taskId)
    const dep = this.resolveTaskId(dependencyId)
    if (!task || !dep) return false
    const idx = task.dependencies.indexOf(dep)
    if (idx === -1) return false
    task.dependencies.splice(idx, 1)
    task.updatedAt = Date.now()
    this.emit({ type: 'task:updated', task })
    return true
  }

  areDependenciesMet(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.dependencies.length === 0) return true
    return task.dependencies.every(depId => {
      const dep = this.tasks.get(depId)
      return dep && dep.status === 'completed'
    })
  }

  getBlockedTasks(): TaskNode[] {
    return this.getAllTasks().filter(t =>
      t.status === 'pending' && !this.areDependenciesMet(t.id)
    )
  }

  getExecutableTasks(): TaskNode[] {
    return this.getAllTasks().filter(t =>
      t.status === 'pending' && this.areDependenciesMet(t.id)
    )
  }

  private wouldCreateDependencyCycle(taskId: string, depId: string): boolean {
    const visited = new Set<string>()
    const stack = [depId]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current === taskId) return true
      if (visited.has(current)) continue
      visited.add(current)
      const task = this.tasks.get(current)
      if (task) {
        for (const d of task.dependencies) {
          stack.push(d)
        }
      }
    }
    return false
  }

  clear(): void {
    this.tasks.clear()
    this.rootIds = []
    this.activeTaskId = null
    this.taskToolCalls.clear()
    this.emit({ type: 'tasks:cleared' })
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  toJSON(): object {
    return {
      tasks: Object.fromEntries(this.tasks),
      rootIds: this.rootIds,
      activeTaskId: this.activeTaskId,
      taskToolCalls: Object.fromEntries(this.taskToolCalls),
    }
  }

  static fromJSON(data: {
    tasks: Record<string, TaskNode>
    rootIds: string[]
    activeTaskId?: string | null
    taskToolCalls?: Record<string, TaskToolCall[]>
  }): TaskManager {
    const mgr = new TaskManager()

    // Phase 1: Insert all tasks into the map.
    for (const [id, task] of Object.entries(data.tasks)) {
      mgr.tasks.set(id, task)
    }

    // Phase 2: Validate parent-child relationships and rebuild rootIds.
    // A task is a root if it has no parentId OR its parentId doesn't exist.
    const validRootIds = new Set<string>()
    for (const [id, task] of mgr.tasks) {
      if (!task.parentId || !mgr.tasks.has(task.parentId)) {
        validRootIds.add(id)
        // Fix dangling parentId reference
        if (task.parentId && !mgr.tasks.has(task.parentId)) {
          task.parentId = null
        }
      } else {
        // Ensure parent's children array includes this task
        const parent = mgr.tasks.get(task.parentId)!
        if (!parent.children.includes(id)) {
          parent.children.push(id)
        }
      }
    }

    // Remove stale entries from children arrays (references to non-existent tasks)
    for (const task of mgr.tasks.values()) {
      task.children = task.children.filter(childId => mgr.tasks.has(childId))
      task.dependencies = task.dependencies.filter(depId => mgr.tasks.has(depId))
    }

    mgr.rootIds = Array.from(validRootIds)

    // Phase 3: Restore activeTaskId (validate it still exists and is in_progress)
    if (data.activeTaskId) {
      const activeTask = mgr.tasks.get(data.activeTaskId)
      if (activeTask && activeTask.status === 'in_progress') {
        mgr.activeTaskId = data.activeTaskId
      }
    }
    // Fallback: if no activeTaskId was stored, scan for in_progress tasks
    if (!mgr.activeTaskId) {
      for (const task of mgr.tasks.values()) {
        if (task.status === 'in_progress') {
          mgr.activeTaskId = task.id
          break
        }
      }
    }

    // Phase 4: Restore tool calls (validate task references)
    if (data.taskToolCalls) {
      for (const [taskId, calls] of Object.entries(data.taskToolCalls)) {
        if (mgr.tasks.has(taskId) && Array.isArray(calls)) {
          mgr.taskToolCalls.set(taskId, calls)
        }
      }
    }

    return mgr
  }

  private recalculateParentProgress(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task?.parentId) return

    const parent = this.recalculateTaskFromChildren(task.parentId)
    if (!parent) return
    this.recalculateParentProgress(parent.id)
  }

  private recalculateTaskFromChildren(taskId: string, now = Date.now()): TaskNode | null {
    const parent = this.tasks.get(taskId)
    if (!parent) return null

    // Never override an explicitly-failed parent — it's a terminal state
    // that should only be cleared by an explicit updateTask call.
    if (parent.status === 'failed') return parent

    const children = parent.children
      .map(id => this.tasks.get(id))
      .filter((t): t is TaskNode => t !== undefined)

    if (children.length > 0) {
      const totalProgress = children.reduce((sum, c) => sum + c.progress, 0)
      parent.progress = Math.round(totalProgress / children.length)
    }

    const allCompleted = children.length > 0 && children.every(c => c.status === 'completed')
    const anyFailed = children.some(c => c.status === 'failed')
    const anyStarted = children.some(c => c.status === 'in_progress' || c.status === 'completed')

    if (allCompleted) {
      parent.status = 'completed'
      parent.completedAt = now
      parent.error = undefined
      if (this.activeTaskId === parent.id) {
        this.activeTaskId = null
      }
    } else if (anyFailed && !children.some(c => c.status === 'in_progress' || c.status === 'pending')) {
      // All children are either completed or failed, and at least one failed.
      parent.status = 'failed'
      parent.completedAt = now
      parent.error = 'One or more subtasks failed'
      if (this.activeTaskId === parent.id) {
        this.activeTaskId = null
      }
    } else if (anyStarted) {
      parent.status = 'in_progress'
      parent.startedAt = parent.startedAt ?? now
      parent.completedAt = undefined
      parent.error = undefined
    } else {
      parent.status = 'pending'
      parent.completedAt = undefined
      parent.error = undefined
      if (this.activeTaskId === parent.id) {
        this.activeTaskId = null
      }
    }

    // Floor open tasks at 99 so the UI never shows "100%" on something that
    // hasn't actually flipped to completed. Already-completed parents must
    // keep 100% even when recompute runs after the fact.
    if (parent.status !== 'completed' && parent.progress >= 100) {
      parent.progress = 99
    } else if (parent.status === 'completed') {
      parent.progress = 100
    }

    parent.updatedAt = now
    return parent
  }

  private areAllChildrenCompleted(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.children.length === 0) return true
    return task.children
      .map(id => this.tasks.get(id))
      .filter((child): child is TaskNode => Boolean(child))
      .every(child => child.status === 'completed')
  }

  private normalizeStoredProgress(progress: number, status: TaskStatus): number {
    const clamped = Math.min(100, Math.max(0, progress))
    if (status === 'completed') return 100
    if (status === 'in_progress' || status === 'pending') return Math.min(99, clamped)
    return clamped
  }

  private normalizeOpenProgress(progress: number): number {
    const clamped = Math.min(100, Math.max(0, progress))
    return clamped >= 100 ? 99 : clamped
  }

  private normalizePriorityForParent(parentId: string | null, requestedPriority: TaskPriority): TaskPriority {
    if (!parentId) {
      return requestedPriority
    }

    const parent = this.tasks.get(parentId)
    if (!parent) {
      return requestedPriority
    }

    if (!parent.parentId) {
      return requestedPriority === 'major' ? 'medium' : requestedPriority
    }

    return requestedPriority === 'major' ? 'minor' : requestedPriority
  }

  private resolveTaskId(ref: string | null | undefined): string | null {
    const value = ref?.trim()
    if (!value) return null
    if (this.tasks.has(value)) return value

    const exactTitleMatches = Array.from(this.tasks.values()).filter(task => task.title.trim() === value)
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0].id
    }

    const folded = value.toLowerCase()
    const foldedTitleMatches = Array.from(this.tasks.values()).filter(task => task.title.trim().toLowerCase() === folded)
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0].id
    }

    return null
  }

  private emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export interface TaskTreeNode extends Omit<TaskNode, 'children'> {
  children: TaskTreeNode[]
}

export type TaskEvent =
  | { type: 'task:created'; task: TaskNode }
  | { type: 'task:updated'; task: TaskNode }
  | { type: 'tasks:cleared' }
