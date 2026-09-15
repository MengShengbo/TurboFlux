import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type {
  WorkbenchApiConfigInput,
  WorkbenchApiConfigSummary,
  WorkbenchModelOption,
  WorkbenchSettingsSnapshot,
} from '@turboflux/agent-core/workbench'
import { createSettingsUpdate, settingsFieldMarkup } from './settingsCenter'
import { reconcileDiscoveredProfileModel } from './apiSettingsModel'

describe('desktop settings draft', () => {
  it('provides a full-size profile workspace backed by real profile objects', () => {
    const settings = readFileSync(new URL('./settingsCenter.ts', import.meta.url), 'utf8')
    const center = readFileSync(new URL('./profileCenter.ts', import.meta.url), 'utf8')
    const importer = readFileSync(new URL('./profileImportWizard.ts', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
    const profileStyles = readFileSync(new URL('./profileCenter.css', import.meta.url), 'utf8')
    const entry = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

    expect(settings).toContain("title: '用户资料'")
    expect(settings).toContain('createProfileCenter(bridge')
    expect(settings).toContain('profileImportWizard.openRebind(profileId)')
    expect(center).toContain('新建用户资料')
    expect(center).toContain('bridge.switchLocalProfile(profileId)')
    expect(center).toContain('bridge.trashLocalProfile(profileId)')
    expect(center).toContain('bridge.restoreLocalProfile(profileId)')
    expect(center).toContain('profile-manager-body')
    expect(center).toContain('data-mobile-view="${mobileView}"')
    expect(center).toContain('data-profile-mobile-list')
    expect(center).toContain('profile-manager-tabs')
    expect(center).toContain('role="region" aria-labelledby="profile-manager-title"')
    expect(center).toContain('class="profile-manager-toolbar"')
    expect(center).not.toContain('class="profile-manager-back" data-profile-close')
    expect(center).toContain('const showSearch = available.length > 7 || search.length > 0')
    expect(center).toContain('profile.recentConversations ?? []')
    expect(center).toContain('profile.workspaces ?? []')
    expect(center).toContain('data-profile-conversation=')
    expect(center).toContain('profile-manager-overview-grid')
    expect(center).toContain('profile-manager-inspector')
    expect(center).not.toContain('profile-manager-device-panel')
    expect(center).toContain('继续工作')
    expect(center).toContain('可以继续全部工作')
    expect(center).not.toContain('个会话保存在此用户资料')
    expect(center).toContain('class="profile-manager-create-overlay" role="dialog" aria-modal="true"')
    expect(center).toContain("event.key === 'Escape'")
    expect(center).not.toContain('profile-manager-metrics')
    expect(center).toContain("profile.id === selectedProfile()?.id")
    expect(center).toContain('Remote 配对、临时许可和运行进程永不进入资料包')
    expect(importer).toContain('async function openRebind(profileId: string)')
    expect(profileStyles).toContain('.profile-manager-row.active::before')
    expect(profileStyles).toContain('.profile-manager-object-row')
    expect(profileStyles).toContain('grid-template-columns: minmax(0, 1fr) 270px')
    expect(profileStyles).toContain('border-radius: 0;')
    expect(profileStyles).not.toContain('left: 304px;')
    expect(profileStyles).toContain('html[data-background-media] .settings-overlay[data-section="data"]')
    expect(profileStyles).toContain('calc(var(--background-material-opacity, 58%) + 24%)')
    expect(profileStyles).toContain('calc(var(--background-material-blur, 20px) + 8px)')
    expect(profileStyles).toContain('.profile-switcher {')
    expect(profileStyles).toContain('background: #f8f8f6;')
    expect(entry).toContain("import './profileCenter.css'")
    expect(settings).toContain("settingsWindow.setAttribute('role', 'dialog')")
    expect(settings).toContain("desktopShell?.setAttribute('inert', '')")
    expect(settings).toContain("desktopShell?.removeAttribute('inert')")
    expect(settings).toContain('await options.onOpenConversation(conversationId)')
    expect(center).toContain('class="profile-manager-object-row" data-profile-tab="workspaces"')
    expect(styles).toContain('.settings-overlay[data-section="data"] .settings-main { grid-template-rows: auto minmax(0,1fr); }')
    expect(profileStyles).toContain('grid-template-columns: 224px minmax(0, 1fr);')
    expect(profileStyles).toContain('@container (max-width: 760px)')
    expect(styles).toContain('.profile-manager-shell[data-mobile-view="detail"] .profile-manager-content')
    expect(profileStyles).toContain('html[data-background-media] .profile-manager-header,')
    expect(profileStyles).not.toContain('html[data-background-media] .settings-overlay[data-section="data"] {\n  background: var(--surface);')
    expect(styles).not.toContain('.profile-manager-shell:has(.profile-manager-detail)')
  })

  it('offers persistent background media with shared image and video composition controls', () => {
    const settings = readFileSync(new URL('./settingsCenter.ts', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8')
    const workbench = readFileSync(new URL('./workbench.ts', import.meta.url), 'utf8')
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
