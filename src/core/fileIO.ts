import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, promises as fsPromises, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

export function writeFileAtomicSync(filePath: string, content: string, mode?: number): void {
  const directory = dirname(filePath)
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const existingMode = existsSync(filePath) ? statSync(filePath).mode : undefined
  try {
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode: mode ?? existingMode })
    renameSync(tempPath, filePath)
    if (mode !== undefined) {
      if (process.platform === 'win32' && process.env.USERNAME) {
        spawnSync('icacls.exe', [filePath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } else {
        chmodSync(filePath, mode)
      }
    }
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true })
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fsPromises.writeFile(tempPath, content, 'utf-8')
    await fsPromises.rename(tempPath, filePath)
  } finally {
    try { await fsPromises.unlink(tempPath) } catch {}
  }
}
