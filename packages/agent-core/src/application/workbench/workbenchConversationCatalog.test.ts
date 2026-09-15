import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TurboFluxConfig } from '../../core/config'
import type { AgentEventType } from '../../core/agentEngine'
import type { ConversationCatalog, ConversationCatalogDiagnostics, PersistedConversation } from '../conversations/index'
import { WorkbenchRuntime } from './workbenchRuntime'

function createConfig(): TurboFluxConfig {
  return {
    provider: 'custom',
    apiKey: '',
    baseUrl: '',
    model: '',
    contextWindow: 200_000,
    maxTokens: 16_384,
    approvalPolicy: 'ask',
    capabilityProfile: 'workspace-write',
    gitEnabled: true,
    apiConfigs: [],
  }
}

function persistedConversation(id: string, workspacePath: string): PersistedConversation {
  return {
    id,
    title: 'Large indexed task',
    titleSource: 'generated',
    workspacePath,
    createdAt: 100,
    updatedAt: 200,
    mode: 'vibe',
    model: 'test-model',
    provider: 'custom',
    turnCount: 1,
    turns: [{ id: 'user-1', role: 'user', content: 'x'.repeat(2 * 1024 * 1024), timestamp: 100 }],
  }
}

function catalog(runtime: WorkbenchRuntime): ConversationCatalog {
  return (runtime as unknown as { conversationCatalog: ConversationCatalog }).conversationCatalog
}

function diagnostics(runtime: WorkbenchRuntime): ConversationCatalogDiagnostics {
  return catalog(runtime).getDiagnostics()
}

describe('WorkbenchRuntime conversation catalog boundary', () => {
  it('never rereads conversation history for snapshots, terminal updates, titles, or deletion', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-catalog-'))
    const conversationsDirectory = join(workspacePath, 'conversations')
    const previousDirectory = process.env.TURBOFLUX_CONVERSATIONS_DIR
    process.env.TURBOFLUX_CONVERSATIONS_DIR = conversationsDirectory
    const conversationPath = join(conversationsDirectory, 'large.jsonl')
    const conversation = persistedConversation('large', workspacePath)
    mkdirSync(conversationsDirectory, { recursive: true })
    writeFileSync(conversationPath, `${JSON.stringify({ version: 1, type: 'snapshot', timestamp: 200, conversation })}\n`)
    const runtime = new WorkbenchRuntime({ workspacePath, config: createConfig() })

    try {
      await runtime.initializePlatform()
      const afterInitialize = diagnostics(runtime)
      expect(afterInitialize.bytesRead).toBeLessThan(600 * 1024)
      expect(runtime.getSnapshot().conversationCatalog).toEqual([
        expect.objectContaining({ id: 'large', title: 'Large indexed task' }),
      ])

      runtime.getSnapshot()
      runtime.getSnapshot()
      const handleAgentEvent = (runtime as unknown as { handleAgentEvent(event: AgentEventType): void }).handleAgentEvent.bind(runtime)
      handleAgentEvent({ type: 'error', error: 'terminal test event' })
      expect(diagnostics(runtime)).toEqual(afterInitialize)

      const sizeBeforeRename = statSync(conversationPath).size
      expect(await runtime.renameConversation('large', 'Renamed without replay')).toBe(true)
      const sizeAfterRename = statSync(conversationPath).size
      expect(sizeAfterRename).toBeGreaterThan(sizeBeforeRename)
      expect(sizeAfterRename - sizeBeforeRename).toBeLessThan(1024)
      expect(diagnostics(runtime)).toEqual(afterInitialize)
      expect(runtime.getSnapshot().conversationCatalog).toEqual([
        expect.objectContaining({ id: 'large', title: 'Renamed without replay' }),
      ])

      expect(await runtime.deleteConversation('large')).toBe(true)
      expect(runtime.getSnapshot().conversationCatalog.some(item => item.id === 'large')).toBe(false)
      const afterDelete = diagnostics(runtime)
      expect(afterDelete.bytesRead).toBe(afterInitialize.bytesRead)
      expect(afterDelete.scannedFiles).toBe(afterInitialize.scannedFiles)
    } finally {
      await runtime.destroy()
      if (previousDirectory === undefined) delete process.env.TURBOFLUX_CONVERSATIONS_DIR
      else process.env.TURBOFLUX_CONVERSATIONS_DIR = previousDirectory
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
