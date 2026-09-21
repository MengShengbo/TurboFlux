import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DesktopUserProfile } from './desktopTypes'
import { UserActivityStore } from './userActivity'

/** Desktop identity belongs to this installation, independently of core profile storage. */
export class DesktopUserProfileStore {
  readonly activity: UserActivityStore
  private identity: DesktopUserProfile = { displayName: '新朋友', updatedAt: Date.now() }
  private writes = Promise.resolve()

  private constructor(private readonly root: string) {
    this.activity = new UserActivityStore(join(root, 'token-activity.json'))
  }

  static async open(root: string): Promise<DesktopUserProfileStore> {
    const store = new DesktopUserProfileStore(root)
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      const saved = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8')) as DesktopUserProfile & { version: number }
      if (saved.version !== 1 || typeof saved.displayName !== 'string' || !saved.displayName.trim()
        || saved.displayName.length > 80 || !Number.isFinite(saved.updatedAt)
        || (saved.avatarDataUrl !== undefined && !store.validAvatar(saved.avatarDataUrl))) {
        throw new Error('个人资料文件格式无效')
      }
      store.identity = { displayName: saved.displayName, avatarDataUrl: saved.avatarDataUrl, updatedAt: saved.updatedAt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await store.activity.load()
    return store
  }

  snapshot(): DesktopUserProfile { return { ...this.identity } }

  saveName(value: unknown): Promise<DesktopUserProfile> {
    if (typeof value !== 'string') return Promise.reject(new Error('请输入名称'))
    const displayName = value.trim().replace(/\s+/gu, ' ')
    if (!displayName || displayName.length > 80) return Promise.reject(new Error('名称需要包含 1 到 80 个字符'))
    return this.save({ displayName })
  }

  saveAvatar(avatarDataUrl: string): Promise<DesktopUserProfile> {
    if (!this.validAvatar(avatarDataUrl)) return Promise.reject(new Error('头像图片无效'))
    return this.save({ avatarDataUrl })
  }

  private validAvatar(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 1_048_576 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(value)
  }

  private save(patch: Partial<DesktopUserProfile>): Promise<DesktopUserProfile> {
    const operation = this.writes.then(async () => {
      const next = { ...this.identity, ...patch, updatedAt: Date.now() }
      const destination = join(this.root, 'identity.json')
      const temporary = `${destination}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { mode: 0o600 })
      await rename(temporary, destination)
      this.identity = next
    })
    this.writes = operation.catch(() => undefined)
    return operation.then(() => this.snapshot())
  }
}
