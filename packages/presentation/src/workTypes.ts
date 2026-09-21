import type { ConversationEventWindowSnapshot } from '@turboflux/contracts/conversationEvent'
import type { WorkProjectionSnapshot } from './workProjection'

export interface WorkSessionSnapshot {
  schemaVersion: 1
  window: ConversationEventWindowSnapshot
  projection: WorkProjectionSnapshot
}
