import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopRuntimeHost } from '../runtimeHost'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('workflow screenshot attachment boundary', () => {
  it('accepts Design Atlas screenshots when the generic attachments directory does not exist', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workflow-image-'))
    directories.push(workspacePath)
    const screenshotPath = join(workspacePath, '.turboflux', 'design-atlas', 'exploration-1', 'shots', '01.png')
    mkdirSync(join(screenshotPath, '..'), { recursive: true })
    writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const host = Object.create(DesktopRuntimeHost.prototype) as DesktopRuntimeHost
    ;(host as unknown as { workspacePath: string }).workspacePath = workspacePath

    await expect(host.resolveImageAttachment(screenshotPath)).resolves.toMatchObject({
      path: realpathSync(screenshotPath),
      filename: '01.png',
      mime: 'image/png',
      size: 4,
    })
  })

  it('rejects screenshots outside managed visual directories', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'turboflux-workflow-image-'))
    directories.push(workspacePath)
    const screenshotPath = join(workspacePath, 'outside.png')
    writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const host = Object.create(DesktopRuntimeHost.prototype) as DesktopRuntimeHost
    ;(host as unknown as { workspacePath: string }).workspacePath = workspacePath

    await expect(host.resolveImageAttachment(screenshotPath)).rejects.toThrow('outside the TurboFlux visual workspace')
  })
})
