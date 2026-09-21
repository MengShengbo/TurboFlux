import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { summarizeModelRequests } from '@turboflux/contracts/modelUsage'
import type { ModelRequestRecord, TokenUsage } from '@turboflux/contracts/agentTypes'
import type { AnyConversationEvent } from '@turboflux/contracts/conversationEvent'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import type { PersistedConversation } from './types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-usage-')); roots.push(root)
  const value: PersistedConversation = { id: 'conversation-usage', title: 'Usage audit', workspacePath: '/workspace', createdAt: 1, updatedAt: 1, mode: 'vibe', model: 'test', provider: 'custom', turnCount: 0, turns: [] }
  let seq = 0
  const open = () => new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace-12345678', '/workspace')
  const repository = open()
  const send = (type: AnyConversationEvent['type'], payload: unknown, fields = {}) => repository.appendCanonical({
    schemaVersion: 1, eventId: `event-${++seq}`, conversationId: value.id, threadId: value.id,
    seq, at: seq, source: 'agent', provenance: 'live', runId: 'run', type, payload, ...fields,
  } as AnyConversationEvent, value)
  return { root, value, send, open, repository }
}
function attempt(id: string, patch: Partial<ModelRequestRecord> = {}): ModelRequestRecord {
  return { id, requestId: 'logical-request', runId: 'run', model: 'test', provider: 'custom', protocol: 'openai_responses', purpose: 'turn', status: 'running', startedAt: 1, updatedAt: 1, usage: { source: 'unknown' }, usageFinal: false, ...patch }
}

describe('persistent model usage', () => {
  it('reopens retries, cumulative updates and cache diagnosis without double counting', () => {
    const h = harness(); h.send('run.started', { objective: 'audit' })
    h.send('model.request_updated', { request: attempt('failed', { status: 'failed', updatedAt: 2, httpStatus: 400 }) })
    h.send('model.request_updated', { request: attempt('accepted') })
    h.send('model.request_updated', { request: attempt('accepted', { updatedAt: 3, usage: { input: 10000, cached: 8000, output: 5, source: 'provider' } }) })
    const final = attempt('accepted', { status: 'completed', updatedAt: 4, usageFinal: true, providerResponseId: 'resp-real', usage: { input: 10000, cached: 8000, output: 100, reasoning: 40, source: 'provider' }, cacheDiagnostic: { broken: true, reason: 'upstream cache drop', tokenDrop: 3000, likelyTtlExpiry: false } })
    h.send('model.request_updated', { request: final });h.send('model.request_updated', { request: final })
    h.send('usage.updated', { usage: final.usage, requestId: final.requestId, attemptId: final.id })
    const loaded = h.open().load(h.value.id)!
    expect(loaded.modelRequests).toHaveLength(2)
    expect(summarizeModelRequests(loaded.modelRequests!)).toMatchObject({ requests: 1, attempts: 2, unknownUsageAttempts: 1, totals: { input: 10000, cached: 8000, output: 100, reasoning: 40 }, cacheHitRate: .8 })
    expect(loaded.modelRequests?.find(r => r.id === 'accepted')).toMatchObject({ providerResponseId: 'resp-real', cacheDiagnostic: final.cacheDiagnostic })
    expect(loaded.canonicalEvents?.filter(e => e.type === 'usage.updated')).toHaveLength(1)
    // Imported/saved history preserves the same accounting after another reopen.
    h.open().persist(loaded)
    expect(summarizeModelRequests(h.open().load(h.value.id)!.modelRequests!)).toEqual(summarizeModelRequests(loaded.modelRequests!))
  })

  it('retains usage from the old live event format while deduplicating updates to the same step', () => {
    const h=harness();h.send('run.started',{objective:'legacy'})
    const usage:TokenUsage={ input: 1200, cached: 1000, output: 20, source:'provider' }
    h.send('usage.updated',{usage},{stepId:'step-1'});h.send('usage.updated',{usage:{...usage,output:30}},{stepId:'step-1'})
    h.send('usage.updated',{usage:{...usage,input:1400,cached:1200}},{stepId:'step-2'})
    const loaded=h.open().load(h.value.id)!
    expect(summarizeModelRequests(loaded.modelRequests!)).toMatchObject({attempts:2,totals:{input:2600,cached:2200,output:50}})
  })

  it('keeps partial consumption through crash recovery and does not invent absent old usage', () => {
    const h=harness();h.send('run.started',{objective:'crash'})
    expect(h.open().load(h.value.id)?.modelRequests).toBeUndefined()
    h.send('model.request_updated',{request:attempt('partial',{usage:{input:500,output:5,source:'provider'}})})
    const loaded=h.open().load(h.value.id)!
    expect(loaded.modelRequests?.[0]).toMatchObject({status:'interrupted',usageFinal:false,usage:{input:500,output:5}})
    const data=new ConversationRepositoryV2(h.root).projection(h.value.id)
    expect(data.modelRequests?.[0]?.status).toBe('running')
  })

  it('rejects malformed or secret-bearing request payloads before they reach disk', () => {
    const h = harness()
    expect(() => h.send('model.request_updated', { request: { ...attempt('secret'), authorization: 'Bearer should-not-persist' } })).toThrow()
    expect(() => h.send('model.request_updated', { request: attempt('negative', { usage: { input: -5 } }) })).toThrow()
    expect(() => h.send('model.request_updated', { request: attempt('impossible', { usage: { input: 10, cached: 20 } }) })).toThrow()
  })

  it('retains spent model usage when rewriting the message history', () => {
    const h = harness(); h.send('run.started', { objective: 'rewrite' })
    h.send('model.request_updated', { request: attempt('spent', { status: 'completed', usageFinal: true, usage: { input: 100, cached: 80, output: 5, source: 'provider' } }) })
    const loaded = h.open().load(h.value.id)!
    loaded.turns = []
    loaded.updatedAt += 100
    h.repository.rewrite(loaded)
    expect(summarizeModelRequests(h.open().load(h.value.id)!.modelRequests!)).toMatchObject({ attempts: 1, totals: { input: 100, cached: 80, output: 5 } })
  })

  it('preserves per-turn usage and attempt linkage after closing and reopening the repository', () => {
    const h=harness();const tokens={input:1200,output:50,cached:1100,source:'provider' as const}
    const turn={id:'assistant',role:'assistant' as const,content:'done',timestamp:4,metadata:{tokens,model:'test',duration:23,modelRequestId:'logical-request',modelAttemptId:'attempt'}}
    h.send('turn.completed',{turn},{turnId:turn.id})
    expect(h.open().load(h.value.id)?.turns[0]?.metadata).toMatchObject(turn.metadata)
  })
})
