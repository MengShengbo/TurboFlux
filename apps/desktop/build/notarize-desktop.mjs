import { notarize } from '@electron/notarize'

export default async function notarizeDesktop(context, options = {}) {
  if (context.electronPlatformName !== 'darwin') return
  const appleId = process.env.APPLE_ID?.trim()
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim()
  const teamId = process.env.APPLE_TEAM_ID?.trim()
  const providedCredentialCount = [appleId, appleIdPassword, teamId].filter(Boolean).length
  if (providedCredentialCount > 0 && providedCredentialCount < 3) {
    throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID must be provided together')
  }
  if (!appleId || !appleIdPassword || !teamId) {
    if (process.env.TURBOFLUX_REQUIRE_NOTARIZATION === '1') throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are required')
    return
  }
  const submit = options.notarizeApplication ?? notarize
  try {
    await submit({
      appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
      appleId,
      appleIdPassword,
      teamId,
    })
  } catch {
    throw new Error('TurboFlux Desktop notarization failed')
  }
}
