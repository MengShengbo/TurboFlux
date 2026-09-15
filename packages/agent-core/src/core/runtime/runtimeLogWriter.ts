import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RuntimeLogWriterOptions {
  maxFileBytes?: number
  maxFiles?: number
  batchBytes?: number
  highWaterBytes?: number
  onDrain?: () => void
  onError?: (error: Error) => void
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_FILES = 8
const DEFAULT_BATCH_BYTES = 256 * 1024
const DEFAULT_HIGH_WATER_BYTES = 2 * 1024 * 1024

export class RuntimeLogWriter {
  private queue: string[] = []
  private queuedBytes = 0
  private fileBytes = 0
  private draining = false
  private closing = false
  private closed = false
  private failed = false
  private initialized = false
  private waiters: Array<() => void> = []
  private readonly maxFileBytes: number
  private readonly maxFiles: number
  private readonly batchBytes: number
  private readonly highWaterBytes: number

  constructor(private readonly path: string, private readonly options: RuntimeLogWriterOptions = {}) {
    this.maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
    this.batchBytes = Math.max(1024, options.batchBytes ?? DEFAULT_BATCH_BYTES)
    this.highWaterBytes = Math.max(this.batchBytes, options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES)
  }

  append(channel: 'stdout' | 'stderr', data: Buffer | string, sequence?: number): boolean {
    if (this.failed) return true
    if (this.closing || this.closed) return false
    const record = `${JSON.stringify({
      timestamp: Date.now(),
      channel,
      data: data.toString(),
      ...(typeof sequence === 'number' ? { seq: sequence } : {}),
    })}\n`
    this.queue.push(record)
    this.queuedBytes += Buffer.byteLength(record)
    void this.drain()
    return this.queuedBytes < this.highWaterBytes
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) return
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    await this.flush()
    this.closed = true
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(dirname(this.path), { recursive: true })
    try {
      this.fileBytes = (await stat(this.path)).size
    } catch {
      this.fileBytes = 0
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      await this.initialize()
      while (this.queue.length > 0) {
        const batch: string[] = []
        let batchSize = 0
        while (this.queue.length > 0 && batchSize < this.batchBytes) {
          const record = this.queue.shift()!
          const recordBytes = Buffer.byteLength(record)
          batch.push(record)
          batchSize += recordBytes
          this.queuedBytes -= recordBytes
        }
        if (this.fileBytes > 0 && this.fileBytes + batchSize > this.maxFileBytes) {
          await this.rotate()
        }
        await appendFile(this.path, batch.join(''), { encoding: 'utf8', mode: 0o600 })
        this.fileBytes += batchSize
        if (this.queuedBytes < this.highWaterBytes) this.options.onDrain?.()
      }
    } catch (error) {
      this.failed = true
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.queue = []
      this.queuedBytes = 0
      this.options.onDrain?.()
    } finally {
      this.draining = false
      if (this.queue.length > 0 && !this.closed) {
        void this.drain()
        return
      }
      const waiters = this.waiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  private async rotate(): Promise<void> {
    await rm(`${this.path}.${this.maxFiles}`, { force: true })
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      try {
        await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`)
      } catch {}
    }
    try {
      await rename(this.path, `${this.path}.1`)
    } catch {}
    this.fileBytes = 0
  }
}
