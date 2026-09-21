import { AutomationRepository } from '../automationRepository'

const [repositoryRoot, runId] = process.argv.slice(2)
if (!repositoryRoot || !runId) throw new Error('Repository root and run ID are required')

const repository = new AutomationRepository(repositoryRoot)
repository.initialize()
repository.acquireExecutionLocks(runId, 'crash-worker', {
  concurrencyGroup: { id: 'process-crash-test', maxParallel: 1 },
  resources: [{ key: 'workspace:process-crash-test', mode: 'exclusive' }],
}, 30_000)
repository.acquireLease(runId, 'crash-worker', 30_000)
process.stdout.write('READY\n')
setInterval(() => undefined, 1_000)
