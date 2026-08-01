#!/usr/bin/env node
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entrypoint = join(repositoryRoot, 'bin', 'turboflux.mjs')
const npmPrefix = process.platform === 'win32'
  ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm prefix -g'], { encoding: 'utf8' }).trim()
  : execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim()
const globalBinDirectory = process.platform === 'win32' ? npmPrefix : join(npmPrefix, 'bin')

if (!existsSync(entrypoint)) {
  throw new Error(`Local CLI entrypoint was not found: ${entrypoint}`)
}

const wrapperPaths = process.platform === 'win32'
  ? [join(globalBinDirectory, 'tf.cmd'), join(globalBinDirectory, 'tf.ps1')]
  : [join(globalBinDirectory, 'tf')]

if (process.argv.includes('--remove')) {
  for (const wrapperPath of wrapperPaths) {
    rmSync(wrapperPath, { force: true })
  }
  console.log(`Removed local tf launcher from ${globalBinDirectory}`)
  process.exit(0)
}

if (process.platform === 'win32') {
  const nodePath = process.execPath
  const escapePowerShell = (value) => value.replaceAll("'", "''")
  writeFileSync(wrapperPaths[0], `@echo off\r\n"${nodePath}" "${entrypoint}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
  writeFileSync(wrapperPaths[1], `& '${escapePowerShell(nodePath)}' '${escapePowerShell(entrypoint)}' @args\r\nexit $LASTEXITCODE\r\n`)
} else {
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(wrapperPaths[0], `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entrypoint)} "$@"\n`)
  chmodSync(wrapperPaths[0], 0o755)
}

console.log(`Linked local dist launcher: tf -> ${entrypoint}`)
