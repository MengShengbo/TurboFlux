import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveProjectMcpSettings } from './settings'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('project MCP settings', () => {
  it('updates MCP servers without discarding unrelated project settings', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-mcp-settings-'))
    directories.push(workspacePath)
    const settingsDirectory = join(workspacePath, '.turboflux')
    mkdirSync(settingsDirectory)
    writeFileSync(join(settingsDirectory, 'settings.json'), JSON.stringify({ theme: 'dark', custom: { retained: true } }))

    saveProjectMcpSettings(workspacePath, {
      mcpServers: { docs: { enabled: true, command: 'npx', args: ['docs-mcp'] } },
    })

    expect(JSON.parse(readFileSync(join(settingsDirectory, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      custom: { retained: true },
      mcpServers: { docs: { enabled: true, command: 'npx', args: ['docs-mcp'] } },
    })
  })
})
