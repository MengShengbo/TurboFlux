import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocket } from 'ws'
import { repositoryRoot } from './workspace-packages.mjs'

const output = resolve(process.env.TURBOFLUX_RENDERER_QA_DIR || join(repositoryRoot, 'apps/desktop/generated/renderer-qa'))
const profile = join(output, `profile-${Date.now()}`)
const workspace = join(profile, 'workspace')
await mkdir(workspace, { recursive: true })
const require = createRequire(join(repositoryRoot, 'package.json'))
const packagedExecutable = process.env.TURBOFLUX_DESKTOP_QA_EXECUTABLE
const logs = [], errors = []
let child, connection, sequence = 0, streamedRequests = 0
const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  const input = body ? JSON.parse(body) : {}
  if (request.url.endsWith('/models')) { response.end(JSON.stringify({ data: [{ id: 'renderer-qa-model', object: 'model' }] })); return }
  if (!input.stream) { response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '渲染引擎验证' } }] })); return }
  streamedRequests++
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = delta => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  const mode = input.tool_choice?.function?.name === 'set_response_mode'
  if (mode) send({ tool_calls: [{ index: 0, id: 'qa-mode', type: 'function', function: { name: 'set_response_mode', arguments: '{"mode":"chat"}' } }] })
  else {
    for (const text of ['验证完成：', ...Array.from({ length: 40 }, (_, i) => ` ${i + 1}`), '。']) {
      send({ content: text }); await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
  }
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: mode ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`)
  response.end('data: [DONE]\n\n')
})
await new Promise(resolveListen => provider.listen(0, '127.0.0.1', resolveListen))
const ports = createPortServer(); await new Promise(resolveListen => ports.listen(0, '127.0.0.1', resolveListen))
const port = ports.address().port; await new Promise(resolveClose => ports.close(resolveClose))
const entry = join(output, 'launch.mjs')
await writeFile(entry, `import { dialog } from 'electron'\ndialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(workspace)}] })\nvoid import(${JSON.stringify(join(repositoryRoot, 'apps/desktop/generated/main.mjs'))})\n`)

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
  const target = targets.find(item => item.type === 'page' && item.url.includes('index.html'))
  if (!target) return false
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject) })
  const pending = new Map()
  socket.on('message', raw => {
    const message = JSON.parse(raw)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    const item = pending.get(message.id)
    if (item) {
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error.message))
      else item.resolve(message.result)
    }
  })
  connection = {
    socket,
    send(method, params = {}) {
      return new Promise((resolveResult, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15_000)
        pending.set(id, { resolve: resolveResult, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
  await connection.send('Runtime.enable')
  return true
}
async function evaluate(expression) {
  const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function until(operation, label, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await operation()) return } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  child = spawn(packagedExecutable || require('electron'), ['--use-mock-keychain', `--remote-debugging-port=${port}`, `--user-data-dir=${join(profile, 'electron')}`, ...(packagedExecutable ? [] : [entry])], {
    cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TURBOFLUX_CONFIG_DIR: join(profile, 'config'), TURBOFLUX_CONVERSATIONS_DIR: join(profile, 'conversations'), TURBOFLUX_DESKTOP_QA_HIDDEN: '1', TURBOFLUX_DESKTOP_URL: '' },
  })
  child.stdout.on('data', data => logs.push(String(data))); child.stderr.on('data', data => logs.push(String(data)))
  await until(connect, 'desktop window')
  await until(() => evaluate(`window.turbofluxDesktop.getSnapshot().then(s => !!s.conversation.id)`), 'runtime ready')
  if (packagedExecutable) {
    const report = await evaluate(`Promise.all([window.turbofluxDesktop.getSnapshot(), window.turbofluxDesktop.getSettings()]).then(([snapshot, settings]) => ({ conversationId: snapshot.conversation.id, status: snapshot.runtime.status, hasSettings: !!settings.profile, bridge: typeof window.turbofluxDesktop.onRuntimeEvent }))`)
    assert.equal(report.status, 'ready'); assert.equal(report.hasSettings, true)
    assert.deepEqual(errors, [])
    await writeFile(join(output, 'packaged-result.json'), JSON.stringify({ ok: true, executable: packagedExecutable, ...report, errors }, null, 2))
    console.log(JSON.stringify({ ok: true, packaged: true, ...report, errors }))
  } else {
  await evaluate(`window.turbofluxDesktop.chooseWorkspace()`)
  await evaluate(`(async () => {
    const bridge = window.turbofluxDesktop, settings = await bridge.getSettings()
    await bridge.saveSettings({ approvalPolicy: 'full', capabilityProfile: 'workspace-write', gitEnabled: false, mcpServers: [], profile: settings.profile, activeApiConfigId: 'renderer-qa', apiProfiles: [{ id: 'renderer-qa', name: 'Renderer QA', provider: 'custom', baseUrl: 'http://127.0.0.1:${provider.address().port}/v1', model: 'renderer-qa-model', apiKey: 'local-test-only', contextWindow: 128000, maxTokens: 1024 }] })
    window.qaEvents = 0
    window.qaUnsubscribe = bridge.onRuntimeEvent(() => window.qaEvents++)
    const input = document.querySelector('#task-input'); input.value = '验证流式渲染'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#run-button').click()
  })()`)
  await until(() => evaluate(`document.querySelector('.message-row.assistant.streaming .message-content')?.textContent.includes('验证完成')`), 'streaming answer')
  await evaluate(`window.qaAnswer = document.querySelector('.message-row.assistant.streaming')`)
  await until(() => evaluate(`window.turbofluxDesktop.getSnapshot().then(s => s.runtime.status === 'ready' && s.conversation.turns.some(t => t.role === 'assistant' && t.content.includes('40')))`), 'completed run')
  await until(() => evaluate(`document.querySelector('#transcript')?.textContent.includes('40')`), 'final paint')
  assert.equal(await evaluate(`window.qaAnswer === document.querySelector('.message-row.assistant')`), true)
  const conversationId = await evaluate(`window.turbofluxDesktop.getSnapshot().then(s => s.conversation.id)`)
  await evaluate(`window.qaUnsubscribe(); window.qaUnsubscribe(); window.qaEventCount = window.qaEvents; window.turbofluxDesktop.newConversation()`)
  await until(() => evaluate(`!document.querySelector('#transcript').textContent.includes('验证完成')`), 'empty conversation')
  assert.equal(await evaluate('window.qaEvents === window.qaEventCount'), true)
  await evaluate(`window.turbofluxDesktop.switchConversation(${JSON.stringify(conversationId)})`)
  await until(() => evaluate(`document.querySelector('#transcript').textContent.includes('40')`), 'history replay')
  const screenshot = await connection.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'desktop.png'), Buffer.from(screenshot.data, 'base64'))
  await evaluate(`window.dispatchEvent(new Event('pagehide')); window.qaHtml = document.querySelector('#app').innerHTML; window.turbofluxDesktop.newConversation()`)
  await new Promise(resolveWait => setTimeout(resolveWait, 180))
  assert.equal(await evaluate(`document.querySelector('#app').innerHTML === window.qaHtml`), true)
  assert.deepEqual(errors, [])
  const report = { ok: true, streamedRequests, checks: ['startup', 'workspace binding', 'model configuration', 'streaming node identity', 'completion', 'new conversation', 'history replay', 'IPC unsubscribe', 'unmount ignores later events'], errors }
  await writeFile(join(output, 'desktop-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
  }
} finally {
  connection?.socket.close()
  if (child && child.exitCode === null) {
    const done = new Promise(resolveExit => child.once('exit', resolveExit)); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000); await done; clearTimeout(timer)
  }
  provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose))
  await writeFile(join(output, 'desktop.log'), logs.join(''))
}
