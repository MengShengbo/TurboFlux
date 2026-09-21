import { join } from 'node:path'
import { BrowserWindow, screen, type Rectangle, type WebContents } from 'electron'
import type {
  ComputerActivitySnapshot,
  ComputerControlMode,
  ComputerSystemEvent,
  ComputerSystemSnapshot,
} from '@turboflux/contracts'
import { desktopAppRoot } from '../desktopPaths'

const OVERLAY_HEIGHT = 66
const OVERLAY_MAX_WIDTH = 820
const OVERLAY_MARGIN = 12
const OVERLAY_PRELOAD = join(desktopAppRoot, 'computer', 'computerActivityOverlayPreload.cjs')

export interface ComputerOverlayApproval {
  id: string
  kind: 'permission'
  question: string
  reason?: string
  toolName?: string
  options: string[]
}

export interface ComputerOverlayApprovalOption {
  value: string
  label: string
  tone: 'normal' | 'primary' | 'danger'
}

export interface ComputerOverlayPresentation {
  title: string
  detail: string
  phase: 'active' | 'waiting' | 'handoff' | 'error'
  controlMode?: ComputerControlMode
  takeControl: boolean
  resumeControl: boolean
  stopControl: boolean
  approval?: Omit<ComputerOverlayApproval, 'options'> & { options: ComputerOverlayApprovalOption[] }
}

interface RuntimeEventLike {
  type?: string
  conversationId?: string
  snapshot?: { conversation?: { id?: string } }
  event?: { type?: string }
}

export type ComputerOverlayRuntimeAction =
  | { kind: 'activate'; conversationId: string; snapshot: NonNullable<RuntimeEventLike['snapshot']> }
  | { kind: 'sync'; conversationId: string }
  | { kind: 'none'; conversationId: string | null }

export interface ComputerOverlayRuntimeClassification {
  action: ComputerOverlayRuntimeAction
  taskFinished: boolean
}

export function classifyComputerOverlayRuntimeEvent(
  event: RuntimeEventLike | null | undefined,
  activeConversationId: string | null,
): ComputerOverlayRuntimeClassification {
  const conversationId = event?.conversationId
    || event?.snapshot?.conversation?.id
    || activeConversationId
  const taskFinished = event?.type === 'runtime-error'
    || event?.type === 'conversation-run'
    || (event?.type === 'agent' && ['session:complete', 'error'].includes(event.event?.type || ''))
  if (event?.type === 'snapshot' && event.snapshot?.conversation?.id) {
    return {
      taskFinished,
      action: {
        kind: 'activate',
        conversationId: event.snapshot.conversation.id,
        snapshot: event.snapshot,
      },
    }
  }
  if (taskFinished && conversationId && conversationId === activeConversationId) {
    return { taskFinished, action: { kind: 'sync', conversationId } }
  }
  return { taskFinished, action: { kind: 'none', conversationId: conversationId || null } }
}

export function computerOverlayApprovalOptions(options: string[]): ComputerOverlayApprovalOption[] {
  const source = options.length > 0 ? options : ['allow-once', 'deny']
  return source.slice(0, 4).map(value => ({
    value,
    label: ({
      'allow-once': '仅这次允许',
      'allow-run': '本任务自动',
      'allow-session': '本会话自动',
      deny: '拒绝',
    } as Record<string, string>)[value] || value,
    tone: value === 'deny' ? 'danger' : value === 'allow-once' ? 'primary' : 'normal',
  }))
}

export function computerOverlayPresentation(
  snapshot: ComputerSystemSnapshot,
  lastActivity?: ComputerActivitySnapshot,
  errorActive = false,
  pendingApproval?: ComputerOverlayApproval | null,
): ComputerOverlayPresentation | null {
  if (!snapshot.sessionActive && !snapshot.handoffActive && !errorActive && !pendingApproval) return null
  const activity = snapshot.activity || lastActivity
  const controls = {
    takeControl: !snapshot.handoffActive && !snapshot.paused,
    resumeControl: snapshot.handoffActive || snapshot.paused,
    stopControl: true,
  }
  if (pendingApproval) {
    return {
      title: `${activity?.appName || snapshot.activeApp?.name || '电脑操控'} · 需要确认`,
      detail: pendingApproval.question,
      phase: 'waiting',
      controlMode: activity?.controlMode,
      ...controls,
      approval: {
        ...pendingApproval,
        options: computerOverlayApprovalOptions(pendingApproval.options),
      },
    }
  }
  if (errorActive) {
    return {
      title: activity?.appName || snapshot.activeApp?.name || '电脑操控',
      detail: '操作遇到问题，请返回 TurboFlux 查看',
      phase: 'error',
      controlMode: activity?.controlMode,
      ...controls,
    }
  }
  if (snapshot.handoffActive || activity?.phase === 'handoff') {
    return {
      title: activity?.appName || snapshot.activeApp?.name || '需要你接管',
      detail: activity?.description || '完成受保护步骤后回到 TurboFlux 继续',
      phase: 'handoff',
      controlMode: 'takeover',
      ...controls,
    }
  }
  return {
    title: activity?.appName || snapshot.activeApp?.name || '电脑操控',
    detail: snapshot.activity?.description || '正在准备下一步',
    phase: snapshot.activity?.phase === 'waiting' ? 'waiting' : 'active',
    controlMode: activity?.controlMode,
    ...controls,
  }
}

export function computerOverlayBounds(workArea: Rectangle): Rectangle {
  const width = Math.max(280, Math.min(OVERLAY_MAX_WIDTH, workArea.width - OVERLAY_MARGIN * 2))
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + OVERLAY_MARGIN),
    width,
    height: OVERLAY_HEIGHT,
  }
}

function overlayDocument(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { display: grid; place-items: center; padding: 2px; }
    #surface {
      width: 100%; min-height: 62px; display: grid; grid-template-columns: 18px minmax(150px, 1fr) auto; align-items: center;
      gap: 10px; padding: 7px 10px 7px 16px; border-radius: 18px;
      color: rgba(22, 22, 24, .94); background: rgba(248, 248, 247, .76);
      border: 1px solid rgba(255, 255, 255, .72);
      box-shadow: 0 9px 30px rgba(0, 0, 0, .13), inset 0 0 0 .5px rgba(0, 0, 0, .05);
      backdrop-filter: blur(24px) saturate(145%); -webkit-backdrop-filter: blur(24px) saturate(145%);
      transform: translateY(-3px) scale(.985); opacity: 0;
      transition: opacity 180ms ease, transform 260ms cubic-bezier(.2, .8, .2, 1), background 180ms ease;
    }
    body.visible #surface { transform: translateY(0) scale(1); opacity: 1; }
    #pulse { width: 9px; height: 9px; margin-left: 3px; border-radius: 999px; background: #43a66f; box-shadow: 0 0 0 5px rgba(67, 166, 111, .12); }
    body.active #pulse { animation: breathe 1.8s ease-in-out infinite; }
    body.waiting #pulse { background: #8b8b90; box-shadow: 0 0 0 5px rgba(139, 139, 144, .11); }
    body.handoff #pulse { background: #d58a2d; box-shadow: 0 0 0 5px rgba(213, 138, 45, .13); }
    body.error #pulse { background: #cc4f4f; box-shadow: 0 0 0 5px rgba(204, 79, 79, .12); }
    #copy { min-width: 0; display: grid; gap: 1px; line-height: 1.15; }
    strong, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    strong { font-size: 12.5px; font-weight: 600; letter-spacing: -.01em; }
    small { color: rgba(39, 39, 42, .62); font-size: 11px; font-weight: 450; }
    #actions, #approval-actions, #control-actions { display: flex; align-items: center; gap: 5px; }
    #actions { min-width: 0; justify-content: flex-end; }
    #approval-actions:empty { display: none; }
    #control-actions { padding-left: 6px; border-left: 1px solid rgba(60, 60, 67, .13); }
    button {
      min-width: 42px; height: 30px; padding: 0 9px; border: 0; border-radius: 9px;
      color: rgba(35, 35, 38, .78); background: rgba(255, 255, 255, .52);
      font: inherit; font-size: 11px; font-weight: 580; letter-spacing: -.01em;
      cursor: default; transition: background 140ms ease, color 140ms ease, opacity 140ms ease, transform 120ms ease;
    }
    button:hover { color: rgba(20, 20, 22, .96); background: rgba(255, 255, 255, .88); }
    button:active { transform: scale(.96); }
    button.primary { color: #fff; background: #30312e; }
    button.danger { color: #b83d3d; background: rgba(197, 61, 61, .09); }
    button:disabled { opacity: .42; }
    @keyframes breathe { 0%, 100% { transform: scale(.88); opacity: .72; } 50% { transform: scale(1.08); opacity: 1; } }
    @media (prefers-color-scheme: dark) {
      #surface { color: rgba(248, 248, 250, .94); background: rgba(35, 35, 37, .78); border-color: rgba(255, 255, 255, .12); box-shadow: 0 10px 32px rgba(0, 0, 0, .34), inset 0 0 0 .5px rgba(255, 255, 255, .07); }
      small { color: rgba(235, 235, 245, .58); }
      #control-actions { border-left-color: rgba(235, 235, 245, .13); }
      button { color: rgba(245, 245, 247, .76); background: rgba(255, 255, 255, .09); }
      button:hover { color: #fff; background: rgba(255, 255, 255, .16); }
      button.primary { color: #222; background: rgba(248, 248, 250, .94); }
      button.danger { color: #ff8a8a; background: rgba(255, 90, 90, .1); }
    }
    @media (prefers-reduced-motion: reduce) { #surface { transition-duration: 1ms; } #pulse { animation: none !important; } }
  </style>
</head>
<body>
  <section id="surface" role="region" aria-live="polite">
    <span id="pulse"></span>
    <span id="copy"><strong id="title"></strong><small id="detail"></small></span>
    <span id="actions">
      <span id="approval-actions"></span>
      <span id="control-actions">
        <button id="take-control" type="button">接管</button>
        <button id="resume-control" class="primary" type="button">继续</button>
        <button id="stop-control" class="danger" type="button">停止</button>
      </span>
    </span>
  </section>
  <script>
    const setPending = pending => document.querySelectorAll('button').forEach(button => { button.disabled = pending; });
    const runAction = async (action, payload = {}) => {
      if (!window.computerOverlay) return;
      setPending(true);
      try {
        await window.computerOverlay.act(action, payload);
      } catch (error) {
        document.getElementById('detail').textContent = error && error.message ? error.message : String(error);
        document.body.className = 'error visible';
      } finally {
        setPending(false);
      }
    };
    document.getElementById('take-control').addEventListener('click', () => runAction('take-control'));
    document.getElementById('resume-control').addEventListener('click', () => runAction('resume-control'));
    document.getElementById('stop-control').addEventListener('click', () => runAction('stop-control'));
    window.renderComputerActivity = payload => {
      document.getElementById('title').textContent = payload.title || '电脑操控';
      document.getElementById('detail').textContent = payload.detail || '正在准备下一步';
      document.getElementById('take-control').hidden = !payload.takeControl;
      document.getElementById('resume-control').hidden = !payload.resumeControl;
      document.getElementById('stop-control').hidden = !payload.stopControl;
      const approvalActions = document.getElementById('approval-actions');
      approvalActions.replaceChildren();
      for (const option of payload.approval?.options || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = option.label;
        button.className = option.tone || '';
        button.addEventListener('click', () => runAction('resolve-approval', {
          requestId: payload.approval.id,
          response: option.value,
        }));
        approvalActions.append(button);
      }
      document.body.className = payload.phase || 'active';
      requestAnimationFrame(() => document.body.classList.add('visible'));
    };
  </script>
</body>
</html>`
}

export class ComputerActivityOverlay {
  private overlayWindow: BrowserWindow | null = null
  private ready = false
  private lastActivity: ComputerActivitySnapshot | undefined
  private latestSnapshot: ComputerSystemSnapshot | null = null
  private errorUntil = 0
  private errorTimer: ReturnType<typeof setTimeout> | null = null
  private captureSuspended = false
  private wantedVisible = false
  private pendingApproval: ComputerOverlayApproval | null = null
  private lastRenderKey: string | null = null

  constructor(private readonly mainWindow: BrowserWindow) {
    this.createWindow()
  }

  handleEvent(event: ComputerSystemEvent, snapshot: ComputerSystemSnapshot): void {
    if (event.type === 'activity-changed' && event.activity) this.lastActivity = { ...event.activity }
    if (event.type === 'error') {
      this.errorUntil = Date.now() + 3_500
      if (this.errorTimer) clearTimeout(this.errorTimer)
      this.errorTimer = setTimeout(() => {
        this.errorTimer = null
        this.render()
      }, 3_550)
    }
    if (!snapshot.sessionActive && !snapshot.handoffActive) this.lastActivity = undefined
    this.latestSnapshot = snapshot
    this.render()
  }

  sync(snapshot: ComputerSystemSnapshot, pendingApproval: ComputerOverlayApproval | null): void {
    this.latestSnapshot = snapshot
    this.pendingApproval = pendingApproval
    this.render()
  }

  ownsWebContents(contents: WebContents): boolean {
    return Boolean(this.overlayWindow && !this.overlayWindow.isDestroyed() && this.overlayWindow.webContents === contents)
  }

  async suspendForCapture(): Promise<void> {
    this.captureSuspended = true
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.setOpacity(0)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 18))
  }

  resumeAfterCapture(): void {
    this.captureSuspended = false
    if (this.wantedVisible && this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.setOpacity(1)
  }

  destroy(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.errorTimer = null
    const window = this.overlayWindow
    this.overlayWindow = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private createWindow(): void {
    const overlay = new BrowserWindow({
      width: OVERLAY_MAX_WIDTH,
      height: OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      focusable: false,
      acceptFirstMouse: true,
      skipTaskbar: true,
      hasShadow: false,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        backgroundThrottling: false,
        preload: OVERLAY_PRELOAD,
      },
    })
    overlay.setAlwaysOnTop(true, 'floating')
    overlay.setFocusable(false)
    overlay.setIgnoreMouseEvents(false)
    overlay.setContentProtection(true)
    if (process.platform === 'darwin') {
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    overlay.webContents.once('did-finish-load', () => {
      this.ready = true
      this.render()
    })
    overlay.on('closed', () => {
      if (this.overlayWindow === overlay) this.overlayWindow = null
    })
    void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayDocument())}`)
    this.overlayWindow = overlay
  }

  private render(): void {
    const overlay = this.overlayWindow
    const snapshot = this.latestSnapshot
    if (!overlay || overlay.isDestroyed() || !snapshot) return
    const presentation = computerOverlayPresentation(snapshot, this.lastActivity, Date.now() < this.errorUntil, this.pendingApproval)
    this.wantedVisible = Boolean(presentation && !this.mainWindow.isFocused())
    if (!presentation || !this.wantedVisible) {
      const renderKey = presentation ? 'hidden:workbench-focused' : 'hidden:inactive'
      if (renderKey === this.lastRenderKey) return
      this.lastRenderKey = renderKey
      if (overlay.isVisible()) overlay.hide()
      return
    }
    const targetBounds = snapshot.activeWindow?.bounds
    const renderKey = JSON.stringify({
      presentation,
      targetBounds: targetBounds || null,
      ready: this.ready,
      captureSuspended: this.captureSuspended,
    })
    if (renderKey === this.lastRenderKey) return
    this.lastRenderKey = renderKey
    const display = targetBounds
      ? screen.getDisplayMatching(targetBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    overlay.setBounds(computerOverlayBounds(display.workArea), false)
    if (!this.captureSuspended) overlay.setOpacity(1)
    if (this.ready) {
      void overlay.webContents.executeJavaScript(`window.renderComputerActivity(${JSON.stringify(presentation)})`, true)
      overlay.showInactive()
    }
  }
}
