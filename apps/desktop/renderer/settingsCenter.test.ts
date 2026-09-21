import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type {
  WorkbenchApiConfigInput,
  WorkbenchApiConfigSummary,
  WorkbenchModelOption,
  WorkbenchSettingsSnapshot,
} from '@turboflux/workbench'
import { createSettingsUpdate, settingsFieldMarkup } from './settingsCenter'
import { reconcileDiscoveredProfileModel } from './apiSettingsModel'

describe('desktop settings draft', () => {
  it('leaves core profile management disconnected from desktop settings', () => {
    const settings = readFileSync(new URL('./settingsCenter.ts', import.meta.url), 'utf8')
    const workbench = ['./workbench.ts', './workbenchShell.ts', './workbenchIcons.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    const personal = readFileSync(new URL('./userProfile.ts', import.meta.url), 'utf8')
    expect(settings).not.toContain('createProfileCenter')
    expect(settings).not.toContain('openProfiles')
    expect(workbench).not.toContain('listLocalProfiles')
    expect(personal).not.toContain('renameLocalProfile')
    expect(personal).not.toContain('profileRegistry')
    expect(personal).toContain('bridge.getUserProfile()')
  })

  it('offers persistent background media with shared image and video composition controls', () => {
    const settings = readFileSync(new URL('./settingsCenter.ts', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8')
    const workbench = ['./workbench.ts', './workbenchShell.ts', './workbenchIcons.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

    expect(settings).toContain('<h3>背景</h3>')
    expect(settings).toContain("backgroundRange('background-brightness'")
    expect(settings).toContain('id="window-opacity"')
    expect(settings).toContain('<div class="background-editor-grid" aria-hidden="true"></div>')
    expect(settings).toContain('data-background-zoom="in"')
    expect(settings).toContain("editor.addEventListener('pointerdown'")
    expect(settings).toContain("editor.addEventListener('wheel'")
    expect(settings).toContain("editor.addEventListener('keydown'")
    expect(settings).toContain('data-background-material="${preset}"')
    expect(settings).toContain("clear: { materialOpacity: 0.38, materialBlur: 26 }")
    expect(settings).toContain("resolvedTheme === 'dark' ? 'darkBrightness' : 'lightBrightness'")
    expect(settings).toContain("backgroundRange('background-playback-rate'")
    expect(settings).toContain('bridge.chooseBackgroundMedia()')
    expect(settings).toContain('bridge.removeBackgroundMedia()')
    expect(workbench).toContain('class="background-media-layer"')
    expect(workbench).toContain('class="background-media-visual background-media-video"')
    expect(preload).toContain("getBackgroundMedia: () => ipcRenderer.invoke('desktop:get-background-media')")
    expect(preload).toContain("chooseBackgroundMedia: () => ipcRenderer.invoke('desktop:choose-background-media')")
    expect(preload).toContain("setWindowOpacity: opacity => ipcRenderer.invoke('desktop:set-window-opacity', opacity)")
    expect(main).toContain("ipcMain.handle('desktop:choose-background-media'")
    expect(main).toContain("protocol.handle('turboflux-media'")
    expect(main).toContain('detectBackgroundMedia(buffer')
    expect(main).toContain('BACKGROUND_VIDEO_MAX_BYTES')
    expect(styles).toContain('#app:has(.settings-overlay.visible) .desktop-shell { visibility: hidden; }')
    expect(styles).toContain('.settings-overlay { z-index: 170; }')
    expect(styles).toContain('.toast { z-index: 210; }')
    expect(styles).toContain('html[data-background-media] .workbench-surface,')
    expect(styles).toContain('html[data-background-media] .main-panel,')
    expect(styles).toContain('html[data-theme="light"] .background-media-visual')
    expect(styles).toContain('brightness(var(--background-light-filter-brightness, 1))')
    expect(styles).toContain('html[data-theme="dark"] .background-media-visual')
    expect(styles).toContain('brightness(var(--background-dark-filter-brightness, 1))')
    expect(styles).toContain('html[data-theme="light"][data-background-media] .composer-card,')
    expect(styles).toContain('html[data-theme="dark"][data-background-media] .composer-card,')
    expect(styles).not.toContain('html[data-theme="light"][data-background-media] .workbench-surface,')
    expect(styles).not.toContain('html[data-theme="dark"][data-background-media] .workbench-surface,')
  })

  it('keeps wallpaper foregrounds readable without a global veil', () => {
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

    expect(styles).toContain('html[data-theme="light"][data-background-media] {')
    expect(styles).toContain('--background-answer-surface: rgba(250,251,248,.66)')
    expect(styles).toContain('html[data-theme="dark"][data-background-media] {')
    expect(styles).toContain('--background-answer-surface: rgba(18,20,19,.62)')
    expect(styles).toContain('html[data-background-media] .transcript {')
    expect(styles).toContain('html[data-background-media] .linear-task-flow .message-row.assistant .message-content {')
    expect(styles).toContain('background: var(--background-answer-surface);')
    expect(styles).toContain('html[data-background-media] .transcript {\n  background: transparent;\n  backdrop-filter: none;')
    expect(styles).not.toContain('--background-reading-surface')
    expect(styles).toContain('html[data-theme="light"][data-background-media] .markdown-body code:not(pre code) {')
    expect(styles).toContain('html[data-theme="dark"][data-background-media] .markdown-body code:not(pre code) {')
    expect(styles).not.toContain('--background-text-halo')
    expect(styles).not.toContain('text-shadow: var(--background-text-halo)')
    expect(styles).toContain('html[data-theme="light"][data-background-media] .composer-card textarea::placeholder { color: #596159; }')
    expect(styles).toContain('html[data-theme="dark"][data-background-media] .composer-card textarea::placeholder { color: #b8beb4; }')
    expect(styles).toContain('html[data-background-media] .composer-menu,')
    expect(styles).toContain('background: var(--background-floating-surface);')
    expect(styles).toContain('.background-media-veil { display: none; }')
  })

  it('keeps temporary remote-control actions connected across the Electron boundary', () => {
    const settings = readFileSync(new URL('./settingsCenter.ts', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8')

    expect(settings).toContain('停止本次远控')
    expect(settings).toContain("bridge.stopRemoteControl()")
    expect(settings).toContain('HTTPS 公开端点')
    expect(settings).toContain('bridge.createRemotePairing')
    expect(settings).toContain('data-remote-approve')
    expect(settings).toContain('申请能力：')
    expect(settings).toContain('已授权：')
    expect(settings).toContain("'approval.resolve': '处理审批与输入请求'")
    expect(settings).toContain('生成二维码')
    expect(settings).toContain('重置远程身份')
    expect(settings).toContain('bridge.resetRemoteIdentity()')
    expect(settings).not.toContain('同一 Wi-Fi')
    expect(preload).toContain("stopRemoteControl: () => ipcRenderer.invoke('desktop:remote-stop-control')")
    expect(preload).toContain("resetRemoteIdentity: () => ipcRenderer.invoke('desktop:remote-reset-identity')")
    expect(preload).toContain("setRemoteClientUrl: url => ipcRenderer.invoke('desktop:remote-set-client-url', url)")
    expect(main).toContain("ipcMain.handle('desktop:remote-stop-control'")
    expect(main).toContain("ipcMain.handle('desktop:remote-reset-identity'")
    expect(main).toContain("ipcMain.handle('desktop:remote-set-client-url'")
  })

  it('escapes remote descriptions rendered as field hints', () => {
    const markup = settingsFieldMarkup('模型', '<input>', '<img src=x onerror="globalThis.pwned=true">')

    expect(markup).toContain('&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;')
    expect(markup).not.toContain('<img')
  })

  it('does not send credential previews back as settings or replacement keys', () => {
    const snapshot = {
      apiProfiles: [{ id: 'main', hasApiKey: true, apiKeyPreview: 'sk-proj********9x2a' }],
      mcpServers: [],
      profile: { enabledPersonaIds: [] },
    } as unknown as WorkbenchSettingsSnapshot
    expect(createSettingsUpdate(snapshot).apiProfiles).toEqual([{ id: 'main', apiKey: '', reasoning: undefined }])
  })

  it('keeps built-in system plugins out of editable MCP settings', () => {
    const snapshot = {
      activeApiConfigId: undefined,
      approvalPolicy: 'agent',
      capabilityProfile: 'workspace-write',
      gitEnabled: true,
      mcpServers: [
        {
          name: 'computer',
          displayName: '电脑操控',
          system: true,
          enabled: true,
          envKeys: [],
          headerKeys: [],
          status: 'connected',
          tools: [],
        },
        {
          name: 'documents',
          enabled: true,
          command: 'npx',
          args: ['documents-mcp'],
          envKeys: [],
          headerKeys: [],
          status: 'connected',
          tools: [],
        },
      ],
      apiProfiles: [],
      profile: { enabledPersonaIds: [] },
    } as unknown as WorkbenchSettingsSnapshot

    expect(createSettingsUpdate(snapshot).mcpServers).toEqual([expect.objectContaining({
      name: 'documents',
      command: 'npx',
      args: ['documents-mcp'],
    })])
  })

  it('replaces a carried model when a changed connection discovers a new endpoint catalog', () => {
    const previous = {
      id: 'main',
      name: '旧端点',
      provider: 'custom',
      baseUrl: 'https://old.example/v1',
      model: 'old-model',
      contextWindow: 200_000,
      maxTokens: 16_384,
      hasApiKey: true,
    } as WorkbenchApiConfigSummary
    const profile = {
      ...previous,
      baseUrl: 'https://new.example/v1',
      apiKey: 'new-secret',
    } as WorkbenchApiConfigInput
    const models = [
      { model: 'old-model', availability: 'configured' },
      {
        id: 'new-model',
        name: 'New Model',
        model: 'new-model',
        provider: 'custom',
        baseUrl: profile.baseUrl,
        contextWindow: 128_000,
        maxTokens: 8_192,
        maxOutputTokens: 16_384,
        availability: 'api',
        reasoningCapabilities: null,
      },
    ] as WorkbenchModelOption[]

    expect(reconcileDiscoveredProfileModel(profile, previous, models)?.model).toBe('new-model')
    expect(profile).toMatchObject({
      model: 'new-model',
      contextWindow: 128_000,
      maxTokens: 8_192,
      maxOutputTokens: 16_384,
    })
  })
})
