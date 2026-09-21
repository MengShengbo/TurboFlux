import type {
  AutomationContextSnapshot,
  AutomationDefinition,
  AutomationPermissionSnapshot,
  AutomationRecoveryAction,
  AutomationRun,
  AutomationRunCheckpoint,
} from './automationTypes'
import {
  automationPermissionDigest,
  captureAutomationWorkspaceIdentity,
  type AutomationWorkspaceIdentity,
} from './automationCheckpoint'

export interface AutomationRecoveryValidationOptions {
  action: AutomationRecoveryAction
  explicitUserChoice: boolean
  run: AutomationRun
  checkpoint: AutomationRunCheckpoint
  definition: AutomationDefinition | null
  permissionSnapshot: AutomationPermissionSnapshot | null
  contextSnapshot: AutomationContextSnapshot | null
  workspacePath: string
  pendingApproval: boolean
  hasSecretRef?: (id: string) => boolean
  resolvePluginVersion?: (id: string) => string | undefined
}

export interface AutomationRecoveryValidation {
  valid: boolean
  issues: string[]
  warnings: string[]
  workspaceIdentity?: AutomationWorkspaceIdentity
}

export function validateAutomationRecovery(options: AutomationRecoveryValidationOptions): AutomationRecoveryValidation {
  const issues: string[] = []
  const warnings: string[] = []
  const { run, checkpoint, permissionSnapshot, contextSnapshot, definition } = options
  if (checkpoint.runId !== run.id || checkpoint.definitionId !== run.definitionId || checkpoint.definitionRevision !== run.definitionRevision) {
    issues.push('The checkpoint does not belong to this frozen run definition.')
  }
  if (!definition || definition.id !== run.definitionId || definition.revision !== run.definitionRevision) {
    issues.push('The frozen automation definition revision is unavailable.')
  }
  if (!permissionSnapshot || automationPermissionDigest(permissionSnapshot) !== checkpoint.permissionDigest) {
    issues.push('The frozen permission snapshot no longer matches the checkpoint.')
  }
  if (!contextSnapshot || contextSnapshot.id !== checkpoint.contextSnapshotId || contextSnapshot.id !== run.contextSnapshotId) {
    issues.push('The frozen context snapshot no longer matches the checkpoint.')
  }
  if (options.pendingApproval) issues.push('The previous approval request must be canceled before recovery.')

  for (const secretRef of permissionSnapshot?.secretRefs ?? []) {
    if (!options.hasSecretRef?.(secretRef)) issues.push(`Required secret reference is unavailable: ${secretRef}`)
  }
  for (const pluginId of permissionSnapshot?.pluginIds ?? []) {
    const frozenVersion = permissionSnapshot?.pluginVersions?.[pluginId]
    const currentVersion = options.resolvePluginVersion?.(pluginId)
    if (!frozenVersion) issues.push(`Plugin version was not frozen for this run: ${pluginId}`)
    else if (!currentVersion) issues.push(`Required plugin is unavailable: ${pluginId}`)
    else if (currentVersion !== frozenVersion) issues.push(`Plugin version changed since the run started: ${pluginId}`)
  }

  let workspaceIdentity: AutomationWorkspaceIdentity | undefined
  try {
    workspaceIdentity = captureAutomationWorkspaceIdentity(options.workspacePath)
    if (!workspaceIdentity.complete) {
      if (options.explicitUserChoice) warnings.push('The workspace could not be fully fingerprinted; inspect it before continuing.')
      else issues.push('The workspace could not be fully fingerprinted for automatic recovery.')
    }
    if (workspaceIdentity.fingerprint !== checkpoint.workspaceFingerprint) {
      if (options.explicitUserChoice) warnings.push('The workspace changed after the checkpoint; the recovery choice must account for those changes.')
      else issues.push('The workspace changed after the checkpoint.')
    }
    if (checkpoint.gitHead !== workspaceIdentity.gitHead) {
      if (options.explicitUserChoice) warnings.push('Git HEAD changed after the checkpoint.')
      else issues.push('Git HEAD changed after the checkpoint.')
    }
  } catch (error) {
    issues.push(`The workspace identity could not be verified: ${error instanceof Error ? error.message : String(error)}`)
  }

  const inFlight = checkpoint.inFlightToolEffect
  if (options.action === 'retry_idempotent') {
    if (!inFlight || !['read_only', 'idempotent_write'].includes(inFlight.classification)) {
      issues.push('The unresolved tool effect is not safe to retry automatically.')
    }
    if (inFlight?.classification === 'idempotent_write' && !inFlight.idempotencyKey) {
      issues.push('The idempotent write is missing its stable idempotency key.')
    }
    if (!checkpoint.resumable && !options.explicitUserChoice) {
      issues.push(checkpoint.nonResumableReason || 'The checkpoint is not marked resumable.')
    }
  } else if (inFlight) {
    warnings.push(`Tool ${inFlight.toolName} will be treated as already attempted and must not be replayed.`)
  }

  return { valid: issues.length === 0, issues, warnings, workspaceIdentity }
}
