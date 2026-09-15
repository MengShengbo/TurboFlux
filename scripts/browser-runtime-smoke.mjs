import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { tsImport } = desktopRequire('tsx/esm/api')

const page = `<!doctype html>
<html lang="zh-CN">
<body>
  <form id="search-form"><label>测试输入 <input aria-label="测试输入"></label></form>
  <label>文件 <input type="file" aria-label="上传文件"></label>
  <a id="download" href="/download">下载测试文件</a>
  <label>主题 <select aria-label="主题"><option value="light">浅色</option><option value="dark">深色</option></select></label>
  <label><input type="checkbox" aria-label="接受测试">接受测试</label>
  <button id="action">执行操作</button>
  <button id="error">生成错误</button>
  <div id="hover" role="button" tabindex="0">悬停目标</div>
  <canvas aria-label="游戏画布" role="application" width="240" height="120"></canvas>
  <p id="result">准备</p>
  <script>
    const result = document.querySelector('#result')
    document.querySelector('input[type=file]').addEventListener('change', event => { result.textContent = 'uploaded:' + event.target.files[0].name })
    document.querySelector('#search-form').addEventListener('submit', event => {
      event.preventDefault()
      result.textContent = 'submitted:' + event.target.querySelector('input').value
    })
    document.querySelector('select').addEventListener('change', event => { result.textContent = 'selected:' + event.target.value })
    document.querySelector('input[type=checkbox]').addEventListener('change', event => { result.textContent = 'checked:' + event.target.checked })
    document.querySelector('#action').addEventListener('click', () => { result.textContent = 'clicked' })
    document.querySelector('#hover').addEventListener('mouseenter', () => { result.textContent = 'hovered' })
    const canvas = document.querySelector('canvas')
    let dragStart = null
    let dragged = false
    canvas.addEventListener('click', () => {
      if (!dragged) result.textContent = 'canvas-clicked'
      dragged = false
    })
    canvas.addEventListener('mousedown', event => { dragStart = { x: event.clientX, y: event.clientY }; dragged = false })
    canvas.addEventListener('mouseup', event => {
      if (dragStart && Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y) > 20) { dragged = true; result.textContent = 'canvas-dragged' }
      dragStart = null
    })
    document.addEventListener('keydown', event => { result.textContent = 'key:' + event.key })
    document.querySelector('#error').addEventListener('click', () => {
      console.error('intentional browser smoke error')
      fetch('/missing').catch(() => {})
    })
  </script>
</body>
</html>`

const server = createServer((request, response) => {
  if (request.url === '/missing') {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('missing')
    return
  }
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="smoke.txt"' })
    response.end('downloaded')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
})

function listen() {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()))
  })
}

function closeServer() {
  return new Promise(resolveClose => server.close(() => resolveClose()))
}

async function run() {
  await app.whenReady()
  const { BrowserSystem } = await tsImport('../apps/desktop/browser/browserSystem.ts', import.meta.url)
  const coreExtensionsUrl = pathToFileURL(desktopRequire.resolve('@turboflux/agent-core/extensions')).href
  const { McpClient } = await import(coreExtensionsUrl)
  const address = await listen()
  if (!address || typeof address === 'string') throw new Error('Browser smoke server did not expose a TCP address')

  const window = new BrowserWindow({ show: true, width: 900, height: 700 })
  const workspace = mkdtempSync(resolve(tmpdir(), 'turboflux-browser-smoke-'))
  const browserEvents = []
  const browser = new BrowserSystem(window, workspace, event => browserEvents.push(event))
  const mcp = new McpClient()
  browser.register(mcp)

  try {
    browser.setBounds({ x: 0, y: 0, width: 820, height: 620 })
    await browser.show()
    await browser.navigate(`http://127.0.0.1:${address.port}`)
    await browser.waitFor('load', undefined, undefined, 5_000)

    let observation = await browser.observe()
    const ref = name => {
      const match = observation.elements.find(element => element.name === name)
      if (!match) throw new Error(`Browser smoke could not find ${name}`)
      return match.ref
    }

    await browser.type(ref('测试输入'), 'TurboFlux', true)
    await browser.waitFor('text', 'submitted:TurboFlux', undefined, 2_000)
    await browser.selectOption(ref('主题'), ['dark'])
    await browser.waitFor('text', 'selected:dark', undefined, 2_000)
    await browser.setChecked(ref('接受测试'), true)
    await browser.waitFor('text', 'checked:true', undefined, 2_000)
    await browser.hover(ref('悬停目标'))
    await browser.waitFor('text', 'hovered', undefined, 2_000)
    await browser.click(ref('执行操作'))
    await browser.waitFor('text', 'clicked', undefined, 2_000)
    await browser.press('ArrowRight', ref('悬停目标'))
    await browser.waitFor('text', 'key:', undefined, 2_000)
    if (!(await browser.observe()).text.includes('key:ArrowRight')) throw new Error('Browser smoke keyboard key identity was incorrect')

    writeFileSync(resolve(workspace, 'upload.txt'), 'upload smoke')
    observation = await browser.observe()
    await browser.uploadFile(ref('上传文件'), 'upload.txt')
    await browser.waitFor('text', 'uploaded:upload.txt', undefined, 2_000)
    await browser.click(ref('下载测试文件'))
    const downloadDeadline = Date.now() + 3_000
    while (Date.now() < downloadDeadline && !browser.getSnapshot().downloads.some(download => download.status === 'completed')) {
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    const download = browser.getSnapshot().downloads.find(item => item.status === 'completed')
    if (!download?.path || !existsSync(download.path)) throw new Error('Browser smoke download was not persisted')
    if (!browserEvents.some(event => event.type === 'artifact-ready' && event.kind === 'download')) throw new Error('Browser smoke download artifact event was not emitted')
    await expectRejected(() => browser.navigate('file:///tmp/blocked.html'), 'blocked navigation')
    if (browser.getSnapshot().lastError?.code !== 'navigation-blocked') throw new Error('Browser smoke blocked navigation state was not recorded')

    observation = await browser.observe()
    const canvas = observation.elements.find(element => element.name === '游戏画布')
    if (!canvas?.bounds) throw new Error('Browser smoke canvas bounds are unavailable')
    await browser.clickAt(canvas.bounds.x + 20, canvas.bounds.y + 20)
    await browser.waitFor('text', 'canvas-clicked', undefined, 2_000)
    await browser.drag(canvas.bounds.x + 20, canvas.bounds.y + 20, canvas.bounds.x + 100, canvas.bounds.y + 60)
    await browser.waitFor('text', 'canvas-dragged', undefined, 2_000)

    await browser.click(ref('生成错误'))
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
    const diagnostics = browser.diagnostics()
    const assertion = await browser.assertPage('text_contains', 'canvas-dragged')
    if (!assertion.passed) throw new Error('Browser smoke assertion failed')
    if (!diagnostics.console.some(entry => entry.message.includes('intentional browser smoke error'))) throw new Error('Browser smoke console diagnostics failed')
    if (!diagnostics.network.some(entry => entry.status === 404)) throw new Error('Browser smoke network diagnostics failed')
    const builtInPluginCall = await mcp.callTool('browser', 'tabs', {})
    if (builtInPluginCall.isError) throw new Error('Browser smoke built-in plugin was unavailable')
    const pluginDiagnostics = await mcp.callTool('browser', 'diagnostics', {})
    if (pluginDiagnostics.isError || !pluginDiagnostics.content.includes('intentional browser smoke error')) throw new Error('Browser smoke MCP bridge failed')
    const visualObservation = await mcp.callTool('browser', 'visual_observe', {})
    const visualAttachment = visualObservation.attachments?.[0]
    if (visualObservation.isError || !visualAttachment) throw new Error('Browser smoke visual observation did not return an attachment')
    if (visualAttachment.mime !== 'image/png') throw new Error(`Browser smoke visual observation returned ${visualAttachment.mime}`)
    if (!existsSync(visualAttachment.path) || statSync(visualAttachment.path).size <= 0) throw new Error('Browser smoke visual capture was not written')
    const visualMetadata = JSON.parse(visualObservation.content)
    if (!visualMetadata.viewport?.width || !visualMetadata.viewport?.height) throw new Error('Browser smoke visual viewport metadata is missing')

    console.log(JSON.stringify({
      status: 'passed',
      observedElements: observation.elements.length,
      consoleEntries: diagnostics.counts.console,
      networkIssues: diagnostics.counts.network,
      visualBytes: visualAttachment.size,
    }))
  } finally {
    browser.destroy()
    window.destroy()
    await closeServer()
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function expectRejected(work, label) {
  try {
    await work()
  } catch {
    return
  }
  throw new Error(`Browser smoke expected ${label} to fail`)
}

run().then(
  () => app.exit(0),
  error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    app.exit(1)
  },
)
