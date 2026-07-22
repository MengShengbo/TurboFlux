import { describe, expect, it } from 'vitest'
import { spawnCaptured } from '../../scripts/retrieval-paper/runners'

describe('benchmark process capture', () => {
  it('settles after terminating a timed-out process tree', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const startedAt = Date.now()

    const result = await spawnCaptured(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
    })

    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  }, 10_000)
})
