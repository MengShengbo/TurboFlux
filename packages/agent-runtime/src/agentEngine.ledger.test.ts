import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentTurn, ToolCall, ToolResult } from '@turboflux/contracts/agentTypes'
import { AgentEngine } from './agentEngine'
import { NodeToolExecutor } from '@turboflux/tools/nodeToolExecutor'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

it('returns current file and search facts after compaction removes the original results', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'turboflux-ledger-compaction-'))
  const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: '', baseUrl: '', model: '', contextWindow: 100_000, maxTokens: 4096 }, workspace)
  const executor = new NodeToolExecutor(workspace)
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace, gitEnabled: false }, executor, state)
  const internals = engine as unknown as {
    session: { turns: AgentTurn[]; modelSurface: unknown }
    preservedFiles: Array<{ path: string }>
    executeSingleTool(call: ToolCall): Promise<ToolResult>
    collectContinuationWorkspaceSnapshot(): Promise<{ workspacePath: string }>
    generateContinuationSummary(): Promise<{ text: string; source: string }>
  }
  try {
    const history: AgentTurn[] = [{ id: 'goal', role: 'user', content: 'Inspect six files', timestamp: 1 }]
    for (let index = 0; index < 6; index++) {
      const path = `file-${index}.txt`
      writeFileSync(join(workspace, path), index === 0 ? 'UNIQUE_FACT_7319' : `Other file ${index}`)
      const call = { id: `old-read-${index}`, name: 'read_file', arguments: { path } }
      const result = await internals.executeSingleTool(call)
      expect(result.isError).toBe(false)
      history.push(
        { id: `assistant-${index}`, role: 'assistant', content: '', toolCalls: [call], timestamp: 2 + index * 2 },
        { id: `result-${index}`, role: 'tool_result', content: '', toolResults: [result], timestamp: 3 + index * 2 },
      )
    }
    const search = { id: 'old-search', name: 'search_files', arguments: { pattern: '*fresh*' } }
    expect((await internals.executeSingleTool(search)).output).not.toContain('fresh.txt')
    internals.session.turns = [...history, ...Array.from({ length: 20 }, (_, index): AgentTurn => ({
      id: `tail-${index}`, role: index % 2 ? 'assistant' : 'user', content: `step ${index}`, timestamp: index + 20,
    }))]
    vi.spyOn(internals, 'collectContinuationWorkspaceSnapshot').mockResolvedValue({ workspacePath: workspace })
    vi.spyOn(internals, 'generateContinuationSummary').mockResolvedValue({ text: 'Continue inspection.', source: 'deterministic' })
    await engine.compactContext()
    expect(internals.session.turns.some(turn => turn.id === 'result-0')).toBe(false)
    expect(internals.preservedFiles).toHaveLength(5)
    expect(internals.preservedFiles.some(file => file.path === 'file-0.txt')).toBe(false)
    expect(JSON.stringify(internals.session.modelSurface)).not.toContain('UNIQUE_FACT_7319')
    expect((await internals.executeSingleTool({ id: 'new-read', name: 'read_file', arguments: { path: 'file-0.txt' } })).output).toContain('UNIQUE_FACT_7319')

    const otherExecutor = new NodeToolExecutor(workspace)
    expect((await otherExecutor.writeFile('file-0.txt', 'EXTERNAL_CHANGE_8462')).success).toBe(true)
    expect((await otherExecutor.writeFile('fresh.txt', 'new search result')).success).toBe(true)
    expect((await internals.executeSingleTool({ id: 'changed-read', name: 'read_file', arguments: { path: 'file-0.txt' } })).output).toContain('EXTERNAL_CHANGE_8462')
    expect((await internals.executeSingleTool({ ...search, id: 'new-search' })).output).toContain('fresh.txt')
  } finally {
    engine.destroy()
    vi.restoreAllMocks()
    rmSync(workspace, { recursive: true, force: true })
  }
})
