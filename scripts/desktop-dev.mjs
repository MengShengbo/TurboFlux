import { spawn, spawnSync } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDesktopDevServer } from './desktop-dev-server.mjs'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptsDirectory, '..')
const publicRepositoryRoot = resolve(process.env.TURBOFLUX_PUBLIC_REPO || repositoryRoot)
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const viteBinary = join(desktopRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const electronBinary = desktopRequire('electron')
const mainEntry = join(desktopRoot, 'main.mjs')
const builtMainEntry = join(desktopRoot, 'generated', 'main.mjs')
const buildMainScript = join(repositoryRoot, 'scripts', 'build-desktop-main.mjs')
const preloadEntry = join(desktopRoot, 'preload.cjs')
const desktopPathsEntry = join(desktopRoot, 'desktopPaths.ts')
const runtimeHostEntry = join(desktopRoot, 'runtimeHost.ts')
const builtCoreRoot = join(publicRepositoryRoot, 'packages', 'agent-core')
const remoteProtocolRoot = join(repositoryRoot, 'packages', 'remote-protocol')
const installedCoreEntry = fileURLToPath(import.meta.resolve('@turboflux/agent-core'))
const installedCoreRoot = resolve(dirname(installedCoreEntry), '..', '..')
const viteConfig = join(desktopRoot, 'vite.config.mjs')
const desktopServer = resolveDesktopDevServer(process.env)
const desktopUrl = desktopServer.url
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const devLockPath = join(desktopRoot, 'generated', 'desktop-dev.lock')
const remoteDebuggingPort = process.env.TURBOFLUX_ELECTRON_REMOTE_DEBUGGING_PORT?.trim()
const isolatedUserDataDirectory = process.env.TURBOFLUX_ELECTRON_USER_DATA_DIR?.trim()
const electronArguments = [
  ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
  ...(isolatedUserDataDirectory ? [`--user-data-dir=${resolve(isolatedUserDataDirectory)}`] : []),
  ...(remoteDebuggingPort && /^\d{2,5}$/.test(remoteDebuggingPort) && Number(remoteDebuggingPort) <= 65_535
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : []),
  builtMainEntry,
]

if (!existsSync(viteBinary) || !existsSync(electronBinary)) {
  throw new Error('Desktop dependencies are missing. Run npm install in the desktop directory.')
}

if (!existsSync(join(publicRepositoryRoot, 'packages', 'agent-core', 'package.json'))) {
  throw new Error(`The public TurboFlux checkout was not found at ${publicRepositoryRoot}. Set TURBOFLUX_PUBLIC_REPO to its path.`)
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireDevLock() {
  mkdirSync(dirname(devLockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(devLockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${process.pid}\n`)
      closeSync(descriptor)
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let existingPid = 0
      try { existingPid = Number.parseInt(readFileSync(devLockPath, 'utf8').trim(), 10) } catch {}
      if (processIsRunning(existingPid)) throw new Error(`TurboFlux Desktop dev is already running (PID ${existingPid}).`)
      try { unlinkSync(devLockPath) } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new Error('Unable to acquire the TurboFlux Desktop dev lock.')
}

function releaseDevLock() {
  try {
    if (Number.parseInt(readFileSync(devLockPath, 'utf8').trim(), 10) === process.pid) unlinkSync(devLockPath)
  } catch {}
}

acquireDevLock()

function buildSharedCore() {
  const result = spawnSync(npmBinary, ['run', 'build:core'], {
    cwd: publicRepositoryRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) throw new Error('Unable to build @turboflux/agent-core before starting Desktop.')
  if (resolve(installedCoreRoot) === resolve(builtCoreRoot)) return
  rmSync(join(installedCoreRoot, 'dist'), { recursive: true, force: true })
  cpSync(join(builtCoreRoot, 'dist'), join(installedCoreRoot, 'dist'), { recursive: true, force: true })
}

function buildRemoteProtocol() {
  const result = spawnSync(npmBinary, ['run', 'build'], {
    cwd: remoteProtocolRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) throw new Error('Unable to build @turboflux/remote-protocol before starting Desktop.')
}

function buildDesktopMain() {
  const result = spawnSync(process.execPath, [buildMainScript], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) throw new Error('Unable to build the Desktop main process.')
}

buildRemoteProtocol()
buildSharedCore()
buildDesktopMain()

const viteProcess = spawn(viteBinary, ['--config', viteConfig], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: { ...process.env, BROWSER: 'none' },
})

viteProcess.once('error', error => {
  console.error(`Unable to start Vite: ${error.message}`)
  process.exitCode = 1
})

async function waitForVite() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${desktopUrl}/`)
      if (response.ok) return
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('Vite did not become ready in time.')
}

await waitForVite()

let electronProcess
let restartTimer
let coreBuildTimer
let remoteProtocolBuildTimer
let shuttingDown = false
const expectedElectronExits = new WeakSet()
let restartSequence = Promise.resolve()

function startElectron() {
  const child = spawn(electronBinary, electronArguments, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, TURBOFLUX_DESKTOP_URL: desktopUrl },
  })
  electronProcess = child
  child.once('error', error => {
    console.error(`Unable to start Electron: ${error.message}`)
    void shutdown()
    process.exitCode = 1
  })
  child.on('exit', code => {
    if (expectedElectronExits.has(child)) return
    if (!shuttingDown && code !== 0) {
      process.exitCode = code || 1
      void shutdown()
    }
  })
}

async function stopElectron(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  expectedElectronExits.add(child)
  child.kill('SIGTERM')
  await new Promise(resolveStop => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 4_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
  })
}

function restartElectron() {
  if (shuttingDown) return
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartSequence = restartSequence.then(async () => {
      if (shuttingDown) return
      try {
        buildDesktopMain()
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return
      }
      const previousElectron = electronProcess
      electronProcess = undefined
      await stopElectron(previousElectron)
      if (!shuttingDown) startElectron()
    })
  }, 120)
}

function rebuildCoreAndRestart() {
  if (shuttingDown) return
  clearTimeout(coreBuildTimer)
  coreBuildTimer = setTimeout(() => {
    try {
      buildSharedCore()
      restartElectron()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
  }, 180)
}

function rebuildRemoteProtocolAndRestart() {
  if (shuttingDown) return
  clearTimeout(remoteProtocolBuildTimer)
  remoteProtocolBuildTimer = setTimeout(() => {
    try {
      buildRemoteProtocol()
      restartElectron()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
    }
  }, 180)
}

const closeWatchers = [mainEntry, preloadEntry, desktopPathsEntry, runtimeHostEntry].map(file => watch(file, restartElectron))
for (const directory of ['browser', 'computer', 'systems']) {
  closeWatchers.push(watch(join(desktopRoot, directory), { recursive: true }, restartElectron))
}
for (const directory of ['application', 'core', 'kernel', 'platform', 'shared', 'state', 'tools']) {
  closeWatchers.push(watch(join(publicRepositoryRoot, 'packages', 'agent-core', 'src', directory), { recursive: true }, rebuildCoreAndRestart))
}
closeWatchers.push(watch(join(remoteProtocolRoot, 'src'), { recursive: true }, rebuildRemoteProtocolAndRestart))
startElectron()

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  closeWatchers.forEach(item => item.close())
  clearTimeout(restartTimer)
  clearTimeout(coreBuildTimer)
  clearTimeout(remoteProtocolBuildTimer)
  await restartSequence.catch(() => undefined)
  await stopElectron(electronProcess)
  electronProcess = undefined
  if (!viteProcess.killed) viteProcess.kill()
  releaseDevLock()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
viteProcess.once('exit', () => { void shutdown() })
