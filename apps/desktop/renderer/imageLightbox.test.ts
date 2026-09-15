import { describe, expect, it } from 'vitest'
import { adjacentImageIndex, clampImageZoom, type ImageLightboxItem } from './imageLightbox'

describe('image lightbox navigation', () => {
  it('clamps zoom to the supported range', () => {
    expect(clampImageZoom(0.1)).toBe(0.25)
    expect(clampImageZoom(1.375)).toBe(1.38)
    expect(clampImageZoom(4)).toBe(3)
  })

  it('wraps previous and next navigation across the image batch', () => {
    expect(adjacentImageIndex(0, -1, 4)).toBe(3)
    expect(adjacentImageIndex(3, 1, 4)).toBe(0)
    expect(adjacentImageIndex(1, 1, 4)).toBe(2)
  })

  it('supports both artifact evidence and user attachments', () => {
    const items: ImageLightboxItem[] = [
      { id: 'artifact-1', title: '网页截图', source: { kind: 'artifact', artifactId: 'artifact-1' } },
      { id: 'attachment-1', title: '用户图片', source: { kind: 'attachment', path: '/workspace/.turboflux/attachments/image.png' } },
    ]
    expect(items.map(item => item.source.kind)).toEqual(['artifact', 'attachment'])
  })

})
