import type { AgentTurn } from '@turboflux/contracts/agentTypes'
import type { ResponseMode } from '@turboflux/contracts/workExecutionTypes'

export const RESPONSE_MODE_TOOL = 'set_response_mode'

export const RESPONSE_MODE_INSTRUCTION = `<response_mode>
At the start of each new user request, before any answer or other tool call, call set_response_mode exactly once with mode="chat" or mode="task". Make this declaration alone without visible text.
Choose chat for ordinary conversation, explanations, or answers that need no execution. Choose task when you will investigate, research, use tools, create or change something, or execute a multi-step request. Decide from the user's intent and context, not keywords.
After the declaration, continue fulfilling the request normally. The mode is presentation metadata, not a permission or tool restriction. A resumed request keeps its existing declaration.
</response_mode>`

export function declaredResponseMode(turn: AgentTurn): ResponseMode {
  const call = turn.toolCalls?.[0]
  const mode = call?.arguments.mode
  if (turn.toolCalls?.length !== 1 || call?.name !== RESPONSE_MODE_TOOL || (mode !== 'chat' && mode !== 'task')) {
    throw new Error('The model must first call set_response_mode with mode="chat" or mode="task".')
  }
  return mode
}
