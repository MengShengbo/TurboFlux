import { describe, expect, it } from 'vitest'
import { orderedPackages } from './workspace-packages.mjs'
import { moduleReferences } from './verify-architecture.mjs'

function workspace(name: string, dependencies: string[] = []) {
  return { directory: name, kind: 'packages', manifest: { name: `@turboflux/${name}`, dependencies: Object.fromEntries(dependencies.map(value => [`@turboflux/${value}`, '*'])) } }
}

describe('workspace build graph', () => {
  it('builds prerequisites once and rejects cycles before starting any builds', () => {
    const graph = [workspace('workbench', ['runtime', 'contracts']), workspace('runtime', ['contracts']), workspace('contracts')]
    expect(orderedPackages(graph).map(entry => entry.manifest.name)).toEqual(['@turboflux/contracts', '@turboflux/runtime', '@turboflux/workbench'])
    expect(() => orderedPackages([workspace('a', ['b']), workspace('b', ['a'])])).toThrow('Package dependency cycle')
    expect(() => orderedPackages([workspace('a', ['missing'])])).toThrow('Unknown package')
  })
  it('distinguishes type-only edges and catches multiline, side effect and dynamic imports', () => {
    const references = moduleReferences('example.ts', `
      import type { Snapshot } from '@turboflux/workbench'
      import { type Turn } from '@turboflux/contracts'
      export { thing,
        type Other } from './implementation'
      import 'node:fs'
      const runtime = import('@turboflux/agent-runtime')
      type Runtime = import('@turboflux/agent-runtime').AgentRuntime
    `)
    expect(references).toEqual([
      { specifier: '@turboflux/workbench', typeOnly: true },
      { specifier: '@turboflux/contracts', typeOnly: true },
      { specifier: './implementation', typeOnly: false },
      { specifier: 'node:fs', typeOnly: false },
      { specifier: '@turboflux/agent-runtime', typeOnly: false },
      { specifier: '@turboflux/agent-runtime', typeOnly: true },
    ])
  })
})
