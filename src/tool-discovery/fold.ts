import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools/types'

import {
  orderCapabilityGroups,
  parseSearchToolsArguments,
  type CapabilityGroup,
} from './capabilities.js'

interface StepPosition {
  readonly turn: number
  readonly step: number
}

export interface ToolDisclosureFoldState {
  readonly activeGroups: readonly CapabilityGroup[]
  readonly pendingGroups: readonly CapabilityGroup[]
  readonly pendingNativeCalls: ReadonlyMap<string, readonly CapabilityGroup[]>
  readonly step?: StepPosition
}

export function createToolDisclosureFoldState(
  activeGroups: readonly CapabilityGroup[] = [],
): ToolDisclosureFoldState {
  return { activeGroups, pendingGroups: [], pendingNativeCalls: new Map() }
}

function sameStep(state: ToolDisclosureFoldState, position: StepPosition): boolean {
  return state.step?.turn === position.turn && state.step.step === position.step
}

/** Only successful search_tools calls in a completed step load tools, in Native or Code mode. */
export function foldToolDisclosureEvent(
  state: ToolDisclosureFoldState,
  event: SessionEvent,
): ToolDisclosureFoldState {
  if (event.type === 'step/start') {
    return { ...createToolDisclosureFoldState(state.activeGroups), step: event.data }
  }
  if (event.type === 'step/end') {
    if (!sameStep(state, event.data)) return state
    return createToolDisclosureFoldState(orderCapabilityGroups([
      ...state.activeGroups, ...state.pendingGroups,
    ]))
  }
  if (event.type === 'turn/end') return createToolDisclosureFoldState(state.activeGroups)

  if (event.type === 'tool/call') {
    if (event.data.name !== 'search_tools' || !sameStep(state, event.data)) return state
    let args: unknown
    try { args = JSON.parse(event.data.arguments) } catch { return state }
    const groups = parseSearchToolsArguments(args)
    if (groups === undefined || state.pendingNativeCalls.has(event.data.callId)) return state
    const pendingNativeCalls = new Map(state.pendingNativeCalls)
    pendingNativeCalls.set(event.data.callId, groups)
    return { ...state, pendingNativeCalls }
  }
  if (event.type === 'tool/result') {
    if (!sameStep(state, event.data)) return state
    const callId = event.data.message.toolCallId
    const groups = state.pendingNativeCalls.get(callId)
    if (groups === undefined) return state
    const pendingNativeCalls = new Map(state.pendingNativeCalls)
    pendingNativeCalls.delete(callId)
    return {
      ...state,
      pendingNativeCalls,
      pendingGroups: event.data.message.isError || event.data.error !== undefined
        ? state.pendingGroups
        : orderCapabilityGroups([...state.pendingGroups, ...groups]),
    }
  }
  if (event.type === 'tool/ptc-dispatch') {
    if (state.step === undefined || event.data.name !== 'search_tools' || event.data.isError) return state
    const groups = parseSearchToolsArguments(event.data.arguments)
    if (groups === undefined) return state
    return { ...state, pendingGroups: orderCapabilityGroups([...state.pendingGroups, ...groups]) }
  }
  return state
}

/** Replay standard events once when attaching or restoring an Agent. */
export function foldToolDisclosureEvents(events: readonly SessionEvent[]): ToolDisclosureFoldState {
  return events.reduce(foldToolDisclosureEvent, createToolDisclosureFoldState())
}
