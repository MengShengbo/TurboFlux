import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopUserProfileStore } from './desktopUserProfile'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'turboflux-personal-')); roots.push(root); return root }

describe('desktop personal identity', () => {
  it('saves a name and avatar independently without creating core profile records', async () => {
    const root = await directory()
    const store = await DesktopUserProfileStore.open(root)
    const avatar = 'data:image/png;base64,iVBORw0KGgo='
    await Promise.all([store.saveName('  小明  '), store.saveAvatar(avatar)])
    const restarted = await DesktopUserProfileStore.open(root)
    expect(restarted.snapshot()).toMatchObject({ displayName: '小明', avatarDataUrl: avatar })
    expect(await readdir(root)).toEqual(['identity.json'])
    expect((await restarted.activity.snapshot()).days).toEqual({})
  })
  it('rejects blank names and unsafe image URLs while preserving saved identity', async () => {
    const store = await DesktopUserProfileStore.open(await directory())
    await store.saveName('小明')
    await expect(store.saveName('   ')).rejects.toThrow()
    await expect(store.saveName('a'.repeat(81))).rejects.toThrow()
    await expect(store.saveAvatar('https://example.com/avatar.png')).rejects.toThrow()
    await expect(store.saveAvatar('data:image/svg+xml,<svg onload="alert(1)">')).rejects.toThrow()
    expect(store.snapshot().displayName).toBe('小明')
  })
})
