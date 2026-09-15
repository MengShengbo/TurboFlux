export interface GithubActionsProvenance {
  gitCommit: string
  repository: string
  workflowName: string
  workflowRef: string
  workflowRunId: string
  workflowRunAttempt: number
  jobId: string
  runnerOs: string
  runnerArch: string
}

export const sharedGithubProvenanceKeys: string[]

export function captureGithubActionsProvenance(
  environment?: NodeJS.ProcessEnv,
): GithubActionsProvenance | null

export function verifyCrossPlatformGithubProvenance(
  artifacts: unknown[],
  errors: string[],
  options?: Record<string, unknown>,
): Record<string, unknown> | null
