import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function invariant(condition, message) {
  if (!condition) throw new Error(`macOS release verification failed: ${message}`)
}

function verifyRegularFile(path, label) {
  invariant(existsSync(path), `missing ${label}`)
  const metadata = lstatSync(path)
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} is not a regular file`)
  invariant(metadata.size > 0, `${label} is empty`)
}

function discoverMacApp() {
  const releaseRoot = join(repositoryRoot, 'release')
  if (!existsSync(releaseRoot)) return undefined
  const candidates = readdirSync(releaseRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap(entry => {
      const directory = join(releaseRoot, entry.name)
      return readdirSync(directory, { withFileTypes: true })
        .filter(child => child.isDirectory() && child.name.endsWith('.app'))
        .map(child => join(directory, child.name))
    })
  invariant(candidates.length === 1, `expected exactly one macOS app under release, found ${candidates.length}`)
  return candidates[0]
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  invariant(!result.error, `${basename(command)} could not be started`)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  invariant(result.status === 0, `${basename(command)} command failed`)
  return output
}

function executeReleaseCommand(execute, command, args, failureMessage) {
  try {
    return execute(command, args)
  } catch {
    invariant(false, failureMessage)
  }
}

function signatureIdentity(details, label) {
  const authority = details.match(/^Authority=(Developer ID Application:[^\r\n]+)$/mu)?.[1]
  const teamIdentifier = details.match(/^TeamIdentifier=([^\s]+)$/mu)?.[1]
  invariant(authority, `${label} is not signed with Developer ID Application`)
  invariant(teamIdentifier && teamIdentifier !== 'not set', `${label} has no TeamIdentifier`)
  return { authority, teamIdentifier }
}

export function verifyDesktopMacReleaseEnvironment(options = {}) {
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  invariant(platform === 'darwin', 'release preflight requires macOS')
  invariant(environment.CSC_NAME?.trim(), 'CSC_NAME is required')
  const appleId = environment.APPLE_ID?.trim()
  const appleIdPassword = environment.APPLE_APP_SPECIFIC_PASSWORD?.trim()
  const teamId = environment.APPLE_TEAM_ID?.trim()
  invariant(appleId && appleIdPassword && teamId, 'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are required')
  return {
    schemaVersion: 1,
    status: 'passed',
    platform,
    signingIdentityConfigured: true,
    notarizationCredentialsConfigured: true,
  }
}

export function verifyDesktopMacRelease(options = {}) {
  const platform = options.platform ?? process.platform
  invariant(platform === 'darwin', 'release verification requires macOS')
  const appCandidate = options.appPath ?? discoverMacApp()
  invariant(appCandidate, 'macOS app does not exist')
  const appPath = resolve(appCandidate)
  invariant(existsSync(appPath) && lstatSync(appPath).isDirectory(), 'macOS app does not exist')
  const helperPath = join(appPath, 'Contents', 'Resources', 'native', 'TurboFluxComputerHelper')
  verifyRegularFile(helperPath, 'TurboFluxComputerHelper')
  const execute = options.runCommand ?? runCommand
  executeReleaseCommand(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], 'application signature verification failed')
  const appDetails = executeReleaseCommand(execute, '/usr/bin/codesign', ['--display', '--verbose=4', appPath], 'application signature inspection failed')
  const appSignature = signatureIdentity(appDetails, 'TurboFlux.app')
  invariant(appDetails.includes('Runtime Version='), 'TurboFlux.app does not use hardened runtime')
  executeReleaseCommand(execute, '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', helperPath], 'helper signature verification failed')
  const helperDetails = executeReleaseCommand(execute, '/usr/bin/codesign', ['--display', '--verbose=4', helperPath], 'helper signature inspection failed')
  const helperSignature = signatureIdentity(helperDetails, 'TurboFluxComputerHelper')
  invariant(helperSignature.teamIdentifier === appSignature.teamIdentifier, 'app and helper TeamIdentifier values differ')
  executeReleaseCommand(execute, '/usr/bin/xcrun', ['stapler', 'validate', appPath], 'notarization ticket validation failed')
  executeReleaseCommand(execute, '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], 'Gatekeeper assessment failed')
  return {
    schemaVersion: 1,
    status: 'passed',
    appName: basename(appPath),
    authority: appSignature.authority,
    teamIdentifier: appSignature.teamIdentifier,
    helperAuthority: helperSignature.authority,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2)
  const appArgument = arguments_.find(argument => argument.startsWith('--app='))
  try {
    const report = arguments_.includes('--preflight')
      ? verifyDesktopMacReleaseEnvironment()
      : verifyDesktopMacRelease({ appPath: appArgument?.slice('--app='.length) })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'macOS release verification failed: unexpected error'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
