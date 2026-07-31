import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Agent Flow ownership boundary', () => {
  it('keeps execution truth out of React component state', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'cli', 'components', 'App.tsx'), 'utf8')

    expect(app).not.toMatch(/useState[^\n]*(?:isRunning|runState|queuedPrompts|pendingSteeringPrompts)/)
    expect(app).not.toMatch(/useState[^\n]*(?:currentMode|tokenUsage|activeTask|streamingToolDraft)/)
    expect(app).toContain('selectIsForegroundBusy(activeFlowState)')
    expect(app).toContain('selectQueuedInputs(activeFlowState)')
    expect(app).toContain('selectAgentRunState(activeFlowState)')
    expect(app).toContain('selectActiveTask(activeFlowState)')
  })
})
