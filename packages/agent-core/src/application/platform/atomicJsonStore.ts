import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AtomicJsonLoadResult<T> {
  value: T
  warnings: string[]
}

export class AtomicJsonStore<T> {
  constructor(
    readonly filePath: string,
    private readonly createDefault: () => T,
    private readonly validate: (value: unknown) => value is T,
  ) {}

  load(): AtomicJsonLoadResult<T> {
    if (!existsSync(this.filePath)) return { value: this.createDefault(), warnings: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!this.validate(parsed)) throw new Error('unsupported schema')
      return { value: parsed, warnings: [] }
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`
      try { renameSync(this.filePath, backupPath) } catch {}
      return {
        value: this.createDefault(),
        warnings: [`Recovered an invalid store at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`],
      }
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }
}
