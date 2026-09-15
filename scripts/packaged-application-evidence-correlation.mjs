import { sharedGithubProvenanceKeys } from './github-actions-provenance.mjs'

export function correlatePackagedApplicationEvidence(applicationArtifacts, packageReport, errors, options = {}) {
  const initialErrorCount = errors.length
  const requiredPlatforms = options.requiredPlatforms ?? ['darwin', 'win32']
  if (packageReport?.schemaVersion !== 2) errors.push('package evidence aggregate schemaVersion must be 2')
  if (packageReport?.status !== 'passed') {
    errors.push('package evidence aggregate must be passed')
    for (const message of packageReport?.errors ?? []) errors.push(`package evidence: ${message}`)
  }
  if (options.requireApplicationProvenance !== false) {
    for (const key of [...sharedGithubProvenanceKeys, 'jobId']) {
      const packageValue = packageReport?.provenance?.[key]
      for (const artifact of applicationArtifacts) {
        if (artifact.provenance?.[key] !== packageValue) errors.push(`${artifact.path}: provenance.${key} does not match package evidence`)
      }
    }
  }
  const correlations = []
  for (const platform of requiredPlatforms) {
    const applicationMatches = applicationArtifacts.filter(artifact => artifact.platform === platform)
    const packageMatches = (packageReport?.artifacts ?? []).filter(artifact => artifact.platform === platform)
    if (applicationMatches.length !== 1 || packageMatches.length !== 1) {
      errors.push(`${platform}: package correlation requires exactly one application artifact and one package report`)
      continue
    }
    const applicationArtifact = applicationMatches[0]
    const packageArtifact = packageMatches[0]
    if (packageArtifact.status !== 'passed') errors.push(`${applicationArtifact.path}: correlated package report is not passed`)
    if (applicationArtifact.arch !== packageArtifact.arch) errors.push(`${applicationArtifact.path}: application arch does not match package report`)
    if (applicationArtifact.packageEvidence?.packageSha256 !== packageArtifact.packageSha256) errors.push(`${applicationArtifact.path}: package SHA-256 does not match package report`)
    if (applicationArtifact.packageEvidence?.asarSha256 !== packageArtifact.asarSha256) errors.push(`${applicationArtifact.path}: ASAR SHA-256 does not match package report`)
    if (options.requireRemoteMobileSha256 && applicationArtifact.packageEvidence?.remoteMobileSha256 !== packageArtifact.remoteMobileSha256) errors.push(`${applicationArtifact.path}: Remote Mobile SHA-256 does not match package report`)
    correlations.push({
      platform,
      arch: applicationArtifact.arch,
      packageSha256: applicationArtifact.packageEvidence?.packageSha256,
      asarSha256: applicationArtifact.packageEvidence?.asarSha256,
      ...(options.requireRemoteMobileSha256 ? { remoteMobileSha256: applicationArtifact.packageEvidence?.remoteMobileSha256 } : {}),
    })
  }
  return {
    schemaVersion: 1,
    status: errors.length === initialErrorCount ? 'passed' : 'failed',
    packageProvenance: packageReport?.provenance ?? null,
    artifacts: correlations,
  }
}
