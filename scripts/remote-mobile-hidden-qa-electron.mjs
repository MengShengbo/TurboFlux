import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeEvidenceFileAtomically } from './evidence-report-output.mjs'

function invariant(condition, message) {
  if (!condition) throw new Error(`Remote Mobile hidden QA failed: ${message}`)
}

const targetUrl = process.env.TURBOFLUX_REMOTE_MOBILE_QA_URL
const evidenceRoot = process.env.TURBOFLUX_REMOTE_MOBILE_QA_EVIDENCE
const temporaryEvidenceRoot = process.env.TURBOFLUX_REMOTE_MOBILE_QA_TEMP
invariant(targetUrl, 'target URL is missing')
invariant(evidenceRoot, 'evidence directory is missing')
invariant(temporaryEvidenceRoot, 'temporary evidence directory is missing')

let windowReceivedFocus = false
const rendererErrors = []

app.on('browser-window-focus', () => { windowReceivedFocus = true })

async function main() {
  nativeTheme.themeSource = 'light'
  if (process.platform === 'darwin') app.dock?.hide()
  await Promise.all([mkdir(evidenceRoot, { recursive: true }), mkdir(temporaryEvidenceRoot, { recursive: true })])

  const window = new BrowserWindow({
    width: 390,
    height: 844,
    useContentSize: true,
    frame: false,
    show: false,
    backgroundColor: '#f4f4f0',
    webPreferences: {
      backgroundThrottling: false,
      offscreen: process.platform !== 'darwin',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.on('focus', () => { windowReceivedFocus = true })
  window.webContents.on('console-message', (_event, level) => {
    if (Number(level) >= 3) rendererErrors.push('console-error')
  })
  window.webContents.on('render-process-gone', () => rendererErrors.push('render-process-gone'))

  let diagnosticTimer
  const writeDiagnostic = async stage => {
    const page = await window.webContents.executeJavaScript(`({
      readyState: document.readyState,
      pairHidden: document.querySelector('#pair-view')?.hidden,
      shellHidden: document.querySelector('#shell-view')?.hidden,
      pairErrorVisible: Boolean(document.querySelector('#pair-error')?.textContent),
      secureContext: window.isSecureContext,
    })`, true).catch(() => ({ evaluationFailed: true }))
    await writeFile(join(temporaryEvidenceRoot, 'diagnostic.json'), `${JSON.stringify({ stage, page, rendererErrorCount: rendererErrors.length }, null, 2)}\n`)
  }

  const evaluate = expression => window.webContents.executeJavaScript(expression, true)
  const waitFor = async (expression, label) => {
    const poll = async attempt => {
      if (attempt >= 300) {
        const state = await evaluate(`({
          readyState: document.readyState,
          pairHidden: document.querySelector('#pair-view')?.hidden,
          shellHidden: document.querySelector('#shell-view')?.hidden,
          pairErrorVisible: Boolean(document.querySelector('#pair-error')?.textContent),
        })`)
        throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`)
      }
      if (await evaluate(`Boolean(${expression})`)) return
      await new Promise(resolve => setTimeout(resolve, 50))
      return poll(attempt + 1)
    }
    return poll(0)
  }
  const capture = async name => {
    const filename = `${name}.png`
    const image = await window.capturePage()
    invariant(!image.isEmpty(), `${name} screenshot is empty`)
    const path = join(evidenceRoot, filename)
    await writeEvidenceFileAtomically(path, image.toPNG())
    return filename
  }
  const inspect = () => evaluate(`(() => {
    const rect = selector => {
      const element = document.querySelector(selector)
      if (!element) return null
      const value = element.getBoundingClientRect()
      return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) }
    }
    const visible = selector => {
      const element = document.querySelector(selector)
      if (!element) return null
      const value = element.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.max(0, value.left + Math.min(12, value.width / 2)), Math.max(0, value.top + Math.min(12, value.height / 2)))
      const ancestors = []
      for (let current = element; current && ancestors.length < 8; current = current.parentElement) {
        const styles = getComputedStyle(current)
        ancestors.push({ display: styles.display, visibility: styles.visibility, opacity: styles.opacity })
      }
      return {
        width: Math.round(Math.max(0, Math.min(value.right, innerWidth) - Math.max(value.left, 0))),
        height: Math.round(Math.max(0, Math.min(value.bottom, innerHeight) - Math.max(value.top, 0))),
        hitWithinTarget: Boolean(hit && element.contains(hit)),
        ancestors,
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      hasFocus: document.hasFocus(),
      secureContext: window.isSecureContext,
      shell: rect('#shell-view'),
      header: rect('.topbar'),
      conversation: rect('.conversation-panel'),
      approval: rect('.approval-card'),
      artifact: rect('.artifact-card'),
      composer: rect('#composer'),
      approvalVisibility: visible('.approval-card'),
      text: document.querySelector('#shell-view')?.textContent?.replace(/\\s+/g, ' ').trim(),
    }
  })()`)

  await window.loadURL(targetUrl)
  await writeDiagnostic('loaded')
  diagnosticTimer = setInterval(() => void writeDiagnostic('waiting-for-pairing'), 500)
  await waitFor(`!document.querySelector('#shell-view')?.hidden`, 'encrypted pairing and control claim')
  await waitFor(`document.querySelectorAll('.approval-card').length === 1 && document.querySelectorAll('.artifact-card').length === 1`, 'real snapshot content')
  await evaluate(`document.querySelector('.approval-card')?.scrollIntoView({ block: 'start', inline: 'nearest' })`)
  await new Promise(resolve => setTimeout(resolve, 100))

  const workspace = await inspect()
  invariant(workspace.viewport.width === 390 && workspace.viewport.height === 844, 'mobile viewport is not 390x844')
  invariant(workspace.document.width <= workspace.viewport.width, 'workspace overflows horizontally')
  invariant(workspace.hasFocus === false && !window.isFocused(), 'hidden window received focus')
  invariant(workspace.secureContext === true, 'localhost page is not a secure browser context')
  invariant(workspace.approvalVisibility?.width > 0 && workspace.approvalVisibility?.height >= 120, 'approval card is not materially visible')
  invariant(workspace.approvalVisibility?.hitWithinTarget === true, 'approval card is covered by another surface')
  invariant(workspace.approvalVisibility?.ancestors.every(item => item.display !== 'none' && item.visibility === 'visible' && Number.parseFloat(item.opacity) > 0), 'approval card has a hidden ancestor')
  invariant(workspace.text?.includes('仅这次允许') && workspace.text?.includes('拒绝'), 'fixed approval choices are missing')
  invariant(workspace.text?.includes('端到端已连接'), 'connected state is missing')
  const workspaceScreenshot = await capture('remote-mobile-workspace-light')

  await evaluate(`document.querySelector('#sessions-toggle')?.click()`)
  await waitFor(`document.querySelector('#session-panel')?.classList.contains('open') && !document.querySelector('#session-scrim')?.hidden`, 'mobile session drawer')
  await waitFor(`document.querySelector('#session-panel')?.getBoundingClientRect().left >= -0.5`, 'mobile session drawer transition')
  const drawer = await evaluate(`(() => {
    const element = document.querySelector('#session-panel')
    const rect = element?.getBoundingClientRect()
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      hasFocus: document.hasFocus(),
      rect: rect && { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    }
  })()`)
  invariant(drawer.documentWidth <= drawer.viewport.width, 'session drawer overflows horizontally')
  invariant(drawer.rect?.x === 0 && drawer.rect.width > 0 && drawer.rect.width <= 328, 'session drawer is outside the mobile viewport')
  invariant(drawer.hasFocus === false, 'session drawer received focus')
  const drawerScreenshot = await capture('remote-mobile-session-drawer-light')

  await evaluate(`document.querySelector('#session-scrim')?.click()`)
  await waitFor(`!document.querySelector('#session-panel')?.classList.contains('open') && document.querySelector('#session-scrim')?.hidden && document.querySelector('#session-panel')?.getBoundingClientRect().right <= 0.5`, 'closed mobile session drawer')
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  })
  await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches`, 'dark reduced-motion media')
  await evaluate(`document.querySelector('.approval-card')?.scrollIntoView({ block: 'start', inline: 'nearest' })`)
  await new Promise(resolve => setTimeout(resolve, 100))
  const darkReducedMotion = await evaluate(`(() => {
    const shell = document.querySelector('#shell-view')
    const styles = getComputedStyle(shell)
    return {
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: styles.animationDuration,
      transitionDuration: styles.transitionDuration,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      hasFocus: document.hasFocus(),
    }
  })()`)
  invariant(darkReducedMotion.documentWidth <= darkReducedMotion.viewportWidth, 'dark layout overflows horizontally')
  invariant(darkReducedMotion.hasFocus === false, 'dark layout received focus')
  const darkScreenshot = await capture('remote-mobile-workspace-dark-reduced-motion')

  const artifactDownload = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for artifact download')), 5_000)
    window.webContents.session.once('will-download', (event, item) => {
      const evidence = {
        name: item.getFilename(),
        mime: item.getMimeType(),
      }
      event.preventDefault()
      clearTimeout(timer)
      resolve(evidence)
    })
  })
  const artifactClicked = await evaluate(`(() => {
    const artifact = document.querySelector('.artifact-card')
    if (!(artifact instanceof HTMLButtonElement)) return false
    artifact.click()
    return true
  })()`)
  invariant(artifactClicked === true, 'artifact card could not be clicked')
  await waitFor(`document.querySelector('#toast')?.textContent === '产物已下载'`, 'remote artifact read completion')
  const downloadedArtifact = await artifactDownload

  const approvalClicked = await evaluate(`(() => {
    const action = [...document.querySelectorAll('.approval-card button')]
      .find(element => element.textContent?.trim() === '仅这次允许')
    if (!(action instanceof HTMLButtonElement)) return false
    action.click()
    return true
  })()`)
  invariant(approvalClicked === true, 'allow-once approval action could not be clicked')
  await waitFor(`document.querySelectorAll('.approval-card').length === 0`, 'remote approval resolution')
  const approvalCardsAfterResolution = await evaluate(`document.querySelectorAll('.approval-card').length`)

  const result = {
    schemaVersion: 2,
    mode: 'hidden-electron-remote-mobile',
    platform: process.platform,
    arch: process.arch,
    windowNeverFocused: !windowReceivedFocus && !window.isFocused(),
    workspace,
    drawer,
    darkReducedMotion,
    interaction: {
      artifactClicked,
      artifactDownloadPrevented: true,
      artifactDownloadName: downloadedArtifact.name,
      artifactDownloadMime: downloadedArtifact.mime,
      approvalClicked,
      approvalCardsAfterResolution,
    },
    rendererErrors,
    screenshots: [workspaceScreenshot, drawerScreenshot, darkScreenshot],
  }
  await writeFile(join(temporaryEvidenceRoot, 'renderer-result.json'), `${JSON.stringify(result, null, 2)}\n`)
  clearInterval(diagnosticTimer)
  await writeFile(join(temporaryEvidenceRoot, 'diagnostic.json'), `${JSON.stringify({ stage: 'completed' }, null, 2)}\n`)
  if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
  window.destroy()
}

app.whenReady().then(main).then(() => app.quit()).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
