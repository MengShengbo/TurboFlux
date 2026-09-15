import {
  type EncryptedRemoteEnvelope,
  type PairingEndpointHint,
  type RemotePairingRequestReceipt,
  type RemotePairingStatus,
  type SignedCapabilityGrant,
  type SignedPairingResponse,
} from './types'

export interface RemoteClientTransport {
  pair(response: SignedPairingResponse): Promise<SignedCapabilityGrant>
  exchange(envelope: EncryptedRemoteEnvelope): Promise<EncryptedRemoteEnvelope>
  close?(): Promise<void> | void
}

export interface RemoteByteChannel {
  request(payload: Uint8Array): Promise<Uint8Array>
  close?(): Promise<void> | void
}

export interface RemotePairingWaitOptions {
  pollIntervalMs?: number
  onStatus?: (status: RemotePairingStatus) => void
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForPairingApproval(
  receipt: RemotePairingRequestReceipt,
  readStatus: () => Promise<RemotePairingStatus>,
  options: RemotePairingWaitOptions,
): Promise<SignedCapabilityGrant> {
  let status: RemotePairingStatus = { status: 'pending', requestId: receipt.requestId, expiresAt: receipt.expiresAt }
  options.onStatus?.(status)
  while (status.status === 'pending') {
    if (Date.now() >= receipt.expiresAt) throw new Error('Pairing confirmation expired before the desktop approved it')
    await delay(Math.max(10, options.pollIntervalMs ?? 1_000))
    status = await readStatus()
    options.onStatus?.(status)
  }
  if (status.status === 'approved') return status.grant
  throw new Error(status.reason)
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4 && octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) && Number(octets[0]) === 127
}

export function isSecureBrowserHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  } catch {
    return false
  }
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Remote HTTP endpoint must use http or https')
  if (!isSecureBrowserHttpEndpoint(url.href)) {
    throw new Error('Remote browser connections require HTTPS; plain HTTP is limited to localhost debugging')
  }
  return url.href.replace(/\/+$/u, '')
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as { ok?: boolean; data?: T; error?: string }
  if (!response.ok || body.ok === false) throw new Error(body.error || `Remote transport failed with HTTP ${response.status}`)
  return (body.data ?? body) as T
}

export class HttpRemoteTransport implements RemoteClientTransport {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(baseUrl: string, fetcher?: typeof fetch, private readonly pairingOptions: RemotePairingWaitOptions = {}) {
    this.baseUrl = normalizedBaseUrl(baseUrl)
    this.fetcher = fetcher
      ? ((input, init) => fetcher(input, init))
      : ((input, init) => globalThis.fetch(input, init))
  }

  async pair(response: SignedPairingResponse): Promise<SignedCapabilityGrant> {
    const result = await this.fetcher(`${this.baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(response),
    })
    const receipt = await readJsonResponse<RemotePairingRequestReceipt>(result)
    return waitForPairingApproval(receipt, async () => {
      const status = await this.fetcher(`${this.baseUrl}/v1/pair/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: receipt.requestId, pollToken: receipt.pollToken }),
      })
      return readJsonResponse<RemotePairingStatus>(status)
    }, this.pairingOptions)
  }

  async exchange(envelope: EncryptedRemoteEnvelope): Promise<EncryptedRemoteEnvelope> {
    const result = await this.fetcher(`${this.baseUrl}/v1/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    return readJsonResponse<EncryptedRemoteEnvelope>(result)
  }
}

export class IrohRemoteTransport implements RemoteClientTransport {
  constructor(private readonly channel: RemoteByteChannel, private readonly pairingOptions: RemotePairingWaitOptions = {}) {}

  async pair(response: SignedPairingResponse): Promise<SignedCapabilityGrant> {
    const receipt = await this.request<RemotePairingRequestReceipt>({ kind: 'pair', response })
    return waitForPairingApproval(receipt, () => this.request<RemotePairingStatus>({
      kind: 'pair.status',
      requestId: receipt.requestId,
      pollToken: receipt.pollToken,
    }), this.pairingOptions)
  }

  async exchange(envelope: EncryptedRemoteEnvelope): Promise<EncryptedRemoteEnvelope> {
    return this.request<EncryptedRemoteEnvelope>({ kind: 'exchange', envelope })
  }

  close(): Promise<void> | void {
    return this.channel.close?.()
  }

  private async request<T>(message: unknown): Promise<T> {
    const response = JSON.parse(new TextDecoder().decode(await this.channel.request(new TextEncoder().encode(JSON.stringify(message))))) as { ok: boolean; data?: T; error?: string }
    if (!response.ok || response.data === undefined) throw new Error(response.error || 'Iroh remote request failed')
    return response.data
  }
}

export function httpEndpointFromHints(hints: readonly PairingEndpointHint[]): string | undefined {
  return hints
    .filter(hint => hint.kind === 'lan' || hint.kind === 'relay' || hint.kind === 'custom')
    .map(hint => hint.value)
    .filter(isSecureBrowserHttpEndpoint)
    .sort((left, right) => Number(right.startsWith('https://')) - Number(left.startsWith('https://')))[0]
}
