import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = join(repositoryRoot, 'release')
const requiredAsarEntries = [
  '/generated/main.mjs',
  '/generated/packagedBootstrap.mjs',
  '/generated/packagedBootstrapRuntime.mjs',
  '/node_modules/@turboflux/agent-core/package.json',
  '/node_modules/@turboflux/remote-protocol/package.json',
  '/node_modules/esbuild/package.json',
  '/node_modules/node-pty/package.json',
  '/node_modules/qrcode/package.json',
  '/node_modules/tsx/package.json',
]
const nativeEvidenceFiles = new Set([
  'result.json',
  'failure.json',
  'native-events.jsonl',
  'native-events.snapshot.json',
  'desktop-process.log',
  'system-sleep-log.txt',
  'approval-notification-target.png',
  'result-notification-target.png',
  'automation-path-picker-return.png',
])
const sensitiveDiagnosticPattern = /(?:https?:\/\/|file:\/\/|\b(?:token|secret|password|api[_-]?key|authorization|bearer)\b\s*[:=])/iu
const localPathPattern = /(?:^|[\s:(])(?:\/|[A-Za-z]:[\\/])/u

function invariant(condition, message) {
  if (!condition) throw new Error(`Desktop package verification failed: ${message}`)
}

export function desktopPackageForbiddenEntry(entry) {
  const normalized = String(entry).replaceAll('\\', '/')
  const filename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return normalized.startsWith('/node_modules/pngjs/')
    || normalized === '/node_modules/pngjs'
    || normalized.includes('/coverage/')
    || normalized.includes('automation-native-qa')
    || normalized.includes('electron-user-data')
    || nativeEvidenceFiles.has(filename)
    || /(^|\/)\.env(?:\.|$)/iu.test(normalized)
}

function walk(directory, options = {}) {
  if (!existsSync(directory)) return []
  const pending = [directory]
  const files = []
  let entryCount = 0
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      entryCount += 1
      invariant(entryCount <= 250_000, `resource tree exceeds 250000 entries: ${directory}`)
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        invariant(!options.rejectSymlinks, `packaged Resources contains symbolic link: ${relative(directory, path)}`)
      } else if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile()) {
        files.push(path)
      } else {
        invariant(false, `packaged Resources contains unsupported entry: ${relative(directory, path)}`)
      }
    }
  }
  return files
}

function verifyRegularFile(path, label, options = {}) {
  invariant(existsSync(path), `missing ${label}: ${path}`)
  const metadata = lstatSync(path)
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} is not a regular file: ${path}`)
  invariant(metadata.size > 0, `${label} is empty: ${path}`)
  if (options.executable) invariant((metadata.mode & 0o111) !== 0, `${label} is not executable: ${path}`)
}

function nativeArchitecture(machine) {
  return new Map([
    [0x01000007, 'x64'],
    [0x0100000c, 'arm64'],
  ]).get(machine)
}

function readBinaryPrefix(path) {
  const descriptor = openSync(path, 'r')
  const buffer = Buffer.alloc(65_536)
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(descriptor)
  }
}

function sha256File(path) {
  const descriptor = openSync(path, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  const hash = createHash('sha256')
  try {
    let bytesRead
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead))
    return hash.digest('hex')
  } finally {
    closeSync(descriptor)
  }
}

export function digestPortableResourceTree(root) {
  invariant(existsSync(root), `resource tree does not exist: ${root}`)
  const rootMetadata = lstatSync(root)
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `resource tree is not a regular directory: ${root}`)
  const records = walk(root, { rejectSymlinks: true }).map(path => {
    const size = statSync(path).size
    return {
      path: relative(root, path).split(sep).join('/'),
      size,
      sha256: sha256File(path),
    }
  }).sort((left, right) => left.path.localeCompare(right.path))
  invariant(records.length > 0, `resource tree is empty: ${root}`)
  const hash = createHash('sha256')
  for (const record of records) hash.update(`${JSON.stringify(record)}\n`)
  return {
    bytes: records.reduce((total, record) => total + record.size, 0),
    fileCount: records.length,
    sha256: hash.digest('hex'),
  }
}

function packageTreeRoot(resourcesDirectory, platform) {
  if (platform !== 'darwin') return dirname(resourcesDirectory)
  const contentsDirectory = dirname(resourcesDirectory)
  const appDirectory = dirname(contentsDirectory)
  return basename(contentsDirectory) === 'Contents' && appDirectory.endsWith('.app') ? appDirectory : resourcesDirectory
}

function digestPackageTree(root) {
  const pending = [root]
  const records = []
  let entryCount = 0
  let fileCount = 0
  let symlinkCount = 0
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      entryCount += 1
      invariant(entryCount <= 250_000, `package tree exceeds 250000 entries: ${root}`)
      const path = join(current, entry.name)
      const portablePath = relative(root, path).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        symlinkCount += 1
        records.push({ path: portablePath, type: 'symlink', target: readlinkSync(path) })
      } else if (entry.isDirectory()) {
        records.push({ path: portablePath, type: 'directory' })
        pending.push(path)
      } else if (entry.isFile()) {
        const size = statSync(path).size
        fileCount += 1
        bytes += size
        records.push({ path: portablePath, type: 'file', size, sha256: sha256File(path) })
      } else {
        invariant(false, `package tree contains unsupported entry: ${portablePath}`)
      }
    }
  }
  records.sort((left, right) => left.path.localeCompare(right.path))
  const hash = createHash('sha256')
  for (const record of records) hash.update(`${JSON.stringify(record)}\n`)
  return { bytes, entryCount, fileCount, symlinkCount, sha256: hash.digest('hex') }
}

function portablePackagePath(packageRoot, path) {
  return relative(packageRoot, path).split(sep).join('/')
}

function runtimeFileReport(packageRoot, path) {
  return {
    path: portablePackagePath(packageRoot, path),
    bytes: statSync(path).size,
    sha256: sha256File(path),
    targets: [...detectNativeBinaryTargets(path)].sort(),
  }
}

function packageProvenance(environment = process.env) {
  const runAttempt = Number.parseInt(environment.GITHUB_RUN_ATTEMPT ?? '', 10)
  const repository = environment.GITHUB_REPOSITORY?.trim()
  const workflowName = environment.GITHUB_WORKFLOW?.trim()
  const workflowRef = environment.GITHUB_WORKFLOW_REF?.trim()
  const jobId = environment.GITHUB_JOB?.trim()
  const runnerOs = environment.RUNNER_OS?.trim()
  const runnerArch = environment.RUNNER_ARCH?.trim()
  return {
    gitCommit: /^[a-f0-9]{40}$/iu.test(environment.GITHUB_SHA ?? '') ? environment.GITHUB_SHA.toLowerCase() : null,
    repository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') ? repository : null,
    workflowName: workflowName && workflowName.length <= 256 && !/[\r\n]/u.test(workflowName) && !sensitiveDiagnosticPattern.test(workflowName) && !localPathPattern.test(workflowName) ? workflowName : null,
    workflowRef: workflowRef && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+@refs\/[A-Za-z0-9._/-]+$/u.test(workflowRef) && !sensitiveDiagnosticPattern.test(workflowRef) ? workflowRef : null,
    workflowRunId: /^\d+$/u.test(environment.GITHUB_RUN_ID ?? '') ? environment.GITHUB_RUN_ID : null,
    workflowRunAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : null,
    jobId: /^[A-Za-z0-9_-]+$/u.test(jobId ?? '') ? jobId : null,
    runnerOs: ['macOS', 'Windows', 'Linux'].includes(runnerOs) ? runnerOs : null,
    runnerArch: ['ARM64', 'X64'].includes(runnerArch) ? runnerArch : null,
  }
}

export function writeDesktopPackageReport(path, report) {
  const reportPath = resolve(path)
  const temporaryPath = `${reportPath}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(dirname(reportPath), { recursive: true })
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporaryPath, reportPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function sanitizedPackageFailureMessage(error, options = {}) {
  const rawMessage = String(error instanceof Error ? error.message : error).split(/\r?\n/u)[0]
  if (sensitiveDiagnosticPattern.test(rawMessage)) return 'Desktop package verification failed: redacted unsafe diagnostic'
  const replacements = [
    options.asarPath ? resolve(options.asarPath) : undefined,
    repositoryRoot,
  ].filter(Boolean).sort((left, right) => right.length - left.length)
  let message = rawMessage
  for (const value of replacements) message = message.replaceAll(value, value === repositoryRoot ? '[REPOSITORY]' : '[PACKAGE]')
  message = message
    .replace(/[A-Za-z]:[\\/][^\s,;)]*/gu, '[PATH]')
    .replace(/(^|[\s:(])\/[^\s,;)]*/gu, '$1[PATH]')
  message = [...message].map(character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('').trim()
  if (sensitiveDiagnosticPattern.test(message)) return 'Desktop package verification failed: redacted unsafe diagnostic'
  return message.slice(0, 1_000) || 'Desktop package verification failed'
}

export function createDesktopPackageFailureReport(error, options = {}) {
  const requestedPlatform = options.platform ?? process.platform
  const requestedArch = options.arch ?? process.arch
  return {
    schemaVersion: 2,
    status: 'failed',
    platform: ['darwin', 'win32', 'linux'].includes(requestedPlatform) ? requestedPlatform : 'unknown',
    arch: ['arm64', 'x64'].includes(requestedArch) ? requestedArch : 'unknown',
    provenance: packageProvenance(options.environment),
    failure: {
      code: 'DESKTOP_PACKAGE_VERIFICATION_FAILED',
      message: sanitizedPackageFailureMessage(error, options),
    },
  }
}

export function detectNativeBinaryTargets(path) {
  const buffer = readBinaryPrefix(path)
  const targets = new Set()
  if (buffer.length >= 8) {
    const thinMagic = 0xfeedfacf
    const littleEndianThin = buffer.readUInt32LE(0) === thinMagic
    const bigEndianThin = buffer.readUInt32BE(0) === thinMagic
    if (littleEndianThin || bigEndianThin) {
      const machine = littleEndianThin ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4)
      const arch = nativeArchitecture(machine)
      if (arch) targets.add(`darwin-${arch}`)
      return targets
    }
    const bigEndianMagic = buffer.readUInt32BE(0)
    const littleEndianMagic = buffer.readUInt32LE(0)
    const fat32Magic = 0xcafebabe
    const fat64Magic = 0xcafebabf
    const bigEndianFat = bigEndianMagic === fat32Magic || bigEndianMagic === fat64Magic
    const littleEndianFat = littleEndianMagic === fat32Magic || littleEndianMagic === fat64Magic
    if (bigEndianFat || littleEndianFat) {
      const readUInt32 = bigEndianFat ? Buffer.prototype.readUInt32BE : Buffer.prototype.readUInt32LE
      const magic = bigEndianFat ? bigEndianMagic : littleEndianMagic
      const count = readUInt32.call(buffer, 4)
      const entrySize = magic === fat64Magic ? 32 : 20
      invariant(count <= 32 && 8 + count * entrySize <= buffer.length, `invalid Mach-O universal header: ${path}`)
      for (let index = 0; index < count; index += 1) {
        const arch = nativeArchitecture(readUInt32.call(buffer, 8 + index * entrySize))
        if (arch) targets.add(`darwin-${arch}`)
      }
      return targets
    }
  }
  if (buffer.length >= 20 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18)
    const arch = new Map([[62, 'x64'], [183, 'arm64']]).get(machine)
    if (arch) targets.add(`linux-${arch}`)
    return targets
  }
  if (buffer.length >= 64 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const headerOffset = buffer.readUInt32LE(0x3c)
    invariant(headerOffset + 6 <= buffer.length, `invalid PE header offset: ${path}`)
    invariant(buffer.subarray(headerOffset, headerOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), `invalid PE signature: ${path}`)
    const arch = new Map([[0x8664, 'x64'], [0xaa64, 'arm64']]).get(buffer.readUInt16LE(headerOffset + 4))
    if (arch) targets.add(`win32-${arch}`)
  }
  return targets
}

function verifyNativeBinary(path, label, platform, arch, options = {}) {
  verifyRegularFile(path, label, options)
  const targets = detectNativeBinaryTargets(path)
  const expected = `${platform}-${arch}`
  invariant(targets.has(expected), `${label} targets ${[...targets].join(', ') || 'an unknown binary format'}, expected ${expected}: ${path}`)
}

function loadNativeAddon(path) {
  const moduleRecord = { exports: {} }
  process.dlopen(moduleRecord, path)
  return moduleRecord.exports
}

function verifyFunctionExports(moduleExports, expectedExports, label) {
  for (const name of expectedExports) invariant(typeof moduleExports[name] === 'function', `${label} is missing native export: ${name}`)
  return Object.keys(moduleExports).sort()
}

export function probeDesktopNativeRuntime(options) {
  const loadAddon = options.loadNativeAddon ?? loadNativeAddon
  const runExecutable = options.runExecutable ?? ((path, args) => spawnSync(path, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    windowsHide: true,
  }))
  const closeDescriptor = options.closeDescriptor ?? closeSync
  const loadedModules = []
  let ptyOpenSmoke = false
  if (options.platform === 'win32') {
    const expectedByFilename = new Map([
      ['pty.node', ['startProcess', 'resize', 'kill', 'getExitCode', 'getProcessList']],
      ['conpty.node', ['startProcess', 'connect', 'resize', 'clear', 'kill']],
      ['conpty_console_list.node', ['getConsoleProcessList']],
    ])
    for (const path of options.ptyFiles.filter(path => path.endsWith('.node'))) {
      const filename = basename(path)
      const expectedExports = expectedByFilename.get(filename)
      invariant(expectedExports, `unexpected Windows node-pty module: ${filename}`)
      loadedModules.push({ filename, exports: verifyFunctionExports(loadAddon(path), expectedExports, filename) })
    }
  } else {
    const ptyPath = options.ptyFiles.find(path => basename(path) === 'pty.node')
    invariant(ptyPath, `missing ${options.platform} pty.node runtime probe target`)
    const pty = loadAddon(ptyPath)
    loadedModules.push({ filename: 'pty.node', exports: verifyFunctionExports(pty, ['fork', 'open', 'process', 'resize'], 'pty.node') })
    let pair
    let probeError
    try {
      pair = pty.open(80, 24)
      invariant(Number.isInteger(pair?.master) && Number.isInteger(pair?.slave), 'pty.open did not return integer descriptors')
      invariant(typeof pair.pty === 'string' && pair.pty.length > 0, 'pty.open did not return a PTY path')
      ptyOpenSmoke = true
    } catch (error) {
      probeError = error
    }
    let closeError
    for (const descriptor of new Set([pair?.master, pair?.slave].filter(Number.isInteger))) {
      try {
        closeDescriptor(descriptor)
      } catch (error) {
        closeError ??= error
      }
    }
    if (probeError) throw probeError
    if (closeError) throw closeError
  }
  const esbuildResult = runExecutable(options.esbuildBinary, ['--version'])
  if (esbuildResult.error) throw esbuildResult.error
  const esbuildOutput = `${esbuildResult.stdout ?? ''}`.trim()
  const esbuildError = `${esbuildResult.stderr ?? ''}`.trim()
  invariant(esbuildResult.status === 0, `packaged esbuild --version failed${esbuildError ? `: ${esbuildError}` : ''}`)
  invariant(esbuildOutput === options.esbuildVersion, `packaged esbuild reported ${esbuildOutput || 'no version'}, expected ${options.esbuildVersion}`)
  return { loadedModules, ptyOpenSmoke, esbuildVersion: esbuildOutput }
}

function verifyNativeRuntime(resourcesDirectory, platform, arch) {
  const unpackedModules = join(resourcesDirectory, 'app.asar.unpacked', 'node_modules')
  const ptyRoot = join(unpackedModules, 'node-pty')
  const ptyCandidates = [
    join(ptyRoot, 'build', 'Release'),
    join(ptyRoot, 'build', 'Debug'),
    join(ptyRoot, 'prebuilds', `${platform}-${arch}`),
  ]
  const ptyFiles = platform === 'win32'
    ? ['pty.node', 'conpty.node', 'conpty_console_list.node']
    : ['pty.node', 'spawn-helper']
  const completePtyDirectory = ptyCandidates.find(directory => ptyFiles.every(filename => {
    const path = join(directory, filename)
    return existsSync(path) && lstatSync(path).isFile() && lstatSync(path).size > 0
  }))
  invariant(completePtyDirectory, `missing complete node-pty ${platform}-${arch} runtime (${ptyFiles.join(', ')})`)
  for (const filename of ptyFiles) {
    verifyNativeBinary(join(completePtyDirectory, filename), `node-pty runtime ${filename}`, platform, arch, {
      executable: platform !== 'win32' && filename === 'spawn-helper',
    })
  }
  const esbuildPackage = `${platform === 'win32' ? 'win32' : platform}-${arch}`
  const esbuildPackageEntry = `/node_modules/@esbuild/${esbuildPackage}/package.json`
  const esbuildBinary = join(unpackedModules, '@esbuild', esbuildPackage, 'bin', platform === 'win32' ? 'esbuild.exe' : 'esbuild')
  verifyNativeBinary(esbuildBinary, `esbuild ${platform}-${arch} runtime`, platform, arch, { executable: platform !== 'win32' })
  return {
    esbuildBinary,
    esbuildPackageEntry,
    ptyFiles: ptyFiles.map(filename => join(completePtyDirectory, filename)),
  }
}

function packageVersion(asarPath, entry) {
  let manifest
  try {
    manifest = JSON.parse(extractFile(asarPath, entry.slice(1)).toString('utf8'))
  } catch (error) {
    throw new Error(`Desktop package verification failed: invalid package manifest ${entry}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  invariant(typeof manifest.version === 'string' && manifest.version.length > 0, `package manifest has no version: ${entry}`)
  return manifest.version
}

export function desktopPackagePathMatchesPlatform(path, platform) {
  const normalized = String(path).replaceAll('\\', '/')
  if (platform === 'darwin') return /\/mac(?:-[^/]+)?\//u.test(normalized)
  if (platform === 'win32') return /\/win(?:-[^/]+)?\//u.test(normalized)
  if (platform === 'linux') return /\/linux(?:-[^/]+)?\//u.test(normalized)
  return false
}

function discoverAsar(platform) {
  const candidates = walk(releaseRoot).filter(path => basename(path) === 'app.asar')
  const platformCandidates = candidates.filter(path => desktopPackagePathMatchesPlatform(path, platform))
  invariant(platformCandidates.length === 1, `expected exactly one ${platform} app.asar under release, found ${platformCandidates.length}`)
  return platformCandidates[0]
}

export function verifyDesktopPackage(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  invariant(['darwin', 'linux', 'win32'].includes(platform), `unsupported package platform: ${platform}`)
  invariant(['arm64', 'x64'].includes(arch), `unsupported package architecture: ${arch}`)
  const asarPath = resolve(options.asarPath ?? discoverAsar(platform))
  invariant(existsSync(asarPath), `ASAR does not exist: ${asarPath}`)
  invariant(statSync(asarPath).isFile(), `ASAR does not exist: ${asarPath}`)
  const entries = listPackage(asarPath)
  const entrySet = new Set(entries)
  for (const required of requiredAsarEntries) invariant(entrySet.has(required), `missing required ASAR entry: ${required}`)
  const forbidden = entries.filter(desktopPackageForbiddenEntry)
  invariant(forbidden.length === 0, `forbidden ASAR entries: ${forbidden.slice(0, 8).join(', ')}`)
  const main = extractFile(asarPath, 'generated/main.mjs').toString('utf8')
  invariant(main.includes('qrcode/lib/browser.js'), 'packaged Main does not use the SVG-only QR code entry')
  const bootstrap = extractFile(asarPath, 'generated/packagedBootstrap.mjs').toString('utf8')
  invariant(bootstrap.includes("import('./main.mjs')") && bootstrap.includes('runPackagedDesktopBootstrap'), 'packaged bootstrap does not load the production Main through its guarded runtime')
  const bootstrapRuntime = extractFile(asarPath, 'generated/packagedBootstrapRuntime.mjs').toString('utf8')
  for (const marker of ['TURBOFLUX_DESKTOP_QA_HIDDEN', 'uncaughtException', 'unhandledRejection', 'TurboFlux hidden QA bootstrap failure']) {
    invariant(bootstrapRuntime.includes(marker), `packaged bootstrap runtime is missing marker: ${marker}`)
  }
  const resourcesDirectory = dirname(asarPath)
  const nativeRuntime = verifyNativeRuntime(resourcesDirectory, platform, arch)
  invariant(entrySet.has(nativeRuntime.esbuildPackageEntry), `missing required ASAR entry: ${nativeRuntime.esbuildPackageEntry}`)
  const esbuildVersion = packageVersion(asarPath, '/node_modules/esbuild/package.json')
  invariant(packageVersion(asarPath, nativeRuntime.esbuildPackageEntry) === esbuildVersion, 'esbuild wrapper and platform package versions differ')
  const nativeRuntimeProbe = (options.runtimeProbe ?? probeDesktopNativeRuntime)({
    platform,
    arch,
    ptyFiles: nativeRuntime.ptyFiles,
    esbuildBinary: nativeRuntime.esbuildBinary,
    esbuildVersion,
  })
  for (const required of ['renderer/index.html', 'remote-mobile/index.html']) {
    verifyRegularFile(join(resourcesDirectory, required), `packaged resource ${required}`)
  }
  const helperPath = join(resourcesDirectory, 'native', 'TurboFluxComputerHelper')
  if (platform === 'darwin') verifyNativeBinary(helperPath, 'macOS TurboFluxComputerHelper', platform, arch, { executable: true })
  else invariant(!existsSync(helperPath), `${platform} package contains the macOS computer helper`)
  const resourceEntries = walk(resourcesDirectory, { rejectSymlinks: true })
    .map(path => relative(resourcesDirectory, path).split(sep).join('/'))
    .filter(entry => entry !== 'app.asar')
  const forbiddenResources = resourceEntries.filter(entry => desktopPackageForbiddenEntry(`/${entry}`))
  invariant(forbiddenResources.length === 0, `forbidden packaged resources: ${forbiddenResources.slice(0, 8).join(', ')}`)
  const packageRoot = packageTreeRoot(resourcesDirectory, platform)
  const remoteMobileRoot = join(resourcesDirectory, 'remote-mobile')
  const runtimeFiles = [...nativeRuntime.ptyFiles, nativeRuntime.esbuildBinary]
  if (platform === 'darwin') runtimeFiles.push(helperPath)
  return {
    schemaVersion: 2,
    status: 'passed',
    platform,
    arch,
    provenance: packageProvenance(),
    packagePath: relative(repositoryRoot, packageRoot).split(sep).join('/'),
    package: digestPackageTree(packageRoot),
    asar: {
      path: portablePackagePath(packageRoot, asarPath),
      bytes: statSync(asarPath).size,
      entryCount: entries.length,
      sha256: sha256File(asarPath),
    },
    remoteMobile: {
      path: portablePackagePath(packageRoot, remoteMobileRoot),
      ...digestPortableResourceTree(remoteMobileRoot),
    },
    resources: { fileCount: resourceEntries.length },
    runtimeFiles: runtimeFiles.map(path => runtimeFileReport(packageRoot, path)),
    nativeRuntimeProbe,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const asarArgument = process.argv.slice(2).find(argument => argument.startsWith('--asar='))
  const platformArgument = process.argv.slice(2).find(argument => argument.startsWith('--platform='))
  const archArgument = process.argv.slice(2).find(argument => argument.startsWith('--arch='))
  const reportArgument = process.argv.slice(2).find(argument => argument.startsWith('--report='))
  const options = {
    asarPath: asarArgument?.slice('--asar='.length),
    platform: platformArgument?.slice('--platform='.length),
    arch: archArgument?.slice('--arch='.length),
  }
  let report
  let failed = false
  try {
    report = verifyDesktopPackage(options)
  } catch (error) {
    failed = true
    report = createDesktopPackageFailureReport(error, options)
  }
  if (reportArgument) writeDesktopPackageReport(reportArgument.slice('--report='.length), report)
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (failed) {
    process.stderr.write(output)
    process.exitCode = 1
  } else process.stdout.write(output)
}
