import { createElement, Folder, X, type IconNode } from 'lucide'
import type { ProjectSnapshot } from '@turboflux/workbench'
import './workspaceDialog.css'

type Project = ProjectSnapshot['projects'][number]
type WorkspaceBridge = Pick<TurboFluxDesktopBridge, 'chooseProjectFolder' | 'addProject'>

function glyph(node: IconNode): string {
  return createElement(node, { 'aria-hidden': 'true', focusable: 'false', 'stroke-width': 1.7 }).outerHTML
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function openWorkspaceDialog(
  bridge: WorkspaceBridge,
  getProjects: () => readonly Project[],
): Promise<Project | null> {
  const activeDialog = document.querySelector<HTMLDialogElement>('.workspace-create-dialog')
  if (activeDialog) {
    activeDialog.querySelector<HTMLInputElement>('input')?.focus()
    return Promise.resolve(null)
  }
  const returnFocus = document.activeElement as HTMLElement | null
  const dialog = document.createElement('dialog')
  dialog.className = 'workspace-create-dialog'
  dialog.setAttribute('aria-labelledby', 'workspace-create-title')
  dialog.innerHTML = `
    <form class="workspace-create-form">
      <header class="workspace-create-header">
        <h2 id="workspace-create-title">添加工作区</h2>
        <button type="button" class="workspace-create-close" aria-label="关闭">${glyph(X)}</button>
      </header>
      <div class="workspace-create-fields">
        <div class="workspace-create-field">
          <label for="workspace-create-name">名称</label>
          <input id="workspace-create-name" name="name" placeholder="选择文件夹后自动填入" maxlength="120" autocomplete="off" required autofocus>
        </div>
        <div class="workspace-create-field">
          <span id="workspace-create-folder-label">文件夹</span>
          <button type="button" class="workspace-create-folder" aria-labelledby="workspace-create-folder-label workspace-create-folder-action">
            <span class="workspace-create-folder-icon">${glyph(Folder)}</span>
            <span class="workspace-create-folder-copy">
              <strong id="workspace-create-folder-action">选择本机文件夹</strong>
              <span class="workspace-create-folder-path">作为任务的工作目录</span>
            </span>
            <span class="workspace-create-folder-change">选择</span>
          </button>
        </div>
      </div>
      <p class="workspace-create-error" role="alert" hidden></p>
      <footer class="workspace-create-footer">
        <span class="workspace-create-status" role="status" aria-live="polite"></span>
        <div class="workspace-create-actions">
          <button type="button" class="dialog-secondary workspace-create-cancel">取消</button>
          <button type="submit" class="dialog-primary workspace-create-submit" disabled>添加</button>
        </div>
      </footer>
    </form>`
  const form = dialog.querySelector<HTMLFormElement>('form')!
  const nameInput = dialog.querySelector<HTMLInputElement>('input')!
  const folderButton = dialog.querySelector<HTMLButtonElement>('.workspace-create-folder')!
  const folderName = dialog.querySelector<HTMLElement>('#workspace-create-folder-action')!
  const folderPath = dialog.querySelector<HTMLElement>('.workspace-create-folder-path')!
  const folderChange = dialog.querySelector<HTMLElement>('.workspace-create-folder-change')!
  const closeButton = dialog.querySelector<HTMLButtonElement>('.workspace-create-close')!
  const cancelButton = dialog.querySelector<HTMLButtonElement>('.workspace-create-cancel')!
  const submitButton = dialog.querySelector<HTMLButtonElement>('.workspace-create-submit')!
  const status = dialog.querySelector<HTMLElement>('.workspace-create-status')!
  const error = dialog.querySelector<HTMLElement>('.workspace-create-error')!
  let selection: Awaited<ReturnType<WorkspaceBridge['chooseProjectFolder']>> = null
  let suggestedName = ''
  let busy: 'choosing' | 'creating' | null = null
  let closed = false
  let slowTimer: ReturnType<typeof setTimeout> | undefined

  const existingProject = () => selection && getProjects().find(project => {
    const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
    const selected = normalize(selection!.path)
    const existing = normalize(project.path)
    return /^[a-z]:\//i.test(selected) ? existing.toLowerCase() === selected.toLowerCase() : existing === selected
  })
  function update() {
    const existing = existingProject()
    nameInput.disabled = busy === 'creating'
    nameInput.readOnly = Boolean(existing)
    folderButton.disabled = busy !== null
    closeButton.disabled = cancelButton.disabled = busy === 'creating'
    submitButton.disabled = busy !== null || !selection || !nameInput.value.trim()
    submitButton.textContent = busy === 'creating' ? '正在添加…' : existing ? '查看工作区' : '添加'
    form.setAttribute('aria-busy', String(busy !== null))
    status.textContent = busy === 'choosing' ? '正在选择文件夹…'
      : busy === 'creating' ? '正在保存工作区…'
        : existing ? '此文件夹已添加到工作区' : selection ? '文件夹已就绪' : ''
    status.classList.toggle('is-busy', busy !== null)
    if (selection) {
      folderButton.classList.add('has-folder')
      folderName.textContent = selection.name
      folderPath.textContent = selection.path
      folderPath.title = selection.path
      folderChange.textContent = '更换'
      folderButton.setAttribute('aria-label', `更换源文件夹，当前：${selection.path}`)
      folderButton.removeAttribute('aria-labelledby')
    }
  }
  function showError(cause: unknown) {
    error.textContent = errorMessage(cause)
    error.hidden = false
  }
  function clearError() {
    error.textContent = ''
    error.hidden = true
  }

  return new Promise(resolve => {
    function finish(project: Project | null) {
      if (closed) return
      closed = true
      clearTimeout(slowTimer)
      dialog.close()
      dialog.remove()
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
      resolve(project)
    }
    const cancel = () => { if (busy !== 'creating') finish(null) }
    closeButton.addEventListener('click', cancel)
    cancelButton.addEventListener('click', cancel)
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel() })
    dialog.addEventListener('keydown', event => { event.stopPropagation() })
    nameInput.addEventListener('input', () => { clearError(); update() })
    folderButton.addEventListener('click', async () => {
      if (busy) return
      busy = 'choosing'
      clearError()
      update()
      try {
        const folder = await bridge.chooseProjectFolder()
        if (closed || !folder) return
        selection = folder
        const existing = existingProject()
        if (existing || !nameInput.value.trim() || nameInput.value === suggestedName) {
          nameInput.value = (existing?.name || folder.name).slice(0, 120)
        }
        suggestedName = (existing?.name || folder.name).slice(0, 120)
      } catch (cause) {
        if (!closed) showError(cause)
      } finally {
        busy = null
        if (!closed) { update(); folderButton.focus() }
      }
    })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (busy || !selection || !nameInput.value.trim()) return
      const existing = existingProject()
      if (existing) { finish(existing); return }
      busy = 'creating'
      clearError()
      update()
      slowTimer = setTimeout(() => { status.textContent = '正在保存，请稍候…' }, 4_000)
      try {
        const projects = await bridge.addProject({ path: selection.path, name: nameInput.value.trim() })
        const project = projects.projects.find(project => project.path === selection!.path)
        if (!project) throw new Error('未能找到已创建的工作区，请重试。')
        finish(project)
      } catch (cause) {
        clearTimeout(slowTimer)
        busy = null
        update()
        showError(cause)
        submitButton.focus()
      }
    })
    document.body.append(dialog)
    dialog.showModal()
  })
}
