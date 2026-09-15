import { isAbsolute } from 'node:path'
import { ProfileArchiveError } from './types'

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/u
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu
const ENCODED_TRAVERSAL_PATTERN = /%(?:2e|2f|5c)/iu

export function normalizeArchivePath(value: string): string {
  const normalized = value.normalize('NFC').replaceAll('\\', '/')
  const parts = normalized.split('/')
  const unsafe = !normalized
    || isAbsolute(normalized)
    || normalized.startsWith('//')
    || WINDOWS_DRIVE_PATTERN.test(normalized)
    || ENCODED_TRAVERSAL_PATTERN.test(normalized)
    || CONTROL_CHARACTER_PATTERN.test(normalized)
    || parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/u.test(part) || WINDOWS_RESERVED_NAME_PATTERN.test(part))
  if (unsafe) {
    throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '资料包包含不安全的内部路径。', '请勿导入该文件，并从可信来源重新导出。')
  }
  return parts.join('/')
}

export function assertUniqueArchivePaths(paths: Iterable<string>): void {
  const seen = new Set<string>()
  const portableSeen = new Set<string>()
  for (const path of paths) {
    const normalized = normalizeArchivePath(path)
    const portable = normalized.toLocaleLowerCase('en-US')
    if (seen.has(normalized) || portableSeen.has(portable)) {
      throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '资料包包含重复的内部路径。', '请重新导出资料包。')
    }
    seen.add(normalized)
    portableSeen.add(portable)
  }
}
