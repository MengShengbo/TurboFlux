import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function digest(path) {
  if (!(await stat(path)).isFile()) throw new Error('Installed payload is not a regular file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function runInstaller(executable, args) {
  const result = spawnSync(executable, args, {
    windowsHide: true,
    // NSIS requires /D= and _?= to be unquoted and last, even with spaces.
    windowsVerbatimArguments: true,
    stdio: 'ignore',
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`NSIS process failed (${result.status})`)
}

if (process.platform !== 'win32') throw new Error('Windows installer verification requires Windows')
const { version } = JSON.parse(await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'))
const installer = join(root, 'release', `TurboFlux-${version}-win-${process.arch}.exe`)
if (!(await stat(installer)).isFile()) throw new Error('Windows installer is missing')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'orbit-install-'))
const installation = join(temporaryRoot, 'Desktop with spaces')
const uninstaller = join(installation, 'Uninstall TurboFlux.exe')
let verified = false
try {
  runInstaller(installer, ['/S', `/D=${installation}`])
  for (const path of ['TurboFlux.exe', 'resources/app.asar', 'resources/renderer/index.html', 'resources/remote-mobile/index.html']) {
    if (await digest(join(installation, path)) !== await digest(join(root, 'release', 'win-unpacked', path))) {
      throw new Error('Installed payload differs from the verified package')
    }
  }
  verified = true
} finally {
  if (existsSync(uninstaller)) runInstaller(uninstaller, ['/S', `_?=${installation}`])
  const removed = !existsSync(join(installation, 'TurboFlux.exe'))
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  if (verified && !removed) throw new Error('Windows uninstaller left the application installed')
}
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, installedPayloadVerified: true, uninstalled: true }))
