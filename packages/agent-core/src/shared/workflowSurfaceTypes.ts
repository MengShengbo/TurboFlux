export type WorkflowSurfaceStage = string

export type WorkflowSurfaceRenderer = 'choice' | 'count' | 'gallery'

export interface WorkflowSurfaceInput {
  type: 'number' | 'text'
  min?: number
  max?: number
  placeholder?: string
  label?: string
}

export interface WorkflowSurfaceChoice {
  id: string
  label: string
  detail?: string
}

export interface WorkflowSurfaceCard {
  id: string
  name: string
  thesis: string
  screenshotPath?: string
  tags?: string[]
}

export interface WorkflowSurfaceSpec {
  workflow: string
  stage: WorkflowSurfaceStage
  renderer?: WorkflowSurfaceRenderer
  title: string
  detail?: string
  explorationId?: string
  choices?: WorkflowSurfaceChoice[]
  directions?: WorkflowSurfaceCard[]
  input?: WorkflowSurfaceInput
}

export interface WorkflowCheckpointTrigger {
  tool?: string
  tools?: string[]
  argument?: string
  equals?: string
  includes?: string
  endsWith?: string
}

export interface WorkflowCheckpointSpec extends Omit<WorkflowSurfaceSpec, 'workflow'> {
  question: string
  trigger: WorkflowCheckpointTrigger
  blockBeforeTrigger?: string[]
}

export interface WorkflowRunContract {
  instanceId?: string
  pluginId?: string
  pluginVersion?: string
  skillId?: string
  workflow: string
  stages?: string[]
  completedStages?: string[]
  responses?: WorkflowStageResponse[]
  checkpoints: WorkflowCheckpointSpec[]
}

export interface WorkflowStageResponse {
  stage: string
  response: string
  resolvedAt: number
}

export interface WorkflowInstanceState {
  schemaVersion: 1
  instanceId: string
  pluginId: string
  pluginVersion: string
  skillId?: string
  workflow: string
  status: 'active' | 'completed' | 'cancelled' | 'invalidated'
  completedStages: string[]
  responses: WorkflowStageResponse[]
  startedAt: number
  updatedAt: number
}

export interface WorkflowProgressUpdate {
  instanceId?: string
  workflow: string
  stage: string
  status: 'resolved' | 'cancelled'
  response?: string
}

export type DesignAtlasWorkflowStage = WorkflowSurfaceStage
export type DesignAtlasChoice = WorkflowSurfaceChoice
export type DesignAtlasDirectionPreview = WorkflowSurfaceCard
export type DesignAtlasWorkflowSpec = WorkflowSurfaceSpec
