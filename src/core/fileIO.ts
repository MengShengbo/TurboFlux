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
import { basename, dirname, join, resolve } from 'node:path'
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

interface HeldFileLock {
  descriptor: number
  depth: number
}

const heldFileLocks = new Map<string, HeldFileLock>()
const LOCK_STALE_AFTER_MS = 30_000
const LOCK_OWNER_GRACE_MS = 1_000

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
    if (basename(filePath).toLowerCase() !== 'credentials.json') {
      chmodSync(filePath, mode)
      return
    }
    chmodSync(filePath, mode)
    const args = [filePath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]
    if (process.env.TURBOFLUX_STRICT_FILE_PERMISSIONS === '1') {
      const result = spawnSync('icacls.exe', args, { windowsHide: true, stdio: 'ignore' })
      if (result.error || result.status !== 0) {
        throw result.error ?? new Error(`icacls exited with status ${result.status}`)
      }
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
    secureFile(filePath, mode)
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
    for (const file of files) secureFile(file.filePath, file.mode)
  } finally {
    if (!prepared) {
      for (const entry of staged) {
        if (existsSync(entry.tempPath)) rmSync(entry.tempPath, { force: true })
      }
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return code === 'EPERM'
  }
}

function shouldRemoveLock(lockPath: string, now: number): boolean {
  let age = LOCK_STALE_AFTER_MS
  try {
    age = now - statSync(lockPath).mtimeMs
  } catch {
    return false
  }
  if (age >= LOCK_STALE_AFTER_MS) return true
  if (age < LOCK_OWNER_GRACE_MS) return false
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown }
    const pid = typeof raw.pid === 'number' ? raw.pid : Number(raw.pid)
    return !processIsAlive(pid)
  } catch {
    return false
  }
}

export function withFileLockSync<T>(lockPath: string, callback: () => T, timeoutMs = 5_000): T {
  const normalizedLockPath = resolve(lockPath)
  const held = heldFileLocks.get(normalizedLockPath)
  if (held) {
    held.depth += 1
    try {
      return callback()
    } finally {
      held.depth -= 1
    }
  }

  const startedAt = Date.now()
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      const candidate = openSync(normalizedLockPath, 'wx', 0o600)
      try {
        writeFileSync(candidate, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf-8')
        descriptor = candidate
      } catch (error) {
        closeSync(candidate)
        rmSync(lockPath, { force: true })
        throw error
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST') throw error
      const now = Date.now()
      if (existsSync(normalizedLockPath) && shouldRemoveLock(normalizedLockPath, now)) {
        rmSync(normalizedLockPath, { force: true })
        continue
      }
      if (now - startedAt >= timeoutMs) throw new Error(`Timed out waiting for file lock: ${normalizedLockPath}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  heldFileLocks.set(normalizedLockPath, { descriptor, depth: 1 })
  try {
    return callback()
  } finally {
    heldFileLocks.delete(normalizedLockPath)
    closeSync(descriptor)
    rmSync(normalizedLockPath, { force: true })
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
    let existingMode: number | undefined
    try {
      existingMode = (await fsPromises.stat(filePath)).mode
    } catch {}
    handle = await fsPromises.open(tempPath, 'wx', existingMode)
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
