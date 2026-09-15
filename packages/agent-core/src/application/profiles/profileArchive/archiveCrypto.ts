import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import type { ProfileArchiveContainerHeaderV1 } from './types'

const SCRYPT_COST = 32_768
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const KEY_LENGTH = 32

function scryptKey(password: Uint8Array, salt: Uint8Array, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export interface ArchiveEncryptionMaterial {
  header: Pick<ProfileArchiveContainerHeaderV1, 'kdf' | 'cipher'>
  key: Buffer
}

export async function createArchiveEncryption(password: Uint8Array): Promise<ArchiveEncryptionMaterial> {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = await scryptKey(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  })
  return {
    header: {
      kdf: {
        algorithm: 'scrypt',
        salt: salt.toString('base64url'),
        cost: SCRYPT_COST,
        blockSize: SCRYPT_BLOCK_SIZE,
        parallelization: SCRYPT_PARALLELIZATION,
        keyLength: KEY_LENGTH,
      },
      cipher: { algorithm: 'aes-256-gcm', nonce: nonce.toString('base64url'), tagLength: 16 },
    },
    key,
  }
}

export async function deriveArchiveKey(password: Uint8Array, header: ProfileArchiveContainerHeaderV1): Promise<Buffer> {
  if (header.kdf?.algorithm !== 'scrypt' || header.cipher?.algorithm !== 'aes-256-gcm') throw new Error('Unsupported archive encryption')
  const { cost, blockSize, parallelization, keyLength } = header.kdf
  if (cost !== SCRYPT_COST || blockSize !== SCRYPT_BLOCK_SIZE || parallelization !== SCRYPT_PARALLELIZATION || keyLength !== KEY_LENGTH) {
    throw new Error('Unsupported archive KDF parameters')
  }
  return scryptKey(password, Buffer.from(header.kdf.salt, 'base64url'), keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  })
}

export function createArchiveCipher(key: Buffer, header: ProfileArchiveContainerHeaderV1, aad: Uint8Array) {
  if (!header.cipher) throw new Error('Archive cipher metadata is missing')
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.cipher.nonce, 'base64url'), { authTagLength: header.cipher.tagLength })
  cipher.setAAD(aad)
  return cipher
}

export function createArchiveDecipher(key: Buffer, header: ProfileArchiveContainerHeaderV1, aad: Uint8Array, tag: Uint8Array) {
  if (!header.cipher) throw new Error('Archive cipher metadata is missing')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.cipher.nonce, 'base64url'), { authTagLength: header.cipher.tagLength })
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return decipher
}
