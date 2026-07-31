import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(process.cwd(), 'src', 'cli')

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

describe('user-visible string boundaries', () => {
  it('keeps Chinese setup prose in the locale catalog', () => {
    const source = read('setup.ts')
    const hanLines = source.split(/\r?\n/).filter(line => /\p{Script=Han}/u.test(line))

    expect(hanLines).toHaveLength(2)
    expect(hanLines.every(line => line.includes("'中文'") && line.includes("'简体中文'"))).toBe(true)
    expect(source).not.toMatch(/\bzh\s*\(/)
  })

  it('rejects natural-language JSX text and string props', () => {
    const componentFiles = [
      'components/App.tsx',
      'components/header/Header.tsx',
      'components/header/StatusLine.tsx',
      'components/input/PromptInput.tsx',
      'components/layout/LandingView.tsx',
      'components/layout/SessionSidebar.tsx',
      'components/messages/Messages.tsx',
      'components/messages/ThinkingBlock.tsx',
      'components/tools/ActiveWorkPanel.tsx',
      'components/tools/QueuedPromptList.tsx',
      'components/tools/TerminalSessionsFooter.tsx',
      'components/tools/ToolActivityList.tsx',
    ]
    const violations: string[] = []

    for (const file of componentFiles) {
      const source = read(file)
      for (const match of source.matchAll(/<Text\b[^>]*>\s*([A-Za-z][^<{\n]*\s+[^<{\n]*)</g)) {
        const text = match[1]!.trim()
        if (/\s/.test(text)) violations.push(`${file}: ${text}`)
      }
      for (const match of source.matchAll(/\b(?:label|title|placeholder|description)="([A-Za-z][^"]*\s+[^"]*)"/g)) {
        violations.push(`${file}: ${match[1]}`)
      }
    }

    expect(violations).toEqual([])
    const app = read('components/App.tsx')
    expect(app).not.toContain("'Thinking...'")
    expect(app).not.toContain('`Selected message ')
    expect(app).not.toContain('`Mounted ${')
  })

  it('requires catalog keys for every static slash-command description', () => {
    const source = read('commands/index.ts')
    const registrations = source.split('commandRegistry.register({').slice(1)
    const missingKeys = registrations
      .filter(block => /^\s*name:\s*'[^']+'/m.test(block))
      .filter(block => !/^\s*descriptionKey:\s*'command\.[^']+\.description'/m.test(block))
      .map(block => block.match(/^\s*name:\s*'([^']+)'/m)?.[1])

    expect(missingKeys).toEqual([])
    expect(source).not.toMatch(/^\s*description:\s*['"]/m)
    expect(source).not.toMatch(/\breturn\s+['"][A-Za-z][^'"\n]*\s+[^'"\n]*['"]/)
  })

  it('keeps startup and attachment diagnostics behind translators', () => {
    const boundaries = [
      read('index.ts'),
      read('repl.ts'),
      read('singleShot.ts'),
      read('imageAttachments.ts'),
    ].join('\n')

    expect(boundaries).not.toMatch(/(?:console\.(?:log|error)|warnings\.push|throw new Error)\(\s*['"][A-Za-z][^'"]*\s+[^'"]*['"]/)
    expect(boundaries).not.toMatch(/\.(?:description|option|argument)\([^\n]*,\s*['"][A-Za-z][^'"]*\s+[^'"]*['"]/)
  })
})
