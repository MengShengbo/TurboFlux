import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild')
const workspace = mkdtempSync(join(tmpdir(), 'turboflux-browser-smoke-'))
const output = resolve(process.env.TURBOFLUX_BROWSER_QA_OUTPUT || join(repositoryRoot, 'apps/desktop/generated/browser-qa'))
mkdirSync(output, { recursive: true })
app.setPath('userData', join(workspace, 'profile'))
const checks = []
const sockets = new Set()
let framePort = 0

const framePage = `<!doctype html><html><body style="font:15px system-ui;background:#eef6fb;padding:12px"><label for="frame-input">Frame field</label><input id="frame-input"><button id="frame-action" onclick="document.querySelector('#frame-result').textContent='Frame clicked'">Frame action</button><p id="frame-result">Frame ready</p></body></html>`
const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>TurboFlux Browser Reliability</title><style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui;margin:0;padding:28px;background:#f3f6fb;color:#132238}h1{font-size:27px;letter-spacing:-.7px;margin:8px 0}header p{color:#526780}main{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:24px}.card{min-width:0;background:white;border:1px solid #dce4ef;border-radius:14px;padding:20px}.card h2{font-size:16px;margin-top:0}label{display:block;margin:8px 0}input:not([type=checkbox]):not([type=radio]),select{padding:8px;border:1px solid #a9bbd1;border-radius:5px;max-width:100%}button{padding:9px 13px;border:0;border-radius:6px;background:#165be8;color:white;margin:4px 6px 4px 0;cursor:pointer}button:disabled{background:#8d9aaa}#result{padding:12px;background:#edf5ff;border-radius:6px;overflow-wrap:anywhere}iframe{border:0;width:100%;height:145px}canvas{background:#dfedff;border-radius:8px;width:240px;height:80px}#shadow-host{display:block;margin:8px 0}#overlay{position:fixed;inset:0;background:#172d50aa;z-index:9999;display:grid;place-items:center;color:white;font-size:24px}#overlay[hidden]{display:none}small{color:#596f88}@media(max-width:650px){body{padding:16px}main{grid-template-columns:1fr}}
</style></head><body>
<header><small>TURBOFLUX · REAL BROWSER VERIFICATION</small><h1>Observe. Act. Verify.</h1><p>Live native input, durable element references, cancellation and recovery.</p></header>
<main><section class="card"><h2>Forms and native input</h2>
<form id="search-form"><label for="search">Search field</label><input id="search" name="search"><button type="submit">Submit form</button></form>
<label for="theme">Theme</label><select id="theme"><option value="light">Light</option><option value="dark">Dark</option><optgroup label="Locked" disabled><option value="locked">Locked</option></optgroup></select>
<label><input type="checkbox" id="check">Accept test</label><label for="upload">Upload file</label><input id="upload" type="file"><a href="/download">Download file</a>
<label for="readonly">Readonly field</label><input id="readonly" readonly value="fixed"><label for="password">Password field</label><input id="password" type="password" value="fixture-secret">
<fieldset disabled><label for="disabled">Disabled field</label><input id="disabled" value="fixed"></fieldset></section>
<section class="card"><h2>Actions and dynamic controls</h2><button id="action">Execute action</button><button id="replacement">Replaceable action</button><button id="error">Generate error</button><button id="delayed" disabled>Delayed action</button><div id="hover" role="button" tabindex="0">Hover target</div><canvas aria-label="Canvas" role="application" width="240" height="80"></canvas><p id="result">Ready</p><div id="shadow-host"></div><h2>Cross-origin frame</h2><iframe src="http://127.0.0.1:${framePort}/frame" title="Test frame"></iframe></section></main><div id="overlay" hidden>Interaction covered by overlay</div>
<script>
 const result=document.querySelector('#result');window.clicks=0;window.doubles=0;window.checkChanges=0;window.keys=0;window.submits=0;
 document.querySelector('#search-form').onsubmit=event=>{event.preventDefault();window.submits++;result.textContent='Submitted:'+document.querySelector('#search').value};
 document.querySelector('#action').onclick=()=>{window.clicks++;result.textContent='Clicked:'+window.clicks};document.querySelector('#action').ondblclick=()=>{window.doubles++};
 document.querySelector('#replacement').onclick=()=>{result.textContent='Replacement clicked'};
 document.querySelector('#theme').onchange=event=>{result.textContent='Selected:'+event.target.value};
 document.querySelector('#check').onchange=event=>{window.checkChanges++;result.textContent='Checked:'+event.target.checked};
 document.querySelector('#upload').onchange=event=>{result.textContent='Uploaded:'+event.target.files[0].name};
 document.querySelector('#hover').onmouseenter=()=>{result.textContent='Hovered'};
 document.addEventListener('keydown',event=>{window.keys++;window.lastKey=event.key});
 document.querySelector('#error').onclick=()=>{console.error('intentional browser smoke error');fetch('/missing?secret=fixture').catch(()=>{})};
 const shadow=document.querySelector('#shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<label for="shadow-input">Shadow field</label><input id="shadow-input"><button id="shadow-button">Shadow action</button><span id="shadow-result">Shadow ready</span>';
 shadow.querySelector('button').onclick=()=>{shadow.querySelector('#shadow-result').textContent='Shadow clicked'};
 let start=null;let dragged=false;const canvas=document.querySelector('canvas');canvas.onmousedown=event=>{start=event.clientX;dragged=false};canvas.onmouseup=event=>{if(start!==null&&Math.abs(event.clientX-start)>20){dragged=true;result.textContent='Canvas dragged'};start=null};canvas.onclick=()=>{if(!dragged)result.textContent='Canvas clicked';dragged=false};
</script></body></html>`

function handler(request, response) {
  if (request.url === '/never') return
  if (request.url.startsWith('/missing')) { response.writeHead(404); response.end('missing'); return }
  if (request.url === '/download') { response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="smoke.txt"' }); response.end('downloaded'); return }
  if (request.url === '/redirect-file') { response.writeHead(302, { location: 'file:///tmp/not-readable.html' }); response.end(); return }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (request.url === '/frame') response.end(framePage)
  else if (request.url === '/slow') response.end('<!doctype html><title>Slow resource</title><p>DOM ready with hanging resource</p><img src="/never">')
  else response.end(page())
}
const server = createServer(handler), frameServer = createServer(handler)
for (const target of [server, frameServer]) target.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
const listen = target => new Promise((resolveListen, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', () => resolveListen(target.address().port)) })
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
async function check(name, work) {
  const started = Date.now()
  try { await work(); checks.push({ name, status: 'passed', durationMs: Date.now() - started }); console.log('PASS', name) }
  catch (error) { checks.push({ name, status: 'failed', message: error.message }); throw error }
}

async function run() {
  await app.whenReady()
  const bundle = join(workspace, 'browser-system.mjs')
  await build({ entryPoints: [join(repositoryRoot, 'apps/desktop/browser/browserSystem.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { BrowserSystem } = await import(pathToFileURL(bundle).href)
  const { McpClient } = await import('@turboflux/extensions')
  framePort = await listen(frameServer)
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const window = new BrowserWindow({ show: true, width: 1150, height: 950, title: 'TurboFlux browser reliability checks', webPreferences: { sandbox: true, contextIsolation: true } })
  const events = [], browser = new BrowserSystem(window, workspace, event => events.push(event), `smoke-${Date.now()}`)
  const mcp = new McpClient()
  browser.register(mcp)
  const tool = async (name, args = {}, options) => {
    const result = await mcp.callTool('browser', name, args, options)
    assert.equal(result.isError, false, `${name}: ${result.content}`)
    return JSON.parse(result.content)
  }
  const view = () => window.contentView.children.find(child => child.webContents && !child.webContents.isDestroyed())
  const evaluate = code => view().webContents.executeJavaScript(code, true)
  const fresh = async (name, role) => {
    const result = await tool('find', { query: name, ...(role ? { role } : {}) })
    const matches = result.matches.filter(element => element.name === name)
    assert.equal(matches.length, 1, `Expected one ${name}, got ${JSON.stringify(result.matches)}`)
    return matches[0].ref
  }
  const assertText = value => tool('assert', { condition: 'text_contains', value, timeout_ms: 2000 })
  let complete = false
  try {
    browser.setBounds({ x: 0, y: 0, width: 1130, height: 900 })
    await browser.show()
    await tool('navigate', { url: base })
    await tool('wait', { condition: 'text', value: 'Frame ready', timeout_ms: 5000 })
    await check('capabilities-and-observation', async () => {
      assert.equal((await tool('capabilities')).reliability.automaticActionReplay, false)
      const observation = await tool('observe')
      assert(observation.frames.length >= 2)
      assert(observation.elements.some(element => element.name === 'Search field' && element.role === 'textbox'))
      assert(observation.elements.some(element => element.name === 'Shadow action'))
      assert(!observation.elements.find(element => element.name === 'Password field').value)
    })
    await check('type-and-native-enter-submit', async () => {
      await tool('type', { ref: await fresh('Search field'), text: 'TurboFlux' })
      await tool('assert', { condition: 'value_equals', ref: await fresh('Search field'), value: 'TurboFlux' })
      await tool('press', { ref: await fresh('Search field'), key: 'Enter' })
      await assertText('Submitted:TurboFlux')
      assert.equal(await evaluate('window.submits'), 1)
    })
    await check('select-validates-before-mutation', async () => {
      await tool('select_option', { ref: await fresh('Theme'), values: ['dark'] })
      await assertText('Selected:dark')
      for (const values of [['missing'], ['light', 'dark'], ['locked']]) {
        const result = await mcp.callTool('browser', 'select_option', { ref: await fresh('Theme'), values })
        assert.equal(result.isError, true)
        assert.equal(await evaluate('document.querySelector("#theme").value'), 'dark')
      }
    })
    await check('checkbox-click-semantics-and-idempotence', async () => {
      await tool('set_checked', { ref: await fresh('Accept test'), checked: true })
      await tool('set_checked', { ref: await fresh('Accept test'), checked: true })
      assert.equal(await evaluate('window.checkChanges'), 1)
      await tool('set_checked', { ref: await fresh('Accept test'), checked: false })
      await tool('assert', { condition: 'element_checked', ref: await fresh('Accept test'), expected: false })
      assert.equal(await evaluate('window.checkChanges'), 2)
    })
    await check('readonly-disabled-and-password-are-protected', async () => {
      for (const name of ['Readonly field', 'Disabled field', 'Password field']) {
        const result = await mcp.callTool('browser', 'type', { ref: await fresh(name), text: 'overwritten' })
        assert.equal(result.isError, true, name)
        assert.equal(JSON.parse(result.content).error.retrySafe, false)
      }
      assert.deepEqual(await evaluate('[document.querySelector("#readonly").value, document.querySelector("#disabled").value, document.querySelector("#password").value]'), ['fixed', 'fixed', 'fixture-secret'])
    })
    await check('native-single-and-double-click-exact-count', async () => {
      await tool('click', { ref: await fresh('Execute action') })
      await assertText('Clicked:1')
      await tool('click', { ref: await fresh('Execute action'), click_count: 2 })
      await assertText('Clicked:3')
      assert.equal(await evaluate('window.doubles'), 1)
    })
    await check('obscured-target-does-not-click-or-fallback', async () => {
      const ref = await fresh('Execute action')
      await evaluate('document.querySelector("#overlay").hidden=false')
      const inspection = await tool('inspect', { ref })
      assert.equal(inspection.element.receivesEvents, false)
      const result = await mcp.callTool('browser', 'click', { ref })
      assert.equal(result.isError, true)
      assert.equal(JSON.parse(result.content).error.code, 'not-actionable')
      assert.equal(await evaluate('window.clicks'), 3)
      await evaluate('document.querySelector("#overlay").hidden=true')
    })
    await check('transient-overlay-waits-before-one-click', async () => {
      const ref = await fresh('Execute action')
      await evaluate('document.querySelector("#overlay").hidden=false;setTimeout(()=>document.querySelector("#overlay").hidden=true,220)')
      await tool('click', { ref })
      assert.equal(await evaluate('window.clicks'), 4)
    })
    await check('hover-created-overlay-is-checked-before-mousedown', async () => {
      await tool('hover', { ref: await fresh('Hover target') })
      const ref = await fresh('Execute action')
      await evaluate('document.querySelector("#action").onmouseenter=()=>document.querySelector("#overlay").hidden=false;void 0')
      const result = await mcp.callTool('browser', 'click', { ref })
      assert.equal(result.isError, true)
      assert.equal(await evaluate('window.clicks'), 4)
      await evaluate('document.querySelector("#action").onmouseenter=null;document.querySelector("#overlay").hidden=true')
    })
    await check('lost-click-acknowledgement-never-replays-action', async () => {
      const ref = await fresh('Execute action')
      const api = view().webContents.debugger
      const originalSend = api.sendCommand
      api.sendCommand = async function(method, params) {
        const result = await originalSend.call(api, method, params)
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') throw new Error('Simulated lost click acknowledgement')
        return result
      }
      try {
        const result = await mcp.callTool('browser', 'click', { ref })
        assert.equal(result.isError, true)
        assert.equal(JSON.parse(result.content).error.retrySafe, false)
      } finally { api.sendCommand = originalSend }
      assert.equal(await evaluate('window.clicks'), 5)
    })
    await check('replaced-dom-node-cannot-inherit-an-old-ref', async () => {
      const ref = await fresh('Replaceable action')
      await evaluate('const old=document.querySelector("#replacement");old.replaceWith(old.cloneNode(true))')
      const result = await mcp.callTool('browser', 'click', { ref })
      assert.equal(result.isError, true)
      assert.equal(JSON.parse(result.content).error.code, 'stale-reference')
    })
    await check('open-shadow-dom-actions-and-visible-text', async () => {
      await tool('type', { ref: await fresh('Shadow field'), text: 'Shadow input' })
      await tool('assert', { ref: await fresh('Shadow field'), condition: 'value_equals', value: 'Shadow input' })
      await tool('click', { ref: await fresh('Shadow action') })
      await assertText('Shadow clicked')
    })
    await check('cross-origin-frame-observe-type-click', async () => {
      await tool('type', { ref: await fresh('Frame field'), text: 'Frame input' })
      await tool('assert', { ref: await fresh('Frame field'), condition: 'value_equals', value: 'Frame input' })
      const clicked = await tool('click', { ref: await fresh('Frame action') })
      assert.equal(clicked.mode, 'dom-frame')
      await assertText('Frame clicked')
    })
    await check('native-hover-and-key-identity', async () => {
      await tool('hover', { ref: await fresh('Hover target') })
      await assertText('Hovered')
      const before = await evaluate('window.keys')
      await tool('press', { ref: await fresh('Hover target'), key: 'ArrowRight' })
      assert.equal(await evaluate('window.lastKey'), 'ArrowRight')
      assert.equal(await evaluate('window.keys'), before + 1)
    })
    await check('workspace-upload-and-download', async () => {
      writeFileSync(join(workspace, 'upload.txt'), 'browser smoke')
      await tool('upload_file', { ref: await fresh('Upload file'), path: 'upload.txt' })
      await assertText('Uploaded:upload.txt')
      const escaped = await mcp.callTool('browser', 'upload_file', { ref: await fresh('Upload file'), path: '/etc/hosts' })
      assert.equal(escaped.isError, true)
      await tool('click', { ref: await fresh('Download file') })
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && !browser.getSnapshot().downloads.some(download => download.status === 'completed')) await delay(40)
      const download = browser.getSnapshot().downloads.find(item => item.status === 'completed')
      assert(download?.path && existsSync(download.path))
      assert(events.some(event => event.type === 'artifact-ready' && event.kind === 'download'))
    })
    await check('canvas-coordinate-click-and-drag', async () => {
      const observation = await tool('find', { query: 'Canvas' })
      const box = observation.matches.find(element => element.name === 'Canvas').bounds
      await tool('click_at', { x: box.x + 20, y: box.y + 20 })
      await assertText('Canvas clicked')
      await tool('drag', { from_x: box.x + 20, from_y: box.y + 20, to_x: box.x + 100, to_y: box.y + 50 })
      await assertText('Canvas dragged')
    })
    await check('assertions-retry-and-report-failure-to-agent', async () => {
      await evaluate('setTimeout(()=>document.querySelector("#result").textContent="Async complete",160)')
      await assertText('Async complete')
      const result = await mcp.callTool('browser', 'assert', { condition: 'text_contains', value: 'Never appears', timeout_ms: 120 })
      assert.equal(result.isError, true)
      assert.equal(JSON.parse(result.content).passed, false)
    })
    await check('diagnostics-include-console-and-redacted-network', async () => {
      await tool('click', { ref: await fresh('Generate error') })
      await delay(200)
      const diagnostics = await tool('diagnostics')
      assert(diagnostics.console.some(entry => entry.message.includes('intentional browser smoke error')))
      assert(diagnostics.network.some(entry => entry.status === 404))
      assert(diagnostics.network.every(entry => !entry.url.includes('secret=')))
    })
    await check('inspect-and-real-viewport-capture', async () => {
      const inspection = await tool('inspect', { ref: await fresh('Execute action') })
      assert(inspection.element.styles['background-color'])
      assert.equal(inspection.page.horizontalOverflow, false)
      const result = await mcp.callTool('browser', 'visual_observe', {})
      assert.equal(result.isError, false, result.content)
      const image = result.attachments[0]
      assert.equal(image.mime, 'image/png')
      assert(statSync(image.path).size > 1000)
      copyFileSync(image.path, join(output, 'browser-desktop.png'))
      browser.setBounds({ x: 0, y: 0, width: 520, height: 800 })
      await delay(100)
      assert.equal((await tool('inspect')).page.horizontalOverflow, false)
      const narrow = await mcp.callTool('browser', 'visual_observe', {})
      assert.equal(narrow.isError, false, narrow.content)
      copyFileSync(narrow.attachments[0].path, join(output, 'browser-narrow.png'))
      browser.setBounds({ x: 0, y: 0, width: 1130, height: 900 })
    })
    await check('cancellation-drains-tool-queue', async () => {
      const controller = new AbortController()
      const pending = mcp.callTool('browser', 'wait', { condition: 'text', value: 'Never appears', timeout_ms: 15000 }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 120)
      const started = Date.now()
      const next = tool('tabs')
      assert.equal((await pending).isError, true)
      await next
      assert(Date.now() - started < 2000)
    })
    await check('refs-cannot-target-another-tab', async () => {
      const original = browser.getSnapshot().activeTabId
      const ref = await fresh('Execute action')
      const opened = await tool('open', { url: base })
      const other = opened.tab.id
      await tool('wait', { condition: 'text', value: 'Frame ready' })
      await fresh('Execute action')
      const result = await mcp.callTool('browser', 'click', { tab_id: other, ref })
      assert.equal(result.isError, true)
      assert.equal(await evaluate('window.clicks'), 0)
      await tool('close', { tab_id: other })
      await tool('activate', { tab_id: original })
    })
    await check('navigation-and-load-ignore-hanging-subresources', async () => {
      const started = Date.now()
      await tool('navigate', { url: `${base}/slow` })
      await tool('wait', { condition: 'load', timeout_ms: 1000 })
      await assertText('DOM ready with hanging resource')
      assert(Date.now() - started < 3000)
      await tool('navigate', { url: base })
      await tool('wait', { condition: 'text', value: 'Frame ready' })
    })
    await check('navigation-cancellation-releases-next-operation', async () => {
      const controller = new AbortController()
      const pending = mcp.callTool('browser', 'navigate', { url: `${base}/never` }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 150)
      assert.equal((await pending).isError, true)
      await tool('navigate', { url: base })
      await tool('wait', { condition: 'text', value: 'Frame ready' })
    })
    await check('cancelled-open-cleans-up-its-new-tab', async () => {
      const original = browser.getSnapshot().activeTabId
      await tool('open', { url: base })
      await tool('wait', { condition: 'text', value: 'Frame ready' })
      const before = browser.getSnapshot()
      const controller = new AbortController()
      const pending = mcp.callTool('browser', 'open', { url: `${base}/never` }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 120)
      assert.equal((await pending).isError, true)
      const after = await tool('tabs')
      assert.equal(after.tabCount, before.tabs.length)
      assert.equal(after.activeTabId, before.activeTabId)
      await tool('close', { tab_id: before.activeTabId })
      await tool('activate', { tab_id: original })
    })
    await check('blocked-navigation-and-popup-stay-contained', async () => {
      assert.equal((await mcp.callTool('browser', 'navigate', { url: 'file:///tmp/blocked' })).isError, true)
      const count = browser.getSnapshot().tabs.length
      await evaluate('window.open("file:///tmp/blocked")')
      assert.equal(browser.getSnapshot().tabs.length, count)
      assert(events.some(event => event.type === 'blocked-navigation'))
    })
    await check('history-and-reload-return-ready-documents', async () => {
      await tool('navigate', { url: `${base}/?second=1` })
      await tool('back')
      assert.equal(browser.getSnapshot().tabs.find(tab => tab.id === browser.getSnapshot().activeTabId).url, `${base}/`)
      await tool('forward')
      assert(browser.getSnapshot().tabs.find(tab => tab.id === browser.getSnapshot().activeTabId).url.includes('second=1'))
      await tool('reload')
      await assertText('Observe. Act. Verify.')
    })
    await check('renderer-crash-invalidates-refs-and-recovers', async () => {
      const oldRef = await fresh('Execute action')
      const oldContents = view().webContents
      const oldId = oldContents.id
      const oldTabId = browser.getSnapshot().activeTabId
      const history = oldContents.navigationHistory.getAllEntries().map(entry => entry.url)
      await evaluate('localStorage.setItem("recovery-check","retained")')
      oldContents.forcefullyCrashRenderer()
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !browser.getSnapshot().tabs.some(tab => tab.crashed)) await delay(30)
      assert(browser.getSnapshot().tabs.some(tab => tab.crashed))
      assert.equal((await mcp.callTool('browser', 'click', { ref: oldRef })).isError, true)
      await tool('reload')
      await tool('wait', { condition: 'text', value: 'Frame ready' })
      assert(browser.getSnapshot().tabs.every(tab => !tab.crashed))
      assert.equal(browser.getSnapshot().activeTabId, oldTabId)
      assert.notEqual(view().webContents.id, oldId)
      assert.deepEqual(view().webContents.navigationHistory.getAllEntries().map(entry => entry.url), history)
      assert.equal(await evaluate('localStorage.getItem("recovery-check")'), 'retained')
      await tool('click', { ref: await fresh('Execute action') })
      await assertText('Clicked:1')
    })
    await check('task-cleanup-retains-only-deliverables', async () => {
      await tool('mark_deliverable')
      const keep = browser.getSnapshot().activeTabId
      await tool('open', { url: `${base}/slow` })
      await browser.finishTask()
      assert.deepEqual(browser.getSnapshot().tabs.map(tab => tab.id), [keep])
    })
    complete = true
    rmSync(join(output, 'failure.json'), { force: true })
  } catch (error) {
    try {
      const diagnostic = await evaluate(`({url:location.href, title:document.title, readyState:document.readyState, width:innerWidth,height:innerHeight,button:document.querySelector('#action')?.outerHTML, body:document.body?.innerText.slice(0,2000)})`)
      writeFileSync(join(output, 'failure.json'), JSON.stringify({ message: error.message, page: diagnostic, observation: await browser.observe(), snapshot: browser.getSnapshot() }, null, 2))
      console.error('FAILURE PAGE', JSON.stringify(diagnostic))
      const main = view().webContents.mainFrame
      console.error('FAILURE FRAMES', JSON.stringify([main, ...main.framesInSubtree].map(frame => ({ nodeId: frame.frameTreeNodeId, process: frame.processId, routing: frame.routingId, destroyed: frame.isDestroyed(), detached: frame.detached, url: frame.url, main: frame === main }))))
      console.error('MAIN EVALUATION', await main.executeJavaScript('document.title'))
    } catch {}
    throw error
  } finally {
    writeFileSync(join(output, 'report.json'), JSON.stringify({ status: complete && !checks.some(item => item.status === 'failed') ? 'passed' : 'failed', platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome, checks }, null, 2))
    browser.destroy()
    window.destroy()
    for (const socket of sockets) socket.destroy()
    await Promise.all([server, frameServer].map(target => new Promise(resolveClose => target.close(resolveClose))))
    rmSync(workspace, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
}
run().then(() => app.exit(0), error => { console.error(error.stack || String(error)); app.exit(1) })
