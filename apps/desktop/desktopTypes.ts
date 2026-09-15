import type {
  WorkbenchConversationResult,
  WorkbenchEvent,
  WorkbenchSettingsSaveResult,
  WorkbenchSnapshot,
} from '@turboflux/agent-core/workbench'

export type DesktopWorkbenchSnapshot = WorkbenchSnapshot & {
  workspace: WorkbenchSnapshot['workspace'] & { specified: boolean }
}

export type DesktopWorkbenchEvent =
  | Exclude<WorkbenchEvent, { type: 'snapshot' }>
  | { type: 'snapshot'; snapshot: DesktopWorkbenchSnapshot }

export type DesktopWorkbenchConversationResult = Omit<WorkbenchConversationResult, 'snapshot'> & {
  snapshot: DesktopWorkbenchSnapshot
}

export type DesktopWorkbenchSettingsSaveResult = Omit<WorkbenchSettingsSaveResult, 'snapshot'> & {
  snapshot: DesktopWorkbenchSnapshot
}
