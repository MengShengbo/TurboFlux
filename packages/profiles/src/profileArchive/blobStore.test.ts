import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveBlobStore } from './blobStore'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('profile archive content-addressed blobs', () => {
  it('deduplicates identical files by SHA-256 while retaining logical names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-blob-store-'))
    directories.push(root)
    const firstPath = join(root, 'first.txt')
    const secondPath = join(root, 'second.txt')
    writeFileSync(firstPath, 'same content')
    writeFileSync(secondPath, 'same content')
    const store = new ArchiveBlobStore()
    const first = await store.addFile(firstPath, 'first.txt')
    const second = await store.addFile(secondPath, 'second.txt')
    expect(first.digest).toBe(second.digest)
    expect(first.logicalName).toBe('first.txt')
    expect(second.logicalName).toBe('second.txt')
    expect(store.listEntries()).toHaveLength(1)
  })
})
