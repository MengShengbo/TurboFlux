const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25

export interface ImageLightboxItem {
  id: string
  title: string
  detail?: string
  source: { kind: 'artifact'; artifactId: string } | { kind: 'attachment'; path: string }
}

export interface ImageLightboxOptions {
  loadPreview(item: ImageLightboxItem): Promise<{ mode: string; dataUrl?: string }>
  exportImage(item: ImageLightboxItem): Promise<string | null>
  notify(message: string): void
}

export interface ImageLightbox {
  open(items: ImageLightboxItem[], initialIndex?: number): void
  close(): void
  isOpen(): boolean
}

export function clampImageZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

export function adjacentImageIndex(index: number, direction: -1 | 1, length: number): number {
  if (length <= 0) return 0
  return (index + direction + length) % length
}

function lightboxIcon(name: 'back' | 'forward' | 'download' | 'close' | 'minus' | 'plus'): string {
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/>',
    forward: '<path d="m9 18 6-6-6-6"/>',
    download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}

export function createImageLightbox(options: ImageLightboxOptions): ImageLightbox {
  const root = document.createElement('section')
  root.className = 'image-lightbox'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', '图像查看器')
  root.innerHTML = `
    <header class="image-lightbox-toolbar">
      <div class="image-lightbox-copy"><strong></strong></div>
      <div class="image-lightbox-actions">
        <button type="button" data-action="download" aria-label="下载当前图像" title="下载">${lightboxIcon('download')}</button>
        <button type="button" data-action="close" aria-label="关闭图像查看器" title="关闭">${lightboxIcon('close')}</button>
      </div>
    </header>
    <button class="image-lightbox-nav previous" type="button" data-action="previous" aria-label="上一张">${lightboxIcon('back')}</button>
    <div class="image-lightbox-stage"><div class="image-lightbox-canvas"><div class="image-lightbox-loading"></div></div></div>
    <button class="image-lightbox-nav next" type="button" data-action="next" aria-label="下一张">${lightboxIcon('forward')}</button>
    <footer class="image-lightbox-zoom">
      <button type="button" data-action="zoom-out" aria-label="缩小">${lightboxIcon('minus')}</button>
      <button class="image-lightbox-zoom-value" type="button" data-action="reset" title="恢复适应窗口">100%</button>
      <button type="button" data-action="zoom-in" aria-label="放大">${lightboxIcon('plus')}</button>
      <span class="image-lightbox-position"></span>
    </footer>
  `
  document.body.append(root)

  const canvas = root.querySelector<HTMLElement>('.image-lightbox-canvas')!
  const title = root.querySelector<HTMLElement>('.image-lightbox-copy strong')!
  const zoomValue = root.querySelector<HTMLButtonElement>('.image-lightbox-zoom-value')!
  const position = root.querySelector<HTMLElement>('.image-lightbox-position')!
  const previous = root.querySelector<HTMLButtonElement>('[data-action="previous"]')!
  const next = root.querySelector<HTMLButtonElement>('[data-action="next"]')!
  const closeButton = root.querySelector<HTMLButtonElement>('[data-action="close"]')!
  let items: ImageLightboxItem[] = []
  let index = 0
  let zoom = 1
  let renderToken = 0

  const renderZoom = () => {
    const image = canvas.querySelector<HTMLImageElement>('img')
    if (image) image.style.transform = `scale(${zoom})`
    zoomValue.textContent = `${Math.round(zoom * 100)}%`
  }

  const setZoom = (value: number) => {
    zoom = clampImageZoom(value)
    renderZoom()
  }

  const render = async () => {
    const item = items[index]
    if (!item) return
    const token = ++renderToken
    zoom = 1
    title.textContent = item.title
    title.title = item.detail ? `${item.title} · ${item.detail}` : item.title
    position.textContent = `${index + 1} / ${items.length}`
    previous.hidden = items.length < 2
    next.hidden = items.length < 2
    canvas.innerHTML = '<div class="image-lightbox-loading"></div>'
    renderZoom()
    try {
      const preview = await options.loadPreview(item)
      if (token !== renderToken || preview.mode !== 'image' || !preview.dataUrl) return
      const image = document.createElement('img')
      image.src = preview.dataUrl
      image.alt = item.title
      image.decoding = 'async'
      if (typeof image.decode === 'function') await image.decode()
      if (token !== renderToken) return
      canvas.replaceChildren(image)
      renderZoom()
    } catch {
      if (token === renderToken) canvas.innerHTML = '<div class="image-lightbox-error">图像暂时无法预览</div>'
    }
  }

  const move = (direction: -1 | 1) => {
    if (items.length < 2) return
    index = adjacentImageIndex(index, direction, items.length)
    void render()
  }

  const close = () => {
    if (root.hidden) return
    root.classList.remove('visible')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.setTimeout(() => {
      root.hidden = true
      canvas.replaceChildren()
      items = []
      renderToken += 1
    }, reduceMotion ? 0 : 180)
  }

  root.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLButtonElement>('[data-action]')?.dataset.action
    if (action === 'close') close()
    if (action === 'previous') move(-1)
    if (action === 'next') move(1)
    if (action === 'zoom-out') setZoom(zoom - ZOOM_STEP)
    if (action === 'zoom-in') setZoom(zoom + ZOOM_STEP)
    if (action === 'reset') setZoom(1)
    if (action === 'download') {
      const item = items[index]
      if (item) void options.exportImage(item).then(path => {
        if (path) options.notify('图像已导出')
      }).catch(() => options.notify('图像导出失败'))
    }
    if (event.target === root || (event.target as Element).classList.contains('image-lightbox-stage')) close()
  })
  root.querySelector<HTMLElement>('.image-lightbox-stage')!.addEventListener('wheel', event => {
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    setZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
  }, { passive: false })
  window.addEventListener('keydown', event => {
    if (root.hidden) return
    if (event.key === 'Escape') close()
    else if (event.key === 'ArrowLeft') move(-1)
    else if (event.key === 'ArrowRight') move(1)
    else if (event.key === '+' || event.key === '=') setZoom(zoom + ZOOM_STEP)
    else if (event.key === '-') setZoom(zoom - ZOOM_STEP)
    else if (event.key === '0') setZoom(1)
    else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  return {
    open(nextItems, initialIndex = 0) {
      if (!nextItems.length) return
      items = [...nextItems]
      index = Math.min(items.length - 1, Math.max(0, initialIndex))
      root.hidden = false
      requestAnimationFrame(() => root.classList.add('visible'))
      closeButton.focus()
      void render()
    },
    close,
    isOpen: () => !root.hidden,
  }
}
