import { describe, expect, it } from 'vitest'
import { pairingCodeFromUrl } from './pairingLocation'

describe('remote pairing URL parsing', () => {
  it('accepts a pairing code only from the URL fragment', () => {
    expect(pairingCodeFromUrl('https://remote.example/control?theme=dark#pair=tfrp1%3Asecret')).toEqual({
      code: 'tfrp1:secret',
      sanitizedPath: '/control?theme=dark',
      queryPairingRejected: false,
    })
  })

  it('removes but never consumes a query-string pairing code', () => {
    expect(pairingCodeFromUrl('https://remote.example/control?pair=tfrp1%3Aleaked&theme=dark')).toEqual({
      code: undefined,
      sanitizedPath: '/control?theme=dark',
      queryPairingRejected: true,
    })
  })

  it('fails closed when query and fragment pairing codes are mixed', () => {
    expect(pairingCodeFromUrl('https://remote.example/?pair=tfrp1%3Aleaked#pair=tfrp1%3Afragment')).toMatchObject({
      code: undefined,
      queryPairingRejected: true,
    })
  })
})
