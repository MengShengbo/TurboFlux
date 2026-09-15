import { chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const helper = join(root, 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  if (existsSync(helper)) {
    const mode = statSync(helper).mode
    if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o111)
  }
}
