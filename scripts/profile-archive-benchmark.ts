import { createHash, randomFillSync } from 'node:crypto'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createArchiveEncryption,
  deriveArchiveKey,
  readProfileArchive,
  writeProfileArchive,
  type ArchiveEntryInput,
} from '@turboflux/profiles/profileArchive/index'
import { captureGithubActionsProvenance } from './github-actions-provenance.mjs'
import { resolveProfileArchiveBenchmarkConfig } from './profile-archive-benchmark-config'
import { sanitizeSourceEvidenceReport, writeSourceEvidenceReportAtomically } from './source-evidence-report.mjs'

const {
  qualification,
  conversationCount,
  blobMiB,
  kdfBudgetMs,
  roundTripBudgetMs,
  rssBudgetMiB,
} = resolveProfileArchiveBenchmarkConfig()

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function createBlob(path: string, size: number): Promise<string> {
  const handle = await open(path, 'wx', 0o600)
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (let written = 0; written < size; written += chunk.length) {
      randomFillSync(chunk)
      const current = chunk.subarray(0, Math.min(chunk.length, size - written))
      hash.update(current)
      await handle.write(current)
    }
    await handle.sync()
  } finally {
    chunk.fill(0)
    await handle.close()
  }
  return hash.digest('hex')
}

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'turboflux-profile-benchmark-'))
  const archivePath = join(root, 'benchmark.turboflux-profile')
  const blobPath = join(root, 'blob.bin')
  const password = Buffer.from('benchmark-password-not-a-secret', 'utf8')
  let sampler: ReturnType<typeof setInterval> | undefined
  try {
    const kdfStarted = performance.now()
    const material = await createArchiveEncryption(password)
    const derived = await deriveArchiveKey(password, {
      containerVersion: 1,
      compression: 'gzip',
      encrypted: true,
      ...material.header,
    })
    const kdfMs = performance.now() - kdfStarted
    material.key.fill(0)
    derived.fill(0)

    const blobBytes = blobMiB * 1024 * 1024
    const blobDigest = await createBlob(blobPath, blobBytes)
    const entries: ArchiveEntryInput[] = Array.from({ length: conversationCount }, (_, index) => {
      const data = Buffer.from(JSON.stringify({ id: `conversation-${index}`, title: `Benchmark ${index}`, turns: [] }), 'utf8')
      return { path: `components/conversations/${index}.json`, size: data.length, digest: digest(data), data }
    })
    entries.push({ path: 'blobs/benchmark.bin', size: blobBytes, digest: blobDigest, sourcePath: blobPath, sourceMtimeMs: (await stat(blobPath)).mtimeMs })

    const rssBefore = process.memoryUsage().rss
    let peakRss = rssBefore
    sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 10)
    const roundTripStarted = performance.now()
    const written = await writeProfileArchive({ targetPath: archivePath, entries, password, verifyDocument: false })
    let expandedBytes = 0
    const read = await readProfileArchive({
      path: archivePath,
      password,
      onEntry: async (_entry, content) => {
        for await (const chunk of content) expandedBytes += chunk.length
      },
    })
    const roundTripMs = performance.now() - roundTripStarted
    clearInterval(sampler)
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const peakRssDeltaMiB = (peakRss - rssBefore) / 1024 / 1024
    const failures = [
      kdfMs > kdfBudgetMs ? `KDF ${kdfMs.toFixed(1)}ms exceeds ${kdfBudgetMs}ms` : '',
      roundTripMs > roundTripBudgetMs ? `round trip ${roundTripMs.toFixed(1)}ms exceeds ${roundTripBudgetMs}ms` : '',
      peakRssDeltaMiB > rssBudgetMiB ? `RSS delta ${peakRssDeltaMiB.toFixed(1)}MiB exceeds ${rssBudgetMiB}MiB` : '',
      read.entries.length !== entries.length ? 'entry count mismatch' : '',
      expandedBytes !== entries.reduce((sum, entry) => sum + entry.size, 0) ? 'expanded byte count mismatch' : '',
    ].filter(Boolean)
    const result = {
      schemaVersion: 2,
      provenance: captureGithubActionsProvenance(),
      qualification,
      completedAt: new Date().toISOString(),
      command: qualification === 'stable' ? 'npm run perf:profiles:stable' : 'npm run perf:profiles',
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
      },
      dataset: { conversationCount, blobMiB, entries: entries.length },
      kdfMs: Number(kdfMs.toFixed(1)),
      roundTripMs: Number(roundTripMs.toFixed(1)),
      peakRssDeltaMiB: Number(peakRssDeltaMiB.toFixed(1)),
      archiveMiB: Number((written.physicalBytes / 1024 / 1024).toFixed(1)),
      expandedMiB: Number((expandedBytes / 1024 / 1024).toFixed(1)),
      verifiedEntries: read.entries.length,
      budgets: { kdfBudgetMs, roundTripBudgetMs, rssBudgetMiB },
      passed: failures.length === 0,
      failures,
    }
    let sanitizedResult
    if (qualification === 'stable') {
      const reportPath = join(process.cwd(), 'apps', 'desktop', 'generated', 'profile-benchmarks', `profile-archive-stable-${process.platform}-${process.arch}.json`)
      sanitizedResult = await writeSourceEvidenceReportAtomically(reportPath, result)
    } else sanitizedResult = sanitizeSourceEvidenceReport(result)
    console.log(JSON.stringify(sanitizedResult, null, 2))
    if (failures.length > 0) throw new Error(`Profile archive benchmark failed: ${failures.join('; ')}`)
  } finally {
    clearInterval(sampler)
    password.fill(0)
    await rm(root, { recursive: true, force: true })
  }
}

try {
  await run()
} catch (error) {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code || error.name : 'unknown error'
  process.stderr.write(`Profile archive benchmark failed (${code})\n`)
  process.exitCode = 1
}
