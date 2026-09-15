import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptsDirectory, '..')
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const outputDirectory = join(desktopRoot, 'generated')

await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  'packagedBootstrap.mjs',
  'packagedBootstrapRuntime.mjs',
].map(filename => copyFile(join(desktopRoot, filename), join(outputDirectory, filename))))
await build({
  entryPoints: [join(desktopRoot, 'main.mjs')],
  outfile: join(outputDirectory, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  external: ['electron'],
  logLevel: 'info',
})
