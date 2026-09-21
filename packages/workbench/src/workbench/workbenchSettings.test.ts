import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurboFluxConfig } from '@turboflux/models/config'
import type { WorkbenchSettingsUpdate } from './types'

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Workbench settings', () => {
  async function runningSettingsHarness() {
    const configDirectory = mkdtempSync(join(tmpdir(), 'turboflux-settings-live-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-live-'))
    directories.push(configDirectory, workspacePath)
    vi.stubEnv('TURBOFLUX_CONFIG_DIR', configDirectory)
    vi.stubEnv('TURBOFLUX_CONVERSATIONS_DIR', join(configDirectory, 'conversations'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }))))
    vi.resetModules()
    const { WorkbenchRuntime } = await import('./workbenchRuntime')
    const config: TurboFluxConfig = {
      provider: 'custom', apiKey: 'original-key', baseUrl: 'https://example.test/v1',
      model: 'original-model', contextWindow: 200_000, maxTokens: 4096,
      approvalPolicy: 'ask', capabilityProfile: 'workspace-write', gitEnabled: false,
      apiConfigs: [], activeApiConfigId: 'main',
    }
    const runtime = new WorkbenchRuntime({ workspacePath, config })
    const requests: Array<{ model: string; finish: (withTool?: boolean) => void; signal?: AbortSignal }> = []
    vi.spyOn(runtime.runtime.toolExecutor, 'streamMessage').mockImplementation((_url, _headers, body, onLine, options) => new Promise(resolve => {
      if (JSON.parse(body).tool_choice?.function?.name === 'set_response_mode') {
        onLine(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `mode-${requests.length}`, type: 'function', function: { name: 'set_response_mode', arguments: '{"mode":"task"}' } }] }, finish_reason: 'tool_calls' }] })}`)
        onLine('data: [DONE]')
        resolve({ success: true, data: '' })
        return
      }
      requests.push({
        model: JSON.parse(body).model,
        signal: options?.signal,
        finish: withTool => {
          const delta = withTool
            ? { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'list_directory', arguments: '{"path":"."}' } }] }
            : { content: 'Done.' }
          onLine(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: withTool ? 'tool_calls' : 'stop' }] })}`)
          onLine('data: [DONE]')
          resolve({ success: true, data: '' })
        },
      })
      const abort = () => resolve({ success: false, error: 'aborted' })
      if (options?.signal?.aborted) abort()
      else options?.signal?.addEventListener('abort', abort, { once: true })
    }))
    const saveModel = (model: string, extra: Partial<WorkbenchSettingsUpdate> = {}) => runtime.saveSettings({
      activeApiConfigId: 'main', approvalPolicy: 'ask', capabilityProfile: 'workspace-write', gitEnabled: false,
      apiProfiles: [{ ...config, id: 'main', name: 'Main', model }],
      profile: {},
      ...extra,
    })
    return { runtime, requests, saveModel }
  }

  it('keeps every request in the current run on its original model and applies the latest choice to the next run', async () => {
    const { runtime, requests, saveModel } = await runningSettingsHarness()
    try {
      const originalConversationId = runtime.getSnapshot().conversation.id
      await runtime.newConversation()
      const idleRuntime = runtime.runtime
      await runtime.switchConversation(originalConversationId)
      runtime.submitPrompt('Inspect the workspace')
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      await saveModel('next-model')
      await saveModel('latest-model', { approvalPolicy: 'full', capabilityProfile: 'danger-full-access' })
      expect(runtime.setMode('plan').runtime.mode).toBe('plan')
      expect(runtime.runtime.engine.getMode()).toBe('vibe')
      expect(runtime.getSnapshot().runtime).toMatchObject({ status: 'running', model: 'latest-model', approvalPolicy: 'full' })
      expect(runtime.runtime.engine.getApprovalPolicy()).toBe('ask')
      expect(runtime.runtime.stateProvider.getActiveModel()?.id).toBe('original-model')
      expect(idleRuntime.stateProvider.getActiveModel()?.id).toBe('latest-model')
      expect(requests[0].signal?.aborted).toBe(false)

      requests[0].finish(true)
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(requests[1].model).toBe('original-model')
      requests[1].finish()
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.status).toBe('ready'))
      expect(runtime.runtime.engine.getMode()).toBe('plan')

      runtime.submitPrompt('Continue')
      await vi.waitFor(() => expect(requests).toHaveLength(3))
      expect(requests[2].model).toBe('latest-model')
      requests[2].finish()
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.status).toBe('ready'))
    } finally {
      runtime.stop()
      await runtime.destroy()
    }
  })

  it('uses saved settings on explicit resume without replacing the paused conversation', async () => {
    const { runtime, requests, saveModel } = await runningSettingsHarness()
    try {
      const conversationId = runtime.getSnapshot().conversation.id
      runtime.submitPrompt('Pause and resume')
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      expect(runtime.pause()).toBe(true)
      await saveModel('resumed-model')
      expect(runtime.getSnapshot().runtime).toMatchObject({ status: 'paused', model: 'resumed-model' })
      expect(runtime.runtime.stateProvider.getActiveModel()?.id).toBe('original-model')
      expect(runtime.resume()).toBe(true)
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      expect(requests[1].model).toBe('resumed-model')
      expect(runtime.getSnapshot().conversation.id).toBe(conversationId)
      requests[1].finish()
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.status).toBe('ready'))
    } finally {
      runtime.stop()
      await runtime.destroy()
    }
  })

  it('allows unchanged MCP settings during a run and rejects connection replacement before saving other settings', async () => {
    const { runtime, requests, saveModel } = await runningSettingsHarness()
    try {
      runtime.submitPrompt('Keep working')
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      const disconnect = vi.spyOn(runtime.runtime.mcpClient, 'disconnectAll')
      await saveModel('original-model', { mcpServers: [] })
      expect(disconnect).not.toHaveBeenCalled()
      const { saveProjectMcpSettings } = await import('@turboflux/extensions/mcp/settings')
      saveProjectMcpSettings(runtime.getSnapshot().workspace.path, { mcpServers: {
        existing: { command: 'mcp-test', enabled: true, env: { TOKEN: 'test-secret' }, httpHeaders: { Authorization: 'test-token' } },
      } })
      await saveModel('original-model', { mcpServers: [{
        name: 'existing', command: 'mcp-test', enabled: true, preserveEnv: true, preserveHttpHeaders: true,
      }] })
      expect(disconnect).not.toHaveBeenCalled()
      await expect(saveModel('original-model', {
        approvalPolicy: 'full', mcpServers: [{ name: 'new-server', command: 'mcp-test', enabled: true }],
      })).rejects.toThrow('MCP')
      expect(runtime.runtime.engine.getApprovalPolicy()).toBe('ask')
      expect((await runtime.getSettings()).approvalPolicy).toBe('ask')
      requests[0].finish()
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.status).toBe('ready'))
    } finally {
      runtime.stop()
      await runtime.destroy()
    }
  })

  it('persists shared settings, hot-applies them, and returns only a masked credential preview', async () => {
    const configDirectory = mkdtempSync(join(tmpdir(), 'turboflux-settings-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(configDirectory, workspacePath)
    vi.stubEnv('TURBOFLUX_CONFIG_DIR', configDirectory)
    vi.resetModules()

    const { WorkbenchRuntime } = await import('./workbenchRuntime')
    const { loadConfig } = await import('@turboflux/models/config')
    const { loadProfile } = await import('@turboflux/models/profile')
    const initialConfig: TurboFluxConfig = {
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
    const runtime = new WorkbenchRuntime({ workspacePath, config: initialConfig })

    try {
      const result = await runtime.saveSettings({
        activeApiConfigId: 'main',
        approvalPolicy: 'agent',
        capabilityProfile: 'workspace-write',
        gitEnabled: false,
        apiProfiles: [{
          id: 'main',
          name: 'Local gateway',
          provider: 'custom',
          apiKey: 'desktop-secret',
          baseUrl: '',
          model: 'gpt-5.6',
          contextWindow: 1_050_000,
          maxTokens: 16_384,
          maxOutputTokens: 128_000,
          reasoning: { enabled: true, effort: 'xhigh' },
        }],
        profile: {
          defaultPersonaId: 'product-builder',
          customInstructions: 'Keep Agent Core and Desktop behavior aligned.',
        },
      })

      expect(result.snapshot.runtime).toMatchObject({
        configured: false,
        model: 'gpt-5.6',
        approvalPolicy: 'agent',
        reasoning: { enabled: true, effort: 'xhigh' },
      })
      expect(runtime.runtime.engine.getApprovalPolicy()).toBe('agent')
      expect(JSON.stringify(result.settings)).not.toContain('desktop-secret')
      expect(result.settings.apiProfiles[0].hasApiKey).toBe(true)
      expect(result.settings.apiProfiles[0].apiKeyPreview).toBe('des********ret')
      expect(result.settings.apiProfiles[0]).not.toHaveProperty('apiKey')

      await runtime.saveSettings({
        activeApiConfigId: result.settings.activeApiConfigId,
        approvalPolicy: result.settings.approvalPolicy,
        capabilityProfile: result.settings.capabilityProfile,
        gitEnabled: result.settings.gitEnabled,
        apiProfiles: result.settings.apiProfiles.map(({ hasApiKey: _hasApiKey, apiKeyPreview: _preview, ...profile }) => ({ ...profile, apiKey: '' })),
        profile: {},
      })

      const reloadedConfig = await loadConfig()
      expect(reloadedConfig).toMatchObject({
        apiKey: 'desktop-secret',
        model: 'gpt-5.6',
        approvalPolicy: 'agent',
        gitEnabled: false,
      })
      expect(loadProfile()).toMatchObject({
        defaultPersonaId: 'product-builder',
        customInstructions: 'Keep Agent Core and Desktop behavior aligned.',
      })
    } finally {
      await runtime.destroy()
    }
  })

  it('discovers draft endpoint models and replaces a carried model after saving a changed connection', async () => {
    const configDirectory = mkdtempSync(join(tmpdir(), 'turboflux-settings-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workbench-'))
    directories.push(configDirectory, workspacePath)
    vi.stubEnv('TURBOFLUX_CONFIG_DIR', configDirectory)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: 'new-endpoint-model',
        context_length: 128_000,
        max_completion_tokens: 16_384,
        capabilities: { tools: true },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()

    const { WorkbenchRuntime } = await import('./workbenchRuntime')
    const { loadConfig } = await import('@turboflux/models/config')
    const initialConfig: TurboFluxConfig = {
      provider: 'custom',
      apiKey: 'old-secret',
      baseUrl: 'https://old.example/v1',
      model: 'old-model',
      contextWindow: 200_000,
      maxTokens: 16_384,
      approvalPolicy: 'ask',
      capabilityProfile: 'workspace-write',
      gitEnabled: true,
      apiConfigs: [],
      activeApiConfigId: 'main',
    }
    const update = {
      activeApiConfigId: 'main',
      approvalPolicy: 'ask' as const,
      capabilityProfile: 'workspace-write' as const,
      gitEnabled: true,
      apiProfiles: [{
        id: 'main',
        name: 'Main',
        provider: 'custom' as const,
        apiKey: 'new-secret',
        baseUrl: 'https://new.example/v1',
        model: 'old-model',
        contextWindow: 200_000,
        maxTokens: 16_384,
      }],
      profile: {},
    }
    const runtime = new WorkbenchRuntime({ workspacePath, config: initialConfig })

    try {
      const preview = await runtime.previewSettingsModels(update)
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://new.example/v1/models',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer new-secret' }) }),
      )
      expect(preview.models).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'new-endpoint-model', availability: 'api' }),
      ]))
      expect(runtime.getSnapshot().runtime.model).toBe('old-model')

      await runtime.saveSettings(update)
      await vi.waitFor(() => expect(runtime.getSnapshot().runtime.model).toBe('new-endpoint-model'))
      expect((await loadConfig()).model).toBe('new-endpoint-model')
    } finally {
      await runtime.destroy()
    }
  })
})
