import { createHash } from 'node:crypto'
import type {
  DownloadItem,
  Event,
  OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails,
  Session,
  WebContents,
} from 'electron'

const BROWSER_PARTITION_PREFIX = 'persist:turboflux-browser-v2'

export interface BrowserSessionOwner {
  ownsWebContents(webContentsId: number): boolean
  handleDownload(item: DownloadItem): void
  recordNetworkIssue(details: OnCompletedListenerDetails | OnErrorOccurredListenerDetails): void
}

interface BrowserSessionRegistry {
  owners: Set<BrowserSessionOwner>
  onWillDownload: (event: Event, item: DownloadItem, webContents: WebContents) => void
}

const browserSessionRegistries = new WeakMap<Session, BrowserSessionRegistry>()

export function browserPartition(scopeKey: string): string {
  const digest = createHash('sha256').update(scopeKey).digest('hex').slice(0, 20)
  return `${BROWSER_PARTITION_PREFIX}-${digest}`
}

export function registerBrowserSession(browserSession: Session, owner: BrowserSessionOwner): () => void {
  const existing = browserSessionRegistries.get(browserSession)
  if (existing) {
    existing.owners.add(owner)
    return () => releaseBrowserSession(browserSession, owner)
  }

  const owners = new Set<BrowserSessionOwner>([owner])
  const onWillDownload = (_event: Event, item: DownloadItem, webContents: WebContents) => {
    const downloadOwner = [...owners].find(candidate => candidate.ownsWebContents(webContents.id))
    downloadOwner?.handleDownload(item)
  }
  const registry = { owners, onWillDownload }
  browserSessionRegistries.set(browserSession, registry)
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  browserSession.setDevicePermissionHandler(() => false)
  browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  browserSession.on('will-download', onWillDownload)
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  browserSession.webRequest.onCompleted(filter, details => {
    if (details.statusCode >= 400) for (const candidate of owners) candidate.recordNetworkIssue(details)
  })
  browserSession.webRequest.onErrorOccurred(filter, details => {
    if (details.error !== 'net::ERR_ABORTED') for (const candidate of owners) candidate.recordNetworkIssue(details)
  })
  return () => releaseBrowserSession(browserSession, owner)
}

function releaseBrowserSession(browserSession: Session, owner: BrowserSessionOwner): void {
  const registry = browserSessionRegistries.get(browserSession)
  if (!registry) return
  registry.owners.delete(owner)
  if (registry.owners.size > 0) return
  browserSession.off('will-download', registry.onWillDownload)
  browserSession.webRequest.onCompleted(null)
  browserSession.webRequest.onErrorOccurred(null)
  browserSessionRegistries.delete(browserSession)
}
