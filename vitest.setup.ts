import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const previousConversationsDirectory = process.env.TURBOFLUX_CONVERSATIONS_DIR
const testConversationsDirectory = mkdtempSync(join(tmpdir(), 'turboflux-test-conversations-'))

process.env.TURBOFLUX_CONVERSATIONS_DIR = testConversationsDirectory

afterAll(() => {
  if (previousConversationsDirectory === undefined) delete process.env.TURBOFLUX_CONVERSATIONS_DIR
  else process.env.TURBOFLUX_CONVERSATIONS_DIR = previousConversationsDirectory
  rmSync(testConversationsDirectory, { recursive: true, force: true })
})
