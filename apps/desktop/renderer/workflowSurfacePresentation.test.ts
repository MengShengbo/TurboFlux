import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workbenchSource = readFileSync(new URL('./workbench.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const workflowSource = workbenchSource.slice(
  workbenchSource.indexOf('function showWorkflowSurface'),
  workbenchSource.indexOf('function setConversationMode'),
)

describe('workflow surface product presentation', () => {
  it('uses the workflow title directly without an AI-style kicker', () => {
    expect(workflowSource).toContain("header.className = 'workflow-surface-header'")
    expect(workflowSource).not.toContain('workflow-surface-kicker')
    expect(workflowSource).not.toContain("textContent = '工作流'")
  })

  it('inherits the explicit TurboFlux theme instead of the OS color scheme', () => {
    expect(styles).toContain('html[data-theme="dark"] .workflow-surface-inline .workflow-surface')
    expect(styles).toContain('html[data-theme="dark"] .workflow-surface {')
    expect(styles).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]{0,3000}workflow-surface/)
  })

  it('presents direction counts as one continuous five-stop scale', () => {
    expect(styles).toContain('.workflow-surface[data-renderer="count"] .workflow-surface-choices { position: relative; grid-template-columns: repeat(5,minmax(0,1fr));')
    expect(styles).toContain('.workflow-surface[data-renderer="count"] .workflow-surface-choice {')
    expect(styles).toContain('.workflow-surface[data-renderer="count"] .workflow-surface-choices::before')
    expect(styles).toContain('.workflow-surface[data-renderer="count"] .workflow-surface-count-marker')
    expect(workflowSource).toContain("countMarker.className = 'workflow-surface-count-marker'")
    expect(workflowSource).toContain("ui.renderer === 'count'")
    expect(workflowSource).toContain("placeholder: '1–20'")
  })

  it('loads gallery screenshots through the workspace attachment boundary', () => {
    expect(workflowSource).toContain("bridge.previewImageAttachment(direction.screenshotPath, 'thumbnail')")
    expect(workflowSource).toContain("image.classList.add('loaded')")
    expect(workflowSource).toContain("placeholder.textContent = '预览暂不可用'")
    expect(workflowSource).not.toContain('direction.previewUrl')
    expect(workflowSource).not.toContain('image.src = direction.')
  })

  it('renders declared text inputs instead of leaving an empty surface', () => {
    expect(workflowSource).toContain("countInput?.type === 'text'")
    expect(workflowSource).toContain("input.maxLength = 4_000")
    expect(workflowSource).toContain("if (!value)")
    expect(styles).toContain('.workflow-surface-custom-text textarea')
  })

  it('renders as an inline decision card instead of a full-screen modal', () => {
    expect(workflowSource).toContain("overlay.className = 'workflow-surface-inline'")
    expect(workflowSource).toContain('appendTranscriptElement(overlay)')
    expect(workflowSource).not.toContain("overlay.setAttribute('aria-modal', 'true')")
    expect(styles).toContain('.workflow-surface-inline {')
    expect(styles).not.toContain('.workflow-surface-overlay')
    expect(styles).not.toMatch(/\.workflow-surface-overlay\s*\{[^}]*backdrop-filter/)
  })

  it('uses restrained staged motion with an accessibility fallback', () => {
    expect(styles).toContain('@keyframes workflow-item-enter')
    expect(styles).toContain('calc(var(--workflow-index) * 38ms + 80ms)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('.workflow-surface-inline, .workflow-surface-inline .workflow-surface { animation: none !important; transition: none !important; }')
  })
})
