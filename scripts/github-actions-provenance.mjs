const commitPattern = /^[a-f0-9]{40}$/u
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const jobPattern = /^[A-Za-z0-9_-]+$/u

export const sharedGithubProvenanceKeys = [
  'gitCommit',
  'repository',
  'workflowName',
  'workflowRef',
  'workflowRunId',
  'workflowRunAttempt',
]

const allGithubProvenanceKeys = [...sharedGithubProvenanceKeys, 'jobId', 'runnerOs', 'runnerArch']

function normalizedGithubProvenance(environment) {
  const runAttempt = Number.parseInt(environment.GITHUB_RUN_ATTEMPT ?? '', 10)
  return {
    gitCommit: /^[a-f0-9]{40}$/iu.test(environment.GITHUB_SHA ?? '') ? environment.GITHUB_SHA.toLowerCase() : null,
    repository: environment.GITHUB_REPOSITORY?.trim() || null,
    workflowName: environment.GITHUB_WORKFLOW?.trim() || null,
    workflowRef: environment.GITHUB_WORKFLOW_REF?.trim() || null,
    workflowRunId: /^\d+$/u.test(environment.GITHUB_RUN_ID ?? '') ? environment.GITHUB_RUN_ID : null,
    workflowRunAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : null,
    jobId: environment.GITHUB_JOB?.trim() || null,
    runnerOs: environment.RUNNER_OS?.trim() || null,
    runnerArch: environment.RUNNER_ARCH?.trim() || null,
  }
}

function provenanceErrors(provenance, platform, arch) {
  const errors = []
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return ['provenance is missing']
  const keys = Object.keys(provenance).sort()
  const expectedKeys = [...allGithubProvenanceKeys].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) errors.push(`provenance fields must be exactly: ${expectedKeys.join(', ')}`)
  if (!commitPattern.test(provenance.gitCommit)) errors.push('provenance.gitCommit is invalid')
  if (!repositoryPattern.test(provenance.repository)) errors.push('provenance.repository is invalid')
  if (typeof provenance.workflowName !== 'string' || provenance.workflowName.length === 0 || provenance.workflowName.length > 256 || /[\r\n]/u.test(provenance.workflowName) || containsSensitiveMetadata(provenance.workflowName)) errors.push('provenance.workflowName is invalid')
  if (typeof provenance.workflowRef !== 'string' || !provenance.workflowRef.startsWith(`${provenance.repository}/.github/workflows/`) || !provenance.workflowRef.includes('@refs/') || containsSensitiveMetadata(provenance.workflowRef)) errors.push('provenance.workflowRef is invalid')
  if (typeof provenance.workflowRunId !== 'string' || !/^\d+$/u.test(provenance.workflowRunId)) errors.push('provenance.workflowRunId is invalid')
  if (!Number.isSafeInteger(provenance.workflowRunAttempt) || provenance.workflowRunAttempt <= 0) errors.push('provenance.workflowRunAttempt is invalid')
  if (typeof provenance.jobId !== 'string' || !jobPattern.test(provenance.jobId)) errors.push('provenance.jobId is invalid')
  const expectedRunnerOs = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform]
  const expectedRunnerArch = { arm64: 'ARM64', x64: 'X64' }[arch]
  if (!expectedRunnerOs || provenance.runnerOs !== expectedRunnerOs) errors.push(`provenance.runnerOs must be ${expectedRunnerOs ?? 'a supported platform'}`)
  if (!expectedRunnerArch || provenance.runnerArch !== expectedRunnerArch) errors.push(`provenance.runnerArch must be ${expectedRunnerArch ?? 'a supported architecture'}`)
  return errors
}

function containsSensitiveMetadata(value) {
  return /(?:https?:\/\/|file:\/\/|(?:^|[\s:(])(?:\/|[A-Za-z]:[\\/])|\b(?:token|secret|password|api[_-]?key|authorization|bearer)\b\s*[:=])/iu.test(value)
}

export function captureGithubActionsProvenance(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== 'true') return null
  const provenance = normalizedGithubProvenance(environment)
  const errors = provenanceErrors(provenance, process.platform, process.arch)
  if (errors.length > 0) throw new Error(`GitHub Actions provenance is incomplete: ${errors.join('; ')}`)
  return provenance
}

function currentWorkflowProvenance(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== 'true') return undefined
  const provenance = normalizedGithubProvenance(environment)
  return Object.fromEntries(sharedGithubProvenanceKeys.map(key => [key, provenance[key]]))
}

export function verifyCrossPlatformGithubProvenance(artifacts, errors, options = {}) {
  const requireProvenance = options.requireProvenance ?? (options.requiredPlatforms?.length ?? 0) > 1
  if (!requireProvenance && artifacts.every(artifact => artifact.provenance == null)) return null
  let provenanceIsValid = true
  for (const artifact of artifacts) {
    const artifactErrors = provenanceErrors(artifact.provenance, artifact.platform, artifact.arch)
    provenanceIsValid &&= artifactErrors.length === 0
    for (const message of artifactErrors) errors.push(`${artifact.path}: ${message}`)
  }
  for (const key of sharedGithubProvenanceKeys) {
    const values = new Set(artifacts.map(artifact => artifact.provenance?.[key]).filter(value => value !== undefined && value !== null))
    if (values.size !== 1 || artifacts.length !== options.requiredPlatforms.length) {
      provenanceIsValid = false
      errors.push(`all evidence artifacts must share one ${key}`)
    }
  }
  const jobIds = new Set(artifacts.map(artifact => artifact.provenance?.jobId).filter(Boolean))
  if (jobIds.size !== 1 || artifacts.length !== options.requiredPlatforms.length) {
    provenanceIsValid = false
    errors.push('all evidence artifacts must share one jobId')
  }
  if (options.expectedSourceJob && (jobIds.size !== 1 || !jobIds.has(options.expectedSourceJob))) errors.push(`all evidence artifacts must come from job ${options.expectedSourceJob}`)
  const expectedProvenance = options.expectedProvenance ?? currentWorkflowProvenance(options.environment)
  if (expectedProvenance) {
    for (const key of sharedGithubProvenanceKeys) {
      if (expectedProvenance[key] === undefined || expectedProvenance[key] === null || expectedProvenance[key] === '') errors.push(`current workflow ${key} is unavailable`)
      for (const artifact of artifacts) {
        if (artifact.provenance?.[key] !== expectedProvenance[key]) errors.push(`${artifact.path}: provenance.${key} does not match the current workflow run`)
      }
    }
  }
  if (!provenanceIsValid || artifacts.length !== options.requiredPlatforms.length || !artifacts[0]?.provenance) return null
  return Object.fromEntries([...sharedGithubProvenanceKeys, 'jobId'].map(key => [key, artifacts[0].provenance[key]]))
}
