import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { repositoryRoot } from './workspace-packages.mjs'

const output = resolve(process.env.TURBOFLUX_RENDERER_QA_DIR || join(repositoryRoot, 'apps/desktop/generated/renderer-engine-qa'))
mkdirSync(output, { recursive: true })
await build({ entryPoints: [join(repositoryRoot, 'scripts/renderer-browser-qa.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: join(output, 'qa.js') })
copyFileSync(join(repositoryRoot, 'apps/desktop/renderer/styles.css'), join(output, 'styles.css'))
writeFileSync(join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="styles.css"><style>body{padding:48px;background:#141414}#transcript{height:auto;max-width:880px;margin:auto;overflow:visible}</style></head><body><div id="transcript"></div><script src="qa.js"></script></body></html>')
const require = createRequire(join(repositoryRoot, 'package.json'))
const result = spawnSync(require('electron'), [
  ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  join(repositoryRoot, 'scripts/renderer-browser-qa.mjs'),
], { stdio: 'inherit', timeout: 30_000, env: { ...process.env, TURBOFLUX_RENDERER_QA_DIR: output } })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
