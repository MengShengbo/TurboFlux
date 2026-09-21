import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
for (const asset of manifest.turboflux?.runtimeAssets || []) {
  const target = resolve('dist', asset)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(resolve('src', asset), target)
}
