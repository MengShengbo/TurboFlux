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
    const inspectProfile = () => evaluate(`(() => {
      const overlay = document.querySelector('.user-profile-overlay')
      const dialog = document.querySelector('.user-profile-dialog')
      const rect = dialog?.getBoundingClientRect()
      return {
        visible: Boolean(overlay && !overlay.hidden),
        modal: dialog?.getAttribute('aria-modal') === 'true',
        backgroundInert: document.querySelector('.desktop-shell')?.hasAttribute('inert') === true,
        expanded: document.querySelector('#profile-center-button')?.getAttribute('aria-expanded') === 'true',
        theme: document.documentElement.dataset.theme,
        viewport: { width: innerWidth, height: innerHeight },
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        noHorizontalOverflow: Boolean(dialog && dialog.scrollWidth <= dialog.clientWidth + 2 && overlay.scrollWidth <= overlay.clientWidth + 2),
        activityDays: document.querySelectorAll('[data-profile-activity] [data-day]').length,
        activityHalves: document.querySelectorAll('.profile-activity-half').length,
        name: document.querySelector('#user-profile-name')?.value,
        title: document.querySelector('#user-profile-title')?.textContent,
      }
    })()`)
    const openProfile = async () => {
      await click('#profile-center-button')
      await waitFor(`document.querySelector('.user-profile-overlay:not([hidden]) [data-profile-activity] [data-day]')`, 'personal profile activity')
    }
    const closeProfile = async () => {
      await press('Escape')
      await waitFor(`document.querySelector('.user-profile-overlay')?.hidden === true`, 'personal profile close')
      await waitFor(`document.activeElement?.id === 'profile-center-button'`, 'profile trigger focus restored')
    }
    const setTheme = async theme => {
      await click('#settings-button')
      await waitFor(`document.querySelector('.settings-overlay.visible')`, 'settings center')
      await click('[data-settings-section="appearance"]')
      await waitFor(`document.querySelector('[data-theme-choice="${theme}"]')`, 'appearance theme choice')
      await click(`[data-theme-choice="${theme}"]`)
      await click('#settings-back')
      await waitFor(`!document.querySelector('.settings-overlay.visible')`, 'settings close')
      await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, 'theme applied')
    }
    const capture = async name => {
      const state = await inspectProfile()
      state.screenshot = await screenshot(name)
      return state
    }
    await setViewport(1440, 900)
    await waitFor(`document.readyState === 'complete' && document.querySelector('#settings-button') && window.turbofluxDesktop`, 'Desktop workbench')
    await setTheme('light')
    await openProfile()
    const light = await capture('user-profile-light')
    const expectedName = 'Desktop QA'
    invariant(await setInput('#user-profile-name', expectedName), 'Name input is unavailable')
    await click('[data-profile-save]')
    await waitFor(`document.querySelector('[data-profile-name]')?.textContent === 'Desktop QA' && document.querySelector('.user-profile-dialog')?.getAttribute('aria-busy') === 'false'`, 'saved personal identity')
    const saved = await evaluate('window.turbofluxDesktop.getUserProfile()')
    const persisted = JSON.parse(await readFile(join(qaRoot, 'electron', 'personal', 'identity.json'), 'utf8'))
    await closeProfile()
    const focusRestored = await evaluate(`document.activeElement?.id === 'profile-center-button' && !document.querySelector('.desktop-shell')?.hasAttribute('inert')`)
    await openProfile()
    const reopened = await evaluate(`document.querySelector('#user-profile-name')?.value`)
    const identity = {
      saved: saved.displayName === expectedName,
      persisted: persisted.displayName === expectedName,
      reopened: reopened === expectedName,
      sidebarUpdated: await evaluate(`document.querySelector('#sidebar-profile-name')?.textContent === 'Desktop QA'`),
    }
    await evaluate(`document.querySelector('.profile-activity-day.is-today')?.focus()`)
    const focusedDay = await evaluate('document.activeElement?.dataset.day')
    await press('ArrowLeft')
    const previousDay = await evaluate('document.activeElement?.dataset.day')
    const keyboardNavigation = Boolean(focusedDay && previousDay && focusedDay !== previousDay)
    await setViewport(760, 720)
    const narrow = await capture('user-profile-narrow')
    await setViewport(720, 450, 2)
    const zoom200 = await capture('user-profile-zoom200')
    await closeProfile()
    await setViewport(1440, 900)
    await setTheme('dark')
    await openProfile()
    const dark = await capture('user-profile-dark')
    await closeProfile()
    for (const [name, state] of Object.entries({ light, narrow, zoom200, dark })) {
      invariant(state.visible && state.modal && state.backgroundInert && state.expanded, `${name} profile modality is invalid`)
      invariant(state.activityDays >= 365 && state.activityHalves === 2, `${name} activity calendar is incomplete`)
      invariant(state.title === '用户资料' && state.noHorizontalOverflow, `${name} profile layout is invalid`)
      invariant(state.rect?.x >= 0 && state.rect?.y >= 0 && state.rect.x + state.rect.width <= state.viewport.width + 1 && state.rect.y + state.rect.height <= state.viewport.height + 1, `${name} profile escaped its viewport`)
    }
    invariant(light.theme === 'light' && dark.theme === 'dark', 'Personal profile themes were not applied')
    invariant(Object.values(identity).every(Boolean), 'Personal identity did not survive saving and reopening')
    invariant(focusRestored && keyboardNavigation, 'Personal profile keyboard lifecycle failed')

    const terminalSession = await evaluate('window.turbofluxDesktop.terminalCreate({ cols: 100, rows: 24 })')
    let terminal
    try {
      const sessionId = JSON.stringify(terminalSession.id)
      const resized = await evaluate(`window.turbofluxDesktop.terminalResize(${sessionId}, 120, 30)`)
      const command = process.platform === 'win32'
        ? "Write-Output ('desktop-terminal-' + 'ok'); exit 0\r"
        : "printf 'desktop-terminal-%s\\n' ok; exit 0\r"
      await evaluate(`window.turbofluxDesktop.terminalWrite(${sessionId}, ${JSON.stringify(command)})`)
      let buffer
      for (let attempt = 0; attempt < 300; attempt += 1) {
        buffer = await evaluate(`window.turbofluxDesktop.terminalRead(${sessionId}, 0)`)
        if (buffer.session.status === 'exited') break
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      }
      terminal = {
        shell: terminalSession.shell,
        outputVerified: buffer?.chunks.map(chunk => chunk.data).join('').includes('desktop-terminal-ok') === true,
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
      schemaVersion: 3,
      platform: process.platform,
      arch: process.arch,
      provenance: captureGithubActionsProvenance(),
      applicationMode,
      packageEvidence: verifiedPackage,
      mode: 'hidden-electron',
      light, dark, narrow, zoom200, identity, focusRestored, keyboardNavigation, terminal,
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
