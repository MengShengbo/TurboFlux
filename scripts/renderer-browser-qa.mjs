import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.TURBOFLUX_RENDERER_QA_DIR
if (!directory) throw new Error('TURBOFLUX_RENDERER_QA_DIR is required')
app.setPath('userData', join(directory, 'electron'))
app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { sandbox: true, backgroundThrottling: false } })
window.webContents.on('console-message', event => console.log(event.message))
try {
  await window.loadFile(join(directory, 'index.html'))
  window.showInactive()
  const result = await Promise.race([window.webContents.executeJavaScript('window.qaResult'), new Promise((_, reject) => setTimeout(() => reject(new Error('Renderer QA timed out')), 15_000))])
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2))
  const screenshot = await window.webContents.capturePage()
  writeFileSync(join(directory, 'renderer.png'), screenshot.toPNG())
  console.log(JSON.stringify(result))
  app.exit(0)
} catch (error) {
  console.error(error)
  app.exit(1)
}

}).catch(error => { console.error(error); app.exit(1) })
