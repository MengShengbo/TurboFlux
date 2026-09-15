import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()

describe('published Agent kernel boundary', () => {
  it('publishes only supported consumer entrypoints', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'packages/agent-core/package.json'), 'utf8'))

    expect(manifest.name).toBe('@turboflux/agent-core')
    expect(manifest.private).not.toBe(true)
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './contracts',
      './runtime',
      './renderer',
      './workbench',
      './extensions',
    ])
    expect(JSON.stringify(manifest)).not.toMatch(/electron|control-plane|account|billing|telemetry/)
  })

  it('provides a self-contained Desktop workspace around the kernel', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
    expect(manifest.private).toBe(true)
    expect(manifest.bin).toBeUndefined()
    expect(manifest.scripts['dev:cli']).toBeUndefined()
    expect(manifest.scripts.dev).toBe('npm run dev:desktop')
    expect(existsSync(join(repositoryRoot, 'src/cli'))).toBe(false)
    expect(existsSync(join(repositoryRoot, 'archive'))).toBe(false)
    expect(existsSync(join(repositoryRoot, 'apps/desktop/package.json'))).toBe(true)
    expect(existsSync(join(repositoryRoot, 'packages/agent-core/src/core/runtime/nodeToolExecutor.ts'))).toBe(true)
  })
})
