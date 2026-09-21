import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InstallationProfileRegistry } from './profileRegistry'
import type { LocalProfileRecord, LocalProfileState } from './types'

type LifecycleKind = 'trash' | 'restore'
type LifecyclePhase = 'prepared' | 'registered' | 'moved'

interface LifecycleJournal {
  schemaVersion: 1
  transactionId: string
  kind: LifecycleKind
  phase: LifecyclePhase
  profileId: string
  sourcePath: string
  targetPath: string
  previousState: LocalProfileState
  createdAt: number
  updatedAt: number
}

class SimulatedLifecycleInterruption extends Error {}

export interface ProfileLifecycleCoordinatorOptions {
  registry: InstallationProfileRegistry
  now?: () => number
  createId?: () => string
  faultAfterPhase?: LifecyclePhase
}

export class ProfileLifecycleCoordinator {
  readonly trashRoot: string
  readonly journalRoot: string
  private readonly now: () => number
  private readonly createId: () => string

  constructor(private readonly options: ProfileLifecycleCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.trashRoot = join(options.registry.dataRoot, 'trash')
    this.journalRoot = join(options.registry.dataRoot, 'profile-lifecycle', 'transactions')
  }

  trash(profileId: string): LocalProfileRecord {
    const context = this.options.registry.context(profileId)
    if (this.options.registry.snapshot().activeProfileId === profileId) throw new Error('当前资料不能回收，请先切换到其他资料')
    if (context.profile.state === 'trashed') return context.profile
    const targetPath = join(this.trashRoot, profileId)
    if (existsSync(targetPath)) throw new Error('资料回收区已存在同一资料目录')
    const journal = this.prepare('trash', profileId, context.storage.profileRoot, targetPath, context.profile.state)
    this.afterPhase(journal, 'prepared')
    const profile = this.options.registry.setState(profileId, 'trashed')
    this.updateJournal(journal, 'registered')
    this.afterPhase(journal, 'registered')
    mkdirSync(this.trashRoot, { recursive: true, mode: 0o700 })
    renameSync(journal.sourcePath, journal.targetPath)
    this.updateJournal(journal, 'moved')
    this.afterPhase(journal, 'moved')
    rmSync(context.storage.deviceBoundRoot, { recursive: true, force: true })
    this.finish(journal)
    return profile
  }

  restore(profileId: string): LocalProfileRecord {
    const context = this.options.registry.context(profileId)
    if (context.profile.state !== 'trashed') return context.profile
    const sourcePath = join(this.trashRoot, profileId)
    if (!existsSync(sourcePath)) throw new Error('资料回收区内容不存在，无法恢复')
    if (existsSync(context.storage.profileRoot)) throw new Error('资料目标目录已存在，无法安全恢复')
    const journal = this.prepare('restore', profileId, sourcePath, context.storage.profileRoot, context.profile.state)
    this.afterPhase(journal, 'prepared')
    renameSync(journal.sourcePath, journal.targetPath)
    this.updateJournal(journal, 'moved')
    this.afterPhase(journal, 'moved')
    const profile = this.options.registry.setState(profileId, 'ready')
    this.updateJournal(journal, 'registered')
    this.afterPhase(journal, 'registered')
    this.finish(journal)
    return profile
  }

  recoverTransactions(): Array<{ transactionId: string; outcome: 'committed' | 'rolled_back' }> {
    const outcomes: Array<{ transactionId: string; outcome: 'committed' | 'rolled_back' }> = []
    const entries = existsSync(this.journalRoot) ? readdirSync(this.journalRoot, { withFileTypes: true }) : []
    for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
      const path = join(this.journalRoot, entry.name)
      let journal: LifecycleJournal
      try { journal = JSON.parse(readFileSync(path, 'utf8')) as LifecycleJournal } catch { continue }
      const profile = this.options.registry.snapshot().profiles.find(candidate => candidate.id === journal.profileId)
      if (!profile) continue
      if (journal.kind === 'trash') {
        if (existsSync(journal.targetPath)) {
          if (profile.state !== 'trashed') this.options.registry.setState(profile.id, 'trashed')
          rmSync(this.options.registry.context(profile.id).storage.deviceBoundRoot, { recursive: true, force: true })
          this.finish(journal)
          outcomes.push({ transactionId: journal.transactionId, outcome: 'committed' })
        } else if (existsSync(journal.sourcePath) && profile.state === 'trashed') {
          mkdirSync(dirname(journal.targetPath), { recursive: true, mode: 0o700 })
          renameSync(journal.sourcePath, journal.targetPath)
          rmSync(this.options.registry.context(profile.id).storage.deviceBoundRoot, { recursive: true, force: true })
          this.finish(journal)
          outcomes.push({ transactionId: journal.transactionId, outcome: 'committed' })
        } else {
          this.finish(journal)
          outcomes.push({ transactionId: journal.transactionId, outcome: 'rolled_back' })
        }
        continue
      }
      if (existsSync(journal.targetPath)) {
        if (profile.state === 'trashed') this.options.registry.setState(profile.id, 'ready')
        this.finish(journal)
        outcomes.push({ transactionId: journal.transactionId, outcome: 'committed' })
      } else {
        this.finish(journal)
        outcomes.push({ transactionId: journal.transactionId, outcome: 'rolled_back' })
      }
    }
    return outcomes
  }

  private prepare(kind: LifecycleKind, profileId: string, sourcePath: string, targetPath: string, previousState: LocalProfileState): LifecycleJournal {
    const timestamp = this.now()
    const journal: LifecycleJournal = {
      schemaVersion: 1,
      transactionId: `profile-lifecycle-${this.createId()}`,
      kind,
      phase: 'prepared',
      profileId,
      sourcePath,
      targetPath,
      previousState,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    mkdirSync(this.journalRoot, { recursive: true, mode: 0o700 })
    this.writeJournal(journal)
    return journal
  }

  private updateJournal(journal: LifecycleJournal, phase: LifecyclePhase): void {
    journal.phase = phase
    journal.updatedAt = this.now()
    this.writeJournal(journal)
  }

  private writeJournal(journal: LifecycleJournal): void {
    const path = join(this.journalRoot, `${journal.transactionId}.json`)
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, path)
  }

  private finish(journal: LifecycleJournal): void {
    rmSync(join(this.journalRoot, `${journal.transactionId}.json`), { force: true })
  }

  private afterPhase(journal: LifecycleJournal, phase: LifecyclePhase): void {
    if (this.options.faultAfterPhase === phase) throw new SimulatedLifecycleInterruption(`Simulated profile lifecycle interruption after ${journal.kind}:${phase}`)
  }
}
