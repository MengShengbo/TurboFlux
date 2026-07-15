import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutor } from '../tools/executor'
import { gitCommitCheckpoint, gitResetToCommit } from './gitService'

function executorWithProcessMock() {
  const runProcess = vi.fn(async (command: string, args: string[]) => ({
    success: true,
    data: {
      stdout: args[0] === 'rev-parse' ? 'abc1234\n' : '',
      stderr: '',
      exitCode: 0,
    },
  }))
  return { executor: { runProcess } as unknown as ToolExecutor, runProcess }
}

describe('git checkpoints', () => {
  it('passes checkpoint messages and touched paths as process arguments', async () => {
    const { executor, runProcess } = executorWithProcessMock()
    const workspace = process.cwd()
    const message = 'safe $(Write-Output injected)'

    const result = await gitCommitCheckpoint(workspace, message, [`${workspace}/src/core/gitService.ts`], executor)

    expect(result).toMatchObject({ ok: true, hash: 'abc1234' })
    expect(runProcess).toHaveBeenNthCalledWith(1, 'git', ['add', '--', 'src/core/gitService.ts'], workspace, {}, 10000)
    expect(runProcess).toHaveBeenNthCalledWith(2, 'git', ['commit', '-m', message], workspace, {}, 15000)
  })

  it('rejects invalid reset revisions before starting git', async () => {
    const { executor, runProcess } = executorWithProcessMock()
    const result = await gitResetToCommit(process.cwd(), 'HEAD; echo injected', executor)

    expect(result.ok).toBe(false)
    expect(runProcess).not.toHaveBeenCalled()
  })
})
