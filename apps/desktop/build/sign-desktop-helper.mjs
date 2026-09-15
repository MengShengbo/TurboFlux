import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export default async function signDesktopHelper(context, options = {}) {
  if (context.electronPlatformName !== 'darwin') return
  const identity = process.env.CSC_NAME?.trim()
  if (!identity) {
    if (process.env.TURBOFLUX_REQUIRE_SIGNING === '1') throw new Error('CSC_NAME is required for a signed TurboFlux release')
    return
  }
  const helper = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'native', 'TurboFluxComputerHelper')
  if (!existsSync(helper)) throw new Error('TurboFlux Computer helper is missing')
  const execute = options.execFileSync ?? execFileSync
  try {
    execute('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, helper], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('TurboFlux Computer helper signing failed')
  }
}
