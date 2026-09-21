import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkspaceFolder } from './workspaceFolders'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'turboflux-workspace-'))
  directories.push(root)
  return root
}

describe('workspace folder selection', () => {
  it('returns a ready directory, including names containing spaces and non-ASCII characters', async () => {
    const root = await fixture()
    const folder = join(root, '我的 项目')
    await mkdir(folder)
    expect(await resolveWorkspaceFolder(folder)).toEqual({ path: await realpath(folder), name: '我的 项目' })
  })

  it('resolves aliases to the same folder so selecting an alias cannot create a duplicate', async () => {
    const root = await fixture()
    const folder = join(root, 'project')
    const alias = join(root, 'alias')
    await mkdir(folder)
    await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await resolveWorkspaceFolder(alias)).toEqual(await resolveWorkspaceFolder(folder))
  })

  it('reports a removed folder and a file selection with actionable errors', async () => {
    const root = await fixture()
    const file = join(root, 'document.txt')
    await writeFile(file, 'hello')
    await expect(resolveWorkspaceFolder(join(root, 'missing'))).rejects.toThrow('文件夹已移动或不存在')
    await expect(resolveWorkspaceFolder(file)).rejects.toThrow('所选位置不是文件夹')
    await expect(resolveWorkspaceFolder('relative/path')).rejects.toThrow('请选择有效的本机文件夹')
  })
})
