import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { digestPortableResourceTree, verifyDesktopPackage } from './verify-desktop-package.mjs'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function containsPath(root, candidate) {
  const nested = relative(root, candidate)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

function validDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function validRemoteMobileReport(value, platform) {
  const expectedPath = platform === 'darwin' ? 'Contents/Resources/remote-mobile' : 'resources/remote-mobile'
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'bytes,fileCount,path,sha256'
    && value.path === expectedPath
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
    && Number.isSafeInteger(value.fileCount)
    && value.fileCount > 0
    && validDigest(value.sha256)
}

async function walk(directory, depth = 0) {
  if (depth > 5) return []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path, depth + 1)
    return entry.isFile() ? [path] : []
  }))
  return nested.flat()
}

export async function discoverPackagedExecutable(options = {}) {
  if (options.executable) {
    let metadata
    try {
      metadata = await stat(options.executable)
    } catch {
      invariant(false, 'configured packaged executable cannot be read')
    }
    invariant(metadata.isFile(), 'configured packaged executable is not a file')
    return resolve(options.executable)
  }
  const platform = options.platform ?? process.platform
  const releaseRoot = resolve(options.releaseRoot)
  const expectedName = platform === 'win32' ? 'TurboFlux.exe' : 'TurboFlux'
  let files
  try {
    files = await walk(releaseRoot)
  } catch {
    invariant(false, 'packaged executable discovery failed')
  }
  const matches = files.filter(path => path.endsWith(expectedName)
    && (platform !== 'darwin' || path.includes('.app/Contents/MacOS/')))
  invariant(matches.length > 0, 'packaged executable was not found; build the unpacked Desktop app first or pass --executable=')
  const architecture = options.arch ?? process.arch
  return matches.sort((left, right) => Number(right.includes(architecture)) - Number(left.includes(architecture)) || left.localeCompare(right))[0]
}

export async function verifyPackagedExecutableIdentity(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const repositoryRoot = resolve(options.repositoryRoot)
  const executable = resolve(options.executable)
  const reportPath = resolve(options.packageReport)
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    throw new Error('packaged executable report is invalid', { cause: error })
  }
  invariant(report.schemaVersion === 2 && report.status === 'passed', 'packaged executable report must be a passed schema v2 package report')
  invariant(report.platform === platform && report.arch === arch, 'package report does not match the packaged executable target')
  invariant(typeof report.packagePath === 'string' && report.packagePath.length > 0 && !isAbsolute(report.packagePath), 'package report path is invalid')
  invariant(typeof report.asar?.path === 'string' && report.asar.path.length > 0 && !isAbsolute(report.asar.path), 'package report ASAR path is invalid')
  invariant(validDigest(report.package?.sha256) && validDigest(report.asar?.sha256), 'package report digests are invalid')
  if (options.remoteMobileRoot) invariant(validRemoteMobileReport(report.remoteMobile, platform), 'package report Remote Mobile evidence is invalid')

  const packageRoot = resolve(repositoryRoot, report.packagePath)
  const asarPath = resolve(packageRoot, report.asar.path)
  invariant(packageRoot !== repositoryRoot && containsPath(repositoryRoot, packageRoot), 'package report path escapes the repository')
  invariant(containsPath(packageRoot, asarPath), 'package report ASAR path escapes the package')
  let realRepositoryRoot
  let realPackageRoot
  let realExecutable
  try {
    [realRepositoryRoot, realPackageRoot, realExecutable] = await Promise.all([
      realpath(repositoryRoot),
      realpath(packageRoot),
      realpath(executable),
    ])
  } catch {
    invariant(false, 'packaged executable identity paths cannot be resolved')
  }
  invariant(containsPath(realRepositoryRoot, realPackageRoot), 'package root resolves outside the repository')
  invariant(realExecutable !== realPackageRoot && containsPath(realPackageRoot, realExecutable), 'packaged executable does not belong to the verified package')

  const packageVerifier = options.packageVerifier ?? verifyDesktopPackage
  let currentReport
  try {
    currentReport = await packageVerifier({ asarPath, platform, arch })
  } catch {
    invariant(false, 'current packaged application could not be verified')
  }
  invariant(currentReport?.schemaVersion === 2 && currentReport.status === 'passed', 'current packaged application did not pass package verification')
  invariant(currentReport.platform === platform && currentReport.arch === arch, 'current package verification target does not match the executable')
  invariant(currentReport.packagePath === report.packagePath, 'current package path does not match the package report')
  invariant(currentReport.package?.sha256 === report.package.sha256, 'packaged application tree changed after package verification')
  invariant(currentReport.asar?.sha256 === report.asar.sha256, 'packaged ASAR changed after package verification')
  if (options.remoteMobileRoot) {
    invariant(validRemoteMobileReport(currentReport.remoteMobile, platform), 'current package Remote Mobile evidence is invalid')
    invariant(currentReport.remoteMobile.path === report.remoteMobile.path
      && currentReport.remoteMobile.bytes === report.remoteMobile.bytes
      && currentReport.remoteMobile.fileCount === report.remoteMobile.fileCount
      && currentReport.remoteMobile.sha256 === report.remoteMobile.sha256, 'packaged Remote Mobile resources changed after package verification')
    let localRemoteMobile
    try {
      localRemoteMobile = digestPortableResourceTree(resolve(options.remoteMobileRoot))
    } catch {
      invariant(false, 'local Remote Mobile build could not be verified')
    }
    invariant(localRemoteMobile.bytes === currentReport.remoteMobile.bytes
      && localRemoteMobile.fileCount === currentReport.remoteMobile.fileCount
      && localRemoteMobile.sha256 === currentReport.remoteMobile.sha256, 'local Remote Mobile build does not match the packaged resources')
    return {
      packageSha256: currentReport.package.sha256,
      asarSha256: currentReport.asar.sha256,
      remoteMobileSha256: currentReport.remoteMobile.sha256,
    }
  }
  return { packageSha256: currentReport.package.sha256, asarSha256: currentReport.asar.sha256 }
}
