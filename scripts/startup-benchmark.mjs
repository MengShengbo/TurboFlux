#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { hrtime } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'bin', 'turboflux.mjs')
const cases = [
  ['version', ['--version']],
  ['help', ['--help']],
  ['config-show', ['config', 'show']],
  ['setup-show', ['setup', 'show']],
]
const samples = Number(process.env.TURBOFLUX_STARTUP_SAMPLES || 5)

for (const [name, args] of cases) {
  const times = []
  for (let index = 0; index < samples; index += 1) {
    const started = hrtime.bigint()
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: 'ignore' })
    const elapsed = Number(hrtime.bigint() - started) / 1e6
    if (result.error || result.status !== 0) throw result.error || new Error(`${name} exited with ${result.status}`)
    times.push(elapsed)
  }
  const average = times.reduce((sum, value) => sum + value, 0) / times.length
  const minimum = Math.min(...times)
  console.log(`${name}: avg=${average.toFixed(1)}ms min=${minimum.toFixed(1)}ms samples=${samples}`)
}
