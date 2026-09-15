import {
  projectWorkProjection,
  type TaskFlowProjectionState,
} from '@turboflux/agent-core/renderer'
import type { WorkbenchSnapshot } from '@turboflux/agent-core/workbench'

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
} from '@turboflux/agent-core/renderer'
export type {
  TaskFlowNode,
  TaskFlowNodeKind,
  TaskFlowNodeStatus,
  TaskFlowProjectionState,
} from '@turboflux/agent-core/renderer'

export function projectTaskFlowSnapshot(snapshot: WorkbenchSnapshot): TaskFlowProjectionState {
  return projectWorkProjection(snapshot.work.projection)
}
