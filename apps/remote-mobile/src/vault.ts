import type { PairedRemoteClientState } from '@turboflux/remote-protocol/browser'

export interface SavedRemoteConnection {
  state: PairedRemoteClientState
  endpoint: string
}

interface EncryptedRemoteConnection {
  schemaVersion: 2
  iv: string
  ciphertext: string
}

const DATABASE_NAME = 'turboflux-remote'
const STORE_NAME = 'private-state'
const CONNECTION_KEY = 'active-connection'
const WRAPPING_KEY = 'local-wrapping-key'

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readValue<T>(key: string): Promise<T | undefined> {
  const db = await database()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function writeValue(key: string, value: unknown): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('Remote key storage transaction was aborted'))
    })
  } finally {
    db.close()
  }
}

async function wrappingKey(): Promise<CryptoKey> {
  const existing = await readValue<CryptoKey>(WRAPPING_KEY)
  if (existing) return existing
  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await writeValue(WRAPPING_KEY, created)
  return created
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer
}

function isConnection(value: unknown): value is SavedRemoteConnection {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SavedRemoteConnection>
  return typeof candidate.endpoint === 'string' && candidate.state?.schemaVersion === 1
}

export async function loadConnection(): Promise<SavedRemoteConnection | undefined> {
  const stored = await readValue<EncryptedRemoteConnection | SavedRemoteConnection>(CONNECTION_KEY)
  if (!stored) return undefined
  if (isConnection(stored)) {
    await saveConnection(stored)
    return structuredClone(stored)
  }
  if (stored.schemaVersion !== 2 || typeof stored.iv !== 'string' || typeof stored.ciphertext !== 'string') {
    throw new Error('Saved remote connection has an unsupported format')
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64Url(stored.iv) },
    await wrappingKey(),
    decodeBase64Url(stored.ciphertext),
  )
  const connection = JSON.parse(new TextDecoder().decode(plaintext)) as SavedRemoteConnection
  if (!isConnection(connection)) throw new Error('Saved remote connection is invalid')
  return connection
}

export async function saveConnection(connection: SavedRemoteConnection): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await wrappingKey(),
    new TextEncoder().encode(JSON.stringify(connection)),
  )
  await writeValue(CONNECTION_KEY, {
    schemaVersion: 2,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  } satisfies EncryptedRemoteConnection)
}

export async function clearConnection(): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      store.delete(CONNECTION_KEY)
      store.delete(WRAPPING_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('Remote key deletion was aborted'))
    })
  } finally {
    db.close()
  }
}
