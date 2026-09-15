import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyDesktopPackageEvidence } from '../../scripts/verify-desktop-package-evidence.mjs'

const digest = 'a'.repeat(64)

beforeEach(() => vi.stubEnv('GITHUB_ACTIONS', 'false'))
afterEach(() => vi.unstubAllEnvs())

function packagePath(platform: 'darwin' | 'linux' | 'win32') {
  if (platform === 'darwin') return 'release/mac-arm64/TurboFlux.app'
  return `release/${platform === 'win32' ? 'win' : 'linux'}-unpacked`
}

function runtimeFiles(platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64') {
  const target = `${platform}-${arch}`
  const root = platform === 'darwin' ? 'Contents/Resources' : 'resources'
  const ptyRoot = `${root}/app.asar.unpacked/node_modules/node-pty/prebuilds/${platform}-${arch}`
  const esbuild = platform === 'win32'
    ? `${root}/app.asar.unpacked/node_modules/@esbuild/${platform}-${arch}/esbuild.exe`
    : `${root}/app.asar.unpacked/node_modules/@esbuild/${platform}-${arch}/bin/esbuild`
  const paths = platform === 'win32'
    ? [`${ptyRoot}/pty.node`, `${ptyRoot}/conpty.node`, `${ptyRoot}/conpty_console_list.node`, esbuild]
    : platform === 'darwin'
      ? [`${ptyRoot}/pty.node`, `${ptyRoot}/spawn-helper`, esbuild]
      : [`${ptyRoot}/pty.node`, esbuild]
  if (platform === 'darwin') paths.push(`${root}/native/TurboFluxComputerHelper`)
  return paths.map(path => ({ path, bytes: 1024, sha256: digest, targets: [target] }))
}

function loadedModules(platform: 'darwin' | 'linux' | 'win32') {
  if (platform !== 'win32') return [{ filename: 'pty.node', exports: ['fork', 'open', 'process', 'resize'] }]
  return [
    { filename: 'pty.node', exports: ['startProcess', 'resize', 'kill', 'getExitCode', 'getProcessList'] },
    { filename: 'conpty.node', exports: ['startProcess', 'connect', 'resize', 'clear', 'kill'] },
    { filename: 'conpty_console_list.node', exports: ['getConsoleProcessList'] },
  ]
}

function validPackageReport(platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64') {
  return {
    schemaVersion: 2,
    status: 'passed',
    platform,
    arch,
    provenance: {
      gitCommit: 'b'.repeat(40),
      repository: 'TurboFlux/TurboFlux',
      workflowName: 'CI',
      workflowRef: 'TurboFlux/TurboFlux/.github/workflows/ci.yml@refs/heads/main',
      workflowRunId: '123456',
      workflowRunAttempt: 1,
      jobId: 'desktop-package',
      runnerOs: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform],
      runnerArch: arch === 'arm64' ? 'ARM64' : 'X64',
    },
    packagePath: packagePath(platform),
    package: { bytes: 100_000, entryCount: 20, fileCount: 10, symlinkCount: platform === 'darwin' ? 2 : 0, sha256: digest },
    asar: { path: platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar', bytes: 50_000, entryCount: 100, sha256: digest },
    remoteMobile: { path: platform === 'darwin' ? 'Contents/Resources/remote-mobile' : 'resources/remote-mobile', bytes: 25_000, fileCount: 5, sha256: digest },
    resources: { fileCount: 8 },
    runtimeFiles: runtimeFiles(platform, arch),
    nativeRuntimeProbe: { loadedModules: loadedModules(platform), ptyOpenSmoke: platform !== 'win32', esbuildVersion: '0.28.2' },
  }
}

function failedPackageReport(platform: 'darwin' | 'linux' | 'win32', arch: 'arm64' | 'x64', message = 'Desktop package verification failed: missing required runtime') {
  const valid = validPackageReport(platform, arch)
  return {
    schemaVersion: 2,
    status: 'failed',
    platform,
    arch,
    provenance: valid.provenance,
    failure: { code: 'DESKTOP_PACKAGE_VERIFICATION_FAILED', message },
  }
}

function writeReport(root: string, name: string, report: unknown) {
  const path = join(root, name, 'package-report.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
}

function writeCompleteEvidence(root: string) {
  writeReport(root, 'macos', validPackageReport('darwin', 'arm64'))
  writeReport(root, 'windows', validPackageReport('win32', 'x64'))
  writeReport(root, 'linux', validPackageReport('linux', 'x64'))
}

describe('Desktop package cross-platform evidence verifier', () => {
  it('accepts exactly one same-run report for macOS, Windows, and Linux', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    const reportPath = join(root, 'aggregate.json')
    try {
      writeCompleteEvidence(root)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root, reportPath })
      expect(report).toMatchObject({
        schemaVersion: 2,
        status: 'passed',
        requiredPlatforms: ['darwin', 'win32', 'linux'],
        provenance: { workflowRunId: '123456', jobId: 'desktop-package' },
        artifacts: expect.arrayContaining([expect.objectContaining({ platform: 'darwin', packageSha256: digest, asarSha256: digest, remoteMobileSha256: digest })]),
      })
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ schemaVersion: 2, status: 'passed' })
      const repeatedReport = await verifyDesktopPackageEvidence({ evidenceRoot: root, reportPath })
      expect(repeatedReport.status).toBe('passed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails when a required native platform report is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeReport(root, 'macos', validPackageReport('darwin', 'arm64'))
      writeReport(root, 'linux', validPackageReport('linux', 'x64'))
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('win32: expected exactly one package report, found 0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects missing or invalid packaged Remote Mobile resource evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const windows = validPackageReport('win32', 'x64')
      windows.remoteMobile.sha256 = 'invalid'
      writeReport(root, 'windows', windows)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('win32-x64/package-report.json: remoteMobile.sha256 is invalid')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects platform packages built from different Remote Mobile bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const windows = validPackageReport('win32', 'x64')
      windows.remoteMobile.sha256 = 'c'.repeat(64)
      writeReport(root, 'windows', windows)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('all package reports must share one Remote Mobile SHA-256')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves a same-run platform failure as explicit aggregate evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      writeReport(root, 'windows', failedPackageReport('win32', 'x64'))
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('win32-x64/package-report.json: package verification failed (DESKTOP_PACKAGE_VERIFICATION_FAILED): Desktop package verification failed: missing required runtime')
      expect(report.errors).not.toContain('win32: expected exactly one package report, found 0')
      expect(report.artifacts).toContainEqual(expect.objectContaining({ platform: 'win32', arch: 'x64', status: 'failed' }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects failure diagnostics containing local paths or extra fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      writeReport(root, 'windows', {
        ...failedPackageReport('win32', 'x64', 'failed at C:\\Users\\runner\\private\\app.asar'),
        debugEnvironment: { secret: 'must-not-pass' },
      })
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('failure report fields must be exactly'),
        expect.stringContaining('failure.message is invalid or contains a local path'),
      ]))
      expect(report.errors.join('\n')).not.toContain('C:\\Users\\runner\\private\\app.asar')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts failure URLs and secret assignments from aggregate diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const sensitive = 'https://private.example/failure?token=secret'
      writeReport(root, 'windows', failedPackageReport('win32', 'x64', sensitive))
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('win32-x64/package-report.json: package verification failed (redacted invalid failure)')
      expect(JSON.stringify(report)).not.toContain(sensitive)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts unsupported identity, provenance, and module filenames from aggregate artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const sensitive = 'https://private.example/?token=secret'
      const candidate = validPackageReport('linux', 'x64')
      Object.assign(candidate, { platform: sensitive, arch: sensitive })
      candidate.provenance.workflowName = sensitive
      candidate.nativeRuntimeProbe.loadedModules[0]!.filename = sensitive
      writeReport(root, 'linux', candidate)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.artifacts).toContainEqual(expect.objectContaining({ path: 'untrusted/package-report.json', platform: 'unknown', arch: 'unknown' }))
      expect(JSON.stringify(report)).not.toContain(sensitive)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts malformed package report contents from aggregate diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      writeFileSync(join(root, 'windows', 'package-report.json'), 'C:\\Users\\runner\\private\\package-report.json?token=secret')
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('untrusted/package-report.json: invalid package report (invalid-json)')
      expect(report.errors.join('\n')).not.toContain('C:\\Users\\runner\\private')
      expect(report.errors.join('\n')).not.toContain('token=secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects reports mixed across workflow runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const windows = validPackageReport('win32', 'x64')
      windows.provenance.workflowRunId = '999999'
      writeReport(root, 'windows', windows)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('all package reports must share one workflowRunId')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects reports that do not belong to the current workflow run or source job', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const report = await verifyDesktopPackageEvidence({
        evidenceRoot: root,
        expectedSourceJob: 'trusted-package-job',
        expectedProvenance: {
          gitCommit: 'c'.repeat(40),
          repository: 'TurboFlux/TurboFlux',
          workflowName: 'CI',
          workflowRef: 'TurboFlux/TurboFlux/.github/workflows/ci.yml@refs/heads/main',
          workflowRunId: '123456',
          workflowRunAttempt: 1,
        },
      })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('all package reports must come from job trusted-package-job')
      expect(report.errors.some(error => error.includes('provenance.gitCommit does not match the current workflow run'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unexpected files in the downloaded evidence tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      writeFileSync(join(root, 'untrusted.txt'), 'unexpected')
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('unexpected file in package evidence root')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects nested package reports instead of recursively trusting them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const nestedReportPath = join(root, 'macos', 'nested', 'package-report.json')
      mkdirSync(dirname(nestedReportPath), { recursive: true })
      writeFileSync(nestedReportPath, `${JSON.stringify(validPackageReport('darwin', 'arm64'))}\n`)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toEqual(expect.arrayContaining([
        'package artifact must contain exactly one package-report.json file',
        'package artifact contains a nested directory',
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects empty package artifact directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      mkdirSync(join(root, 'empty-artifact'))
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('package artifact must contain exactly one package-report.json file')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects extra files inside package artifact directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      writeFileSync(join(root, 'linux', 'debug.log'), 'must not be trusted')
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toEqual(expect.arrayContaining([
        'package artifact must contain exactly one package-report.json file',
        'package artifact contains an unexpected entry',
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links inside package artifact directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      symlinkSync('package-report.json', join(root, 'windows', 'linked-report.json'))
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors).toEqual(expect.arrayContaining([
        'package artifact must contain exactly one package-report.json file',
        'package artifact contains a symbolic link',
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('replaces an aggregate report symlink without writing through it', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-parent-'))
    const root = join(parent, 'evidence')
    const outside = join(parent, 'outside.json')
    const reportPath = join(root, 'aggregate.json')
    try {
      mkdirSync(root)
      writeCompleteEvidence(root)
      writeFileSync(outside, 'outside must remain unchanged')
      symlinkSync(outside, reportPath)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root, reportPath })
      expect(report.status).toBe('failed')
      expect(report.errors).toContain('symbolic links are not allowed in package evidence root')
      expect(readFileSync(outside, 'utf8')).toBe('outside must remain unchanged')
      expect(lstatSync(reportPath).isFile()).toBe(true)
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ schemaVersion: 2, status: 'failed' })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('writes a failed aggregate report when the evidence root does not exist', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-parent-'))
    const root = join(parent, 'missing-evidence')
    const reportPath = join(root, 'aggregate.json')
    try {
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root, reportPath })
      expect(report.status).toBe('failed')
      expect(report.errors).toEqual(expect.arrayContaining([
        'darwin: expected exactly one package report, found 0',
        'win32: expected exactly one package report, found 0',
        'linux: expected exactly one package report, found 0',
      ]))
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ schemaVersion: 2, status: 'failed', artifacts: [] })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects unknown fields, unsafe paths, and wrong native targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-package-evidence-'))
    try {
      writeCompleteEvidence(root)
      const linux = { ...validPackageReport('linux', 'x64'), unexpected: true }
      linux.packagePath = '../../outside'
      linux.runtimeFiles[0].targets = ['darwin-arm64']
      writeReport(root, 'linux', linux)
      const report = await verifyDesktopPackageEvidence({ evidenceRoot: root })
      expect(report.status).toBe('failed')
      expect(report.errors.some(error => error.includes('report fields must be exactly'))).toBe(true)
      expect(report.errors.some(error => error.includes('invalid packagePath'))).toBe(true)
      expect(report.errors.some(error => error.includes('targets must be linux-x64'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
