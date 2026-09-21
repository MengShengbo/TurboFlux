import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { createPackage } from '@electron/asar'
import { describe, expect, it } from 'vitest'
import { buildDesktopAssets, desktopAssetPlan } from '../../scripts/build-desktop-assets.mjs'
import { verifyDesktopMacRelease, verifyDesktopMacReleaseEnvironment } from '../../scripts/verify-desktop-macos-release.mjs'
import { createDesktopPackageFailureReport, desktopPackageForbiddenEntry, desktopPackagePathMatchesPlatform, digestPortableResourceTree, probeDesktopNativeRuntime, verifyDesktopPackage, writeDesktopPackageReport } from '../../scripts/verify-desktop-package.mjs'
import notarizeDesktop from './build/notarize-desktop.mjs'
import signDesktopHelper from './build/sign-desktop-helper.mjs'

const builderConfig = readFileSync(new URL('./electron-builder.yml', import.meta.url), 'utf8')
const desktopPackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const continuousIntegration = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

function writeFixtureFile(root: string, path: string, options: { executable?: boolean; value?: string | Buffer } = {}) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, options.value ?? 'fixture')
  if (options.executable) chmodSync(target, 0o755)
  return target
}

function createNativeBinaryFixture(platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64') {
  if (platform === 'darwin') {
    const buffer = Buffer.alloc(64)
    buffer.writeUInt32LE(0xfeedfacf, 0)
    buffer.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    return buffer
  }
  if (platform === 'linux') {
    const buffer = Buffer.alloc(64)
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buffer)
    buffer[4] = 2
    buffer[5] = 1
    buffer.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
    return buffer
  }
  const buffer = Buffer.alloc(256)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(0x80, 0x3c)
  Buffer.from([0x50, 0x45, 0, 0]).copy(buffer, 0x80)
  buffer.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x84)
  return buffer
}

async function createDesktopPackageFixture(platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64' = 'x64', options: { mainValue?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-desktop-package-'))
  const source = join(directory, 'source')
  const resources = join(directory, 'Resources')
  const asarPath = join(resources, 'app.asar')
  const esbuildPackage = `${platform === 'win32' ? 'win32' : platform}-${arch}`
  writeFixtureFile(source, 'generated/main.mjs', {
    value: options.mainValue ?? 'qrcode/lib/browser.js',
  })
  writeFixtureFile(source, 'generated/packagedBootstrap.mjs', { value: "runPackagedDesktopBootstrap(() => import('./main.mjs'))" })
  writeFixtureFile(source, 'generated/packagedBootstrapRuntime.mjs', { value: 'TURBOFLUX_DESKTOP_QA_HIDDEN uncaughtException unhandledRejection TurboFlux hidden QA bootstrap failure' })
  for (const path of [
    'node_modules/@turboflux/workbench/package.json',
    'node_modules/@turboflux/agent-runtime/package.json',
    'node_modules/@turboflux/contracts/package.json',
    'node_modules/@turboflux/models/package.json',
    'node_modules/@turboflux/platform/package.json',
    'node_modules/@turboflux/tools/package.json',
    'node_modules/@turboflux/extensions/package.json',
    'node_modules/@turboflux/conversations/package.json',
    'node_modules/@turboflux/profiles/package.json',
    'node_modules/@turboflux/automations/package.json',
    'node_modules/@turboflux/presentation/package.json',
    'node_modules/@turboflux/renderer/package.json',
    'node_modules/@turboflux/remote-protocol/package.json',
    `node_modules/@esbuild/${esbuildPackage}/package.json`,
    'node_modules/esbuild/package.json',
    'node_modules/node-pty/package.json',
    'node_modules/qrcode/package.json',
    'node_modules/tsx/package.json',
  ]) writeFixtureFile(source, path, { value: path.includes('esbuild') ? '{"version":"0.0.0-test"}' : '{}' })
  mkdirSync(resources, { recursive: true })
  await finished(await createPackage(source, asarPath))
  writeFixtureFile(resources, 'renderer/index.html')
  writeFixtureFile(resources, 'remote-mobile/index.html')
  const ptyDirectory = `app.asar.unpacked/node_modules/node-pty/prebuilds/${platform}-${arch}`
  const ptyFiles = platform === 'win32'
    ? ['pty.node', 'conpty.node', 'conpty_console_list.node']
    : platform === 'darwin'
      ? ['pty.node', 'spawn-helper']
      : ['pty.node']
  for (const filename of ptyFiles) writeFixtureFile(resources, `${ptyDirectory}/${filename}`, {
    executable: platform !== 'win32' && filename === 'spawn-helper',
    value: createNativeBinaryFixture(platform, arch),
  })
  writeFixtureFile(resources, platform === 'win32'
    ? `app.asar.unpacked/node_modules/@esbuild/${esbuildPackage}/esbuild.exe`
    : `app.asar.unpacked/node_modules/@esbuild/${esbuildPackage}/bin/esbuild`, {
    executable: platform !== 'win32',
    value: createNativeBinaryFixture(platform, arch),
  })
  if (platform === 'darwin') writeFixtureFile(resources, 'native/TurboFluxComputerHelper', {
    executable: true,
    value: createNativeBinaryFixture(platform, arch),
  })
  return { asarPath, directory, resources }
}

const syntheticRuntimeProbe = () => ({ loadedModules: [], ptyOpenSmoke: false, esbuildVersion: '0.0.0-test' })

function verifyDesktopPackageFixture(fixture: { asarPath: string }, platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64') {
  return verifyDesktopPackage({ asarPath: fixture.asarPath, platform, arch, runtimeProbe: syntheticRuntimeProbe })
}

async function withEnvironment(values: Record<string, string | undefined>, action: () => Promise<unknown>) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function createMacReleaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-mac-release-'))
  const appPath = join(directory, 'TurboFlux.app')
  writeFixtureFile(appPath, 'Contents/Resources/native/TurboFluxComputerHelper')
  return { appPath, directory }
}

describe('Desktop packaging contract', () => {
  it('lets electron-builder resolve production dependencies without copying the entire workspace node_modules tree', () => {
    expect(builderConfig).not.toMatch(/^\s*-\s+node_modules\/\*\*\/\*\*\s*$/mu)
    expect(builderConfig).toContain('!node_modules/pngjs/**/*')
    expect(builderConfig).toContain('!node_modules/**/coverage/**/*')
    expect(desktopPackage.dependencies).toMatchObject({
      '@turboflux/workbench': expect.any(String),
      '@turboflux/remote-protocol': expect.any(String),
      'node-pty': expect.any(String),
      tsx: expect.any(String),
    })
  })

  it('packages the production Main and keeps renderer, mobile, and native assets outside ASAR', () => {
    const [sharedConfig, macConfig] = builderConfig.split('\nmac:\n')
    expect(builderConfig).toContain('- generated/main.mjs')
    expect(builderConfig).toContain('- generated/packagedBootstrap.mjs')
    expect(builderConfig).toContain('- generated/packagedBootstrapRuntime.mjs')
    expect(desktopPackage.main).toBe('generated/packagedBootstrap.mjs')
    expect(builderConfig).toContain('from: ../../dist-desktop/renderer')
    expect(builderConfig).toContain('from: ../remote-mobile/dist')
    expect(sharedConfig).not.toContain('from: generated/native')
    expect(macConfig).toContain('from: generated/native')
  })

  it('builds Swift helper and ICNS assets only on macOS', () => {
    expect(desktopAssetPlan('darwin')).toEqual({ platform: 'darwin', buildsMacAssets: true })
    expect(desktopAssetPlan('win32')).toEqual({ platform: 'win32', buildsMacAssets: false })
    expect(desktopAssetPlan('linux')).toEqual({ platform: 'linux', buildsMacAssets: false })
    const messages: string[] = []
    expect(buildDesktopAssets({ platform: 'win32', output: { write: (message: string) => messages.push(message) } })).toEqual({ platform: 'win32', buildsMacAssets: false })
    expect(messages).toEqual(['TurboFlux Desktop has no generated win32 assets.\n'])
  })

  it('rejects development, credential, runtime, and native evidence paths from release packages', () => {
    for (const path of ['/node_modules/pngjs/package.json', '/node_modules/example/coverage/index.html', '/.env.production', '/nested/.ENV.local', '/electron-user-data/Preferences', '/automation-native-qa/result.json', '/native-events.jsonl', '/system-sleep-log.txt', '/approval-notification-target.png']) {
      expect(desktopPackageForbiddenEntry(path)).toBe(true)
    }
    expect(desktopPackageForbiddenEntry('/node_modules/@turboflux/agent-core/package.json')).toBe(false)
  })

  it.each([
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ] as const)('accepts a complete synthetic %s-%s runtime package', async (platform, arch) => {
    const fixture = await createDesktopPackageFixture(platform, arch)
    try {
      expect(verifyDesktopPackageFixture(fixture, platform, arch)).toMatchObject({
        status: 'passed',
        platform,
        arch,
        remoteMobile: {
          path: platform === 'darwin' ? 'remote-mobile' : 'Resources/remote-mobile',
          bytes: 7,
          fileCount: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      })
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects incomplete node-pty and esbuild native runtime files', async () => {
    const windows = await createDesktopPackageFixture('win32')
    try {
      unlinkSync(join(windows.resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node'))
      expect(() => verifyDesktopPackageFixture(windows, 'win32', 'x64')).toThrow(/missing complete node-pty win32-x64 runtime/u)
    } finally {
      rmSync(windows.directory, { recursive: true, force: true })
    }
    const linux = await createDesktopPackageFixture('linux')
    try {
      unlinkSync(join(linux.resources, 'app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild'))
      expect(() => verifyDesktopPackageFixture(linux, 'linux', 'x64')).toThrow(/missing esbuild linux-x64 runtime/u)
    } finally {
      rmSync(linux.directory, { recursive: true, force: true })
    }
  })

  it('rejects native runtime files whose binary header targets another architecture', async () => {
    const fixture = await createDesktopPackageFixture('win32')
    try {
      writeFixtureFile(fixture.resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node', {
        value: createNativeBinaryFixture('win32', 'arm64'),
      })
      expect(() => verifyDesktopPackageFixture(fixture, 'win32', 'x64')).toThrow(/targets win32-arm64, expected win32-x64/u)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects unsupported target identities before inspecting package paths', () => {
    expect(() => verifyDesktopPackage({ asarPath: '/does/not/matter', platform: 'freebsd', arch: 'x64' })).toThrow(/unsupported package platform/u)
    expect(() => verifyDesktopPackage({ asarPath: '/does/not/matter', platform: 'linux', arch: 'riscv64' })).toThrow(/unsupported package architecture/u)
  })

  it('discovers both Intel and architecture-suffixed native package directories', () => {
    expect(desktopPackagePathMatchesPlatform('/checkout/release/mac/TurboFlux.app/Contents/Resources/app.asar', 'darwin')).toBe(true)
    expect(desktopPackagePathMatchesPlatform('/checkout/release/mac-arm64/TurboFlux.app/Contents/Resources/app.asar', 'darwin')).toBe(true)
    expect(desktopPackagePathMatchesPlatform('C:\\checkout\\release\\win-unpacked\\resources\\app.asar', 'win32')).toBe(true)
    expect(desktopPackagePathMatchesPlatform('/checkout/release/linux-unpacked/resources/app.asar', 'linux')).toBe(true)
    expect(desktopPackagePathMatchesPlatform('/checkout/release/linux-unpacked/resources/app.asar', 'darwin')).toBe(false)
  })

  it('loads the Unix addon, opens and closes a PTY, and executes packaged esbuild', () => {
    const closedDescriptors: number[] = []
    const report = probeDesktopNativeRuntime({
      platform: 'darwin',
      ptyFiles: ['/fixture/pty.node', '/fixture/spawn-helper'],
      esbuildBinary: '/fixture/esbuild',
      esbuildVersion: '1.2.3',
      loadNativeAddon: () => ({
        fork: () => undefined,
        open: () => ({ master: 10, slave: 11, pty: '/dev/ttys-test' }),
        process: () => undefined,
        resize: () => undefined,
      }),
      closeDescriptor: (descriptor: number) => closedDescriptors.push(descriptor),
      runExecutable: () => ({ status: 0, stdout: '1.2.3\n', stderr: '' }),
    })
    expect(report).toMatchObject({ ptyOpenSmoke: true, esbuildVersion: '1.2.3' })
    expect(closedDescriptors).toEqual([10, 11])
    expect(() => probeDesktopNativeRuntime({
      platform: 'darwin',
      ptyFiles: ['/fixture/pty.node'],
      esbuildBinary: '/fixture/esbuild',
      esbuildVersion: '1.2.3',
      loadNativeAddon: () => ({ fork: () => undefined, open: () => undefined, process: () => undefined }),
      runExecutable: () => ({ status: 0, stdout: '1.2.3\n', stderr: '' }),
    })).toThrow(/pty\.node is missing native export: resize/u)
  })

  it('loads every Windows PTY addon and rejects an esbuild version mismatch', () => {
    const exportsByFilename: Record<string, Record<string, () => undefined>> = {
      'pty.node': Object.fromEntries(['startProcess', 'resize', 'kill', 'getExitCode', 'getProcessList'].map(name => [name, () => undefined])),
      'conpty.node': Object.fromEntries(['startProcess', 'connect', 'resize', 'clear', 'kill'].map(name => [name, () => undefined])),
      'conpty_console_list.node': { getConsoleProcessList: () => undefined },
    }
    const options = {
      platform: 'win32',
      ptyFiles: Object.keys(exportsByFilename).map(filename => `/fixture/${filename}`),
      esbuildBinary: '/fixture/esbuild.exe',
      esbuildVersion: '1.2.3',
      loadNativeAddon: (path: string) => exportsByFilename[path.slice(path.lastIndexOf('/') + 1)],
    }
    expect(probeDesktopNativeRuntime({
      ...options,
      runExecutable: () => ({ status: 0, stdout: '1.2.3\r\n', stderr: '' }),
    })).toMatchObject({ ptyOpenSmoke: false, esbuildVersion: '1.2.3' })
    expect(() => probeDesktopNativeRuntime({
      ...options,
      runExecutable: () => ({ status: 0, stdout: '9.9.9\n', stderr: '' }),
    })).toThrow(/packaged esbuild reported 9\.9\.9, expected 1\.2\.3/u)
  })

  it('rejects deeply nested forbidden resources instead of stopping after a fixed depth', async () => {
    const fixture = await createDesktopPackageFixture('darwin', 'arm64')
    try {
      writeFixtureFile(fixture.resources, 'one/two/three/four/five/six/seven/eight/nine/coverage/report.html')
      expect(() => verifyDesktopPackageFixture(fixture, 'darwin', 'arm64')).toThrow(/forbidden packaged resources/u)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links in packaged Resources', async () => {
    const fixture = await createDesktopPackageFixture('darwin', 'arm64')
    try {
      symlinkSync('index.html', join(fixture.resources, 'renderer', 'linked-index.html'))
      expect(() => verifyDesktopPackageFixture(fixture, 'darwin', 'arm64')).toThrow(/packaged Resources contains symbolic link/u)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('makes the standard macOS package command fail closed on signing and notarization', () => {
    expect(desktopPackage.scripts['package:mac']).toContain('verify-desktop-macos-release.mjs --preflight')
    expect(desktopPackage.scripts['package:mac']).toContain('TURBOFLUX_REQUIRE_SIGNING=1')
    expect(desktopPackage.scripts['package:mac']).toContain('TURBOFLUX_REQUIRE_NOTARIZATION=1')
    expect(desktopPackage.scripts['package:mac']).toContain('package:mac:unverified')
    expect(desktopPackage.scripts['package:mac']).toContain('verify:desktop:mac-release')
    expect(rootPackage.scripts['verify:desktop:mac-release']).toBe('node scripts/verify-desktop-macos-release.mjs')
  })

  it('preflights all release credentials without returning their values', () => {
    expect(() => verifyDesktopMacReleaseEnvironment({ platform: 'darwin', environment: {} })).toThrow(/CSC_NAME is required/u)
    expect(() => verifyDesktopMacReleaseEnvironment({
      platform: 'darwin',
      environment: { CSC_NAME: 'Developer ID Application: TurboFlux', APPLE_ID: 'developer@example.invalid' },
    })).toThrow(/APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are required/u)
    expect(verifyDesktopMacReleaseEnvironment({
      platform: 'darwin',
      environment: {
        CSC_NAME: 'Developer ID Application: TurboFlux',
        APPLE_ID: 'developer@example.invalid',
        APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
        APPLE_TEAM_ID: 'TEAM123456',
      },
    })).toEqual({
      schemaVersion: 1,
      status: 'passed',
      platform: 'darwin',
      signingIdentityConfigured: true,
      notarizationCredentialsConfigured: true,
    })
  })

  it('fails before packaging or network access when release credentials are absent or partial', async () => {
    const context = { electronPlatformName: 'darwin', appOutDir: '/unused', packager: { appInfo: { productFilename: 'TurboFlux' } } }
    await expect(withEnvironment({ CSC_NAME: undefined, TURBOFLUX_REQUIRE_SIGNING: '1' }, () => signDesktopHelper(context))).rejects.toThrow(/CSC_NAME is required/u)
    await expect(withEnvironment({
      APPLE_ID: undefined,
      APPLE_APP_SPECIFIC_PASSWORD: undefined,
      APPLE_TEAM_ID: undefined,
      TURBOFLUX_REQUIRE_NOTARIZATION: '1',
    }, () => notarizeDesktop(context))).rejects.toThrow(/are required/u)
    await expect(withEnvironment({
      APPLE_ID: 'developer@example.invalid',
      APPLE_APP_SPECIFIC_PASSWORD: undefined,
      APPLE_TEAM_ID: undefined,
      TURBOFLUX_REQUIRE_NOTARIZATION: undefined,
    }, () => notarizeDesktop(context))).rejects.toThrow(/must be provided together/u)
  })

  it('redacts signing and notarization hook failures', async () => {
    const fixture = createMacReleaseFixture()
    const sensitive = '/Users/runner/private/TurboFlux.app?token=secret'
    const context = { electronPlatformName: 'darwin', appOutDir: fixture.directory, packager: { appInfo: { productFilename: 'TurboFlux' } } }
    try {
      await expect(withEnvironment({
        CSC_NAME: 'Developer ID Application: TurboFlux',
        TURBOFLUX_REQUIRE_SIGNING: '1',
      }, () => signDesktopHelper(context, {
        execFileSync: () => { throw new Error(`codesign failed for ${sensitive}`) },
      }))).rejects.toThrow('TurboFlux Computer helper signing failed')
      await expect(withEnvironment({
        APPLE_ID: 'developer@example.invalid',
        APPLE_APP_SPECIFIC_PASSWORD: 'not-a-real-password',
        APPLE_TEAM_ID: 'TEAM123456',
        TURBOFLUX_REQUIRE_NOTARIZATION: '1',
      }, () => notarizeDesktop(context, {
        notarizeApplication: () => { throw new Error(`notarization failed for ${sensitive}`) },
      }))).rejects.toThrow('TurboFlux Desktop notarization failed')
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('verifies Developer ID, hardened runtime, helper identity, stapling, and Gatekeeper', () => {
    const fixture = createMacReleaseFixture()
    const commands: string[] = []
    try {
      const runCommand = (command: string, args: string[]) => {
        commands.push(`${command} ${args.join(' ')}`)
        if (args[0] === '--display') {
          return 'Authority=Developer ID Application: TurboFlux Test (TEAM123456)\nTeamIdentifier=TEAM123456\nRuntime Version=15.0.0'
        }
        return 'accepted'
      }
      expect(verifyDesktopMacRelease({ appPath: fixture.appPath, platform: 'darwin', runCommand })).toMatchObject({
        status: 'passed',
        appName: 'TurboFlux.app',
        teamIdentifier: 'TEAM123456',
      })
      expect(commands.some(command => command.includes('/usr/bin/xcrun stapler validate'))).toBe(true)
      expect(commands.some(command => command.includes('/usr/sbin/spctl --assess'))).toBe(true)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects a helper signed by a different Developer team', () => {
    const fixture = createMacReleaseFixture()
    try {
      const runCommand = (_command: string, args: string[]) => {
        if (args[0] !== '--display') return 'accepted'
        const team = args.at(-1)?.endsWith('TurboFluxComputerHelper') ? 'OTHERTEAM1' : 'TEAM123456'
        return `Authority=Developer ID Application: TurboFlux Test (${team})\nTeamIdentifier=${team}\nRuntime Version=15.0.0`
      }
      expect(() => verifyDesktopMacRelease({ appPath: fixture.appPath, platform: 'darwin', runCommand })).toThrow(/TeamIdentifier values differ/u)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('redacts local paths and command output from macOS release failures', () => {
    const fixture = createMacReleaseFixture()
    const sensitive = '/Users/runner/private/TurboFlux.app?token=secret'
    try {
      let failure: Error | undefined
      try {
        verifyDesktopMacRelease({
          appPath: fixture.appPath,
          platform: 'darwin',
          runCommand: () => { throw new Error(`codesign failed for ${sensitive}`) },
        })
      } catch (error) {
        failure = error as Error
      }
      expect(failure?.message).toContain('application signature verification failed')
      expect(failure?.message).not.toContain(sensitive)
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('prints only a sanitized release verifier error without a stack trace', () => {
    const verifier = fileURLToPath(new URL('../../scripts/verify-desktop-macos-release.mjs', import.meta.url))
    const sensitive = '/Users/runner/private/TurboFlux.app?token=secret'
    const result = spawnSync(process.execPath, [verifier, `--app=${sensitive}`], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('macOS release verification failed:')
    expect(result.stderr).not.toContain(sensitive)
    expect(result.stderr).not.toContain('verify-desktop-macos-release.mjs:')
  })

  it('verifies every native CI package and uploads reports without application bundles', () => {
    expect(rootPackage.scripts['verify:desktop:package']).toBe(
      'node scripts/verify-desktop-package.mjs --report=apps/desktop/generated/package-verification/package-report.json',
    )
    expect(continuousIntegration).toContain('os: [macos-14, windows-latest, ubuntu-latest]')
    expect(continuousIntegration).toContain('npm run verify:desktop:package -- --report=apps/desktop/generated/package-verification/package-report.json')
    expect(continuousIntegration).toContain('run: npm run package:dir --workspace @turboflux/desktop')
    expect(continuousIntegration).not.toContain('name: desktop-unpacked-')
    expect(continuousIntegration).not.toContain('release/*-unpacked/')
    expect(continuousIntegration).not.toContain('release/mac/')
    expect(continuousIntegration).not.toContain('release/mac-*/')
    expect(continuousIntegration).toContain('name: desktop-package-report-${{ matrix.os }}')
    expect(continuousIntegration).toMatch(/uses: actions\/upload-artifact@v4\n\s+if: always\(\)\n\s+with:\n\s+name: desktop-package-report-/u)
    expect(continuousIntegration).toContain('pattern: desktop-package-report-*')
    expect(continuousIntegration).toContain('run: npm run verify:desktop:package:evidence')
    const packageEvidenceJob = continuousIntegration.slice(
      continuousIntegration.indexOf('  desktop-package-evidence:'),
      continuousIntegration.indexOf('  desktop-remote-evidence:'),
    )
    const packageDownload = packageEvidenceJob.slice(
      packageEvidenceJob.indexOf('- uses: actions/download-artifact@v4'),
      packageEvidenceJob.indexOf('- name: Verify macOS, Windows, and Linux package evidence'),
    )
    expect(packageDownload).toContain('pattern: desktop-package-report-*')
    expect(packageDownload).toContain('path: apps/desktop/generated/package-evidence')
    expect(packageDownload).not.toContain('merge-multiple: true')
  })

  it('writes a sanitized structured report when package verification fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-failure-'))
    const privateAsar = join(root, 'private-workspace-name', 'missing.asar')
    const reportPath = join(root, 'package-report.json')
    const verifier = fileURLToPath(new URL('../../scripts/verify-desktop-package.mjs', import.meta.url))
    try {
      const result = spawnSync(process.execPath, [
        verifier,
        `--asar=${privateAsar}`,
        '--platform=darwin',
        '--arch=arm64',
        `--report=${reportPath}`,
      ], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(report).toEqual({
        schemaVersion: 2,
        status: 'failed',
        platform: 'darwin',
        arch: 'arm64',
        provenance: expect.any(Object),
        failure: {
          code: 'DESKTOP_PACKAGE_VERIFICATION_FAILED',
          message: 'Desktop package verification failed: ASAR does not exist: [PACKAGE]',
        },
      })
      expect(JSON.stringify(report)).not.toContain(root)
      expect(JSON.stringify(report)).not.toContain('private-workspace-name')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts unsafe package diagnostics and provenance before report serialization', () => {
    const sensitive = 'https://private.example/failure?token=secret'
    const sensitivePath = '/Users/runner/private/workflow'
    const report = createDesktopPackageFailureReport(new Error(`packaged esbuild failed: ${sensitive}`), {
      platform: sensitive,
      arch: sensitive,
      environment: {
        GITHUB_SHA: sensitive,
        GITHUB_REPOSITORY: `owner/${sensitive}`,
        GITHUB_WORKFLOW: sensitivePath,
        GITHUB_WORKFLOW_REF: sensitive,
        GITHUB_RUN_ID: sensitive,
        GITHUB_RUN_ATTEMPT: sensitive,
        GITHUB_JOB: sensitive,
        RUNNER_OS: sensitive,
        RUNNER_ARCH: sensitive,
      },
    })
    expect(report).toEqual({
      schemaVersion: 2,
      status: 'failed',
      platform: 'unknown',
      arch: 'unknown',
      provenance: {
        gitCommit: null,
        repository: null,
        workflowName: null,
        workflowRef: null,
        workflowRunId: null,
        workflowRunAttempt: null,
        jobId: null,
        runnerOs: null,
        runnerArch: null,
      },
      failure: {
        code: 'DESKTOP_PACKAGE_VERIFICATION_FAILED',
        message: 'Desktop package verification failed: redacted unsafe diagnostic',
      },
    })
    expect(JSON.stringify(report)).not.toContain(sensitive)
    expect(JSON.stringify(report)).not.toContain(sensitivePath)
  })

  it('writes package reports despite a stale legacy temporary file', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-report-write-'))
    const reportPath = join(root, 'package-report.json')
    const stalePath = `${reportPath}.${process.pid}.tmp`
    try {
      writeFileSync(stalePath, 'stale interrupted write')
      const report = { schemaVersion: 2, status: 'failed', failure: { code: 'TEST', message: 'sanitized' } }
      writeDesktopPackageReport(reportPath, report)
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report)
      expect(readFileSync(stalePath, 'utf8')).toBe('stale interrupted write')
      expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([basename(stalePath)])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
