import type { WorkbenchArtifactPreview, WorkbenchSnapshot } from '@turboflux/workbench'

type ArtifactRecord = WorkbenchSnapshot['artifacts']['artifacts'][number]

const rightChevronIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'

export interface VisualEvidenceItem {
  artifactId: string
  name: string
  source: 'browser' | 'computer'
  title: string
  detail: string
  capturedAt: number
}

export interface VisualEvidenceRange {
  conversationId: string
  startedAt: number
  completedAt?: number
}

export interface VisualEvidenceViewOptions {
  loadPreview(artifactId: string): Promise<WorkbenchArtifactPreview>
  open(items: VisualEvidenceItem[], initialIndex: number): void
  defaultCollapsed?: boolean
}

function metadataText(artifact: ArtifactRecord, key: string): string {
  const value = artifact.metadata?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function metadataNumber(artifact: ArtifactRecord, key: string): number | undefined {
  const value = artifact.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function visualEvidenceSource(artifact: ArtifactRecord): VisualEvidenceItem['source'] | null {
  if (artifact.kind !== 'image') return null
  if (artifact.source === 'browser' || metadataText(artifact, 'browserTabId') || metadataText(artifact, 'browserUrl')) return 'browser'
  if (metadataText(artifact, 'visualSource') === 'computer') return 'computer'
  return null
}

export function visualEvidenceItems(
  artifacts: ArtifactRecord[],
  range: VisualEvidenceRange,
): VisualEvidenceItem[] {
  const completedAt = range.completedAt ?? Number.POSITIVE_INFINITY
  return artifacts.flatMap(artifact => {
    const source = visualEvidenceSource(artifact)
    const capturedAt = metadataNumber(artifact, 'capturedAt') ?? artifact.updatedAt
    if (!source || !artifact.available) return []
    if (artifact.conversationId && artifact.conversationId !== range.conversationId) return []
    if (capturedAt < range.startedAt - 1_000 || capturedAt > completedAt + 5_000) return []
    const browserTitle = metadataText(artifact, 'browserTitle')
    const browserUrl = metadataText(artifact, 'browserUrl')
    const appName = metadataText(artifact, 'computerAppName')
    const windowTitle = metadataText(artifact, 'computerWindowTitle')
    return [{
      artifactId: artifact.id,
      name: artifact.name,
      source,
      title: source === 'browser' ? browserTitle || '网页截图' : appName || '电脑操作',
      detail: source === 'browser' ? browserUrl : windowTitle,
      capturedAt,
    }]
  }).sort((left, right) => left.capturedAt - right.capturedAt)
}

export function visualEvidenceLabel(items: VisualEvidenceItem[]): string {
  const sources = new Set(items.map(item => item.source))
  if (sources.size > 1) return '视觉证据'
  return sources.has('computer') ? '电脑操作' : '网页截图'
}

export function visualEvidenceSignature(items: VisualEvidenceItem[]): string {
  return items.map(item => `${item.artifactId}:${item.capturedAt}`).join('|')
}

function imageGlyph(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.5"/><path d="m5.5 17 4.2-4.3 3.2 3 2.2-2.2 3.4 3.5"/></svg>'
}

export function renderVisualEvidence(
  host: HTMLElement,
  items: VisualEvidenceItem[],
  options: VisualEvidenceViewOptions,
): void {
  const signature = visualEvidenceSignature(items)
  if (!items.length) {
    host.hidden = true
    host.replaceChildren()
    delete host.dataset.evidenceSignature
    return
  }
  if (host.dataset.evidenceSignature === signature) return

  const previous = host.querySelector<HTMLElement>('.visual-evidence')
  const wasCollapsed = previous
    ? previous.classList.contains('collapsed')
    : options.defaultCollapsed !== false
  host.dataset.evidenceSignature = signature
  host.hidden = false

  const section = document.createElement('section')
  section.className = `visual-evidence${wasCollapsed ? ' collapsed' : ''}`
  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = 'visual-evidence-summary'
  summary.setAttribute('aria-expanded', String(!wasCollapsed))
  const glyph = document.createElement('span')
  glyph.className = 'visual-evidence-glyph'
  glyph.innerHTML = imageGlyph()
  const copy = document.createElement('span')
  copy.className = 'visual-evidence-copy'
  const title = document.createElement('strong')
  title.textContent = `已查看 ${items.length} 张图像`
  const source = document.createElement('small')
  source.textContent = visualEvidenceLabel(items)
  copy.append(title, source)
  const chevron = document.createElement('span')
  chevron.className = 'visual-evidence-chevron'
  chevron.innerHTML = rightChevronIcon
  summary.append(glyph, copy, chevron)

  const body = document.createElement('div')
  body.className = 'visual-evidence-body'
  body.setAttribute('aria-hidden', String(wasCollapsed))
  const bodyInner = document.createElement('div')
  bodyInner.className = 'visual-evidence-body-inner'
  let thumbnailsMounted = false
  const mountThumbnails = () => {
    if (thumbnailsMounted) return
    thumbnailsMounted = true
    const grid = document.createElement('div')
    grid.className = 'visual-evidence-grid'
    const visibleItems = items.slice(0, 4)
    visibleItems.forEach((item, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'visual-evidence-thumbnail loading'
      button.title = item.detail || item.title
      button.setAttribute('aria-label', `查看图像 ${index + 1}：${item.title}`)
      const placeholder = document.createElement('span')
      placeholder.className = 'visual-evidence-placeholder'
      placeholder.innerHTML = imageGlyph()
      button.append(placeholder)
      if (index === visibleItems.length - 1 && items.length > visibleItems.length) {
        const more = document.createElement('span')
        more.className = 'visual-evidence-more'
        more.textContent = `+${items.length - visibleItems.length}`
        button.append(more)
      }
      button.addEventListener('click', () => options.open(items, index))
      grid.append(button)
      void options.loadPreview(item.artifactId).then(async preview => {
        if (!button.isConnected || preview.mode !== 'image' || !preview.dataUrl) return
        const image = document.createElement('img')
        image.src = preview.dataUrl
        image.alt = item.title
        image.decoding = 'async'
        if (typeof image.decode === 'function') await image.decode()
        if (!button.isConnected) return
        button.classList.remove('loading')
        button.prepend(image)
        placeholder.remove()
      }).catch(() => {
        button.classList.remove('loading')
        button.classList.add('unavailable')
      })
    })
    bodyInner.append(grid)
  }

  if (!wasCollapsed) mountThumbnails()
  body.append(bodyInner)
  section.append(summary, body)
  summary.addEventListener('click', () => {
    const collapsed = section.classList.toggle('collapsed')
    summary.setAttribute('aria-expanded', String(!collapsed))
    body.setAttribute('aria-hidden', String(collapsed))
    if (!collapsed) mountThumbnails()
  })
  host.replaceChildren(section)
}
