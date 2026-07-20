import React, { useMemo, type Ref } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from '../../theme/index'
import { UserMessage, AssistantMessage, SystemMessage, type Message } from './Messages'
import { ToolCallTree } from '../tools/ToolCallTree'
import { DiffCard } from '../diff/DiffCard'
import type { ChangeSummary } from '../../../shared/agentTypes'

interface Props {
  messages: Message[]
  verbose: boolean
  diffMaxRows?: number
  /** If set, renders a border around the selected message */
  selectedIndex?: number
  selectedMessageId?: string
  selectedMessageRef?: Ref<DOMElement>
  showThinking?: boolean
}

/** Group consecutive system messages into a single rendered block. */
function useGroupedMessages(messages: Message[]) {
  return useMemo(() => {
    const result: Array<
      | { type: 'single'; msg: Message }
      | { type: 'systemGroup'; msgs: Message[] }
    > = []

    let sysBuffer: Message[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        sysBuffer.push(msg)
        continue
      }

      if (sysBuffer.length > 0) {
        result.push({ type: 'systemGroup', msgs: sysBuffer })
        sysBuffer = []
      }
      result.push({ type: 'single', msg })
    }

    if (sysBuffer.length > 0) {
      result.push({ type: 'systemGroup', msgs: sysBuffer })
    }

    return result
  }, [messages])
}

export function MessageList({
  messages,
  verbose,
  diffMaxRows,
  selectedIndex,
  selectedMessageId,
  selectedMessageRef,
  showThinking = verbose,
}: Props) {
  const theme = useTheme()
  const grouped = useGroupedMessages(messages)
  const selectedId = selectedMessageId ?? (selectedIndex === undefined ? undefined : messages[selectedIndex]?.id)

  return (
    <Box flexDirection="column" marginTop={0}>
      {grouped.map((group) => {
        if (group.type === 'systemGroup') {
          const key = group.msgs.map(m => m.id).join('-')
          const msgs = group.msgs
          const isSelected = selectedId !== undefined && msgs.some(message => message.id === selectedId)
          if (msgs.length === 1) {
            return (
              <Box
                key={key}
                ref={isSelected ? selectedMessageRef : undefined}
                flexDirection="column"
                marginBottom={1}
                borderStyle={isSelected ? 'round' : undefined}
                borderColor={isSelected ? theme.brand : undefined}
                paddingX={isSelected ? 1 : 0}
              >
                <SystemMessage content={msgs[0]!.content} />
              </Box>
            )
          }
          return (
            <Box
              key={key}
              ref={isSelected ? selectedMessageRef : undefined}
              flexDirection="column"
              marginBottom={1}
              borderStyle={isSelected ? 'round' : undefined}
              borderColor={isSelected ? theme.brand : undefined}
              paddingX={isSelected ? 1 : 0}
            >
              <Text dimColor color={theme.inactive}>
                {'>'} {msgs.length} system messages
              </Text>
              {msgs.map(m => (
                <Box key={m.id} paddingLeft={2}>
                  <SystemMessage content={m.content} />
                </Box>
              ))}
            </Box>
          )
        }

        const msg = group.msg
        const isSelected = selectedId === msg.id

        if (msg.role === 'user') {
          return (
            <Box
              key={msg.id}
              ref={isSelected ? selectedMessageRef : undefined}
              flexDirection="column"
              marginBottom={1}
              borderStyle={isSelected ? 'round' : undefined}
              borderColor={isSelected ? theme.brand : undefined}
              paddingX={isSelected ? 1 : 0}
            >
              <UserMessage content={msg.content} />
            </Box>
          )
        }

        if (msg.role === 'system') {
          return (
            <Box
              key={msg.id}
              ref={isSelected ? selectedMessageRef : undefined}
              flexDirection="column"
              marginBottom={1}
              borderStyle={isSelected ? 'round' : undefined}
              borderColor={isSelected ? theme.brand : undefined}
              paddingX={isSelected ? 1 : 0}
            >
              <SystemMessage content={msg.content} />
            </Box>
          )
        }

        return (
          <Box
            key={msg.id}
            ref={isSelected ? selectedMessageRef : undefined}
            flexDirection="column"
            marginBottom={1}
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? theme.brand : undefined}
            paddingX={isSelected ? 1 : 0}
          >
            {msg.tools && msg.tools.length > 0 && <ToolCallTree tools={msg.tools} verbose={verbose} />}
            {msg.changes && msg.changes.length > 0 && msg.changes.map((change, ci) => (
              <Box key={ci}>
                <DiffCard
                  filename={change.path}
                  operation={change.operation}
                  before={change.before}
                  after={change.after}
                  addedLines={change.addedLines}
                  removedLines={change.removedLines}
                  totalLines={change.totalLines}
                  maxDiffRows={diffMaxRows}
                />
              </Box>
            ))}
            <AssistantMessage content={msg.content} interrupted={msg.interrupted} thinking={msg.thinking} showThinking={showThinking} />
          </Box>
        )
      })}
    </Box>
  )
}
