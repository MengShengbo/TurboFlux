import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const generatedRoot = join(desktopRoot, 'generated', 'profile-benchmarks')
const entryPath = join(generatedRoot, 'profile-switch-benchmark.mjs')
await mkdir(generatedRoot, { recursive: true })
await build({
  entryPoints: [join(desktopRoot, 'profileSwitchBenchmark.entry.ts')],
  outfile: entryPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  external: ['electron'],
  logLevel: 'silent',
})

const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const electron = desktopRequire('electron')
const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn(electron, [entryPath], {
    cwd: repositoryRoot,
    env: { ...process.env, TURBOFLUX_PROFILE_SWITCH_BENCHMARK: '1' },
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', code => resolvePromise(code ?? 1))
})
if (exitCode !== 0) process.exitCode = exitCode
