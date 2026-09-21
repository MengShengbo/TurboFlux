import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeLogWriter } from './runtimeLogWriter'

describe('RuntimeLogWriter', () => {
  it('flushes JSONL asynchronously and rotates bounded log files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-log-'))
    const logPath = join(root, 'task.jsonl')
    try {
      const writer = new RuntimeLogWriter(logPath, {
        maxFileBytes: 1024,
        maxFiles: 2,
        batchBytes: 1024,
      })
      writer.append('stdout', 'a'.repeat(800))
      writer.append('stderr', 'b'.repeat(800))
      await writer.flush()
      writer.append('stdout', 'final-output', 17)
      await writer.close()

      expect(existsSync(`${logPath}.1`)).toBe(true)
      expect(readFileSync(`${logPath}.1`, 'utf8')).toContain('a'.repeat(20))
      expect(readFileSync(logPath, 'utf8')).toContain('final-output')
      expect(JSON.parse(readFileSync(logPath, 'utf8').trim())).toMatchObject({ seq: 17, data: 'final-output' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases backpressure when durable logging fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-runtime-log-error-'))
    try {
      const errors: Error[] = []
      let drained = 0
      const writer = new RuntimeLogWriter(root, {
        batchBytes: 1024,
        highWaterBytes: 1024,
        onError: error => errors.push(error),
        onDrain: () => { drained += 1 },
      })
      expect(writer.append('stdout', 'x'.repeat(2048))).toBe(false)
      await writer.flush()

      expect(errors).toHaveLength(1)
      expect(drained).toBeGreaterThan(0)
      expect(writer.append('stdout', 'logging-is-disabled')).toBe(true)
      await writer.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
