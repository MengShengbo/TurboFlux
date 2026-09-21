import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchEvent } from '@turboflux/workbench'
import { UserActivityStore, localActivityDate } from './userActivity'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'turboflux-user-activity-'))
  directories.push(root)
  const path = join(root, 'activity.json')
  const store = new UserActivityStore(path)
  await store.load()
  return { path, store }
}

function usage(total: number, options: { step?: string; at?: number; provenance?: string; source?: string } = {}): WorkbenchEvent {
  return { type: 'conversation-event', conversationId: 'conversation', event: {
    type: 'usage.updated', conversationId: 'conversation', eventId: `event-${total}`, runId: 'run', stepId: options.step || 'step-1',
    at: options.at ?? new Date(2026, 8, 19, 20).getTime(), provenance: options.provenance || 'live',
    payload: { usage: { input: total - 20, output: 20, total, cached: 30, source: options.source || 'provider' } },
  } } as WorkbenchEvent
}

describe('independent desktop token activity', () => {
  it('counts cumulative provider reports once, includes cached input once, and persists across restarts', async () => {
    const { path, store } = await setup()
    store.record(usage(100))
    store.record(usage(150))
    store.record(usage(150))
    store.record(usage(120))
    store.record(usage(70, { step: 'step-2' }))
    expect((await store.snapshot()).days['2026-09-19']).toBe(220)
    const restarted = new UserActivityStore(path)
    await restarted.load()
    restarted.record(usage(150))
    expect((await restarted.snapshot()).days['2026-09-19']).toBe(220)
    expect(JSON.parse(await readFile(path, 'utf8')).days['2026-09-19']).toBe(220)
  })

  it('counts two physical attempts in one model step separately and deduplicates each one', async () => {
    const { store } = await setup()
    const first = usage(100)
    const second = usage(80)
    if (first.type === 'conversation-event' && first.event.type === 'usage.updated') first.event.payload.attemptId = 'attempt-a'
    if (second.type === 'conversation-event' && second.event.type === 'usage.updated') second.event.payload.attemptId = 'attempt-b'
    store.record(first); store.record(first); store.record(second); store.record(second)
    expect((await store.snapshot()).days['2026-09-19']).toBe(180)
  })

  it('deduplicates the hidden initial request before a visible step exists', async () => {
    const { store } = await setup()
    const initial = usage(100)
    if (initial.type === 'conversation-event') delete initial.event.stepId
    const repeated = structuredClone(initial)
    if (repeated.type === 'conversation-event') repeated.event.eventId = 'second-usage-report'
    store.record(initial)
    store.record(repeated)
    store.record(usage(100, { step: 'visible-step' }))
    expect((await store.snapshot()).days['2026-09-19']).toBe(200)
  })

  it('assigns only new consumption to the local day when a request crosses midnight', async () => {
    const { store } = await setup()
    store.record(usage(100, { at: new Date(2026, 8, 19, 23, 59).getTime() }))
    store.record(usage(130, { at: new Date(2026, 8, 20, 0, 1).getTime() }))
    expect((await store.snapshot()).days).toEqual({ '2026-09-19': 100, '2026-09-20': 30 })
    expect(localActivityDate(new Date(2026, 0, 1, 0, 1).getTime())).toBe('2026-01-01')
  })

  it('ignores replay, estimates and invalid counts instead of inventing activity', async () => {
    const { store } = await setup()
    store.record(usage(100, { provenance: 'restored' }))
    store.record(usage(100, { source: 'unknown' }))
    store.record(usage(-10))
    const invalid = usage(100)
    if (invalid.type === 'conversation-event' && invalid.event.type === 'usage.updated') invalid.event.payload.usage = { total: Number.NaN, source: 'provider' }
    store.record(invalid)
    expect((await store.snapshot()).days).toEqual({})
  })

  it('includes a subagent turn once without counting its cached tokens twice', async () => {
    const { store } = await setup()
    const event = { type: 'conversation-event', conversationId: 'conversation', event: {
      type: 'runtime.event', conversationId: 'conversation', eventId: 'subagent-event', runId: 'run', at: new Date(2026, 8, 19, 20).getTime(), provenance: 'live',
      payload: { kind: 'subagent:progress', payload: { agentId: 'agent-1', event: { type: 'turn_complete', turn: 1, inputTokens: 300, outputTokens: 50, cacheReadTokens: 100 } } },
    } } as WorkbenchEvent
    store.record(event)
    store.record(event)
    expect((await store.snapshot()).days['2026-09-19']).toBe(350)
  })
})
