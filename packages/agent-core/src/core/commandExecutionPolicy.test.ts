import { describe, expect, it } from 'vitest'
import { shouldAutoBackgroundCommand } from './commandExecutionPolicy'

describe('shouldAutoBackgroundCommand', () => {
  it.each([
    'npm install',
    'pnpm add react',
    'yarn install --immutable',
    'bun run build',
    'npx vitest run',
    'uv sync',
    'cargo test',
    'dotnet restore',
  ])('moves long-running command to the background: %s', command => {
    expect(shouldAutoBackgroundCommand(command)).toBe(true)
  })

  it.each([
    'git status',
    'node --version',
    'npm list',
    'rg --files',
  ])('keeps bounded command in the foreground: %s', command => {
    expect(shouldAutoBackgroundCommand(command)).toBe(false)
  })
})
