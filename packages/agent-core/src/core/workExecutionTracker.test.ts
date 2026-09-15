import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import { WORK_EXECUTION_SCHEMA_VERSION, type WorkExecutionSnapshot } from '../shared/workExecutionTypes'
import { TaskManager } from './taskManager'
import { WorkExecutionTracker } from './workExecutionTracker'

describe('WorkExecutionTracker', () => {
  it('restarts an edited run without its previous mode, timing or activity state', () => {
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.startRun('run-1', 'Original task', 1_000)
    tracker.setResponseMode('task')
    tracker.startTool({ id: 'old-tool', name: 'read_file', arguments: { path: 'README.md' } })
    tracker.setPhase('paused')
    tracker.setPhase('thinking')
    tracker.finishRun('failed', 'Old outcome', 'Old error')

    tracker.startRun('run-1', 'Edited request', 100_000, { restart: true })
    const snapshot = tracker.getSnapshot(new TaskManager())
    expect(snapshot.currentRunId).toBe('run-1')
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]).toMatchObject({
      objective: 'Edited request', status: 'running', phase: 'thinking', presentation: 'conversation',
      startedAt: 100_000, executionSegments: [{ startedAt: 100_000 }], activities: {}, steps: {},
    })
    expect(snapshot.runs[0].responseMode).toBeUndefined()
    expect(snapshot.runs[0].completedAt).toBeUndefined()
    expect(snapshot.runs[0].error).toBeUndefined()
    expect(snapshot.runs[0].outcome).toBeUndefined()
    tracker.setResponseMode('chat')
    expect(tracker.getResponseMode()).toBe('chat')
  })

  it('retains each stopped segment and excludes pauses from execution time across recovery', () => {
    const clock = vi.spyOn(Date, 'now')
    const tracker = new WorkExecutionTracker('conversation-1')
    const manager = new TaskManager()
    try {
      clock.mockReturnValue(1_000)
      tracker.startRun('run-1', 'Inspect the workspace')
      tracker.setResponseMode('task')
      clock.mockReturnValue(8_000)
      tracker.setPhase('paused')
      tracker.setPhase('paused')
      clock.mockReturnValue(100_000)
      tracker.setPhase('thinking')
      clock.mockReturnValue(105_000)
      tracker.setPhase('paused')
      clock.mockReturnValue(200_000)
      tracker.setPhase('thinking')
      clock.mockReturnValue(248_000)
      tracker.finishRun('completed', 'Done')
      const snapshot = tracker.getSnapshot(manager)
      expect(snapshot.runs[0]).toMatchObject({ responseMode: 'task', presentation: 'work', executionSegments: [
        { startedAt: 1_000, endedAt: 8_000, outcome: 'paused' },
        { startedAt: 100_000, endedAt: 105_000, outcome: 'paused' },
        { startedAt: 200_000, endedAt: 248_000, outcome: 'completed' },
      ] })
      const restored = new WorkExecutionTracker('conversation-1')
      restored.restoreSnapshot(snapshot, manager)
      snapshot.runs[0].executionSegments![0].endedAt = 999_000
      expect(restored.getSnapshot(manager).runs[0].executionSegments?.[0].endedAt).toBe(8_000)
    } finally {
      clock.mockRestore()
    }
  })

  it('freezes timing at the stop click and does not count cleanup or downtime', () => {
    const clock = vi.spyOn(Date, 'now')
    const tracker = new WorkExecutionTracker('conversation-1')
    try {
      clock.mockReturnValue(1_000)
      tracker.startRun('run-1', 'Inspect')
      tracker.setResponseMode('task')
      clock.mockReturnValue(8_000)
      tracker.setPhase('aborting')
      clock.mockReturnValue(20_000)
      tracker.finishRun('cancelled')
      expect(tracker.getSnapshot(new TaskManager()).runs[0].executionSegments).toEqual([
        { startedAt: 1_000, endedAt: 8_000, outcome: 'stopped' },
      ])
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps chat presentation even if task records exist', () => {
    const tracker = new WorkExecutionTracker('conversation-1')
    const manager = new TaskManager()
    tracker.startRun('run-1', 'Hello')
    tracker.setResponseMode('chat')
    manager.createTask({ title: 'Legacy task', description: '', priority: 'major' })
    expect(tracker.getSnapshot(manager).runs[0].presentation).toBe('conversation')
    expect(() => tracker.setResponseMode('task')).toThrow('already declared')
  })

  it('separates failed attempts from the final step outcome', () => {
    const manager = new TaskManager()
    const task = manager.createTask({ title: 'Verify', description: 'Verify behavior', priority: 'major' })
    manager.updateTask(task.id, { status: 'in_progress' })
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.startRun('run-1', 'Fix and verify')

    tracker.startTool({ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }, task.id, 'a.ts')
    tracker.finishTool({ toolCallId: 'call-1', name: 'read_file', output: 'temporary failure', isError: true })
    tracker.startTool({ id: 'call-2', name: 'read_file', arguments: { path: 'a.ts' } }, task.id, 'a.ts')
    tracker.finishTool({ toolCallId: 'call-2', name: 'read_file', output: 'ok' })
    manager.updateTask(task.id, { status: 'completed' })

    const snapshot = tracker.getSnapshot(manager)
    const run = snapshot.runs[0]
    expect(run.steps[task.id].status).toBe('completed')
    expect(Object.values(run.activities).map(activity => activity.status)).toEqual(['failed', 'recovered'])
  })

  it('uses indeterminate progress instead of deriving it from tool count', () => {
    const manager = new TaskManager()
    const task = manager.createTask({ title: 'Explore', description: 'Unknown amount of work', priority: 'major' })
    manager.updateTask(task.id, { status: 'in_progress' })
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.startRun('run-1', 'Explore')
    tracker.startTool({ id: 'call-1', name: 'search_files', arguments: {} }, task.id)
    tracker.finishTool({ toolCallId: 'call-1', name: 'search_files', output: 'ok' })

    expect(tracker.getSnapshot(manager).runs[0].steps[task.id]).toMatchObject({
      progress: null,
      progressMode: 'indeterminate',
    })
  })

  it('counts retries only when the tool arguments describe the same action', () => {
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.startRun('run-1', 'Research sources')
    tracker.startTool({ id: 'open-1', name: 'browser__open', arguments: { url: 'https://example.com/one' } })
    tracker.finishTool({ toolCallId: 'open-1', name: 'browser__open', output: 'ok' })
    tracker.startTool({ id: 'open-2', name: 'browser__open', arguments: { url: 'https://example.com/two' } })
    tracker.finishTool({ toolCallId: 'open-2', name: 'browser__open', output: 'ok' })
    tracker.startTool({ id: 'open-3', name: 'browser__open', arguments: { url: 'https://example.com/one' } })

    const activities = Object.values(tracker.getSnapshot(new TaskManager()).runs[0].activities)
    expect(activities.map(activity => activity.attempt)).toEqual([1, 1, 2])
  })

  it('settles the running step as failed and exposes dependent steps as blocked', () => {
    const manager = new TaskManager()
    const first = manager.createTask({ title: 'Research', description: 'Collect sources', priority: 'major' })
    const second = manager.createTask({ title: 'Build deck', description: 'Create slides', priority: 'major' })
    manager.addDependency(second.id, first.id)
    manager.updateTask(first.id, { status: 'in_progress' })
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.startRun('run-1', 'Research and create a deck')
    tracker.syncTasks(manager)

    tracker.finishRun('failed', undefined, 'Model request failed', manager)

    const run = tracker.getSnapshot(manager).runs[0]
    expect(manager.getTask(first.id)).toMatchObject({ status: 'failed', error: 'Model request failed' })
    expect(run.steps[first.id]).toMatchObject({ status: 'failed', error: 'Model request failed' })
    expect(run.steps[second.id].status).toBe('blocked')
  })

  it('round-trips the versioned execution snapshot without sharing mutable state', () => {
    const manager = new TaskManager()
    const task = manager.createTask({ title: 'Build', description: 'Build the application', priority: 'major' })
    manager.updateTask(task.id, { status: 'in_progress' })
    const source = new WorkExecutionTracker('conversation-1')
    source.startRun('run-1', 'Build and verify')
    source.syncTasks(manager)
    manager.updateTask(task.id, { status: 'completed' })
    source.finishRun('completed', 'Built and verified')

    const persisted = source.getSnapshot(manager)
    expect(persisted.schemaVersion).toBe(WORK_EXECUTION_SCHEMA_VERSION)

    const restored = new WorkExecutionTracker('conversation-1')
    expect(restored.restoreSnapshot(persisted, manager)).toBe(true)
    const roundTripped = restored.getSnapshot(manager)
    expect(roundTripped.schemaVersion).toBe(persisted.schemaVersion)
    expect(roundTripped.currentRunId).toBe(persisted.currentRunId)
    expect(roundTripped.runs[0]).toMatchObject({
      id: persisted.runs[0].id,
      objective: persisted.runs[0].objective,
      presentation: persisted.runs[0].presentation,
      status: persisted.runs[0].status,
      phase: persisted.runs[0].phase,
      rootStepIds: persisted.runs[0].rootStepIds,
      steps: persisted.runs[0].steps,
      activities: persisted.runs[0].activities,
    })

    roundTripped.runs[0].steps[task.id].title = 'Changed outside the tracker'
    expect(restored.getSnapshot(manager).runs[0].steps[task.id].title).toBe('Build')
  })

  it('migrates snapshots written before presentation was persisted', () => {
    const manager = new TaskManager()
    const task = manager.createTask({ title: 'Verify', description: 'Run checks', priority: 'major' })
    const source = new WorkExecutionTracker('conversation-1')
    source.startRun('run-1', 'Verify the release')
    source.syncTasks(manager)
    source.finishRun('completed', 'Verified')
    const legacy = source.getSnapshot(manager) as WorkExecutionSnapshot & {
      runs: Array<WorkExecutionSnapshot['runs'][number] & { presentation?: 'conversation' | 'work' }>
    }
    delete legacy.runs[0].presentation

    const restored = new WorkExecutionTracker('conversation-1')
    expect(restored.restoreSnapshot(legacy as WorkExecutionSnapshot, manager)).toBe(true)
    expect(restored.getSnapshot(manager).runs[0].presentation).toBe('work')
  })

  it('recovers a failed attempt followed by a successful retry from journal turns', () => {
    const turns: AgentTurn[] = [
      { id: 'user-1', role: 'user', content: 'Inspect the project', timestamp: 100, metadata: { workRunId: 'run-1' } },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 110,
        metadata: { workRunId: 'run-1' },
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/app.ts' } }],
      },
      {
        id: 'result-1',
        role: 'tool_result',
        content: 'read_file failed',
        timestamp: 120,
        toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: 'temporary failure', isError: true }],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        timestamp: 130,
        metadata: { workRunId: 'run-1' },
        toolCalls: [{ id: 'call-2', name: 'read_file', arguments: { path: 'src/app.ts' } }],
      },
      {
        id: 'result-2',
        role: 'tool_result',
        content: 'read_file succeeded',
        timestamp: 140,
        toolResults: [{ toolCallId: 'call-2', name: 'read_file', output: 'ok' }],
      },
      { id: 'assistant-3', role: 'assistant', content: 'Done', timestamp: 150, metadata: { workRunId: 'run-1' } },
    ]
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.restoreFromTurns(turns, new TaskManager())

    const run = tracker.getSnapshot(new TaskManager()).runs[0]
    expect(run).toMatchObject({ id: 'run-1', status: 'completed', recoveredFromPersistence: true })
    expect(Object.values(run.activities).map(activity => activity.status)).toEqual(['failed', 'recovered'])
  })

  it('restores interrupted journal work as partial instead of completed', () => {
    const turns: AgentTurn[] = [
      { id: 'user-1', role: 'user', content: 'Inspect the project', timestamp: 100, metadata: { workRunId: 'run-1' } },
      {
        id: 'assistant-1', role: 'assistant', content: 'Still inspecting', timestamp: 110,
        metadata: { workRunId: 'run-1', interrupted: true },
      },
    ]
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.restoreFromTurns(turns, new TaskManager())

    expect(tracker.getSnapshot(new TaskManager()).runs[0]).toMatchObject({
      id: 'run-1',
      status: 'partial',
      phase: 'partial',
      recoveredFromPersistence: true,
    })
  })

  it('keeps an interrupted historical run partial when a later run exists', () => {
    const turns: AgentTurn[] = [
      { id: 'user-1', role: 'user', content: 'First task', timestamp: 100, metadata: { workRunId: 'run-1' } },
      { id: 'assistant-1', role: 'assistant', content: 'Stopped', timestamp: 110, metadata: { workRunId: 'run-1', interrupted: true } },
      { id: 'user-2', role: 'user', content: 'Second task', timestamp: 120, metadata: { workRunId: 'run-2' } },
      { id: 'assistant-2', role: 'assistant', content: 'Done', timestamp: 130, metadata: { workRunId: 'run-2' } },
    ]
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.restoreFromTurns(turns, new TaskManager())

    expect(tracker.getSnapshot(new TaskManager()).runs).toMatchObject([
      { id: 'run-1', status: 'partial', phase: 'partial' },
      { id: 'run-2', status: 'completed', phase: 'completed' },
    ])
  })

  it('converts a persisted active run into a recovered partial run', () => {
    const manager = new TaskManager()
    const source = new WorkExecutionTracker('conversation-1')
    source.startRun('run-1', 'Long-running task', 100)
    const activeSnapshot = source.getSnapshot(manager)
    const restored = new WorkExecutionTracker('conversation-1')

    expect(restored.restoreSnapshot(activeSnapshot, manager)).toBe(true)
    expect(restored.getSnapshot(manager)).toMatchObject({
      currentRunId: null,
      runs: [{ id: 'run-1', status: 'partial', phase: 'partial', recoveredFromPersistence: true }],
    })
  })

  it('uses journal terminal evidence to settle stale running snapshot activities', () => {
    const turns: AgentTurn[] = [
      { id: 'user-1', role: 'user', content: 'Inspect', timestamp: 100, metadata: { workRunId: 'run-1' } },
      {
        id: 'assistant-1', role: 'assistant', content: '', timestamp: 110,
        metadata: { workRunId: 'run-1' },
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'package.json' } }],
      },
      {
        id: 'result-1', role: 'tool_result', content: 'read_file succeeded', timestamp: 120,
        toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: 'ok' }],
      },
      { id: 'assistant-2', role: 'assistant', content: 'Done', timestamp: 130, metadata: { workRunId: 'run-1' } },
    ]
    const manager = new TaskManager()
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.restoreFromTurns(turns, manager)
    const stale = tracker.getSnapshot(manager)
    stale.runs[0].activities['activity-call-1'].status = 'running'
    delete stale.runs[0].activities['activity-call-1'].completedAt

    expect(tracker.restoreSnapshot(stale, manager)).toBe(true)
    expect(tracker.getSnapshot(manager).runs[0].activities['activity-call-1']).toMatchObject({
      status: 'completed',
      result: 'ok',
    })
  })

  it('rejects unsupported snapshot versions without replacing current state', () => {
    const manager = new TaskManager()
    const tracker = new WorkExecutionTracker('conversation-1')
    tracker.startRun('current-run', 'Keep current state')
    const unsupported = {
      schemaVersion: WORK_EXECUTION_SCHEMA_VERSION + 1,
      currentRunId: null,
      runs: [],
    } as unknown as WorkExecutionSnapshot

    expect(tracker.restoreSnapshot(unsupported, manager)).toBe(false)
    expect(tracker.getSnapshot(manager).runs[0].id).toBe('current-run')
  })
})
