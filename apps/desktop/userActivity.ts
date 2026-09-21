import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkbenchEvent } from '@turboflux/workbench'
import type { DesktopUserActivity } from './desktopTypes'

interface ActivityFile extends DesktopUserActivity {
  version: 1
  requests: Record<string, number>
}

export function localActivityDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Usage reports are cumulative within a model request; cached tokens are already part of input. */
export class UserActivityStore {
  private data: ActivityFile
  private pending = Promise.resolve()
  private writeError: unknown

  constructor(private readonly path: string, now = Date.now()) {
    this.data = { version: 1, recordedSince: now, days: {}, requests: {} }
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as ActivityFile
      if (saved.version !== 1
        || !Number.isFinite(saved.recordedSince) || !saved.days || !saved.requests
        || Object.entries(saved.days).some(([day, count]) => !/^\d{4}-\d{2}-\d{2}$/u.test(day) || tokens(count) !== count)
        || Object.values(saved.requests).some(count => tokens(count) !== count)) {
        throw new Error('Token 活动记录格式无效')
      }
      this.data = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  record(event: WorkbenchEvent): void {
    if (event.type !== 'conversation-event' || event.event.provenance !== 'live') return
    const entry = event.event
    let requestId: string
    let total: number
    if (entry.type === 'usage.updated') {
      const usage = entry.payload.usage
      if (usage.source !== 'provider' || [usage.total, usage.input, usage.output].some(value =>
        value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))) return
      // The initial response-mode declaration reports usage before a visible step exists.
      requestId = entry.payload.attemptId
        ? `${entry.conversationId}:attempt:${entry.payload.attemptId}`
        : `${entry.conversationId}:${entry.runId || entry.eventId}:${entry.stepId || 'declaration'}`
      total = tokens(usage.total) || tokens(usage.input) + tokens(usage.output)
    } else if (entry.type === 'runtime.event' && entry.payload.kind === 'subagent:progress') {
      const payload = entry.payload.payload as { agentId?: string; event?: { type?: string; turn?: number; inputTokens?: number; outputTokens?: number } } | undefined
      if (!payload?.agentId || payload.event?.type !== 'turn_complete' || !Number.isInteger(payload.event.turn)) return
      requestId = `${entry.conversationId}:${entry.runId}:subagent:${payload.agentId}:${payload.event.turn}`
      total = tokens(payload.event.inputTokens) + tokens(payload.event.outputTokens)
    } else return
    if (!total || !Number.isFinite(entry.at)) return
    const key = createHash('sha256').update(requestId).digest('hex')
    const previous = this.data.requests[key] || 0
    if (total <= previous) return
    const day = localActivityDate(entry.at)
    this.data.requests[key] = total
    this.data.days[day] = (this.data.days[day] || 0) + total - previous
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(this.data)}\n`, { mode: 0o600 })
      await rename(temporary, this.path)
      this.writeError = undefined
    }).catch(error => {
      this.writeError = error
      console.error('Unable to persist profile token activity:', error)
    })
  }

  async snapshot(): Promise<DesktopUserActivity> {
    await this.pending
    if (this.writeError) throw this.writeError
    return { recordedSince: this.data.recordedSince, days: { ...this.data.days } }
  }
}
