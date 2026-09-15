import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createNodeDeviceIdentity } from './nodeCrypto'
import { type DevicePublicIdentity, type NodeDeviceIdentity, type RemoteCommandResult, type SignedCapabilityGrant } from './types'

export interface PersistedRemotePairing {
  device: DevicePublicIdentity
  grant: SignedCapabilityGrant
  pairedAt: number
}

export interface PersistedRemoteCommand {
  dedupeKey: string
  subjectDeviceId: string
  grantId: string
  commandId: string
  commandHash: string
  status: 'in_progress' | 'completed'
  startedAt: number
  expiresAt: number
  result?: RemoteCommandResult
}

export interface RemoteHostPersistentState {
  schemaVersion: 2
  identity: NodeDeviceIdentity
  pairings: PersistedRemotePairing[]
  commands: PersistedRemoteCommand[]
}

interface StoredRemoteHostState {
  schemaVersion: 1
  protected: boolean
  payload: string
}

export interface NodeRemoteStateStoreOptions {
  protect?: (plaintext: Uint8Array) => Uint8Array
  unprotect?: (ciphertext: Uint8Array) => Uint8Array
}

export class RemoteHostStateUnreadableError extends Error {
  readonly code = 'REMOTE_HOST_STATE_UNREADABLE'
  readonly cause: unknown

  constructor(readonly path: string, cause: unknown) {
    super('Remote host state could not be read')
    this.name = 'RemoteHostStateUnreadableError'
    this.cause = cause
  }
}

function parseState(value: string): StoredRemoteHostState {
  const parsed = JSON.parse(value) as StoredRemoteHostState
  if (parsed.schemaVersion !== 1 || typeof parsed.protected !== 'boolean' || typeof parsed.payload !== 'string') {
    throw new Error('Remote host state has an unsupported format')
  }
  return parsed
}

function parsePayload(value: Uint8Array): RemoteHostPersistentState {
  const parsed = JSON.parse(Buffer.from(value).toString('utf8')) as Partial<RemoteHostPersistentState> & { schemaVersion?: number }
  if (![1, 2].includes(parsed.schemaVersion ?? 0) || !parsed.identity?.publicIdentity?.deviceId || !Array.isArray(parsed.pairings)) {
    throw new Error('Remote host state payload is invalid')
  }
  return {
    schemaVersion: 2,
    identity: parsed.identity,
    pairings: parsed.pairings,
    commands: parsed.schemaVersion === 2 && Array.isArray(parsed.commands) ? parsed.commands : [],
  }
}

function decodePayload(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error('Remote host state payload is not valid base64url')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error('Remote host state payload is not valid base64url')
  return decoded
}

export interface RemoteStateStore {
  loadOrCreate(displayName: string, now?: number): Promise<RemoteHostPersistentState>
  save(state: RemoteHostPersistentState): Promise<void>
}

export class NodeRemoteStateStore {
  constructor(readonly path: string, private readonly options: NodeRemoteStateStoreOptions = {}) {
    if (Boolean(options.protect) !== Boolean(options.unprotect)) throw new Error('Remote state protection requires both protect and unprotect functions')
  }

  async loadOrCreate(displayName: string, now = Date.now()): Promise<RemoteHostPersistentState> {
    try {
      return await this.load()
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      const state: RemoteHostPersistentState = {
        schemaVersion: 2,
        identity: createNodeDeviceIdentity(displayName, now),
        pairings: [],
        commands: [],
      }
      await this.save(state)
      return state
    }
  }

  async load(): Promise<RemoteHostPersistentState> {
    const serialized = await readFile(this.path, 'utf8')
    try {
      const stored = parseState(serialized)
      const encoded = decodePayload(stored.payload)
      if (stored.protected && !this.options.unprotect) throw new Error('Remote host state requires the platform key store')
      const plaintext = stored.protected ? this.options.unprotect!(encoded) : encoded
      return parsePayload(plaintext)
    } catch (error) {
      throw new RemoteHostStateUnreadableError(this.path, error)
    }
  }

  async save(state: RemoteHostPersistentState): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8')
    const protectedPayload = this.options.protect ? this.options.protect(plaintext) : plaintext
    const stored: StoredRemoteHostState = {
      schemaVersion: 1,
      protected: Boolean(this.options.protect),
      payload: Buffer.from(protectedPayload).toString('base64url'),
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(stored), { encoding: 'utf8' })
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.path)
      await this.syncParentDirectory()
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async syncParentDirectory(): Promise<void> {
    let directory
    try {
      directory = await open(dirname(this.path), 'r')
      await directory.sync()
    } catch {} finally {
      await directory?.close().catch(() => undefined)
    }
  }
}
