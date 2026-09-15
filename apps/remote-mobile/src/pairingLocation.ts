export interface PairingLocationResult {
  code?: string
  sanitizedPath: string
  queryPairingRejected: boolean
}

export function pairingCodeFromUrl(value: string): PairingLocationResult {
  const url = new URL(value)
  const fragmentCode = new URLSearchParams(url.hash.replace(/^#/u, '')).get('pair')
  const queryPairingRejected = url.searchParams.has('pair')
  url.hash = ''
  url.searchParams.delete('pair')
  return {
    code: !queryPairingRejected && fragmentCode?.startsWith('tfrp1:') ? fragmentCode : undefined,
    sanitizedPath: `${url.pathname}${url.search}`,
    queryPairingRejected,
  }
}
