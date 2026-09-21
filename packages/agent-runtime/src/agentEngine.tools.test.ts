import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeToolExecutor } from '@turboflux/tools/nodeToolExecutor'
import type { ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import type { ToolExecutor } from '@turboflux/contracts/toolExecutor'
import { AgentEngine } from './agentEngine'
import { createAgentRunInterruption } from './runtime/runControl'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import type { WorkExecutionTracker } from './workExecutionTracker'

function harness() {
  const workspacePath = process.cwd()
  const engine = new AgentEngine({
    mode: 'vibe', approvalPolicy: 'full', workspacePath, gitEnabled: false,
  }, {} as ToolExecutor, new DefaultAgentStateProvider({
    provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model',
    contextWindow: 100_000, maxTokens: 4096,
  }, workspacePath))
  const internals = engine as unknown as {
    executeSingleTool(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>
    executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]>
    dispatchTool(name: string, args: Record<string, unknown>, id: string, signal?: AbortSignal): Promise<string>
    fileBeforeSnapshots: Map<string, string | null>
    workExecution: WorkExecutionTracker
  }
  return { engine, internals }
}

describe('AgentEngine tool lifecycle integration', () => {
  it.each(['edit_file', 'multi_edit'])('%s writes literal dollar markers and reports the exact resulting file', async name => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-literal-edit-'))
    const source = 'prefix\nTARGET\nsuffix\n'
    const replacement = ['$&', '$$', '$`', "$'", '$1', '$<name>'].join(' ')
    const expected = `prefix\n${replacement}\nsuffix\n`
    writeFileSync(join(workspacePath, 'sample.txt'), source)
    const executor = new NodeToolExecutor(workspacePath, { capabilityProfile: 'danger-full-access' })
    const engine = new AgentEngine({
      mode: 'vibe', approvalPolicy: 'full', capabilityProfile: 'danger-full-access', workspacePath, gitEnabled: false,
    }, executor, new DefaultAgentStateProvider({
      provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096,
    }, workspacePath))
    const internal = engine as unknown as { executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> }
    try {
      const args = name === 'edit_file'
        ? { path: 'sample.txt', old_content: 'TARGET', new_content: replacement, replace_all: false }
        : { path: 'sample.txt', edits: [{ old_string: 'TARGET', new_string: replacement, replace_all: false }] }
      const result = await internal.executeToolCalls([{ id: 'literal-edit', name, arguments: args }])
      expect(result[0]).toMatchObject({ isError: false, changeSummary: { before: source, after: expected } })
      expect(readFileSync(join(workspacePath, 'sample.txt'), 'utf8')).toBe(expected)
    } finally {
      engine.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('passes an explicit cancellation signal to the adapter and rejects its late success', async () => {
    const { engine, internals } = harness()
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let finish!: (output: string) => void
    const dispatch = vi.spyOn(internals, 'dispatchTool').mockImplementation(() => {
      markStarted()
      return new Promise(resolve => { finish = resolve })
    })

    try {
      const call = { id: 'explicit-signal', name: 'read_file', arguments: { path: 'file.ts' } }
      const pending = internals.executeSingleTool(call, controller.signal)
      await started
      expect(dispatch.mock.calls[0][3]).toBe(controller.signal)
      controller.abort(createAgentRunInterruption('stop'))
      finish('late source content')
      await expect(pending).resolves.toMatchObject({
        toolCallId: call.id, isError: true, errorKind: 'abort', interruption: { kind: 'stop' },
      })
    } finally {
      engine.destroy()
    }
  })

  it('settles task activity and releases file snapshots even when a result observer throws', async () => {
    const { engine, internals } = harness()
    const observerError = new Error('result subscriber failed')
    internals.workExecution.startRun('tool-run', 'Read source')
    vi.spyOn(internals, 'dispatchTool').mockImplementation(async () => {
      internals.fileBeforeSnapshots.set('file.ts', 'old source')
      return 'source content'
    })
    engine.subscribe(event => {
      if (event.type === 'tool:result') throw observerError
    })

    try {
      await expect(internals.executeToolCalls([
        { id: 'read', name: 'read_file', arguments: { path: 'file.ts' } },
      ])).rejects.toBe(observerError)
      expect(internals.fileBeforeSnapshots.size).toBe(0)
      expect(engine.getWorkExecutionSnapshot().runs[0].activities['activity-read']).toMatchObject({
        status: 'completed', result: 'source content',
      })
    } finally {
      engine.destroy()
    }
  })
})
