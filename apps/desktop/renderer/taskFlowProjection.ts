import {
  projectWorkProjection,
  type TaskFlowProjectionState,
} from '@turboflux/presentation'
import type { WorkbenchSnapshot } from '@turboflux/workbench'

export {
  applyTaskFlowEvent,
  applyTaskFlowWorkSnapshot,
  createTaskFlowProjection,
  historicalTaskFlowNodeId,
  latestTaskFlowNodeId,
  orderTaskFlowNodeIds,
  projectWorkProjection,
  syncTaskFlowLiveText,
  taskFlowNodeIdForTool,
  taskFlowNodeIdForTurn,
} from '@turboflux/presentation'
export type {
  TaskFlowNode,
  TaskFlowNodeKind,
  TaskFlowNodeStatus,
  TaskFlowProjectionState,
} from '@turboflux/presentation'

export function projectTaskFlowSnapshot(snapshot: WorkbenchSnapshot): TaskFlowProjectionState {
  return projectWorkProjection(snapshot.work.projection)
}
