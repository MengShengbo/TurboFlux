import { describe, expect, it } from 'vitest'
import { sameWorkspacePath } from './store'

describe('conversation workspace isolation', () => {
  it('matches equivalent paths and rejects different workspaces', () => {
    expect(sameWorkspacePath('.', process.cwd())).toBe(true)
    expect(sameWorkspacePath(process.cwd(), `${process.cwd()}-other`)).toBe(false)
  })
})
