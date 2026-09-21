import { describe, expect, it } from 'vitest'
import { CONVERSATION_EVENT_SCHEMA_VERSION, type AnyConversationEvent } from '@turboflux/contracts/conversationEvent'
import { ConversationEventLog } from './conversationEventLog'

function runStarted(seq: number, eventId: string, objective = 'test'): AnyConversationEvent {
  return {
    schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
    eventId,
    conversationId: 'conversation-1',
    threadId: 'conversation-1',
    runId: 'run-1',
    seq,
    at: seq * 10,
    source: 'agent',
    provenance: 'live',
    type: 'run.started',
    payload: { objective },
  }
}

describe('ConversationEventLog', () => {
  it('assigns one monotonic sequence across event types', () => {
    let id = 0
    const log = new ConversationEventLog('conversation-1', 'conversation-1', {
      now: () => 100,
      createId: () => `event-${++id}`,
    })

    const started = log.append({
      source: 'agent',
      type: 'run.started',
      runId: 'run-1',
      payload: { objective: 'Build' },
    })
    const step = log.append({
      source: 'agent',
      type: 'step.started',
      runId: 'run-1',
      stepId: 'run-1:step:1',
      payload: { index: 1, model: 'test-model' },
    })

    expect(started).toMatchObject({ eventId: 'event-1', seq: 1, at: 100 })
    expect(step).toMatchObject({ eventId: 'event-2', seq: 2, stepId: 'run-1:step:1' })
    expect(log.getSnapshot()).toMatchObject({ baseSeq: 1, lastSeq: 2, eventCount: 2, hasMore: false })
  })

  it('clones and freezes appended facts', () => {
    const payload = { objective: 'Original' }
    const log = new ConversationEventLog('conversation-1')
    const event = log.append({ eventId: 'immutable', source: 'agent', type: 'run.started', payload })

    payload.objective = 'Mutated outside'

    expect(event?.payload).toEqual({ objective: 'Original' })
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event?.payload)).toBe(true)
  })

  it('deduplicates stable event ids without advancing sequence', () => {
    const log = new ConversationEventLog('conversation-1')
    expect(log.append({ eventId: 'same', source: 'agent', type: 'run.started', payload: {} })?.seq).toBe(1)
    expect(log.append({ eventId: 'same', source: 'flow', type: 'run.started', payload: {} })).toBeNull()
    expect(log.getLastSequence()).toBe(1)
  })

  it('rejects events for another conversation or thread before mutation', () => {
    const log = new ConversationEventLog('conversation-1', 'thread-1')

    expect(() => log.append({
      conversationId: 'conversation-2',
      source: 'agent',
      type: 'run.started',
      payload: {},
    })).toThrow('expected conversation-1')
    expect(() => log.append({
      threadId: 'thread-2',
      source: 'agent',
      type: 'run.started',
      payload: {},
    })).toThrow('expected thread-1')
    expect(log.getLastSequence()).toBe(0)
  })

  it('retains a bounded event window while preserving total sequence', () => {
    const log = new ConversationEventLog('conversation-1', 'conversation-1', { windowLimit: 3 })
    for (let index = 1; index <= 5; index += 1) {
      log.append({ eventId: `event-${index}`, source: 'agent', type: 'run.started', payload: { objective: String(index) } })
    }

    expect(log.getEvents().map(event => event.seq)).toEqual([3, 4, 5])
    expect(log.getSnapshot()).toEqual({
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      conversationId: 'conversation-1',
      threadId: 'conversation-1',
      baseSeq: 3,
      lastSeq: 5,
      eventCount: 3,
      droppedEventCount: 2,
      hasMore: true,
    })
  })

  it('replays deterministically and continues from the restored sequence', () => {
    const source = [runStarted(5, 'event-5', 'five'), runStarted(6, 'event-6', 'six')]
    const first = new ConversationEventLog('conversation-1', 'conversation-1', { windowLimit: 4 })
    const second = new ConversationEventLog('conversation-1', 'conversation-1', { windowLimit: 4 })

    expect(first.replay(source)).toEqual(second.replay(source))
    expect(first.getEvents()).toEqual(second.getEvents())
    expect(first.append({ eventId: 'event-7', source: 'agent', type: 'run.completed', payload: { outcome: 'completed' } })?.seq).toBe(7)
    expect(first.getSnapshot()).toMatchObject({ baseSeq: 5, lastSeq: 7, droppedEventCount: 4 })
  })

  it('rejects replay gaps, duplicate ids, and unsupported schemas', () => {
    const log = new ConversationEventLog('conversation-1')
    expect(() => log.replay([runStarted(1, 'one'), runStarted(3, 'three')])).toThrow('expected seq 2')
    expect(() => log.replay([runStarted(1, 'same'), runStarted(2, 'same')])).toThrow('Duplicate conversation event id')
    expect(() => log.replay([{ ...runStarted(1, 'bad-schema'), schemaVersion: 99 as 1 }])).toThrow('Unsupported conversation event schema')
  })

  it('activates another conversation with a fresh sequence domain', () => {
    const log = new ConversationEventLog('conversation-1')
    log.append({ eventId: 'old', source: 'agent', type: 'run.started', payload: {} })

    log.activate('conversation-2', 'thread-2')
    const event = log.append({ eventId: 'new', source: 'agent', type: 'run.started', payload: {} })

    expect(event).toMatchObject({ conversationId: 'conversation-2', threadId: 'thread-2', seq: 1 })
    expect(log.getEvents()).toEqual([event])
  })
})
