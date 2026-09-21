import { describe, expect, it, vi } from 'vitest'
import { ModelRequestTracker } from './modelRequestTracker'
import type { ModelRequestRecord } from '@turboflux/contracts/agentTypes'

const input={requestId:'logical',protocol:'openai_responses' as const,provider:'custom',model:'test',purpose:'turn' as const,serializedBody:'{"input":"private conversation","model":"test"}'}
describe('ModelRequestTracker',()=>{
  it('creates distinct physical attempts, isolates emitted data, and keeps unknown consumption',()=>{
    const events:ModelRequestRecord[]=[];const tracker=new ModelRequestTracker(r=>events.push(r))
    const failed=tracker.begin(input);const first=failed.finish('failed',400)
    const accepted=tracker.begin(input);accepted.usage({input:100,cached:80,output:10,source:'provider'});accepted.responseId('resp-1');const second=accepted.finish('completed',200)
    expect(first.id).not.toBe(second.id);expect(first.requestId).toBe(second.requestId)
    expect(first.usage).toEqual({source:'unknown'});expect(first.usageFinal).toBe(false)
    expect(second).toMatchObject({status:'completed',usageFinal:true,providerResponseId:'resp-1',usage:{input:100,cached:80,output:10}})
    const count=events.length;accepted.finish('failed');expect(events).toHaveLength(count)
    events.at(-1)!.usage.input=999;expect(second.usage.input).toBe(100)
    expect(JSON.stringify(events)).not.toContain('private conversation')
  })

  it('uses monotonic duration even when the wall clock moves backwards',()=>{
    const now=vi.spyOn(Date,'now');now.mockReturnValueOnce(10000).mockReturnValue(100)
    try{const record=new ModelRequestTracker(()=>{}).begin(input).finish('interrupted');expect(record.durationMs).toBeGreaterThanOrEqual(0)}finally{now.mockRestore()}
  })
})
