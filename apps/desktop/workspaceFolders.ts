import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** Validate the selected directory without opening a runtime or scanning its contents. */
export async function resolveWorkspaceFolder(selectedPath: string): Promise<{ path: string; name: string }> {
  if (!isAbsolute(selectedPath)) throw new Error('请选择有效的本机文件夹。')
  try {
    const path = await realpath(selectedPath)
    if (!(await stat(path)).isDirectory()) throw new Error('所选位置不是文件夹，请重新选择。')
    await access(path, constants.R_OK | constants.W_OK)
    return { path, name: basename(path) || path }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('文件夹已移动或不存在，请重新选择。', { cause: error })
    if (code === 'EACCES' || code === 'EPERM') throw new Error('无法读写此文件夹，请检查系统权限或选择其他文件夹。', { cause: error })
    throw error
  }
}
