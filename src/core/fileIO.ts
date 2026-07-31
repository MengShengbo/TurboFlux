import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  promises as fsPromises,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface AtomicFileWrite {
  filePath: string
  content: string
  mode?: number
}

interface FileTransactionDocument {
  version: 1
  files: Array<{ filePath: string; tempPath: string; hash: string }>
}

export function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function secureFile(filePath: string, mode?: number): void {
  if (mode === undefined) return
  if (process.platform === 'win32' && process.env.USERNAME) {
    const result = spawnSync('icacls.exe', [filePath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], {
      windowsHide: true,
      stdio: 'ignore',
    })
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`icacls exited with status ${result.status}`)
    }
    return
  }
  chmodSync(filePath, mode)
}

function stageFileSync(filePath: string, content: string, mode?: number): string {
  const directory = dirname(filePath)
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const existingMode = existsSync(filePath) ? statSync(filePath).mode : undefined
  let descriptor: number | undefined
  let completed = false
  try {
    descriptor = openSync(tempPath, 'wx', mode ?? existingMode)
    writeFileSync(descriptor, content, 'utf-8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    secureFile(tempPath, mode)
    completed = true
    return tempPath
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (!completed && existsSync(tempPath)) rmSync(tempPath, { force: true })
  }
}

export function writeFileAtomicSync(filePath: string, content: string, mode?: number): void {
  const directory = dirname(filePath)
  let tempPath: string | undefined
  try {
    tempPath = stageFileSync(filePath, content, mode)
    renameSync(tempPath, filePath)
    tempPath = undefined
    syncDirectory(directory)
  } finally {
    if (tempPath && existsSync(tempPath)) rmSync(tempPath, { force: true })
  }
}

export function recoverFilesAtomicSync(transactionPath: string): void {
  if (!existsSync(transactionPath)) return
  const directory = dirname(transactionPath)
  const parsed = JSON.parse(readFileSync(transactionPath, 'utf-8')) as FileTransactionDocument
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`Invalid file transaction: ${transactionPath}`)
  }
  for (const entry of parsed.files) {
    if (dirname(entry.filePath) !== directory || dirname(entry.tempPath) !== directory) {
      throw new Error(`File transaction escapes its directory: ${transactionPath}`)
    }
    if (existsSync(entry.tempPath)) renameSync(entry.tempPath, entry.filePath)
    if (!existsSync(entry.filePath) || hashText(readFileSync(entry.filePath, 'utf-8')) !== entry.hash) {
      throw new Error(`File transaction could not recover ${entry.filePath}`)
    }
  }
  rmSync(transactionPath, { force: true })
  syncDirectory(directory)
}

export function writeFilesAtomicSync(files: AtomicFileWrite[], transactionPath: string): void {
  if (files.length === 0) return
  const directory = dirname(transactionPath)
  if (files.some(file => dirname(file.filePath) !== directory)) {
    throw new Error('Atomic file transactions must stay within one directory')
  }
  recoverFilesAtomicSync(transactionPath)
  const staged: Array<{ filePath: string; tempPath: string; hash: string }> = []
  let prepared = false
  try {
    for (const file of files) {
      staged.push({
        filePath: file.filePath,
        tempPath: stageFileSync(file.filePath, file.content, file.mode),
        hash: hashText(file.content),
      })
    }
    const transaction: FileTransactionDocument = { version: 1, files: staged }
    writeFileAtomicSync(transactionPath, JSON.stringify(transaction, null, 2), 0o600)
    prepared = true
    recoverFilesAtomicSync(transactionPath)
  } finally {
    if (!prepared) {
      for (const entry of staged) {
        if (existsSync(entry.tempPath)) rmSync(entry.tempPath, { force: true })
      }
    }
  }
}

export function withFileLockSync<T>(lockPath: string, callback: () => T, timeoutMs = 5_000): T {
  const startedAt = Date.now()
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      const candidate = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(candidate, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf-8')
        fsyncSync(candidate)
        descriptor = candidate
      } catch (error) {
        closeSync(candidate)
        rmSync(lockPath, { force: true })
        throw error
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST') throw error
      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 30_000) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for file lock: ${lockPath}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try {
    return callback()
  } finally {
    closeSync(descriptor)
    rmSync(lockPath, { force: true })
  }
}

export function quarantineCorruptFileSync(filePath: string): string {
  const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.bak`
  renameSync(filePath, backupPath)
  return backupPath
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined
  try {
    handle = await fsPromises.open(tempPath, 'wx')
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsPromises.rename(tempPath, filePath)
    if (process.platform !== 'win32') {
      const directoryHandle = await fsPromises.open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
  } finally {
    try { await handle?.close() } catch {}
    try { await fsPromises.unlink(tempPath) } catch {}
  }
}
