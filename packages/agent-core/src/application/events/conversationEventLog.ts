import { randomUUID } from 'node:crypto'
import {
  CONVERSATION_EVENT_SCHEMA_VERSION,
  type AnyAppendConversationEventInput,
  type AnyConversationEvent,
  type AppendConversationEventInput,
  type ConversationEventEnvelope,
  type ConversationEventType,
} from './conversationEvent'

export const DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT = 4_096

export interface ConversationEventWindowSnapshot {
  schemaVersion: typeof CONVERSATION_EVENT_SCHEMA_VERSION
  conversationId: string
  threadId: string
  baseSeq: number
  lastSeq: number
  eventCount: number
  droppedEventCount: number
  hasMore: boolean
}

export interface ConversationEventLogOptions {
  windowLimit?: number
  now?: () => number
  createId?: () => string
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value!)) : fallback
}

function clonePayload<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(object as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function immutableEvent(event: AnyConversationEvent): AnyConversationEvent {
  return deepFreeze({
    ...event,
    payload: clonePayload(event.payload),
  } as AnyConversationEvent)
}

export class ConversationEventLog {
  private readonly windowLimit: number
  private readonly now: () => number
  private readonly createId: () => string
  private events: AnyConversationEvent[] = []
  private eventStart = 0
  private eventCount = 0
  private nextSeq = 0
  private droppedEventCount = 0
  private readonly observedEventIds = new Set<string>()

  constructor(
    private conversationId: string,
    private threadId = conversationId,
    options: ConversationEventLogOptions = {},
  ) {
    this.windowLimit = positiveInteger(options.windowLimit, DEFAULT_CONVERSATION_EVENT_WINDOW_LIMIT)
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  getSnapshot(): ConversationEventWindowSnapshot {
    const firstEvent = this.eventAt(0)
    const lastEvent = this.eventAt(this.eventCount - 1)
    return {
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      conversationId: this.conversationId,
      threadId: this.threadId,
      baseSeq: firstEvent?.seq ?? this.nextSeq + 1,
      lastSeq: lastEvent?.seq ?? this.nextSeq,
      eventCount: this.eventCount,
      droppedEventCount: this.droppedEventCount,
      hasMore: this.droppedEventCount > 0,
    }
  }

  getEvents(): readonly AnyConversationEvent[] {
    if (this.eventCount === 0) return []
    const end = this.eventStart + this.eventCount
    if (end <= this.events.length) return this.events.slice(this.eventStart, end)
    return [
      ...this.events.slice(this.eventStart),
      ...this.events.slice(0, end - this.events.length),
    ]
  }

  getLastSequence(): number {
    return this.nextSeq
  }

  append<T extends ConversationEventType>(input: AppendConversationEventInput<T>): ConversationEventEnvelope<T> | null
  append(input: AnyAppendConversationEventInput): AnyConversationEvent | null
  append(input: AnyAppendConversationEventInput): AnyConversationEvent | null {
    this.assertCoordinates(input.conversationId, input.threadId)
    const eventId = input.eventId ?? this.createId()
    if (this.observedEventIds.has(eventId)) return null
    const event = immutableEvent({
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      eventId,
      conversationId: this.conversationId,
      threadId: this.threadId,
      runId: input.runId,
      turnId: input.turnId,
      stepId: input.stepId,
      itemId: input.itemId,
      seq: this.nextSeq + 1,
      at: input.at ?? this.now(),
      source: input.source,
      provenance: input.provenance ?? 'live',
      type: input.type,
      payload: input.payload,
    } as AnyConversationEvent)
    this.nextSeq = event.seq
    this.store(event)
    return event
  }

  appendMany(inputs: readonly AnyAppendConversationEventInput[]): readonly AnyConversationEvent[] {
    for (const input of inputs) this.assertCoordinates(input.conversationId, input.threadId)
    const appended: AnyConversationEvent[] = []
    for (const input of inputs) {
      const event = this.append(input) as AnyConversationEvent | null
      if (event) appended.push(event)
    }
    return appended
  }

  replay(events: readonly AnyConversationEvent[]): ConversationEventWindowSnapshot {
    this.reset()
    let previousSeq: number | undefined
    for (const candidate of events) {
      if (candidate.schemaVersion !== CONVERSATION_EVENT_SCHEMA_VERSION) {
        throw new Error(`Unsupported conversation event schema: ${candidate.schemaVersion}`)
      }
      this.assertCoordinates(candidate.conversationId, candidate.threadId)
      if (!Number.isInteger(candidate.seq) || candidate.seq < 1) throw new Error(`Invalid conversation event sequence: ${candidate.seq}`)
      if (previousSeq !== undefined && candidate.seq !== previousSeq + 1) {
        throw new Error(`Conversation event replay expected seq ${previousSeq + 1}, received ${candidate.seq}`)
      }
      if (this.observedEventIds.has(candidate.eventId)) throw new Error(`Duplicate conversation event id during replay: ${candidate.eventId}`)
      if (previousSeq === undefined && candidate.seq > 1) this.droppedEventCount = candidate.seq - 1
      const event = immutableEvent(candidate)
      this.nextSeq = event.seq
      this.store(event)
      previousSeq = event.seq
    }
    return this.getSnapshot()
  }

  activate(conversationId: string, threadId = conversationId): void {
    if (conversationId === this.conversationId && threadId === this.threadId) return
    this.conversationId = conversationId
    this.threadId = threadId
    this.reset()
  }

  private assertCoordinates(conversationId?: string, threadId?: string): void {
    if (conversationId !== undefined && conversationId !== this.conversationId) {
      throw new Error(`Conversation event belongs to ${conversationId}, expected ${this.conversationId}`)
    }
    if (threadId !== undefined && threadId !== this.threadId) {
      throw new Error(`Conversation event belongs to thread ${threadId}, expected ${this.threadId}`)
    }
  }

  private store(event: AnyConversationEvent): void {
    this.observedEventIds.add(event.eventId)
    if (this.eventCount < this.windowLimit) {
      const insertAt = (this.eventStart + this.eventCount) % this.windowLimit
      if (insertAt === this.events.length) this.events.push(event)
      else this.events[insertAt] = event
      this.eventCount += 1
      return
    }
    this.events[this.eventStart] = event
    this.eventStart = (this.eventStart + 1) % this.windowLimit
    this.droppedEventCount += 1
  }

  private reset(): void {
    this.events = []
    this.eventStart = 0
    this.eventCount = 0
    this.nextSeq = 0
    this.droppedEventCount = 0
    this.observedEventIds.clear()
  }

  private eventAt(offset: number): AnyConversationEvent | undefined {
    if (offset < 0 || offset >= this.eventCount) return undefined
    return this.events[(this.eventStart + offset) % this.windowLimit]
  }
}
