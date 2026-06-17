import { describe, it, expect, beforeEach } from 'vitest';
import { TaskManager, type TaskToolCall } from './taskManager';

describe('TaskManager', () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager();
  });

  describe('createTask', () => {
    it('should create a root task', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Test Description',
        priority: 'major',
      });
      expect(task.id).toBeDefined();
      expect(task.title).toBe('Test Task');
      expect(task.status).toBe('pending');
      expect(task.parentId).toBeNull();
      expect(manager.getRootTasks()).toHaveLength(1);
    });

    it('should create a child task', () => {
      const parent = manager.createTask({
        title: 'Parent Task',
        description: 'Parent Description',
        priority: 'major',
      });
      const child = manager.createTask({
        title: 'Child Task',
        description: 'Child Description',
        priority: 'medium',
        parentId: parent.id,
      });
      expect(child.parentId).toBe(parent.id);
      expect(parent.children).toContain(child.id);
    });

    it('should throw error for non-existent parent', () => {
      expect(() => {
        manager.createTask({
          title: 'Child Task',
          description: 'Child Description',
          priority: 'medium',
          parentId: 'non-existent-id',
        });
      }).toThrow('Parent task not found');
    });

    it('should normalize priority based on parent depth', () => {
      const root = manager.createTask({
        title: 'Root',
        description: 'Root',
        priority: 'major',
      });
      const child = manager.createTask({
        title: 'Child',
        description: 'Child',
        priority: 'major',
        parentId: root.id,
      });
      expect(child.priority).toBe('medium');

      const grandchild = manager.createTask({
        title: 'Grandchild',
        description: 'Grandchild',
        priority: 'major',
        parentId: child.id,
      });
      expect(grandchild.priority).toBe('minor');
    });

    it('should handle empty title', () => {
      const task = manager.createTask({
        title: '',
        description: 'Description',
        priority: 'minor',
      });
      expect(task.title).toBe('');
    });

    it('should handle special characters in title', () => {
      const task = manager.createTask({
        title: 'Task with 特殊 characters & symbols!',
        description: 'Description',
        priority: 'minor',
      });
      expect(task.title).toBe('Task with 特殊 characters & symbols!');
    });
  });

  describe('updateTask', () => {
    it('should update task status to in_progress', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      const updated = manager.updateTask(task.id, { status: 'in_progress' });
      expect(updated?.status).toBe('in_progress');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should update task status to completed', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      const updated = manager.updateTask(task.id, { status: 'completed' });
      expect(updated?.status).toBe('completed');
      expect(updated?.progress).toBe(100);
      expect(updated?.completedAt).toBeDefined();
    });

    it('should update task status to failed', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      const updated = manager.updateTask(task.id, {
        status: 'failed',
        error: 'Test error',
      });
      expect(updated?.status).toBe('failed');
      expect(updated?.error).toBe('Test error');
    });

    it('should update task progress', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      manager.updateTask(task.id, { status: 'in_progress' });
      const updated = manager.updateTask(task.id, { progress: 50 });
      expect(updated?.progress).toBe(50);
    });

    it('should cap progress at 99 for in_progress tasks', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      manager.updateTask(task.id, { status: 'in_progress' });
      const updated = manager.updateTask(task.id, { progress: 100 });
      expect(updated?.progress).toBe(99);
    });

    it('should return null for non-existent task', () => {
      const result = manager.updateTask('non-existent', { status: 'completed' });
      expect(result).toBeNull();
    });

    it('should not complete parent if children are not completed', () => {
      const parent = manager.createTask({
        title: 'Parent',
        description: 'Parent',
        priority: 'major',
      });
      manager.createTask({
        title: 'Child',
        description: 'Child',
        priority: 'medium',
        parentId: parent.id,
      });
      const updated = manager.updateTask(parent.id, { status: 'completed' });
      expect(updated?.status).not.toBe('completed');
    });
  });

  describe('task retrieval', () => {
    it('should get task by id', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      const retrieved = manager.getTask(task.id);
      expect(retrieved?.id).toBe(task.id);
    });

    it('should return null for non-existent task', () => {
      const retrieved = manager.getTask('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should get all root tasks', () => {
      manager.createTask({ title: 'Root 1', description: 'D1', priority: 'major' });
      manager.createTask({ title: 'Root 2', description: 'D2', priority: 'medium' });
      const child = manager.createTask({ title: 'Root 3', description: 'D3', priority: 'minor' });
      manager.createTask({
        title: 'Child',
        description: 'Child',
        priority: 'medium',
        parentId: child.id,
      });
      expect(manager.getRootTasks()).toHaveLength(3);
    });

    it('should get child tasks', () => {
      const parent = manager.createTask({
        title: 'Parent',
        description: 'Parent',
        priority: 'major',
      });
      const child1 = manager.createTask({
        title: 'Child 1',
        description: 'Child 1',
        priority: 'medium',
        parentId: parent.id,
      });
      const child2 = manager.createTask({
        title: 'Child 2',
        description: 'Child 2',
        priority: 'medium',
        parentId: parent.id,
      });
      const children = manager.getChildTasks(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map(c => c.id)).toContain(child1.id);
      expect(children.map(c => c.id)).toContain(child2.id);
    });

    it('should get tasks by status', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.updateTask(task1.id, { status: 'in_progress' });
      manager.updateTask(task2.id, { status: 'completed' });
      const pending = manager.getTasksByStatus('pending');
      const inProgress = manager.getTasksByStatus('in_progress');
      const completed = manager.getTasksByStatus('completed');
      expect(pending).toHaveLength(0);
      expect(inProgress).toHaveLength(1);
      expect(completed).toHaveLength(1);
    });

    it('should get current task (most recent in_progress)', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      manager.updateTask(task1.id, { status: 'in_progress' });
      // Wait a bit to ensure time difference
      const start = Date.now();
      while (Date.now() - start < 10) {
        // busy wait
      }
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'major' });
      manager.updateTask(task2.id, { status: 'in_progress' });
      const current = manager.getCurrentTask();
      expect(current?.id).toBe(task2.id);
    });
  });

  describe('dependencies', () => {
    it('should add dependency', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      const result = manager.addDependency(task2.id, task1.id);
      expect(result).toBe(true);
      expect(task2.dependencies).toContain(task1.id);
    });

    it('should not add self-dependency', () => {
      const task = manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      const result = manager.addDependency(task.id, task.id);
      expect(result).toBe(false);
    });

    it('should not add duplicate dependency', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.addDependency(task2.id, task1.id);
      const result = manager.addDependency(task2.id, task1.id);
      expect(result).toBe(false);
    });

    it('should not create circular dependency', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.addDependency(task1.id, task2.id);
      const result = manager.addDependency(task2.id, task1.id);
      expect(result).toBe(false);
    });

    it('should remove dependency', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.addDependency(task2.id, task1.id);
      const result = manager.removeDependency(task2.id, task1.id);
      expect(result).toBe(true);
      expect(task2.dependencies).not.toContain(task1.id);
    });

    it('should check if dependencies are met', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.addDependency(task2.id, task1.id);
      expect(manager.areDependenciesMet(task2.id)).toBe(false);
      manager.updateTask(task1.id, { status: 'completed' });
      expect(manager.areDependenciesMet(task2.id)).toBe(true);
    });

    it('should get blocked tasks', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.addDependency(task2.id, task1.id);
      const blocked = manager.getBlockedTasks();
      expect(blocked).toHaveLength(1);
      expect(blocked[0].id).toBe(task2.id);
    });

    it('should get executable tasks', () => {
      const task1 = manager.createTask({ title: 'Task 1', description: 'D1', priority: 'major' });
      const task2 = manager.createTask({ title: 'Task 2', description: 'D2', priority: 'medium' });
      manager.addDependency(task2.id, task1.id);
      const executable = manager.getExecutableTasks();
      expect(executable).toHaveLength(1);
      expect(executable[0].id).toBe(task1.id);
    });
  });

  describe('tool calls', () => {
    it('should add tool call to active task', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      manager.updateTask(task.id, { status: 'in_progress' });
      const toolCall: TaskToolCall = {
        toolCallId: 'tc1',
        toolName: 'read_file',
        status: 'running',
        path: '/path/to/file',
      };
      const result = manager.addToolCallToActiveTask(toolCall);
      expect(result).toBe(task.id);
      expect(manager.getTaskToolCalls(task.id)).toHaveLength(1);
    });

    it('should update tool call status', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      manager.updateTask(task.id, { status: 'in_progress' });
      const toolCall: TaskToolCall = {
        toolCallId: 'tc1',
        toolName: 'read_file',
        status: 'running',
      };
      manager.addToolCallToActiveTask(toolCall);
      manager.updateToolCallStatus(task.id, 'tc1', 'completed', 'result');
      const calls = manager.getTaskToolCalls(task.id);
      expect(calls[0].status).toBe('completed');
      expect(calls[0].result).toBe('result');
    });

    it('should auto-update progress from tool calls', () => {
      const task = manager.createTask({
        title: 'Test Task',
        description: 'Description',
        priority: 'major',
      });
      manager.updateTask(task.id, { status: 'in_progress' });
      manager.addToolCallToActiveTask({
        toolCallId: 'tc1',
        toolName: 'read_file',
        status: 'completed',
      });
      manager.addToolCallToActiveTask({
        toolCallId: 'tc2',
        toolName: 'edit_file',
        status: 'running',
      });
      const updated = manager.getTask(task.id);
      // Progress is capped at 99 for in_progress tasks
      expect(updated?.progress).toBe(99);
    });

    it('includes progress in active task context', () => {
      const task = manager.createTask({
        title: 'Visible Task',
        description: 'Description',
        priority: 'major',
      });
      manager.updateTask(task.id, { status: 'in_progress', progress: 42 });
      const context = manager.getActiveTaskContext();
      expect(context?.taskId).toBe(task.id);
      expect(context?.progress).toBe(42);
    });
  });

  describe('task tree', () => {
    it('should get task tree', () => {
      const parent = manager.createTask({
        title: 'Parent',
        description: 'Parent',
        priority: 'major',
      });
      const child = manager.createTask({
        title: 'Child',
        description: 'Child',
        priority: 'medium',
        parentId: parent.id,
      });
      const tree = manager.getTaskTree(parent.id);
      expect(tree?.children).toHaveLength(1);
      expect(tree?.children[0].id).toBe(child.id);
    });

    it('should get full tree', () => {
      manager.createTask({ title: 'Root 1', description: 'D1', priority: 'major' });
      manager.createTask({ title: 'Root 2', description: 'D2', priority: 'medium' });
      const fullTree = manager.getFullTree();
      expect(fullTree).toHaveLength(2);
    });
  });

  describe('events', () => {
    it('should emit task:created event', () => {
      let eventEmitted = false;
      manager.subscribe(() => { eventEmitted = true; });
      manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      expect(eventEmitted).toBe(true);
    });

    it('should emit task:updated event', () => {
      let eventEmitted = false;
      const task = manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      manager.subscribe(() => { eventEmitted = true; });
      manager.updateTask(task.id, { status: 'in_progress' });
      expect(eventEmitted).toBe(true);
    });

    it('should emit tasks:cleared event', () => {
      let eventEmitted = false;
      manager.subscribe(() => { eventEmitted = true; });
      manager.clear();
      expect(eventEmitted).toBe(true);
    });

    it('should unsubscribe listener', () => {
      let eventCount = 0;
      const unsubscribe = manager.subscribe(() => { eventCount++; });
      manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      unsubscribe();
      manager.createTask({ title: 'Task 2', description: 'D2', priority: 'major' });
      expect(eventCount).toBe(1);
    });
  });

  describe('clear and serialization', () => {
    it('should clear all tasks', () => {
      manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      manager.clear();
      expect(manager.getAllTasks()).toHaveLength(0);
      expect(manager.getRootTasks()).toHaveLength(0);
    });

    it('should serialize to JSON', () => {
      manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      const json = manager.toJSON();
      expect(json).toHaveProperty('tasks');
      expect(json).toHaveProperty('rootIds');
    });

    it('should deserialize from JSON', () => {
      manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      const json = manager.toJSON();
      const newManager = TaskManager.fromJSON(json as any);
      expect(newManager.getAllTasks()).toHaveLength(1);
      expect(newManager.getRootTasks()).toHaveLength(1);
    });
  });

  describe('task resolution by title', () => {
    it('should resolve task by exact title', () => {
      const task = manager.createTask({ title: 'Unique Title', description: 'D', priority: 'major' });
      const resolved = manager.createTask({
        title: 'Child',
        description: 'Child',
        priority: 'medium',
        parentId: 'Unique Title',
      });
      expect(resolved.parentId).toBe(task.id);
    });

    it('should resolve task by case-insensitive title', () => {
      const task = manager.createTask({ title: 'Unique Title', description: 'D', priority: 'major' });
      const resolved = manager.createTask({
        title: 'Child',
        description: 'Child',
        priority: 'medium',
        parentId: 'unique title',
      });
      expect(resolved.parentId).toBe(task.id);
    });

    it('should return null for ambiguous title matches', () => {
      manager.createTask({ title: 'Duplicate', description: 'D1', priority: 'major' });
      manager.createTask({ title: 'Duplicate', description: 'D2', priority: 'medium' });
      expect(() => {
        manager.createTask({
          title: 'Child',
          description: 'Child',
          priority: 'medium',
          parentId: 'Duplicate',
        });
      }).toThrow('Parent task not found');
    });
  });

  describe('fromJSON full restoration', () => {
    it('should restore activeTaskId for in_progress tasks', () => {
      const task = manager.createTask({ title: 'Active', description: 'D', priority: 'major' });
      manager.updateTask(task.id, { status: 'in_progress' });
      const json = manager.toJSON() as any;
      const restored = TaskManager.fromJSON(json);
      expect(restored.getCurrentTask()?.id).toBe(task.id);
    });

    it('should not restore activeTaskId for completed tasks', () => {
      const task = manager.createTask({ title: 'Done', description: 'D', priority: 'major' });
      manager.updateTask(task.id, { status: 'completed' });
      const json = manager.toJSON() as any;
      const restored = TaskManager.fromJSON(json);
      expect(restored.getCurrentTask()).toBeNull();
    });

    it('should restore taskToolCalls', () => {
      const task = manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      manager.updateTask(task.id, { status: 'in_progress' });
      manager.addToolCallToActiveTask({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        status: 'completed',
        path: '/test.ts',
      });
      const json = manager.toJSON() as any;
      const restored = TaskManager.fromJSON(json);
      const calls = restored.getTaskToolCalls(task.id);
      expect(calls).toHaveLength(1);
      expect(calls[0].toolCallId).toBe('tc-1');
      expect(calls[0].status).toBe('completed');
    });

    it('should fix dangling parent references', () => {
      const task = manager.createTask({ title: 'Orphan', description: 'D', priority: 'major' });
      const json = manager.toJSON() as any;
      // Simulate a dangling parentId
      json.tasks[task.id].parentId = 'non-existent-parent';
      const restored = TaskManager.fromJSON(json);
      const restoredTask = restored.getTask(task.id);
      expect(restoredTask?.parentId).toBeNull();
      expect(restored.getRootTasks()).toHaveLength(1);
    });

    it('should fix stale children references', () => {
      const parent = manager.createTask({ title: 'Parent', description: 'D', priority: 'major' });
      const child = manager.createTask({ title: 'Child', description: 'D', priority: 'medium', parentId: parent.id });
      const json = manager.toJSON() as any;
      // Remove child from tasks but leave reference in parent.children
      delete json.tasks[child.id];
      const restored = TaskManager.fromJSON(json);
      const restoredParent = restored.getTask(parent.id);
      expect(restoredParent?.children).toHaveLength(0);
    });

    it('should fix stale dependency references', () => {
      const task1 = manager.createTask({ title: 'T1', description: 'D', priority: 'major' });
      const task2 = manager.createTask({ title: 'T2', description: 'D', priority: 'major' });
      manager.addDependency(task2.id, task1.id);
      const json = manager.toJSON() as any;
      // Remove task1 from tasks
      delete json.tasks[task1.id];
      json.rootIds = json.rootIds.filter((id: string) => id !== task1.id);
      const restored = TaskManager.fromJSON(json);
      const restoredTask2 = restored.getTask(task2.id);
      expect(restoredTask2?.dependencies).toHaveLength(0);
    });
  });

  describe('restoreTask child-before-parent ordering', () => {
    it('should correctly link child restored before parent', () => {
      // Restore child first with a parentId that doesn't exist yet
      const child = manager.restoreTask({
        id: 'child-1',
        title: 'Child',
        description: 'Child task',
        priority: 'medium',
        parentId: 'parent-1',
      });
      expect(child.parentId).toBe('parent-1');
      // Child should NOT be in rootIds
      expect(manager.getRootTasks().map(t => t.id)).not.toContain('child-1');

      // Now restore the parent
      const parent = manager.restoreTask({
        id: 'parent-1',
        title: 'Parent',
        description: 'Parent task',
        priority: 'major',
      });
      // Parent should have child linked
      expect(parent.children).toContain('child-1');
      expect(manager.getRootTasks().map(t => t.id)).toContain('parent-1');
      expect(manager.getRootTasks().map(t => t.id)).not.toContain('child-1');
    });

    it('should handle multiple orphans for the same parent', () => {
      manager.restoreTask({ id: 'c1', title: 'C1', description: 'D', priority: 'medium', parentId: 'p1' });
      manager.restoreTask({ id: 'c2', title: 'C2', description: 'D', priority: 'minor', parentId: 'p1' });
      const parent = manager.restoreTask({ id: 'p1', title: 'P1', description: 'D', priority: 'major' });
      expect(parent.children).toContain('c1');
      expect(parent.children).toContain('c2');
      expect(manager.getRootTasks()).toHaveLength(1);
    });
  });

  describe('failed parent protection', () => {
    it('should not override explicitly failed parent when child updates', () => {
      const parent = manager.createTask({ title: 'Parent', description: 'D', priority: 'major' });
      const child = manager.createTask({ title: 'Child', description: 'D', priority: 'medium', parentId: parent.id });
      // Explicitly fail the parent
      manager.updateTask(parent.id, { status: 'failed', error: 'Manual failure' });
      expect(parent.status).toBe('failed');
      expect(parent.error).toBe('Manual failure');

      // Update child — should NOT override parent's failed status
      manager.updateTask(child.id, { status: 'completed' });
      const updatedParent = manager.getTask(parent.id);
      expect(updatedParent?.status).toBe('failed');
      expect(updatedParent?.error).toBe('Manual failure');
    });

    it('should propagate failure from children when all are terminal', () => {
      const parent = manager.createTask({ title: 'Parent', description: 'D', priority: 'major' });
      const child1 = manager.createTask({ title: 'C1', description: 'D', priority: 'medium', parentId: parent.id });
      const child2 = manager.createTask({ title: 'C2', description: 'D', priority: 'medium', parentId: parent.id });
      manager.updateTask(child1.id, { status: 'completed' });
      manager.updateTask(child2.id, { status: 'failed', error: 'oops' });
      const updatedParent = manager.getTask(parent.id);
      expect(updatedParent?.status).toBe('failed');
    });
  });

  describe('addToolCallToActiveTask defensive behavior', () => {
    it('should return null when no task is in_progress', () => {
      manager.createTask({ title: 'Pending', description: 'D', priority: 'major' });
      const result = manager.addToolCallToActiveTask({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        status: 'running',
      });
      expect(result).toBeNull();
    });

    it('should not emit for non-in_progress tasks', () => {
      const task = manager.createTask({ title: 'Task', description: 'D', priority: 'major' });
      manager.updateTask(task.id, { status: 'completed' });
      const events: any[] = [];
      manager.subscribe(e => events.push(e));
      const result = manager.addToolCallToActiveTask({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        status: 'running',
      });
      expect(result).toBeNull();
      // No task:updated event should have been emitted
      expect(events.filter(e => e.type === 'task:updated')).toHaveLength(0);
    });
  });
});
