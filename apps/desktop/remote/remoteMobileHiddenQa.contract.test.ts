import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const parent = readFileSync(new URL('../../../scripts/remote-mobile-hidden-qa.ts', import.meta.url), 'utf8')
const electron = readFileSync(new URL('../../../scripts/remote-mobile-hidden-qa-electron.mjs', import.meta.url), 'utf8')
const verifier = readFileSync(new URL('../../../scripts/verify-remote-mobile-evidence.mjs', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')

describe('Remote Mobile hidden Electron acceptance contract', () => {
  it('uses the real encrypted Desktop approval and control path without focusing a window', () => {
    expect(parent).toContain('DesktopRemoteHostManager')
    expect(parent).toContain("argument === '--package-correlated'")
    expect(parent).toContain('discoverPackagedExecutable')
    expect(parent).toContain('verifyPackagedExecutableIdentity')
    expect(parent).toContain('remoteMobileRoot: mobileWebRoot')
    expect(parent).toContain("hostApplicationMode: 'development-electron'")
    expect(parent).toContain('packageEvidence: verifiedPackage')
    expect(parent).toContain('manager.approvePairing(pending.requestId)')
    expect(parent).toContain('requestedDeviceId: approvedPairing.deviceId')
    expect(parent).toContain('controlClientInstanceId: controlSession.clientInstanceId')
    expect(parent).toContain('resolution: runtime.resolvedApprovals[0]')
    expect(parent).toContain('artifactReadIds: runtime.artifactReadIds')
    expect(parent).toContain('mobileWebRoot')
    expect(parent).toContain('windowsHide: true')
    expect(parent).toContain('await waitForExit(child, 5_000)')
    expect(parent).toContain('rm(rendererResultPath, { force: true })')
    expect(parent).toContain('rm(diagnosticPath, { force: true })')
    expect(parent).toContain('maxRetries: 5, retryDelay: 50')
    expect(parent).toContain("resolve(process.argv[1]) === fileURLToPath(import.meta.url)")
    expect(parent).toContain('writeSourceEvidenceReportAtomically')
    expect(parent).toContain('projectEvidenceFields(rendererResult, rendererEvidenceSchema)')
    expect(parent).toContain('TURBOFLUX_REMOTE_MOBILE_QA_TEMP: rendererTemporaryRoot')
    expect(parent).toContain("process.stderr.write('Remote Mobile hidden QA failed\\n')")
    expect(parent).not.toContain('...rendererResult')
    expect(parent).not.toContain('output.join')
    expect(parent).not.toContain('remote-mobile-evidence-report-${process.platform}')
    expect(electron).toContain('show: false')
    expect(electron).toContain("app.dock?.hide()")
    expect(electron).toContain('workspace.hasFocus === false && !window.isFocused()')
    expect(electron).not.toContain('.show()')
    expect(electron).not.toContain('.focus()')
    expect(electron).toContain("writeEvidenceFileAtomically(path, Buffer.from(screenshot.data, 'base64'))")
    expect(electron).not.toContain('writeFile(path,')
    expect(electron).toContain('return filename')
    expect(electron).not.toContain('location.href')
    expect(electron).not.toContain("document.body?.innerText?.slice")
    expect(electron).toContain('rendererErrorCount: rendererErrors.length')
    expect(electron).toContain("element.textContent?.trim() === '仅这次允许'")
    expect(electron).toContain("document.querySelector('.artifact-card')")
    expect(electron).toContain("session.once('will-download'")
    expect(electron).toContain('event.preventDefault()')
    expect(electron).toContain("join(temporaryEvidenceRoot, 'renderer-result.json')")
    expect(electron).toContain("join(temporaryEvidenceRoot, 'diagnostic.json')")
  })

  it('requires 390x844 workspace, approval, drawer, themes, and non-uniform screenshots', () => {
    for (const evidence of [
      'remote-mobile-workspace-light',
      'remote-mobile-session-drawer-light',
      'remote-mobile-workspace-dark-reduced-motion',
      'workspace.viewport.width === 390 && workspace.viewport.height === 844',
      "workspace.text?.includes('仅这次允许')",
      "document.querySelector('#sessions-toggle')?.click()",
      "getBoundingClientRect().right <= 0.5",
      "name: 'prefers-reduced-motion', value: 'reduce'",
    ]) expect(electron).toContain(evidence)
    expect(verifier).toContain('metrics.dominantColorShare <= 0.97')
    expect(verifier).toContain('pairing, paired-device, and control-session identities do not match')
    expect(verifier).toContain('approval was not resolved by the authenticated remote control device')
    expect(verifier).toContain('approval and artifact do not belong to the same automation Run')
    expect(verifier).toContain('correlatePackagedApplicationEvidence')
    expect(verifier).toContain('requireRemoteMobileSha256: true')
    expect(verifier).toContain('package evidence root is required when Remote package correlation is required')
    expect(workflow).toContain('npm run qa:remote:hidden')
    expect(workflow).toContain('npm run qa:remote:hidden -- --package-correlated')
    expect(workflow).toContain('npm run verify:remote:evidence')
  })
})
