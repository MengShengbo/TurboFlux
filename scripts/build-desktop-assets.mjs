import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function desktopAssetPlan(platform = process.platform) {
  return { platform, buildsMacAssets: platform === 'darwin' }
}

export function buildDesktopAssets(options = {}) {
  const plan = desktopAssetPlan(options.platform)
  const output = options.output ?? process.stdout
  if (!plan.buildsMacAssets) {
    output.write(`TurboFlux Desktop has no generated ${plan.platform} assets.\n`)
    return plan
  }
  const desktop = join(root, 'apps', 'desktop')
  const generated = join(desktop, 'generated')
  const iconset = join(generated, 'TurboFlux.iconset')
  const sourceIcon = join(desktop, 'build', 'turboflux-app-icon.png')
  const helperSource = join(desktop, 'computer', 'native', 'TurboFluxComputerHelper.swift')
  const helperDirectory = join(generated, 'native')
  mkdirSync(iconset, { recursive: true })
  mkdirSync(helperDirectory, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), sourceIcon, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
    execFileSync('/usr/bin/sips', ['-z', String(size * 2), String(size * 2), sourceIcon, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(generated, 'TurboFlux.icns')], { stdio: 'inherit' })
  execFileSync('/usr/bin/xcrun', [
    'swiftc', '-O', '-framework', 'AppKit', '-framework', 'ApplicationServices', helperSource,
    '-o', join(helperDirectory, 'TurboFluxComputerHelper'),
  ], { stdio: 'inherit' })
  rmSync(iconset, { recursive: true, force: true })
  output.write('TurboFlux Desktop build assets are ready.\n')
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildDesktopAssets()
