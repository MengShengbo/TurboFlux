import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { ModelRequestRecord, TokenUsage } from '@turboflux/contracts/agentTypes'

export interface ModelRequestHandle {
  readonly record: ModelRequestRecord
  usage(usage: TokenUsage): void
  responseId(id: string): void
  finish(status: ModelRequestRecord['status'], httpStatus?: number): ModelRequestRecord
}

export class ModelRequestTracker {
  constructor(private readonly emit: (record: ModelRequestRecord) => void) {}

  begin(input: {
    requestId: string; runId?: string; model: string; provider: string;
    protocol: NonNullable<ModelRequestRecord['protocol']>; purpose: ModelRequestRecord['purpose']; serializedBody: string;
  }): ModelRequestHandle {
    const clock = performance.now()
    const at = Date.now()
    const record: ModelRequestRecord = {
      id: randomUUID(), requestId: input.requestId, runId: input.runId,
      model: input.model, provider: input.provider, protocol: input.protocol, purpose: input.purpose,
      status: 'running', startedAt: at, updatedAt: at,
      requestFingerprint: createHash('sha256').update(input.serializedBody).digest('hex'),
      usage: { source: 'unknown' }, usageFinal: false,
    }
    const publish = () => this.emit(structuredClone(record))
    publish()
    return {
      record,
      usage: usage => {
        if (record.status !== 'running') return
        record.usage = { ...record.usage, ...usage }
        record.updatedAt = Math.max(record.updatedAt, Date.now())
        publish()
      },
      responseId: id => { if (record.status === 'running') record.providerResponseId = id },
      finish: (status, httpStatus) => {
        if (record.status !== 'running') return structuredClone(record)
        record.status = status
        record.updatedAt = Math.max(record.updatedAt, Date.now())
        record.endedAt = record.updatedAt
        record.durationMs = Math.max(0, performance.now() - clock)
        record.usageFinal = status === 'completed' && record.usage.source === 'provider'
        if (httpStatus !== undefined) record.httpStatus = httpStatus
        publish()
        return structuredClone(record)
      },
    }
  }
}
