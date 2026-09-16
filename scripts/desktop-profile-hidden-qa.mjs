import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { writeEvidenceFileAtomically } from './evidence-report-output.mjs'
import { captureGithubActionsProvenance } from './github-actions-provenance.mjs'
import { writeSourceEvidenceReportAtomically } from './source-evidence-report.mjs'
import { discoverPackagedExecutable, verifyPackagedExecutableIdentity } from './desktop-packaged-executable.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const mainEntry = join(desktopRoot, 'generated', 'main.mjs')
const releaseRoot = join(repositoryRoot, 'release')
const defaultPackageReport = join(desktopRoot, 'generated', 'package-verification', 'package-report.json')
const profileEvidenceRoot = join(desktopRoot, 'generated', 'profile-qa')
const screenshotRoot = join(profileEvidenceRoot, `${process.platform}-${process.arch}`)
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const electron = desktopRequire('electron')

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function parseArguments(argumentsList) {
  const options = { packaged: false, executable: undefined, packageReport: defaultPackageReport }
  for (const argument of argumentsList) {
    if (argument === '--packaged') options.packaged = true
    else if (argument.startsWith('--executable=')) {
      options.packaged = true
      options.executable = resolve(argument.slice('--executable='.length))
    } else if (argument.startsWith('--package-report=')) options.packageReport = resolve(argument.slice('--package-report='.length))
    else invariant(false, 'Unknown Profile hidden QA argument')
  }
  return options
}

async function packageIdentity(options, executable) {
  if (!options.packaged) return null
  return verifyPackagedExecutableIdentity({
    executable,
    packageReport: options.packageReport,
    repositoryRoot,
    platform: process.platform,
    arch: process.arch,
  })
}

async function createQaProfileFixture(qaRoot) {
  const timestamp = Date.now() - 10_000
  const profileId = 'profile-hidden-qa'
  const workspaceId = 'workspace-hiddenqa-12345678'
  const conversationId = 'conversation-hidden-qa'
  const configRoot = join(qaRoot, 'config')
  const profileRoot = join(configRoot, 'profiles', profileId)
  const legacyConversationsRoot = join(qaRoot, 'legacy-conversations')
  const sourceWorkspace = join(qaRoot, 'source-machine', 'portable-workspace')
  const reboundWorkspace = join(qaRoot, 'target-machine', 'portable-workspace')
  const archivePath = join(qaRoot, 'hidden-ui-roundtrip.turboflux-profile')
  await Promise.all([
    mkdir(legacyConversationsRoot, { recursive: true }),
    mkdir(join(profileRoot, 'workspaces'), { recursive: true }),
    mkdir(join(profileRoot, 'platform'), { recursive: true }),
    mkdir(sourceWorkspace, { recursive: true }),
    mkdir(reboundWorkspace, { recursive: true }),
  ])
  await writeFile(join(sourceWorkspace, 'README.md'), '# Hidden profile QA workspace\n')
  const profile = {
    schemaVersion: 1,
    id: profileId,
    displayName: '默认资料',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivatedAt: timestamp,
    state: 'ready',
    lock: { kind: 'none' },
    storageVersion: 1,
  }
  await writeFile(join(configRoot, 'profiles.json'), `${JSON.stringify({
    schemaVersion: 1,
    installationId: 'installation-hidden-qa',
    activeProfileId: profileId,
    profiles: [profile],
    updatedAt: timestamp,
  }, null, 2)}\n`)
  await writeFile(join(profileRoot, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`)
  await writeFile(join(profileRoot, 'workspaces', 'bindings.json'), `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{
      schemaVersion: 1,
      id: workspaceId,
      displayName: '可移植工作区',
      localPath: sourceWorkspace,
      boundAt: timestamp,
      verifiedAt: timestamp,
      sourceHint: { platform: process.platform, folderName: 'portable-workspace' },
      state: 'bound',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }, null, 2)}\n`)
  await writeFile(join(profileRoot, 'platform', 'projects.json'), `${JSON.stringify({
    schemaVersion: 1,
    projects: [{
      id: 'project-hidden-qa',
      name: '可移植项目',
      path: sourceWorkspace,
      pinned: true,
      tags: ['qa'],
      createdAt: timestamp,
      updatedAt: timestamp + 1_000,
      lastOpenedAt: timestamp + 1_000,
      available: true,
    }],
  }, null, 2)}\n`)
  const conversation = {
    id: conversationId,
    title: '界面迁移验证会话',
    workspacePath: sourceWorkspace,
    createdAt: timestamp + 2_000,
    updatedAt: timestamp + 4_000,
    mode: 'vibe',
    model: 'qa-model',
    provider: 'custom',
    turnCount: 2,
    turns: [
      { id: 'turn-hidden-user', role: 'user', content: '第一条界面迁移历史', timestamp: timestamp + 2_000 },
      { id: 'turn-hidden-assistant', role: 'assistant', content: '第二条界面迁移历史', timestamp: timestamp + 3_000 },
    ],
  }
  await writeFile(join(legacyConversationsRoot, `${conversationId}.jsonl`), `${JSON.stringify({
    version: 1,
    type: 'snapshot',
    timestamp: conversation.updatedAt,
    conversation,
  })}\n`)
  return { archivePath, conversationId, legacyConversationsRoot, profileId, reboundWorkspace, sourceWorkspace, workspaceId }
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  await new Promise(resolvePromise => server.close(resolvePromise))
  invariant(address && typeof address === 'object', 'Unable to allocate a Desktop QA port')
  return address.port
}

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find(candidate => (
          candidate.type === 'page'
          && candidate.webSocketDebuggerUrl
          && typeof candidate.url === 'string'
          && candidate.url.startsWith('file:')
          && candidate.url.includes('/renderer/index.html')
        ))
        if (target) return target
      }
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error('Hidden Desktop window did not expose a QA target')
}

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    await new Promise((resolvePromise, reject) => {
      this.socket.once('open', resolvePromise)
      this.socket.once('error', reject)
    })
    this.socket.on('message', message => {
      const payload = JSON.parse(String(message))
      if (!payload.id) {
        this.events.push(payload)
        return
      }
      const pending = this.pending.get(payload.id)
      if (!pending) return
      this.pending.delete(payload.id)
      clearTimeout(pending.timeout)
      if (payload.error) pending.reject(new Error(payload.error.message))
      else pending.resolve(payload.result)
    })
  }

  call(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Desktop QA protocol request timed out: ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve: resolvePromise, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Desktop QA protocol session closed'))
    }
    this.pending.clear()
    this.socket.close()
  }
}

async function main(options) {
  if (!options.packaged) await readFile(mainEntry)
  const executable = options.packaged
    ? await discoverPackagedExecutable({ executable: options.executable, releaseRoot })
    : electron
  const verifiedPackage = await packageIdentity(options, executable)
  const qaRoot = await mkdtemp(join(tmpdir(), 'turboflux-profile-hidden-qa-'))
  await rm(profileEvidenceRoot, { recursive: true, force: true })
  await mkdir(screenshotRoot, { recursive: true })
  const fixture = await createQaProfileFixture(qaRoot)
  const port = await availablePort()
  const child = spawn(executable, [
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ...(process.platform !== 'darwin' ? ['--disable-gpu'] : []),
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    `--user-data-dir=${join(qaRoot, 'electron')}`,
    `--remote-debugging-port=${port}`,
    ...(options.packaged ? [] : [mainEntry]),
  ], {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TURBOFLUX_CONFIG_DIR: join(qaRoot, 'config'),
      TURBOFLUX_CONVERSATIONS_DIR: fixture.legacyConversationsRoot,
      TURBOFLUX_DESKTOP_QA_HIDDEN: '1',
      TURBOFLUX_DESKTOP_QA_PROFILE_EXPORT_PATH: fixture.archivePath,
      TURBOFLUX_DESKTOP_QA_PROFILE_IMPORT_PATH: fixture.archivePath,
      TURBOFLUX_DESKTOP_QA_PROFILE_REBIND_PATH: fixture.reboundWorkspace,
    },
  })
  child.once('error', () => {})
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  let cdp
  try {
    const target = await waitForTarget(port)
    const applicationMode = target.url.includes('/dist-desktop/') ? 'development-electron' : 'packaged-app'
    invariant(!options.packaged || applicationMode === 'packaged-app', 'Packaged Profile QA connected to a development Renderer')
    cdp = new CdpSession(target.webSocketDebuggerUrl)
    await cdp.connect()
    await Promise.all([cdp.call('Runtime.enable'), cdp.call('Page.enable'), cdp.call('Log.enable')])
    const evaluate = async expression => {
      const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Desktop QA evaluation failed')
      return result.result.value
    }
    const waitFor = async (expression, label, attempts = 750) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(`Boolean(${expression})`)) return
        await new Promise(resolvePromise => setTimeout(resolvePromise, 40))
      }
      const state = await evaluate(`({ url: location.href, title: document.title, readyState: document.readyState, text: document.body?.innerText?.slice(0, 800), html: document.documentElement?.outerHTML?.slice(0, 1200) })`)
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`)
    }
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
    const setInput = (selector, value) => evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (!(input instanceof HTMLInputElement)) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return input.value === ${JSON.stringify(value)}
    })()`)
    const screenshot = async name => {
      await evaluate(`new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise(true))))`)
      const image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const filename = `${name}.png`
      await writeEvidenceFileAtomically(join(screenshotRoot, filename), Buffer.from(image.data, 'base64'))
      return filename
    }
    const press = async (key, code = key) => {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
    }
    const setViewport = async (width, height, deviceScaleFactor = 1) => {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
      await evaluate('new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))')
    }
    const inspectSwitcher = () => evaluate(`(() => {
      const surface = document.querySelector('.profile-switcher-surface')
      const rect = surface?.getBoundingClientRect()
      return {
        visible: document.querySelector('.profile-switcher')?.classList.contains('visible') === true,
        rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        currentUsers: document.querySelectorAll('.profile-switcher-current [data-profile-switcher-user]').length,
        actions: document.querySelectorAll('.profile-switcher-actions button').length,
        manageLabel: document.querySelector('[data-profile-switcher-manage]')?.textContent?.replace(/\\s+/g, ' ').trim(),
        expanded: document.querySelector('#profile-center-button')?.getAttribute('aria-expanded'),
        text: surface?.textContent?.replace(/\\s+/g, ' ').trim(),
      }
    })()`)
    const inspectProfilePage = theme => evaluate(`(() => {
      const rect = selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        const value = element.getBoundingClientRect()
        return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) }
      }
      const page = document.querySelector('.profile-manager-shell')
      const entry = document.querySelector('.profile-manager-row')
      const settingsOverlay = document.querySelector('.settings-overlay')
      const style = entry ? getComputedStyle(entry) : null
      const settingsStyle = settingsOverlay ? getComputedStyle(settingsOverlay) : null
      const listStyle = page ? getComputedStyle(document.querySelector('.profile-manager-nav')) : null
      const contentStyle = page ? getComputedStyle(document.querySelector('.profile-manager-content')) : null
      return {
        theme: document.documentElement.dataset.theme,
        expectedTheme: ${JSON.stringify(theme)},
        viewport: { width: innerWidth, height: innerHeight },
        document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
        overlay: rect('.settings-overlay'),
        settingsSidebar: rect('.settings-nav'),
        settingsMain: rect('.settings-main'),
        settingsHeading: rect('.settings-header'),
        page: rect('.profile-manager-shell'),
        head: rect('.profile-manager-toolbar'),
        list: rect('.profile-manager-nav'),
        portability: rect('.profile-manager-content'),
        entry: rect('.profile-manager-row'),
        footer: rect('.profile-manager-footer-actions'),
        mobileView: page?.getAttribute('data-mobile-view'),
        listVisible: listStyle?.display !== 'none' && listStyle?.visibility !== 'hidden',
        contentVisible: contentStyle?.display !== 'none' && contentStyle?.visibility !== 'hidden',
        mobileBackVisible: document.querySelector('[data-profile-mobile-list]') ? getComputedStyle(document.querySelector('[data-profile-mobile-list]')).display !== 'none' : false,
        profiles: document.querySelectorAll('.profile-manager-row').length,
        activeProfiles: document.querySelectorAll('.profile-manager-row.active').length,
        activeProfileId: document.querySelector('.profile-manager-row.active')?.getAttribute('data-profile-select'),
        rebindActions: document.querySelectorAll('[data-profile-rebind]').length,
        settingsVisible: settingsOverlay?.classList.contains('visible') === true,
        settingsOpacity: settingsStyle?.opacity,
        settingsVisibility: settingsStyle?.visibility,
        title: document.querySelector('#settings-title')?.textContent,
        tabs: document.querySelectorAll('.profile-manager-tabs [role="tab"]').length,
        metrics: document.querySelectorAll('.profile-manager-metrics').length,
        closeActions: document.querySelectorAll('.settings-nav #settings-back').length,
        searchFields: document.querySelectorAll('.profile-manager-search').length,
        conversationRows: document.querySelectorAll('.profile-manager-conversation-row').length,
        workspaceRows: document.querySelectorAll('.profile-manager-object-row[data-profile-tab="workspaces"]').length,
        text: page?.textContent?.replace(/\\s+/g, ' ').trim(),
        entryBackground: style?.backgroundColor,
        entryColor: style?.color,
      }
    })()`)
    const inspectDialog = selector => evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(selector)})
      const rect = dialog?.getBoundingClientRect()
      const style = dialog ? getComputedStyle(dialog) : null
      const overflow = dialog ? [...dialog.querySelectorAll('*')].filter(element => element.scrollWidth > element.clientWidth + 2).map(element => element.className || element.tagName).slice(0, 10) : []
      return {
        open: Boolean(dialog?.closest('.profile-export-overlay')?.classList.contains('open')),
        theme: document.documentElement.dataset.theme,
        rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        background: style?.backgroundColor,
        color: style?.color,
        colorScheme: style?.colorScheme,
        stepCount: dialog?.querySelectorAll('.profile-export-steps li').length,
        heading: dialog?.querySelector('h2')?.textContent,
        overflow,
      }
    })()`)
    const inspectRebindCenter = () => evaluate(`(() => ({
      heading: document.querySelector('.profile-import-window .profile-export-content h3')?.textContent,
      profileName: document.querySelector('.profile-import-window .profile-export-header p')?.textContent,
      workspaceCount: document.querySelectorAll('.profile-import-workspace').length,
      boundWorkspaces: document.querySelectorAll('.profile-import-workspace.bound').length,
      unboundWorkspaces: document.querySelectorAll('.profile-import-workspace.unbound').length,
      conversationCount: document.querySelectorAll('.profile-import-history').length,
      text: document.querySelector('.profile-import-window')?.textContent?.replace(/\\s+/g, ' ').trim(),
    }))()`)
    const inspectReadonlyConversation = () => evaluate(`(() => ({
      heading: document.querySelector('.profile-import-conversation-head h3')?.textContent,
      readonlyLabel: document.querySelector('.profile-import-conversation-head p')?.textContent,
      turns: [...document.querySelectorAll('.profile-import-turn p')].map(element => element.textContent),
      hasBackButton: Boolean(document.querySelector('[data-import-action="back-rebind"]')),
    }))()`)
    const inspectCreateSheet = () => evaluate(`(() => {
      const overlay = document.querySelector('.profile-manager-create-overlay')
      const dialog = overlay?.querySelector('[role="dialog"],.profile-manager-create-view') || overlay?.firstElementChild
      const value = dialog?.getBoundingClientRect()
      return {
        visible: Boolean(overlay),
        rect: value ? { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) } : null,
        modal: overlay?.getAttribute('aria-modal'),
        backgroundInert: document.querySelector('.profile-manager-body')?.hasAttribute('inert'),
        colorChoices: overlay?.querySelectorAll('input[name="profile-color"]').length,
        templateChoices: overlay?.querySelectorAll('input[name="profile-template"]').length,
        footerActions: overlay?.querySelectorAll('.profile-manager-footer-actions button').length,
        overflow: dialog && dialog.scrollWidth > dialog.clientWidth + 2 ? ['dialog'] : [],
      }
    })()`)
    const captureCreateSheet = async name => {
      await click('[data-profile-show-create]')
      await waitFor(`document.querySelector('.profile-manager-create-overlay[aria-modal="true"]')`, `${name} create sheet`)
      const state = await inspectCreateSheet()
      state.screenshot = await screenshot(name)
      await press('Escape', 'Escape')
      await waitFor(`!document.querySelector('.profile-manager-create-overlay')`, `${name} create sheet close`)
      await waitFor(`document.activeElement?.matches('[data-profile-show-create]') === true`, `${name} create sheet focus restoration`)
      state.focusRestored = await evaluate(`document.activeElement?.matches('[data-profile-show-create]') === true`)
      return state
    }

    await setViewport(1440, 900)
    await waitFor(`document.readyState === 'complete' && document.querySelector('#settings-button')`, 'Desktop workbench')
    await click('#settings-button')
    await waitFor(`document.querySelector('.settings-overlay.visible')`, 'settings center')
    await click('[data-settings-section="appearance"]')
    await waitFor(`document.querySelector('[data-theme-choice="light"]')`, 'appearance theme choices')
    await click('[data-theme-choice="light"]')
    await click('#settings-back')
    await waitFor(`!document.querySelector('.settings-overlay.visible')`, 'settings close before profile switcher')
    await click('#profile-center-button')
    await waitFor(`document.querySelector('.profile-switcher.visible [data-profile-switcher-manage]')`, 'profile switcher')
    const lightSwitcher = await inspectSwitcher()
    lightSwitcher.screenshot = await screenshot('profile-switcher-light')
    await click('[data-profile-switcher-manage]')
    await waitFor(`document.querySelector('.profile-manager-shell')`, 'local profile page')
    await waitFor(`getComputedStyle(document.querySelector('.settings-overlay')).opacity === '1' && !document.querySelector('#toast.visible')`, 'settled light profile page')
    const light = await inspectProfilePage('light')
    light.screenshot = await screenshot('profile-center-light-1440-overview')
    const wallpaperMaterial = await evaluate(`(() => {
      document.documentElement.dataset.backgroundMedia = 'image'
      const layer = document.querySelector('.background-media-layer')
      if (layer) layer.style.background = 'radial-gradient(circle at 22% 18%, #54c6c8 0, #4961ac 34%, #d95d98 68%, #1d253c 100%)'
      const element = selector => {
        const target = document.querySelector(selector)
        if (!target) throw new Error('Missing Profile material element: ' + selector)
        return target
      }
      const background = selector => getComputedStyle(element(selector)).backgroundColor
      const backdrop = selector => {
        const styles = getComputedStyle(element(selector))
        return { standard: styles.backdropFilter, webkit: styles.webkitBackdropFilter }
      }
      return {
        overlay: background('.settings-overlay[data-section="data"]'),
        shell: background('.profile-manager-shell'),
        header: background('.profile-manager-toolbar'),
        nav: background('.profile-manager-nav'),
        content: background('.profile-manager-content'),
        overlayBackdrop: backdrop('.settings-overlay[data-section="data"]'),
        shellBackdrop: backdrop('.profile-manager-shell'),
      }
    })()`)
    const hasBackdrop = value => Object.values(value).some(filter => typeof filter === 'string' && filter !== '' && filter !== 'none')
    const opaqueCanvas = value => value === 'rgb(255, 255, 255)' || value === 'rgb(0, 0, 0)'
    wallpaperMaterial.screenshot = await screenshot('profile-center-light-background-material')
    await evaluate(`(() => {
      delete document.documentElement.dataset.backgroundMedia
      const layer = document.querySelector('.background-media-layer')
      if (layer) layer.style.background = ''
    })()`)
    const create1440 = await captureCreateSheet('profile-create-light-1440')

    await setViewport(1024, 768)
    const light1024 = await inspectProfilePage('light')
    light1024.screenshot = await screenshot('profile-center-light-1024-overview')
    const create1024 = await captureCreateSheet('profile-create-light-1024')
    await click('[data-profile-tab="workspaces"]')
    const workspaces1024 = await inspectProfilePage('light')
    workspaces1024.screenshot = await screenshot('profile-center-light-1024-workspaces')
    await click('[data-profile-tab="transfer"]')
    const transfer1024 = await inspectProfilePage('light')
    transfer1024.screenshot = await screenshot('profile-center-light-1024-transfer')

    await setViewport(760, 720)
    await waitFor(`document.querySelector('.profile-manager-shell')?.getAttribute('data-mobile-view') === 'list'`, 'narrow profile list')
    const narrowList = await inspectProfilePage('light')
    narrowList.screenshot = await screenshot('profile-center-light-760-list')
    const create760 = await captureCreateSheet('profile-create-light-760')
    await click('[data-profile-select]')
    await waitFor(`document.querySelector('.profile-manager-shell')?.getAttribute('data-mobile-view') === 'detail'`, 'narrow profile detail')
    const narrowDetail = await inspectProfilePage('light')
    narrowDetail.screenshot = await screenshot('profile-center-light-760-detail')
    await click('[data-profile-mobile-list]')
    await waitFor(`document.querySelector('.profile-manager-shell')?.getAttribute('data-mobile-view') === 'list'`, 'narrow profile list return')

    await setViewport(720, 450, 2)
    const zoom200 = await inspectProfilePage('light')
    zoom200.screenshot = await screenshot('profile-center-light-200-percent-effective')
    const createZoom200 = await captureCreateSheet('profile-create-light-200-percent-effective')

    await setViewport(1440, 900)

    await click('#settings-back')
    await waitFor(`!document.querySelector('.settings-overlay.visible')`, 'profile center close')
    await click('#settings-button')
    await waitFor(`document.querySelector('.settings-overlay.visible')`, 'settings center for dark theme')
    await click('[data-settings-section="appearance"]')
    await waitFor(`document.querySelector('[data-theme-choice="dark"]')`, 'dark theme choice')
    await click('[data-theme-choice="dark"]')
    await click('#settings-back')
    await waitFor(`!document.querySelector('.settings-overlay.visible')`, 'settings close before dark profile switcher')
    await click('#profile-center-button')
    await waitFor(`document.querySelector('.profile-switcher.visible [data-profile-switcher-manage]')`, 'dark profile switcher')
    const darkSwitcher = await inspectSwitcher()
    darkSwitcher.screenshot = await screenshot('profile-switcher-dark')
    await click('[data-profile-switcher-manage]')
    await waitFor(`document.querySelector('.profile-manager-shell')`, 'dark profile page')
    await waitFor(`getComputedStyle(document.querySelector('.settings-overlay')).opacity === '1' && !document.querySelector('#toast.visible')`, 'settled dark profile page')
    const dark = await inspectProfilePage('dark')
    dark.screenshot = await screenshot('profile-center-dark-1440-overview')
    const createDark = await captureCreateSheet('profile-create-dark-1440')

    await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reducedMotion = await evaluate(`(() => {
      const entry = document.querySelector('.profile-manager-row')
      const style = getComputedStyle(entry)
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationDuration: style.animationDuration,
        transitionDuration: style.transitionDuration,
      }
    })()`)

    await click('[data-profile-tab="transfer"]')
    await waitFor(`document.querySelector('[data-profile-export]')`, 'profile transfer actions')
    const exportTriggerFocused = await evaluate(`(() => { const button = document.querySelector('[data-profile-export]'); button?.focus(); button?.click(); return document.activeElement === button })()`)
    await waitFor(`document.querySelector('.profile-export-overlay.open')`, 'export wizard')
    const exportDialog = await inspectDialog('.profile-export-window')
    exportDialog.screenshot = await screenshot('profile-export-dark-reduced-motion')
    const exportFocusTrap = await evaluate(`(() => {
      const dialog = document.querySelector('.profile-export-window')
      const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(element => !element.hidden)
      focusable.at(-1)?.focus()
      return { count: focusable.length, lastFocused: document.activeElement === focusable.at(-1) }
    })()`)
    await press('Tab', 'Tab')
    exportFocusTrap.wrapped = await evaluate(`document.activeElement === document.querySelector('.profile-export-window .profile-export-close')`)
    await press('Escape', 'Escape')
    await waitFor(`!document.querySelector('.profile-export-overlay.open')`, 'export wizard close')
    exportFocusTrap.focusRestored = await evaluate(`document.activeElement?.matches('[data-profile-export]') === true`)

    await evaluate(`document.querySelector('[data-profile-import]')?.focus(); document.querySelector('[data-profile-import]')?.click()`)
    await waitFor(`document.querySelector('.profile-import-overlay.open')`, 'import wizard')
    const importDialog = await inspectDialog('.profile-import-window')
    importDialog.screenshot = await screenshot('profile-import-dark-reduced-motion')
    const importFocusTrap = await evaluate(`(() => {
      const dialog = document.querySelector('.profile-import-window')
      const focusable = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(element => !element.hidden)
      focusable.at(-1)?.focus()
      return { count: focusable.length, lastFocused: document.activeElement === focusable.at(-1) }
    })()`)
    await press('Tab', 'Tab')
    importFocusTrap.wrapped = await evaluate(`document.activeElement === document.querySelector('.profile-import-window .profile-export-close')`)
    await press('Escape', 'Escape')
    await waitFor(`!document.querySelector('.profile-import-overlay.open')`, 'import wizard close')
    importFocusTrap.focusRestored = await evaluate(`document.activeElement?.matches('[data-profile-import]') === true`)

    const archivePassword = 'hidden profile QA password'
    await click('[data-profile-export]')
    await waitFor(`document.querySelector('.profile-export-overlay.open')`, 'round-trip export wizard')
    await click('.profile-export-window [data-export-action="next"]')
    await waitFor(`document.querySelector('.profile-export-window .profile-export-steps li:nth-child(2)')?.classList.contains('active')`, 'export content step')
    await click('.profile-export-window [data-export-action="next"]')
    await waitFor(`document.querySelector('.profile-export-window .profile-export-steps li:nth-child(3)')?.classList.contains('active')`, 'export privacy step')
    await click('.profile-export-window [data-export-action="next"]')
    await waitFor(`document.querySelector('.profile-export-window .profile-export-steps li:nth-child(4)')?.classList.contains('active')`, 'export protection step')
    invariant(await setInput('#profile-export-password', archivePassword), 'Export password could not be entered')
    invariant(await setInput('#profile-export-password-confirm', archivePassword), 'Export password confirmation could not be entered')
    await click('.profile-export-window [data-export-action="next"]')
    await waitFor(`document.querySelector('.profile-export-window .profile-export-steps li:nth-child(5)')?.classList.contains('active')`, 'export confirmation step')
    await click('.profile-export-window [data-export-action="choose-target"]')
    await waitFor(`document.querySelector('.profile-export-window .profile-export-target strong')?.textContent === 'hidden-ui-roundtrip.turboflux-profile'`, 'hidden export target')
    await click('.profile-export-window [data-export-action="next"]')
    await waitFor(`document.querySelector('.profile-export-window .profile-export-content h3')?.textContent === '资料包已导出'`, 'encrypted export completion')
    const exportCompletion = await evaluate(`(() => ({
      heading: document.querySelector('.profile-export-window .profile-export-content h3')?.textContent,
      target: document.querySelector('.profile-export-result strong')?.textContent,
      hash: document.querySelector('.profile-export-result code')?.textContent,
      text: document.querySelector('.profile-export-window')?.textContent?.replace(/\\s+/g, ' ').trim(),
    }))()`)
    exportCompletion.screenshot = await screenshot('profile-export-completed')
    await click('.profile-export-window [data-export-action="done"]')
    await waitFor(`!document.querySelector('.profile-export-overlay.open')`, 'completed export close')

    await click('[data-profile-import]')
    await waitFor(`document.querySelector('.profile-import-overlay.open')`, 'round-trip import wizard')
    await click('.profile-import-window [data-import-action="choose-source"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-target strong')?.textContent === 'hidden-ui-roundtrip.turboflux-profile'`, 'hidden import source')
    await click('.profile-import-window [data-import-action="next"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-steps li:nth-child(2)')?.classList.contains('active')`, 'import authentication step')
    invariant(await setInput('#profile-import-password', archivePassword), 'Import password could not be entered')
    await click('.profile-import-window [data-import-action="next"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-steps li:nth-child(3)')?.classList.contains('active')`, 'import preview step')
    await click('.profile-import-window [data-import-action="next"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-steps li:nth-child(4)')?.classList.contains('active')`, 'import content step')
    await click('.profile-import-window [data-import-action="next"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-steps li:nth-child(5)')?.classList.contains('active')`, 'import safety step')
    await click('#profile-import-risk')
    await waitFor(`document.querySelector('#profile-import-risk')?.checked === true`, 'import safety acceptance')
    await click('.profile-import-window [data-import-action="next"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-steps li:nth-child(6)')?.classList.contains('active')`, 'import create step')
    invariant(await setInput('#profile-import-name', '隐藏验收导入资料'), 'Imported profile name could not be entered')
    await click('.profile-import-window [data-import-action="next"]')
    await waitFor(`document.querySelector('.profile-import-window .profile-export-content h3')?.textContent === '资料已导入，等待重绑定'`, 'import completion and rebind center')
    const rebindBefore = await inspectRebindCenter()
    rebindBefore.screenshot = await screenshot('profile-import-completed-unbound')

    await click('.profile-import-window [data-import-conversation]')
    await waitFor(`document.querySelector('.profile-import-conversation-head h3')?.textContent === '界面迁移验证会话'`, 'imported read-only conversation')
    const readonlyBeforeRebind = await inspectReadonlyConversation()
    readonlyBeforeRebind.screenshot = await screenshot('profile-import-history-readonly')
    await click('.profile-import-window [data-import-action="back-rebind"]')
    await waitFor(`document.querySelector('.profile-import-workspace.unbound')`, 'unbound workspace after history view')

    await click('.profile-import-window [data-rebind-workspace]')
    await waitFor(`document.querySelector('.profile-import-workspace.bound')`, 'workspace rebind completion')
    const rebindAfter = await inspectRebindCenter()
    rebindAfter.screenshot = await screenshot('profile-import-workspace-rebound')
    await click('.profile-import-window [data-import-conversation]')
    await waitFor(`document.querySelector('.profile-import-conversation-head h3')?.textContent === '界面迁移验证会话'`, 'read-only conversation after rebind')
    const readonlyAfterRebind = await inspectReadonlyConversation()
    readonlyAfterRebind.screenshot = await screenshot('profile-import-history-after-rebind')
    await click('.profile-import-window [data-import-action="back-rebind"]')
    await waitFor(`document.querySelector('.profile-import-workspace.bound')`, 'rebind center after second history view')
    await click('.profile-import-window [data-import-action="done"]')
    await waitFor(`!document.querySelector('.profile-import-overlay.open')`, 'completed import close')
    await waitFor(`document.querySelectorAll('.profile-manager-row').length === 2`, 'two isolated local profiles')
    const finalProfiles = await inspectProfilePage('dark')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    finalProfiles.screenshot = await screenshot('profile-center-after-roundtrip')

    await evaluate(`(async () => {
      for (const [index, displayName] of ['学习', '实验', '写作', '研究', '客户', '测试'].entries()) {
        await window.turbofluxDesktop.createLocalProfile({
          displayName,
          avatar: { kind: 'color', value: ${JSON.stringify(['#7c6ee6', '#3f82c4', '#2f8c77', '#9a7137', '#b05f72', '#66758f'])}[index] },
          copyCurrentSettings: false,
          switchToNew: false,
        })
      }
      return true
    })()`)
    await click('#settings-back')
    await waitFor(`!document.querySelector('.settings-overlay.visible')`, 'profile center close before eight-user evidence')
    await click('#profile-center-button')
    await waitFor(`document.querySelector('.profile-switcher.visible [data-profile-switcher-manage]')`, 'eight-user profile switcher')
    await click('[data-profile-switcher-manage]')
    await waitFor(`document.querySelectorAll('.profile-manager-row').length === 8 && document.querySelector('.profile-manager-search input')`, 'eight-user search threshold')
    const eightUsers = await inspectProfilePage('dark')
    eightUsers.screenshot = await screenshot('profile-center-dark-eight-users-search')

    for (const state of [light, dark]) {
      invariant(state.theme === state.expectedTheme, `${state.expectedTheme} theme did not apply`)
      invariant(state.overlay && state.page && state.head && state.list && state.portability && state.entry, `${state.expectedTheme} profile layout is incomplete`)
      invariant(state.page.x === state.head.x && state.page.x === state.list.x && state.head.width === state.page.width, `${state.expectedTheme} profile shell axes are misaligned`)
      invariant(state.head.y + state.head.height <= state.list.y && state.head.y + state.head.height <= state.portability.y, `${state.expectedTheme} profile toolbar overlaps its content`)
      invariant(state.settingsMain && state.page.x >= state.settingsMain.x && state.page.x + state.page.width <= state.settingsMain.x + state.settingsMain.width + 1, `${state.expectedTheme} profile page escapes its settings content`)
      invariant(state.settingsSidebar && Math.abs(state.settingsSidebar.x + state.settingsSidebar.width - state.settingsMain.x) <= 1, `${state.expectedTheme} settings navigation is detached from its content`)
      invariant(state.settingsHeading && state.settingsHeading.y + state.settingsHeading.height <= state.page.y, `${state.expectedTheme} settings heading overlaps the profile page`)
      invariant(state.document.scrollWidth <= state.viewport.width, `${state.expectedTheme} profile page overflows horizontally`)
      invariant(state.profiles >= 1 && state.activeProfiles === 1, `${state.expectedTheme} profile state is incomplete`)
      invariant(state.title === '用户资料', `${state.expectedTheme} profile heading is incorrect`)
      invariant(state.tabs === 3 && state.metrics === 0 && state.footer === null, `${state.expectedTheme} profile information architecture regressed`)
      invariant(state.closeActions === 1, `${state.expectedTheme} profile workspace does not have one clear return action`)
      invariant(state.searchFields === 0, `${state.expectedTheme} profile workspace wastes space on search for one user`)
      invariant(state.conversationRows >= 1 && state.workspaceRows >= 1 && state.text?.includes('界面迁移验证会话') && state.text?.includes('可移植工作区'), `${state.expectedTheme} profile workspace does not show real conversation and workspace objects`)
    }
    for (const switcher of [lightSwitcher, darkSwitcher]) {
      invariant(switcher.visible && switcher.currentUsers === 1 && switcher.actions === 3, `Profile switcher hierarchy is incomplete: ${JSON.stringify(switcher)}`)
      invariant(switcher.expanded === 'true' && switcher.manageLabel === '管理用户资料…', `Profile switcher identity or management route is incorrect: ${JSON.stringify(switcher)}`)
    }
    const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
    const translucent = value => {
      const slashAlpha = value.match(/\/\s*([0-9]*\.?[0-9]+)(%)?\s*\)$/u)
      if (slashAlpha) return Number(slashAlpha[1]) < (slashAlpha[2] ? 100 : 1)
      const commaAlpha = value.match(/^rgba\([^)]*,\s*([0-9]*\.?[0-9]+)\s*\)$/u)
      return commaAlpha ? Number(commaAlpha[1]) < 1 : false
    }
    const materialBackdrop = hasBackdrop(wallpaperMaterial.overlayBackdrop) || hasBackdrop(wallpaperMaterial.shellBackdrop)
    const materialFallback = translucent(wallpaperMaterial.overlay) || translucent(wallpaperMaterial.shell)
    invariant(!opaqueCanvas(wallpaperMaterial.overlay) && (materialBackdrop || materialFallback), `Profile editor does not retain a supported background material: ${JSON.stringify(wallpaperMaterial)}`)
    invariant(transparent(wallpaperMaterial.header) && transparent(wallpaperMaterial.nav) && transparent(wallpaperMaterial.content), `Profile settings page material layers are incorrect: ${JSON.stringify(wallpaperMaterial)}`)
    invariant(light1024.document.scrollWidth <= light1024.viewport.width && light1024.tabs === 3, `1024px profile layout regressed: ${JSON.stringify(light1024)}`)
    invariant(workspaces1024.text?.includes('工作区绑定') && transfer1024.text?.includes('迁移边界'), 'Profile task tabs do not expose their intended content')
    invariant(narrowList.mobileView === 'list' && narrowList.listVisible && !narrowList.contentVisible, `760px list state is incorrect: ${JSON.stringify(narrowList)}`)
    invariant(narrowDetail.mobileView === 'detail' && !narrowDetail.listVisible && narrowDetail.contentVisible && narrowDetail.mobileBackVisible, `760px detail state is incorrect: ${JSON.stringify(narrowDetail)}`)
    invariant(narrowList.document.scrollWidth <= narrowList.viewport.width && narrowDetail.document.scrollWidth <= narrowDetail.viewport.width, '760px profile layout overflows horizontally')
    invariant(zoom200.document.scrollWidth <= zoom200.viewport.width && zoom200.listVisible, `200% effective viewport is unusable: ${JSON.stringify(zoom200)}`)
    for (const createSheet of [create1440, create1024, create760, createZoom200, createDark]) {
      invariant(createSheet.visible && createSheet.modal === 'true' && createSheet.backgroundInert, `Create sheet is not modal: ${JSON.stringify(createSheet)}`)
      invariant(createSheet.colorChoices === 8 && createSheet.templateChoices === 2 && createSheet.footerActions === 2, `Create sheet options are incomplete: ${JSON.stringify(createSheet)}`)
      invariant(createSheet.overflow.length === 0 && createSheet.focusRestored, `Create sheet layout or focus lifecycle failed: ${JSON.stringify(createSheet)}`)
    }
    const boundedMotion = value => value.split(',').every(duration => {
      const trimmed = duration.trim()
      if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed) <= 1
      if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) <= 0.001
      return false
    })
    invariant(reducedMotion.matches && boundedMotion(reducedMotion.animationDuration) && boundedMotion(reducedMotion.transitionDuration), 'Reduced Motion does not suppress profile animation')
    invariant(exportTriggerFocused, 'Export trigger could not receive focus')
    for (const dialog of [exportDialog, importDialog]) {
      invariant(dialog.open && dialog.rect, `${dialog.heading || 'Profile'} dialog is not open`)
      invariant(dialog.rect.x >= 0 && dialog.rect.y >= 0 && dialog.rect.x + dialog.rect.width <= light.viewport.width && dialog.rect.y + dialog.rect.height <= light.viewport.height, `${dialog.heading} dialog is outside the viewport`)
      invariant(dialog.overflow.length === 0, `${dialog.heading} dialog contains horizontal overflow: ${dialog.overflow.join(', ')}`)
    }
    invariant(exportDialog.stepCount === 5, 'Export wizard steps are incomplete')
    invariant(importDialog.stepCount === 6, 'Import wizard steps are incomplete')
    invariant(exportFocusTrap.lastFocused && exportFocusTrap.wrapped && exportFocusTrap.focusRestored, 'Export dialog keyboard focus lifecycle failed')
    invariant(importFocusTrap.lastFocused && importFocusTrap.wrapped && importFocusTrap.focusRestored, `Import dialog keyboard focus lifecycle failed: ${JSON.stringify(importFocusTrap)}`)
    invariant(exportCompletion.heading === '资料包已导出' && exportCompletion.target === 'hidden-ui-roundtrip.turboflux-profile' && /^[a-f0-9]{64}$/u.test(exportCompletion.hash || ''), 'Encrypted export completion evidence is incomplete')
    invariant(rebindBefore.workspaceCount === 1 && rebindBefore.unboundWorkspaces === 1 && rebindBefore.boundWorkspaces === 0, `Imported workspace was not isolated before rebind: ${JSON.stringify(rebindBefore)}`)
    invariant(rebindBefore.conversationCount === 1 && rebindBefore.text?.includes('高风险内容保持禁用'), 'Imported history or safety state is missing before rebind')
    for (const readonly of [readonlyBeforeRebind, readonlyAfterRebind]) {
      invariant(readonly.heading === '界面迁移验证会话' && readonly.readonlyLabel?.includes('只读历史') && readonly.hasBackButton, 'Imported conversation is not presented as read-only history')
      invariant(readonly.turns.join('|') === '第一条界面迁移历史|第二条界面迁移历史', 'Imported conversation order or content changed')
    }
    invariant(rebindAfter.workspaceCount === 1 && rebindAfter.boundWorkspaces === 1 && rebindAfter.unboundWorkspaces === 0, `Workspace did not become bound through the UI: ${JSON.stringify(rebindAfter)}`)
    invariant(rebindAfter.text?.includes('已绑定 portable-workspace'), 'Rebound folder is not shown in the UI')
    invariant(finalProfiles.profiles === 2 && finalProfiles.activeProfiles === 1, 'Import did not create exactly one isolated profile')
    invariant(finalProfiles.settingsVisible && finalProfiles.settingsOpacity === '1' && finalProfiles.settingsVisibility === 'visible', `Profile center is not visibly restored after import: ${JSON.stringify(finalProfiles)}`)
    invariant(finalProfiles.activeProfileId === fixture.profileId, 'Import unexpectedly replaced or activated over the original profile')
    invariant(finalProfiles.rebindActions === 0, `Imported profile summary did not retain the completed rebind state: ${JSON.stringify(finalProfiles)}`)
    invariant(eightUsers.profiles === 8 && eightUsers.searchFields === 1, `Eight-user search threshold failed: ${JSON.stringify(eightUsers)}`)

    const terminalSession = await evaluate('window.turbofluxDesktop.terminalCreate({ cols: 100, rows: 24 })')
    let terminal
    try {
      const sessionId = JSON.stringify(terminalSession.id)
      const resized = await evaluate(`window.turbofluxDesktop.terminalResize(${sessionId}, 120, 30)`)
      const command = process.platform === 'win32'
        ? "Write-Output ('orbit-terminal-' + 'ok'); exit 0\r"
        : "printf 'orbit-terminal-%s\\n' ok; exit 0\r"
      await evaluate(`window.turbofluxDesktop.terminalWrite(${sessionId}, ${JSON.stringify(command)})`)
      let buffer
      for (let attempt = 0; attempt < 300; attempt += 1) {
        buffer = await evaluate(`window.turbofluxDesktop.terminalRead(${sessionId}, 0)`)
        if (buffer.session.status === 'exited') break
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      }
      terminal = {
        shell: terminalSession.shell,
        outputVerified: buffer?.chunks.map(chunk => chunk.data).join('').includes('orbit-terminal-ok') === true,
        resized: resized.cols === 120 && resized.rows === 30,
        exitCode: buffer?.session.status === 'exited' ? buffer.session.exitCode : null,
        closed: false,
      }
      invariant(terminal.outputVerified && terminal.resized && terminal.exitCode === 0, 'Packaged terminal did not complete the shell round trip')
    } finally {
      await evaluate(`window.turbofluxDesktop.terminalClose(${JSON.stringify(terminalSession.id)})`)
    }
    const remainingTerminals = await evaluate('window.turbofluxDesktop.terminalList()')
    terminal.closed = !remainingTerminals.some(session => session.id === terminalSession.id)
    invariant(terminal.closed, 'Packaged terminal did not close')

    const result = {
      schemaVersion: 2,
      platform: process.platform,
      arch: process.arch,
      provenance: captureGithubActionsProvenance(),
      applicationMode,
      packageEvidence: verifiedPackage,
      mode: 'hidden-electron',
      lightSwitcher,
      light,
      wallpaperMaterial,
      create1440,
      light1024,
      create1024,
      workspaces1024,
      transfer1024,
      narrowList,
      create760,
      narrowDetail,
      zoom200,
      createZoom200,
      darkSwitcher,
      dark,
      createDark,
      reducedMotion,
      exportDialog,
      exportFocusTrap,
      importDialog,
      importFocusTrap,
      exportCompletion,
      rebindBefore,
      readonlyBeforeRebind,
      rebindAfter,
      readonlyAfterRebind,
      finalProfiles,
      eightUsers,
      terminal,
      rendererErrors: cdp.events.filter(event => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')).map(event => event.params),
    }
    invariant(result.rendererErrors.length === 0, `Renderer reported ${result.rendererErrors.length} error(s)`)
    const sanitizedResult = await writeSourceEvidenceReportAtomically(join(screenshotRoot, 'result.json'), result)
    process.stdout.write(`${JSON.stringify(sanitizedResult, null, 2)}\n`)
  } finally {
    cdp?.close()
    if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        // Terminate Chromium children too, so they release the temporary profile files.
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 })
      } catch {
        child.kill('SIGKILL')
      }
    } else child.kill('SIGTERM')
    await new Promise(resolvePromise => {
      if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise() }, 4_000)
      timer.unref()
      child.once('close', () => { clearTimeout(timer); resolvePromise() })
    })
    if (process.env.TURBOFLUX_QA_PRESERVE !== '1') await rm(qaRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    else process.stderr.write('Preserved hidden QA root\n')
  }
}

try {
  await main(parseArguments(process.argv.slice(2)))
} catch (error) {
  if (process.env.TURBOFLUX_PROFILE_QA_DIAGNOSTICS === '1') console.error(error)
  process.stderr.write('Profile hidden QA failed\n')
  process.exitCode = 1
}
