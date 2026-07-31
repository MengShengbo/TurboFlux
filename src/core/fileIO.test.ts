import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hashText,
  quarantineCorruptFileSync,
  recoverFilesAtomicSync,
  withFileLockSync,
  writeFilesAtomicSync,
} from './fileIO'

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'turboflux-file-io-'))
  directories.push(directory)
  return directory
}

describe('atomic file transactions', () => {
  it('commits related files and removes the transaction record', () => {
    const directory = temporaryDirectory()
    const first = join(directory, 'first.json')
    const second = join(directory, 'second.json')
    const transaction = join(directory, '.transaction.json')

    writeFilesAtomicSync([
      { filePath: first, content: '{"value":1}', mode: 0o600 },
      { filePath: second, content: '{"value":2}', mode: 0o600 },
    ], transaction)

    expect(readFileSync(first, 'utf-8')).toBe('{"value":1}')
    expect(readFileSync(second, 'utf-8')).toBe('{"value":2}')
    expect(existsSync(transaction)).toBe(false)
  })

  it('finishes an interrupted prepared transaction', () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'config.json')
    const staged = join(directory, '.config.pending.tmp')
    const transaction = join(directory, '.transaction.json')
    writeFileSync(target, 'old', 'utf-8')
    writeFileSync(staged, 'new', 'utf-8')
    writeFileSync(transaction, JSON.stringify({
      version: 1,
      files: [{
        filePath: target,
        tempPath: staged,
        hash: hashText('new'),
      }],
    }), 'utf-8')

    recoverFilesAtomicSync(transaction)

    expect(readFileSync(target, 'utf-8')).toBe('new')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(transaction)).toBe(false)
  })

  it('keeps an unrecoverable transaction for operator recovery', () => {
    const directory = temporaryDirectory()
    const target = join(directory, 'config.json')
    const staged = join(directory, '.missing.pending.tmp')
    const transaction = join(directory, '.transaction.json')
    writeFileSync(target, 'old', 'utf-8')
    writeFileSync(transaction, JSON.stringify({
      version: 1,
      files: [{ filePath: target, tempPath: staged, hash: hashText('new') }],
    }), 'utf-8')

    expect(() => recoverFilesAtomicSync(transaction)).toThrow(/could not recover/)
    expect(readFileSync(target, 'utf-8')).toBe('old')
    expect(existsSync(transaction)).toBe(true)
  })

  it('serializes locked updates and removes the lock', () => {
    const directory = temporaryDirectory()
    const lock = join(directory, '.config.lock')
    const result = withFileLockSync(lock, () => {
      expect(existsSync(lock)).toBe(true)
      return 'saved'
    })

    expect(result).toBe('saved')
    expect(existsSync(lock)).toBe(false)
  })

  it('quarantines malformed data without deleting it', () => {
    const directory = temporaryDirectory()
    const file = join(directory, 'config.json')
    writeFileSync(file, '{broken', 'utf-8')

    const backup = quarantineCorruptFileSync(file)

    expect(existsSync(file)).toBe(false)
    expect(readFileSync(backup, 'utf-8')).toBe('{broken')
  })
})
