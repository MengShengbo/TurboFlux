import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeToolExecutor } from './nodeToolExecutor'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turboflux-search-')))
  roots.push(root)
  const write = (path: string, content: string) => {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
    return target
  }
  return { root, write, executor: new NodeToolExecutor(root) }
}

describe('workspace search contract', () => {
  it('preserves all 30 matches when increasing the result limit', async () => {
    const { root, write, executor } = workspace()
    write('owner.ts', Array.from({ length: 30 }, (_, i) => `needle ${i}`).join('\n'))
    for (const limit of [50, 100, 500]) {
      const response = await executor.searchContentPage('needle', root, undefined, false, { limit })
      expect(response).toMatchObject({ success: true, data: { totalMatches: 30, totalIsExact: true, truncated: false } })
      expect(response.data?.hits).toHaveLength(30)
    }
  })

  it('returns stable, non-overlapping pages across several files', async () => {
    const { root, write, executor } = workspace()
    for (const file of ['c.ts', 'a.ts', 'b.ts']) write(file, 'needle 1\nneedle 2\nneedle 3\n')
    const first = await executor.searchContentPage('needle', root, undefined, false, { limit: 4 })
    const second = await executor.searchContentPage('needle', root, undefined, false, { limit: 4, offset: first.data?.nextOffset })
    const third = await executor.searchContentPage('needle', root, undefined, false, { limit: 4, offset: second.data?.nextOffset })
    const hits = [first, second, third].flatMap(page => page.data?.hits || [])
    expect(new Set(hits.map(hit => `${hit.file}:${hit.line}`)).size).toBe(9)
    expect(hits.map(hit => hit.file)).toEqual(['a.ts', 'a.ts', 'a.ts', 'b.ts', 'b.ts', 'b.ts', 'c.ts', 'c.ts', 'c.ts'].map(file => join(root, file)))
    expect(third.data).toMatchObject({ totalMatches: 9, totalIsExact: true, truncated: false })
  })

  it('locates files and counts matching lines without returning source text', async () => {
    const { root, write, executor } = workspace()
    write('a.ts', 'needle needle\nneedle\n')
    write('b.py', 'needle\n')
    const files = await executor.searchContentPage('needle', root, undefined, false, { outputMode: 'files' })
    expect(files.data).toMatchObject({ hits: [], files: [{ file: join(root, 'a.ts') }, { file: join(root, 'b.py') }], totalMatches: 2, totalIsExact: true })
    const counts = await executor.searchContentPage('needle', root, undefined, false, { outputMode: 'count', limit: 1 })
    expect(counts.data).toMatchObject({ hits: [], files: [{ file: join(root, 'a.ts'), count: 2 }], totalMatches: 2, nextOffset: 1 })
  })

  it('uses one ignore policy for paths and content, including explicit filters', async () => {
    const { root, write, executor } = workspace()
    write('.gitignore', 'generated/\n')
    write('generated/hidden.ts', 'needle')
    write('src/visible.ts', 'needle')
    for (const includeIgnored of [false, true]) {
      const files = await executor.searchFiles('**/*.ts', root, { includeIgnored })
      const contents = await executor.searchContentPage('needle', root, '*.ts', false, { includeIgnored, outputMode: 'files' })
      expect(files.data?.matches).toEqual(contents.data?.files?.map(file => file.file))
      expect(files.data?.matches).toHaveLength(includeIgnored ? 2 : 1)
    }
  })

  it('searches an explicit file without reading same-named descendants', async () => {
    const { root, write, executor } = workspace()
    const file = write('package.json', '{"scripts": {}}')
    write('nested/package.json', '{"scripts": {}}')
    const result = await executor.searchContentPage('scripts', file)
    expect(result.data?.hits.map(hit => hit.file)).toEqual([file])
    expect(result.data?.totalMatches).toBe(1)
  })

  it('matches literal punctuation, methods and non-JavaScript languages', async () => {
    const { root, write, executor } = workspace()
    write('owner.ts', 'class Owner {\n  async startRuntime() {}\n}\n')
    write('owner.py', 'def startRuntime(): pass\n')
    write('notes.txt', '路径查询 [startRuntime()]\n')
    const literal = await executor.searchContentPage('startRuntime()', root, undefined, true, { fixedStrings: true })
    expect(literal.data?.hits).toHaveLength(3)
    const invalid = await executor.searchContentPage('[startRuntime(', root)
    expect(invalid.success).toBe(false)
    expect(invalid.error).toContain('regex parse error')
  })

  it('keeps batched regex semantics identical to standalone ripgrep', async () => {
    const { root, write, executor } = workspace()
    write('names.txt', '中文\nABC\n')
    const results = await executor.searchContentBatch([
      { pattern: '\\p{Han}+', basePath: root, caseInsensitive: false },
      { pattern: '(?i)abc', basePath: root, caseInsensitive: false },
    ])
    expect(results[0].data?.hits[0].text).toBe('中文')
    expect(results[1].data?.hits[0].text).toBe('ABC')
  })

  it('preserves adjacent matches in context and real multiline ranges', async () => {
    const { root, write, executor } = workspace()
    write('source.ts', 'needle one\nneedle two\nend\n')
    const adjacent = await executor.searchContentPage('needle', root, undefined, false, { contextAfter: 1 })
    expect(adjacent.data?.hits[0].context).toContain('2: needle two')
    const multiline = await executor.searchContentPage('one\nneedle two', root, undefined, false, { multiline: true })
    expect(multiline.data?.hits[0]).toMatchObject({ line: 1, endLine: 2 })
  })

  it('reports scan budget exhaustion separately from pagination', async () => {
    const { root, write, executor } = workspace()
    write('large.txt', (`needle ${'x'.repeat(700)}\n`).repeat(13_000))
    const result = await executor.searchContentPage('needle', root, undefined, false, { limit: 500 })
    expect(result).toMatchObject({ success: true, data: { truncated: true, totalIsExact: false, warning: expect.stringContaining('incomplete') } })
    expect(result.data?.hits.length).toBeGreaterThan(0)
    expect(result.data?.nextOffset).toBe(result.data?.hits.length)
    expect(result.data?.hits[0].textTruncated).toBe(true)
  })

  it('returns 90 files without silent secondary slicing and supports brace globs', async () => {
    const { root, write, executor } = workspace()
    for (let i = 0; i < 90; i++) write(`src/file-${String(i).padStart(3, '0')}.${i % 2 ? 'ts' : 'js'}`, '')
    const files = await executor.searchFiles('src/*.{ts,js}', root, { limit: 100 })
    expect(files.data).toMatchObject({ totalMatches: 90, totalIsExact: true, truncated: false })
    expect(files.data?.matches).toHaveLength(90)
  })

  it('excludes secret environment files and Git internals even with ignored files enabled', async () => {
    const { root, write, executor } = workspace()
    write('.env.production', 'needle')
    write('.env.example', 'needle')
    write('.git/config', 'needle')
    const files = await executor.searchFiles('**/*', root, { includeIgnored: true })
    const content = await executor.searchContentPage('needle', root, undefined, false, { includeIgnored: true })
    expect(files.data?.matches).toEqual([join(root, '.env.example')])
    expect(content.data?.hits.map(hit => hit.file)).toEqual(files.data?.matches)
  })

  it('reports a missing directory as failure instead of an empty successful tree', async () => {
    const { executor } = workspace()
    expect((await executor.listTree('missing')).success).toBe(false)
  })
})
