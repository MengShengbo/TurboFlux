import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('core reuse ownership boundary', () => {
  it('keeps reusable orchestration modules independent from UI frameworks', () => {
    const files = [
      'contextCompactionBoundary.ts',
      'modelRequestOrchestrator.ts',
      'taskToolDispatcher.ts',
      'toolCallOrchestrator.ts',
    ]

    for (const file of files) {
      const source = readFileSync(`${process.cwd()}/packages/agent-core/src/core/${file}`, 'utf8')
      expect(source).not.toMatch(/from ['"][^'"]*\/cli\//)
      expect(source).not.toMatch(/from ['"](?:ink|react|electron|@tauri-apps)/)
    }
  })

  it('keeps the execution kernel independent from Desktop platform services', () => {
    const roots = ['application', 'core', 'kernel', 'platform', 'server', 'shared', 'state', 'tools']
    const sourceFiles: string[] = []
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) sourceFiles.push(path)
      }
    }
    roots.forEach(root => collect(join(process.cwd(), 'packages/agent-core/src', root)))

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from ['"][^'"]*desktop\//)
      expect(source, file).not.toMatch(/controlPlane|productAccount|safeStorage/)
    }

    const openSourceConfig = readFileSync(join(process.cwd(), 'tsconfig.open-source.json'), 'utf8')
    expect(openSourceConfig).toContain('"packages/agent-core/src/desktop/**/*"')
    const coreManifest = readFileSync(join(process.cwd(), 'packages', 'agent-core', 'package.json'), 'utf8')
    expect(coreManifest).not.toMatch(/desktop:|control-plane:|website:|electron/)
  })

  it('keeps product experience prompts in private adapters', () => {
    const workbenchRuntime = readFileSync(join(process.cwd(), 'packages/agent-core/src/application/workbench/workbenchRuntime.ts'), 'utf8')

    expect(workbenchRuntime).toContain('surfaceSystemPrompt?: string')
    expect(workbenchRuntime).toContain("conversationPrefix: this.options.conversationPrefix || 'workbench'")
    expect(workbenchRuntime).not.toContain('<desktop_experience>')
    expect(workbenchRuntime).not.toContain("conversationPrefix: 'desktop'")
  })
})
