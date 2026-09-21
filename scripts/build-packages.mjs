import { spawnSync } from 'node:child_process'
import { orderedPackages } from './workspace-packages.mjs'

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run npm run build:packages from the workspace root.')
for (const { directory, manifest } of orderedPackages()) {
  console.log(`Building ${manifest.name}`)
  const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd: directory, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
