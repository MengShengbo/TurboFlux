import { describe, expect, it } from 'vitest'
import { normalizeBuiltInToolArguments } from './toolArgumentNormalization'

const options = {
  workspacePath: '/workspace',
  resolvePath: (basePath: string, path: string) => `${basePath}/${path}`,
  isFile: (path: string) => path === '/workspace/package.json' || path === '/workspace/apps/web/package.json',
}

describe('built-in tool argument normalization', () => {
  it('uses the workspace root for an empty directory path', () => {
    expect(normalizeBuiltInToolArguments('list_directory', { path: '' }, options)).toEqual({ path: '.' })
  })

  it('preserves a concrete file scope without matching same-named descendants', () => {
    expect(normalizeBuiltInToolArguments('search_content', {
      path: 'apps/web/package.json',
      pattern: 'scripts',
      context_after: 2,
    }, options)).toEqual({
      path: 'apps/web/package.json',
      pattern: 'scripts',
      context_after: 2,
    })
  })

  it('accepts the common glob alias without leaking an unknown parameter', () => {
    expect(normalizeBuiltInToolArguments('search_content', {
      path: '',
      pattern: 'AgentEngine',
      glob: '*.ts',
    }, options)).toEqual({
      path: '.',
      pattern: 'AgentEngine',
      file_pattern: '*.ts',
    })
  })
})
